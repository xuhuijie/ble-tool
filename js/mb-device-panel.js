/* ============================================================
 * Modbus 设备面板：设备管理 / 寄存器配置 / 手动批量读 / 单个写
 *
 * 纯前端：配置存 localStorage；读写走 ModbusPanel.transact()，
 * 复用透传页的 TX/RX 特征与 Modbus RTU 组帧/解析。
 * ============================================================ */
'use strict';

import {
  buildReadHolding, buildReadInput, buildWriteSingle, buildWriteMultiple,
  parseAddr, parseReg, parseTypedValue, encodeTypedValue, DATA_TYPES,
} from './modbus.js';
import { $, esc, toast, appendLog, gts } from './ui.js';
import { KEYS, loadJson } from './storage.js';

const REG_TYPE_LABEL = { readonly: '只读', writeonly: '只写', readwrite: '读写' };
const WRITABLE = ['writeonly', 'readwrite'];
const MAX_READ = 125;

const fmtNum = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
};

/** 解析选项配置：JSON {"0":"周期测量"} 或简写 "0=周期测量, 6=校准模式" → {0:'周期测量'} */
function parseOptions(optStr) {
  const map = {};
  const t = String(optStr || '').trim();
  if (!t) return map;
  try {
    const o = JSON.parse(t);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) {
        const n = parseInt(k, 10);
        if (Number.isInteger(n)) map[n] = String(v);
      }
      if (Object.keys(map).length) return map;
    }
  } catch {}
  for (const part of t.split(/[\n,，;；]/)) {
    const idx = part.search(/[:=]/);
    if (idx > 0) {
      const n = parseInt(part.slice(0, idx).trim(), 10);
      const label = part.slice(idx + 1).trim();
      if (Number.isInteger(n) && label) map[n] = label;
    }
  }
  return map;
}

/** 选项 map → 表单可编辑的简写字符串 */
function optionsToText(optStr) {
  const map = parseOptions(optStr);
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join(', ');
}

export class MbDevicePanel {
  /** @param {import('./ble-service.js').BleService} ble */
  constructor(ble, modbusPanel, store, uartPanel) {
    this.ble = ble;
    this.modbus = modbusPanel;
    this.store = store;
    this.uartPanel = uartPanel || null;
    this.curDeviceId = null;
    this.editingDevice = null; // 'new' | deviceId | null
    this.editingReg = null;    // 'new' | regId | null
    this.results = new Map();  // regId -> { ok, raw, value, error, time }
    this.busy = false;
    this.readOnly = false;     // 普通用户：只能使用，不能改配置
  }

  /** 切换只读模式（普通用户隐藏全部配置入口） */
  setReadOnly(ro) {
    this.readOnly = !!ro;
    for (const id of ['btnMbdAdd', 'btnMbdEdit', 'btnMbdDel', 'btnMbrAdd']) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', this.readOnly);
    }
    this.hideForms();
    this.renderRegs();
  }

  noPerm() {
    toast('普通用户无权修改配置', true);
    return true;
  }

  async load() {
    try { await this.store.load(); }
    catch (err) { toast('配置加载失败：' + err.message, true); }
    if (!this.curDeviceId || !this.store.getDevice(this.curDeviceId)) {
      this.curDeviceId = this.store.devices[0]?.id || null;
    }
    this.renderDevices();
    this.renderRegs();
    this.applyUartConfig();
  }

  /** 选中设备时将其绑定的透传配置套用到收发层 */
  applyUartConfig() {
    if (this.uartPanel) this.uartPanel.applyConfig(this.curDevice()?.uart);
  }

  curDevice() {
    return this.store.getDevice(this.curDeviceId);
  }

  /* ================= 设备 ================= */

  renderDevices() {
    const sel = $('mbdSel');
    sel.innerHTML = '';
    if (!this.store.devices.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '（暂无设备，请新增）';
      sel.appendChild(o);
    }
    for (const d of this.store.devices) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = `${d.name}（从站 ${d.slave}）`;
      sel.appendChild(o);
    }
    if (this.curDeviceId) sel.value = this.curDeviceId;

    const dev = this.curDevice();
    const conn = this.ble.device ? (this.ble.device.name || '未知名称') : null;
    let hint;
    if (!conn) hint = '未连接蓝牙设备';
    else if (dev && dev.bleName && conn !== dev.bleName) hint = `已连接「${conn}」，与该设备绑定的「${dev.bleName}」不一致`;
    else hint = `已连接「${conn}」`;
    $('mbdConnHint').textContent = '当前：' + hint;
  }

  selectDevice(id) {
    this.curDeviceId = id || null;
    this.results.clear();
    this.hideForms();
    this.renderDevices();
    this.renderRegs();
    this.applyUartConfig();
  }

  showDeviceForm(editId) {
    if (this.readOnly) return this.noPerm();
    this.editingDevice = editId;
    this.editingReg = null;
    $('mbrForm').classList.add('hidden');
    const d = editId === 'new' ? null : this.store.getDevice(editId);
    if (editId !== 'new' && !d) return;
    $('mbdName').value = d ? d.name : '';
    $('mbdBle').value = d ? d.bleName : '';
    $('mbdSlave').value = d ? d.slave : '1';
    $('mbdWordOrder').value = d ? d.wordOrder : 'ABCD';
    const uart = d?.uart || {};
    const lsUart = loadJson(KEYS.UART, {});
    $('mbdTxSvc').value = uart.txSvc || lsUart.txService || '';
    $('mbdTxChar').value = uart.txChar || lsUart.txChar || '';
    $('mbdRxSvc').value = uart.rxSvc || lsUart.rxService || '';
    $('mbdRxChar').value = uart.rxChar || lsUart.rxChar || '';
    $('mbdFormTitle').textContent = editId === 'new' ? '新增设备' : '编辑设备';
    $('mbdForm').classList.remove('hidden');
  }

  async saveDeviceForm() {
    if (this.readOnly) return this.noPerm();
    const name = $('mbdName').value.trim();
    if (!name) { toast('设备名称不能为空', true); return; }
    let slave;
    try { slave = parseAddr($('mbdSlave').value); }
    catch (err) { toast(err.message, true); return; }
    const data = {
      name, bleName: $('mbdBle').value.trim(),
      slave, wordOrder: $('mbdWordOrder').value,
      uart: {
        txSvc: $('mbdTxSvc').value.trim(), txChar: $('mbdTxChar').value.trim(),
        rxSvc: $('mbdRxSvc').value.trim(), rxChar: $('mbdRxChar').value.trim(),
      },
    };
    try {
      if (this.editingDevice === 'new') {
        const d = await this.store.addDevice(data);
        this.curDeviceId = d.id;
        toast('设备已新增');
      } else {
        await this.store.updateDevice(this.editingDevice, data);
        toast('设备已保存');
      }
    } catch (err) { toast(err.message, true); return; }
    appendLog('sys', `Modbus 设备配置已保存：${name}（从站 ${slave}）`);
    this.hideForms();
    this.renderDevices();
    this.renderRegs();
    this.applyUartConfig();
  }

  async deleteDevice() {
    if (this.readOnly) return this.noPerm();
    const d = this.curDevice();
    if (!d) { toast('没有可删除的设备', true); return; }
    if (!confirm(`删除设备「${d.name}」及其 ${d.registers.length} 个寄存器配置？`)) return;
    try { await this.store.deleteDevice(d.id); }
    catch (err) { toast(err.message, true); return; }
    this.results.clear();
    this.curDeviceId = this.store.devices[0]?.id || null;
    this.hideForms();
    this.renderDevices();
    this.renderRegs();
    toast('已删除');
  }

  /* ================= 寄存器 ================= */

  renderRegs() {
    const dev = this.curDevice();
    const el = $('mbrList');
    if (!dev) { el.innerHTML = '<div class="placeholder">先新增设备</div>'; return; }
    if (!dev.registers.length) {
      el.innerHTML = '<div class="placeholder">暂无寄存器配置，点「＋ 添加寄存器」</div>';
      return;
    }
    el.innerHTML = dev.registers.map((r) => {
      const res = this.results.get(r.id);
      const badgeCls = r.regType === 'readonly' ? 'ro' : r.regType === 'writeonly' ? 'wo' : 'rw';
      let valHtml = '';
      if (r.regType !== 'writeonly') {
        if (!res) valHtml = `<div class="reg-val"><span class="empty">未读取</span></div>`;
        else if (res.ok) {
          if (r.dataType === 'enum') {
            const readMap = parseOptions(r.readOptions);
            const label = (Object.keys(readMap).length ? readMap : parseOptions(r.options))[res.raw];
            valHtml = label
              ? `<div class="reg-val"><span class="v">${esc(label)}</span></div>`
              : `<div class="reg-val"><span class="v">${esc(res.raw)}</span></div>`;
          } else {
            valHtml = `<div class="reg-val"><span class="v">${esc(fmtNum(res.value))}<small>${esc(r.unit)}</small></span><span class="raw">原始 ${esc(fmtNum(res.raw))}</span></div>`;
          }
        }
        else valHtml = `<div class="reg-val"><span class="errmsg">读取失败：${esc(res.error)}</span></div>`;
      }
      const readBtn = r.regType === 'writeonly' ? ''
        : `<button class="btn ghost small" data-read="${r.id}">读</button>`;
      const writeHtml = !WRITABLE.includes(r.regType) ? '' : r.dataType === 'enum'
        ? `<select id="mbw_${r.id}" class="text mono">${Object.entries(parseOptions(r.options)).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select><button class="btn primary small" data-write="${r.id}">写</button>`
        : `<input id="mbw_${r.id}" class="text mono" placeholder="写入值"><button class="btn primary small" data-write="${r.id}">写</button>`;
      const cfgBtns = this.readOnly ? '' :
        `<span class="reg-tools">
          <button class="btn ghost small" data-editreg="${r.id}">编辑</button>
          <button class="btn ghost small" data-delreg="${r.id}">删除</button>
        </span>`;
      const dragHandle = this.readOnly ? '' : `<span class="drag-handle" data-drag title="按住拖动排序">⋮⋮</span>`;
      return `<div class="reg-card" data-reg="${r.id}">
        <div class="reg-head">
          ${dragHandle}<span class="reg-name">${esc(r.name)}</span>
          <span class="reg-badge ${badgeCls}">${REG_TYPE_LABEL[r.regType] || r.regType}</span>
        </div>
        ${valHtml}
        <div class="reg-actions">${readBtn}${writeHtml}${cfgBtns}</div>
      </div>`;
    }).join('');
  }

  /** 选项行编辑器：每行 [数字输入][名称输入][删除] */
  optRowEl(k, v) {
    const div = document.createElement('div');
    div.className = 'row opt-row';
    div.innerHTML =
      `<input class="text mono opt-val" placeholder="数字" value="${esc(k)}" style="width:90px;flex:none">` +
      `<input class="text opt-label" placeholder="操作名称，如 周期测量" value="${esc(v)}" style="flex:1">` +
      `<button class="btn ghost small" data-delopt type="button">删除</button>`;
    return div;
  }

  renderOptRows(listId, map) {
    const el = $(listId);
    el.innerHTML = '';
    const entries = Object.entries(map);
    if (!entries.length) entries.push(['', '']);
    for (const [k, v] of entries) el.appendChild(this.optRowEl(k, v));
  }

  addOptRow(listId) {
    $(listId).appendChild(this.optRowEl('', ''));
  }

  onOptListClick(e) {
    const b = e.target.closest('[data-delopt]');
    if (b) b.closest('.opt-row')?.remove();
  }

  /* ---------- 寄存器卡片拖拽排序（Pointer Events，兼容触屏） ---------- */
  onDragPointerDown(e) {
    const handle = e.target.closest('[data-drag]');
    if (!handle || this.readOnly) return;
    e.preventDefault();
    const card = handle.closest('.reg-card');
    const grid = $('mbrList');
    const startX = e.clientX, startY = e.clientY;
    let dragging = false, ph = null;

    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 8) return; // 8px 内算点击，不启动拖拽
        dragging = true;
        const rect = card.getBoundingClientRect();
        ph = document.createElement('div');
        ph.className = 'drag-placeholder';
        ph.style.height = rect.height + 'px';
        card.after(ph);
        card.classList.add('dragging');
        card.style.left = rect.left + 'px';
        card.style.top = rect.top + 'px';
        card.style.width = rect.width + 'px';
      }
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      // 手指下方（排除被拖卡片）的卡片：按纵向中点决定插前/插后
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.reg-card:not(.dragging)');
      if (under) {
        const r = under.getBoundingClientRect();
        grid.insertBefore(ph, ev.clientY < r.top + r.height / 2 ? under : under.nextSibling);
      } else {
        grid.appendChild(ph);
      }
    };
    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!dragging) return;
      card.classList.remove('dragging');
      card.style.cssText = '';
      ph.replaceWith(card);
      const order = [...grid.querySelectorAll('.reg-card')].map((c) => c.dataset.reg);
      try {
        await this.store.reorderRegisters(this.curDeviceId, order);
      } catch (err) {
        toast('排序保存失败：' + (err.message || err), true);
        this.renderRegs();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /** 读取选项行 → {数字: 名称} */
  readOptions(listId) {
    const map = {};
    document.querySelectorAll('#' + listId + ' .opt-row').forEach((row) => {
      const n = parseInt(row.querySelector('.opt-val').value.trim(), 10);
      const label = row.querySelector('.opt-label').value.trim();
      if (Number.isInteger(n) && label) map[n] = label;
    });
    return map;
  }

  showRegForm(editId) {
    if (this.readOnly) return this.noPerm();
    const dev = this.curDevice();
    if (!dev) { toast('先新增设备', true); return; }
    this.editingReg = editId;
    this.editingDevice = null;
    $('mbdForm').classList.add('hidden');
    const r = editId === 'new' ? null : dev.registers.find((x) => x.id === editId);
    if (editId !== 'new' && !r) return;
    $('mbrName').value = r ? r.name : '';
    $('mbrAddr').value = r ? r.address : '';
    $('mbrRegType').value = r ? r.regType : 'readwrite';
    $('mbrDataType').value = r ? r.dataType : 'uint16';
    const isEnum = $('mbrDataType').value === 'enum';
    $('mbrOptionsWrap').classList.toggle('hidden', !isEnum);
    $('mbrReadOptionsWrap').classList.toggle('hidden', !isEnum);
    this.renderOptRows('mbrOptList', r ? parseOptions(r.options) : {});
    this.renderOptRows('mbrReadOptList', r ? parseOptions(r.readOptions) : {});
    $('mbrUnit').value = r ? r.unit : '';
    $('mbrScale').value = r ? r.scale : '1';
    $('mbrOffset').value = r ? r.offset : '0';
    $('mbrFormTitle').textContent = editId === 'new' ? '添加寄存器' : '编辑寄存器';
    $('mbrForm').classList.remove('hidden');
  }

  async saveRegForm() {
    if (this.readOnly) return this.noPerm();
    const dev = this.curDevice();
    if (!dev) return;
    const name = $('mbrName').value.trim();
    if (!name) { toast('变量名不能为空', true); return; }
    let address;
    try { address = parseReg($('mbrAddr').value); }
    catch (err) { toast(err.message, true); return; }
    const scale = parseFloat($('mbrScale').value);
    const offset = parseFloat($('mbrOffset').value);
    if (!Number.isFinite(scale) || scale === 0) { toast('缩放系数无效', true); return; }
    if (!Number.isFinite(offset)) { toast('偏移量无效', true); return; }
    const dataType = $('mbrDataType').value;
    let options = '', readOptions = '';
    if (dataType === 'enum') {
      const map = this.readOptions('mbrOptList');
      if (!Object.keys(map).length) { toast('请至少添加一个写入选项（数字 + 名称）', true); return; }
      options = JSON.stringify(map);
      const rmap = this.readOptions('mbrReadOptList');
      if (Object.keys(rmap).length) readOptions = JSON.stringify(rmap);
    }
    const data = {
      name, address,
      regType: $('mbrRegType').value,
      dataType,
      unit: $('mbrUnit').value.trim(), scale, offset, options, readOptions,
    };
    try {
      if (this.editingReg === 'new') {
        await this.store.addRegister(dev.id, data);
        toast('寄存器已添加');
      } else {
        await this.store.updateRegister(dev.id, this.editingReg, data);
        this.results.delete(this.editingReg);
        toast('寄存器已保存');
      }
    } catch (err) { toast(err.message, true); return; }
    this.hideForms();
    this.renderRegs();
  }

  async deleteReg(regId) {
    if (this.readOnly) return this.noPerm();
    const dev = this.curDevice();
    if (!dev) return;
    const r = dev.registers.find((x) => x.id === regId);
    if (r && !confirm(`删除寄存器「${r.name}」？`)) return;
    try { await this.store.deleteRegister(dev.id, regId); }
    catch (err) { toast(err.message, true); return; }
    this.results.delete(regId);
    this.renderRegs();
  }

  hideForms() {
    this.editingDevice = null;
    this.editingReg = null;
    $('mbdForm').classList.add('hidden');
    $('mbrForm').classList.add('hidden');
  }

  /** 表格内按钮事件委托 */
  onListClick(e) {
    const w = e.target.closest('[data-write]');
    if (w) { this.writeReg(w.dataset.write); return; }
    const rd = e.target.closest('[data-read]');
    if (rd) { this.readOne(rd.dataset.read); return; }
    const er = e.target.closest('[data-editreg]');
    if (er) { this.showRegForm(er.dataset.editreg); return; }
    const dr = e.target.closest('[data-delreg]');
    if (dr) { this.deleteReg(dr.dataset.delreg); return; }
  }

  /* ================= 读写 ================= */

  /** 组读计划：按类型分组、合并连续地址段、超长分片 */
  buildPlan(items) {
    const plans = [];
    for (const regType of ['readonly', 'readwrite']) {
      const list = items
        .filter((r) => r.regType === regType)
        .map((r) => ({ ...r, count: (DATA_TYPES[r.dataType] || DATA_TYPES.uint16).count }))
        .sort((a, b) => a.address - b.address);
      let cur = null;
      const push = () => { if (cur) plans.push(cur); cur = null; };
      for (const r of list) {
        const end = r.address + r.count;
        if (cur && r.address <= cur.end && end - cur.start <= MAX_READ) {
          cur.end = Math.max(cur.end, end);
          cur.items.push(r);
        } else {
          push();
          cur = { regType, start: r.address, end, items: [r] };
        }
      }
      push();
    }
    return plans;
  }

  /** 执行单个读取计划（供读取全部/单个复用） */
  async readPlan(p, dev) {
    const func = p.regType === 'readwrite' ? 0x03 : 0x04;
    const count = p.end - p.start;
    try {
      const frame = func === 0x03
        ? buildReadHolding(dev.slave, p.start, count)
        : buildReadInput(dev.slave, p.start, count);
      const res = await this.modbus.transact(frame, { addr: dev.slave, func, count });
      for (const it of p.items) {
        const idx = it.address - p.start;
        try {
          const raw = parseTypedValue(res.registers, idx, it.dataType, dev.wordOrder);
          this.results.set(it.id, {
            ok: true, raw, value: raw * it.scale + it.offset, time: Date.now(),
          });
        } catch (err) {
          this.results.set(it.id, { ok: false, error: err.message });
        }
      }
    } catch (err) {
      for (const it of p.items) this.results.set(it.id, { ok: false, error: err.message });
      appendLog('err', `读取 ${p.start}~${p.end - 1} 失败：${err.message}`);
    }
    this.renderRegs();
  }

  /** 手动触发：读取单个寄存器 */
  async readOne(regId) {
    const dev = this.curDevice();
    if (!dev) return;
    const r = dev.registers.find((x) => x.id === regId);
    if (!r || r.regType === 'writeonly') return;
    if (this.busy) { toast('正在读写中，请稍候', true); return; }
    if (!this.ble.connected) { toast('未连接蓝牙设备', true); return; }
    this.busy = true;
    try {
      const plans = this.buildPlan([r]);
      for (const p of plans) await this.readPlan(p, dev);
    } finally {
      this.busy = false;
    }
  }

  /** 手动触发：读取全部寄存器 */
  async readAll() {
    const dev = this.curDevice();
    if (!dev) { toast('先新增设备', true); return; }
    if (!dev.registers.length) { toast('先添加寄存器配置', true); return; }
    if (this.busy) { toast('正在读写中，请稍候', true); return; }
    if (!this.ble.connected) { toast('未连接蓝牙设备', true); return; }
    this.busy = true;
    $('btnMbrReadAll').disabled = true;
    try {
      const plans = this.buildPlan(dev.registers);
      appendLog('sys', `开始读取 ${dev.name}：${plans.length} 次请求，共 ${dev.registers.length} 个变量`);
      for (const p of plans) await this.readPlan(p, dev);
      const okN = dev.registers.filter((r) => this.results.get(r.id)?.ok).length;
      appendLog('sys', `读取完成：${okN}/${dev.registers.length} 成功`);
      toast(`读取完成 ${okN}/${dev.registers.length}`);
    } finally {
      this.busy = false;
      $('btnMbrReadAll').disabled = false;
    }
  }

  /** 手动触发：写单个寄存器变量 */
  async writeReg(regId) {
    const dev = this.curDevice();
    if (!dev) return;
    const r = dev.registers.find((x) => x.id === regId);
    if (!r || !WRITABLE.includes(r.regType)) return;
    if (this.busy) { toast('正在读写中，请稍候', true); return; }
    if (!this.ble.connected) { toast('未连接蓝牙设备', true); return; }
    const text = $(`mbw_${regId}`).value.trim();
    if (!text) { toast('请输入写入值', true); return; }
    const engValue = Number(text);
    if (!Number.isFinite(engValue)) { toast('写入值不是有效数字', true); return; }
    let words;
    try {
      words = encodeTypedValue(r.dataType, engValue, r.scale, r.offset, dev.wordOrder);
    } catch (err) { toast(err.message, true); return; }
    this.busy = true;
    try {
      const frame = words.length === 1
        ? buildWriteSingle(dev.slave, r.address, words[0])
        : buildWriteMultiple(dev.slave, r.address, words);
      const func = words.length === 1 ? 0x06 : 0x10;
      await this.modbus.transact(frame, { addr: dev.slave, func, count: words.length });
      appendLog('sys', `写入成功：${r.name} = ${engValue}${r.unit}`);
      toast(`写入成功：${r.name}`);
      // 写后回读一次
      const rf = buildReadHolding(dev.slave, r.address, words.length);
      const res = await this.modbus.transact(rf, { addr: dev.slave, func: 0x03, count: words.length });
      const raw = parseTypedValue(res.registers, 0, r.dataType, dev.wordOrder);
      this.results.set(r.id, { ok: true, raw, value: raw * r.scale + r.offset, time: Date.now() });
      this.renderRegs();
    } catch (err) {
      appendLog('err', `写入失败：${err.message}`);
      toast('写入失败：' + err.message, true);
    } finally {
      this.busy = false;
    }
  }
}

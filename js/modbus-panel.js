/* ============================================================
 * Modbus RTU 面板：设备地址配置 / 读写寄存器 / 响应解析
 *
 * 复用透传页的 TX/RX 特征配置发送与接收（uartPanel）。
 * 请求-响应匹配 + CRC 校验 + 分包组帧（含重同步），超时 1.5s。
 * ============================================================ */
'use strict';

import {
  buildReadHolding, buildReadInput, buildWriteSingle, buildWriteMultiple,
  expectedLen, parseResponse, parseAddr, parseReg, parseValues, parseCount,
  regsToU32, u32ToI32, u32ToF32,
} from './modbus.js';
import { KEYS, loadJson, saveJson } from './storage.js';
import { canonicalUuid } from './device-filter.js';
import { hexBytes } from './codec.js';
import { $, esc, toast, appendLog, gts } from './ui.js';

const TIMEOUT_MS = 1500;
const FUNC_NAMES = { 3: '03 读保持寄存器', 4: '04 读输入寄存器', 6: '06 写单个寄存器', 16: '10 写多个寄存器' };

export class ModbusPanel {
  /** @param {import('./ble-service.js').BleService} ble @param {import('./uart-panel.js').UartPanel} uartPanel */
  constructor(ble, uartPanel) {
    this.ble = ble;
    this.uartPanel = uartPanel;
    this.pending = null; // { addr, func, start, count, expected, buf, txFrame, timer }
  }

  load() {
    const cfg = loadJson(KEYS.MODBUS, {});
    if (cfg.addr != null) $('mbAddr').value = cfg.addr;
    if (cfg.func != null) $('mbFunc').value = String(cfg.func);
    if (cfg.fmt != null) $('mbFmt').value = cfg.fmt;
    if (cfg.order != null) $('mbOrder').value = cfg.order;
    this.syncFuncUI();
  }

  saveCfg() {
    saveJson(KEYS.MODBUS, {
      addr: $('mbAddr').value.trim(), func: $('mbFunc').value,
      fmt: $('mbFmt').value, order: $('mbOrder').value,
    });
  }

  /** 按功能码切换 数量/写入值/解析格式 输入框 */
  syncFuncUI() {
    const func = parseInt($('mbFunc').value, 10);
    const isWrite = func === 0x06 || func === 0x10;
    const isRead = !isWrite;
    $('mbCountWrap').classList.toggle('hidden', isWrite);
    $('mbValueWrap').classList.toggle('hidden', !isWrite);
    $('mbFmtWrap').classList.toggle('hidden', isWrite);
    this.syncOrderUI();
    $('mbValue').placeholder = func === 0x10 ? '多个值用空格/逗号分隔，如 1 0xFF 300' : '0~65535，如 1234 或 0x04D2';
  }

  /** 32 位解析时才显示字序选项 */
  syncOrderUI() {
    const show = !$('mbFmtWrap').classList.contains('hidden')
      && ($('mbFmt').value === 'i32' || $('mbFmt').value === 'f32');
    $('mbOrderWrap').classList.toggle('hidden', !show);
  }

  /** 解析 TX 特征（复用透传配置） */
  resolveTxChar() {
    const cfg = this.uartPanel.cfg;
    if (cfg.txChar) {
      const canon = canonicalUuid(cfg.txChar);
      const target = canon ? this.ble.findChar(canon) : null;
      if (!target) throw new Error('未找到配置的 TX 特征，请检查透传页配置');
      return target;
    }
    const target = this.ble.firstWritableChar();
    if (!target) throw new Error('设备没有可写特征，请先在透传页配置 TX');
    return target;
  }

  /** 通知数据入口（main.js handleValue 调用） */
  onRx(uuid, u8, source) {
    if (!this.pending || source !== 'notify') return;
    if (this.uartPanel.cfg.rxChar && !this.uartPanel.isRxChar(uuid)) return;
    this.pending.buf.push(...u8);
    this.tryParse();
  }

  /** 尝试从缓冲中提取完整帧（含异常帧优先、CRC 失败重同步） */
  tryParse() {
    const p = this.pending;
    if (!p) return;
    const buf = p.buf;
    let guard = 0;
    while (buf.length >= 5 && guard++ < 128) {
      // 异常帧：地址 + (功能码|0x80)，固定 5 字节
      if (buf[0] === p.addr && buf[1] === ((p.func | 0x80) & 0xFF)) {
        this.finish(parseResponse(Uint8Array.from(buf.slice(0, 5)), p.addr, p.func, p.count), 5);
        return;
      }
      if (buf.length < p.expected) break;
      const r = parseResponse(Uint8Array.from(buf.slice(0, p.expected)), p.addr, p.func, p.count);
      if (r.code === 'crc' || r.code === 'addr') { buf.shift(); continue; } // 重同步
      this.finish(r, p.expected);
      return;
    }
  }

  finish(result, consumed) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    p.buf.splice(0, consumed);
    this.pending = null;
    if (p.resolve) {
      // transact() 事务模式
      if (result.ok) p.resolve(result);
      else p.reject(new Error(result.error));
    } else {
      this.renderResult(p, result);
    }
  }

  /**
   * 底层事务：发送一帧并等待响应。
   * @param {Uint8Array} frame 完整 RTU 帧
   * @param {{addr:number, func:number, count:number}} meta 地址/功能码/寄存器数量
   * @returns {Promise<{ok:true, registers:number[]}>}
   */
  transact(frame, { addr, func, count }) {
    return new Promise((resolve, reject) => {
      if (!this.ble.connected) { reject(new Error('未连接设备')); return; }
      if (this.pending) { reject(new Error('有请求正在进行，请稍候')); return; }
      let target;
      try { target = this.resolveTxChar(); }
      catch (err) { reject(err); return; }
      const pending = {
        addr, func, count, start: 0, expected: expectedLen(func, count),
        buf: [], txFrame: frame, timer: 0, fmt: 'u16', order: 'ABCD',
        resolve, reject,
      };
      pending.timer = setTimeout(() => {
        if (this.pending === pending) {
          this.pending = null;
          reject(new Error(`请求超时（${TIMEOUT_MS}ms），未收到从站响应`));
        }
      }, TIMEOUT_MS);
      this.pending = pending;
      const done = target.props.writeWithoutResponse
        ? target.char.writeValueWithoutResponse(frame)
        : target.char.writeValue(frame);
      done.then(() => appendLog('tx', `Modbus TX: ${hexBytes(frame)}`))
        .catch((err) => {
          if (this.pending === pending) {
            clearTimeout(pending.timer);
            this.pending = null;
            reject(err);
          }
        });
    });
  }

  renderTimeout() {
    const el = $('mbResult');
    el.innerHTML += `<div>[${gts()}] <span style="color:var(--danger)">请求超时（${TIMEOUT_MS}ms）：未收到从站响应，请检查地址/线路/波特率</span></div>`;
    el.scrollTop = el.scrollHeight;
    appendLog('err', 'Modbus 请求超时');
  }

  renderResult(p, r) {
    const el = $('mbResult');
    const ts = gts();
    let html = `<div>[${ts}] TX: ${esc(hexBytes(p.txFrame))}</div>`;
    if (!r.ok) {
      html += `<div>[${ts}] <span style="color:var(--danger)">失败：${esc(r.error)}</span></div>`;
    } else if (p.func === 0x03 || p.func === 0x04) {
      html += `<div>[${ts}] RX OK，共 ${r.registers.length} 个寄存器：</div>`;
      if (p.fmt === 'i32' || p.fmt === 'f32') {
        for (let i = 0; i + 1 < r.registers.length; i += 2) {
          const a = p.start + i;
          const u32 = regsToU32(r.registers, i, p.order);
          const hex = '0x' + u32.toString(16).padStart(8, '0').toUpperCase();
          if (p.fmt === 'i32') {
            html += `<div>&nbsp;&nbsp;地址 ${a}~${a + 1}: ${hex} = ${u32}（int32: ${u32ToI32(u32)}）</div>`;
          } else {
            const f = u32ToF32(u32);
            html += `<div>&nbsp;&nbsp;地址 ${a}~${a + 1}: ${hex} = ${Number.isFinite(f) ? f : String(f)}</div>`;
          }
        }
      } else {
        r.registers.forEach((v, i) => {
          const s16 = v >= 0x8000 ? v - 0x10000 : v;
          const hex = '0x' + v.toString(16).padStart(4, '0').toUpperCase();
          html += `<div>&nbsp;&nbsp;地址 ${p.start + i}: ${hex} = ${v}（int16: ${s16}）</div>`;
        });
      }
    } else {
      html += `<div>[${ts}] <span style="color:#4ade80">写入成功（从站回显一致）</span></div>`;
    }
    el.innerHTML += html;
    el.scrollTop = el.scrollHeight;
    appendLog('sys', `Modbus ${FUNC_NAMES[p.func]} ${r.ok ? '成功' : '失败：' + r.error}`);
  }

  /** 组帧并发送 */
  async execute() {
    if (!this.ble.connected) { toast('未连接设备', true); return; }
    if (this.pending) { toast('上一次请求还未完成，请稍候', true); return; }

    let addr, func, start, count = 0, frame;
    let fmt = 'u16', order = 'ABCD';
    try {
      addr = parseAddr($('mbAddr').value);
      func = parseInt($('mbFunc').value, 10);
      start = parseReg($('mbStart').value);
      if (func === 0x03 || func === 0x04) {
        count = parseCount($('mbCount').value, func);
        fmt = $('mbFmt').value;
        order = $('mbOrder').value;
        if ((fmt === 'i32' || fmt === 'f32') && count % 2 !== 0) {
          throw new Error('32 位解析需要偶数个寄存器');
        }
        frame = func === 0x03 ? buildReadHolding(addr, start, count) : buildReadInput(addr, start, count);
      }
      else if (func === 0x06) {
        const vs = parseValues($('mbValue').value);
        if (vs.length !== 1) throw new Error('06 功能一次只能写一个值');
        frame = buildWriteSingle(addr, start, vs[0]);
      } else if (func === 0x10) {
        const vs = parseValues($('mbValue').value);
        parseCount(String(vs.length), func); // 校验上限 123
        count = vs.length;
        frame = buildWriteMultiple(addr, start, vs);
      } else throw new Error('不支持的功能码');
    } catch (err) { toast(err.message, true); return; }

    let target;
    try { target = this.resolveTxChar(); }
    catch (err) { toast(err.message, true); return; }

    // 先注册 pending 再发送，避免响应先到
    this.pending = {
      addr, func, start, count, expected: expectedLen(func, count),
      buf: [], txFrame: frame, timer: 0, fmt, order,
    };
    this.pending.timer = setTimeout(() => {
      if (this.pending) { this.pending = null; this.renderTimeout(); }
    }, TIMEOUT_MS);

    try {
      if (target.props.writeWithoutResponse) await target.char.writeValueWithoutResponse(frame);
      else await target.char.writeValue(frame);
      appendLog('tx', `Modbus TX [${FUNC_NAMES[func]}] 从站 ${addr}: ${hexBytes(frame)}`);
      const el = $('mbResult');
      el.innerHTML += `<div>[${gts()}] TX: ${esc(hexBytes(frame))}</div>`;
      el.scrollTop = el.scrollHeight;
    } catch (err) {
      clearTimeout(this.pending.timer);
      this.pending = null;
      appendLog('err', 'Modbus 发送失败：' + err.message);
      toast('发送失败', true);
    }
  }
}

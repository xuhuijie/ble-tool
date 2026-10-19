/* ============================================================
 * UI 基础层：DOM 工具 / 吐司 / 状态胶囊 / 分色日志 / 渲染
 * 只操作 DOM，不含任何蓝牙逻辑。
 * ============================================================ */
'use strict';

import { hexBytes, decodeUtf8 } from './codec.js';
import { shortUuid, serviceName, appearanceName, companyName } from './names.js';

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

let toastTimer = null;
export function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------- 显示选项（页面级状态） ---------- */
let displayHex = true;   // UART 收发区：HEX / 文本显示
let viewFormat = 'hex';   // GATT 特征值显示格式 hex/ascii/both

export function setDisplayOptions({ hex, format } = {}) {
  if (hex !== undefined) displayHex = !!hex;
  if (format !== undefined) viewFormat = format;
}

export function fmtHex(u8) {
  return displayHex ? hexBytes(u8) : (decodeUtf8(u8) ?? hexBytes(u8));
}

export function formatForView(u8) {
  if (viewFormat === 'ascii') return asciiLocal(u8) || '(空)';
  if (viewFormat === 'both') return `${hexBytes(u8)}  |  ${asciiLocal(u8)}`;
  return hexBytes(u8) || '(空)';
}
function asciiLocal(u8) {
  let s = '';
  for (const b of u8 || []) s += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
  return s;
}

/* ---------- 分色日志 ---------- */
const LOG_TAG = { rx: 'RX', tx: 'TX', sys: 'SYS', err: 'ERR' };
const logFilters = { rx: true, tx: true, sys: true, err: true };

export function setLogFilter(kind, on) { logFilters[kind] = !!on; }

export function gts() {
  const d = new Date();
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function maybeScroll(el) {
  if (el && $('ckScroll').checked) el.scrollTop = el.scrollHeight;
}

export function appendLog(kind, text) {
  const el = $('sysLog');
  if (!logFilters[kind]) return;
  el.insertAdjacentHTML('beforeend',
    `<span class="line l-${kind}"><span class="t">[${gts()}] </span><span class="tag">[${LOG_TAG[kind]}]</span> ${esc(text)}</span>`);
  maybeScroll(el);
}

export function appendGatt(text, color) {
  const el = $('gattResult');
  el.insertAdjacentHTML('beforeend',
    `<span class="line"><span class="t">[${gts()}] </span><span style="color:${color}">${esc(text)}</span></span>`);
  maybeScroll(el);
}

export function appendUartRx(label, u8) {
  const el = $('uartRx');
  el.insertAdjacentHTML('beforeend',
    `<span class="line l-rx"><span class="t">[${gts()}] </span><span class="tag">[RX]</span> ${esc(label)}${esc(fmtHex(u8))}</span>`);
  maybeScroll(el);
}

export function appendUartTx(u8) {
  const el = $('uartRx');
  el.insertAdjacentHTML('beforeend',
    `<span class="line l-tx"><span class="t">[${gts()}] </span><span class="tag">[TX]</span> ${esc(fmtHex(u8))}</span>`);
  maybeScroll(el);
}

export function exportLog() {
  // .line 是 span，textContent 不含换行，必须逐行 join，否则导出全挤成一行
  const lines = Array.from($('sysLog').querySelectorAll('.line')).map((l) => l.textContent);
  if (!lines.length) { toast('日志为空'); return; }
  downloadFile('ble_log.txt', lines.join('\r\n'));
}

/* ---------- 状态胶囊 / 连接区 UI ---------- */
export function detectSupport() {
  if (!navigator.bluetooth) {
    $('unsupported').classList.remove('hidden');
    $('btnScan').disabled = true;
    return false;
  }
  return true;
}

export function setPill(state, text) {
  const p = $('connPill');
  p.className = 'pill ' + state;
  p.textContent = text;
}

export function setConnUI(connected) {
  $('deviceSection').classList.toggle('hidden', !connected);
  $('connectCard').classList.toggle('hidden', connected);
  // 注意：页签栏不再跟随蓝牙连接状态，登录后即显示（用户管理无需连接设备）
}

/* ---------- GATT 服务树渲染 ----------
 * 按钮通过 data-action/data-uuid 声明意图，
 * 事件统一由 main.js 在容器上委托处理，渲染层不耦合蓝牙逻辑。 */
export function renderSvcTree(servicesCache) {
  const tree = $('svcTree');
  if (!servicesCache.length) { tree.innerHTML = '<div class="placeholder">未发现服务。</div>'; return; }
  tree.innerHTML = '';
  servicesCache.forEach((svc) => {
    const card = document.createElement('div');
    card.className = 'svc';
    card.innerHTML = `
      <div class="svc-head"><span class="svc-name">${esc(svc.name || '服务')}</span>
        <span class="mono dim">${esc(shortUuid(svc.uuid))}</span></div>
      <div class="svc-body"></div>`;
    const body = card.querySelector('.svc-body');
    card.querySelector('.svc-head').addEventListener('click', () => body.classList.toggle('open'));

    if (!svc.chars.length) {
      body.insertAdjacentHTML('beforeend', '<div class="dim" style="padding:6px 0">（无特征）</div>');
    }
    svc.chars.forEach((ci) => {
      const props = Object.keys(ci.props).filter((k) => ci.props[k]);
      const propsText = props.join(' ') || '无属性';
      const row = document.createElement('div');
      row.className = 'char';
      row.dataset.uuid = ci.uuid;
      row.innerHTML = `
        <div class="char-head">
          <span class="char-title">${esc(ci.name || '特征')}</span>
          <span class="dim mono">${esc(shortUuid(ci.uuid))}</span>
        </div>
        <div class="char-props">${esc(propsText)}</div>
        <div class="char-actions"></div>
        <div class="char-value" data-out>值：<span class="dim">—</span></div>`;
      const acts = row.querySelector('.char-actions');
      const btn = (label, cls, action) => {
        const b = document.createElement('button');
        b.className = 'btn ' + cls;
        b.textContent = label;
        b.dataset.action = action;
        b.dataset.uuid = ci.uuid;
        return b;
      };

      if (ci.props.read) {
        acts.appendChild(btn('读取', 'ghost small', 'read'));
        acts.appendChild(btn('定读', 'ghost small', 'poll'));
      }
      if (ci.props.notify || ci.props.indicate) {
        acts.appendChild(btn(ci.props.notify ? '订阅' : '订阅(表)', 'ghost small accent', 'notify'));
      }
      if (ci.props.write || ci.props.writeWithoutResponse) {
        const inp = document.createElement('input');
        inp.className = 'text mono write-in';
        inp.placeholder = '写入内容（HEX 或文本）';
        inp.dataset.uuid = ci.uuid;
        acts.appendChild(inp);
        if (ci.props.write) acts.appendChild(btn('写', 'ghost small', 'write'));
        if (ci.props.writeWithoutResponse) acts.appendChild(btn('无响应', 'ghost small', 'writeNR'));
      }
      body.appendChild(row);
    });
    tree.appendChild(card);
  });
}

export function setCharValue(uuid, text) {
  const row = document.querySelector(`.char[data-uuid="${uuid}"]`);
  if (row) {
    const v = row.querySelector('.char-value span');
    if (v) { v.textContent = text; v.classList.remove('dim'); }
  }
}

/** 复位全部「停止定读」按钮文案 */
export function resetPollButtons() {
  document.querySelectorAll('.char button').forEach((b) => {
    if (b.textContent === '停止定读') { b.textContent = '定读'; b.classList.remove('on'); }
  });
}

/* ---------- 广播数据渲染 ---------- */
export function renderAdvertisement(dev) {
  const el = $('advView');
  const ad = dev.adData;
  const lines = [];
  lines.push(`设备名称 : ${dev.name || '(未命名)'}`);
  lines.push(`设备 ID  : ${dev.id}`);
  if (!ad) {
    lines.push('（无可用的广播数据）');
    el.innerHTML = renderKV(lines);
    return;
  }
  lines.push(`可连接 : ${ad.connected === false ? '否' : '是'}`);
  if (ad.rssi != null) lines.push(`RSSI : ${ad.rssi} dBm`);
  if (ad.txPower != null) lines.push(`TX 功率 : ${ad.txPower} dBm`);
  if (ad.appearance != null) lines.push(`外观 : 0x${ad.appearance.toString(16).padStart(4, '0')} (${appearanceName(ad.appearance)})`);
  if (ad.serviceUUIDs && ad.serviceUUIDs.size) {
    lines.push('服务 UUID:');
    for (const u of ad.serviceUUIDs) {
      const n = serviceName(u);
      lines.push(`  ${shortUuid(u)}${n ? ' - ' + n : ''}`);
    }
  } else {
    lines.push('服务 UUID: （无）');
  }
  if (ad.manufacturerData && ad.manufacturerData.size) {
    lines.push('厂商数据:');
    for (const [id, data] of ad.manufacturerData) {
      const dv = new DataView(data.buffer, data.byteOffset || 0, data.byteLength || 0);
      const company = dv.byteLength >= 2 ? dv.getUint16(0, true) : id;
      const rest = new Uint8Array(data.buffer, (data.byteOffset || 0) + (dv.byteLength >= 2 ? 2 : 0), data.byteLength - (dv.byteLength >= 2 ? 2 : 0));
      lines.push(`  ${companyName(company)} (0x${company.toString(16).padStart(4, '0')}): ${hexBytes(rest)}`);
    }
  }
  if (ad.serviceData && ad.serviceData.size) {
    lines.push('服务数据:');
    for (const [u, data] of ad.serviceData) {
      lines.push(`  ${shortUuid(u)}: ${hexBytes(new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || 0))}`);
    }
  }
  el.innerHTML = renderKV(lines);
}

function renderKV(lines) {
  return lines.map((l) => `<div>${esc(l)}</div>`).join('');
}

/* ---------- 文件下载 ---------- */
export function downloadFile(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

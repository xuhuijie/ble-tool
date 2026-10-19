/* ============================================================
 * UART 透传面板：TX/RX 特征配置、发送、自动订阅 RX
 * ============================================================ */
'use strict';

import { parseHex, encodeAuto, formatData } from './codec.js';
import { charLabel, shortUuid } from './names.js';
import { canonicalUuid } from './device-filter.js';
import { KEYS, loadJson, saveJson } from './storage.js';
import { $, toast, appendLog, appendUartRx, appendUartTx } from './ui.js';

const DEFAULT_CFG = { txService: '', txChar: '', rxService: '', rxChar: '' };

export class UartPanel {
  /** @param {import('./ble-service.js').BleService} ble */
  constructor(ble) {
    this.ble = ble;
    this.cfg = { ...DEFAULT_CFG };
    this.sendMode = 'text'; // text / hex
  }

  /** 从 localStorage 载入配置并回填输入框 */
  load() {
    this.cfg = { ...DEFAULT_CFG, ...loadJson(KEYS.UART, {}) };
    this.fillInputs();
  }

  /** 回填透传页输入框 */
  fillInputs() {
    $('uartTxSvc').value = this.cfg.txService;
    $('uartTxChar').value = this.cfg.txChar;
    $('uartRxSvc').value = this.cfg.rxService;
    $('uartRxChar').value = this.cfg.rxChar;
  }

  /** 应用设备绑定的透传配置（切换设备时调用） */
  applyConfig(uart) {
    this.cfg = {
      txService: uart?.txSvc || '', txChar: uart?.txChar || '',
      rxService: uart?.rxSvc || '', rxChar: uart?.rxChar || '',
    };
    this.fillInputs();
  }

  /** 读取透传页输入框的当前配置 */
  readInputs() {
    return {
      txSvc: $('uartTxSvc').value.trim(), txChar: $('uartTxChar').value.trim(),
      rxSvc: $('uartRxSvc').value.trim(), rxChar: $('uartRxChar').value.trim(),
    };
  }

  /** 保存配置并立即生效（自动订阅 RX） */
  save() {
    this.cfg = {
      txService: $('uartTxSvc').value.trim(), txChar: $('uartTxChar').value.trim(),
      rxService: $('uartRxSvc').value.trim(), rxChar: $('uartRxChar').value.trim(),
    };
    saveJson(KEYS.UART, this.cfg);
    this.autoSubscribeRx();
    toast('UART 配置已保存');
    appendLog('sys', 'UART 配置已保存');
  }

  setSendMode(mode) { this.sendMode = mode; }

  /** 当前特征值是否为配置的 RX（用于通知路由到接收区） */
  isRxChar(uuid) {
    if (!this.cfg.rxChar) return false;
    return canonicalUuid(uuid) === canonicalUuid(this.cfg.rxChar);
  }

  /** 连接成功 / 保存配置后自动订阅 RX 特征 */
  async autoSubscribeRx() {
    if (!this.ble.server || !this.cfg.rxChar) return;
    const canon = canonicalUuid(this.cfg.rxChar);
    if (!canon) return;
    try {
      const ok = await this.ble.subscribeForUart(canon);
      if (ok) appendLog('sys', `已自动订阅 RX 特征值(${shortUuid(canon)})`);
    } catch (err) {
      appendLog('err', '自动订阅 RX 失败：' + err.message);
    }
  }

  /** 发送（按当前 sendMode 编码；TX 未配置时自动选首个可写特征） */
  async send() {
    const raw = $('sendInput').value;
    if (!raw.trim()) { toast('请输入内容', true); return; }
    let u8;
    if (this.sendMode === 'hex') {
      try { u8 = parseHex(raw); } catch (err) { toast(err.message, true); return; }
      if (!u8.length) { toast('HEX 无效', true); return; }
    } else {
      u8 = encodeAuto(raw);
    }

    let target;
    if (this.cfg.txChar) {
      const canon = canonicalUuid(this.cfg.txChar);
      target = canon ? this.ble.findChar(canon) : null;
      if (!target) { toast('未找到配置的 TX 特征', true); return; }
    } else {
      target = this.ble.firstWritableChar();
      if (!target) { toast('设备没有可写特征，请配置 TX UUID', true); return; }
    }
    try {
      // 与旧版一致：优先无响应写（可用时）
      if (target.props.writeWithoutResponse) await target.char.writeValueWithoutResponse(u8);
      else await target.char.writeValue(u8);
      appendUartTx(u8);
      appendLog('tx', `TX -> ${charLabel(target.uuid)}: ${formatData(u8)}`);
    } catch (err) {
      appendLog('err', '发送失败：' + err.message);
      toast('发送失败', true);
    }
  }

  /** 通知路由入口：RX 特征的值进接收区 */
  routeValue(uuid, u8) {
    if (this.isRxChar(uuid)) appendUartRx('', u8);
  }
}

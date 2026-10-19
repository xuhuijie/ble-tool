/* ============================================================
 * 蓝牙服务层：所有 navigator.bluetooth 调用集中于此
 *
 * 职责：
 *   - 扫描：系统选择框（requestDevice）
 *   - 连接生命周期：连接 / 断开 / 意外断开回调
 *   - GATT 操作：服务发现 / 读 / 写 / 订阅通知 / 定时读
 *
 * 与 UI 解耦：通过构造时注入的 hooks 回调向外通知
 *   log(kind, text)                    写系统日志
 *   onValue(uuid, u8, source)          特征值更新（read/notify）
 *   onDisconnected()                   意外断开
 *   onPollStop()                       定读停止（用于复位按钮文案）
 * ============================================================ */
'use strict';

import { buildOptionalServices, DeviceFilter } from './device-filter.js';
import { serviceName, characteristicName } from './names.js';

export class BleService {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.device = null;          // 当前已连接的 BluetoothDevice
    this.server = null;          // BluetoothRemoteGATTServer
    this.servicesCache = [];     // [{service, uuid, name, chars:[{char,uuid,name,props}]}]
    this.subscribed = new Set(); // 已订阅通知的特征 UUID
    this.pollTimer = null;
    this.pollTarget = null;
    this._boundChars = new WeakSet(); // 已绑定通知处理器的特征对象（防重复绑定）
    this._onDisconnected = (e) => this._handleDisconnected(e);
  }

  get connected() { return !!(this.device && this.device.gatt.connected); }

  log(kind, text) { this.hooks.log && this.hooks.log(kind, text); }

  /* ============ 扫描 ============ */

  /**
   * 系统选择框模式。requestDevice 必须由真实用户手势触发
   * （必须在点击事件原始调用栈内调用，不能从回退逻辑里链式代发）。
   * @returns {Promise<{ok:boolean, device?:object, rejected?:boolean}>}
   *   rejected=true 表示选中的设备没过筛选（如无名称被「只看已知设备」拦下）
   */
  async requestSystemDevice(filter) {
    const dev = await navigator.bluetooth.requestDevice(filter.toRequestOptions());
    // 兜底校验：名称关键字（大小写不敏感）+ 未知设备筛选，选中后统一拦截
    if (!filter.matches(dev)) {
      const reason = filter.namedOnly && !DeviceFilter.hasName(dev) ? 'unnamed' : 'keyword';
      return { ok: false, rejected: true, reason, name: dev?.name || '', keyword: filter.keyword };
    }
    return { ok: true, device: dev };
  }

  /* ============ 连接生命周期 ============ */

  /**
   * 建立连接：断开旧连接 → GATT 连接 → 服务发现 → 校验。
   * 服务数为 0 或发现失败时抛错（调用方据此把设备当作未知/不支持过滤掉）。
   * @returns {Promise<number>} 服务数量
   */
  async connect(dev) {
    // 若旧连接还挂着（搜索时直接连了新设备），先断开，避免两个连接同时往日志里灌数据
    if (this.device && this.device !== dev && this.device.gatt.connected) {
      try { await this.device.gatt.disconnect(); } catch {}
    }
    this.device = dev;
    this.server = await dev.gatt.connect();
    let svcCount;
    try {
      svcCount = await this.discoverServices();
    } catch (err) {
      // 服务发现失败同样视为不可用设备，断开后向上抛
      try { await dev.gatt.disconnect(); } catch {}
      throw err;
    }
    if (svcCount === 0) {
      try { await dev.gatt.disconnect(); } catch {}
      throw new Error('该设备无可用的 GATT 服务');
    }
    dev.addEventListener('gattserverdisconnected', this._onDisconnected);
    return svcCount;
  }

  /** 主动断开并清空全部连接态 */
  async disconnect() {
    this.stopPoll();
    this.subscribed.clear();
    const dev = this.device;
    // 先清空再断开：gattserverdisconnected 事件可能在 await 期间触发，
    // 此时 _handleDisconnected 里 e.target !== this.device（已置空），不会误走「意外断开」分支
    this.device = null;
    this.server = null;
    this.servicesCache = [];
    if (dev && dev.gatt.connected) {
      try { await dev.gatt.disconnect(); } catch {}
    }
  }

  _handleDisconnected(e) {
    this.stopPoll();
    this.subscribed.clear();
    if (this.device && e.target === this.device) {
      this.hooks.onDisconnected && this.hooks.onDisconnected();
    }
  }

  /* ============ GATT 操作 ============ */

  /** 发现并缓存全部服务与特征；返回服务数量（发现异常时抛出原始错误） */
  async discoverServices() {
    this.servicesCache = [];
    const svcs = await this.server.getPrimaryServices();
    for (const svc of svcs) {
      const chars = [];
      let chs = [];
      try { chs = await svc.getCharacteristics(); } catch {}
      for (const ch of chs) {
        chars.push({ char: ch, uuid: ch.uuid, name: characteristicName(ch.uuid), props: ch.properties });
      }
      this.servicesCache.push({ service: svc, uuid: svc.uuid, name: serviceName(svc.uuid), chars });
    }
    return this.servicesCache.length;
  }

  /** 按 UUID 查特征信息（服务刷新后特征可能消失，调用方需判空） */
  findChar(uuid) {
    for (const svc of this.servicesCache) {
      const ci = svc.chars.find((c) => c.uuid === uuid);
      if (ci) return ci;
    }
    return null;
  }

  isSubscribed(uuid) { return this.subscribed.has(uuid); }

  /** 读特征值。readValue() 返回 DataView，必须按 buffer/byteOffset/byteLength 构造 Uint8Array。 */
  async readCharacteristic(uuid) {
    const ci = this.findChar(uuid);
    if (!ci || !ci.props.read) throw new Error('特征不可读');
    const dv = await ci.char.readValue();
    const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    this.hooks.onValue && this.hooks.onValue(uuid, u8, 'read');
    return u8;
  }

  /** 写特征值（noResp=true 走无响应写） */
  async writeCharacteristic(uuid, data, noResp) {
    const ci = this.findChar(uuid);
    if (!ci) throw new Error('特征不存在');
    if (noResp) await ci.char.writeValueWithoutResponse(data);
    else await ci.char.writeValue(data);
    return ci;
  }

  /**
   * 切换通知订阅。返回切换后的状态（true=已订阅）。
   * 每个特征对象只绑定一次监听器（WeakSet 防重复，服务刷新重建缓存也不会叠加）。
   */
  async toggleNotify(uuid) {
    const ci = this.findChar(uuid);
    if (!ci || !(ci.props.notify || ci.props.indicate)) throw new Error('特征不支持通知');
    if (this.subscribed.has(uuid)) {
      try { await ci.char.stopNotifications(); } catch {}
      this.subscribed.delete(uuid);
      return false;
    }
    await ci.char.startNotifications();
    this._bindNotifyHandler(ci);
    this.subscribed.add(uuid);
    return true;
  }

  /** 按 UART 配置订阅 RX 特征（已订阅则直接成功） */
  async subscribeForUart(uuid) {
    const ci = this.findChar(uuid);
    if (!ci || !(ci.props.notify || ci.props.indicate)) return false;
    if (this.subscribed.has(uuid)) return true;
    await ci.char.startNotifications();
    this._bindNotifyHandler(ci);
    this.subscribed.add(uuid);
    return true;
  }

  /** 全局唯一的定时读取 */
  startPoll(uuid, intervalSec) {
    this.stopPoll();
    this.pollTarget = uuid;
    this.pollTimer = setInterval(async () => {
      if (!this.connected) { this.stopPoll(); return; }
      const ci = this.findChar(this.pollTarget); // 刷新服务后特征可能已不存在，判空防崩
      if (!ci) {
        this.log('err', '定读的特征已不存在，已停止定读');
        this.stopPoll();
        return;
      }
      try { await this.readCharacteristic(ci.uuid); }
      catch (err) { this.log('err', `定读失败：${err.message}`); this.stopPoll(); }
    }, intervalSec * 1000);
    this.readCharacteristic(uuid).catch(() => {});
  }

  stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.pollTarget = null;
      this.hooks.onPollStop && this.hooks.onPollStop();
    }
  }

  /** 第一个可写特征（UART 未配置 TX 时的自动选择） */
  firstWritableChar() {
    for (const svc of this.servicesCache) {
      const ci = svc.chars.find((c) => c.props.write || c.props.writeWithoutResponse);
      if (ci) return ci;
    }
    return null;
  }

  _bindNotifyHandler(ci) {
    if (this._boundChars.has(ci.char)) return;
    this._boundChars.add(ci.char);
    ci.char.addEventListener('characteristicvaluechanged', (e) => {
      const u8 = new Uint8Array(e.target.value.buffer.slice(0));
      this.hooks.onValue && this.hooks.onValue(ci.uuid, u8, 'notify');
    });
  }
}

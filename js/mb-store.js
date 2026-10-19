/* ============================================================
 * Modbus 设备/寄存器配置存储（服务端 D1，全局共享）
 * 读需登录；增删改仅管理员（服务端强制）。
 * ============================================================ */
'use strict';

import { ApiClient } from './api.js';

export class MbStore {
  constructor(api) {
    this.api = api || new ApiClient();
    this.devices = [];
  }

  async load() {
    const { devices } = await this.api.get('/api/devices');
    this.devices = Array.isArray(devices) ? devices : [];
  }

  getDevice(id) {
    return this.devices.find((d) => d.id === id) || null;
  }

  async addDevice({ name, bleName, slave, wordOrder, uart }) {
    const { device } = await this.api.post('/api/devices', {
      name, bleName, slave, wordOrder, uart,
    });
    this.devices.push(device);
    return device;
  }

  async updateDevice(id, patch) {
    const { device } = await this.api.patch(`/api/devices/${id}`, patch);
    const i = this.devices.findIndex((d) => d.id === id);
    if (i >= 0) this.devices[i] = device;
    return device;
  }

  async deleteDevice(id) {
    await this.api.del(`/api/devices/${id}`);
    this.devices = this.devices.filter((d) => d.id !== id);
  }

  async addRegister(deviceId, { name, address, regType, dataType, unit, scale, offset, options, readOptions }) {
    const { register } = await this.api.post(`/api/devices/${deviceId}/registers`, {
      name, address, regType, dataType, unit, scale, offset, options, readOptions,
    });
    const d = this.getDevice(deviceId);
    if (d) d.registers.push(register);
    return register;
  }

  async updateRegister(deviceId, regId, patch) {
    await this.api.patch(`/api/registers/${regId}`, patch);
    const d = this.getDevice(deviceId);
    if (d) {
      const r = d.registers.find((x) => x.id === regId);
      if (r) Object.assign(r, patch);
    }
  }

  /** 拖拽排序：按新顺序写 sort */
  async reorderRegisters(deviceId, orderedIds) {
    await this.api.put(`/api/devices/${deviceId}/registers/order`, { order: orderedIds });
    const dev = this.devices.find((d) => d.id === deviceId);
    if (dev && dev.registers) {
      const pos = new Map(orderedIds.map((id, i) => [id, i]));
      dev.registers.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    }
  }

  async deleteRegister(deviceId, regId) {
    await this.api.del(`/api/registers/${regId}`);
    const d = this.getDevice(deviceId);
    if (d) d.registers = d.registers.filter((x) => x.id !== regId);
  }
}

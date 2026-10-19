/* ============================================================
 * 持久化层：localStorage 统一读写（JSON 安全解析 + 容错）
 * 键名与旧版保持一致，老用户的配置无缝迁移。
 * ============================================================ */
'use strict';

export const KEYS = {
  UART: 'ble_uart',            // UART 透传配置
  PROTOCOLS: 'ble_protocols', // 协议解析规则
  MODBUS: 'ble_modbus',          // Modbus RTU 配置（设备地址等）
  MBDEVICES: 'ble_mb_devices',   // Modbus 设备/寄存器配置表
  USERS: 'ble_users',            // 本地用户（管理员/普通用户）
};

export function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export function loadText(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

export function saveText(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

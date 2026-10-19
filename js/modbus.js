/* ============================================================
 * Modbus RTU 协议：组帧 / CRC16 / 响应解析（纯函数，无 DOM/状态）
 *
 * 帧格式：[地址 1B][功能码 1B][数据 NB][CRC16 2B，低字节在前]
 * 支持功能码：0x03 读保持寄存器 / 0x04 读输入寄存器 /
 *             0x06 写单个寄存器 / 0x10 写多个寄存器
 * ============================================================ */
'use strict';

/** CRC16-Modbus：poly 0xA001，初值 0xFFFF */
export function crc16(data) {
  let crc = 0xFFFF;
  for (const b of data) {
    crc ^= b & 0xFF;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
    }
  }
  return crc & 0xFFFF;
}

const u16be = (v) => [(v >>> 8) & 0xFF, v & 0xFF];

/** 组装完整 RTU 帧（含 CRC） */
export function buildFrame(addr, func, data) {
  const body = Uint8Array.from([addr & 0xFF, func & 0xFF, ...data]);
  const crc = crc16(body);
  const frame = new Uint8Array(body.length + 2);
  frame.set(body);
  frame[body.length] = crc & 0xFF;          // CRC 低字节在前
  frame[body.length + 1] = (crc >>> 8) & 0xFF;
  return frame;
}

export const buildReadHolding = (addr, start, count) =>
  buildFrame(addr, 0x03, [...u16be(start), ...u16be(count)]);

export const buildReadInput = (addr, start, count) =>
  buildFrame(addr, 0x04, [...u16be(start), ...u16be(count)]);

export const buildWriteSingle = (addr, reg, value) =>
  buildFrame(addr, 0x06, [...u16be(reg), ...u16be(value)]);

export function buildWriteMultiple(addr, start, values) {
  const data = [...u16be(start), ...u16be(values.length), values.length * 2];
  for (const v of values) data.push(...u16be(v));
  return buildFrame(addr, 0x10, data);
}

/** 预期响应长度（组帧用；异常帧固定 5 字节） */
export function expectedLen(func, count) {
  if (func === 0x03 || func === 0x04) return 5 + 2 * count;
  if (func === 0x06 || func === 0x10) return 8;
  return 0;
}

export const EXCEPTIONS = {
  0x01: '非法功能码', 0x02: '非法数据地址', 0x03: '非法数据值',
  0x04: '从站设备故障', 0x05: '确认（需轮询）', 0x06: '从站忙',
};

const hex2 = (v) => '0x' + v.toString(16).padStart(2, '0').toUpperCase();

/**
 * 解析响应帧。返回 { ok, code, error, registers }
 * code: 'ok' | 'short' | 'addr' | 'crc' | 'func' | 'exception' | 'len'
 */
export function parseResponse(frame, addr, func, count) {
  if (!frame || frame.length < 5) return { ok: false, code: 'short', error: '帧太短' };
  if (frame[0] !== (addr & 0xFF)) {
    return { ok: false, code: 'addr', error: `地址不匹配（期望 ${addr}，收到 ${frame[0]}）` };
  }
  const recvCrc = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
  if (crc16(frame.slice(0, -2)) !== recvCrc) {
    return { ok: false, code: 'crc', error: 'CRC 校验失败' };
  }
  if (frame[1] === ((func | 0x80) & 0xFF)) {
    const code = frame[2];
    return { ok: false, code: 'exception', error: `从站异常：${EXCEPTIONS[code] || '未知异常码'}（${hex2(code)}）` };
  }
  if (frame[1] !== (func & 0xFF)) {
    return { ok: false, code: 'func', error: `功能码不匹配（期望 ${hex2(func)}，收到 ${hex2(frame[1])}）` };
  }
  if (func === 0x03 || func === 0x04) {
    const byteCount = frame[2];
    if (byteCount !== 2 * count) {
      return { ok: false, code: 'len', error: `字节数不符（期望 ${2 * count}，收到 ${byteCount}）` };
    }
    const registers = [];
    for (let i = 0; i < count; i++) {
      registers.push(((frame[3 + 2 * i] << 8) | frame[4 + 2 * i]) & 0xFFFF);
    }
    return { ok: true, code: 'ok', error: '', registers };
  }
  return { ok: true, code: 'ok', error: '', registers: [] }; // 0x06 / 0x10 写成功（回显）
}

/* ---------- 输入解析 ---------- */

function parseNum(text, min, max, label) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) throw new Error(`${label}不能为空`);
  const v = t.startsWith('0x') ? parseInt(t, 16) : parseInt(t, 10);
  if (isNaN(v) || v < min || v > max) {
    throw new Error(`${label}无效：${text}（范围 ${min}~${max}，支持 0x 十六进制）`);
  }
  return v;
}

/** 从站地址 1~247 */
export const parseAddr = (text) => parseNum(text, 1, 247, '设备地址');
/** 寄存器地址 0~65535（协议地址，0-based） */
export const parseReg = (text) => parseNum(text, 0, 0xFFFF, '寄存器地址');

/** 读取数量：0x03/0x04 最多 125，0x10 最多 123 */
export function parseCount(text, func) {
  const max = func === 0x10 ? 123 : 125;
  return parseNum(text, 1, max, '数量');
}

/** 写入值：单个（0x06）或空格/逗号分隔的多个（0x10），每个 0~65535 */
export function parseValues(text) {
  const parts = String(text ?? '').split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) throw new Error('写入值不能为空');
  return parts.map((p) => parseNum(p, 0, 0xFFFF, '写入值'));
}

/* ---------- 32 位解析（LONG / FLOAT） ---------- */

/**
 * 取 2 个寄存器的原始 32 位无符号值
 * @param {number[]} regs uint16 数组
 * @param {number} idx 起始寄存器索引
 * @param {'ABCD'|'CDAB'} order 字序：ABCD 大端（高字在前，电表常用）/ CDAB 小端（低字在前）
 */
export function regsToU32(regs, idx, order = 'ABCD') {
  const hi = regs[idx] & 0xFFFF, lo = regs[idx + 1] & 0xFFFF;
  const [w0, w1] = order === 'CDAB' ? [lo, hi] : [hi, lo];
  return (w0 * 0x10000 + w1) >>> 0;
}

/** u32 转有符号 int32 */
export function u32ToI32(u) {
  return u >= 0x80000000 ? u - 0x100000000 : u;
}

/** u32 按 IEEE 754 转 float32（大端） */
export function u32ToF32(u) {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, u >>> 0, false);
  return dv.getFloat32(0, false);
}

/** float32 转 u32 位模式（大端） */
export function f32ToU32(f) {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, f, false);
  return dv.getUint32(0, false);
}

/* ---------- 寄存器数据类型（设备配置用） ---------- */

export const DATA_TYPES = {
  uint16:  { label: 'UINT16',  count: 1 },
  int16:   { label: 'INT16',   count: 1 },
  uint32:  { label: 'UINT32',  count: 2 },
  int32:   { label: 'INT32',   count: 2 },
  float32: { label: 'FLOAT32', count: 2 },
  enum:    { label: '选择',    count: 1 },
};

const TYPE_RANGES = {
  uint16: [0, 65535], int16: [-32768, 32767],
  uint32: [0, 4294967295], int32: [-2147483648, 2147483647],
  enum: [0, 65535],
};

/** 按数据类型从寄存器数组解析原始值（number） */
export function parseTypedValue(regs, idx, dataType, order = 'ABCD') {
  const t = DATA_TYPES[dataType] || DATA_TYPES.uint16;
  if (t.count === 1) {
    const v = regs[idx] & 0xFFFF;
    return dataType === 'int16' ? (v >= 0x8000 ? v - 0x10000 : v) : v;
  }
  const u32 = regsToU32(regs, idx, order);
  if (dataType === 'int32') return u32ToI32(u32);
  if (dataType === 'float32') return u32ToF32(u32);
  return u32;
}

/**
 * 按数据类型把工程值编码为待写入的字数组（已做逆缩放/逆偏移与范围校验）
 * 返回长度 1（用 06 功能码）或 2（用 10 功能码）
 */
export function encodeTypedValue(dataType, engValue, scale = 1, offset = 0, order = 'ABCD') {
  if (typeof engValue !== 'number' || !Number.isFinite(engValue)) {
    throw new Error('写入值不是有效数字');
  }
  const rawF = (engValue - offset) / scale;
  if (dataType === 'float32') {
    const u = f32ToU32(rawF);
    const hi = (u >>> 16) & 0xFFFF, lo = u & 0xFFFF;
    return order === 'CDAB' ? [lo, hi] : [hi, lo];
  }
  const range = TYPE_RANGES[dataType];
  if (!range) throw new Error(`不支持的数据类型：${dataType}`);
  const raw = Math.round(rawF);
  if (raw < range[0] || raw > range[1]) {
    throw new Error(`写入值 ${engValue} 换算后 ${raw} 超出 ${dataType} 范围`);
  }
  if (DATA_TYPES[dataType].count === 1) return [raw & 0xFFFF];
  const u = raw < 0 ? raw + 0x100000000 : raw;
  const hi = Math.floor(u / 0x10000), lo = u % 0x10000;
  return order === 'CDAB' ? [lo, hi] : [hi, lo];
}

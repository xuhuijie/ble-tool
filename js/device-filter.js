/* ============================================================
 * 设备筛选器 —— 本工具的核心能力模块
 *
 * 三个筛选维度，全部决策统一收口到 DeviceFilter：
 *   1. 蓝牙名称筛选（keyword，大小写不敏感）
 *      - 系统选择框层：关键字展开为[原样/小写/大写]前缀变体做 OR 预过滤，
 *        兼顾大小写不敏感与原生隐藏无名设备；选中后由 matches() 做最终校验
 *   2. 未知设备筛选（namedOnly）
 *      - 一键排除无名称设备；系统选择框无法预先隐藏它们，
 *        选中后由 matches() 兜底校验并拒绝
 *   3. 服务 UUID 筛选（services）
 *      - 扫描层过滤 + 连接授权（optionalServices）双重职责
 *
 * 使用方式：
 *   const filter = DeviceFilter.fromUserInput({ name, serviceText, namedOnly });
 *   filter.matches(device)          // 客户端判定（选中校验）
 *   filter.toRequestOptions()       // 生成 requestDevice 参数
 *   filter.describe()               // 日志友好的条件描述
 * ============================================================ */
'use strict';

import { shortUuid } from './names.js';

// 常用 GATT 服务 UUID：连接时声明到 optionalServices，避免
// 「Origin is not allowed to access any service」导致服务枚举被浏览器拒绝
export const COMMON_SERVICES = [
  '1800','1801','1802','1803','1804','1805','1806','1807','1808','1809',
  '180a','180b','180c','180d','180e','180f','1810','1811','1812','1813',
  '1814','1815','1816','1817','1818','1819','181a','181b','181c','181d',
  '181e','181f','1820','1821','1822','1823','1824','1825','1826','1827',
  '1828','1829','182a','182b','182c','182d','182e','182f','1830','1831',
  '1832','1833','1834','1835','1836','1837','1838','1839','183a','183b',
  '183c','183d','183e','183f','1840','1841','1842','1843','1844','1845',
  '1846','1847','1848','1849','184a','184b','184c','184d','184e','184f',
  '1850','1851','1852','1853','1854','1855','1856','1857','1858','1859',
  '185a','185b','185c','185d','185e','185f','1860','1861','1862','1863',
  '1864','1865','1866','1867','1868','1869','186a','186b','186c',
  // 常见厂商/模组服务（串口透传类）
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
  '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 / CC2541 串口
  '0000fff0-0000-1000-8000-00805f9b34fb', // 常用模组服务
  '000018f0-0000-1000-8000-00805f9b34fb', // 各家自定义
  '0000fe00-0000-1000-8000-00805f9b34fb', // 私有扩展
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
];

// 把任意格式的服务 UUID 规范为完整小写 UUID：
// '180f' / '0x180F' / '0000180f' / '0000180f-0000-1000-8000-00805f9b34fb' 都
// 转成 '0000180f-0000-1000-8000-00805f9b34fb'；无法识别返回 ''。
export function normalizeServiceUuid(u) {
  let t = String(u || '').trim().toLowerCase();
  if (!t) return '';
  t = t.replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(t)) return '0000' + t + '-0000-1000-8000-00805f9b34fb';
  if (/^[0-9a-f]{8}$/.test(t)) return t + '-0000-1000-8000-00805f9b34fb';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) return t;
  return '';
}

// 任意 UUID（含特征 UUID）规范化：先走浏览器 BluetoothUUID，失败回退文本规则
export function canonicalUuid(u) {
  const t = String(u || '').trim();
  if (!t) return '';
  try { return BluetoothUUID.canonicalUUID(t); } catch { return normalizeServiceUuid(t) || t; }
}

// 连接时组装 optionalServices：常用表 + 用户填写的服务
// 关键：requestDevice 的 optionalServices 必须是「完整 UUID」（如
// 00001800-0000-1000-8000-00805f9b34fb），不能用 '1800' 这种短别名，
// 否则浏览器抛 "Invalid Service name: '1800'"，搜索直接失败。
export function buildOptionalServices(userSvc) {
  const list = [];
  const add = (raw) => {
    const c = normalizeServiceUuid(raw);
    if (c && !list.includes(c)) list.push(c);
  };
  COMMON_SERVICES.forEach(add);
  if (userSvc) String(userSvc).split(/[\s,;]+/).filter(Boolean).forEach(add);
  return list;
}

export class DeviceFilter {
  /**
   * @param {object} opts
   * @param {string}  opts.keyword    名称关键字（空 = 不限）
   * @param {string[]} opts.services  规范化后的服务 UUID 列表
   * @param {boolean} opts.namedOnly  只看有名称的设备（未知设备筛选）
   */
  constructor({ keyword = '', services = [], namedOnly = false } = {}) {
    this.keyword = String(keyword || '').trim();
    this.services = Array.isArray(services) ? services.filter(Boolean) : [];
    this.namedOnly = !!namedOnly;
  }

  /**
   * 从表单输入构建筛选器；服务 UUID 非法时抛出带原因的错误。
   * @param {{name?:string, serviceText?:string, namedOnly?:boolean}} input
   */
  static fromUserInput({ name = '', serviceText = '', namedOnly = false } = {}) {
    const tokens = String(serviceText || '').split(/[\s,;]+/).filter(Boolean);
    const services = [];
    for (const t of tokens) {
      const c = normalizeServiceUuid(t);
      if (!c) throw new Error(`服务 UUID 格式无效：${t}`);
      services.push(c);
    }
    return new DeviceFilter({ keyword: name, services, namedOnly });
  }

  /** 设备是否「已知」：有非空名称（未知设备筛选的核心判定） */
  static hasName(device) {
    return typeof device?.name === 'string' && device.name.length > 0;
  }

  /** 名称「包含」匹配（客户端判定，大小写不敏感；选中校验用） */
  matchesName(name) {
    if (!this.keyword) return true;
    return typeof name === 'string' && name.toLowerCase().includes(this.keyword.toLowerCase());
  }

  /** 完整校验：未知设备筛选 + 名称筛选（任一不过即拒绝） */
  matches(device) {
    if (this.namedOnly && !DeviceFilter.hasName(device)) return false;
    return this.matchesName(device?.name);
  }

  /** 是否携带任何扫描层条件（决定 requestDevice 用 filters 还是 acceptAllDevices） */
  hasCriteria() {
    return !!(this.keyword || this.services.length);
  }

  /**
   * 生成 requestDevice 参数（系统选择框模式）。
   * 大小写不敏感搜索：浏览器原生的 namePrefix 是大小写敏感的，这里把关键字展开为
   * [原样/小写/大写] 三种前缀变体做 OR 过滤，覆盖常见命名（NWM/nwm），同时保留原生
   * 过滤无名设备的能力；选中后再由 matches() 做最终的大小写不敏感「包含」校验。
   */
  toRequestOptions() {
    const opts = { optionalServices: buildOptionalServices(this.services.join(',')) };
    const variants = this.keyword
      ? [...new Set([this.keyword, this.keyword.toLowerCase(), this.keyword.toUpperCase()])]
      : [null];
    const filters = variants.map((v) => {
      const f = {};
      if (v) f.namePrefix = v;
      if (this.services.length) f.services = [...this.services];
      return f;
    }).filter((f) => Object.keys(f).length);
    if (filters.length) {
      opts.acceptAllDevices = false;
      opts.filters = filters;
    } else {
      opts.acceptAllDevices = true;
    }
    return opts;
  }

  /** 日志友好的条件描述 */
  describe() {
    const parts = [];
    parts.push(this.namedOnly ? '只看有名称设备' : '允许无名称设备');
    if (this.keyword) parts.push(`名称包含「${this.keyword}」`);
    if (this.services.length) parts.push(`服务 ${this.services.map((s) => shortUuid(s)).join('、')}`);
    return parts.join('，');
  }
}

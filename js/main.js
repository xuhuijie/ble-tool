/* ============================================================
 * 入口：页面流程编排 + 事件接线
 * main.js 只负责"什么时候调用谁"，业务逻辑在各自模块里。
 * ============================================================ */
'use strict';

import { DeviceFilter } from './device-filter.js';
import { ApiClient } from './api.js';
import { BleService } from './ble-service.js';
import { UartPanel } from './uart-panel.js';
import { ProtocolPanel } from './protocol-panel.js';
import { ModbusPanel } from './modbus-panel.js';
import { MbStore } from './mb-store.js';
import { MbDevicePanel } from './mb-device-panel.js';
import { MbAuth } from './mb-auth.js';
import { MbUserPanel } from './mb-user-panel.js';
import { encodeAuto, formatData } from './codec.js';
import { charLabel } from './names.js';

import {
  $, esc, toast, appendLog, appendGatt, setPill, setConnUI, detectSupport,
  renderSvcTree, renderAdvertisement, setCharValue, resetPollButtons,
  formatForView, exportLog, setLogFilter, setDisplayOptions,
} from './ui.js';

const VERSION = 'v20261019-w';
const SCAN_TIMEOUT_MS = 8000;

/* ---------- 页面状态 ---------- */
let pendingDevice = null;    // 搜索选中、尚未连接的设备
let lastKeyword = '';         // 上次搜索用的名称关键字（重连用）
let sendMode = 'text';       // 发送编码模式（镜像 UartPanel 状态）

/* ---------- 模块实例 ---------- */
const ble = new BleService({
  log: appendLog,
  onValue: handleValue,
  onDisconnected: handleUnexpectedDisconnect,
  onPollStop: resetPollButtons,
});
const uartPanel = new UartPanel(ble);
const protocolPanel = new ProtocolPanel();
const modbusPanel = new ModbusPanel(ble, uartPanel);
const api = new ApiClient();
const mbStore = new MbStore(api);
const mbDevicePanel = new MbDevicePanel(ble, modbusPanel, mbStore, uartPanel);
const auth = new MbAuth(api);
const userPanel = new MbUserPanel(auth);

/* ============================================================
 * 特征值统一路由：读 / 通知数据都从这里分发
 * ============================================================ */
function handleValue(uuid, u8, source) {
  const label = source === 'read' ? '读取' : '通知';
  setCharValue(uuid, formatForView(u8));
  appendLog('rx', `${label} ${charLabel(uuid)}: ${formatData(u8)}`);
  appendGatt(`${label} ${charLabel(uuid)}: ${formatData(u8)}`, '#4ade80');
  protocolPanel.onData(uuid, u8, source);
  uartPanel.routeValue(uuid, u8);
  modbusPanel.onRx(uuid, u8, source);
}

/* ============================================================
 * 搜索流程
 * ============================================================ */
async function searchDevice() {
  // 防重入：系统授权框未关闭时再次点击会把旧请求顶掉，
  // 旧 promise 以 "User canceled the permission prompt" 被拒
  if (searchDevice._busy) {
    toast('正在等待蓝牙授权，请先处理弹出的授权框', true);
    return;
  }
  searchDevice._busy = true;
  try {
  appendLog('sys', '点击搜索：开始查找设备…');
  // 防旧缓存混合页面：关键 DOM 缺失时明确报错，而不是静默崩掉
  if (!$('fName') || !$('fService') || !$('ckNamed')) {
    appendLog('err', '发现页面结构不完整（很可能加载了旧缓存）。请点击浏览器刷新按钮，或清除缓存后重开本页。');
    toast('页面是旧缓存，请刷新后再试', true);
    setPill('', '未连接');
    return;
  }

  let filter;
  try {
    filter = DeviceFilter.fromUserInput({
      name: $('fName').value.trim(),
      serviceText: $('fService').value.trim(),
      namedOnly: $('ckNamed').checked,
    });
  } catch (err) {
    toast(err.message, true);
    return;
  }
  lastKeyword = filter.keyword;

  return await searchSystem(filter);
  } finally {
    searchDevice._busy = false;
  }
}

/* ---- 系统选择框模式 ---- */
async function searchSystem(filter) {
  appendLog('sys', `当前模式：系统列表（${filter.describe()}）`);
  setPill('connecting', '搜索中…');
  try {
    const { ok, device, rejected, reason, name, keyword } = await ble.requestSystemDevice(filter);
    if (rejected) {
      // 兜底拦截：选中的设备没过筛选
      $('selectedCard').classList.add('hidden');
      setPill('', '未连接');
      if (reason === 'keyword') {
        toast(`名称不包含「${keyword}」（已忽略大小写）`, true);
        appendLog('sys', `所选设备「${name || '(未命名)'}」名称不包含关键字「${keyword}」（大小写不敏感），请重新选择。`);
      } else {
        toast('该设备未命名，已按「只看已知设备」过滤', true);
        appendLog('sys', '所选设备没有名称，被「只看已知设备」过滤。如需连接，请取消勾选后再搜索。');
      }
      return;
    }
    pendingDevice = device;
    // 选出后先显示已选设备，等用户点「连接」
    $('selectedName').textContent = device.name || '(未命名)';
    $('selectedMeta').textContent = `id: ${device.id.slice(0, 12)}…`;
    $('selectedCard').classList.remove('hidden');
    setPill('', '已选设备');
    appendLog('sys', `已选择设备：${device.name || '(未命名)'}，请点击「连接」`);
  } catch (err) {
    if (err.name === 'SecurityError') {
      appendLog('err', '搜索失败：请确认页面以 https:// 或 localhost 打开（当前非安全上下文），并开启蓝牙权限。');
      toast('需要 https 或 localhost 打开', true);
      setPill('', '未连接');
      return;
    }
    if (err.name !== 'NotFoundError') appendLog('err', '搜索失败/取消：' + (err.message || err.name));
    setPill('', '未连接');
  }
}

/* ============================================================
 * 连接流程
 * ============================================================ */
async function connectSelected() {
  if (!pendingDevice) { toast('请先搜索并选择设备', true); return; }
  setPill('connecting', '连接中…');
  try {
    await establishConnection(pendingDevice);
  } catch (err) {
    // 连接失败 -> 视为未知/不支持的设备，自动过滤
    pendingDevice = null;
    $('selectedCard').classList.add('hidden');
    setPill('', '未连接');
    appendLog('err', '所选设备不可用（未知或不支持），已过滤：' + (err.message || err.name));
    toast('设备不可用，已过滤', true);
  }
}

async function establishConnection(dev) {
  $('svcTree').innerHTML = '<div class="placeholder">正在读取服务…</div>';
  try {
    const svcCount = await ble.connect(dev);
    renderSvcTree(ble.servicesCache);
    protocolPanel.fillCharSelect(ble.servicesCache);
    const name = dev.name || '(未命名)';
    setPill('connected', '已连接');
    renderAdvertisement(dev);
    $('deviceInfo').textContent = `${name}  ·  id:${dev.id.slice(0, 8)}`;
    $('deviceLabel').textContent = `已连接 ${name}`;
    $('metaLabel').textContent = '浏览器负责 MTU 协商';
    setConnUI(true);
    $('btnReconnect').classList.add('hidden');
    appendLog('sys', `连接成功：${name} (${dev.id.slice(0, 12)}…)`);
    // 连接后自动按已保存的 UART 配置订阅 RX
    await uartPanel.autoSubscribeRx();
    return svcCount;
  } catch (err) {
    $('svcTree').innerHTML = `<div class="placeholder err">连接/读取服务失败：${esc(err.message)}</div>`;
    appendLog('err', '连接/读取服务失败：' + err.message);
    if (/not allowed to access/i.test(err.message)) {
      appendLog('sys', '提示：请在「服务 UUID 过滤」填入设备的主服务 UUID 后重新搜索连接。');
    }
    throw err;
  }
}

async function reconnectDevice() {
  const name = lastKeyword || $('fName').value.trim();
  try {
    // 与搜索一致：名称前缀 + 服务 UUID 过滤（含连接授权）
    const filter = DeviceFilter.fromUserInput({ name, serviceText: $('fService').value.trim() });
    const opts = filter.toRequestOptions();
    setPill('connecting', '选择设备…');
    const dev = await navigator.bluetooth.requestDevice(opts);
    setPill('connecting', '连接中…');
    // 走统一收尾：校验服务、刷新 UI、渲染广播数据、自动订阅 RX
    await establishConnection(dev);
    appendLog('sys', `重新连接成功：${dev.name || '(未命名)'}`);
  } catch (err) {
    appendLog('err', '重新连接失败：' + (err.message || err.name));
    setPill('', '未连接');
  }
}

function handleUnexpectedDisconnect() {
  setPill('', '已断开');
  setConnUI(false);
  // 意外断开时保留「已连接设备」卡片，否则「重新连接」按钮会被一起隐藏而无法点击
  $('deviceSection').classList.remove('hidden');
  appendLog('sys', '连接已断开（设备端断开或信号丢失），可点击「重新连接」或重新搜索设备');
}

async function disconnectDevice() {
  await ble.disconnect();
  $('svcTree').innerHTML = '';
  $('advView').textContent = '（连接后自动解析该设备的广播数据）';
  setPill('', '未连接');
  setConnUI(false);
  appendLog('sys', '已断开连接');
}

/* ============================================================
 * GATT 服务树操作（事件委托）
 * ============================================================ */
function handleSvcTreeClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const uuid = btn.dataset.uuid;
  const action = btn.dataset.action;
  const ci = ble.findChar(uuid);
  if (!ci) { toast('特征不存在，请刷新服务', true); return; }

  switch (action) {
    case 'read': doRead(uuid); break;
    case 'poll': doPoll(uuid, btn); break;
    case 'notify': doNotify(uuid, btn, ci); break;
    case 'write': doWrite(uuid, btn, false); break;
    case 'writeNR': doWrite(uuid, btn, true); break;
  }
}

async function doRead(uuid) {
  try {
    await ble.readCharacteristic(uuid);
  } catch (err) {
    appendLog('err', `读取 ${charLabel(uuid)} 失败：${err.message}`);
    toast('读取失败', true);
  }
}

function doPoll(uuid, btn) {
  if (ble.pollTimer) { ble.stopPoll(); toast('已停止定读'); return; }
  const sec = Math.max(1, parseInt($('pollInterval').value, 10) || 1);
  ble.startPoll(uuid, sec);
  btn.textContent = '停止定读';
  btn.classList.add('on');
  appendLog('sys', `开始定时读取 ${charLabel(uuid)}, 每 ${sec} 秒`);
  toast('开始定读');
}

async function doNotify(uuid, btn, ci) {
  try {
    const on = await ble.toggleNotify(uuid);
    btn.textContent = on ? '取消订阅' : (ci.props.notify ? '订阅' : '订阅(表)');
    btn.classList.toggle('on', on);
    appendLog('sys', on ? `已订阅通知：${charLabel(uuid)}` : `已取消订阅：${charLabel(uuid)}`);
  } catch (err) {
    appendLog('err', `订阅失败：${err.message}`);
    toast('订阅失败', true);
  }
}

async function doWrite(uuid, btn, noResp) {
  const row = btn.closest('.char');
  const inp = row && row.querySelector('input.write-in');
  if (!inp) return;
  const text = inp.value;
  if (!text.trim()) { toast('请输入内容', true); return; }
  let u8;
  try { u8 = encodeAuto(text); } catch (err) { toast(err.message, true); return; }
  if (!u8.length) { toast('没有可发送的数据', true); return; }
  try {
    await ble.writeCharacteristic(uuid, u8, noResp);
    const mode = noResp ? '写入(无响应)' : '写入';
    appendLog('tx', `${mode} ${charLabel(uuid)}: ${formatData(u8)}`);
    appendGatt(`${mode} ${charLabel(uuid)}: ${formatData(u8)}`, '#38bdf8');
    setCharValue(uuid, formatForView(u8));
  } catch (err) {
    appendLog('err', `${noResp ? '无响应写入' : '写入'} ${charLabel(uuid)} 失败：${err.message}`);
    toast('写入失败', true);
  }
}

/* ============================================================
 * 主题（深色/浅色）
 * ============================================================ */
function applyTheme(t, save = true) {
  const theme = t === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  if (save) { try { localStorage.setItem('ble_theme', theme); } catch {} }
  document.querySelectorAll('.theme-btn').forEach((b) => {
    b.textContent = theme === 'light' ? '🌙' : '☀️';
  });
}

/* ============================================================
 * 页签 / 搜索模式
 * ============================================================ */
function switchTab(name) {
  // 非管理员禁止进入用户页（按钮已隐藏，此处为兜底）
  if (name === 'mbuser' && !auth.isAdmin()) { toast('仅管理员可访问', true); return; }
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-body').forEach((b) => b.classList.toggle('active', b.id === 'tab-' + name));
  if (name === 'mbuser') userPanel.render();
}

/* ============================================================
 * 用户认证与权限
 * ============================================================ */
// 普通用户仅可见「设备」页 + 顶部连接区；管理员可见全部页签
const ADMIN_TABS = ['gatt', 'uart', 'modbus', 'proto'];
// 无 Web Bluetooth 的浏览器也能登录做用户/设备管理，只隐藏依赖实时蓝牙的页签
let bleOk = true;

async function applyAuthUI() {
  const u = auth.current();
  const isAdmin = auth.isAdmin();
  $('loginGate').classList.add('hidden');
  $('userBox').classList.remove('hidden');
  $('userBadge').textContent = `${u.username}（${isAdmin ? '管理员' : '普通用户'}）`;
  // 页签栏随登录显示，不再依赖蓝牙连接
  $('tabs').classList.remove('hidden');
  for (const t of ADMIN_TABS) {
    document.querySelector(`[data-tab="${t}"]`)?.classList.toggle('hidden', !isAdmin || !bleOk);
  }
  $('tabBtnUser').classList.toggle('hidden', !isAdmin);
  mbDevicePanel.setReadOnly(!isAdmin);
  // 若当前页签已被隐藏，切到设备页
  const active = document.querySelector('.tab.active');
  if (active && active.classList.contains('hidden')) switchTab('mbdev');
  if (isAdmin) {
    try { await auth.refreshUsers(); } catch {}
    userPanel.render();
  }
}

function showGate(mode) {
  $('loginGate').classList.remove('hidden');
  $('userBox').classList.add('hidden');
  $('loginForm').classList.toggle('hidden', mode !== 'login');
  $('setupForm').classList.toggle('hidden', mode !== 'setup');
  $('loginTitle').textContent = mode === 'setup' ? '创建管理员' : '登录';
  $('loginHint').textContent = '';
}

async function afterLogin(welcome) {
  applyAuthUI();
  await mbDevicePanel.load();
  await maybeMigrateLocal();
  if (welcome) toast(welcome);
}

async function doLogin() {
  try {
    const u = await auth.verify($('loginUser').value, $('loginPw').value);
    $('loginHint').textContent = '';
    await afterLogin(`欢迎，${u.username}`);
  } catch (err) {
    $('loginHint').textContent = err.message;
  }
}

async function doSetup() {
  const a = $('setupUser').value, b = $('setupPw').value, c = $('setupPw2').value;
  if (b !== c) { toast('两次密码不一致', true); return; }
  try {
    await auth.setupAdmin(a, b);
    await afterLogin('管理员已创建，欢迎使用');
  } catch (err) { toast(err.message, true); }
}

/** 一次性迁移：旧版 localStorage 设备配置导入 D1（仅管理员、仅服务端为空时） */
async function maybeMigrateLocal() {
  if (!auth.isAdmin()) return;
  let local = null;
  try { local = JSON.parse(localStorage.getItem('ble_mb_devices') || '[]'); } catch {}
  if (!Array.isArray(local) || !local.length) return;
  if (mbStore.devices.length) return;
  let n = 0;
  for (const d of local) {
    try {
      const nd = await mbStore.addDevice({
        name: d.name, bleName: d.bleName || '',
        slave: d.slave, wordOrder: d.wordOrder || 'ABCD',
      });
      for (const r of (d.registers || [])) {
        try {
          // 兼容旧版类型：holding→读写，input→只读
          const rt = r.regType === 'holding' ? 'readwrite'
            : r.regType === 'input' ? 'readonly' : r.regType;
          await mbStore.addRegister(nd.id, {
            name: r.name, address: r.address, regType: rt,
            dataType: r.dataType, unit: r.unit || '',
            scale: r.scale ?? 1, offset: r.offset ?? 0,
          });
        } catch {}
      }
      n++;
    } catch {}
  }
  try {
    localStorage.removeItem('ble_mb_devices');
    localStorage.removeItem('ble_users');
  } catch {}
  if (n) {
    appendLog('sys', `已将 ${n} 个本地设备配置迁移到云端`);
    await mbDevicePanel.load();
  }
}

function wireAuth() {
  $('btnLogin').addEventListener('click', doLogin);
  $('btnSetup').addEventListener('click', doSetup);
  $('loginPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('btnLogout').addEventListener('click', () => {
    auth.logout();
    $('loginUser').value = '';
    $('loginPw').value = '';
    $('tabs').classList.add('hidden');
    showGate('login');
    toast('已退出登录');
  });
  $('btnNuAdd').addEventListener('click', () => userPanel.addUser());
  $('userList').addEventListener('click', (e) => userPanel.onListClick(e));
  document.querySelector('[data-tab="mbuser"]').addEventListener('click', () => userPanel.render());
}

/* ============================================================
 * 初始化
 * ============================================================ */
async function init() {
  // 无 Web Bluetooth 的浏览器也能登录做用户/设备管理，不提前 return
  bleOk = detectSupport();

  // 连接卡片
  $('btnScan').addEventListener('click', searchDevice);
  $('btnConnectSel').addEventListener('click', connectSelected);
  $('btnDisconnect').addEventListener('click', disconnectDevice);
  $('btnReconnect').addEventListener('click', reconnectDevice);

  // GATT 服务树：事件委托（读/写/订阅/定读）
  $('svcTree').addEventListener('click', handleSvcTreeClick);
  $('btnRefreshSvc').addEventListener('click', async () => {
    if (!ble.server) return;
    $('svcTree').innerHTML = '<div class="placeholder">正在读取服务…</div>';
    try {
      const n = await ble.discoverServices();
      renderSvcTree(ble.servicesCache);
      protocolPanel.fillCharSelect(ble.servicesCache);
      appendLog('sys', `已发现 ${n} 个服务`);
    } catch (err) {
      $('svcTree').innerHTML = `<div class="placeholder err">读取服务失败：${esc(err.message)}</div>`;
      appendLog('err', '读取 GATT 服务失败：' + err.message);
    }
  });

  // UART 面板
  // 透传页保存 → 写入当前选中设备的透传配置（D1，随设备走）
  $('btnSaveUart').addEventListener('click', async () => {
    const dev = mbDevicePanel.curDevice();
    if (!dev) { toast('请先在「设备」页选择设备', true); return; }
    const uart = uartPanel.readInputs();
    try {
      await mbStore.updateDevice(dev.id, { uart });
      uartPanel.applyConfig(uart);
      uartPanel.autoSubscribeRx();
      toast(`透传配置已保存到「${dev.name}」`);
      appendLog('sys', `透传配置已保存到设备「${dev.name}」`);
    } catch (err) { toast(err.message, true); }
  });
  $('btnSend').addEventListener('click', () => uartPanel.send());

  // Modbus RTU
  $('btnMbSend').addEventListener('click', () => modbusPanel.execute());
  $('btnMbClear').addEventListener('click', () => { $('mbResult').innerHTML = ''; });
  $('mbFunc').addEventListener('change', () => { modbusPanel.syncFuncUI(); modbusPanel.saveCfg(); });
  $('mbFmt').addEventListener('change', () => { modbusPanel.syncOrderUI(); modbusPanel.saveCfg(); });
  $('mbOrder').addEventListener('change', () => modbusPanel.saveCfg());
  $('mbAddr').addEventListener('change', () => modbusPanel.saveCfg());

  // Modbus 设备配置
  $('mbdSel').addEventListener('change', (e) => mbDevicePanel.selectDevice(e.target.value));
  $('btnMbdAdd').addEventListener('click', () => mbDevicePanel.showDeviceForm('new'));
  $('btnMbdEdit').addEventListener('click', () => {
    if (mbDevicePanel.curDevice()) mbDevicePanel.showDeviceForm(mbDevicePanel.curDeviceId);
    else toast('先新增设备', true);
  });
  $('btnMbdDel').addEventListener('click', () => mbDevicePanel.deleteDevice());
  $('btnMbdSave').addEventListener('click', () => mbDevicePanel.saveDeviceForm());
  $('btnMbdCancel').addEventListener('click', () => mbDevicePanel.hideForms());
  $('btnMbrAdd').addEventListener('click', () => mbDevicePanel.showRegForm('new'));
  $('btnMbrSave').addEventListener('click', () => mbDevicePanel.saveRegForm());
  $('btnMbrCancel').addEventListener('click', () => mbDevicePanel.hideForms());
  // 选择"选择"类型时显示选项输入行
  $('mbrDataType').addEventListener('change', (e) => {
    const isEnum = e.target.value === 'enum';
    $('mbrOptionsWrap').classList.toggle('hidden', !isEnum);
    $('mbrReadOptionsWrap').classList.toggle('hidden', !isEnum);
  });
  $('btnMbrOptAdd').addEventListener('click', () => mbDevicePanel.addOptRow('mbrOptList'));
  $('btnMbrReadOptAdd').addEventListener('click', () => mbDevicePanel.addOptRow('mbrReadOptList'));
  $('mbrOptList').addEventListener('click', (e) => mbDevicePanel.onOptListClick(e));
  $('mbrReadOptList').addEventListener('click', (e) => mbDevicePanel.onOptListClick(e));
  $('btnMbrReadAll').addEventListener('click', () => mbDevicePanel.readAll());
  $('mbrList').addEventListener('click', (e) => mbDevicePanel.onListClick(e));
  $('mbrList').addEventListener('pointerdown', (e) => mbDevicePanel.onDragPointerDown(e));
  $('btnClearUartRx').addEventListener('click', () => { $('uartRx').textContent = ''; });
  $('sendMode').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    sendMode = b.dataset.mode;
    uartPanel.setSendMode(sendMode);
    document.querySelectorAll('#sendMode .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('sendInput').placeholder = sendMode === 'hex' ? '输入 HEX，如 01 02 A0 FF' : '输入文本…';
  });

  // 日志
  $('btnClearLog').addEventListener('click', () => { $('sysLog').textContent = ''; });
  $('btnExportLog').addEventListener('click', exportLog);
  document.querySelectorAll('input[data-filter]').forEach((chk) => {
    chk.addEventListener('change', () => setLogFilter(chk.dataset.filter, chk.checked));
  });

  // 显示选项
  $('viewFormat').addEventListener('change', (e) => setDisplayOptions({ format: e.target.value }));
  $('ckHex').addEventListener('change', (e) => setDisplayOptions({ hex: e.target.checked }));

  // 协议面板
  $('btnClearRes').addEventListener('click', () => protocolPanel.clearResults());
  $('btnExportCsv').addEventListener('click', () => protocolPanel.exportCsv());
  $('btnAddRule').addEventListener('click', () => protocolPanel.addEmptyRule());
  $('btnDelRule').addEventListener('click', () => protocolPanel.delRule());
  $('btnAddField').addEventListener('click', () => protocolPanel.addFieldFromSelection());
  $('btnProtoLoad').addEventListener('click', () => protocolPanel.loadFromInput());
  $('byteView').addEventListener('click', (e) => protocolPanel.handleByteClick(e));

  // 页签
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // 主题切换
  applyTheme(document.documentElement.dataset.theme || 'dark', false);
  document.querySelectorAll('.theme-btn').forEach((b) => b.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  }));

  // 用户认证（服务端）
  wireAuth();
  try { await auth.load(); } catch { /* 连不上服务端则走登录门 */ }

  // 载入持久化配置
  uartPanel.load();
  protocolPanel.load();
  modbusPanel.load();

  // 登录门禁：无用户则引导创建管理员，未登录则显示登录框
  if (!auth.hasUsers()) showGate('setup');
  else if (!auth.current()) showGate('login');
  else await afterLogin();

  setConnUI(false);
  setPill('', '未连接');
  appendLog('sys', '就绪。请点击「搜索设备」，在弹出的系统选择框中选择你的 BLE 设备。');
  appendLog('sys', `页面版本 ${VERSION}；如非最新请刷新（清缓存）后重试。`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

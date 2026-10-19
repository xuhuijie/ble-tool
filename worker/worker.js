/* ============================================================
 * ble-rtu-web Worker：静态资源 + /api/* 用户与设备配置接口
 *
 * 绑定：DB (D1), ASSETS (静态资源), AUTH_SECRET (secret)
 * 认证：PBKDF2-SHA256 密码哈希 + HMAC-SHA256 签名 token
 * 权限：设备/寄存器写操作仅管理员；读操作需登录
 * ============================================================ */
'use strict';

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------- base64url ---------- */
function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------- token ---------- */
async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64urlEncode(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

async function makeToken(secret, userId, ttlSec = 7 * 86400) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${b64urlEncode(enc.encode(userId))}.${b64urlEncode(enc.encode(String(exp)))}`;
  return `${body}.${await hmacSign(secret, body)}`;
}

async function verifyToken(secret, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [bId, bExp, sig] = parts;
  const expect = await hmacSign(secret, `${bId}.${bExp}`);
  if (sig.length !== expect.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return null;
  let userId, exp;
  try {
    userId = dec.decode(b64urlDecode(bId));
    exp = parseInt(dec.decode(b64urlDecode(bExp)), 10);
  } catch { return null; }
  if (!userId || !(exp > Date.now() / 1000)) return null;
  return { sub: userId, exp };
}

/* ---------- 密码 ---------- */
const PBKDF2_ITERS = 100000;

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERS }, key, 256);
  return `pbkdf2$${PBKDF2_ITERS}$${b64urlEncode(salt)}$${b64urlEncode(bits)}`;
}

async function verifyPassword(password, stored) {
  const [algo, iters, bSalt, bHash] = String(stored || '').split('$');
  if (algo !== 'pbkdf2' || !bSalt || !bHash) return false;
  const salt = b64urlDecode(bSalt);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: parseInt(iters, 10) || PBKDF2_ITERS }, key, 256);
  const a = b64urlEncode(bits);
  if (a.length !== bHash.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ bHash.charCodeAt(i);
  return diff === 0;
}

/* ---------- 响应 ---------- */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const err = (message, status = 400) => json({ error: message }, status);
async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}
const pubUser = (u) => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at });
/* 选项归一化：收 JSON 或 "0=名称,6=名称"（写入值=操作名称），返回规范 JSON（空则 ''） */
function normOptions(optStr) {
  const t = String(optStr || '').trim();
  if (!t) return '';
  const map = {};
  try {
    const o = JSON.parse(t);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) {
        const n = parseInt(k, 10);
        if (Number.isInteger(n)) map[n] = String(v);
      }
      if (Object.keys(map).length) return JSON.stringify(map);
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
  if (!Object.keys(map).length) throw new Error('bad options');
  return JSON.stringify(map);
}

/* 透传配置归一化：只收字符串 */
const normUart = (u) => ({
  txSvc: String(u?.txSvc || ''), txChar: String(u?.txChar || ''),
  rxSvc: String(u?.rxSvc || ''), rxChar: String(u?.rxChar || ''),
});

/* ---------- 鉴权 ---------- */
async function authUser(req, env) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  const t = await verifyToken(env.AUTH_SECRET, m[1]);
  if (!t) return null;
  const u = await env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?')
    .bind(t.sub).first();
  return u || null;
}
async function requireAdmin(req, env) {
  const u = await authUser(req, env);
  return u && u.role === 'admin' ? u : null;
}

/* ---------- 路由 ---------- */
async function handleApi(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;
  const method = req.method;

  // 公开：状态 / 初始化 / 登录
  if (p === '/api/auth/status' && method === 'GET') {
    const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
    return json({ hasUsers: (n?.c || 0) > 0 });
  }
  if (p === '/api/auth/setup' && method === 'POST') {
    const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
    if ((n?.c || 0) > 0) return err('已初始化', 403);
    const { username, password } = await readJson(req);
    if (!username?.trim()) return err('用户名不能为空');
    if (!password || password.length < 4) return err('密码至少 4 位');
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO users (id, username, pw, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, username.trim(), await hashPassword(password), 'admin', now).run();
    const token = await makeToken(env.AUTH_SECRET, id);
    return json({ token, user: { id, username: username.trim(), role: 'admin' } });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const { username, password } = await readJson(req);
    const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
      .bind(String(username || '').trim()).first();
    if (!u || !(await verifyPassword(password || '', u.pw))) {
      return err('用户名或密码错误', 401);
    }
    const token = await makeToken(env.AUTH_SECRET, u.id);
    return json({ token, user: pubUser(u) });
  }

  // 需登录
  const me = await authUser(req, env);
  if (!me) return err('未登录', 401);

  if (p === '/api/auth/me' && method === 'GET') return json({ user: me });

  // 用户管理：仅管理员
  if (p === '/api/users' && method === 'GET') {
    if (!await requireAdmin(req, env)) return err('仅管理员可访问', 403);
    const { results } = await env.DB.prepare(
      'SELECT id, username, role, created_at FROM users ORDER BY created_at').all();
    return json({ users: results });
  }
  if (p === '/api/users' && method === 'POST') {
    const admin = await requireAdmin(req, env);
    if (!admin) return err('仅管理员可访问', 403);
    const { username, password, role } = await readJson(req);
    if (!username?.trim()) return err('用户名不能为空');
    if (!password || password.length < 4) return err('密码至少 4 位');
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        'INSERT INTO users (id, username, pw, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, username.trim(), await hashPassword(password),
          role === 'admin' ? 'admin' : 'user', Date.now()).run();
    } catch { return err('用户名已存在', 409); }
    const u = await env.DB.prepare(
      'SELECT id, username, role, created_at FROM users WHERE id = ?').bind(id).first();
    return json({ user: u }, 201);
  }
  {
    const m = p.match(/^\/api\/users\/([^/]+)$/);
    if (m) {
      const admin = await requireAdmin(req, env);
      if (!admin) return err('仅管理员可访问', 403);
      const uid = m[1];
      const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(uid).first();
      if (!target) return err('用户不存在', 404);
      if (method === 'DELETE') {
        if (uid === admin.id) return err('不能删除自己', 400);
        if (target.role === 'admin') {
          const n = await env.DB.prepare(
            "SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").first();
          if ((n?.c || 0) <= 1) return err('至少保留一个管理员', 400);
        }
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
        return json({ ok: true });
      }
      if (method === 'PATCH') {
        const { role, password } = await readJson(req);
        if (role !== undefined) {
          const nr = role === 'admin' ? 'admin' : 'user';
          if (uid === admin.id && nr !== 'admin') return err('不能取消自己的管理员身份', 400);
          if (target.role === 'admin' && nr !== 'admin') {
            const n = await env.DB.prepare(
              "SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").first();
            if ((n?.c || 0) <= 1) return err('至少保留一个管理员', 400);
          }
          await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(nr, uid).run();
        }
        if (password !== undefined) {
          if (!password || password.length < 4) return err('密码至少 4 位');
          await env.DB.prepare('UPDATE users SET pw = ? WHERE id = ?')
            .bind(await hashPassword(password), uid).run();
        }
        const u = await env.DB.prepare(
          'SELECT id, username, role, created_at FROM users WHERE id = ?').bind(uid).first();
        return json({ user: u });
      }
    }
  }

  // 设备：读需登录，写仅管理员（服务端强制）
  const rowToDevice = async (d) => {
    const { results } = await env.DB.prepare(
      'SELECT * FROM registers WHERE device_id = ? ORDER BY sort, address').bind(d.id).all();
    return {
      id: d.id, name: d.name, bleName: d.ble_name, slave: d.slave,
      wordOrder: d.word_order,
      uart: {
        txSvc: d.tx_svc || '', txChar: d.tx_char || '',
        rxSvc: d.rx_svc || '', rxChar: d.rx_char || '',
      },
      registers: (results || []).map((r) => ({
        id: r.id, name: r.name, address: r.address, regType: r.reg_type,
        dataType: r.data_type, unit: r.unit, scale: r.scale, offset: r.offset,
        options: r.options || '',
        readOptions: r.read_options || '',
      })),
    };
  };
  if (p === '/api/devices' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM devices ORDER BY created_at').all();
    const devices = [];
    for (const d of (results || [])) devices.push(await rowToDevice(d));
    return json({ devices });
  }
  if (p === '/api/devices' && method === 'POST') {
    if (!await requireAdmin(req, env)) return err('仅管理员可修改配置', 403);
    const { name, bleName, slave, wordOrder, uart } = await readJson(req);
    if (!String(name || '').trim()) return err('设备名称不能为空');
    const s = parseInt(slave, 10);
    if (!(s >= 1 && s <= 247)) return err('从站地址范围 1~247');
    const u = normUart(uart);
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO devices (id, name, ble_name, slave, word_order, tx_svc, tx_char, rx_svc, rx_char, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name.trim(), String(bleName || ''), s,
        wordOrder === 'CDAB' ? 'CDAB' : 'ABCD',
        u.txSvc, u.txChar, u.rxSvc, u.rxChar, now, now).run();
    const d = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first();
    return json({ device: await rowToDevice(d) }, 201);
  }
  {
    const m = p.match(/^\/api\/devices\/([^/]+)$/);
    if (m) {
      const did = m[1];
      const d = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(did).first();
      if (!d) return err('设备不存在', 404);
      if (method === 'PATCH') {
        if (!await requireAdmin(req, env)) return err('仅管理员可修改配置', 403);
        const body = await readJson(req);
        const sets = [];
        const vals = [];
        if (body.name !== undefined) {
          if (!String(body.name).trim()) return err('设备名称不能为空');
          sets.push('name = ?'); vals.push(String(body.name).trim());
        }
        if (body.bleName !== undefined) { sets.push('ble_name = ?'); vals.push(String(body.bleName)); }
        if (body.slave !== undefined) {
          const sc = parseInt(body.slave, 10);
          if (!(sc >= 1 && sc <= 247)) return err('从站地址范围 1~247');
          sets.push('slave = ?'); vals.push(sc);
        }
        if (body.wordOrder !== undefined) {
          sets.push('word_order = ?'); vals.push(body.wordOrder === 'CDAB' ? 'CDAB' : 'ABCD');
        }
        if (body.uart !== undefined) {
          const u = normUart(body.uart);
          sets.push('tx_svc = ?', 'tx_char = ?', 'rx_svc = ?', 'rx_char = ?');
          vals.push(u.txSvc, u.txChar, u.rxSvc, u.rxChar);
        }
        if (!sets.length) return err('无可更新字段');
        sets.push('updated_at = ?'); vals.push(Date.now());
        vals.push(did);
        await env.DB.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        const nd = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(did).first();
        return json({ device: await rowToDevice(nd) });
      }
      if (method === 'DELETE') {
        if (!await requireAdmin(req, env)) return err('仅管理员可修改配置', 403);
        await env.DB.prepare('DELETE FROM registers WHERE device_id = ?').bind(did).run();
        await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(did).run();
        return json({ ok: true });
      }
    }
  }
  {
    const m = p.match(/^\/api\/devices\/([^/]+)\/registers$/);
    if (m && method === 'POST') {
      if (!await requireAdmin(req, env)) return err('仅管理员可修改配置', 403);
      const did = m[1];
      const d = await env.DB.prepare('SELECT id FROM devices WHERE id = ?').bind(did).first();
      if (!d) return err('设备不存在', 404);
      const { name, address, regType, dataType, unit, scale, offset, options, readOptions } = await readJson(req);
      if (!String(name || '').trim()) return err('变量名不能为空');
      const a = parseInt(address, 10);
      if (!(a >= 0 && a <= 65535)) return err('寄存器地址范围 0~65535');
      if (!['readonly', 'writeonly', 'readwrite'].includes(regType)) return err('寄存器类型无效');
      const validTypes = ['uint16', 'int16', 'uint32', 'int32', 'float32', 'enum'];
      if (!validTypes.includes(dataType)) return err('数据类型无效');
      const sc = parseFloat(scale), of = parseFloat(offset);
      if (!Number.isFinite(sc) || sc === 0) return err('缩放系数无效');
      if (!Number.isFinite(of)) return err('偏移量无效');
      let optJson = '', readOptJson = '';
      if (dataType === 'enum') {
        try { optJson = normOptions(options); }
        catch { return err('选项格式无效，如：0=周期测量, 6=校准模式'); }
        if (String(readOptions || '').trim()) {
          try { readOptJson = normOptions(readOptions); }
          catch { return err('读取选项格式无效，如：1=周期测量模式, 7=校准模式'); }
        }
      }
      const { results } = await env.DB.prepare(
        'SELECT COALESCE(MAX(sort), -1) AS mx FROM registers WHERE device_id = ?').bind(did).all();
      const id = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO registers (id, device_id, name, address, reg_type, data_type, unit, scale, offset, options, read_options, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, did, name.trim(), a, regType, dataType,
          String(unit || ''), sc, of, optJson, readOptJson, (results?.[0]?.mx ?? -1) + 1).run();
      return json({ register: { id, name: name.trim(), address: a, regType, dataType, unit: String(unit || ''), scale: sc, offset: of, options: optJson, readOptions: readOptJson } }, 201);
    }
  }
  {
    // 寄存器拖拽排序（仅管理员）
    const m = p.match(/^\/api\/devices\/([^/]+)\/registers\/order$/);
    if (m && method === 'PUT') {
      if (!await requireAdmin(req, env)) return err('仅管理员可修改配置', 403);
      const did = m[1];
      const d = await env.DB.prepare('SELECT id FROM devices WHERE id = ?').bind(did).first();
      if (!d) return err('设备不存在', 404);
      const { order } = await readJson(req);
      if (!Array.isArray(order) || !order.length) return err('排序数据无效');
      const batch = order.map((rid, i) =>
        env.DB.prepare('UPDATE registers SET sort = ? WHERE id = ? AND device_id = ?').bind(i, String(rid), did));
      await env.DB.batch(batch);
      return json({ ok: true });
    }
  }
  {
    const m = p.match(/^\/api\/registers\/([^/]+)$/);
    if (m) {
      if (!await requireAdmin(req, env)) return err('仅管理员可修改配置', 403);
      const rid = m[1];
      const r = await env.DB.prepare('SELECT * FROM registers WHERE id = ?').bind(rid).first();
      if (!r) return err('寄存器不存在', 404);
      if (method === 'PATCH') {
        const { name, address, regType, dataType, unit, scale, offset, options, readOptions } = await readJson(req);
        if (!String(name || '').trim()) return err('变量名不能为空');
        const a = parseInt(address, 10);
        if (!(a >= 0 && a <= 65535)) return err('寄存器地址范围 0~65535');
        if (!['readonly', 'writeonly', 'readwrite'].includes(regType)) return err('寄存器类型无效');
        const validTypes = ['uint16', 'int16', 'uint32', 'int32', 'float32', 'enum'];
        if (!validTypes.includes(dataType)) return err('数据类型无效');
        const sc = parseFloat(scale), of = parseFloat(offset);
        if (!Number.isFinite(sc) || sc === 0) return err('缩放系数无效');
        if (!Number.isFinite(of)) return err('偏移量无效');
        let optJson = '', readOptJson = '';
        if (dataType === 'enum') {
          try { optJson = normOptions(options); }
          catch { return err('选项格式无效，如：0=周期测量, 6=校准模式'); }
          if (String(readOptions || '').trim()) {
            try { readOptJson = normOptions(readOptions); }
            catch { return err('读取选项格式无效，如：1=周期测量模式, 7=校准模式'); }
          }
        }
        await env.DB.prepare(
          'UPDATE registers SET name = ?, address = ?, reg_type = ?, data_type = ?, unit = ?, scale = ?, offset = ?, options = ?, read_options = ? WHERE id = ?')
          .bind(name.trim(), a, regType, dataType, String(unit || ''), sc, of, optJson, readOptJson, rid).run();
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await env.DB.prepare('DELETE FROM registers WHERE id = ?').bind(rid).run();
        return json({ ok: true });
      }
    }
  }

  return err('未知接口', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      if (!env.DB) return err('数据库未绑定', 500);
      if (!env.AUTH_SECRET) return err('服务端未配置密钥', 500);
      try {
        return await handleApi(req, env);
      } catch (e) {
        return err('服务端错误', 500);
      }
    }
    try {
      return await env.ASSETS.fetch(req);
    } catch (e) {
      // 静态资源缺失（如 favicon.ico）：ASSETS 会抛异常，转为 404
      return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  },
};

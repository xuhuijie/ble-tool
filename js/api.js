/* ============================================================
 * 后端 API 客户端：token 存 sessionStorage，随请求带 Authorization
 * ============================================================ */
'use strict';

const TOKEN_KEY = 'ble_token';

export class ApiClient {
  constructor() {
    this.token = null;
    try { this.token = sessionStorage.getItem(TOKEN_KEY) || null; } catch {}
  }

  setToken(t) {
    this.token = t || null;
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {}
  }

  async req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('无法连接服务器');
    }
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  get(path) { return this.req('GET', path); }
  post(path, body) { return this.req('POST', path, body); }
  put(path, body) { return this.req('PUT', path, body); }
  patch(path, body) { return this.req('PATCH', path, body); }
  del(path) { return this.req('DELETE', path); }
}

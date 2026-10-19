/* ============================================================
 * 用户认证（服务端）：登录态 token 存 sessionStorage（关浏览器即登出）
 * 密码 PBKDF2 加盐哈希存 D1，权限由服务端强制执行。
 * ============================================================ */
'use strict';

import { ApiClient } from './api.js';

export class MbAuth {
  constructor(api) {
    this.api = api || new ApiClient();
    this.users = [];       // 管理员视角的缓存用户列表
    this._me = null;       // 当前登录用户
    this._hasUsers = false;
  }

  /** 初始化：查系统状态 + 恢复登录态 */
  async load() {
    try {
      const st = await this.api.get('/api/auth/status');
      this._hasUsers = !!st.hasUsers;
    } catch {
      this._hasUsers = false;
    }
    if (this.api.token) {
      try {
        const { user } = await this.api.get('/api/auth/me');
        this._me = user;
      } catch {
        this._me = null;
        this.api.setToken(null);
      }
    }
  }

  hasUsers() { return this._hasUsers; }
  current() { return this._me; }
  get currentId() { return this._me?.id || null; }
  isAdmin() { return this._me?.role === 'admin'; }

  /** 首次初始化：创建管理员（无需登录） */
  async setupAdmin(username, password) {
    username = String(username || '').trim();
    if (!username) throw new Error('用户名不能为空');
    if (!password || password.length < 4) throw new Error('密码至少 4 位');
    const { token, user } = await this.api.post('/api/auth/setup', { username, password });
    this.api.setToken(token);
    this._me = user;
    this._hasUsers = true;
    return user;
  }

  /** 登录 */
  async verify(username, password) {
    const { token, user } = await this.api.post('/api/auth/login', {
      username: String(username || '').trim(), password: password || '',
    });
    this.api.setToken(token);
    this._me = user;
    return user;
  }

  logout() {
    this._me = null;
    this.users = [];
    this.api.setToken(null);
  }

  /** 管理员：刷新用户列表 */
  async refreshUsers() {
    const { users } = await this.api.get('/api/users');
    this.users = users || [];
    return this.users;
  }

  /** 管理员：新增用户 */
  async createUser(username, password, role) {
    username = String(username || '').trim();
    if (!username) throw new Error('用户名不能为空');
    if (!password || password.length < 4) throw new Error('密码至少 4 位');
    const { user } = await this.api.post('/api/users', { username, password, role });
    await this.refreshUsers();
    return user;
  }

  async deleteUser(id) {
    await this.api.del(`/api/users/${id}`);
    await this.refreshUsers();
  }

  async resetPassword(id, password) {
    if (!password || password.length < 4) throw new Error('密码至少 4 位');
    await this.api.patch(`/api/users/${id}`, { password });
  }

  async setRole(id, role) {
    const { user } = await this.api.patch(`/api/users/${id}`, { role });
    await this.refreshUsers();
    return user;
  }
}

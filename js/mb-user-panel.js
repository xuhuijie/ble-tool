/* ============================================================
 * 用户管理面板（仅管理员可见）：用户列表 / 新增 / 删改角色 / 重置密码
 * ============================================================ */
'use strict';

import { $, esc, toast } from './ui.js';

const ROLE_LABEL = { admin: '管理员', user: '普通用户' };

export class MbUserPanel {
  /** @param {import('./mb-auth.js').MbAuth} auth */
  constructor(auth) {
    this.auth = auth;
  }

  render() {
    const el = $('userList');
    const users = this.auth.users;
    if (!users.length) {
      el.innerHTML = '<div class="placeholder">暂无用户</div>';
      return;
    }
    el.innerHTML = users.map((u) => {
      const isSelf = u.id === this.auth.currentId;
      const d = new Date(u.created);
      const created = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return `<div class="rule-row">
        <div class="row between">
          <b>${esc(u.username)}</b>
          <span class="dim">${ROLE_LABEL[u.role] || u.role} · 创建于 ${created}${isSelf ? ' · 当前登录' : ''}</span>
        </div>
        <div class="row">
          <button class="btn ghost small" data-role="${u.id}">${u.role === 'admin' ? '降为普通用户' : '升为管理员'}</button>
          <button class="btn ghost small" data-resetpw="${u.id}">重置密码</button>
          <button class="btn ghost small" data-deluser="${u.id}">删除</button>
        </div>
      </div>`;
    }).join('');
  }

  async onListClick(e) {
    const roleBtn = e.target.closest('[data-role]');
    if (roleBtn) {
      const u = this.auth.users.find((x) => x.id === roleBtn.dataset.role);
      if (!u) return;
      try {
        await this.auth.setRole(u.id, u.role === 'admin' ? 'user' : 'admin');
        toast(`已更新：${u.username}`);
      } catch (err) { toast(err.message, true); return; }
      this.render();
      return;
    }
    const resetBtn = e.target.closest('[data-resetpw]');
    if (resetBtn) {
      const u = this.auth.users.find((x) => x.id === resetBtn.dataset.resetpw);
      if (!u) return;
      const pw = prompt(`为「${u.username}」设置新密码（至少 4 位）：`);
      if (pw === null) return;
      this.auth.resetPassword(u.id, pw).then(() => {
        toast('密码已重置');
        this.render();
      }).catch((err) => toast(err.message, true));
      return;
    }
    const delBtn = e.target.closest('[data-deluser]');
    if (delBtn) {
      const u = this.auth.users.find((x) => x.id === delBtn.dataset.deluser);
      if (!u) return;
      if (!confirm(`删除用户「${u.username}」？`)) return;
      try { await this.auth.deleteUser(u.id); toast('已删除'); }
      catch (err) { toast(err.message, true); return; }
      this.render();
    }
  }

  async addUser() {
    const name = $('nuName').value.trim();
    const pw = $('nuPw').value;
    const role = $('nuRole').value;
    try {
      await this.auth.createUser(name, pw, role);
    } catch (err) { toast(err.message, true); return; }
    $('nuName').value = '';
    $('nuPw').value = '';
    toast(`用户「${name}」已创建`);
    this.render();
  }
}

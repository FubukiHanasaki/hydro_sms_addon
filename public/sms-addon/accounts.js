/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
  const app = document.getElementById('sms-app'); if (!app) return;
  const $ = id => document.getElementById(id); let me; let page = 1; let request = 0; let save; const selected = new Map(); let currentRows = [];
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); return node; };
  function error(e) { const node = $('sms-account-dialog').open ? $('sms-account-error') : $('sms-notice'); node.textContent = e.message; node.hidden = false; }
  function button(text, work) { const node = el('button', 'link sms-link', text); node.type = 'button'; node.addEventListener('click', () => Promise.resolve().then(work).catch(error)); return node; }
  async function api(url, body) {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-SMS-Request': '1', Accept: 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let result; try { result = await response.json(); } catch { throw new Error('服务响应异常，请刷新后重试'); }
    if (!response.ok || !Object.hasOwn(result, 'data')) throw new Error(result.message || '账号操作未完成，请刷新后确认'); return result.data;
  }
  async function load() {
    const serial = ++request; const url = new URL(app.dataset.accounts, location.origin); url.search = new URLSearchParams({ q: $('sms-account-query').value, enabled: $('sms-account-enabled').value, page }); const data = await api(url); if (serial !== request) return;
    app.dataset.exportAccounts = JSON.stringify(Object.fromEntries(url.searchParams));
    currentRows = data.accounts; for (const a of data.accounts) if (selected.has(a.uid)) { if (a.protected) selected.delete(a.uid); else selected.set(a.uid, a); }
    const rows = $('sms-account-rows'); rows.replaceChildren();
    for (const account of data.accounts) {
      const row = el('tr'); const cell = el('td'); const check = el('input'); check.type = 'checkbox'; check.disabled = account.protected || !me.capabilities['accounts.password']; check.checked = selected.has(account.uid); check.setAttribute('aria-label', `选择 ${account.username}`); check.dataset.uid = account.uid; check.addEventListener('change', () => { if (check.checked) selected.set(account.uid, account); else selected.delete(account.uid); selection(); }); cell.append(check); row.append(cell); const name = el('td'); name.append(el('div', 'sms-student-name', account.username), el('div', 'sms-secondary', `UID ${account.uid}`)); row.append(name, el('td', '', account.studentName || '未绑定学生档案'), el('td', account.enabled ? 'text-green' : 'text-gray', account.enabled ? '已启用' : '已停用'));
      const actions = el('td'); const group = el('div', 'sms-org-actions');
      if (account.protected) group.append(el('span', 'help-text', '受保护账号'));
      else {if(me.capabilities['accounts.rename'])group.append(button('修改用户名',()=>open('rename',account)));if(me.capabilities['accounts.password'])group.append(button('重置密码',()=>open('password',account)));if(me.capabilities['accounts.status'])group.append(button(account.enabled?'停用':'启用',()=>open('status',account)));}
      const profile = el('a', 'link sms-link', '资料页 ↗'); profile.href = `/user/${account.uid}`; group.append(profile); actions.append(group); row.append(actions); rows.append(row);
    }
    if (!data.accounts.length) { const row = el('tr'); const cell = el('td', 'help-text', '没有符合条件的账号'); cell.colSpan = 5; row.append(cell); rows.append(row); }
    selection();
    $('sms-account-summary').textContent = `共 ${data.total} 个账号`;
    $('sms-account-page').textContent = `第 ${page} / ${Math.max(1, Math.ceil(data.total / 20))} 页`; $('sms-account-prev').disabled = page <= 1; $('sms-account-next').disabled = page * 20 >= data.total;
  }
  function selection() { const available = currentRows.filter(a => !a.protected && me.capabilities['accounts.password']); const count = available.filter(a => selected.has(a.uid)).length; $('sms-account-select-page').checked = !!available.length && count === available.length; $('sms-account-select-page').indeterminate = count > 0 && count < available.length; $('sms-account-select-page').disabled = !available.length; $('sms-account-bulk-password').textContent = `批量重置密码（${selected.size}）`; $('sms-account-bulk-password').disabled = !selected.size; $('sms-account-clear-selection').hidden = !selected.size; }
  $('sms-account-select-page').addEventListener('change', e => { for (const a of currentRows.filter(a => !a.protected && me.capabilities['accounts.password'])) { if (e.target.checked) selected.set(a.uid, a); else selected.delete(a.uid); } for (const c of $('sms-account-rows').querySelectorAll('input[data-uid]')) c.checked = selected.has(Number(c.dataset.uid)); selection(); });
  $('sms-account-clear-selection').addEventListener('click', () => { selected.clear(); load().catch(error); });
  $('sms-account-bulk-password').addEventListener('click', () => app.dispatchEvent(new CustomEvent('sms:bulk-password', { detail: [...selected.keys()] })));
  app.addEventListener('sms:bulk-complete', () => { selected.clear(); if (location.hash === '#accounts') load().catch(error); });
  function field(root, id, label, type = 'text', value = '') {
    const wrap = el('label', 'sms-field', label); const input = el('input', 'textbox'); input.id = id; input.type = type; input.value = value; input.required = true; input.maxLength = type === 'password' ? 255 : 100; input.autocomplete = type === 'password' ? 'new-password' : 'off'; wrap.append(input); root.append(wrap); return input;
  }
  function requestId() { const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128; const s = [...bytes].map(n => n.toString(16).padStart(2, '0')).join(''); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`; }
  function open(action, account) {
    const root = $('sms-account-fields'); root.replaceChildren(); $('sms-account-error').textContent = '';
    $('sms-account-title').textContent = action === 'create' ? '创建账号' : `${({ rename: '修改用户名', password: '重置密码', status: account?.enabled ? '停用账号' : '启用账号' })[action]} · ${account.username}`;
    let username; let password; let verify;
    if (action === 'create' || action === 'rename') username = field(root, 'sms-edit-account-username', '用户名 *', 'text', account?.username || '');
    if (action === 'create' || action === 'password') { password = field(root, 'sms-edit-account-password', '密码（6–255 个字符）*', 'password'); password.minLength = 6; verify = field(root, 'sms-edit-account-verify', '确认密码 *', 'password'); verify.minLength = 6; }
    if (action === 'status') root.append(el('p', '', account.enabled ? '确认停用此账号？停用后将退出登录并无法登录。' : '确认启用此账号？'));
    if (action === 'password') root.append(el('p', 'help-text', '保存后旧密码和现有会话失效。'));
    const key = action === 'create' ? requestId() : null;
    save = async () => {
      if (password && password.value !== verify.value) throw new Error('两次密码输入不一致');
      const body = action === 'create' ? { username: username.value, password: password.value, requestId: key } : { action, version: account.version, ...(username ? { username: username.value } : {}), ...(password ? { password: password.value } : {}), ...(action === 'status' ? { enabled: !account.enabled } : {}) };
      const result = await api(action === 'create' ? app.dataset.accounts : `${app.dataset.accounts}/${account.uid}`, body); $('sms-account-dialog').close(); $('sms-notice').hidden = false; $('sms-notice').textContent = action === 'create' ? `账号已创建：${result.username}（UID ${result.uid}）。` : '账号已更新。'; await load();
    };
    $('sms-account-dialog').showModal();
  }
  $('sms-account-form').addEventListener('submit', async e => { e.preventDefault(); const node = $('sms-account-save'); node.disabled = true; try { await save(); } catch (e) { error(e); } finally { node.disabled = false; } });
  $('sms-account-close').addEventListener('click', () => $('sms-account-dialog').close()); $('sms-account-cancel').addEventListener('click', () => $('sms-account-dialog').close());
  $('sms-account-dialog').addEventListener('close', () => { $('sms-account-fields').replaceChildren(); save = null; });
  $('sms-account-create').addEventListener('click', () => open('create')); $('sms-account-search-form').addEventListener('submit', e => { e.preventDefault(); page = 1; load().catch(error); });
  $('sms-account-enabled').addEventListener('change', () => { page = 1; load().catch(error); }); $('sms-account-prev').addEventListener('click', () => { page--; load().catch(error); }); $('sms-account-next').addEventListener('click', () => { page++; load().catch(error); });
  app.addEventListener('sms:ready', e => { me = e.detail;$('sms-account-create').hidden=!me.capabilities['accounts.create'];$('sms-account-bulk-password').hidden=!me.capabilities['accounts.password']; });
  app.addEventListener('sms:tab', e => { me = e.detail.me; if (e.detail.tab === 'accounts') { if (!me?.admin) { error(new Error('需要插件管理员授权')); return; } load().catch(error); } });
})();

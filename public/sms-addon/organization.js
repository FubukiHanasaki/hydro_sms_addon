/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
  const app = document.getElementById('sms-app'); if (!app) return;
  const $ = id => document.getElementById(id);
  let me; let page = 1; let request = 0; let dialogSerial = 0; let save;
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); return node; };
  const button = (label, work, cls = 'rounded button') => {
    const node = el('button', cls, label); node.type = 'button';
    node.addEventListener('click', async () => { if (node.disabled) return; node.disabled = true; try { await work(); } catch (e) { error(e); } finally { node.disabled = false; } }); return node;
  };
  function error(e) { const node = $('sms-org-dialog').open ? $('sms-org-error') : $('sms-notice'); node.textContent = e.message; node.hidden = false; }
  async function api(url, body) {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-SMS-Request': '1', Accept: 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let result; try { result = await response.json(); } catch { throw new Error('服务响应异常，请刷新后重试'); }
    if (!response.ok || !Object.hasOwn(result, 'data')) throw new Error(result.message || '操作未完成，请刷新后确认'); return result.data;
  }
  function options(select, entries, current) { for (const [value, label] of entries) { const option = el('option', '', label); option.value = value; select.append(option); } select.value = current; }
  async function loadClasses() {
    const serial = ++request; const url = new URL(app.dataset.classes, location.origin);
    url.search = new URLSearchParams({ q: $('sms-class-query').value, status: $('sms-class-status').value, page });
    const result = await api(url); if (serial !== request) return;
    const rows = $('sms-class-rows'); rows.replaceChildren();
    for (const c of result.classes) {
      const row = el('tr'); const name = el('td'); name.append(el('div', 'sms-student-name', c.name), el('div', 'sms-secondary', c.domainId)); row.append(name);
      for (const text of [[c.type, c.academicYear].filter(Boolean).join(' / ') || '—', c.memberCount ?? '—', c.status === 'active' ? '开班中' : '已归档']) row.append(el('td', '', text));
      const actions = el('td'); const group = el('div', 'sms-org-actions'); group.append(button(me.admin ? '编辑资料' : '查看资料', () => openClass(c._id), 'link sms-link'), button('成员', () => members(c._id), 'link sms-link'));
      const link = el('a', 'link sms-link', '进入子域 ↗'); link.href = `/d/${encodeURIComponent(c.domainId)}/`; group.append(link); actions.append(group); row.append(actions); rows.append(row);
    }
    if (!result.total) { const row = el('tr'); const cell = el('td', 'help-text', '暂无符合条件的班级与子域'); cell.colSpan = 5; row.append(cell); rows.append(row); }
    $('sms-class-summary').textContent = `共 ${result.total} 个班级与子域 · 名称、说明和成员统一管理`;
    $('sms-class-page').textContent = `第 ${page} / ${Math.max(1, Math.ceil(result.total / 20))} 页`;
    $('sms-class-prev').disabled = page <= 1; $('sms-class-next').disabled = page * 20 >= result.total;
  }
  function dialog(title, editable = true) {
    dialogSerial++; $('sms-org-title').textContent = title; $('sms-org-fields').replaceChildren(); $('sms-org-error').textContent = ''; $('sms-org-save').hidden = !editable;
    $('sms-org-pagination').replaceChildren(); $('sms-org-pagination').hidden = true; $('sms-org-dialog').classList.remove('sms-members-dialog'); save = null;
    if (!$('sms-org-dialog').open) $('sms-org-dialog').showModal(); $('sms-org-fields').closest('.sms-dialog-body').scrollTop = 0; return $('sms-org-fields');
  }
  function field(root, name, label, value = '', entries, required = false) {
    const wrap = el('label', 'sms-field', label); const input = el(entries ? 'select' : 'input', entries ? 'select' : 'textbox'); input.id = `sms-org-${name}`;
    if (entries) options(input, entries, String(value)); else { input.value = value; input.maxLength = 200; }
    input.required = required; wrap.append(input); root.append(wrap); return input;
  }
  async function openClass(id) {
    const c = id ? await api(`${app.dataset.classes}/${encodeURIComponent(id)}`) : null;
    const root = dialog(c ? c.name : '新建班级与子域', me.admin);
    if (!me.admin) {
      for (const [label, value] of [['子域 ID', c.domainId], ['班型', c.type], ['学年', c.academicYear], ['上课安排', c.schedule], ['地点', c.location], ['说明', c.description], ['状态', c.status === 'active' ? '开班中' : '已归档'], ['任课教师', c.teachers.map(t => t.username).join('、')]]) root.append(el('p', 'sms-org-value', `${label}：${value || '未填写'}`)); return;
    }
    if (c?.syncState !== 'ready' && c) root.append(el('p', 'help-text', '上一次保存尚未完成，请核对当前资料后重新保存。'));
    const grid = el('div', 'sms-form-grid'); root.append(grid); const inputs = {};
    inputs.name = field(grid, 'class-name', '班级与子域名称 *', c?.name || '', null, true); inputs.name.maxLength = 100;
    inputs.domainId = field(grid, 'domain-id', '子域 ID *', c?.domainId || '', null, true); inputs.domainId.disabled = !!c; inputs.domainId.maxLength = 64;
    for (const [key, label] of [['type', '班型'], ['academicYear', '学年'], ['schedule', '上课安排（选填）'], ['location', '上课地点']]) inputs[key] = field(grid, key, label, c?.[key] || '');
    inputs.status = field(grid, 'class-lifecycle', '状态', c?.status || 'active', [['active', '开班中'], ['archived', '已归档']]);
    const label = el('label', 'sms-field', '说明 / 子域公告'); inputs.description = el('textarea', 'textbox'); inputs.description.id = 'sms-org-description'; inputs.description.value = c?.description || ''; inputs.description.maxLength = 5000; label.append(inputs.description); root.append(label);
    root.append(el('p', 'help-text', '名称和说明同步用于 Hydro 子域。保存后可在「成员」中添加账号、分配教师；学生账号绑定档案后自动显示为学生。'));
    save = async () => { const data = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])); data.version = c?.version ?? 0; data.createDomain = !c; await api(c ? `${app.dataset.classes}/${encodeURIComponent(c._id)}` : app.dataset.classes, data); $('sms-org-dialog').close(); await loadClasses(); };
  }
  async function members(id) {
    const c = await api(`${app.dataset.classes}/${encodeURIComponent(id)}`);
    const root = dialog(`成员 · ${c.name}`, false); const activeDialog = dialogSerial; $('sms-org-dialog').classList.add('sms-members-dialog');
    let memberPage = 1; let version = c.version; let serial = 0; let busy = false;
    const body = root.closest('.sms-dialog-body'); const toolbar = el('div', 'sms-member-toolbar'); root.append(toolbar);
    const query = field(toolbar, 'member-search', '查找成员'); query.type = 'search'; query.placeholder = '用户名、姓名或 UID';
    const refresh = button('刷新', () => load()); toolbar.append(refresh);
    const summary = el('p', 'help-text'); summary.id = 'sms-member-summary'; root.append(summary);
    const list = el('div', 'sms-member-list'); list.id = 'sms-member-list'; root.append(list);
    const pager = $('sms-org-pagination'); pager.hidden = false;
    if (me.admin) {
      const add = el('div', 'sms-member-add'); const addQuery = field(add, 'account-query', '添加已有 Hydro 账号'); addQuery.placeholder = '输入用户名或 UID'; addQuery.type = 'search';
      const kind = field(add, 'member-kind', '身份', 'member', [['member', '普通成员'], ['teacher', '任课教师'], ['student', '学生（需绑定档案）']]);
      const results = el('div', 'sms-account-results'); results.id = 'sms-member-account-results'; add.append(results); root.prepend(add);
      let timer; let accountRequest = 0;
      const search = async () => { const current = ++accountRequest; if (!addQuery.value.trim()) { results.replaceChildren(); return; } const url = new URL(app.dataset.users, location.origin); url.search = new URLSearchParams({ q: addQuery.value.trim() }); const users = await api(url); if (current !== accountRequest || activeDialog !== dialogSerial) return;
        results.replaceChildren(); for (const user of users) results.append(button(`${user.username} · UID ${user.uid}`, async () => { if (busy) return; busy = true; try { await api(`${app.dataset.domains}/${encodeURIComponent(id)}/members`, { uid: user.uid, joined: true, kind: kind.value, version }); addQuery.value = ''; results.replaceChildren(); await load(); await loadClasses(); } catch (e) { await load(); throw e; } finally { busy = false; } })); if (!users.length) results.append(el('p', 'help-text', '没有匹配的账号'));
      };
      addQuery.addEventListener('input', () => { clearTimeout(timer); accountRequest++; timer = setTimeout(() => search().catch(error), 250); }); addQuery.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search().catch(error); } });
    }
    async function load() {
      const current = ++serial; refresh.disabled = true;
      try {
        const url = new URL(`${app.dataset.domains}/${encodeURIComponent(id)}/members`, location.origin); url.search = new URLSearchParams({ q: query.value, page: memberPage });
        const data = await api(url); if (current !== serial || activeDialog !== dialogSerial) return;
        if (memberPage > 1 && !data.members.length) { memberPage = Math.max(1, Math.ceil(data.total / 20)); return load(); }
        version = data.version; summary.textContent = `共 ${data.total} 名成员${me.admin ? ' · 班级与子域共用此名册' : ''}`; list.replaceChildren();
        for (const m of data.members) {
          const row = el('div', 'sms-member-row'); const person = el('div', 'sms-member-person'); person.append(el('div', 'sms-student-name', m.studentName || m.username), el('div', 'sms-secondary', `${m.studentName ? `${m.username} · ` : ''}UID ${m.uid}`));
          row.append(person, el('span', 'sms-member-kind', ({ teacher: '任课教师', student: '学生', member: '普通成员' })[m.kind]));
          const actions = el('div', 'sms-member-actions');
          if (m.canRemove) actions.append(button('移除', async () => { if (busy) return; busy = true; try { await api(url.pathname, { uid: m.uid, joined: false, version }); await load(); await loadClasses(); } catch (e) { await load(); throw e; } finally { busy = false; } }));
          else if (m.uid === c.owner) actions.append(el('span', 'help-text', '所有者'));
          row.append(actions); list.append(row);
        }
        if (!data.members.length) list.append(el('p', 'sms-empty', '没有符合条件的成员'));
        const prev = button('上一页', () => { memberPage--; body.scrollTop = 0; return load(); }); prev.disabled = memberPage <= 1;
        const next = button('下一页', () => { memberPage++; body.scrollTop = 0; return load(); }); next.disabled = memberPage * 20 >= data.total;
        const pages = el('span', 'help-text', `${memberPage} / ${Math.max(1, Math.ceil(data.total / 20))} 页`); pages.setAttribute('aria-live', 'polite'); pager.replaceChildren(prev, pages, next);
      } finally { if (current === serial) refresh.disabled = false; }
    }
    let timer; query.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { memberPage = 1; load().catch(error); }, 250); }); query.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); memberPage = 1; load().catch(error); } });
    body.scrollTop = 0; await load();
  }
  $('sms-org-close').addEventListener('click', () => $('sms-org-dialog').close()); $('sms-org-cancel').addEventListener('click', () => $('sms-org-dialog').close());
  $('sms-org-dialog').addEventListener('close', () => { dialogSerial++; });
  $('sms-org-form').addEventListener('submit', async e => { e.preventDefault(); if (!save) return; const node = $('sms-org-save'); node.disabled = true; try { await save(); } catch (e) { error(e); } finally { node.disabled = false; } });
  $('sms-create-class').addEventListener('click', () => openClass().catch(error));
  $('sms-class-search-form').addEventListener('submit', e => { e.preventDefault(); page = 1; loadClasses().catch(error); });
  $('sms-class-status').addEventListener('change', () => { page = 1; loadClasses().catch(error); });
  $('sms-class-prev').addEventListener('click', () => { page--; loadClasses().catch(error); }); $('sms-class-next').addEventListener('click', () => { page++; loadClasses().catch(error); });
  app.addEventListener('sms:ready', e => { me = e.detail; $('sms-create-class').hidden = !me.admin; });
  app.addEventListener('sms:tab', async e => { me = e.detail.me; if (!me || e.detail.tab !== 'organization') return; try { await loadClasses(); } catch (e) { error(e); } });
})();

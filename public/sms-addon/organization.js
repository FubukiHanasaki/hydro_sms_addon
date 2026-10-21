/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
  const app = document.getElementById('sms-app'); if (!app) return;
  const $ = id => document.getElementById(id);
  let me; let domains = []; let page = 1; let request = 0; let dialogSerial = 0; let save;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = String(text); return e; };
  const button = (label, fn, cls = 'rounded button') => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', () => Promise.resolve().then(fn).catch(error)); return b; };
  function error(e) { const node = $('sms-org-dialog').open ? $('sms-org-error') : $('sms-notice'); node.textContent = e.message; node.hidden = false; }
  async function api(url, body) {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-SMS-Request': '1', Accept: 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); if (!response.ok || !Object.hasOwn(result, 'data')) throw new Error(result.message || '操作失败，请刷新后重试'); return result.data;
  }
  function options(select, entries, current = '', placeholder) {
    select.replaceChildren(); if (placeholder !== undefined) entries = [['', placeholder], ...entries];
    for (const [value, label] of entries) { const option = el('option', '', label); option.value = value; select.append(option); } select.value = current;
  }
  async function loadDomains() {
    domains = await api(app.dataset.domains);
    options($('sms-class-domain'), domains.map(d => [d._id, d.name || d._id]), $('sms-class-domain').value, '全部子域');
    const list = $('sms-domain-list'); list.replaceChildren();
    for (const d of domains) {
      const card = el('div', 'sms-org-card'); const link = el('a', 'link', `${d.name || d._id}（${d._id}）`); link.href = `/d/${encodeURIComponent(d._id)}/`; card.append(link);
      if (me.admin) { const actions = el('div', 'sms-org-actions'); actions.append(button('编辑子域', () => editDomain(d)), button('管理成员', () => members(d))); card.append(actions); }
      list.append(card);
    }
    if (!domains.length) list.append(el('p', 'help-text', '暂无可访问的子域。'));
  }
  async function loadClasses() {
    const serial = ++request; const url = new URL(app.dataset.classes, location.origin);
    url.search = new URLSearchParams({ q: $('sms-class-query').value, domainId: $('sms-class-domain').value, status: $('sms-class-status').value, page });
    const result = await api(url); if (serial !== request) return;
    const rows = $('sms-class-rows'); rows.replaceChildren();
    for (const c of result.classes) {
      const row = el('tr'); for (const text of [c.name, domains.find(d => d._id === c.domainId)?.name || c.domainId, [c.type, c.academicYear].filter(Boolean).join(' / ') || '—', c.studentCount ?? '—', c.status === 'active' ? '开班中' : '已归档']) row.append(el('td', '', text));
      const actions = el('td'); actions.append(button(me.admin ? '查看 / 管理' : '查看班级', () => openClass(c._id), 'link sms-link')); row.append(actions); rows.append(row);
    }
    if (!result.total) { const row = el('tr'); const cell = el('td', 'help-text', '暂无符合条件的可访问班级'); cell.colSpan = 6; row.append(cell); rows.append(row); }
    $('sms-class-summary').textContent = `共 ${result.total} 个可访问班级`;
    $('sms-class-page').textContent = `第 ${page} / ${Math.max(1, Math.ceil(result.total / 20))} 页`;
    $('sms-class-prev').disabled = page <= 1; $('sms-class-next').disabled = page * 20 >= result.total;
  }
  function dialog(title, editable = true) {
    dialogSerial++; $('sms-org-title').textContent = title; $('sms-org-fields').replaceChildren(); $('sms-org-error').textContent = ''; $('sms-org-save').hidden = !editable; save = null;
    if (!$('sms-org-dialog').open) $('sms-org-dialog').showModal(); return $('sms-org-fields');
  }
  function field(root, name, label, value = '', entries, required = false) {
    const wrap = el('label', 'sms-field', label); const input = el(entries ? 'select' : 'input', entries ? 'select' : 'textbox'); input.id = `sms-org-${name}`; input.name = name;
    if (entries) options(input, entries, String(value)); else { input.value = value; input.maxLength = 200; }
    input.required = required; wrap.append(input); root.append(wrap); return input;
  }
  function editDomain(d) {
    const root = dialog(d ? '编辑子域' : '新建子域');
    const id = field(root, 'domain-id', '子域 ID', d?._id || '', null, true); id.disabled = !!d; id.maxLength = 64;
    const name = field(root, 'domain-name', '子域名称', d?.name || '', null, true); name.maxLength = 100;
    const bulletin = field(root, 'bulletin', '子域公告', d?.bulletin || ''); bulletin.maxLength = 5000;
    root.append(el('p', 'help-text', '新建子域的所有者为当前账号。原版子域管理已停用，成员加入或移除统一在本插件中管理。'));
    save = async () => { await api(app.dataset.domains, { action: d ? 'update' : 'create', id: id.value, name: name.value, bulletin: bulletin.value }); $('sms-org-dialog').close(); await loadDomains(); };
  }
  function accountPicker(root, label, chosen, onChange) {
    const query = field(root, `account-${Math.random().toString(36).slice(2)}`, label); query.placeholder = '输入用户名或 UID';
    const results = el('div', 'sms-org-results'); const chips = el('div', 'sms-chips'); root.append(chips, results); let serial = 0; let timer;
    const render = () => { chips.replaceChildren(); for (const [uid, name] of chosen) chips.append(button(`${name} · UID ${uid} ×`, () => { chosen.delete(uid); render(); onChange?.(); })); };
    const search = async () => { const current = ++serial; const activeDialog = dialogSerial; if (!query.value.trim()) { results.replaceChildren(); return; } const url = new URL(app.dataset.users, location.origin); url.search = new URLSearchParams({ q: query.value }); const users = await api(url); if (current !== serial || activeDialog !== dialogSerial) return; results.replaceChildren(); for (const user of users) results.append(button(`${user.username} · UID ${user.uid}`, async () => { chosen.set(user.uid, user.username); render(); results.replaceChildren(); query.value = ''; await onChange?.(user.uid); render(); })); if (!users.length) results.append(el('p', 'help-text', '没有匹配的账号')); };
    query.addEventListener('input', () => { clearTimeout(timer); serial++; timer = setTimeout(() => search().catch(error), 250); }); query.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search().catch(error); } }); render();
  }
  async function members(d) {
    const root = dialog(`子域成员 · ${d.name || d._id}`, false); const activeDialog = dialogSerial; let memberPage = 1;
    const selected = new Map(); accountPicker(root, '加入已有 Hydro 账号', selected, async uid => { if (!uid) return; await api(`${app.dataset.domains}/${encodeURIComponent(d._id)}/members`, { uid, joined: true }); selected.clear(); await load(); });
    root.append(el('p', 'help-text', '加入或移除只改变子域成员关系，保留原域角色；不会改变班级分组。'));
    const query = field(root, 'member-search', '搜索成员'); const list = el('div'); const pagination = el('div', 'sms-org-actions'); root.append(list, pagination);
    let serial = 0; const load = async () => { const current = ++serial; const url = new URL(`${app.dataset.domains}/${encodeURIComponent(d._id)}/members`, location.origin); url.search = new URLSearchParams({ q: query.value, page: memberPage }); const data = await api(url); if (current !== serial || activeDialog !== dialogSerial) return;
      list.replaceChildren(el('p', 'help-text', `共 ${data.total} 名成员`)); for (const m of data.members) { const line = el('div', 'sms-org-card', `${m.username} · UID ${m.uid} · ${m.role || 'default'}`); if (m.uid !== d.owner) line.append(button('移出子域', async () => { await api(url.pathname, { uid: m.uid, joined: false }); await load(); })); list.append(line); }
      const prev = button('上一页', () => { memberPage--; return load(); }); prev.disabled = memberPage <= 1; const next = button('下一页', () => { memberPage++; return load(); }); next.disabled = memberPage * 20 >= data.total; pagination.replaceChildren(prev, el('span', 'help-text', `第 ${memberPage} 页`), next);
    };
    let timer; query.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { memberPage = 1; load().catch(error); }, 250); }); await load();
  }
  function studentPicker(root, chosen) {
    root.append(el('h2', 'section__title', '班级学生')); const chips = el('div', 'sms-chips'); const query = field(root, 'student-query', '搜索学生'); const results = el('div', 'sms-org-results'); const pagination = el('div', 'sms-org-actions'); root.append(chips, results, pagination); let studentPage = 1; let serial = 0; const activeDialog = dialogSerial;
    const render = () => { chips.replaceChildren(); for (const [id, name] of chosen) chips.append(button(`${name} ×`, () => { chosen.delete(id); render(); results.querySelectorAll('input').forEach(c => { if (c.value === id) c.checked = false; }); })); };
    const load = async () => { const current = ++serial; const url = new URL(app.dataset.api, location.origin); url.search = new URLSearchParams({ q: query.value, page: studentPage }); const data = await api(url); if (current !== serial || activeDialog !== dialogSerial) return; results.replaceChildren(); for (const s of data.students) { const label = el('label', 'checkbox'); const check = el('input', 'checkbox'); check.type = 'checkbox'; check.value = s.id; check.checked = chosen.has(s.id); check.addEventListener('change', () => { if (check.checked) chosen.set(s.id, s.name); else chosen.delete(s.id); render(); }); label.append(check, document.createTextNode(` ${s.name} · ${s.grade || '未填写年级'}`)); const container = el('div', 'checkbox-container'); container.append(label); results.append(container); }
      const prev = button('上一页', () => { studentPage--; return load(); }); prev.disabled = studentPage <= 1; const next = button('下一页', () => { studentPage++; return load(); }); next.disabled = studentPage * 20 >= data.total; pagination.replaceChildren(prev, el('span', 'help-text', `共 ${data.total} 人 · 第 ${studentPage} 页`), next);
    };
    let timer; query.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { studentPage = 1; load().catch(error); }, 250); }); query.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); load().catch(error); } }); render(); load().catch(error);
  }
  async function openClass(id) {
    const c = id ? await api(`${app.dataset.classes}/${encodeURIComponent(id)}`) : null;
    const root = dialog(c ? c.name : '新建班级', me.admin); const editable = me.admin;
    if (!editable) {
      for (const [label, value] of [['子域', c.domainId], ['班型', c.type], ['学年', c.academicYear], ['上课安排', c.schedule], ['地点', c.location], ['说明', c.description], ['状态', c.status === 'active' ? '开班中' : '已归档'], ['任课教师', c.teachers.map(t => `${t.username}（UID ${t.uid}）`).join('、')]]) root.append(el('p', 'sms-org-value', `${label}：${value || '未填写'}`));
      root.append(el('h2', 'section__title', '学生')); for (const s of c.students) root.append(el('p', 'sms-org-value', `${s.name} · ${s.grade || '未填写年级'} · ${s.school || '未填写学校'}`)); return;
    }
    const grid = el('div', 'sms-form-grid'); root.append(grid); const inputs = {};
    inputs.name = field(grid, 'class-name', '班级名称 *', c?.name || '', null, true); inputs.name.maxLength = 100;
    inputs.domainId = field(grid, 'class-domain', '所属子域 *', c?.domainId || domains[0]?._id || '', domains.map(d => [d._id, `${d.name || d._id}（${d._id}）`]), true);
    for (const [key, label] of [['type', '班型'], ['academicYear', '学年'], ['schedule', '上课安排（选填）'], ['location', '上课地点']]) inputs[key] = field(grid, key, label, c?.[key] || '');
    inputs.status = field(grid, 'class-lifecycle', '班级状态', c?.status || 'active', [['active', '开班中'], ['archived', '已归档']]);
    inputs.description = field(root, 'description', '班级说明', c?.description || ''); inputs.description.maxLength = 2000;
    root.append(el('p', 'help-text', '上课安排仅作说明；入班、退班立即生效，不校验在班日期或时段。分班不会自动加入或移出 Hydro 子域。'));
    const teachers = new Map((c?.teachers || []).map(t => [t.uid, t.username])); accountPicker(root, '分配任课教师（Hydro 账号）', teachers);
    const selected = new Map((c?.students || []).map(s => [s.id, s.name])); studentPicker(root, selected);
    save = async () => { const body = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value])); body.teacherUids = [...teachers.keys()]; body.studentIds = [...selected.keys()]; if (c) body.version = c.version; await api(c ? `${app.dataset.classes}/${encodeURIComponent(c._id)}` : app.dataset.classes, body); $('sms-org-dialog').close(); await loadClasses(); };
  }
  $('sms-org-close').addEventListener('click', () => $('sms-org-dialog').close()); $('sms-org-cancel').addEventListener('click', () => $('sms-org-dialog').close());
  $('sms-org-dialog').addEventListener('close', () => { dialogSerial++; });
  $('sms-org-form').addEventListener('submit', async event => { event.preventDefault(); if (!save) return; const b = $('sms-org-save'); b.disabled = true; try { await save(); } catch (e) { error(e); } finally { b.disabled = false; } });
  $('sms-create-domain').addEventListener('click', () => editDomain()); $('sms-create-class').addEventListener('click', () => openClass().catch(error));
  $('sms-class-search-form').addEventListener('submit', event => { event.preventDefault(); page = 1; loadClasses().catch(error); });
  for (const id of ['sms-class-domain', 'sms-class-status']) $(id).addEventListener('change', () => { page = 1; loadClasses().catch(error); });
  $('sms-class-prev').addEventListener('click', () => { page--; loadClasses().catch(error); }); $('sms-class-next').addEventListener('click', () => { page++; loadClasses().catch(error); });
  app.addEventListener('sms:ready', e => { me = e.detail; $('sms-create-domain').hidden = $('sms-create-class').hidden = !me.admin; });
  app.addEventListener('sms:tab', async e => { me = e.detail.me; if (!me) return; try { await loadDomains(); if (e.detail.tab === 'classes') await loadClasses(); } catch (e) { error(e); } });
})();

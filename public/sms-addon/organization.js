/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
  const app = document.getElementById('sms-app'); if (!app) return;
  const $ = id => document.getElementById(id);
  let me; let page = 1; let request = 0; let dialogSerial = 0; let save;
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); return node; };
  const button = (label, work, cls = 'rounded button') => {
    const node = el('button', cls, label); node.type = 'button';
    node.addEventListener('click', async () => { if (node.disabled) return; node.disabled = true; try { await work(); } catch (e) { error(e); } finally { node.disabled = node.hasAttribute('data-disabled'); } }); return node;
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
    app.dataset.exportClasses = JSON.stringify(Object.fromEntries(url.searchParams));
    const rows = $('sms-class-rows'); rows.replaceChildren();
    for (const c of result.classes) {
      const row = el('tr'); const name = el('td'); name.append(el('div', 'sms-student-name', c.name), el('div', 'sms-secondary', c.domainId)); row.append(name);
      for (const text of [[c.type, c.academicYear].filter(Boolean).join(' / ') || '—', c.memberCount ?? '—', c.status === 'active' ? '开班中' : '已归档']) row.append(el('td', '', text));
      const actions = el('td'); const group = el('div', 'sms-org-actions'); group.append(button('详情', () => app.dispatchEvent(new CustomEvent('sms:class-detail', { detail: { id: c._id } })), 'link sms-link'), button(c.canEdit ? '编辑资料' : '查看资料', () => openClass(c._id), 'link sms-link'), button('成员', () => members(c._id), 'link sms-link'));
      const link = el('a', 'link sms-link', '进入子域 ↗'); link.href = `/d/${encodeURIComponent(c.domainId)}/`; group.append(link); actions.append(group); row.append(actions); rows.append(row);
    }
    if (!result.total) { const row = el('tr'); const cell = el('td', 'help-text', '暂无符合条件的班级与子域'); cell.colSpan = 5; row.append(cell); rows.append(row); }
    $('sms-class-summary').textContent = `共 ${result.total} 个班级与子域`;
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
    const editable=c?c.canEdit:me.capabilities['classes.create'];const root = dialog(c ? c.name : '新建班级与子域', editable);
    if (!editable) {
      for (const [label, value] of [['子域 ID', c.domainId], ['班型', c.type], ['学年', c.academicYear], ['上课安排', c.schedule], ['地点', c.location], ['说明', c.description], ['状态', c.status === 'active' ? '开班中' : '已归档'], ['任课教师', c.teachers.map(t => t.username).join('、')]]) root.append(el('p', 'sms-org-value', `${label}：${value || '未填写'}`)); return;
    }
    if (c?.syncState !== 'ready' && c) root.append(el('p', 'help-text', '上次保存未完成，请核对后重试。'));
    const grid = el('div', 'sms-form-grid'); root.append(grid); const inputs = {};
    inputs.name = field(grid, 'class-name', '班级与子域名称 *', c?.name || '', null, true); inputs.name.maxLength = 100;
    inputs.domainId = field(grid, 'domain-id', '子域 ID *', c?.domainId || '', null, true); inputs.domainId.disabled = !!c; inputs.domainId.maxLength = 64;
    for (const [key, label] of [['type', '班型'], ['academicYear', '学年'], ['schedule', '上课安排（选填）'], ['location', '上课地点']]) inputs[key] = field(grid, key, label, c?.[key] || '');
    inputs.status = field(grid, 'class-lifecycle', '状态', c?.status || 'active', [['active', '开班中'], ['archived', '已归档']]);
    if(c&&me.scopes['classes.archive']!==null&&!me.scopes['classes.archive'].includes(c.domainId))inputs.status.disabled=true;
    const label = el('label', 'sms-field', '说明 / 子域公告'); inputs.description = el('textarea', 'textbox'); inputs.description.id = 'sms-org-description'; inputs.description.value = c?.description || ''; inputs.description.maxLength = 5000; label.append(inputs.description); root.append(label);
    save = async () => { const data = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])); data.version = c?.version ?? 0; data.createDomain = !c; await api(c ? `${app.dataset.classes}/${encodeURIComponent(c._id)}` : app.dataset.classes, data); $('sms-org-dialog').close(); await loadClasses(); };
  }
  async function members(id) {
    const c = await api(`${app.dataset.classes}/${encodeURIComponent(id)}`);
    const editable=me.scopes['classes.members']===null||me.scopes['classes.members'].includes(c.domainId);const root = dialog(`成员 · ${c.name}`, false); const activeDialog = dialogSerial; $('sms-org-dialog').classList.add('sms-members-dialog');
    let memberPage = 1; let version = c.version; let serial = 0; let busy = false;
    const body = root.closest('.sms-dialog-body'); const toolbar = el('div', 'sms-member-toolbar'); root.append(toolbar);
    const query = field(toolbar, 'member-search', '查找成员'); query.type = 'search'; query.placeholder = '用户名、姓名或 UID';
    let exportQuery='';const refresh = button('刷新', () => load()); const actions=el('div','sms-member-toolbar-actions');actions.append(refresh,globalThis.SmsExport.control('导出成员','members',()=>({classId:id,q:exportQuery})));toolbar.append(actions);
    const summary = el('p', 'help-text'); summary.id = 'sms-member-summary'; root.append(summary);
    const list = el('div', 'sms-member-list'); list.id = 'sms-member-list'; root.append(list);
    const pager = $('sms-org-pagination'); pager.hidden = false;
    if (editable) {
      const add = el('div', 'sms-member-add'); const addQuery = field(add, 'account-query', '添加已有 Hydro 账号'); addQuery.placeholder = '输入用户名或 UID'; addQuery.type = 'search';
      const kind = field(add, 'member-kind', '身份', 'member', [['member','普通成员'],...(me.scopes['classes.teachers']===null||me.scopes['classes.teachers'].includes(c.domainId)?[['teacher','任课教师']]:[]),['student',id==='system'?'学生':'学生（需档案）']]);
      const results = el('div', 'sms-account-results'); results.id = 'sms-member-account-results';
      const selected = el('p', 'help-text'); selected.id = 'sms-member-selected'; let selectedUser = null;
      const confirm = button('确认添加', async () => {
        if (busy || !selectedUser) return; busy = true;
        try { await api(`${app.dataset.domains}/${encodeURIComponent(id)}/members`, { uid: selectedUser.uid, joined: true, kind: kind.value, version }); addQuery.value = ''; selectedUser = null; selected.textContent = ''; results.replaceChildren(); await loadClasses(); await load(); }
        catch (e) { await load(); throw e; } finally { busy = false; confirm.toggleAttribute('data-disabled', !selectedUser); confirm.disabled = !selectedUser; }
      }, 'primary rounded button'); confirm.id = 'sms-member-confirm-add'; confirm.disabled = true; confirm.setAttribute('data-disabled', '');
      const controls = el('div', 'sms-member-add-actions'); const addActions = el('div', 'sms-org-actions');
      const file = el('input'); file.type = 'file'; file.accept = '.xlsx,.csv'; file.hidden = true; file.setAttribute('aria-label', '导入成员文件');
      const preview = el('section', 'sms-member-import'); preview.hidden = true; preview.setAttribute('aria-label', '成员导入预览');
      const importBase = `${app.dataset.domains}/${encodeURIComponent(id)}/member-import`; let batchId = ''; let uploading = false;
      const cancelPreview = async () => { if (batchId) await api(`${importBase}/${encodeURIComponent(batchId)}/cancel`, {}); batchId = ''; preview.hidden = true; preview.replaceChildren(); };
      const importButton = button('批量导入', () => { if (!busy && !uploading) file.click(); }); importButton.id = 'sms-member-import-open';
      file.addEventListener('change', async () => {
        const selectedFile = file.files[0]; file.value = ''; if (!selectedFile || uploading || busy) return;
        uploading = true; importButton.disabled = true; $('sms-org-error').textContent = ''; $('sms-org-error').hidden = true;
        try {
          if (!/\.(xlsx|csv)$/i.test(selectedFile.name) || selectedFile.size > 2 * 1024 * 1024) throw new Error('请选择不超过 2 MB 的 XLSX 或 CSV 文件');
          await cancelPreview();
          const content = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('读取文件失败')); reader.readAsDataURL(selectedFile); });
          const data = await api(importBase, { filename: selectedFile.name, content });
          if (activeDialog !== dialogSerial) { await api(`${importBase}/${encodeURIComponent(data._id)}/cancel`, {}); return; }
          batchId = data._id; preview.replaceChildren(); preview.hidden = false;
          const counts = { add: 0, existing: 0, invalid: 0 }; for (const row of data.rows) counts[row.status]++;
          const header = el('div', 'sms-member-import-heading'); header.append(el('strong', '', '导入预览'), el('span', 'help-text', `新增 ${counts.add} · 已有 ${counts.existing} · 无效 ${counts.invalid}`)); preview.append(header);
          const scroll = el('div', 'sms-member-import-table'); const table = el('table', 'sms-bulk-table'); const head = el('thead'); const heading = el('tr');
          for (const label of ['行', 'UID', '账号 / 姓名', '导入身份', '结果']) heading.append(el('th', '', label)); head.append(heading); table.append(head); const rows = el('tbody');
          for (const item of data.rows) { const tr = el('tr'); for (const value of [item.row, item.uid ?? '—', [item.username, item.name].filter(Boolean).join(' / ') || '—', item.status === 'existing' ? '保留原身份' : item.kind === 'student' ? '学生' : '普通成员', item.errors.join('；') || (item.status === 'existing' ? '跳过已有成员' : '待添加')]) tr.append(el('td', '', value)); rows.append(tr); }
          table.append(rows); scroll.append(table); preview.append(scroll);
          const actions = el('div', 'sms-org-actions');
          const apply = button('确认导入', async () => {
            if (busy || !batchId) return; busy = true;
            try { const result = await api(`${importBase}/${encodeURIComponent(batchId)}/confirm`, {}); batchId = ''; preview.replaceChildren(el('p', 'help-text', `已添加 ${result.added} 名成员，跳过 ${result.skipped} 名已有成员`)); await loadClasses(); await load(); }
            catch (e) { await load(); throw e; } finally { busy = false; }
          }, 'primary rounded button'); apply.id = 'sms-member-import-confirm'; apply.disabled = !!counts.invalid || !counts.add; apply.toggleAttribute('data-disabled', apply.disabled);
          actions.append(button('取消', cancelPreview), apply); preview.append(actions);
        } catch (e) { error(e); } finally { uploading = false; importButton.disabled = false; }
      });
      importButton.title = '第一行表头为 UID，支持 XLSX / CSV，每次最多 200 人';
      $('sms-org-dialog').addEventListener('close', () => { cancelPreview().catch(() => {}); }, { once: true });
      addActions.append(importButton, confirm); controls.append(selected, addActions); add.append(results, controls, file); root.prepend(add); add.after(preview);

      let timer; let accountRequest = 0;
      const search = async () => { const current = ++accountRequest; if (!addQuery.value.trim()) { results.replaceChildren(); return; } const url = new URL(app.dataset.users, location.origin); url.search = new URLSearchParams({ q: addQuery.value.trim(), classId:id }); const users = await api(url); if (current !== accountRequest || activeDialog !== dialogSerial) return;
        results.replaceChildren(); for (const user of users) results.append(button(`${user.username} · UID ${user.uid}`, () => { selectedUser = user; selected.textContent = `已选择 ${user.username}（UID ${user.uid}）`; confirm.disabled = false; confirm.removeAttribute('data-disabled'); results.replaceChildren(); })); if (!users.length) results.append(el('p', 'help-text', '没有匹配的账号'));
      };
      addQuery.addEventListener('input', () => { clearTimeout(timer); accountRequest++; selectedUser = null; selected.textContent = ''; confirm.disabled = true; confirm.setAttribute('data-disabled', ''); timer = setTimeout(() => search().catch(error), 250); }); addQuery.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search().catch(error); } });
    }
    async function load() {
      const current = ++serial; refresh.disabled = true;
      try {
        const url = new URL(`${app.dataset.domains}/${encodeURIComponent(id)}/members`, location.origin); url.search = new URLSearchParams({ q: query.value, page: memberPage });
        const data = await api(url); if (current !== serial || activeDialog !== dialogSerial) return;
        if (memberPage > 1 && !data.members.length) { memberPage = Math.max(1, Math.ceil(data.total / 20)); return load(); }
        exportQuery=query.value;version = data.version; summary.textContent = `共 ${data.total} 名成员`; list.replaceChildren();
        for (const m of data.members) {
          const row = el('div', 'sms-member-row'); const person = el('div', 'sms-member-person'); person.append(el('div', 'sms-student-name', m.studentName || m.username), el('div', 'sms-secondary', `${m.studentName ? `${m.username} · ` : ''}UID ${m.uid}`));
          row.append(person); const actions = el('div', 'sms-member-actions');
          if (data.canManage && (m.kind!=='teacher'||data.canTeachers)) {
            row.classList.add('sms-member-editable'); const identity = el('select', 'select sms-member-role-select'); identity.setAttribute('aria-label', `修改 ${m.username} 的身份`);
            options(identity, [['member','普通成员'],...(data.canTeachers?[['teacher','任课教师']]:[]),['student',id==='system'?'学生':'学生（需档案）']],m.kind); row.append(identity);
            const apply = button('保存身份', async () => { if (busy) return; busy = true; identity.disabled = true; try { await api(url.pathname, { uid: m.uid, joined: true, roleOnly: true, kind: identity.value, version }); await loadClasses(); await load(); } catch (e) { await load(); throw e; } finally { busy = false; } });
            apply.disabled = true; apply.setAttribute('aria-label', `保存 ${m.username} 的身份`); identity.addEventListener('change', () => { apply.disabled = identity.value === m.kind; }); actions.append(apply);
          } else row.append(el('span', 'sms-member-kind', ({ teacher: '任课教师', student: '学生', member: '普通成员' })[m.kind]));
          if (m.canRemove && (m.kind!=='teacher'||data.canTeachers)) actions.append(button('移除', async () => { if (busy) return; busy = true; try { await api(url.pathname, { uid: m.uid, joined: false, version }); await loadClasses(); await load(); } catch (e) { await load(); throw e; } finally { busy = false; } }));
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
  app.addEventListener('sms:ready', e => { me = e.detail; $('sms-create-class').hidden = !me.capabilities['classes.create']; });
  app.addEventListener('sms:tab', async e => { me = e.detail.me; if (!me || e.detail.tab !== 'organization') return; try { await loadClasses(); } catch (e) { error(e); } });
})();

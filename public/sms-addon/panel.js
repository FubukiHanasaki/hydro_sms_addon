/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
  const app = document.getElementById('sms-app');
  if (!app || app.dataset.initialized) return;
  app.dataset.initialized = 'true';
  const $ = (id) => document.getElementById(id);
  // Hydro's document-level submit-click guard shares a five-second lock across
  // different buttons. These AJAX forms manage their own pending state instead.
  app.addEventListener('click', (event) => {
    if (event.target.closest('button[type="submit"]')) event.stopPropagation();
  });
  const state = { me: null, page: 1, total: 0, students: [], current: null, policy: null, selected: new Map(), tab: 'students', request: 0 };
  const basicFields = [
    ['name', '姓名', 'text', true], ['studentNo', '学号'], ['gender', '性别', ['未填写', '男', '女']],
    ['grade', '年级'], ['school', '学校'], ['status', '学生状态', ['在校', '休学', '离校']],
    ['campus', '校区'], ['enrollmentDate', '入学日期', 'date'], ['competitionLevel', '竞赛等级'], ['currentStage', '学习阶段'], ['targetLevel', '目标阶段'],
  ];
  const sensitiveFields = [['birthday', '生日', 'date'], ['phone', '联系电话', 'tel'], ['parentName', '家长姓名'], ['parentPhone', '家长电话', 'tel'], ['wechat', '微信'], ['address', '家庭地址']];
  const permissionLabels = { 'students.read': '查看资料', 'students.sensitive': '敏感资料', 'students.write': '编辑资料', 'students.bind': '账号绑定' };
  const actionLabels = { 'students.create': '新建学生', 'students.update': '修改资料', 'students.sensitive.read': '查看敏感资料', 'students.sensitive.profile': '资料页查看敏感资料', 'permissions.save': '保存授权', 'permissions.revoke': '撤销授权', 'admin.grant': '设置插件管理员', 'admin.revoke': '移除插件管理员' };
  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = String(content);
    return node;
  }
  function notice(message, error = false) {
    $('sms-notice').hidden = !message;
    $('sms-notice').className = `sms-notice${error ? ' error' : ''}`;
    $('sms-notice').textContent = message;
  }
  async function api(url, body) {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-SMS-Request': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('服务响应异常，请刷新页面后重试'); }
    if (!response.ok) throw new Error(result.message || (response.status === 403 ? '登录已失效或没有访问权限，请重新登录后重试' : '操作未完成，请稍后重试'));
    if (!Object.hasOwn(result, 'data')) throw new Error('服务响应格式异常');
    return result.data;
  }
  function dateTime(value) {
    return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  }
  async function loadStudents() {
    const request = ++state.request;
    $('sms-prev').disabled = $('sms-next').disabled = true;
    $('sms-summary').textContent = '正在加载…';
    const url = new URL(app.dataset.api, location.origin);
    url.search = new URLSearchParams({ q: $('sms-search').value.trim(), status: $('sms-status').value, page: state.page });
    try {
      const result = await api(url);
      if (request !== state.request) return;
      state.students = result.students; state.total = result.total;
      renderStudents();
    } catch (error) {
      if (request !== state.request) return;
      $('sms-student-rows').replaceChildren();
      $('sms-summary').textContent = '暂时无法加载学生档案';
      $('sms-page-label').textContent = '';
      notice(error.message, true);
    }
  }
  function renderStudents() {
    const rows = $('sms-student-rows'); rows.replaceChildren();
    for (const student of state.students) {
      const row = element('tr'); const nameCell = element('td');
      const person = element('div', 'sms-student-cell');
      person.append(element('span', 'sms-avatar', student.name.slice(0, 1)));
      const identity = element('div'); identity.append(element('div', 'sms-student-name', student.name), element('div', 'sms-secondary', student.studentNo || '未填写学号'));
      person.append(identity); nameCell.append(person); row.append(nameCell);
      const school = element('td'); school.append(element('div', '', student.grade || '未填写年级'), element('div', 'sms-secondary', student.school || '未填写学校')); row.append(school);
      row.append(element('td', '', student.currentStage || '—'));
      const status = element('td'); status.append(element('span', `sms-tag${student.status === '休学' ? ' pause' : student.status === '离校' ? ' left' : ''}`, student.status)); row.append(status);
      const account = element('td');
      if (student.hydroUid) { const link = element('a', 'sms-link', `UID ${student.hydroUid}`); link.href = `/user/${student.hydroUid}`; account.append(link); }
      else account.append(element('span', 'sms-secondary', '未绑定'));
      row.append(account);
      const actions = element('td'); const view = element('button', 'sms-link', '查看资料 →'); view.type = 'button'; view.addEventListener('click', () => openStudent(student.id)); actions.append(view); row.append(actions); rows.append(row);
    }
    $('sms-empty').hidden = state.students.length !== 0;
    $('sms-summary').textContent = `共 ${state.total} 名可访问学生 · 资料按最近更新时间排列`;
    $('sms-page-label').textContent = `第 ${state.page} / ${Math.max(1, Math.ceil(state.total / 20))} 页 · 每页 20 条`;
    $('sms-prev').disabled = state.page <= 1;
    $('sms-next').disabled = state.page * 20 >= state.total;
  }
  function fieldGroup(title, fields, values, editable, prefix) {
    const fragment = document.createDocumentFragment(); fragment.append(element('h3', '', title));
    const grid = element('div', 'sms-form-grid');
    for (const [key, label, type = 'text', required = false] of fields) {
      const wrapper = element('label', '', label + (required && editable ? ' *' : ''));
      if (editable) {
        let input;
        if (Array.isArray(type)) {
          input = element('select');
          for (const option of type) { const node = element('option', '', option); node.value = option; input.append(node); }
        } else { input = element('input'); input.type = type; input.maxLength = key === 'name' ? 80 : key === 'address' ? 500 : 160; }
        input.name = `${prefix}.${key}`; input.value = values[key] || (key === 'status' ? '在校' : key === 'gender' ? '未填写' : ''); input.required = !!required; wrapper.append(input);
      } else wrapper.append(element('div', 'sms-read-value', values[key] || '未填写'));
      grid.append(wrapper);
    }
    fragment.append(grid); return fragment;
  }
  async function openStudent(id) {
    notice('');
    try {
      const student = id ? await api(`${app.dataset.api}/${encodeURIComponent(id)}`) : null;
      state.current = student;
      const caps = student?.capabilities || { edit: true, editSensitive: true, sensitive: true, internalNote: true, bind: true };
      $('sms-dialog-title').textContent = student ? student.basic.name : '新建学生';
      const fields = $('sms-student-fields'); fields.replaceChildren();
      if (!caps.edit && !caps.bind) fields.append(element('p', 'sms-read-only', '当前以只读方式查看。资料修改请联系获授权的管理人员。'));
      fields.append(fieldGroup('基本资料', basicFields, student?.basic || {}, caps.edit, 'basic'));
      if (caps.sensitive) fields.append(fieldGroup('个人与联系资料', sensitiveFields, student?.sensitive || {}, caps.editSensitive, 'sensitive'));
      if (caps.internalNote) {
        fields.append(element('h3', '', '内部备注'));
        if (caps.edit) { const note = element('textarea'); note.name = 'internalNote'; note.rows = 3; note.maxLength = 3000; note.value = student?.internalNote || ''; note.setAttribute('aria-label', '内部备注'); fields.append(note); }
        else fields.append(element('p', 'sms-read-value', student?.internalNote || '未填写'));
        fields.append(element('p', 'sms-muted', '内部备注不会向学生本人展示。'));
      }
      fields.append(element('h3', '', 'Hydro 账号关联'));
      if (caps.bind) {
        const label = element('label', 'sms-field', 'Hydro UID'); const input = element('input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.name = 'hydroUid'; input.placeholder = '留空表示不绑定账号'; input.value = student?.hydroUid || ''; label.append(input); fields.append(label);
        fields.append(element('p', 'sms-muted', '绑定后，该 Hydro 用户可查看自己的基本与联系资料。请核实 UID 后再保存。'));
      } else fields.append(element('p', 'sms-read-value', student?.hydroUid ? `UID ${student.hydroUid}` : '未绑定'));
      if (student) {
        const footnote = element('p', 'sms-muted', `最近更新：${dateTime(student.updatedAt)} · 档案编号 ${student.id}`); fields.append(footnote);
      }
      $('sms-hydro-profile').hidden = !student?.hydroUid;
      if (student?.hydroUid) $('sms-hydro-profile').href = `/user/${student.hydroUid}`;
      $('sms-save-student').hidden = !caps.edit && !caps.bind;
      $('sms-save-student').disabled = false;
      $('sms-dialog-error').hidden = true;
      $('sms-student-dialog').showModal();
      $('sms-student-dialog').querySelector('.sms-dialog-body').scrollTop = 0;
    } catch (error) { notice(error.message, true); }
  }
  async function saveStudent(event) {
    event.preventDefault();
    const student = state.current; const caps = student?.capabilities || { edit: true, editSensitive: true, sensitive: true, internalNote: true, bind: true };
    const values = new FormData(event.target); const body = {};
    if (student) body.version = student.version;
    if (caps.edit) {
      body.basic = Object.fromEntries(basicFields.map(([key]) => [key, values.get(`basic.${key}`) || '']));
      if (caps.editSensitive) body.sensitive = Object.fromEntries(sensitiveFields.map(([key]) => [key, values.get(`sensitive.${key}`) || '']));
      if (caps.internalNote) body.internalNote = values.get('internalNote') || '';
    }
    if (caps.bind) body.hydroUid = values.get('hydroUid') ? Number(values.get('hydroUid')) : null;
    $('sms-save-student').disabled = true;
    try {
      await api(student ? `${app.dataset.api}/${encodeURIComponent(student.id)}` : app.dataset.api, body);
      $('sms-student-dialog').close(); notice(student ? '学生资料已保存。' : '学生档案已创建。'); await loadStudents();
    } catch (error) { $('sms-dialog-error').textContent = error.message; $('sms-dialog-error').hidden = false; $('sms-dialog-error').scrollIntoView({ block: 'nearest' }); }
    finally { $('sms-save-student').disabled = false; }
  }
  async function loadPolicy() {
    state.policy = await api(app.dataset.permissions);
    $('sms-admin-list').textContent = `插件管理员：${state.policy.admins.map((uid) => `UID ${uid}`).join('、')}。管理员身份由服务器命令管理。`;
    const list = $('sms-grant-list'); list.replaceChildren();
    if (!state.policy.grants.length) list.append(element('p', 'sms-muted', '暂无追加授权。绑定学生仍可查看本人资料。'));
    for (const grant of state.policy.grants) {
      const row = element('div', 'sms-grant-item'); const info = element('div'); const expired = grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now();
      info.append(element('strong', '', `UID ${grant.uid}${expired ? ' · 已失效' : ''}`));
      info.append(element('p', '', grant.permissions.map((p) => permissionLabels[p]).join(' · ')));
      info.append(element('p', '', `${grant.studentIds === 'all' ? '全部学生' : `指定 ${grant.studentIds.length} 名学生`} · ${grant.expiresAt ? `${dateTime(grant.expiresAt)} 到期` : '长期有效'}`));
      const controls = element('div'); const edit = element('button', 'sms-link', '编辑'); edit.type = 'button';
      edit.addEventListener('click', async () => {
        $('sms-grant-uid').value = grant.uid;
        $('sms-grant-expires').value = grant.expiresAt ? new Date(Date.parse(grant.expiresAt) + 8 * 3600000).toISOString().slice(0, 16) : '';
        document.querySelectorAll('[name=sms-permission]').forEach((input) => { input.checked = grant.permissions.includes(input.value); });
        $('sms-grant-scope').value = grant.studentIds === 'all' ? 'all' : 'selected';
        state.selected.clear();
        if (grant.studentIds !== 'all') for (const id of grant.studentIds) state.selected.set(id, `档案 ${id.slice(0, 8)}`);
        try { await loadScope(); } catch (error) { notice(error.message, true); }
        $('sms-grant-uid').focus();
      });
      const revoke = element('button', 'sms-link', '撤销'); revoke.type = 'button'; revoke.addEventListener('click', async () => {
        if (!confirm(`撤销 UID ${grant.uid} 的全部追加授权？`)) return;
        revoke.disabled = true;
        try { await api(app.dataset.permissions, { action: 'revoke', uid: grant.uid, revision: state.policy.revision }); await loadPolicy(); notice('授权已撤销。'); }
        catch (error) { notice(error.message, true); } finally { revoke.disabled = false; }
      });
      controls.append(edit, revoke); row.append(info, controls); list.append(row);
    }
  }
  function renderChips() {
    const chips = $('sms-selected-students'); chips.replaceChildren();
    for (const [id, label] of state.selected) {
      const chip = element('button', '', `${label} ×`); chip.type = 'button'; chip.addEventListener('click', () => { state.selected.delete(id); renderChips(); document.querySelectorAll('[data-student-id]').forEach((c) => { if (c.dataset.studentId === id) c.checked = false; }); }); chips.append(chip);
    }
  }
  let scopeRequest = 0;
  async function loadScope() {
    const request = ++scopeRequest;
    $('sms-grant-students').hidden = $('sms-grant-scope').value !== 'selected';
    renderChips();
    if ($('sms-grant-students').hidden) return;
    const url = new URL(app.dataset.api, location.origin); url.search = new URLSearchParams({ q: $('sms-scope-search').value, page: 1 });
    const result = await api(url); if (request !== scopeRequest) return;
    const options = $('sms-scope-options'); options.replaceChildren();
    for (const student of result.students) {
      if (state.selected.has(student.id)) state.selected.set(student.id, student.name);
      const label = element('label'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.studentId = student.id; checkbox.checked = state.selected.has(student.id);
      checkbox.addEventListener('change', () => { if (checkbox.checked) state.selected.set(student.id, student.name); else state.selected.delete(student.id); renderChips(); });
      label.append(checkbox, document.createTextNode(`${student.name} · ${student.studentNo || '未填写学号'}`)); options.append(label);
    }
    if (result.total > 20) options.append(element('p', 'sms-muted', '显示前 20 条，请输入姓名或学号缩小范围。'));
    if (!result.total) options.append(element('p', 'sms-muted', '没有匹配的学生。'));
    renderChips();
  }
  async function saveGrant(event) {
    event.preventDefault(); const button = event.target.querySelector('[type=submit]'); button.disabled = true;
    try {
      const localTime = $('sms-grant-expires').value;
      const data = { action: 'save', uid: Number($('sms-grant-uid').value), revision: state.policy.revision,
        permissions: ['students.read', ...[...document.querySelectorAll('[name=sms-permission]:checked')].map((i) => i.value)],
        studentIds: $('sms-grant-scope').value === 'all' ? 'all' : [...state.selected.keys()],
        expiresAt: localTime ? new Date(`${localTime}:00+08:00`).toISOString() : null };
      await api(app.dataset.permissions, data); await loadPolicy(); notice('访问授权已保存。');
    } catch (error) { notice(error.message, true); }
    finally { button.disabled = false; }
  }
  async function loadAudit() {
    const records = await api(app.dataset.audit); const rows = $('sms-audit-rows'); rows.replaceChildren();
    for (const record of records) {
      const row = element('tr');
      for (const content of [dateTime(record.at), record.uid ? `UID ${record.uid}` : '服务器命令', actionLabels[record.action] || record.action, record.target, ({ success: '成功', pending: '待核对', failed: '失败', unchanged: '未变更' })[record.outcome] || '已记录']) row.append(element('td', '', content));
      rows.append(row);
    }
    if (!records.length) { const row = element('tr'); const cell = element('td', '', '暂无操作记录'); cell.colSpan = 5; row.append(cell); rows.append(row); }
  }
  async function switchTab(tab) {
    state.tab = tab; notice('');
    for (const name of ['students', 'permissions', 'audit']) $(`sms-${name}-section`).hidden = name !== tab;
    document.querySelectorAll('.sms-nav').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    try { if (tab === 'permissions') await loadPolicy(); else if (tab === 'audit') await loadAudit(); else await loadStudents(); }
    catch (error) { notice(error.message, true); }
  }
  $('sms-search-form').addEventListener('submit', (event) => { event.preventDefault(); state.page = 1; notice(''); loadStudents(); });
  $('sms-prev').addEventListener('click', () => { state.page--; loadStudents(); });
  $('sms-next').addEventListener('click', () => { state.page++; loadStudents(); });
  $('sms-create').addEventListener('click', () => openStudent());
  $('sms-close-dialog').addEventListener('click', () => $('sms-student-dialog').close());
  $('sms-cancel-dialog').addEventListener('click', () => $('sms-student-dialog').close());
  $('sms-student-form').addEventListener('submit', saveStudent);
  $('sms-grant-form').addEventListener('submit', saveGrant);
  $('sms-grant-scope').addEventListener('change', () => loadScope().catch((error) => notice(error.message, true)));
  let scopeTimer; $('sms-scope-search').addEventListener('input', () => { clearTimeout(scopeTimer); scopeTimer = setTimeout(() => loadScope().catch((error) => notice(error.message, true)), 250); });
  $('sms-refresh-audit').addEventListener('click', () => loadAudit().catch((error) => notice(error.message, true)));
  document.querySelectorAll('.sms-nav').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  (async () => {
    try {
      state.me = await api(app.dataset.me);
      $('sms-identity').textContent = `UID ${state.me.uid} · ${state.me.admin ? '插件管理员' : state.me.grants.length ? '已授权用户' : state.me.boundStudentId ? '学生本人' : 'Hydro 用户'}`;
      $('sms-create').hidden = $('sms-permissions-nav').hidden = $('sms-audit-nav').hidden = !state.me.admin;
      if (!state.me.initialized) notice('插件尚未初始化，请由服务器维护人员指定首位插件管理员。');
      await loadStudents();
    } catch (error) { notice(error.message, true); $('sms-identity').textContent = '无法确认访问权限'; $('sms-summary').textContent = '请确认登录状态后刷新页面'; }
  })();
})();

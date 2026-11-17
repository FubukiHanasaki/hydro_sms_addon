/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
  const app = document.getElementById('sms-app'); if (!app?.dataset.manageDomain) return;
  const $ = id => document.getElementById(id), form = $('sms-domain-profile-form');
  const fields = ['name', 'type', 'academicYear', 'schedule', 'location', 'status', 'avatar', 'description', 'langs', 'share'];
  let identity, current, baseline, busy = false, navigating = false, membersReady = false, revoked = false, checking;
  const signature = value => JSON.stringify([value.admin, value.capabilities, value.scopes]);
  const allowed = code => identity.scopes[code] === null || identity.scopes[code]?.includes(app.dataset.manageDomain);
  const snapshot = () => JSON.stringify(fields.filter(key => !form.elements[key].disabled).map(key => [key, form.elements[key].value]));
  const dirty = () => baseline !== undefined && (snapshot() !== baseline || bulletin.uploading());
  function notice(message) { $('sms-domain-notice').textContent = message; $('sms-domain-notice').hidden = !message; }
  async function api(url, body) {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-SMS-Request': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 403 && identity) refreshIdentity();
    let result; try { result = await response.json(); } catch { throw Error('服务响应异常，请刷新后重试'); }
    if (!response.ok || !Object.hasOwn(result, 'data')) throw Error(result.message || '无法读取域资料'); return result.data;
  }
  function render(value) {
    if (revoked) return;
    current = value;
    $('sms-domain-fields').disabled = false;
    for (const key of fields) { form.elements[key].value = value[key] ?? ''; form.elements[key].disabled = !value.canEdit; }
    form.elements.description.disabled = !value.canEditBulletin;
    bulletin.set(value.description, value.canEditBulletin);
    form.elements.status.disabled = !value.canEdit || !allowed('classes.archive');
    form.elements.share.disabled = !value.canEdit || !identity.admin;
    $('sms-domain-share-field').hidden = !identity.admin;
    $('sms-domain-save').hidden = !(value.canEdit || value.canEditBulletin); $('sms-domain-save').disabled = !(value.canEdit || value.canEditBulletin);
    $('sms-domain-name').textContent = value.name;
    const option = [...$('sms-domain-select').options].find(option => option.value === value.domainId);
    if (option) option.textContent = `${value.name} (${value.domainId})`;
    $('sms-domain-teachers').textContent = value.teachers.map(teacher => teacher.displayName || teacher.name || teacher.username).join('、') || '—';
    $('sms-domain-count').textContent = value.memberCount === undefined ? '—' : `${value.memberCount} 人`;
    baseline = snapshot();
    $('sms-domain-status').textContent = value.syncState === 'ready' ? '' : '上次保存未完成，请核对资料后重试。';
  }
  async function reload() {
    if (busy || revoked || dirty() && !confirm('有未保存的修改，确认重新载入？')) return;
    busy = true; $('sms-domain-reload').disabled = true;
    try { render(await api(`${app.dataset.classes}/${encodeURIComponent(app.dataset.manageDomain)}`)); notice(''); }
    catch (error) { notice(error.message); } finally { busy = false; $('sms-domain-reload').disabled = false; }
  }
  async function view(name) {
    if (!identity || revoked) return;
    const members = name === 'members';
    $('sms-domain-profile-panel').hidden = members; $('sms-domain-members-panel').hidden = !members;
    for (const tab of ['profile', 'members']) { const node = $(`sms-domain-tab-${tab}`); node.setAttribute('aria-selected', String(tab === name)); node.tabIndex = tab === name ? 0 : -1; }
    if (members && !membersReady) { membersReady = true; try { await globalThis.SmsDomainMembers(identity); } catch (error) { membersReady = false; notice(error.message); } }
  }
  const requestedTab = () => location.hash === '#members' ? 'members' : location.hash === '#profile' ? 'profile' : current && !current.canEdit && !current.canEditBulletin && allowed('classes.members') ? 'members' : 'profile';
  for (const name of ['profile', 'members']) {
    const tab = $(`sms-domain-tab-${name}`);
    tab.addEventListener('click', () => { history.pushState(null, '', `#${name}`); view(name); });
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 'profile' : event.key === 'End' ? 'members' : name === 'profile' ? 'members' : 'profile';
      $(`sms-domain-tab-${next}`).focus(); $(`sms-domain-tab-${next}`).click();
    });
  }
  window.addEventListener('hashchange', () => view(requestedTab()));
  window.addEventListener('popstate', () => view(requestedTab()));
  $('sms-domain-select').addEventListener('change', event => {
    if (dirty() && !confirm('有未保存的修改，确认切换子域？')) { event.target.value = app.dataset.manageDomain; return; }
    navigating = true; location.assign(`/d/${encodeURIComponent(event.target.value)}/sms/domain${location.hash}`);
  });
  window.addEventListener('beforeunload', event => { if (app.isConnected && !navigating && dirty()) { event.preventDefault(); event.returnValue = ''; } });
  $('sms-domain-reload').addEventListener('click', reload);
  // This form owns its in-flight lock. Hydro's delegated five-second click
  // throttle would silently swallow retries after a validation/conflict error.
  $('sms-domain-save').addEventListener('click', event => event.stopPropagation());
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || revoked || !(current?.canEdit || current?.canEditBulletin)) return;
    if (bulletin.uploading()) { notice('资料正在上传，请完成后再保存公告'); return; }
    busy = true; $('sms-domain-save').disabled = true; $('sms-domain-reload').disabled = true; notice('');
    const data = { domainId: current.domainId, version: current.version, createDomain: false };
    for (const key of fields) {
      if (key === 'share' && !identity.admin) continue;
      if (['avatar', 'langs', 'share'].includes(key) && form.elements[key].value === (current[key] ?? '')) continue;
      data[key] = key === 'status' && form.elements.status.disabled ? current.status : form.elements[key].value;
    }
    $('sms-domain-fields').disabled = true; form.setAttribute('aria-busy', 'true');
    try {
      const result = current.canEdit ? await api(`${app.dataset.classes}/${encodeURIComponent(current._id)}`, data) : await api(`${app.dataset.domains}/${encodeURIComponent(current.domainId)}/bulletin`, { description: form.elements.description.value, version: current.version });
      render(result); membersReady = false; $('sms-domain-status').textContent = '已保存';
    }
    catch (error) { notice(error.message); }
    finally { busy = false; form.removeAttribute('aria-busy'); if (!revoked) { $('sms-domain-fields').disabled = false; $('sms-domain-save').disabled = false; $('sms-domain-reload').disabled = false; } }
  });
  app.addEventListener('sms:domain-mutated', async () => {
    if (dirty() || busy || revoked) return;
    try { render(await api(`${app.dataset.classes}/${encodeURIComponent(app.dataset.manageDomain)}`)); } catch (error) { notice(error.message); }
  });
  async function refreshIdentity() {
    if (!app.isConnected || revoked || !identity || checking) return checking;
    checking = (async () => {
      try {
        const next = await api(app.dataset.me);
        if (signature(next) === signature(identity)) return;
        revoke();
      } catch (error) { if (/无法读取|Forbidden|登录/.test(error.message)) revoke(); }
      finally { checking = null; }
    })(); return checking;
  }
  function revoke() {
    revoked = true; bulletin.disable(); app.hidden = true; app.inert = true;
    const section = document.createElement('section'); section.className = 'section section__body'; section.setAttribute('role', 'alert');
    const text = document.createElement('p'); text.textContent = '访问权限已变化，请刷新页面。';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'rounded button'; button.textContent = '刷新页面';
    button.addEventListener('click', () => { if (!dirty() || confirm('刷新会放弃未保存的修改，确认继续？')) { navigating = true; location.reload(); } });
    section.append(text, button); app.before(section);
  }
  globalThis.SmsRefreshIdentity = refreshIdentity;
  const bulletin = globalThis.SmsBulletinEditor(app, { api, onError: notice, onChange: () => { $('sms-domain-status').textContent = ''; } });
  window.addEventListener('focus', refreshIdentity);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIdentity(); });
  setInterval(() => { if (!document.hidden) refreshIdentity(); }, 60000);
  (async () => {
    try {
      const [me, value] = await Promise.all([api(app.dataset.me), api(`${app.dataset.classes}/${encodeURIComponent(app.dataset.manageDomain)}`)]);
      identity = me; render(value); await view(requestedTab());
    } catch (error) { notice(error.message); $('sms-domain-status').textContent = ''; }
  })();
})();

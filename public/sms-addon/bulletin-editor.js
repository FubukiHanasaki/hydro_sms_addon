/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
  globalThis.SmsBulletinEditor = (app, { api, onError, onChange }) => {
    const $ = id => document.getElementById(id), root = $('sms-bulletin-editor'), source = $('sms-bulletin-source');
    const endpoint = `${app.dataset.domains}/${encodeURIComponent(app.dataset.manageDomain)}`;
    const preview = $('sms-bulletin-preview'), toolbar = $('sms-bulletin-toolbar'), picker = $('sms-bulletin-upload');
    let editable = false, dead = false, pending = false, timer, serial = 0, fileSerial = 0, mode = matchMedia('(max-width:767px)').matches ? 'edit' : 'split';
    let history = [], position = -1, typing = 0, initialized = false;
    const controls = [], views = [];
    const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
    const active = () => !dead && app.isConnected;
    const writable = () => editable && active() && !source.matches(':disabled');
    function message(text) { $('sms-bulletin-message').textContent = text; $('sms-bulletin-message').hidden = !text; }
    function remember(group = false) {
      if (history[position] === source.value) return;
      if (group && Date.now() - typing < 500 && position > 0) history[position] = source.value;
      else { history = history.slice(0, position + 1); history.push(source.value); if (history.length > 80) history.shift(); position = history.length - 1; }
      typing = group ? Date.now() : 0;
    }
    function changed(group = false) { remember(group); onChange(); clearTimeout(timer); serial++; timer = setTimeout(renderPreview, 250); }
    function insert(before, after = '', fallback = '') {
      if (!writable()) return;
      const start = source.selectionStart, end = source.selectionEnd, selected = source.value.slice(start, end) || fallback;
      const value = before + selected + after;
      if (source.value.length - (end - start) + value.length > source.maxLength) return onError('公告最多支持 100000 字符');
      source.setRangeText(value, start, end, 'end'); source.focus();
      source.setSelectionRange(start + before.length, start + before.length + selected.length); changed();
    }
    function action(label, title, work) {
      const button = el('button', label); button.type = 'button'; button.className = 'tool-button'; button.title = title; button.setAttribute('aria-label', title); button.disabled = true;
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', event => { event.stopPropagation(); if (!button.disabled && active()) work(); }); toolbar.append(button); controls.push(button); return button;
    }
    for (const [label, title, before, after, fallback] of [
      ['H','标题','\n## ','\n','标题'],['B','粗体','**','**','文字'],['I','斜体','*','*','文字'],['引用','引用','\n> ','\n','引用内容'],
      ['列表','无序列表','\n- ','\n','列表项'],['序号','有序列表','\n1. ','\n','列表项'],['任务','任务列表','\n- [ ] ','\n','任务项'],
      ['代码','代码块','\n```cpp\n','\n```\n',''],['表格','插入表格','\n| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |\n','',''],
      ['链接','插入链接','[','](https://)','链接文字'],
    ]) action(label, title, () => insert(before, after, fallback));
    action('图片', '上传并插入图片', () => { picker.accept = '.png,.jpg,.jpeg,.gif,.webp'; picker.click(); });
    action('附件', '上传并插入学习资料', () => { picker.accept = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.csv,.zip,.7z,.rar,.c,.cpp,.h,.py,.java,.pas,.png,.jpg,.jpeg,.gif,.webp'; picker.click(); });
    function move(step) { const next = position + step; if (next < 0 || next >= history.length) return; position = next; source.value = history[position]; typing = 0; onChange(); serial++; clearTimeout(timer); timer = setTimeout(renderPreview, 150); source.focus(); }
    action('↶', '撤销', () => move(-1)); action('↷', '重做', () => move(1));
    action('全屏', '切换全屏编辑', () => fullscreen(!root.classList.contains('is-fullscreen')));
    function fullscreen(value) { root.classList.toggle('is-fullscreen', value); if (value) source.focus(); }
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && root.classList.contains('is-fullscreen')) { event.preventDefault(); fullscreen(false); } });
    source.addEventListener('input', () => changed(true));
    source.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && ['z','y','b','i','s'].includes(event.key.toLowerCase())) {
        event.preventDefault(); const key = event.key.toLowerCase();
        if (key === 'z' || key === 'y') move(key === 'y' || event.shiftKey ? 1 : -1);
        else if (key === 'b') insert('**','**','文字'); else if (key === 'i') insert('*','*','文字'); else $('sms-domain-profile-form').requestSubmit();
      }
      if (event.key === 'Tab' && editable) { event.preventDefault(); insert('  '); }
    });
    function setMode(value) { mode = value; root.dataset.mode = mode; for (const [button, name] of views) button.setAttribute('aria-pressed', String(name === mode)); if (mode !== 'edit') renderPreview(); }
    for (const [name, label] of [['edit','编辑'],['split','分栏'],['preview','预览']]) {
      const button = el('button', label); button.type = 'button'; button.className = 'tool-button'; button.setAttribute('aria-pressed', String(name === mode)); button.addEventListener('click', () => setMode(name)); $('sms-bulletin-views').append(button); views.push([button, name]);
    }
    async function renderPreview() {
      if (!active() || !initialized || mode === 'edit') return;
      const current = ++serial, value = source.value;
      if (!value.trim()) { preview.replaceChildren(); return; }
      try {
        const result = await api(`${endpoint}/bulletin/preview`, { text: value });
        if (!active() || current !== serial) return;
        // The server uses the same sanitized Markdown renderer as the domain home.
        preview.innerHTML = result.html;
        for (const link of preview.querySelectorAll('a')) link.rel = 'noopener noreferrer';
      } catch (error) { if (active() && current === serial) onError(error.message); }
    }
    const markdown = file => `${file.image ? '!' : ''}[${file.filename.replace(/[\\\[\]]/g, '\\$&')}](${file.url})`;
    async function refreshFiles() {
      if (!active() || !editable) return;
      const current = ++fileSerial;
      try {
        const files = await api(`${endpoint}/materials`); if (!active() || current !== fileSerial) return;
        $('sms-bulletin-file-count').textContent = `（${files.length}）`; const list = $('sms-bulletin-files'); list.replaceChildren();
        for (const file of files) {
          const row = el('div'); row.className = 'sms-bulletin-file'; const link = el('a', file.filename); link.href = file.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
          const size = el('span', file.size >= 1048576 ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(file.size / 1024))} KB`);
          const button = el('button', '插入公告'); button.type = 'button'; button.className = 'link'; button.addEventListener('click', () => insert('\n' + markdown(file) + '\n'));
          row.append(link, size, button); list.append(row);
        }
        if (!files.length) list.append(el('p', '暂无学习资料'));
      } catch (error) { if (active() && current === fileSerial) onError(error.message); }
    }
    async function upload(files) {
      if (!writable() || pending || !files.length) return;
      pending = true; for (const control of controls) control.disabled = true;
      try {
        for (const file of files) {
          if (!active()) break;
          if (!file.size || file.size > 20 * 1024 * 1024) throw Error('单个学习资料文件不能超过 20 MB，且不能为空');
          message(`正在上传 ${file.name}…`); const body = new FormData(); body.append('file', file);
          const response = await fetch(`${endpoint}/materials`, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'X-SMS-Request': '1' }, body });
          if (response.status === 403) globalThis.SmsRefreshIdentity?.();
          let result; try { result = await response.json(); } catch { throw Error('上传未完成，请重试'); }
          if (!response.ok || !result.data) throw Error(result.message || '上传未完成，请重试');
          if (active()) insert('\n' + markdown(result.data) + '\n');
        }
        if (active()) { message('资料已插入，保存公告后显示。'); await refreshFiles(); }
      } catch (error) { if (active()) { message(''); onError(error.message); await refreshFiles(); } }
      finally { pending = false; if (active()) for (const control of controls) control.disabled = !editable; }
    }
    picker.addEventListener('change', () => { const files = [...picker.files]; picker.value = ''; upload(files); });
    root.addEventListener('dragover', event => { if (editable && event.dataTransfer.types.includes('Files')) event.preventDefault(); });
    root.addEventListener('drop', event => { if (event.dataTransfer.files.length) { event.preventDefault(); upload([...event.dataTransfer.files]); } });
    source.addEventListener('paste', event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); upload(files); } });
    root.dataset.mode = mode;
    return {
      uploading: () => pending,
      set(value, canEdit) {
        source.value = value || ''; editable = canEdit; initialized = true; history = [source.value]; position = 0; typing = 0;
        for (const control of controls) control.disabled = !editable || pending;
        toolbar.hidden = !editable; $('sms-bulletin-materials').hidden = !editable; picker.disabled = !editable;
        serial++; clearTimeout(timer); renderPreview(); refreshFiles();
      },
      disable() { dead = true; serial++; fileSerial++; clearTimeout(timer); fullscreen(false); for (const control of controls) control.disabled = true; },
    };
  };
})();

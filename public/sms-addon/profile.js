/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
  for (const root of document.querySelectorAll('.sms-profile-tabs')) {
    if (root.dataset.ready) continue;
    const source = root.querySelector('.sms-profile-tab-source');
    if (!source) continue;
    const tabs = [...source.children].map(item => ({ title: item.querySelector('.section__tab-title')?.textContent, panel: item.querySelector('.section__tab-main') })).filter(item => item.title && item.panel);
    const wrapper = document.createElement('div'); wrapper.className = 'section__tab-header-wrapper';
    const header = document.createElement('div'); header.className = 'section__tab-header'; header.setAttribute('role', 'tablist'); header.setAttribute('aria-label', '用户资料');
    const content = document.createElement('div'); content.className = 'sms-profile-tab-content';
    const buttons = [];
    function select(index, remember = false, focus = false) {
      index = Number.isInteger(index) && index >= 0 && index < tabs.length ? index : 0;
      tabs.forEach(({ panel }, i) => { panel.hidden = i !== index; panel.classList.toggle('active', i === index); buttons[i].classList.toggle('selected', i === index); buttons[i].setAttribute('aria-selected', String(i === index)); buttons[i].tabIndex = i === index ? 0 : -1; });
      if (remember && location.hash !== `#tab-${index}`) history.pushState(null, '', `#tab-${index}`);
      if (focus) buttons[index].focus();
    }
    tabs.forEach(({ title, panel }, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'section__tab-header-item'; button.textContent = title;
      button.id = `sms-profile-tab-${index}`; panel.id = `sms-profile-panel-${index}`;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
      button.addEventListener('click', () => select(index, true));
      button.addEventListener('keydown', event => { let next; if (event.key === 'ArrowRight') next = (index + 1) % tabs.length; else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = tabs.length - 1; if (next !== undefined) { event.preventDefault(); select(next, true, true); } });
      buttons.push(button); header.append(button); content.append(panel);
    });
    wrapper.append(header); root.append(wrapper, content); source.remove(); root.dataset.ready = 'true';
    const fromHash = () => select(Number(/^#tab-(\d+)$/.exec(location.hash)?.[1] ?? 0));
    window.addEventListener('hashchange', fromHash); window.addEventListener('popstate', fromHash); fromHash();
  }
})();

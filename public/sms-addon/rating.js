/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
    if (window.smsRatingInstalled)
        return;
    window.smsRatingInstalled = true;
    const $ = id => document.getElementById(id), app = $('sms-app'), native = document.querySelector('[data-sms-native-rating]');
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls)
        e.className = cls; if (text !== undefined)
        e.textContent = String(text); return e; };
    const date = s => new Date(s).toLocaleString('zh-CN', { hour12: false }), number = v => Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }), signed = v => (v > 0 ? '+' : '') + number(v);
    const button = (label, work, cls = 'rounded button') => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try {
        await work();
    }
    catch (e) {
        error(e);
    }
    finally {
        if (b.isConnected)
            b.disabled = b.hasAttribute('data-disabled');
    } }); return b; };
    async function api(url, body) { const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-SMS-Request': '1', Accept: 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); let result; try {
        result = await r.json();
    }
    catch {
        throw new Error('服务响应异常');
    } if (!r.ok || !Object.hasOwn(result, 'data'))
        throw new Error(result.message || '无法读取 Rating'); return result.data; }
    let currentDialog;
    function error(e) { const node = currentDialog?.open ? currentDialog.querySelector('.sms-rating-error') : $('sms-notice'); if (node) {
        node.textContent = e.message;
        node.hidden = false;
    }
    else
        alert(e.message); }
    function dialog(title) {
        if (currentDialog?.open)
            currentDialog.close();
        const d = el('dialog', 'section visible sms-rating-dialog');
        d.setAttribute('aria-label', title);
        const header = el('header', 'section__header'), h = el('h1', 'section__title', title), close = button('×', () => d.close(), 'link sms-close');
        close.setAttribute('aria-label', '关闭');
        header.append(h, close);
        const body = el('div', 'section__body'), err = el('p', 'sms-rating-error');
        err.setAttribute('role', 'alert');
        body.append(err);
        const footer = el('footer', 'section__footer'), left = el('div'), right = el('div');
        right.append(button('关闭', () => d.close()));
        footer.append(left, right);
        d.append(header, body, footer);
        document.body.append(d);
        currentDialog = d;
        d.addEventListener('close', () => { for (const plot of d.querySelectorAll('.sms-rating-chart')) plot.smsResize?.disconnect(); d.remove(); }, { once: true });
        d.showModal();
        return { d, body, footer, left, right, error: err };
    }
    function table(headers, cls = '') { const wrapper = el('div', 'sms-table-scroll'), t = el('table', `data-table ${cls}`), head = el('thead'), tr = el('tr'), body = el('tbody'), cols = el('colgroup'); const widths = headers.length === 2 ? [75, 25] : cls === 'sms-rating-history-table' ? [34, 12, 24, 14, 16] : cls === 'sms-rating-config-table' ? [32, 18, 15, 20, 15] : [20, 25, 55]; widths.forEach(w => { const col = el('col'); col.style.width = w + '%'; cols.append(col); }); t.append(cols); headers.forEach(h => tr.append(el('th', '', h))); head.append(tr); t.append(head, body); wrapper.append(t); return { wrapper, body }; }
    function chart(root, points, bands = root.smsBands || []) {
        root.replaceChildren();
        root.classList.add('sms-rating-chart', 'sms-cf-chart');
        root.smsPoints = points; root.smsBands = bands;
        const width = Math.max(280, Math.min(880, root.clientWidth || 760));
        root.smsChartWidth = width;
        if (!root.smsResize && typeof ResizeObserver !== 'undefined') {
            root.smsResize = new ResizeObserver(() => {
                if (root.clientWidth && Math.max(280, Math.min(880, root.clientWidth)) !== root.smsChartWidth) chart(root, root.smsPoints);
            });
            root.smsResize.observe(root);
        }
        if (!points.length) { root.append(el('p', 'sms-rating-chart-empty', '暂无 Rating 记录')); return; }
        const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
        const height = width < 500 ? 270 : 300, left = 52, right = width - 16, top = 18, bottom = height - 34;
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('role', 'img'); svg.setAttribute('tabindex', '0');
        svg.setAttribute('aria-label', 'Rating 历史曲线，可用左右方向键查看记录');
        const append = (tag, attrs, text) => { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = String(text); svg.append(node); return node; };
        const low = points.reduce((v, p) => Math.min(v, p.rating), Infinity), high = points.reduce((v, p) => Math.max(v, p.rating), -Infinity), lo = Math.max(0, Math.floor((low - 100) / 100) * 100), hi = Math.max(lo + 400, Math.ceil((high + 100) / 100) * 100);
        const start = +new Date(points[0].at), end = +new Date(points[points.length - 1].at);
        const x = p => end === start ? (left + right) / 2 : left + (+new Date(p.at) - start) / (end - start) * (right - left);
        const y = rating => bottom - (rating - lo) / (hi - lo) * (bottom - top);
        const tiers = [...bands].sort((a, b) => a.min - b.min);
        tiers.forEach((band, index) => {
            const lower = Math.max(lo, band.min), upper = Math.min(hi, tiers[index + 1]?.min ?? hi);
            if (upper <= lower) return;
            append('rect', { x: left, y: y(upper), width: right - left, height: y(lower) - y(upper), class: `sms-rating-band sms-band-${band.key}`, 'aria-hidden': 'true' });
            if (y(lower) - y(upper) >= 24 && width >= 600) append('text', { x: right - 7, y: y(upper) + 16, 'text-anchor': 'end', class: 'sms-band-label', 'aria-hidden': 'true' }, band.title);
        });
        const step = (hi - lo) / 4;
        for (let i = 0; i <= 4; i++) {
            const value = lo + i * step, yy = y(value);
            append('line', { x1: left, x2: right, y1: yy, y2: yy, class: 'sms-chart-grid' });
            append('text', { x: left - 8, y: yy + 4, 'text-anchor': 'end' }, number(value));
        }
        append('line', { x1: left, x2: left, y1: top, y2: bottom, class: 'sms-chart-axis' });
        append('line', { x1: left, x2: right, y1: bottom, y2: bottom, class: 'sms-chart-axis' });
        const shortDate = t => new Date(t).toLocaleDateString('zh-CN');
        if (start === end) append('text', { x: (left + right) / 2, y: height - 9, 'text-anchor': 'middle' }, shortDate(start));
        else {
            append('text', { x: left, y: height - 9 }, shortDate(start));
            if (width >= 600) append('text', { x: (left + right) / 2, y: height - 9, 'text-anchor': 'middle' }, shortDate((start + end) / 2));
            append('text', { x: right, y: height - 9, 'text-anchor': 'end' }, shortDate(end));
        }
        append('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(2)},${y(p.rating).toFixed(2)}`).join(' '), class: 'sms-chart-line' });
        points.forEach((p, i) => {
            if (points.length > 200 && i % Math.ceil(points.length / 200) && i !== points.length - 1) return;
            const dot = append('circle', { cx: x(p), cy: y(p.rating), r: 2.7, class: 'sms-chart-point' }), title = document.createElementNS(ns, 'title');
            title.textContent = `${p.title || 'Rating'} · ${date(p.at)} · ${number(p.rating)}`; dot.append(title);
        });
        const marker = append('circle', { r: 5, class: 'sms-chart-selected', visibility: 'hidden', 'aria-hidden': 'true' });
        const detail = el('div', 'sms-rating-point-detail'); detail.hidden = true; detail.setAttribute('role', 'status'); detail.setAttribute('aria-live', 'polite');
        let selected = points.length - 1;
        function show(index) {
            selected = Math.max(0, Math.min(points.length - 1, index)); const p = points[selected];
            const delta = p.delta ?? (selected ? p.rating - points[selected - 1].rating : 0);
            detail.replaceChildren(el('strong', '', p.title || 'Rating 记录'), el('span', '', date(p.at)), el('span', '', `Rating ${number(p.rating)}（${signed(delta)}）`));
            if (p.rank) detail.append(el('span', '', `排名 ${p.rank} / ${p.participants}`));
            marker.setAttribute('cx', x(p)); marker.setAttribute('cy', y(p.rating)); marker.setAttribute('visibility', 'visible'); detail.hidden = false;
            const scale = svg.getBoundingClientRect().width / width;
            detail.style.left = `${Math.max(6, Math.min(root.clientWidth - detail.offsetWidth - 6, x(p) * scale + 12))}px`;
            detail.style.top = `${Math.max(6, Math.min(svg.getBoundingClientRect().height - detail.offsetHeight - 6, y(p.rating) * scale + 12))}px`;
        }
        function nearest(event) {
            const rect = svg.getBoundingClientRect(), px = (event.clientX - rect.left) / rect.width * width;
            let a = 0, b = points.length - 1;
            while (a < b) { const mid = Math.floor((a + b) / 2); if (x(points[mid]) < px) a = mid + 1; else b = mid; }
            return a > 0 && Math.abs(x(points[a - 1]) - px) < Math.abs(x(points[a]) - px) ? a - 1 : a;
        }
        svg.addEventListener('pointermove', event => show(nearest(event)));
        svg.addEventListener('pointerleave', () => { if (document.activeElement !== svg) { detail.hidden = true; marker.setAttribute('visibility', 'hidden'); } });
        svg.addEventListener('click', event => { show(nearest(event)); svg.focus({ preventScroll: true }); });
        svg.addEventListener('focus', () => show(selected));
        svg.addEventListener('blur', () => { detail.hidden = true; marker.setAttribute('visibility', 'hidden'); });
        svg.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
            event.preventDefault(); if (event.key === 'Escape') { detail.hidden = true; marker.setAttribute('visibility', 'hidden'); return; }
            show(event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : selected + (event.key === 'ArrowRight' ? 1 : -1));
        });
        root.append(svg, detail);
    }
    async function history(uid, base) {
        const view = dialog('Rating 历史'), metrics = el('div', 'sms-rating-metrics'), range = el('div', 'sms-rating-range'), plot = el('div'), details = table(['时间 / 来源', '难度', 'Rating', '变化', '排名'], 'sms-rating-history-table');
        view.body.append(metrics, range, plot, details.wrapper);
        let page = 1, serial = 0, period = 'all';
        async function load() {
            const request = ++serial;
            view.error.textContent = '';
            const data = await api(`${base}/${uid}?page=${page}`);
            if (!view.d.open || request !== serial)
                return;
            view.d.querySelector('h1').textContent = `${data.username} · Rating`;
            metrics.replaceChildren();
            for (const [label, value] of [['当前 Rating', number(data.rating)], ['称号', data.title], ['最高 Rating', number(data.peak)], ['近 30 天', signed(data.recent.delta)]]) {
                const block = el('div');
                block.append(el('span', '', label), el('strong', label === '称号' ? 'sms-rating-tier-value' : '', value));
                metrics.append(block);
            }
            const draw = () => chart(plot, period === 'all' ? data.trend : data.trend.filter(p => +new Date(p.at) >= Date.now() - 30 * 86400000), data.tierBands);
            range.replaceChildren();
            for (const [key, label] of [['all', '全部记录'], ['recent', '近 30 天']]) {
                const b = button(label, () => { period = key; for (const e of range.children)
                    e.setAttribute('aria-pressed', String(e === b)); draw(); });
                b.setAttribute('aria-pressed', String(period === key));
                range.append(b);
            }
            range.append(globalThis.SmsExport.control('导出历史','rating-history',()=>({uid,period})));
            draw();
            details.body.replaceChildren();
            for (const c of data.history) {
                const r = el('tr'), source = el('td');
                source.append(el('div', '', date(c.at)), el('div', 'sms-secondary', c.title));
                r.append(source, el('td', '', c.difficulty || '—'), el('td', '', `${number(c.before)} → ${number(c.after)}`), el('td', c.delta > 0 ? 'sms-rating-up' : c.delta < 0 ? 'sms-rating-down' : '', signed(c.delta)), el('td', '', c.rank ? `${c.rank} / ${c.participants}` : '—'));
                details.body.append(r);
            }
            if (!data.history.length) {
                const c = el('td', '', '暂无历史记录');
                c.colSpan = 5;
                const r = el('tr');
                r.append(c);
                details.body.append(r);
            }
            const prev = button('上一页', async () => { page--; await load(); }), next = button('下一页', async () => { page++; await load(); });
            prev.disabled = page <= 1;
            next.disabled = page * 20 >= data.total;
            if (prev.disabled)
                prev.setAttribute('data-disabled', '');
            if (next.disabled)
                next.setAttribute('data-disabled', '');
            view.left.replaceChildren(prev, el('span', '', `${page} / ${Math.max(1, Math.ceil(data.total / 20))} 页`), next);
        }
        await load();
    }
    const historyBase = app?.dataset.ratingHistory || native?.dataset.historyApi;
    native?.querySelectorAll('.sms-rating-view').forEach(b => b.addEventListener('click', () => history(b.dataset.uid, historyBase).catch(error)));
    for (const profile of document.querySelectorAll('[data-sms-profile-rating]')) {
        if(profile.querySelector('.sms-profile-history'))profile.querySelector('.sms-profile-rating-header').append(globalThis.SmsExport.control('导出历史','rating-history',()=>({uid:profile.dataset.smsProfileRating})));
        const base = profile.dataset.api.replace(/\/\d+$/, '');
        profile.querySelector('.sms-profile-history')?.addEventListener('click', () => history(profile.dataset.smsProfileRating, base).catch(error));
        if (profile.querySelector('.sms-profile-history'))
            api(profile.dataset.api).then(data => chart(profile.querySelector('.sms-profile-chart'), data.trend, data.tierBands)).catch(e => { profile.querySelector('.sms-profile-chart').textContent = e.message; });
    }
    if (!app)
        return;
    let me, page = 1, request = 0, boardStats;
    async function board() {
        const serial = ++request, url = new URL(app.dataset.rating, location.origin);
        url.search = new URLSearchParams({ q: $('sms-rating-query').value, mode: $('sms-rating-mode').value, page, grade: $('sms-rating-grade').value, school: $('sms-rating-school').value, classId: $('sms-rating-class').value });
        const data = await api(url);
        if (serial !== request)
            return;
        const classes = $('sms-rating-class');
        const all = el('option', '', data.classScope.label); all.value = '';
        classes.replaceChildren(all);
        for (const c of data.classScope.classes) { const option = el('option', '', c.name || c._id); option.value = c._id; classes.append(option); }
        classes.value = data.classScope.selected;
        app.dataset.exportRating=JSON.stringify(Object.fromEntries(url.searchParams));
        boardStats = data.stats;
        const rows = $('sms-rating-rows');
        rows.replaceChildren();
        for (const u of data.users) {
            const row = el('tr'), account = el('td'), link = el('a', '', u.username);
            link.href = `/user/${u.uid}`;
            account.append(link, el('div', 'sms-secondary', `UID ${u.uid}`));
            const rating = el('td'), tier = el('span', 'sms-rating-tier', u.title);
            tier.style.setProperty('--sms-tier-color', u.color);
            rating.append(el('strong', 'sms-rating-number', number(u.rating)), tier);
            const recent = el('td');
            recent.append(el('span', `sms-rating-delta ${u.recent.delta > 0 ? 'sms-rating-up' : u.recent.delta < 0 ? 'sms-rating-down' : ''}`, signed(u.recent.delta)), el('span', 'sms-secondary', u.recent.text));
            const action = el('td');
            action.append(button('历史记录', () => history(u.uid, historyBase), 'link'));
            row.append(el('td', '', u.rank ?? '—'), account, rating, recent, el('td', '', u.rated ? u.contests : '—'), action);
            rows.append(row);
        }
        if (!data.users.length) {
            const row = el('tr'), cell = el('td', '', '暂无符合条件的账号');
            cell.colSpan = 6;
            row.append(cell);
            rows.append(row);
        }
        $('sms-rating-summary').textContent = `共 ${data.total} 人`;
        $('sms-rating-page').textContent = `第 ${page} / ${Math.max(1, Math.ceil(data.total / 20))} 页`;
        $('sms-rating-prev').disabled = page <= 1;
        $('sms-rating-next').disabled = page * 20 >= data.total;
    }
    function syncFilters() { for (const [target, source] of [['grade', 'grade'], ['school', 'school']]) {
        const select = $(`sms-rating-${target}`), original = $(`sms-${source}`), current = select.value;
        select.replaceChildren(...Array.from(original.options).map(o => o.cloneNode(true)));
        select.value = current;
    } }
    function parseImport(value) {
        const raw = value.trim();
        if (!raw)
            throw new Error('请选择文件或填写导入记录');
        if (raw.startsWith('[') || raw.startsWith('{')) {
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data : data.records;
        }
        const lines = raw.split(/\r?\n/).filter(l => l.trim());
        if (/^uid\s*,/i.test(lines[0]))
            lines.shift();
        return lines.map((line, i) => { const fields = []; let field = '', quoted = false; for (let j = 0; j < line.length; j++) {
            const c = line[j];
            if (c === '"') {
                if (quoted && line[j + 1] === '"') {
                    field += '"';
                    j++;
                }
                else
                    quoted = !quoted;
            }
            else if (c === ',' && !quoted) {
                fields.push(field.trim());
                field = '';
            }
            else
                field += c;
        } fields.push(field.trim()); if (quoted || fields.length !== 3 || fields.some(f => !f))
            throw new Error(`第 ${i + 1} 行需要 UID、Rating、记录时间三列`); return { uid: Number(fields[0]), rating: Number(fields[1]), recordedAt: fields[2] }; });
    }
    async function importDialog() {
        const view = dialog('导入 Rating'), label = el('label', 'sms-rating-import-label', 'UID、Rating、记录时间（北京时间或带时区）'), file = el('input', 'sms-rating-import-file'), input = el('textarea', 'textbox sms-rating-import-text'), preview = el('div', 'sms-rating-import-preview');
        file.type = 'file';
        file.accept = '.csv,.json,text/csv,application/json';
        file.setAttribute('aria-label', '选择 Rating 文件');
        input.setAttribute('aria-label', '导入记录');
        input.placeholder = 'uid,rating,recordedAt\n5,1680,2026-10-01 18:00:00';
        label.append(input);
        view.body.append(file, label, preview);
        let staged;
        const confirm = button('确认导入', async () => { if (!staged)
            return; view.error.textContent = ''; const result = await api(app.dataset.ratingImport, { records: staged.records, revision: staged.revision }); view.d.close(); $('sms-notice').textContent = `已导入 ${result.added} 条，重复 ${result.duplicates} 条`; $('sms-notice').hidden = false; await board(); }, 'primary rounded button');
        confirm.disabled = true;
        confirm.setAttribute('data-disabled', '');
        view.right.prepend(confirm);
        const reset = () => { staged = null; confirm.disabled = true; confirm.setAttribute('data-disabled', ''); preview.replaceChildren(); view.error.textContent = ''; };
        input.addEventListener('input', reset);
        file.addEventListener('change', async () => { reset(); if (file.files[0]) {
            if (file.files[0].size > 1024 * 1024) {
                error(new Error('文件不能超过 1 MB'));
                return;
            }
            input.value = await file.files[0].text();
        } });
        view.left.append(button('预览', async () => { reset(); const records = parseImport(input.value), result = await api(app.dataset.ratingImport, { records, preview: true }); staged = { records, revision: result.revision }; preview.append(el('p', '', `新增 ${result.added} 条 · 重复 ${result.duplicates} 条`)); const t = table(['UID', 'Rating', '记录时间'], 'sms-rating-preview-table'); for (const r of result.records) {
            const row = el('tr');
            row.append(el('td', '', r.uid), el('td', '', number(r.rating)), el('td', '', date(r.at)));
            t.body.append(row);
        } preview.append(t.wrapper); if (result.received > 20)
            preview.append(el('p', 'help-text', `预览前 20 / ${result.received} 条`)); confirm.disabled = result.added === 0; if (!confirm.disabled)
            confirm.removeAttribute('data-disabled'); }));
    }
    async function configDialog() {
        const view = dialog('Rating 比赛设置'), t = table(['比赛 / 子域', '难度', '计入 Rating', '结算', '操作'], 'sms-rating-config-table');
        view.body.append(t.wrapper);
        async function load() { const result = await api(app.dataset.ratingContests); if (!view.d.open)
            return; t.body.replaceChildren(); for (const c of result.contests) {
            const r = el('tr'), name = el('td'), link = el('a', '', c.title);
            link.href = `/d/${encodeURIComponent(c.domainId)}/contest/${c.id}`;
            name.append(link, el('div', 'sms-secondary', c.domainId));
            const diff = el('select', 'select');
            diff.setAttribute('aria-label', `${c.title} 难度`);
            for (const d of result.difficulties) {
                const o = el('option', '', d);
                o.value = d;
                diff.append(o);
            }
            diff.value = c.difficulty;
            const enable = el('input', 'checkbox');
            enable.type = 'checkbox';
            enable.checked = c.enabled;
            enable.setAttribute('aria-label', `${c.title} 计入 Rating`);
            const state = el('td', '', c.error || (!c.enabled ? '未计入' : +new Date(c.endAt) > Date.now() ? '未结束' : c.settled ? `已结算 · ${c.participants} 人` : '待结算'));
            if (c.error)
                state.className = 'sms-rating-error';
            const diffCell = el('td'), enableCell = el('td'), actions = el('td');
            diffCell.append(diff);
            enableCell.append(enable);
            actions.append(button('保存', async () => { view.error.textContent = ''; await api(app.dataset.ratingContests, { domainId: c.domainId, contestId: c.id, difficulty: diff.value, enabled: enable.checked }); await load(); await board(); }));
            r.append(name, diffCell, enableCell, state, actions);
            t.body.append(r);
        } if (!result.contests.length) {
            const r = el('tr'), c = el('td', '', '暂无比赛');
            c.colSpan = 5;
            r.append(c);
            t.body.append(r);
        } }
        view.left.append(button('重新结算', async () => { view.error.textContent = ''; await api(app.dataset.ratingContests.replace(/\/contests$/, '/recalculate'), {}); await load(); await board(); }));
        await load();
    }
    $('sms-rating-stats').addEventListener('click', () => { if (!boardStats)
        return; const view = dialog('Rating 数据概览'), metrics = el('div', 'sms-rating-metrics'); for (const [label, value] of [['已评级', boardStats.rated], ['最高 Rating', number(boardStats.highest)], ['平均 Rating', number(boardStats.average)]]) {
        const block = el('div');
        block.append(el('span', '', label), el('strong', '', value));
        metrics.append(block);
    } view.body.append(metrics); const t = table(['称号', '人数'], 'sms-rating-distribution'); for (const tier of boardStats.tiers) {
        const row = el('tr');
        row.append(el('td', '', tier.title), el('td', '', tier.count));
        t.body.append(row);
    } view.body.append(t.wrapper); });
    $('sms-rating-search').addEventListener('submit', e => { e.preventDefault(); page = 1; board().catch(error); });
    for (const name of ['mode', 'class', 'grade', 'school'])
        $(`sms-rating-${name}`).addEventListener('change', () => { page = 1; board().catch(error); });
    $('sms-rating-prev').addEventListener('click', () => { page--; board().catch(error); });
    $('sms-rating-next').addEventListener('click', () => { page++; board().catch(error); });
    $('sms-rating-import').addEventListener('click', () => importDialog().catch(error));
    $('sms-rating-config').addEventListener('click', () => configDialog().catch(error));
    app.addEventListener('sms:ready', e => { me = e.detail; document.querySelector('.sms-rating-admin').hidden = !me.capabilities['rating.configure']&&!me.capabilities['rating.import'];document.getElementById('sms-rating-config').hidden=!me.capabilities['rating.configure'];document.getElementById('sms-rating-import').hidden=!me.capabilities['rating.import']; });
    app.addEventListener('sms:tab', e => { if (e.detail.tab === 'rating') {
        syncFilters();
        board().catch(error);
    } });
})();

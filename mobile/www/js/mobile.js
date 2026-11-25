'use strict';
/* 手机版 P1 风格页：导入 → 选预设 → 引擎渲染 → 保存/分享。 */
(function () {
    const panel = document.getElementById('panel');
    const canvas = document.getElementById('previewCanvas');
    const stageEmpty = document.getElementById('stageEmpty');
    const state = {
        image: null, images: [], preset: null, template: window.qfsNative.defaultTemplate(),
        tab: 'style', filter: '全部', activeSlot: 0,
        puzzle: { enabled: 1, layout: 'grid4', gap: 6, bgMode: 0, slots: {} }
    };

    function clone(v) { return JSON.parse(JSON.stringify(v)); }
    function stageBar(name, meta) {
        document.getElementById('stageName').textContent = name || '未选择风格';
        document.getElementById('stageMeta').textContent = meta || '—';
    }

    const renderStubs = {
        fitZoom() {}, applyZoomStyle() {}, requestRender() {}, logoMaxSize() { return 120; },
        _gesture: false, _forceFitNext: true, selectedEls: [], displayMax: 1600, uiDprOverride: 1
    };

    function renderPreview() {
        if (state.tab === 'puzzle') {
            if (!state.images.length) return;
            const tpl = state.template;
            tpl.puzzle = state.puzzle;
            const app = Object.assign({
                dom: { canvas }, image: state.image, images: state.images, template: tpl
            }, renderStubs);
            try { window.__renderPuzzle(app, false, true); }
            catch (e) { console.warn('[mobile] puzzle render failed', e); paintFallback(); }
            return;
        }
        if (!state.image) return;
        const app = Object.assign({ dom: { canvas }, image: state.image, template: state.template }, renderStubs);
        try {
            if (typeof window.__render === 'function') window.__render(app, false);
            else paintFallback();
        } catch (e) {
            console.warn('[mobile] render failed', e);
            paintFallback();
        }
        stageEmpty.hidden = true;
    }

    function paintFallback() {
        const g = canvas.getContext('2d');
        canvas.width = 720; canvas.height = 960;
        const grad = g.createLinearGradient(0, 0, canvas.width, canvas.height);
        grad.addColorStop(0, '#202422'); grad.addColorStop(1, '#181B1A');
        g.fillStyle = grad; g.fillRect(0, 0, canvas.width, canvas.height);
        g.strokeStyle = 'rgba(61,217,176,.25)'; g.lineWidth = 2;
        g.strokeRect(40, 40, canvas.width - 80, canvas.height - 80);
        if (state.image && state.image.el) g.drawImage(state.image.el, 60, 60, canvas.width - 120, canvas.height - 120);
    }

    function hint(text) {
        const span = stageEmpty.querySelector('span');
        if (span) span.textContent = text;
    }

    async function importPhotos() {
        const list = await window.qfsNative.pickImages();
        if (!list.length) return;
        state.images = list;
        state.image = list[0];
        state.template = window.qfsNative.defaultTemplate();
        state.preset = null;
        state.puzzle.slots = {};
        list.forEach((im, i) => { state.puzzle.slots[i] = { imageIndex: i }; });
        stageEmpty.querySelector('b').textContent = state.image.name;
        hint(`已导入 ${list.length} 张 · 当前 ${state.image.w}×${state.image.h}`);
        stageBar(state.image.name, `${state.image.w}×${state.image.h}`);
        renderPreview();
        render('style');
    }

    function applyPreset(p) {
        if (!p) return;
        state.preset = p;
        state.template = clone(p);
        state.template.templateName = p._fileName || p.templateName || '';
        state.template.photoFrameStyle = (p.photoFrameStyle || p.templateName || '').toUpperCase();
        stageEmpty.hidden = false;
        const name = p.templateName || p._fileName || '已套用风格';
        stageEmpty.querySelector('b').textContent = name;
        stageBar(name, state.image ? `${state.image.w}×${state.image.h}` : '未导入照片');
        hint('已套用，点「保存 / 分享」导出');
        renderPreview();
        render('style');
    }

    async function exportCurrent() {
        if (!state.image) { hint('请先导入照片'); return; }
        const mime = 'image/jpeg';
        const data = canvas.toDataURL(mime, 0.92);
        const name = (state.image.name || 'photo').replace(/\.[^.]+$/, '') + '_清框影.jpg';
        hint('正在保存…');
        const r = await window.qfsNative.saveImage(data, name);
        hint(r.ok ? (r.mode === 'native' ? '已调起系统分享，可存到相册' : '已下载到本机') : ('保存失败：' + r.error));
    }

    function stylePage() {
        const presets = window.QF_PRESETS || [];
        const items = (window.QF_WALL && window.QF_WALL.items) || [];
        const byName = new Map(items.map((it) => [it.preset, it]));
        const tags = ['全部', ...Array.from(new Set(items.map((it) => it.tag).filter(Boolean)))];
        const all = presets.map((p, i) => ({ p, i, wall: byName.get(p.templateName || p._fileName) }));
        const shown = state.filter === '全部' ? all : all.filter((x) => x.wall && x.wall.tag === state.filter);
        const chips = tags.map((t) => `<button class="chip${state.filter === t ? ' active' : ''}" data-tag="${t}">${t}</button>`).join('');
        const cards = shown.map(({ p, i, wall }) => {
            const name = p.templateName || p._fileName || ('风格 ' + (i + 1));
            const active = state.preset && state.preset._fileName === p._fileName;
            const cover = wall && wall.cover ? wall.cover : '';
            return `<button class="style-card${active ? ' active' : ''}" data-preset="${i}">`
                + `${cover ? `<img src="${cover}" loading="lazy" alt="">` : ''}<span>${name}</span></button>`;
        }).join('');
        return `
            <h2>选一个风格</h2>
            <div class="chips">${chips}</div>
            <div class="style-grid">${cards || '<div class="style-card">这个分类下暂无风格</div>'}</div>
            <p class="panel-note">共 ${presets.length} 款内置风格 · 预览长边 1600px · 照片全程本地处理</p>`;
    }

    const PUZZLE_N = { single: 1, h2: 2, v2: 2, as2: 2, h3: 3, v3: 3, grid4: 4, as4: 4, h4: 4, v4: 4, grid6: 6, grid9: 9 };

    function puzzlePage() {
        const layouts = Object.keys(window.PUZZLE_LAYOUT_TYPES || {});
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        const chips = layouts.map((l) => `<button class="chip${state.puzzle.layout === l ? ' active' : ''}" data-layout="${l}">${l}</button>`).join('');
        const cells = Array.from({ length: n }, (_, i) => {
            const sc = state.puzzle.slots[i] || {};
            const im = state.images[sc.imageIndex];
            const thumb = im && im.el ? `<img src="${im.el.toDataURL ? im.el.toDataURL('image/jpeg', 0.6) : ''}" alt="">` : '';
            return `<button class="slot${state.activeSlot === i ? ' active' : ''}" data-slot="${i}">`
                + `${thumb || '<span>空格</span>'}<small>${i + 1}</small></button>`;
        }).join('');
        const photos = state.images.map((im, i) => {
            const src = im.el && im.el.toDataURL ? im.el.toDataURL('image/jpeg', 0.5) : '';
            return `<button class="photo-thumb" data-photo="${i}"><img src="${src}" alt=""><small>${i + 1}</small></button>`;
        }).join('');
        return `
            <h2>拼图</h2>
            <div class="chips">${chips}</div>
            <div class="puzzle-grid">${cells}</div>
            <div class="puzzle-acts">
                <button id="btnRotateSlot">旋转选中格</button>
                <button id="btnClearSlot">清空选中格</button>
                <button id="btnFillAll">一键铺满</button>
            </div>
            <h2 style="margin-top:14px">照片库</h2>
            <div class="photo-strip">${photos || '<p class="panel-note">先导入照片</p>'}</div>`;
    }

    function setLayout(name) {
        if (!PUZZLE_N[name]) return;
        state.puzzle.layout = name;
        state.puzzle.axisVals = {};
        stageBar('拼图 · ' + name, (PUZZLE_N[name]) + ' 格');
        renderPreview();
        render('puzzle');
    }
    function assignSlot(i, imageIndex) {
        if (!state.images[imageIndex]) return;
        state.puzzle.slots[i] = { imageIndex, rotate: 0 };
        state.activeSlot = i;
        renderPreview();
        render('puzzle');
    }
    function fillAll() {
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        for (let i = 0; i < n; i++) {
            if (!state.puzzle.slots[i] && state.images.length) {
                state.puzzle.slots[i] = { imageIndex: i % state.images.length, rotate: 0 };
            }
        }
        renderPreview();
        render('puzzle');
    }

    const PAGES = {
        style: stylePage,
        puzzle: puzzlePage,
        grade: () => `<h2>调色</h2><p class="panel-note">P4：直方图 + 分组滑块 + 溢出按钮 + 自动调色。</p>`,
        crop: () => `<h2>切图</h2><p class="panel-note">P5：九宫格预览 + 勾选块 + 系统分享。</p>`
    };

    function render(name) {
        state.tab = name || state.tab;
        panel.innerHTML = (PAGES[state.tab] || PAGES.style)();
        document.querySelectorAll('#tabs .tab').forEach((b) => {
            b.classList.toggle('active', b.dataset.tab === state.tab);
        });
        panel.querySelectorAll('[data-preset]').forEach((b) => {
            b.addEventListener('click', () => applyPreset((window.QF_PRESETS || [])[Number(b.dataset.preset)]));
        });
        panel.querySelectorAll('[data-tag]').forEach((b) => {
            b.addEventListener('click', () => { state.filter = b.dataset.tag; render('style'); });
        });
        panel.querySelectorAll('[data-layout]').forEach((b) => {
            b.addEventListener('click', () => setLayout(b.dataset.layout));
        });
        panel.querySelectorAll('[data-slot]').forEach((b) => {
            b.addEventListener('click', () => { state.activeSlot = Number(b.dataset.slot); render('puzzle'); });
        });
        panel.querySelectorAll('[data-photo]').forEach((b) => {
            b.addEventListener('click', () => assignSlot(state.activeSlot, Number(b.dataset.photo)));
        });
        const rot = document.getElementById('btnRotateSlot');
        if (rot) rot.addEventListener('click', () => {
            const sc = state.puzzle.slots[state.activeSlot];
            if (!sc) return;
            sc.rotate = ((Number(sc.rotate) || 0) + 90) % 360;
            renderPreview();
        });
        const clr = document.getElementById('btnClearSlot');
        if (clr) clr.addEventListener('click', () => {
            delete state.puzzle.slots[state.activeSlot];
            renderPreview(); render('puzzle');
        });
        const fill = document.getElementById('btnFillAll');
        if (fill) fill.addEventListener('click', fillAll);

        document.getElementById('btnPick').textContent = state.tab === 'puzzle' ? '＋ 选图' : '＋ 导入';
        document.getElementById('btnExport').textContent = state.tab === 'puzzle' ? '保存拼图' : '保存 / 分享';
        if (state.tab === 'puzzle') {
            stageBar('拼图 · ' + state.puzzle.layout, (PUZZLE_N[state.puzzle.layout] || 1) + ' 格');
            if (state.images.length) renderPreview();
        } else if (state.tab === 'style' && state.preset) {
            stageBar(state.preset.templateName || state.preset._fileName || '已套用风格',
                state.image ? `${state.image.w}×${state.image.h}` : '—');
        }
    }

    // 底部操作条常驻，不随面板滚动
    document.getElementById('btnPick').addEventListener('click', () => {
        if (state.tab === 'puzzle' && state.images.length) {
            const next = (state.activeSlot + 1) % state.images.length;
            assignSlot(state.activeSlot, next);
            return;
        }
        importPhotos();
    });
    document.getElementById('btnExport').addEventListener('click', exportCurrent);

    document.getElementById('tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (tab) render(tab.dataset.tab);
    });
    document.getElementById('btnSettings').addEventListener('click', () => {
        panel.innerHTML = `<h2>设置</h2><p class="panel-note">运行平台：${window.qfsNative.platform()} · 内测版 · 无账号、无上传。</p>`;
    });

    // 有引擎时先用它，否则降级自绘
    if (typeof window.__render !== 'function') paintFallback();
    render('style');
    window.QF_MOBILE_READY = true;
})();

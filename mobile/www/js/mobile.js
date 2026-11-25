'use strict';
/* 手机版 P1 风格页：导入 → 选预设 → 引擎渲染 → 保存/分享。 */
(function () {
    const panel = document.getElementById('panel');
    const canvas = document.getElementById('previewCanvas');
    const stageEmpty = document.getElementById('stageEmpty');
    const A = window.App;
    const state = {
        image: null, images: [], preset: null, template: window.qfsNative.defaultTemplate(),
        tab: 'style', filter: '全部', activeSlot: 0,
        puzzle: { enabled: 1, layout: 'grid4', gap: 6, bgMode: 0, slots: {} },
        crop: { rows: 3, cols: 3, picked: new Set(), blocks: [] }
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
        Object.assign(A, { dom: { canvas }, image: state.image, images: state.images, template: state.template }, renderStubs);
        if (state.tab === 'puzzle') {
            if (!state.images.length) return;
            const tpl = state.template;
            tpl.puzzle = state.puzzle;
            A.template = tpl;
            try { window.__renderPuzzle(A, false, true); }
            catch (e) { console.warn('[mobile] puzzle render failed', e); paintFallback(); }
            return;
        }
        if (!state.image) return;
        try {
            if (typeof window.__render === 'function') window.__render(A, false);
            else paintFallback();
        } catch (e) {
            console.warn('[mobile] render failed', e);
            paintFallback();
        }
        stageEmpty.hidden = true;
        if (state.tab === 'grade' && window.QfsHistogram && state.image) {
            try { window.QfsHistogram.refresh(state.image); } catch (_) { /* 直方图可选 */ }
        }
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
        Object.assign(A, { image: state.image, images: state.images, template: state.template });
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
        A.template = state.template;
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

    const GRADE_UI = [
        ['exp', '曝光', -5, 5, 0.01], ['con', '对比度', -100, 100, 1],
        ['hi', '高光', -100, 100, 1], ['sh', '阴影', -100, 100, 1],
        ['white', '白色', -100, 100, 1], ['black', '黑色', -100, 100, 1],
        ['gam', '中间调', -100, 100, 1], ['temp', '色温', -100, 100, 1],
        ['tint', '色调', -100, 100, 1], ['vib', '自然饱和度', -100, 100, 1], ['sat', '饱和度', -100, 100, 1]
    ];

    function gradePage() {
        const g = (state.image && state.image.grade) || {};
        const rows = GRADE_UI.map(([k, label, min, max, step]) => {
            const v = Number(g[k]) || 0;
            return `<div class="grade-row"><label>${label}</label>`
                + `<input type="range" data-grade="${k}" min="${min}" max="${max}" step="${step}" value="${v}">`
                + `<output data-out="${k}">${v}</output></div>`;
        }).join('');
        return `<h2>调色</h2>
            <div class="histo-card"><canvas id="gradeHisto" width="600" height="180"></canvas></div>
            <div class="grade-sliders">${rows}</div>
            <div class="puzzle-acts"><button id="btnGradeReset">重置调色</button></div>
            <p class="panel-note">滑块来自桌面调色引擎；直方图实时读取调色后像素</p>`;
    }

    async function exportGrid() {
        const blocks = state.crop.blocks || [];
        if (!blocks.length) { hint('先导入照片'); return; }
        const picks = Array.from(state.crop.picked).sort((a, b) => a - b);
        if (!picks.length) { hint('至少勾选一块'); return; }
        hint(`正在导出 ${picks.length} 块…`);
        let ok = 0;
        for (const i of picks) {
            const data = blocks[i].toDataURL('image/jpeg', 0.92);
            const name = `${state.image.name || 'photo'}_九宫格_${i + 1}.jpg`.replace(/\.[^.]+\./, '.');
            const r = await window.qfsNative.saveImage(data, name);
            if (r.ok) ok++;
        }
        hint(`已导出 ${ok}/${picks.length} 块`);
    }

    function cropPage() {
        if (!state.image) return `<h2>切图</h2><p class="panel-note">请先导入照片</p>`;
        const { rows, cols } = state.crop;
        const blocks = (typeof A._sliceGrid === 'function')
            ? A._sliceGrid(state.image.el, rows, cols, 0, 0, 0) : [];
        state.crop.blocks = blocks;
        if (!state.crop.picked.size) blocks.forEach((_, i) => state.crop.picked.add(i));
        const presets = [[3, 3], [2, 2], [4, 4], [3, 4]].map(([r, c]) =>
            `<button class="chip${rows === r && cols === c ? ' active' : ''}" data-grid="${r}x${c}">${r}×${c}</button>`).join('');
        const cells = blocks.map((cv, i) => {
            const t = document.createElement('canvas'); t.width = 96; t.height = 96;
            t.getContext('2d').drawImage(cv, 0, 0, 96, 96);
            const checked = state.crop.picked.has(i) ? ' checked' : '';
            return `<label class="crop-cell"><input type="checkbox" data-block="${i}"${checked}>`
                + `<img src="${t.toDataURL('image/jpeg', 0.5)}" alt=""><small>${i + 1}</small></label>`;
        }).join('');
        return `<h2>切图</h2>
            <div class="chips">${presets}</div>
            <div class="crop-grid">${cells}</div>
            <p class="panel-note">已勾选 ${state.crop.picked.size}/${blocks.length} 块 · 点底部「导出选中块」逐块保存/分享</p>`;
    }

    const PAGES = {
        style: stylePage,
        puzzle: puzzlePage,
        grade: gradePage,
        crop: cropPage
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

        panel.querySelectorAll('[data-grade]').forEach((b) => {
            b.addEventListener('input', () => {
                const key = b.dataset.grade, v = Number(b.value);
                if (typeof A.setGrade === 'function') A.setGrade({ [key]: v });
                else if (state.image) {
                    state.image.grade = state.image.grade || {};
                    state.image.grade[key] = v;
                }
                const out = panel.querySelector(`[data-out="${key}"]`);
                if (out) out.textContent = String(v);
                renderPreview();
            });
        });
        const greset = document.getElementById('btnGradeReset');
        if (greset) greset.addEventListener('click', () => {
            if (typeof A.resetGrade === 'function') A.resetGrade();
            renderPreview(); render('grade');
        });
        if (state.tab === 'grade' && window.QfsHistogram && state.image) {
            setTimeout(() => { try { window.QfsHistogram.refresh(state.image); } catch (_) {} }, 30);
        }
        panel.querySelectorAll('[data-grid]').forEach((b) => {
            b.addEventListener('click', () => {
                const [r, c] = b.dataset.grid.split('x').map(Number);
                state.crop.rows = r; state.crop.cols = c;
                state.crop.picked = new Set();
                document.getElementById('inpGridCols').value = String(c);
                document.getElementById('inpGridRows').value = String(r);
                render('crop');
            });
        });
        panel.querySelectorAll('[data-block]').forEach((b) => {
            b.addEventListener('change', () => {
                const i = Number(b.dataset.block);
                if (b.checked) state.crop.picked.add(i); else state.crop.picked.delete(i);
                const note = panel.querySelector('.panel-note');
                if (note) note.textContent = `已勾选 ${state.crop.picked.size}/${state.crop.blocks.length} 块 · 点底部「导出选中块」逐块保存/分享`;
            });
        });

        document.getElementById('btnPick').textContent = state.tab === 'puzzle' ? '＋ 选图' : '＋ 导入';
        document.getElementById('btnExport').textContent = state.tab === 'crop' ? '导出选中块'
            : (state.tab === 'puzzle' ? '保存拼图' : '保存 / 分享');
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
    document.getElementById('btnExport').addEventListener('click', () => {
        if (state.tab === 'crop') exportGrid();
        else exportCurrent();
    });

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

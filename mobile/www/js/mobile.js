'use strict';
/* 手机版：导入 → 选风格 → 引擎渲染 → 保存/分享；拼图 / 调色 / 切图。 */
(function () {
    const panel = document.getElementById('panel');
    const canvas = document.getElementById('previewCanvas');
    const stageEmpty = document.getElementById('stageEmpty');
    const toast = document.getElementById('toast');
    const A = window.App;
    const state = {
        image: null, images: [], preset: null, template: window.qfsNative.defaultTemplate(),
        tab: 'style', filter: '全部', activeSlot: 0, importing: false, exporting: false,
        puzzle: { enabled: 1, layout: 'grid4', gap: 6, bgMode: 0, slots: {} },
        crop: { rows: 3, cols: 3, picked: new Set(), blocks: [], touched: false }
    };

    let toastTimer = 0;
    function hint(text, ms) {
        if (!text) return;
        if (!toast) {
            const span = stageEmpty && stageEmpty.querySelector('span');
            if (span) span.textContent = text;
            return;
        }
        toast.textContent = text;
        toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.hidden = true; }, ms || 2800);
    }
    // 原生适配层（HEIC 兜底解码）在 mobile.js 之前加载，通过它复用同一个 toast
    window.qfHint = hint;

    function clone(v) { return JSON.parse(JSON.stringify(v)); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function dimsOf(im) { return im ? `${im.w}×${im.h}` : '未导入照片'; }
    // 缩略图按图缓存：拼图页/当前照片条每次重绘都重新 toDataURL 一张 1600px
    // 的图，会明显卡顿；缓存后只在首次生成。
    function thumbOf(im, q) {
        if (!im || !im.el) return '';
        if (im._thumb) return im._thumb;
        try {
            const iw = im.el.naturalWidth || im.el.width || 0;
            const ih = im.el.naturalHeight || im.el.height || 0;
            if (!iw || !ih) return '';
            const k = Math.min(1, 160 / Math.max(iw, ih));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(iw * k));
            c.height = Math.max(1, Math.round(ih * k));
            c.getContext('2d').drawImage(im.el, 0, 0, c.width, c.height);
            im._thumb = c.toDataURL('image/jpeg', q || 0.6);
            return im._thumb;
        } catch (_) { return ''; }
    }
    // 风格/调色/切图页的当前照片条：导入是追加到照片库的，没有这条的话
    // 第二张之后的照片只能在拼图页看到，主流程里永远切不回去。
    function currentStrip() {
        if (state.images.length < 2) return '';
        const items = state.images.map((im, i) => {
            const active = im === state.image ? ' active' : '';
            return `<button class="photo-thumb${active}" data-current="${i}" title="${esc(im.name)}">`
                + `<img src="${thumbOf(im, 0.5)}" alt=""><small>${i + 1}</small></button>`;
        }).join('');
        return `<div class="photo-strip current-strip">${items}</div>`;
    }
    function presetLabel() {
        return (state.preset && (state.preset.templateName || state.preset._fileName)) || '已套用风格';
    }
    function stageBar(name, meta) {
        document.getElementById('stageName').textContent = name || '未选择风格';
        document.getElementById('stageMeta').textContent = meta || '—';
    }
    function updateEmpty() {
        const has = !!state.image;
        stageEmpty.hidden = has;
        if (!has) {
            const b = stageEmpty.querySelector('b');
            const s = stageEmpty.querySelector('span');
            if (b) b.textContent = '先导入一张照片';
            if (s) s.textContent = '点下面的「风格」页选图';
        }
    }

    const renderStubs = {
        fitZoom() {}, applyZoomStyle() {}, requestRender() {}, logoMaxSize() { return 120; },
        _gesture: false, _forceFitNext: true, selectedEls: [], displayMax: 1600, uiDprOverride: 1
    };

    // 调色滑块 input 事件一秒能来几十次，每次都跑一遍 1600px 引擎渲染会直接把
    // 手机拖到个位数帧率。合并到下一帧，一帧最多渲染一次。
    let previewRaf = 0;
    function renderPreviewSoon() {
        if (previewRaf) return;
        previewRaf = requestAnimationFrame(() => {
            previewRaf = 0;
            renderPreview();
        });
    }

    // 把当前页签的内容画到预览画布。puzzle 走独立管线；其余页签都画「照片 + 风格 + 调色」。
    // opts 可临时覆盖 displayMax/exportScale 等渲染档位（导出原尺寸时用），
    // 不传则回到 1600px 预览档，并清掉上一次导出残留的 exportScale。
    function renderPreview(skipHistogram, opts) {
        Object.assign(A, { dom: { canvas }, image: state.image, images: state.images, template: state.template }, renderStubs, opts || {});
        if (!opts || !('exportScale' in opts)) delete A.exportScale;
        if (state.tab === 'puzzle') {
            if (!state.images.length) { updateEmpty(); return; }
            state.template.puzzle = state.puzzle;
            A.template = state.template;
            try { window.__renderPuzzle(A, false, true); }
            catch (e) { console.warn('[mobile] puzzle render failed', e); paintFallback(); }
            updateEmpty();
            return;
        }
        if (!state.image) { updateEmpty(); return; }
        try {
            if (typeof window.__render === 'function') window.__render(A, false);
            else paintFallback();
        } catch (e) {
            console.warn('[mobile] render failed', e);
            paintFallback();
        }
        updateEmpty();
        if (!skipHistogram && state.tab === 'grade' && window.QfsHistogram && state.image) {
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

    async function importPhotos() {
        // 连点两次「导入」会同时挂两个 file picker，第一个 Promise 永远不 resolve。
        if (state.exporting || state.importing) return;
        state.importing = true;
        try {
            let list = [];
            try { list = await window.qfsNative.pickImages(); }
            catch (e) { hint('选图失败：' + ((e && e.message) || e), 4200); return; }
            const errs = (typeof window.qfsNative.getPickErrors === 'function')
                ? window.qfsNative.getPickErrors() : [];
            if (!list.length) {
                if (errs.length) hint(`导入失败：${errs[0].name}（${errs[0].error}）`, 4800);
                return;
            }
            const firstImport = state.images.length === 0;
            // 追加而不是替换：拼图照片库要能继续攒图；换照片也不该把已选风格一起清掉。
            state.images = state.images.concat(list);
            state.image = list[0];
            if (firstImport) {
                state.puzzle.slots = {};
                state.images.forEach((im, i) => { state.puzzle.slots[i] = { imageIndex: i }; });
                state.activeSlot = 0;
            } else {
                clampActiveSlot();
            }
            state.crop.picked = new Set();
            state.crop.blocks = [];
            state.crop.touched = false;
            Object.assign(A, { image: state.image, images: state.images, template: state.template });
            const b = stageEmpty.querySelector('b');
            if (b) b.textContent = state.image.name;
            if (errs.length) hint(`已导入 ${list.length} 张，${errs.length} 张失败：${errs[0].name}`, 4800);
            else hint(`已导入 ${list.length} 张 · 照片库共 ${state.images.length} 张`);
            updateEmpty();
            render(state.tab);
        } finally {
            state.importing = false;
        }
    }

    function selectCurrent(i) {
        const im = state.images[i];
        if (!im || im === state.image) return;
        state.image = im;
        state.crop.picked = new Set();
        state.crop.blocks = [];
        state.crop.touched = false;
        Object.assign(A, { image: im, images: state.images, template: state.template });
        render(state.tab);
    }

    function applyPreset(p) {
        if (!p) return;
        state.preset = p;
        state.template = clone(p);
        state.template.templateName = p.templateName || p._fileName || '';
        // 不要给没有 photoFrameStyle 的预设补一个风格名：引擎会把未知名字当成
        // 相框风格去查表，结果 23 个「默认图层」预设全变成灰色占位图。
        A.template = state.template;
        const name = p.templateName || p._fileName || '已套用风格';
        if (state.image) {
            const b = stageEmpty.querySelector('b');
            if (b) b.textContent = name;
            hint(`已套用「${name}」`);
            renderPreview(true);
            stageBar(name, dimsOf(state.image));
        } else {
            hint(`已套用「${name}」，导入照片后生效`);
            stageBar(name, '未导入照片');
        }
        updateEmpty();
        // 只改高亮，不重建整面风格墙：重建会把滚动位置弹回顶部，
        // 用户挑到列表下半部分时每点一次就跳一次。
        panel.querySelectorAll('[data-preset]').forEach((b) => {
            const q = (window.QF_PRESETS || [])[Number(b.dataset.preset)];
            b.classList.toggle('active', q === p);
        });
    }

    // 临时把当前照片换成全尺寸源，渲染导出帧后立即还原。
    // 预览/调色缓存都按 im.el 的尺寸烘焙，换源后必须 invalidateGrade + ensureFullGrade，
    // 否则导出的仍是 1600px 代理放大的糊图。
    async function withFullImage(im, fn) {
        let full = null;
        let prevEl = null, prevW = 0, prevH = 0;
        try {
            if (!im || typeof window.qfFullSource !== 'function') {
                return await fn(1600, false, false);
            }
            hint('正在准备原尺寸…', 12000);
            full = await window.qfFullSource(im);
            if (!full || !full.canvas) return await fn(1600, false, false);
            if (full.changed) {
                prevEl = im.el; prevW = im.w; prevH = im.h;
                im.el = full.canvas;
                im.w = full.canvas.naturalWidth || full.canvas.width;
                im.h = full.canvas.naturalHeight || full.canvas.height;
                if (typeof A.invalidateGrade === 'function') A.invalidateGrade(im);
                if (typeof window.ensureFullGrade === 'function') window.ensureFullGrade(im);
            }
            const target = Math.max(Number(im.w) || 0, Number(im.h) || 0) || 1600;
            return await fn(target, !!full.fallback, !!full.capped);
        } finally {
            if (prevEl) {
                im.el = prevEl; im.w = prevW; im.h = prevH;
                if (typeof A.invalidateGrade === 'function') A.invalidateGrade(im);
            }
            if (full && full.release) full.release();
        }
    }

    async function exportCurrent() {
        if (state.exporting) return;
        const isPuzzle = state.tab === 'puzzle';
        if (isPuzzle) {
            if (!state.images.length) { hint('先导入照片'); return; }
        } else if (!state.image) { hint('先导入照片'); return; }
        state.exporting = true;
        let data = '';
        let note = '';
        try {
            if (isPuzzle) {
                hint('正在渲染拼图…', 12000);
                // 拼图版式坐标固定在 1000 单位，只有 exportScale 能把成品真正放大到 4000px
                renderPreview(true, { displayMax: 4000, uiDprOverride: 1, exportScale: 4000 });
                try { data = canvas.toDataURL('image/jpeg', 0.92); }
                catch (e) { hint('导出失败：' + ((e && e.message) || e), 4200); return; }
            } else {
                // 先渲染全尺寸帧，再释放原图、编码。编码期间不再占着两张 6000px 画布。
                await withFullImage(state.image, async (targetPx, fallback, capped) => {
                    if (fallback) note = ' · 全尺寸解码失败，已用预览尺寸';
                    else if (capped) note = ' · 已按 6000px 上限导出';
                    renderPreview(true, { displayMax: targetPx, uiDprOverride: 1 });
                });
                try { data = canvas.toDataURL('image/jpeg', 0.92); }
                catch (e) { hint('导出失败：' + ((e && e.message) || e), 4200); return; }
            }
            if (!data || data.length < 64) { hint('导出失败：画布为空'); return; }
            const base = String((state.image && state.image.name) || 'photo')
                .replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
            const suffix = isPuzzle ? '_拼图' : '_清框影';
            hint('正在保存…', 12000);
            const r = await window.qfsNative.saveImage(data, `${base}${suffix}.jpg`);
            if (r && r.canceled) hint('已取消保存');
            else if (r && r.ok) hint((r.mode === 'native' ? '已调起系统分享，可存到相册' : '已下载到本机') + note);
            else hint('保存失败：' + ((r && r.error) || '未知错误'), 4800);
        } catch (e) {
            hint('保存失败：' + ((e && e.message) || e), 4800);
        } finally {
            delete A.exportScale;
            // 导出帧可能是 4000px 拼图/原尺寸，保存结束后切回 1600px 预览，别让大画布常驻
            try { renderPreview(true); } catch (_) {}
            state.exporting = false;
        }
    }

    // 从成品画布切一块（与 app-export.js 的 _sliceGrid 同口径：行优先、无留白）。
    // 逐块生成而不是一次切 9 块：6000px 画布上 9 块加起来又是一整张全尺寸图。
    function sliceOne(src, rows, cols, index) {
        const rn = Math.max(1, Math.min(12, Math.round(rows) || 1));
        const cn = Math.max(1, Math.min(12, Math.round(cols) || 1));
        const r = Math.floor(index / cn), c = index % cn;
        const x = Math.round(c * src.width / cn), x2 = Math.round((c + 1) * src.width / cn);
        const y = Math.round(r * src.height / rn), y2 = Math.round((r + 1) * src.height / rn);
        const w = Math.max(1, x2 - x), h = Math.max(1, y2 - y);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
        return cv;
    }

    function stylePage() {
        const presets = window.QF_PRESETS || [];
        const items = (window.QF_WALL && window.QF_WALL.items) || [];
        const byName = new Map(items.map((it) => [it.preset, it]));
        const tags = ['全部', ...Array.from(new Set(items.map((it) => it.tag).filter(Boolean)))];
        const all = presets.map((p, i) => ({ p, i, wall: byName.get(p.templateName || p._fileName) }));
        const shown = state.filter === '全部' ? all : all.filter((x) => x.wall && x.wall.tag === state.filter);
        const chips = tags.map((t) => `<button class="chip${state.filter === t ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
        const cards = shown.map(({ p, i, wall }) => {
            const name = p.templateName || p._fileName || ('风格 ' + (i + 1));
            const active = state.preset && state.preset._fileName === p._fileName;
            const cover = wall && wall.cover ? wall.cover : '';
            return `<button class="style-card${active ? ' active' : ''}" data-preset="${i}">`
                + `${cover ? `<img src="${esc(cover)}" loading="lazy" alt="">` : ''}<span>${esc(name)}</span></button>`;
        }).join('');
        return `
            <h2>选一个风格</h2>
            ${currentStrip()}
            <div class="chips">${chips}</div>
            <div class="style-grid">${cards || '<div class="style-card">这个分类下暂无风格</div>'}</div>
            <p class="panel-note">共 ${presets.length} 款内置风格 · 预览 1600px · 导出按原图（最长 6000px）· 照片全程本地处理</p>`;
    }

    const PUZZLE_N = { single: 1, h2: 2, v2: 2, as2: 2, h3: 3, v3: 3, grid4: 4, as4: 4, h4: 4, v4: 4, grid6: 6, grid9: 9 };
    const PUZZLE_LABEL = {
        single: '单张', h2: '左右两格', v2: '上下两格', as2: '一大一小',
        h3: '横三格', v3: '竖三格', grid4: '四宫格', as4: '一大多小',
        h4: '横四格', v4: '竖四格', grid6: '六宫格', grid9: '九宫格'
    };
    function puzzleLabel(layout) { return PUZZLE_LABEL[layout] || layout; }
    function clampActiveSlot() {
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        const i = Number(state.activeSlot) || 0;
        state.activeSlot = Math.min(Math.max(0, i), n - 1);
    }

    function puzzlePage() {
        const layouts = Object.keys(window.PUZZLE_LAYOUT_TYPES || {});
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        const chips = layouts.map((l) => `<button class="chip${state.puzzle.layout === l ? ' active' : ''}" data-layout="${l}">${puzzleLabel(l)}</button>`).join('');
        const cells = Array.from({ length: n }, (_, i) => {
            const sc = state.puzzle.slots[i] || {};
            const im = state.images[sc.imageIndex];
            const t = thumbOf(im, 0.6);
            const thumb = t ? `<img src="${t}" alt="">` : '';
            return `<button class="slot${state.activeSlot === i ? ' active' : ''}" data-slot="${i}">`
                + `${thumb || '<span>空格</span>'}<small>${i + 1}</small></button>`;
        }).join('');
        const photos = state.images.map((im, i) => {
            return `<button class="photo-thumb" data-photo="${i}"><img src="${thumbOf(im, 0.5)}" alt=""><small>${i + 1}</small></button>`;
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
        clampActiveSlot();
        render('puzzle');
    }
    function assignSlot(i, imageIndex) {
        if (!state.images[imageIndex]) return;
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        if (i < 0 || i >= n) return;
        state.puzzle.slots[i] = { imageIndex, rotate: 0 };
        state.activeSlot = i;
        render('puzzle');
    }
    function fillAll() {
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        if (!state.images.length) { hint('先导入照片'); return; }
        for (let i = 0; i < n; i++) {
            if (!state.puzzle.slots[i]) {
                state.puzzle.slots[i] = { imageIndex: i % state.images.length, rotate: 0 };
            }
        }
        clampActiveSlot();
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
        if (!state.image) return `<h2>调色</h2><p class="panel-note">请先导入照片</p>`;
        const g = state.image.grade || {};
        const rows = GRADE_UI.map(([k, label, min, max, step]) => {
            const v = Number(g[k]) || 0;
            return `<div class="grade-row"><label>${label}</label>`
                + `<input type="range" data-grade="${k}" min="${min}" max="${max}" step="${step}" value="${v}">`
                + `<output data-out="${k}">${v}</output></div>`;
        }).join('');
        return `<h2>调色</h2>
            ${currentStrip()}
            <div class="histo-card"><canvas id="gradeHisto" width="600" height="180"></canvas></div>
            <div class="grade-sliders">${rows}</div>
            <div class="puzzle-acts"><button id="btnGradeReset">重置调色</button></div>
            <p class="panel-note">滑块来自桌面调色引擎；直方图实时读取调色后像素</p>`;
    }

    async function exportGrid() {
        if (state.exporting) return;
        if (!state.image) { hint('先导入照片'); return; }
        const rows = state.crop.rows, cols = state.crop.cols;
        const total = rows * cols;
        const picks = Array.from(state.crop.picked)
            .filter((i) => i >= 0 && i < total)
            .sort((a, b) => a - b);
        if (!picks.length) { hint('至少勾选一块'); return; }
        const base = String(state.image.name || 'photo')
            .replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
        const tag = `${rows}x${cols}`;
        state.exporting = true;
        let ok = 0, fail = 0, canceled = false;
        let note = '';
        try {
            // 切图必须从「加风格/调色后的全尺寸成品」上切；预览画布只有 1600px，
            // 9 块放大到手机相册尺寸会明显糊。渲染完立即还原代理，逐块编码。
            await withFullImage(state.image, async (targetPx, fallback, capped) => {
                if (fallback) note = ' · 全尺寸解码失败，已用预览尺寸';
                else if (capped) note = ' · 已按 6000px 上限导出';
                renderPreview(true, { displayMax: targetPx, uiDprOverride: 1 });
            });
            for (let n = 0; n < picks.length; n++) {
                const i = picks[n];
                hint(`正在导出 ${n + 1}/${picks.length}…`, 12000);
                let block = null;
                try {
                    block = sliceOne(canvas, rows, cols, i);
                    const data = block.toDataURL('image/jpeg', 0.92);
                    const r = await window.qfsNative.saveImage(data, `${base}_${tag}_${i + 1}.jpg`);
                    if (r && r.canceled) { canceled = true; break; }
                    if (r && r.ok) ok++; else fail++;
                } catch (_) { fail++; }
                finally {
                    if (block) { block.width = 0; block.height = 0; }
                }
            }
            hint((canceled ? `已取消（已导出 ${ok} 块）`
                : `已导出 ${ok}/${picks.length} 块${fail ? `，${fail} 块失败` : ''}`) + note,
            canceled || fail ? 4200 : 2800);
        } finally {
            delete A.exportScale;
            try { renderPreview(true); } catch (_) {}
            state.exporting = false;
        }
    }

    function cropPage() {
        if (!state.image) {
            state.crop.blocks = [];
            return `<h2>切图</h2><p class="panel-note">请先导入照片</p>`;
        }
        const { rows, cols } = state.crop;
        // 切的是当前成品画布（含风格/调色），不是未处理的原图。
        const src = (canvas && canvas.width) ? canvas : state.image.el;
        const blocks = (typeof A._sliceGrid === 'function' && src)
            ? A._sliceGrid(src, rows, cols, 0, 0, 0) : [];
        state.crop.blocks = blocks;
        if (!state.crop.touched) {
            state.crop.picked = new Set(blocks.map((_, i) => i));
        }
        const valid = new Set(blocks.map((_, i) => i));
        state.crop.picked = new Set(Array.from(state.crop.picked).filter((i) => valid.has(i)));
        const presets = [[3, 3], [2, 2], [4, 4], [3, 4]].map(([r, c]) =>
            `<button class="chip${rows === r && cols === c ? ' active' : ''}" data-grid="${r}x${c}">${r}×${c}</button>`).join('');
        const cells = blocks.map((cv, i) => {
            const t = document.createElement('canvas'); t.width = 96; t.height = 96;
            const g = t.getContext('2d');
            const s = Math.min(cv.width, cv.height);
            if (s > 0) g.drawImage(cv, (cv.width - s) / 2, (cv.height - s) / 2, s, s, 0, 0, 96, 96);
            const checked = state.crop.picked.has(i) ? ' checked' : '';
            return `<label class="crop-cell"><input type="checkbox" data-block="${i}"${checked}>`
                + `<img src="${t.toDataURL('image/jpeg', 0.5)}" alt=""><small>${i + 1}</small></label>`;
        }).join('');
        return `<h2>切图</h2>
            ${currentStrip()}
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
        if (state.tab === 'puzzle') clampActiveSlot();
        // 切页签先把画布画回当前照片，否则从拼图切回风格/调色时会继续显示拼图，
        // 此时点「保存」导出的是上一页的拼图。
        if (state.tab !== 'puzzle' && state.image) renderPreview(true);
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
        panel.querySelectorAll('[data-current]').forEach((b) => {
            b.addEventListener('click', () => selectCurrent(Number(b.dataset.current)));
        });
        const rot = document.getElementById('btnRotateSlot');
        if (rot) rot.addEventListener('click', () => {
            const sc = state.puzzle.slots[state.activeSlot];
            if (!sc) { hint('先选一个已放照片的格子'); return; }
            // 引擎里 rotate 是「90° 的倍数」(0..3)，不是角度值。
            sc.rotate = ((Number(sc.rotate) || 0) + 1) % 4;
            renderPreview();
            hint(`第 ${state.activeSlot + 1} 格旋转 ${sc.rotate * 90}°`);
        });
        const clr = document.getElementById('btnClearSlot');
        if (clr) clr.addEventListener('click', () => {
            if (!state.puzzle.slots[state.activeSlot]) { hint('这个格子本来就是空的'); return; }
            delete state.puzzle.slots[state.activeSlot];
            render('puzzle');
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
                renderPreviewSoon();
            });
        });
        const greset = document.getElementById('btnGradeReset');
        if (greset) greset.addEventListener('click', () => {
            if (typeof A.resetGrade === 'function') A.resetGrade();
            hint('已重置调色');
            render('grade');
        });
        if (state.tab === 'grade' && window.QfsHistogram && state.image) {
            setTimeout(() => { try { window.QfsHistogram.refresh(state.image); } catch (_) {} }, 30);
        }
        panel.querySelectorAll('[data-grid]').forEach((b) => {
            b.addEventListener('click', () => {
                const [r, c] = b.dataset.grid.split('x').map(Number);
                state.crop.rows = r; state.crop.cols = c;
                state.crop.picked = new Set();
                state.crop.blocks = [];
                state.crop.touched = false;
                const ic = document.getElementById('inpGridCols');
                const ir = document.getElementById('inpGridRows');
                if (ic) ic.value = String(c);
                if (ir) ir.value = String(r);
                render('crop');
            });
        });
        panel.querySelectorAll('[data-block]').forEach((b) => {
            b.addEventListener('change', () => {
                const i = Number(b.dataset.block);
                state.crop.touched = true;
                if (b.checked) state.crop.picked.add(i); else state.crop.picked.delete(i);
                const note = panel.querySelector('.panel-note');
                if (note) note.textContent = `已勾选 ${state.crop.picked.size}/${state.crop.blocks.length} 块 · 点底部「导出选中块」逐块保存/分享`;
                stageBar(`切图 · ${state.crop.rows}×${state.crop.cols}`,
                    `${state.crop.picked.size}/${state.crop.blocks.length} 块`);
            });
        });

        document.getElementById('btnPick').textContent = state.tab === 'puzzle' ? '＋ 加照片' : '＋ 导入';
        document.getElementById('btnExport').textContent = state.tab === 'crop' ? '导出选中块'
            : (state.tab === 'puzzle' ? '保存拼图' : '保存 / 分享');
        updateEmpty();
        if (state.tab === 'puzzle') {
            stageBar('拼图 · ' + puzzleLabel(state.puzzle.layout),
                state.images.length ? `${PUZZLE_N[state.puzzle.layout] || 1} 格 · ${state.images.length} 张照片` : '未导入照片');
            if (state.images.length) renderPreview();
        } else if (state.tab === 'crop') {
            stageBar(`切图 · ${state.crop.rows}×${state.crop.cols}`,
                state.image ? `${state.crop.picked.size}/${state.crop.blocks.length} 块` : '未导入照片');
        } else if (state.tab === 'grade') {
            stageBar(state.image ? (state.preset ? presetLabel() : state.image.name) : '调色',
                state.image ? dimsOf(state.image) : '未导入照片');
        } else {
            stageBar(state.image ? (state.preset ? presetLabel() : state.image.name)
                : (state.preset ? presetLabel() : '未选择风格'),
            state.image ? dimsOf(state.image) : '未导入照片');
        }
    }

    // 底部操作条常驻，不随面板滚动
    document.getElementById('btnPick').addEventListener('click', () => {
        if (state.exporting) return;
        importPhotos();
    });
    document.getElementById('btnExport').addEventListener('click', () => {
        if (state.exporting) return;
        if (state.tab === 'crop') exportGrid();
        else exportCurrent();
    });

    document.getElementById('tabs').addEventListener('click', (e) => {
        // 导出/切图途中切页签会把画布重画回预览，正在编码的那一帧就废了
        if (state.exporting) return;
        const tab = e.target.closest('.tab');
        if (tab) render(tab.dataset.tab);
    });
    document.getElementById('btnSettings').addEventListener('click', () => {
        panel.innerHTML = `<h2>设置</h2><p class="panel-note">运行平台：${window.qfsNative.platform()} · 内测版 · 无账号、无上传。</p>`;
    });

    // 有引擎时先用它，否则降级自绘
    if (typeof window.__render !== 'function') paintFallback();
    updateEmpty();
    render('style');
    window.QF_MOBILE_READY = true;
})();

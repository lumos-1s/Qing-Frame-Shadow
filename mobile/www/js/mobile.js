'use strict';
/* 手机版 P1 风格页：导入 → 选预设 → 引擎渲染 → 保存/分享。 */
(function () {
    const panel = document.getElementById('panel');
    const canvas = document.getElementById('previewCanvas');
    const stageEmpty = document.getElementById('stageEmpty');
    const state = { image: null, preset: null, template: window.qfsNative.defaultTemplate(), tab: 'style' };

    function clone(v) { return JSON.parse(JSON.stringify(v)); }

    // 用桌面引擎把当前照片 + 当前模板画到预览画布
    function renderPreview() {
        if (!state.image) return;
        const app = {
            dom: { canvas },
            image: state.image,
            template: state.template,
            selectedEls: [],
            displayMax: 1600,
            uiDprOverride: 1,
            fitZoom() {},
            applyZoomStyle() {},
            requestRender() {},
            logoMaxSize() { return 120; },
            _gesture: false,
            _forceFitNext: true
        };
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
        state.image = list[0];
        state.template = window.qfsNative.defaultTemplate();
        state.preset = null;
        stageEmpty.querySelector('b').textContent = state.image.name;
        hint(`已导入 ${list.length} 张 · 当前 ${state.image.w}×${state.image.h}`);
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
        stageEmpty.querySelector('b').textContent = p.templateName || p._fileName || '已套用风格';
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
        const cards = presets.slice(0, 24).map((p, i) => {
            const name = p.templateName || p._fileName || ('风格 ' + (i + 1));
            const active = state.preset && state.preset._fileName === p._fileName;
            return `<button class="style-card${active ? ' active' : ''}" data-preset="${i}">${name}</button>`;
        }).join('');
        return `
            <h2>选一个风格</h2>
            <div class="style-grid">${cards || '<div class="style-card">内置预设未加载</div>'}</div>
            <button class="primary-btn" id="btnPick">${state.image ? '换一张照片' : '导入照片'}</button>
            <button class="primary-btn ghost" id="btnExport">保存 / 分享</button>
            <p class="panel-note">共 ${presets.length} 款内置风格 · 当前预览长边 1600px · 照片全程本地处理</p>`;
    }

    const PAGES = {
        style: stylePage,
        puzzle: () => `<h2>拼图</h2><p class="panel-note">P3：布局横滑 + 底部相册抽屉 + 格子动作条。</p>`,
        grade: () => `<h2>调色</h2><p class="panel-note">P4：直方图 + 分组滑块 + 溢出按钮 + 自动调色。</p>`,
        crop: () => `<h2>切图</h2><p class="panel-note">P5：九宫格预览 + 勾选块 + 系统分享。</p>`
    };

    function render(name) {
        state.tab = name || state.tab;
        panel.innerHTML = (PAGES[state.tab] || PAGES.style)();
        document.querySelectorAll('#tabs .tab').forEach((b) => {
            b.classList.toggle('active', b.dataset.tab === state.tab);
        });
        const pick = document.getElementById('btnPick');
        if (pick) pick.addEventListener('click', importPhotos);
        const exp = document.getElementById('btnExport');
        if (exp) exp.addEventListener('click', exportCurrent);
        panel.querySelectorAll('[data-preset]').forEach((b) => {
            b.addEventListener('click', () => applyPreset((window.QF_PRESETS || [])[Number(b.dataset.preset)]));
        });
    }

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

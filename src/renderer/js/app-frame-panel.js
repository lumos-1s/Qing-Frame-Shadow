'use strict';
/* AI 边框协作面板：管理 userData/frames/*.json（agent 与用户共享的作品目录）。
 * 数据层走 window.qingframe.frames* IPC；体检复用 StyleParams/StyleCaps（与 CLI 同一套规则）；
 * 预览用 window.__render 在离屏画布渲染，完全不碰用户当前照片与模板状态。
 */
(function () {
    const $ = (id) => document.getElementById(id);
    let app = null;
    let modal = null;
    let current = null;          // { name }
    let unwatch = null;

    function api() { return window.qingframe || {}; }

    function setStatus(text, kind) {
        const el = $('frameStatus');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'frame-status' + (kind ? ' ' + kind : '');
    }

    function parse(text) {
        try {
            const t = JSON.parse(text);
            if (!t || typeof t !== 'object' || Array.isArray(t)) return { ok: false, issues: ['根节点不是对象'] };
            return { ok: true, t };
        } catch (e) { return { ok: false, issues: ['JSON 解析失败：' + e.message] }; }
    }

    // 与 tools/qfs-frame.js check 同一套规则（渲染层用全局模块，CLI 用 require）
    function inspect(t) {
        const issues = [];
        if (!t.templateName || typeof t.templateName !== 'string') issues.push('缺 templateName（字符串）');
        const style = String(t.photoFrameStyle || '').toUpperCase();
        const SP = window.StyleParams, SC = window.StyleCaps;
        if (style && SC && SC.MEASURED && !Object.prototype.hasOwnProperty.call(SC.MEASURED, style)) {
            issues.push(`photoFrameStyle="${t.photoFrameStyle}" 不在已知风格表`);
        }
        if (SP && style) {
            for (const p of SP.forStyle(style)) {
                const raw = p.path === 'root' ? t[p.key] : (t.styleParams && t.styleParams[style] && t.styleParams[style][p.key]);
                if (raw == null) continue;
                const n = Number(raw);
                if (!Number.isFinite(n)) { issues.push(`参数 ${p.key} 不是数`); continue; }
                if (n < p.min || n > p.max) issues.push(`参数 ${p.key}=${raw} 超出 [${p.min},${p.max}]`);
            }
            const bad = SP.defaultsOk && SP.defaultsOk();
            if (bad && bad.length) issues.push('默认值与引擎字面量不符：' + bad.slice(0, 3).join('; '));
        }
        const bm = t.baseMargin || {};
        for (const k of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'imgScale']) {
            if (bm[k] != null && !Number.isFinite(Number(bm[k]))) issues.push(`baseMargin.${k} 不是数`);
        }
        if (t.layerList != null && !Array.isArray(t.layerList)) issues.push('layerList 不是数组');
        return issues;
    }

    async function loadList() {
        const list = api().framesList ? await api().framesList() : [];
        const box = $('frameList');
        if (!box) return;
        box.innerHTML = '';
        for (const name of (list || [])) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'frame-file' + (current && current.name === name ? ' active' : '');
            b.textContent = name;
            b.title = name;
            b.addEventListener('click', () => select(name));
            box.appendChild(b);
        }
        if (!list || !list.length) {
            const em = document.createElement('div');
            em.className = 'frame-preview-empty';
            em.textContent = '还没有边框文件。用 SKILL.md 让 agent 生成，或复制目录路径给它。';
            box.appendChild(em);
        }
        const dir = await (api().framesDir ? api().framesDir() : Promise.resolve({}));
        const d = $('frameDir');
        if (d) d.textContent = dir.path || '';
    }

    async function select(name) {
        const r = await (api().framesRead ? api().framesRead(name) : null);
        if (!r) { setStatus('读取失败', 'bad'); return; }
        current = { name: r.name };
        $('frameText').value = r.text;
        setStatus('', '');
        loadList();
    }

    async function save() {
        if (!current) { setStatus('先选一个文件', 'bad'); return; }
        const text = $('frameText').value;
        const p = parse(text);
        if (!p.ok) { setStatus(p.issues[0], 'bad'); return; }
        const r = await (api().framesSave ? api().framesSave(current.name, text) : null);
        if (r && r.ok) setStatus('已保存', 'ok');
        else setStatus((r && r.message) || '保存失败', 'bad');
    }

    function doCheck() {
        const p = parse($('frameText').value);
        if (!p.ok) { setStatus(p.issues.join('；'), 'bad'); return false; }
        const issues = inspect(p.t);
        if (issues.length) { setStatus('体检未过：' + issues.join('；'), 'bad'); return false; }
        setStatus('体检通过', 'ok');
        return true;
    }

    // 用真实引擎在离屏画布渲染当前 JSON，不碰 App 的 template / image / 画布
    function renderPreview() {
        const p = parse($('frameText').value);
        if (!p.ok) { setStatus(p.issues[0], 'bad'); return; }
        const usePhoto = $('frameUsePhoto') && $('frameUsePhoto').checked;
        const src = usePhoto && app && app.image && app.image.el;
        const stage = $('framePreviewStage');
        if (!window.__render) { setStatus('引擎未就绪', 'bad'); return; }
        const cv = document.createElement('canvas');
        cv.width = 600; cv.height = 760;
        const img = src || window.__qfsPhotoStub;
        if (!img || !img.naturalWidth) { setStatus('底图未就绪，稍后再试', 'bad'); return; }
        const tmp = {
            template: JSON.parse(JSON.stringify(p.t)),
            displayMax: 4000, selectedEls: [], uiDprOverride: 1,
            image: { el: img, exif: (p.t.manualExif) || {} },
            dom: { canvas: cv }, logos: [], logoImgCache: {},
            scheduleRender() {}, applyZoomStyle() {}
        };
        try {
            window.EngineStyles && window.EngineStyles.clearCaches && window.EngineStyles.clearCaches();
            window.__render(tmp);
            stage.innerHTML = '';
            const out = document.createElement('img');
            out.src = cv.toDataURL('image/png');
            stage.appendChild(out);
            setStatus('预览已渲染 ' + cv.width + '×' + cv.height, 'ok');
        } catch (e) { setStatus('渲染失败：' + (e.message || e), 'bad'); }
    }

    function applyCurrent() {
        const p = parse($('frameText').value);
        if (!p.ok) { setStatus(p.issues[0], 'bad'); return; }
        const issues = inspect(p.t);
        if (issues.length) { setStatus('体检未过，先修：' + issues[0], 'bad'); return; }
        if (!app || typeof app.applyPresetToCurrent !== 'function') { setStatus('应用未就绪', 'bad'); return; }
        app.applyPresetToCurrent(p.t);
        setStatus('已应用到当前照片（保留了你的签名/Logo/贴纸）', 'ok');
    }

    async function open() {
        if (!modal) return;
        modal.style.display = 'flex';
        await loadList();
        if (api().framesWatch) api().framesWatch();
        if (!unwatch && api().onFramesChanged) {
            unwatch = api().onFramesChanged((payload) => {
                setStatus('文件已被外部修改：' + (payload.name || '?') + '，点「刷新」重载', 'bad');
            });
        }
    }

    function close() {
        if (modal) modal.style.display = 'none';
    }

    function init(a) {
        app = a;
        modal = $('frameModal');
        if (!modal || modal.dataset.bound === '1') return;
        modal.dataset.bound = '1';
        $('frameModalClose').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        $('btnFrameRefresh').addEventListener('click', () => { loadList(); setStatus('已刷新', 'ok'); });
        $('btnFrameOpenDir').addEventListener('click', () => api().framesOpenDir && api().framesOpenDir());
        $('btnFrameCopyDir').addEventListener('click', async () => {
            const d = await (api().framesDir ? api().framesDir() : Promise.resolve({}));
            if (d.path && navigator.clipboard) {
                try { await navigator.clipboard.writeText(d.path); setStatus('目录路径已复制，发给 agent 即可', 'ok'); return; } catch (_) {}
            }
            setStatus(d.path || '无法获取目录', '');
        });
        $('btnFrameSave').addEventListener('click', save);
        $('btnFrameCheck').addEventListener('click', doCheck);
        $('btnFramePreview').addEventListener('click', renderPreview);
        $('btnFrameApply').addEventListener('click', applyCurrent);
        // 造一张离屏示例底图（无 --image 时预览用）。引擎读 naturalWidth，
        // 必须用 Image 而非 canvas（canvas 没有 naturalWidth，会算出 NaN seed）。
        try {
            const c = document.createElement('canvas'); c.width = 600; c.height = 760;
            const g = c.getContext('2d');
            const grad = g.createLinearGradient(0, 0, 0, 760);
            grad.addColorStop(0, '#7ec8e3'); grad.addColorStop(.55, '#e78ba0'); grad.addColorStop(1, '#5b4c7a');
            g.fillStyle = grad; g.fillRect(0, 0, 600, 760);
            const im = new Image();
            im.onload = () => { window.__qfsPhotoStub = im; };
            im.src = c.toDataURL('image/png');
        } catch (_) {}
    }

    window.QfsFramePanel = { init, open, close };
})();

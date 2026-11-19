'use strict';
/* 拾景纸刊面板：一张照片 → 一张纸上作品。
 *
 * 和「AI 造型」分开：那边是图层边框模板，这边是真正的图像生成。
 * 生成结果不塞进模板系统，而是落盘后作为新照片导入 —— 这样调色、
 * EXIF、导出、撤销全部复用现成链路，不碰渲染引擎。
 */
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const clone = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; } };
    const P = () => window.QfsAiProvider || {};
    const Z = () => window.QfsZine || {};
    const api = () => window.qingframe || {};

    let busy = false;
    let lastResults = [];
    let seq = 0;

    function photoSource() {
        const im = (window.App || {}).image;
        if (!im) return null;
        return (window.photoSrc && window.photoSrc(im)) || im.el || null;
    }
    function toDataUrl(el) {
        if (!el) return '';
        try {
            const w = el.naturalWidth || el.width || 0, h = el.naturalHeight || el.height || 0;
            if (!w || !h) return '';
            const max = 1024;
            const k = max / Math.max(w, h);
            const c = document.createElement('canvas');
            c.width = Math.round(w * Math.min(1, k));
            c.height = Math.round(h * Math.min(1, k));
            c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', 0.86);
        } catch (_) { return ''; }
    }
    function brief() {
        const im = (window.App || {}).image;
        if (!im) return null;
        if (window.QfsPhotoBrief && typeof window.QfsPhotoBrief.analyze === 'function') {
            try { return window.QfsPhotoBrief.analyze(photoSource(), { exif: im.exif }); } catch (_) {}
        }
        return null;
    }
    function setStatus(msg, bad) {
        const el = $('zineStatus');
        if (el) { el.textContent = msg || ''; el.className = 'zine-status' + (bad ? ' bad' : ''); }
    }
    function busyUI(on, text) {
        busy = on;
        const btn = $('btnZineMake');
        if (btn) { btn.disabled = on; btn.textContent = on ? '正在生成…' : '生成纸刊'; }
        const bar = $('zineProgress');
        if (bar) bar.hidden = !on;
        const t = $('zineProgressText');
        if (t && text) t.textContent = text;
    }

    function show() {
        const el = $('zineModal');
        if (!el) return;
        el.hidden = false;
        el.style.display = 'flex';
        refreshBrief();
        renderResults();
    }
    function hide() {
        const el = $('zineModal');
        if (!el) return;
        el.hidden = true;
        el.style.display = 'none';
    }

    function refreshBrief() {
        const b = brief();
        const box = $('zineBrief');
        if (!box) return;
        if (!b) { box.hidden = true; box.textContent = ''; return; }
        box.hidden = false;
        const txt = (window.QfsPhotoBrief && window.QfsPhotoBrief.toPromptText)
            ? window.QfsPhotoBrief.toPromptText(b, ((window.App || {}).image || {}).exif)
            : (b.ratio || '') + ' ' + (b.luma && b.luma.tone || '');
        box.textContent = txt;
    }

    async function generate() {
        if (busy) return;
        if (!P().imageReady) { setStatus('先到「高级 → 接口地址 / Key / 图像模型」配好通道，纸刊才能生成', true); return; }
        if (P().channel && P().channel() !== 'api') {
            setStatus('纸刊走 API 图像通道：请在「高级 → 模型通道」选 API 并填 Key', true);
            return;
        }
        if (!photoSource()) { setStatus('先在画布里导入一张照片', true); return; }
        const my = ++seq;
        busyUI(true, '正在编译画面描述…');
        setStatus('');
        try {
            const path = ($('zinePath') && $('zinePath').value) === 'distill' ? 'distill' : 'collage';
            const img = toDataUrl(photoSource());
            const b = brief();
            const compiled = Z().compile(b, {
                path,
                subject: ($('zineSubject') && $('zineSubject').value || '').trim(),
                mood: ($('zineMood') && $('zineMood').value || '').trim(),
                microText: ($('zineText') && $('zineText').value || '').trim(),
                lang: ($('zineLang') && $('zineLang').value) || 'en',
                ratio: ($('zineRatio') && $('zineRatio').value) || '',
                exif: ((window.App || {}).image || {}).exif
            });
            if (!compiled || !compiled.prompt) throw new Error('画面描述编译失败');
            busyUI(true, '正在请模型作画（约 20–60 秒）…');
            const r = await P().image({
                prompt: compiled.prompt,
                negative: compiled.negative,
                size: compiled.ratio === '5:3' ? '1536x1024' : '1024x1536',
                source: compiled.needsSourceImage ? img : ''
            });
            if (my !== seq) return;
            if (!r || !r.ok) throw new Error((r && r.error) || '图像生成失败');
            if (!r.image) throw new Error('模型没有返回图片');
            lastResults = [{
                key: 'zine:' + Date.now(),
                image: r.image,
                path: compiled.path,
                name: path === 'collage' ? '拾景拼贴' : '影像蒸馏',
                rationale: compiled.rationale,
                microText: compiled.microText
            }];
            setStatus('已生成，点「作为照片导入」就能继续调色和导出');
        } catch (e) {
            if (my !== seq) return;
            setStatus('失败：' + (e && e.message ? e.message : String(e)), true);
        } finally {
            if (my === seq) busyUI(false);
        }
        renderResults();
    }

    function renderResults() {
        const box = $('zineResults');
        if (!box) return;
        box.innerHTML = '';
        if (!lastResults.length) {
            const empty = document.createElement('div');
            empty.className = 'zine-empty';
            empty.textContent = '选择「实景拼贴」或「影像蒸馏」，点生成，把自己的照片变成一张纸上作品。';
            box.appendChild(empty);
            return;
        }
        lastResults.forEach((r) => {
            const card = document.createElement('div'); card.className = 'zine-card';
            const img = document.createElement('img');
            img.src = r.image; img.alt = r.name;
            card.appendChild(img);
            const meta = document.createElement('div'); meta.className = 'zine-card-meta';
            const name = document.createElement('div'); name.className = 'zine-card-name';
            name.textContent = r.name + ' · ' + r.microText;
            const why = document.createElement('div'); why.className = 'zine-card-why';
            why.textContent = r.rationale;
            const acts = document.createElement('div'); acts.className = 'zine-card-acts';
            const use = document.createElement('button');
            use.type = 'button'; use.className = 'mini-btn primary'; use.textContent = '作为照片导入';
            use.addEventListener('click', () => importAsPhoto(r));
            const save = document.createElement('button');
            save.type = 'button'; save.className = 'mini-btn'; save.textContent = '下载 PNG';
            save.addEventListener('click', () => savePng(r));
            acts.appendChild(use); acts.appendChild(save);
            meta.appendChild(name); meta.appendChild(why); meta.appendChild(acts);
            card.appendChild(meta);
            box.appendChild(card);
        });
    }

    async function importAsPhoto(r) {
        if (!r || !r.image) return;
        try {
            setStatus('正在导入…');
            const a = api();
            if (typeof a.zineImport !== 'function' || typeof a.collectImages !== 'function') {
                throw new Error('当前版本不支持导入生成图');
            }
            const saved = await a.zineImport(r.image, '拾景纸刊_' + Date.now());
            if (!saved || !saved.ok) throw new Error((saved && saved.error) || '保存失败');
            const items = await a.collectImages([saved.path]);
            if (!items || !items.length) throw new Error('导入失败：图片未被识别');
            const inst = window.App || {};
            if (typeof inst.importPicked !== 'function') throw new Error('应用还没准备好接收图片');
            await inst.importPicked(items, 0);
            hide();
            setStatus('');
        } catch (e) {
            setStatus('导入失败：' + (e && e.message ? e.message : String(e)), true);
        }
    }

    function savePng(r) {
        if (!r || !r.image) return;
        const a = document.createElement('a');
        a.href = r.image;
        a.download = '拾景纸刊_' + Date.now() + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    let inited = false;
    function init() {
        if (inited) return;
        inited = true;
        $('zineClose').addEventListener('click', hide);
        $('zineModal').addEventListener('click', (e) => { if (e.target === $('zineModal')) hide(); });
        $('btnZineMake').addEventListener('click', generate);
    }

    window.QfsZinePanel = { init, show, hide, generate, renderResults, get results() { return clone(lastResults); } };
})();

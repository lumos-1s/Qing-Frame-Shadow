'use strict';
/* AI 造型：一句话生成多方案画廊，点选即用。
 * 主流程对用户只有「输入想法 → 4 宫格样片 → 点选应用」；
 * 文件/JSON/体检/模型等开发者能力收进「高级」折叠区，默认不出现。
 * 渲染复用 window.__render 离屏画布，套到用户照片，不碰当前模板状态。
 *
 * 生成闭环：可停止、可换一批、可基于某一款继续改；历史/收藏/大图预览/套用后微调
 * 都在本面板内完成，生成失败会在主界面给出原因和重试入口。
 */
(function () {
    const $ = (id) => document.getElementById(id);
    let app = null, modal = null;
    let agentKey = null, agentModelId = 'model', agentModels = [], modelPopUnwatch = null;
    const MODEL_KEY = 'qfs_ai_model';
    const AGENT_KEY = 'qfs_ai_agent';
    const STORE_KEY = 'qfs_ai_gallery_v1';
    const modelKeyOf = (id) => MODEL_KEY + ':' + String(id || '');
    function readStore(k) { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } }
    function writeStore(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (_) {} }
    function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; } }
    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    function modelForAgent(id) { return readStore(modelKeyOf(id)) || readStore(MODEL_KEY); }
    let currentAgent = readStore(AGENT_KEY);
    let currentModel = modelForAgent(currentAgent);
    let preloadPromise = null, preloadFor = '';
    let agentStream = '', unwatchAgent = null;
    let current = null;          // 高级区选中的文件 { name }
    let gallery = [];            // 本轮方案 [{ key, preset, dataUrl, source }]
    let view = 'current';        // current | history | favs
    let currentPrompt = '';
    let lastRequest = null;      // { prompt, base, avoid } 供重试/换一批
    let previousNames = [];
    let generating = false;
    let runSeq = 0;
    let activePrompt = null, cancelWait = null;
    let progressTimer = 0, progressBase = '';
    let applied = null;          // 当前 AI 边框的微调基准 { key, layers, bg, name, textEdits, textColors }
    let tweakUndoPushed = false, tweakTimer = 0;
    let iterateBase = null;      // 继续改所基于的方案 entry
    let lbEntry = null, lbPreview = '', lbOriginal = '';
    const previewCache = new Map();

    function api() { return window.qingframe || {}; }
    function setStatus(text, kind) {
        const el = $('frameStatus'); if (!el) return;
        el.textContent = text || ''; el.className = 'frame-status' + (kind ? ' ' + kind : '');
        el.title = text || '';
    }
    function progress(on, text) {
        const p = $('frameProgress'); if (!p) return;
        p.hidden = !on;
        clearInterval(progressTimer); progressTimer = 0;
        if (!on) { progressBase = ''; return; }
        progressBase = text || '处理中';
        const started = Date.now();
        const tick = () => {
            const t = $('frameProgressText'); if (!t) return;
            const s = Math.floor((Date.now() - started) / 1000);
            t.textContent = progressBase + (s > 0 ? ' · ' + s + 's' : '');
        };
        tick();
        progressTimer = setInterval(tick, 1000);
    }
    function parse(text) {
        try { const t = JSON.parse(text); if (!t || typeof t !== 'object' || Array.isArray(t)) return { ok: false, issues: ['根节点不是对象'] }; return { ok: true, t }; }
        catch (e) { return { ok: false, issues: ['JSON 解析失败：' + e.message] }; }
    }
    // 图层边框文档：校验 layers / aiLayers，过滤非法层，保证至少有一层
    function sanitizeLayerDoc(t) {
        const src = layersOfDoc(t);
        if (!src) return null;
        const layers = src.map((l) => window.AiLayers ? window.AiLayers.normalize(l) : l).filter(Boolean);
        if (!layers.length) return null;
        ensurePhotoSlot(layers);
        const out = Object.assign({}, t, { layers });
        if (typeof out.templateName !== 'string' || !out.templateName) out.templateName = 'AI 边框';
        return out;
    }
    // 老方案/模型漏写 photo 槽位时，按最大的实心卡纸推导一个，别让照片永远落在固定 8% 的位置
    function ensurePhotoSlot(layers) {
        if (!Array.isArray(layers) || layers.some((l) => l && l.type === 'photo')) return layers;
        let bg = null, area = 0;
        for (const l of layers) {
            if (!l || l.type !== 'rect' || !l.fill) continue;
            const op = l.fillOpacity == null ? 1 : Number(l.fillOpacity);
            const a = (Number(l.w) || 0) * (Number(l.h) || 0);
            if (op > 0.5 && a > area) { bg = l; area = a; }
        }
        let slot;
        if (bg && area > 0.25) {
            const pad = Math.max(0.015, Math.min(Number(bg.w) || 0, Number(bg.h) || 0) * 0.04);
            const x = Math.max(0, Math.min(1, (Number(bg.x) || 0) + pad));
            const y = Math.max(0, Math.min(1, (Number(bg.y) || 0) + pad));
            slot = {
                type: 'photo', x, y,
                w: Math.max(0.05, Math.min((Number(bg.w) || 0) - pad * 2, 1 - x)),
                h: Math.max(0.05, Math.min((Number(bg.h) || 0) - pad * 2, 1 - y)),
                fit: 'cover'
            };
        } else {
            slot = { type: 'photo', x: 0.08, y: 0.08, w: 0.84, h: 0.78, fit: 'cover' };
        }
        const at = bg && layers.indexOf(bg) >= 0 ? layers.indexOf(bg) + 1 : 0;
        layers.splice(at, 0, slot);
        return layers;
    }
    function layersOfDoc(t) {
        if (!t) return null;
        if (Array.isArray(t.layers) && t.layers.length) return t.layers;
        if (Array.isArray(t.aiLayers) && t.aiLayers.length) return t.aiLayers;
        return null;
    }
    function isLayerDoc(preset) { return !!layersOfDoc(preset); }
    function inspect(t) {
        const issues = [];
        if (!t.templateName || typeof t.templateName !== 'string') issues.push('缺 templateName');
        const docLayers = layersOfDoc(t);
        if (docLayers) {
            const valid = docLayers.map((l) => window.AiLayers ? window.AiLayers.normalize(l) : l).filter(Boolean);
            if (!valid.length) issues.push('没有有效图层');
            if (valid.length < docLayers.length) issues.push('有 ' + (docLayers.length - valid.length) + ' 个图层类型无法识别');
            const photos = valid.filter((l) => l.type === 'photo');
            if (!photos.length) issues.push('缺 photo 照片槽位（照片会落到默认中央区）');
            if (photos.length > 1) issues.push('只能有一个 photo 槽位');
            for (const p of photos) {
                const x = Number(p.x) || 0, y = Number(p.y) || 0, w = Number(p.w) || 0, h = Number(p.h) || 0;
                if (w < 0.2 || h < 0.2) issues.push('photo 槽位太小');
                if (x + w > 1.001 || y + h > 1.001) issues.push('photo 槽位超出画布');
            }
            return issues;
        }
        const style = String(t.photoFrameStyle || '').toUpperCase();
        const SP = window.StyleParams, SC = window.StyleCaps;
        if (style && SC && SC.MEASURED && !Object.prototype.hasOwnProperty.call(SC.MEASURED, style)) issues.push(`未知风格 ${t.photoFrameStyle}`);
        if (SP && style) for (const p of SP.forStyle(style)) {
            const raw = p.path === 'root' ? t[p.key] : (t.styleParams && t.styleParams[style] && t.styleParams[style][p.key]);
            if (raw == null) continue;
            const n = Number(raw);
            if (!Number.isFinite(n) || n < p.min || n > p.max) issues.push(`${p.key} 超出 [${p.min},${p.max}]`);
        }
        return issues;
    }

    // ── 渲染：把一份方案套到底图，返回 dataURL ──
    // 图层方案走 AiLayers：photo 槽位决定照片位置，画布按照片比例算，不拉伸、不伪造 480×620。
    // 传统预设仍走引擎离屏渲染。
    function renderFrameToUrl(preset, img, opts) {
        if (!img) return null;
        try {
            const layers = preset && (Array.isArray(preset.layers) ? preset.layers
                : (Array.isArray(preset.aiLayers) ? preset.aiLayers : null));
            if (layers && layers.length && window.AiLayers && window.AiLayers.renderToCanvas) {
                const cv = window.AiLayers.renderToCanvas(preset, img, { maxEdge: (opts && opts.maxEdge) || 620 });
                return cv ? cv.toDataURL('image/png') : null;
            }
            if (!window.__render) return null;
            if (!img.naturalWidth && !img.width) return null;
            const cv = document.createElement('canvas');
            cv.width = 480; cv.height = 620;
            const tmp = {
                template: JSON.parse(JSON.stringify(preset)),
                displayMax: 4000, selectedEls: [], uiDprOverride: 1,
                image: { el: img, exif: (preset.manualExif) || {} },
                dom: { canvas: cv }, logos: [], logoImgCache: {},
                scheduleRender() {}, applyZoomStyle() {}
            };
            window.EngineStyles && window.EngineStyles.clearCaches && window.EngineStyles.clearCaches();
            window.__render(tmp);
            return cv.toDataURL('image/png');
        } catch (e) {
            console.warn('[AI 边框] 预览渲染失败', e);
            return null;
        }
    }
    // 用户已导入的照片列表（画廊示例图）：默认当前照片，可自己选
    function refreshSamplePhotos() {
        const sel = $('frameSamplePhoto'); if (!sel) return;
        const imgs = (app && Array.isArray(app.images)) ? app.images : [];
        sel.innerHTML = '';
        if (!imgs.length) {
            const o = document.createElement('option'); o.value = ''; o.textContent = '（用示例图）'; sel.appendChild(o);
            return;
        }
        imgs.forEach((im, i) => {
            const o = document.createElement('option');
            o.value = String(i);
            o.textContent = (im.name || ('照片 ' + (i + 1))) + (im === (app && app.image) ? ' · 当前' : '');
            if (im === (app && app.image)) o.selected = true;
            sel.appendChild(o);
        });
    }
    // 选中的示例照片对象（默认当前主图）
    function photoImage() {
        const sel = $('frameSamplePhoto');
        const i = sel ? parseInt(sel.value, 10) : NaN;
        if (app && Array.isArray(app.images) && Number.isInteger(i) && app.images[i]) return app.images[i];
        return (app && app.image) || null;
    }
    // ── 照片速写：让 AI「看着这张照片配」，而不是盲配 ──
    // 统计在 64px 缩略图上做，几千个像素，每次生成前跑一次也不心疼。
    let lastBrief = null;
    function briefOf() {
        const im = photoImage();
        if (!im || !window.PhotoBrief) return null;
        const src = (window.photoSrc && window.photoSrc(im)) || im.el;
        if (!src) return null;
        const brief = window.PhotoBrief.analyze(src);
        if (!brief) return null;
        const exif = im.exif || (app && app.image && app.image.exif) || {};
        return { brief, text: window.PhotoBrief.toPromptText(brief, exif), advice: window.PhotoBrief.toAdvice(brief) };
    }
    function refreshBrief() {
        lastBrief = briefOf();
        const el = $('frameBrief');
        if (app) app._frameBrief = lastBrief ? lastBrief.brief : null;
        if (!el) return;
        if (!lastBrief) { el.hidden = true; el.textContent = ''; el.removeAttribute('title'); return; }
        const b = lastBrief.brief;
        el.hidden = false;
        el.textContent = '';
        const sw = document.createElement('span');
        sw.className = 'frame-brief-swatch';
        sw.style.background = b.dominant.hex;
        const txt = document.createElement('span');
        txt.textContent = '已读照片：' + b.ratio + ' ' + b.orient + '构图 · ' + b.luma.tone
            + ' · 主色 ' + b.dominant.name + ' · 重心' + b.centroid.label;
        el.appendChild(sw);
        el.appendChild(txt);
        el.title = lastBrief.text + '\n\n' + lastBrief.advice;
    }
    // 预览必须走引擎同一取源：调色后的照片在 im._grade.canvas 里，直接用 im.el 会预览成未调色。
    function photoSource() {
        const im = photoImage();
        if (!im) return window.__qfsPhotoStub;
        return (window.photoSrc && window.photoSrc(im)) || im.el;
    }
    // 大图「看原图」用的缩略 dataURL：原图可能 6000×4000，直接 toDataURL 又慢又占内存，
    // 这里按 1600px 等比缩小后再导出，和成品大图同一量级。
    function photoDataUrl() {
        const im = photoImage();
        if (!im) return (window.__qfsPhotoStub && window.__qfsPhotoStub.src) || '';
        const src = photoSource();
        if (src && (src.naturalWidth || src.width)) {
            try {
                const nw = src.naturalWidth || src.width, nh = src.naturalHeight || src.height;
                const scale = Math.min(1, 1600 / Math.max(nw, nh));
                const c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(nw * scale));
                c.height = Math.max(1, Math.round(nh * scale));
                c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
                return c.toDataURL('image/png');
            } catch (_) { /* 落回原始 dataURL */ }
        }
        if (src && typeof src.toDataURL === 'function') { try { return src.toDataURL('image/png'); } catch (_) {} }
        return (src && src.src) || (im.el && im.el.src) || '';
    }

    // ── 历史 / 收藏（只存图层文档，重启后按当前照片重新出预览）──
    function readGalleryStore() {
        try {
            const o = JSON.parse(readStore(STORE_KEY) || '{}') || {};
            return {
                rounds: (Array.isArray(o.rounds) ? o.rounds : []).filter((r) => r && Array.isArray(r.items) && r.items.length),
                favs: (Array.isArray(o.favs) ? o.favs : []).filter((f) => f && f.preset)
            };
        } catch (_) { return { rounds: [], favs: [] }; }
    }
    // localStorage 配额有限：先丢最旧的整轮/收藏，仍超限就放弃写，不能让保存历史把生成流程搞挂。
    function writeGalleryStore(st) {
        st.rounds = st.rounds.slice(0, 12);
        st.favs = st.favs.slice(0, 40);
        let raw = JSON.stringify(st);
        while (raw.length > 1800000 && st.rounds.length) { st.rounds.pop(); raw = JSON.stringify(st); }
        while (raw.length > 1800000 && st.favs.length) { st.favs.pop(); raw = JSON.stringify(st); }
        try { localStorage.setItem(STORE_KEY, raw); } catch (_) {
            try { localStorage.setItem(STORE_KEY, JSON.stringify({ rounds: st.rounds.slice(0, 2), favs: st.favs.slice(0, 6) })); } catch (_) {}
        }
    }
    function pushRound(prompt, presets) {
        const st = readGalleryStore();
        st.rounds.unshift({ id: uid(), at: Date.now(), prompt: String(prompt || ''), items: presets.map((p) => clone(p)) });
        writeGalleryStore(st);
    }
    function docKey(preset) {
        try {
            const s = JSON.stringify(layersOfDoc(preset) || []);
            let h = 5381;
            for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
            return String((preset && preset.templateName) || '') + '|' + (layersOfDoc(preset) || []).length + '|' + (h >>> 0);
        } catch (_) { return ''; }
    }
    function isFavDoc(preset, st) {
        const k = docKey(preset);
        return (st || readGalleryStore()).favs.some((f) => docKey(f.preset) === k);
    }
    function updateFavCount(st) {
        const el = $('frameFavCount'); if (!el) return;
        const n = ((st || readGalleryStore()).favs || []).length;
        el.textContent = n ? String(n) : '';
    }
    function pad2(n) { return n < 10 ? '0' + n : String(n); }
    function roundLabel(entry) {
        const d = new Date(entry.roundAt || Date.now());
        const t = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        return t + ' · ' + String(entry.roundPrompt || '未命名').slice(0, 60);
    }
    function displayEntries(st) {
        if (view === 'history') {
            const out = [];
            st.rounds.slice(0, 6).forEach((r) => {
                (r.items || []).forEach((preset, i) => {
                    out.push({
                        key: 'h:' + r.id + ':' + i, preset, source: 'history', isLayer: isLayerDoc(preset),
                        roundId: r.id, roundPrompt: r.prompt, roundAt: r.at
                    });
                });
            });
            return out;
        }
        if (view === 'favs') {
            return st.favs.map((f) => ({
                key: 'f:' + f.id, preset: f.preset, source: 'favs', isLayer: isLayerDoc(f.preset),
                roundPrompt: f.prompt, roundAt: f.at
            }));
        }
        return gallery;
    }
    function ensurePreview(entry) {
        if (entry.dataUrl) return entry.dataUrl;
        const cached = previewCache.get(entry.key);
        if (cached) { entry.dataUrl = cached; return cached; }
        const url = renderFrameToUrl(entry.preset, photoSource());
        if (url) { entry.dataUrl = url; previewCache.set(entry.key, url); }
        return url;
    }
    function emptyGalleryHtml() {
        if (view === 'history') {
            return '<div class="frame-gallery-empty"><div class="frame-gallery-empty-ico">◷</div><div>还没有历史记录</div>'
                + '<div class="frame-gallery-empty-sub">生成过的方案会留在这里，重启软件也还在</div></div>';
        }
        if (view === 'favs') {
            return '<div class="frame-gallery-empty"><div class="frame-gallery-empty-ico">☆</div><div>还没有收藏</div>'
                + '<div class="frame-gallery-empty-sub">点方案卡片右上角的 ☆，把常用款留在这里</div></div>';
        }
        return '<div class="frame-gallery-empty" id="frameGalleryEmpty"><div class="frame-gallery-empty-ico">◫</div>'
            + '<div>选一张你已导入的照片，说一句想要的风格，AI 洗出 <b>4 款</b> 让你挑</div>'
            + '<div class="frame-gallery-empty-sub">没导入照片也能看效果，但用你自己的照片更直观</div></div>';
    }

    // ── 画廊 ──
    function renderGallery() {
        const box = $('frameGallery'); if (!box) return;
        const st = readGalleryStore();
        const entries = displayEntries(st);
        updateFavCount(st);
        if (!entries.length) { box.innerHTML = emptyGalleryHtml(); return; }
        box.innerHTML = '';
        let lastRound = '';
        entries.forEach((entry) => {
            if (entry.source === 'history' && entry.roundId !== lastRound) {
                lastRound = entry.roundId;
                const head = document.createElement('div');
                head.className = 'frame-round-head';
                head.textContent = roundLabel(entry);
                box.appendChild(head);
            }
            box.appendChild(buildCard(entry, ensurePreview(entry), st));
        });
    }
    function buildCard(entry, url, st) {
        const card = document.createElement('div');
        card.className = 'frame-swatch' + (applied && applied.key === entry.key ? ' applied' : '');
        card.setAttribute('role', 'listitem');
        card.tabIndex = 0;
        card.title = entry.preset.templateName || '方案';

        const imgBox = document.createElement('div'); imgBox.className = 'frame-swatch-img';
        if (url) {
            const im = document.createElement('img');
            im.src = url; im.alt = entry.preset.templateName || '方案';
            imgBox.appendChild(im);
        } else {
            const ld = document.createElement('div'); ld.className = 'frame-swatch-loading'; ld.textContent = '渲染中…'; imgBox.appendChild(ld);
        }
        const acts = document.createElement('div'); acts.className = 'frame-swatch-acts';
        const expand = document.createElement('button');
        expand.type = 'button'; expand.dataset.act = 'expand'; expand.title = '放大预览'; expand.setAttribute('aria-label', '放大预览'); expand.textContent = '⤢';
        const fav = document.createElement('button');
        fav.type = 'button'; fav.dataset.act = 'fav';
        const on = isFavDoc(entry.preset, st);
        fav.textContent = on ? '★' : '☆';
        fav.classList.toggle('active', on);
        fav.title = on ? '取消收藏' : '收藏这款';
        fav.setAttribute('aria-label', fav.title);
        acts.appendChild(expand); acts.appendChild(fav);
        imgBox.appendChild(acts);
        if (entry.lint && ((entry.lint.fixes && entry.lint.fixes.length) || (entry.lint.issues && entry.lint.issues.length))) {
            const issues = entry.lint.issues || [];
            const warnN = issues.filter((x) => x.level === 'warn').length;
            const errN = issues.filter((x) => x.level === 'error').length;
            const badge = document.createElement('span');
            badge.className = 'frame-swatch-lint' + (warnN || errN ? ' warn' : '');
            badge.textContent = (entry.lint.fixes && entry.lint.fixes.length)
                ? '已修正 ' + entry.lint.fixes.length
                : (errN ? errN + ' 处问题' : warnN + ' 处提醒');
            badge.title = [entry.lint.summary, window.FrameLint ? window.FrameLint.describe(issues) : ''].filter(Boolean).join('\n');
            imgBox.appendChild(badge);
        }
        if (entry.bold) {
            const b = document.createElement('span');
            b.className = 'frame-swatch-bold' + (entry.bold.score >= 45 ? ' strong' : '');
            b.textContent = entry.bold.grade + ' ' + entry.bold.score;
            b.title = (entry.bold.hints && entry.bold.hints.length)
                ? '大胆度 ' + entry.bold.score + '/100\n' + entry.bold.hints.join('\n')
                : '大胆度 ' + entry.bold.score + '/100';
            imgBox.appendChild(b);
        }

        const foot = document.createElement('div'); foot.className = 'frame-swatch-foot';
        const name = document.createElement('span'); name.className = 'frame-swatch-name'; name.textContent = entry.preset.templateName || '方案';
        foot.appendChild(name);
        if (entry.isLayer) {
            const tweak = document.createElement('button');
            tweak.type = 'button'; tweak.className = 'frame-swatch-tweak'; tweak.dataset.act = 'tweak';
            tweak.textContent = '继续改'; tweak.title = '基于这一款再生成 4 个变体';
            foot.appendChild(tweak);
            tweak.addEventListener('click', (e) => { e.stopPropagation(); openIterate(entry); });
        }
        const use = document.createElement('span'); use.className = 'frame-swatch-use'; use.textContent = '套用 ›';
        foot.appendChild(use);

        card.appendChild(imgBox); card.appendChild(foot);
        card.addEventListener('click', () => applyEntry(entry));
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applyEntry(entry); }
        });
        expand.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(entry); });
        fav.addEventListener('click', (e) => { e.stopPropagation(); toggleFav(entry); });
        return card;
    }

    function applyEntry(entry) {
        if (!entry) return;
        const inst = window.App || app;
        if (!inst || typeof inst.applyPresetToCurrent !== 'function') { setStatus('应用未就绪', 'bad'); return; }
        const layers = layersOfDoc(entry.preset);
        let tpl;
        if (layers) {
            // AI 图层边框是「模板」，不是贴回照片的成品图：
            // 只把 layers 写进 template.aiLayers，照片/调色/裁切/撤销全部保持原样。
            tpl = {
                templateName: entry.preset.templateName || 'AI 边框',
                aiLayers: clone(layers),
                aiBackground: typeof entry.preset.aiBackground === 'string' ? entry.preset.aiBackground : '#ffffff'
            };
        } else {
            tpl = clone(entry.preset);
        }
        const ok = inst.applyPresetToCurrent(tpl);
        if (ok === false) { setStatus('套用失败', 'bad'); return; }
        applied = layers ? {
            key: entry.key, layers: clone(layers), bg: tpl.aiBackground, name: tpl.templateName,
            textEdits: {}, textColors: {}
        } : null;
        tweakUndoPushed = false;
        refreshTweakPanel(true);
        let extra = 0;
        const batchEl = $('frameBatchApply');
        if (batchEl && batchEl.checked && inst._syncTplToTargets && Array.isArray(inst.selectedIdx) && inst.selectedIdx.length > 1) {
            const n = inst._syncTplToTargets(inst.selectedIdx, { confirm: true });
            if (n > 0) extra = n;
        }
        setStatus(extra ? `已套用「${tpl.templateName}」到当前照片和另外 ${extra} 张` : `已套用「${tpl.templateName}」`, 'ok');
        renderGallery();
        syncToolbar();
    }

    function toggleFav(entry) {
        if (!entry) return;
        const st = readGalleryStore();
        const k = docKey(entry.preset);
        const i = st.favs.findIndex((f) => docKey(f.preset) === k);
        if (i >= 0) st.favs.splice(i, 1);
        else st.favs.unshift({ id: uid(), at: Date.now(), prompt: entry.roundPrompt || currentPrompt || '', preset: clone(entry.preset) });
        writeGalleryStore(st);
        updateFavCount(st);
        renderGallery();
        if (lbEntry && lbEntry.key === entry.key) updateLbFav();
        setStatus(i >= 0 ? '已取消收藏' : '已收藏，在「收藏」标签查看', i >= 0 ? '' : 'ok');
    }

    // ── 生成：一句话 → N 个方案 ──
    // 生成规则是「会话级约定」，不能把用户第一句话写进 AGENTS.md：
    // 每次请求单独把规则 + 本轮要求/参考版一起发给助手。
    // 图层协议只有一份：本机助手（写文件）和 API 通道（直接回 JSON）共用，避免两边漂移
    //
    // 四款必须落在四种不同「构图语法」上，而不是同一套相框换四次颜色。
    // 每族都带硬指标：只说「更大胆」，模型会退回「居中照片 + 四边等宽留白 + 底部一行字」；
    // 给出照片占比、展示字下限、色块占比这些数字，构图才真的会变。
    // 每轮抽 3 个破格族 + 1 个安静族——安静族也必须有一个压场的大元素，不许交白卷。
    // 每族给「坐标原型」而不是形容词：模型对「贴边」的理解是 0.02 边距，
    // 只有把 photo 槽位写成 x=0/w=1 这样的具体数字，它才会真的顶到画布边。
    const CREATIVE_FAMILIES = [
        { name: '满版压字', bold: true, slot: 'x=0,y=0,w=1,h=1（四边满版）', recipe: '照片四边满版；一枚 size 0.14~0.18 的展示字直接压在照片上，配 ≥0.6 宽的实色条或重阴影；标题块 ≤30% 画面' },
        { name: '偏置分栏', bold: true, slot: 'x=0,y=0,w=0.62,h=1（左侧满高）或 x=0.38,y=0,w=0.62,h=1（右侧满高）', recipe: '照片一边满高贴边、占 55%~75% 宽；另一侧一条 ≥0.13 展示编号/短句 + 一块 ≥25% 版面的实色块；信息沿边竖排' },
        { name: '档案票据', bold: false, slot: 'x=0.08,y=0.10,w=0.84,h=0.62（贴顶的图版）', recipe: '≥14 条结构线/刻度/网格；页眉页脚齐全；照片带 1.5%~3% 错位投影；至少 6 条线跨过照片边' },
        { name: '网点印刷', bold: true, slot: 'x=0,y=0,w=1,h=0.86（顶满宽）或 x=0,y=0,w=1,h=1', recipe: '照片贴边；≥28 个重复圆点组成 ≥22% 版面的矩阵，允许圆点压在照片上；2~3 色套印，一块实色块错位 0.01~0.02' },
        { name: '字体海报', bold: true, slot: 'x=0.42,y=0,w=0.58,h=0.78（右上）或 x=0,y=0.28,w=0.66,h=0.72', recipe: '展示字 0.14~0.18 是主视觉，与照片重叠 ≥40%；照片 ≤60% 宽；文字贴边或竖排' },
        { name: '极简光学', bold: false, slot: 'x=0.06,y=0,w=0.88,h=0.66（贴顶）', recipe: '留白 ≥45%，但必须有一枚 ≥0.15 展示字或一块 ≥30% 单色块压场；一条发丝线，不许多余装饰' },
        { name: '取景器', bold: false, slot: 'x=0,y=0,w=1,h=1（满版）或 x=0,y=0.2,w=1,h=0.8', recipe: '四角括号+三分线+中心十字+边缘刻度+曝光参数，≥3 条线横穿照片；画面满版，不留相框边' },
        { name: '纸片拼贴', bold: true, slot: 'x=0.04,y=0.04,w=0.78,h=0.66（偏左上）', recipe: '≥3 张错位纸片（带投影）+ 胶带条 + 一块色片压住照片角 15%~25%；短句像手写标注' }
    ];
    function shuffled(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }
    // 3 破格 + 1 安静：整批先站住「大胆」，安静款负责喘气，但不能空。
    function pickFamilies() {
        const bold = shuffled(CREATIVE_FAMILIES.filter((f) => f.bold)).slice(0, 3);
        const quiet = shuffled(CREATIVE_FAMILIES.filter((f) => !f.bold))[0];
        return [bold[0], quiet, bold[1], bold[2]];
    }
    function familyAssignment(families, keepBase) {
        if (!Array.isArray(families) || !families.length) return '';
        if (keepBase) {
            return [
                '这 4 个变体各借一种构图语法，但保留参考版的照片槽位与整体骨架：',
                families.map((f, i) => (i + 1) + '. ' + f.name + '：借它的文字角色、母题与装饰语言，照片槽位不动。').join('\n'),
                '变体之间至少在文字角色、母题、装饰语言三项里改两项；只换配色或字号不算。'
            ].join('\n');
        }
        return [
            '本轮四款的构图语法与顺序（不许换位、不许重复，每款先满足本族硬指标再谈装饰）：',
            families.map((f, i) => (i + 1) + '. ' + f.name + '：photo 槽位写成 ' + f.slot + '；' + f.recipe).join('\n'),
            '本批硬指标（逐款核对，做不到就重做那一款）：',
            '① 四款里至少两款的 photo 有 ≥2 条边贴住画布（x=0 / y=0 / x+w=1 / y+h=1），或照片面积 ≥85%，或 ≤40%；',
            '② 至少两款有 size ≥0.14 的展示字，且这枚字与照片重叠 ≥50%；',
            '③ 至少一款整幅没有「等宽留白相框边」——照片必须贴边或满版；',
            '④ 四款的 photo 槽位写法必须四种不同，不许都用 0.08/0.08/0.84；',
            '⑤ 每款画布宽高比落在 0.6~1.8（写完用「照片比例 × 槽位高 ÷ 槽位宽」算一遍，超了就改槽位方向）。'
        ].join('\n');
    }
    function creativeMethodLines() {
        return [
            '设计方法：先为每款写一句「构图句」（照片怎么放、文字扮演什么、母题是什么），再落图层。',
            '四款必须是四种不同构图语法；同一骨架只换配色或一句文案，不算四款。如果用户明确要求四款同风格/同骨架，先服从用户。',
            '可用构图语法：' + CREATIVE_FAMILIES.map((f) => f.name).join(' / ') + '；本轮只用下面指定给这一款的语法。',
            '反默认：不要四款都做成「照片居中 + 四边等宽留白 + 照片描边 + 底部一行字」，出现两款以上就重做；也不要直接复刻邮票齿孔、拍立得白边、报纸头版、胶片齿条、票根、杂志封面——这些内置预设已经有了。',
            '破格动作（至少两款各用一个）：照片满版或贴边、展示字 ≥0.14 压图、色块/圆点矩阵占 ≥20% 且压到照片、文字贴边或竖排。',
            '注意：照片槽位不能超出画布（x/y 在 0..1，w/h 最多到画布边），「出血」只能是贴边或满版，不要写负坐标或大于 1 的宽高。',
            '配色从照片主色/辅色或一个明确概念来；至少两款离开「暖白底 + 黑 + 金」，可用对比色大色块或双色套印。每条线、每个圆点都要有结构作用，别用装饰填空。',
            '落完图层逐款自检，三问答不出数字就重做：photo 有几条边贴住画布？最大字号是多少？有没有东西压在照片上？'
        ];
    }
    function layerSchemaLines() {
        return [
            '每个方案是一个「图层边框」对象，格式：',
            '{"templateName":"方案名","layers":[ ...图层... ]}',
            'layers 从底到顶绘制，每层是以下之一（坐标为 0..1 比例，相对画布宽高）。示例只示意字段，坐标按本族硬指标来，不要退回 0.08 边距：',
            ' {"type":"photo","x":0,"y":0,"w":1,"h":1,"radius":0,"fit":"cover"}（满版）  或  {"type":"photo","x":0,"y":0,"w":0.62,"h":1,"radius":0,"fit":"cover"}（左侧满高）',
            ' {"type":"rect","x":0,"y":0.72,"w":1,"h":0.28,"fill":"#111111","fillOpacity":1}（贴边色带）  或  {"type":"rect","x":0.55,"y":0.06,"w":0.4,"h":0.5,"fill":"#c8452d","fillOpacity":0.92}（压图色块）',
            ' {"type":"circle","cx":0.5,"cy":0.2,"r":0.08,"fill":"#129e78"}',
            ' {"type":"line","x1":0,"y1":0.5,"x2":1,"y2":0.5,"color":"#dcba79","width":2,"dash":[4,4]}（跨整幅）',
            ' {"type":"text","x":0,"y":0.9,"text":"秋日","size":0.16,"color":"#f5efe0","align":"left","weight":800,"maxW":0.96,"maxLines":1,"shadow":{"color":"#000000","blur":12,"opacity":0.45}}',
            '必须包含且只包含一个 photo 槽位：它就是照片的位置和大小。画布比例由槽位反推——画布宽高比 = 照片宽高比 × 槽位高 ÷ 槽位宽，必须落在 0.6~1.8 之间。',
            '  横照片（宽>高）不要写 w=0.62,h=1 的左右分栏（会拉出 2:1 长卷、照片裁掉大半），改成 w=1,h=0.7 的上下分栏；竖照片反过来。「照片只占下半」会得到更高的画布，这是正常的。',
            'photo 之前的图层画在照片下面（底色/卡纸/背景），photo 之后的图层画在照片上面（文字/线条/装饰）；不要用一整块不透明层把照片全盖住，也不要把色块/标签排在文字后面盖住文字。',
            '文字务必带 maxW（0..1，展示字用 0.9~1.0）和 maxLines：正文 size 0.02~0.055，展示字 0.13~0.18（maxLines:1），不要超过 0.20。展示字控制在 2~4 个字，字越多会被引擎缩得越小。',
            '允许文字压在照片上，用实色条块垫底或阴影保证可读；色块可以压住照片一角（≤30%）做层次。',
            '可加 shadow:{color,blur,offsetX,offsetY,opacity}。颜色用十六进制。'
        ];
    }
    function designRules() {
        return [
            '你是清框影边框设计师。',
            '请生成 4 个各不相同的边框方案，在本目录写 4 个 JSON：a1.json / a2.json / a3.json / a4.json（a1~a4 依次对应本轮第 1~4 款的构图语法）。'
        ].concat(layerSchemaLines(), creativeMethodLines(), [
            '名字要体现构图或概念（如「偏置档案」「满版压字」），不要「方案一」。',
            '写好 4 个文件后只回复「完成」，不要输出 JSON 正文。'
        ]).join('\n');
    }
    function designRulesApi() {
        return [
            '你是清框影边框设计师。只输出一个 JSON 数组，数组里有 4 个「图层边框」对象；不要输出解释，不要用 Markdown 代码块包裹。'
        ].concat(layerSchemaLines(), creativeMethodLines(), [
            '数组第 1~4 个对象依次对应本轮第 1~4 款的构图语法。',
            '文字必须能读：浅底深字、深底浅字；压图文字必须有实色底/色块垫底/阴影。'
        ]).join('\n');
    }
    function buildFullPrompt(promptText, base, avoid, photo, notes, rules, families) {
        const parts = [rules || designRules(), '', '====', '用户这次的要求：' + promptText];
        const fam = familyAssignment(families, !!base);
        if (fam) parts.push('', fam);
        if (photo && photo.text) {
            parts.push('', '照片速写（根据这张照片的真实像素统计，不是猜的）：');
            parts.push(photo.text);
            if (photo.advice) parts.push('排版与配色建议：' + photo.advice);
            parts.push('4 款都要照顾这张照片（文字放哪儿、底色明暗、留白给谁），但边框本身要立得住，不要做成融进照片的隐形框。');
        }
        if (notes) {
            parts.push('', '上一轮生成的方案体检不合格：');
            parts.push(String(notes).slice(0, 400));
            parts.push('这一轮逐条避开：压图文字必须有实色底/色块垫底/阴影保证对比（浅底深字 / 深底浅字）；照片别停在四边内缩的中间尺寸（要么贴边，要么做成 ≤40% 的小图版）；别用不透明层整张盖住照片。');
        }
        if (base) {
            const doc = { templateName: base.templateName || '参考方案', layers: layersOfDoc(base) || [] };
            parts.push('', '参考这一版（上一轮已生成的方案）。请保留它的骨架与照片槽位关系，按新要求做 4 个明显不同的变体：');
            parts.push(JSON.stringify(doc));
            parts.push('不要把参考版原样复制，也不要只改一行文字；4 个变体在照片位置、文字角色、母题上至少两项不同，不要只换配色或字号。');
        }
        if (Array.isArray(avoid) && avoid.length) {
            parts.push('', '避免与这些已生成过的方案重名或视觉雷同：' + avoid.slice(0, 8).join('、'));
        }
        return parts.join('\n');
    }

    function setGeneratingUI(on) {
        const btn = $('btnGenerate');
        if (btn) { btn.disabled = on; btn.textContent = on ? '生成中…' : '生成 4 款'; }
        const go = $('btnIterateGo'); if (go) go.disabled = on;
        const again = $('btnFrameAgain'); if (again) again.hidden = on || !lastRequest;
        const cancel = $('btnFrameCancel'); if (cancel) cancel.disabled = !on;
    }
    function hideIterate() {
        const box = $('frameIterate'); if (box) box.hidden = true;
        iterateBase = null;
    }
    // 让当前这一轮失效：停掉进度/按钮，后续到达的助手结果直接丢弃。
    function abandonRun() {
        runSeq++;
        generating = false;
        progress(false);
        setGeneratingUI(false);
        syncToolbar();
    }
    function cancelGeneration() {
        if (!generating) return;
        // 记住还在等的那次 agentPrompt：下一次生成前先等它收尾（最多 3 秒），
        // 避免在 ACP 会话里同时压两条 prompt。
        if (activePrompt) cancelWait = activePrompt.catch(() => {});
        abandonRun();
        if (agentKey && api().agentCancel) { try { api().agentCancel(agentKey); } catch (_) {} }
        setStatus('已停止生成。助手会话还在，可以直接重来或点「新会话」', '');
        hideError();
    }

    // ── 通道：本机助手 / OpenAI 兼容 API ──
    function channelOf() {
        if (window.QfsAiProvider && typeof window.QfsAiProvider.channel === 'function') return window.QfsAiProvider.channel();
        const el = $('frameChannel');
        return el && el.value === 'api' ? 'api' : 'local';
    }
    // 从模型回复里抠出 JSON 数组（宽容解析见 app-frame-plans.js）
    function parsePlansFromText(raw) {
        if (window.FramePlans && window.FramePlans.plansFromText) return window.FramePlans.plansFromText(raw);
        return [];
    }
    async function apiGenerate(text, base, avoid, photo, notes, families) {
        const P = window.QfsAiProvider;
        if (!P) throw new Error('API 通道未加载');
        const rules = designRulesApi();
        const full = buildFullPrompt(text, base, avoid, photo, notes, rules, families);
        const r = await P.chat([{ role: 'user', content: full }], { temperature: 0.9 });
        if (!r || !r.ok) throw new Error((r && r.error) || '模型调用失败');
        const plans = parsePlansFromText(r.content);
        if (!plans.length) {
            throw new Error('模型没有给出可解析的方案 JSON（' + String(r.content || '').slice(0, 120) + '…）');
        }
        return plans;
    }

    // ── 收下方案：体检 → 画廊 → 渲染 → 历史（本机助手与 API 通道共用） ──
    async function adoptPlans(plans, my, text, opts) {
        if (my !== runSeq) return;
        const brief = (lastBrief && lastBrief.brief) || null;
        const docs = (plans || []).map((p) => sanitizeLayerDoc(p)).filter(Boolean);
        if (!docs.length) throw new Error('模型没有给出可用的图层方案');
        // 生成之后先自己看一眼：能修的当场修（对比度/槽位/层级），修不了的照实提醒。
        const checked = docs.map((p) => {
            if (!window.FrameLint) return { ok: true, preset: p, lint: null };
            const res = window.FrameLint.checkAndFix(p, {
                bg: p.aiBackground || '#ffffff',
                photo: brief ? { ar: brief.ar, lumaMean: brief.luma.mean } : null
            });
            return { ok: res.usable, preset: res.doc, lint: res };
        });
        let picks = checked.filter((x) => x.ok);
        // 一款都站不住：带着体检结论自动重出一次，而不是把烂方案端给用户
        if (!picks.length && !opts.retry) {
            const why = checked.map((x) => (x.lint ? window.FrameLint.describe(x.lint.issues) : '')).join('\n')
                .replace(/\n+/g, '；').slice(0, 400);
            progress(true, '方案站不住，正在自动重出…');
            setTimeout(() => generate({ prompt: text, base: opts.base || null, avoid: (lastRequest && lastRequest.avoid) || [], retry: why }), 80);
            return;
        }
        if (!picks.length) picks = checked;   // 重出仍不合格：降级给出，卡片上标出来

        // 够不够大胆：几何算分。整批平均低于 42 说明又滑回「传统相框」，
        // 带原因重出一次（只重出一次，且「继续改」不重出，免得覆盖用户选中的骨架）。
        const briefForBold = brief ? { ar: brief.ar, lumaMean: brief.luma.mean } : null;
        const bolds = picks.map((g) => {
            if (!window.FrameLint || !window.FrameLint.boldness) return null;
            return window.FrameLint.boldness(g.preset, { photo: briefForBold });
        });
        const scored = bolds.filter(Boolean);
        const avg = scored.length ? Math.round(scored.reduce((n, b) => n + b.score, 0) / scored.length) : -1;
        if (!opts.base && !opts.boldRetry && avg >= 0 && avg < 42) {
            const hints = [];
            scored.forEach((b) => (b.hints || []).forEach((h) => { if (hints.indexOf(h) < 0) hints.push(h); }));
            const why = '上一批四款平均大胆度只有 ' + avg + ' 分（' + scored.map((b) => b.grade).join('/') + '），太像传统相框：'
                + hints.slice(0, 4).join('；') + '。这次四款都要按各自的硬指标做，照片必须贴边或满版，至少两款有 ≥0.14 的展示字压图，画布比例落在 0.6~1.8。';
            progress(true, '这批不够大胆（平均 ' + avg + ' 分），正在重出…');
            setTimeout(() => generate({ prompt: text, base: null, avoid: (lastRequest && lastRequest.avoid) || [], retry: why, boldRetry: true }), 80);
            return;
        }
        const at = Date.now();
        gallery = picks.map((g, i) => ({
            key: 'cur:' + my + ':' + i, preset: g.preset, dataUrl: null, isLayer: true,
            source: 'current', roundPrompt: text, roundAt: at, lint: g.lint, bold: bolds[i] || null
        }));
        previousNames = picks.map((g) => g.preset.templateName || '');
        view = 'current';
        syncTabs();
        renderGallery();
        // 逐张渲染到用户照片（走 photoSrc：调过色的照片预览也用同一条取源）
        const img = photoSource();
        progress(true, '正在套用你的照片…');
        let rendered = 0;
        for (let i = 0; i < gallery.length; i++) {
            if (my !== runSeq) return;
            gallery[i].dataUrl = renderFrameToUrl(gallery[i].preset, img);
            if (gallery[i].dataUrl) rendered++;
            renderGallery();
        }
        if (!rendered) throw new Error('样片渲染失败：照片未就绪或图层没有可用图元（展开「高级」看日志）');
        pushRound(text, picks.map((g) => g.preset));
        renderGallery();
        const fixedN = picks.reduce((n, g) => n + ((g.lint && g.lint.fixes.length) || 0), 0);
        setStatus('已生成 ' + gallery.length + ' 款' + (fixedN ? '，自动修正 ' + fixedN + ' 处' : '') + '，点卡片即可套用', 'ok');
    }
    async function generate(opts) {
        opts = opts || {};
        const promptEl = $('framePrompt');
        const text = String(opts.prompt != null ? opts.prompt : (promptEl && promptEl.value) || '').trim();
        const base = opts.base ? clone(opts.base) : null;
        if (generating) return;
        if (!text) { setStatus('先描述你想要的风格', 'bad'); return; }
        const channel = channelOf();
        const id = $('frameAgentSelect') && $('frameAgentSelect').value;
        if (channel === 'local' && !id) { setStatus('未检测到本机助手；也可以在「高级」里改用 API 通道', 'bad'); return; }
        if (channel === 'api' && !(window.QfsAiProvider && window.QfsAiProvider.ready())) {
            setStatus('API 通道还没配好：高级 → 接口地址 / Key / 模型', 'bad');
            return;
        }
        hideError();
        hideIterate();
        generating = true;
        const my = ++runSeq;
        lastRequest = { prompt: text, base: base ? clone(base) : null, avoid: (opts.avoid || previousNames).slice(0, 8) };
        currentPrompt = text;
        // 每轮只抽一次构图语法：之前 API 通道抽一次、buildFullPrompt 又抽一次，
        // 一条提示里出现两组互相冲突的「本轮四款」，模型只能二选一，四族就散了。
        const families = Array.isArray(opts.families) && opts.families.length ? opts.families : pickFamilies();
        setGeneratingUI(true);
        progress(true, base ? '正在基于这一款改 4 个变体…' : '正在洗 4 款样片…');
        agentStream = '';
        if ($('frameAgentOut')) $('frameAgentOut').textContent = '';
        try {
            const photo = lastBrief || briefOf();
            // API 通道：不碰本机助手会话与文件，直接让模型回 4 个 JSON
            if (channel === 'api') {
                progress(true, base ? '正在基于这一款改 4 个变体…' : '正在让模型出 4 款…');
                const plans = await apiGenerate(text, base, lastRequest.avoid, photo, opts.retry, families);
                if (my !== runSeq) return;
                await adoptPlans(plans, my, text, opts);
                return;
            }
            // 上一次被停止的 prompt 可能还没收尾：先等它（最多 3 秒），别在 ACP 会话里并发压两条。
            if (cancelWait) {
                progress(true, '正在收回上一轮…');
                try { await Promise.race([cancelWait, new Promise((res) => setTimeout(res, 3000))]); } catch (_) {}
                cancelWait = null;
                if (my !== runSeq) return;
                progress(true, base ? '正在基于这一款改 4 个变体…' : '正在洗 4 款样片…');
            }
            if (id !== currentAgent) await switchAgent(id);
            // 面板打开时的预启动可能还在进行：等同一次会话，别又起一个
            if (!agentKey && preloadPromise) { try { await preloadPromise; } catch (_) {} }
            if (my !== runSeq) return;
            const skill = await (api().framesSkill ? api().framesSkill() : Promise.resolve({ text: '' }));
            const rules = designRules();
            const ready = await ensureAgentSession(id, skill.text || '', rules);
            if (!ready) throw new Error('已切换助手，请重新生成');
            if (my !== runSeq) return;
            // 清掉上一轮的约定文件，避免读到旧方案
            if (api().framesRemove) for (const n of ['a1.json', 'a2.json', 'a3.json', 'a4.json']) await api().framesRemove(n);
            if (my !== runSeq) return;
            // 记录生成前的文件内容：目录里可能还留着更早的方案，不能把它们当成本轮结果
            const before = new Map();
            if (api().framesList && api().framesRead) {
                for (const n of ((await api().framesList()) || [])) {
                    const f = await api().framesRead(n);
                    if (f && typeof f.text === 'string') before.set(n, f.text);
                }
            }
            if (my !== runSeq) return;
            progress(true, base ? '正在改 4 个变体…' : '正在洗 4 款样片…');
            const fullPrompt = buildFullPrompt(text, base, lastRequest.avoid, photo, opts.retry, undefined, families);
            const p = api().agentPrompt ? api().agentPrompt(agentKey, fullPrompt) : Promise.resolve(null);
            activePrompt = p;
            let r;
            try { r = await p; } finally { if (activePrompt === p) activePrompt = null; }
            if (my !== runSeq) return;
            if (!r || !r.ok) throw new Error((r && r.error) || '生成失败');
            // 读回本轮生成的方案：先按约定名 a1-a4，再补本轮新建/改过的文件。
            // 每个都 sanitize（自动修正未知风格/越界参数），不再因小错整款丢弃。
            progress(true, '正在读回方案…');
            const candidates = ['a1.json', 'a2.json', 'a3.json', 'a4.json'];
            const all = api().framesList ? (await api().framesList()) : [];
            for (const n of (all || [])) {
                if (candidates.includes(n)) continue;
                const f = await api().framesRead(n);
                if (f && before.get(n) !== f.text) candidates.push(n);
            }
            if (my !== runSeq) return;
            const found = [];
            let seen = 0;
            for (const n of candidates) {
                const f = await api().framesRead(n);
                if (!f) continue;
                const p = parse(f.text);
                if (!p.ok) continue;
                seen++;
                // 只收图层边框：退回旧预设等于「拿现成风格改文字」，这正是要修的问题
                const layerDoc = sanitizeLayerDoc(p.t);
                if (!layerDoc) continue;
                found.push({ name: f.name, preset: layerDoc, dataUrl: null, isLayer: true });
                if (found.length >= 4) break;
            }
            if (my !== runSeq) return;
            if (!found.length) {
                const tail = (agentStream || '').slice(-300);
                const why = seen ? `助手写了 ${seen} 个 JSON，但没有一个含有效图层。` : '助手没有产出可解析的边框文件。';
                throw new Error(why + (tail ? '日志：' + tail : '展开「高级」看日志。'));
            }
            if (my !== runSeq) return;
            await adoptPlans(found.map((g) => g.preset), my, text, opts);
        } catch (e) {
            if (my !== runSeq) return;
            const msg = e && e.message ? e.message : '生成失败';
            // 会话已死（助手进程退出/被关掉）：清掉会话，重试时自动重建，而不是一直撞同一堵墙。
            if (agentKey && /会话不存在|进程已退出|已关闭|closed/i.test(msg)) {
                try { api().agentClose && api().agentClose(agentKey); } catch (_) {}
                agentKey = null;
            }
            showError(msg);
        } finally {
            if (my === runSeq) {
                generating = false;
                progress(false);
                setGeneratingUI(false);
                syncToolbar();
            }
        }
    }

    // ── 失败可视化 ──
    function showError(msg) {
        setStatus(msg, 'bad');
        const box = $('frameError'); const m = $('frameErrorMsg'); const log = $('frameErrorLog');
        if (m) m.textContent = msg || '生成失败';
        if (log) { log.textContent = (agentStream || '（助手没有输出）').slice(-4000); log.hidden = true; }
        if (box) box.hidden = false;
        const lg = $('btnFrameErrLog'); if (lg) lg.textContent = '查看日志';
        syncToolbar();
    }
    function hideError() {
        const box = $('frameError'); if (box) box.hidden = true;
    }

    // ── 基于某一款继续改 ──
    function openIterate(entry) {
        if (!entry || !entry.isLayer) { setStatus('这一款不是图层边框，不能继续改', 'bad'); return; }
        iterateBase = entry;
        const nm = $('frameIterateName'); if (nm) nm.textContent = entry.preset.templateName || '方案';
        const input = $('frameIterateText'); if (input) input.value = '';
        const box = $('frameIterate'); if (box) { box.hidden = false; if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' }); }
        if (input) input.focus();
        setStatus('可以点常用方向，或自己写一句再生成');
    }
    function iterateWith(instruction) {
        if (generating) return;
        const base = iterateBase;
        if (!base) return;
        const txt = String(instruction || '').trim();
        if (!txt) { setStatus('先说一句想怎么改', 'bad'); return; }
        generate({ prompt: txt, base: base.preset, avoid: [base.preset.templateName].concat(previousNames) });
    }
    const ITER_HINTS = {
        color: '换一套更协调、更有质感的配色，保持版式与照片槽位不变',
        space: '留白多一点，整体更透气，保持版式与配色关系',
        simple: '更简洁：去掉多余装饰，只保留必要的线条与文字',
        date: '在底部加入日期/相机参数样式的文字，注意不要溢出画面',
        film: '更像胶片：暖色调、轻颗粒感、细描边，保持版式'
    };

    // ── 大图预览 / 原图对比 ──
    function openLightbox(entry) {
        if (!entry) return;
        lbEntry = entry;
        const box = $('frameLightbox'); if (!box) return;
        const nm = $('frameLightboxName'); if (nm) nm.textContent = entry.preset.templateName || '方案';
        lbPreview = renderFrameToUrl(entry.preset, photoSource(), { maxEdge: 1600 }) || entry.dataUrl || '';
        lbOriginal = photoDataUrl();
        const img = $('frameLightboxImg'); if (img) img.src = lbPreview;
        setLbCompare(false);
        updateLbFav();
        const save = $('btnFrameLightboxSave'); if (save) save.textContent = '保存为模板';
        box.hidden = false;
    }
    function closeLightbox() {
        const box = $('frameLightbox'); if (box) box.hidden = true;
        setLbCompare(false);
        lbEntry = null;
    }
    function setLbCompare(on) {
        const img = $('frameLightboxImg'); if (!img) return;
        if (on && lbOriginal) img.src = lbOriginal;
        else img.src = lbPreview;
        const btn = $('btnFrameLightboxCompare');
        if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    function updateLbFav() {
        const btn = $('btnFrameLightboxFav'); if (!btn || !lbEntry) return;
        const on = isFavDoc(lbEntry.preset);
        btn.textContent = on ? '已收藏 ★' : '收藏';
        btn.classList.toggle('active', on);
    }
    async function saveAsTemplate(entry) {
        if (!entry) return;
        const inst = window.App || app;
        const layers = layersOfDoc(entry.preset);
        if (!layers) { setStatus('只有图层边框能保存为模板', 'bad'); return; }
        const def = entry.preset.templateName || 'AI 边框';
        let name = null;
        if (inst && typeof inst.promptText === 'function') name = await inst.promptText('保存为样式模板（之后可在「样式模板」列表找到）', def);
        else name = window.prompt('保存为模板', def);
        if (name == null) return;
        name = String(name).trim();
        if (!name) { setStatus('模板名不能为空', 'bad'); return; }
        const doc = {
            templateName: name,
            aiLayers: clone(layers),
            aiBackground: typeof entry.preset.aiBackground === 'string' ? entry.preset.aiBackground : '#ffffff'
        };
        const r = api().saveTemplate ? await api().saveTemplate(name, doc) : null;
        if (r && r.ok) {
            setStatus(`已保存模板「${name}」`, 'ok');
            if (inst && typeof inst.refreshTemplates === 'function') { try { inst.refreshTemplates(); } catch (_) {} }
            const btn = $('btnFrameLightboxSave');
            if (btn) { btn.textContent = '已保存 ✓'; setTimeout(() => { if (btn.textContent === '已保存 ✓') btn.textContent = '保存为模板'; }, 1800); }
        } else {
            setStatus('保存失败：' + ((r && (r.error || r.message)) || '未知错误'), 'bad');
        }
    }

    // ── 套用后微调：留白 / 底色 / 文字 ──
    function colorInputValue(c) {
        const h = String(c || '').replace('#', '').trim();
        if (/^[0-9a-f]{3}$/i.test(h)) return '#' + h.split('').map((x) => x + x).join('');
        if (/^[0-9a-f]{6}/i.test(h)) return '#' + h.slice(0, 6);
        if (/^[0-9a-f]{8}/i.test(h)) return '#' + h.slice(0, 6);
        return '#ffffff';
    }
    function refreshTweakPanel(forceBase) {
        const inst = window.App || app;
        const tpl = inst && inst.template;
        const layers = tpl && Array.isArray(tpl.aiLayers) ? tpl.aiLayers : null;
        const box = $('frameTweak');
        if (!layers || !layers.length) {
            if (box) box.hidden = true;
            applied = null;
            syncToolbar();
            return;
        }
        if (forceBase || !applied) {
            applied = {
                key: (applied && applied.key) || '',
                layers: clone(layers),
                bg: tpl.aiBackground || '#ffffff',
                name: tpl.templateName || 'AI 边框',
                textEdits: {}, textColors: {}
            };
        }
        if (box) box.hidden = false;
        const nm = $('frameTweakName'); if (nm) nm.textContent = applied.name;
        const bg = $('frameTweakBg'); if (bg) bg.value = colorInputValue(applied.bg);
        const pad = $('frameTweakPad'); if (pad) pad.value = '0';
        const out = $('frameTweakPadVal'); if (out) out.textContent = '0%';
        renderTweakTexts();
        syncToolbar();
    }
    function renderTweakTexts() {
        const box = $('frameTweakTexts'); if (!box) return;
        box.innerHTML = '';
        const texts = [];
        (applied ? applied.layers : []).forEach((l, i) => { if (l && l.type === 'text') texts.push({ l, i }); });
        if (!texts.length) { box.hidden = true; return; }
        box.hidden = false;
        const label = document.createElement('span');
        label.className = 'frame-tweak-texts-label'; label.textContent = '文字';
        box.appendChild(label);
        texts.slice(0, 12).forEach(({ l, i }) => {
            const row = document.createElement('span'); row.className = 'frame-tweak-text';
            const inp = document.createElement('input');
            inp.type = 'text'; inp.dataset.layer = String(i); inp.title = '修改这段文字';
            inp.value = l.text == null ? '' : String(l.text);
            inp.addEventListener('input', () => {
                if (!applied) return;
                applied.textEdits[i] = inp.value;
                scheduleTweak();
            });
            const col = document.createElement('input');
            col.type = 'color'; col.dataset.layer = String(i); col.title = '文字颜色';
            col.value = colorInputValue(l.color || '#ffffff');
            col.addEventListener('change', () => {
                if (!applied) return;
                applied.textColors[i] = col.value;
                applyTweak();
            });
            row.appendChild(inp); row.appendChild(col);
            box.appendChild(row);
        });
    }
    function scheduleTweak() {
        clearTimeout(tweakTimer);
        tweakTimer = setTimeout(() => { tweakTimer = 0; applyTweak(); }, 120);
    }
    // 每次从「套用时拿到的基准图层」重算，而不是在上一帧上叠加，拖动滑块不会累积误差。
    function applyTweak() {
        const inst = window.App || app;
        if (!applied || !inst || !inst.template) return;
        if (!tweakUndoPushed && !inst._gesture) {
            if (typeof inst.pushUndo === 'function') { try { inst.pushUndo(); } catch (_) {} }
            tweakUndoPushed = true;
        }
        const layers = clone(applied.layers);
        const padEl = $('frameTweakPad');
        const pad = padEl ? (Number(padEl.value) || 0) : 0;
        if (pad) {
            const pi = layers.findIndex((l) => l && l.type === 'photo');
            if (pi >= 0) {
                const l = layers[pi];
                const d = pad / 100 * 0.15;
                const x = Number(l.x) || 0, y = Number(l.y) || 0;
                const w = Number(l.w) || 0, h = Number(l.h) || 0;
                const nx = Math.max(0, Math.min(0.98, x + d));
                const ny = Math.max(0, Math.min(0.98, y + d));
                l.x = nx; l.y = ny;
                l.w = Math.max(0.05, Math.min(w - d * 2, 1 - nx));
                l.h = Math.max(0.05, Math.min(h - d * 2, 1 - ny));
            }
        }
        for (const k of Object.keys(applied.textEdits || {})) {
            const l = layers[Number(k)];
            if (l && l.type === 'text') l.text = applied.textEdits[k];
        }
        for (const k of Object.keys(applied.textColors || {})) {
            const l = layers[Number(k)];
            if (l && l.type === 'text') l.color = applied.textColors[k];
        }
        inst.template.aiLayers = layers;
        const bgEl = $('frameTweakBg');
        if (bgEl) inst.template.aiBackground = bgEl.value;
        if (typeof inst.saveCurrentTemplate === 'function') inst.saveCurrentTemplate();
        if (typeof inst.scheduleRender === 'function') inst.scheduleRender(true);
        if (typeof inst.autoSaveState === 'function') { try { inst.autoSaveState(); } catch (_) {} }
    }
    function resetTweak() {
        if (!applied) return;
        const pad = $('frameTweakPad'); if (pad) pad.value = '0';
        const out = $('frameTweakPadVal'); if (out) out.textContent = '0%';
        const bg = $('frameTweakBg'); if (bg) bg.value = colorInputValue(applied.bg);
        applied.textEdits = {}; applied.textColors = {};
        renderTweakTexts();
        tweakUndoPushed = false;
        applyTweak();
        setStatus('已还原微调', 'ok');
    }

    // ── 工具栏 / 视图 ──
    function syncTabs() {
        document.querySelectorAll('.frame-tab').forEach((b) => {
            const on = b.dataset.view === view;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
    }
    function syncToolbar() {
        const inst = window.App || app;
        const sel = (inst && Array.isArray(inst.selectedIdx)) ? inst.selectedIdx : [];
        const targets = sel.filter((i) => i !== (inst && inst.currentIdx)).filter((i) => inst && Array.isArray(inst.images) && i >= 0 && i < inst.images.length);
        const wrap = $('frameBatchWrap');
        if (wrap) {
            wrap.hidden = targets.length < 1;
            const lbl = $('frameBatchLabel');
            if (lbl) lbl.textContent = '套用到选中的另外 ' + targets.length + ' 张';
            const cb = $('frameBatchApply');
            if (targets.length < 1 && cb) cb.checked = false;
        }
        const again = $('btnFrameAgain');
        if (again) again.hidden = generating || !lastRequest;
        const tt = $('btnFrameTweakToggle');
        if (tt) tt.hidden = !(inst && inst.template && Array.isArray(inst.template.aiLayers) && inst.template.aiLayers.length);
        updateFavCount();
    }

    // ── 助手会话（ACP）──
    function updateText(u) {
        if (!u) return '';
        const t = u.type || u.sessionUpdate || '';
        if (t === 'agent_message_chunk' || t === 'message_chunk') { const c = u.content || {}; return typeof c === 'string' ? c : (c.text || ''); }
        if (t === 'tool_call' || t === 'toolCall') return '\n[工具] ' + (u.title || u.name || '') + '\n';
        if (t === 'error' || t === 'session_error') return '\n[错误] ' + (u.message || u.error || '助手报错') + '\n';
        return '';
    }
    async function ensureAgentSession(id, skillText, rules) {
        if (agentKey) return true;
        const r = await (api().agentStart ? api().agentStart(id, skillText, rules) : null);
        if (!r || !r.ok) throw new Error((r && r.error) || '无法启动助手会话');
        // 启动期间用户切了助手：这个会话已经过时，关掉，别把 prompt 发到旧助手
        if (currentAgent && id !== currentAgent) {
            if (api().agentClose) { try { await api().agentClose(r.key); } catch (_) {} }
            return false;
        }
        agentKey = r.key; agentModelId = r.modelId || 'model';
        populateModels(r.models || []);
        // 把记忆的模型应用到新会话（若有）；失败要告知，不能标签写着「已记住」但会话跑默认模型
        if (currentModel && api().agentSetModel) {
            try {
                const mr = await api().agentSetModel(agentKey, agentModelId, currentModel);
                if (mr && mr.ok === false) setStatus('模型记忆未生效：' + (mr.error || mr.message || '助手拒绝'), 'bad');
            } catch (e) {
                setStatus('模型记忆未生效：' + (e && e.message ? e.message : e), 'bad');
            }
        }
        if (!unwatchAgent && api().onAgentEvent) {
            unwatchAgent = api().onAgentEvent((payload) => {
                if (!agentKey || payload.key !== agentKey) return;
                agentStream = (agentStream + updateText(payload.update)).slice(-16000);
                const out = $('frameAgentOut'); if (out) out.textContent = agentStream.slice(-4000);
            });
        }
        return true;
    }
    function modelGroup(m) {
        const v = String(m.value || ''); let p = v.split('/')[0] || '模型';
        if (p === 'openrouter' && v.split('/')[1]) p = 'openrouter / ' + v.split('/')[1];
        return p;
    }
    function populateModels(models) {
        agentModels = Array.isArray(models) ? models.slice() : [];
        const label = $('frameModelLabel');
        if (!agentModels.length) { if (label) label.textContent = '默认模型'; return; }
        const cur = (currentModel && agentModels.find((m) => m.value === currentModel))
            || agentModels.find((m) => m.current) || agentModels[0];
        currentModel = cur ? cur.value : ''; if (label) label.textContent = cur ? cur.name : '默认模型';
        // 记忆的模型可能已下线：把实际生效的模型写回，下次打开标签和会话一致
        if (currentModel && currentAgent) writeStore(modelKeyOf(currentAgent), currentModel);
        renderModelList('');
    }
    function renderModelList(query) {
        const list = $('frameModelList'); if (!list) return;
        const q = String(query || '').trim().toLowerCase();
        const matches = agentModels.filter((m) => !q || String(m.name).toLowerCase().includes(q) || String(m.value).toLowerCase().includes(q));
        list.innerHTML = '';
        if (!matches.length) { const em = document.createElement('div'); em.className = 'frame-model-empty'; em.textContent = '没有匹配的模型'; list.appendChild(em); return; }
        const groups = new Map();
        for (const m of matches) { const g = modelGroup(m); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(m); }
        for (const [g, ms] of groups) {
            const h = document.createElement('div'); h.className = 'frame-model-group'; h.textContent = g; list.appendChild(h);
            for (const m of ms) {
                const b = document.createElement('button'); b.type = 'button';
                b.className = 'frame-model-opt' + (m.value === currentModel ? ' active' : '');
                b.textContent = m.name; b.title = m.value;
                b.addEventListener('click', () => chooseModel(m)); list.appendChild(b);
            }
        }
    }
    async function chooseModel(m) {
        currentModel = m.value;
        if (currentAgent) writeStore(modelKeyOf(currentAgent), m.value);
        writeStore(MODEL_KEY, m.value);
        const label = $('frameModelLabel'); if (label) label.textContent = m.name;
        renderModelList($('frameModelSearch') && $('frameModelSearch').value); closeModelPop();
        if (agentKey && api().agentSetModel) {
            const r = await api().agentSetModel(agentKey, agentModelId, m.value);
            setStatus(r && r.ok ? ('模型：' + m.name) : '(下次发送生效)', r && r.ok ? 'ok' : '');
        }
    }
    function openModelPop() {
        const pop = $('frameModelPop'); if (!pop) return; pop.hidden = false;
        const btn = $('btnFrameModel'); if (btn) btn.setAttribute('aria-expanded', 'true');
        const s = $('frameModelSearch'); if (s) { s.value = ''; renderModelList(''); s.focus(); }
        if (!modelPopUnwatch) {
            modelPopUnwatch = (e) => { const wrap = document.querySelector('.frame-model-wrap'); if (wrap && !wrap.contains(e.target)) closeModelPop(); };
            document.addEventListener('mousedown', modelPopUnwatch);
        }
    }
    function closeModelPop() {
        const pop = $('frameModelPop'); if (pop) pop.hidden = true;
        const btn = $('btnFrameModel'); if (btn) btn.setAttribute('aria-expanded', 'false');
    }
    async function preloadSession(id) {
        if (agentKey) return true;
        // 打开面板立刻点生成会同时触发预启动：同一个助手的 in-flight 会话直接复用，避免起两个
        if (preloadPromise) {
            if (preloadFor === id) return preloadPromise;
            try { await preloadPromise; } catch (_) {}
            if (agentKey) return true;
        }
        preloadFor = id;
        preloadPromise = (async () => {
            const skill = await (api().framesSkill ? api().framesSkill() : Promise.resolve({ text: '' }));
            return ensureAgentSession(id, skill.text || '', designRules());
        })().catch(() => { /* 预启动失败不阻塞，生成时会再报错 */ }).finally(() => {
            if (preloadFor === id) { preloadPromise = null; preloadFor = ''; }
        });
        return preloadPromise;
    }
    async function switchAgent(id) {
        currentAgent = id || '';
        writeStore(AGENT_KEY, currentAgent);
        currentModel = currentAgent ? modelForAgent(currentAgent) : '';
    }
    async function detectAgents() {
        const sel = $('frameAgentSelect'); if (!sel || !api().agentDetect) return;
        const list = await api().agentDetect(); sel.innerHTML = '';
        const installed = (list || []).filter((a) => a.installed);
        if (!installed.length) {
            const o = document.createElement('option'); o.value = ''; o.textContent = '未检测到本机助手'; sel.appendChild(o);
            const hint = $('frameAgentHint');
            if (hint) hint.textContent = channelOf() === 'api' ? '当前走 API 通道，本机助手可以不装' : '在「高级」里：需先装 Claude Code / Codex / OpenCode';
            return;
        }
        for (const a of installed) { const o = document.createElement('option'); o.value = a.id; o.textContent = a.name; sel.appendChild(o); }
        const hint = $('frameAgentHint'); if (hint) hint.textContent = '已就绪 ' + installed.length + ' 个助手';
        // 沿用上次的选择；没装/没记忆才回落到第一个
        const pick = installed.find((a) => a.id === currentAgent) || installed[0];
        await switchAgent(pick.id);
        sel.value = pick.id;
        const label = $('frameModelLabel');
        // 已经为同一个助手建好会话：直接回显当前模型，别把标签停在「加载模型中…」
        if (agentKey && agentModels.length) populateModels(agentModels);
        else { if (label) label.textContent = '加载模型中…'; preloadSession(pick.id); }
    }

    // ── 高级区：文件 / JSON / 体检 ──
    async function loadList() {
        const list = api().framesList ? await api().framesList() : [];
        const box = $('frameList'); if (!box) return; box.innerHTML = '';
        for (const name of (list || [])) {
            const b = document.createElement('button'); b.type = 'button';
            b.className = 'frame-file' + (current && current.name === name ? ' active' : '');
            b.textContent = name; b.title = name; b.addEventListener('click', () => select(name)); box.appendChild(b);
        }
        if (!list || !list.length) { const em = document.createElement('div'); em.className = 'frame-preview-empty'; em.textContent = '还没有边框文件'; box.appendChild(em); }
        const dir = await (api().framesDir ? api().framesDir() : Promise.resolve({})); const d = $('frameDir'); if (d) d.textContent = dir.path || '';
    }
    async function select(name) {
        const r = await (api().framesRead ? api().framesRead(name) : null); if (!r) return;
        current = { name: r.name }; $('frameText').value = r.text; loadList();
    }
    async function save() {
        if (!current) { setStatus('先选一个文件', 'bad'); return; }
        const text = $('frameText').value; const p = parse(text);
        if (!p.ok) { setStatus(p.issues[0], 'bad'); return; }
        const r = await (api().framesSave ? api().framesSave(current.name, text) : null);
        setStatus(r && r.ok ? '已保存' : ((r && r.message) || '保存失败'), r && r.ok ? 'ok' : 'bad');
    }
    function doCheck() {
        const p = parse($('frameText').value); if (!p.ok) { setStatus(p.issues.join('；'), 'bad'); return; }
        const issues = inspect(p.t);
        setStatus(issues.length ? ('体检：' + issues.join('；')) : '体检通过', issues.length ? 'bad' : 'ok');
    }
    function applyCurrent() {
        const p = parse($('frameText').value); if (!p.ok) { setStatus(p.issues[0], 'bad'); return; }
        const issues = inspect(p.t); if (issues.length) { setStatus('先修：' + issues[0], 'bad'); return; }
        const inst = window.App || app;
        if (!inst || typeof inst.applyPresetToCurrent !== 'function') return;
        const docLayers = layersOfDoc(p.t);
        if (docLayers) {
            // 高级区粘贴的图层 JSON 也按「模板」应用，不再走预设路径套成默认模板
            const layers = docLayers.map((l) => window.AiLayers ? window.AiLayers.normalize(l) : l).filter(Boolean);
            const bg = typeof p.t.aiBackground === 'string' ? p.t.aiBackground : '#ffffff';
            const name = p.t.templateName || 'AI 边框';
            const ok = inst.applyPresetToCurrent({ templateName: name, aiLayers: layers, aiBackground: bg });
            if (ok === false) { setStatus('应用失败', 'bad'); return; }
            applied = { key: 'adv:' + uid(), layers: clone(layers), bg, name, textEdits: {}, textColors: {} };
            tweakUndoPushed = false;
            refreshTweakPanel(true);
            setStatus('已应用', 'ok');
            return;
        }
        inst.applyPresetToCurrent(p.t);
        applied = null; refreshTweakPanel(true);
        setStatus('已应用', 'ok');
    }

    // ── 生命周期 ──
    async function open() {
        if (!modal) return; modal.style.display = 'flex';
        refreshSamplePhotos();
        refreshBrief();
        if (window.QfsAiProvider) syncChannelUI();
        // 关掉面板期间可能调过色/裁切：历史与收藏的预览都按当前照片重画，不能拿旧缓存。
        previewCache.clear();
        if (gallery.length) {
            const img = photoSource();
            gallery.forEach((g) => {
                const url = renderFrameToUrl(g.preset, img);
                if (url) g.dataUrl = url;
            });
        }
        syncTabs();
        syncToolbar();
        refreshTweakPanel(true);
        renderGallery();
        detectAgents(); loadList();
        if (api().framesWatch) api().framesWatch();
    }
    function close() { closeLightbox(); hideIterate(); if (modal) modal.style.display = 'none'; }

    // 画布上直接拖动/双击改字之后，面板里那份「基准图层」已经过时。
    // 不刷新的话，下一次改底色会把用户的拖动结果覆盖掉。
    function syncFromCanvas() {
        if (!modal || modal.style.display !== 'flex') { applied = null; return; }
        refreshTweakPanel(true);
    }

    // ── 通道配置 UI ──
    function syncChannelUI() {
        const P = window.QfsAiProvider;
        const ch = P ? P.channel() : 'local';
        const sel = $('frameChannel');
        if (sel) sel.value = ch;
        const box = $('frameApiCfg');
        if (box) box.hidden = ch !== 'api';
        const cfg = P ? P.load() : { baseUrl: '', apiKey: '', model: '' };
        const base = $('frameApiBase'), key = $('frameApiKey'), model = $('frameApiModel');
        if (base && base.value !== cfg.baseUrl) base.value = cfg.baseUrl;
        if (key && !key.value) key.value = cfg.apiKey;
        if (model && model.value !== cfg.model) model.value = cfg.model;
        const hint = $('frameChannelHint');
        if (hint) {
            if (ch !== 'api') hint.textContent = '用本机已装的助手，不花 Key';
            else if (P && P.ready(cfg)) hint.textContent = '已配置 · ' + P.mask(cfg.apiKey) + ' · ' + cfg.model;
            else hint.textContent = '填地址 / Key / 模型，免装 CLI';
        }
        const note = $('frameApiNote');
        if (note) {
            note.textContent = (P && P.ready(cfg))
                ? '当前：' + (cfg.baseUrl || '内置默认地址') + ' · ' + cfg.model
                : '任何 OpenAI 兼容接口都行：官方 / 中转 / 自建网关。填完先用「测试连接」验一次。打包版还可以用环境变量 QFS_AI_PROXY 指到内置中转。';
        }
    }
    function apiFormCfg() {
        return {
            baseUrl: ($('frameApiBase') && $('frameApiBase').value) || '',
            apiKey: ($('frameApiKey') && $('frameApiKey').value) || '',
            model: ($('frameApiModel') && $('frameApiModel').value) || ''
        };
    }
    function bindChannelUI() {
        const P = window.QfsAiProvider;
        if (!P) return;
        syncChannelUI();
        const sel = $('frameChannel');
        if (sel) sel.addEventListener('change', () => { P.setChannel(sel.value); syncChannelUI(); });
        for (const id of ['frameApiBase', 'frameApiKey', 'frameApiModel']) {
            const el = $(id); if (!el) continue;
            el.addEventListener('change', () => { P.save(apiFormCfg()); syncChannelUI(); });
        }
        const test = $('btnFrameApiTest');
        if (test) test.addEventListener('click', async () => {
            P.save(apiFormCfg());
            syncChannelUI();
            const old = test.textContent;
            test.disabled = true; test.textContent = '测试中…';
            try {
                const r = await P.test();
                if (r && r.ok) setStatus('API 通道可用 · ' + (r.model || '') + ' · 回复「' + (r.text || '') + '」', 'ok');
                else setStatus('API 通道不可用：' + ((r && r.error) || '未知原因'), 'bad');
            } finally {
                test.disabled = false; test.textContent = old;
            }
        });
    }

    function init(a) {
        app = a; modal = $('frameModal');
        if (a) a._syncAiLayerEdit = syncFromCanvas;
        if (!modal || modal.dataset.bound === '1') return; modal.dataset.bound = '1';
        bindChannelUI();
        $('frameModalClose').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        $('btnGenerate').addEventListener('click', () => generate({ prompt: $('framePrompt').value }));
        $('framePrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) generate({ prompt: $('framePrompt').value }); });
        $('btnFrameCancel').addEventListener('click', cancelGeneration);
        $('btnFrameAgain').addEventListener('click', () => { if (lastRequest) generate(lastRequest); });
        $('frameSamplePhoto').addEventListener('change', () => {
            // 换示例照片：用同一批方案即时重渲染，用户能比较不同照片的效果
            previewCache.clear();
            refreshBrief();
            if (!gallery.length) { if (view !== 'current') renderGallery(); return; }
            const img = photoSource();
            gallery.forEach((g) => { g.dataUrl = renderFrameToUrl(g.preset, img); });
            renderGallery();
            setStatus('已换成所选照片预览', 'ok');
        });
        document.querySelectorAll('.frame-tab').forEach((b) => {
            b.addEventListener('click', () => { view = b.dataset.view || 'current'; syncTabs(); renderGallery(); });
        });
        $('btnFrameTweakToggle').addEventListener('click', () => {
            const box = $('frameTweak'); if (!box) return;
            if (box.hidden) { if (!applied) refreshTweakPanel(true); else box.hidden = false; }
            else box.hidden = true;
        });
        $('btnTweakHide').addEventListener('click', () => { const box = $('frameTweak'); if (box) box.hidden = true; });
        $('btnFrameEditOnCanvas').addEventListener('click', () => {
            // 关掉面板才能点到画布；顺手把最上层的 AI 文字选中，
            // 用户不用先猜“点哪里”，直接拖/双击就能改。
            close();
            const inst = window.App || app;
            const layers = inst && inst.template && inst.template.aiLayers;
            if (!inst || !Array.isArray(layers) || !layers.length) return;
            let idx = -1;
            for (let i = layers.length - 1; i >= 0; i--) {
                if (layers[i] && layers[i].type === 'text') { idx = i; break; }
            }
            const sel = idx >= 0 ? layers[idx] : layers[layers.length - 1];
            inst.selectedEls = [{ kind: 'aiLayer', obj: sel, index: idx }];
            if (inst.refreshElList) inst.refreshElList();
            if (inst.scheduleRender) inst.scheduleRender(true);
            inst.setStatus && inst.setStatus('在画布上拖动这个元素移动，双击文字改字，拖四角缩放；Esc 取消选中');
        });
        $('btnTweakReset').addEventListener('click', resetTweak);
        const pad = $('frameTweakPad');
        if (pad) {
            pad.addEventListener('pointerdown', () => {
                const inst = window.App || app;
                if (inst && inst.image && inst.template && typeof inst.beginGesture === 'function') {
                    try { inst.beginGesture(); } catch (_) {}
                    tweakUndoPushed = true;
                }
            });
            pad.addEventListener('input', () => {
                const out = $('frameTweakPadVal'); if (out) out.textContent = pad.value + '%';
                scheduleTweak();
            });
            pad.addEventListener('change', () => {
                const inst = window.App || app;
                if (inst && typeof inst.endGesture === 'function') { try { inst.endGesture(); } catch (_) {} }
                applyTweak();
            });
        }
        const bg = $('frameTweakBg');
        if (bg) bg.addEventListener('change', applyTweak);
        $('btnFrameRetry').addEventListener('click', () => { if (lastRequest) { hideError(); generate(lastRequest); } });
        $('btnFrameErrLog').addEventListener('click', () => {
            const log = $('frameErrorLog'); const btn = $('btnFrameErrLog');
            if (!log) return;
            log.hidden = !log.hidden;
            if (btn) btn.textContent = log.hidden ? '查看日志' : '收起日志';
        });
        $('btnIterateCancel').addEventListener('click', hideIterate);
        $('btnIterateGo').addEventListener('click', () => iterateWith($('frameIterateText').value));
        $('frameIterateText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) iterateWith($('frameIterateText').value); });
        $('frameIterateChips').addEventListener('click', (e) => {
            const b = e.target && e.target.closest ? e.target.closest('[data-iter]') : null;
            if (!b) return;
            iterateWith(ITER_HINTS[b.dataset.iter] || b.textContent);
        });
        // 大图预览
        $('btnFrameLightboxClose').addEventListener('click', closeLightbox);
        $('frameLightboxBackdrop').addEventListener('click', closeLightbox);
        $('btnFrameLightboxApply').addEventListener('click', () => { const e = lbEntry; closeLightbox(); applyEntry(e); });
        $('btnFrameLightboxFav').addEventListener('click', () => { if (lbEntry) toggleFav(lbEntry); });
        $('btnFrameLightboxSave').addEventListener('click', () => { if (lbEntry) saveAsTemplate(lbEntry); });
        const cmp = $('btnFrameLightboxCompare');
        if (cmp) {
            cmp.addEventListener('pointerdown', () => setLbCompare(true));
            ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => cmp.addEventListener(ev, () => setLbCompare(false)));
            cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setLbCompare(true); } });
            cmp.addEventListener('keyup', () => setLbCompare(false));
            cmp.addEventListener('blur', () => setLbCompare(false));
        }
        document.addEventListener('keydown', (e) => {
            const lb = $('frameLightbox');
            if (e.key === 'Escape' && lb && !lb.hidden) { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
        }, true);
        $('btnFrameRefresh').addEventListener('click', () => { loadList(); setStatus('已刷新', 'ok'); });
        $('btnFrameOpenDir').addEventListener('click', () => api().framesOpenDir && api().framesOpenDir());
        $('btnFrameCopyDir').addEventListener('click', async () => {
            const d = await (api().framesDir ? api().framesDir() : Promise.resolve({}));
            if (d.path && navigator.clipboard) { try { await navigator.clipboard.writeText(d.path); setStatus('路径已复制', 'ok'); return; } catch (_) {} }
            setStatus(d.path || '', '');
        });
        $('btnFrameSave').addEventListener('click', save);
        $('btnFrameCheck').addEventListener('click', doCheck);
        $('btnFrameApply').addEventListener('click', applyCurrent);
        $('btnFrameModel').addEventListener('click', (e) => { e.stopPropagation(); const p = $('frameModelPop'); if (p && !p.hidden) closeModelPop(); else openModelPop(); });
        const fs = $('frameModelSearch'); if (fs) fs.addEventListener('input', () => renderModelList(fs.value));
        $('frameAgentSelect').addEventListener('change', async (e) => {
            if (generating) abandonRun();
            if (agentKey && api().agentClose) api().agentClose(agentKey);
            agentKey = null; agentModels = []; const label = $('frameModelLabel'); if (label) label.textContent = '加载模型中…';
            await switchAgent(e.target.value);
            preloadSession(e.target.value);
        });
        $('btnAgentNew').addEventListener('click', async () => {
            if (generating) abandonRun();
            if (agentKey && api().agentClose) api().agentClose(agentKey);
            agentKey = null; agentModels = []; const label = $('frameModelLabel'); if (label) label.textContent = '加载模型中…';
            const id = $('frameAgentSelect') && $('frameAgentSelect').value;
            await switchAgent(id);
            preloadSession(id);
        });
        // 离屏示例底图（无照片时预览用）
        try {
            const c = document.createElement('canvas'); c.width = 480; c.height = 620;
            const g = c.getContext('2d'); const grad = g.createLinearGradient(0, 0, 0, 620);
            grad.addColorStop(0, '#7ec8e3'); grad.addColorStop(.55, '#e78ba0'); grad.addColorStop(1, '#5b4c7a');
            g.fillStyle = grad; g.fillRect(0, 0, 480, 620);
            const im = new Image(); im.onload = () => { window.__qfsPhotoStub = im; }; im.src = c.toDataURL('image/png');
        } catch (_) {}
    }

    window.QfsFramePanel = { init, open, close, syncFromCanvas };
})();

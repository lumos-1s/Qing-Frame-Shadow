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
    let pendingGenerate = null;  // 首次引导期间暂存的生成请求，配好后自动续跑
    let tweakUndoPushed = false, tweakTimer = 0;
    let iterateBase = null;      // 继续改所基于的方案 entry
    let lbEntry = null, lbPreview = '', lbOriginal = '';
    // 生成方式：free = 模型/配方从零画图层；director = 从手工边框里挑 + 写文案。
    // 导演是「挑不出来」时的兜底，不做粘性记忆——每次打开面板都从 free 起，
    // 免得用户下次进来先看到一个自己没选过的模式。
    let genMode = 'free';
    // AI 破框正在跑：挡住重复点击，也用来防「生成中又切照片」把结果挂到别的图上。
    let breaking = false;
    // 发布开关：整个 AI 窗口本版不发布；窗口里的破框还要再等真实 Key 验过。
    // 只认 QfsFeatures 的默认值，别在这里再写一份，否则发版时容易漏改一处。
    function aiPanelOn() {
        return !!(window.QfsFeatures && window.QfsFeatures.on('aiPanel'));
    }
    function aiBreakOn() {
        return !!(window.QfsFeatures && window.QfsFeatures.on('aiBreak'));
    }
    // 关掉时要把入口、设置项、提示行一起收干净：只藏窗口按钮会留下工具栏上的
    // 一个可疑位置，只藏破框按钮会留下「图像模型」和「还差一个图像模型」。
    function applyFeatureGates() {
        const panelOn = aiPanelOn();
        const entry = $('btnFramePanel'); if (entry) entry.hidden = !panelOn;
        const on = panelOn && aiBreakOn();
        const btn = $('btnFrameBreak'); if (btn) btn.hidden = !on;
        const field = $('frameImageModel');
        const wrap = field && field.closest ? field.closest('.frame-api-field') : null;
        if (wrap) wrap.hidden = !on;
        const hint = $('frameImageHint'); if (hint) hint.hidden = !on;
    }
    // 错误块里的「重试」该重跑什么：生成失败重跑生成，破框失败重跑破框，
    // 否则点一下「重试」会莫名其妙地出一批边框。
    let errorRetry = null;
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
    // 换照片（含 AI 生成后主图变了）：缓存作废，已经出的卡片按新源图重画。
    // 不重画的话，主画布已经换成新图，面板里那几张卡还停在旧照片上。
    function refreshPhotoPreviews() {
        previewCache.clear();
        refreshBrief();
        if (!gallery.length) { if (view !== 'current') renderGallery(); return; }
        const img = photoSource();
        gallery.forEach((g) => { g.dataUrl = renderFrameToUrl(g.preset, img); });
        renderGallery();
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
    // 收藏/保存模板要存「此刻真正生效的版本」：套用后微调过、或在画布上拖过/改过字，
    // 画廊里那份生成原始数据已经不是用户看到的样子了。
    function effectivePreset(entry) {
        if (!entry) return null;
        if (!applied || applied.key !== entry.key || !Array.isArray(applied.layers)) return entry.preset;
        const doc = Object.assign({}, entry.preset, {
            templateName: applied.name || (entry.preset && entry.preset.templateName) || 'AI 边框',
            aiLayers: clone(applied.layers),
            aiBackground: applied.bg || '#ffffff'
        });
        // layers 优先于 aiLayers：留着旧 layers 会把微调结果整个盖掉。
        delete doc.layers;
        return doc;
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
            + '<div>点一个灵感，或自己说一句，AI 会先出 <b>4 款</b> 让你挑</div>'
            + '<div class="frame-gallery-empty-sub">套用后还能在画布上拖动、双击改字；没导入照片也能先看效果</div></div>';
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

        card.appendChild(imgBox);
        // 导演给的「为什么选这款」：一行到两行，鼠标悬停看全文。
        // 自由造型没有这句，不占位置。
        if (entry.why) {
            const why = document.createElement('div');
            why.className = 'frame-swatch-why';
            why.textContent = entry.why;
            why.title = entry.why;
            card.appendChild(why);
        }
        card.appendChild(foot);
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
        // 键盘 Enter/Space 激活卡片、大图里的「套用这款」都不会经过画布外的 click，
        // 必须显式取消旧选中，否则 selectedEls 会指向即将被替换的旧 aiLayers。
        if (typeof inst.clearElementSelection === 'function') inst.clearElementSelection({ silent: true });
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
        const preset = effectivePreset(entry);
        const k = docKey(preset);
        const i = st.favs.findIndex((f) => docKey(f.preset) === k);
        if (i >= 0) st.favs.splice(i, 1);
        else st.favs.unshift({ id: uid(), at: Date.now(), prompt: entry.roundPrompt || currentPrompt || '', preset: clone(preset) });
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
        if (btn) {
            btn.disabled = on;
            btn.textContent = on ? '生成中…' : (genMode === 'director' ? '让导演挑 4 款' : '生成 4 款');
        }
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

    // ── 通道：本地配方 / 本机助手 / OpenAI 兼容 API ──
    function channelOf() {
        if (window.QfsAiProvider && typeof window.QfsAiProvider.channel === 'function') return window.QfsAiProvider.channel('frame');
        const el = $('frameChannel');
        return el && el.value === 'api' ? 'api' : el && el.value === 'local' ? 'local' : 'recipe';
    }
    // 本地配方：不调模型、不联网、不等 JSON。照片比例 + 关键词 → 4 份排好的图层文档。
    // 这是默认通道，也是模型通道失败时的兜底——用户永远能先拿到 4 款能用的。
    function recipePlans(text, base) {
        const R = window.FrameRecipes;
        if (!R) throw new Error('本地配方没有加载，请重启应用');
        const info = lastBrief || briefOf();
        const brief = info && info.brief ? info.brief : null;
        const inst = window.App || app;
        const im = inst && inst.image;
        const exif = (im && im.exif) || (inst && inst.image && inst.image.exif) || {};
        const seed = Date.now();
        return base
            ? R.variantsOf(base, { brief: brief, exif: exif, prompt: text, seed: seed })
            : R.designPlans({ brief: brief, exif: exif, prompt: text, seed: seed, count: 4 });
    }
    // 灵感模板：一句话就是一条完整方向，用户不用学提示词写法。
    const IDEA_PROMPTS = {
        poster: '做成美术馆展览海报：照片贴边放大，超大标题直接压在照片上，底部一行小字写展期和地点',
        film: '做成胶片边框：暖调、轻颗粒，照片像一格底片，底部留一条手写日期和相机参数',
        minimal: '极简留白：大量空白，照片用细线框住，标题小而克制，整体安静',
        journal: '手账拼贴：照片旁有胶带、错位纸片和手写短句，像旅行手账的一页',
        archive: '复古档案卡：牛皮纸底色，打字机字体，编号、表格线和一枚小印章',
        magazine: '时尚杂志封面：大标题压在照片上，带刊号、条码和一两行封面导读'
    };
    function aiSetupStatus() {
        const P = window.QfsAiProvider;
        if (channelOf() === 'recipe') return { ok: true, text: '本地配方 · 免配置、不联网，点生成秒出 4 款' };
        if (channelOf() === 'api') {
            const cfg = P && P.load ? P.load() : {};
            const ok = !!(P && P.ready && P.ready(cfg));
            if (!ok) return { ok: false, text: '还没填好：需要接口地址、API Key 和模型名' };
            // 破框没上线时，就别在状态栏提「出图用哪个模型」，那会把人指向看不见的设置。
            if (!aiBreakOn()) return { ok: true, text: 'API 已就绪 · ' + (cfg.model || '默认模型') };
            // 对话通了不等于能出图：这两条通道用的是两个模型，界面上得一分为二地说。
            const only = P && P.textOnlyOf ? P.textOnlyOf(cfg.baseUrl) : '';
            const img = P && P.imageModelOf ? P.imageModelOf(cfg) : '';
            let tail;
            if (only) tail = ' · 但 ' + only + ' 没有画图接口，AI 破框用不了';
            else if (img) tail = ' · 出图用 ' + img;
            else tail = ' · AI 破框还差一个图像模型';
            return { ok: true, text: 'API 已就绪 · ' + (cfg.model || '默认模型') + tail };
        }
        const sel = $('frameAgentSelect');
        const id = sel && sel.value;
        if (!id) {
            const first = sel && sel.options && sel.options[0] ? sel.options[0].textContent : '';
            return { ok: false, text: /检测中/.test(first) ? '正在检测本机助手…' : '没检测到本机助手。可以切到「API Key」，或安装 claude / codex / opencode 后再试' };
        }
        const name = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : id;
        return { ok: true, text: '本机助手已就绪 · ' + name };
    }
    function updateAiSetupState() {
        const box = $('aiSetupState'); if (!box) return;
        const s = aiSetupStatus();
        box.textContent = s.text;
        box.classList.toggle('bad', !s.ok);
    }
    // 统一 AI 设置入口：所有通道/助手/模型配置都在这一个弹窗里，
    // 没配好时点生成不会报错走人，而是直接把设置弹出来。
    function aiConfigured() { return aiSetupStatus().ok; }
    function openAiSetup(fromGenerate, opts) {
        opts = opts || {};
        const m = $('aiSetupModal');
        if (!m) return;
        if (!fromGenerate && !opts.keepPending) pendingGenerate = null;
        const adv = $('frameAdvanced'), slot = $('aiSetupSlot');
        if (adv && slot && adv.parentNode !== slot) slot.appendChild(adv);
        if (adv) adv.open = true;
        m.style.display = 'flex';
        syncChannelUI();
        updateAiSetupState();
        const done = $('btnAiSetupDone');
        if (done) done.textContent = pendingGenerate
            ? (opts.retry ? '保存并重试' : '保存并继续生成')
            : '保存设置';
        if (detectAgents) detectAgents();
        if (fromGenerate) setStatus('还没配好 AI，已打开设置；配好后会自动继续生成', 'bad');
    }
    async function finishAiSetup() {
        const P = window.QfsAiProvider;
        if (P && P.save) P.save(apiFormCfg());
        const st = aiSetupStatus();
        const pending = pendingGenerate;
        if (pending && !st.ok) {
            updateAiSetupState();
            setStatus('还差一步：' + st.text, 'bad');
            return;
        }
        pendingGenerate = null;
        const m = $('aiSetupModal');
        if (m) m.style.display = 'none';
        if (pending) { await generate(pending); return; }
        setStatus(st.ok ? 'AI 设置已保存' : '设置还没完成，生成时会再提醒你', st.ok ? 'ok' : '');
    }
    // 关闭设置 ≠ 执行暂存的生成：点 X / 背景 / Esc 都只退出，不偷偷跑一次。
    function closeAiSetup() {
        const hadPending = !!pendingGenerate;
        pendingGenerate = null;
        const m = $('aiSetupModal');
        if (m) m.style.display = 'none';
        if (hadPending) setStatus('已关闭设置，需要时再点「生成 4 款」');
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
        // 本地配方是确定性排版，不合格时重出同一套没有意义，直接按体检结果修/降级。
        const fromRecipe = docs.some((d) => d && d.recipe);
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
        if (!picks.length && !opts.retry && !fromRecipe) {
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
        if (!opts.base && !opts.boldRetry && !fromRecipe && avg >= 0 && avg < 42) {
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
        setStatus((fromRecipe ? '本地配方已出 ' : '已生成 ') + gallery.length + ' 款' + (fixedN ? '，自动修正 ' + fixedN + ' 处' : '') + '，点卡片即可套用', 'ok');
    }
    // ── 导演选框：模型只挑不改版式 ──────────────────────────────
    // 和「自由造型」的关键差别：AI 不写坐标，只从 app.presets 里选名字 + 写文案。
    // 因此模型抽风最多是选错框；渲染、撤销、导出仍走手工预设那条老路。
    function syncModeUI() {
        const on = genMode === 'director';
        const link = $('btnFrameDirector');
        if (link) {
            link.classList.toggle('active', on);
            link.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        const text = $('frameDirectorText');
        if (text) text.textContent = on ? '导演模式：只从 91 款里挑 + 按照片写文案' : '不知道要什么？让导演从 91 款里挑';
        const tail = $('frameDirectorTail');
        if (tail) tail.textContent = on ? '切回' : '→';
        const input = $('framePrompt');
        if (input) {
            input.placeholder = on
                ? '说用途或场合，如：旅行手账、给妈妈的生日卡（可不填）'
                : '想要什么感觉？如：展览海报、胶片边框、大字标题';
        }
        if (!generating) setGeneratingUI(false);
    }

    function directorApiReady() {
        const P = window.QfsAiProvider;
        if (!P || channelOf() !== 'api') return false;
        const cfg = P.load ? P.load() : {};
        return !!(P.ready && P.ready(cfg));
    }

    // ── AI 破框：照片 + 一段固定描述交给图像模型，直出一张成片 ──────────
    // 和「导演选框」是两条路：导演只挑现成边框、输出仍是可编辑工程（撤销、换字、
    // 换色都在）；这里输出的是一张位图，进来就作为新照片入库，能继续调色/加字/
    // 导出，但没有图层，也不能回头改那几笔「溢出」。
    // 这也是为什么它必须写在按钮上：一次几十秒，且模型不保证原样保留人物细节。

    // 常见图像网关只认这三档尺寸（gpt-image-1 就只收这三个）。按照片的宽高比
    // 选一档：横图硬塞竖版，模型会把画面横向压扁再补边，人一看就歪了。
    function breakSizeOf(w, h) {
        const r = (w && h) ? w / h : 0.75;
        if (r > 1.05) return { size: '1536x1024', orient: '横版', ratio: '3:2' };
        if (r < 0.95) return { size: '1024x1536', orient: '竖版', ratio: '2:3' };
        return { size: '1024x1024', orient: '方版', ratio: '1:1' };
    }

    // 描述分三段：装裱效果 / 保真红线 / 风格。方向与补充要求接在末尾——
    // 输入框里打的字（比如「纸面再黄一点」）会作为补充要求一起发过去，
    // 不用改代码就能调，否则每次微调都得找开发者。
    function breakPrompt(box, extra) {
        const base = [
            '把这张照片做成「3D 破框」立体装裱效果：照片嵌在一个矩形相框里，',
            '相框立在一张温暖的米白色纸面上，纸面有细腻轻微的纸纹，构图留白均衡，',
            '呈现精致的杂志编辑美学。',
            '画面中的主体与部分前景元素（树枝、花丛、人物轮廓等）自然延伸出相框边界，',
            '落到纸面上，仿佛从照片里进入观看者所在的现实空间；相框与溢出元素在纸面',
            '投下方向一致、柔和的自然光阴影，形成真实可信的三维纵深，不要生硬、虚假或过度夸张。',
            '严格保留原图的人物身份、面部特征、表情、姿势、服装、原始环境、色彩与光线特征；',
            '不得修改、重新诠释或替换参考照片中的任何关键元素。',
            '风格：高级编辑摄影、极简奢华、温暖中性色调、照片级真实渲染和出色的细节表现，',
            box.orient + ' ' + box.ratio + ' 画幅。'
        ].join('');
        const add = String(extra || '').replace(/\s+/g, ' ').trim();
        // 截到 120 字：输入框里可能是给「生成 4 款」写的一整句风格描述，
        // 全塞进图像 prompt 会稀释掉上面那几条硬约束。
        return add ? base + '补充要求：' + add.slice(0, 120) : base;
    }

    // 交给图像接口的源图：长边 1280 的 JPEG。原图 6000px 直接传会把请求体撑到
    // 十几 MB，网关多半 413；1280 对「重绘一张成片」这个用途已经够用。
    function breakSourceDataUrl() {
        const src = photoSource();
        const nw = src && (src.naturalWidth || src.width);
        const nh = src && (src.naturalHeight || src.height);
        if (!nw || !nh) return '';
        try {
            const k = Math.min(1, 1280 / Math.max(nw, nh));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(nw * k));
            c.height = Math.max(1, Math.round(nh * k));
            const g = c.getContext('2d');
            g.fillStyle = '#ffffff';
            g.fillRect(0, 0, c.width, c.height);
            g.drawImage(src, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', 0.9);
        } catch (_) { return ''; }
    }

    // 生成结果变成一张新照片：走和「导入照片」一样的入库路径——push 进 images、
    // 排缩略图、选中它。之后调色/裁切/导出全都照常，和普通照片没有区别。
    async function addGeneratedPhoto(dataUrl, name, from) {
        const A = window.App;
        if (!A || !Array.isArray(A.images)) throw new Error('主程序还没准备好');
        const img = (typeof window.qfsImage === 'function') ? window.qfsImage() : new Image();
        img.decoding = 'async';
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('生成的图打不开'));
            img.src = dataUrl;
        });
        if (!img.naturalWidth || !img.naturalHeight) throw new Error('生成的图是空的');
        const im = {
            el: img, name: name || 'AI 生成', path: null, sample: false,
            w: img.naturalWidth, h: img.naturalHeight, exif: {}, customSettings: null,
            // 标记来源：图上再点一次「AI 破框」会变成框中框，得先知道自己在干什么；
            // aiFrom 记着它出自哪张，导出与排错时能对上。
            aiGenerated: true, aiFrom: from || ''
        };
        A.images.push(im);
        if (typeof A.queueThumb === 'function') A.queueThumb(im);
        if (typeof A.buildThumbnails === 'function') A.buildThumbnails();
        if (typeof A.selectImage === 'function') A.selectImage(A.images.length - 1);
        return im;
    }

    // 网关差异大，404/401 这类裸状态码对用户没有意义。原文照留，只在后面补一句
    // 「大概是什么原因」，别让人对着 HTTP 404 猜。
    function breakErrorText(r) {
        const e = String((r && r.error) || '未知原因');
        const code = r && r.code;
        // 这几种主进程已经写成了整段人话（哪个地址没接口、该换成什么），别再补尾巴
        if (code === 'no-image-api' || code === 'need-image-model' || code === 'no-images-api') return e;
        if (/HTTP 404/.test(e)) return e + '（多半是图像模型名不对，或这个网关没有带参考图的接口）';
        if (/HTTP 413/.test(e)) return e + '（请求体过大，源图再压小一点）';
        if (/HTTP 401|HTTP 403/.test(e)) return e + '（Key 无效，或没有这个图像模型的权限）';
        if (/HTTP 429/.test(e)) return e + '（限流或额度用尽，过一会儿再试）';
        if (/请求超时/.test(e)) return e + '（模型没在 3 分钟内出图）';
        return e;
    }

    // 破框失败的信息常常是一整段（哪个地址没有画图接口、该换成什么），塞进工具栏
    // 那一行状态会被截掉一半，所以放进错误块：那里有地方，还带「检查 AI 设置」。
    function breakFailed(text) {
        setStatus(text, 'bad');
        const box = $('frameError'), m = $('frameErrorMsg'), log = $('frameErrorLog'), lg = $('btnFrameErrLog');
        if (m) m.textContent = text;
        if (log) log.hidden = true;
        if (lg) lg.hidden = true;   // 破框不经过助手会话，没有日志可看
        if (box) box.hidden = false;
        errorRetry = () => aiBreakFrame();
        syncToolbar();
    }

    async function aiBreakFrame() {
        if (!aiBreakOn()) { setStatus('这个版本还没放出 AI 破框', 'bad'); return; }
        if (breaking) return;
        const P = window.QfsAiProvider;
        if (!P || typeof P.image !== 'function') { setStatus('这个版本没有图像通道', 'bad'); return; }
        hideError();
        if (!(P.imageReady && P.imageReady())) {
            setStatus('先填图像模型：AI 设置 → 图像模型（对话模型出不了图）', 'bad');
            openAiSetup(false);
            return;
        }
        const cur = photoImage();
        const src = photoSource();
        const nw = src && (src.naturalWidth || src.width);
        const nh = src && (src.naturalHeight || src.height);
        const source = breakSourceDataUrl();
        if (!source || !nw || !nh) { setStatus('这张照片取不出来，换一张再试', 'bad'); return; }

        const box = breakSizeOf(nw, nh);
        const prompt = breakPrompt(box, ($('framePrompt') && $('framePrompt').value) || '');
        breaking = true;
        const btn = $('btnFrameBreak');
        if (btn) btn.disabled = true;
        progress(true, 'AI 正在重绘，通常 30–90 秒');
        setStatus(cur && cur.aiGenerated
            ? '源图本身是 AI 成片，这会在它外面再套一层框…'
            : '已提交（' + box.orient + ' ' + box.ratio + '），等模型出图…');
        try {
            const r = await P.image({ prompt: prompt, source: source, size: box.size });
            if (!r || !r.ok) {
                breakFailed('生成失败：' + breakErrorText(r));
                // 这两类是配置问题（地址没有画图接口 / 没填图像模型），直接把设置摊开
                if (r && (r.code === 'no-image-api' || r.code === 'need-image-model')) openAiSetup(false);
                return;
            }
            if (!r.image) { breakFailed('接口说成功了，但里面没有图'); return; }
            const made = await addGeneratedPhoto(r.image, 'AI 破框', (cur && cur.name) || '');
            // 面板顶部的照片下拉是独立于主界面的：新图入了库但下拉里没有它，
            // 面板就会一直预览旧图，和主画布对不上。这里重建一次，跟到新图上。
            refreshSamplePhotos();
            refreshPhotoPreviews();
            // 成片像素通常只有原图的几分之一，导出前就该知道，别等打出来才发现。
            setStatus('已生成「AI 破框」' + (made.w ? ' ' + made.w + '×' + made.h : '')
                + '，在胶片条里，可以接着调色或导出' + (r.note ? '；' + r.note : ''));
        } catch (e) {
            breakFailed('生成出错：' + (e && e.message ? e.message : String(e)));
        } finally {
            breaking = false;
            if (btn) btn.disabled = false;
            progress(false);
        }
    }

    // 给模型看的缩略图：长边 512 就够判断构图与明暗，再大只是把请求体撑胖。
    function directorThumb() {
        const src = photoSource();
        const w = src && (src.naturalWidth || src.width);
        const h = src && (src.naturalHeight || src.height);
        if (!w || !h) return '';
        try {
            const k = Math.min(1, 512 / Math.max(w, h));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(w * k));
            c.height = Math.max(1, Math.round(h * k));
            const g = c.getContext('2d');
            g.fillStyle = '#ffffff';
            g.fillRect(0, 0, c.width, c.height);
            g.drawImage(src, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', 0.82);
        } catch (_) { return ''; }
    }

    async function directorGenerate(text, my, avoid) {
        const D = window.QfsFrameDirector;
        if (!D) throw new Error('导演模块未加载，请重启应用');
        const presets = (app && Array.isArray(app.presets) ? app.presets : []).filter((p) => p && p.templateName);
        if (!presets.length) throw new Error('边框清单还没加载完，等一秒再试');

        const info = lastBrief || briefOf();
        const brief = info && info.brief ? info.brief : null;
        const im = photoImage();
        const exif = (im && im.exif) || {};
        const location = (app && app.template && app.template.location) || '';
        const skip = (Array.isArray(avoid) ? avoid : []).slice(0, 8);
        const ctx = { brief: brief, exif: exif, intent: text, avoid: skip };
        let picks = [];
        let note = '';
        let dropped = 0;

        if (directorApiReady()) {
            const P = window.QfsAiProvider;
            progress(true, '导演正在看照片、翻边框…');
            let image = directorThumb();
            const ask = (withImage) => D.buildMessages({
                presets: presets, brief: brief, briefText: info && info.text, exif: exif,
                location: location, intent: text, image: withImage ? image : '', count: 4, avoid: skip
            });
            let r = await P.chat(ask(!!image), { temperature: 0.8 });
            if (my !== runSeq) return;
            // 不少 OpenAI 兼容模型只收文字：带图被拒时去掉图再来一次，
            // 不把「模型不支持视觉」变成用户的一次失败重试。
            if (!r.ok && image && /image|vision|content|图片|多模态|unsupported|400/i.test(String(r.error || ''))) {
                note = '当前模型没看图，按参数摘要选的';
                r = await P.chat(ask(false), { temperature: 0.8 });
                if (my !== runSeq) return;
            }
            if (!r.ok) throw new Error(r.error || '导演调用失败');
            const parsed = D.parsePicks(r.content, presets);
            picks = parsed.picks;
            dropped = (parsed.dropped || []).length;
            if (!picks.length) note = '模型没给出可用边框名，已退回本地初选';
            else if (picks.length < 4) note = '模型只给了 ' + picks.length + ' 款，其余用本地补齐';
            if (dropped) note = (note ? note + '；' : '') + dropped + ' 个编造的边框名已丢弃';
        } else {
            // 三条通道里只有 API 能看图；说清楚"这批为什么是本地挑的"，不让用户以为模型挑的。
            note = channelOf() === 'api' ? 'AI 还没配好，已用本地初选'
                : channelOf() === 'recipe' ? '本地配方不调模型，这批按比例与关键词挑；想让它读图请在「高级」切到 API Key'
                    : '本机助手看不了图，已用本地初选';
        }

        if (!picks.length) picks = D.localPicks(presets, ctx, 4, Date.now());
        if (!picks.length) throw new Error('没有可用的边框');

        const built = [];
        let warns = 0;
        const used = new Set();
        for (const pick of picks) {
            if (built.length >= 4) break;
            if (!pick || !pick.preset || used.has(pick.preset.templateName)) continue;
            const c = D.composePreset(pick.preset, pick);
            warns += (c.warnings || []).length;
            used.add(pick.preset.templateName);
            built.push({ preset: c.preset, why: pick.why, director: true });
        }
        // 模型给得不够 4 款（或去重后不够）时，用本地初选补齐，不让画廊空着
        if (built.length < 4) {
            for (const item of D.localPicks(presets, ctx, 8, Date.now() + 17)) {
                if (built.length >= 4) break;
                if (used.has(item.preset.templateName)) continue;
                const c = D.composePreset(item.preset, item);
                used.add(item.preset.templateName);
                built.push({ preset: c.preset, why: item.why, director: true });
            }
        }

        const at = Date.now();
        const roundId = uid();
        gallery = built.map((b, i) => ({
            key: 'dir:' + roundId + ':' + i, preset: b.preset, dataUrl: null,
            source: 'current', director: true, why: b.why,
            roundPrompt: text, roundAt: at
        }));
        previousNames = gallery.map((g) => g.preset.templateName || '');
        view = 'current';
        syncTabs();
        renderGallery();

        progress(true, '正在套用你的照片…');
        let rendered = 0;
        for (let i = 0; i < gallery.length; i++) {
            if (my !== runSeq) return;
            gallery[i].dataUrl = renderFrameToUrl(gallery[i].preset, photoSource());
            if (gallery[i].dataUrl) rendered++;
            renderGallery();
        }
        if (!rendered) throw new Error('样片渲染失败：照片未就绪');
        pushRound(text, built.map((b) => b.preset));
        renderGallery();
        setStatus('导演挑了 ' + gallery.length + ' 款'
            + (warns ? '，' + warns + ' 处文案已按字位压缩' : '')
            + (note ? ' · ' + note : ''), 'ok');
    }

    async function generate(opts) {
        opts = opts || {};
        const promptEl = $('framePrompt');
        const text = String(opts.prompt != null ? opts.prompt : (promptEl && promptEl.value) || '').trim();
        const base = opts.base ? clone(opts.base) : null;
        if (generating) return;
        // 导演模式允许空提示：没有想法时就让导演按照片本身挑。
        if (!text && genMode !== 'director') { setStatus('先描述你想要的风格', 'bad'); return; }
        const channel = channelOf();
        if (genMode !== 'director' && channel !== 'recipe' && !aiConfigured()) {
            // 首次使用 / 配置失效：不把用户丢在一句报错里，直接开统一设置，配好自动续跑。
            pendingGenerate = { prompt: text, base: base, avoid: opts.avoid };
            openAiSetup(true);
            return;
        }
        const id = $('frameAgentSelect') && $('frameAgentSelect').value;
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
            if (genMode === 'director') {
                await directorGenerate(text, my, lastRequest.avoid);
                return;
            }
            // 本地配方：不配置、不联网、不等模型，直接排 4 款。
            if (channel === 'recipe') {
                progress(true, base ? '正在换 4 套配色…' : '正在按本地配方排版…');
                const docs = recipePlans(text, base);
                if (my !== runSeq) return;
                await adoptPlans(docs, my, text, opts);
                return;
            }
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
    // 把接口/助手的原始报错翻成用户能行动的一句话；原始日志仍留给「查看日志」。
    function friendlyError(msg) {
        const m = String(msg || '生成失败');
        if (/401|unauthorized|invalid.*(api\s*)?key|incorrect api key|认证失败/i.test(m)) {
            return 'API Key 无效或已过期。打开「检查 AI 设置」重填 Key，保存后再重试。';
        }
        if (/403|forbidden|permission|没有权限/i.test(m)) {
            return '这个 Key 没有调用权限，或账户额度不足。检查 AI 设置后重试。';
        }
        if (/429|rate limit|too many requests|请求过于频繁/i.test(m)) {
            return '调用太频繁了，等几秒再点「重试」。';
        }
        if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|网络|连接失败/i.test(m)) {
            return '连不上 AI 服务。检查网络或接口地址，再点「重试」。';
        }
        if (/timeout|timed out|超时/i.test(m)) {
            return '等太久了。可以重试；如果反复超时，换一个更快的模型。';
        }
        if (/404|not found|模型不存在/i.test(m)) {
            return '接口地址或模型名不对。打开「检查 AI 设置」核对一下。';
        }
        return m;
    }
    function showError(msg) {
        const text = friendlyError(msg);
        errorRetry = null;
        setStatus(text, 'bad');
        const box = $('frameError'); const m = $('frameErrorMsg'); const log = $('frameErrorLog');
        if (m) m.textContent = text;
        if (log) { log.textContent = (agentStream || '（助手没有输出）').slice(-4000); log.hidden = true; }
        if (box) box.hidden = false;
        const lg = $('btnFrameErrLog'); if (lg) { lg.textContent = '查看日志'; lg.hidden = false; }
        syncToolbar();
    }
    function hideError() {
        const box = $('frameError'); if (box) box.hidden = true;
        errorRetry = null;
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
        const src = effectivePreset(entry);
        const layers = layersOfDoc(src);
        if (!layers) { setStatus('只有图层边框能保存为模板', 'bad'); return; }
        const def = src.templateName || 'AI 边框';
        let name = null;
        if (inst && typeof inst.promptText === 'function') name = await inst.promptText('保存为样式模板（之后可在「样式模板」列表找到）', def);
        else name = window.prompt('保存为模板', def);
        if (name == null) return;
        name = String(name).trim();
        if (!name) { setStatus('模板名不能为空', 'bad'); return; }
        const doc = {
            templateName: name,
            aiLayers: clone(layers),
            aiBackground: typeof src.aiBackground === 'string' ? src.aiBackground : '#ffffff'
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
        // 整份数组被换成新对象：画布上的选中必须重绑，否则方向键/Delete 操作孤儿图层。
        if (typeof inst.rebindSelectedEls === 'function') inst.rebindSelectedEls();
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
    // 模型浮层用 fixed 定位挂到视口：高级区是带 max-height 的滚动容器，
    // 绝对定位的浮层会从底部被裁掉，改固定坐标后不受任何祖先 overflow 影响。
    function placeModelPop() {
        const pop = $('frameModelPop'), btn = $('btnFrameModel');
        if (!pop || !btn || pop.hidden) return;
        const r = btn.getBoundingClientRect();
        const w = pop.offsetWidth || 320;
        const h = pop.offsetHeight || 320;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
        const top = (window.innerHeight - r.bottom >= h + 8)
            ? r.bottom + 4
            : Math.max(8, r.top - h - 4);
        pop.style.top = Math.round(top) + 'px';
        pop.style.left = Math.round(left) + 'px';
    }
    function openModelPop() {
        const pop = $('frameModelPop'); if (!pop) return; pop.hidden = false;
        placeModelPop();
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
        // 默认本地配方 / API 通道都不需要助手，别在打开面板时白跑一次 CLI 探测。
        if (channelOf() !== 'local') {
            const hint0 = $('frameAgentHint');
            if (hint0) hint0.textContent = '切到「本机助手」后再检测';
            return;
        }
        const list = await api().agentDetect(); sel.innerHTML = '';
        const installed = (list || []).filter((a) => a.installed);
        if (!installed.length) {
            const o = document.createElement('option'); o.value = ''; o.textContent = '未检测到本机助手'; sel.appendChild(o);
            const hint = $('frameAgentHint');
            if (hint) {
                // 不再让用户去装 CLI：豆包/Codex 扩展/WorkBuddy 都不是可调用的 CLI，
                // 装了也识别不到。这条通道只认 claude / codex / opencode 三个命令。
                hint.textContent = '没找到命令行助手（只认 claude / codex / opencode）。豆包、WorkBuddy 这类请切到「API Key」。';
                hint.title = '本机助手通道通过 PATH 里的命令行调用，只支持 Claude Code、Codex、OpenCode。'
                    + '桌面应用（豆包 / WorkBuddy / Codex 浏览器扩展）没有命令行入口，无法被这里识别；'
                    + '它们若提供 OpenAI 兼容接口，请切到「API Key」填地址与 Key。';
            }
            updateAiSetupState();
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
        else {
            if (label) label.textContent = '加载模型中…';
            // 本地配方 / API 通道不需要助手会话：打开面板就起进程既慢又容易报错。
            if (channelOf() === 'local') preloadSession(pick.id);
            else if (label) label.textContent = '切到「本机助手」后加载';
        }
        updateAiSetupState();
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
    // 文件/JSON 相关 UI 已不对普通用户展示；这些函数保留给可能的内部调用，
    // 缺 DOM 时静默退出，避免面板初始化报错。
    async function select(name) {
        const ta = $('frameText'); if (!ta) return;
        const r = await (api().framesRead ? api().framesRead(name) : null); if (!r) return;
        current = { name: r.name }; ta.value = r.text; loadList();
    }
    async function save() {
        const ta = $('frameText'); if (!ta) return;
        if (!current) { setStatus('先选一个文件', 'bad'); return; }
        const text = ta.value; const p = parse(text);
        if (!p.ok) { setStatus(p.issues[0], 'bad'); return; }
        const r = await (api().framesSave ? api().framesSave(current.name, text) : null);
        setStatus(r && r.ok ? '已保存' : ((r && r.message) || '保存失败'), r && r.ok ? 'ok' : 'bad');
    }
    function doCheck() {
        const ta = $('frameText'); if (!ta) return;
        const p = parse(ta.value); if (!p.ok) { setStatus(p.issues.join('；'), 'bad'); return; }
        const issues = inspect(p.t);
        setStatus(issues.length ? ('体检：' + issues.join('；')) : '体检通过', issues.length ? 'bad' : 'ok');
    }
    function applyCurrent() {
        const ta = $('frameText'); if (!ta) return;
        const p = parse(ta.value); if (!p.ok) { setStatus(p.issues[0], 'bad'); return; }
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
        // 窗口没发布：连直接调用都不放行，不只是藏工具栏按钮。
        if (!aiPanelOn()) return false;
        if (!modal) return; modal.style.display = 'flex';
        applyFeatureGates();
        refreshSamplePhotos();
        refreshBrief();
        // 导演是兜底入口，不做粘性：每次打开都回到正常的「生成 4 款」。
        genMode = 'free';
        syncModeUI();
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
    function close() {
        closeLightbox(); hideIterate();
        const setup = $('aiSetupModal');
        if (setup && setup.style.display === 'flex') { setup.style.display = 'none'; pendingGenerate = null; }
        // 关整个弹层时，把视图复位到 AI 造型；下次打开不会掉进上次的纸刊页
        if (window.QfsZinePanel && typeof window.QfsZinePanel.backToFrame === 'function') {
            try { window.QfsZinePanel.backToFrame(); } catch (_) {}
        }
        if (modal) modal.style.display = 'none';
    }

    // 画布上直接拖动/双击改字之后，面板里那份「基准图层」已经过时。
    // 不刷新的话，下一次改底色会把用户的拖动结果覆盖掉。
    function syncFromCanvas() {
        if (!modal || modal.style.display !== 'flex') { applied = null; return; }
        refreshTweakPanel(true);
    }

    // 主画布切了照片：画廊缩略图和微调基准都要按新照片重算。
    // 面板关着时只把基准清掉，下次 open() 会自己重建。
    function refreshForPhotoChange() {
        if (!modal || modal.style.display !== 'flex') { applied = null; return; }
        previewCache.clear();
        const img = photoSource();
        displayEntries(readGalleryStore()).forEach((g) => {
            const url = renderFrameToUrl(g.preset, img);
            if (url) { g.dataUrl = url; previewCache.set(g.key, url); }
        });
        refreshTweakPanel(true);
        renderGallery();
    }

    // ── 通道配置 UI ──
    function syncChannelUI() {
        const P = window.QfsAiProvider;
        const ch = P ? P.channel('frame') : 'recipe';
        const sel = $('frameChannel');
        if (sel) sel.value = ch;
        const box = $('frameApiCfg');
        if (box) box.hidden = ch !== 'api';
        // 三套方式只显示各自相关字段，别让用户同时看到助手和 API 两组输入。
        const agentRow = $('frameAgentRow');
        if (agentRow) agentRow.hidden = ch !== 'local';
        const devLog = document.querySelector('#frameAdvanced .frame-dev');
        if (devLog) devLog.hidden = ch !== 'local';
        const cfg = P ? P.load() : { baseUrl: '', apiKey: '', model: '' };
        const base = $('frameApiBase'), key = $('frameApiKey'), model = $('frameApiModel');
        const imgModel = $('frameImageModel');
        if (base && base.value !== cfg.baseUrl) base.value = cfg.baseUrl;
        if (key && !key.value) key.value = cfg.apiKey;
        if (model && model.value !== cfg.model) model.value = cfg.model;
        if (imgModel && !imgModel.value) imgModel.value = cfg.imageModel || '';
        const hint = $('frameChannelHint');
        if (hint) {
            if (ch === 'recipe') hint.textContent = '免配置 · 不联网 · 点一下秒出 4 款';
            else if (ch === 'local') hint.textContent = '用本机已装的助手，不花 Key';
            else if (P && P.ready(cfg)) hint.textContent = '已配置 · ' + P.mask(cfg.apiKey) + ' · ' + cfg.model;
            else hint.textContent = '填地址 / Key / 模型，不用装命令行';
        }
        const note = $('frameApiNote');
        if (note) {
            note.textContent = (P && P.ready(cfg))
                ? '当前：' + (cfg.baseUrl || '内置默认地址') + ' · ' + cfg.model + (P.isLocalBase && P.isLocalBase(cfg.baseUrl) ? '（本机地址免 Key）' : '')
                : '支持 OpenAI 兼容接口：官方、中转或自建网关。填完点「测试连接」，成功后再保存。';
        }
        // 图像通道单独一行：对话通了只说明能写字，能出图是另一回事。
        const imgHint = $('frameImageHint');
        if (imgHint) {
            const only = P && P.textOnlyOf ? P.textOnlyOf(cfg.baseUrl) : '';
            const img = P && P.imageModelOf ? P.imageModelOf(cfg) : '';
            let bad = false;
            if (only) {
                bad = true;
                imgHint.textContent = only + ' 只有对话接口，出不了图。要用 AI 破框，得把地址、Key、图像模型一起换成带画图能力的网关。';
            } else if (img) {
                imgHint.textContent = 'AI 破框会用它出图：' + img;
            } else {
                imgHint.textContent = '不填就没有 AI 破框（对话模型出不了图）。例：gpt-image-1 / doubao-seedream-4-0-20260415 / qwen-image-3.0，以你网关的模型列表为准。';
            }
            imgHint.classList.toggle('bad', bad);
        }
        updateAiSetupState();
    }
    function apiFormCfg() {
        return {
            baseUrl: ($('frameApiBase') && $('frameApiBase').value) || '',
            apiKey: ($('frameApiKey') && $('frameApiKey').value) || '',
            model: ($('frameApiModel') && $('frameApiModel').value) || '',
            // 图像模型：AI 破框走 images/*，和对话模型是两个名字。留空就是不配图像通道，
            // 别拿上面那个去顶——顶上去的结果是一个「看起来配好了」的 404。
            imageModel: ($('frameImageModel') && $('frameImageModel').value) || ''
        };
    }
    function bindChannelUI() {
        const P = window.QfsAiProvider;
        if (!P) return;
        syncChannelUI();
        const sel = $('frameChannel');
        if (sel) sel.addEventListener('change', () => {
            P.setChannel(sel.value, 'frame');
            if (sel.value === 'api' || sel.value === 'recipe') closeModelPop();
            syncChannelUI();
            if (sel.value === 'local') detectAgents();
        });
        // 通道可能被别处（纸刊标签 / 外部）改动，监听广播保持本面板同步
        if (P.CHANGE_EVENT && typeof window.addEventListener === 'function') {
            window.addEventListener(P.CHANGE_EVENT, (e) => {
                const d = (e && e.detail) || {};
                if (!d.scope || d.scope === 'frame') syncChannelUI();
            });
        }
        for (const id of ['frameApiBase', 'frameApiKey', 'frameApiModel', 'frameImageModel']) {
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
        if (a) {
            a._syncAiLayerEdit = syncFromCanvas;
            a._onAiPhotoChanged = refreshForPhotoChange;
        }
        if (!modal || modal.dataset.bound === '1') return; modal.dataset.bound = '1';
        // 配置区搬进统一设置弹窗；高级里不再堆通道/助手/模型。
        const adv = $('frameAdvanced'), setupSlot = $('aiSetupSlot');
        if (adv && setupSlot) { setupSlot.appendChild(adv); adv.open = true; }
        const setupBtn = $('btnAiSetup');
        if (setupBtn) setupBtn.addEventListener('click', () => openAiSetup(false));
        const setupClose = $('btnAiSetupClose');
        if (setupClose) setupClose.addEventListener('click', closeAiSetup);
        const setupDone = $('btnAiSetupDone');
        if (setupDone) setupDone.addEventListener('click', finishAiSetup);
        const setupModal = $('aiSetupModal');
        if (setupModal) setupModal.addEventListener('click', (e) => { if (e.target === setupModal) closeAiSetup(); });
        bindChannelUI();
        const dLink = $('btnFrameDirector');
        if (dLink) dLink.addEventListener('click', () => {
            genMode = genMode === 'director' ? 'free' : 'director';
            syncModeUI();
            refreshBrief();
            if (genMode === 'director') {
                setStatus(directorApiReady()
                    ? '导演会看图，从 91 款手工边框里挑 4 款，并按照片写标题与参数'
                    : '未配置 AI：先按比例与关键词本地挑 4 款；配好后导演能看图配文');
                const input = $('framePrompt');
                if (input && typeof input.focus === 'function') input.focus();
            } else {
                setStatus('已切回自由造型');
            }
        });
        const brk = $('btnFrameBreak');
        if (brk) brk.addEventListener('click', () => { aiBreakFrame(); });
        applyFeatureGates();
        syncModeUI();
        // 面板滚动/窗口缩放时跟着按钮重新定位模型浮层，避免它飘在旧位置。
        if (typeof window.addEventListener === 'function') {
            window.addEventListener('resize', placeModelPop);
            const studio = $('frameView');
            if (studio) studio.addEventListener('scroll', placeModelPop, true);
        }
        $('frameModalClose').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        $('btnGenerate').addEventListener('click', () => generate({ prompt: $('framePrompt').value }));
        $('framePrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) generate({ prompt: $('framePrompt').value }); });
        const ideas = $('frameIdeas');
        if (ideas) ideas.addEventListener('click', (e) => {
            const b = e.target && e.target.closest ? e.target.closest('[data-idea]') : null;
            if (!b) return;
            const prompt = IDEA_PROMPTS[b.dataset.idea];
            const input = $('framePrompt');
            if (!prompt || !input) return;
            input.value = prompt;
            input.focus();
            setStatus('已填入「' + b.textContent.trim() + '」，可以直接生成，也能接着改');
        });
        $('btnFrameCancel').addEventListener('click', cancelGeneration);
        $('btnFrameAgain').addEventListener('click', () => { if (lastRequest) generate(lastRequest); });
        $('frameSamplePhoto').addEventListener('change', () => {
            // 换示例照片：用同一批方案即时重渲染，用户能比较不同照片的效果
            refreshPhotoPreviews();
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
        $('btnFrameRetry').addEventListener('click', () => {
            const again = errorRetry;
            hideError();
            if (again) { again(); return; }
            if (lastRequest) generate(lastRequest);
        });
        const errSetup = $('btnFrameErrSetup');
        if (errSetup) errSetup.addEventListener('click', () => {
            // 破框失败的下一步是改图像模型，不是排一次生成；保存后也不自动重试——
            // 出图要花钱，什么时候再花应该由用户点那一下。
            if (errorRetry) { pendingGenerate = null; openAiSetup(false, { keepPending: true }); return; }
            if (lastRequest) pendingGenerate = lastRequest;
            openAiSetup(false, { keepPending: true, retry: true });
        });
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
            if (e.key !== 'Escape') return;
            // 层级：统一设置 → 大图 → 纸刊标签 → 模型菜单 → 整个弹层。逐层退，不越级。
            const setup = $('aiSetupModal');
            if (setup && setup.style.display === 'flex') { e.preventDefault(); e.stopPropagation(); closeAiSetup(); return; }
            const lb = $('frameLightbox');
            if (lb && !lb.hidden) { e.preventDefault(); e.stopPropagation(); closeLightbox(); return; }
            const zine = $('zineModal');
            if (zine && !zine.hidden && window.QfsZinePanel && window.QfsZinePanel.backToFrame) {
                e.preventDefault(); e.stopPropagation(); window.QfsZinePanel.backToFrame(); return;
            }
            const pop = $('frameModelPop');
            if (pop && !pop.hidden) { e.preventDefault(); e.stopPropagation(); pop.hidden = true; return; }
            if (modal && modal.style.display === 'flex') { e.preventDefault(); e.stopPropagation(); close(); }
        }, true);
        // 文件管理 / JSON 编辑器已从界面移除；保留函数但只在元素仍存在时绑定。
        const bindClick = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
        bindClick('btnFrameRefresh', () => { loadList(); setStatus('已刷新', 'ok'); });
        bindClick('btnFrameOpenDir', () => api().framesOpenDir && api().framesOpenDir());
        bindClick('btnFrameCopyDir', async () => {
            const d = await (api().framesDir ? api().framesDir() : Promise.resolve({}));
            if (d.path && navigator.clipboard) { try { await navigator.clipboard.writeText(d.path); setStatus('路径已复制', 'ok'); return; } catch (_) {} }
            setStatus(d.path || '', '');
        });
        bindClick('btnFrameSave', save);
        bindClick('btnFrameCheck', doCheck);
        bindClick('btnFrameApply', applyCurrent);
        $('btnFrameModel').addEventListener('click', (e) => { e.stopPropagation(); const p = $('frameModelPop'); if (p && !p.hidden) closeModelPop(); else openModelPop(); });
        const fs = $('frameModelSearch'); if (fs) fs.addEventListener('input', () => renderModelList(fs.value));
        $('frameAgentSelect').addEventListener('change', async (e) => {
            if (generating) abandonRun();
            if (agentKey && api().agentClose) api().agentClose(agentKey);
            agentKey = null; agentModels = []; const label = $('frameModelLabel'); if (label) label.textContent = '加载模型中…';
            await switchAgent(e.target.value);
            preloadSession(e.target.value);
            updateAiSetupState();
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

    window.QfsFramePanel = { init, open, close, syncFromCanvas, syncFeatureGates: applyFeatureGates };
    // 脚本在 </body> 前加载，DOM 已就绪：先按开关把工具栏入口摆好，别等第一次点击。
    // 测试临时改开关后也用它重新应用，不必重开页面。
    applyFeatureGates();
})();

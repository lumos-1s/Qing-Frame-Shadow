'use strict';
/* AI 造型：一句话生成多方案画廊，点选即用。
 * 主流程对用户只有「输入想法 → 4 宫格样片 → 点选应用」；
 * 文件/JSON/体检/模型等开发者能力收进「高级」折叠区，默认不出现。
 * 渲染复用 window.__render 离屏画布，套到用户照片，不碰当前模板状态。
 */
(function () {
    const $ = (id) => document.getElementById(id);
    let app = null, modal = null;
    let agentKey = null, agentModelId = 'model', agentModels = [], modelPopUnwatch = null;
    const MODEL_KEY = 'qfs_ai_model';
    const AGENT_KEY = 'qfs_ai_agent';
    const modelKeyOf = (id) => MODEL_KEY + ':' + String(id || '');
    function readStore(k) { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } }
    function writeStore(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (_) {} }
    function modelForAgent(id) { return readStore(modelKeyOf(id)) || readStore(MODEL_KEY); }
    let currentAgent = readStore(AGENT_KEY);
    let currentModel = modelForAgent(currentAgent);
    let preloadPromise = null, preloadFor = '';
    let agentStream = '', unwatchAgent = null;
    let current = null;          // 高级区选中的文件 { name }
    let gallery = [];            // 本轮方案 [{ name, preset, dataUrl }]
    let generating = false;

    function api() { return window.qingframe || {}; }
    function setStatus(text, kind) {
        const el = $('frameStatus'); if (!el) return;
        el.textContent = text || ''; el.className = 'frame-status' + (kind ? ' ' + kind : '');
    }
    function progress(on, text) {
        const p = $('frameProgress'); if (!p) return;
        p.hidden = !on; const t = $('frameProgressText'); if (t && text) t.textContent = text;
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
    function renderFrameToUrl(preset, img) {
        if (!img) return null;
        try {
            const layers = preset && (Array.isArray(preset.layers) ? preset.layers
                : (Array.isArray(preset.aiLayers) ? preset.aiLayers : null));
            if (layers && layers.length && window.AiLayers && window.AiLayers.renderToCanvas) {
                const cv = window.AiLayers.renderToCanvas(preset, img, { maxEdge: 620 });
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
    // 预览必须走引擎同一取源：调色后的照片在 im._grade.canvas 里，直接用 im.el 会预览成未调色。
    function photoSource() {
        const im = photoImage();
        if (!im) return window.__qfsPhotoStub;
        return (window.photoSrc && window.photoSrc(im)) || im.el;
    }

    // ── 画廊 ──
    function renderGallery() {
        const box = $('frameGallery'); if (!box) return;
        if (!gallery.length) {
            box.innerHTML = '<div class="frame-gallery-empty" id="frameGalleryEmpty"><div class="frame-gallery-empty-ico">◫</div><div>说一句你想要的风格，AI 用你的照片洗出 <b>4 款</b> 让你挑</div><div class="frame-gallery-empty-sub">先导入一张照片，效果会更直观</div></div>';
            return;
        }
        box.innerHTML = '';
        gallery.forEach((g, i) => {
            const card = document.createElement('div');
            card.className = 'frame-swatch'; card.setAttribute('role', 'listitem');
            const imgBox = document.createElement('div'); imgBox.className = 'frame-swatch-img';
            if (g.dataUrl) {
                const im = document.createElement('img'); im.src = g.dataUrl; im.alt = g.preset.templateName || ('方案 ' + (i + 1)); imgBox.appendChild(im);
            } else {
                const ld = document.createElement('div'); ld.className = 'frame-swatch-loading'; ld.textContent = '渲染中…'; imgBox.appendChild(ld);
            }
            const foot = document.createElement('div'); foot.className = 'frame-swatch-foot';
            const name = document.createElement('span'); name.className = 'frame-swatch-name'; name.textContent = g.preset.templateName || ('方案 ' + (i + 1));
            const use = document.createElement('span'); use.className = 'frame-swatch-use'; use.textContent = '点击套用 ›';
            foot.appendChild(name); foot.appendChild(use);
            card.appendChild(imgBox); card.appendChild(foot);
            card.addEventListener('click', () => applyGalleryItem(i));
            box.appendChild(card);
        });
    }

    function applyGalleryItem(i) {
        const g = gallery[i];
        if (!g) return;
        const inst = window.App || app;
        if (!inst || typeof inst.applyPresetToCurrent !== 'function') { setStatus('应用未就绪', 'bad'); return; }
        if (g.isLayer) {
            // AI 图层边框是「模板」，不是贴回照片的成品图：
            // 只把 layers 写进 template.aiLayers，照片/调色/裁切/撤销全部保持原样。
            const layers = Array.isArray(g.preset.layers) ? g.preset.layers
                : (Array.isArray(g.preset.aiLayers) ? g.preset.aiLayers : null);
            if (!layers || !layers.length) { setStatus('方案无有效图层', 'bad'); return; }
            const tpl = {
                templateName: g.preset.templateName || 'AI 边框',
                aiLayers: JSON.parse(JSON.stringify(layers)),
                aiBackground: typeof g.preset.aiBackground === 'string' ? g.preset.aiBackground : '#ffffff'
            };
            const ok = inst.applyPresetToCurrent(tpl);
            if (ok === false) { setStatus('套用失败', 'bad'); return; }
            setStatus('已套用「' + tpl.templateName + '」', 'ok');
            return;
        }
        inst.applyPresetToCurrent(g.preset);
        setStatus('已套用「' + (g.preset.templateName || '方案') + '」', 'ok');
    }

    // ── 生成：一句话 → N 个方案 ──
    async function generate() {
        const text = ($('framePrompt') && $('framePrompt').value || '').trim();
        if (generating) return;
        if (!text) { setStatus('先描述你想要的风格', 'bad'); return; }
        const id = $('frameAgentSelect') && $('frameAgentSelect').value;
        if (!id) { setStatus('未检测到本机助手（在「高级」里查看）', 'bad'); return; }
        generating = true;
        const btn = $('btnGenerate'); if (btn) btn.disabled = true;
        if (id !== currentAgent) await switchAgent(id);
        // 面板打开时的预启动可能还在进行：等同一次会话，别又起一个
        if (!agentKey && preloadPromise) { try { await preloadPromise; } catch (_) {} }
        progress(true, '正在洗 4 款样片…');
        agentStream = '';
        if ($('frameAgentOut')) $('frameAgentOut').textContent = '';
        try {
            const skill = await (api().framesSkill ? api().framesSkill() : Promise.resolve({ text: '' }));
            const rules = [
                '你是清框影边框设计师。用户想要：' + text,
                '请生成 4 个各不相同的边框方案，在本目录写 4 个 JSON：a1.json / a2.json / a3.json / a4.json。',
                '每个文件是一个「图层边框」对象，格式：',
                '{"templateName":"方案名","layers":[ ...图层... ]}',
                'layers 从底到顶绘制，每层是以下之一（坐标为 0..1 比例，相对画布宽高）：',
                ' {"type":"photo","x":0.08,"y":0.08,"w":0.84,"h":0.7,"radius":0.01,"fit":"cover"}',
                ' {"type":"rect","x":0.05,"y":0.05,"w":0.9,"h":0.9,"radius":0.02,"fill":"#ffffff","fillOpacity":0.9,"stroke":"#dcba79","strokeWidth":2}',
                ' {"type":"circle","cx":0.5,"cy":0.2,"r":0.08,"fill":"#129e78"}',
                ' {"type":"line","x1":0.1,"y1":0.5,"x2":0.9,"y2":0.5,"color":"#dcba79","width":2,"dash":[4,4]}',
                ' {"type":"text","x":0.5,"y":0.92,"text":"文字","size":0.035,"color":"#f2e4c4","align":"center","weight":600,"letterSpacing":0.1,"maxW":0.8,"maxLines":1}',
                '必须包含且只包含一个 photo 槽位：它就是照片的位置和大小，画布比例由它决定。',
                'photo 之前的图层画在照片下面（底色/卡纸/背景），photo 之后的图层画在照片上面（文字/线条/装饰）；不要把照片整张盖住。',
                '文字务必带 maxW（0..1，建议 0.6~0.9）和 maxLines，size 不要超过 0.06，避免溢出画面。',
                '可加 shadow:{color,blur,offsetX,offsetY,opacity}。颜色用十六进制。',
                '要求：4 款在风格/配色/留白/排版上明显不同，且都用图层组合出真实的新设计（不要只写一行文字）。',
                '写好 4 个文件后只回复「完成」，不要输出 JSON 正文。'
            ].join('\n');
            await ensureAgentSession(id, skill.text || '', rules);
            // 关键：把「生成规则 + 用户想法」一起发给 agent（rules 只在建会话时用，不会随 prompt 发送）
            const fullPrompt = rules + '\n\n====\n用户这次的要求：' + text;
            // 清掉上一轮的约定文件，避免读到旧方案
            if (api().framesRemove) for (const n of ['a1.json','a2.json','a3.json','a4.json']) await api().framesRemove(n);
            // 记录生成前的文件内容：目录里可能还留着更早的方案，不能把它们当成本轮结果
            const before = new Map();
            if (api().framesList && api().framesRead) {
                for (const n of ((await api().framesList()) || [])) {
                    const f = await api().framesRead(n);
                    if (f && typeof f.text === 'string') before.set(n, f.text);
                }
            }
            const r = await (api().agentPrompt ? api().agentPrompt(agentKey, fullPrompt) : null);
            if (!r || !r.ok) throw new Error((r && r.error) || '生成失败');
            // 读回本轮生成的方案：先按约定名 a1-a4，再补本轮新建/改过的文件。
            // 每个都 sanitize（自动修正未知风格/越界参数），不再因小错整款丢弃。
            const candidates = ['a1.json', 'a2.json', 'a3.json', 'a4.json'];
            const all = api().framesList ? (await api().framesList()) : [];
            for (const n of (all || [])) {
                if (candidates.includes(n)) continue;
                const f = await api().framesRead(n);
                if (f && before.get(n) !== f.text) candidates.push(n);
            }
            const found = [];
            for (const n of candidates) {
                const f = await api().framesRead(n);
                if (!f) continue;
                const p = parse(f.text);
                if (!p.ok) continue;
                // 只收图层边框：退回旧预设等于「拿现成风格改文字」，这正是要修的问题
                const layerDoc = sanitizeLayerDoc(p.t);
                if (!layerDoc) continue;
                found.push({ name: f.name, preset: layerDoc, dataUrl: null, isLayer: true });
                if (found.length >= 4) break;
            }
            if (!found.length) {
                const tail = (agentStream || '').slice(-300);
                throw new Error('助手没有产出可解析的边框文件。' + (tail ? '日志：' + tail : '展开「高级」看日志。'));
            }
            gallery = found;
            renderGallery();
            // 逐张渲染到用户照片（走 photoSrc：调过色的照片预览也用同一条取源）
            const img = photoSource();
            progress(true, '正在套用你的照片…');
            let rendered = 0;
            for (let i = 0; i < gallery.length; i++) {
                gallery[i].dataUrl = renderFrameToUrl(gallery[i].preset, img);
                if (gallery[i].dataUrl) rendered++;
                renderGallery();
            }
            if (!rendered) throw new Error('样片渲染失败：照片未就绪或图层没有可用图元（展开「高级」看日志）');
            setStatus('已生成 ' + gallery.length + ' 款，点卡片即可套用', 'ok');
        } catch (e) {
            setStatus(e.message || '生成失败', 'bad');
        } finally {
            generating = false; if (btn) btn.disabled = false;
            progress(false);
        }
    }

    // ── 助手会话（ACP）──
    function updateText(u) {
        if (!u) return '';
        const t = u.type || u.sessionUpdate || '';
        if (t === 'agent_message_chunk' || t === 'message_chunk') { const c = u.content || {}; return typeof c === 'string' ? c : (c.text || ''); }
        if (t === 'tool_call' || t === 'toolCall') return '\n[工具] ' + (u.title || u.name || '') + '\n';
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
                agentStream += updateText(payload.update);
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
            return ensureAgentSession(id, skill.text || '', '你是清框影边框设计师。只在本目录创建或修改 *.json 图层边框文件：{templateName, layers}，必须有且只有一个 photo 槽位。');
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
            const hint = $('frameAgentHint'); if (hint) hint.textContent = '在「高级」里：需先装 Claude Code / Codex / OpenCode';
            return;
        }
        for (const a of installed) { const o = document.createElement('option'); o.value = a.id; o.textContent = a.name; sel.appendChild(o); }
        const hint = $('frameAgentHint'); if (hint) hint.textContent = '已就绪 ' + installed.length + ' 个助手';
        // 沿用上次的选择；没装/没记忆才回落到第一个
        const pick = installed.find((a) => a.id === currentAgent) || installed[0];
        await switchAgent(pick.id);
        sel.value = pick.id;
        const label = $('frameModelLabel'); if (label) label.textContent = '加载模型中…';
        preloadSession(pick.id);
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
            const ok = inst.applyPresetToCurrent({
                templateName: p.t.templateName || 'AI 边框',
                aiLayers: layers,
                aiBackground: typeof p.t.aiBackground === 'string' ? p.t.aiBackground : '#ffffff'
            });
            setStatus(ok === false ? '应用失败' : '已应用', ok === false ? 'bad' : 'ok');
            return;
        }
        inst.applyPresetToCurrent(p.t); setStatus('已应用', 'ok');
    }

    // ── 生命周期 ──
    async function open() {
        if (!modal) return; modal.style.display = 'flex';
        refreshSamplePhotos();
        renderGallery(); detectAgents(); loadList();
        if (api().framesWatch) api().framesWatch();
    }
    function close() { if (modal) modal.style.display = 'none'; }

    function init(a) {
        app = a; modal = $('frameModal');
        if (!modal || modal.dataset.bound === '1') return; modal.dataset.bound = '1';
        $('frameModalClose').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        $('btnGenerate').addEventListener('click', generate);
        $('framePrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter') generate(); });
        $('frameSamplePhoto').addEventListener('change', () => {
            // 换示例照片：用同一批方案即时重渲染，用户能比较不同照片的效果
            if (!gallery.length) return;
            const img = photoSource();
            gallery.forEach((g) => { g.dataUrl = renderFrameToUrl(g.preset, img); });
            renderGallery();
            setStatus('已换成所选照片预览', 'ok');
        });
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
            if (agentKey && api().agentClose) api().agentClose(agentKey);
            agentKey = null; agentModels = []; const label = $('frameModelLabel'); if (label) label.textContent = '加载模型中…';
            await switchAgent(e.target.value);
            preloadSession(e.target.value);
        });
        $('btnAgentNew').addEventListener('click', async () => {
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

    window.QfsFramePanel = { init, open, close };
})();

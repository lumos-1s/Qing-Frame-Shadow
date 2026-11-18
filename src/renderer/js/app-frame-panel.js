'use strict';
/* AI 造型：一句话生成多方案画廊，点选即用。
 * 主流程对用户只有「输入想法 → 4 宫格样片 → 点选应用」；
 * 文件/JSON/体检/模型等开发者能力收进「高级」折叠区，默认不出现。
 * 渲染复用 window.__render 离屏画布，套到用户照片，不碰当前模板状态。
 */
(function () {
    const $ = (id) => document.getElementById(id);
    let app = null, modal = null;
    let agentKey = null, agentModelId = 'model', agentModels = [], currentModel = '', modelPopUnwatch = null;
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
    function inspect(t) {
        const issues = [];
        if (!t.templateName || typeof t.templateName !== 'string') issues.push('缺 templateName');
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

    // ── 渲染：把一份预设套到底图，返回 dataURL ──
    function renderFrameToUrl(preset, img) {
        if (!window.__render) return null;
        if (!img || !img.naturalWidth) return null;
        const cv = document.createElement('canvas');
        cv.width = 480; cv.height = 620;
        const tmp = {
            template: JSON.parse(JSON.stringify(preset)),
            displayMax: 4000, selectedEls: [], uiDprOverride: 1,
            image: { el: img, exif: (preset.manualExif) || {} },
            dom: { canvas: cv }, logos: [], logoImgCache: {},
            scheduleRender() {}, applyZoomStyle() {}
        };
        try {
            window.EngineStyles && window.EngineStyles.clearCaches && window.EngineStyles.clearCaches();
            window.__render(tmp);
            return cv.toDataURL('image/png');
        } catch (e) { return null; }
    }
    function photoEl() { return (app && app.image && app.image.el) || window.__qfsPhotoStub; }

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
        if (!g || !app || typeof app.applyPresetToCurrent !== 'function') return;
        app.applyPresetToCurrent(g.preset);
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
        progress(true, '正在洗 4 款样片…');
        agentStream = '';
        if ($('frameAgentOut')) $('frameAgentOut').textContent = '';
        try {
            const skill = await (api().framesSkill ? api().framesSkill() : Promise.resolve({ text: '' }));
            const rules = [
                '你是清框影边框设计师。当前目录是边框作品目录，AGENTS.md 里有完整设计规范。',
                '用户想要：' + text,
                '请生成 4 个不同方案：在本目录写 4 个 JSON 文件，分别命名 a1.json / a2.json / a3.json / a4.json。',
                '每个文件是一份完整预设（templateName / photoFrameStyle / baseMargin / cornerConfig / styleParams / userSignature / manualExif），四款要有明显区别（风格/配色/留白/排版各不同）。',
                'styleParams 按 AGENTS.md 的范围取值。写完只回复「完成」，不要输出 JSON 正文。'
            ].join('\n');
            await ensureAgentSession(id, skill.text || '', rules);
            const r = await (api().agentPrompt ? api().agentPrompt(agentKey, text) : null);
            if (!r || !r.ok) throw new Error((r && r.error) || '生成失败');
            // 读回本轮生成的方案（按约定名 a1-a4）
            const names = api().framesRead ? ['a1.json', 'a2.json', 'a3.json', 'a4.json'] : [];
            const found = [];
            for (const n of names) {
                const f = await api().framesRead(n);
                if (f) { const p = parse(f.text); if (p.ok && inspect(p.t).length === 0) found.push({ name: n, preset: p.t, dataUrl: null }); }
            }
            if (!found.length) throw new Error('助手没有产出可用的边框文件，展开「高级」看日志');
            gallery = found;
            renderGallery();
            // 逐张渲染到用户照片
            const img = photoEl();
            progress(true, '正在套用你的照片…');
            for (let i = 0; i < gallery.length; i++) {
                gallery[i].dataUrl = renderFrameToUrl(gallery[i].preset, img);
                renderGallery();
            }
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
        agentKey = r.key; agentModelId = r.modelId || 'model';
        populateModels(r.models || []);
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
        const cur = agentModels.find((m) => m.current) || agentModels[0];
        currentModel = cur ? cur.value : ''; if (label) label.textContent = cur ? cur.name : '默认模型';
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
        currentModel = m.value; const label = $('frameModelLabel'); if (label) label.textContent = m.name;
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
        if (agentKey) return;
        try {
            const skill = await (api().framesSkill ? api().framesSkill() : Promise.resolve({ text: '' }));
            await ensureAgentSession(id, skill.text || '', '你是清框影边框设计师，只在本目录创建或修改 *.json 边框文件。');
        } catch (e) { /* 预启动失败不阻塞 */ }
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
        sel.value = installed[0].id;
        const label = $('frameModelLabel'); if (label) label.textContent = '加载模型中…';
        preloadSession(installed[0].id);
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
        if (!app || typeof app.applyPresetToCurrent !== 'function') return;
        app.applyPresetToCurrent(p.t); setStatus('已应用', 'ok');
    }

    // ── 生命周期 ──
    async function open() {
        if (!modal) return; modal.style.display = 'flex';
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
        $('frameAgentSelect').addEventListener('change', (e) => {
            if (agentKey && api().agentClose) api().agentClose(agentKey);
            agentKey = null; agentModels = []; const label = $('frameModelLabel'); if (label) label.textContent = '加载模型中…';
            preloadSession(e.target.value);
        });
        $('btnAgentNew').addEventListener('click', () => {
            if (agentKey && api().agentClose) api().agentClose(agentKey);
            agentKey = null; agentModels = []; const label = $('frameModelLabel'); if (label) label.textContent = '默认模型';
            preloadSession($('frameAgentSelect') && $('frameAgentSelect').value);
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

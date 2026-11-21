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
    const api = () => window.qingframe || {};

    let busy = false;
    let lastResults = [];
    let seq = 0;
    let previewKey = '';
    let previewTimer = 0;
    let sampleSceneEl = null;

    function photoSource() {
        const im = (window.App || {}).image;
        if (!im) return null;
        return (window.photoSrc && window.photoSrc(im)) || im.el || null;
    }
    function photoBriefApi() { return window.PhotoBrief || window.QfsPhotoBrief || null; }

    // 没导入照片时，用一张内置的示例画面画预览：用户先看到「这几种纸感长什么样」，
    // 不用先折腾导入。导入照片后 key 变化，预览自动换成用户自己的照片。
    function sampleScene() {
        if (sampleSceneEl) return sampleSceneEl;
        const cv = document.createElement('canvas');
        cv.width = 480; cv.height = 600;
        const c = cv.getContext('2d');
        const g = c.createLinearGradient(0, 0, 0, 600);
        g.addColorStop(0, '#476A84'); g.addColorStop(0.55, '#9DB4BE'); g.addColorStop(1, '#DDC9A6');
        c.fillStyle = g; c.fillRect(0, 0, 480, 600);
        c.fillStyle = '#F3DCA6'; c.beginPath(); c.arc(330, 158, 56, 0, 6.2832); c.fill();
        c.fillStyle = '#3F5C50'; c.beginPath();
        c.moveTo(0, 410); c.lineTo(150, 288); c.lineTo(285, 402); c.lineTo(392, 318);
        c.lineTo(480, 388); c.lineTo(480, 600); c.lineTo(0, 600); c.closePath(); c.fill();
        c.fillStyle = '#263E38'; c.beginPath();
        c.moveTo(0, 480); c.quadraticCurveTo(230, 412, 480, 470);
        c.lineTo(480, 600); c.lineTo(0, 600); c.closePath(); c.fill();
        sampleSceneEl = cv;
        return cv;
    }
    function zineVisible() {
        const el = $('zineModal');
        return !!el && !el.hidden;
    }
    function composeText() {
        return {
            title: (($('zineSubject') || {}).value || '').trim(),
            subtitle: (($('zineMood') || {}).value || '').trim()
        };
    }
    function renderPreviews(force) {
        const R = window.QfsZineRender;
        const box = $('zineStyles');
        if (!R || typeof R.render !== 'function' || !box) return;
        const im = (window.App || {}).image;
        const src = photoSource() || sampleScene();
        const text = composeText();
        const bold = Number(($('zineBold') || {}).value) || 0.6;
        const key = [
            im ? (im.path || im.name || (im.w + 'x' + im.h)) : 'sample',
            src.naturalWidth || src.width, src.naturalHeight || src.height,
            text.title, text.subtitle, bold
        ].join('|');
        if (!force && key === previewKey) return;
        previewKey = key;
        const note = document.querySelector('.zine-pick-note');
        if (note) note.textContent = (photoSource() ? '预览用你的照片' : '先用示例画面预览，导入照片后会换成你的照片')
            + '；每次生成会出 4 种构图变化';
        const thumbs = Array.from(box.querySelectorAll('.zine-style-thumb'));
        builtinList().forEach((p) => {
            const out = R.render(p.id, src, {
                id: p.id, maxEdge: 320, bold,
                title: text.title || undefined,
                subtitle: text.subtitle || undefined
            });
            const node = thumbs.find((n) => n.parentNode && n.parentNode.dataset.style === p.id);
            if (node && out && out.dataUrl) node.src = out.dataUrl;
        });
    }
    function schedulePreviews(delay) {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => { if (zineVisible()) renderPreviews(); }, delay == null ? 40 : delay);
    }
    function brief() {
        const im = (window.App || {}).image;
        if (!im) return null;
        const B = photoBriefApi();
        if (B && typeof B.analyze === 'function') {
            try { return B.analyze(photoSource(), { exif: im.exif }); } catch (_) {}
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

    // ── 内置风格：只保留本机渲染器真能画的 4 种，避免选了没反应 ──
    function promptLib() { return window.QfsZinePrompts || {}; }
    function builtinList() {
        const all = promptLib().BUILTIN || [];
        const R = window.QfsZineRender || {};
        const ids = R.PRESETS || [];
        if (!ids.length) return all.slice();
        const map = {};
        all.forEach((p) => { if (p && p.id) map[p.id] = p; });
        return ids.map((id) => map[id]).filter(Boolean);
    }
    function rebuildPresetOptions() {
        const sel = $('zinePromptPreset'); if (!sel) return;
        const list = builtinList();
        sel.innerHTML = '';
        list.forEach((p) => {
            const o = document.createElement('option');
            o.value = p.id; o.textContent = p.name; o.title = p.desc || '';
            sel.appendChild(o);
        });
        if (!list.length) {
            const o = document.createElement('option'); o.value = ''; o.textContent = '无内置风格';
            sel.appendChild(o);
        }
        rebuildStyleCards();
    }
    function rebuildStyleCards() {
        const box = $('zineStyles'); if (!box) return;
        box.innerHTML = '';
        builtinList().forEach((p) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'zine-style'; b.dataset.style = p.id;
            b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false');
            b.title = p.desc || p.name;
            const thumb = document.createElement('img');
            thumb.className = 'zine-style-thumb'; thumb.alt = '';
            thumb.setAttribute('aria-hidden', 'true');
            const name = document.createElement('span');
            name.className = 'zine-style-name'; name.textContent = p.name;
            b.appendChild(thumb);
            b.appendChild(name);
            b.addEventListener('click', () => applyPreset(p.id));
            box.appendChild(b);
        });
        syncStyleCards();
    }
    function syncStyleCards() {
        const sel = $('zinePromptPreset');
        const id = sel && sel.value;
        const box = $('zineStyles');
        if (box) {
            Array.from(box.children).forEach((b) => {
                const on = b.dataset.style === id;
                b.classList.toggle('active', on);
                b.setAttribute('aria-checked', String(on));
            });
        }
        const p = promptLib().get ? promptLib().get(id) : null;
        const desc = $('zineStyleDesc');
        if (desc) desc.textContent = p ? (p.desc || '') : '';
    }
    function applyPreset(id, silent) {
        const p = promptLib().get ? promptLib().get(id) : null;
        if (!p) return;
        const sel = $('zinePromptPreset'); if (sel) sel.value = p.id;
        const ta = $('zinePrompt'); if (ta) ta.value = p.text || '';
        promptLib().select && promptLib().select(p.id);
        syncStyleCards();
        if (!silent) setStatus('已选「' + p.name + '」，点「生成纸刊」就能看到效果');
    }

    // 纸刊不再是独立弹层：初始化时把自己的 DOM 搬进 frameModal 的插槽，
    // 与 AI 造型平级，由顶部标签切换。所有 id 不变，外部引用不受影响。
    function adoptIntoStudio() {
        const el = $('zineModal');
        const slot = $('studioSlot');
        if (!el || !slot) return;
        if (el.parentNode !== slot) slot.appendChild(el);
    }
    function markTab(on) {
        const f = $('tabFrameStudio'), z = $('btnZineOpen');
        if (f) { f.classList.toggle('active', !on); f.setAttribute('aria-selected', String(!on)); }
        if (z) { z.classList.toggle('active', !!on); z.setAttribute('aria-selected', String(!!on)); }
        const title = $('frameModalTitle');
        if (title) title.textContent = on ? '给照片一页新的纸' : '给照片一副好框';
        // 纸刊零配置，不出现 AI 设置，免得用户以为这里也要填 Key
        const setup = $('btnAiSetup');
        if (setup) setup.hidden = !!on;
    }
    function show() {
        const el = $('zineModal');
        const frameView = $('frameView');
        if (!el) return;
        adoptIntoStudio();
        el.hidden = false;
        if (frameView) frameView.hidden = true;
        markTab(true);
        syncStyleCards();
        refreshBrief();
        renderResults();
        schedulePreviews();
    }
    // 关闭整个弹层（不是切回标签），交由 frame-panel 统一处理
    function hide() {
        const closeBtn = $('frameModalClose');
        if (closeBtn && typeof closeBtn.click === 'function') closeBtn.click();
    }
    // 只切回 AI 造型视图，不关弹层
    function backToFrame() {
        const el = $('zineModal'), frameView = $('frameView');
        if (el) el.hidden = true;
        if (frameView) frameView.hidden = false;
        markTab(false);
    }

    function refreshBrief() {
        const b = brief();
        const box = $('zineBrief');
        if (!box) return;
        if (!b) { box.hidden = true; box.textContent = ''; return; }
        box.hidden = false;
        const bits = [
            b.orient ? b.orient + '幅' : '',
            b.ratio || '',
            b.dominant && b.dominant.name ? ('主色 ' + b.dominant.name) : '',
            b.centroid && b.centroid.label ? ('重心' + b.centroid.label) : ''
        ].filter(Boolean);
        box.textContent = bits.length ? ('已读照片：' + bits.join(' · ')) : '已读照片';
    }

    // 零配置本地渲染：不调图像模型，不读通道/Key，直接按选中风格画一张。
    function renderZineLocally(seed, bold) {
        const R = window.QfsZineRender;
        if (!R || typeof R.render !== 'function') throw new Error('本地渲染器未加载');
        const chosen = promptLib().get ? promptLib().get(($('zinePromptPreset') || {}).value) : null;
        const valid = chosen && R.PRESETS.indexOf(chosen.id) >= 0;
        const id = valid ? chosen.id : R.PRESETS[0];
        const meta = valid ? chosen : builtinList().find((p) => p.id === id) || null;
        const subject = ($('zineSubject') && $('zineSubject').value || '').trim();
        const out = R.render(id, photoSource(), {
            id, seed, bold,
            title: subject || undefined,
            subtitle: ($('zineMood') && $('zineMood').value || '').trim() || undefined
        });
        if (!out || !out.dataUrl) throw new Error('本地渲染失败');
        return { out, chosen: meta || (builtinList()[0] || null) };
    }

    function generate() {
        if (busy) return;
        if (!photoSource()) { setStatus('先在画布里导入一张照片', true); return; }
        const my = ++seq;
        const batch = (Math.random() * 0x7fffffff) >>> 0;
        const bold = Number(($('zineBold') || {}).value) || 0.6;
        busyUI(true, '正在绘制 4 种构图变化…');
        setStatus('');
        try {
            const next = [];
            for (let i = 0; i < 4; i++) {
                const { out, chosen } = renderZineLocally(batch + i * 7919, bold);
                if (my !== seq) return;
                next.push({
                    key: 'zine:' + batch + ':' + i,
                    image: out.dataUrl,
                    path: 'local',
                    name: ((chosen && chosen.name) || '拾景纸刊') + ' · ' + ['一', '二', '三', '四'][i],
                    rationale: ((chosen && chosen.desc) ? chosen.desc + ' · ' : '') + '第 ' + (i + 1) + ' 种构图变化',
                    palette: out.palette || [],
                    size: (out.W && out.H) ? (out.W + ' × ' + out.H + ' px') : ''
                });
            }
            lastResults = next;
            setStatus('已生成 4 种构图变化，点任一卡的「作为照片导入」继续调色和导出');
        } catch (e) {
            if (my !== seq) return;
            setStatus('失败：' + (e && e.message ? e.message : String(e)), true);
        } finally {
            if (my === seq) busyUI(false);
        }
        renderResults();
        const box = $('zineResults');
        if (box && typeof box.scrollIntoView === 'function') {
            try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
        }
    }

    function renderResults() {
        const box = $('zineResults');
        if (!box) return;
        const again = $('btnZineAgain');
        if (again) again.hidden = !lastResults.length;
        box.innerHTML = '';
        if (!lastResults.length) {
            const empty = document.createElement('div');
            empty.className = 'zine-empty';
            empty.textContent = '选一种纸感，点「生成纸刊」。标题和短句可以留空，每次会画出 4 种构图变化供你挑。';
            box.appendChild(empty);
            return;
        }
        lastResults.forEach((r) => {
            const card = document.createElement('div'); card.className = 'zine-card';
            const img = document.createElement('img');
            img.src = r.image; img.alt = r.name;
            card.appendChild(img);
            const meta = document.createElement('div'); meta.className = 'zine-card-meta';
            const kicker = document.createElement('div'); kicker.className = 'zine-card-kicker';
            kicker.textContent = '纸刊已生成';
            meta.appendChild(kicker);
            const name = document.createElement('div'); name.className = 'zine-card-name';
            const nameText = document.createElement('span'); nameText.textContent = r.name;
            name.appendChild(nameText);
            if (Array.isArray(r.palette) && r.palette.length) {
                const sw = document.createElement('span');
                sw.className = 'zine-card-swatches'; sw.title = '从照片取出的主色';
                r.palette.slice(0, 4).forEach((c) => {
                    const dot = document.createElement('i');
                    dot.style.background = c; dot.title = c;
                    sw.appendChild(dot);
                });
                name.appendChild(sw);
            }
            const why = document.createElement('div'); why.className = 'zine-card-why';
            why.textContent = r.rationale || '用当前照片直接绘制';
            const size = document.createElement('div'); size.className = 'zine-card-size';
            size.textContent = '成品尺寸：' + (r.size || '按照片比例');
            const acts = document.createElement('div'); acts.className = 'zine-card-acts';
            const use = document.createElement('button');
            use.type = 'button'; use.className = 'mini-btn primary'; use.textContent = '作为照片导入';
            use.addEventListener('click', () => importAsPhoto(r));
            const save = document.createElement('button');
            save.type = 'button'; save.className = 'mini-btn'; save.textContent = '下载 PNG';
            save.addEventListener('click', () => savePng(r));
            acts.appendChild(use); acts.appendChild(save);
            const tip = document.createElement('div'); tip.className = 'zine-card-tip';
            tip.textContent = '想换纸感或改字？调整上面的选项再点一次「生成纸刊」。';
            meta.appendChild(name); meta.appendChild(why); meta.appendChild(size);
            meta.appendChild(acts); meta.appendChild(tip);
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
            // collect-images 返回的是 { items, skipped }，不是数组；旧代码把对象当数组，
            // 于是每次点「作为照片导入」都会报「图片未被识别」。
            const collected = await a.collectImages([saved.path]);
            const items = (collected && collected.items) || (Array.isArray(collected) ? collected : []);
            if (!items.length) throw new Error('导入失败：图片未被识别');
            const inst = window.App || {};
            if (typeof inst.importPicked !== 'function') throw new Error('应用还没准备好接收图片');
            await inst.importPicked(items, (collected && collected.skipped) || 0);
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
        adoptIntoStudio();
        // 默认选上次那条；第一次打开选第一种。只有本机渲染器能画的风格才进列表。
        rebuildPresetOptions();
        const savedId = promptLib().selectedId && promptLib().selectedId();
        const R = window.QfsZineRender || {};
        const first = (builtinList()[0] || {}).id;
        const startId = (savedId && R.PRESETS && R.PRESETS.indexOf(savedId) >= 0 && promptLib().get(savedId)) ? savedId : first;
        if (startId) applyPreset(startId, true);
        const sel = $('zinePromptPreset');
        if (sel) sel.addEventListener('change', () => applyPreset(sel.value));
        const copy = $('btnZineCopyPrompt');
        if (copy) copy.addEventListener('click', async () => {
            const ta = $('zinePrompt');
            const text = ta ? String(ta.value || '') : '';
            if (!text.trim()) return;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
                else { ta.select(); document.execCommand('copy'); }
                setStatus('提示词已复制，可以粘贴到别的工具里用');
            } catch (_) {
                ta.select();
                setStatus('已选中提示词，按 Ctrl+C 复制');
            }
        });
        const close = $('zineClose'); if (close) close.addEventListener('click', backToFrame);
        const tab = $('tabFrameStudio'); if (tab) tab.addEventListener('click', backToFrame);
        const make = $('btnZineMake'); if (make) make.addEventListener('click', generate);
        // 标题/短句一改，四张风格预览跟着变，所见即所得
        ['zineSubject', 'zineMood'].forEach((id) => {
            const el = $(id);
            if (el) el.addEventListener('input', () => schedulePreviews(260));
        });
        const bold = $('zineBold');
        if (bold) bold.addEventListener('change', () => schedulePreviews());
        const again = $('btnZineAgain');
        if (again) again.addEventListener('click', () => generate());
        schedulePreviews();
    }

    window.QfsZinePanel = { init, show, hide, backToFrame, generate, renderResults, get results() { return clone(lastResults); } };
})();

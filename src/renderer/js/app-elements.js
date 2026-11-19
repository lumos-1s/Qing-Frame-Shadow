// 元素模块：命中检测 / 坐标换算 / 选择框 / 元素增删与对齐 —— 从 app.js 拆分

// Logo 编辑时的放大上限（绘制宽度，单位与 el.size / 缩放输入框一致）
const LOGO_MAX_SIZE = 500;

// 拖动/缩放/旋转前要记住的几何字段。只抄几何，不抄 dataUrl / src 这类大字符串：
// 每次按下都整份克隆 Logo 的 base64 会明显拖慢 mousedown。
const EL_GEOMETRY_KEYS = [
    'x', 'y', 'rel', 'rx', 'ry', 'offsetX', 'offsetY', 'align',
    'rotation', 'size', 'scale',
    'fontSize', 'letterSpacing', 'strokeWidth',
    'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
    'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2',
    'w', 'h', 'radius', 'width', 'maxW', 'maxLines'
];

window.App = Object.assign(window.App || {}, {
    screenToCanvas(e) {
        const canvas = this.dom.canvas;
        const rect = canvas.getBoundingClientRect();
        // 与 puzzlePx 一致:用 DOM 渲染尺寸(已含 CSS 缩放/平移)的比例换算到画布像素,避免二次除以 zoom
        const cx = (rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0) * canvas.width;
        const cy = (rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0) * canvas.height;
        return { x: cx, y: cy, cw: canvas.width, ch: canvas.height };
    },

    hasEl(list, el) { return list.some(x => x.kind === el.kind && x.obj === el.obj); },

    /* 画布上选中元素后，把右侧面板翻到能改它的地方并滚到对应分组：
       文字 → 「文字」页签的「自定义文字」组；Logo / 贴纸 → 「Logo」页签的「元素管理」组。
       以前只有「双击文字」会翻页签，点选 Logo 时右侧还停在别的页签，用户得自己找。 */
    revealElementPanel(kind) {
        // AI 图层的可编辑属性不在右侧面板里，别把用户从 AI 造型的工作流里翻走。
        if (kind === 'aiLayer') return;
        const tab = (kind === 'text') ? 'text' : 'logo';
        const panel = document.getElementById('panel-' + tab);
        if (!panel) return;
        if (!panel.classList.contains('active') && typeof this.switchTab === 'function') this.switchTab(tab);
        const anchor = document.getElementById(tab === 'text' ? 'grpCustomText' : 'grpElManage');
        const body = document.querySelector('#inspector .insp-body');
        if (!anchor || !body) return;
        // 自己算滚动量：scrollIntoView 会连带把外层容器一起滚走
        const ar = anchor.getBoundingClientRect();
        const br = body.getBoundingClientRect();
        if (ar.top < br.top || ar.bottom > br.bottom) {
            body.scrollTop += (ar.top - br.top) - 8;
        }
    },

    // 命中检测:logo/贴纸/自由文字/AI 边框图层
    pickElement(pt) {
        const hitLogo = this.hitTestLogos(pt);
        const hitStk = this.hitTestStickers(pt);
        const hitTxt = this.hitTestTexts(pt);
        const hitAi = this.hitTestAiLayers(pt);
        const cands = [hitLogo, hitStk, hitTxt, hitAi].filter(Boolean);
        if (!cands.length) return null;
        cands.sort((a, b) => (b.z || 0) - (a.z || 0));
        return cands[0];
    },

    // 统一的「取消选中」出口：Esc、点画布外、AI 面板切换都用它，
    // 避免只在某个分支清 selectedEls 而参考线/选择框/右侧列表残留。
    clearElementSelection(opts) {
        const had = !!(this.selectedEls && this.selectedEls.length);
        this.selectedEls = [];
        this._aiGuides = null;
        this._aiSnap = null;
        if (this._hideRotateHint) this._hideRotateHint();
        if (this.refreshElList) this.refreshElList();
        if (this.scheduleRender) this.scheduleRender(true);
        if (had && !(opts && opts.silent)) this.setStatus('已取消选中元素');
        return had;
    },

    // 记录/还原元素的几何字段：Esc 取消拖动时要回到按下前，而 AI 图层、
    // 锚定文字解锁都会新增/删除字段，单纯赋值 x/y 还原不干净。
    snapshotElementGeometry(el) {
        const out = {};
        if (!el || typeof el !== 'object') return out;
        EL_GEOMETRY_KEYS.forEach(k => {
            if (Object.prototype.hasOwnProperty.call(el, k)) out[k] = el[k];
        });
        return out;
    },

    restoreElementGeometry(el, snap) {
        if (!el || typeof el !== 'object' || !snap) return false;
        EL_GEOMETRY_KEYS.forEach(k => {
            if (Object.prototype.hasOwnProperty.call(snap, k)) el[k] = snap[k];
            else delete el[k];
        });
        return true;
    },

    // 手势第一次真正产生改动时才压撤销。记下 pushUndo 会清空的重做栈，
    // Esc 取消时原样还回去，避免「取消一次拖动」把用户原有的重做记录吃掉。
    pushGestureUndo(holder) {
        if (!holder || holder.undoPushed) return;
        holder.redo0 = (this.redoStack || []).slice();
        holder.undoPushed = true;
        this.pushUndo();
    },

    dropGestureUndo(holder) {
        if (!holder || !holder.undoPushed) return;
        if (this.undoStack && this.undoStack.length) this.undoStack.pop();
        this.redoStack = holder.redo0 || [];
        if (this.updateHistoryButtons) this.updateHistoryButtons();
        holder.undoPushed = false;
    },

    // 测量文字用的离屏 ctx：AI 图层的 textLayout 需要 measureText，
    // 借用主画布 ctx 会改它的 font/textAlign，可能污染正在进行的绘制。
    aiMeasureCtx() {
        if (!this._aiMeasureCtx) {
            const c = document.createElement('canvas');
            c.width = c.height = 1;
            this._aiMeasureCtx = c.getContext('2d');
        }
        return this._aiMeasureCtx;
    },

    // AI 自由图层：比例坐标 × 画布像素 = 命中框；数组顺序就是 z 序。
    // 用户自己的文字/Logo 画在 AI 边框之上，所以它们的 z 更高、优先命中。
    hitTestAiLayers(pt) {
        const layers = this.template && this.template.aiLayers;
        const cv = this.dom && this.dom.canvas;
        if (!cv || !(cv.width > 1) || !Array.isArray(layers) || !layers.length) return null;
        if (!window.AiLayers || typeof window.AiLayers.hitTest !== 'function') return null;
        const k = this.textSpaceScale();
        const tol = Math.max(6, 8 * k);
        const hit = window.AiLayers.hitTest(this.aiMeasureCtx(), layers, pt.x, pt.y, cv.width, cv.height, tol);
        if (!hit) return null;
        const c = window.AiLayers.layerCenter(hit.layer, cv.width, cv.height) || { x: pt.x, y: pt.y };
        return { kind: 'aiLayer', obj: hit.layer, index: hit.index, x0: c.x, y0: c.y, z: 1 + hit.index };
    },

    // AI 图层的吸附基准：画布像素 ↔ 引擎基准画布。
    aiCanvasBase() {
        const cv = this.dom && this.dom.canvas;
        return {
            cw: (cv && cv.width) || 0, ch: (cv && cv.height) || 0,
            bw: this._canvasBaseW || (cv && cv.width) || 1,
            bh: this._canvasBaseH || (cv && cv.height) || 1
        };
    },

    // 照片槽位的像素矩形：优先用引擎这一帧写下的 _photoRect，回退到图层槽位比例。
    aiPhotoRect(cw, ch) {
        const { bw, bh } = this.aiCanvasBase();
        const sx = cw / Math.max(1, bw), sy = ch / Math.max(1, bh);
        if (this._photoRect) {
            const r = this._photoRect;
            return { x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy };
        }
        const layers = this.template && this.template.aiLayers;
        if (!Array.isArray(layers) || !window.AiLayers) return null;
        const pi = window.AiLayers.findPhotoIndex(layers);
        if (pi < 0) return null;
        const s = window.AiLayers.photoSlot(layers[pi]);
        return { x: s.x * cw, y: s.y * ch, w: s.w * cw, h: s.h * ch };
    },

    // AI 图层吸附：拖动中的图层左/中/右（上/中/下）去贴画布三分线、画布边、
    // 照片槽位边/中线、以及其它 AI 图层的边/中线。返回修正后的中心和要画的参考线。
    aiSnapGuides(cx, cy, layer, cw, ch) {
        const layers = this.template && this.template.aiLayers;
        const out = { x: cx, y: cy, guides: [] };
        if (!window.AiLayers || typeof window.AiLayers.layerBounds !== 'function'
            || !Array.isArray(layers) || !layer) return out;
        const ctx = this.aiMeasureCtx();
        const b = window.AiLayers.layerBounds(ctx, layer, cw, ch);
        if (!b) return out;
        // Alt 临时关掉吸附（跟设计软件一致），不改变任何设置。
        if (this._aiSnapOff) { this._aiGuides = []; return out; }
        const rect = this.dom.canvas.getBoundingClientRect();
        const k = rect.width > 0 ? cw / rect.width : 1;
        const tol = 8 * k;
        const vLines = [], hLines = [];
        const V = (pos, type) => vLines.push({ pos, type });
        const H = (pos, type) => hLines.push({ pos, type });
        [cw / 3, cw / 2, cw * 2 / 3].forEach(p => V(p, 'grid'));
        [ch / 3, ch / 2, ch * 2 / 3].forEach(p => H(p, 'grid'));
        V(0, 'edge'); V(cw, 'edge'); H(0, 'edge'); H(ch, 'edge');
        const pr = this.aiPhotoRect(cw, ch);
        if (pr) {
            V(pr.x, 'photo'); V(pr.x + pr.w / 2, 'photo'); V(pr.x + pr.w, 'photo');
            H(pr.y, 'photo'); H(pr.y + pr.h / 2, 'photo'); H(pr.y + pr.h, 'photo');
        }
        layers.forEach(l => {
            if (!l || l === layer) return;
            const ob = window.AiLayers.layerBounds(ctx, l, cw, ch);
            if (!ob) return;
            V(ob.x, 'layer'); V(ob.x + ob.w / 2, 'layer'); V(ob.x + ob.w, 'layer');
            H(ob.y, 'layer'); H(ob.y + ob.h / 2, 'layer'); H(ob.y + ob.h, 'layer');
        });
        // b 是当前（未被拖动）的包围盒，cx/cy 是「想把中心挪到哪」。
        // 所以锚点偏移要相对包围盒自己的中心，不能相对 cx —— 否则
        // 当前位置和目标位置的差会被算进偏移里，吸附到错误的那条线。
        const av = [
            { off: -b.w / 2, tag: 'left' },
            { off: 0, tag: 'center' },
            { off: b.w / 2, tag: 'right' }
        ];
        const ah = [
            { off: -b.h / 2, tag: 'top' },
            { off: 0, tag: 'center' },
            { off: b.h / 2, tag: 'bottom' }
        ];
        let bestV = null, bestH = null;
        for (const line of vLines) for (const a of av) {
            const d = line.pos - (cx + a.off);
            if (Math.abs(d) <= tol && (!bestV || Math.abs(d) < Math.abs(bestV.d))) bestV = { d, line, anchor: a };
        }
        for (const line of hLines) for (const a of ah) {
            const d = line.pos - (cy + a.off);
            if (Math.abs(d) <= tol && (!bestH || Math.abs(d) < Math.abs(bestH.d))) bestH = { d, line, anchor: a };
        }
        if (bestV) { out.x = cx + bestV.d; out.guides.push({ axis: 'v', pos: bestV.line.pos, type: bestV.line.type }); }
        if (bestH) { out.y = cy + bestH.d; out.guides.push({ axis: 'h', pos: bestH.line.pos, type: bestH.line.type }); }
        this._aiGuides = out.guides;
        this._aiSnap = { x: out.x, y: out.y };
        return out;
    },

    hitTestLogos(pt) {
        const els = (this.template && this.template.logoElements) || [];
        // rel 比例(rx/ry)已统一为「显示画布 canvas.width/height」的分数,与引擎
        // drawLogoElements 同一口径;此处传 logoBaseForOverlay()(基准口径)只供锚点/
        // 像素分支使用,rel 分支会自行按当前 canvas 解析,与基准/显示无关。
        const base = this.logoBaseForOverlay();
        for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            // 命中框跟实际绘制尺寸走：旧模板/导入模板里超过上限的 size 不能
            // 让用户点在看不见的“大框”上。
            const size = this._logoDrawSize(el, 'logo').w;
            const pos = this.logoPos(el, base.w, base.h, size);
            if (Math.abs(pt.x - pos.cx) <= size / 2 && Math.abs(pt.y - pos.cy) <= size / 2) {
                return { kind: 'logo', obj: el, x0: pos.cx, y0: pos.cy, z: el.z || 0 };
            }
        }
        return null;
    },

    hitTestStickers(pt) {
        const stickers = (this.template && this.template.decorConfig && this.template.decorConfig.stickers) || [];
        for (let i = stickers.length - 1; i >= 0; i--) {
            const el = stickers[i];
            const tex = this.textureEl(el.src);
            if (!tex) continue;
            const sw = tex.naturalWidth * (el.scale || 1), sh = tex.naturalHeight * (el.scale || 1);
            if (Math.abs(pt.x - el.x) <= sw / 2 && Math.abs(pt.y - el.y) <= sh / 2) {
                return { kind: 'sticker', obj: el, x0: el.x, y0: el.y, z: (el.z || 0) + 5 };
            }
        }
        return null;
    },

    // 文字坐标是「画布逻辑像素」，而命中点来自 screenToCanvas（含 DPR 的画布像素）。
    // 两者差一个 scale，DPR≠1 时不换算就会「点在这里、拖去那里」。
    textSpaceScale() {
        const cv = this.dom && this.dom.canvas;
        if (!cv || !(cv.width > 1)) return 1;
        const lw = (cv._logW > 1) ? cv._logW : cv.width;
        return cv.width / lw;
    },

    // 引擎的「EXIF 参数条」占位行：exifAutoText 开启时这行会被换成相机参数（原地换字，
    // 字号/颜色沿用），因此在元素列表/命中里也按「原样文字」处理没有意义 ——
    // 用户点到的会是看不见的原字。
    _isHiddenExifLine(el, decor) {
        if (!el || !el.text) return false;
        const d = decor || (this.template && this.template.decorConfig) || {};
        if ((d.exifAutoText || 0) !== 1) return false;
        const lines = d.textLines || [];
        const idx = lines.findIndex(l => l.text && (l.align === 'bottom' || l.align === 'exif'));
        return idx >= 0 && lines[idx] === el;
    },

    hitTestTexts(pt) {
        const decor = (this.template && this.template.decorConfig) || {};
        const lines = decor.textLines || [];
        const cv = this.dom && this.dom.canvas;
        if (!cv || !(cv.width > 1) || !lines.length) return null;
        const cw = (cv._logW > 1) ? cv._logW : cv.width;
        const ch = (cv._logH > 1) ? cv._logH : cv.height;
        const k = this.textSpaceScale();
        const px = pt.x / k, py = pt.y / k;
        const metrics = window.textLineMetrics;
        if (typeof metrics !== 'function') return null;
        for (let i = lines.length - 1; i >= 0; i--) {
            const el = lines[i];
            if (!el.text || this._isHiddenExifLine(el, decor)) continue;
            // 外框已经含方向与角度：竖排/侧排/旋转都按同一套几何判定
            const m = metrics(el, cw, ch, false, 0, 0);
            if (px >= m.x && px <= m.x + m.w && py >= m.y && py <= m.y + m.h) {
                return { kind: 'text', obj: el, x0: m.cx, y0: m.cy, z: (el.z || 0) + 3 };
            }
        }
        return null;
    },

    // 把「锚定在底边/顶边」的文字就地解锁成自由文字：坐标取当前几何框的中心，
    // 所以画面一格都不跳。之后拖拽/输入才真的动得了它。
    // 文字在「逻辑画布」里的几何（绘制口径）。算不出来时返回 null。
    textMetricsOf(el) {
        const cv = this.dom && this.dom.canvas;
        const cw = (cv && cv._logW > 1) ? cv._logW : (cv ? cv.width : 0);
        const ch = (cv && cv._logH > 1) ? cv._logH : (cv ? cv.height : 0);
        if (!(cw > 1) || !(ch > 1) || typeof window.textLineMetrics !== 'function') return null;
        return window.textLineMetrics(el, cw, ch, false, 0, 0);
    },

    // 逻辑画布尺寸（绘制口径）。文字的一切坐标都按这个口径存。
    _logCanvas() {
        const cv = this.dom && this.dom.canvas;
        return {
            w: (cv && cv._logW > 1) ? cv._logW : (cv ? cv.width : 0),
            h: (cv && cv._logH > 1) ? cv._logH : (cv ? cv.height : 0),
        };
    },

    // ── 文字工具（像 PS 那样：双击画布落字、画布内编辑、拖角缩放）──
    // 必须先点右侧「文字」页签里的「添加文字」进入放置状态，再双击画布才创建；
    // 这样位置是用户双击的位置，也不会在普通浏览时误触新建文字。
    beginAddText() {
        // 再点一次按钮 = 取消（和 PS 工具按钮一样是可切换的）
        if (this._textPlaceMode) { this.cancelAddText(); return; }
        if (!this.image) { this.setStatus('先导入一张照片，再添加文字'); return; }
        const { w, h } = this._logCanvas();
        if (!(w > 1) || !(h > 1)) { this.setStatus('先导入一张照片，再添加文字'); return; }
        this._textPlaceMode = true;
        this.dom.canvas.style.cursor = 'text';
        // 文字设置在「文字」页签：进入放置态就把它翻出来，放好字后不用再找。
        if (typeof this.switchTab === 'function') this.switchTab('text');
        this.setStatus('添加模式：在画布上双击放置文字；Esc 取消');
        this._syncAddTextBtn();
    },

    // 兼容旧调用点/测试：以前这里直接弹窗新建，现在进入放置状态
    addFreeText() { this.beginAddText(); },

    cancelAddText() {
        if (!this._textPlaceMode) return;
        this._textPlaceMode = false;
        if (this.dom.canvas) this.dom.canvas.style.cursor = '';
        this.setStatus('已取消添加文字');
        this._syncAddTextBtn();
    },

    // 右侧「文字」页签里的入口按钮要能看出「正在放置」：再点一次可取消，
    // 和 PS 里工具按钮的按下态一致。
    _syncAddTextBtn() {
        const btn = document.getElementById('btnAddFreeText');
        if (!btn) return;
        const on = !!this._textPlaceMode;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.textContent = on ? '✕ 取消添加文字' : '＋ 添加文字（双击画布放置）';
        btn.title = on
            ? '正在添加文字：在画布上双击放置；Esc 取消'
            : '点一下进入添加模式，再在画布上双击你要放字的位置；双击已有文字改内容';
    },

    // 在逻辑画布坐标 (lx, ly) 创建一段文字，并立刻进入画布内编辑。
    // 字号按短边 6% 起步；默认给一层很轻的阴影，白字放在亮照片上也读得清。
    createTextAt(lx, ly) {
        const { w, h } = this._logCanvas();
        if (!(w > 1) || !(h > 1)) { this.setStatus('先导入一张照片，再添加文字'); return null; }
        this._textPlaceMode = false;
        if (this.dom.canvas) this.dom.canvas.style.cursor = '';
        this._syncAddTextBtn();
        const tpl = this.template || (this.template = this.defaultTemplate());
        const decor = tpl.decorConfig || (tpl.decorConfig = {});
        if (!decor.textLines) decor.textLines = [];
        const fs = Math.max(12, Math.round(Math.min(w, h) * 0.06));
        const line = {
            text: '文字',
            align: 'free',
            x: Math.round(Math.max(0, Math.min(w, lx))),
            y: Math.round(Math.max(0, Math.min(h, ly))),
            fontFamily: 'Microsoft YaHei',
            fontSize: fs,
            fontWeight: 400,
            letterSpacing: 0,
            colorHex: '#ffffff',
            opacity: 100,
            rotation: 0,
            enableShadow: 1,
            shadowColorHex: '#000000',
            shadowOpacity: 45,
            shadowBlur: Math.max(2, Math.round(fs * 0.18)),
            shadowOffsetX: 0,
            shadowOffsetY: Math.max(1, Math.round(fs * 0.05)),
        };
        // 先压撤销快照，再写入新元素：撤销时应当「整段文字消失」，而不是退回占位字
        this.pushUndo();
        decor.textLines.push(line);
        this.selectedEls = [{ kind: 'text', obj: line }];
        this.refreshElList();
        this.openTextEditor(line, { isNew: true, pushedUndo: true });
        this.scheduleRender(true);
        return line;
    },

    // 双击已有文字 → 画布内编辑（不再弹 prompt）。textarea 用与画布同一套
    // 字体/字号/字距/旋转，输入时实时回写，Ctrl+Enter 或失焦提交，Esc 取消。
    editTextContent(el) {
        if (!el) return;
        // 画布双击传来的是选中对象；AI 图层要连 kind/index 一起带给编辑器，
        // 否则编辑器会按普通 decor 文字处理（字段格式完全不同）。
        if (el.kind === 'aiLayer' && el.obj) this.openTextEditor(el.obj, { aiLayerSel: el });
        else this.openTextEditor(el);
    },

    _textEditorCssScale(cv) {
        const rect = cv.getBoundingClientRect();
        const lw = (cv._logW > 1) ? cv._logW : cv.width;
        return lw > 0 ? rect.width / lw : 1;
    },

    _textEditorMetrics(el, isAi) {
        const cv = this.dom && this.dom.canvas;
        if (!cv) return null;
        const lw = (cv._logW > 1) ? cv._logW : cv.width;
        const lh = (cv._logH > 1) ? cv._logH : cv.height;
        if (!(lw > 1) || !(lh > 1)) return null;
        if (isAi) {
            if (!window.AiLayers || typeof window.AiLayers.textLayout !== 'function') return null;
            // AI 的布局结果本来就是像素口径，直接拿来定位 textarea 即可（rot 恒为 0）。
            const m = window.AiLayers.textLayout(this.aiMeasureCtx(), el, lw, lh);
            if (!m) return null;
            return { cx: m.cx, cy: m.cy, lw: m.lw, lh: m.lh, fs: m.size, ls: m.tracking, rot: 0 };
        }
        if (typeof window.textLineMetrics !== 'function') return null;
        return window.textLineMetrics(el, lw, lh, false, 0, 0);
    },

    _positionTextEditor() {
        const st = this._textEditor;
        if (!st) return;
        const cv = this.dom.canvas;
        const m = this._textEditorMetrics(st.el, !!st.ai);
        if (!cv || !m) return;
        const rect = cv.getBoundingClientRect();
        const css = this._textEditorCssScale(cv);
        const fsCss = Math.max(8, m.fs * css);
        const boxW = Math.max(30, m.lw * css + 6, (m.dir === 'v' ? fsCss * 4 : 0));
        const boxH = Math.max(24, m.lh * css + 4, (m.dir === 'v' ? fsCss * 2 : 0));
        const ta = st.ta;
        ta.style.left = (rect.left + m.cx * css) + 'px';
        ta.style.top = (rect.top + m.cy * css) + 'px';
        ta.style.width = boxW + 'px';
        ta.style.height = boxH + 'px';
        ta.style.transform = `translate(-50%,-50%) rotate(${m.rot}deg)`;
        ta.style.fontSize = fsCss + 'px';
        ta.style.fontFamily = `"${st.ai ? (st.el.font || 'sans-serif') : (st.el.fontFamily || 'Microsoft YaHei')}"`;
        ta.style.fontWeight = String(st.ai ? (st.el.weight || 400) : (st.el.fontWeight || 400));
        ta.style.letterSpacing = (m.ls * css) + 'px';
        ta.style.color = this._hex6(st.ai ? (st.el.color || '#ffffff') : st.el.colorHex);
    },

    openTextEditor(el, opts) {
        this.commitTextEditor();
        if (!el) return;
        const cv = this.dom && this.dom.canvas;
        if (!cv) return;
        const aiSel = (opts && opts.aiLayerSel) || null;
        const ai = !!aiSel || (opts && opts.aiLayer === true);
        const m = this._textEditorMetrics(el, ai);
        if (!m) return;
        this.selectedEls = [aiSel || { kind: 'text', obj: el }];
        this.refreshElList();
        // 双击画布上的文字/新建文字时，把「文字」页签翻出来：字体/字号/描边就在眼前。
        // AI 图层没有对应面板（属性在 AI 造型里），不要乱翻页签。
        if (!ai && typeof this.switchTab === 'function') this.switchTab('text');
        const pushedUndo = !(opts && opts.pushedUndo);
        if (pushedUndo) this.pushUndo();
        const ta = document.createElement('textarea');
        ta.className = 'canvas-text-editor';
        ta.value = String(el.text == null ? '' : el.text);
        ta.spellcheck = false;
        ta.setAttribute('wrap', 'off');
        ta.style.position = 'fixed';
        ta.style.zIndex = '9999';
        ta.style.margin = '0';
        ta.style.padding = '0 2px';
        ta.style.border = '1px dashed #00e5a0';
        ta.style.borderRadius = '3px';
        ta.style.background = 'rgba(0,0,0,0.22)';
        ta.style.boxSizing = 'border-box';
        ta.style.lineHeight = '1.18';
        ta.style.textAlign = 'center';
        ta.style.overflow = 'hidden';
        ta.style.resize = 'none';
        ta.style.outline = 'none';
        ta.style.caretColor = '#00e5a0';
        ta.style.whiteSpace = 'pre';
        const state = {
            el, ta, ai,
            initial: ta.value,
            isNew: !!(opts && opts.isNew),
            pushedUndo: true,
            cancelled: false,
        };
        this._textEditor = state;
        this._positionTextEditor();
        // 先把画布上的旧字清掉，再把 textarea 放进 DOM。只 scheduleRender 不够：
        // 大图一帧要 100ms 以上，这期间半透明输入框会盖在旧字上，看起来就是重影。
        // 同步重画只发生在「打开编辑器」这一次，输入时仍走 rAF 队列。
        let cleanCanvas = false;
        try {
            if (typeof this.renderPreview === 'function') {
                this.renderPreview();
                cleanCanvas = true;
            }
        } catch (e) {
            console.warn('openTextEditor render', e);
        }
        document.body.appendChild(ta);
        this._positionTextEditor();
        ta.focus();
        this.setStatus((opts && opts.isNew ? '输入文字' : '编辑文字') + '；Ctrl+Enter 完成，Esc 取消');
        if (opts && opts.caretEnd) {
            const n = ta.value.length;
            ta.setSelectionRange(n, n);
        } else {
            ta.select();
        }
        ta.addEventListener('input', () => {
            el.text = ta.value;
            this._positionTextEditor();
            this.scheduleRender();
        });
        ta.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.cancelTextEditor();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.commitTextEditor();
            } else if (e.key === 'Tab') {
                e.preventDefault();
                this.commitTextEditor();
            }
        });
        ta.addEventListener('blur', () => {
            if (this._textEditor === state) this.commitTextEditor();
        });
        // 同步重画失败时的兜底：至少下一帧会把旧字清掉，不至于一直叠着。
        if (!cleanCanvas) this.scheduleRender(true);
    },

    _dropUndo() {
        if (this.undoStack && this.undoStack.length) {
            this.undoStack.pop();
            this.updateHistoryButtons();
        }
    },

    _removeTextEl(el) {
        const arr = (this.template && this.template.decorConfig && this.template.decorConfig.textLines) || [];
        const i = arr.indexOf(el);
        if (i >= 0) arr.splice(i, 1);
        this.selectedEls = (this.selectedEls || []).filter(s => s.obj !== el);
    },

    commitTextEditor() {
        const st = this._textEditor;
        if (!st) return;
        this._textEditor = null;
        st.ta.remove();
        const el = st.el;
        const text = st.ta.value;
        if (!String(text).trim()) {
            if (st.ai) {
                // AI 图层不能像 decor 文字那样「空了就删层」：删掉会破坏边框构图，
                // 而且引擎还会留着 photo 槽位，视觉上是整款边框突然废了。
                el.text = st.initial;
                if (st.pushedUndo) this._dropUndo();
                this.saveCurrentTemplate();
                this.scheduleRender(true);
                this.setStatus('文字不能为空，已保留原字');
                if (this._syncAiLayerEdit) this._syncAiLayerEdit();
                return;
            }
            this._removeTextEl(el);
            if (st.pushedUndo) this._dropUndo();
            this.refreshElList();
            this.saveCurrentTemplate();
            this.scheduleRender(true);
            this.setStatus('文字为空，已移除');
            return;
        }
        if (st.isNew && text === st.initial) {
            // 新建后没改占位字：当作取消，别留下一个“文字”层
            this._removeTextEl(el);
            if (st.pushedUndo) this._dropUndo();
            this.refreshElList();
            this.saveCurrentTemplate();
            this.scheduleRender(true);
            this.setStatus('已取消添加文字');
            return;
        }
        el.text = text;
        if (text === st.initial && st.pushedUndo) this._dropUndo();
        this.refreshElList();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus(st.ai ? 'AI 边框文字已更新' : '文字已更新');
        if (st.ai && this._syncAiLayerEdit) this._syncAiLayerEdit();
    },

    cancelTextEditor() {
        const st = this._textEditor;
        if (!st) return;
        this._textEditor = null;
        st.cancelled = true;
        st.ta.remove();
        st.el.text = st.initial;
        if (st.isNew) this._removeTextEl(st.el);
        if (st.pushedUndo) this._dropUndo();
        this.refreshElList();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus(st.isNew ? '已取消添加文字' : '已取消编辑');
        if (st.ai && this._syncAiLayerEdit) this._syncAiLayerEdit();
    },

    // ── 鼠标旋转 ──
    // 把手画在选中框上方（drawSelectionBox 里算好坐标存在 _rotHandle），
    // 命中检测直接读它 —— 两处各算一遍角度迟早对不上。
    hitRotateHandle(pt) {
        const hd = this._rotHandle;
        const sel = this.selectedEls;
        // 同 hitResizeHandle：选中态已变但还没重绘时，旧把手不能再生效
        if (!hd || !sel || sel.length !== 1 || sel[0].kind !== 'text') return null;
        return Math.hypot(pt.x - hd.x, pt.y - hd.y) <= hd.r + 6 ? hd : null;
    },

    // 悬停旋转把手时在把手附近显示提示：画布默认光标就是 grab，
    // 只换 cursor 用户看不出变化，必须给一个可见的「可拖动」反馈。
    _showRotateHint(hd) {
        const hint = document.getElementById('rotHint');
        const cv = this.dom && this.dom.canvas;
        const stage = this.dom && this.dom.stage;
        if (!hint || !cv || !stage || !hd) return;
        const cr = cv.getBoundingClientRect();
        const sr = stage.getBoundingClientRect();
        if (!(cr.width > 0) || !(cr.height > 0)) return;
        hint.style.left = (cr.left - sr.left + (hd.x / Math.max(1, cv.width)) * cr.width) + 'px';
        hint.style.top = (cr.top - sr.top + (hd.y / Math.max(1, cv.height)) * cr.height - 12) + 'px';
        hint.hidden = false;
    },

    _hideRotateHint() {
        const hint = document.getElementById('rotHint');
        if (hint) hint.hidden = true;
    },

    beginRotate(pt) {
        const sel = this.selectedEls && this.selectedEls[0];
        if (!sel || !sel.obj) return null;
        const m = this.textMetricsOf(sel.obj);
        if (!m) return null;
        const k = this.textSpaceScale();
        const px = pt.x / k, py = pt.y / k;
        // 旋转只改这一段文字：把它从背景合成里排除，之后每帧只需
        // 「拷贝静态背景 + 重画文字 + 选择框」，不再整帧重排文字。
        this._skipUserEl = sel.obj;
        this._dropDragBase();
        this._hideRotateHint();
        this._primeTransformGuides(sel.obj, 'text', m.cx, m.cy);
        this._rotEl = {
            ref: sel.obj, kind: sel.kind,
            cx: m.cx, cy: m.cy,
            base: Number(sel.obj.rotation) || 0,
            a0: Math.atan2(py - m.cy, px - m.cx),
            moved: false,
            orig: this.snapshotElementGeometry(sel.obj),
        };
        return this._rotEl;
    },

    // shiftKey 时按 15° 吸附，和 PS 一致
    applyRotate(pt, shift) {
        const r = this._rotEl;
        if (!r) return;
        const k = this.textSpaceScale();
        const px = pt.x / k, py = pt.y / k;
        const a = Math.atan2(py - r.cy, px - r.cx);
        let deg = r.base + (a - r.a0) * 180 / Math.PI;
        deg = ((deg % 360) + 360) % 360;
        if (shift) deg = (Math.round(deg / 15) * 15) % 360;
        const next = Math.round(deg * 10) / 10;
        if (!r.moved) {
            // 角度没变（常见于 Shift 吸附回原位）就不留撤销步
            if (next === r.base) return;
            r.moved = true;
            this.pushGestureUndo(r);
        }
        r.ref.rotation = next;
        this.scheduleRender();
    },

    // Esc 的「取消」语义：拖动/缩放/旋转到一半时按下，回到按下前的几何，
    // 并丢掉这次手势刚压入的撤销步；松手后不会再把半截修改提交出去。
    cancelElementGesture() {
        const drag = this._dragEl;
        const resize = this._resizeEl;
        const rot = this._rotEl;
        if (!drag && !resize && !rot) return false;
        let changed = false;
        if (drag) {
            this._dragEl = null;
            if (drag.moved) changed = this.restoreElementGeometry(drag.ref, drag.orig) || changed;
            this.dropGestureUndo(drag);
        }
        if (resize) {
            this._resizeEl = null;
            if (resize.moved) changed = this.restoreElementGeometry(resize.ref, resize.orig) || changed;
            this.dropGestureUndo(resize);
        }
        if (rot) {
            this._rotEl = null;
            if (rot.moved) changed = this.restoreElementGeometry(rot.ref, rot.orig) || changed;
            this.dropGestureUndo(rot);
        }
        this._skipAiLayer = null;
        this._skipUserEl = null;
        this._backingCap = 0;
        this._aiGuides = null; this._aiSnap = null; this._aiSnapOff = false;
        this._dropDragBase();
        this._logoSnapV = null; this._logoSnapH = null;
        this._logoSnapEdgeV = null; this._logoSnapEdgeH = null;
        this._logoSnapPhotoV = null; this._logoSnapPhotoH = null;
        this._hideRotateHint();
        if (this.dom && this.dom.canvas) this.dom.canvas.style.cursor = '';
        if (changed) {
            this.saveCurrentTemplate();
            this.setStatus('已取消本次修改');
        }
        this.refreshElList();
        this.scheduleRender(true);
        return true;
    },

    // 四角缩放手柄：drawSelectionBox 把四个角的物理像素坐标存在 _resizeHandles。
    // 命中半径要跟着 DPR 走，否则高分屏上 7px 的小方块只有 3.5 CSS px，点不中。
    hitResizeHandle(pt) {
        const hs = this._resizeHandles;
        const sel = this.selectedEls;
        // 取消选中后可能还没来得及重绘，旧手柄坐标仍在内存里；没有「单选文字」就不算命中
        if (!hs || !hs.length || !pt || !sel || sel.length !== 1
            || (sel[0].kind !== 'text' && sel[0].kind !== 'aiLayer')) return null;
        const k = this.textSpaceScale();
        const r = Math.max(8, 9 * k);
        for (const hd of hs) {
            if (Math.hypot(pt.x - hd.x, pt.y - hd.y) <= r) return hd;
        }
        return null;
    },

    // 以文字中心为基准，拖角 = 等比缩放字号（PS 的角手柄语义）。
    // 锚定文字第一次真正拖动时先解锁成自由文字，中心不变，画面不跳。
    beginResize(pt) {
        const sel = this.selectedEls && this.selectedEls[0];
        if (!sel || !sel.obj) return null;
        if (sel.kind === 'aiLayer') {
            // AI 图层的几何是比例坐标，包围盒直接按画布像素算；不进引擎的
            // 「排除被拖元素 + 静态背景」快通道（那套只认用户元素）。
            if (!window.AiLayers || typeof window.AiLayers.layerBounds !== 'function') return null;
            const cv = this.dom.canvas;
            const b = window.AiLayers.layerBounds(this.aiMeasureCtx(), sel.obj, cv.width, cv.height);
            if (!b) return null;
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
            this._dropDragBase();
            this._hideRotateHint();
            this._resizeEl = { ref: sel.obj, isAi: true, cx, cy,
                d0: Math.max(4, Math.hypot(pt.x - cx, pt.y - cy)), moved: false,
                orig: this.snapshotElementGeometry(sel.obj) };
            return this._resizeEl;
        }
        if (sel.kind !== 'text') return null;
        const m = this.textMetricsOf(sel.obj);
        if (!m) return null;
        const k = this.textSpaceScale();
        const px = pt.x / k, py = pt.y / k;
        // 和旋转同一套快速通道：背景缓存里先排除这段文字。
        this._skipUserEl = sel.obj;
        this._dropDragBase();
        this._hideRotateHint();
        this._primeTransformGuides(sel.obj, 'text', m.cx, m.cy);
        this._resizeEl = {
            ref: sel.obj,
            cx: m.cx,
            cy: m.cy,
            d0: Math.max(4, Math.hypot(px - m.cx, py - m.cy)),
            fs0: Math.max(1, Number(sel.obj.fontSize) || m.fs),
            ls0: Math.max(0, Number(sel.obj.letterSpacing) || 0),
            sw0: Math.max(0, Number(sel.obj.strokeWidth) || 0),
            sb0: Math.max(0, Number(sel.obj.shadowBlur) || 0),
            sx0: Number(sel.obj.shadowOffsetX) || 0,
            sy0: Number(sel.obj.shadowOffsetY) || 0,
            moved: false,
            orig: this.snapshotElementGeometry(sel.obj),
        };
        return this._resizeEl;
    },

    applyResize(pt) {
        const r = this._resizeEl;
        if (!r) return false;
        if (r.isAi) {
            const d = Math.hypot(pt.x - r.cx, pt.y - r.cy);
            if (!r.moved && Math.abs(d - r.d0) < 2) return false;
            if (!r.moved) { r.moved = true; this.pushGestureUndo(r); }
            const cv = this.dom.canvas;
            const ratio = Math.max(0.05, Math.min(20, d / r.d0));
            window.AiLayers.scaleLayer(r.ref, ratio, cv.width, cv.height);
            // 缩放不移动中心；只按当前包围盒刷新对齐参考线，给用户「贴上了」的反馈。
            const b = window.AiLayers.layerBounds(this.aiMeasureCtx(), r.ref, cv.width, cv.height);
            if (b) this.aiSnapGuides(b.x + b.w / 2, b.y + b.h / 2, r.ref, cv.width, cv.height);
            this._positionTextEditor();
            this.scheduleRender();
            return true;
        }
        const k = this.textSpaceScale();
        const px = pt.x / k, py = pt.y / k;
        const d = Math.hypot(px - r.cx, py - r.cy);
        // 手抖 1~2px 不该算一次缩放（会留下无意义的撤销步）
        if (!r.moved && Math.abs(d - r.d0) < 2) return false;
        if (!r.moved) {
            r.moved = true;
            this.pushGestureUndo(r);
            // 锚定文字没有可写的中心；先按当前几何中心解锁，再缩放
            if (r.ref.align !== 'free') this.promoteTextToFree(r.ref);
        }
        const ratio = Math.max(0.05, Math.min(20, d / r.d0));
        const fs = Math.max(4, Math.min(2000, Math.round(r.fs0 * ratio)));
        const kk = fs / r.fs0;
        r.ref.fontSize = fs;
        if (r.ls0 > 0) r.ref.letterSpacing = Math.round(r.ls0 * kk * 10) / 10;
        if (r.sw0 > 0) r.ref.strokeWidth = Math.round(r.sw0 * kk * 10) / 10;
        if (r.sb0 > 0) r.ref.shadowBlur = Math.round(r.sb0 * kk * 10) / 10;
        if (r.sx0) r.ref.shadowOffsetX = Math.round(r.sx0 * kk * 10) / 10;
        if (r.sy0) r.ref.shadowOffsetY = Math.round(r.sy0 * kk * 10) / 10;
        this.syncSliderFromEl({ kind: 'text', obj: r.ref });
        this._positionTextEditor();
        this.scheduleRender();
        return true;
    },

    promoteTextToFree(el) {
        if (!el || el.align === 'free') return false;
        const m = this.textMetricsOf(el);
        if (!m) return false;
        el.align = 'free';
        el.x = Math.round(m.cx);
        el.y = Math.round(m.cy);
        delete el.rel;   // rel 是 logo 的口径（canvas.width 分数），文字不用
        return true;
    },

    // 元素在画布上的中心点(像素)。三种坐标形式并存,按优先级解析:
    //   ① el.rel + 相对比例 rx/ry —— 以「显示画布 canvas.width/height」的比例存储,
    //                               换照片尺寸时按新画布还原不会错位,预览与导出同一分数
    //   ② el.x 为数字            —— 绝对像素坐标(旧模板的格式;新写入时与 ① 同时保存以兼容旧版)
    //   ③ el.x 为字符串          —— 锚点定位('right'/'bottom' + offsetX/offsetY),天然随画布自适应
    // rel 分支直接按当前 canvas 解析(不依赖调用方传基准还是显示尺寸),与引擎绘制同一口径;
    // 锚点/像素分支仍用传入的 cw/ch(调用方传基准口径,与引擎锚点一致)。
    logoPos(el, cw, ch, size) {
        if (!el) return { cx: cw / 2, cy: ch / 2 };
        if (el.rel && typeof el.rx === 'number' && typeof el.ry === 'number') {
            const cv = this.dom && this.dom.canvas;
            // 画布未知时(例如尚未渲染)退回后续分支,避免算出错误偏移
            if (cv && cv.width > 1 && cv.height > 1) {
                return { cx: el.rx * cv.width, cy: el.ry * cv.height };
            }
        }
        if (typeof el.x === 'number' && typeof el.y === 'number') {
            return { cx: el.x, cy: el.y };
        }
        const hAlign = el.x || 'right', vAlign = el.y || 'bottom';
        const ox = el.offsetX || 20, oy = el.offsetY || 20;
        // 半高按元素真实纵横比算(Logo 的 size 是宽度,高度 = size * ratio);
        // 原先上下都用 size/2,等于把非正方形 Logo 当正方形,导致上下留白与左右不一致。
        const ratio = (typeof el.ratio === 'number' && el.ratio > 0) ? el.ratio : 1;
        const hw = size / 2, hh = (size * ratio) / 2;
        const tx = hAlign === 'left' ? ox + hw : hAlign === 'center' ? cw / 2 : cw - ox - hw;
        const ty = vAlign === 'top' ? oy + hh : vAlign === 'center' ? ch / 2 : ch - oy - hh;
        return { cx: tx, cy: ty };
    },

    // 当前照片的「基准画布」尺寸(不含显示缩放与 DPR),rel 比例的换算基准。
    // 注意 _logW/_logH 由引擎渲染时写入,切换照片后到下一次渲染完成前仍是「上一张图」的值。
    // 因此校验 canvas.width ≈ _logW × devicePixelRatio:两者对不上说明 _log 是上一张图的残留,
    // 此时返回 null,调用方退回像素坐标(绝不拿错误基准去算比例)。
    logoBaseSize() {
        const cv = this.dom && this.dom.canvas;
        const im = this.image;
        if (cv && cv._logW > 1 && cv._logH > 1 && im) {
            // 守卫要用「实际生效的 dpr」,而不是猜一个。原实现固定用 window.devicePixelRatio,
            // 在两种合法画布上都会误判:
            //
            //   ① 导出通道:app-export.js 设 uiDprOverride=1(按逻辑像素渲染,保证导出尺寸等于所选档位)
            //      引擎 engine.js 走 setupCanvas → width = _logW * 1,而这里按 dpr=2 算 expect=_logW*2 → 失配
            //   ② 相框通道:engine-styles.js 完全不乘 dpr(那三处都写 _logW = canvas.width),
            //      无论预览还是导出 width 都恒等于 _logW → 同样与 expect=_logW*2 失配
            //
            // 失配的代价不是"少个提示",而是 logoPos 跳过 rel 比例分支、退回锚点分支
            // (app-elements.js logoPos 第 74 行),把 logo 画到右下角默认偏移位 ——
            // 表现为「预览里 logo 在中间,导出的图里 logo 跑到了角上」。
            //
            // 正确做法:枚举引擎可能用到的 dpr(1 与 devicePixelRatio),任一匹配即认为 _logW 可信。
            // dpr=1 始终要试:相框通道与导出通道都落在这一档。
            //
            // 注:守卫原本想拦「渲染未完成时 _logW 还是上一张图」的残留,但那需要 _logW 与当前图
            // 尺寸比对才能判断,单看 width/logW 的比值做不到。实测该残留不会造成位置偏移
            // (rel 比例天然与画布大小无关),所以此处不做超出枚举的额外推断。
            const devDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            const candidates = devDpr === 1 ? [1] : [1, devDpr];
            for (const k of candidates) {
                const expect = cv._logW * k;
                if (Math.abs(cv.width - expect) <= Math.max(2, expect * 0.02)) {
                    return { w: cv._logW, h: cv._logH };
                }
            }
        }
        return null;
    },

    // 供叠加层/命中/瞄准环传给 logoPos 的 cw/ch。rel 分支现按当前 canvas 自行解析,
    // 此值只影响锚点/像素分支:取基准口径,与引擎锚点(cw 为逻辑画布)一致。
    logoBaseForOverlay() {
        const cv = this.dom && this.dom.canvas;
        const b = this.logoBaseSize();
        if (b) return b;
        return { w: (cv && cv.width) || 1, h: (cv && cv.height) || 1 };
    },

    // Logo 的绘制宽高比（高度 / 宽度）。优先用添加/导入时写入的 ratio；
    // 旧模板没有这个字段时查已加载位图，避免把长条 Logo 当成正方形来算上限。
    logoRatio(el) {
        let ratio = (el && el.ratio) || 0;
        if (!(ratio > 0) && el && el.dataUrl) {
            const im = window.getElementBitmap ? window.getElementBitmap(el.dataUrl) : null;
            if (im && im.naturalWidth) ratio = im.naturalHeight / im.naturalWidth;
        }
        return ratio > 0 ? ratio : 0;
    },

    // 计算 Logo 上限时使用的画布尺寸（物理像素，与 el.size 同一口径）。
    // 手势期间 displayMax 会临时降到 900，不能拿缩小后的 canvas 当上限，
    // 否则拖一次缩放滑块就会把大 Logo 永久压小。这里用基准画布 + 手势前的
    // displayMax 还原出正常预览尺寸，松手后与真实 canvas 一致。
    logoViewportSize() {
        const cv = this.dom && this.dom.canvas;
        if (!cv || !(cv.width > 1) || !(cv.height > 1)) return null;
        if (!this._gesture) return { w: cv.width, h: cv.height };
        const bw = this._canvasBaseW || 0, bh = this._canvasBaseH || 0;
        if (!(bw > 1) || !(bh > 1)) return { w: cv.width, h: cv.height };
        const prevMax = (this._gesturePrevMax != null) ? this._gesturePrevMax : 1800;
        const dpr = (typeof this.uiDprOverride === 'number' && this.uiDprOverride > 0)
            ? this.uiDprOverride
            : ((typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        const k = Math.min(1, prevMax / Math.max(bw, bh)) * dpr;
        return { w: bw * k, h: bh * k };
    },

    // Logo 放大上限：500px（size 是绘制宽度）。同时不超出画布，极小画布或
    // 竖长 Logo 仍以画布宽/高为最终边界。高度 = size * ratio。
    logoMaxSize(el) {
        const vp = this.logoViewportSize();
        const ratio = this.logoRatio(el) || 0.4;
        const canvasMax = vp ? Math.min(vp.w, vp.h / ratio) : LOGO_MAX_SIZE;
        return Math.max(8, Math.floor(Math.min(LOGO_MAX_SIZE, canvasMax)));
    },

    // 旧模板/导入模板里的 Logo 可能超过上限；渲染前统一收回。
    // 这里只按固定 500 收，不依赖当前 canvas，避免首帧画布尚未切到新照片时误缩。
    clampLogoElementSizes(t) {
        const tpl = t || this.template;
        if (!tpl || !Array.isArray(tpl.logoElements)) return;
        for (const el of tpl.logoElements) {
            if (el && Number(el.size) > LOGO_MAX_SIZE) el.size = LOGO_MAX_SIZE;
        }
    },

    // 当前选中元素在缩放滑块上的实际上限。目前只有 Logo 需要按画布封顶。
    selectedElementSizeMax() {
        const first = this.selectedEls && this.selectedEls[0];
        return (first && first.kind === 'logo') ? this.logoMaxSize(first.obj) : 10000;
    },

    // 相对比例格式迁移:旧版 rx/ry 以「基准画布 _logW/_logH」为分母,而导出(uiDprOverride=1)
    // 时画布变回 _logW,同一数值画完会被放大 canvas.width/_logW 倍,形成
    // 「预览居中、导出跑到角上/贴边」的偏差。新版统一以「显示画布 canvas.width/height」为分母,
    // 预览与导出天然一致。此处把旧格式(rel 为真值但非 'canvas')在渲染前一次性换算:
    //   换算系数 = 基准画布/显示画布,换算前后在同一画布上的绘制像素完全不变,只改数值口径。
    // 仅在比值≠1 时换算并标记;ratio-1 环境(DPR1/相框通道/导出)旧值本就等于显示画布分数,
    // 保持原值、不固化,留待 ratio≠1 环境一次性转换,避免以错误口径保存到模板文件。
    migrateRelCanvasFrac() {
        const t = this.template;
        if (!t || !t.logoElements || !t.logoElements.length) return;
        const cv = this.dom && this.dom.canvas;
        if (!cv || cv.width <= 1 || cv.height <= 1) return;
        const b = this.logoBaseSize();
        if (!b || b.w <= 1 || b.h <= 1) return;
        const fx = b.w / cv.width, fy = b.h / cv.height;
        if (!isFinite(fx) || !isFinite(fy) || fx <= 0 || fy <= 0) return;
        if (Math.abs(fx - 1) <= 1e-9 && Math.abs(fy - 1) <= 1e-9) return;
        for (const el of t.logoElements) {
            if (el && el.rel && el.rel !== 'canvas' && typeof el.rx === 'number' && typeof el.ry === 'number') {
                el.rx *= fx;
                el.ry *= fy;
                el.rel = 'canvas';
            }
        }
    },

    // 把像素中心写回元素:优先用相对比例存储(可跨照片尺寸),锚点模式则保留锚点只反算 offset。
    setLogoPixelPos(el, cx, cy) {
        if (!el) return;
        const base = this.logoBaseSize();
        const cv = this.dom && this.dom.canvas;
        if (typeof el.x === 'string' || typeof el.y === 'string') {
            // 锚点模式:保持锚点不变 → 它本来就能随画布自适应,无需转成比例
            if (!base) return;
            const dim = this._logoDrawSize(el);
            const hAlign = el.x || 'right', vAlign = el.y || 'bottom';
            const halfW = dim.w / 2, halfH = dim.h / 2;
            if (hAlign === 'left') el.offsetX = Math.max(0, Math.round(cx - halfW));
            else if (hAlign === 'center') el.offsetX = 0;
            else el.offsetX = Math.max(0, Math.round(base.w - cx - halfW));
            if (vAlign === 'top') el.offsetY = Math.max(0, Math.round(cy - halfH));
            else if (vAlign === 'center') el.offsetY = 0;
            else el.offsetY = Math.max(0, Math.round(base.h - cy - halfH));
            return;
        }
        // 像素值照旧写入(旧版程序打开同一模板时仍能定位),限制在画布内;
        // 相对比例以「显示画布 canvas.width/height」为分母(rx∈[0,1]):
        // 预览(canvas 可能为 _logW×dpr)与导出(canvas=_logW)按同一分数还原,
        // 不再出现「预览居中、导出跑角/贴边」的偏差。
        const clampedX = cv && cv.width > 0 ? Math.min(cv.width, Math.max(0, cx)) : cx;
        const clampedY = cv && cv.height > 0 ? Math.min(cv.height, Math.max(0, cy)) : cy;
        el.x = Math.round(clampedX);
        el.y = Math.round(clampedY);
        if (!cv || cv.width <= 0 || cv.height <= 0) return;
        el.rel = 'canvas';
        el.rx = Math.max(0, Math.min(1, cx / cv.width));
        el.ry = Math.max(0, Math.min(1, cy / cv.height));
    },

    nudgeElement(el, mode, dir) {
        const e = el.obj;
        if (el.kind === 'aiLayer') {
            if (mode !== 'rot' && window.AiLayers && window.AiLayers.scaleLayer) {
                const cv = this.dom.canvas;
                window.AiLayers.scaleLayer(e, dir > 0 ? 1.1 : 0.9, cv.width, cv.height);
                if (this._syncAiLayerEdit) this._syncAiLayerEdit();
            }
            this.saveCurrentTemplate();
            this.scheduleRender();
            return;
        }
        if (el.kind === 'logo') {
            if (typeof e.x !== 'number') { const p = this.logoPos(e, this.dom.canvas.width, this.dom.canvas.height, e.size || 60); this.setLogoPixelPos(e, p.cx, p.cy); }
            // 取 1 位小数再存：3.2 + 5 这类累加会变成 8.199999999999989，
            // 显示层虽然会圆，但值会写进模板/导出，不该带这种尾巴。
            if (mode === 'rot') e.rotation = Math.round((((e.rotation || 0) + dir * 5) % 360 + 360) % 360 * 10) / 10;
            else {
                // 旧模板可能存着超过上限的 size；从“实际显示尺寸”开始加减，
                // 否则第一次按缩小键会 clamp 回上限，看起来像按了没反应。
                const max = this.logoMaxSize(e);
                e.size = clampNum(Math.min(e.size || 60, max) + dir * 25, 8, max);
            }
        } else if (el.kind === 'sticker') {
            // 取 1 位小数再存：3.2 + 5 这类累加会变成 8.199999999999989，
            // 显示层虽然会圆，但值会写进模板/导出，不该带这种尾巴。
            if (mode === 'rot') e.rotation = Math.round((((e.rotation || 0) + dir * 5) % 360 + 360) % 360 * 10) / 10;
            else e.scale = clampNum((e.scale || 1) * (dir > 0 ? 1.1 : 0.9), 0.02, 3);
        } else if (el.kind === 'text') {
            // 取 1 位小数再存：3.2 + 5 这类累加会变成 8.199999999999989，
            // 显示层虽然会圆，但值会写进模板/导出，不该带这种尾巴。
            if (mode === 'rot') e.rotation = Math.round((((e.rotation || 0) + dir * 5) % 360 + 360) % 360 * 10) / 10;
            else { e.fontSize = clampNum((e.fontSize || 18) + dir * 2, 6, 300); if (e.autoSize) e.autoSize = 0; }
        }
        this.syncSliderFromEl(el);
        this.saveCurrentTemplate();
        this.scheduleRender();
    },

    // ── Compositor 借鉴 #1:方向键微移元素 + 精确数值输入 ──
    // 方向键微移:1px/次,Shift=10px;logo 走 setLogoPixelPos(同步 rx/ry,换照片尺寸不错位)
    nudgeSelectedPosition(dx, dy) {
        if (!this.selectedEls || !this.selectedEls.length) return;
        const cw = this.dom.canvas.width || 0, ch = this.dom.canvas.height || 0;
        let ai = false;
        this.selectedEls.forEach(sel => {
            const e = sel.obj;
            if (sel.kind === 'aiLayer') {
                if (window.AiLayers && window.AiLayers.moveLayer) window.AiLayers.moveLayer(e, dx, dy, cw, ch);
                ai = true;
            } else if (sel.kind === 'logo') {
                if (typeof e.x !== 'number' || typeof e.y !== 'number') {
                    const p = this.logoPos(e, cw, ch, e.size || 60);
                    this.setLogoPixelPos(e, p.cx, p.cy);
                }
                this.setLogoPixelPos(e, (e.x || 0) + dx, (e.y || 0) + dy);
            } else if (sel.kind === 'sticker') {
                e.x = Math.max(20, Math.min(cw - 20, (e.x || 0) + dx));
                e.y = Math.max(20, Math.min(ch - 20, (e.y || 0) + dy));
            } else if (sel.kind === 'text') {
                this.promoteTextToFree(e);
                const lw = (this.dom.canvas._logW > 1) ? this.dom.canvas._logW : cw;
                const lh = (this.dom.canvas._logH > 1) ? this.dom.canvas._logH : ch;
                e.x = Math.max(0, Math.min(lw, (e.x || 0) + dx));
                e.y = Math.max(0, Math.min(lh, (e.y || 0) + dy));
            }
        });
        this.syncElInputs();
        this.saveCurrentTemplate();
        this.scheduleRender();
        if (ai && this._syncAiLayerEdit) this._syncAiLayerEdit();
    },

    _elCenterX(sel) {
        const e = sel.obj;
        if (sel.kind === 'aiLayer') {
            const cv = this.dom.canvas;
            const c = window.AiLayers && window.AiLayers.layerCenter
                ? window.AiLayers.layerCenter(e, cv.width, cv.height) : null;
            return Math.round(c ? c.x : (e.x || 0));
        }
        if (sel.kind === 'logo') {
            if (typeof e.x === 'number') return Math.round(e.x);
            const p = this.logoPos(e, this.dom.canvas.width || 0, this.dom.canvas.height || 0, e.size || 60);
            return Math.round(p.cx);
        }
        // 锚定文字没有 x/y（x=0 只是占位），面板要显示它「现在实际在哪」，
        // 否则选了文字却看到 0,0，会以为坏了。
        if (sel.kind === 'text' && e.align !== 'free') {
            const m = this.textMetricsOf(e);
            if (m) return Math.round(m.cx);
        }
        return Math.round(e.x || 0);
    },
    _elCenterY(sel) {
        const e = sel.obj;
        if (sel.kind === 'aiLayer') {
            const cv = this.dom.canvas;
            const c = window.AiLayers && window.AiLayers.layerCenter
                ? window.AiLayers.layerCenter(e, cv.width, cv.height) : null;
            return Math.round(c ? c.y : (e.y || 0));
        }
        if (sel.kind === 'logo') {
            if (typeof e.y === 'number') return Math.round(e.y);
            const p = this.logoPos(e, this.dom.canvas.width || 0, this.dom.canvas.height || 0, e.size || 60);
            return Math.round(p.cy);
        }
        if (sel.kind === 'text' && e.align !== 'free') {
            const m = this.textMetricsOf(e);
            if (m) return Math.round(m.cy);
        }
        return Math.round(e.y || 0);
    },
    // 回显位置输入框:多选时禁用(绝对坐标只对单元素有意义)
    syncElInputs() {
        const $ = this.$;
        const inpX = $('inpElX'), inpY = $('inpElY');
        if (!inpX && !inpY) return;
        const sel = this.selectedEls && this.selectedEls[0];
        const multi = (this.selectedEls || []).length > 1;
        if (!sel || multi) {
            if (inpX) { if (!inpX.disabled) inpX.disabled = true; if (inpX.value !== '') inpX.value = ''; }
            if (inpY) { if (!inpY.disabled) inpY.disabled = true; if (inpY.value !== '') inpY.value = ''; }
            return;
        }
        if (inpX) { if (inpX.disabled) inpX.disabled = false; const v = String(this._elCenterX(sel)); if (inpX.value !== v) inpX.value = v; }
        if (inpY) { if (inpY.disabled) inpY.disabled = false; const v2 = String(this._elCenterY(sel)); if (inpY.value !== v2) inpY.value = v2; }
    },
    // 精确写入元素中心像素坐标(logo 走 setLogoPixelPos 保持 rx/ry)
    setElementCenter(sel, x, y) {
        const e = sel.obj;
        const cw = this.dom.canvas.width || 0, ch = this.dom.canvas.height || 0;
        if (sel.kind === 'aiLayer') {
            if (window.AiLayers && window.AiLayers.setLayerCenter) window.AiLayers.setLayerCenter(e, x, y, cw, ch);
            if (this._syncAiLayerEdit) this._syncAiLayerEdit();
            return;
        }
        if (sel.kind === 'logo') this.setLogoPixelPos(e, x, y);
        else if (sel.kind === 'sticker') { e.x = Math.max(20, Math.min(cw - 20, x)); e.y = Math.max(20, Math.min(ch - 20, y)); }
        else if (sel.kind === 'text') {
            // 锚定文字没有 x/y 可言：先在当前位置解锁成自由文字（画面不跳），再写坐标
            this.promoteTextToFree(e);
            const lw = (this.dom.canvas._logW > 1) ? this.dom.canvas._logW : cw;
            const lh = (this.dom.canvas._logH > 1) ? this.dom.canvas._logH : ch;
            e.x = Math.max(0, Math.min(lw, x));
            e.y = Math.max(0, Math.min(lh, y));
        }
    },

    rebindSelectedEls() { /* template引用稳定,无需重绑 */ },

    moveElement(drag, x, y) {
        const e = drag.ref;
        const cv = this.dom.canvas;
        const cw = cv.width || 0, ch = cv.height || 0;
        if (drag.kind === 'aiLayer') {
            // 拖动坐标是画布像素；AI 图层内部存 0..1 比例，由 AiLayers 统一写回。
            // snapToGuides 只认 logo/decor 的像素字段，这里走 AI 专用的吸附。
            if (window.AiLayers && typeof window.AiLayers.setLayerCenter === 'function') {
                const snap = this.aiSnapGuides(x, y, e, cw, ch);
                // setLayerCenter 自己会把像素换算成 0..1 比例，这里传的就是画布像素。
                window.AiLayers.setLayerCenter(e, snap.x, snap.y, cw, ch);
            }
            this.onSettingChanged();
            return;
        }
        if (drag.kind === 'text') {
            // 文字坐标是逻辑口径，而拖拽位移是画布像素（含 DPR）——先换算再吸附/写回，
            // 否则 DPR>1 的屏幕上文字会以 1.x 倍速跟手。
            const k = this.textSpaceScale();
            const lw = (cv._logW > 1) ? cv._logW : cw;
            const lh = (cv._logH > 1) ? cv._logH : ch;
            const snap = this.snapToGuides(drag.x + (x - drag.x) / k, drag.y + (y - drag.y) / k, lw, lh, e, 'text');
            e.x = Math.max(0, Math.min(lw, snap.x));
            e.y = Math.max(0, Math.min(lh, snap.y));
            this._logoSnapV = snap.v; this._logoSnapH = snap.h;
            this._logoSnapEdgeV = snap.vEdge; this._logoSnapEdgeH = snap.hEdge;
            this._logoSnapPhotoV = snap.photoV; this._logoSnapPhotoH = snap.photoH;
            this.onSettingChanged();
            return;
        }
        const snap = this.snapToGuides(x, y, cw, ch, e, drag.kind);
        if (drag.kind === 'logo') {
            // 用相对比例写回,换照片尺寸时不会跑到画布外
            this.setLogoPixelPos(e, snap.x, snap.y);
        } else if (drag.kind === 'sticker') {
            e.x = Math.max(20, Math.min(cw - 20, snap.x)); e.y = Math.max(20, Math.min(ch - 20, snap.y));
        } else if (drag.kind === 'text') {
            e.x = Math.max(30, Math.min(cw - 30, snap.x)); e.y = Math.max(20, Math.min(ch - 20, snap.y));
        }
        this._logoSnapV = snap.v; this._logoSnapH = snap.h;
        this._logoSnapEdgeV = snap.vEdge; this._logoSnapEdgeH = snap.hEdge;
        this._logoSnapPhotoV = snap.photoV; this._logoSnapPhotoH = snap.photoH;
        this.onSettingChanged();
    },

    // 参考线 + 四边吸附:吸附元素中心并记录命中的位置(供高亮)
    //  - 参考线:1/3、1/2、2/3 六条,吸附中心
    //  - 边缘  :贴左/右/上/下,吸附到「元素完整可见 + 最小边距」的位置
    //    水印最常见用法就是贴四角(右下角品牌、左下角日期),原实现只有三分线,贴角全靠手感,
    //    而且容易贴得太靠外——大 logo 会有一半落在画布外。
    // 位移量按元素实际绘制尺寸推导(而非固定比例),因此大 logo 会自动留出更大的贴边距离。
    //  - 照片区域:有边距(留白/卡片)时,照片是画布内的一块居中区域,额外吸附照片四边/中心,
    //    让元素能贴"照片边缘"而不是画布边缘。照片矩形按 baseMargin 边距估算。
    // 该方法对 logo / 贴纸 / 自由文字统一生效(Compositor 借鉴:元素吸附+参考线)。
    photoRectEstimate() {
        const cv = this.dom && this.dom.canvas;
        if (!cv || cv.width <= 1 || cv.height <= 1) return null;
        const m = (this.template && this.template.baseMargin) || {};
        const gm = m.globalMargin || 1;
        const padT = (m.refTop || 0) * gm, padB = (m.refBottom || 0) * gm;
        const padL = (m.refLeft || 0) * gm, padR = (m.refRight || 0) * gm;
        if (padT + padB + padL + padR <= 1 && Math.abs(gm - 1) <= 0.01) return null;
        const areaW = Math.max(10, cv.width - padL - padR);
        const areaH = Math.max(10, cv.height - padT - padB);
        const sc = m.imgScale || 1;
        const dw = areaW * sc, dh = areaH * sc;
        const px = m.imgOffsetX || 0, py = m.imgOffsetY || 0;
        return { x: cv.width / 2 - dw / 2 + px, y: cv.height / 2 - dh / 2 + py, w: dw, h: dh };
    },

    _logoDrawSize(el, kind) {
        if (kind === 'text' && el && typeof window.textLineMetrics === 'function') {
            const cv = this.dom && this.dom.canvas;
            const cw = (cv && cv._logW > 1) ? cv._logW : (cv ? cv.width : 0);
            const ch = (cv && cv._logH > 1) ? cv._logH : (cv ? cv.height : 0);
            if (cw > 1 && ch > 1) {
                const m = window.textLineMetrics(el, cw, ch, false, 0, 0);
                return { w: m.lw, h: m.lh };
            }
        }
        let size = Math.max(2, (el && el.size) || 60);
        if (kind === 'sticker') size = Math.max(6, Math.round(((el && el.scale) || 1) * 60));
        if (kind === 'logo') size = Math.min(size, this.logoMaxSize(el));
        let ratio = (el && el.ratio) || 0;
        if (!ratio && el && el.dataUrl) {
            const im = window.getElementBitmap ? window.getElementBitmap(el.dataUrl) : null;
            if (im && im.naturalWidth) ratio = im.naturalHeight / im.naturalWidth;
        }
        if (!ratio) ratio = 0.4;   // 图片尚未就绪时的兜底纵横比
        return { w: size, h: size * ratio };
    },

    snapToGuides(x, y, cw, ch, el, kind) {
        const vLines = [cw / 3, cw / 2, cw * 2 / 3];
        const hLines = [ch / 3, ch / 2, ch * 2 / 3];
        const tol = 8;
        let sv = -1, sh = -1, dv = tol, dh = tol;
        for (let i = 0; i < vLines.length; i++) {
            const d = Math.abs(x - vLines[i]);
            if (d < dv) { dv = d; sv = i; }
        }
        for (let i = 0; i < hLines.length; i++) {
            const d = Math.abs(y - hLines[i]);
            if (d < dh) { dh = d; sh = i; }
        }
        let nx = sv >= 0 ? vLines[sv] : x;
        let ny = sh >= 0 ? hLines[sh] : y;

        const dim = this._logoDrawSize(el, kind);
        const dx = dim.w / 2, dy = dim.h / 2;
        const kx = Math.max(10, Math.min(cw * 0.05, dx));
        const ky = Math.max(10, Math.min(ch * 0.05, dy));
        const glx = Math.min(dx + kx, cw / 2);
        const gly = Math.min(dy + ky, ch / 2);

        // 分别记录「该方向是否真的发生了边缘约束」,不用"哪个更近"判断——
        // 例如元素在右上角时,左右两个候选的 x 距离可能相同。
        let vEdge = null, hEdge = null;
        let bestX = tol, bestY = tol;
        for (const [d, tag] of [[x - glx, 'left'], [cw - glx - x, 'right'], [Math.abs(x - cw / 2), 'hcenter']]) {
            if (d < bestX) { bestX = d; vEdge = tag; }
        }
        for (const [d, tag] of [[y - gly, 'top'], [ch - gly - y, 'bottom'], [Math.abs(y - ch / 2), 'vcenter']]) {
            if (d < bestY) { bestY = d; hEdge = tag; }
        }
        if (vEdge === 'left') nx = glx; else if (vEdge === 'right') nx = cw - glx;
        else if (vEdge === 'hcenter') nx = cw / 2;
        if (hEdge === 'top') ny = gly; else if (hEdge === 'bottom') ny = ch - gly;
        else if (hEdge === 'vcenter') ny = ch / 2;

        // 照片区域四边 + 中心吸附:仅在有边距(照片<画布)时生效
        let photoV = null, photoH = null;
        const pr = this.photoRectEstimate();
        if (pr) {
            const pTol = 10;
            let pbX = pTol, pTag = null;
            for (const [d, tag] of [[pr.x + dx, 'pleft'], [pr.x + pr.w - dx, 'pright'], [pr.x + pr.w / 2, 'phcenter']]) {
                const dd = Math.abs(x - d);
                if (dd < pbX) { pbX = dd; pTag = tag; }
            }
            if (pTag === 'pleft') { nx = pr.x + dx; photoV = 'pleft'; }
            else if (pTag === 'pright') { nx = pr.x + pr.w - dx; photoV = 'pright'; }
            else if (pTag === 'phcenter') { nx = pr.x + pr.w / 2; photoV = 'phcenter'; }
            let pbY = pTol, pTag2 = null;
            for (const [d, tag] of [[pr.y + dy, 'ptop'], [pr.y + pr.h - dy, 'pbottom'], [pr.y + pr.h / 2, 'pvcenter']]) {
                const dd = Math.abs(y - d);
                if (dd < pbY) { pbY = dd; pTag2 = tag; }
            }
            if (pTag2 === 'ptop') { ny = pr.y + dy; photoH = 'ptop'; }
            else if (pTag2 === 'pbottom') { ny = pr.y + pr.h - dy; photoH = 'pbottom'; }
            else if (pTag2 === 'pvcenter') { ny = pr.y + pr.h / 2; photoH = 'pvcenter'; }
        }

        return {
            x: nx, y: ny,
            v: sv >= 0 ? sv : null,
            h: sh >= 0 ? sh : null,
            vEdge, hEdge, photoV, photoH,
        };
    },

    // 旋转/拖角缩放时，元素中心是固定的。提前按中心算一次命中的参考线，
    // drawLogoGuides 就能在旋转过程中把中心所在的线高亮出来。
    // 只借 snapToGuides 的命中标签，不写回 x/y —— 旋转不应该偷偷移动元素。
    _primeTransformGuides(el, kind, cx, cy) {
        const cv = this.dom && this.dom.canvas;
        if (!cv || !el) return;
        const lw = (cv._logW > 1) ? cv._logW : cv.width;
        const lh = (cv._logH > 1) ? cv._logH : cv.height;
        if (!(lw > 1) || !(lh > 1)) return;
        const snap = this.snapToGuides(cx, cy, lw, lh, el, kind || 'text');
        this._logoSnapV = snap.v;
        this._logoSnapH = snap.h;
        this._logoSnapEdgeV = snap.vEdge;
        this._logoSnapEdgeH = snap.hEdge;
        this._logoSnapPhotoV = snap.photoV;
        this._logoSnapPhotoH = snap.photoH;
    },

    textureEl(src) {
        if (!src) return null;
        if (this.logoImgCache[src]) return this.logoImgCache[src];
        if (this.textures) {
            const t = this.textures.find(x => x.name === src);
            if (t) { const im = window.qfsImage(); im.src = t.dataUrl; this.logoImgCache[src] = im; return im; }
        }
        const im = window.qfsImage(); im.src = src; this.logoImgCache[src] = im; return im;
    },

    syncSliderFromEl(el) {
        if (!el || !el.kind) return;
        const e = el.obj;
        const $ = this.$;
        const rot = $('slElementRotation'), op = $('slActiveIconOpacity'), sz = $('slElementSize');
        // 先归一化到 [0,360) 再取 1 位小数：直接取模会把 3.2 变成 3.200000000000017，
        // 那个长串会从 46px 的 .pval 里溢出来（用户截图里就是它）。
        const rotDeg = Math.round((((Number(e.rotation) || 0) % 360) + 360) % 360 * 10) / 10;
        if (rot) rot.value = rotDeg;
        if (op) op.value = Math.round(e.opacity != null ? e.opacity : 100);
        // Logo 的缩放上限随画布尺寸/纵横比变化；滑块仍用 0~1000 的平方映射，
        // 但映射终点换成当前 Logo 的实际上限，低值端依旧精细。
        const maxSize = el.kind === 'logo' ? this.logoMaxSize(e) : 10000;
        const rawSize = el.kind === 'logo' ? Math.round(e.size || 60)
            : el.kind === 'sticker' ? Math.round((e.scale || 1) * 60) : 60;
        const sizeVal = el.kind === 'logo' ? Math.min(rawSize, maxSize) : rawSize;
        const sizeSpan = Math.max(1, maxSize - 16);
        if (sz) sz.value = Math.round(1000 * Math.sqrt(clampNum((sizeVal - 16) / sizeSpan, 0, 1)));
        this.updateLabel('lblElementRotation', rotDeg + '°');
        this.updateLabel('lblActiveIconOpacity', Math.round(e.opacity != null ? e.opacity : 100) + '%');
        this.updateLabel('lblElementSize', sizeVal);
        const inpR = $('inpElRotation'), inpO = $('inpElOpacity'), inpS = $('inpElSize');
        if (inpR) inpR.value = rotDeg;
        if (inpO) inpO.value = Math.round(e.opacity != null ? e.opacity : 100);
        if (inpS) {
            inpS.value = sizeVal;
            inpS.max = String(Math.round(maxSize));
        }
        this.syncTextRows(el);
        this.syncElInputs();
    },

    // 把 #RRGGBB / rrggbb / 颜色名 归一成 <input type=color> 能吃的 #rrggbb
    _hex6(c) {
        const v = String(c == null ? '' : c).trim();
        if (/^#?[0-9a-f]{6}$/i.test(v)) return '#' + v.replace('#', '').toLowerCase();
        if (/^#?[0-9a-f]{3}$/i.test(v)) {
            const h = v.replace('#', '');
            return ('#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toLowerCase();
        }
        return '#ffffff';
    },

    // 文字专属的行只在选中文字时露出，其余时候整行收起。
    // 同时把「缩放」行换成「字号」——文字用 8~400 的线性字号滑条，
    // 比复用 logo 那条 16~500 的平方映射好用得多（后者对 40px 的字几乎不可调）。
    syncTextRows(sel) {
        const $ = this.$;
        const isText = !!(sel && sel.kind === 'text' && sel.obj);
        const textRows = ['rowElTextContent', 'rowElTextFont', 'rowElTextSize', 'rowElTextColor',
                          'rowElTextDir', 'rowElTextSpacing',
                          'rowElTextWeight', 'rowElTextStroke', 'rowElTextStrokeWidth',
                          'rowElTextShadow', 'rowElTextShadowBlur', 'rowElTextShadowOffset'];
        textRows.forEach(id => {
            const r = $(id);
            if (r) r.style.display = isText ? '' : 'none';
        });
        const rowScale = $('rowElSize');
        if (rowScale) rowScale.style.display = isText ? 'none' : '';
        // 「文字」页签顶部的状态：没选中文字时告诉用户去哪选，选中后显示当前这段字。
        // 样式行本身只在选中文字时出现，避免整页常驻一堆灰行。
        const status = $('txtStyleStatus');
        if (status) {
            status.textContent = isText
                ? '正在调整：文字「' + String(sel.obj.text || '空文字').replace(/\s+/g, ' ').substring(0, 10) + '」'
                : '未选中文字：先在画布上点一段文字';
        }
        // Logo → 元素管理里只留位置/旋转/层级；给选中文字的人一条明确指路，
        // 不然把字体/描边搬走后，用户会以为功能没了。
        const hint = $('elTextStyleHint');
        if (hint) hint.style.display = isText ? '' : 'none';
        if (!isText) return;

        const e = sel.obj;
        // 内容：正在输入时不覆盖，否则每帧渲染都会把光标位置顶掉
        const tf = $('tfElText');
        if (tf && document.activeElement !== tf) tf.value = e.text || '';

        // 字体：预设里可能写成 '"Microsoft YaHei", sans-serif'，取第一个族名去匹配
        const cbF = $('cbElTextFont');
        if (cbF) {
            const fam = String(e.fontFamily || 'Microsoft YaHei').split(',')[0].replace(/["']/g, '').trim();
            if ([].some.call(cbF.options, o => o.value === fam)) cbF.value = fam;
            else if (cbF.options.length) cbF.value = cbF.options[0].value;
        }

        const fs = Math.round(Number(e.fontSize) || 18);
        const slS = $('slElTextSize'), inS = $('inpElTextSize');
        if (slS) slS.value = Math.max(8, Math.min(400, fs));
        if (inS) inS.value = fs;
        this.updateLabel('lblElTextSize', fs + 'px');

        const cp = $('cpElTextColor');
        if (cp) cp.value = this._hex6(e.colorHex);

        const cb = $('cbElTextDir');
        if (cb) cb.value = (typeof window.textLineDir === 'function') ? window.textLineDir(e) : 'h';
        const sl = $('slElTextSpacing');
        const ls = Math.round(Number(e.letterSpacing) || 0);
        if (sl) sl.value = Math.max(0, Math.min(40, ls));
        this.updateLabel('lblElTextSpacing', ls + 'px');

        // ── 字重 ──
        const cbW = $('cbElTextWeight');
        if (cbW) {
            const w = String(Math.round(Number(e.fontWeight) || 400));
            if ([].some.call(cbW.options, o => o.value === w)) cbW.value = w;
            else cbW.value = '400';
        }

        // ── 描边 / 阴影 ──
        // 老预设只有 enableShadow 开关、没有模糊/偏移字段（引擎也不会画），
        // 所以“阴影”勾选状态要与引擎同源：字段齐全才算真的开着，否则显示未勾选。
        const strokeOn = Number(e.strokeEnable) === 1;
        const chkStroke = $('chkElTextStroke');
        if (chkStroke) chkStroke.checked = strokeOn;
        const cpStroke = $('cpElTextStroke');
        if (cpStroke) cpStroke.value = this._hex6(e.strokeColorHex || '#000000');
        const slSW = $('slElTextStrokeWidth');
        const sw = Math.max(1, Math.round(Number(e.strokeWidth) || Math.max(1, fs * 0.06)));
        if (slSW) slSW.value = Math.min(40, sw);
        this.updateLabel('lblElTextStrokeWidth', Math.min(40, sw) + 'px');
        const rowSW = $('rowElTextStrokeWidth');
        if (rowSW) rowSW.classList.toggle('row-disabled', !strokeOn);

        const shadowOn = Number(e.enableShadow) === 1
            && (e.shadowBlur != null || e.shadowOffsetX != null || e.shadowOffsetY != null);
        const chkShadow = $('chkElTextShadow');
        if (chkShadow) chkShadow.checked = shadowOn;
        const cpShadow = $('cpElTextShadow');
        if (cpShadow) cpShadow.value = this._hex6(e.shadowColorHex || '#000000');
        const slSB = $('slElTextShadowBlur');
        const sb = Math.max(0, Math.round(Number(e.shadowBlur) || 8));
        if (slSB) slSB.value = Math.min(60, sb);
        this.updateLabel('lblElTextShadowBlur', Math.min(60, sb) + 'px');
        const inSX = $('inpElTextShadowX'), inSY = $('inpElTextShadowY');
        if (inSX) inSX.value = Number(e.shadowOffsetX) || 0;
        if (inSY) inSY.value = (e.shadowOffsetY != null ? Number(e.shadowOffsetY) : 2) || 0;
        ['rowElTextShadowBlur', 'rowElTextShadowOffset'].forEach(id => {
            const r = $(id);
            if (r) r.classList.toggle('row-disabled', !shadowOn);
        });
    },

    drawSelectionBox() {
        this._rotHandle = null;   // 只有「单选一个元素」时才会重新写它
        this._resizeHandles = null;
        try {
            const canvas = this.dom.canvas;
            if (!canvas || !this.selectedEls || !this.selectedEls.length) return;
            const ctx = canvas.getContext('2d');
            for (const sel of this.selectedEls) {
                const e = sel.obj;
                if (!e) continue;
                // 正在画布内编辑的文字已经有 textarea 边框和把手外的编辑框，
                // 再画一遍选中框会出现两层虚线，视觉上很脏。
                if (this._textEditor && this._textEditor.el === e) continue;
                if (sel.kind === 'aiLayer') {
                    if (!window.AiLayers || typeof window.AiLayers.layerBounds !== 'function') continue;
                    const b = window.AiLayers.layerBounds(this.aiMeasureCtx(), e, canvas.width, canvas.height);
                    if (!b) continue;
                    ctx.save();
                    ctx.strokeStyle = '#00e5a0';
                    ctx.lineWidth = 2;
                    ctx.setLineDash([6, 4]);
                    ctx.strokeRect(b.x - 5, b.y - 5, b.w + 10, b.h + 10);
                    ctx.setLineDash([]);
                    ctx.fillStyle = '#00e5a0';
                    const h = Math.max(6, 7 * this.textSpaceScale());
                    const corners = [
                        ['nw', b.x - 5, b.y - 5],
                        ['ne', b.x + b.w + 5 - h, b.y - 5],
                        ['sw', b.x - 5, b.y + b.h + 5 - h],
                        ['se', b.x + b.w + 5 - h, b.y + b.h + 5 - h],
                    ];
                    corners.forEach(([, x, y]) => ctx.fillRect(x, y, h, h));
                    if (this.selectedEls.length === 1) {
                        this._resizeHandles = corners.map(([name, x, y]) => ({
                            name, x: x + h / 2, y: y + h / 2,
                            cursor: (name === 'nw' || name === 'se') ? 'nwse-resize' : 'nesw-resize'
                        }));
                    }
                    ctx.restore();
                    continue;
                }
                // 文字用真实度量框（含方向/旋转/多行）：原来按 logo 的 size 画 60px 方块，
                // 对文字既不是它的位置也不是它的大小。
                if (sel.kind === 'text' && typeof window.textLineMetrics === 'function') {
                    const cw = (canvas._logW > 1) ? canvas._logW : canvas.width;
                    const chh = (canvas._logH > 1) ? canvas._logH : canvas.height;
                    const k = this.textSpaceScale();
                    const m = window.textLineMetrics(e, cw, chh, false, 0, 0);
                    const bw = Math.max(14, m.lw * k), bh = Math.max(14, m.lh * k);
                    const rotTh = m.rot * Math.PI / 180;
                    ctx.save();
                    ctx.translate(m.cx * k, m.cy * k);
                    if (m.rot) ctx.rotate(rotTh);
                    ctx.strokeStyle = '#00e5a0';
                    ctx.lineWidth = 2;
                    ctx.setLineDash([6, 4]);
                    ctx.strokeRect(-bw / 2 - 3, -bh / 2 - 3, bw + 6, bh + 6);
                    ctx.setLineDash([]);
                    // 四个角的小方块：现在不只是提示「可拖」，拖它们会等比缩放字号。
                    ctx.fillStyle = '#00e5a0';
                    const h = Math.max(6, 7 * k);
                    const corners = [
                        ['nw', -bw / 2 - 3, -bh / 2 - 3],
                        ['ne', bw / 2 + 3 - h, -bh / 2 - 3],
                        ['sw', -bw / 2 - 3, bh / 2 + 3 - h],
                        ['se', bw / 2 + 3 - h, bh / 2 + 3 - h],
                    ];
                    corners.forEach(([, x, y]) => ctx.fillRect(x, y, h, h));
                    if (this.selectedEls.length === 1) {
                        const hand = h / 2;
                        this._resizeHandles = corners.map(([name, x, y]) => {
                            const lx = x + hand, ly = y + hand;
                            const ax = m.cx * k + lx * Math.cos(rotTh) - ly * Math.sin(rotTh);
                            const ay = m.cy * k + lx * Math.sin(rotTh) + ly * Math.cos(rotTh);
                            return { name, x: ax, y: ay,
                                cursor: (name === 'nw' || name === 'se') ? 'nwse-resize' : 'nesw-resize' };
                        });
                    }
                    // 旋转把手：框顶外侧一个圆点。位置在这里算一次并存下来，
                    // 命中检测(mousedown)直接用 —— 两处各算一遍角度迟早对不上。
                    if (this.selectedEls.length === 1) {
                        // 注意：这段已经在 translate/rotate 之后的**局部**坐标系里，
                        // 所以线要画在 (0,-bh/2)→(0,-dist)，不能再按绝对坐标画一次
                        // 把手尺寸按 DPI 缩放：画布是物理像素，写死 6 在高分屏上只有 3 CSS px，
                        // 小到点不中，也看不见。
                        const kr = 7 * k;
                        const dist = bh / 2 + 14 * k;
                        const th = m.rot * Math.PI / 180;
                        ctx.strokeStyle = 'rgba(0,229,160,0.9)';
                        ctx.lineWidth = 1.5 * k;
                        ctx.beginPath(); ctx.moveTo(0, -bh / 2); ctx.lineTo(0, -dist); ctx.stroke();
                        ctx.beginPath(); ctx.arc(0, -dist, kr, 0, Math.PI * 2);
                        ctx.fillStyle = '#00e5a0'; ctx.fill();
                        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 * k; ctx.stroke();
                        this._rotHandle = {
                            x: m.cx * k + dist * Math.sin(th),
                            y: m.cy * k - dist * Math.cos(th),
                            r: kr,
                        };
                    }
                    ctx.restore();
                    continue;
                }
                // Logo 用实际绘制尺寸画框（含放大上限），否则旧模板/导入模板
                // 会出现“框很大、图被引擎封顶”的错位。
                let cx = e.x, cy = e.y;
                let size = sel.kind === 'logo' ? this._logoDrawSize(e, 'logo').w : (e.size || 60);
                if (typeof cx !== 'number' || typeof cy !== 'number') {
                    const p = this.logoPos(e, canvas.width, canvas.height, size);
                    cx = p.cx; cy = p.cy;
                }
                ctx.save();
                ctx.strokeStyle = '#00e5a0';
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 4]);
                ctx.strokeRect(cx - size / 2 - 6, cy - size / 2 - 6, size + 12, size + 12);
                ctx.setLineDash([]);
                ctx.fillStyle = '#00e5a0';
                const h = 5;
                [[cx-size/2-6, cy-size/2-6],[cx+size/2+6-h, cy-size/2-6],
                 [cx-size/2-6, cy+size/2+6-h],[cx+size/2+6-h, cy+size/2+6-h]].forEach(([x,y])=>{
                    ctx.fillRect(x, y, h, h);
                });
                ctx.restore();
            }
        } catch(err) { console.warn('drawSelectionBox', err); }
    },

    // 拖动/旋转/拖角缩放时叠加参考线:三分/中心线、四边吸附高亮、安全区提示。
    // 旋转时位置不动，但中心所在的线仍然高亮，并额外画一组随文字转动的轴线。
    drawLogoGuides() {
        try {
            const xf = (typeof this._activeTransform === 'function')
                ? this._activeTransform()
                : (this._dragEl || this._rotEl || this._resizeEl);
            if (!xf || !xf.ref) return;
            const canvas = this.dom.canvas;
            if (!canvas || !canvas.width) return;
            const ctx = canvas.getContext('2d');
            const cw = canvas.width, ch = canvas.height;
            if (xf.kind === 'aiLayer' || xf.isAi) { this.drawAiGuides(ctx, xf.ref, cw, ch); return; }
            const vLines = [cw / 3, cw / 2, cw * 2 / 3];
            const hLines = [ch / 3, ch / 2, ch * 2 / 3];
            ctx.save();
            const drawLine = (x1, y1, x2, y2, active) => {
                // 深色衬底 + 亮线两层,保证深/浅背景都清晰
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.lineWidth = active ? 5 : 3;
                ctx.stroke();
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.strokeStyle = active ? '#00e5a0' : 'rgba(255,255,255,0.8)';
                ctx.lineWidth = active ? 2.5 : 1.5;
                if (active) {
                    ctx.shadowColor = '#00e5a0';
                    ctx.shadowBlur = 8;
                }
                ctx.stroke();
                ctx.shadowBlur = 0;
            };
            vLines.forEach((x, i) => drawLine(x, 0, x, ch, i === this._logoSnapV));
            hLines.forEach((y, i) => drawLine(0, y, cw, y, i === this._logoSnapH));

            // 边缘吸附:高亮贴住的那条画布边,让"已贴边"有明确反馈
            const ev = this._logoSnapEdgeV, eh = this._logoSnapEdgeH;
            if (ev === 'left') drawLine(1, 0, 1, ch, true);
            else if (ev === 'right') drawLine(cw - 1, 0, cw - 1, ch, true);
            if (eh === 'top') drawLine(0, 1, cw, 1, true);
            else if (eh === 'bottom') drawLine(0, ch - 1, cw, ch - 1, true);

            // 安全区:提示"贴到这里以内不会被裁"。(居中吸附时不画,避免与中心线视觉混淆)
            // 文字度量是逻辑口径；参考线画在物理画布上，需要乘 DPR 才是真实尺寸。
            let dim = this._logoDrawSize(xf.ref, xf.kind || 'text');
            if ((xf.kind || 'text') === 'text') {
                const tk = this.textSpaceScale();
                dim = { w: dim.w * tk, h: dim.h * tk };
            }
            const kx = Math.max(10, Math.min(cw * 0.05, dim.w / 2));
            const ky = Math.max(10, Math.min(ch * 0.05, dim.h / 2));
            ctx.setLineDash([7, 6]);
            ctx.strokeStyle = 'rgba(255,255,255,0.45)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(kx, ky, Math.max(1, cw - kx * 2), Math.max(1, ch - ky * 2));
            ctx.setLineDash([]);

            // 照片区域参考线(金色):照片四边 + 中心,命中的那条高亮
            const pr = this.photoRectEstimate();
            if (pr) {
                const pv = this._logoSnapPhotoV, ph = this._logoSnapPhotoH;
                const drawP = (x1, y1, x2, y2, active) => {
                    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                    ctx.lineWidth = active ? 5 : 2.5;
                    ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                    ctx.strokeStyle = active ? '#ffb454' : 'rgba(255,180,84,0.45)';
                    ctx.lineWidth = active ? 2.5 : 1;
                    ctx.stroke();
                };
                drawP(pr.x, pr.y, pr.x, pr.y + pr.h, pv === 'pleft');
                drawP(pr.x + pr.w, pr.y, pr.x + pr.w, pr.y + pr.h, pv === 'pright');
                drawP(pr.x, pr.y, pr.x + pr.w, pr.y, ph === 'ptop');
                drawP(pr.x, pr.y + pr.h, pr.x + pr.w, pr.y + pr.h, ph === 'pbottom');
                if (pv === 'phcenter') drawP(pr.x + pr.w / 2, 0, pr.x + pr.w / 2, ch, true);
                if (ph === 'pvcenter') drawP(0, pr.y + pr.h / 2, cw, pr.y + pr.h / 2, true);
            }

            // 命中反馈:拖动时在元素中心画瞄准环（旋转/缩放不画，避免盖住文字）
            if (this._dragEl && (this._logoSnapV != null || this._logoSnapH != null || ev || eh || this._logoSnapPhotoV || this._logoSnapPhotoH)) {
                const el = xf.ref;
                const size = this._logoDrawSize(el, 'logo').w;
                // 与 hitTestLogos 同理:瞄准环要画在 logo 实际绘制处(rel 用 _logW 口径),
                // 画布口径会偏 2 倍(dpr=2 时),环与 logo 对不上。
                const gb = this.logoBaseForOverlay();
                const cx0 = this.logoPos(el, gb.w, gb.h, size).cx, cy0 = this.logoPos(el, gb.w, gb.h, size).cy;
                ctx.beginPath();
                ctx.arc(cx0, cy0, size * 0.42, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.lineWidth = 4;
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(cx0, cy0, size * 0.42, 0, Math.PI * 2);
                ctx.strokeStyle = '#00e5a0';
                ctx.lineWidth = 2;
                ctx.shadowColor = '#00e5a0';
                ctx.shadowBlur = 10;
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.beginPath();
                ctx.arc(cx0, cy0, 3, 0, Math.PI * 2);
                ctx.fillStyle = '#00e5a0';
                ctx.fill();
            }
            if (this._rotEl || this._resizeEl) this._drawTransformAxes(ctx, xf, cw, ch);
            ctx.restore();
        } catch(err) { console.warn('drawLogoGuides', err); }
    },

    // AI 图层专用的参考线：网格/照片槽位常驻淡显，命中的对齐线绿色高亮。
    drawAiGuides(ctx, layer, cw, ch) {
        try {
            ctx.save();
            const line = (x1, y1, x2, y2, color, width, dash) => {
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.setLineDash(dash || []);
                ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = width + 2.5; ctx.stroke();
                ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
                ctx.setLineDash([]);
            };
            [cw / 3, cw / 2, cw * 2 / 3].forEach(x => line(x, 0, x, ch, 'rgba(255,255,255,0.38)', 1));
            [ch / 3, ch / 2, ch * 2 / 3].forEach(y => line(0, y, cw, y, 'rgba(255,255,255,0.38)', 1));
            const pr = this.aiPhotoRect(cw, ch);
            if (pr) {
                const g = 'rgba(255,180,84,0.55)';
                line(pr.x, pr.y, pr.x, pr.y + pr.h, g, 1, [7, 5]);
                line(pr.x + pr.w, pr.y, pr.x + pr.w, pr.y + pr.h, g, 1, [7, 5]);
                line(pr.x, pr.y, pr.x + pr.w, pr.y, g, 1, [7, 5]);
                line(pr.x, pr.y + pr.h, pr.x + pr.w, pr.y + pr.h, g, 1, [7, 5]);
            }
            (this._aiGuides || []).forEach(g => {
                const color = g.type === 'photo' ? '#ffb454' : '#00e5a0';
                ctx.shadowColor = color; ctx.shadowBlur = 8;
                if (g.axis === 'v') line(g.pos, 0, g.pos, ch, color, 2.5);
                else line(0, g.pos, cw, g.pos, color, 2.5);
                ctx.shadowBlur = 0;
            });
            const snap = this._aiSnap;
            if (snap) {
                ctx.beginPath(); ctx.arc(snap.x, snap.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#00e5a0'; ctx.fill();
            }
            ctx.restore();
        } catch (err) { console.warn('drawAiGuides', err); }
    },

    // 旋转/缩放时围绕文字框画一组随角度转动的虚线轴：从框的四边向外延伸，
    // 不穿过文字；中心点标出旋转轴心。画布三分/中心线由 drawLogoGuides 负责，
    // 这里补的是「当前角度」这一层参考。
    _drawTransformAxes(ctx, xf, cw, ch) {
        try {
            if (!xf || !xf.ref || typeof window.textLineMetrics !== 'function') return;
            if (!this._rotEl && !this._resizeEl) return;
            const cv = this.dom && this.dom.canvas;
            if (!cv || !cw || !ch) return;
            const k = this.textSpaceScale();
            const logW = (cv._logW > 1) ? cv._logW : cw;
            const logH = (cv._logH > 1) ? cv._logH : ch;
            const m = window.textLineMetrics(xf.ref, logW, logH, false, 0, 0);
            if (!m) return;
            const cx = m.cx * k, cy = m.cy * k;
            const th = m.rot * Math.PI / 180;
            const co = Math.cos(th), si = Math.sin(th);
            const hw = Math.max(7, m.lw * k / 2);
            const hh = Math.max(7, m.lh * k / 2);
            const gap = 10 * k;
            // 轴线只伸出文字框一小段：足够看清当前角度，又不会在整张照片上
            // 拉出一个巨大的 X 盖住画面。画布三分/中心线由 drawLogoGuides 负责。
            const arm = Math.max(70 * k, Math.min(180 * k, Math.min(cw, ch) * 0.16));
            const ray = (ux, uy, start) => {
                const end = start + arm;
                const x1 = cx + ux * start, y1 = cy + uy * start;
                const x2 = cx + ux * end, y2 = cy + uy * end;
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.strokeStyle = 'rgba(0,0,0,0.42)';
                ctx.lineWidth = 3.5 * k;
                ctx.stroke();
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.strokeStyle = 'rgba(0,229,160,0.55)';
                ctx.lineWidth = 1.25 * k;
                ctx.setLineDash([6 * k, 5 * k]);
                ctx.stroke();
                ctx.setLineDash([]);
            };
            ctx.save();
            // 文字框本地 X/Y 轴的四根射线，从框外开始，避免压在文字上。
            // 上方那根给旋转把手让位，从把手外侧再起笔，别把把手盖住。
            ray(co, si, hw + gap);
            ray(-co, -si, hw + gap);
            ray(-si, co, hh + gap);
            ray(si, -co, hh + gap + 34 * k);
            // 旋转轴心：小圆点 + 十字
            const pr = 5 * k;
            ctx.strokeStyle = 'rgba(0,229,160,0.85)';
            ctx.lineWidth = 1.25 * k;
            ctx.beginPath();
            ctx.moveTo(cx - pr, cy); ctx.lineTo(cx + pr, cy);
            ctx.moveTo(cx, cy - pr); ctx.lineTo(cx, cy + pr);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, 2.5 * k, 0, Math.PI * 2);
            ctx.fillStyle = '#00e5a0';
            ctx.fill();
            ctx.restore();
        } catch (err) { console.warn('_drawTransformAxes', err); }
    },

    armLogoPlacement(logo) {
        // 直接加到画布中央,然后用户可拖动
        this.addLogoElement(logo);
    },

    async addLogoElement(logo, px, py) {
        if (!logo) return;
        this.onSettingCommit();
        if (!this.template) return;
        // 预加载图标到缓存,确保渲染时图片已就绪(避免首帧因 Image 未加载完而跳过绘制)
        const bmp = this.logoImgCache[logo.dataUrl] || window.qfsImage();
        this.logoImgCache[logo.dataUrl] = bmp;
        if (!bmp.complete || !bmp.naturalWidth) {
            await new Promise(res => { bmp.onload = res; bmp.onerror = res; bmp.src = logo.dataUrl; });
        }
        // 图片已就绪:顺手把引擎的位图缓存(TEXTURE_CACHE)也指向这张已加载的图,
        // 这样首帧渲染就能直接画出来,不依赖「引擎自己再加载一遍 + onload 补帧」这条会偶发丢失的链路。
        if (typeof window.getElementBitmap === 'function' && bmp.complete && bmp.naturalWidth) {
            window.getElementBitmap(logo.dataUrl);
        }
        if (!this.template.logoElements) this.template.logoElements = [];
        const cw = this.dom.canvas.width, ch = this.dom.canvas.height;
        const ratio = bmp.naturalHeight / bmp.naturalWidth || 1;
        // 默认按画布宽度取比例(原为写死的 500px):固定值在 800px 画布上占 62%,在 3600px 上只占 14%,
        // 用户每次都得手动调。改为约 12% 画布宽并夹在 80~2000,大小观感在不同分辨率下保持一致。
        // 最后再和放大上限取小,极小画布上也不会一添加就超出画布。
        const size = Math.min(clampNum(Math.round(cw * 0.12), 80, 2000), this.logoMaxSize({ ratio }));
        const el = {
            name: logo.name, dataUrl: logo.dataUrl, img: null,
            x: px != null ? px : Math.round(cw / 2), y: py != null ? py : Math.round(ch / 2), size, opacity: 100, rotation: 0, z: 10, free: 1,
            ratio,
        };
        // 补记相对比例:新加的 Logo 默认在画布中央,换照片尺寸时应仍在中央,而不是按像素算偏
        this.setLogoPixelPos(el, el.x, el.y);
        this.template.logoElements.push(el);
        this.selectedEls = [{ kind: 'logo', obj: el }];
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus(`已添加 Logo「${logo.name}」`);
    },

    focusElement(el, factor) {
        if (!el || !this.image) return;
        const canvas = this.dom.canvas;
        if (!canvas.width) return;
        const stage = this.dom.stage;
        const rect = stage.getBoundingClientRect();
        const z0 = this.zoom || 0.1;
        const z1 = Math.min(3, Math.max(0.1, z0 * (factor || 2.5)));
        const lw = canvas._logW || canvas.width, lh = canvas._logH || canvas.height;
        const fx = (el.x / canvas.width) * lw, fy = (el.y / canvas.height) * lh;
        this.panX = Math.round(rect.width / 2 - fx * z1);
        this.panY = Math.round(rect.height / 2 - fy * z1);
        this.setZoom(z1);
    },

    // 文字转图片:把输入文字渲染成透明 PNG,作为可拖拽/缩放/旋转的元素加到画布(复用 Logo 管线)
    async textToImage() {
        const $ = this.$;
        const inp = $('tfTextToImage');
        const text = inp ? String(inp.value).trim() : '';
        if (!text) { this.setStatus('先输入要转图片的文字'); return; }
        const fontSel = $('cbT2iFont'), colorInp = $('cpT2iColor'), effSel = $('cbT2iEffect');
        const fontFamily = fontSel && fontSel.value ? fontSel.value : '"Microsoft YaHei","PingFang SC",sans-serif';
        const color = colorInp && colorInp.value ? colorInp.value : '#000000';
        const effect = effSel ? effSel.value : 'none';
        const c = document.createElement('canvas');
        const pad = 56, font = '700 120px ' + fontFamily;
        let ctx = c.getContext('2d');
        ctx.font = font;
        const w = Math.max(10, Math.ceil(ctx.measureText(text).width));
        c.width = w + pad * 2;
        c.height = 232;
        ctx = c.getContext('2d');
        ctx.font = font;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const tx = pad, ty = c.height / 2;
        const gradTop = '#ffffff', gradBottom = color;
        if (effect === 'stroke') {
            ctx.lineWidth = 10; ctx.lineJoin = 'round'; ctx.strokeStyle = '#ffffff';
            ctx.strokeText(text, tx, ty);
            ctx.fillStyle = color; ctx.fillText(text, tx, ty);
        } else if (effect === 'shadow') {
            ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 8; ctx.shadowBlur = 18;
            ctx.fillStyle = color; ctx.fillText(text, tx, ty);
        } else if (effect === 'gradient') {
            const g = ctx.createLinearGradient(0, ty - 70, 0, ty + 70);
            g.addColorStop(0, gradTop); g.addColorStop(1, gradBottom);
            ctx.fillStyle = g; ctx.fillText(text, tx, ty);
        } else if (effect === 'outline') {
            ctx.lineWidth = 8; ctx.lineJoin = 'round'; ctx.strokeStyle = color;
            ctx.strokeText(text, tx, ty);
        } else {
            ctx.fillStyle = color; ctx.fillText(text, tx, ty);
        }
        const dataUrl = c.toDataURL('image/png');
        const logo = { name: text, dataUrl, custom: true };
        this.logos.push(logo);
        this.saveCustomIcon(logo);
        await this.addLogoElement(logo);
        this.renderLogoPools();
        if (inp) inp.value = '';
        this.setStatus('已把文字「' + text + '」转成图片元素:已存入自定义图标池,可直接拖拽/缩放/旋转');
    },

    async addCustomIcon() {
        const res = await window.qingframe.openStickerImage();
        if (res && res.error) { this.setStatus(res.error); return; }
        if (!res || !res.data) return;
        // 按扩展名判断 MIME:主进程只回传文件名与 base64。此前一律标成 image/jpeg,
        // 会把带透明通道的 PNG 图标当作 JPEG 解码,导致透明底变黑、边缘出现杂色块。
        const ext = String(res.name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
        const mime = { png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' }[ext ? ext[1] : ''] || 'image/jpeg';
        const dataUrl = 'data:' + mime + ';base64,' + res.data;
        const im = window.qfsImage();
        await new Promise(r => { im.onload = r; im.onerror = r; im.src = dataUrl; });
        if (!im.naturalWidth) { this.setStatus('图片加载失败'); return; }
        const defaultName = String(res.name || '自定义').replace(/\.[a-z0-9]+$/i, '');
        const typed = await this.promptText('给这个 Logo 起个名字(留空则用文件名)', defaultName);
        if (typed === null) { this.setStatus('已取消添加'); return; }
        const logo = { name: (typed || '').trim() || defaultName, dataUrl, custom: true };
        this.logos.push(logo);
        this.saveCustomIcon(logo);
        this.addLogoElement(logo);
        this.renderLogoPools();
    },

    // 批量导入 Eagle 素材包（.eaglepack）。主进程负责解包与落盘（userData/brandlogos），
    // 这里只做按钮态、重扫 logo 池和结果反馈。
    // filePath 可选：不传则弹系统文件框（UI 按钮走这条路）；传了就直接导（探针/拖拽用）。
    async importLogoPack(filePath) {
        const btn = this.$('btnImportLogoPack');
        const label = btn ? btn.textContent : '';
        // 改了 src/main 却只刷了页面（F5/Ctrl+R）时：新按钮在、主进程还是旧的。
        // 这两种情况都别把裸 IPC 错误丢给用户，直说要重启。
        if (!window.qingframe || typeof window.qingframe.importLogoPack !== 'function') {
            this.setStatus('这个功能需要重启应用才生效：完全退出后重新打开（刷新页面不够）');
            return;
        }
        if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
        try {
            const r = await window.qingframe.importLogoPack(filePath);
            if (!r || r.canceled) { this.setStatus('已取消导入'); return; }
            if (r.error) { this.setStatus('导入失败：' + r.error); return; }
            const n = (r.added || 0) + (r.replaced || 0);
            // 重新扫池子:主进程把文件写进了 userData/brandlogos
            await this.loadLogos();
            this.renderLogoPools();
            const parts = [];
            if (r.added && r.replaced) parts.push(`已导入 ${r.added} 个，更新 ${r.replaced} 个同名`);
            else if (r.replaced) parts.push(`已更新 ${r.replaced} 个同名品牌 Logo`);
            else parts.push(`已导入 ${n} 个品牌 Logo`);
            // 与内置同名时池子数量不会变，不说明会以为没生效
            if (r.shadowed) parts.push(`其中 ${r.shadowed} 个与内置同名，已用导入版`);
            if (r.svgOnly) parts.push(`跳过 ${r.svgOnly} 个只有 SVG 的（这版只收位图）`);
            if (r.skipped && r.skipped > (r.svgOnly || 0)) parts.push(`另有 ${r.skipped - (r.svgOnly || 0)} 个读不出来`);
            this.setStatus(parts.join('，'));
        } catch (e) {
            const msg = String(e && e.message || e || '');
            if (/No handler registered|is not a function/i.test(msg)) {
                this.setStatus('这个功能需要重启应用才生效：完全退出后重新打开（刷新页面不够）');
            } else {
                this.setStatus('导入失败：' + msg);
            }
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = label || '导入 Logo 素材包'; }
        }
    },

    refreshElList() {
        const $ = this.$;
        const list = $('elList'), status = $('elStatus');
        if (!list) return;
        const t = this.template;
        const items = [];
        (t && t.logoElements || []).forEach((el, i) => items.push({ kind: 'logo', i, label: el.name || 'Logo', src: el.dataUrl, obj: el }));
        (t && t.decorConfig && t.decorConfig.stickers || []).forEach((el, i) => items.push({ kind: 'sticker', i, label: '贴纸', src: el.src, obj: el }));
        (t && t.decorConfig && t.decorConfig.textLines || []).forEach((el, i) => {
            // 不再只收 align==='free'：87 个预设的文字全是锚定行，只收 free 等于
            // 「元素管理」里一个字都看不到，用户只能改字号。这里全列出来，
            // 拖动/输入坐标时才就地解锁（promoteTextToFree），画面不跳。
            if (!el.text || this._isHiddenExifLine(el, t.decorConfig)) return;
            items.push({ kind: 'text', i, label: String(el.text).substring(0, 8), src: null, obj: el });
        });
        list.innerHTML = '';
        if (!items.length) {
            status.textContent = '未选中元素';
            const e = document.createElement('div');
            e.className = 'el-row';
            e.textContent = '画布上暂无文字/贴纸/Logo';
            list.appendChild(e);
            return;
        }
        const tagMap = { logo: 'Logo', sticker: '贴纸', text: '文字', aiLayer: 'AI 边框' };
        items.forEach(it => {
            const r = document.createElement('div');
            r.className = 'el-row';
            if (it.kind === 'logo' || it.kind === 'sticker') {
                const img = document.createElement('img');
                img.src = it.src;
                r.appendChild(img);
            }
            const span = document.createElement('span');
            span.textContent = it.label;
            r.appendChild(span);
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = tagMap[it.kind];
            r.appendChild(tag);
            const sel = this.selectedEls.some(x => x.kind === it.kind && x.obj === it.obj);
            if (sel) r.classList.add('active');
            // 列表多选:普通点击=单选;Ctrl/Cmd 点击=加选/取消;Shift 点击=范围选取。
            // 底层 selectedEls / applyToSelectedEls / 批量滑块早就支持多选,此前列表点击会
            // 直接覆盖选中集,导致"给多个 Logo 统一调透明度"只能在画布上逐个 Shift 点选。
            r.addEventListener('click', (ev) => {
                const cur = this.selectedEls.some(x => x.kind === it.kind && x.obj === it.obj);
                if (ev.shiftKey && this._elListAnchor) {
                    const i0 = items.findIndex(x => x.obj === this._elListAnchor.obj && x.kind === this._elListAnchor.kind);
                    const i1 = items.indexOf(it);
                    if (i0 >= 0 && i1 >= 0) {
                        const [a, b] = i0 <= i1 ? [i0, i1] : [i1, i0];
                        const range = items.slice(a, b + 1).map(x => ({ kind: x.kind, obj: x.obj }));
                        // 叠加去重,保留已有选中项
                        const merged = this.selectedEls.slice();
                        range.forEach(r2 => {
                            if (!merged.some(m => m.kind === r2.kind && m.obj === r2.obj)) merged.push(r2);
                        });
                        this.selectedEls = merged;
                    }
                } else if (ev.ctrlKey || ev.metaKey) {
                    if (cur) this.selectedEls = this.selectedEls.filter(x => !(x.kind === it.kind && x.obj === it.obj));
                    else this.selectedEls.push({ kind: it.kind, obj: it.obj });
                    this._elListAnchor = { kind: it.kind, obj: it.obj };
                } else {
                    this.selectedEls = [{ kind: it.kind, obj: it.obj }];
                    this._elListAnchor = { kind: it.kind, obj: it.obj };
                }
                this.refreshElList();
                this.scheduleRender(true);
            });
            list.appendChild(r);
        });
        const first = this.selectedEls.length ? this.selectedEls[0] : null;
        const n = this.selectedEls.length;
        status.textContent = !first ? `共 ${items.length} 个元素,点击选择(可 Ctrl/Shift 多选)`
            : (n > 1 ? `已选中 ${n} 个元素` : `${tagMap[first.kind]}「${this.elLabel(first.obj)}」已选中`);
        if (first) this.syncSliderFromEl({ kind: first.kind, obj: first.obj });
        else this.syncTextRows(null);   // 取消选中时把「方向/字距」两行也收起来
        this.syncElInputs();
    },

    elLabel(el) {
        if (!el) return '';
        return el.name || el.text || '元素';
    },

    applyToSelectedEls(fn) {
        this.selectedEls.forEach(s => fn(s.obj, s.kind));
    },

    batchElOps() {
        this.saveCurrentTemplate();
        this.scheduleRender();
    },

    copyElement() {
        const first = this.selectedEls[0];
        if (!first) { this.setStatus('请先选中元素'); return; }
        this._elClip = { kind: first.kind, el: JSON.parse(JSON.stringify(first.obj)) };
        this.setStatus('已复制选中元素');
    },

    pasteElement() {
        if (!this._elClip) { this.setStatus('剪贴板为空'); return; }
        this.onSettingCommit();
        const t = this.template;
        const make = () => {
            const copy = JSON.parse(JSON.stringify(this._elClip.el));
            if (copy.x != null) copy.x += 24;
            if (copy.y != null) copy.y += 24;
            if (copy.offsetX != null) copy.offsetX += 24;
            if (copy.offsetY != null) copy.offsetY += 24;
            return copy;
        };
        let placed = null;
        if (this._elClip.kind === 'logo') {
            if (!t.logoElements) t.logoElements = [];
            const n = make();
            n.size = clampNum(n.size || 60, 8, this.logoMaxSize(n));
            t.logoElements.push(n); placed = { kind: 'logo', obj: n };
        } else if (this._elClip.kind === 'sticker') {
            const decor = t.decorConfig || (t.decorConfig = {});
            if (!decor.stickers) decor.stickers = [];
            const n = make(); decor.stickers.push(n); placed = { kind: 'sticker', obj: n };
        } else if (this._elClip.kind === 'text') {
            const decor = t.decorConfig || (t.decorConfig = {});
            if (!decor.textLines) decor.textLines = [];
            const n = make(); decor.textLines.push(n); placed = { kind: 'text', obj: n };
        }
        if (placed) this.selectedEls = [placed];
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
    },

    deleteElement() {
        const sel = this.selectedEls;
        if (!sel.length) { this.setStatus('请先选中元素'); return; }
        if (sel.some(s => s.kind === 'aiLayer' && s.obj && s.obj.type === 'photo')) {
            this.setStatus('照片槽位不能删除：它决定照片位置和画布比例');
            return;
        }
        this.onSettingCommit();
        const t = this.template;
        sel.forEach(s => {
            if (s.kind === 'logo') { const i = (t.logoElements || []).indexOf(s.obj); if (i >= 0) t.logoElements.splice(i, 1); }
            else if (s.kind === 'sticker') { const a = (t.decorConfig && t.decorConfig.stickers) || []; const i = a.indexOf(s.obj); if (i >= 0) a.splice(i, 1); }
            else if (s.kind === 'text') { const a = (t.decorConfig && t.decorConfig.textLines) || []; const i = a.indexOf(s.obj); if (i >= 0) a.splice(i, 1); }
            else if (s.kind === 'aiLayer') { const a = t.aiLayers || []; const i = a.indexOf(s.obj); if (i >= 0) a.splice(i, 1); }
        });
        this.selectedEls = [];
        this._aiGuides = null; this._aiSnap = null;
        if (this._syncAiLayerEdit) this._syncAiLayerEdit();
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        // 元素删掉后状态栏还停在上一句「已添加 Logo」，用户分不清是删成功了
        // 还是快捷键失灵（deleteCaption / clearElements 都有反馈，这里补上）
        this.setStatus(`已删除 ${sel.length} 个选中元素`);
    },

    clearElements() {
        if (!this.template) return;
        this.onSettingCommit();
        this.template.logoElements = [];
        if (this.template.decorConfig) { this.template.decorConfig.stickers = []; this.template.decorConfig.textLines = []; }
        this.selectedEls = [];
        delete this.template._draftText;
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus('已清空全部元素');
    },

    moveZOrder(delta) {
        if (!this.selectedEls.length) { this.setStatus('请先选中元素'); return; }
        this.onSettingCommit();
        const kinds = ['logo', 'sticker', 'text'];
        kinds.forEach(kind => {
            const els = (kind === 'logo') ? (this.template.logoElements || [])
                : (kind === 'sticker') ? (this.template.decorConfig && this.template.decorConfig.stickers || [])
                    : (this.template.decorConfig && this.template.decorConfig.textLines || []);
            this.selectedEls.forEach(s => {
                const i = els.indexOf(s.obj);
                if (i < 0) return;
                els[i].z = (els[i].z || 0) + delta;
                // 通过 z 排序实现层级:直接赋序
                els[i].z = clampNum(els[i].z, -100, 100);
            });
            // 依据 z 排序后按新序重排数组(等效 Java 中 moveZOrder 1/-1/2/-2)
            els.sort((a, b) => (a.z || 0) - (b.z || 0));
        });
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
    },



    // 元素对齐 / 均分 / 统一尺寸。基准取「所有选中元素的包围盒」(贴近常见编辑器行为)。
    // 兼容两种坐标:绝对像素(el.x 为数字)与锚点+偏移(el.x 为 'right'/'bottom' 等)。
    // 后者在写回时按目标点反算 offset,避免被强行转成像素坐标而失去"随画布自适应"的特性。
    alignSelectedEls(mode) {
        const sel = (this.selectedEls || []).filter(s => s && s.obj);
        if (sel.length < 2) { this.setStatus('请至少选中两个元素再对齐'); return; }
        const cv = this.dom.canvas;
        const cwM = Math.max(1, cv.width), chM = Math.max(1, cv.height);
        const lw = cv._logW || cwM, lh = cv._logH || chM;

        this.onSettingCommit();
        const boxes = sel.map(s => {
            const o = s.obj;
            const dim = this._elBoxSize(s);
            const cur = (typeof o.x === 'number' && typeof o.y === 'number')
                ? { cx: o.x, cy: o.y }
                : this.logoPos(o, lw, lh, dim.w);
            return { s, dim, cur, box: { x0: cur.cx - dim.w / 2, y0: cur.cy - dim.h / 2, x1: cur.cx + dim.w / 2, y1: cur.cy + dim.h / 2 } };
        });

        const L = Math.min(...boxes.map(b => b.box.x0));
        const R = Math.max(...boxes.map(b => b.box.x1));
        const T = Math.min(...boxes.map(b => b.box.y0));
        const B = Math.max(...boxes.map(b => b.box.y1));
        const HC = (L + R) / 2, VC = (T + B) / 2;

        if (mode === 'sameSize') {
            const avg = Math.round(boxes.reduce((sum, b) => sum + b.dim.w, 0) / boxes.length);
            boxes.forEach(b => { this._applyElSize(b.s.kind, b.s.obj, Math.max(2, avg)); });
        } else if (mode === 'distH' || mode === 'distV') {
            const horiz = mode === 'distH';
            const sorted = boxes.slice().sort((a, b) => (horiz ? a.cur.cx - b.cur.cx : a.cur.cy - b.cur.cy));
            const first = sorted[0], last = sorted[sorted.length - 1];
            const span = horiz ? (last.cur.cx - first.cur.cx) : (last.cur.cy - first.cur.cy);
            const step = span / (sorted.length - 1);
            sorted.forEach((b, i) => {
                const cx = horiz ? first.cur.cx + step * i : b.cur.cx;
                const cy = horiz ? b.cur.cy : first.cur.cy + step * i;
                this._applyElPos(b.s.obj, cx, cy, cwM, chM, lw, lh, b.dim);
            });
        } else {
            boxes.forEach(b => {
                let cx = b.cur.cx, cy = b.cur.cy;
                if (mode === 'left') cx = L + b.dim.w / 2;
                else if (mode === 'right') cx = R - b.dim.w / 2;
                else if (mode === 'hcenter') cx = HC;
                else if (mode === 'top') cy = T + b.dim.h / 2;
                else if (mode === 'bottom') cy = B - b.dim.h / 2;
                else if (mode === 'vcenter') cy = VC;
                this._applyElPos(b.s.obj, cx, cy, cwM, chM, lw, lh, b.dim);
            });
        }
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        const names = { left: '左对齐', hcenter: '水平居中', right: '右对齐', top: '顶对齐', vcenter: '垂直居中', bottom: '底对齐', distH: '水平均分', distV: '垂直均分', sameSize: '统一尺寸' };
        this.setStatus('已' + (names[mode] || mode));
    },

    // 元素在画布上的近似外接尺寸(对齐用)。Logo 为宽×宽×纵横比;贴纸按原图×scale;文字按字号方块。
    _elBoxSize(s) {
        const o = s.obj || {};
        if (s.kind === 'logo') return this._logoDrawSize(o);
        if (s.kind === 'sticker') {
            const im = window.getElementBitmap ? window.getElementBitmap(o.src) : null;
            const sc = o.scale || 1;
            const w = (im && im.naturalWidth ? im.naturalWidth : 100) * sc;
            const h = (im && im.naturalHeight ? im.naturalHeight : 100) * sc;
            return { w, h };
        }
        const f = (o.fontSize || 18) * 1.2;
        return { w: f * Math.max(1, String(o.text || '').length) * 0.6, h: f };
    },

    _applyElSize(kind, o, size) {
        if (kind === 'logo') o.size = clampNum(size, 8, this.logoMaxSize(o));
        else if (kind === 'sticker') o.scale = clampNum(size / 100, 0.02, 3);
        else if (kind === 'text') o.fontSize = clampNum(size, 6, 300);
    },

    _applyElPos(o, cx, cy, cwM, chM, lw, lh, dim) {
        if (typeof o.x === 'string' || typeof o.y === 'string') {
            // 锚点定位:保持锚点不变,按目标点反算偏移量,这样它仍能随画布尺寸自适应
            const hAlign = o.x || 'right', vAlign = o.y || 'bottom';
            const half = dim.w / 2, halfY = dim.h / 2;
            if (hAlign === 'left') o.offsetX = Math.round(cx - half);
            else if (hAlign === 'center') o.offsetX = 0;
            else o.offsetX = Math.round(lw - cx - half);
            if (vAlign === 'top') o.offsetY = Math.round(cy - halfY);
            else if (vAlign === 'center') o.offsetY = 0;
            else o.offsetY = Math.round(lh - cy - halfY);
            if (o.offsetX < 0) o.offsetX = 0;
            if (o.offsetY < 0) o.offsetY = 0;
            return;
        }
        // 绝对坐标:按测量画布→显示画布的缩放换算(与拖拽一致),并同步相对比例
        this.setLogoPixelPos(o, cx * (cwM / lw), cy * (chM / lh));
    },
});

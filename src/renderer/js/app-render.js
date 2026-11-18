// 渲染模块：rAF 调度队列 / 拖动背景缓存 / 帧合成 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* 防御：临时渲染（缩略图 / 沉浸预览 / 导出）会临时改 this.image，
       还原时若与 currentIdx 错位，就会出现「胶片条高亮新图、画布还画旧图」
       —— 表现为切图后缩略图与画布不是同一张。这里以 currentIdx 为准纠正一次。
       正常路径下 this.image === images[currentIdx]，本函数是空操作。 */
    _reconcileCurrentImage() {
        const imgs = this.images;
        if (!imgs || !imgs.length) return false;
        const cur = imgs[this.currentIdx];
        if (!cur || this.image === cur) return false;
        // 这是切换当前图后的纠错路径，也要把撤销栈换成该图自己的。
        if (typeof this._swapHistory === 'function') this._swapHistory(cur);
        this.image = cur;
        const saved = this.getTpl ? this.getTpl(cur) : null;
        this.template = saved ? JSON.parse(JSON.stringify(saved)) : this.defaultTemplate();
        return true;
    },

    /* ══ 渲染调度 ══ */
    // 单一 rAF 队列 + 脏标记。任意多次 scheduleRender 合并为「下一帧渲一次」,
    // 帧回调天然与屏幕刷新对齐,不会出现 setTimeout 落在两次 vblank 之间造成的撕裂/半帧感。
    // 取代旧的 setTimeout(dly) 尾随防抖:旧实现手势期要等 120ms 才出下一帧,手感明显拖尾。
    scheduleRender(immediate) {
        if (!this.image) return;
        this._renderDirty = true;
        // 手势拖动中(滑块/文本框聚焦)降频:按帧跳过,而不是靠定时器延迟
        this._renderUrgent = this._renderUrgent || !!immediate;
        this._renderSkip = immediate ? 0 : (this._gesture ? 2 : 0);
        if (this._renderRaf) return;
        this._renderRaf = requestAnimationFrame(() => this._drainRenderQueue());
    },

    // 帧回调:按 _renderSkip 决定本帧是否真的合成。
    // 跳帧时把脏标记留着并重新排下一帧,保证手势结束前不会漏掉最后一次刷新。
    _drainRenderQueue() {
        this._renderRaf = 0;
        if (!this._renderDirty) return;
        if (this._renderSkip > 0) {
            this._renderSkip--;
            this._renderRaf = requestAnimationFrame(() => this._drainRenderQueue());
            return;
        }
        this._renderDirty = false;
        this._renderSkip = 0;
        this._renderUrgent = false;
        this.renderPreview();
        // 兑现 flushRender 等待者:此时本帧已真正合成,调用方可安全读像素
        if (this._renderFlushResolvers.length) {
            const rs = this._renderFlushResolvers;
            this._renderFlushResolvers = [];
            rs.forEach(res => res());
        }
    },

    // 导出/测像素等必须等某一帧真正画完的场合用:提交渲染并同步等到该帧回调跑完。
    // 走同一个队列,避免与 scheduleRender 并行排两帧导致读到半成品。
    flushRender() {
        if (!this.image) return Promise.resolve();
        this._renderDirty = true;
        this._renderUrgent = true;
        this._renderSkip = 0;
        if (this._renderRaf) return new Promise(res => {
            const prev = this._renderFlushResolvers;
            prev.push(res);
            return undefined;
        });
        return new Promise(res => {
            this._renderFlushResolvers = [res];
            this._renderRaf = requestAnimationFrame(() => this._drainRenderQueue());
        });
    },

    // 照片切换时清空 AWT 样式缓存(模糊底/取色/高斯核)
    invalidateStyleCaches() {
        const es = window.EngineStyles;
        if (!es || typeof es.clearCaches !== 'function') return;
        try { es.clearCaches(); } catch (e) {}
    },

    // 模板是否已含有效边框设置(区别于默认原图模板)
    hasBorderSettings(t) {
        if (!t) return false;
        if (Array.isArray(t.aiLayers) && t.aiLayers.length) return true;
        if (Array.isArray(t.layers) && t.layers.length) return true;
        if (t.templateName || t.templateTag || t.photoFrameStyle) return true;
        const m = t.baseMargin;
        if (m) {
            if (m.marginTop || m.marginBottom || m.marginLeft || m.marginRight) return true;
            if (m.imgScale && m.imgScale !== 1) return true;
        }
        return false;
    },

    /* ══ 拖动叠加层:拖拽期间避免每帧全量重合成 ══
       问题:移动 logo/贴纸/文字时每帧都会走完整引擎(实测 52~143ms/帧,见 tools/measure-drag.js),
       而 logo 是最后绘制的一层,前面所有内容(照片+边框+光影)在拖动期间完全不变。
       做法:拖动首帧把"不含被拖元素"的整帧结果缓存成背景位图,之后每帧只 blit 背景 +
       重绘被拖元素 + 选择框/参考线,把每帧成本从「全量合成」降到「一次位图拷贝」。
       正确性:缓存键包含画布尺寸/模板引用/图源,任一变化即重建;拖动结束后清缓存并整帧重渲染。 */
    _dragBaseValid() {
        const c = this._dragBase;
        const cv = this.dom.canvas;
        return !!(c
            && c.bmp
            && c.w === cv.width && c.h === cv.height
            && c.tpl === this.template
            && c.img === (this.image && this.image.el));
    },

    // 当前正在做的手势：拖动 / 旋转 / 拖角缩放。三者都只改一个元素，
    // 都能复用「静态背景 + 单元素重绘」的快速通道，避免每帧全量合成。
    _activeTransform() {
        if (this._dragEl && this._dragEl.ref) {
            return { ref: this._dragEl.ref, kind: this._dragEl.kind || 'text' };
        }
        if (this._rotEl && this._rotEl.ref) return { ref: this._rotEl.ref, kind: 'text' };
        if (this._resizeEl && this._resizeEl.ref) {
            return { ref: this._resizeEl.ref, kind: 'text', isAi: !!this._resizeEl.isAi };
        }
        return null;
    },

    // 只有 photo 之后的前景层能走单元素重绘快通道：背景层在照片下面，
    // 补画到缓存上面会盖住照片；照片槽位本身拖动会改变画布比例，必须整帧重算。
    aiLayerFastOk(layer) {
        const layers = this.template && this.template.aiLayers;
        if (!layer || !Array.isArray(layers) || !window.AiLayers) return false;
        const i = layers.indexOf(layer);
        if (i < 0) return false;
        const pi = window.AiLayers.findPhotoIndex(layers);
        const anchor = pi >= 0 ? pi : window.AiLayers.fallbackPhotoIndex(layers);
        return i > anchor;
    },

    _dragBaseBuild() {
        const canvas = this.dom.canvas;
        const bmp = document.createElement('canvas');
        bmp.width = canvas.width;
        bmp.height = canvas.height;
        // 此时被拖元素已从整帧绘制中排除,拷出来即是干净背景
        bmp.getContext('2d').drawImage(canvas, 0, 0);
        this._dragBase = { bmp, w: canvas.width, h: canvas.height, tpl: this.template, img: this.image && this.image.el };
    },

    _blitDragBase() {
        const canvas = this.dom.canvas;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // 背景位图是在「拖动态当时」的画布尺寸下建的,而拖动期间 displayMax 会变(降级再复原),
        // 因此要按当前画布尺寸缩放贴回,否则会把小图直接摊在画布一角
        const b = this._dragBase.bmp;
        const same = b.width === canvas.width && b.height === canvas.height;
        // 同尺寸时位图不透明且铺满画布，clearRect 一次千万级像素纯属浪费。
        if (!same) ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (same) ctx.drawImage(b, 0, 0);
        else ctx.drawImage(b, 0, 0, b.width, b.height, 0, 0, canvas.width, canvas.height);
    },

    // 注意不再接收 cw/ch:元素几何一律按「基准画布」口径计算(与引擎 drawLogoElements 一致),
    // 传入最终画布尺寸反而会误用。保留参数位会让调用方以为尺寸有效,故直接去掉。
    _drawDraggedEl(ctx, el, kind) {
        if (!el) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (kind === 'aiLayer' && window.AiLayers) {
            // 引擎按「基准画布」画 AI 层，再由 setupCanvas 的 scale 放大到后备像素。
            // 叠加层要套同一个 scale，否则拖动中的位置/字号会和松手后不一致。
            const { bw, bh } = this.aiCanvasBase();
            const s = (this.dom.canvas.width || 1) / Math.max(1, bw);
            ctx.setTransform(s, 0, 0, s, 0, 0);
            // 用 AiLayers.render 而不是 drawLayer：它会带上内部图片缓存，image 层不重复解码。
            window.AiLayers.render(ctx, [el], bw, bh, null);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            return;
        }
        // 关键:引擎在 drawLogoElements 里用 canvas._logW/_logH(基准画布)作为 rel 比例的分母,
        // 即 rx/ry 是「相对基准画布」的比例,元素几何也在基准口径下计算。
        // 叠加层必须与引擎完全一致,否则拖动中元素位置/大小会与松手后不同(会跳一下)。
        // 因此这里不做额外缩放,直接按基准口径绘制(与引擎同一坐标系)。
        const ovBase = this.logoBaseForOverlay();
        if (kind === 'logo' || kind === 'sticker') {
            const src = kind === 'logo' ? el.dataUrl : el.src;
            if (!src) return;
            // 复用引擎的同一份位图缓存,避免拖动中重复解码
            const img = window.getElementBitmap ? window.getElementBitmap(src) : null;
            if (!img || !img.complete || !img.naturalWidth) return;
            const size = kind === 'logo'
                ? Math.min(Math.max(2, el.size || 60), this.logoMaxSize(el))
                : 0;
            let dw, dh, cx, cy;
            if (kind === 'logo') {
                const ratio = img.naturalHeight / img.naturalWidth || 1;
                dw = size; dh = size * ratio;
                // 走 logoPos 统一解析 rel / 锚点 / 旧像素三种形式,并传基准口径尺寸
                const bp = this.logoPos(el, ovBase.w, ovBase.h, size);
                cx = bp.cx; cy = bp.cy;
            } else {
                dw = img.naturalWidth * (el.scale || 1);
                dh = img.naturalHeight * (el.scale || 1);
                cx = el.x || 0; cy = el.y || 0;
            }
            const op = el.opacity == null ? 100 : el.opacity;
            ctx.save();
            ctx.globalAlpha = Math.max(0, Math.min(1, op / 100));
            ctx.translate(cx, cy);
            if (el.rotation) ctx.rotate(el.rotation * Math.PI / 180);
            ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();
        } else if (kind === 'text') {
            // 文字复用引擎绘制。引擎现在按「物理画布 + scl」画文字（见 engine.js 的
            // textScl），这里必须给同一口径：以前传的是逻辑尺寸 ovBase 且不给 scl，
            // 于是按下瞬间会多出一份「逻辑坐标、未缩放」的小字贴在左上角（用户实测）。
            // 相框通道里 _logW == canvas.width，所以 scl 自然是 1，两种通道都对。
            // 不限制 align：预设里锚定在顶部/底部的文字旋转/缩放时也要先画出来，
            // drawTextLine 自己会按锚点算位置。
            if (el.text && window.drawTextLine) {
                const cvEl = this.dom.canvas;
                const cw = cvEl.width || 1, chh = cvEl.height || 1;
                const scl = (cvEl._logW > 1) ? cw / cvEl._logW : 1;
                window.drawTextLine(ctx, el, cw, chh, false, 0, 0, scl);
            }
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    },

    _dropDragBase() { this._dragBase = null; },

    // 帧回调内同步执行整帧合成。旧实现在这里再套一层 rAF + token,
    // 与外层调度器构成双重排队,白白多等一帧,且 renderToken 的作废判断在同步体内永远为真、
    // 形同死代码。现在由 _drainRenderQueue 保证「每帧至多一次、且不丢最后一次」,这里直接画。
    renderPreview() {
        // 先纠正错位的当前图（见 _reconcileCurrentImage）：切图后画布必须跟选中图一致
        if (this._reconcileCurrentImage()) {
            this._dropDragBase();
            this.invalidateStyleCaches();
        }
        if (!this.image) return;
        this.renderToken++;
        // 对比原图是一次性旁路:取用本帧挂载的 compare 标记后立即清空,避免污染后续正常帧
        if (this._comparePending) {
            this._comparePending = false;
            window.__render(this, true);
            this.updateStatusBar();
            return;
        }
        this.draggingCompare = false;
        {
            // 交互进行中(格内拖动/平移/拖元素/手势)不得用旧快照替换当前模板,否则会将正在编辑的
            // 拼图平移/缩放瞬时回退到保存前的状态
            // 不再用 customSettings 替换 this.template,保持编辑对象引用稳定
            this.normalizeTemplate();
            this.dom.stage.classList.toggle('has-img', !!this.image);
            // 拖动 / 旋转 / 拖角缩放中且背景缓存有效 → 只拷贝背景 + 重绘该元素,
            // 跳过整帧合成 (缓存键在校验尺寸/模板/图源,任一变即回落到正常整帧渲染)
            const xf = this._activeTransform();
            const aiKind = !!(xf && (xf.kind === 'aiLayer' || xf.isAi));
            // AI 前景层（photo 之后）也能走快通道：引擎首帧把该层摘掉，
            // 之后每帧 blit 背景 + 只重绘这一层。背景层/照片槽位不能这么干——
            // 它们盖在照片下面，补画到最上层会遮住照片，只能整帧合成。
            const aiFast = aiKind && this.aiLayerFastOk(xf.ref);
            const xfRef = xf && xf.ref && (!aiKind || aiFast) ? xf.ref : null;
            if (xfRef && this._dragBaseValid()) {
                this._blitDragBase();
                this._drawDraggedEl(this.dom.canvas.getContext('2d'), xfRef, xf.kind);
                this.drawSelectionBox();
                this.drawLogoGuides();
                if (this._textEditor) this._positionTextEditor();
                this.updateStatusBar();
                return;
            }
            // 未使用预设的图:画布直接展示原图;当前图只要有边框设置,就把最新模板写回该图记录
            // (既标记“已用预设”,也保证切走再切回时保留最新编辑)。
            // 悬停预览例外:那一帧的 template 是临时的,写回去就等于「划过一下 = 应用了」。
            const im = this.image;
            const previewing = !!this._presetHover;
            if (!previewing && this.hasBorderSettings(this.template)) this.setTpl(im, this.template);
            // 预览时即便这张图还没有模板记录,也要按 this.template 画，否则会被当成“未用预设”退回原图。
            const assigned = previewing || !!this.getTpl(im);
            const previewTpl = assigned ? this.template : this.defaultTemplate();
            const prevTpl = this.template;
            this.template = previewTpl;
            // 手势首帧:合成完整帧(此时该元素已被 _skipUserEl 排除)后缓存为背景,供后续帧复用
            const needDragBase = !!(xfRef && (!this._dragBase || !this._dragBaseValid()));
            // 蒙版「原图预览」：只在这一帧的整帧合成里生效(取源见 photoSrcOf)，
            // 帧结束立刻复位 —— 导出/缩略图/后续帧都不会被污染。
            const prevUseOrig = this._previewUseOriginal;
            this._previewUseOriginal = !!this._maskPreviewOriginal;
            // 首帧让引擎把被拖的 AI 图层摘掉，建出的背景缓存才不含它。
            this._skipAiLayer = aiFast ? xf.ref : null;
            try {
                const puzzle = previewTpl && previewTpl.puzzle && previewTpl.puzzle.enabled;
                const fire = () => {
                    if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false);
                    else window.__render(this, false);
                };
                fire();
                // 引擎在分辨率刚变化时首帧不稳定(实测同一路径连渲两次,首帧与次帧最大通道差可达 86),
                // 而缓存一旦建在这种帧上,整个手势过程都会沿用错误背景。再渲一次取其稳定结果。
                if (needDragBase) fire();
            } finally {
                this.template = prevTpl;
                this._previewUseOriginal = prevUseOrig;
            }
            if (needDragBase) this._dragBaseBuild();
            this._skipAiLayer = null;
            this.drawSelectionBox();
            this.drawLogoGuides();
            // 缩放/平移/窗口变化后，画布内文字编辑器要跟着画布走（它是 fixed 定位）
            if (this._textEditor) this._positionTextEditor();
            if (this.autoFit) {
                this.autoFit = false;
                requestAnimationFrame(() => this.fitZoom());
            }
            this.updateStatusBar();
        }
    },

    // 把任意来源(.qfs / 模板 JSON / 旧草稿)的对象收成引擎能安全消费的形状。
    // 旧实现只判断 truthy:layerList 是字符串时也能过 `!t.layerList.length`,
    // 下一行 .forEach 直接抛异常 → 导入坏工程即白屏。
    coerceTemplate(t) {
        const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
        if (!isObj(t)) t = this.defaultTemplate();
        for (const k of ['baseMargin', 'cornerConfig', 'filmTearConfig', 'lightEffect', 'decorConfig']) {
            if (!isObj(t[k])) t[k] = {};
        }
        // 晕影符号迁移：旧版「0..100，正值 = 压暗」，新版对齐 Camera Raw 改成
        // 「-100..100，负值压暗 / 正值提亮」。老模板没有 vignetteSignV2 标记，
        // 这里把「已启用且为正」的强度翻成负值，观感保持不变；写入标记后不再重复翻转。
        // 内置预设里有 6 个是 enable:1 + 正值（NOMO复古相机/双胶片条/暗夜星空/
        // 极光渐变/电影宽荧幕/金箔奢华），靠这段迁移继续压暗，不需要改 JSON。
        // 放在 coerceTemplate 而不是 normalizeTemplate：草稿恢复 / 打开 .qfs / 导入
        // 配置都会先走这里纠形，保证 refreshUI 读到的已经是迁移后的值。
        const le = t.lightEffect;
        if (!le.vignetteSignV2) {
            le.vignetteSignV2 = 2;
            const vs = Number(le.vignetteStrength) || 0;
            if (Number(le.vignetteEnable) === 1 && vs > 0) le.vignetteStrength = -vs;
        }
        if (t._draftText) delete t._draftText;
        if (!Array.isArray(t.layerList)) t.layerList = [];
        t.layerList = t.layerList.filter(isObj).slice(0, 200);
        if (!t.layerList.length) {
            const dl = this.defaultTemplate().layerList;
            t.layerList = [(dl && dl[0]) || {}];
        }
        for (const lay of t.layerList) {
            if (!isObj(lay.fillConfig)) lay.fillConfig = {};
            if (!Array.isArray(lay.fillConfig.gradientStops)) {
                lay.fillConfig.gradientStops = [{ position: 0, color: 'eeeeee' }, { position: 1, color: 'bbbbbb' }];
            }
            if (!isObj(lay.strokeConfig)) lay.strokeConfig = {};
            if (!isObj(lay.shadowGlowConfig)) lay.shadowGlowConfig = {};
        }
        if (!Array.isArray(t.logoElements)) t.logoElements = [];
        t.logoElements = t.logoElements.filter(isObj).slice(0, 500);
        if (!isObj(t.puzzle)) t.puzzle = this.defaultTemplate().puzzle;
        for (const k of ['slots', 'axisVals', 'captions', 'gapCaptions']) {
            if (!isObj(t.puzzle[k])) t.puzzle[k] = {};
        }
        return t;
    },

    normalizeTemplate() {
        const t = this.coerceTemplate(this.template);
        this.template = t;
        // 旧格式(rx 以基准画布为分母)在此一次性换算为显示画布分数,须在引擎绘制前完成
        this.migrateRelCanvasFrac();
        if (t.baseMargin.refTop == null) {
            t.baseMargin.refTop = t.baseMargin.marginTop != null ? t.baseMargin.marginTop : 80;
            t.baseMargin.refBottom = t.baseMargin.marginBottom != null ? t.baseMargin.marginBottom : 120;
            t.baseMargin.refLeft = t.baseMargin.marginLeft != null ? t.baseMargin.marginLeft : 80;
            t.baseMargin.refRight = t.baseMargin.marginRight != null ? t.baseMargin.marginRight : 80;
        }
        const stripHash = (v) => (v == null ? '' : String(v)).replace(/^#+/, '');
        (t.layerList || []).forEach(lay => {
            if (lay.visible !== undefined) lay.visible = (lay.visible === false || lay.visible === 0) ? 0 : 1;
            const f = lay.fillConfig || {}, s = lay.strokeConfig || {}, sg = lay.shadowGlowConfig || {};
            if (f.fillHex) f.fillHex = stripHash(f.fillHex);
            (f.gradientStops || []).forEach(g => { if (g && g.color) g.color = stripHash(g.color); });
            if (s.strokeColorHex) s.strokeColorHex = stripHash(s.strokeColorHex);
            (s.gradientStops || []).forEach(g => { if (g && g.color) g.color = stripHash(g.color); });
            if (sg.shadowColorHex) sg.shadowColorHex = stripHash(sg.shadowColorHex);
            if (sg.glowColorHex) sg.glowColorHex = stripHash(sg.glowColorHex);
        });
        if (typeof this.clampLogoElementSizes === 'function') this.clampLogoElementSizes(t);
    },

    requestRender() { this.scheduleRender(true); },

    setCompare(on) {
        if (!this.image) return;
        this.draggingCompare = on;
        const saved = this.getTpl(this.image);
        if (saved) this.template = saved;
        this.normalizeTemplate();
        // 走统一队列:与普通帧 FIFO,不再自排一条并行 rAF(那会让对比帧与
        // 已排队的正常帧争抢同一 vsync,谁先跑取决于注册顺序,表现为偶发闪回)
        this._comparePending = !!on;
        this.scheduleRender(true);
    },
});

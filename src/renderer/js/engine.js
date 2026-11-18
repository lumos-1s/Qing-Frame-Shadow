// 清框??Canvas 2D 渲染引擎 —????JavaFX BorderEngine 逐行移植
// 严格对齐原版:computeCanvasSize(含侧投影阴影预留空间)、图??阴影/辉光/渐变/纹理/描边)??// 照片投影(四面均匀/悬浮双层/默认小阴??、白色齿孔、全局光影(暗角/漏光)??// 装饰(四角括号/EXIF 底条)、卡片样??renderCardStyle 独立管线)??
// ── 工具 ──
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 照片取源：调色过就取烘焙好的离屏画布，否则取原图。
// 真正的实现在 app-grade.js（window.photoSrcOf），这里留兜底是因为 engine 先于它加载。
// 烘焙画布被刻意补了 naturalWidth/naturalHeight，所以下游所有按 im.el.naturalWidth
// 算比例的代码不用改也不会错。
function photoSrc(im) {
    if (!im) return null;
    if (window.photoSrcOf) return window.photoSrcOf(im);
    return im.el || null;
}

// AI 自由图层模板：新格式存 aiLayers，旧文档/面板读回用 layers；两者都认。
function aiLayersOf(template) {
    if (!template) return null;
    if (Array.isArray(template.aiLayers) && template.aiLayers.length) return template.aiLayers;
    if (Array.isArray(template.layers) && template.layers.length) return template.layers;
    return null;
}

// parseColor：hex + opacity(0-100) → {r,g,b,a}，与原版 parseColor 一致(空透明度按 100 处理)
// 记忆化:一帧里它会被调上百次(每个图层/描边/阴影/文字各一次),而输入组合很有限。
// 返回对象只被读取(调用方一律是 rgba(c) 或读字段,没有任何地方写它),复用安全。
const PARSE_COLOR_CACHE = new Map();
const PARSE_COLOR_MAX = 4096;
function parseColor(hex, opacity) {
    const key = hex + '\u0000' + (opacity == null ? 100 : opacity);
    const hit = PARSE_COLOR_CACHE.get(key);
    if (hit !== undefined) return hit;
    const v = parseColorUncached(hex, opacity);
    if (PARSE_COLOR_CACHE.size >= PARSE_COLOR_MAX) PARSE_COLOR_CACHE.clear();
    PARSE_COLOR_CACHE.set(key, v);
    return v;
}
function parseColorUncached(hex, opacity) {
    try {
        hex = String(hex || '#000000').replace('#', '');
        if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        if (hex.length === 6) hex = 'FF' + hex;
        const argb = parseInt(hex, 16);
        const a = (argb >> 24) & 0xFF;
        const r = (argb >> 16) & 0xFF;
        const g = (argb >> 8) & 0xFF;
        const b = argb & 0xFF;
        const alpha = (a / 255) * ((opacity == null ? 100 : opacity) / 100);
        return { r, g, b, a: clamp(alpha, 0, 1) };
    } catch (e) {
        return { r: 0, g: 0, b: 0, a: 1 };
    }
}
function rgba(c) { return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${c.a})`; }

// baseMargin 总边??对应原版 getTotalLeft/Right/Top/Bottom)
function totals(m) {
    return { left: m.marginLeft || 0, right: m.marginRight || 0, top: m.marginTop || 0, bottom: m.marginBottom || 0 };
}

// 侧投影模式的阴影预留空间:容纳环境阴影层的模糊半径 + 最大偏移量(原版 getShadowSpace)
function getShadowSpace(template) {
    if (!template) return 0;
    for (const layer of (template.layerList || [])) {
        const sg = layer.shadowGlowConfig;
        if (sg && sg.sideShadow === 1) {
            const radius = Math.max(4, (sg.shadowBlur || 0) * 1.5);
            const off = Math.max(0, Math.max(sg.shadowOffsetX || 0, sg.shadowOffsetY || 0)) * 2.4;
            return Math.max(24, radius * 2 + off);
        }
    }
    return 0;
}

function parseRatio(ratio) {
    try {
        const parts = String(ratio).split(':');
        return [parseFloat(parts[0]), parseFloat(parts[1])];
    } catch (e) { return null; }
}

// 默认画布比例:模板/用户显式声明了比例(非 original)则尊重显式值;
// 未声明时一律按原图比例出图(不再按图片方向强套竖 3:4 / 横 4:3)。
function effectiveCanvasRatio(template) {
    const r = template && template.canvasRatio;
    if (r && r !== 'original' && r !== 'auto') return r;
    return 'original';
}

// 计算渲染画布尺寸(含画布比例调??+ 侧投影预留空??，与原版 computeCanvasSize 一??
function computeCanvasSize(imgW, imgH, template) {
    const margin = template.baseMargin || {};
    const t = totals(margin);
    let canvasW = imgW + t.left + t.right;
    let canvasH = imgH + t.top + t.bottom;
    const shadowSpace = getShadowSpace(template);
    if (shadowSpace > 0) { canvasW += shadowSpace * 2; canvasH += shadowSpace * 2; }
    const ratio = effectiveCanvasRatio(template);
    if (ratio && ratio !== 'original') {
        const wh = parseRatio(ratio);
        if (wh) {
            // 只扩大、不裁剪:向目标比??补齐"，照片保持完??
        const targetRatio = wh[0] / wh[1];
            const currentRatio = canvasW / canvasH;
            if (currentRatio > targetRatio) canvasH = canvasW / targetRatio;
            else canvasW = canvasH * targetRatio;
        }
    }
    return [canvasW, canvasH];
}

// ── 渲染主入??对应原版 renderToCanvas 的三路分??──
function renderToCanvas(app, compare) {
    const canvas = app.dom.canvas;
    const prevW = canvas.width, prevH = canvas.height;
    // _canvasBaseW/H 是「未经 displayMax/DPR 缩放」的画布内容基尺寸(setupCanvas 写入)。
    // 后备像素(canvas.width)会随 displayMax/DPR/exportScale 变化,而基尺寸不会。
    const prevBW = app._canvasBaseW || 0, prevBH = app._canvasBaseH || 0;
    _renderToCanvasInner(app, compare);
    // 画布后备尺寸变化后自动重新适配显示(缩略图条上方留白),避免旧缩放下画布溢出盖住缩略图条
    const curW = canvas.width, curH = canvas.height;
    const curBW = app._canvasBaseW || 0, curBH = app._canvasBaseH || 0;
    const styleNow = String((app.template && app.template.photoFrameStyle) || '').toUpperCase();
    const stylePrev = app._fitStyleName;
    app._fitStyleName = styleNow;
    const forceFit = !!app._forceFitNext;
    app._forceFitNext = false;
    // 苹果信息卡的信息条高度是内容驱动的(字号/开关一变,画布就变高或变矮)。这种「只变高、不变宽」
    // 的参数调整不该重新 fitZoom —— 否则每调一次参数,整张照片就被缩放一次,看起来像"图片缩小"。
    // 换图/换模板时会置 _forceFitNext,或风格名变化/基宽变化,仍照常重新适配。
    const appleHeightOnly = !forceFit && styleNow === 'CARD_APPLE' && styleNow === stylePrev
        && curBW === prevBW && curBH !== prevBH;
    // 仅当「后备尺寸」与「内容基尺寸」同时变化才重新适配:基尺寸变化 = 真实内容变化
    // (换图/裁切/旋转/换模板),必然需要重新 fit;而手势期 displayMax 临时降到 900 再复原、
    // 或导出 exportScale/DPR 变化只改后备分辨率,基尺寸不变,不应触发 fitZoom —— 否则拖调色滑块时
    // 画布后备尺寸一变就 fitZoom,把用户当前的平移/缩放回退成「适应窗口」,照片即发生位置/大小突变(跳跃)。
    if (prevW > 0 && prevH > 0 && (curW !== prevW || curH !== prevH)
        && (curBW !== prevBW || curBH !== prevBH) && !appleHeightOnly) {
        // 正在操作元素(logo/sticker)或正在手势(拖调色滑块)时不自动 fitZoom,保持用户当前缩放级别
        const hasSel = app.selectedEls && app.selectedEls.length;
        if (!hasSel && !app._gesture && typeof app.fitZoom === 'function') requestAnimationFrame(() => app.fitZoom());
    }
}
function _renderToCanvasInner(app, compare) {
    const { image, template } = app;
    // 每次渲染先清空:只有默认模板管线能算出照片矩形,卡片/相框管线保持 null(蒙版编辑层会提示切换)
    app._photoRect = null;
    // 对比原图必须取**未调色**的工作底图(含裁切/旋转)。photoSrc 会优先返回调色烘焙画布，
    // 直接用它会让“对比原图”显示成调色后的照片(只是去掉边框)，完全失去对比意义。
    const img = compare ? (image.el || photoSrc(image)) : photoSrc(image);
    const cw0 = img.naturalWidth, ch0 = img.naturalHeight;

    // 对比原图:只画照片本身,无边框
    if (compare) {
        const canvas = app.dom.canvas;
        canvas.width = cw0; canvas.height = ch0;
        // 逻辑尺寸必须和「带边框时的显示比例」一致：
        // app._canvasScale 是上一次 setupCanvas 记下的 uiScale（基准坐标→逻辑像素），
        // 照片在边框态里就是按这个比例缩到屏幕上的。对比态沿用同一个比例，
        // 照片的屏幕尺寸就和边框里一模一样，只是边框消失。
        const uiBase = (typeof app._canvasScale === 'number' && app._canvasScale > 0)
            ? app._canvasScale
            : Math.min(1, ((app.displayMax || 1800) / Math.max(1, cw0, ch0)));
        canvas._logW = Math.max(1, Math.round(cw0 * uiBase));
        canvas._logH = Math.max(1, Math.round(ch0 * uiBase));
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, cw0, ch0);
        ctx.drawImage(img, 0, 0, cw0, ch0);
        // 这里**绝不能**调 fitZoom：它会按「原图尺寸」重算 zoom 并写进 this.zoom，
        // 松手回到边框态后，画布按这个 zoom 显示小得多的逻辑宽度（1800×0.13≈240px），
        // 用户看到的就是「对比一下，加过边框的图变小了」。只重新套用当前 zoom 即可。
        if (typeof app.applyZoomStyle === 'function') app.applyZoomStyle();
        return;
    }

    // 0) AI 自由图层模板：layers 里的 photo 槽位决定照片位置，背景/前景由顺序决定
    if (aiLayersOf(template) && window.AiLayers) {
        renderAiLayerStyle(app);
        return;
    }

    // 1) photoFrameStyle 相框样式(BorderProcessor 移植,engine-styles.js)
    const pfStyle = template.photoFrameStyle;
    if (pfStyle && pfStyle !== 'NONE') {
        if (window.EngineStyles && window.EngineStyles.renderPhotoFrame) {
            window.EngineStyles.renderPhotoFrame(app);
        } else {
            renderPlaceholder(app, '#ffffff');
        }
        return;
    }

    // 2) 卡片样式(bgBlurEnable==1 ??renderCardStyle 独立管线)
    const margin = template.baseMargin || {};
    if ((margin.bgBlurEnable || 0) === 1) { renderCardStyle(app); return; }

    // 3) 默认:模板图层样式
    renderTemplateStyle(app);
}

function setupCanvas(app, canvasW, canvasH) {
    const canvas = app.dom.canvas;
    const displayMax = (typeof app.displayMax === 'number' && app.displayMax > 0) ? app.displayMax : 1800;
    // 高分屏(Windows 缩放等 DPR>1)下把后备缓冲区按 devicePixelRatio 放大,避免文字/照片被浏览器放大而发虚
    // 导出通道(app.uiDprOverride=1)则按逻辑像素渲染,保证导出尺寸与选项/“原图尺寸”一致
    const dpr = (typeof app.uiDprOverride === 'number' && app.uiDprOverride > 0)
        ? app.uiDprOverride
        : ((typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const ui = Math.min(1, displayMax / Math.max(canvasW, canvasH));
    // 导出大尺寸选项(app.exportScale):把画布长边放大到目标值,小图也能上采样到所选尺寸;
    // 普通预览/“原图尺寸”仍按 displayMax 封顶(ui≤1),不放大
    const uiScale = (typeof app.exportScale === 'number' && app.exportScale > 0)
        ? app.exportScale / Math.max(canvasW, canvasH)
        : ui;
    // 显示比例 ≠ 渲染比例：手势期 beginGesture 会把 displayMax 压到 900 做低清预览，
    // 但降清只该减少画布像素，绝不能改变画面在屏幕上的尺寸。否则拖暗角/漏光/颗粒这类
    // 走 bindRanges→beginGesture 的滑块时，_logW 跟着 displayMax 一起变小，
    // applyZoomStyle 按它算 CSS 宽度 → 照片缩一圈，松手再弹回（照片"变小"）。
    // 相框/卡片风格管线早已按「手势前的 displayMax」算显示比例（见 engine-styles 的
    // displayScale），这里补上同一条规则，让默认模板/卡片/拼图管线也一致。
    const sizeMax = (app._gesture && app._gesturePrevMax != null) ? app._gesturePrevMax : displayMax;
    const displayScale = (typeof app.exportScale === 'number' && app.exportScale > 0)
        ? uiScale
        : Math.min(1, sizeMax / Math.max(canvasW, canvasH));
    const scale = uiScale * dpr;
    canvas.width = Math.max(1, Math.round(canvasW * scale));
    canvas.height = Math.max(1, Math.round(canvasH * scale));
    // 逻辑显示尺寸(CSS 像素),供 applyZoomStyle 使用(与后备缓冲解耦,不会因 DPR 放得更大)
    canvas._logW = Math.max(1, Math.round(canvasW * displayScale));
    canvas._logH = Math.max(1, Math.round(canvasH * displayScale));
    // 基准坐标(模板/照片矩形都是这套单位) → 逻辑显示坐标的比例。
    // 大图会被 uiScale 缩到 displayMax,叠加层/指针换算必须乘它,否则蒙版范围会错位成一个小矩形。
    app._canvasScale = uiScale;
    // 基准坐标尺寸（模板/照片矩形都用这套单位）:叠加层靠它把基准坐标换算成像素。
    app._canvasBaseW = canvasW;
    app._canvasBaseH = canvasH;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(scale, scale);
    return ctx;
}

// ── 模板图层样式(对应原版 renderToCanvas 非卡片体)──
// 整体卡片圆角:跟随“边框圆角(最外层边框图层 cornerConfig)”,未配置时回退到合成短边的 5%。
// 供 renderTemplateStyle(镂空四角)与 beginCardClip(元素叠层剪辑)共用,保证两者一致。
function computeCardRadii(template, cw, ch) {
    const ccCard = template.cornerConfig || {};
    const outerRound = ccCard.outerRound === 1;
    const maxCardR = Math.floor(Math.min(cw, ch) / 2);
    // 最外层可见边框图层(= 绘制时最后画在最上层、整体形状可见的那层):其 cornerConfig 即“边框圆角”
    let borderLayer = null;
    for (let i = 0; i < (template.layerList || []).length; i++) {
        const l = (template.layerList || [])[i];
        if (l && l.visible !== false) { borderLayer = l; break; }
    }
    const blConf = borderLayer && borderLayer.cornerConfig;
    const hasBorderRadii = !!(blConf && (blConf.cornerRadiusAll != null || blConf.cornerRadiusTL != null || blConf.cornerRadiusTR != null || blConf.cornerRadiusBL != null || blConf.cornerRadiusBR != null));
    const blAll = blConf ? clamp(blConf.cornerRadiusAll || 0, 0, maxCardR) : 0;
    const blOne = (k) => (blConf && (blConf[k] || 0) > 0) ? clamp(blConf[k], 0, maxCardR) : blAll;
    const fallbackR = Math.round(Math.min(cw, ch) * 0.05);
    const card = hasBorderRadii
        ? { tl: blOne('cornerRadiusTL'), tr: blOne('cornerRadiusTR'), bl: blOne('cornerRadiusBL'), br: blOne('cornerRadiusBR') }
        : { tl: fallbackR, tr: fallbackR, bl: fallbackR, br: fallbackR };
    return { outerRound, tl: card.tl, tr: card.tr, bl: card.bl, br: card.br };
}

// 若卡片为圆角(outerRound),将元素叠层(Logo/贴纸/自由文字/装饰)剪辑到卡片轮廓内,
// 保证 Logo 只出现在“加边框后的图片之中”,不会透出圆角镂空区。返回是否已 clip(需要 restore)。
function beginCardClip(ctx, template, cw, ch) {
    const c = computeCardRadii(template, cw, ch);
    if (!c.outerRound) return false;
    ctx.save();
    buildRoundedPath(ctx, 0, 0, cw, ch, c.tl, c.tr, c.bl, c.br);
    ctx.clip();
    return true;
}

function renderTemplateStyle(app) {
    const { image, template } = app;
    const img = photoSrc(image);
    const margin = template.baseMargin || {};
    const cs = computeCanvasSize(img.naturalWidth, img.naturalHeight, template);
    const canvasW = cs[0], canvasH = cs[1];
    const ctx = setupCanvas(app, canvasW, canvasH);

    // 圆角卡片(outerRound):整体图片的圆角跟随“边框圆角”设置,四角真镂空,形成圆角卡片外观。
    // 不整体 clip:裁剪态下 Chromium 对照片 drawImage 走慢路径,周期纹理在特定缩放比会出现摩尔纹横线;
    // 改为整图绘制完毕后用 destination-out 镂空四角(外观与导出一致且无混叠线)。元素叠层另行剪辑。
    const card = computeCardRadii(template, canvasW, canvasH);
    const outerRound = card.outerRound;

    // 白底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // 图层(倒序:最底层先画)
    const layers = template.layerList || [];
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (layer.visible === false) continue;
        drawLayerShadowGlow(ctx, layer, canvasW, canvasH, margin);
        drawSingleLayer(ctx, layer, canvasW, canvasH, margin);
    }

    // 照片
    // 记录照片在画布里的矩形(逻辑坐标),蒙版叠加层靠它把指针位置换算成照片坐标
    app._photoRect = drawOriginImage(ctx, img, margin, canvasW, canvasH, template) || null;

    // 形状遮罩:仅胶片齿??白色;原版无锯齿撕裂、无暗色圆点)
    applyShapeMask(ctx, template.filmTearConfig, canvasW, canvasH, margin);

    // 全局光影
    applyGlobalLight(ctx, template.lightEffect, canvasW, canvasH);

    // 圆角卡片(outerRound):整图完成后按边框圆角镂空四角,形成整体圆角卡片;照片圆角另在临时画布处理,不受此影响
    if (outerRound) {
        punchRoundedCorners(ctx, 0, 0, canvasW, canvasH, card.tl, card.tr, card.bl, card.br);
    }

    ctx.restore();

    // 元素叠层(基准画布像素坐标):文字/贴纸/四角括号/EXIF 参数 + Logo
    const cw = app.dom.canvas.width, ch = app.dom.canvas.height;
    const scl = canvasW > 0 ? cw / canvasW : 1;
    // 文字/贴纸层的坐标口径是「显示逻辑尺寸」_logW(=_logH)，不是基准 canvasW：
    // 大图会被 uiScale 缩到 displayMax，此时 cw/canvasW = uiScale*dpr，而元素坐标
    // 只按 dpr 放大。用错这一层，文字会偏到左上、并且比选中框小一圈（用户实测症状）。
    const textScl = (app.dom.canvas._logW > 1) ? cw / app.dom.canvas._logW : 1;
    const pm = image.el ? (template.baseMargin || {}) : {};
    const pih = (image.el ? image.el.naturalHeight : 0) * (pm.imgScale || 1);
    const pusableH = canvasH - (pm.marginTop || 0) - (pm.marginBottom || 0);
    const stripTop = image.el ? ((pm.marginTop || 0) + (pusableH - pih) / 2 + (pm.imgOffsetY || 0) + pih) * scl : ch;
    // Logo/贴纸/文字/装饰仅允许出现在“加边框后的成品图片”范围内:圆角卡片时剪辑到卡片轮廓
    const cardClip = beginCardClip(ctx, template, cw, ch);
    drawDecoration(ctx, template.decorConfig || {}, cw, ch, image, template, stripTop, textScl);
    drawDraftText(ctx, template, cw, ch, textScl);
    drawLogoElements(ctx, template.logoElements || [], cw, ch);
    if (cardClip) ctx.restore();

    app.applyZoomStyle();
}

// 图层圆角:cornerConfig 供边框(图层/描边)独立于照片圆角自由调整
// ── AI 自由图层样式 ──
// layers 的顺序就是 z 序：photo 之前是背景，photo 之后是前景。
// 画布尺寸按 photo 槽位比例与照片比例计算，照片 cover/contain 进槽位，不拉伸。
function renderAiLayerStyle(app) {
    const { image, template } = app;
    const img = photoSrc(image);
    const layers = aiLayersOf(template) || [];
    if (!img || !layers.length || !window.AiLayers) {
        renderPlaceholder(app, '#ffffff');
        return;
    }
    const nw = img.naturalWidth || img.width || 0;
    const nh = img.naturalHeight || img.height || 0;
    if (!nw || !nh) { renderPlaceholder(app, '#ffffff'); return; }

    const size = window.AiLayers.computeFrameSize(nw, nh, layers, { maxBase: 6000 });
    const canvasW = size.W, canvasH = size.H;
    const slot = size.slot;
    const ctx = setupCanvas(app, canvasW, canvasH);

    // 白底/自定义底：AI 的背景层可以完整覆盖它
    ctx.fillStyle = typeof template.aiBackground === 'string' ? template.aiBackground : '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    const pi = size.photoIndex >= 0 ? size.photoIndex : window.AiLayers.fallbackPhotoIndex(layers);
    window.AiLayers.render(ctx, layers.slice(0, pi), canvasW, canvasH, () => {});

    // 照片槽位（这是唯一绘制照片的地方）
    window.AiLayers.drawPhoto(ctx, img, canvasW, canvasH, slot);
    app._photoRect = {
        x: slot.x * canvasW, y: slot.y * canvasH,
        w: slot.w * canvasW, h: slot.h * canvasH
    };

    window.AiLayers.render(ctx, layers.slice(pi + 1), canvasW, canvasH, () => {});

    // 全局光影（模板可选；AI 模板默认没有）
    applyGlobalLight(ctx, template.lightEffect, canvasW, canvasH);

    // 整体圆角卡片（模板可选）
    const card = computeCardRadii(template, canvasW, canvasH);
    if (card.outerRound) {
        punchRoundedCorners(ctx, 0, 0, canvasW, canvasH, card.tl, card.tr, card.bl, card.br);
    }

    // 基准坐标 → 后备像素
    ctx.restore();

    // 元素叠层：用户自己的文字/贴纸/Logo 仍然画在 AI 边框之上，保持可编辑
    const cw = app.dom.canvas.width, ch = app.dom.canvas.height;
    const scl = canvasW > 0 ? cw / canvasW : 1;
    const textScl = (app.dom.canvas._logW > 1) ? cw / app.dom.canvas._logW : 1;
    const stripTop = (slot.y + slot.h) * canvasH * scl;
    const cardClip = beginCardClip(ctx, template, cw, ch);
    drawDecoration(ctx, template.decorConfig || {}, cw, ch, image, template, stripTop, textScl);
    drawDraftText(ctx, template, cw, ch, textScl);
    drawLogoElements(ctx, template.logoElements || [], cw, ch);
    if (cardClip) ctx.restore();

    app.applyZoomStyle();
}

function layerCornerRadii(layer, w, h) {
    const lcc = (layer && layer.cornerConfig) || {};
    const maxR = Math.min(w, h) / 2;
    const all = clamp(lcc.cornerRadiusAll || 0, 0, maxR);
    const one = (v) => (v || 0) > 0 ? Math.min(v, maxR) : all;
    return { tl: one(lcc.cornerRadiusTL), tr: one(lcc.cornerRadiusTR), bl: one(lcc.cornerRadiusBL), br: one(lcc.cornerRadiusBR) };
}

// 以圆角路径(如果有)裁剪后填充矩形;无圆角时与 fillRect 完全一致
function fillLayerRect(ctx, x, y, w, h, corners) {
    const r = corners && (corners.tl || corners.tr || corners.bl || corners.br);
    if (r) {
        ctx.save();
        buildRoundedPath(ctx, x, y, w, h, corners.tl, corners.tr, corners.bl, corners.br);
        ctx.clip();
        ctx.fillRect(x, y, w, h);
        ctx.restore();
    } else {
        ctx.fillRect(x, y, w, h);
    }
}

function drawSingleLayer(ctx, layer, cw, ch, margin) {
    const bx = (margin.marginLeft || 0) + (layer.marginLeft || 0);
    const by = (margin.marginTop || 0) + (layer.marginTop || 0);
    const bw = cw - (margin.marginLeft || 0) - (margin.marginRight || 0) - (layer.marginLeft || 0) - (layer.marginRight || 0);
    const bh = ch - (margin.marginTop || 0) - (margin.marginBottom || 0) - (layer.marginTop || 0) - (layer.marginBottom || 0);
    if (bw <= 0 || bh <= 0) return;

    const corners = layerCornerRadii(layer, bw, bh);
    const fill = layer.fillConfig || {};
    applyFill(ctx, fill, bx, by, bw, bh);
    fillLayerRect(ctx, bx, by, bw, bh, corners);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    const stroke = layer.strokeConfig || {};
    if ((stroke.strokeWidth || 0) > 0) {
        applyStroke(ctx, stroke, bx, by, bw, bh, corners);
    }
}

function drawLayerShadowGlow(ctx, layer, cw, ch, margin) {
    const sg = layer.shadowGlowConfig || {};
    if (sg.shadowEnable !== 1 && sg.glowEnable !== 1) return;

    const lx = (margin.marginLeft || 0) + (layer.marginLeft || 0);
    const ly = (margin.marginTop || 0) + (layer.marginTop || 0);
    const lw = cw - (margin.marginLeft || 0) - (margin.marginRight || 0) - (layer.marginLeft || 0) - (layer.marginRight || 0);
    const lh = ch - (margin.marginTop || 0) - (margin.marginBottom || 0) - (layer.marginTop || 0) - (layer.marginBottom || 0);

    const corners = layerCornerRadii(layer, lw, lh);

    // 阴影
    if (sg.shadowEnable === 1) {
        ctx.save();
        ctx.shadowColor = rgba(parseColor(sg.shadowColorHex, sg.shadowOpacity));
        ctx.shadowBlur = sg.shadowBlur || 0;
        ctx.shadowOffsetX = sg.shadowOffsetX || 0;
        ctx.shadowOffsetY = sg.shadowOffsetY || 0;
        // Canvas ??spread,用略大的填充近似(与原版注释一??
        applyFill(ctx, layer.fillConfig || {}, lx, ly, lw, lh);
        fillLayerRect(ctx, lx, ly, lw, lh, corners);
        ctx.restore();
    }

    // 辉光:以辉光色本身为填充源
    if (sg.glowEnable === 1) {
        const glowColor = parseColor(sg.glowColorHex, sg.glowOpacity);
        ctx.save();
        ctx.shadowColor = rgba(glowColor);
        ctx.shadowBlur = sg.glowBlur || 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = rgba(glowColor);
        fillLayerRect(ctx, lx, ly, lw, lh, corners);
        ctx.restore();
    }
}

function applyFill(ctx, fill, x, y, w, h) {
    const type = fill.fillType || 'solid';
    if (type === 'gradient') { applyGradient(ctx, fill, x, y, w, h); return; }
    if (type === 'transparent') { ctx.fillStyle = 'rgba(0,0,0,0)'; return; }
    if (type === 'texture' && fill.textureSrc && setTextureFill(ctx, fill, x, y, w, h)) return;
    ctx.fillStyle = rgba(parseColor(fill.fillHex, fill.fillOpacity));
}

function applyGradient(ctx, fill, x, y, w, h) {
    const stops = (fill.gradientStops || []).map(s => ({
        pos: s.position || 0,
        c: parseColor(s.color, fill.gradientOpacity),
    }));
    if (!stops.length) { ctx.fillStyle = '#ffffff'; return; }
    const angle = (fill.gradientAngle || 0) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const cx = x + w / 2, cy = y + h / 2;
    const dx = Math.abs(w * cos / 2) + Math.abs(h * sin / 2);
    const dy = Math.abs(w * sin / 2) + Math.abs(h * cos / 2);
    let grad;
    if (fill.gradientType === 'radial') {
        grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(dx, dy));
    } else {
        const x0 = cx - dx, y0 = cy - dy, x1 = cx + dx, y1 = cy + dy;
        grad = ctx.createLinearGradient(x0, y0, x1, y1);
    }
    for (const s of stops) grad.addColorStop(clamp(s.pos, 0, 1), rgba(s.c));
    ctx.fillStyle = grad;
}

const TEXTURE_CACHE = {};
function getTexture(name) {
    if (!name) return null;
    if (TEXTURE_CACHE[name] && TEXTURE_CACHE[name].complete && TEXTURE_CACHE[name].naturalWidth > 0) return TEXTURE_CACHE[name];
    if (TEXTURE_CACHE[name]) return null;
    const app = (typeof window !== 'undefined' && window.App) ? window.App : null;
    const t = app && app.textures ? app.textures.find(x => x.name === name) : null;
    if (!t) return null;
    const im = window.qfsImage();
    im.onload = () => { if (window.App) window.App.requestRender(); };
    im.src = t.dataUrl;
    TEXTURE_CACHE[name] = im;
    return null;
}

// 元素位图:纹理名或 dataUrl 均可(贴纸 dataUrl / Logo 图标 / 内置纹理走同一缓存)
/* exported getElementBitmap */ function getElementBitmap(src) {
    if (!src) return null;
    if (TEXTURE_CACHE[src] && TEXTURE_CACHE[src].complete && TEXTURE_CACHE[src].naturalWidth > 0) return TEXTURE_CACHE[src];
    // 复用 App 已经加载好的 Logo 位图:addLogoElement 把图标预加载进 logoImgCache 后再入列,
    // 但引擎原本只会从自己的 TEXTURE_CACHE 读 —— 两者是不同 Image 对象,导致引擎首帧看不到图、
    // 要等 TEXTURE_CACHE 那张自己加载完再 onload→requestRender 补一帧。这一帧若被合并/丢弃,
    // 就会出现「拖上去了但 logo 不显示,得再动一下鼠标才出来」的间歇现象。
    // 这里优先用已就绪的 logoImgCache 图,首帧即绘制,彻底去掉这层时序依赖。
    const app = (typeof window !== 'undefined' && window.App) ? window.App : null;
    if (app && app.logoImgCache && app.logoImgCache[src]
        && app.logoImgCache[src].complete && app.logoImgCache[src].naturalWidth > 0) {
        TEXTURE_CACHE[src] = app.logoImgCache[src];
        return TEXTURE_CACHE[src];
    }
    if (TEXTURE_CACHE[src]) return null; // 加载中
    let url = src;
    const tex = app && app.textures ? app.textures.find(x => x.name === src) : null;
    if (tex && tex.dataUrl) url = tex.dataUrl;
    const im = window.qfsImage();
    im.onload = () => { if (app) app.requestRender(); };
    im.onerror = () => { TEXTURE_CACHE[src] = null; };
    im.src = url;
    TEXTURE_CACHE[src] = im;
    return null;
}
function mapBlend(blend) {
    if (blend === 'multiply') return 'multiply';
    if (blend === 'screen') return 'screen';
    if (blend === 'overlay') return 'overlay';
    return null;
}
// 设置纹理填充画刷到当前 ctx.fillStyle(含缩放/偏移/混合/透明度),返回 true 表示成功。
// 注意:不在这里 drawImage/fillRect,而是交由 fillLayerRect 做圆角裁剪后再 fill,
// 这样纹理既能被圆角裁剪,也不会被随后 callLayerRect 的旧 fillStyle 覆盖。
function setTextureFill(ctx, fill, x, y) {
    const name = fill.textureSrc;
    const tex = TEXTURE_CACHE[name];
    if (!tex || !tex.complete || !tex.naturalWidth) {
        getTexture(name);
        return false;
    }
    try {
        const scale = fill.textureScale || 1;
        const pattern = ctx.createPattern(tex, 'repeat');
        if (!pattern) return false;
        pattern.setTransform(new DOMMatrix()
            .translate(x + (fill.textureOffsetX || 0), y + (fill.textureOffsetY || 0))
            .scale(scale));
        const blend = mapBlend(fill.textureBlend);
        if (blend) ctx.globalCompositeOperation = blend;
        ctx.globalAlpha = clamp((fill.textureOpacity == null ? 100 : fill.textureOpacity) / 100, 0, 1);
        ctx.fillStyle = pattern;
        return true;
    } catch (e) {
        return false;
    }
}

function applyStroke(ctx, stroke, x, y, w, h, corners) {
    const sw = stroke.strokeWidth || 0;
    const pos = stroke.strokePos || 'inside';
    const inset = pos === 'inside' ? 0 : pos === 'center' ? sw / 2 : sw;
    ctx.strokeStyle = rgba(parseColor(stroke.strokeColorHex, stroke.strokeOpacity));
    ctx.lineWidth = sw;
    if (stroke.strokeDashArray && stroke.strokeDashArray.length) {
        ctx.setLineDash(stroke.strokeDashArray);
        ctx.lineDashOffset = stroke.strokeDashOffset || 0;
    }
    const r = corners && (corners.tl || corners.tr || corners.bl || corners.br);
    if (r) {
        const d = 2 * inset;
        buildRoundedPath(ctx, x + inset, y + inset, w - d, h - d,
            Math.max(0, corners.tl - inset), Math.max(0, corners.tr - inset),
            Math.max(0, corners.bl - inset), Math.max(0, corners.br - inset));
        ctx.stroke();
    } else {
        ctx.strokeRect(x + inset, y + inset, w - 2 * inset, h - 2 * inset);
    }
    ctx.setLineDash([]);
}

// 构建圆角矩形路径(与原??buildRoundedPath 一??
function buildRoundedPath(ctx, x, y, w, h, tl, tr, bl, br) {
    ctx.beginPath();
    appendRoundedPath(ctx, x, y, w, h, tl, tr, bl, br);
}

// 不重置当前路径地追加一条圆角矩形子路径(供 evenodd 双路径镂空等复用)
function appendRoundedPath(ctx, x, y, w, h, tl, tr, bl, br) {
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
}

// 用 destination-out 镂空矩形四角外的圆角外侧区域(等效"圆角裁剪"),且不影响已画内容的其他区域。
// 与 clip 的差别:照片 drawImage 全程不处于裁剪态,规避 Chromium 裁剪态缩放照片的高频纹理混叠横线。
function punchRoundedCorners(ctx, x, y, w, h, tl, tr, bl, br) {
    if (!tl && !tr && !bl && !br) return;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    appendRoundedPath(ctx, x, y, w, h, tl || 0, tr || 0, bl || 0, br || 0);
    ctx.fill('evenodd');
    ctx.restore();
}

// 在无 clip 的离屏画布上画照片并镂空四角，再按设备像素 1:1 贴回主画布。
// 这样圆角边缘由照片自身的不透明像素决定，不会透出背景模糊卡片 Step 1 的白色衬底。
function drawPhotoWithCorners(ctx, img, x, y, w, h, tl, tr, bl, br) {
    const sc = Math.abs(ctx.getTransform().a) || 1;
    const tmpW = Math.max(1, Math.round(w * sc));
    const tmpH = Math.max(1, Math.round(h * sc));
    const tmp = document.createElement('canvas');
    tmp.width = tmpW; tmp.height = tmpH;
    const tg = tmp.getContext('2d');
    tg.setTransform(sc, 0, 0, sc, 0, 0);
    tg.drawImage(img, 0, 0, w, h);
    punchRoundedCorners(tg, 0, 0, w, h, tl, tr, bl, br);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(tmp, Math.round(x * sc), Math.round(y * sc), tmpW, tmpH);
    ctx.restore();
}

// 照片绘制(投影 + 圆角裁剪),与原??drawOriginImage 一??
function drawOriginImage(ctx, img, margin, cw, ch, template) {
    // 照片同步画幅:画布比例非「原始」且开启同步时,照片按画布(内容区)比例 cover 填满,
    // 超出部分在绘制时被内容区裁掉 —— 照片显示比例与边框/画布比例一致,不留空白。
    // 关闭(默认)保持原行为:照片完整,画布向目标比例补齐(可能留白)。
    const ratio = template.canvasRatio;
    const syncOn = template.canvasSync === 1 && ratio && ratio !== 'original';
    let iw = img.naturalWidth * (margin.imgScale || 1);
    let ih = img.naturalHeight * (margin.imgScale || 1);
    const usableW = cw - (margin.marginLeft || 0) - (margin.marginRight || 0);
    const usableH = ch - (margin.marginTop || 0) - (margin.marginBottom || 0);
    if (syncOn) {
        // cover:放大到覆盖整个内容区(比例与画布一致),居中后多出的部分在照片本体绘制时裁掉
        const nw = Math.max(1, img.naturalWidth), nh = Math.max(1, img.naturalHeight);
        const k = Math.max(usableW / nw, usableH / nh) * (margin.imgScale || 1);
        iw = nw * k;
        ih = nh * k;
    }
    const ox = (margin.marginLeft || 0) + (usableW - iw) / 2 + (margin.imgOffsetX || 0);
    const oy = (margin.marginTop || 0) + (usableH - ih) / 2 + (margin.imgOffsetY || 0);
    const rect = { x: ox, y: oy, w: iw, h: ih };
    const corner = template.cornerConfig || {};
    let rTL = corner.cornerRadiusTL || 0, rTR = corner.cornerRadiusTR || 0;
    let rBL = corner.cornerRadiusBL || 0, rBR = corner.cornerRadiusBR || 0;
    // 照片圆角只由右侧栏 cornerRadius 控制;outerRound 仅作用于边框/卡片外角,不强改照片
    const hasCorner = rTL > 0 || rTR > 0 || rBL > 0 || rBR > 0;

    // 照片后的投影:优先使用图层中启用的阴影参数
    let photoShadow = null;
    for (const layer of (template.layerList || [])) {
        const sg = layer.shadowGlowConfig;
        if (sg && sg.shadowEnable === 1) { photoShadow = sg; break; }
    }

    if (photoShadow) {
        if (photoShadow.sideShadow !== 1) {
            // 四边均匀投影:投影从照片四周均匀扩散(偏移恒为 0)
            ctx.save();
            ctx.shadowColor = rgba(parseColor(photoShadow.shadowColorHex, photoShadow.shadowOpacity));
            ctx.shadowBlur = photoShadow.shadowBlur || 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            if (hasCorner) {
                buildRoundedPath(ctx, ox, oy, iw, ih, rTL, rTR, rBL, rBR);
                ctx.clip();
            }
            ctx.drawImage(img, ox, oy, iw, ih);
            ctx.restore();
        } else {
            // 立体悬浮卡片(浮影白框):白色衬边 + 环境阴影(????大模?? + 接触阴影(????小模?? + 卡片本体
            const matL = margin.marginLeft, matT = margin.marginTop;
            const matR = margin.marginRight, matB = margin.marginBottom;
            const cx = ox - matL, cy = oy - matT;
            const cw2 = iw + matL + matR, ch2 = ih + matT + matB;
            const sc = parseColor(photoShadow.shadowColorHex, photoShadow.shadowOpacity);
            const blur = Math.max(4, photoShadow.shadowBlur || 0);
            const offX = photoShadow.shadowOffsetX || 0, offY = photoShadow.shadowOffsetY || 0;

            // 环境阴影:大模糊、浅色、偏移更??            
            ctx.save();
            ctx.shadowColor = `rgba(${Math.round(sc.r)},${Math.round(sc.g)},${Math.round(sc.b)},${sc.a * 0.6})`;
            ctx.shadowBlur = blur * 1.5;
            ctx.shadowOffsetX = offX * 2.4;
            ctx.shadowOffsetY = offY * 2.4;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(cx, cy, cw2, ch2);
            ctx.restore();

            // 接触阴影:小模糊、深色、紧贴卡??            
            ctx.save();
            ctx.shadowColor = rgba(sc);
            ctx.shadowBlur = blur * 0.5;
            ctx.shadowOffsetX = offX * 0.5;
            ctx.shadowOffsetY = offY * 0.5;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(cx, cy, cw2, ch2);
            ctx.restore();

            // 卡片本体(白色衬边)
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(cx, cy, cw2, ch2);
            ctx.restore();
        }
} else if (corner.outerRound !== 1) {
        // 默认小阴影:圆角卡片(outerRound)四角镂空后,偏移阴影会从镂空角/右侧/下侧漏出黑边,不再绘制
            ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        if (hasCorner) {
            buildRoundedPath(ctx, ox + 5, oy + 5, iw, ih, rTL, rTR, rBL, rBR);
            ctx.fill();
        } else {
            ctx.fillRect(ox + 5, oy + 5, iw, ih);
        }
        ctx.restore();
    }

    // 照片本体:同尺寸临时画布(设备分辨率)绘制后单独镂空四角,再 1:1 贴回主画布。
    // 这样照片圆角外露出下方边框/卡片本体,而不会把边框凿穿成透明(否则深色主题下四角透出黑底);
    // 主画布 drawImage 全程不处于裁剪态,规避裁剪态缩放照片产生的高频纹理摩尔纹横线。
    // 同步画幅时把照片裁到内容区内(照片 cover 后超出边距/画布的部分不绘制)
    if (syncOn) { ctx.save(); ctx.beginPath(); ctx.rect(margin.marginLeft || 0, margin.marginTop || 0, usableW, usableH); ctx.clip(); }
    if (hasCorner) {
        const sc = Math.abs(ctx.getTransform().a) || 1;
        const tmpW = Math.max(1, Math.round(iw * sc));
        const tmpH = Math.max(1, Math.round(ih * sc));
        const tmp = document.createElement('canvas');
        tmp.width = tmpW; tmp.height = tmpH;
        const tg = tmp.getContext('2d');
        tg.setTransform(sc, 0, 0, sc, 0, 0);
        tg.drawImage(img, 0, 0, iw, ih);
        punchRoundedCorners(tg, 0, 0, iw, ih, rTL, rTR, rBL, rBR);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(tmp, ox * sc, oy * sc, tmpW, tmpH);
        ctx.restore();
    } else {
        ctx.drawImage(img, ox, oy, iw, ih);
    }
    if (syncOn) ctx.restore();
    return rect;
}

// 形状遮罩:仅胶片齿??原版 applyShapeMask)
function applyShapeMask(ctx, filmTearConfig, cw, ch, margin) {
    if (filmTearConfig && filmTearConfig.filmPerforationEnable === 1) {
        drawFilmPerforations(ctx, filmTearConfig, cw, ch, margin);
    }
}

// 白色齿孔(原版 drawFilmPerforations:hstrip 上下两条轨道,否则左右竖列)
// 锚定到照片区(??baseMargin 内侧):web 预设把胶片条作为照片区图??页边留白属页面背??
// margin ??0 时与原版画布原点一致??
function drawFilmPerforations(ctx, config, cw, ch, margin) {
    const size = config.filmPerforationSize || 0;
    const spacing = config.filmPerforationSpacing || 0;
    const isRound = config.filmPerforationType === 'round';
    const horizontal = config.filmPerforationType === 'hstrip';
    // 步长守卫:size/spacing ??0 或负数时保证循环推进
    const stepX = Math.max(1, size + spacing);
    const stepY = Math.max(1, size + spacing);
    const m = 15;
    const ax = (margin && margin.marginLeft) || 0;
    const ay = (margin && margin.marginTop) || 0;
    const aw = cw - ax - ((margin && margin.marginRight) || 0);
    const ah = ch - ay - ((margin && margin.marginBottom) || 0);
    ctx.fillStyle = '#ffffff';
    if (horizontal) {
        const yTop = ay + m;
        const yBottom = ay + ah - m - size;
        let x = ax + m;
        while (x + size <= ax + aw - m) {
            ctx.fillRect(x, yTop, size, size);
            ctx.fillRect(x, yBottom, size, size);
            x += stepX;
        }
    } else {
        let y = ay + m;
        while (y + size <= ay + ah - m) {
            for (const xv of [ax + m, ax + aw - m - size]) {
                if (isRound) { ctx.beginPath(); ctx.arc(xv + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.fill(); }
                else ctx.fillRect(xv, y, size, size);
            }
            y += stepY;
        }
    }
}

// 全局光影(暗角 MULTIPLY + 漏光 SCREEN + 胶片颗粒 OVERLAY)
// ── 胶片颗粒 ──
// 噪声砖缓存:key = 砖边长(强度不进 key,同一张砖用不同 alpha 复用)。
// 之所以要缓存:一帧 4000×3455 的画布若每帧重算 1400 万个随机数,拖滑块会直接卡死。
const GRAIN_TILE_CACHE = {};
// 砖尺寸的键空间是 96..1408 的整数(约 1300 档),而单块最大 1408²×4 ≈ 7.9MB。
// 不设上限时:拖动留白/缩放会让画布尺寸每帧微变 → 每帧生成一块新砖 → 一次拖拽就能涨到 GB 级。
// 保留最近 8 块(预览尺寸下每块约 1-2MB)即可覆盖"预览 + 导出"的常用档位。
// 砖由固定盐的 LCG 确定性生成(见 GRAIN_SALT),淘汰后重算的像素完全一致 ——
// 这是纯内存回收,不改变任何输出。
const GRAIN_TILE_ORDER = [];
const GRAIN_TILE_MAX = 8;
// 固定盐值:同一张图 + 同一个尺寸永远得到同一张颗粒图。
// 绝不能用 Math.random() —— 否则每帧颗粒都在跳(预览"沙沙"响),
// 而且视觉回归基线永远对不上。
const GRAIN_SALT = 20240816;

function grainTile(size) {
    if (GRAIN_TILE_CACHE[size]) return GRAIN_TILE_CACHE[size];
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    const d = img.data;
    // 固定种子的 LCG:不用 Math.random,理由见 GRAIN_SALT
    let seed = (Math.imul(size, 2654435761) ^ GRAIN_SALT) >>> 0;
    for (let i = 0; i < d.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        // 取高 16 位映射到 0..255,低 16 位在这类 LCG 里周期过短、分布不均
        const v = 58 + ((seed >>> 16) & 255) * (140 / 255);   // 58..198,均值 128
        d[i] = v; d[i + 1] = v; d[i + 2] = v;
        d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    GRAIN_TILE_CACHE[size] = c;
    GRAIN_TILE_ORDER.push(size);
    while (GRAIN_TILE_ORDER.length > GRAIN_TILE_MAX) {
        const old = GRAIN_TILE_ORDER.shift();
        if (old !== size) delete GRAIN_TILE_CACHE[old];
    }
    return c;
}

// 颗粒层:强度 0~100(%)
// 砖边长跟着画布走(约 min/3.2),而不是写死 —— 写死的话预览(约 1000px)和
// 导出(4000px)的颗粒相对大小会差 4 倍,导出后"看不清颗粒",预览与成品对不上。
    // 300px 短边 → 94px 砖;3000px 短边(4000x3000 图)→ 938px 砖,
    // 两者的"每张画布几颗颗粒"一致。
    // 单块上限 1408px 是为了让超大图别生成上千万像素的砖(约 6MB,首次会卡一下);
    // 超出后颗粒相对画布会略微变细,对观感无影响。
function applyFilmGrain(ctx, light, cw, ch) {
    if (!light || light.filmGrainEnable !== 1) return;
    const amt = clamp((light.filmGrainIntensity || 0) / 100, 0, 1);
    if (amt <= 0) return;
    const size = clamp(Math.round(Math.min(cw, ch) / 3.2), 96, 1408);
    const tile = grainTile(size);
    ctx.save();
    // OVERLAY:亮处被提亮、暗处被压暗 —— 这才是胶片颗粒的质感。
    // 用 'lighter'(纯加噪)会把整张图提成灰雾,像蒙了层纱,不是颗粒。
    // 噪声砖必须**居中在 128**:OVERLAY 的枢轴是 0.5,overlay(base,128) === base,
    // 砖均值偏离 128 就等于给照片加了一层曝光。实测均值 172 的砖会把 1200px 图的
    // 平均亮度从 172 抬到 201(强度 100% 时),那就不是颗粒而是"把照片调亮了"。
    ctx.globalCompositeOperation = 'overlay';
    // 强度→alpha 用 1.5 次幂(而不是平方)。这条曲线是被仓库里已有的 10 个
    // filmGrainEnable:1 预设逼出来的:它们的 filmGrainIntensity 全落在 6~18。
    // 平方曲线下 6 档的 alpha 只有 0.0036,实测最大 RGB 差 0 —— 加载后画面一个
    // 像素都不变,等于"字段有、渲染无"换了个形式又造一遍。1.5 次幂把
    // 6/10/18 档变成 1.5%/3.2%/7.6% alpha,颗粒细腻但确实看得见;
    // 100 档仍是 alpha=1,推得满。
    ctx.globalAlpha = Math.pow(amt, 1.5);
    const pat = ctx.createPattern(tile, 'repeat');
    if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, cw, ch); }
    ctx.restore();
}

function applyGlobalLight(ctx, light, cw, ch) {
    if (!light) return;
    if (light.vignetteEnable === 1) {
        // 双向晕影（与 Lightroom / Camera Raw 同向）：负值压暗四角，正值提亮四角。
        // 老数据只有 0..100 的正值，走同一分支，观感不变。
        const raw = (Number(light.vignetteStrength) || 0) / 100;
        const s = Math.abs(raw);
        if (s > 0) {
            // 羽化：以前只存不用（死滑块）。这里把它接上，且特意让「50」还原旧几何
            // （内圈透明止点 = 1 - s），所以老预设/老草稿的画面不会因为这次改动而变。
            // <50 收得更紧（暗角更贴边），>50 过渡起点更早（更柔、覆盖更大）。
            const feather = light.vignetteFeather != null ? Number(light.vignetteFeather) : 50;
            const mid = Math.max(0, Math.min(1, 1 - s * (0.5 + (isFinite(feather) ? feather : 50) / 100)));
            const r = Math.max(cw, ch) / 2;
            const grad = ctx.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, r);
            const tint = raw < 0 ? '0,0,0' : '255,255,255';
            grad.addColorStop(0, `rgba(${tint},0)`);
            grad.addColorStop(mid, `rgba(${tint},0)`);
            grad.addColorStop(1, `rgba(${tint},${Math.min(1, s)})`);
            ctx.save();
            // 压暗走 multiply、提亮走 screen：两者都是「以原图为准」的混合，
            // 不会像 lighter 那样把亮的角落直接烧成纯白。
            ctx.globalCompositeOperation = raw < 0 ? 'multiply' : 'screen';
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, cw, ch);
            ctx.restore();
        }
    }
    if (light.lightLeakEnable === 1) {
        const op = light.lightLeakOpacity / 100;
        const type = light.lightLeakType || 'warm';
        let core, mid;
        if (type === 'cool') { core = [120, 200, 255]; mid = [70, 150, 255]; }
        else if (type === 'magenta') { core = [255, 140, 220]; mid = [220, 90, 255]; }
        else { core = [255, 190, 110]; mid = [255, 130, 60]; }
        const a = (light.lightLeakAngle || 0) * Math.PI / 180;
        const dx = Math.cos(a), dy = Math.sin(a);
        // 光源位于画布边缘外侧,光束与光晕从该方向射入画??
        const sx = cw / 2 + dx * cw * 0.58;
        const sy = ch / 2 + dy * ch * 0.58;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        // 1) 大范围柔光晕
        const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(cw, ch) * 0.85);
        halo.addColorStop(0, `rgba(${mid[0]},${mid[1]},${mid[2]},${clamp(op * 0.45, 0, 1)})`);
        halo.addColorStop(0.35, `rgba(${mid[0]},${mid[1]},${mid[2]},${clamp(op * 0.15, 0, 1)})`);
        halo.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, cw, ch);
        // 2) 光束
        const bx = -dx, by = -dy;
        const beam = ctx.createLinearGradient(sx, sy, sx + bx * cw, sy + by * ch);
        beam.addColorStop(0, `rgba(${core[0]},${core[1]},${core[2]},${clamp(op * 0.9, 0, 1)})`);
        beam.addColorStop(0.3, `rgba(${core[0]},${core[1]},${core[2]},${clamp(op * 0.3, 0, 1)})`);
        beam.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = beam;
        ctx.fillRect(0, 0, cw, ch);
        ctx.restore();
    }
    // 颗粒放在最后:暗角/漏光之后再叠,才是"拍完再冲印"的顺序。
    // 放前面的话,漏光的 SCREEN 会把颗粒一起提亮,看起来像加了层灰纱。
    applyFilmGrain(ctx, light, cw, ch);
}

// 文字字号:exif 自适行??2000px 基准缩放(0.5~2.5 ??,其余保持原??原版 autoExifTextSize)
function autoExifTextSize(textLine, canvasW) {
    let fs = Math.max(1, textLine.fontSize || 1);
    if (textLine.align === 'exif' && !textLine.autoSize) {
        const k = clamp(canvasW / 2000, 0.5, 2.5);
        fs = Math.max(4, fs * k);
    }
    return fs;
}

// 四角括号装饰(原版 drawCornerDecor:line/round/double)
function drawCornerDecor(ctx, type, s, cw, ch) {
    if (!s || s <= 0) return;
    const isRound = type === 'round';
    const isDouble = type === 'double';
    ctx.strokeStyle = 'rgb(128,128,128)';
    ctx.lineWidth = 2;
    const corners = [[s, s], [cw - s, s], [s, ch - s], [cw - s, ch - s]];
    for (const c of corners) {
        const x = c[0], y = c[1];
        const dx = x < cw / 2 ? 1 : -1;
        const dy = y < ch / 2 ? 1 : -1;
        if (isRound) {
            const r = Math.max(4, s * 0.6);
            ctx.beginPath();
            ctx.moveTo(x + dx * s, y);
            ctx.arcTo(x, y, x, y + dy * s, r);
            ctx.stroke();
        } else if (isDouble) {
            const in_ = Math.max(4, s * 0.25);
            const len = Math.max(6, s - in_ * 2);
            ctx.beginPath();
            ctx.moveTo(x, y); ctx.lineTo(x + dx * s, y);
            ctx.moveTo(x, y); ctx.lineTo(x, y + dy * s);
            const xi = x + dx * in_, yi = y + dy * in_;
            ctx.moveTo(xi, yi); ctx.lineTo(xi + dx * len, yi);
            ctx.moveTo(xi, yi); ctx.lineTo(xi, yi + dy * len);
            ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.moveTo(x, y); ctx.lineTo(x + dx * s, y);
            ctx.moveTo(x, y); ctx.lineTo(x, y + dy * s);
            ctx.stroke();
        }
    }
}

// 文字行锚??原版 textLineAnchor)
function textLineAnchor(textLine, cw, ch, card, cardY, cardH) {
    const fs = autoExifTextSize(textLine, cw);
    const align = textLine.align || 'bottom';
    if (align === 'free') return [textLine.x || 0, textLine.y || 0];
    const tx = textLine.x > 0 ? textLine.x : cw / 2;
    let ty;
    if (align === 'bottom' || align === 'exif') {
        ty = card ? cardY + cardH + Math.max(8, ch * 0.008) : ch - fs - 10;
    } else if (align === 'top') {
        ty = card ? fs + Math.max(6, ch * 0.004) : fs + 10;
    } else {
        ty = textLine.y > 0 ? textLine.y
            : (card ? cardY + cardH + Math.max(8, ch * 0.008) : ch - fs - 10);
    }
    return [tx, ty];
}

// ── 文字排版度量 ──
// 一处算、三处用：drawTextLine（画）、hitTestTexts（点）、选中框（框）。
// 之前命中框是「字数 × 字号 × 0.7」猜的，只对「横排、居中、无旋转」近似成立；
// 一旦允许竖排/侧排/旋转，就会出现「字画在这里、点在那里」。
/* exported textLineSpacing, textLineDir, textLineMetrics */

// 字距(px)。预设里就是像素口径；非有限值/负数一律按 0。
function textLineSpacing(line) {
    const ls = Number(line && line.letterSpacing);
    return Number.isFinite(ls) && ls > 0 ? ls : 0;
}

// 方向：h 横排（默认）/ v 竖排直立（逐字堆叠，中文用）/ side 侧排（整行 -90°，自下而上读）
function textLineDir(line) {
    const d = line && line.direction;
    return (d === 'v' || d === 'side') ? d : 'h';
}

// 竖排的格距倍率（1.0 = 字紧贴；默认 1.2）。同一字段也当行距用，取值夹在 0.6~3。
function textLineStepRatio(line) {
    const g = Number(line && line.lineGap);
    return Number.isFinite(g) && g >= 0.6 && g <= 3 ? g : 1.2;
}

// 量宽用的离屏 ctx：横排宽度必须真量（含字距），不能靠字数估。
let _textMeasureCtx = null;
function textMeasureCtx() {
    if (!_textMeasureCtx) {
        const c = document.createElement('canvas');
        c.width = 1; c.height = 1;
        _textMeasureCtx = c.getContext('2d');
    }
    return _textMeasureCtx;
}

// 横排文字宽度（含字距）。letterSpacing 必须是 CSS 长度字符串——
// 给数字会被静默忽略（同 engine-styles.js:2093 记过这个坑）。
// textOverride 用于多行：同一行样式，只换这一行的文字。
function textLineAdvance(line, fs, textOverride) {
    const g = textMeasureCtx();
    const ls = textLineSpacing(line);
    g.font = `${line.fontWeight || 400} ${fs}px "${line.fontFamily || 'Microsoft YaHei'}"`;
    if (ls > 0) g.letterSpacing = ls + 'px';
    const raw = textOverride == null ? line.text : textOverride;
    const w = g.measureText(String(raw == null ? '' : raw)).width;
    if (ls > 0) g.letterSpacing = '0px';
    return Math.max(1, w);
}

// 多行文字：拆行、量最宽一行、算总高。竖排不支持多列，换行直接并成一列
// （否则每多一行就得多一套列距算法，收益不大）。
function textLineSegments(line) {
    const raw = String(line && line.text == null ? '' : line.text).replace(/\r\n?/g, '\n');
    if (textLineDir(line) === 'v') return [raw.replace(/\n/g, '')];
    return raw.split('\n');
}

// 一行文字的几何。返回（全部为画布逻辑像素）：
//   cx/cy  未旋转时的框中心（自由文字的 x/y 就是这个中心）
//   lw/lh  未旋转时的框尺寸
//   rot    实际旋转角（direction:'side' 已经折进来）
//   by     横排/侧排的基线相对框中心的纵向偏移（正=在中心下方）
//   step   竖排每字占的格高（含字距）
//   x/y/w/h 旋转后的轴对齐外框（命中、选中框用）
function textLineMetrics(line, cw, ch, card, cardY, cardH, scl) {
    const W = (cw > 1 ? cw : 1), H = (ch > 1 ? ch : 1);
    // 文字/贴纸层是在 ctx.restore() 之后用**物理**画布尺寸画的，而 fontSize 与
    // 自由文字的 x/y 都是逻辑量 —— 因此在 DPR≠1 时，文字会只有一半大、自由坐标还会
    // 偏到左上角（老 bug）。scl = 物理/逻辑，把这两样放大即可；锚点分支本来就用
    // 物理 cw/ch，不能再乘。
    const S = (Number(scl) > 0 ? scl : 1);
    const fs = Math.max(1, autoExifTextSize(line, W / S) * S);
    const dir = textLineDir(line);
    const ls = textLineSpacing(line);
    const segments = textLineSegments(line);
    const text = segments.join(dir === 'v' ? '' : '\n');
    const n = text.length;
    const ratio = textLineStepRatio(line);
    // 竖排：一个字一格；字距是「字与字之间」的附加间隙
    const step = fs * ratio + ls;
    // 横排/侧排多行：行高固定 1.18×字号（与单行时代的框高一致，老预设不变）。
    const lineH = fs * 1.18;
    const nLines = Math.max(1, segments.length);
    const lw = dir === 'v' ? fs * 1.15
        : Math.max(1, ...segments.map(s => textLineAdvance(line, fs, s)));
    const lh = dir === 'v' ? Math.max(fs, n * step) : lineH * nLines;
    const a = textLineAnchor(line, W, H, card || false, cardY || 0, cardH || 0);
    let cx = a[0], cy = a[1];
    if (line.align === 'free') {
        // 自由文字：(x, y) 即框中心（逻辑口径），绘制时按 S 放大
        cx = a[0] * S; cy = a[1] * S;
    } else if (dir === 'v') {
        // 竖排沿用横排锚点的含义（baseline 那条线）：顶对齐从锚点下方起排，
        // 底对齐让末字贴着锚点，这样「贴顶/贴底」的既有语义不用改。
        const top = line.align === 'top' ? (cy - fs * 0.8) : (cy + fs * 0.2 - lh);
        cy = top + lh / 2;
    } else {
        // 横排：锚点是基线。多行时底对齐要保证**最后一行**的基线落在锚点上，
        // 否则多出来的行会整段掉到画布外面；顶对齐则保持第一行基线在锚点。
        const firstBaseline = (line.align === 'top') ? cy : (cy - (nLines - 1) * lineH);
        cy = firstBaseline - (fs * 0.8 - lh / 2);
    }
    const rot = (Number(line.rotation) || 0) + (dir === 'side' ? -90 : 0);
    const th = rot * Math.PI / 180;
    const hw = Math.abs(lw / 2 * Math.cos(th)) + Math.abs(lh / 2 * Math.sin(th));
    const hh = Math.abs(lw / 2 * Math.sin(th)) + Math.abs(lh / 2 * Math.cos(th));
    return {
        dir, fs, ls, step, rot, cx, cy, lw, lh,
        lines: segments, nLines, lineH, text, scl: S,
        by: fs * 0.8 - lh / 2,
        x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2,
    };
}

// ── 智能反差 ──
// 采样文字背后的实际像素,决定文字用什么颜色、要不要一圈反色边线。
// 取样方式:把目标区域先缩到 32×8 再 getImageData —— 直接读原区域的话,6000px 宽的导出
// 画布上一趟要搬 MB 级像素,而这里只需要几十个采样点。
const LM_W = 32, LM_H = 8;
let _lmCv = null, _lmCtx = null;
// WCAG 相对亮度的线性化查找表(γ≈2.2,够用且比 pow 便宜)
const LM_LUT = (() => { const t = new Float64Array(256); for (let i = 0; i < 256; i++) t[i] = Math.pow(i / 255, 2.2); return t; })();

// 纯决策:meanY=平均相对亮度(0..1)、dev=编码亮度的平均绝对偏差(0..255,越大底越花)。
// 黑/白两边对比度的交叉点在 Y≈0.179(WCAG 公式解出来的),故阈值取 0.18;
// 底花(dev>30)时光靠换色保证不了可读性,再描一圈反色边线。
function contrastChoice(meanY, dev) {
    const light = !(meanY > 0.18);          // 暗底 → 白字
    return { light, outline: dev > 30 };
}

// 采样:返回 { meanY, dev, n } 或 null(读不到像素:无 DOM 桩 / 跨域画布 / 尺寸非法)。
// 绝不抛异常、绝不改动传入 ctx 的任何状态 —— 调用方拿不到结果就按原行为走。
function backdropStats(ctx, x, y, w, h) {
    try {
        const cv = ctx && ctx.canvas;
        if (!cv || !(w > 0) || !(h > 0)) return null;
        const sx = Math.max(0, Math.floor(x)), sy = Math.max(0, Math.floor(y));
        const sw = Math.min(cv.width - sx, Math.ceil(w)), sh = Math.min(cv.height - sy, Math.ceil(h));
        if (sw <= 0 || sh <= 0) return null;
        if (!_lmCv) {
            _lmCv = document.createElement('canvas');
            _lmCv.width = LM_W; _lmCv.height = LM_H;
            _lmCtx = _lmCv.getContext('2d', { willReadFrequently: true });
        }
        _lmCtx.clearRect(0, 0, LM_W, LM_H);
        _lmCtx.drawImage(cv, sx, sy, sw, sh, 0, 0, LM_W, LM_H);
        const d = _lmCtx.getImageData(0, 0, LM_W, LM_H).data;
        const n = d.length / 4;
        if (!n) return null;
        let sumY = 0, sumL = 0, dev = 0;
        const lums = new Float64Array(n);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
            const a = d[i + 3] / 255;
            // 半透明像素按「白底」折算:JPEG 导出会垫白,透明区不该被当成纯黑
            const r = d[i] * a + 255 * (1 - a), g = d[i + 1] * a + 255 * (1 - a), b = d[i + 2] * a + 255 * (1 - a);
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            sumY += 0.2126 * LM_LUT[Math.round(r)] + 0.7152 * LM_LUT[Math.round(g)] + 0.0722 * LM_LUT[Math.round(b)];
            sumL += l; lums[p] = l;
        }
        const meanL = sumL / n;
        for (let p = 0; p < n; p++) dev += Math.abs(lums[p] - meanL);
        return { meanY: sumY / n, dev: dev / n, n };
    } catch (e) { return null; }
}

// 文字行绘??原版 drawTextLine)
/* exported drawTextLine */ function drawTextLine(ctx, line, cw, ch, card, cardY, cardH, scl) {
    if (!line || line.text == null || line.text === '') return;
    const m = textLineMetrics(line, cw, ch, card, cardY, cardH, scl);
    const fs = m.fs;
    const S = m.scl || 1;
    ctx.save();
    ctx.font = `${line.fontWeight || 400} ${fs}px "${line.fontFamily || 'Microsoft YaHei'}"`;
    ctx.textAlign = 'center';
    let fill = rgba(parseColor(line.colorHex, line.opacity));
    let autoOutline = null;
    // 智能反差(仅显式开启的行,如 EXIF 水印):按文字实际覆盖的区域取色。
    // 取的是度量外框,所以竖排/旋转时采样区也跟着对。
    if (line.autoContrast) {
        const st = backdropStats(ctx, m.x, m.y, m.w, m.h);
        if (st) {
            const pick = contrastChoice(st.meanY, st.dev);
            const a = clamp((line.opacity == null ? 100 : line.opacity) / 100, 0, 1);
            fill = pick.light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
            if (pick.outline) autoOutline = pick.light ? `rgba(0,0,0,${a * 0.5})` : `rgba(255,255,255,${a * 0.5})`;
        }
    }
    ctx.fillStyle = fill;
    // 用户可选的描边：与智能反差边线共用同一个落笔函数，描边永远在填充下面。
    const strokeOn = line.strokeEnable === undefined ? false : Number(line.strokeEnable) === 1;
    const strokeColor = strokeOn
        ? rgba(parseColor(line.strokeColorHex || '#000000', line.strokeOpacity == null ? 100 : line.strokeOpacity))
        : autoOutline;
    const strokeWidth = strokeOn
        ? (line.strokeWidth != null
            ? Math.max(1, Number(line.strokeWidth) * S)
            : Math.max(1, fs * 0.06))
        : Math.max(1, Math.round(fs * 0.06));
    // 阴影：老预设只有 enableShadow 开关、没有 shadowBlur 等字段。这里要求至少有一个
    // 显式参数才启用，避免把 2 个老预设的观感突然改掉（它们当年就没被引擎实现过）。
    const shadowOn = Number(line.enableShadow) === 1
        && (line.shadowBlur != null || line.shadowOffsetX != null || line.shadowOffsetY != null);
    const shadowColor = rgba(parseColor(line.shadowColorHex || '#000000',
        line.shadowOpacity == null ? 45 : line.shadowOpacity));
    const shadowBlur = Math.max(0, (Number(line.shadowBlur) || 0) * S);
    const shadowX = (Number(line.shadowOffsetX) || 0) * S;
    const shadowY = (Number(line.shadowOffsetY) || 0) * S;
    const paint = (tx, ty, str) => {
        if (strokeColor) {
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = strokeWidth;
            ctx.lineJoin = 'round';
            ctx.strokeText(str, tx, ty);
        }
        if (shadowOn) {
            ctx.shadowColor = shadowColor;
            ctx.shadowBlur = shadowBlur;
            ctx.shadowOffsetX = shadowX;
            ctx.shadowOffsetY = shadowY;
        }
        ctx.fillText(str, tx, ty);
        if (shadowOn) {
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
        }
    };
    // 旋转绕「框中心」而不是锚点:命中框、选中框算的都是这个中心,三者才对得上。
    ctx.translate(m.cx, m.cy);
    if (m.rot) ctx.rotate(m.rot * Math.PI / 180);
    if (m.dir === 'v') {
        // 竖排:每字占一格、格内居中;格高已经把字距算进去了(见 textLineMetrics.step)
        ctx.textBaseline = 'middle';
        const t = m.text;
        for (let i = 0; i < t.length; i++) paint(0, -m.lh / 2 + m.step * (i + 0.5), t[i]);
    } else {
        ctx.textBaseline = 'alphabetic';
        // 字距必须是 CSS 长度字符串:给数字会被静默忽略(engine-styles.js:2093 记过同一个坑)。
        // 居中时 Chromium 把末字之后那段也计入 advance,故整体右移 ls/2,让「墨迹」真正居中。
        if (m.ls > 0) ctx.letterSpacing = m.ls + 'px';
        for (let i = 0; i < m.lines.length; i++) {
            paint(m.ls / 2, m.by + i * m.lineH, m.lines[i]);
        }
        if (m.ls > 0) ctx.letterSpacing = '0px';
    }
    ctx.restore();
}

// 实时草稿文字(align:'live',??UI 预览??不写??textLines)
function drawDraftText(ctx, template, cw, ch, scl) {
    const d = template && template._draftText;
    if (d && d.text) drawTextLine(ctx, d, cw, ch, false, 0, 0, scl);
}

// 参数条数据源:逐字段「手动(含相机库填入)> 自动识别」。
// 自动 EXIF 的品牌键名是 make、手动是 brand —— 原先这里整份二选一(hasManual ? manual : exif),
// 结果:导入后没碰过参数输入框的照片,参数条里只剩型号没有品牌;而风格参数行(cameraFor)
// 本来就用 make 兜住了,两处口径不一致。现在改成逐字段回落,手动只填了 ISO 时其余字段照样兜底。
function stripExifSrc(manual, image) {
    const auto = (image && image.exif && typeof image.exif === 'object') ? image.exif : {};
    const pick = (mk, ak) => {
        const v = (manual && manual[mk] != null) ? String(manual[mk]).trim() : '';
        if (v) return v;
        return (auto[ak] != null) ? String(auto[ak]).trim() : '';
    };
    return {
        brand: pick('brand', 'make'),
        model: pick('model', 'model'),
        focal: pick('focal', 'focal'),
        aperture: pick('aperture', 'aperture'),
        iso: pick('iso', 'iso'),
        shutter: pick('shutter', 'shutter'),
    };
}

// 装饰总入??原版 drawDecoration:文字/贴纸/四角括号/EXIF 底条)
function drawDecoration(ctx, decor, cw, ch, image, template, stripTop, scl) {
    if (!decor) return;

    const exifOn = (decor.exifAutoText || 0) === 1;
    const tpl = template || {};
    const manual = (tpl.manualExif && typeof tpl.manualExif === 'object') ? tpl.manualExif : {};
    // 手动(含相机库填入)> 自动识别,逐字段合并 —— 见 stripExifSrc 注释
    const src = stripExifSrc(manual, image);
    const exifParts = [
        src.brand && src.model ? `${src.brand} ${src.model}` : (src.brand || src.model || ''),
        (src.shutter != null ? src.shutter : ''), (src.aperture != null ? src.aperture : ''),
        (src.iso != null ? src.iso : ''), (src.focal != null ? src.focal : ''),
    ].map(String).filter(Boolean);
    const lines = decor.textLines || [];
    const exifLineIdx = exifOn ? lines.findIndex(l => l.text && (l.align === 'bottom' || l.align === 'exif')) : -1;
    // 画布内编辑时，文字由 textarea 覆盖层显示；这里跳过同一元素，避免两层字形
    // 因为字体度量/缩放取整差 1px 而出现重影。
    const app = (typeof window !== 'undefined') ? window.App : null;
    const editingText = (app && app._textEditor) ? app._textEditor.el : null;
    // 拖动/旋转/缩放中的元素也要跳过：背景缓存里不能烤进它，否则快速通道
    // 会在旧字上再画一遍新字，旋转时看起来就是重影 + 拖尾。
    const skip = app ? app._skipUserEl : null;

    for (let i = 0; i < lines.length; i++) {
        const textLine = lines[i];
        if (!textLine.text) continue;
        if (i === exifLineIdx) continue;
        if (textLine === editingText || textLine === skip) continue;
        drawTextLine(ctx, textLine, cw, ch, false, 0, 0, scl);
    }
    for (const sticker of (decor.stickers || [])) {
        if (!sticker.src || sticker === skip) continue;
        const tex = getElementBitmap(sticker.src);
        if (!tex || !tex.complete || !tex.naturalWidth) continue;
        const sw = tex.naturalWidth * (sticker.scale || 1);
        const sh = tex.naturalHeight * (sticker.scale || 1);
        ctx.save();
        ctx.translate(sticker.x || 0, sticker.y || 0);
        if (sticker.rotation) ctx.rotate(sticker.rotation * Math.PI / 180);
        ctx.globalAlpha = clamp((sticker.opacity == null ? 100 : sticker.opacity) / 100, 0, 1);
        ctx.drawImage(tex, -sw / 2, -sh / 2, sw, sh);
        ctx.restore();
    }
    if ((decor.cornerDecorEnable || 0) === 1) {
        drawCornerDecor(ctx, decor.cornerDecorType || 'line', decor.cornerDecorSize || 30, cw, ch);
    }
    // 勾选「EXIF 参数条」时：
    //   · 底部已经有文字行 → **原地换字**，字体/字号/颜色/字距全部沿用那一行。
    //     换的只是内容：预设里的「Kodak Portra 400 · 35mm」变成照片真实的相机参数。
    //     以前这里不分青红皂白画一条大字条：14px 的落款会被一行 40px+ 的字顶掉，
    //     2000px 宽的成片上直接铺满整个底边，版式就坏了。
    //   · 底部没有文字行 → 才在留白里画参数条（drawExifStrip）。
    if (exifOn) {
        const srcLine = exifLineIdx >= 0 ? lines[exifLineIdx] : null;
        if (srcLine) {
            if (srcLine !== editingText && srcLine !== skip) {
                // 没有可用的相机参数时把原字照常画回去 —— 勾上了却什么都没有，比不勾更糟
                const text = exifParts.length ? exifParts.join(' · ') : srcLine.text;
                drawTextLine(ctx, Object.assign({}, srcLine, { text }), cw, ch, false, 0, 0, scl);
            }
        } else {
            const text = exifParts.length ? exifParts.join(' · ') : '';
            if (text) drawExifStrip(ctx, text, stripTop, cw, ch);
        }
    }
}

// EXIF 参数文字:黑色、字号随底部留白(图片底边~卡片底边)自适应,垂直居中于留白条内
function drawExifStrip(ctx, text, stripTop, cw, ch) {
    const stripH = Math.max(4, ch - (stripTop || 0));
    const minFs = Math.max(11, Math.round(cw / 260));
    let fs = Math.round(stripH * 0.55);
    const maxFs = Math.max(stripH * 0.7, minFs + 2);
    fs = Math.max(minFs, Math.min(fs, maxFs));
    const font = (s) => `400 ${s}px "Microsoft YaHei"`;
    ctx.font = font(fs);
    const padX = Math.max(16, cw * 0.015);
    const avail = Math.max(1, cw - padX * 2);
    const w = ctx.measureText(text).width;
    if (w > avail && w > 0) fs = Math.max(minFs, Math.round(fs * avail / w));
    ctx.font = font(fs);
    // 智能反差:参数条压在纯白留白上是黑字;换成深色/花纹理填充后,原来的固定黑字会消失。
    // 采样留白条的实际颜色:亮底黑字、暗底白字;底花(偏差大)再描一圈反色边线。
    let stripFill = 'rgba(0,0,0,1)';
    let stripOutline = null;
    const st = backdropStats(ctx, 0, stripTop || 0, cw, stripH);
    if (st) {
        const pick = contrastChoice(st.meanY, st.dev);
        stripFill = pick.light ? 'rgba(255,255,255,1)' : 'rgba(0,0,0,1)';
        if (pick.outline) stripOutline = pick.light ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ty = stripTop + stripH / 2 + fs * 0.06;
    if (stripOutline) {
        ctx.strokeStyle = stripOutline;
        ctx.lineWidth = Math.max(1, Math.round(fs * 0.06));
        ctx.lineJoin = 'round';
        ctx.strokeText(text, cw / 2, ty);
    }
    ctx.fillStyle = stripFill;
    ctx.fillText(text, cw / 2, ty);
}

// ── 卡片样式(原版 renderCardStyle:独立管线,不画图层)──
function renderCardStyle(app) {
    const { image, template } = app;
    const img = photoSrc(image);
    const margin = template.baseMargin || {};
    const originW = img.naturalWidth, originH = img.naturalHeight;
    let canvasW = originW + (margin.marginLeft || 0) + (margin.marginRight || 0);
    let canvasH = originH + (margin.marginTop || 0) + (margin.marginBottom || 0);

    const ratio = effectiveCanvasRatio(template);
    if (ratio && ratio !== 'original') {
        const wh = parseRatio(ratio);
        if (wh) {
            const targetRatio = wh[0] / wh[1];
            const currentRatio = canvasW / canvasH;
            if (currentRatio > targetRatio) canvasH = canvasW / targetRatio;
            else canvasW = canvasH * targetRatio;
        }
    }

    const ctx = setupCanvas(app, canvasW, canvasH);

    // 1. 模糊背景(cover 铺满)
    drawBlurredBackground(ctx, img, canvasW, canvasH, margin);
    const whiteOv = margin.bgBlurWhiteOverlay || 0;
    if (whiteOv > 0) {
        const ovA = whiteOv === 1 ? 0.15 : clamp(whiteOv / 100, 0, 1);
        ctx.fillStyle = `rgba(255,255,255,${ovA})`;
        ctx.fillRect(0, 0, canvasW, canvasH);
    }

    // 2. 径向暗角(原版固定 0.25)
    const cx = canvasW / 2, cy = canvasH / 2;
    const radius = Math.sqrt(cx * cx + cy * cy);
    const vig = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    vig.addColorStop(0, 'rgba(255,255,255,0.0)');
    vig.addColorStop(0.5, 'rgba(0,0,0,0.0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, canvasW, canvasH);

    // 3. 内容??
    const cardX = margin.marginLeft || 0;
    const cardY = margin.marginTop || 0;
    const cardW0 = canvasW - (margin.marginLeft || 0) - (margin.marginRight || 0);
    let cardH = canvasH - (margin.marginTop || 0) - (margin.marginBottom || 0);
    const textAreaH = Math.max(20, canvasH * 0.011);
    cardH -= textAreaH;

    // 4. 圆角照片 + 柔和阴影
    const corner = template.cornerConfig || {};
    const cr = clamp(corner.cornerRadiusAll || 0, 0, cardW0 / 2);
    const prTL = (corner.cornerRadiusTL || 0) > 0 ? Math.min(corner.cornerRadiusTL, cardW0 / 2) : cr;
    const prTR = (corner.cornerRadiusTR || 0) > 0 ? Math.min(corner.cornerRadiusTR, cardW0 / 2) : cr;
    const prBL = (corner.cornerRadiusBL || 0) > 0 ? Math.min(corner.cornerRadiusBL, cardH / 2) : cr;
    const prBR = (corner.cornerRadiusBR || 0) > 0 ? Math.min(corner.cornerRadiusBR, cardH / 2) : cr;

    const imgScale = Math.min(cardW0 / originW, cardH / originH) * (margin.imgScale || 1);
    const drawW = originW * imgScale;
    const drawH = originH * imgScale;
    const drawX = cardX + (cardW0 - drawW) / 2 + (margin.imgOffsetX || 0);
    const drawY = cardY + (cardH - drawH) / 2 + (margin.imgOffsetY || 0);
    // 照片在基准坐标里的矩形：蒙版叠加层靠它把指针换算成照片内坐标。
    // 卡片管线的画布由 setupCanvas 建（_canvasBaseW/H、_canvasScale 已就绪），这里只补矩形。
    app._photoRect = { x: drawX, y: drawY, w: drawW, h: drawH };

    // 阴影参数:优先图层启用的阴??否则默认柔和阴影
    let cardShadow = null;
    for (const layer of (template.layerList || [])) {
        const sg = layer.shadowGlowConfig;
        if (sg && sg.shadowEnable === 1) { cardShadow = sg; break; }
    }
    let blur, offX, offY, sc;
    if (cardShadow) {
        blur = cardShadow.shadowBlur || 0;
        offX = cardShadow.shadowOffsetX || 0;
        offY = cardShadow.shadowOffsetY || 0;
        sc = parseColor(cardShadow.shadowColorHex, cardShadow.shadowOpacity);
    } else {
        blur = Math.max(8, canvasW * 0.006);
        offX = 0;
        offY = Math.max(2, canvasH * 0.002);
        sc = { r: 0, g: 0, b: 0, a: 0.30 };
    }

    // Step 1: 圆角路径填充 + DropShadow 柔和投影
    ctx.save();
    ctx.shadowColor = rgba(sc);
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = offX;
    ctx.shadowOffsetY = offY;
    ctx.fillStyle = '#ffffff';
    buildRoundedPath(ctx, drawX, drawY, drawW, drawH, prTL, prTR, prBL, prBR);
    ctx.fill();
    ctx.restore();

    // Step 2: 清晰照片。用离屏画布 + destination-out 镂空圆角外侧再贴回，
    // 不走 ctx.clip() —— clip 的抗锯齿边缘会让 Step 1 的白色衬底从弧边透出白边。
    drawPhotoWithCorners(ctx, img, drawX, drawY, drawW, drawH, prTL, prTR, prBL, prBR);

    // 8. 全局光影
    applyGlobalLight(ctx, template.lightEffect, canvasW, canvasH);

    ctx.restore();

    // 元素叠层(基准画布像素坐标)
    const cw = app.dom.canvas.width, ch = app.dom.canvas.height;
    const cardScl = canvasW > 0 ? cw / canvasW : 1;
    // 同上：文字层按 _logW 口径换算（与 app-elements 的 textSpaceScale 一致）
    const textScl2 = (app.dom.canvas._logW > 1) ? cw / app.dom.canvas._logW : 1;
    drawDecoration(ctx, template.decorConfig || {}, cw, ch, image, template, (drawY + drawH) * cardScl, textScl2);
    drawDraftText(ctx, template, cw, ch, textScl2);
    drawLogoElements(ctx, template.logoElements || [], cw, ch);

    app.applyZoomStyle();
}

// 模糊背景:用户背景图优先,否则照片本身模糊拉伸填满全部画布(原版 drawBlurredBackground)
// 绘制区四周外扩 3 倍模糊半径,避免模糊核采样到图像边缘造成角部半透明
function drawBlurredBackground(ctx, img, cw, ch, margin) {
    const blurRadius = Math.max(1, margin.bgBlurRadius || 0);
    const pad = Math.ceil(blurRadius * 3);
    const sw = cw + pad * 2, sh = ch + pad * 2;
    ctx.save();
    ctx.filter = `blur(${blurRadius}px)`;
    ctx.drawImage(img, -pad, -pad, sw, sh);
    ctx.restore();
}

// Logo 元素绘制(透明 PNG 叠在最上层;坐标为基准画布像素,拖拽/命中检测一致)
// 拖动优化:app._skipUserEl 指向正在拖的元素时把它排除,使其余内容可作为静态背景缓存,
// 拖动期间只需 blit 背景 + 重绘该元素(见 app.js 的 renderPreview)
function _filterUserEls(elements) {
    const skip = (typeof window !== 'undefined' && window.App) ? window.App._skipUserEl : null;
    if (!skip || !elements || !elements.length) return elements;
    return elements.filter(el => el !== skip);
}

function drawLogoElements(ctx, elements, cw, ch) {
    elements = _filterUserEls(elements);
    if (!elements || !elements.length) return;
    const sorted = elements.slice().sort((a, b) => (a.z || 0) - (b.z || 0));
    for (const el of sorted) {
        if (!el || !el.dataUrl) continue;
        const img = getElementBitmap(el.dataUrl);
        if (!img || !img.complete || !img.naturalWidth) continue;
        // 按原图宽高比缩放(size为宽度,高度按比例)
        const ratio = img.naturalHeight / img.naturalWidth || 1;
        // 放大上限:宽、高都不超过画布。手势期 canvas 会临时缩到 900px,
        // 此时用 App 按手势前画布算出的上限，避免拖动过程中把 Logo 压小；
        // 导出/正常预览没有手势，直接用当前真实画布做最终兜底。
        const app = (typeof window !== 'undefined') ? window.App : null;
        let maxSize = Math.min(cw, ch / ratio);
        if (app && app._gesture && typeof app.logoMaxSize === 'function') maxSize = app.logoMaxSize(el);
        if (!(maxSize > 0)) maxSize = Infinity;
        const size = Math.max(2, Math.min(el.size || 60, maxSize));
        const dw = size, dh = size * ratio;
        let cx, cy;
        if (el.rel && typeof el.rx === 'number' && typeof el.ry === 'number') {
            // 相对比例以「显示画布 canvas.width/height」为分母(rx∈[0,1]):预览在可能
            // canvas=_logW×dpr 的画布上按同一分数解析,导出(canvas=_logW)亦然,两处位置一致。
            // 旧模板(rx 以基准画布为分母)由 app 侧 normalizeTemplate 的 migrateRelCanvasFrac
            // 在渲染前一次性换算,这里直接按显示画布还原即可。
            const cvEl = (typeof window !== 'undefined' && window.App && window.App.dom && window.App.dom.canvas) || null;
            if (cvEl && cvEl.width > 1 && cvEl.height > 1) {
                cx = el.rx * cvEl.width;
                cy = el.ry * cvEl.height;
            }
        }
        if (cx === undefined) {
            if (typeof el.x === 'number' && typeof el.y === 'number') {
                cx = el.x; cy = el.y;
            } else {
                const hAlign = el.x || 'right', vAlign = el.y || 'bottom';
                const ox = el.offsetX || 20, oy = el.offsetY || 20;
                // 与 app.js 的 logoPos 口径一致:此处 dw/dh 已是实际绘制尺寸,直接用
                cx = hAlign === 'left' ? ox + dw / 2 : hAlign === 'center' ? cw / 2 : cw - ox - dw / 2;
                cy = vAlign === 'top' ? oy + dh / 2 : vAlign === 'center' ? ch / 2 : ch - oy - dh / 2;
            }
        }
        ctx.save();
        ctx.globalAlpha = clamp((el.opacity == null ? 100 : el.opacity) / 100, 0, 1);
        ctx.translate(cx, cy);
        if (el.rotation) ctx.rotate(el.rotation * Math.PI / 180);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
    }
}

// 用户叠层元素:自由文字 + 贴纸 + Logo(用于相框风格??避免与样式内绘制重复)
/* exported drawUserElements */ function drawUserElements(ctx, template, cw, ch) {
    if (!template) return;
    const decor = template.decorConfig || {};
    const app = (typeof window !== 'undefined') ? window.App : null;
    const skip = app ? app._skipUserEl : null;
    // 相框风格（engine-styles）走的是这条通道，不是 drawDecoration。
    // 画布内编辑时也必须跳过同一段文字，否则半透明 textarea 下面还压着画布字形，
    // 看起来就是打字有重影（用户实测；只在默认模板通道里修过，相框预设没覆盖到）。
    const editingText = (app && app._textEditor) ? app._textEditor.el : null;
    for (const textLine of (decor.textLines || [])) {
        if (textLine === skip || textLine === editingText) continue;
        if (textLine.text && textLine.align === 'free') drawTextLine(ctx, textLine, cw, ch, false, 0, 0);
    }
    for (const sticker of (decor.stickers || [])) {
        if (sticker === skip) continue;
        if (!sticker.src) continue;
        const tex = getElementBitmap(sticker.src);
        if (!tex || !tex.complete || !tex.naturalWidth) continue;
        const sw = tex.naturalWidth * (sticker.scale || 1);
        const sh = tex.naturalHeight * (sticker.scale || 1);
        ctx.save();
        ctx.translate(sticker.x || 0, sticker.y || 0);
        if (sticker.rotation) ctx.rotate(sticker.rotation * Math.PI / 180);
        ctx.globalAlpha = clamp((sticker.opacity == null ? 100 : sticker.opacity) / 100, 0, 1);
        ctx.drawImage(tex, -sw / 2, -sh / 2, sw, sh);
        ctx.restore();
    }
    drawDraftText(ctx, template, cw, ch);
    drawLogoElements(ctx, template.logoElements || [], cw, ch);
}

function renderPlaceholder(app) {
    const canvas = app.dom.canvas;
    canvas.width = 400; canvas.height = 300;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#cccccc';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('该预设样式(MVP 尚未支持)', 200, 150);
    app.applyZoomStyle();
}

// ── 拼图渲染(拼图页签,独立管线;长边 4000 导出??app.displayMax)──
function puzzleSlotCountOf(layout) {
    const n = { single: 1, as2: 2, h2: 2, v2: 2, h3: 3, v3: 3, as4: 4, grid4: 4, h4: 4, v4: 4, grid6: 6, grid9: 9 };
    return n[layout] || 1;
}

// ── 拼图布局引擎(对应 Java PuzzlrRenderer.buildSlots)──
// 11 布局:0=单张 1=h2 2=v2 3=as2 4=h3 5=v3 6=grid4 7=as4 8=h4 9=v4 10=grid6 11=grid9
const PUZZLE_LAYOUT_TYPES = {
    single: 0, h2: 1, v2: 2, as2: 3, h3: 4, v3: 5,
    grid4: 6, as4: 7, h4: 8, v4: 9, grid6: 10, grid9: 11,
};
// 每布局的可拖分割轴定义(相对 0-1):axes: {v:[..], h:[..]}
const PUZZLE_LAYOUT_AXES = {
    single: { v: [], h: [] },                                  // 无轴
    h2:     { v: [0.5], h: [] },                               // 1 竖轴
    v2:     { v: [], h: [0.5] },                               // 1 横轴
    as2:    { v: [0.6], h: [] },                               // 1 竖轴(一大一小)
    h3:     { v: [0.333, 0.667], h: [] },                      // 2 竖轴
    v3:     { v: [], h: [0.333, 0.667] },                      // 2 横轴
    grid4:  { v: [0.5], h: [0.5] },                            // 1 竖 + 1 横
    as4:    { v: [0.55], h: [0.333, 0.667] },                  // 左大 + 右三行
    h4:     { v: [0.25, 0.5, 0.75], h: [] },                   // 3 竖轴
    v4:     { v: [], h: [0.25, 0.5, 0.75] },                   // 3 横轴
    grid6:  { v: [0.333, 0.667], h: [0.5] },                   // 2 竖 + 1 横
    grid9:  { v: [0.333, 0.667], h: [0.333, 0.667] },          // 2 竖 + 2 横
};
// 画布建议宽高比(基准 S=1):[w,h]
function puzzleLayoutSize(layout, S, gap) {
    switch (layout) {
        case 'h2': return [2 * S + gap, S];
        case 'v2': return [S, 2 * S + gap];
        case 'as2': return [Math.round(S * 1.5) + gap, S];
        case 'h3': return [3 * S + 2 * gap, S];
        case 'v3': return [S, 3 * S + 2 * gap];
        case 'grid4': return [2 * S + gap, 2 * S + gap];
        case 'as4': return [Math.round(S * 1.6) + gap, S];
        case 'h4': return [4 * S + 3 * gap, S];
        case 'v4': return [S, 4 * S + 3 * gap];
        case 'grid6': return [3 * S + 2 * gap, 2 * S + gap];
        case 'grid9': return [3 * S + 2 * gap, 3 * S + 2 * gap];
default: return [S, S];
    }
}

// 由(布局, 轴位置)实时计算每格相对坐标 [x,y,w,h](0-1)。
// axes: {v:[0-1], h:[0-1]} 已钳制;补齐端点;列/行从轴位置切分。
function buildPuzzleSlots(layoutType, axes) {
    const def = PUZZLE_LAYOUT_AXES[layoutType] || PUZZLE_LAYOUT_AXES.single;
    const v = (axes && axes.v) || def.v || [];
    const h = (axes && axes.h) || def.h || [];
    const vs = [0].concat(v.slice().sort((a, b) => a - b)).concat(1);
    const hs = [0].concat(h.slice().sort((a, b) => a - b)).concat(1);
    const cols = [], rows = [];
    for (let i = 0; i < vs.length - 1; i++) cols.push([vs[i], vs[i + 1]]);
    for (let j = 0; j < hs.length - 1; j++) rows.push([hs[j], hs[j + 1]]);
    const rects = [];
    if (layoutType === 'as4') {
        // 左大列 + 右侧 3 行(右侧各行宽 = 1 - v[0])
        const vp = vs[1];
        const restW = 1 - vp;
        rects.push([0, 0, vp, 1]);
        for (let j = 0; j < rows.length; j++) rects.push([vp, rows[j][0], restW, rows[j][1] - rows[j][0]]);
    } else if (cols.length > 1 && rows.length > 1) {
        for (const c of cols) for (const r of rows) rects.push([c[0], r[0], c[1] - c[0], r[1] - r[0]]);
    } else if (cols.length > 1) {
        for (const c of cols) rects.push([c[0], 0, c[1] - c[0], 1]);
    } else {
        for (const r of rows) rects.push([0, r[0], 1, r[1] - r[0]]);
    }
    return rects;
}

// 钳制轴位:只保留当前布局定义的那几条轴(切换布局后不残留旧轴),
// 缺省位置按布局默认比例补全,范围 0.12–0.88、相邻轴间距≥0.12。
// 旧实现直接 map 用户数组:拖一条轴只写入一个下标,其余轴会丢(3 列变 2 列),
// 从其他布局带过来的 v/h 轴也会凭空多切一刀。
function clampPuzzleAxes(layoutType, axes) {
    const def = PUZZLE_LAYOUT_AXES[layoutType] || PUZZLE_LAYOUT_AXES.single;
    const out = { v: [], h: [] };
    const MIN = 0.12;
    for (const dim of ['v', 'h']) {
        const defs = def[dim] || [];
        const n = defs.length;
        if (!n) continue;
        const src = (axes && Array.isArray(axes[dim])) ? axes[dim] : [];
        const vals = [];
        for (let i = 0; i < n; i++) {
            let v = (src[i] == null) ? defs[i] : Number(src[i]);
            if (!isFinite(v)) v = defs[i];
            vals.push(clamp(v, MIN, 1 - MIN));
        }
        vals.sort((a, b) => a - b);
        // 按"左侧还要放 i+1 个最小格、右侧还要放 n-i 个"先限位,
        // 再从左往右补最小间距;这样两条轴不会撞在一起或越界。
        for (let i = 0; i < n; i++) {
            const lo = MIN + i * MIN;
            const hi = 1 - MIN - (n - 1 - i) * MIN;
            vals[i] = clamp(vals[i], lo, hi);
        }
        for (let i = 1; i < n; i++) vals[i] = Math.max(vals[i], vals[i - 1] + MIN);
        out[dim] = vals;
    }
    return out;
}

// 槽内图片适配:cover/contain + 槽位缩放/偏移
function puzzleFit(r, iw, ih, mode, zoomPct, offX, offY) {
    const z = (zoomPct == null ? 100 : zoomPct) / 100;
    const s = mode === 'contain' ? Math.min(r.w / iw, r.h / ih) : Math.max(r.w / iw, r.h / ih);
    const dw = iw * s * z, dh = ih * s * z;
    const dx = r.x + (r.w - dw) / 2 + (offX || 0) / 100 * (r.w - dw);
    const dy = r.y + (r.h - dh) / 2 + (offY || 0) / 100 * (r.h - dh);
    return { dx, dy, dw, dh };
}

// 拼图字幕(横排):文本块(一行或两行)整体在条带内垂直居中,字号按 4000 长边基准缩放,
// 过高/超宽会自动等比缩小;align='bottom' 用于格子画面字幕(叠印在图片底部)
function drawPuzzleCaption(ctx, cap, r, align, fs) {
    if (!cap || (!cap.line1 && !cap.line2) || !r || r.h < 1) return;
    const F = (fs == null ? 1 : fs);
    const base1 = Math.max(6, (cap.size1 || 28) * F), base2 = Math.max(6, (cap.size2 || 20) * F);
    const c = parseColor(cap.color || 'ffffff', 100);
    const spPct = (cap.spacing == null ? 0 : cap.spacing) / 100;
    let s1 = base1, s2 = base2;
    // 高度自适应(双行整块 / 单行行高)
    if (cap.line2) {
        const rawH = Math.round(s1 * 1.15) + spPct * s1 + s2;
        if (rawH > r.h) { const sc = Math.max(0.3, r.h / rawH); s1 = Math.max(6, s1 * sc); s2 = Math.max(6, s2 * sc); }
    } else if (Math.round(s1 * 1.15) > r.h) { s1 = Math.max(6, r.h / 1.15); }
    // 宽度自适应(测宽,超宽等比缩)
    ctx.font = `${s1}px "${cap.font1 || 'Microsoft YaHei'}"`;
    const w1 = cap.line1 ? ctx.measureText(cap.line1).width : 0;
    ctx.font = `${s2}px "${cap.font2 || 'Microsoft YaHei'}"`;
    const w2 = cap.line2 ? ctx.measureText(cap.line2).width : 0;
    const mw = Math.max(w1, w2);
    if (mw > r.w && r.w > 0) { const sc = Math.max(0.2, r.w / mw); s1 = Math.max(6, s1 * sc); s2 = Math.max(6, s2 * sc); }
    const lead1 = Math.round(s1 * 1.15);
    const spacing = cap.line2 ? Math.round(s1 * spPct) : 0;
    const blockH = cap.line2 ? lead1 + spacing + s2 : lead1;
    const top = (align === 'bottom') ? Math.max(r.y, r.y + r.h - blockH) : Math.max(r.y, r.y + (r.h - blockH) / 2);
    if (cap.bgBar === 1) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(r.x, top, r.w, Math.min(blockH, r.h));
    }
    ctx.fillStyle = rgba(c);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (cap.line1) {
        ctx.font = `${s1}px "${cap.font1 || 'Microsoft YaHei'}"`;
        const baseline = cap.line2 ? top + lead1 : (align === 'bottom' ? top + Math.round(s1 * 0.9) : r.y + r.h / 2 + Math.round(s1 * 0.36));
        ctx.fillText(cap.line1, r.x + r.w / 2, baseline);
    }
    if (cap.line2) {
        ctx.font = `${s2}px "${cap.font2 || 'Microsoft YaHei'}"`;
        ctx.fillText(cap.line2, r.x + r.w / 2, Math.min(r.y + r.h - 2, top + lead1 + spacing + s2));
    }
}

// 竖直间隙字幕:每条文本一列,列内自上而下、整体在缝高内居中;两行时分列并排(缝内均分)。
// 字形宽度受缝隙厚度与 4000 长边基准限制;间距 = 字符间隙的附加比例;背景条同样只认勾选。
// (旧实现恒定画 55% 黑条 —— 勾选框无效;且只读 line1,第二行/间距被静默丢弃。)
function drawVerticalPuzzleCaption(ctx, cap, x, y0, y1, gw, fs) {
    if (!cap) return;
    const F = (fs == null ? 1 : fs);
    const txts = [cap.line1, cap.line2].filter(s => s != null && String(s).length);
    if (!txts.length) return;
    const c = parseColor(cap.color || 'ffffff', 100);
    const spPct = (cap.spacing == null ? 0 : cap.spacing) / 100;
    const colW = Math.max(1, gw / txts.length);
    txts.forEach((raw, ci) => {
        const t = String(raw);
        const size1 = ci === 0 ? (cap.size1 || 28) : (cap.size2 || 20);
        const font = ci === 0 ? (cap.font1 || 'Microsoft YaHei') : (cap.font2 || 'Microsoft YaHei');
        const size = Math.max(6, Math.min(size1 * F, Math.max(1, colW * 0.9) / 1.4));
        const w = Math.max(1, Math.min(size * 1.4, colW - 1));
        const step = size * 1.3 + size * spPct;
        const totalH = t.length * step;
        const yTop = y0 + Math.max(0, (y1 - y0 - totalH) / 2);
        const cx = x - gw / 2 + colW * (ci + 0.5);
        if (cap.bgBar === 1) {
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(cx - w / 2, yTop, w, Math.min(totalH, y1 - yTop));
        }
        ctx.fillStyle = rgba(c);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.font = `${size}px "${font}"`;
        for (let i = 0; i < t.length; i++) {
            const cy = yTop + i * step;
            if (cy > y1 - size) break;
            ctx.fillText(t[i], cx, cy);
        }
    });
}

function renderPuzzle(app, compare, noSelection) {
    const pk = (app.template && app.template.puzzle) || {};
    const layout = pk.layout || 'single';
    const n = puzzleSlotCountOf(layout);
    const srcs = (app.images && app.images.length) ? app.images : (app.image ? [app.image] : []);
    // 槽位配置:兼容数组/对象计数两种存储;逐格解析实际使用的照片
    const slotsRaw = pk.slots;
    const slots = (slotsRaw && (Array.isArray(slotsRaw) || typeof slotsRaw === 'object')) ? slotsRaw : {};
    const used = Array.from({ length: n }, (_, i) => {
        const sc = slots[i] || {};
        if (sc.imageIndex != null && srcs[sc.imageIndex]) return srcs[sc.imageIndex];
        if (sc.imagePath) return srcs.find(x => x.name === sc.imagePath) || null;
        return null;
    });
    const gap = Math.max(0, Math.round(((pk.gap == null ? 6 : pk.gap) / 100) * 1000));
    const S = 1000;
    let W = 1000, H = 1000;
    const sz = puzzleLayoutSize(layout, S, gap);
    W = sz[0]; H = sz[1];
    // 间距换算基准 = 版式「原生」短边(auto 时它恰好等于画布短边)。
    // 画布比例只负责把画布裁成所选比例,不应顺带改变间距的厚度 —— 否则同一档「间距」
    // 在 auto / 4:3 / 9:16 下渲染出的缝隙各不相同(实测 v3: 3.00→2.25px,h3: 3.00→7.02px)。
    const gapUnit = Math.min(W, H);
    if (pk.canvasRatio && pk.canvasRatio !== 'auto') {
        const wh = parseRatio(pk.canvasRatio);
        if (wh) {
            const R = wh[0] / wh[1];
            if (W / H !== R) H = Math.max(20, Math.round(W / R));
        }
    }
    const ctx = setupCanvas(app, W, H);

    const axes = clampPuzzleAxes(layout, pk.axisVals);
    let slots0 = buildPuzzleSlots(layout, axes);
    const rawSlots = slots0.slice(); // 未加间隙的原始格子位置,给模糊背景用
    const Wn = W || 1, Hn = H || 1;
    const border = parseColor(pk.borderColor || 'ffffff', 100);
    const b = Math.max(1, Math.round(Wn * 0.003));
    const px = (x) => x * Wn, py = (y) => y * Hn, pw = (w) => w * Wn, ph = (h) => h * Hn;
    const scaler = gapUnit / 1000;
    // 格子间距统一只有一种来源:图片每侧内缩 gapPx;贴边格子的外边再内进 gapPx,
    // 于是内部缝隙 = 2*gapPx = 四周留白 = 字幕条带厚度(gth),格子间距处处一致。
    const gapG = Math.max(0, Math.round(((pk.gap == null ? 6 : pk.gap) / 100) * 1000));
    const gapPx = Math.max(0, (pk.gap == null ? 6 : pk.gap) * scaler * 0.5);
    const EPS = 1e-6;
    const shift = gapPx;
    const shiftX = shift / Wn, shiftY = shift / Hn;
    // 只对"贴边的那些边"额外内进 gapPx(+ 下面统一内缩的 gapPx = 外侧 2*gapPx):
    // 外侧 2*gapPx = 内部缝隙 2*gapPx = 字幕条带 gth,四处一致。
    // 以前这里对所有格子四条边无条件内进,于是缝隙变成 4*gapPx(2 倍外边距),
    // 与 puzzleSlotAtPx 的点选范围、gth 字幕带的宽度都对不上。
    slots0 = slots0.map(r => {
        let x0 = r[0], y0 = r[1], x1 = r[0] + r[2], y1 = r[1] + r[3];
        if (x0 <= EPS) x0 += shiftX;
        if (x1 >= 1 - EPS) x1 -= shiftX;
        if (y0 <= EPS) y0 += shiftY;
        if (y1 >= 1 - EPS) y1 -= shiftY;
        return [x0, y0, x1 - x0, y1 - y0];
    });
    // 字幕字号:画布长边基准 + 受字幕带高度(gth)约束,gap 小则字号自动缩小,避免行间重叠
    const gthBase = Math.max(2, gapPx * 2);
    const capFsRaw = Math.max(Wn, Hn) / 4000;
    // 字号上限:字幕带高度的 0.45(单行)/0.75(双行),保证文字在带内不溢出
    const capFs = Math.min(capFsRaw, gthBase / 28 * 0.9);

    if (pk.bgMode === 1 && used[0]) {
        drawDetailBlurBackground(ctx, used, rawSlots, Wn, Hn);
    } else {
        ctx.fillStyle = rgba(border);
        ctx.fillRect(0, 0, Wn, Hn);
    }

    if (pk.bgMode === 1 && used[0]) {
        // 模糊照片底:不画细边框,照片直接贴在虚化背景上
    } else {
        // 白色背景:保持原有边框铺满(整格外扩 b)
        ctx.fillStyle = rgba(border);
        slots0.forEach(r => {
            ctx.fillRect(px(r[0]) - b, py(r[1]) - b, pw(r[2]) + b * 2, ph(r[3]) + b * 2);
        });
    }

    const rectPx = slots0.map(r => [px(r[0]), py(r[1]), pw(r[2]), ph(r[3])]);

    // 间隙字幕:行内全宽通栏带;h 间隙按"行"计数(行数 = 横轴数 + 1,最后一条为底部字幕带),v 间隙按竖轴
    const gcs = pk.gapCaptions;
    const gth = Math.max(2, gapPx * 2);
    const hAxRow = axes.h || [], vAxRow = axes.v || [];
    const rowsN = hAxRow.length + 1;

    // 选中格高亮(预览);导出(noSelection)时抑制,避免选中蓝边进入成品图
    const drawSlotSel = (x, y, w, h) => {
        if (noSelection) return;
        ctx.save();
        ctx.strokeStyle = 'rgba(30,144,255,0.95)';
        ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.025);
        ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
        ctx.setLineDash([]);
        ctx.restore();
    };
    rectPx.forEach((r, i) => {
        const sc = slots[i] || {};
        const im = used[i] || null;
        const rx = r[0], ry = r[1], rw = r[2], rh = r[3];
        if (!im || !photoSrc(im)) {
            ctx.fillStyle = 'rgba(224,224,224,1)';
            ctx.fillRect(rx, ry, rw, rh);
            // 空格也画选中框:点它往往是为了把照片放进这一格
            if (app._activePuzzleSlot === i) drawSlotSel(rx + gapPx, ry + gapPx, Math.max(1, rw - gapPx * 2), Math.max(1, rh - gapPx * 2));
            return;
        }
        ctx.save();
        ctx.beginPath();
        const cx = rx + gapPx, cy = ry + gapPx, cw = Math.max(1, rw - gapPx * 2);
        // 字幕带厚度 = 外边距 = 2*gapPx,底部字幕带正好落进下外边距里,图片不必再让位。
        // (旧写法拿像素 r[1] 去比 0-1 归一化轴位,恒真 —— gap>0 时每一行都被削掉 gth。)
        const chh = Math.max(1, rh - gapPx * 2);
        // 格子圆角(用户可调,默认3%)
        const cornerPct = (pk.cornerRadius == null ? 3 : pk.cornerRadius) / 100;
        const cr = Math.max(0, Math.min(cw, chh) * cornerPct);
        // 格子阴影(模糊模式下在clip之前画,只画投影不填色)
        if (pk.bgMode === 1) {
            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,0.65)';
            ctx.shadowBlur = Math.max(20, Math.min(cw, chh) * 0.1);
            ctx.shadowOffsetY = Math.max(8, Math.min(cw, chh) * 0.035);
            ctx.fillStyle = 'rgba(255,255,255,1)';
            if (typeof ctx.roundRect === 'function') ctx.roundRect(cx, cy, cw, chh, cr);
            else ctx.rect(cx, cy, cw, chh);
            ctx.fill();
            ctx.restore();
        }
        ctx.save();
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(cx, cy, cw, chh, cr);
        else ctx.rect(cx, cy, cw, chh);
        ctx.clip();
        const fillMode = sc.fillMode || pk.slotFill || 'cover';
        const zoom = sc.zoom != null ? sc.zoom : (pk.zoom != null ? pk.zoom : 100);
        const offX = clamp(sc.offsetX != null ? sc.offsetX : (pk.offsetX || 0), -100, 100);
        const offY = clamp(sc.offsetY != null ? sc.offsetY : (pk.offsetY || 0), -100, 100);
        const imSrc = photoSrc(im);
        const fit = puzzleFit({ x: cx, y: cy, w: cw, h: chh }, imSrc.naturalWidth, imSrc.naturalHeight, fillMode, zoom, offX, offY);
        // 格子内图片旋转(0/90/180/270)
        const rot = ((sc.rotate || 0) % 4 + 4) % 4;
        if (rot === 0) {
            ctx.drawImage(imSrc, fit.dx, fit.dy, fit.dw, fit.dh);
        } else {
            ctx.save();
            ctx.translate(cx + cw / 2, cy + chh / 2);
            ctx.rotate(rot * Math.PI / 2);
            const rw = (rot % 2 === 1) ? chh : cw;
            const rh = (rot % 2 === 1) ? cw : chh;
            const rscale = Math.max(rw / (imSrc.naturalWidth || 1), rh / (imSrc.naturalHeight || 1));
            const rdw = (imSrc.naturalWidth || 1) * rscale;
            const rdh = (imSrc.naturalHeight || 1) * rscale;
            ctx.drawImage(imSrc, -rdw / 2, -rdh / 2, rdw, rdh);
            ctx.restore();
        }
        ctx.restore();
        // 格子画面字幕:叠印在该格图片底部,宽度随格子自适应(门牌号 S<i>)
        const scap = (pk.captions && pk.captions[i]);
        if (scap && (scap.line1 || scap.line2)) drawPuzzleCaption(ctx, scap, { x: cx, y: cy, w: cw, h: chh }, 'bottom', capFs);
        // 选中格高亮(空格在分支里已画)
        if (app._activePuzzleSlot === i) drawSlotSel(cx, cy, cw, chh);
    });

    if (gcs) {
        for (const key in gcs) {
            const cap = gcs[key];
            if (!cap || (!cap.line1 && !cap.line2)) continue;
            const m = /^([vh])(\d+)$/.exec(key);
            if (!m) continue;
            const dim = m[1], idx = parseInt(m[2], 10);
            if (dim === 'h') {
                if (idx >= rowsN) continue;
                let by;
                if (idx === rowsN - 1) by = Math.max(0, Hn - gth); // 底部字幕带
                else {
                    const pos = hAxRow[idx];
                    if (pos == null) continue;
                    by = Math.max(0, Math.min(Hn - gth, py(pos) - gth / 2)); // 行间通栏带:以轴线居中
                }
                drawPuzzleCaption(ctx, cap, { x: 0, y: by, w: Wn, h: gth }, null, capFs);
            } else {
                const pos = vAxRow[idx];
                if (pos == null) continue;
                drawVerticalPuzzleCaption(ctx, cap, px(pos), 0, Hn, gth, capFs);
            }
        }
    }

    // 拖拽互换:目标格高亮 + 被抓取图片预览 / 槽外浮空跟手
    const pick = app._puzzlePick;
    if (pick && photoSrc(pick)) {
        ctx.save();
        const pickSrc = photoSrc(pick);
        if (pick.mode === 'target' && rectPx[pick.target]) {
            const r = rectPx[pick.target];
            const cx = r[0] + gapPx, cy = r[1] + gapPx, cw = Math.max(1, r[2] - gapPx * 2), chh = Math.max(1, r[3] - gapPx * 2);
            const fit = puzzleFit({ x: cx, y: cy, w: cw, h: chh }, pick.iw, pick.ih, pk.slotFill || 'cover', 100, 0, 0);
            ctx.globalAlpha = 0.45;
            ctx.drawImage(pickSrc, fit.dx, fit.dy, fit.dw, fit.dh);
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = 'rgba(56,201,91,0.95)';
            ctx.lineWidth = Math.max(2, Math.min(cw, chh) * 0.03);
            ctx.strokeRect(cx - 2, cy - 2, cw + 4, chh + 4);
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 6]);
            ctx.strokeRect(cx - 2, cy - 2, cw + 4, chh + 4);
            ctx.setLineDash([]);
        } else {
            const w0 = pick.w0 || 1, h0 = pick.h0 || 1;
            const fit = puzzleFit({ x: 0, y: 0, w: w0, h: h0 }, pick.iw, pick.ih, 'cover', 100, 0, 0);
            ctx.globalAlpha = 0.8;
            ctx.drawImage(pickSrc, pick.x - fit.dw / 2, pick.y - fit.dh / 2, fit.dw, fit.dh);
        }
        ctx.restore();
    }

    // 分隔线悬停/拖动高亮:只用于预览,导出(noSelection)不画进成品
    if (!noSelection && app._puzzleAxisHover) {
        const hax = app._puzzleAxisHover;
        const apos = (axes[hax.dim] || [])[hax.idx];
        if (apos != null) {
            // 线宽按屏幕 2px 折算:画布常被缩放到 20–60% 显示,固定逻辑像素的线会细到看不见
            let lw = 2;
            try {
                const rw = app.dom.canvas.getBoundingClientRect().width;
                if (rw > 0) lw = Math.max(1, 2 * Wn / rw);
            } catch (_) {}
            ctx.save();
            ctx.fillStyle = 'rgba(30,144,255,0.55)';
            if (hax.dim === 'v') ctx.fillRect(px(apos) - lw / 2, 0, lw, Hn);
            else ctx.fillRect(0, py(apos) - lw / 2, Wn, lw);
            ctx.restore();
        }
    }

    ctx.restore();
    if (typeof window !== 'undefined') window.__lastPuzzleGeom = { Wn, Hn, shift, gapPx, gapG, layout, axes };
    app.applyZoomStyle();
}

// 重虚化照片底:多格照片按格子位置无缝铺满再强模糊
function drawDetailBlurBackground(ctx, used, rawSlots, Wn, Hn) {
    const avail = used.filter(x => x && photoSrc(x));
    if (!avail.length) { ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, Wn, Hn); return; }
    // 用 1/4 输出尺寸的中间画布绘制照片,再以强模糊上采样,得到柔和可辨的模糊照片底
    const tw = Math.max(1, Math.round(Wn / 4));
    const th = Math.max(1, Math.round(Hn / 4));
    const tmp = document.createElement('canvas');
    tmp.width = tw; tmp.height = th;
    const tctx = tmp.getContext('2d');
    // 按原始格子位置(无间隙)把每张照片 cover 填满对应格子
    rawSlots.forEach((r, i) => {
        const im = avail[i % avail.length];
        if (!im) return;
        const dx = r[0] * tw, dy = r[1] * th, dw = r[2] * tw, dh = r[3] * th;
        const imSrc2 = photoSrc(im);
        const iw = imSrc2.naturalWidth, ih = imSrc2.naturalHeight;
        const scale = Math.max(dw / iw, dh / ih);
        const cw = iw * scale, ch = ih * scale;
        tctx.drawImage(imSrc2, dx + (dw - cw) / 2, dy + (dh - ch) / 2, cw, ch);
    });
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    // 模糊半径按画布长边比例,1800px 约 48px,600px 约 16px
    const blurPx = Math.max(8, Math.round(Math.min(Wn, Hn) / 36));
    ctx.filter = 'blur(' + blurPx + 'px)';
    ctx.drawImage(tmp, 0, 0, Wn, Hn);
    ctx.restore();
    // 微微压暗,避免背景照片与格内图片争抢视觉焦点
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, 0, Wn, Hn);
}

window.__renderPuzzle = renderPuzzle;
window.__render = renderToCanvas;
// 供 app.js 的「拖动叠加层」复用,保证拖拽中的画法与整帧渲染像素一致
window.getElementBitmap = getElementBitmap;
window.drawTextLine = drawTextLine;
// 文字几何:命中框/选中框/面板要用同一份度量(见 textLineMetrics 注释)
window.textLineMetrics = textLineMetrics;
window.textLineDir = textLineDir;
window.drawLogoElements = drawLogoElements;
window.PUZZLE_LAYOUT_TYPES = PUZZLE_LAYOUT_TYPES;
window.PUZZLE_LAYOUT_AXES = PUZZLE_LAYOUT_AXES;
window.__buildPuzzleSlots = buildPuzzleSlots;
window.__clampPuzzleAxes = clampPuzzleAxes;
window.__puzzleFit = puzzleFit;
// photoSrc 显式导出：engine-styles.js 的相框/卡片管线（44 个预设）靠 window.photoSrc
// 取「调色过就取烘焙画布、否则取原图」。以前能用是因为经典脚本的顶层函数会自动挂到
// window —— 但哪天把 engine.js 包进 IIFE 或改成 ES module，这行就会静默失效：
// 相框样式的调色全部消失，且没有任何报错。显式导出把这个隐式依赖钉死。
window.photoSrc = photoSrc;

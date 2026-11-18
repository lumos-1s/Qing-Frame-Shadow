'use strict';
/* AI 自由图层渲染器：把一组图层描述画成边框。
 * 每个图层是可编辑的数据（位置/大小/颜色/圆角/文字），因此天然能点选、拖动、改属性。
 * 图元类型：rect / circle / line / text / image。
 * 坐标用 0..1 的比例（相对画布宽高），换画布尺寸时自动等比缩放。
 *
 * 图层格式（数组，顺序 = 从底到顶）：
 * { type:'rect', x,y,w,h, radius, fill:'#rrggbb', fillOpacity, stroke, strokeWidth,
 *   shadow:{color,blur,offsetX,offsetY,opacity} }
 * { type:'circle', cx,cy,r, ...同 fill/stroke/shadow }
 * { type:'line', x1,y1,x2,y2, color, width, dash:[..] }
 * { type:'text', x,y, text, size(相对画布高), color, font, align, weight, letterSpacing }
 * { type:'image', src(dataURL), x,y,w,h, radius, fit:'cover'|'contain' }
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AiLayers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const TYPES = ['rect', 'circle', 'line', 'text', 'image'];
    const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

    // 校验并规范化一层；不合法返回 null
    function normalize(layer) {
        if (!layer || typeof layer !== 'object') return null;
        const t = String(layer.type || '').toLowerCase();
        if (!TYPES.includes(t)) return null;
        const l = Object.assign({}, layer, { type: t });
        // 数字字段兜底
        for (const k of ['x', 'y', 'w', 'h', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2',
            'radius', 'strokeWidth', 'width', 'size', 'letterSpacing', 'fillOpacity', 'opacity']) {
            if (l[k] != null) { const n = Number(l[k]); l[k] = Number.isFinite(n) ? n : 0; }
        }
        return l;
    }

    function withAlpha(hex, alpha) {
        const a = alpha == null ? 1 : (Number(alpha) || 0);
        const h = String(hex || '#000000').replace('#', '');
        if (h.length === 6) {
            const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
            return `rgba(${r},${g},${b},${a})`;
        }
        if (h.length === 3) {
            const r = parseInt(h[0] + h[0], 16), g = parseInt(h[1] + h[1], 16), b = parseInt(h[2] + h[2], 16);
            return `rgba(${r},${g},${b},${a})`;
        }
        return `rgba(0,0,0,${a})`;
    }

    function applyShadow(ctx, sh, draw) {
        if (!sh || Number(sh.blur || 0) <= 0) { draw(); return; }
        ctx.save();
        try {
            ctx.shadowColor = withAlpha(sh.color || '#000000', sh.opacity != null ? sh.opacity : 0.4);
            ctx.shadowBlur = Math.max(0, Number(sh.blur) || 0);
            ctx.shadowOffsetX = Number(sh.offsetX) || 0;
            ctx.shadowOffsetY = Number(sh.offsetY) || 0;
            draw();
        } finally { ctx.restore(); }
    }

    // 画一个图层（比例坐标 → 像素）
    function drawLayer(ctx, raw, W, H, imageCache) {
        const l = normalize(raw);
        if (!l) return;
        const px = (v) => clamp01(v) * W;
        const py = (v) => clamp01(v) * H;
        ctx.save();
        try {
            if (l.opacity != null) ctx.globalAlpha = clamp01(l.fillOpacity != null ? l.fillOpacity : l.opacity);

            if (l.type === 'rect') {
                const x = px(l.x || 0), y = py(l.y || 0), w = px(l.w || 0), h = py(l.h || 0);
                if (w <= 0 || h <= 0) return;
                const r = Math.max(0, Number(l.radius) || 0);
                applyShadow(ctx, l.shadow, () => {
                    ctx.beginPath();
                    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
                    else ctx.rect(x, y, w, h);
                    if (l.fill) { ctx.fillStyle = withAlpha(l.fill, l.fillOpacity != null ? l.fillOpacity : 1); ctx.fill(); }
                    if (l.stroke && (l.strokeWidth || 0) > 0) { ctx.strokeStyle = withAlpha(l.stroke, 1); ctx.lineWidth = l.strokeWidth; ctx.stroke(); }
                });
            } else if (l.type === 'circle') {
                const cx = px(l.cx || 0), cy = py(l.cy || 0);
                const r = Math.max(0, Number(l.r) || 0) * Math.min(W, H);
                if (r <= 0) return;
                applyShadow(ctx, l.shadow, () => {
                    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
                    if (l.fill) { ctx.fillStyle = withAlpha(l.fill, l.fillOpacity != null ? l.fillOpacity : 1); ctx.fill(); }
                    if (l.stroke && (l.strokeWidth || 0) > 0) { ctx.strokeStyle = withAlpha(l.stroke, 1); ctx.lineWidth = l.strokeWidth; ctx.stroke(); }
                });
            } else if (l.type === 'line') {
                const x1 = px(l.x1 || 0), y1 = py(l.y1 || 0), x2 = px(l.x2 || 0), y2 = py(l.y2 || 0);
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.strokeStyle = withAlpha(l.color || l.stroke || '#000000', l.opacity != null ? l.opacity : 1);
                ctx.lineWidth = Math.max(1, Number(l.width || l.strokeWidth || 1));
                if (Array.isArray(l.dash) && ctx.setLineDash) ctx.setLineDash(l.dash.map(Number));
                ctx.stroke();
            } else if (l.type === 'text') {
                const x = px(l.x || 0), y = py(l.y || 0);
                let size = Math.max(6, (Number(l.size) || 0.04) * H);
                const align = l.align || 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.textAlign = align;
                const font = () => `${l.weight || 400} ${size}px ${l.font || 'sans-serif'}`;
                const spacing = (l.letterSpacing != null && ctx.letterSpacing != null) ? (l.letterSpacing * size) : 0;
                const applySpacing = () => { if (ctx.letterSpacing != null) ctx.letterSpacing = spacing + 'px'; };
                ctx.font = font(); applySpacing();
                ctx.fillStyle = withAlpha(l.color || '#ffffff', l.opacity != null ? l.opacity : 1);

                // 可用宽度：AI 可给 maxW；否则按对齐方式取到画布边缘的距离
                let maxW = l.maxW != null ? px(l.maxW) :
                    (align === 'center' ? Math.min(x, W - x) * 2 : align === 'right' ? x : W - x);
                maxW = Math.max(size, maxW - spacing * 2 * String(l.text || '').length); // 扣掉字距累加
                const text = String(l.text == null ? '' : l.text);
                const lines = [];
                const maxLines = Math.max(1, Number(l.maxLines) || 3);

                // 先按可用宽度折行；若折行后仍超 maxLines，则整体缩字号再试
                for (let attempt = 0; attempt < 4; attempt++) {
                    lines.length = 0;
                    ctx.font = font(); applySpacing();
                    let cur = '';
                    for (const ch of text) {
                        if (ch === '\n') { lines.push(cur); cur = ''; continue; }
                        const test = cur + ch;
                        if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = ch; }
                        else cur = test;
                    }
                    if (cur) lines.push(cur);
                    if (lines.length <= maxLines) break;
                    size *= 0.85; // 行太多，缩小字号重试
                }
                if (lines.length > maxLines) lines.length = maxLines;
                ctx.font = font(); applySpacing();

                // 起点：首行基线 y，后续行按行高下移；限制不超出画布上下
                const lineH = size * 1.2;
                let startY = Math.max(size, Math.min(H - 2, y - (lines.length - 1) * lineH * 0.5));
                for (let i = 0; i < lines.length; i++) {
                    let ly = startY + i * lineH;
                    // 水平方向再夹一次，避免字距累加后越界
                    const w = ctx.measureText(lines[i]).width;
                    let lx = x;
                    if (align === 'center') lx = Math.max(w / 2, Math.min(W - w / 2, x));
                    else if (align === 'right') lx = Math.max(w, Math.min(W, x));
                    else lx = Math.max(0, Math.min(W - w, x));
                    ctx.fillText(lines[i], lx, Math.min(H - 2, ly));
                }
                if (ctx.letterSpacing != null) ctx.letterSpacing = '0px';
            } else if (l.type === 'image' && l.src) {
                const x = px(l.x || 0), y = py(l.y || 0), w = px(l.w || 0), h = py(l.h || 0);
                let img = imageCache && imageCache.get(l.src);
                if (!img) { img = { pending: true }; if (imageCache) imageCache.set(l.src, img); loadImage(l.src, () => {}); }
                if (img && img.complete && img.naturalWidth) {
                    ctx.save();
                    const r = Math.max(0, Number(l.radius) || 0);
                    ctx.beginPath();
                    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
                    ctx.clip();
                    if (l.fit === 'contain') {
                        const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
                        const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
                        ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
                    } else {
                        ctx.drawImage(img, x, y, w, h);
                    }
                    ctx.restore();
                }
            }
        } finally { ctx.restore(); }
    }

    const _imgs = new Map();
    function loadImage(src, cb) {
        if (_imgs.get(src) && _imgs.get(src).complete) return cb(_imgs.get(src));
        const img = new Image();
        img.onload = () => cb(img);
        img.onerror = () => cb(null);
        img.src = src;
        _imgs.set(src, img);
        return img;
    }

    // 画整组图层（从底到顶）
    function render(ctx, layers, W, H, onLoad) {
        const arr = Array.isArray(layers) ? layers : [];
        for (const l of arr) drawLayer(ctx, l, W, H, _imgs);
        // 图片异步加载完成后回调重绘
        for (const l of arr) {
            if (l && l.type === 'image' && l.src) {
                const img = _imgs.get(l.src);
                if (img && !img.__notified && img.complete) { img.__notified = true; if (onLoad) onLoad(); }
                else if (img && !img.complete) { const old = img.onload; img.onload = () => { old && old(); if (onLoad) onLoad(); }; }
            }
        }
    }

    return { TYPES, normalize, withAlpha, drawLayer, render, loadImage };
});

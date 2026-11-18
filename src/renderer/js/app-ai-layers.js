'use strict';
/* AI 自由图层渲染器：把一组图层描述画成边框。
 * 每个图层都是可编辑的数据（位置/大小/颜色/圆角/文字），不是一段画死的 JS。
 * 图元类型：rect / circle / line / text / image / photo。
 * 坐标用 0..1 的比例（相对画布宽高），换画布尺寸时自动等比缩放。
 *
 * 图层顺序 = 从底到顶。`photo` 是照片插入点：
 *   [背景层..., photo, 前景层...]
 * 这样“照片放哪、谁在照片前面”由 AI 的图层顺序直接决定，不再靠面积猜。
 *
 * 图层格式（数组，顺序 = 从底到顶）：
 * { type:'rect', x,y,w,h, radius, fill:'#rrggbb', fillOpacity, stroke, strokeWidth,
 *   shadow:{color,blur,offsetX,offsetY,opacity} }
 * { type:'circle', cx,cy,r, ...同 fill/stroke/shadow }
 * { type:'line', x1,y1,x2,y2, color, width, dash:[..] }
 * { type:'text', x,y, text, size(相对画布高; >1 视为像素), color, font, align, weight,
 *   letterSpacing(相对字号; >1 视为像素), maxW(相对宽; >1 视为像素), maxLines }
 * { type:'image', src(dataURL), x,y,w,h, radius, fit:'cover'|'contain' }
 * { type:'photo', x,y,w,h, radius, fit:'cover'|'contain' }  // 照片槽位，本身不画
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AiLayers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const TYPES = ['rect', 'circle', 'line', 'text', 'image', 'photo'];
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const clamp01 = (v) => clamp(Number(v) || 0, 0, 1);

    // 校验并规范化一层；不合法返回 null
    function normalize(layer) {
        if (!layer || typeof layer !== 'object') return null;
        const t = String(layer.type || '').toLowerCase();
        if (!TYPES.includes(t)) return null;
        const l = Object.assign({}, layer, { type: t });
        for (const k of ['x', 'y', 'w', 'h', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2',
            'radius', 'strokeWidth', 'width', 'size', 'letterSpacing', 'fillOpacity', 'opacity',
            'maxW', 'maxLines']) {
            if (l[k] != null) { const n = Number(l[k]); l[k] = Number.isFinite(n) ? n : 0; }
        }
        if (l.maxLines != null) l.maxLines = Math.max(1, Math.floor(l.maxLines) || 1);
        return l;
    }

    function hexToRgba(hex, alpha) {
        const h = String(hex || '').replace('#', '');
        if (!/^[0-9a-f]+$/i.test(h)) return null;
        let r, g, b, a = 1;
        if (h.length === 3 || h.length === 4) {
            r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
            if (h.length === 4) a = parseInt(h[3] + h[3], 16) / 255;
        } else if (h.length === 6 || h.length === 8) {
            r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
            if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
        } else return null;
        if (![r, g, b].every(Number.isFinite)) return null;
        return `rgba(${r},${g},${b},${clamp(a * alpha, 0, 1)})`;
    }

    // 把 hex / rgb() / rgba() 统一成 rgba；未知格式原样返回（不再画成黑色）。
    function withAlpha(color, alpha) {
        const a = alpha == null ? 1 : clamp(Number(alpha) || 0, 0, 1);
        let s = String(color == null ? '#000000' : color).trim();
        if (!s) s = '#000000';
        if (s[0] === '#') {
            const out = hexToRgba(s, a);
            if (out) return out;
        }
        const m = s.match(/^rgba?\(\s*([^)]+)\)$/i);
        if (m) {
            const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
            if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
                const r = clamp(parts[0], 0, 255) | 0;
                const g = clamp(parts[1], 0, 255) | 0;
                const b = clamp(parts[2], 0, 255) | 0;
                const ca = parts.length >= 4 && Number.isFinite(parts[3]) ? clamp(parts[3], 0, 1) : 1;
                return `rgba(${r},${g},${b},${clamp(ca * a, 0, 1)})`;
            }
        }
        return s;
    }

    // 圆角：<1 视为相对短边，>=1 视为像素
    function radiusPx(v, w, h) {
        const n = Number(v) || 0;
        if (n <= 0) return 0;
        const max = Math.min(w, h) / 2;
        return n < 1 ? clamp(n * Math.min(w, h), 0, max) : clamp(n, 0, max);
    }

    // 字号：>1 视为像素，否则相对画布高；硬夹到 6..20% 画布高，AI 给错单位也不会画出天际。
    function sizePx(raw, H) {
        const n = Number(raw);
        const px = n > 1 ? n : (n > 0 ? n * H : 0.04 * H);
        return clamp(px, 6, H * 0.2);
    }

    function maxWidthPx(raw, W, fallback) {
        const n = Number(raw);
        const px = n > 1 ? n : (n > 0 ? n * W : fallback);
        return clamp(px, 1, W);
    }

    function applyShadow(ctx, sh, alpha, draw) {
        const blur = Number(sh && sh.blur) || 0;
        if (!sh || blur <= 0) { draw(); return; }
        ctx.save();
        try {
            const op = sh.opacity != null ? Number(sh.opacity) : 0.4;
            ctx.shadowColor = withAlpha(sh.color || '#000000', clamp(op, 0, 1) * alpha);
            ctx.shadowBlur = Math.max(0, blur);
            ctx.shadowOffsetX = Number(sh.offsetX) || 0;
            ctx.shadowOffsetY = Number(sh.offsetY) || 0;
            draw();
        } finally { ctx.restore(); }
    }

    function roundRectPath(ctx, x, y, w, h, r) {
        ctx.beginPath();
        if (ctx.roundRect) {
            if (r > 0) ctx.roundRect(x, y, w, h, r);
            else ctx.rect(x, y, w, h);
        } else {
            ctx.rect(x, y, w, h);
        }
    }

    // 画一个图层（比例坐标 → 像素）。photo 只作为槽位标记，由合成器负责画照片。
    function drawLayer(ctx, raw, W, H, imageCache) {
        const l = normalize(raw);
        if (!l || l.type === 'photo') return;
        const px = (v) => clamp01(v) * W;
        const py = (v) => clamp01(v) * H;
        const alpha = l.opacity != null ? clamp01(l.opacity) : 1;
        ctx.save();
        try {
            if (l.type === 'rect') {
                const x = px(l.x || 0), y = py(l.y || 0), w = px(l.w || 0), h = py(l.h || 0);
                if (w <= 0 || h <= 0) return;
                const r = radiusPx(l.radius, w, h);
                applyShadow(ctx, l.shadow, alpha, () => {
                    roundRectPath(ctx, x, y, w, h, r);
                    if (l.fill) {
                        ctx.fillStyle = withAlpha(l.fill, (l.fillOpacity != null ? clamp01(l.fillOpacity) : 1) * alpha);
                        ctx.fill();
                    }
                    if (l.stroke && (l.strokeWidth || 0) > 0) {
                        ctx.strokeStyle = withAlpha(l.stroke, alpha);
                        ctx.lineWidth = Math.max(0.5, Number(l.strokeWidth) || 0);
                        ctx.stroke();
                    }
                });
            } else if (l.type === 'circle') {
                const cx = px(l.cx || 0), cy = py(l.cy || 0);
                const rawR = Number(l.r) || 0;
                const r = clamp(rawR > 1 ? rawR : rawR * Math.min(W, H), 0, Math.min(W, H) / 2);
                if (r <= 0) return;
                applyShadow(ctx, l.shadow, alpha, () => {
                    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
                    if (l.fill) {
                        ctx.fillStyle = withAlpha(l.fill, (l.fillOpacity != null ? clamp01(l.fillOpacity) : 1) * alpha);
                        ctx.fill();
                    }
                    if (l.stroke && (l.strokeWidth || 0) > 0) {
                        ctx.strokeStyle = withAlpha(l.stroke, alpha);
                        ctx.lineWidth = Math.max(0.5, Number(l.strokeWidth) || 0);
                        ctx.stroke();
                    }
                });
            } else if (l.type === 'line') {
                const x1 = px(l.x1 || 0), y1 = py(l.y1 || 0), x2 = px(l.x2 || 0), y2 = py(l.y2 || 0);
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.strokeStyle = withAlpha(l.color || l.stroke || '#000000', alpha);
                ctx.lineWidth = clamp(Number(l.width || l.strokeWidth) || 1, 0.5, 40);
                if (Array.isArray(l.dash) && ctx.setLineDash) ctx.setLineDash(l.dash.map(Number).filter((n) => n > 0));
                ctx.stroke();
            } else if (l.type === 'text') {
                drawText(ctx, l, W, H);
            } else if (l.type === 'image' && l.src) {
                const x = px(l.x || 0), y = py(l.y || 0), w = px(l.w || 0), h = py(l.h || 0);
                if (w <= 0 || h <= 0) return;
                let img = imageCache && imageCache.get(l.src);
                if (!img) { img = { pending: true }; if (imageCache) imageCache.set(l.src, img); loadImage(l.src, () => {}); }
                if (img && img.complete && img.naturalWidth) {
                    ctx.save();
                    roundRectPath(ctx, x, y, w, h, radiusPx(l.radius, w, h));
                    ctx.clip();
                    ctx.globalAlpha = alpha;
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

    // 文字布局：measureText + 折行 + 缩字号 + 定位全部在这里算完并返回。
    // 「一处算、三处用」：drawText 用它画、layerBounds 用它框、画布内编辑器用它摆 textarea。
    // 以前这段埋在 drawText 里没有返回值，导致画布上的文字无法点选/编辑。
    function textLayout(ctx, raw, W, H) {
        const l = normalize(raw);
        if (!l || l.type !== 'text') return null;
        const x = clamp01(l.x || 0) * W;
        const y = clamp01(l.y || 0) * H;
        const align = ['left', 'center', 'right'].includes(l.align) ? l.align : 'left';
        let size = sizePx(l.size, H);
        const weight = l.weight || 400;
        const fontFamily = l.font || 'sans-serif';
        const font = () => `${weight} ${size}px ${fontFamily}`;
        const rawTracking = Number(l.letterSpacing) || 0;
        const tracking = clamp(rawTracking > 1 ? rawTracking : rawTracking * size, 0, size * 0.5);
        const text = String(l.text == null ? '' : l.text);
        if (!text) return null;

        const measure = (s) => {
            ctx.font = font();
            ctx.textAlign = 'left';
            // 整串测量：保留连字/emoji 组合/阿拉伯文 shaping；字距按字符数线性叠加
            const n = Array.from(s).length;
            return Math.max(0, ctx.measureText(s).width + tracking * Math.max(0, n - 1));
        };
        const wrap = (maxW) => {
            const lines = [];
            let cur = '';
            for (const ch of Array.from(text)) {
                if (ch === '\n') { lines.push(cur); cur = ''; continue; }
                const test = cur + ch;
                if (cur && measure(test) > maxW) { lines.push(cur); cur = ch; }
                else cur = test;
            }
            if (cur || !lines.length) lines.push(cur);
            return lines;
        };
        const truncate = (line, maxW) => {
            if (measure(line) <= maxW + 0.5) return line;
            const ell = '…';
            let out = '';
            for (const ch of Array.from(line)) {
                if (measure(out + ch + ell) > maxW) break;
                out += ch;
            }
            return out ? out + ell : '';
        };

        const maxW = maxWidthPx(l.maxW, W,
            align === 'center' ? Math.min(x, W - x) * 2 : align === 'right' ? x : W - x);
        const maxLines = Math.max(1, Math.floor(Number(l.maxLines) || 3));
        let lines = [];
        // 先缩字号，再截断；保证最终每一行都放得进 maxW，整块放得进画布。
        for (let attempt = 0; attempt < 16; attempt++) {
            lines = wrap(maxW);
            const tooWide = lines.some((ln) => measure(ln) > maxW + 0.5);
            const tooMany = lines.length > maxLines;
            const lineH = size * 1.25;
            const blockH = (lines.length - 1) * lineH + size * 1.15;
            if (!tooWide && !tooMany && blockH <= H * 0.96) break;
            size *= 0.85;
            if (size <= 6) { size = 6; break; }
        }
        lines = wrap(maxW);
        if (lines.length > maxLines) lines.length = maxLines;
        lines = lines.map((ln) => truncate(ln, maxW)).filter((ln, i) => ln || i === 0);
        if (!lines.length) return null;

        const lineH = size * 1.25;
        const minY = size * 0.95;          // 预留 ascender
        const maxY = H - size * 0.25;      // 预留 descender，避免基线贴底被裁
        const firstY = clamp(y - (lines.length - 1) * lineH / 2, minY, Math.max(minY, maxY - (lines.length - 1) * lineH));
        const perLine = lines.map((ln, i) => {
            const w = measure(ln);
            let sx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
            sx = w <= W ? clamp(sx, 0, W - w) : 0;
            return { text: ln, x: sx, w, y: clamp(firstY + i * lineH, minY, maxY) };
        });
        const left = Math.min(...perLine.map((p) => p.x));
        const right = Math.max(...perLine.map((p) => p.x + p.w));
        const top = firstY - size * 0.95;
        const bottom = (perLine.length - 1) * lineH + firstY + size * 0.25;
        return {
            x, y, align, size, font: font(), weight, fontFamily, tracking,
            opacity: l.opacity != null ? clamp01(l.opacity) : 1,
            color: l.color || '#ffffff',
            lines, perLine, lineH, firstY, minY, maxY, maxW,
            left, top, lw: right - left, lh: bottom - top,
            cx: (left + right) / 2, cy: (top + bottom) / 2
        };
    }

    // 文字：布局结果直接绘制；measureText 的位置/折行/缩字号与 textLayout 完全一致。
    function drawText(ctx, raw, W, H) {
        const m = textLayout(ctx, raw, W, H);
        if (!m) return;
        ctx.save();
        try {
            ctx.beginPath();
            ctx.rect(0, 0, W, H);
            ctx.clip();
            ctx.font = m.font;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = withAlpha(m.color, m.opacity);
            for (const p of m.perLine) {
                if (!m.tracking) {
                    // 没有额外字距时整行绘制，浏览器保留连字与组合字符
                    ctx.fillText(p.text, p.x, p.y);
                    continue;
                }
                let cx = p.x;
                for (const ch of Array.from(p.text)) {
                    ctx.fillText(ch, cx, p.y);
                    cx += ctx.measureText(ch).width + m.tracking;
                }
            }
        } finally { ctx.restore(); }
    }

    // ── 画布直接编辑用的纯几何工具（不碰渲染状态，Node 单测也能跑）──
    // 统一返回画布像素矩形；所有输入坐标都是 0..1 比例。
    function layerBounds(ctx, raw, W, H) {
        const l = normalize(raw);
        if (!l) return null;
        const px = (v) => clamp01(v) * W;
        const py = (v) => clamp01(v) * H;
        if (l.type === 'rect' || l.type === 'image' || l.type === 'photo') {
            const x = px(l.x || 0), y = py(l.y || 0), w = px(l.w || 0), h = py(l.h || 0);
            return w > 0 && h > 0 ? { x, y, w, h } : null;
        }
        if (l.type === 'circle') {
            const r0 = Number(l.r) || 0;
            const r = clamp(r0 > 1 ? r0 : r0 * Math.min(W, H), 0, Math.min(W, H) / 2);
            if (r <= 0) return null;
            return { x: px(l.cx || 0) - r, y: py(l.cy || 0) - r, w: r * 2, h: r * 2 };
        }
        if (l.type === 'line') {
            const x1 = px(l.x1 || 0), y1 = py(l.y1 || 0), x2 = px(l.x2 || 0), y2 = py(l.y2 || 0);
            const lw = clamp(Number(l.width || l.strokeWidth) || 1, 0.5, 40) / 2;
            return {
                x: Math.min(x1, x2) - lw, y: Math.min(y1, y2) - lw,
                w: Math.abs(x2 - x1) + lw * 2, h: Math.abs(y2 - y1) + lw * 2
            };
        }
        if (l.type === 'text') {
            const m = textLayout(ctx, l, W, H);
            if (!m) return null;
            return { x: m.left, y: m.top, w: m.lw, h: m.lh };
        }
        return null;
    }

    // 从最上层往下找；数组顺序就是 z 序（见文件头）。
    function hitTest(ctx, layers, px, py, W, H, tol) {
        const arr = Array.isArray(layers) ? layers : [];
        const d = Math.max(0, Number(tol) || 0);
        for (let i = arr.length - 1; i >= 0; i--) {
            const b = layerBounds(ctx, arr[i], W, H);
            if (!b) continue;
            if (px >= b.x - d && px <= b.x + b.w + d && py >= b.y - d && py <= b.y + b.h + d) {
                return { index: i, layer: arr[i], bounds: b };
            }
        }
        return null;
    }

    // 图层的「可拖动锚点」（中心）：rect/image/photo/text 用自身中心，circle 用圆心，line 用中点。
    function layerCenter(raw, W, H) {
        const l = normalize(raw);
        if (!l) return null;
        const px = (v) => clamp01(v) * W;
        const py = (v) => clamp01(v) * H;
        if (l.type === 'circle') return { x: px(l.cx || 0), y: py(l.cy || 0) };
        if (l.type === 'line') {
            return { x: (px(l.x1 || 0) + px(l.x2 || 0)) / 2, y: (py(l.y1 || 0) + py(l.y2 || 0)) / 2 };
        }
        const w = px(l.w || 0), h = py(l.h || 0);
        return { x: px(l.x || 0) + (l.type === 'text' ? 0 : w / 2), y: py(l.y || 0) + (l.type === 'text' ? 0 : h / 2) };
    }

    // 写回中心（比例坐标）。直接改原对象，保证画布引用和 template.aiLayers 是同一份。
    function setLayerCenter(raw, cx, cy, W, H) {
        const l = raw;
        if (!l || typeof l !== 'object') return false;
        const u = clamp(Number(cx) / Math.max(1, W) || 0, 0, 1);
        const v = clamp(Number(cy) / Math.max(1, H) || 0, 0, 1);
        if (l.type === 'circle') { l.cx = u; l.cy = v; return true; }
        if (l.type === 'line') {
            const mx = (clamp01(l.x1 || 0) + clamp01(l.x2 || 0)) / 2;
            const my = (clamp01(l.y1 || 0) + clamp01(l.y2 || 0)) / 2;
            const dx = u - mx, dy = v - my;
            l.x1 = clamp01(clamp01(l.x1 || 0) + dx); l.x2 = clamp01(clamp01(l.x2 || 0) + dx);
            l.y1 = clamp01(clamp01(l.y1 || 0) + dy); l.y2 = clamp01(clamp01(l.y2 || 0) + dy);
            return true;
        }
        if (l.type === 'text') { l.x = u; l.y = v; return true; }
        const w = clamp01(l.w || 0), h = clamp01(l.h || 0);
        l.x = clamp(u - w / 2, 0, Math.max(0, 1 - w));
        l.y = clamp(v - h / 2, 0, Math.max(0, 1 - h));
        return true;
    }

    function moveLayer(raw, du, dv, W, H) {
        const c = layerCenter(raw, W, H);
        if (!c) return false;
        return setLayerCenter(raw, c.x + (Number(du) || 0), c.y + (Number(dv) || 0), W, H);
    }

    // 拖角缩放：文字改字号，圆改半径，线改端点，框类改 w/h 并保持中心。
    function scaleLayer(raw, ratio, W, H) {
        const l = raw;
        if (!l || typeof l !== 'object') return false;
        const r = clamp(Number(ratio) || 1, 0.05, 20);
        if (l.type === 'text') {
            const px = (Number(l.size) || 0.04) * H;
            const next = clamp(px * r, 6, H * 0.2);
            l.size = Math.round((next / H) * 10000) / 10000;
            return true;
        }
        if (l.type === 'circle') {
            const r0 = Number(l.r) || 0;
            l.r = r0 > 1 ? r0 * r : r0 * r;
            return true;
        }
        if (l.type === 'line') {
            const mx = (clamp01(l.x1 || 0) + clamp01(l.x2 || 0)) / 2;
            const my = (clamp01(l.y1 || 0) + clamp01(l.y2 || 0)) / 2;
            l.x1 = clamp(mx + (clamp01(l.x1 || 0) - mx) * r, 0, 1);
            l.x2 = clamp(mx + (clamp01(l.x2 || 0) - mx) * r, 0, 1);
            l.y1 = clamp(my + (clamp01(l.y1 || 0) - my) * r, 0, 1);
            l.y2 = clamp(my + (clamp01(l.y2 || 0) - my) * r, 0, 1);
            return true;
        }
        const w = clamp(clamp01(l.w || 0) * r, 0.02, 1);
        const h = clamp(clamp01(l.h || 0) * r, 0.02, 1);
        const c = layerCenter(l, W, H);
        l.w = w; l.h = h;
        setLayerCenter(l, c.x, c.y, W, H);
        return true;
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

    // 画整组图层（从底到顶）。filter(layer) 为真才画，用于分阶段合成。
    function render(ctx, layers, W, H, onLoad, filter) {
        const arr = Array.isArray(layers) ? layers : [];
        for (const l of arr) if (!filter || filter(l)) drawLayer(ctx, l, W, H, _imgs);
        for (const l of arr) {
            if (l && l.type === 'image' && l.src) {
                const img = _imgs.get(l.src);
                if (img && !img.__notified && img.complete) { img.__notified = true; if (onLoad) onLoad(); }
                else if (img && !img.complete) { const old = img.onload; img.onload = () => { old && old(); if (onLoad) onLoad(); }; }
            }
        }
    }

    function findPhotoIndex(layers) {
        const arr = Array.isArray(layers) ? layers : [];
        for (let i = 0; i < arr.length; i++) {
            const l = arr[i];
            if (l && String(l.type || '').toLowerCase() === 'photo') return i;
        }
        return -1;
    }

    // 没有 photo 槽位时的兜底：放在“开头的大面积卡纸”之后，避免文字被照片压住。
    function fallbackPhotoIndex(layers) {
        const arr = Array.isArray(layers) ? layers : [];
        let idx = 0;
        for (let i = 0; i < arr.length; i++) {
            const l = arr[i];
            if (!l) continue;
            if (l.type === 'rect') {
                const area = (Number(l.w) || 0) * (Number(l.h) || 0);
                const op = l.fillOpacity == null ? 1 : Number(l.fillOpacity);
                if (area > 0.45 && op > 0.5) idx = i + 1;
            } else if (l.type !== 'photo') break;
        }
        return idx;
    }

    function photoSlot(layer) {
        const src = layer || {};
        let x = clamp01(src.x != null ? src.x : 0.08);
        let y = clamp01(src.y != null ? src.y : 0.08);
        let w = clamp(Number(src.w) || 0.84, 0.02, 1 - x);
        let h = clamp(Number(src.h) || 0.84, 0.02, 1 - y);
        if (!(w > 0.02)) w = Math.max(0.02, 1 - x);
        if (!(h > 0.02)) h = Math.max(0.02, 1 - y);
        return {
            x, y, w, h,
            radius: Number(src.radius) || 0,
            fit: src.fit === 'contain' ? 'contain' : 'cover'
        };
    }

    // 画布尺寸：让 photo 槽位的像素比例 = 照片比例（照片不被拉伸），
    // 再用 maxEdge / maxBase 限制预览/基准分辨率。
    function computeFrameSize(photoW, photoH, layers, opts) {
        const arr = Array.isArray(layers) ? layers : [];
        const pi = findPhotoIndex(arr);
        const slot = photoSlot(pi >= 0 ? arr[pi] : null);
        const nw = Math.max(1, Number(photoW) || 1);
        const nh = Math.max(1, Number(photoH) || 1);
        let W = nw / slot.w;
        let H = W * (slot.w / slot.h) * (nh / nw);
        if (!Number.isFinite(W) || W <= 0) W = 1000;
        if (!Number.isFinite(H) || H <= 0) H = W * (nh / nw);
        const rawCap = Number((opts && (opts.maxEdge || opts.maxBase)) || 0);
        const cap = rawCap > 0 ? rawCap : 0;
        if (cap && Math.max(W, H) > cap) {
            const k = cap / Math.max(W, H);
            W *= k; H *= k;
        }
        return {
            W: Math.max(1, Math.round(W)),
            H: Math.max(1, Math.round(H)),
            slot,
            photoIndex: pi
        };
    }

    // 把照片 cover/contain 画进槽位（带圆角裁剪）
    function drawPhoto(ctx, img, W, H, slot) {
        if (!img) return;
        const nw = img.naturalWidth || img.width || 0;
        const nh = img.naturalHeight || img.height || 0;
        if (!nw || !nh) return;
        const x = slot.x * W, y = slot.y * H, w = slot.w * W, h = slot.h * H;
        if (w <= 0 || h <= 0) return;
        ctx.save();
        try {
            roundRectPath(ctx, x, y, w, h, radiusPx(slot.radius, w, h));
            ctx.clip();
            if (slot.fit === 'contain') {
                const s = Math.min(w / nw, h / nh);
                const dw = nw * s, dh = nh * s;
                ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
            } else {
                const s = Math.max(w / nw, h / nh);
                const dw = nw * s, dh = nh * s;
                ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
            }
        } finally { ctx.restore(); }
    }

    // 预览合成：返回 canvas；与引擎使用同一套尺寸/槽位/图层顺序。
    function renderToCanvas(doc, img, opts) {
        if (!img) return null;
        const layers = Array.isArray(doc) ? doc
            : (doc && Array.isArray(doc.layers) ? doc.layers
                : (doc && Array.isArray(doc.aiLayers) ? doc.aiLayers : []));
        const nw = img.naturalWidth || img.width || 0;
        const nh = img.naturalHeight || img.height || 0;
        if (!nw || !nh) return null;
        const size = computeFrameSize(nw, nh, layers, opts || {});
        const cv = document.createElement('canvas');
        cv.width = size.W; cv.height = size.H;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = (opts && opts.background) || (doc && doc.aiBackground) || '#ffffff';
        ctx.fillRect(0, 0, size.W, size.H);
        const pi = size.photoIndex >= 0 ? size.photoIndex : fallbackPhotoIndex(layers);
        render(ctx, layers.slice(0, pi), size.W, size.H, null);
        drawPhoto(ctx, img, size.W, size.H, size.slot);
        render(ctx, layers.slice(pi + 1), size.W, size.H, null);
        return cv;
    }

    return {
        TYPES, normalize, withAlpha, drawLayer, drawText, textLayout, render, loadImage,
        findPhotoIndex, fallbackPhotoIndex, photoSlot, computeFrameSize, drawPhoto, renderToCanvas,
        layerBounds, hitTest, layerCenter, moveLayer, setLayerCenter, scaleLayer
    };
});

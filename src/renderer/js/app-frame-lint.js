'use strict';
/* 边框体检：生成之后先自己看一眼，再拿给用户。
 *
 * 模型能写出「结构正确但视觉站不住」的方案：文字压在主体上、白字配浅底、
 * 照片槽位窄成一条缝、装饰层把照片盖掉。这些都能用几何 + WCAG 对比度算出来，
 * 而且大半能自动修好，不必再花一轮生成。
 *
 * lint(doc, opts)      → { issues:[{code,level,layer,msg}], size }
 * autofix(doc, opts)   → { doc, fixes:[code], issues:[剩余] }
 * checkAndFix(doc, ..) → 上面两个的组合，面板直接用这个
 * boldness(doc, opts)  → { score:0~100, grade, hints }，判断「够不够大胆」，只读不修
 *
 * opts: { bg, photo:{ar, lumaMean}, ctx, W, H }，ctx 只在 Node 测试里需要传。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FrameLint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const clone = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; } };
    const layersOf = (doc) => (Array.isArray(doc) ? doc
        : (doc && Array.isArray(doc.layers) ? doc.layers
            : (doc && Array.isArray(doc.aiLayers) ? doc.aiLayers : [])));

    function Ai() {
        if (typeof window !== 'undefined' && window.AiLayers) return window.AiLayers;
        try { return require('./app-ai-layers.js'); } catch (_) { return null; }
    }

    // ── 颜色 ──
    function parseColor(c) {
        if (c && typeof c === 'object' && Number.isFinite(c.r)) return c;
        const s = String(c == null ? '' : c).trim();
        const hex = s.match(/^#([0-9a-f]{3,8})$/i);
        if (hex) {
            let h = hex[1];
            if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
            const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
            const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
            return [r, g, b].every(Number.isFinite) ? { r, g, b, a } : null;
        }
        const m = s.match(/^rgba?\(\s*([^)]+)\)$/i);
        if (m) {
            const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
            if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) {
                return { r: clamp(p[0], 0, 255), g: clamp(p[1], 0, 255), b: clamp(p[2], 0, 255), a: p.length > 3 ? clamp(p[3], 0, 1) : 1 };
            }
        }
        return null;
    }
    function relLum(c) {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    }
    function contrast(a, b) {
        if (!a || !b) return 21;
        const l1 = Math.max(relLum(a), relLum(b)), l2 = Math.min(relLum(a), relLum(b));
        return (l1 + 0.05) / (l2 + 0.05);
    }
    const gray = (v) => ({ r: v, g: v, b: v, a: 1 });

    // ── 几何 ──
    function sizeFor(doc, photoAr) {
        const layers = layersOf(doc);
        const slot = layers.find((l) => l && l.type === 'photo');
        const H = 1200;
        if (slot && photoAr > 0) {
            const sw = Math.max(0.02, Number(slot.w) || 0.8);
            const sh = Math.max(0.02, Number(slot.h) || 0.8);
            const W = Math.round(H * (photoAr * sh) / sw);
            return { W: clamp(W, 300, 4000), H };
        }
        return { W: 1500, H: 1200 };
    }
    function boundsOf(ctx, layer, W, H) {
        const L = Ai();
        if (!L || !L.layerBounds) return null;
        try { return L.layerBounds(ctx, layer, W, H); } catch (_) { return null; }
    }
    function area(b) { return b ? Math.max(0, b.w) * Math.max(0, b.h) : 0; }
    function overlapArea(a, b) {
        if (!a || !b) return 0;
        const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        return x * y;
    }
    const inside = (b, x, y) => !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

    function bgAt(layers, ctx, idx, x, y, W, H, opts) {
        for (let i = idx - 1; i >= 0; i--) {
            const l = layers[i];
            if (!l) continue;
            const b = boundsOf(ctx, l, W, H);
            if (!inside(b, x, y)) continue;
            if (l.type === 'photo') {
                const mean = opts.photo && Number.isFinite(opts.photo.lumaMean) ? opts.photo.lumaMean : 128;
                return { kind: 'photo', color: gray(mean) };
            }
            if (l.type === 'rect' || l.type === 'circle') {
                const op = (l.fillOpacity == null ? 1 : Number(l.fillOpacity)) * (l.opacity == null ? 1 : Number(l.opacity));
                if (!l.fill || !(op >= 0.5)) continue;
                const c = parseColor(l.fill);
                if (c) return { kind: 'fill', color: c };
            }
        }
        return { kind: 'canvas', color: parseColor(opts.bg || '#ffffff') || gray(255) };
    }

    // 文字框里取 5 个采样点，挑最差的那个：一块文字压在照片边缘时，
    // 只看中心会漏掉「一半在照片上、一半在白底上」这种最糟情况。
    function samplePoints(b) {
        return [
            [b.x + b.w / 2, b.y + b.h / 2], [b.x + 4, b.y + b.h / 2], [b.x + b.w - 4, b.y + b.h / 2],
            [b.x + b.w / 2, b.y + 4], [b.x + b.w / 2, b.y + b.h - 4]
        ];
    }
    function worstBg(layers, ctx, idx, box, fg, W, H, opts) {
        let worst = { ratio: 21, bg: null, x: 0, y: 0 };
        for (const [x, y] of samplePoints(box)) {
            const bg = bgAt(layers, ctx, idx, x, y, W, H, opts);
            const cr = contrast(fg, bg.color);
            if (cr < worst.ratio) worst = { ratio: cr, bg, x, y };
        }
        return worst;
    }

    function textBox(l, b) {
        // textLayout 已经把行夹在画布内，但极端字号/超长仍可能溢出；这里以 bounds 为准
        return b;
    }

    // ── 大胆度 ──
    // 保守款有稳定的几何特征：照片四边等宽内缩、没有展示字、没有任何层压过照片。
    // 破格款也有：至少一边贴画布、大字号压图、色块/文字占住照片的一部分。
    // 把它算成 0~100，才能回答「这版到底够不够狠」，而不是各人说各人的感觉。
    function boldness(doc, opts) {
        const o = opts || {};
        const layers = layersOf(doc);
        const size = (o.W && o.H) ? { W: o.W, H: o.H } : sizeFor(doc, o.photo && o.photo.ar);
        const W = size.W, H = size.H;
        const ctx = o.ctx || makeCtx();
        const pi = layers.findIndex((l) => l && l.type === 'photo');
        if (pi < 0) return { score: 0, grade: '无槽位', parts: {}, hints: ['没有照片槽位'], size };
        const pb = boundsOf(ctx, layers[pi], W, H);
        if (!pb || !area(pb)) return { score: 0, grade: '无槽位', parts: {}, hints: ['照片槽位尺寸为零'], size };

        const px = Math.max(1, Math.min(W, H)) * 0.004;   // 贴边容差 ≈ 千分之四
        const edges = (pb.x <= px ? 1 : 0) + (pb.y <= px ? 1 : 0)
            + (pb.x + pb.w >= W - px ? 1 : 0) + (pb.y + pb.h >= H - px ? 1 : 0);
        const share = area(pb) / (W * H);

        let maxSize = 0, onPhoto = 0, textEdge = 0, deco = 0, decoArea = 0, blockOn = 0;
        layers.forEach((l, i) => {
            if (!l) return;
            if (l.type === 'text') {
                maxSize = Math.max(maxSize, Number(l.size) || 0);
                const b = boundsOf(ctx, l, W, H);
                if (!b) return;
                const tb = textBox(l, b);
                if (area(tb) && overlapArea(tb, pb) / area(tb) > 0.5) onPhoto++;
                if (tb.x <= px || tb.y <= px || tb.x + tb.w >= W - px || tb.y + tb.h >= H - px) textEdge++;
                return;
            }
            if (l.type === 'photo') return;
            if (i <= pi) return;              // 照片下面的背景不算装饰
            deco++;
            const b = boundsOf(ctx, l, W, H);
            if (area(b)) decoArea += area(b) / (W * H);
            if (!l.fill) return;
            const op = (l.fillOpacity == null ? 1 : Number(l.fillOpacity)) * (l.opacity == null ? 1 : Number(l.opacity));
            if (op < 0.5) return;
            if (!area(b)) return;
            blockOn = Math.max(blockOn, overlapArea(b, pb) / area(pb));
        });

        const off = Math.abs((pb.x + pb.w / 2) / W - 0.5);
        const p = {};
        p.edge = Math.min(21, edges * 7);
        p.share = share >= 0.88 ? 20 : share >= 0.70 ? 8 : share >= 0.45 ? 2 : (edges ? 12 : 6);
        p.display = maxSize >= 0.16 ? 26 : maxSize >= 0.13 ? 20 : maxSize >= 0.10 ? 14 : maxSize >= 0.08 ? 7 : 0;
        p.onPhoto = Math.min(18, onPhoto * 9);
        p.block = blockOn >= 0.30 ? 16 : blockOn >= 0.10 ? 11 : blockOn >= 0.04 ? 5 : 0;
        p.deco = decoArea >= 0.60 ? 12 : decoArea >= 0.30 ? 9 : decoArea >= 0.12 ? 5 : 0;
        p.textEdge = textEdge ? 6 : 0;
        p.offset = off >= 0.12 ? 5 : off >= 0.06 ? 2 : 0;

        let score = 0;
        for (const k in p) score += p[k];
        // 视觉重量：照片 + 照片上的色块合起来盖住多少版面。低于 45% 就是「空」，
        // 不是极简——极简的压场来自一个大到不可能忽略的元素，而不是没有元素。
        const mass = Math.min(1, share + decoArea);
        if (mass < 0.45) score -= 8;
        score = Math.round(clamp(score, 0, 100));
        const grade = score >= 70 ? '破格' : score >= 45 ? '大胆' : score >= 25 ? '常规' : '保守';

        const hints = [];
        if (!edges) hints.push('照片没有任何一边贴住画布，四边都在内缩');
        if (!edges && share >= 0.45 && share < 0.88) hints.push('照片停在「不大不小」的中间尺寸（占 ' + Math.round(share * 100) + '%）');
        if (maxSize < 0.08) hints.push('最大字号只有 ' + (maxSize * 100).toFixed(0) + '%，没有展示字（≥10%）');
        if (!onPhoto) hints.push('照片上一个字都没有，文字全在留白里');
        if (blockOn < 0.04) hints.push('没有色块/图形压过照片');
        if (decoArea < 0.12) hints.push('装饰层只覆盖 ' + Math.round(decoArea * 100) + '% 版面，缺少压场的大色块');
        if (mass < 0.45) hints.push('照片和色块只盖住 ' + Math.round(mass * 100) + '% 版面，剩下的是空白不是留白');

        return { score, grade, parts: p, size, edges, share, maxSize, onPhoto, blockOn, deco, decoArea, mass, canvasAr: W / H, offset: off, hints };
    }

    // ── 体检 ──
    function lint(doc, opts) {
        const o = Object.assign({ bg: '#ffffff' }, opts || {});
        const layers = layersOf(doc);
        const issues = [];
        const push = (code, level, layer, msg) => issues.push({ code, level, layer, msg });
        const size = (o.W && o.H) ? { W: o.W, H: o.H } : sizeFor(doc, o.photo && o.photo.ar);
        const W = size.W, H = size.H;
        const ctx = o.ctx || makeCtx();
        if (!layers.length) { push('empty', 'error', -1, '没有任何图层'); return { issues, size }; }

        const slots = [];
        layers.forEach((l, i) => { if (l && l.type === 'photo') slots.push(i); });
        if (!slots.length) push('no-photo', 'error', -1, '缺照片槽位');
        else if (slots.length > 1) push('multi-photo', 'error', slots[1], '照片槽位不止一个，照片会被重复绘制');
        const slotIdx = slots[0] >= 0 ? slots[0] : -1;
        const slot = slotIdx >= 0 ? layers[slotIdx] : null;
        const slotBox = slot ? boundsOf(ctx, slot, W, H) : null;

        // 画布比例由槽位反推，「照片占一条」天然会得到长卷——这是构图，不是错误。
        // 只有极端到照片已经无法辨认时才判错；正常范围只提醒。
        const canvasAr = W / H;
        if (canvasAr > 4.0 || canvasAr < 0.25) {
            push('canvas-extreme', 'error', -1, '画布比例 ' + canvasAr.toFixed(2) + ':1 太极端，照片会被裁到无法辨认；把槽位的 w/h 调回接近照片比例');
        } else if (canvasAr > 2.0 || canvasAr < 0.42) {
            push('canvas-extreme', 'warn', -1, '画布比例 ' + canvasAr.toFixed(2) + ':1，确认是有意的长卷/竖轴');
        }

        if (slotBox) {
            const shortPx = Math.min(slotBox.w, slotBox.h);
            const shortShare = shortPx / Math.min(W, H);
            const shareArea = area(slotBox) / (W * H);            // 用「照片占画面多少」判断可读性，而不是短边比例：
            // 画布尺寸本身由槽位反推，短边占比会被算成恒定值，量不出「一条缝」。
            // 只有小到导出后看不清、或细成一根线，才算结构错误；「占一侧的条带」是设计。
            if (shareArea < 0.08 || shortShare < 0.10) {
                push('slot-narrow', 'error', slotIdx, '照片只占画面 ' + Math.round(shareArea * 100) + '%、短边 ' + Math.round(shortShare * 100) + '%，导出后看不清');
            } else if (shareArea < 0.15) {
                push('slot-narrow', 'warn', slotIdx, '照片只占画面 ' + Math.round(shareArea * 100) + '%，确认是有意的图版构图');
            } else if (shareArea < 0.22) {
                push('photo-small', 'warn', slotIdx, '照片只占画面 ' + Math.round(shareArea * 100) + '%，像贴纸');
            }
            if (o.photo && o.photo.ar > 0) {
                const slotAr = slotBox.w / Math.max(1, slotBox.h);
                const fit = String(slot.fit || 'cover').toLowerCase();
                const mismatch = Math.max(slotAr / o.photo.ar, o.photo.ar / slotAr);
                if (mismatch > 2.8) push('slot-crop', 'warn', slotIdx, '槽位比例与照片差太多（' + slotAr.toFixed(2) + ' vs ' + o.photo.ar.toFixed(2) + '），' + (fit === 'contain' ? '会留白边' : '会裁掉不少画面'));
            }
        }

        // 照片被后画的实心层盖住
        if (slotBox) {
            for (let i = slotIdx + 1; i < layers.length; i++) {
                const l = layers[i];
                if (!l || (l.type !== 'rect' && l.type !== 'circle')) continue;
                const op = (l.fillOpacity == null ? 1 : Number(l.fillOpacity)) * (l.opacity == null ? 1 : Number(l.opacity));
                if (!l.fill || op < 0.6) continue;
                const b = boundsOf(ctx, l, W, H);
                if (area(b) && overlapArea(b, slotBox) / area(slotBox) > 0.55) {
                    push('photo-covered', 'error', i, '这一层把照片盖掉了一大半');
                }
            }
        }

        // 文字：越小越难读，越界更糟
        let prevTexts = [];
        layers.forEach((l, i) => {
            if (!l || l.type !== 'text') return;
            const b = textBox(l, boundsOf(ctx, l, W, H));
            if (!b) { push('text-empty', 'warn', i, '空文字层'); return; }
            const sizePx = (Number(l.size) || 0.04) * H;
            if (sizePx < 10) push('text-tiny', 'error', i, '字号只有 ' + Math.round(sizePx) + 'px，导出后看不清');
            else if (sizePx < 16) push('text-small', 'warn', i, '字号偏小（' + Math.round(sizePx) + 'px）');
            if (sizePx > H * 0.22) push('text-huge', 'warn', i, '字号过大，会压住照片');
            if (b.x < -1 || b.y < -1 || b.x + b.w > W + 1 || b.y + b.h > H + 1) push('text-out', 'error', i, '文字超出画面');

            if (slotBox) {
                const cover = area(b) ? overlapArea(b, slotBox) / area(b) : 0;
                if (cover > 0.5) push('text-on-photo', 'warn', i, '文字有一半以上压在照片上');
            }
            // 对比度：取文字框里 5 个采样点里最差的那个
            const fg = parseColor(l.color || '#ffffff');
            const worst = worstBg(layers, ctx, i, b, fg, W, H, o);
            if (worst.ratio < 1.8) push('low-contrast', 'error', i, '文字和底色几乎同色（对比度 ' + worst.ratio.toFixed(1) + ':1）');
            else if (worst.ratio < 3) push('low-contrast', 'warn', i, '文字对比度偏低（' + worst.ratio.toFixed(1) + ':1）');

            for (const p of prevTexts) {
                if (area(b) && overlapArea(b, p) / Math.min(area(b), area(p) || 1) > 0.5) push('text-collision', 'warn', i, '两段文字叠在一起');
            }
            // 文字被后画的不透明层压住：模型常把「标签纸条」排在文字后面，标题只剩半截
            for (let j = i + 1; j < layers.length; j++) {
                const nl = layers[j];
                if (!nl || (nl.type !== 'rect' && nl.type !== 'circle' && nl.type !== 'image')) continue;
                const op = (nl.fillOpacity == null ? 1 : Number(nl.fillOpacity)) * (nl.opacity == null ? 1 : Number(nl.opacity));
                if (op < 0.6) continue;
                const nb = boundsOf(ctx, nl, W, H);
                if (!area(nb) || !area(b)) continue;
                if (overlapArea(b, nb) / area(b) > 0.4) push('text-covered', 'error', i, '文字被后面的不透明层压住');
            }
            prevTexts.push(b);
        });

        // 装饰层：完全在画面外 / 尺寸为零
        layers.forEach((l, i) => {
            if (!l || l.type === 'photo' || l.type === 'text') return;
            const b = boundsOf(ctx, l, W, H);
            if (!b || area(b) < 4) { push('degenerate', 'warn', i, '这一层尺寸为零，等于没画'); return; }
            if (b.x + b.w < 0 || b.y + b.h < 0 || b.x > W || b.y > H) push('off-canvas', 'warn', i, '这一层完全在画面外');
        });

        return { issues, size };
    }

    let _ctx = null;
    function makeCtx() {
        if (_ctx) return _ctx;
        try {
            const cv = document.createElement('canvas');
            cv.width = 8; cv.height = 8;
            _ctx = cv.getContext('2d');
        } catch (_) { _ctx = null; }
        return _ctx;
    }

    // ── 自动修正 ──
    function pickTextColor(bg) {
        if (!bg) return '#1a1a1a';
        return relLum(bg) > 0.45 ? '#1a1a1a' : '#f6f2e9';
    }

    function autofix(doc, opts) {
        const o = Object.assign({ bg: '#ffffff' }, opts || {});
        const out = clone(doc);
        const layers = layersOf(out);
        const fixes = [];
        if (!Array.isArray(layers) || !layers.length) return { doc: out, fixes, issues: [{ code: 'empty', level: 'error', layer: -1, msg: '没有任何图层' }] };
        const size = (o.W && o.H) ? { W: o.W, H: o.H } : sizeFor(out, o.photo && o.photo.ar);
        const W = size.W, H = size.H;
        const ctx = o.ctx || makeCtx();

        // 1) 多个槽位：留面积最大的那个
        const slots = [];
        layers.forEach((l, i) => { if (l && l.type === 'photo') slots.push(i); });
        if (slots.length > 1) {
            let keep = slots[0], best = -1;
            for (const i of slots) { const a = area(boundsOf(ctx, layers[i], W, H)); if (a > best) { best = a; keep = i; } }
            for (const i of slots.slice().reverse()) { if (i !== keep) { layers.splice(i, 1); fixes.push('multi-photo'); } }
        }
        // 2) 没有槽位：按最大的实心层内缩一块，实在没有就用八成版面
        if (!layers.some((l) => l && l.type === 'photo')) {
            let bgLayer = null, bgArea = 0;
            for (const l of layers) {
                if (!l || (l.type !== 'rect' && l.type !== 'circle') || !l.fill) continue;
                const op = (l.fillOpacity == null ? 1 : Number(l.fillOpacity)) * (l.opacity == null ? 1 : Number(l.opacity));
                const a = area(boundsOf(ctx, l, W, H));
                if (op >= 0.6 && a > bgArea) { bgArea = a; bgLayer = l; }
            }
            const base = bgLayer ? boundsOf(ctx, bgLayer, W, H) : null;
            const pad = base ? Math.min(24, Math.min(base.w, base.h) * 0.04) : 0;
            const slot = base
                ? {
                    type: 'photo', x: clamp((base.x + pad) / W, 0, 1), y: clamp((base.y + pad) / H, 0, 1),
                    w: clamp((base.w - pad * 2) / W, 0.1, 1), h: clamp((base.h - pad * 2) / H, 0.1, 1), fit: 'cover'
                }
                : { type: 'photo', x: 0.08, y: 0.08, w: 0.84, h: 0.76, fit: 'cover' };
            const at = bgLayer ? layers.indexOf(bgLayer) + 1 : 0;
            layers.splice(at, 0, slot);
            fixes.push('no-photo');
        }

        const slotIdx = () => layers.findIndex((l) => l && l.type === 'photo');
        const slotBoxNow = () => { const i = slotIdx(); return i >= 0 ? boundsOf(ctx, layers[i], W, H) : null; };

        // 3) 槽位小到看不清 / 细成一根线：放大到能看（面积 12%），并保住原本贴住的那几条边。
        //    「照片只占一侧」是设计，不是错误——阈值必须低到这里才不会把构图改回相框。
        for (let round = 0; round < 2; round++) {
            const b = slotBoxNow();
            if (!b) break;
            const shortPx = Math.min(b.w, b.h);
            const shortShare = shortPx / Math.min(W, H);
            const areaShare = area(b) / (W * H);
            if (areaShare >= 0.08 && shortShare >= 0.10) break;
            const slot = layers[slotIdx()];
            const kArea = Math.sqrt(0.12 / Math.max(0.001, areaShare));
            const kShort = shortShare < 0.12 ? (0.12 * Math.min(W, H)) / Math.max(1, shortPx) : 1;
            const k = Math.min(2.8, Math.max(kArea, kShort));
            const x0 = Number(slot.x) || 0, y0 = Number(slot.y) || 0;
            const w0 = Number(slot.w) || 0.8, h0 = Number(slot.h) || 0.8;
            const nw = Math.min(1, w0 * k);
            const nh = Math.min(1, h0 * k);
            const eps = 0.004;
            const leftEdge = x0 <= eps, rightEdge = x0 + w0 >= 1 - eps;
            const topEdge = y0 <= eps, bottomEdge = y0 + h0 >= 1 - eps;
            slot.w = nw; slot.h = nh;
            slot.x = leftEdge ? 0 : rightEdge ? 1 - nw : clamp(x0 + w0 / 2 - nw / 2, 0, 1 - nw);
            slot.y = topEdge ? 0 : bottomEdge ? 1 - nh : clamp(y0 + h0 / 2 - nh / 2, 0, 1 - nh);
            fixes.push('slot-narrow');
        }

        // 4) 照片被后画的实心层盖住：挪到照片下面（当背景），而不是删掉它
        const sb = slotBoxNow();
        if (sb) {
            const si = slotIdx();
            const offenders = [];
            for (let i = si + 1; i < layers.length; i++) {
                const l = layers[i];
                if (!l || (l.type !== 'rect' && l.type !== 'circle') || !l.fill) continue;
                const op = (l.fillOpacity == null ? 1 : Number(l.fillOpacity)) * (l.opacity == null ? 1 : Number(l.opacity));
                if (op < 0.6) continue;
                const b = boundsOf(ctx, l, W, H);
                if (!area(b) || overlapArea(b, sb) / area(sb) <= 0.55) continue;
                offenders.push(i);
            }
            for (let k = offenders.length - 1; k >= 0; k--) {
                const idx = offenders[k];
                const l = layers[idx];
                layers.splice(idx, 1);
                layers.splice(slotIdx(), 0, l);
                if (!fixes.includes('photo-covered')) fixes.push('photo-covered');
            }
        }

        // 4b) 文字被后面的不透明层压住：把那层挪到文字下面（标签纸本来就该垫在字底下）
        for (let round = 0; round < 3; round++) {
            let moved = false;
            for (let i = 0; i < layers.length && !moved; i++) {
                const l = layers[i];
                if (!l || l.type !== 'text') continue;
                const tb = boundsOf(ctx, l, W, H);
                if (!area(tb)) continue;
                for (let j = i + 1; j < layers.length; j++) {
                    const nl = layers[j];
                    if (!nl || (nl.type !== 'rect' && nl.type !== 'circle' && nl.type !== 'image')) continue;
                    const op = (nl.fillOpacity == null ? 1 : Number(nl.fillOpacity)) * (nl.opacity == null ? 1 : Number(nl.opacity));
                    if (op < 0.6) continue;
                    const nb = boundsOf(ctx, nl, W, H);
                    if (!area(nb) || overlapArea(tb, nb) / area(tb) <= 0.4) continue;
                    layers.splice(j, 1);
                    layers.splice(i, 0, nl);
                    fixes.push('text-covered');
                    moved = true;
                    break;
                }
            }
            if (!moved) break;
        }

        // 5) 文字：拉回画面 / 抬字号 / 补对比度 / 压照片就挪到留白带
        const slotFinal = slotBoxNow();
        layers.forEach((l, i) => {
            if (!l || l.type !== 'text') return;
            for (let round = 0; round < 3; round++) {
                const b = boundsOf(ctx, l, W, H);
                if (!b) return;
                const dx = b.x < 0 ? -b.x : (b.x + b.w > W ? W - (b.x + b.w) : 0);
                const dy = b.y < 0 ? -b.y : (b.y + b.h > H ? H - (b.y + b.h) : 0);
                if (!dx && !dy) break;
                l.x = clamp((Number(l.x) || 0) + dx / W, 0, 1);
                l.y = clamp((Number(l.y) || 0) + dy / H, 0, 1);
                fixes.push('text-out');
            }
            const sizePx = (Number(l.size) || 0.04) * H;
            if (sizePx < 16) {
                l.size = Math.round((16 / H) * 10000) / 10000;
                fixes.push('text-tiny');
            } else if (sizePx > H * 0.24) {
                l.size = 0.22;
                fixes.push('text-huge');
            }

            // 只有「看不清」才动手。压图文字先保设计：换色 + 加阴影，仍不够才挪到留白带。
            // 有意压在照片上的浅色标题不去碰它——对比度够就说明是设计，不是错误。
            const bb = boundsOf(ctx, l, W, H);
            if (!bb) return;
            const fg0 = parseColor(l.color || '#ffffff');
            const worst0 = worstBg(layers, ctx, i, bb, fg0, W, H, o);
            if (worst0.ratio >= 3) return;
            const overPhoto = !!slotFinal && area(bb) > 0 && overlapArea(bb, slotFinal) / area(bb) > 0.5;
            if (overPhoto && (Number(l.size) || 0.04) < 0.06) {
                // 小字压图看不清就挪走；展示字（≥6%）一律留在照片上——那是构图，不是错误
                const need = bb.h + 10;
                const above = slotFinal.y;
                const below = H - (slotFinal.y + slotFinal.h);
                const moveTo = above >= need + 6 ? (slotFinal.y - need / 2 - 4)
                    : below >= need + 6 ? (slotFinal.y + slotFinal.h + need / 2 + 4) : null;
                if (moveTo != null) {
                    l.y = clamp(moveTo / H, 0, 1);
                    fixes.push('text-off-photo');
                    const nb = boundsOf(ctx, l, W, H);
                    const nw = nb ? worstBg(layers, ctx, i, nb, fg0, W, H, o) : null;
                    if (nw && nw.ratio >= 3) return;
                    if (nw) { l.color = pickTextColor(nw.bg.color); fixes.push('low-contrast'); return; }
                }
            }
            l.color = pickTextColor(worst0.bg.color);
            if (overPhoto) {
                l.shadow = Object.assign({ color: '#000000', blur: 12, offsetX: 0, offsetY: 1, opacity: 0.45 }, l.shadow || {});
            }
            fixes.push('low-contrast');
        });

        // 6) 尺寸为零 / 画面外的装饰层：清掉
        for (let i = layers.length - 1; i >= 0; i--) {
            const l = layers[i];
            if (!l || l.type === 'photo' || l.type === 'text') continue;
            const b = boundsOf(ctx, l, W, H);
            if (!b || area(b) < 4) { layers.splice(i, 1); fixes.push('degenerate'); continue; }
            if (b.x + b.w < 0 || b.y + b.h < 0 || b.x > W || b.y > H) { layers.splice(i, 1); fixes.push('off-canvas'); }
        }

        // 去重，保持「修了什么」一眼能读
        const uniq = [];
        for (const f of fixes) if (!uniq.includes(f)) uniq.push(f);
        // 槽位被改过（放大/缩窄）后画布尺寸要重算，否则会用旧口径复查，误判「画布比例极端」
        const sizeAfter = sizeFor(out, o.photo && o.photo.ar);
        const after = lint(out, Object.assign({}, o, { W: sizeAfter.W, H: sizeAfter.H, ctx }));
        return { doc: out, fixes: uniq, issues: after.issues, size: sizeAfter };
    }

    function checkAndFix(doc, opts) {
        const before = lint(doc, opts);
        const fatal = before.issues.filter((x) => x.level === 'error');
        const r = autofix(doc, Object.assign({}, opts, { W: before.size.W, H: before.size.H }));
        const remain = r.issues.filter((x) => x.level === 'error');
        return {
            doc: r.doc, fixes: r.fixes, issues: r.issues,
            before: before.issues, fatalBefore: fatal.length, fatalAfter: remain.length,
            usable: remain.length === 0,
            summary: summaryOf(r.fixes, r.issues)
        };
    }

    const LABEL = {
        'multi-photo': '多写的照片槽位', 'no-photo': '补照片槽位', 'slot-narrow': '放宽照片槽位',
        'photo-covered': '被装饰层盖住的照片', 'text-covered': '被压住的文字', 'canvas-extreme': '极端画布比例',
        'text-out': '越界文字', 'text-tiny': '过小字号',
        'text-huge': '过大字号', 'text-off-photo': '压住主体的文字', 'low-contrast': '对比度',
        'degenerate': '空图层', 'off-canvas': '画面外图层'
    };
    function summaryOf(fixes, issues) {
        const warn = (issues || []).filter((x) => x.level === 'warn').length;
        const parts = [];
        if (fixes && fixes.length) parts.push('已自动修正 ' + fixes.length + ' 处（' + fixes.map((f) => LABEL[f] || f).join('、') + '）');
        if (warn) parts.push('还有 ' + warn + ' 处提醒');
        return parts.join('，');
    }
    function describe(issues) {
        return (issues || []).map((x) => '· ' + x.msg).join('\n');
    }

    return { lint, autofix, checkAndFix, boldness, contrast, parseColor, sizeFor, summaryOf, describe, LABEL };
});

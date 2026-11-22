'use strict';
/* 本地智能配方：不调模型，也能稳定出 4 款「像设计师做的」边框。
 *
 * 为什么需要它：
 *   - 本机助手要装 CLI、API 要填 Key，第一次用的人经常卡在配置；
 *   - 让模型直接写 0..1 坐标，很容易出「照片缩在中间 + 四边等宽 + 大字乱压」；
 *   - 生成一轮要等几十秒，失败还得重来。
 *
 * 这里把「排版」交给确定性的配方，把「选风格/配色/文案」交给照片速写与关键词。
 * 每个配方都按真实画布比例反算 photo 槽位，文字带 maxW/maxLines，颜色先过对比度。
 * 输出仍是标准图层文档，渲染、微调、导出、历史全部复用现有链路。
 *
 * 纯函数模块：Node 单测与渲染层共用。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FrameRecipes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const FONTS = {
        serif: "Georgia, 'Times New Roman', 'Songti SC', 'Noto Serif SC', serif",
        sans: "'Helvetica Neue', Arial, 'PingFang SC', 'Noto Sans SC', sans-serif",
        mono: "'Courier New', 'SFMono-Regular', Consolas, monospace"
    };

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;

    // ── 颜色 ────────────────────────────────────────────────────
    function parseHex(hex) {
        const h = String(hex || '').replace('#', '').trim();
        if (!/^[0-9a-f]{3,8}$/i.test(h)) return null;
        let s = h;
        if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
        if (s.length !== 6 && s.length !== 8) return null;
        return {
            r: parseInt(s.slice(0, 2), 16),
            g: parseInt(s.slice(2, 4), 16),
            b: parseInt(s.slice(4, 6), 16)
        };
    }
    function toHex(c) {
        const p = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
        return '#' + p(c.r) + p(c.g) + p(c.b);
    }
    function mix(a, b, t) {
        const A = parseHex(a) || { r: 0, g: 0, b: 0 };
        const B = parseHex(b) || { r: 255, g: 255, b: 255 };
        const k = clamp(t, 0, 1);
        return toHex({ r: A.r + (B.r - A.r) * k, g: A.g + (B.g - A.g) * k, b: A.b + (B.b - A.b) * k });
    }
    function relLum(c) {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    }
    function contrast(a, b) {
        const A = parseHex(a), B = parseHex(b);
        if (!A || !B) return 21;
        const l1 = Math.max(relLum(A), relLum(B)), l2 = Math.min(relLum(A), relLum(B));
        return (l1 + 0.05) / (l2 + 0.05);
    }
    function satOf(hex) {
        const c = parseHex(hex);
        if (!c) return 0;
        const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
        return mx ? (mx - mn) / mx : 0;
    }
    // 把颜色往黑/白推，直到和目标底色达到指定对比度；推不动就取黑或白。
    function ensureContrast(color, bg, min) {
        const target = num(min, 3);
        if (contrast(color, bg) >= target) return color;
        const c = parseHex(color) || { r: 0, g: 0, b: 0 };
        const dark = { r: 0, g: 0, b: 0 }, light = { r: 255, g: 255, b: 255 };
        const to = relLum(parseHex(bg) || { r: 255, g: 255, b: 255 }) > 0.45 ? dark : light;
        for (let i = 1; i <= 20; i++) {
            const t = i / 20;
            const out = toHex({
                r: c.r + (to.r - c.r) * t,
                g: c.g + (to.g - c.g) * t,
                b: c.b + (to.b - c.b) * t
            });
            if (contrast(out, bg) >= target) return out;
        }
        return to === dark ? '#000000' : '#ffffff';
    }

    // ── 随机 ────────────────────────────────────────────────────
    function hash(str) {
        let h = 2166136261;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }
    function rng(seed) {
        let a = seed >>> 0;
        return function () {
            a += 0x6D2B79F5;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // ── 图层小工具 ──────────────────────────────────────────────
    function rect(x, y, w, h, fill, opt) {
        return Object.assign({
            type: 'rect', x, y, w, h,
            fill: fill || null,
            fillOpacity: fill ? 1 : 0
        }, opt || {});
    }
    function circle(cx, cy, r, fill, opt) {
        return Object.assign({
            type: 'circle', cx, cy, r, fill: fill || null,
            fillOpacity: fill ? 1 : 0
        }, opt || {});
    }
    function line(x1, y1, x2, y2, color, width, opt) {
        return Object.assign({
            type: 'line', x1, y1, x2, y2,
            color: color || '#000000', width: width || 1
        }, opt || {});
    }
    function photo(x, y, w, h, opt) {
        return Object.assign({ type: 'photo', x, y, w, h, fit: 'cover' }, opt || {});
    }
    function text(str, x, y, size, color, opt) {
        const o = opt || {};
        return {
            type: 'text', x, y, text: String(str == null ? '' : str),
            size, color: color || '#111111',
            font: o.font || FONTS.sans,
            align: o.align || 'left',
            weight: o.weight || 400,
            letterSpacing: o.letterSpacing == null ? 0 : o.letterSpacing,
            maxW: o.maxW == null ? 0.9 : o.maxW,
            maxLines: o.maxLines == null ? 1 : o.maxLines,
            opacity: o.opacity == null ? 1 : o.opacity,
            shadow: o.shadow || undefined
        };
    }
    function doc(name, bg, layers) {
        return {
            templateName: name,
            aiBackground: bg,
            layers: layers.filter(Boolean),
            recipe: true
        };
    }

    // 画布比例固定后，反算 photo 槽位：槽位像素比例必须等于照片比例。
    // box 是槽位可用的归一化区域；返回的 w/h 已经满足 canvasAr。
    function fitSlotIn(photoAr, canvasAr, box) {
        const p = Math.max(0.2, num(photoAr, 1));
        const c = Math.max(0.4, num(canvasAr, 1));
        const x0 = clamp(num(box.x0, 0), 0, 1), y0 = clamp(num(box.y0, 0), 0, 1);
        const x1 = clamp(num(box.x1, 1), x0 + 0.05, 1), y1 = clamp(num(box.y1, 1), y0 + 0.05, 1);
        const availW = x1 - x0, availH = y1 - y0;
        const slotAr = p / c;                 // 归一化 w/h
        let w = availW, h = w / slotAr;
        if (h > availH) { h = availH; w = h * slotAr; }
        return {
            x: x0 + (availW - w) / 2,
            y: y0 + (availH - h) / 2,
            w: Math.max(0.05, w),
            h: Math.max(0.05, h)
        };
    }
    function canvasArFor(id, photoAr) {
        const p = Math.max(0.2, num(photoAr, 1));
        // 画布比例尽量贴着照片走：差得越远，槽位越小、留白越空，
        // 最后不是「满版」而是「照片缩在纸中间」。
        if (id === 'fullbleed') return clamp(p, 0.35, 2.6);
        if (id === 'magazine') return clamp(p, 0.55, 1.55);
        if (id === 'ticket') return clamp(p * 1.2, 0.8, 1.55);
        if (id === 'duotone') return clamp(p * 1.05, 0.6, 1.25);
        if (id === 'minimal') return clamp(p * 1.1, 0.55, 1.3);
        if (id === 'poster') return p < 1.05 ? clamp(p, 0.45, 0.95) : 1.12;
        if (id === 'journal') return clamp(p * 1.05, 0.55, 1.3);
        if (id === 'split') return p >= 1.05 ? 1.12 : 1.32;
        return p > 1.12 ? 1.36 : p < 0.88 ? 0.82 : 1.0;   // gallery
    }

    // ── 文案 ────────────────────────────────────────────────────
    const STYLE_WORDS = /海报|展览|胶片|极简|留白|手账|拼贴|杂志|封面|档案|复古|边框|大字|标题|排版|poster|film|minimal|journal|magazine|archive|vintage|cover|layout/i;
    function pickTitle(prompt) {
        const p = String(prompt || '');
        const q = /「([^」]{1,16})」|“([^”]{1,16})”|"([^"]{1,16})"|《([^》]{1,16})》/.exec(p);
        if (q) return (q[1] || q[2] || q[3] || q[4] || '').trim();
        const cleaned = p.replace(/[，。！？、,.!?：:；;]/g, '').trim();
        if (cleaned && cleaned.length <= 8 && !STYLE_WORDS.test(cleaned)) return cleaned;
        const year = new Date().getFullYear();
        return 'STILL / ' + year;
    }
    function pickSubtitle(prompt, exif) {
        const p = String(prompt || '');
        if (/手账|日记|旅行|journal|travel/i.test(p)) return 'NOTES FROM THE ROAD';
        if (/胶片|复古|film|vintage/i.test(p)) return 'A FRAME FROM THE ARCHIVE';
        if (/极简|留白|minimal|quiet/i.test(p)) return 'LESS, BUT BETTER';
        const bits = [];
        const e = exif || {};
        if (e.focal) bits.push(String(e.focal).toUpperCase());
        if (e.aperture) bits.push(String(e.aperture));
        if (e.shutter) bits.push(String(e.shutter));
        if (e.iso) bits.push('ISO ' + String(e.iso).replace(/^ISO\s*/i, ''));
        if (bits.length >= 2) return bits.slice(0, 4).join(' · ');
        return 'A PHOTOGRAPH';
    }
    function pickMeta(exif) {
        const e = exif || {};
        const bits = [];
        const model = [e.make, e.model].filter(Boolean).join(' ').trim();
        if (model) bits.push(model.toUpperCase());
        const shot = [e.focal, e.aperture, e.shutter, e.iso ? 'ISO ' + String(e.iso).replace(/^ISO\s*/i, '') : '']
            .filter(Boolean).join(' · ');
        if (shot) bits.push(shot);
        const d = new Date();
        bits.push(d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0'));
        return bits.join('\n');
    }

    // ── 配色 ────────────────────────────────────────────────────
    const ACCENTS = ['#B4472F', '#B07A2A', '#2E6F68', '#2F4E7A', '#6B6F3A', '#8C3B5A', '#3E6B4F'];
    function pickAccent(brief, prompt, seed) {
        const b = brief || {};
        const fromPhoto = [b.accent && b.accent.hex, b.dominant && b.dominant.hex]
            .filter(Boolean).find((h) => satOf(h) >= 0.28 && contrast(h, '#ffffff') > 1.2);
        if (fromPhoto && /照片|photo|自然|原色|配色/i.test(String(prompt || ''))) return fromPhoto;
        const rand = rng(hash('accent' + seed + String(prompt || '')));
        return ACCENTS[Math.floor(rand() * ACCENTS.length) % ACCENTS.length];
    }
    function paletteFor(prompt, brief, seed) {
        const p = String(prompt || '');
        const b = brief || {};
        const tone = b.luma && b.luma.tone;
        const night = /夜|黑|暗|night|dark|moody|noir/i.test(p) || tone === '偏暗';
        const cool = /极简|白|干净|冷|minimal|clean|cool|quiet/i.test(p);
        const warm = /复古|暖|胶片|档案|秋|warm|vintage|film|archive/i.test(p);
        let paper = night ? '#141414' : cool ? '#F2F4F2' : warm ? '#F3EDE2' : '#F4F0E8';
        let ink = night ? '#F2ECE0' : '#1C1A17';
        let accent = pickAccent(b, p, seed);
        // 深色纸上的强调色要够亮，否则整块糊在一起。
        if (night && relLum(parseHex(accent) || { r: 0, g: 0, b: 0 }) < 0.18) {
            accent = mix(accent, '#ffffff', 0.42);
        }
        accent = ensureContrast(accent, paper, 2.4);
        const muted = mix(ink, paper, 0.46);
        const line = mix(ink, paper, 0.72);
        const onAccent = relLum(parseHex(accent) || { r: 0, g: 0, b: 0 }) > 0.46 ? '#111111' : '#F7F3EA';
        return { paper, ink, muted, line, accent, onAccent, tone: night ? 'night' : 'warm' };
    }

    // ── 配方 ────────────────────────────────────────────────────
    // 每个配方只做一件事，并且把「照片槽位、文字安全区、对比度」先算好。
    // 目标不是四款都抢眼，而是四款都站得住：一款安静、一款编辑感、一款海报、一款实验。

    function buildGallery(c) {
        const ar = canvasArFor('gallery', c.photoAr);
        const slot = fitSlotIn(c.photoAr, ar, { x0: 0.10, y0: 0.08, x1: 0.90, y1: 0.82 });
        return doc('留白画廊', c.pal.paper, [
            rect(slot.x - 0.012, slot.y - 0.012, slot.w + 0.024, slot.h + 0.024, c.pal.paper),
            photo(slot.x, slot.y, slot.w, slot.h),
            rect(slot.x, slot.y, slot.w, slot.h, null, { stroke: c.pal.line, strokeWidth: 1 }),
            line(0.10, 0.875, 0.44, 0.875, c.pal.line, 1),
            text(c.title, 0.10, 0.925, 0.040, c.pal.ink, {
                font: FONTS.serif, weight: 500, letterSpacing: 0.10, maxW: 0.56
            }),
            text(c.subtitle, 0.10, 0.958, 0.015, c.pal.muted, {
                letterSpacing: 0.16, maxW: 0.56
            }),
            text(c.index, 0.90, 0.925, 0.020, c.pal.ink, {
                align: 'right', letterSpacing: 0.12, maxW: 0.20
            }),
            text('QINGFRAME', 0.90, 0.958, 0.014, c.pal.muted, {
                align: 'right', letterSpacing: 0.20, maxW: 0.20
            })
        ]);
    }

    function buildFullbleed(c) {
        const ar = canvasArFor('fullbleed', c.photoAr);
        const slot = fitSlotIn(c.photoAr, ar, { x0: 0, y0: 0, x1: 1, y1: 1 });
        // 窄长画布上标题会折两行，底部信息带要更高，否则标题和副标题会撞在一起。
        const narrow = ar < 0.85;
        const band = narrow ? 0.30 : 0.24;
        const top = 1 - band;
        return doc('满版压字', c.pal.paper, [
            photo(slot.x, slot.y, slot.w, slot.h),
            rect(0, top, 1, band, c.pal.paper, { fillOpacity: 0.95 }),
            line(0.06, top + 0.035, 0.24, top + 0.035, c.pal.accent, 2),
            // 顶部小字压在照片上：一层淡墨顶光，亮天空上也读得清，不会像贴了两块灰补丁。
            rect(0, 0, 1, 0.13, '#000000', { fillOpacity: 0.24 }),
            text(c.title, 0.06, top + 0.125, narrow ? 0.070 : 0.085, c.pal.ink, {
                font: FONTS.sans, weight: 700, maxW: 0.88, maxLines: 2, letterSpacing: 0.01
            }),
            text(c.subtitle, 0.06, top + 0.255, 0.018, c.pal.muted, {
                maxW: 0.88, letterSpacing: 0.14
            }),
            text(c.index, 0.94, 0.085, 0.018, c.pal.paper, {
                align: 'right', maxW: 0.20, letterSpacing: 0.14,
                shadow: { color: '#000000', blur: 8, opacity: 0.5 }
            }),
            text('QINGFRAME', 0.06, 0.085, 0.014, c.pal.paper, {
                maxW: 0.30, letterSpacing: 0.20,
                shadow: { color: '#000000', blur: 8, opacity: 0.5 }
            })
        ]);
    }

    function buildSplit(c) {
        const ar = canvasArFor('split', c.photoAr);
        if (c.photoAr < 1.05) {
            const slot = fitSlotIn(c.photoAr, ar, { x0: 0, y0: 0.04, x1: 0.58, y1: 0.96 });
            return doc('侧栏档案', c.pal.paper, [
                photo(slot.x, slot.y, slot.w, slot.h),
                line(0.60, 0.14, 0.60, 0.86, c.pal.line, 1),
                text(c.title, 0.645, 0.24, 0.070, c.pal.ink, {
                    font: FONTS.serif, weight: 600, maxW: 0.31, maxLines: 2, letterSpacing: 0.02
                }),
                text(c.subtitle, 0.645, 0.35, 0.016, c.pal.muted, {
                    maxW: 0.31, maxLines: 2, letterSpacing: 0.10
                }),
                rect(0.645, 0.43, 0.22, 0.006, c.pal.accent),
                text(c.meta, 0.645, 0.51, 0.014, c.pal.muted, {
                    maxW: 0.31, maxLines: 4, letterSpacing: 0.10
                }),
                text(c.index, 0.645, 0.84, 0.095, c.pal.accent, {
                    font: FONTS.sans, weight: 700, maxW: 0.31, opacity: 0.9
                }),
                text('QINGFRAME', 0.645, 0.915, 0.014, c.pal.muted, {
                    maxW: 0.31, letterSpacing: 0.20
                })
            ]);
        }
        const slot = fitSlotIn(c.photoAr, ar, { x0: 0, y0: 0, x1: 1, y1: 0.70 });
        return doc('上下分栏', c.pal.paper, [
            photo(slot.x, slot.y, slot.w, slot.h),
            rect(0, 0.72, 1, 0.28, c.pal.paper),
            line(0.06, 0.765, 0.24, 0.765, c.pal.accent, 2),
            text(c.title, 0.06, 0.845, 0.075, c.pal.ink, {
                font: FONTS.serif, weight: 600, maxW: 0.62, maxLines: 1, letterSpacing: 0.02
            }),
            text(c.subtitle, 0.06, 0.915, 0.016, c.pal.muted, {
                maxW: 0.62, letterSpacing: 0.12
            }),
            text(c.meta, 0.94, 0.835, 0.014, c.pal.muted, {
                align: 'right', maxW: 0.30, maxLines: 3, letterSpacing: 0.08
            }),
            text(c.index, 0.94, 0.925, 0.020, c.pal.accent, {
                align: 'right', maxW: 0.20, letterSpacing: 0.12
            })
        ]);
    }

    function buildMagazine(c) {
        const ar = canvasArFor('magazine', c.photoAr);
        const slot = fitSlotIn(c.photoAr, ar, { x0: 0, y0: 0, x1: 1, y1: 1 });
        return doc('杂志封面', c.pal.paper, [
            photo(slot.x, slot.y, slot.w, slot.h),
            rect(0, 0, 1, 0.20, c.pal.ink, { fillOpacity: 0.55 }),
            text(c.title, 0.06, 0.135, 0.105, c.pal.paper, {
                font: FONTS.serif, weight: 800, maxW: 0.88, maxLines: 1, letterSpacing: 0.02
            }),
            text(c.subtitle, 0.06, 0.175, 0.016, c.pal.paper, {
                maxW: 0.88, letterSpacing: 0.18, opacity: 0.88
            }),
            rect(0, 0.78, 1, 0.22, c.pal.paper, { fillOpacity: 0.95 }),
            text(c.meta, 0.06, 0.865, 0.014, c.pal.ink, {
                maxW: 0.55, maxLines: 3, letterSpacing: 0.10
            }),
            text(c.index, 0.94, 0.865, 0.020, c.pal.ink, {
                align: 'right', maxW: 0.20, letterSpacing: 0.12
            }),
            text('QINGFRAME', 0.06, 0.945, 0.014, c.pal.muted, {
                maxW: 0.40, letterSpacing: 0.20
            })
        ]);
    }

    function buildTicket(c) {
        const ar = canvasArFor('ticket', c.photoAr);
        const slot = fitSlotIn(c.photoAr, ar, { x0: 0.05, y0: 0.08, x1: 0.62, y1: 0.92 });
        const firstWord = String(c.title || '').trim().split(/[\s/]/)[0] || 'STILL';
        const chars = Array.from(firstWord).slice(0, 5).join('\n');
        return doc('票根档案', c.pal.paper, [
            rect(slot.x - 0.008, slot.y - 0.008, slot.w + 0.016, slot.h + 0.016, '#ffffff', {
                stroke: c.pal.line, strokeWidth: 1
            }),
            photo(slot.x, slot.y, slot.w, slot.h),
            // 票根上的圆戳：压住照片一角，既像检票章，也给画面一个重色锚点。
            circle(slot.x + slot.w - 0.055, slot.y + slot.h - 0.065, 0.075, c.pal.accent, { fillOpacity: 0.92 }),
            text(c.index, slot.x + slot.w - 0.055, slot.y + slot.h - 0.050, 0.030, c.pal.paper, {
                align: 'center', weight: 700, maxW: 0.14, letterSpacing: 0.06
            }),
            line(0.645, 0.08, 0.645, 0.92, c.pal.line, 1, { dash: [8, 8] }),
            circle(0.645, 0.08, 0.012, c.pal.paper),
            circle(0.645, 0.92, 0.012, c.pal.paper),
            text(chars, 0.69, 0.17, 0.055, c.pal.ink, {
                font: FONTS.serif, weight: 600, maxW: 0.24, maxLines: 6, letterSpacing: 0.06
            }),
            text(c.subtitle, 0.69, 0.66, 0.014, c.pal.muted, {
                maxW: 0.26, maxLines: 3, letterSpacing: 0.12
            }),
            rect(0.69, 0.76, 0.22, 0.006, c.pal.accent),
            text(c.meta, 0.69, 0.86, 0.014, c.pal.muted, {
                maxW: 0.26, maxLines: 3, letterSpacing: 0.08
            }),
            text(c.index, 0.94, 0.10, 0.014, c.pal.muted, {
                align: 'right', maxW: 0.20, letterSpacing: 0.14
            })
        ]);
    }

    function buildDuotone(c) {
        const ar = canvasArFor('duotone', c.photoAr);
        const slot = fitSlotIn(c.photoAr, ar, { x0: 0.10, y0: 0.10, x1: 0.90, y1: 0.82 });
        // 窄画布上整行英文会把最后一个数字孤零零甩到第二行，主动在空格处断行。
        let title = c.title;
        if (ar < 0.9 && !/\n/.test(title) && title.length > 6) title = title.replace(/ (\S+)$/, '\n$1');
        return doc('双色套印', c.pal.accent, [
            circle(slot.x + slot.w * 0.90, slot.y + slot.h * 0.10, 0.11, c.pal.paper, { fillOpacity: 0.92 }),
            rect(slot.x + 0.03, slot.y + 0.03, slot.w, slot.h, c.pal.paper, { fillOpacity: 0.96 }),
            photo(slot.x, slot.y, slot.w, slot.h),
            // 编号压在照片左下角，用纸白小牌托底：双色套印里，这是第三块「版」。
            rect(slot.x + 0.03, slot.y + slot.h - 0.15, 0.22, 0.12, c.pal.paper, { fillOpacity: 0.96 }),
            text(c.index, slot.x + 0.045, slot.y + slot.h - 0.06, 0.085, c.pal.ink, {
                font: FONTS.sans, weight: 800, maxW: 0.18, letterSpacing: 0.04
            }),
            text(title, 0.08, 0.945, ar < 0.9 ? 0.062 : 0.080, c.pal.onAccent, {
                font: FONTS.sans, weight: 700, maxW: 0.62, maxLines: 2, letterSpacing: 0.0
            }),
            ar < 0.9 ? null : text(c.subtitle, 0.08, 0.985, 0.016, c.pal.onAccent, {
                maxW: 0.62, letterSpacing: 0.14, opacity: 0.82
            }),
            text(c.index, 0.92, 0.915, 0.020, c.pal.onAccent, {
                align: 'right', maxW: 0.20, letterSpacing: 0.12, opacity: 0.8
            })
        ]);
    }

    function buildMinimal(c) {
        const ar = canvasArFor('minimal', c.photoAr);
        const slot = fitSlotIn(c.photoAr, ar, { x0: 0.16, y0: 0.12, x1: 0.84, y1: 0.78 });
        return doc('极简线框', c.pal.paper, [
            photo(slot.x, slot.y, slot.w, slot.h),
            rect(slot.x - 0.006, slot.y - 0.006, slot.w + 0.012, slot.h + 0.012, null, {
                stroke: c.pal.line, strokeWidth: 1
            }),
            text(c.title, 0.16, 0.875, 0.030, c.pal.ink, {
                font: FONTS.serif, weight: 500, maxW: 0.50, letterSpacing: 0.14
            }),
            text(c.subtitle, 0.16, 0.925, 0.014, c.pal.muted, {
                maxW: 0.50, letterSpacing: 0.18
            }),
            text(c.index, 0.84, 0.875, 0.014, c.pal.muted, {
                align: 'right', maxW: 0.20, letterSpacing: 0.14
            })
        ]);
    }

    function buildPoster(c) {
        const ar = canvasArFor('poster', c.photoAr);
        if (c.photoAr < 1.05) {
            const slot = fitSlotIn(c.photoAr, ar, { x0: 0, y0: 0.05, x1: 1, y1: 0.58 });
            return doc('字体海报', c.pal.paper, [
                circle(0.86, 0.14, 0.15, c.pal.accent, { fillOpacity: 0.90 }),
                photo(slot.x, slot.y, slot.w, slot.h),
                // 大编号压在照片下缘：给一块实色小牌，保证任何照片上都读得清。
                rect(slot.x + 0.03, 0.430, 0.280, 0.105, c.pal.accent, { fillOpacity: 0.95 }),
                text(c.index, slot.x + 0.045, 0.515, 0.090, c.pal.paper, {
                    font: FONTS.sans, weight: 800, maxW: 0.24, letterSpacing: 0.06
                }),
                rect(0, 0.62, 1, 0.38, c.pal.paper),
                rect(0.08, 0.665, 0.22, 0.006, c.pal.accent),
                text(c.title, 0.08, 0.775, 0.082, c.pal.ink, {
                    font: FONTS.sans, weight: 800, maxW: 0.84, maxLines: 2, letterSpacing: 0.0
                }),
                text(c.subtitle, 0.08, 0.945, 0.014, c.pal.muted, {
                    maxW: 0.62, letterSpacing: 0.14
                }),
                text('QINGFRAME', 0.92, 0.955, 0.014, c.pal.muted, {
                    align: 'right', maxW: 0.26, letterSpacing: 0.16
                })
            ]);
        }
        const slot = fitSlotIn(c.photoAr, ar, { x0: 0, y0: 0.06, x1: 0.62, y1: 0.94 });
        return doc('字体海报', c.pal.paper, [
            circle(0.10, 0.16, 0.13, c.pal.accent, { fillOpacity: 0.90 }),
            photo(slot.x, slot.y, slot.w, slot.h),
            text(c.index, 0.52, slot.y + slot.h - 0.030, 0.090, c.pal.paper, {
                font: FONTS.sans, weight: 800, align: 'right', maxW: 0.34,
                letterSpacing: 0.04, shadow: { color: '#000000', blur: 10, opacity: 0.45 }
            }),
            text(c.title, 0.66, 0.30, 0.095, c.pal.ink, {
                font: FONTS.sans, weight: 800, maxW: 0.30, maxLines: 3, letterSpacing: 0.0
            }),
            rect(0.66, 0.58, 0.22, 0.006, c.pal.accent),
            text(c.subtitle, 0.66, 0.66, 0.014, c.pal.muted, {
                maxW: 0.30, maxLines: 3, letterSpacing: 0.10
            }),
            text('QINGFRAME', 0.94, 0.92, 0.014, c.pal.muted, {
                align: 'right', maxW: 0.26, letterSpacing: 0.14
            })
        ]);
    }

    function buildJournal(c) {
        const ar = canvasArFor('journal', c.photoAr);
        // 照片贴住左上角，像真的贴在纸页上；右侧/底部留出手账的批注区。
        const slot = fitSlotIn(c.photoAr, ar, { x0: 0, y0: 0, x1: 0.84, y1: 0.76 });
        const chipW = 0.20, chipH = 0.105;
        const chipX = slot.x + 0.03, chipY = slot.y + slot.h - chipH - 0.025;
        return doc('手账拼贴', c.pal.paper, [
            rect(slot.x + 0.03, slot.y + 0.025, slot.w, slot.h, c.pal.muted, { fillOpacity: 0.30 }),
            rect(slot.x + 0.055, slot.y + 0.045, slot.w, slot.h, c.pal.accent, { fillOpacity: 0.14 }),
            photo(slot.x, slot.y, slot.w, slot.h),
            rect(slot.x + slot.w * 0.06, slot.y + 0.012, slot.w * 0.26, 0.030, '#D9C7A3', {
                fillOpacity: 0.75, radius: 0.002
            }),
            rect(slot.x + slot.w * 0.66, slot.y + slot.h - 0.016, slot.w * 0.26, 0.030, '#D9C7A3', {
                fillOpacity: 0.75, radius: 0.002
            }),
            // 手写编号贴纸压在照片上：手账里最常见的「编号 + 日期」动作。
            rect(chipX, chipY, chipW, chipH, c.pal.accent, { fillOpacity: 0.94, radius: 0.002 }),
            text(c.index, chipX + 0.015, chipY + chipH - 0.025, 0.062, c.pal.paper, {
                font: FONTS.sans, weight: 800, maxW: chipW - 0.03, letterSpacing: 0.04
            }),
            text(c.title, 0.10, 0.845, 0.050, c.pal.ink, {
                font: FONTS.serif, weight: 600, maxW: 0.60, maxLines: 2, letterSpacing: 0.02
            }),
            text(c.subtitle, 0.10, 0.925, 0.016, c.pal.muted, {
                maxW: 0.60, maxLines: 2, letterSpacing: 0.10
            }),
            text('QINGFRAME', 0.88, 0.955, 0.014, c.pal.muted, {
                align: 'right', maxW: 0.24, letterSpacing: 0.16
            })
        ]);
    }

    const RECIPES = {
        gallery: { name: '留白画廊', build: buildGallery, quiet: true },
        fullbleed: { name: '满版压字', build: buildFullbleed },
        split: { name: '侧栏档案', build: buildSplit },
        magazine: { name: '杂志封面', build: buildMagazine },
        ticket: { name: '票根档案', build: buildTicket },
        duotone: { name: '双色套印', build: buildDuotone },
        minimal: { name: '极简线框', build: buildMinimal, quiet: true },
        poster: { name: '字体海报', build: buildPoster },
        journal: { name: '手账拼贴', build: buildJournal }
    };

    // ── 选配方 ──────────────────────────────────────────────────
    // 关键词只决定「优先顺序」，不改变配方本身；同一批里保证四款不同。
    // 每批固定留 2 个名额给关键词方向，另外 2 个从全池换，换一批才会真的换组合。
    const BOLD_RECIPES = ['fullbleed', 'magazine'];
    function chooseRecipes(prompt, brief, count, seed) {
        const p = String(prompt || '');
        let list;
        if (/海报|展览|大字|标题|poster|exhibition|type/i.test(p)) {
            list = ['fullbleed', 'poster', 'magazine', 'split'];
        } else if (/极简|留白|安静|干净|minimal|quiet|clean/i.test(p)) {
            list = ['gallery', 'minimal', 'split', 'fullbleed'];
        } else if (/胶片|复古|档案|老照片|film|vintage|archive/i.test(p)) {
            list = ['ticket', 'gallery', 'duotone', 'split'];
        } else if (/手账|拼贴|旅行|日记|journal|collage|travel/i.test(p)) {
            list = ['journal', 'ticket', 'gallery', 'duotone'];
        } else if (/杂志|时尚|封面|magazine|fashion|cover/i.test(p)) {
            list = ['magazine', 'fullbleed', 'poster', 'split'];
        } else if (/大胆|色彩|波普|撞色|bold|color|pop/i.test(p)) {
            list = ['duotone', 'poster', 'fullbleed', 'ticket'];
        } else {
            list = ['gallery', 'split', 'fullbleed', 'duotone'];
        }
        const want = Math.max(1, count || 4);
        const pool = ['gallery', 'split', 'fullbleed', 'duotone', 'ticket', 'magazine', 'minimal', 'poster', 'journal'];
        const rand = rng(hash('recipes' + seed + p));
        const out = [];
        const push = (id) => { if (id && !out.includes(id) && RECIPES[id]) out.push(id); };
        // 第一优先永远保留，让关键词真的有效。
        push(list[0]);
        // 第二个名额从关键词方向的其余款里随机，后面从全池随机补。
        const rest = list.slice(1);
        if (rest.length && out.length < want) push(rest.splice(Math.floor(rand() * rest.length), 1)[0]);
        while (out.length < want) {
            const left = pool.filter((id) => !out.includes(id));
            if (!left.length) break;
            push(left[Math.floor(rand() * left.length)]);
        }
        // 一批里至少有一款「满版/封面/海报」，否则四款全是安静小图，整批会显得保守。
        if (!out.some((id) => BOLD_RECIPES.includes(id))) {
            const left = BOLD_RECIPES.filter((id) => !out.includes(id));
            if (left.length) out[out.length - 1] = left[Math.floor(rand() * left.length)];
        }
        return out.slice(0, want);
    }

    // ── 对外 ────────────────────────────────────────────────────
    function designPlans(opts) {
        const o = opts || {};
        const brief = o.brief || {};
        const photoAr = num(brief.ar, num(o.photoAr, 1));
        const seed = num(o.seed, Date.now());
        const pal = paletteFor(o.prompt, brief, seed);
        const title = String(o.title || pickTitle(o.prompt, o.exif)).trim().slice(0, 24);
        const subtitle = String(o.subtitle || pickSubtitle(o.prompt, o.exif)).trim().slice(0, 80);
        const meta = pickMeta(o.exif);
        const ids = chooseRecipes(o.prompt, brief, num(o.count, 4), seed);
        return ids.map((id, i) => {
            const built = RECIPES[id].build({
                photoAr, pal, title, subtitle, meta,
                index: String(i + 1).padStart(2, '0'),
                seed: seed + i * 97
            });
            if (built) built.recipeId = id;
            return built;
        }).filter(Boolean);
    }

    // 给面板/测试用：按 id 单独构建一款，便于调试。
    function buildOne(id, opts) {
        const o = opts || {};
        const brief = o.brief || {};
        const seed = num(o.seed, Date.now());
        const pal = paletteFor(o.prompt, brief, seed);
        return RECIPES[id] ? RECIPES[id].build({
            photoAr: num(brief.ar, num(o.photoAr, 1)), pal,
            title: String(o.title || pickTitle(o.prompt, o.exif)).trim().slice(0, 24),
            subtitle: String(o.subtitle || pickSubtitle(o.prompt, o.exif)).trim().slice(0, 80),
            meta: pickMeta(o.exif), index: '01', seed
        }) : null;
    }

    // ── 基于某一款继续改 ────────────────────────────────────────
    // 本地模式没有模型可问，但「改配色 / 改纸色」本来就不需要模型：
    // 骨架、照片槽位、文字全部保留，只换四套配色重画。
    // 用户点「换个配色」得到的是同一款构图的 4 个颜色版本，不会突然换版式。
    function textsFromDoc(doc) {
        const layers = (doc && Array.isArray(doc.layers)) ? doc.layers : [];
        const texts = layers.filter((l) => l && l.type === 'text' && String(l.text || '').trim());
        texts.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
        const title = texts[0] ? String(texts[0].text).replace(/\n/g, ' ').trim() : '';
        const subtitle = texts[1] ? String(texts[1].text).replace(/\n/g, ' ').trim() : '';
        return { title, subtitle };
    }
    function paletteVariants(prompt, brief, seed) {
        return [
            paletteFor(prompt, brief, seed),
            paletteFor('暗色 夜 night ' + String(prompt || ''), brief, seed + 11),
            paletteFor('极简 冷 干净 cool ' + String(prompt || ''), brief, seed + 23),
            paletteFor('复古 暖 胶片 warm ' + String(prompt || ''), brief, seed + 37)
        ];
    }
    function variantsOf(baseDoc, opts) {
        const o = opts || {};
        const base = baseDoc && Array.isArray(baseDoc.layers) ? baseDoc : null;
        if (!base) return designPlans(o);
        const id = RECIPES[base.recipeId] ? base.recipeId : 'gallery';
        const brief = o.brief || {};
        const photoAr = num(brief.ar, num(o.photoAr, 1));
        const seed = num(o.seed, Date.now());
        const fromDoc = textsFromDoc(base);
        const title = String(o.title || fromDoc.title || pickTitle(o.prompt, o.exif)).trim().slice(0, 24);
        const subtitle = String(o.subtitle || fromDoc.subtitle || pickSubtitle(o.prompt, o.exif)).trim().slice(0, 80);
        const meta = pickMeta(o.exif);
        return paletteVariants(o.prompt, brief, seed).map((pal, i) => {
            const built = RECIPES[id].build({
                photoAr, pal, title, subtitle, meta,
                index: String(i + 1).padStart(2, '0'),
                seed: seed + i * 131
            });
            if (built) { built.recipeId = id; built.variantOf = base.templateName || ''; }
            return built;
        }).filter(Boolean);
    }

    return {
        FONTS, RECIPES, designPlans, buildOne, variantsOf, chooseRecipes, paletteFor,
        pickTitle, pickSubtitle, pickMeta, fitSlotIn, canvasArFor, textsFromDoc,
        parseHex, toHex, mix, contrast, ensureContrast, hash, rng
    };
});

'use strict';
/* 照片速写：把一张照片「看得见的东西」折成几句模型读得懂的话。
 *
 * 只做纯统计，不做语义识别：宽高比、主色/辅色、亮暗分布、视觉重心、饱和度，
 * 再加上 EXIF。目的是让 AI 从「盲配」变成「看着这张照片配」——
 * 暗调照片不该给白字配深底，重心偏右不该把文字压在主体上。
 *
 * 两个入口：
 *   analyzePixels(rgba, w, h)  纯函数，给测试和离屏数据用
 *   analyze(src, opts)         画到 64px 小图再统计，O(4k) 像素，可以每次生成都跑
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PhotoBrief = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const round2 = (v) => Math.round(v * 100) / 100;

    function gcd(a, b) {
        a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
        while (b) { const t = a % b; a = b; b = t; }
        return a || 1;
    }

    function ratioLabel(w, h) {
        if (!(w > 0 && h > 0)) return '';
        const ar = w / h;
        const common = [[1, 1], [3, 2], [2, 3], [4, 3], [3, 4], [16, 9], [9, 16], [5, 4], [4, 5], [21, 9], [9, 21]];
        let best = null, bestD = Infinity;
        for (const [a, b] of common) {
            const d = Math.abs(Math.log(ar / (a / b)));
            if (d < bestD) { bestD = d; best = [a, b]; }
        }
        if (best && bestD < 0.045) return best[0] + ':' + best[1];
        const g = gcd(w, h);
        const rw = Math.round(w / g), rh = Math.round(h / g);
        if (rw <= 40 && rh <= 40) return rw + ':' + rh;
        return (Math.round(ar * 100) / 100) + ':1';
    }

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        const d = max - min;
        if (!d) return { h: 0, s: 0, l };
        const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        let h;
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
        return { h, s, l };
    }

    // 给模型看的颜色名：够用就行，不追求十六色命名
    function colorName(hex) {
        const h = String(hex || '').replace('#', '');
        if (h.length < 6) return '未知';
        const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        if (![r, g, b].every(Number.isFinite)) return '未知';
        const { h: H, s, l } = rgbToHsl(r, g, b);
        if (l <= 0.10) return '近黑';
        if (l >= 0.93 && s <= 0.12) return '近白';
        if (s <= 0.10) return l < 0.42 ? '深灰' : l > 0.72 ? '浅灰' : '灰';
        const depth = l < 0.32 ? '深' : l > 0.72 ? '浅' : '';
        let base;
        if (H < 15 || H >= 345) base = '红';
        else if (H < 40) base = l >= 0.5 ? '橙' : '棕';
        else if (H < 65) base = '黄';
        else if (H < 160) base = '绿';
        else if (H < 200) base = '青';
        else if (H < 252) base = '蓝';
        else if (H < 290) base = '紫';
        else base = '洋红';
        return depth + base;
    }

    function hexOf(r, g, b) {
        const p = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
        return '#' + p(r) + p(g) + p(b);
    }

    // 纯统计：rgba 是 Uint8ClampedArray / 普通数组，长度 = w*h*4
    function analyzePixels(rgba, w, h, opts) {
        const n = Math.max(0, (w | 0) * (h | 0));
        if (!n || !rgba || rgba.length < n * 4) return null;
        const o = opts || {};
        const step = Math.max(1, Math.floor(o.step || 1));

        let sumLuma = 0, sumSat = 0, sampled = 0;
        const lumas = [];
        const bins = new Map();
        for (let i = 0; i < n; i += step) {
            const p = i * 4;
            const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
            const a = rgba[p + 3];
            if (a === 0) continue;
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const sat = mx ? (mx - mn) / mx : 0;
            sumLuma += lum; sumSat += sat; sampled++;
            if (lumas.length < 20000) lumas.push(lum);
            const key = ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
            let bin = bins.get(key);
            if (!bin) { bin = { c: 0, r: 0, g: 0, b: 0 }; bins.set(key, bin); }
            bin.c++; bin.r += r; bin.g += g; bin.b += b;
        }
        if (!sampled) return null;
        const meanLuma = sumLuma / sampled;
        const meanSat = sumSat / sampled;

        lumas.sort((a, b) => a - b);
        const pick = (q) => lumas[clamp(Math.floor(lumas.length * q), 0, lumas.length - 1)] || 0;
        const p10 = pick(0.10), p50 = pick(0.50), p90 = pick(0.90);
        let shadow = 0, highlight = 0;
        for (const v of lumas) { if (v < 51) shadow++; else if (v > 204) highlight++; }

        const palette = [];
        for (const bin of bins.values()) {
            const share = bin.c / sampled;
            if (share < 0.015) continue;
            const r = bin.r / bin.c, g = bin.g / bin.c, b = bin.b / bin.c;
            const hex = hexOf(r, g, b);
            const hsl = rgbToHsl(Math.round(r), Math.round(g), Math.round(b));
            palette.push({ hex, share, hsl, name: colorName(hex) });
        }
        palette.sort((a, b) => b.share - a.share);
        const top = palette.slice(0, 6);
        const dominant = top[0] || { hex: '#808080', name: '灰', share: 1, hsl: { h: 0, s: 0, l: 0.5 } };
        let accent = null;
        for (const c of top.slice(1)) {
            if (c.hsl.s < 0.18 || c.share < 0.03) continue;
            const dh = Math.abs(c.hsl.h - dominant.hsl.h);
            const hueGap = Math.min(dh, 360 - dh);
            if (dominant.hsl.s >= 0.18 && hueGap < 25) continue;
            accent = c; break;
        }
        if (!accent) accent = top[1] || dominant;

        // 视觉重心：亮度偏离平均 + 饱和度高的地方更抓眼
        let wsum = 0, cx = 0, cy = 0;
        for (let y = 0; y < h; y += step) {
            for (let x = 0; x < w; x += step) {
                const i = (y * w + x) * 4;
                if (rgba[i + 3] === 0) continue;
                const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
                const sat = mx ? (mx - mn) / mx : 0;
                const wgt = Math.abs(lum - meanLuma) / 255 + sat * 0.5;
                wsum += wgt; cx += (x / Math.max(1, w - 1)) * wgt; cy += (y / Math.max(1, h - 1)) * wgt;
            }
        }
        let nx = 0.5, ny = 0.5;
        if (wsum > sampled * 0.02) { nx = clamp(cx / wsum, 0, 1); ny = clamp(cy / wsum, 0, 1); }

        const ar = w / h;
        const orient = ar > 1.08 ? '横' : ar < 0.92 ? '竖' : '方';
        const tone = meanLuma < 92 ? '偏暗' : meanLuma > 165 ? '偏亮' : '中间调';
        const df = (p90 - p10) / 255;
        const contrast = df > 0.55 ? '强' : df < 0.28 ? '弱' : '中等';
        const satLabel = meanSat > 0.5 ? '高' : meanSat < 0.18 ? '低' : '中等';

        return {
            w, h, ar, ratio: ratioLabel(w, h), orient,
            luma: {
                mean: Math.round(meanLuma), p10: Math.round(p10), p50: Math.round(p50), p90: Math.round(p90),
                shadow: shadow / lumas.length, highlight: highlight / lumas.length,
                tone, contrast, range: round2(df)
            },
            sat: { mean: round2(meanSat), label: satLabel },
            palette: top.map((c) => ({ hex: c.hex, name: c.name, share: round2(c.share), s: round2(c.hsl.s), l: round2(c.hsl.l) })),
            dominant: { hex: dominant.hex, name: dominant.name, share: round2(dominant.share) },
            accent: { hex: accent.hex, name: accent.name, share: round2(accent.share) },
            centroid: { x: round2(nx), y: round2(ny), label: whereLabel(nx, ny) }
        };
    }

    function whereLabel(x, y) {
        const col = x < 0.4 ? '左' : x > 0.6 ? '右' : '中';
        const row = y < 0.4 ? '上' : y > 0.6 ? '下' : '中';
        if (row === '中' && col === '中') return '居中';
        return '偏' + row + col;
    }

    let _cache = null;
    function cacheOf() {
        if (!_cache) _cache = new WeakMap();
        return _cache;
    }

    function analyze(src, opts) {
        if (!src) return null;
        const o = opts || {};
        try {
            const c = cacheOf().get(src);
            const nw = src.naturalWidth || src.width || 0;
            const nh = src.naturalHeight || src.height || 0;
            if (c && c.w === nw && c.h === nh) return c.brief;
        } catch (_) { /* 非对象，直接算 */ }
        try {
            const nw = src.naturalWidth || src.width || 0;
            const nh = src.naturalHeight || src.height || 0;
            if (!nw || !nh) return null;
            const max = Math.max(16, Math.min(96, o.max || 64));
            const scale = Math.min(1, max / Math.max(nw, nh));
            const sw = Math.max(1, Math.round(nw * scale));
            const sh = Math.max(1, Math.round(nh * scale));
            const cv = document.createElement('canvas');
            cv.width = sw; cv.height = sh;
            const g = cv.getContext('2d', { willReadFrequently: true });
            g.drawImage(src, 0, 0, sw, sh);
            const data = g.getImageData(0, 0, sw, sh).data;
            const brief = analyzePixels(data, sw, sh, o);
            if (brief) { brief.w = nw; brief.h = nh; brief.ar = nw / nh; brief.ratio = ratioLabel(nw, nh); }
            try { cacheOf().set(src, { w: nw, h: nh, brief }); } catch (_) {}
            return brief;
        } catch (_) { return null; }
    }

    function pct(v) { return Math.round(clamp(v, 0, 1) * 100) + '%'; }

    // 压成给模型看的几行；不带任何渲染细节，避免挤占 token
    function toPromptText(brief, exif) {
        if (!brief) return '';
        const lines = [];
        lines.push(`照片 ${brief.w}×${brief.h}（${brief.ratio} ${brief.orient}构图）`);
        lines.push(`明暗：${brief.luma.tone}，平均亮度 ${brief.luma.mean}/255，暗部 ${pct(brief.luma.shadow)}，高光 ${pct(brief.luma.highlight)}，对比${brief.luma.contrast}`);
        lines.push(`色彩：主色 ${brief.dominant.name} ${brief.dominant.hex}（${pct(brief.dominant.share)}），辅色 ${brief.accent.name} ${brief.accent.hex}（${pct(brief.accent.share)}），整体饱和度${brief.sat.label}`);
        lines.push(`视觉重心：${brief.centroid.label}（${brief.centroid.x}, ${brief.centroid.y}）`);
        const e = exif && (exif.make || exif.model || exif.iso || exif.shutter || exif.aperture || exif.focal);
        if (e) {
            const bits = [String(exif.make || '').trim(), String(exif.model || '').trim()].filter(Boolean).join(' ');
            const shot = [exif.focal, exif.aperture, exif.shutter, exif.iso].filter(Boolean).join(' · ');
            lines.push('EXIF：' + [bits, shot].filter(Boolean).join(' · '));
        }
        return lines.join('\n');
    }

    // 把速写翻成可执行的排版/配色建议（就一句，避免模型自由发挥）
    function toAdvice(brief) {
        if (!brief) return '';
        const tips = [];
        if (brief.luma.tone === '偏暗') tips.push('暗调照片：用浅色/暖白卡纸或高对比亮字，别用深底深字');
        else if (brief.luma.tone === '偏亮') tips.push('亮调照片：卡纸选中性深色或米灰，文字用深色，避免整片发白');
        else tips.push('中间调照片：可以用主色做描边、辅色做点缀');
        if (brief.luma.contrast === '弱') tips.push('画面反差小，边框要加一条细线或描边把照片框住');
        if (brief.centroid.x < 0.4) tips.push('主体偏左：文字排到右侧留白，别压在主体上');
        else if (brief.centroid.x > 0.6) tips.push('主体偏右：文字排到左侧留白，别压在主体上');
        if (brief.sat.label === '低') tips.push('照片本身素，边框可以带一点主色/辅色提气');
        else if (brief.sat.label === '高') tips.push('照片已经很艳，边框降低饱和度，别抢戏');
        if (brief.ar < 0.8) tips.push('竖幅照片：适合上下分栏的版式，别把文字挤在两侧');
        return tips.join('；') + '。';
    }

    return { analyze, analyzePixels, toPromptText, toAdvice, colorName, ratioLabel, rgbToHsl };
});

'use strict';
/* 自动调色：一次本地、确定性的测光 + 白平衡估算。
 *
 * 设计取舍
 * ─────────────────────────────────────────────────────────────
 * 1) 不联网、不跑模型、不识别场景。读的是原图的一张 256px 采样图，
 *    连续点两次得到同一组参数，不会"越调越重"。
 * 2) 只给基础 11 档建议，不碰曲线、蒙版、混色器、颜色分级。
 * 3) 曝光在线性光上对准绝对目标；白场/黑场、中间调 gamma 在编码域换算；
 *    高光/阴影按两端剪切比例给档，而不是一条曝光拉到底（ACR 的分层思路）。
 * 4) 白平衡：普通照片反解实测 ACR 白平衡表（QfsAcr.neutralize），
 *    RAW 则反解 raw-tonemap 的通道增益——都精确对上自己的渲染器。
 * 5) RAW 的解码已经做了自动曝光基线 + 高光肩，显影层只校白平衡，
 *    调色层跳过色温/色调，避免双重校正。
 */
(function () {
    const MAX_EDGE = 256;
    // 18% 灰略亮一点：目标中位线性亮度 0.20（≈ sRGB 0.48），只走一半、上限 ±0.8EV。
    const TARGET_LIN = 0.20;
    const EXP_FACTOR = 0.5;
    const EXP_CAP = 0.8;
    // Compositor 的 Levels Auto：gamma = log(mean)/log(0.5)，这里换算到我们的 gam 档
    // （buildTables 里 gpow = 2^(-gam*0.85)），只走六成、上限 ±70。
    const GAM_FACTOR = 0.6;
    const GAM_CAP = 70;
    const CLIP_MIN = 0.003;
    const HI_SH_CAP = 35;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const srgbToLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const linToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    let cv = null;
    let ctx = null;

    function sample(im) {
        const src = im && im.el;
        if (!src) return null;
        const iw = src.naturalWidth || src.width || 0;
        const ih = src.naturalHeight || src.height || 0;
        if (!iw || !ih) return null;
        if (!cv) {
            cv = document.createElement('canvas');
            ctx = cv.getContext('2d', { willReadFrequently: true });
        }
        if (!ctx) return null;
        const k = Math.min(1, MAX_EDGE / Math.max(iw, ih));
        cv.width = Math.max(1, Math.round(iw * k));
        cv.height = Math.max(1, Math.round(ih * k));
        ctx.clearRect(0, 0, cv.width, cv.height);
        try { ctx.drawImage(src, 0, 0, cv.width, cv.height); } catch (_) { return null; }
        try { return ctx.getImageData(0, 0, cv.width, cv.height).data; } catch (_) { return null; }
    }

    // 亮部、低饱和像素的**线性光**平均（Compositor 的灰世界在线性域做）。
    // 保留"亮部 + 接近中性"的过滤是为了不把肤色、蓝天、夕阳当成色偏。
    function neutralAverage(data, loY, hiY, maxSat) {
        let n = 0, r = 0, g = 0, b = 0, sat = 0;
        for (let i = 0; i < data.length; i += 4) {
            const R = data[i], G = data[i + 1], B = data[i + 2];
            const y = (R * 77 + G * 150 + B * 29) >> 8;
            if (y < loY || y > hiY) continue;
            const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
            const s = mx ? (mx - mn) / mx : 0;
            if (s > maxSat) continue;
            n++;
            r += srgbToLin(R / 255);
            g += srgbToLin(G / 255);
            b += srgbToLin(B / 255);
            sat += s;
        }
        return n >= 32 ? { r: r / n, g: g / n, b: b / n, sat: sat / n, n } : null;
    }

    function suggest(im, opts) {
        const data = sample(im);
        if (!data) return null;
        const total = data.length / 4;
        const lums = new Float32Array(total);
        let clipLo = 0, clipHi = 0;
        for (let p = 0, i = 0; p < total; p++, i += 4) {
            const R = data[i], G = data[i + 1], B = data[i + 2];
            const lin = 0.2126 * srgbToLin(R / 255) + 0.7152 * srgbToLin(G / 255) + 0.0722 * srgbToLin(B / 255);
            lums[p] = lin;
            const y = linToSrgb(lin) * 255;
            if (y <= 2) clipLo++;
            else if (y >= 253) clipHi++;
        }
        if (!total) return null;
        lums.sort();
        const pick = (q) => lums[Math.min(total - 1, Math.floor(total * q))];
        const loLin = pick(0.01), midLin = pick(0.50), hiLin = pick(0.99);
        // 白场/黑场/对比度按 sRGB 端点算（那几档的 LUT 就是在编码域上做的）。
        const lo = linToSrgb(loLin), hi = linToSrgb(hiLin);
        const span = Math.max(0.06, hi - lo);

        // 曝光：把中位线性亮度拉向固定目标（不是"拉到自身区间的中点"）。
        const exp = Math.round(clamp(Math.log2(TARGET_LIN / Math.max(midLin, 0.006)) * EXP_FACTOR,
            -EXP_CAP, EXP_CAP) * 100) / 100;
        const con = Math.round(clamp((0.72 / span - 1) * 26, -12, 26));
        const black = lo > 0.03 ? -Math.round(Math.min(20, (lo - 0.03) * 180)) : 0;
        const white = hi < 0.97 ? Math.round(Math.min(26, (0.97 - hi) * 170)) : 0;

        // 中间调 gamma：先把全图亮度按黑白场归一，求均值 m，令 m^(1/gamma)=0.5，
        // 即 gamma = log(m)/log(0.5)；再换算到我们的 gam 档（gpow = 2^(-gam*0.85)）。
        let mapped = 0;
        for (let p = 0; p < total; p++) mapped += clamp((linToSrgb(lums[p]) - lo) / span, 0, 1);
        const mean = mapped / total;
        let gam = 0;
        if (mean > 0.05 && mean < 0.95) {
            const gamma = Math.log(mean) / Math.log(0.5);
            gam = Math.round(clamp(GAM_FACTOR * 100 * Math.log2(gamma) / 0.85, -GAM_CAP, GAM_CAP));
        }

        // 高光/阴影按两端剪切比例走档：亮部堆积 → 负 hi 回收；暗部压死 → 正 sh 提亮。
        const hiClip = clipHi / total, loClip = clipLo / total;
        const hiAdj = hiClip > CLIP_MIN ? -Math.round(Math.min(HI_SH_CAP, hiClip * 500)) : 0;
        const shAdj = loClip > CLIP_MIN ? Math.round(Math.min(HI_SH_CAP, loClip * 500)) : 0;

        let temp = 0, tint = 0, vib = 0;
        const avg = neutralAverage(data, 190, 250, 0.65);
        if (avg) {
            vib = Math.round(clamp((0.16 - avg.sat) * 45, 0, 10));
            if (!(opts && opts.skipWhiteBalance)) {
                const A = window.QfsAcr;
                const solved = (A && A.ready() && typeof A.neutralize === 'function')
                    ? A.neutralize(linToSrgb(avg.r) * 255, linToSrgb(avg.g) * 255, linToSrgb(avg.b) * 255)
                    : null;
                if (solved) {
                    temp = clamp(Math.round(solved.temperature / 5) * 5, -20, 20);
                    tint = clamp(Math.round(solved.tint / 5) * 5, -12, 12);
                } else {
                    // 表未就绪时的兜底系数（与之前一致）。
                    const r = linToSrgb(avg.r), g = linToSrgb(avg.g), b = linToSrgb(avg.b);
                    temp = Math.round(clamp(-(r - b) * 80, -18, 18));
                    tint = Math.round(clamp(-((r + b) / 2 - g) * 90, -12, 12));
                }
            }
        }

        return { exp, con, sat: 0, vib, temp, tint, hi: hiAdj, sh: shAdj, white, black, gam };
    }

    // RAW 显影白平衡：反解 raw-tonemap 的通道增益（和主进程同一组公式），
    // 找让亮部中性像素三通道相等的 temperature/tint；曝光/高光保持解码默认值。
    function suggestRaw(im) {
        const data = sample(im);
        if (!data) return null;
        const avg = neutralAverage(data, 145, 245, 0.22);
        if (!avg) return { temperature: 0, tint: 0 };
        let bt = 0, bg = 0, bs = Infinity;
        for (let t = -20; t <= 20; t++) {
            for (let g = -12; g <= 12; g++) {
                const tn = t / 100, gn = g / 100;
                const R = avg.r * (1 + 0.32 * tn + 0.10 * gn);
                const G = avg.g * (1 - 0.12 * Math.abs(tn) - 0.16 * gn);
                const B = avg.b * (1 - 0.30 * tn + 0.10 * gn);
                const spread = Math.max(R, G, B) - Math.min(R, G, B);
                if (spread < bs) { bs = spread; bt = t; bg = g; }
            }
        }
        return { temperature: bt, tint: bg };
    }

    window.QfsAutoGrade = { suggest, suggestRaw };
})();

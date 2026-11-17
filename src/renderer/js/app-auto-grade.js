'use strict';
/* 自动调色：一次本地、确定性的直方图/白平衡估算，只输出基础调色档位。
 *
 * 设计取舍
 * ─────────────────────────────────────────────────────────────
 * 1) 不联网、不跑模型、不识别场景。读的是**原图**的一张 256px 采样图，
 *    所以连续点两次得到同一组参数（不会产生"越调越重"的累积）。
 * 2) 只给基础 11 档里的色调/白平衡一个保守建议，不碰曲线、蒙版、混色器、
 *    颜色分级这些"表达意图"的参数；算出多少就是多少，用户能看见滑块落点。
 * 4) RAW 单独走 suggestRaw：解码层已经做了自动曝光基线 + 高光肩，
 *    所以显影层只校白平衡（色温/色调），不重复拉曝光；调色层的「自动」
 *    在 RAW 上会跳过色温/色调，两层合起来才是一次完整自动调整。
 */
(function () {
    const MAX_EDGE = 256;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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

    // 直方图分位点：返回 0..255，用累计计数找第一个越过 q 的 bin。
    function percentile(hist, total, q) {
        const target = total * q;
        let acc = 0;
        for (let i = 0; i < 256; i++) {
            acc += hist[i];
            if (acc >= target) return i;
        }
        return 255;
    }

    function suggest(im, opts) {
        const data = sample(im);
        if (!data) return null;
        const hist = new Uint32Array(256);
        let total = 0;
        // 白平衡只信"亮但没爆"的像素：纯白/镜面高光没有颜色信息，暗部噪声太多。
        let brightN = 0, sr = 0, sg = 0, sb = 0, satSum = 0;
        for (let i = 0; i < data.length; i += 4) {
            const R = data[i], G = data[i + 1], B = data[i + 2];
            const y = (R * 77 + G * 150 + B * 29) >> 8;
            hist[y]++;
            total++;
            if (y >= 190 && y < 250) {
                brightN++;
                sr += R; sg += G; sb += B;
                const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
                satSum += mx ? (mx - mn) / mx : 0;
            }
        }
        if (!total) return null;

        const lo = percentile(hist, total, 0.01) / 255;
        const mid = percentile(hist, total, 0.50) / 255;
        const hi = percentile(hist, total, 0.99) / 255;
        const span = Math.max(0.06, hi - lo);
        const midN = clamp((mid - lo) / span, 0.05, 0.95);

        // 曝光：把 1%–99% 区间的中位亮度拉向 0.5，系数 0.55 留一半给手动微调。
        const exp = Math.round(clamp(Math.log2(0.5 / midN) * 0.55, -0.8, 0.8) * 100) / 100;
        // 对比度：目标跨度 0.72；极平（low contrast）的照片给正档，本来很硬的给小幅负档。
        const con = Math.round(clamp((0.72 / span - 1) * 26, -12, 26));
        // 白点/黑点：只在端点确实没顶到边时动；画面本身有纯黑纯白就不去"抬雾"。
        const black = lo > 0.03 ? -Math.round(Math.min(20, (lo - 0.03) * 180)) : 0;
        const white = hi < 0.97 ? Math.round(Math.min(26, (0.97 - hi) * 170)) : 0;

        let temp = 0, tint = 0, vib = 0;
        if (brightN > total * 0.002) {
            const r = sr / brightN / 255, g = sg / brightN / 255, b = sb / brightN / 255;
            // 偏暖（R>B）就往冷拉，程序里的 temp 正档是"更暖"，所以取负号。
            temp = Math.round(clamp(-(r - b) * 80, -18, 18));
            // 品红偏（R+B 大于 2G）往绿拉；tint 正档是品红，同样取负号。
            tint = Math.round(clamp(-((r + b) / 2 - g) * 90, -12, 12));
            // 亮部本来就鲜艳就别再加饱和，只给明显发灰的画面一点自然饱和度。
            vib = Math.round(clamp((0.16 - satSum / brightN) * 45, 0, 10));
        }

        // RAW 照片在显影层做白平衡（见 suggestRaw），调色层这里必须跳过，避免双重校正。
        if (opts && opts.skipWhiteBalance) { temp = 0; tint = 0; }

        return { exp, con, sat: 0, vib, temp, tint, hi: 0, sh: 0, white, black, gam: 0 };
    }

    // RAW 显影白平衡：只输出 raw.params 的色温/色调，曝光和高光保持解码默认值。
    // 取样偏严（亮部 + 低饱和）是为了不把红衣服、蓝天、夕阳当成色偏。
    function suggestRaw(im) {
        const data = sample(im);
        if (!data) return null;
        let n = 0, sr = 0, sg = 0, sb = 0;
        for (let i = 0; i < data.length; i += 4) {
            const R = data[i], G = data[i + 1], B = data[i + 2];
            const y = (R * 77 + G * 150 + B * 29) >> 8;
            if (y < 145 || y > 245) continue;
            const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
            if (mx && (mx - mn) / mx > 0.22) continue;   // 只信接近中性的像素
            n++; sr += R; sg += G; sb += B;
        }
        if (n < 32) return { temperature: 0, tint: 0 };
        const r = sr / n / 255, g = sg / n / 255, b = sb / n / 255;
        // raw-tonemap 的通道增益：R = 1+0.32t，B = 1-0.30t。
        // 要抵消 R>B 的暖偏，t 取负；系数按这个增益斜率换算，留一半余量。
        const temperature = Math.round(clamp(-(r - b) * 55, -20, 20));
        // 洋红偏（R+B > 2G）往绿拉；tint 正档是洋红，同样取负号。
        const tint = Math.round(clamp(-((r + b) / 2 - g) * 70, -12, 12));
        return { temperature, tint };
    }

    window.QfsAutoGrade = { suggest, suggestRaw };
})();

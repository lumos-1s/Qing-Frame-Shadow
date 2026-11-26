'use strict';

// RAW 显影的色调映射：LibRaw 给出 sRGB（已去马赛克 + 相机白平衡 + 色彩矩阵），
// 这里把「曝光 / 对比 / 高光肩 / 色温 / 色调」折成查表，再逐像素套用。
//
// 两条路径，同一份曲线（toneLinear），只是表的大小不同：
//   · 8bit  — 256 项表，代理图走这条，解码快一倍；
//   · 16bit — 65536 项表，全尺寸/导出走这条，量化损失只发生在最后一步 BGRA。
// 两条路径的自动基线（autoGain）必须算出同一个 gain，否则代理图和导出图会一亮一暗。
//
// 为什么不逐像素算：24MP 每通道一次 Math.pow 要 2s 以上，拖不动滑块。而这几档调整
// 都是逐通道单调函数（色温色调只是通道增益），完全可以预先折进表里，全图只剩
// 三次查表 + 一次写 BGRA，24MP 约 150ms。
//
// 高光肩是逐通道做的：真实的高光压缩本来就会让高光去饱和，观感上比按亮度缩放更接近
// Lightroom；代价是极端色（纯红高光）会略掉饱和，这在 8bit 输出里可以接受。

// 高光肩默认 25：渲染层导入时也是这个基线，两边必须一致——以前一边 0 一边 25，
// URL 里少一个字段（旧工程/旧草稿）画面就会突然硬一档。
const DEFAULTS = { exposure: 0, contrast: 0, highlights: 25, temperature: 0, tint: 0 };

// 16bit 输入的线性化表：65536 项 Float32（256KB），建表约 6ms。
// 逐像素算 pow 要 24MP×3 次，等于把导出卡死；建表一次后面全查表，和 8bit 那条路径同一个套路。
// 延迟到真正用到时再建：只导入 JPEG 的用户不该为这 6ms 和 256KB 买单。
let LIN16 = null;
function lin16Table() {
    if (LIN16) return LIN16;
    const t = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
        const c = i / 65535;
        t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    LIN16 = t;
    return t;
}
const LIMITS = {
    exposure: [-5, 5],
    contrast: [-100, 100],
    highlights: [-100, 100],
    temperature: [-100, 100],
    tint: [-100, 100]
};

// sRGB 8bit → 线性。源数据是 LibRaw 编好的 sRGB，逆回去才能做曝光和肩部。
const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const linToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const num = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
};

// 参数一律裁剪到合法区间：URL / 草稿 / 旧版本都可能塞进越界值，越界会让查表溢出成黑边。
function normalize(params) {
    const p = params && typeof params === 'object' ? params : {};
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
        const [lo, hi] = LIMITS[k];
        out[k] = Math.min(hi, Math.max(lo, num(p[k], DEFAULTS[k])));
    }
    return out;
}

// 自动基线：把 99.7% 分位亮度映射到 0.9 线性，既不裁高光也不让欠曝的片子发灰。
// 这是"自动亮度"该有的做法——LibRaw 自带的自动亮度会为了拉亮中间调把高光切掉 0.13%。
function autoGain(src, colors, total) {
    const hist = new Uint32Array(256);
    const step = total > 4000000 ? 7 : 1; // 大图抽样即可，分位数不需要每个像素
    const ch = colors || 3;
    for (let i = 0; i < total; i += step) {
        const j = i * ch;
        const l = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29) >> 8;
        hist[l]++;
    }
    let seen = 0;
    let counted = 0;
    for (let i = 0; i < 256; i++) counted += hist[i];
    if (!counted) return 1;
    const target = counted * 0.997;
    let p = 255;
    for (let i = 0; i < 256; i++) {
        seen += hist[i];
        if (seen >= target) { p = i; break; }
    }
    const lin = SRGB_TO_LIN[p] || 0.0001;
    // 已经是亮的图（p 接近 255）gain 会被压在 1 附近；夜景也别一次拉过 3 倍。
    return Math.min(3, Math.max(0.5, 0.9 / Math.max(lin, 0.002)));
}

// 16bit 的自动基线。故意和 8bit 版用同一个 256 档直方图：
//
// 一度想用 4096 档「更准」，实测反而出问题——同一张片子两条路径算出的 gain 差 4%，
// 代理图（8bit）和导出图（16bit）就会一亮一暗，而且只在导出时才发现。
// 分位数本来就是全局的一个数，8bit 的分辨率（0.4%）对基线足够；
// 把精度留给逐像素的 LUT（那张表还是 65536 项），一致性比"更准"重要。
function autoGain16(src, colors, total) {
    const hist = new Uint32Array(256);
    const step = total > 4000000 ? 7 : 1;
    const ch = colors || 3;
    for (let i = 0; i < total; i += step) {
        const j = i * ch;
        const l = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29) >> 8; // 0..65280
        hist[Math.min(255, l >> 8)]++;
    }
    let counted = 0;
    for (let i = 0; i < 256; i++) counted += hist[i];
    if (!counted) return 1;
    const target = counted * 0.997;
    let seen = 0;
    let p = 255;
    for (let i = 0; i < 256; i++) {
        seen += hist[i];
        if (seen >= target) { p = i; break; }
    }
    // 取这一级 8bit 值的中间位置做线性化：和 8bit 那条路径查的是同一个编码值。
    // p=255 时 p*257+128 会越过表尾（65663 > 65535），必须夹住——不夹的话查出来是
    // undefined，`|| 0.0001` 兜底成"几乎没有光"，gain 直接被推到上限 3，整张图变亮。
    const lin = lin16Table()[Math.min(65535, p * 257 + 128)] || 0.0001;
    return Math.min(3, Math.max(0.5, 0.9 / Math.max(lin, 0.002)));
}

// 通道增益。色温在绿-红/蓝之间反向推，色调在绿-洋红之间推；系数取保守值，
// 滑块拉到头也不会变成滤镜，只是白平衡偏移。
function channelGains(p) {
    const t = p.temperature / 100;
    const g = p.tint / 100;
    return [
        1 + 0.32 * t + 0.10 * g,   // R：暖 → 加红，洋红 → 也加红
        1 - 0.12 * Math.abs(t) - 0.16 * g, // G：暖冷两头都略收绿，洋红收得更多
        1 - 0.30 * t + 0.10 * g    // B：暖 → 减蓝
    ];
}

// 单通道的曲线部分：线性值进去，sRGB 编码值出来（0..1）。
//
// 8bit 和 16bit 两条路径共用这一份公式。曲线一旦在两边分叉，代理图和导出图的亮度
// 就会差一档——那种 bug 只在"导出来发现比预览亮"的时候才被发现，很难定位。
function toneLinear(v, knee, contrast) {
    if (v > knee) {
        const room = 1 - knee;
        v = knee + room * (1 - Math.exp(-(v - knee) / room));
    }
    let e = linToSrgb(clamp01(v));
    if (contrast) {
        const s = e * e * (3 - 2 * e); // smoothstep：中间调不变，两端拉开
        e = e + contrast * 0.62 * (s - e);
    }
    return clamp01(e);
}

// 曲线参数整理：三条 LUT 共用同一组 knee / contrast。
function curveArgs(p) {
    const hl = p.highlights / 100;
    return {
        // highlights > 0 提前压高光，< 0 反而把肩抬高（让高光更硬）
        knee: Math.min(0.98, Math.max(0.35, 0.80 - 0.30 * hl)),
        contrast: p.contrast / 100,
        gains: channelGains(p),
        expo: Math.pow(2, p.exposure)
    };
}

function buildLut(params, gain) {
    const p = normalize(params);
    const { knee, contrast, gains, expo } = curveArgs(p);
    const lut = new Uint8Array(768);
    for (let c = 0; c < 3; c++) {
        const k = gains[c] * gain * expo;
        for (let i = 0; i < 256; i++) {
            lut[c * 256 + i] = Math.round(toneLinear(SRGB_TO_LIN[i] * k, knee, contrast) * 255);
        }
    }
    return lut;
}

// 16bit 版：表按输入值直接索引，65536 项 × 3 通道 = 393KB，不需要插值补间。
// 建表 196k 次 pow/exp 约 20ms，只在全尺寸显影时发生一次。
function buildLut16(params, gain) {
    const p = normalize(params);
    const { knee, contrast, gains, expo } = curveArgs(p);
    const lin = lin16Table();
    const T = 65536;
    const lut = new Uint16Array(3 * T);
    for (let c = 0; c < 3; c++) {
        const k = gains[c] * gain * expo;
        const base = c * T;
        for (let i = 0; i < T; i++) {
            lut[base + i] = Math.round(toneLinear(lin[i] * k, knee, contrast) * 65535);
        }
    }
    return lut;
}

// 显影视图：裁切 + 旋转。
//
// 裁切矩形用 0..1 的归一化坐标存，坐标系是「LibRaw 已经按机身方向转正后的原图」。
// 这样代理图和全尺寸图能用同一份参数，不必在渲染层按分辨率换算。
// 顺序固定为「先裁切、后旋转」：用户在主界面再转 90° 只是把 rotate 加一，
// 裁切框不需要跟着改，重新显影也能得到同一块画面。
function normalizeView(crop, rotate) {
    const t = ((Math.round(num(rotate, 0)) % 4) + 4) % 4;
    let c = null;
    if (crop && typeof crop === 'object' && !Array.isArray(crop)) {
        // 宽高先夹到 (0,1]；左上角再按宽高夹回去，避免 URL/草稿里的越界值
        // 让 worker 算出一个负的起点或 0 像素的图。
        let w = Math.min(1, Math.max(0.001, num(crop.w, 1)));
        let h = Math.min(1, Math.max(0.001, num(crop.h, 1)));
        let x = Math.min(Math.max(0, num(crop.x, 0)), 1 - w);
        let y = Math.min(Math.max(0, num(crop.y, 0)), 1 - h);
        w = Math.min(w, 1 - x);
        h = Math.min(h, 1 - y);
        // 几乎等于整张图就当没裁，少一次全图拷贝。
        if (x > 0.0005 || y > 0.0005 || w < 0.9995 || h < 0.9995) {
            c = { x, y, w, h };
        }
    }
    return { crop: c, rotate: t };
}

// 裁切 + 90°×turns 旋转，返回一块新的 RGB(A) 缓冲。
// 放在缩放之前：代理图也先从原图裁出目标区域，再缩到 1600，清晰度不会先被
// 整图缩小再裁一次。整图且不旋转时直接返回原缓冲，零拷贝。
//
// 位深按输入缓冲的类型走（Uint16Array → Uint16Array），不额外传参：
// 少一个「调用方说是 16 位、实际给了 8 位」的机会，那种错会静默产出半张黑图。
function cropRotate(src, sw, sh, channels, crop, turns) {
    const stride = channels || 3;
    const och = stride === 4 ? 4 : 3;
    const wide = src instanceof Uint16Array;
    const full16 = wide ? 65535 : 255;
    const t = ((Math.round(num(turns, 0)) % 4) + 4) % 4;
    let x0 = 0, y0 = 0, cw = sw, ch = sh;
    if (crop) {
        x0 = Math.min(sw - 1, Math.max(0, Math.floor(num(crop.x, 0) * sw)));
        y0 = Math.min(sh - 1, Math.max(0, Math.floor(num(crop.y, 0) * sh)));
        cw = Math.max(1, Math.min(sw - x0, Math.round(num(crop.w, 1) * sw)));
        ch = Math.max(1, Math.min(sh - y0, Math.round(num(crop.h, 1) * sh)));
    }
    const full = x0 === 0 && y0 === 0 && cw === sw && ch === sh;
    if (full && t === 0) return { data: src, width: sw, height: sh, colors: stride };

    const ow = (t & 1) ? ch : cw;
    const oh = (t & 1) ? cw : ch;
    const out = wide ? new Uint16Array(ow * oh * och) : new Uint8Array(ow * oh * och);

    // 不旋转时按行拷贝，24MP 也只是一次线性复制。
    if (t === 0 && och === stride) {
        for (let y = 0; y < ch; y++) {
            const s = ((y0 + y) * sw + x0) * stride;
            out.set(src.subarray(s, s + cw * stride), y * cw * stride);
        }
        return { data: out, width: cw, height: ch, colors: och };
    }

    const put = (s, d) => {
        if (stride <= 2) {
            // 单通道 RAW/灰度：复制成 RGB，后面的 LUT/BGRA 不需要再分情况。
            const v = src[s];
            out[d] = v; out[d + 1] = v; out[d + 2] = v;
        } else {
            out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2];
            if (och === 4) out[d + 3] = stride === 4 ? src[s + 3] : full16;
        }
    };
    // 旋转方向的推导：90° 顺时针把源 (x,y) 送到 (ch-1-y, x)。
    for (let sy = 0; sy < ch; sy++) {
        for (let sx = 0; sx < cw; sx++) {
            const s = ((y0 + sy) * sw + (x0 + sx)) * stride;
            let dx, dy;
            if (t === 1) { dx = ch - 1 - sy; dy = sx; }
            else if (t === 2) { dx = cw - 1 - sx; dy = ch - 1 - sy; }
            else { dx = sy; dy = cw - 1 - sx; }
            put(s, (dy * ow + dx) * och);
        }
    }
    return { data: out, width: ow, height: oh, colors: och };
}

// 缩放用面积平均（box）：缩小不会像最近邻那样出现锯齿，对代理图足够。
// 输出跟随输入位深——16 位源在缩放阶段就降到 8 位的话，后面的曝光/高光全部是在
// 已经被砍掉 8 位的数值上做，等于把 16 位解码白买了。
function resizeBox(src, sw, sh, dw, dh, channels) {
    if (dw === sw && dh === sh) return src;
    const wide = src instanceof Uint16Array;
    const out = wide ? new Uint16Array(dw * dh * 4) : new Uint8Array(dw * dh * 4);
    const full = wide ? 65535 : 255;
    const xr = sw / dw;
    const yr = sh / dh;
    const ch = channels || 3;
    for (let y = 0; y < dh; y++) {
        const y0 = Math.floor(y * yr);
        const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((y + 1) * yr)));
        for (let x = 0; x < dw; x++) {
            const x0 = Math.floor(x * xr);
            const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((x + 1) * xr)));
            let r = 0, g = 0, b = 0, n = 0;
            for (let sy = y0; sy < y1; sy++) {
                let idx = (sy * sw + x0) * ch;
                for (let sx = x0; sx < x1; sx++) {
                    r += src[idx];
                    g += src[idx + 1];
                    b += src[idx + 2];
                    idx += ch;
                    n++;
                }
            }
            const o = (y * dw + x) * 4;
            out[o] = (r / n) | 0;
            out[o + 1] = (g / n) | 0;
            out[o + 2] = (b / n) | 0;
            out[o + 3] = full;
        }
    }
    return out;
}

// 把已经缩好的 RGB 铺成 BGRA（nativeImage.createFromBitmap 要的顺序），顺手套表。
function toBgra(src, colors, width, height, lut) {
    const total = width * height;
    const out = new Uint8ClampedArray(total * 4);
    const ch = colors || 3;
    for (let i = 0; i < total; i++) {
        const s = i * ch;
        const o = i * 4;
        out[o] = lut[512 + src[s + 2]];
        out[o + 1] = lut[256 + src[s + 1]];
        out[o + 2] = lut[src[s]];
        out[o + 3] = 255;
    }
    return out;
}

// 16bit 版：查 65536 项表，最后一步才降到 8 位 BGRA。
// 量化只发生在这里一次——这才是「16 位有用」的全部意义：中间每一次曝光/对比/
// 高光肩运算都在 16 位精度上做，不是每调一次就先砍成 256 级再救。
function toBgra16(src, colors, width, height, lut) {
    const total = width * height;
    const out = new Uint8ClampedArray(total * 4);
    const ch = colors || 3;
    const T = 65536;
    for (let i = 0; i < total; i++) {
        const s = i * ch;
        const o = i * 4;
        // +128 再右移 8：四舍五入到最近的 8 位值，直接截断会让整体暗 0.5/255
        out[o] = (lut[2 * T + src[s + 2]] + 128) >> 8;
        out[o + 1] = (lut[T + src[s + 1]] + 128) >> 8;
        out[o + 2] = (lut[src[s]] + 128) >> 8;
        out[o + 3] = 255;
    }
    return out;
}

module.exports = {
    DEFAULTS, LIMITS, normalize, normalizeView, autoGain, buildLut,
    cropRotate, resizeBox, toBgra, SRGB_TO_LIN,
    // 16bit 路径：全尺寸显影才走，代理图继续用上面那套 8bit 的（解码快一倍）
    autoGain16, buildLut16, toBgra16, lin16Table, toneLinear
};

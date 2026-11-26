// ACR 实测查找表：Photoshop「Camera Raw 滤镜」在每个滑块每个档位下对 17³ 色格的
// 实测输出（Compositor 项目以 MIT 许可发布的 CameraRawTables.bin，此处转存为 zlib）。
// 为什么用它：LR/ACR 的色调引擎是私有的，公式猜不准（我们已经在高光/暗部上
// 连续翻车三次）；而我们的应用处理的同样是 8-bit sRGB 图像，和 Camera Raw 滤镜
// 的输入输出域完全一致，实测表就是最直接的 ground truth。
//
// 用法：buildTables 里把每个滑块档位的表按值线性混合成「灰轴对角线响应」
// （输入 v,v,v → 输出），作为每通道曲线替换手写公式。表保持灰守恒
// （灰进灰出），所以对角线提取对色温之外的档位是精确的。
'use strict';

(function () {
    const BRIGHT = [53, 80, 104, 130, 160, 190, 224];   // 自适应档位的背景亮度（sRGB 级）
    const AVAL = [-100, -50, -25, 0, 25, 50, 100];      // 自适应档位的滑块值

    // 表区起点（与 Compositor 的 CameraRawTables.swift 布局一致）
    // 236 起的「阴影区」不在这里读：ACR 的阴影是空间自适应的，已改由
    // shared/acr/cr-shadows.bin + app-acr-shadows.js 承担（见下方 toneFix 的说明）。
    const WB_START = 0, EXPO_START = 81, WHITES_START = 102, BLACKS_START = 111,
        SAT_START = 120, VIB_START = 129, CON_START = 138, HI_START = 187,
        MIXER_START = 285, CAL_START = 405, PARAM_START = 435,
        GRAD_START = 455, GRAD_LUM_START = 743;

    // 三维合成网格：Compositor 用 33（比 17 的表更细，合成本身几乎不增加模糊）。
    // 实测绘：33³ × 24~30 级合成在 JS 里约 23~27ms，够交互式拖动。
    const GRID = 33;
    // 混色器 8 带的顺序必须与 Compositor 一致（red, orange, yellow, green, aqua, blue, purple, magenta）
    const MIX_KEYS = ['r', 'o', 'y', 'g', 'a', 'b', 'p', 'm'];

    let T = null;        // { size, count, step, data, entries }
    let loading = null;  // Promise

    function ensure() {
        if (T) return Promise.resolve(true);
        if (!loading) {
            const api = window.qingframe;
            if (!api || !api.loadAcrTables) { loading = Promise.resolve(false); return loading; }
            loading = api.loadAcrTables().then((r) => {
                if (!r || !r.data) return false;
                T = decode(r);
                return !!T;
            }).catch(() => false);
        }
        return loading;
    }

    // 主进程已 zlib.inflate；这里做差分解码（每表每通道是前值增量）
    function decode(r) {
        try {
            const size = r.size, count = r.count, step = r.step;
            const cells = size * size * size, entries = cells * 3;
            const src = new Uint8Array(r.data);
            if (src.length !== count * entries) return null;
            const out = new Uint8Array(count * entries);
            const level = [];
            for (let i = 0; i < size; i++) level.push(Math.round(i * 255 / (size - 1)));
            for (let t = 0; t < count; t++) {
                for (let ch = 0; ch < 3; ch++) {
                    const base = (t * 3 + ch) * cells;
                    let running = 0;
                    for (let cell = 0; cell < cells; cell++) {
                        running += (src[base + cell] << 24) >> 24;
                        const axis = ch === 0 ? (cell / (size * size)) | 0
                            : ch === 1 ? ((cell / size) | 0) % size : cell % size;
                        let v = level[axis] + running * step;
                        out[t * entries + cell * 3 + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
                    }
                }
            }
            return { size, count, step, data: out, entries };
        } catch (_) { return null; }
    }

    // 一段连续取值里的两个表下标与分数（Swift 的 between(_:low:step:tables:)）
    function span(value, low, step, tables) {
        const pos = Math.min(tables - 1, Math.max(0, (value - low) / step));
        const idx = Math.min(tables - 2, Math.floor(pos));
        return [idx, pos - idx];
    }

    // 混合一个 stage（最多 8 张表）在灰轴对角线上的每通道响应。
    // 返回 {r,g,b}：各 17 个格子（0..255 等距）的输出。
    function stageDiag(parts) {
        const size = T.size, entries = T.entries, data = T.data;
        const cell0 = size * size, out = { r: [], g: [], b: [] };
        for (let i = 0; i < size; i++) {
            const cell = i * cell0 + i * size + i;
            let sr = 0, sg = 0, sb = 0;
            for (let k = 0; k < parts.length; k++) {
                const p = parts[k];
                if (!p || p.w === 0 || p.off < 0) continue;
                const base = p.off * entries + cell * 3;
                sr += p.w * data[base];
                sg += p.w * data[base + 1];
                sb += p.w * data[base + 2];
            }
            out.r.push(sr); out.g.push(sg); out.b.push(sb);
        }
        return out;
    }

    // ── 各滑块的 stage 构造（与 Swift 一一对应）──
    function whiteBalance(temp, tint) {
        const [row, down] = span(temp, -100, 25, 9);
        const [col, across] = span(tint, -100, 25, 9);
        const b = WB_START + row * 9 + col;
        return [
            { off: b, w: (1 - down) * (1 - across) }, { off: b + 1, w: (1 - down) * across },
            { off: b + 9, w: down * (1 - across) }, { off: b + 10, w: down * across }
        ];
    }
    function exposure(ev) {
        const [i, f] = span(ev, -5, 0.5, 21);
        return [{ off: EXPO_START + i, w: 1 - f }, { off: EXPO_START + i + 1, w: f }];
    }
    function plain(start, v) {
        const [i, f] = span(v, -100, 25, 9);
        return [{ off: start + i, w: 1 - f }, { off: start + i + 1, w: f }];
    }
    // 自适应档（对比度/高光/阴影）：亮度行 × 滑块值列，四表混合
    function adaptive(start, value, brightness) {
        const [row, down] = betweenPts(brightness, BRIGHT);
        const [col, across] = betweenPts(value, AVAL);
        const width = AVAL.length, base = start + row * width + col;
        return [
            { off: base, w: (1 - down) * (1 - across) }, { off: base + 1, w: (1 - down) * across },
            { off: base + width, w: down * (1 - across) }, { off: base + width + 1, w: down * across }
        ];
    }
    function betweenPts(value, pts) {
        const v = Math.min(pts[pts.length - 1], Math.max(pts[0], value));
        let i = 0;
        while (i < pts.length - 2 && v > pts[i + 1]) i++;
        return [i, (v - pts[i]) / (pts[i + 1] - pts[i])];
    }
    function fifty(start, v) {
        const [i, f] = span(v, -100, 50, 5);
        return [{ off: start + i, w: 1 - f }, { off: start + i + 1, w: f }];
    }

    // 17 格对角线 → 256 级每通道 LUT（线性插值，端点钳制）
    function toLut256(diag) {
        const size = T.size, lut = new Array(256);
        for (let i = 0; i < 256; i++) {
            const x = i * (size - 1) / 255;
            const i0 = Math.min(size - 2, Math.floor(x)), f = x - i0;
            lut[i] = (diag[i0] * (1 - f) + diag[i0 + 1] * f) / 255;
        }
        lut[0] = Math.min(lut[0], lut[1]);
        lut[255] = Math.max(lut[255], lut[254]);
        return lut;
    }

    // 依次施加多个 stage 的对角线（灰进灰出，通道不发散时安全）
    function composeDiags(diags) {
        // diags: [{r,g,b}]，把后一个作用在前一个的输出上（按 17 格线性插值）
        return diags.reduce((acc, d) => {
            const out = { r: [], g: [], b: [] };
            for (let c = 0; c < 3; c++) {
                const key = ['r', 'g', 'b'][c], src = acc[key], fn = d[key];
                for (let i = 0; i < T.size; i++) {
                    const v = src[i] / 255 * (T.size - 1);
                    const i0 = Math.min(T.size - 2, Math.max(0, Math.floor(v))), f = v - i0;
                    out[key].push(fn[i0] * (1 - f) + fn[i0 + 1] * f);
                }
            }
            return out;
        });
    }

    // 白平衡表的**绿轴标定**。
    // 表本身来自 ACR（Compositor 的 CameraRawTables），索引方式与 Swift 源码一致，
    // 但实测 tint 方向对 G 的作用幅度是 Lightroom 的两倍：
    //   LR 三档导出（tint=0/50/100，其余完全相同）实测斜率比
    //   R 0.99 / B 0.95 / G **2.00**。
    // 结果是 tint 一给，绿色被压掉双份，黄叶与暖墙整体转向品红（色相 −13°）。
    // 这里把「相对中性」的 G 偏移折半，只动 tint 那条轴，R/B 不碰。
    const WB_G_FIX = 0.5;

    // WB stage 对中性灰的 G 响应（1 = 不偏），据此算出补偿增益。
    // 注意不能拿「1」当基准：表里含着相机 as-shot 的基线，tint=0 时本身就偏离 1
    // （实测偏到 0.88，若按 1 补会把整张图抬绿 14%）。基准取同温度下 tint=0 的那一列。
    function neutralG(parts) {
        if (!T || !parts || !parts.length) return 1;
        const d = stageDiag(parts);
        const mid = (T.size - 1) >> 1;
        const g = d.g[mid] / 255;
        return (g > 0.02 && g < 2) ? g : 1;
    }
    function wbGreenGain(wbParts, temp) {
        if (!T || !wbParts || !wbParts.length) return 1;
        const gNow = neutralG(wbParts);
        const gZero = neutralG(whiteBalance(temp || 0, 0));
        return 1 + WB_G_FIX * (1 - gNow / gZero);
    }

    // 单通道增益 stage（对角线，长度 = 表格尺寸，值域 0..255）
    function gainDiag(gc) {
        const size = T.size, out = { r: [], g: [], b: [] };
        for (let i = 0; i < size; i++) {
            const v = i / (size - 1) * 255;
            out.r.push(v); out.g.push(v * gc); out.b.push(v);
        }
        return out;
    }

    // ── 通道平衡（整条 ACR 链的定标）─────────────────────────────────
    // 曾经想用一条逐通道增益修掉「整体偏品红」：与 LR **自己的导出**逐块对拍
    // （tools/patch-lab.js + tools/gain-fit.js），线性光下我们的 G 一律低 7~8%、
    // R 低 3~4%，tint=0 与 tint=50 两次独立拟合还给出同一个数（ΔG 只差 0.02），
    // 看着像链路固定偏置（等价于相机 Profile 缺了一条通道平衡）。
    // ⚠ 实测结论：这条平衡**不该开**，已停用（常量留 1.0 备查）。
    // 上一轮把「线性光下 G 低 7~8%」直接当成「画面偏品红」，用 G×1.095 去补。
    // 但换到 Lab 口径复测（tools/bal-eval.js，全分辨率 5905×3937，对 LR 自己的导出）：
    //     不开             ΔE 8.95   Δa +0.61   Δb +1.25
    //     G1.025           ΔE 9.00   Δa +0.18   Δb +1.69
    //     G1.050           ΔE 9.11   Δa −0.24   Δb +2.15
    //     G1.095（原设置）  ΔE 9.44   Δa −1.06   Δb +2.98
    // 误差随 G **单调上升**：加绿把 a* 从「偏正」推成「偏负」，同时把 b* 一路推高。
    // 原因是线性光的逐通道比不等价于 Lab 的 a*——G 提上来 L 也跟着变，感知的红绿轴
    // 并不同步。当时只看了线性光的数字，没在 Lab 上复核，是过冲。
    // 副作用很显眼：这条挂在三维表末尾，任何走 ACR 链的画面都吃它，所以边框墙的
    // 「本图预览」缩略图也会整片变样（用户看到的「封面墙全变了」就是这里）。
    const ACR_BAL = { r: 1.0, g: 1.0, b: 1.0 };
    const BAL_ON = ACR_BAL.r !== 1 || ACR_BAL.g !== 1 || ACR_BAL.b !== 1;
    const BAL_LUT = (() => {
        const toLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        const toSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
        const mk = (g) => {
            const a = new Float32Array(256);
            for (let i = 0; i < 256; i++) a[i] = 255 * toSrgb(Math.min(1, g * toLin(i / 255)));
            return a;
        };
        return { r: mk(ACR_BAL.r), g: mk(ACR_BAL.g), b: mk(ACR_BAL.b) };
    })();
    // 平衡是**中低亮度**的定标（拟合用的六块：黄叶两块、墙、天光、路面、暗部，
    // 全在中调以下）。一路乘到白点会出事：高光再乘 G×1.095，最亮 6% 的 Lab 色相
    // 被推绿 +10°，G 比 LR 高 25 级，叶子缝里的天光就从金黄变成黄白。
    // 所以按亮度淡出——L* 80 以下全量，L* 97 以上归零，中间平滑过渡。
    const BAL_FADE = [0.60, 0.88];      // 线性光亮度
    const BAL_LIN = (() => {
        const a = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            const e = i / 255;
            a[i] = e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4);
        }
        return a;
    })();
    // ── 高光收口（顶端那段色阶复位）───────────────────────────────
    // 逐像素拿「我们」和 LR 自己的导出比线性光亮度，按亮度分箱取比值中位数，
    // 得到一条 k(Y)（tools/k-curve.js）：
    //   Y 0.30~0.45  k≈1      中调已经对齐，不要碰
    //   Y 0.55       k 0.95
    //   Y 0.75       k 0.91
    //   Y 0.85~0.93  k 0.89   ← 高光整体亮了约一成一
    //   Y →1         k →1      纯白仍是纯白（两端都截断，不该压成灰）
    // 表现就是叶子缝里的天光先于 LR 冲到白：最亮 6% 我们 238/227/192、LR 225/205/168，
    // 差的那 13~24 级全在这一段。按亮度等比缩放（三通道同乘）不动机色相与彩度，
    // 只把顶端色阶拉开，等价于「高光段多给一点对比」。
    // 锚点第二列就是**乘数 k**（不是输出亮度），所以插值完直接存，不要再除 x
    const HI_K_PTS = [[0, 1], [0.30, 1], [0.45, 0.962], [0.55, 0.948], [0.65, 0.936],
        [0.75, 0.912], [0.85, 0.890], [0.92, 0.894], [1, 1]];
    // 单调三次插值（Fritsch–Carlson）：锚点之间平滑、不会过冲，避免亮部出现台阶
    const HI_K = (() => {
        const pts = HI_K_PTS, n = pts.length;
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const d = [], m = new Array(n).fill(0);
        for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
        m[0] = d[0]; m[n - 1] = d[n - 2];
        for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
        for (let i = 0; i < n - 1; i++) {
            if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
            const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
            if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
        }
        const out = new Float32Array(256);
        for (let v = 0; v < 256; v++) {
            const x = v / 255;
            let i = 0;
            while (i < n - 2 && x > xs[i + 1]) i++;
            const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
            const t2 = t * t, t3 = t2 * t;
            const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
                + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
            out[v] = Math.max(0.5, Math.min(1.2, y));
        }
        out[255] = 1;
        return out;
    })();
    function toSrgbLin(v) {
        if (v <= 0) return 0;
        if (v >= 1) return 1;
        return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    }
    function hiRolloff(rgba, n) {
        for (let i = 0; i < n; i++) {
            const p = i * 4;
            const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
            const y = 0.2126 * BAL_LIN[r] + 0.7152 * BAL_LIN[g] + 0.0722 * BAL_LIN[b];
            if (y < 0.16) continue;                       // k=1 的区间，省掉一次查表
            const k = HI_K[Math.round(y * 255)];
            if (k > 0.999) continue;
            const vr = Math.round(255 * toSrgbLin(BAL_LIN[r] * k));
            const vg = Math.round(255 * toSrgbLin(BAL_LIN[g] * k));
            const vb = Math.round(255 * toSrgbLin(BAL_LIN[b] * k));
            rgba[p] = vr < 0 ? 0 : vr;
            rgba[p + 1] = vg < 0 ? 0 : vg;
            rgba[p + 2] = vb < 0 ? 0 : vb;
        }
    }

    // 只能挂在**三维表的最后一步**：色调那条链的 pre() 是「亮度取对角线、色度取三维」，
    // 逐通道增益属于色度，挂在滤镜里会被三维表的彩度顶掉（还会被 pre 的反解算两遍）。
    function balanceApply(rgba, n) {
        const lo = BAL_FADE[0], span = BAL_FADE[1] - BAL_FADE[0];
        for (let i = 0; i < n; i++) {
            const p = i * 4;
            const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
            const y = 0.2126 * BAL_LIN[r] + 0.7152 * BAL_LIN[g] + 0.0722 * BAL_LIN[b];
            let t = (y - lo) / span;
            if (t <= 0) {
                rgba[p] = Math.round(BAL_LUT.r[r]);
                rgba[p + 1] = Math.round(BAL_LUT.g[g]);
                rgba[p + 2] = Math.round(BAL_LUT.b[b]);
                continue;
            }
            if (t >= 1) continue;                     // 高光端不补：原样输出
            const w = 1 - t * t * (3 - 2 * t);        // smoothstep 淡出
            rgba[p] = Math.round(r + (BAL_LUT.r[r] - r) * w);
            rgba[p + 1] = Math.round(g + (BAL_LUT.g[g] - g) * w);
            rgba[p + 2] = Math.round(b + (BAL_LUT.b[b] - b) * w);
        }
    }

    // ── 色调 stage 组（曝光→白平衡→对比度→高光→白→黑，ACR 顺序）──
    // 返回「stage 权重组」列表，供两条路复用：灰轴对角线（CSS 滤镜）与三维（补彩度）。
    function toneParts(p, bright) {
        if (!T) return null;
        bright = bright || {};
        const bc = bright.con == null ? 128 : bright.con;
        const bh = bright.hi == null ? 128 : bright.hi;
        const parts = [];
        if (p.exp) parts.push({ k: 'exp', s: exposure(Math.max(-5, Math.min(5, p.exp))) });
        if (p.temp || p.tint) parts.push({ k: 'wb', s: whiteBalance(p.temp || 0, p.tint || 0) });
        if (p.con) parts.push({ k: 'con', s: adaptive(CON_START, p.con, bc) });
        if (p.hi) parts.push({ k: 'hi', s: adaptive(HI_START, p.hi, bh) });
        // 阴影**不在这里**：ACR 的阴影是空间自适应的（同一个 −30，只压暗「比周围更暗
        // 且低于全图参考亮度」的区域），灰轴对角线只能做「全图暗部一起压」。改由
        // app-acr-shadows.js 在色调之后单独跑一遍。
        if (p.white) parts.push({ k: 'white', s: plain(WHITES_START, p.white) });
        if (p.black) parts.push({ k: 'black', s: plain(BLACKS_START, p.black) });
        return parts.length ? parts : null;
    }

    // 对外：色调的灰轴对角线（每通道 256 级），给 CSS 滤镜用
    function toneStages(p, bright) {
        const parts = toneParts(p, bright);
        if (!parts) return null;
        const chain = [];
        for (let i = 0; i < parts.length; i++) {
            chain.push(stageDiag(parts[i].s));
            // 绿轴补偿必须紧跟白平衡，不能挪到链尾（后面还有对比度/高光/白/黑，
            // 放到末尾会连高光端一起乘，白点被推过 255）
            if (parts[i].k === 'wb') {
                const gc = wbGreenGain(parts[i].s, p.temp);
                if (Math.abs(gc - 1) > 0.002) chain.push(gainDiag(gc));
            }
        }
        const d = chain.length === 1 ? chain[0] : composeDiags(chain);
        return { r: toLut256(d.r), g: toLut256(d.g), b: toLut256(d.b) };
    }

    // 参数曲线：用实测参数曲线表替换公式换算（值 −100..100 步 50）
    // 返回 17 格控制点 [{x,y}…]（0..1），失败返回 null
    function parametricDiag(sh, dk, lt, hi) {
        if (!T) return null;
        const stages = [];
        if (sh) stages.push(stageDiag(fifty(PARAM_START + 0 * 5, sh)));
        if (dk) stages.push(stageDiag(fifty(PARAM_START + 1 * 5, dk)));
        if (lt) stages.push(stageDiag(fifty(PARAM_START + 2 * 5, lt)));
        if (hi) stages.push(stageDiag(fifty(PARAM_START + 3 * 5, hi)));
        if (!stages.length) return null;
        const d = stages.length === 1 ? stages[0] : composeDiags(stages);
        const size = T.size, pts = [];
        for (let i = 0; i < size; i++) {
            const y = Math.max(0, Math.min(1, d.r[i] / 255));   // 灰轴上三通道一致
            pts.push([Math.round(i / (size - 1) * 100) / 100, Math.round(y * 100) / 100]);
        }
        // 单调性兜底
        for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1];
        return pts;
    }

    // ── 三维合成：混色器 / 校准 / 饱和度 / 自然饱和度 / 颜色分级 ─────
    // 这些档位是**跨通道**的（同一个滑块对红黄蓝的作用完全不同），灰轴对角线
    // 提取不出来，必须整格合成。Compositor 正是把这些 stage 合成到 33³ 再查表。
    const _blend = new Float32Array(17 * 17 * 17 * 3);
    // 「不变」的那张表：颜色分级在饱和度落到 0 档时 Compositor 放的是 nil，
    // 权重缺口必须补成恒等（否则权重和不为 1，绝对输出会被按缺口比例压暗 ——
    // 实测整套预设会整整暗 4 倍）。
    let IDENT = null;
    function buildIdent() {
        const size = T.size, cells = size * size * size;
        const level = [];
        for (let i = 0; i < size; i++) level.push(Math.round(i * 255 / (size - 1)));
        const out = new Float32Array(cells * 3);
        for (let cell = 0; cell < cells; cell++) {
            out[cell * 3] = level[(cell / (size * size)) | 0];
            out[cell * 3 + 1] = level[((cell / size) | 0) % size];
            out[cell * 3 + 2] = level[cell % size];
        }
        return out;
    }

    // 把一个 stage（最多 8 张表 + 权重）混成一张 17³ 表。用 Float32 中间量，
    // 免得每级都量化一次（8 级串下来会攒出可见误差）。
    function blendInto(parts) {
        const entries = T.entries, data = T.data;
        if (!IDENT) IDENT = buildIdent();
        _blend.fill(0);
        let wsum = 0;
        for (let k = 0; k < parts.length; k++) {
            const p = parts[k];
            if (!p || p.w === 0 || p.off < 0 || p.off >= T.count) continue;
            const base = p.off * entries, w = p.w;
            wsum += w;
            for (let i = 0; i < entries; i++) _blend[i] += w * data[base + i];
        }
        const miss = 1 - wsum;
        if (miss > 1e-6 || miss < -1e-6) {
            for (let i = 0; i < entries; i++) _blend[i] += miss * IDENT[i];
        }
    }

    // 把一组 stage 依次作用到 grid³ 网格上：每级一次三线性采样。
    // 表存的是**绝对输出色**（level + 累计增量），所以合成就是 f_n(…f_1(c))。
    // pre：可选的起点映射（输入网格点 → 起始颜色）。色调的三维补偿用它把
    // 「CSS 滤镜已经按对角线改过的颜色」先还原成真实的三维结果。
    function compose3d(partsList, grid, pre, bal) {
        const n = grid * grid * grid;
        const cur = new Float32Array(n * 3);
        const lv = new Float32Array(grid);
        for (let i = 0; i < grid; i++) lv[i] = i * 255 / (grid - 1);
        let q = 0;
        for (let bi = 0; bi < grid; bi++) {
            for (let gi = 0; gi < grid; gi++) {
                for (let ri = 0; ri < grid; ri++, q += 3) {
                    if (pre) {
                        const c = pre(lv[ri], lv[gi], lv[bi]);
                        cur[q] = c[0]; cur[q + 1] = c[1]; cur[q + 2] = c[2];
                    } else {
                        cur[q] = lv[ri]; cur[q + 1] = lv[gi]; cur[q + 2] = lv[bi];
                    }
                }
            }
        }
        const SZ = T.size, S = SZ - 1, P2 = SZ * SZ, P3 = P2 * 3, R3 = SZ * 3;
        for (let s = 0; s < partsList.length; s++) {
            blendInto(partsList[s]);
            let p3 = 0;
            for (let i = 0; i < n; i++, p3 += 3) {
                const x = cur[p3] * (S / 255), y = cur[p3 + 1] * (S / 255), z = cur[p3 + 2] * (S / 255);
                let i0 = x | 0; if (i0 > S - 1) i0 = S - 1;
                let j0 = y | 0; if (j0 > S - 1) j0 = S - 1;
                let k0 = z | 0; if (k0 > S - 1) k0 = S - 1;
                const fx = x - i0, fy = y - j0, fz = z - k0;
                // 格子里 r 最慢、b 最快，每格 3 字节：r 邻 +P3、g 邻 +R3、b 邻 +3
                const o = (i0 * P2 + j0 * SZ + k0) * 3;
                const oi = o + P3, oj = o + R3, oij = oi + R3;
                const ok = o + 3, oik = oi + 3, ojk = oj + 3, oijk = oij + 3;
                const w0 = 1 - fx;
                for (let ch = 0; ch < 3; ch++) {
                    const v00 = _blend[o + ch] * w0 + _blend[oi + ch] * fx;
                    const v10 = _blend[oj + ch] * w0 + _blend[oij + ch] * fx;
                    const v01 = _blend[ok + ch] * w0 + _blend[oik + ch] * fx;
                    const v11 = _blend[ojk + ch] * w0 + _blend[oijk + ch] * fx;
                    const v0 = v00 + (v10 - v00) * fy, v1 = v01 + (v11 - v01) * fy;
                    cur[p3 + ch] = v0 + (v1 - v0) * fz;
                }
            }
        }
        // RGBA：行字节数天然 4 对齐，上传纹理不用改 UNPACK_ALIGNMENT。
        // 纹理是 grid 张 grid×grid 切片横排（宽 grid*grid、高 grid）：
        // 纹素 (x=bi*grid+ri, y=gi)，所以这里要按**纹素序**落盘，不能直接用节点序。
        const rgba = new Uint8Array(n * 4);
        for (let gi = 0; gi < grid; gi++) {
            for (let bi = 0; bi < grid; bi++) {
                for (let ri = 0; ri < grid; ri++) {
                    const s3 = (bi * grid * grid + gi * grid + ri) * 3;
                    const d4 = (gi * grid * grid + bi * grid + ri) * 4;
                    for (let ch = 0; ch < 3; ch++) {
                        const v = Math.round(cur[s3 + ch]);
                        rgba[d4 + ch] = v < 0 ? 0 : (v > 255 ? 255 : v);
                    }
                    rgba[d4 + 3] = 255;
                }
            }
        }
        // bal 里的高光收口是**引擎级定标**，会作用到每一张走 ACR 链的画面，
        // 包括边框墙的「本图预览」缩略图。通道平衡默认关闭（见 ACR_BAL 的说明）。
        // _noBalance 只给 tools/ 下的标定脚本开，用来量这两级到底把画面推了多少。
        const noBal = typeof window !== 'undefined' && window.QfsAcr && window.QfsAcr._noBalance;
        if (bal && !noBal) {
            if (BAL_ON) balanceApply(rgba, n);
            hiRolloff(rgba, n);
        }
        return { grid, rgba };
    }
    // 三线性采样一张已合成的 grid³ 表（纹理布局：x = 蓝*grid + 红，y = 绿）
    function sampleTable(t, r, g, b) {
        const G = t.grid, S = G - 1, A = t.rgba;
        const x = Math.min(S, Math.max(0, r) * S / 255);
        const y = Math.min(S, Math.max(0, g) * S / 255);
        const z = Math.min(S, Math.max(0, b) * S / 255);
        const i0 = Math.min(S - 1, Math.floor(x)), j0 = Math.min(S - 1, Math.floor(y)), k0 = Math.min(S - 1, Math.floor(z));
        const fx = x - i0, fy = y - j0, fz = z - k0;
        const at = (ri, gi, bi) => ((gi * G + bi) * G + ri) * 4;
        const out = [0, 0, 0];
        for (let ch = 0; ch < 3; ch++) {
            const c00 = A[at(i0, j0, k0) + ch] * (1 - fx) + A[at(i0 + 1, j0, k0) + ch] * fx;
            const c10 = A[at(i0, j0 + 1, k0) + ch] * (1 - fx) + A[at(i0 + 1, j0 + 1, k0) + ch] * fx;
            const c01 = A[at(i0, j0, k0 + 1) + ch] * (1 - fx) + A[at(i0 + 1, j0, k0 + 1) + ch] * fx;
            const c11 = A[at(i0, j0 + 1, k0 + 1) + ch] * (1 - fx) + A[at(i0 + 1, j0 + 1, k0 + 1) + ch] * fx;
            const c0 = c00 * (1 - fy) + c10 * fy, c1 = c01 * (1 - fy) + c11 * fy;
            out[ch] = c0 * (1 - fz) + c1 * fz;
        }
        return out;
    }

    // 单调曲线的反解：给输出 y 找回输入 x（1017 级，够用且只建一次）
    const INV_N = 1017;
    function rampInverse(lut) {
        const out = new Float32Array(INV_N);
        let j = 0;
        for (let i = 0; i < INV_N; i++) {
            const y = i / (INV_N - 1);
            while (j < 254 && lut[j + 1] < y) j++;
            const y0 = lut[j], y1 = lut[j + 1];
            const f = y1 > y0 ? (y - y0) / (y1 - y0) : 0;
            out[i] = Math.max(0, Math.min(1, (j + f) / 255));
        }
        return out;
    }

    // ── 色调的三维补偿 ───────────────────────────────────────────
    // ACR 的曝光/白平衡/对比度/高光/白/黑是 17³ 三维表，作用到彩色像素时会改变
    // 彩度；只取灰轴对角线做成逐通道曲线就丢掉了这部分。实测：黄叶 (200,170,70)
    // 走三维 57.2、走对角线 48.4（少 15%），暖色墙面少 35%（灰轴本身不受影响）。
    // 这就是「颜色不够艳」的主因——混色器那点 −13 的饱和度只是小头。
    //
    // 做法：CSS 滤镜仍然按对角线跑（快、无 GL 也能用），但把差量做成一张三维修正
    // 表，折进已有的三维色表：网格点 y 先反解回 x（滤镜上还叠了用户曲线，所以要
    // 「曲线⁻¹ ∘ 对角线⁻¹」一起反），再过真实三维色调 → 得 z，然后照常串颜色
    // stage。整条链于是等于「三维色调 → 三维颜色」，不增加 pass。
    //
    // 只在滤镜里除了色调+曲线没有别的逐像素步骤时才补：色彩平衡/渐变映射/整体 gamma
    // 也串在那条滤镜后面，混进来反解就不准了（它们都不是 ACR 的档位，默认全关）。
    const _fixCache = { key: '', fix: null };
    const FIX_GRID = 33;
    function toneFix(p, bright, curveSig) {
        const parts = toneParts(p, bright);
        if (!parts) return null;
        const diag = toneStages(p, bright);
        const key = FIX_GRID + '|' + (curveSig || '-') + '|'
            + diag.r.join(',') + '|' + diag.g.join(',') + '|' + diag.b.join(',');
        if (_fixCache.key === key) return _fixCache.fix;
        const t3 = compose3d(parts.map((x) => x.s), FIX_GRID);
        // 三维表里没有绿轴补偿（那是给对角线加的），这里补上同一个增益，
        // 否则「亮度取对角线、色度取三维」两边会对不上，暗部会重新偏品红
        const wbPart = parts.find((x) => x.k === 'wb');
        const gc = wbPart ? wbGreenGain(wbPart.s, p.temp) : 1;
        // 滤镜实际做的是 curve(diag(x))，所以反解要连曲线一起反
        const C = window.QfsCurve;
        const cl = (C && C.curveActive(p.curve)) ? C.buildCurveLuts(p.curve) : null;
        const chainOf = (d, c) => {
            if (!c) return d;
            const out = new Array(256);
            for (let i = 0; i < 256; i++) {
                const v = Math.min(1, Math.max(0, d[i]));
                out[i] = c[Math.min(255, Math.round(v * 255))];
            }
            return out;
        };
        const invR = rampInverse(chainOf(diag.r, cl && cl.r));
        const invG = rampInverse(chainOf(diag.g, cl && cl.g));
        const invB = rampInverse(chainOf(diag.b, cl && cl.b));
        const at = (ramp, v) => ramp[Math.min(INV_N - 1, Math.max(0, Math.round(v / 255 * (INV_N - 1))))] * 255;
        const fix = {
            key,
            // 只借三维的**彩度**，亮度仍用对角线那条（也就是滤镜已经给出的值）。
            // 六个 stage 串起来的三维合成在暗部会把整片压得更暗（实测 5% 分位掉 11 级，
            // 而 LR 只掉 2 级）——那是逐级 8 位表复合的累积误差，不是 ACR 的真实行为。
            // 彩度差是实打实的（黄叶少 15%），所以按「亮度取对角线、色度取三维」拼回去。
            pre(r, g, b) {
                const z = sampleTable(t3, at(invR, r), at(invG, g), at(invB, b));
                z[1] *= gc;
                const lz = 0.2126 * z[0] + 0.7152 * z[1] + 0.0722 * z[2];
                const ly = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                // 加性重构（亮度换成对角线的、各通道保留与三维的差值）。
                // 试过乘性版本（z * ly/lz）：色相理论上更稳，但实测 a*/b* 都更差
                // —— 三维与对角线的亮度本来就差得远（饱和黄 57 vs 48），一乘法
                // 连彩度一起缩了。留着加性。
                // 也试过「高光端把三维彩度淡出、退回对角线」（ly 190→240）：最亮 6%
                // 的均值只动 0.4 级，说明那段的三维与对角线本来就重合——真正把高光
                // 洗白的是混色器（关掉它 B 立刻从 196 掉到 179），所以不保留这段代码。
                return [ly + z[0] - lz, ly + z[1] - lz, ly + z[2] - lz];
            }
        };
        _fixCache.key = key;
        _fixCache.fix = fix;
        return fix;
    }
    // 校准：红/绿/蓝 各自的色相与饱和，顺序与 Swift 一致
    function calStages(cal) {
        const out = [];
        const vals = [cal.rh, cal.rs, cal.gh, cal.gs, cal.bh, cal.bs];
        for (let i = 0; i < 6; i++) {
            const v = Number(vals[i]) || 0;
            if (v) out.push(fifty(CAL_START + i * 5, v));
        }
        return out;
    }

    // 混色器：明亮度 → 饱和度 → 色相（Compositor 实测出「这个顺序合成才像 PS」）
    function mixerStages(mix) {
        const out = [];
        const kinds = ['l', 's', 'h'];
        for (let kind = 0; kind < 3; kind++) {
            for (let c = 0; c < 8; c++) {
                const band = mix[MIX_KEYS[c]];
                const v = band ? (Number(band[kinds[kind]]) || 0) : 0;
                if (v) out.push(fifty(MIXER_START + (kind * 8 + c) * 5, v));
            }
        }
        return out;
    }

    // 颜色分级：先四个亮度滑块，再 全局 → 中间调 → 高光 → 阴影（Compositor 的顺序）
    function gradingStages(cg) {
        const out = [];
        const zones = ['shadow', 'mid', 'high', 'global'];   // 亮度表下标 0..3
        for (let i = 0; i < 4; i++) {
            const z = cg[zones[i]] || {};
            const l = Number(z.l) || 0;
            if (l) out.push(fifty(GRAD_LUM_START + i * 5, l));
        }
        const bal = (Number(cg.balance) || 0) / 100;
        const hiShare = Math.max(0, bal < 0 ? 1 + 1.4 * bal : 1 + 2 * bal);
        const shShare = Math.max(0, bal < 0 ? 1 - 1.2 * bal : 1 - 1.4 * bal);
        const bl = Number.isFinite(Number(cg.blending)) ? Number(cg.blending) : 50;
        const [blendLow, blendUp] = betweenPts(bl, [0, 50, 100]);
        // [轮下标, 我们的分区键, 平衡占比, 是否随 Blending 插值]
        const wheels = [[3, 'global', 1, false], [2, 'mid', 1, false],
            [1, 'high', hiShare, true], [0, 'shadow', shShare, true]];
        for (const w of wheels) {
            const wheel = w[0], z = cg[w[1]] || {}, s = (Number(z.s) || 0) * w[2];
            if (!(s > 0)) continue;
            const h = ((Number(z.h) || 0) % 360 + 360) % 360;
            const pos = h / 30;
            const first = Math.floor(pos) % 12, second = (first + 1) % 12;
            const around = pos - Math.floor(pos);
            const [level, up] = betweenPts(s, [0, 25, 50, 100]);
            const parts = [];
            const blendings = w[3] ? [[blendLow, 1 - blendUp], [blendLow + 1, blendUp]] : [[1, 1]];
            for (let bi = 0; bi < blendings.length; bi++) {
                const bIdx = blendings[bi][0], bW = blendings[bi][1];
                const base = bIdx === 0 ? GRAD_START + wheel * 36
                    : (bIdx === 1 ? GRAD_START + 72 + wheel * 36 : GRAD_START + 216 + wheel * 36);
                const hues = [[first, 1 - around], [second, around]];
                const sats = [[level, 1 - up], [level + 1, up]];
                for (let hi2 = 0; hi2 < 2; hi2++) {
                    for (let si = 0; si < 2; si++) {
                        const sat = sats[si][0];
                        if (sat === 0) continue;   // 没有「饱和 0」这张表，等于不变
                        parts.push({ off: base + hues[hi2][0] * 3 + sat - 1, w: bW * hues[hi2][1] * sats[si][1] });
                    }
                }
            }
            if (parts.length) out.push(parts.slice(0, 8));
        }
        return out;
    }

    // 滤镜里除色调/曲线之外还有别的**逐像素标量**步骤吗（整体 gamma）。
    // 有的话「按对角线反解」不成立，宁可不补。
    // 色彩平衡 / 渐变映射不在此列：它们已改由 colorLut 的 extra 钩子接管，
    // 不再写进滤镜表了（以前一旦开启就整个跳过三维色调补偿，连带把饱和度的
    // 表现也改掉，是个隐蔽的串扰）。
    function extrasInFilter(p) {
        return !!(Number(p.gam) || 0);
    }

    // ── 对外：颜色侧三维 LUT（校准 → 饱和度 → 自然饱和度 → 混色器 → 颜色分级）──
    // 返回 { grid, rgba }；没有可测档位时返回 null（调用方退回原路径）。
    // 两个常用网格各留一份缓存：预览用小网格（快），静置/导出用大网格（精）。
    // 只留一份会在「拖动→静置」来回时反复重算。
    //
    // bright：色调三维补偿所需的亮度测度（对比度/高光自适应档）。不传就不补，
    // 结果退回「对角线彩度」那一版（略欠饱和，但不会错色）。
    //
    // extra：色彩平衡 / 渐变映射这类**公式型跨通道**算子，由调用方给出
    // { key, pre(r,g,b) → [r,g,b] }（app-grade.js 的 cbgmPrep）。它们没有实测表，
    // 但同样必须按像素的真实 RGB 算 —— 逐通道表只能看见单通道的值，灰阶上碰巧
    // 相等，彩色上就错（饱和橙走渐变映射差 76 级、色相反掉）。
    // 位置接在色调修正之后、颜色档位之前，与原先「曲线之后」的滤镜顺序一致。
    const _lutCache = {};
    let _lutSeq = 0;
    function colorLut(p, grid, bright, extra) {
        if (!T || !p) return null;
        const parts = [];
        if (p.cal) parts.push.apply(parts, calStages(p.cal));
        const sat = Number(p.sat) || 0;
        if (sat) parts.push(plain(SAT_START, sat));
        const vib = Number(p.vib) || 0;
        if (vib) parts.push(plain(VIB_START, vib));
        if (p.mix) parts.push.apply(parts, mixerStages(p.mix));
        if (p.cg) parts.push.apply(parts, gradingStages(p.cg));
        const C2 = window.QfsCurve;
        const curveSig = (C2 && C2.curveActive(p.curve)) ? C2.curveSignature(p.curve) : '-';
        const fix = (bright && !extrasInFilter(p)) ? toneFix(p, bright, curveSig) : null;
        // 格点先反解回「真实三维色调」，再交给色彩平衡 / 渐变映射
        // （fix.pre 返回数组，extra.pre 收三个数字，这里转一次）
        const pre = (fix && extra) ? (r, g, b) => {
            const c = fix.pre(r, g, b);
            return extra.pre(c[0], c[1], c[2]);
        } : (fix ? fix.pre : (extra ? extra.pre : null));
        if (!parts.length && !pre) return null;
        const key = (fix ? 'T|' + fix.key + '|' : '')
            + (extra ? 'X|' + extra.key + '|' : '')
            + parts.map((q) => q.map((x) => x.off + ':' + x.w.toFixed(4)).join(' ')).join('|');
        const g = grid || GRID;
        const slot = _lutCache[g];
        if (slot && slot.key === key && slot.lut) return slot.lut;
        const out = compose3d(parts, g, pre, true);
        out.token = ++_lutSeq;   // 纹理上传的变更凭据
        _lutCache[g] = { key, lut: out };
        return out;
    }

    // 高光档要读「这张图的高光有多亮」，所以取最亮 10% 像素的平均亮度（sRGB 级）。
    // 早先沿用 Compositor 的最亮通道对数平均（几何均值），实测会翻车：暗背景加一小块
    // 天空的图（DSC09381 就是）几何均值只有 77，落进 53/80 这一档，而该档下高光 −100
    // 是「压全图」——中间调 128 被压到 89、160 被压到 107，整张发灰；同一张图在 PS 里
    // 只压顶部。改按高光端取值后这张图落到 160 档，128 只掉 3 级，与 LR 吻合。
    // 理由：Photoshop 的自适应键描述的是「高光区有多亮」，不该被大片暗部拖低。
    const HI_TOP_FRACTION = 0.10;

    // 图片亮度测度（sRGB 级 0..255）：对比度用最亮通道线性光均值，阴影用平均亮度，
    // 高光用高光端（见上）。缩略图上算，拖动滑块时不会重复采样。
    function measureBrightness(src) {
        const fallback = { con: 128, hi: 128, sh: 128 };
        if (!src || !src.naturalWidth) return fallback;
        try {
            const w = 96, h = Math.max(1, Math.round(96 * src.naturalHeight / src.naturalWidth));
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(src, 0, 0, w, h);
            const d = g.getImageData(0, 0, w, h).data;
            let sumB = 0, sumL = 0, n = 0;
            const hist = new Uint32Array(256);   // 最亮通道的编码级直方图，供高光档取分位
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] < 8) continue;
                const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
                const mx = Math.max(r, gg, b);
                const lin = mx <= 0.04045 ? mx / 12.92 : Math.pow((mx + 0.055) / 1.055, 2.4);
                const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
                sumB += lin; sumL += lum; n++;
                hist[Math.round(mx * 255)]++;
            }
            if (!n) return fallback;
            const enc = (v) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
            // 从最亮一级往下数满 10%，取这些像素的均值——对个别过曝斑点不敏感，
            // 又不会被大面积暗部拉低。
            let need = n * HI_TOP_FRACTION, sum = 0, weight = 0;
            for (let v = 255; v >= 0 && need > 0; v--) {
                const take = Math.min(hist[v], need);
                if (take > 0) { sum += v * take; weight += take; need -= take; }
            }
            return {
                con: Math.round(enc(sumB / n) * 255),
                sh: Math.round(enc(sumL / n) * 255),
                hi: weight > 0 ? Math.round(sum / weight) : fallback.hi
            };
        } catch (_) { return fallback; }
    }

    // Camera Raw 去薄雾用的「雾色」：全图最亮 1% 像素的平均色（按亮度阈值取）。
    // 移植自 Compositor 的 dehaze_haze()，同样在缩略图上算——最亮 1% 的均值
    // 对分辨率不敏感，而全图扫两遍在拖动时太贵。
    function dehazeHaze(src) {
        if (!src || !src.naturalWidth) return null;
        try {
            const w = 192, h = Math.max(1, Math.round(192 * src.naturalHeight / src.naturalWidth));
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(src, 0, 0, w, h);
            const d = g.getImageData(0, 0, w, h).data;
            const hist = new Float64Array(256);
            const n = w * h;
            for (let i = 0, p = 0; i < n; i++, p += 4) {
                const level = Math.round(255 * (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255);
                hist[level < 0 ? 0 : (level > 255 ? 255 : level)]++;
            }
            let total = 0;
            for (let i = 0; i < 256; i++) total += hist[i];
            if (!total) return null;
            let threshold = 255;
            for (let above = 0; threshold > 0 && above + hist[threshold] < total * 0.01; --threshold) above += hist[threshold];
            // 阈值之上一个像素都没有时（纯色图），把阈值降到底：整幅都是雾，ACR 也是不动它
            let sumR = 0, sumG = 0, sumB = 0, weight = 0;
            for (let i = 0, p = 0; i < n; i++, p += 4) {
                const level = Math.round(255 * (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255);
                if (level < threshold) continue;
                sumR += d[p]; sumG += d[p + 1]; sumB += d[p + 2]; weight++;
            }
            if (!weight) return null;
            return [sumR / weight / 255, sumG / weight / 255, sumB / weight / 255];
        } catch (_) { return null; }
    }

    // ── 反解白平衡（Compositor 的 neutralize 思路）──
    // 在实测表的 9×9 温度/色调网格上搜，使一个颜色经过 WB stage 后三通道最接近。
    // 比手调系数精确：结果直接对上我们自己的渲染器。
    function neutralizeColor(red, green, blue) {
        if (!T) return null;
        const ch = (v) => Math.max(0, Math.min(255, Math.round(v)));
        const r = ch(red), g = ch(green), b = ch(blue);
        function spread(t, ti) {
            const F = toneStages({ temp: t, tint: ti }, null);
            if (!F) return Infinity;
            const R = F.r[r], G = F.g[g], B = F.b[b];
            return Math.max(R, G, B) - Math.min(R, G, B);
        }
        let bt = 0, bi = 0, bs = Infinity;
        for (let t = -100; t <= 100; t += 10) {
            for (let ti = -100; ti <= 100; ti += 10) {
                const s = spread(t, ti);
                if (s < bs) { bs = s; bt = t; bi = ti; }
            }
        }
        for (let t = Math.max(-100, bt - 10); t <= Math.min(100, bt + 10); t += 2) {
            for (let ti = Math.max(-100, bi - 10); ti <= Math.min(100, bi + 10); ti += 2) {
                const s = spread(t, ti);
                if (s < bs) { bs = s; bt = t; bi = ti; }
            }
        }
        return { temperature: bt, tint: bi, spread: bs };
    }

    window.QfsAcr = {
        ensure,
        ready: () => !!T,
        grid: GRID,
        toneStages,
        colorLut,
        parametricDiag,
        measureBrightness,
        dehazeHaze,
        // 反解白平衡表：找一个 Temperature/Tint，使给定 sRGB 颜色经过 WB stage 后三通道最接近。
        // 与 Compositor 的 CameraRawTables.neutralize 同一个思路：不求解析解，直接在
        // 实测表的 9×9 网格上搜，再在邻居里细化；结果对本渲染器是"精确"的。
        neutralize: neutralizeColor,
        // 三线性采样一张已合成的 grid³ 表（r,g,b 0..255）。测试与标定脚本用。
        sampleTable,
        diag256: (stage) => T ? { r: toLut256(stage.r), g: toLut256(stage.g), b: toLut256(stage.b) } : null
    };

    // 启动即后台解压（首次拖滑块前基本就绪；没就绪时 buildTables 走公式兜底）
    ensure();
})();

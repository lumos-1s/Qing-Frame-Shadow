'use strict';
/* 基础调色：曝光 / 对比度 / 饱和度 / 色温 / 色调 / 高光 / 阴影 / 白色 / 黑色
 *
 * 设计取舍
 * ─────────────────────────────────────────────────────────────
 * 1) 不逐像素。Chromium 的 ctx.filter 是原生实现（GPU 或有优化的 CPU 路径），
 *    实测 2400×1600 一次全滤镜约 25ms（--use-gl=swiftshader 纯软件渲染），
 *    逐像素 JS 同尺寸要 300ms 以上，拖滑块根本没法用。
 * 2) 原则上不逐像素、不上 WebGL。例外是混色器（app-mix.js）：按色相选区
 *    的调整权重取决于每个像素自己的色相，是三维操作，逐通道 LUT 表达不了，
 *    用 WebGL 单 pass 做烘焙**前置级**（原图 → GL 混色 → ctx.filter 其余），
 *    GL 不可用时自动退回原图、混色器禁用，其余档位不受影响。
 * 3) 一次性「烘焙」到离屏画布，渲染时正常 drawImage 缓存。
 *    渲染热路径因此完全不带滤镜 —— engine.js 里特别强调过「裁剪态下
 *    drawImage 会走慢路径」，叠加滤镜只会更糟。烘焙只在参数变化时发生一次。
 * 4) 色温 / 色调 / 高光 / 阴影 用 SVG feComponentTransfer 的 256 项 table
 *    表达（合并成每通道一条曲线，一次过）；曝光/对比度/饱和度用原生函数式
 *    滤镜。二者可以混写在同一个 filter 字符串里，已实测生效。
 * 5) 自然饱和度与颜色分级依赖像素自己的饱和度/亮度，逐通道 LUT 表达不了，
 *    用 WebGL 后置单 pass（app-color-grade.js）；GL 不可用时退回 Canvas2D
 *    逐像素兼容路径。
 *
 * 借鉴来源：fabric.js 的 BaseFilter 分组（brightness/contrast/saturation/
 * hueRotation 的取值域与「0 为不变」约定），以及 glfx.js 的 vibrance/tone
 * 曲线思路。但最终实现换成浏览器原生滤镜，因为本项目只跑 Electron/Chromium。
 */
(function () {
    const GRADE_FILTER_ID = 'qfsGradeLut';
    const LUT_N = 256;
    // 三维表走小网格的尺寸上限：预览（含拖动时的降采样）在此之下用 25³
    const GRID_PREVIEW_MAX = 1700;
    // 高光/阴影用**平滑窗**而不是钟形：钟形 v(1-v)² 的翼太宽，
    // 满档会把中灰 128 压到 37（LR 只到约 122），整张预设看起来"大相径庭"。
    // 窗只覆盖两端，中间调基本为零位移，这才是 LR「高光/阴影」的语义。
    const SH_AMP = 0.16;   // 阴影满档时暗部最大位移（0 → +41）
    const HI_AMP = 0.24;   // 高光满档时亮部最大位移（230 → ~181，LR −100 实测量级）
    const HI_KNEE = 0.45;  // 高光窗下沿：低于此亮度完全不受影响
    const HI_TOP = 0.97;   // 高光窗上沿回落的起点：只有纯白/镜面高光才保住
    const LO_KNEE = 0.55;  // 阴影窗上沿：高于此亮度完全不受影响
    const T_AMP = 0.10;    // 色温满档时中间调最大位移
    const TINT_AMP = 0.075; // 色调满档时中间调最大位移（品红/绿轴）
    const CB_AMP = 0.11;    // 色彩平衡满档时该通道的位移（约 28 级/255）
    // 选中蒙版时，这些键改的是蒙版参数；其余键永远是全局
    const MASK_ROUTE_KEYS = ['exp', 'con', 'sat', 'vib', 'temp', 'tint', 'hi', 'sh', 'white', 'black', 'gam'];
    const LOW_EDGE = 1600; // 拖动过程中的降采样长边
    const FULL_EDGE = 0;   // 静止后的成品：0 = 按原图尺寸，不降采样
                           // （降采样会让导出的「原图」档位拿不到真实长边，宁可多占内存）
    const LRU_MAX = 4;     // 同时保留的烘焙缓存张数（24MP 一张约 96MB）

    const GRADE_FIELDS = [
        { k: 'exp', label: '曝光', min: -5, max: 5, step: 0.01, hint: 'EV：±5 档，1.00 = 一倍亮度' },
        { k: 'con', label: '对比度', min: -100, max: 100, hint: '明暗反差' },
        { k: 'sat', label: '饱和度', min: -100, max: 100, hint: '-100 为黑白' },
        { k: 'vib', label: '自然饱和度', min: -100, max: 100, hint: '优先保护已经鲜艳的颜色' },
        { k: 'temp', label: '色温', min: -100, max: 100, hint: '左冷右暖' },
        { k: 'tint', label: '色调', min: -100, max: 100, hint: '左绿右品红（与 LR 同向）' },
        { k: 'hi', label: '高光', min: -100, max: 100, hint: '只动亮部' },
        { k: 'sh', label: '阴影', min: -100, max: 100, hint: '只动暗部' },
        { k: 'white', label: '白色', min: -100, max: 100, hint: '白点：正档高光并合、负档压暗亮部' },
        { k: 'black', label: '黑色', min: -100, max: 100, hint: '黑点：正档抬黑起雾、负档压死暗部' },
        // 色阶的中间调（PS/LR 的 Levels 第二根三角）。与「对比度」不同：
        // 它只抬/压中间调，两端锚死，所以能在不动黑白场的前提下改通透度。
        { k: 'gam', label: '中间调', min: -100, max: 100, hint: '只抬/压中间调，两端不动（色阶 gamma）' }
    ];

    // ── 颜色分级（对齐 LR 的 3 向 + 全局） ─────────────────────────
    // hue 0..360，sat 0..100，lum -100..100；blending 0..100，balance -100..100。
    const CG_ZONES = [
        { k: 'shadow', label: '阴影' },
        { k: 'mid', label: '中间调' },
        { k: 'high', label: '高光' },
        { k: 'global', label: '全局' }
    ];
    function defaultCgZone() { return { h: 0, s: 0, l: 0 }; }
    function defaultCg() {
        return {
            shadow: defaultCgZone(), mid: defaultCgZone(),
            high: defaultCgZone(), global: defaultCgZone(),
            blending: 50, balance: 0
        };
    }
    function sanitizeCg(c) {
        if (!c || typeof c !== 'object') return null;
        const out = defaultCg();
        let any = false;
        for (const z of CG_ZONES) {
            const v = c[z.k] || {};
            const h = Number(v.h), s = Number(v.s), l = Number(v.l);
            out[z.k] = {
                h: Number.isFinite(h) ? Math.max(0, Math.min(360, Math.round(h))) : 0,
                s: Number.isFinite(s) ? Math.max(0, Math.min(100, Math.round(s))) : 0,
                l: Number.isFinite(l) ? Math.max(-100, Math.min(100, Math.round(l))) : 0
            };
            // 色相单独存在也要留住：色相本身不产生颜色（还要饱和度），但用户通常
            // 先定色相再拉饱和度。这里只看 s/l 的话，一拖色相整组就被判空 → cg 变
            // null → 滑块弹回 0，「色相拉不动」就是这么来的。
            if (out[z.k].h || out[z.k].s || out[z.k].l) any = true;
        }
        const b = Number(c.blending), ba = Number(c.balance);
        out.blending = Number.isFinite(b) ? Math.max(0, Math.min(100, Math.round(b))) : 50;
        out.balance = Number.isFinite(ba) ? Math.max(-100, Math.min(100, Math.round(ba))) : 0;
        return any ? out : null;
    }
    function cgActive(c) {
        if (!c) return false;
        for (const z of CG_ZONES) {
            const v = c[z.k];
            if (v && (Number(v.s) || Number(v.l))) return true;
        }
        return false;
    }

    // ── 色彩平衡（PS 的 Color Balance：三区 × 三轴） ─────────────
    // 每区 r/g/b ∈ [-100,100]，分别对应「青↔红 / 洋红↔绿 / 黄↔蓝」。
    // 走同一条 256 项 LUT（不需要 GL），分区权重与颜色分级同一套形态。
    const CB_ZONES = [
        { k: 'shadow', label: '阴影' },
        { k: 'mid', label: '中间调' },
        { k: 'high', label: '高光' }
    ];
    const CB_AXES = [
        { k: 'r', label: '青 ↔ 红' },
        { k: 'g', label: '洋红 ↔ 绿' },
        { k: 'b', label: '黄 ↔ 蓝' }
    ];
    function defaultCbZone() { return { r: 0, g: 0, b: 0 }; }
    function defaultCb() {
        return { shadow: defaultCbZone(), mid: defaultCbZone(), high: defaultCbZone(), preserve: 1 };
    }
    function sanitizeCb(c) {
        if (!c || typeof c !== 'object') return null;
        const out = defaultCb();
        let any = false;
        for (const z of CB_ZONES) {
            const v = c[z.k] || {};
            for (const a of CB_AXES) {
                const n = Number(v[a.k]);
                out[z.k][a.k] = Number.isFinite(n) ? Math.max(-100, Math.min(100, Math.round(n))) : 0;
                if (out[z.k][a.k]) any = true;
            }
        }
        out.preserve = c.preserve === 0 ? 0 : 1;
        return any ? out : null;
    }
    function cbActive(c) {
        if (!c) return false;
        for (const z of CB_ZONES) {
            const v = c[z.k];
            if (v && (Number(v.r) || Number(v.g) || Number(v.b))) return true;
        }
        return false;
    }

    // ── 渐变映射（PS 的 Gradient Map） ───────────────────────────
    // 用亮度索引一条两色渐变，再按 amount 与原图混合。比「颜色分级」粗，
    // 但它是整条亮度标尺统一映射，做单色调/双色分离最快。
    function defaultGm() { return { on: 1, dark: '#101a33', light: '#ffd9a0', amount: 100 }; }
    function normHex(v, dft) {
        const s = String(v || '').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
        if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toLowerCase();
        return dft;
    }
    function sanitizeGm(v) {
        if (!v || typeof v !== 'object') return null;
        const out = defaultGm();
        out.dark = normHex(v.dark, out.dark);
        out.light = normHex(v.light, out.light);
        const a = Number(v.amount);
        out.amount = Number.isFinite(a) ? Math.max(0, Math.min(100, Math.round(a))) : 100;
        out.on = v.on === 0 ? 0 : 1;
        return (out.on && out.amount > 0) ? out : null;
    }
    function gmActive(v) { return !!(v && v.on !== 0 && (Number(v.amount) || 0) > 0); }
    function hexToRgb(h) {
        const s = normHex(h, '#000000');
        return [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
    }

    // ── 色彩平衡 / 渐变映射：一个像素怎么算 ───────────────────────
    // 这两档都是**跨通道**算子：先按这个像素的亮度选权重（阴影/中间调/高光，
    // 或渐变索引），再同时动三个通道。feComponentTransfer 的表对每个通道独立
    // 作用，它只能看见「这个通道是多少」，看不见「这个像素有多亮」——灰阶上两者
    // 恰好相等，一上彩色就错：饱和橙走渐变映射能差 76 级，色相直接反掉。
    // 所以公式只留这一份，由两条路共用：
    //   · 三维表（WebGL 可用）：colorLut 的 pre 钩子，在每个格点上按真实 RGB 算；
    //   · 逐通道 256 表（无 GL 兜底）：拿灰阶 v 当输入算，彩色仍会退化，
    //     但灰度与中性色的表现与三维路径一致。
    function cbgmPrep(p) {
        const cbOn = cbActive(p.cb);
        const gmOn = gmActive(p.gm);
        if (!cbOn && !gmOn) return null;
        let zones = null, preserve = false;
        if (cbOn) {
            zones = CB_ZONES.map((z) => {
                const v = p.cb[z.k] || {};
                return [(Number(v.r) || 0) / 100, (Number(v.g) || 0) / 100, (Number(v.b) || 0) / 100];
            });
            preserve = p.cb.preserve !== 0;
        }
        let gm = null;
        if (gmOn) {
            const dk = hexToRgb(p.gm.dark), lt = hexToRgb(p.gm.light);
            gm = [dk[0], dk[1], dk[2], lt[0], lt[1], lt[2],
                Math.max(0, Math.min(100, Number(p.gm.amount) || 0)) / 100];
        }
        const key = 'c' + (cbOn
            ? zones.map((z) => z.map((x) => Math.round(x * 100)).join('.')).join(',') + (preserve ? 'p' : '')
            : '-')
            + 'g' + (gmOn ? p.gm.dark + p.gm.light + Math.round(gm[6] * 100) : '-');
        return {
            key,
            // r/g/b：0..255。返回同一量纲，方便直接喂给三维网格。
            // 必须有 **三个数字** 的参数：compose3d 的 pre 钩子就是这么调的。
            pre(r, g, b) {
                let vr = r / 255, vg = g / 255, vb = b / 255;
                if (zones) {
                    const y0 = 0.299 * vr + 0.587 * vg + 0.114 * vb;
                    const w = cbWeights(y0);
                    // 极暗门控：纯黑不染色（0→0）。否则「暗部加红」会把画面的黑边、
                    // 白边阴影一起染成暗红，看起来像脏了。6% 以上是满权重。
                    const gate = smoothstep(0, 0.06, y0);
                    let dr = 0, dg = 0, db = 0;
                    for (let zi = 0; zi < 3; zi++) {
                        const z = zones[zi], wz = w[zi] * gate;
                        if (!wz) continue;
                        dr += z[0] * wz * CB_AMP;
                        dg += z[1] * wz * CB_AMP;
                        db += z[2] * wz * CB_AMP;
                    }
                    vr = clamp01(vr + dr); vg = clamp01(vg + dg); vb = clamp01(vb + db);
                    // 保持明度：把亮度的净变化补回去（PS 的 Preserve Luminosity）。
                    // 直接按比例缩放会把色度一起削掉，用差值补偿更接近 PS 的观感。
                    if (preserve) {
                        const y1 = 0.299 * vr + 0.587 * vg + 0.114 * vb;
                        const dl = (y0 - y1) * 0.9;
                        vr = clamp01(vr + dl); vg = clamp01(vg + dl); vb = clamp01(vb + dl);
                    }
                }
                if (gm) {
                    // 拿当前亮度当索引去查那条两色渐变，再按强度混回去。
                    const t = clamp01(0.299 * vr + 0.587 * vg + 0.114 * vb);
                    const amt = gm[6];
                    vr = clamp01(vr + (gm[0] + (gm[3] - gm[0]) * t - vr) * amt);
                    vg = clamp01(vg + (gm[1] + (gm[4] - gm[1]) * t - vg) * amt);
                    vb = clamp01(vb + (gm[2] + (gm[5] - gm[2]) * t - vb) * amt);
                }
                return [vr * 255, vg * 255, vb * 255];
            }
        };
    }
    // 测试与 tools/ 下的标定脚本要用同一份公式
    // （buildTables 是函数声明，提前引用没问题：它在这一行之后才定义，但已提升）
    window.QfsCbgm = { prep: cbgmPrep, buildTables };

    // ── 镜头校正（目前只做畸变） ─────────────────────────────────
    // distort>0 校正桶形（把外围往里收），<0 校正枕形。几何重采样只能在
    // GL pass 里做（Canvas2D 逐像素重采样没有双线性插值，边缘会锯齿）。
    function defaultLc() { return { distort: 0 }; }
    function sanitizeLc(v) {
        if (!v || typeof v !== 'object') return null;
        const d = Number(v.distort);
        const out = { distort: Number.isFinite(d) ? Math.max(-100, Math.min(100, Math.round(d))) : 0 };
        return out.distort ? out : null;
    }
    function lcActive(v) { return !!(v && Number(v.distort)); }

    // ── 蒙版组合模式（PS/LR 的 Add / Subtract / Intersect）─────────
    // 一个「组」= 一个 new 蒙版 + 后续若干 add/subtract/intersect 成员，
    // 整组共用组首的参数、共用一条烘焙层。这样「修边缘」不用重画整个蒙版。
    const MASK_MODES = [
        { k: 'new', label: '新建', title: '独立的调整层（用自己的参数）' },
        { k: 'add', label: '添加', title: '并进上一个蒙版的生效范围' },
        { k: 'subtract', label: '减去', title: '从上一个蒙版里挖掉这块' },
        { k: 'intersect', label: '相交', title: '只保留与上一个蒙版重叠的部分' }
    ];
    function maskGroups(masks) {
        const list = Array.isArray(masks) ? masks : [];
        const groups = [];
        for (const m of list) {
            if (!m) continue;
            const mode = (m.mode && m.mode !== 'new' && groups.length) ? m.mode : 'new';
            if (mode === 'new') groups.push({ head: m, members: [m] });
            else groups[groups.length - 1].members.push(m);
        }
        return groups;
    }

    // ── 扩展档位（对齐 LR 的「细节 / 校准 / 混色器」） ──────────────
    const DET_FIELDS = [
        // 锐化是 LR 的「捕获锐化」：XMP 里 SharpenAmount/Radius/Detail/EdgeMasking。
        // 它不写进色调表（USM 是空间算子），走 syncChain 里独立的一级。
        { k: 'shp', label: '锐化', min: 0, max: 150, hint: 'LR 捕获锐化：只作用于亮度，不产生彩边' },
        { k: 'shr', label: '锐化半径', min: 0.3, max: 3, step: 0.1, fmt: (v) => (Math.round(v * 10) / 10).toFixed(1), hint: '按输出像素算：0.5～1.0 接近 LR 默认' },
        { k: 'shd', label: '锐化细节', min: 0, max: 100, hint: '低值偏边缘、高值连细纹一起锐（近似）' },
        { k: 'shm', label: '锐化蒙版', min: 0, max: 100, hint: '保护平滑区域（天空/皮肤），只锐边缘（近似）' },
        { k: 'clar', label: '清晰度', hint: '中间调立体感' },
        { k: 'tex', label: '纹理', hint: '表面细节' },
        { k: 'dhz', label: '去除薄雾', hint: '通透度：按 Camera Raw 的雾色反演，正档去雾、负档加雾' }
    ];
    const CAL_FIELDS = [
        { k: 'rh', label: '红·色相' }, { k: 'rs', label: '红·饱和' },
        { k: 'gh', label: '绿·色相' }, { k: 'gs', label: '绿·饱和' },
        { k: 'bh', label: '蓝·色相' }, { k: 'bs', label: '蓝·饱和' }
    ];
    // LR 混色器的 8 个色相带；hw = 权重过渡带宽（约取相邻带间距的一半再放宽一点）
    const MIX_BANDS = [
        { k: 'r', label: '红色', hue: 0, hw: 30 },
        { k: 'o', label: '橙色', hue: 30, hw: 25 },
        { k: 'y', label: '黄色', hue: 60, hw: 25 },
        { k: 'g', label: '绿色', hue: 120, hw: 40 },
        { k: 'a', label: '浅绿色', hue: 180, hw: 40 },
        { k: 'b', label: '蓝色', hue: 240, hw: 40 },
        { k: 'p', label: '紫色', hue: 285, hw: 32 },
        { k: 'm', label: '洋红', hue: 320, hw: 27 }
    ];
    const MIX_METRICS = [
        { k: 'h', label: '色相' }, { k: 's', label: '饱和度' }, { k: 'l', label: '明亮度' }
    ];

    // ── 黑白混色器（对齐 LR / PS 的 Black & White：8 色相带各自调亮调暗）──
    // 色带中心复用混色器那套（0/30/60/120/180/240/285/320），LR 的 GrayMixer 就是这 8 个。
    // XMP 里 ConvertToGrayscale + GrayMixerRed…Magenta 以前整组进 skipped，导进来等于没生效。
    const BW_BANDS = MIX_BANDS;
    const BW_KEYS = ['r', 'o', 'y', 'g', 'a', 'b', 'p', 'm'];
    function defaultBw() {
        const b = { on: 1 };
        for (const k of BW_KEYS) b[k] = 0;
        return b;
    }
    function sanitizeBw(v) {
        if (!v || typeof v !== 'object') return null;
        if (v.on === 0) return null;
        const out = defaultBw();
        for (const k of BW_KEYS) {
            const n = Number(v[k]);
            out[k] = Number.isFinite(n) ? Math.max(-100, Math.min(100, Math.round(n))) : 0;
        }
        // 注意：不能因为「8 个滑块都是 0」就返回 null —— 勾了黑白本身就是一次灰度转换，
        // 全 0 等于标准灰度（LR 里也是这样），返回 null 会让开关刚勾上就自己弹回去。
        return out;
    }
    function bwActive(v) { return !!(v && v.on !== 0); }

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    function bell(x) { return 4 * x * (1 - x); }
    // 三区分权重：阴影/中间调/高光，边界 0.33/0.66、过渡带 0.12（与颜色分级的
    // 默认形态一致）。返回已归一化的三元组。
    function cbWeights(y) {
        const lo = 0.33, hi = 0.66, soft = 0.12;
        let wS = 1 - smoothstep(lo - soft, lo + soft, y);
        let wH = smoothstep(hi - soft, hi + soft, y);
        let wM = Math.max(0, 1 - wS - wH);
        const sum = wS + wM + wH;
        if (sum > 1e-6) { wS /= sum; wM /= sum; wH /= sum; }
        return [wS, wM, wH];
    }
    function smoothstep(a, b, x) {
        if (a === b) return x < a ? 0 : 1;
        const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    }
    // sRGB ↔ 线性光：曝光必须在线上乘，否则 +1EV 会把 sRGB 128 直接推到 255。
    function srgbToLinear(v) {
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    function linearToSrgb(v) {
        return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    }

    // ── SVG 滤镜（单例，改参数只换属性/重建子节点，不重复建 DOM） ──
    // 链路：feComponentTransfer(色温/高光/阴影/曲线/薄雾黑场) → feColorMatrix(校准)
    //       → feGaussianBlur+feComposite(纹理 USM) → 同(清晰度 USM)
    // 各级都可选：参数为 0 时该级不进链，烘焙成本不涨。
    let _filterEl = null, _ctEl = null, _chainSig = '';
    function ensureFilter() {
        if (_filterEl) return _filterEl;
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden';
        const f = document.createElementNS(ns, 'filter');
        f.setAttribute('id', GRADE_FILTER_ID);
        // 必须是 sRGB：默认值 linearRGB 会让中间调整体变暗，怎么调都不对
        f.setAttribute('color-interpolation-filters', 'sRGB');
        const ct = document.createElementNS(ns, 'feComponentTransfer');
        const mk = (tag) => {
            const n = document.createElementNS(ns, tag);
            n.setAttribute('type', 'table');
            n.setAttribute('tableValues', '0 1');
            ct.appendChild(n);
            return n;
        };
        _ctEl = { el: ct, r: mk('feFuncR'), g: mk('feFuncG'), b: mk('feFuncB') };
        f.appendChild(ct);
        svg.appendChild(f);
        (document.body || document.documentElement).appendChild(svg);
        _filterEl = f;
        return f;
    }

    // 校准 = 3×3 通道混合矩阵。色相偏移 = 原色轴在原色平面内旋转；
    // 饱和度 = 轴向「灰矢量」收放（-100 收进灰、正过冲更艳，LR 同款语义）。
    // 灰守恒：各列的改动量做均摊配平，保证 Σ列 = (1,1,1)，即 R=G=B 的输入
    // 输出恒等 —— 灰背景、白边、中性皮肤在任何校准组合下都不偏色。
    // （纯原色在别的列被配平后会带一点邻色，这是线性 3×3 的数学极限，
    //   典型用法 ±10~30 完全够用。）
    function calMatrixValues(cal) {
        // ── 绕灰轴旋转（Rodrigues）──
        // 每个原色轴绕 (1,1,1)/√3 转 θ，这是唯一同时满足两件事的模型：
        //   ① 行和 = 1  → 灰 (g,g,g) 输入仍是灰，白边/灰背景永不偏色；
        //   ② 正交矩阵 → 列模长不变，色度不被压缩。
        // 早期版本把三个轴各自朝 A/B 方向线性插值再归一化：行和是 1.31/1.35，
        // 灰 128 被推成 (123,166,172)；改成行归一化又把色度压掉约 24%，
        // 导入预设后整张发灰、黄叶变柠檬色。
        const K = 1 / Math.sqrt(3);
        const GRAY = 1 / 3;
        const rotCol = (deg, i) => {
            const th = deg * Math.PI / 180;
            const c = Math.cos(th), sn = Math.sin(th);
            const e = [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
            // [k]× 的第 i 列（k = 灰轴单位向量）
            const kv = i === 0 ? [0, K, -K] : (i === 1 ? [-K, 0, K] : [K, -K, 0]);
            return [0, 1, 2].map((j) => c * e[j] + sn * kv[j] + (1 - c) * GRAY);
        };
        const axes = [
            rotCol(cal.rh / 100 * 45, 0),
            rotCol(cal.gh / 100 * 45, 1),
            rotCol(cal.bh / 100 * 45, 2)
        ];
        // 三个原色轴各转各的角度，Rodrigues 单列旋转**不保行和**
        // （实测 RedHue+49/GreenHue+46 时行和是 0.746/1.221/1.033）。
        // 不修就会让灰 (0.5,0.5,0.5) 变成 (0.33,0.5,0.5) —— 整张偏青绿。
        for (let j = 0; j < 3; j++) {
            const sum = axes[0][j] + axes[1][j] + axes[2][j];
            if (Math.abs(sum) > 1e-6) {
                const k = 1 / sum;
                for (let i = 0; i < 3; i++) axes[i][j] *= k;
            }
        }
        const sats = [cal.rs / 100, cal.gs / 100, cal.bs / 100];
        // 饱和度：col + s·(col − GRAY)。s=−1 收成灰、s=+1 过冲更艳；
        // 逐列的偏移量行和为 0，所以不会破坏灰守恒（三个 s 不同时再用下面的配平收口）。
        const cols = [[], [], []];
        let D0 = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const sg = Math.max(-1, Math.min(1, sats[i]));
            for (let j = 0; j < 3; j++) {
                const d = sg * (axes[i][j] - GRAY);
                cols[i][j] = axes[i][j] + d;
                D0[j] += d;
            }
        }
        // 三个 s 不一致时行和会被拉偏，把 Σd 均摊回去（量级很小，不伤饱和度）
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) cols[i][j] -= D0[j] / 3;
        }
        // 行主序 4×5：R' = cols[0][0]*R + cols[1][0]*G + cols[2][0]*B …
        return [
            cols[0][0], cols[1][0], cols[2][0], 0, 0,
            cols[0][1], cols[1][1], cols[2][1], 0, 0,
            cols[0][2], cols[1][2], cols[2][2], 0, 0,
            0, 0, 0, 1, 0
        ].map((v) => v.toFixed(5)).join(' ');
    }

    const nsURI = 'http://www.w3.org/2000/svg';
    function feEl(tag, attrs) {
        const n = document.createElementNS(nsURI, tag);
        for (const k in attrs) n.setAttribute(k, attrs[k]);
        return n;
    }

    // USM 一级：out = src*(1+amt) - blur*amt。amt<0 时反向（往模糊里混，柔化）。
    function usmStage(input, resultName, radius, amt) {
        return [
            feEl('feGaussianBlur', { in: input, stdDeviation: String(radius), result: 'qB' }),
            feEl('feComposite', {
                in: input, in2: 'qB', operator: 'arithmetic',
                k1: '0', k2: (1 + amt).toFixed(4), k3: (-amt).toFixed(4), k4: '0',
                result: resultName
            })
        ];
    }

    // 按「校准/纹理/清晰度是否启用 + 烘焙分辨率」重建子节点（分辨率变了模糊半径要跟着变）
    // 锐化不在这里：它是带符号高通，SVG 滤镜的 arithmetic 会把负半边钳掉，
    // 走 QfsSharpen 的 CPU pass（见 bakeOne），和阴影同一套做法。
    function syncChain(p, longPx, lutOn) {
        const f = ensureFilter();
        // 校准已并入三维表时这里不再叠矩阵
        const cal = calActive(p.cal) && !lutOn;
        const det = p.det || {};
        const clar = det.clar | 0, tex = det.tex | 0;
        // 注意别用全参数的 signature():对纯 cal 对象它算出的是常量串,
        // 会导致换校准矩阵时不重建链、滤镜停留在上一次的 values
        const calSig = cal ? CAL_FIELDS.map((x) => p.cal[x.k]).join(',') : '';
        const sig = calSig + '|' + clar + '|' + tex + '|' + Math.round(longPx);
        if (_chainSig === sig) return;
        _chainSig = sig;
        while (f.firstChild) f.removeChild(f.firstChild);
        _ctEl.el.setAttribute('result', 'qL');
        f.appendChild(_ctEl.el);
        let cur = 'qL';
        if (cal) {
            f.appendChild(feEl('feColorMatrix', {
                in: cur, type: 'matrix', values: calMatrixValues(p.cal), result: 'qC'
            }));
            cur = 'qC';
        }
        // 纹理先（细节层），清晰度后（整体立体感），与 LR 的作用层级一致
        if (tex) {
            const r = Math.max(1, Math.min(6, longPx / 250));
            const stages = usmStage(cur, 'qU1', r.toFixed(2), (tex / 100) * 0.5);
            stages.forEach((n) => f.appendChild(n));
            cur = 'qU1';
        }
        if (clar) {
            const r = Math.max(4, Math.min(60, longPx / 40));
            const stages = usmStage(cur, 'qU2', r.toFixed(2), (clar / 100) * 0.5);
            stages.forEach((n) => f.appendChild(n));
            cur = 'qU2';
        }
    }

    function defaultCal() { return { rh: 0, rs: 0, gh: 0, gs: 0, bh: 0, bs: 0 }; }
    // shr/shd 是 LR 的默认值（1.0 / 25）：预设里缺省时按它们补，见 app-xmp.js
    function defaultDet() { return { clar: 0, tex: 0, dhz: 0, shp: 0, shr: 1, shd: 25, shm: 0 }; }
    // 细节组不像别的组是纯 ±100：锐化量 0..150、半径 0.3..3.0（小数），
    // 所以不能用 sanitizeGroup（它会把半径四舍五入成整数、把 0.5 抹成 1）。
    function sanitizeDet(p) {
        if (!p) return null;
        const out = defaultDet();
        const ci = (v) => Math.max(-100, Math.min(100, Math.round(Number(v) || 0)));
        out.clar = ci(p.clar); out.tex = ci(p.tex); out.dhz = ci(p.dhz);
        const shp = Number(p.shp);
        out.shp = Number.isFinite(shp) ? Math.max(0, Math.min(150, Math.round(shp))) : 0;
        const shr = Number(p.shr);
        out.shr = Number.isFinite(shr) ? Math.round(Math.max(0.3, Math.min(3, shr)) * 10) / 10 : 1;
        const shd = Number(p.shd);
        out.shd = Number.isFinite(shd) ? Math.max(0, Math.min(100, Math.round(shd))) : 25;
        const shm = Number(p.shm);
        out.shm = Number.isFinite(shm) ? Math.max(0, Math.min(100, Math.round(shm))) : 0;
        // 只有半径/细节被改、锐化量为 0 时视作没开（半径单独没有意义）
        return detActive(out) ? out : null;
    }
    // 只保留非零项，草稿里不塞一堆 0
    function sanitizeMix(m) {
        if (!m) return null;
        const out = {};
        let any = false;
        for (const b of MIX_BANDS) {
            const v = m[b.k];
            if (!v) continue;
            const e = {};
            for (const mt of MIX_METRICS) {
                const n = Math.round(Number(v[mt.k]) || 0);
                const c = Math.max(-100, Math.min(100, n));
                e[mt.k] = c;
                if (c) any = true;
            }
            if (e.h || e.s || e.l) out[b.k] = e;
        }
        return any ? out : null;
    }

    // ── 点颜色（对齐 LR 的 Point Color）：在画面上取一次色就建一个样本 ──
    // 与混色器的 8 个固定色带不同：样本中心是"用户点到的那个颜色"，
    // 每个样本自己有 色相/饱和度/明亮度/变量 四档调整，外加「范围」决定多大一片算这个颜色。
    // range 存 0~100 原样（0 是极窄而非"未设置"），着色器里再换算成角度/容差。
    // 着色器 uniform 数组只有 8 组，这里按 8 兜底；界面（app-mix.js 的 PC_MAX）
    // 只允许取 6 个 —— 6 个圆点刚好在「取样」右边排成一行。
    const SAMPLES_MAX = 8;
    function clampSm(v) {
        const n = Math.round(Number(v) || 0);
        return Math.max(-100, Math.min(100, n));
    }
    function sanitizeSamples(v) {
        if (!Array.isArray(v)) return null;
        const out = [];
        for (const s of v) {
            if (!s || typeof s !== 'object') continue;
            const hue = Number(s.hue);
            if (!Number.isFinite(hue)) continue;
            const light = Number(s.light);
            out.push({
                hue: Math.round(((hue % 360) + 360) % 360),
                sat: Math.max(0, Math.min(1, Number(s.sat) || 0)),
                light: Number.isFinite(light) ? Math.max(0.01, Math.min(0.99, light)) : 0.5,
                range: Math.max(0, Math.min(100, Math.round(Number(s.range) || 0))),
                dh: clampSm(s.dh), ds: clampSm(s.ds), dl: clampSm(s.dl), dv: clampSm(s.dv)
            });
            if (out.length >= SAMPLES_MAX) break;
        }
        return out.length ? out : null;
    }
    function samplesActive(v) {
        if (!Array.isArray(v)) return false;
        for (const s of v) if (s && (s.dh || s.ds || s.dl || s.dv)) return true;
        return false;
    }
    function sanitizeGroup(p, def) {
        if (!p) return null;
        const out = def();
        let any = false;
        for (const k in out) {
            const n = Math.round(Number(p[k]) || 0);
            out[k] = Math.max(-100, Math.min(100, n));
            if (out[k]) any = true;
        }
        return any ? out : null;
    }
    function gradeField(k) {
        for (const f of GRADE_FIELDS) if (f.k === k) return f;
        return null;
    }
    function clampGradeValue(k, v) {
        const f = gradeField(k);
        const lo = f ? f.min : -100, hi = f ? f.max : 100;
        const n = Math.max(lo, Math.min(hi, Number(v) || 0));
        return f && f.step ? Math.round(n / f.step) * f.step : Math.round(n);
    }

    function defaultGrade() {
        const p = {};
        for (const f of GRADE_FIELDS) p[f.k] = 0;
        p.curve = null;      // 四条曲线的控制点；null = 全是直线
        p.cal = null;        // 校准（原色色相/饱和）
        p.det = null;        // 细节（清晰度/纹理/去除薄雾）
        p.mix = null;        // 混色器（8 色相带 HSL）
        p.cg = null;         // 颜色分级（阴影/中间调/高光/全局）
        p.bw = null;         // 黑白混色器（8 色相带各自调亮调暗）
        p.cb = null;         // 色彩平衡（三区 × 三轴）
        p.gm = null;         // 渐变映射（两色 + 强度）
        p.lc = null;         // 镜头校正（畸变）
        p.masks = [];        // 蒙版（线性/椭圆/画笔/亮度），每个带一套基础参数
        return p;
    }

    function normalizeGrade(p) {
        const out = defaultGrade();
        if (!p) return out;
        for (const f of GRADE_FIELDS) {
            let v = Number(p[f.k]);
            if (!Number.isFinite(v)) { out[f.k] = 0; continue; }
            // 兼容旧草稿：旧版曝光是 -100..100 的线性滑块，新版是 EV。
            // 旧档位 >5 时按旧公式反推 EV，保证打开旧草稿不会突然过曝。
            if (f.k === 'exp' && Math.abs(v) > 5.01) {
                const old = Math.max(-100, Math.min(100, v));
                v = Math.log(Math.max(0.01, 1 + old * 0.005)) / Math.LN2;
            }
            v = Math.max(f.min, Math.min(f.max, v));
            out[f.k] = f.step ? Math.round(v / f.step) * f.step : v;
            if (f.k === 'exp') out[f.k] = Math.round(out[f.k] * 100) / 100;
        }
        const C = window.QfsCurve;
        out.curve = C ? C.sanitizeCurve(p.curve) : null;
        out.cal = sanitizeGroup(p.cal, defaultCal);
        out.det = sanitizeDet(p.det);
        out.mix = sanitizeMix(p.mix);
        out.samples = sanitizeSamples(p.samples);
        out.cg = sanitizeCg(p.cg);
        out.bw = sanitizeBw(p.bw);
        out.cb = sanitizeCb(p.cb);
        out.gm = sanitizeGm(p.gm);
        out.lc = sanitizeLc(p.lc);
        out.masks = (window.QfsMask && window.QfsMask.sanitizeMasks)
            ? window.QfsMask.sanitizeMasks(p.masks) : [];
        return out;
    }

    function calActive(c) { return !!(c && (c.rh || c.rs || c.gh || c.gs || c.bh || c.bs)); }
    function detActive(d) { return !!(d && (d.clar || d.tex || d.dhz || d.shp)); }
    function mixActive(m) {
        if (!m) return false;
        for (const b of MIX_BANDS) {
            const v = m[b.k];
            if (v && (v.h || v.s || v.l)) return true;
        }
        return false;
    }

    function isNeutral(p) {
        if (!p) return true;
        for (const f of GRADE_FIELDS) if (Number(p[f.k]) || 0) return false;
        const C = window.QfsCurve;
        if (C && C.curveActive(p.curve)) return false;
        if (window.QfsMask && window.QfsMask.activeMasks(p.masks).length) return false;
        if (bwActive(p.bw)) return false;
        if (cbActive(p.cb) || gmActive(p.gm) || lcActive(p.lc)) return false;
        return !calActive(p.cal) && !detActive(p.det) && !mixActive(p.mix) && !cgActive(p.cg)
            && !samplesActive(p.samples);
    }

    function signature(p) {
        if (!p) return '';
        const C = window.QfsCurve;
        let s = GRADE_FIELDS.map((f) => (Number(p[f.k]) || 0)).join(',')
            + (C ? '/' + C.curveSignature(p.curve) : '');
        if (calActive(p.cal)) s += '/c' + CAL_FIELDS.map((f) => p.cal[f.k]).join(',');
        if (detActive(p.det)) s += '/d' + DET_FIELDS.map((f) => p.det[f.k]).join(',');
        if (mixActive(p.mix)) s += '/m' + MIX_BANDS.map((b) => {
            const v = p.mix[b.k] || {};
            return (v.h || 0) + '.' + (v.s || 0) + '.' + (v.l || 0);
        }).join(',');
        // 点颜色样本：中心色与范围都进签名，否则改样本/改范围不会触发重烘
        if (Array.isArray(p.samples) && p.samples.length) s += '/p' + p.samples.map((v) => [
            Math.round(v.hue), Math.round((v.sat || 0) * 100), Math.round((v.light || 0) * 100),
            Math.round(v.range || 0), v.dh || 0, v.ds || 0, v.dl || 0, v.dv || 0
        ].join('.')).join(',');
        if (bwActive(p.bw)) s += '/bw' + BW_KEYS.map((k) => (Number(p.bw[k]) || 0)).join(',');
        if (cbActive(p.cb)) s += '/cb' + CB_ZONES.map((z) => CB_AXES.map((a) => Number(p.cb[z.k][a.k]) || 0).join('.')).join(',')
            + '.' + (p.cb.preserve ? 1 : 0);
        if (gmActive(p.gm)) s += '/gm' + p.gm.dark + p.gm.light + (p.gm.amount || 0);
        if (lcActive(p.lc)) s += '/lc' + (p.lc.distort || 0);
        if (cgActive(p.cg)) s += '/g' + CG_ZONES.map((z) => {
            const v = p.cg[z.k] || {};
            return (v.h || 0) + '.' + (v.s || 0) + '.' + (v.l || 0);
        }).join(',') + '.' + (p.cg.blending || 0) + '.' + (p.cg.balance || 0);
        // 只把「会改变画面」的组算进来：只画了形状没调参数的蒙版不影响像素。
        // 组合模式下一个组可能含多个成员（add/subtract/intersect），
        // 任一成员改形状都要重烘，所以签名取整组。
        const grps = (window.QfsMask && window.QfsMask.activeGroups) ? window.QfsMask.activeGroups(p.masks) : [];
        if (grps.length) s += '/k' + grps.map((g) => window.QfsMask.groupSignature(g)).join('~');
        return s;
    }

    // 256 级实测响应表采样（x ∈ 0..1）
    function lutAt(arr, x) {
        const t = x * 255;
        const i = Math.min(254, Math.max(0, Math.floor(t)));
        const f = t - i;
        return arr[i] * (1 - f) + arr[i + 1] * f;
    }
    // 自适应档（对比度/高光/阴影）需要的图片亮度测度；按图缓存。
    function acrBrightness() {
        const im = window.App && window.App.image;
        if (!im || !im.el) return { con: 128, hi: 128, sh: 128 };
        if (!im._acrBright) {
            im._acrBright = (window.QfsAcr && window.QfsAcr.measureBrightness)
                ? window.QfsAcr.measureBrightness(im.el) : { con: 128, hi: 128, sh: 128 };
        }
        return im._acrBright;
    }

    // 去薄雾的雾色：全图最亮 1% 的平均色。按图缓存——它只取决于原图，
    // 与当前调色参数无关，所以拖滑块时不会再算。
    function acrHaze() {
        const im = window.App && window.App.image;
        if (!im || !im.el) return null;
        if (im._acrHaze === undefined) {
            im._acrHaze = (window.QfsAcr && window.QfsAcr.dehazeHaze)
                ? window.QfsAcr.dehazeHaze(im.el) : null;
        }
        return im._acrHaze;
    }

    // 色温/高光/阴影/白点黑点合成每通道一条曲线，再串联用户曲线与薄雾黑场
    //
    // skipCbgm：三维表在用时（WebGL 可用）色彩平衡 / 渐变映射改由 colorLut 的
    // pre 钩子按真实 RGB 计算。这两档必须看见「这个像素有多亮」，逐通道表看不见，
    // 所以不能再写进表里 —— 否则同一个档位会生效两遍。
    function buildTables(p, skipCbgm) {
        const sh = (p.sh || 0) / 100, hi = (p.hi || 0) / 100, tp = (p.temp || 0) / 100;
        const tn = (p.tint || 0) / 100;
        const wht = (p.white || 0) / 100, blk = (p.black || 0) / 100;
        const evGain = Math.pow(2, Number(p.exp) || 0);
        const gam = (Number(p.gam) || 0) / 100;
        // 色彩平衡 / 渐变映射：与亮度无关的量先算好，循环里只做一次查表
        const cbgm = skipCbgm ? null : cbgmPrep(p);
        const C = window.QfsCurve;
        const cl = (C && C.curveActive(p.curve)) ? C.buildCurveLuts(p.curve) : null;
        // ACR 实测 stage（QfsAcr）：曝光→白平衡→对比度→高光→阴影→白→黑，
        // 顺序与 Photoshop Camera Raw 一致。表没加载好时退回手写公式。
        const ACR = window.QfsAcr;
        const acrOn = !!(ACR && ACR.ready());
        const F = acrOn
            ? ACR.toneStages({
                exp: Number(p.exp) || 0, temp: Number(p.temp) || 0, tint: Number(p.tint) || 0,
                con: Number(p.con) || 0, hi: Number(p.hi) || 0, sh: Number(p.sh) || 0,
                white: Number(p.white) || 0, black: Number(p.black) || 0
            }, acrBrightness())
            : null;
        const gpow = Math.pow(2, -gam * 0.85);
        const r = new Array(LUT_N), g = new Array(LUT_N), b = new Array(LUT_N);
        for (let i = 0; i < LUT_N; i++) {
            const v = i / (LUT_N - 1);
            let vr, vg, vb;
            if (F) {
                // 实测复合响应：三分量在白平衡处开始分道，各自沿自己的曲线走
                vr = lutAt(F.r, v); vg = lutAt(F.g, v); vb = lutAt(F.b, v);
                if (gam) {
                    vr = Math.pow(clamp01(vr), gpow); vg = Math.pow(clamp01(vg), gpow); vb = Math.pow(clamp01(vb), gpow);
                }
            } else {
                // ── 兜底：手写公式（表未就绪/主进程无表）──
                // 曝光是线性光量：先在 sRGB 解码后的线性空间乘 2^EV，再编码回
                // sRGB。直接 brightness(2^EV) 会把中灰 128 翻成 255，LR 只到约 175。
                let o = v;
                if (evGain !== 1) {
                    o = linearToSrgb(clamp01(srgbToLinear(v) * evGain));
                }
                // 高光/阴影：只吃两端（窗内为 1、窗外为 0），中间调几乎不动。
                // 判定用当前亮度 o（曝光之后的实际亮度），避免"先提亮再压高光"错位。
                if (sh) o += sh * SH_AMP * (1 - smoothstep(0, LO_KNEE, o));
                // 高光窗在接近纯白处**回落**：LR 的高光恢复不会把白点压灰，
                // 否则整张照片失去最亮处，看起来"发灰不发亮"（用户对照 PS 时的第一感受）。
                if (hi) {
                    const w = smoothstep(HI_KNEE, HI_TOP, o) * (1 - 0.65 * smoothstep(HI_TOP, 1, o));
                    o += hi * HI_AMP * w;
                }
                o = clamp01(o);
                // 白点：正档把白点往里收（亮部提前并合到纯白），负档整体压暗亮部。
                // 与高光不同，它**故意允许溢出**——那是「白色」该干的事，所以用端点操作，
                // 但按 v² 加权，只让高光区吃到，中间调几乎不动。
                if (wht) {
                    // 三次方加权：128 只吃 12.5%，224 吃 68%，端点全吃
                    const gain = 1 / Math.max(0.1, 1 - wht * 0.25);
                    o = o + (clamp01(o * gain) - o) * o * o * o;
                }
                // 黑点：正档抬黑（0 变成 0.22，起雾/褪色），负档压死暗部（低于阈值的直接切黑）。
                // 按 (1-v)² 加权，只吃暗部。
                if (blk) {
                    // LR 的 Blacks +100 大约把纯黑抬到 30～35，0.22 会抬到 56（暗部发灰、不通透）
                    const op = blk > 0
                        ? o * (1 - blk * 0.16) + blk * 0.16
                        : Math.max(0, (o + blk * 0.16) / (1 + blk * 0.16));
                    o = o + (op - o) * (1 - o) * (1 - o) * (1 - o);
                }
                if (gam) o = Math.pow(clamp01(o), gpow);
                const d = tp * T_AMP * bell(o);
                const dt = tn * TINT_AMP * bell(o);
                // 色调：正 = 品红（R/B 升、G 降），负 = 绿（G 升、R/B 降），
                // 与 Lightroom 的 Tint 正负方向一致；不再是 hue-rotate 的整体转色。
                vr = clamp01(o + d + dt * 0.5);
                vg = clamp01(o + d * 0.18 - dt);
                vb = clamp01(o - d + dt * 0.5);
            }
            // 去除薄雾不再在这里拉黑场：ACR 的反演已经包含通透度的变化，
            // 再叠一次黑场拉伸会让暗部发死（旧实现就是这么糊掉的）。
            // 曲线串在最后：先色温/高光/阴影，再用户曲线（与 PS 的复合顺序一致）
            if (cl) {
                if (cl.r) vr = C.sampleLut(cl.r, vr);
                if (cl.g) vg = C.sampleLut(cl.g, vg);
                if (cl.b) vb = C.sampleLut(cl.b, vb);
            }
            // 色彩平衡 / 渐变映射：按这个像素的真实亮度（不是本通道的值）算。
            // 顺序在曲线之后 —— 与 PS 的调整图层顺序一致（曲线定骨架、色彩平衡着色）。
            // 三维路径上这两档由 colorLut 的 pre 钩子接管，这里只服务无 GL 的兜底。
            if (cbgm) {
                const o = cbgm.pre(vr * 255, vg * 255, vb * 255);
                vr = o[0] / 255; vg = o[1] / 255; vb = o[2] / 255;
            }
            r[i] = vr.toFixed(5);
            g[i] = vg.toFixed(5);
            b[i] = vb.toFixed(5);
        }
        return { r, g, b };
    }

    function writeTables(p, skipCbgm) {
        ensureFilter();
        const t = buildTables(p, skipCbgm);
        _ctEl.r.setAttribute('tableValues', t.r.join(' '));
        _ctEl.g.setAttribute('tableValues', t.g.join(' '));
        _ctEl.b.setAttribute('tableValues', t.b.join(' '));
    }

    // lutOn：跨通道那几档已并入 ACR 三维表时，这里就不要再叠一遍
    // （校准矩阵 / CSS saturate），否则同一个滑块会生效两次。
    function filterString(p, longPx, lutOn) {
        syncChain(p, longPx || 0, !!lutOn);
        const parts = [];
        const hi = Number(p.hi) || 0, tp = Number(p.temp) || 0;
        const tn = Number(p.tint) || 0;
        const wht = Number(p.white) || 0, blk = Number(p.black) || 0;
        const exp = Number(p.exp) || 0;
        const C = window.QfsCurve;
        const curved = !!(C && C.curveActive(p.curve));
        const calOn = calActive(p.cal) && !lutOn;
        // 只要滤镜进链就写表（写表只有 256 次循环，可忽略）：
        // 否则只开校准/USM 时会残留上一次烘焙的表值。
        // 曝光也在这张表里（线性光乘 2^EV），不再用 brightness()。
        const gamOn = Number(p.gam) || 0;
        // 阴影不进表：它由 QfsShadows 的空间 pass 负责（见 bakeOne）
        // 色彩平衡 / 渐变映射只在没有三维表时进滤镜；有表时它们由 colorLut 接管
        // （按真实 RGB 算，见 cbgmPrep），这时滤镜里若也写一遍就会生效两遍。
        const cbgmOn = !lutOn && (cbActive(p.cb) || gmActive(p.gm));
        if (hi || tp || tn || wht || blk || exp || gamOn || curved
            || (Number(p.con) || 0)
            || cbgmOn
            || calOn || detActive(p.det)) {
            writeTables(p, lutOn);
            parts.push('url(#' + GRADE_FILTER_ID + ')');
        }
        const acrCon = (window.QfsAcr && window.QfsAcr.ready())
            && (Number(p.con) || 0);   // 实测表路径下对比度已进 LUT，不再叠 CSS contrast
        const con = (Number(p.con) || 0) / 100;
        if (con && !acrCon) parts.push('contrast(' + (1 + con * 0.5).toFixed(4) + ')');
        const sat = (Number(p.sat) || 0) / 100;
        if (sat && !lutOn) parts.push('saturate(' + (1 + sat).toFixed(4) + ')');
        // 去除薄雾不再走 contrast/saturate 叠加：那是「假通透」，与 ACR 差得远。
        // 真实做法（雾色 + 暗通道反演）已在后置 pass 里，见 QfsColor。
        return parts.join(' ');
    }

    // ── 缓存 ──────────────────────────────────────────────────────
    const _lru = [];
    /* 淘汰一张照片时显式释放它持有的全尺寸画布后备缓冲。
       只置 null 的话，Chromium 要等 GC 才肯还那 96MB；多图洗图时 LRU 一直往外吐
       大画布却迟迟不回落（app-qfs.js 编码完也是 width=0 这么做的）。
       只在「整张图被淘汰」时调用：此刻 _grade 与 _gradeCache 会一起丢弃，
       不会有别处还在用这些位图。invalidateFullGrade 那种局部作废不能这么干，
       它丢的 canvas 可能正是 low 档 slot.base。 */
    function releaseGradeBitmaps(im) {
        if (!im) return;
        const seen = new Set();
        const kill = (c) => {
            if (!c || seen.has(c) || !(c instanceof HTMLCanvasElement)) return;
            seen.add(c);
            try { c.width = 0; c.height = 0; } catch (_) { /* 已释放，忽略 */ }
        };
        const g = im._grade || {};
        kill(g.canvas);
        kill(g.low);
        const slots = im._gradeCache;
        if (!slots) return;
        for (const k of Object.keys(slots)) {
            const s = slots[k];
            if (!s) continue;
            kill(s.base);
            for (const it of (s.chain || [])) kill(it && it.canvas);
        }
    }
    function lruTouch(im) {
        const i = _lru.indexOf(im);
        if (i >= 0) _lru.splice(i, 1);
        _lru.push(im);
        while (_lru.length > LRU_MAX) {
            const old = _lru.shift();
            if (!old) continue;
            releaseGradeBitmaps(old);
            if (old._grade) { old._grade.canvas = null; old._grade.low = null; }
            old._gradeCache = null;
        }
    }

    // 单层烘焙：把 src 按 params 画成一张指定尺寸的画布（不含蒙版）。
    //
    // 跨通道的那几档（校准 / 饱和度 / 自然饱和度 / 混色器 / 颜色分级）走 ACR 实测
    // 三维表：它们对红黄蓝的作用各不相同，逐通道 LUT 和手写公式都学不像 PS。
    // 表/WebGL 任一不可用时整段退回旧路径（QfsMix + shader 里的 vib/cg），
    // 功能不缺失，只是精度回到公式。
    // 阴影 pass 的「画布内容」凭据，用来复用它的引导滤波场。
    // 只能按参数自己拼：filterString 里只有 url(#id)，参数一换表就换、字符串却不变。
    // sh 本身**不在**键里 —— 拖阴影滑块时场完全没变，正是要命中的场景。
    const _shSrcId = new WeakMap();
    let _shSrcSeq = 0;
    function shadowKey(p, tw, th, src, withMix) {
        // src 一定是 Image/Canvas；真遇到别的类型就不进缓存（宁可慢，不能崩）
        let id = 0;
        if (src && typeof src === 'object') {
            id = _shSrcId.get(src);
            if (!id) { id = ++_shSrcSeq; _shSrcId.set(src, id); }
        }
        const C = window.QfsCurve;
        const sig = (C && C.curveActive(p.curve)) ? C.curveSignature(p.curve) : '-';
        const n = (v) => Number(v) || 0;
        // 尺寸只进「长宽比」，不进像素数：场本身是 384 格的低频栅格（1600px 上是
        // 800×534，23MP 上只有 591×394），同一张图同一套色调参数下两者信息量几乎
        // 一样。以前把 tw/th 原样写进键，松手补全分辨率时必然 miss，于是又把 23MP
        // 整幅重扫了一遍（实测 ~600ms）。裁切/旋转会替换 im.el（id 变了），所以
        // 这里不必靠像素数兜底；长宽比只防「同一张源图被渲染成不同画幅」。
        const ar = th > 0 ? (tw / th) : 0;
        const parts = [id, ar.toFixed(3), n(p.exp), n(p.temp), n(p.tint), n(p.con), n(p.hi),
            n(p.white), n(p.black), n(p.gam), sig,
            p.cb ? JSON.stringify(p.cb) : '', p.gm ? JSON.stringify(p.gm) : '',
            p.det ? JSON.stringify(p.det) : ''];
        // 没有三维表时，混色器走前置 GL pass、饱和度/校准走 CSS 滤镜，画布内容就
        // 跟着这些量变，键里必须带上（有表时它们全在 LUT 里，不必进键，否则拖
        // 饱和度滑块会白白错过缓存）。
        if (withMix) {
            parts.push(JSON.stringify(p.mix || 0), n(p.sat), JSON.stringify(p.cal || 0));
        }
        return parts.join(',');
    }

    function bakeOne(src, params, tw, th) {
        let drawSrc = src;
        // 预览用小网格、定稿用大网格：33³ 合成约 6ms，25³ 约 3ms，而两者逐点
        // 平均只差 0.3/255 级（肉眼不可见）。拖动时省下的 3ms 更值钱。
        const lutGrid = Math.max(tw, th) <= GRID_PREVIEW_MAX ? 25 : 33;
        // 色彩平衡 / 渐变映射也进三维表：它们是跨通道算子，逐通道表看不见像素亮度
        const cbgm = cbgmPrep(params);
        let lut = (window.QfsAcr && window.QfsAcr.ready())
            ? window.QfsAcr.colorLut(params, lutGrid, acrBrightness(), cbgm) : null;
        const useLut = !!lut && !!(window.QfsColor && window.QfsColor.usingGL());
        if (!useLut) lut = null;
        // 混色器已并进三维表，就不再需要前置的 GL 混色 pass
        // 点颜色样本没进三维表（样本是用户随取的，网格做不出来），始终走前置 GL pass：
        // 有三维表时先只施加样本、让表去管 8 个色带；没有表时一次把带与样本都施加掉。
        if (window.QfsMix && (samplesActive(params.samples)
            || (!useLut && mixActive(params.mix)))) {
            drawSrc = window.QfsMix.pass(src, params.mix, params.samples, tw, th, !useLut) || src;
        }
        const c = document.createElement('canvas');
        c.width = tw; c.height = th;
        const g = c.getContext('2d');
        if (!g) return null;
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        const fs = filterString(params, Math.max(tw, th), useLut);
        if (fs) g.filter = fs;
        g.drawImage(drawSrc, 0, 0, tw, th);
        if (fs) g.filter = 'none';
        // 锐化不在这里：带蒙版的照片每一层都会走 bakeOne，放这儿会被锐化两遍。
        // 它是全局的（LR 的捕获锐化同样不分蒙版），统一在 bake() 合成完再做一次。
        // 阴影：ACR 的阴影是空间自适应的，逐通道查找表做不出那个形状，所以单独跑一遍
        // 像素 pass（在色调之后、跨通道三维表之前，与 Camera Raw 的顺序一致）。
        // 系数表没就绪时静默跳过——不能退回全局表，那正是要修掉的错误形状。
        const shAmt = Number(params.sh) || 0;
        const shOn = shAmt && window.QfsShadows && window.QfsShadows.ready();
        let shData = null;
        if (shOn) {
            const shKey = shadowKey(params, tw, th, src, !useLut);
            // 优先交给 shader：场与系数上传成纹理，在 QfsColor 的 pass 里施加。
            // 全分辨率 23MP 实测 1387ms → 十几毫秒，而且不再需要把整幅像素
            // getImageData 出来（那是 92MB 的分配）；字段命中时连读像素都省了。
            if (window.QfsColor && window.QfsColor.canShadow()) {
                shData = window.QfsShadows.prepare(c, shAmt, shKey, false);
            }
            // 兜底：没有 WebGL / 没有浮点纹理时仍走逐像素。不能静默跳过 ——
            // 跳过等于整片漏掉阴影，画面会突然变平。
            if (!shData) window.QfsShadows.applyCanvas(c, shAmt, shKey);
        }
        // 后置 pass 的顺序（对齐 Compositor）：先几何（畸变重采样），再上三维颜色表，
        // 最后黑白（PS 的黑白混色器没有实测表，仍走公式）。
        // 旧路径下 vib / cg 也在这里（按像素自己的饱和度/亮度选区，LUT 表达不了）。
        if (shOn || useLut || bwActive(params.bw) || lcActive(params.lc)
            || (!useLut && ((Number(params.vib) || 0) || cgActive(params.cg)))
            || (Number(params.det && params.det.dhz) || 0)) {
            const haze = (Number(params.det && params.det.dhz) || 0) ? acrHaze() : null;
            const out = window.QfsColor && window.QfsColor.pass(c, params, tw, th, lut, haze, shData);
            if (out) {
                // GL 通道返回的是 app-color-grade.js 里的**模块级共享画布**(glc，标了
                // __qfsShared)。直接把它当成 im._grade.canvas，所有照片的烘焙结果就会指向
                // 同一张画布：后烘的图覆盖先烘的，切回上一张时 selectImage 看到 canvas 有值
                // 就不再重烘，画布于是显示另一张照片的像素 —— 也就是「两张照片串了」。
                // 2D 回退通道自己新建画布，可以直接交出去；共享画布必须落回自有画布。
                if (!out.__qfsShared) return out;
                // 落回时复用 c（尺寸一致），不再额外分配一张全分辨率画布
                g.setTransform(1, 0, 0, 1, 0, 0);
                g.clearRect(0, 0, tw, th);
                g.drawImage(out, 0, 0);
                return c;
            }
        }
        return c;
    }

    // 全分辨率蒙版链最多留几层（每层 ≈96MB，见 bake 里的说明）
    const FULL_CHAIN_KEEP = 3;
    let _srcSeq = 0;
    // 中间结果缓存：拖动某个蒙版时只重烘它那一层，前缀直接复用。
    // 两档分别缓存：low（1600px）拖动时用；full（原图尺寸）导出/静置时用。
    //
    // 以前 full 档用的是临时对象，前缀缓存完全失效 —— 改最后一个蒙版要把前面
    // 所有组从头烘一遍，每组产出 1 张全尺寸画布，峰值内存能到十几张 96MB。
    // 现在 full 档也走缓存，但**只留最近一档**：全尺寸画布太大，
    // 同时缓存两档等于同时驻留两套蒙版链，内存翻倍。
    function cacheSlot(im, tw, th) {
        if (!im._gradeCache) im._gradeCache = {};
        const key = tw + 'x' + th;
        if (!im._gradeCache[key]) {
            const keys = Object.keys(im._gradeCache);
            // 只留两档（low + full），超出的先丢（丢的是最老的一档）
            while (keys.length >= 2) { delete im._gradeCache[keys.shift()]; }
            im._gradeCache[key] = { baseKey: '', base: null, chain: [] };
        }
        return im._gradeCache[key];
    }

    function bake(im, p, maxEdge) {
        const src = im.el;
        if (!src) return null;
        const W = src.naturalWidth || im.w || 0;
        const H = src.naturalHeight || im.h || 0;
        if (!W || !H) return null;
        let tw = W, th = H;
        const long = Math.max(W, H);
        if (maxEdge > 0 && long > maxEdge) {
            const k = maxEdge / long;
            tw = Math.max(1, Math.round(W * k));
            th = Math.max(1, Math.round(H * k));
        }
        // 源像素换了（裁切/旋转会替换 im.el）也必须失效，否则会拿到旧图烘的缓存
        if (!src._qfsVer) src._qfsVer = ++_srcSeq;

        const globalOnly = Object.assign({}, p, { masks: [] });
        const baseKey = signature(globalOnly) + '@' + src._qfsVer + '@' + tw + 'x' + th;
        // 两档都走 slot 缓存：全分辨率档以前是临时对象，前缀缓存等于没有
        const slot = cacheSlot(im, tw, th);
        if (slot.baseKey !== baseKey || !slot.base) {
            slot.base = bakeOne(src, p, tw, th);
            slot.baseKey = baseKey;
            slot.chain = [];
        }
        let cur = slot.base;
        if (!cur) return null;

        // 逐「组」烘焙：一个组 = 一个 new 蒙版 + 它的 add/subtract/intersect 成员，
        // 组内共用组首的参数、共用一条烘焙层；权重由 groupAlpha 按组合模式合并。
        // 这样「修边缘」= 加一个「减去」蒙版，不用重画整个蒙版。
        // 前缀缓存：只改第 N 组时，前 N-1 层直接复用。
        const grps = (window.QfsMask && window.QfsMask.activeGroups) ? window.QfsMask.activeGroups(p.masks) : [];
        let prevKey = baseKey;
        for (let i = 0; i < grps.length; i++) {
            const g = grps[i];
            const key = prevKey + '>' + window.QfsMask.groupSignature(g);
            const hit = slot.chain[i];
            if (hit && hit.key === key && hit.canvas) {   // canvas 可能被内存上限置空
                cur = hit.canvas;
                prevKey = key;
                continue;
            }
            const layer = bakeOne(cur, g.head.p, tw, th) || cur;
            // 蒙版权重固定按**原图**算：亮度/颜色蒙版若拿已调色层当源，一压暗选区就变大、
            // 一提亮就变小，调完色再点回蒙版会发现"范围变了"。曲线/校准/混色器同理，
            // 选区应该只由原画面的内容决定，与调色参数无关。
            const alpha = window.QfsMask.groupAlpha(g, tw, th, im.el);
            cur = window.QfsMask.composite(cur, layer, alpha);
            slot.chain[i] = { key, canvas: cur };
            slot.chain.length = i + 1;
            // 全分辨率档的链不能无限长：每一层都是一张原图尺寸的画布（24MP ≈ 96MB），
            // 12 个蒙版就能把内存顶到 1GB 以上。低分辨率档无所谓（1600px 才几 MB），
            // 全分辨率只留最近 3 层 —— 改最后一个蒙版是常见操作，前缀复用已经够；
            // 再往前的层留着基本没人用得到，内存却实打实占着。
            //
            // 注意只能把旧层的**画布**丢掉，不能动数组下标：chain[i] 对应第 i 组，
            // 一旦 splice 移位，下标与组的对应关系就错位了，缓存会命中错误的层
            // （症状是改了第 5 组，画面却按第 3 组的中间结果合成）。
            if (maxEdge <= 0 && slot.chain.length > FULL_CHAIN_KEEP) {
                for (let k = 0; k < slot.chain.length - FULL_CHAIN_KEEP; k++) {
                    if (slot.chain[k]) slot.chain[k].canvas = null;
                }
            }
            prevKey = key;
        }
        if (grps.length === 0) slot.chain.length = 0;

        // 锐化：蒙版合成完之后做一次，且必须落到**新画布**上 ——
        // cur 可能直接就是 slot.base 缓存，就地改会越叠越锐（每渲染一次再加一遍）。
        //
        // 拖动中的 1600px 过渡档不锐化：它在松手 220ms 后就会被全分辨率档替换，
        // 肉眼几乎看不出差别，但这一刀实测要 76ms，正好卡在每帧 200ms 的手感上。
        // 全分辨率档与导出照常锐化 —— 该有画质的地方一点没少。
        const doSharpen = maxEdge !== LOW_EDGE;
        const shP = (doSharpen && window.QfsSharpen)
            ? window.QfsSharpen.paramsOf(p.det, Math.max(tw, th), Math.max(W, H)) : null;
        if (shP) {
            // 先走 shader：23MP 实测 CPU 版 1064ms（其中 420ms 是把 GPU 画布读回
            // 来的代价），GL 只上传一次 + 两趟高斯 + 一趟合成。sharpenCanvas
            // 返回自有画布；不可用（无 GL / 半径超出 33 抽头核）时返回 null。
            let sc = null;
            if (window.QfsColor && window.QfsColor.sharpenCanvas) {
                sc = window.QfsColor.sharpenCanvas(cur, shP);
            }
            if (!sc) {
                sc = document.createElement('canvas');
                sc.width = tw; sc.height = th;
                const sg = sc.getContext('2d');
                if (!sg) sc = null;
                else {
                    sg.drawImage(cur, 0, 0);
                    window.QfsSharpen.applyCanvas(sc, p.det, Math.max(tw, th), Math.max(W, H));
                }
            }
            if (sc) cur = sc;
        }

        // canvas 没有 naturalWidth/naturalHeight，但引擎里到处用它算 fit / 比例 /
        // 自适应字号（autoExifSize = 档位 × clamp(照片宽/1200)）。
        // 必须恒等于原图尺寸，不能报烘焙后的像素尺寸：拖动中用的是 1600px 降采样，
        // 若按实际像素报，相机型号/参数文字会在拖动过程中变小、松手后又跳回原大小。
        // 烘焙画布只是像素密度不同，逻辑尺寸与原图一致，drawImage 仍按目标尺寸缩放绘制。
        cur.naturalWidth = W;
        cur.naturalHeight = H;
        cur.complete = true;
        return cur;
    }

    // 渲染取源：优先全分辨率，其次拖动中的降采样，都没有就原图
    window.photoSrcOf = function (im) {
        if (!im) return null;
        // 蒙版「原图预览」：只在主预览渲染期间(renderPreview 临时置 _previewUseOriginal)生效。
        // 导出/缩略图走各自的渲染入口，不会误用未调色源；导出后画面不会变。
        const app = window.App;
        if (app && app._previewUseOriginal && im === app.image) return im.el || null;
        const g = im._grade;
        if (g && !g.neutral) {
            // 烘焙画布是 Canvas（没有 src），样式引擎的取色缓存只认 src+尺寸会永远命中。
            // 把当前烘焙签名挂在画布上，imgKey 据此区分不同调色结果 —— 艺术卡色卡、
            // 主色/边缘取色等都会随调色实时更新。签名一变，旧缓存自然失效，不必全清。
            if (g.canvas) {
                g.canvas._qfsGradeKey = g.fullKey || g.lowKey || '';
                return g.canvas;
            }
            // low 只在 lowKey 仍有效时才可信：invalidateGrade(换底图/还原/重设等)会清空
            // lowKey 却保留旧 low 画布,若直接返回会拿到裁切前/旋转前的旧图当"已调色结果"
            // —— 表现就是调色像没了,碰一下滑块才回来。
            if (g.low && g.lowKey) {
                g.low._qfsGradeKey = g.lowKey;
                return g.low;
            }
        }
        return im.el || null;
    };

    // 导出/保存前必须保证存在全分辨率版本，否则会拿 1600px 的降采样去出 4K 图
    window.ensureFullGrade = function (im) {
        const app = window.App;
        if (!im || !im._grade || im._grade.neutral) return;
        if (im._grade.canvas) return;
        im._grade.canvas = bake(im, im.grade, FULL_EDGE);
        lruTouch(im);
        if (app && im._grade.canvas) app.__gradeBaked = true;
    };

    // ── 色彩平衡 / 渐变映射 / 镜头校正 的 UI 绑定 ──────────────────
    // 这三组的共同点：参数不是「单一数字」，所以不走 GRADE_FIELDS 那套通用滑块，
    // 各自 bind 一次，提交时整体 patch 进 grade。
    let _cbZone = 'shadow';

    function initToneExtra() {
        const $ = (id) => document.getElementById(id);
        const self = this;
        const commit = (patch) => {
            if (!self.image) return;
            self.setGrade(patch);
        };
        const bindRange = (inp, apply, settleMs) => {
            if (!inp) return;
            let t = 0;
            inp.addEventListener('input', () => {
                apply(Number(inp.value) || 0);
                clearTimeout(t);
                t = setTimeout(() => self.rebuildGrade('full'), settleMs || 220);
            });
            inp.addEventListener('change', () => {
                clearTimeout(t);
                apply(Number(inp.value) || 0);
                // 松手不同步烘全分辨率：那是 1~3 秒的主线程阻塞，正好压在松手那一帧，
                // 界面会先僵住、再「啪」地变清晰。交给同一个防抖晚 80ms 再烘，
                // 当前低清帧先画完，手感不断。
                t = setTimeout(() => self.rebuildGrade('full'), 80);
            });
        };

        // 色彩平衡：三个区共九个值，当前区由「阴影/中间调/高光」子页决定
        const zones = $('cbZones');
        if (zones) {
            zones.querySelectorAll('[data-cbz]').forEach((b) => {
                b.addEventListener('click', () => {
                    _cbZone = b.dataset.cbz;
                    zones.querySelectorAll('[data-cbz]').forEach((x) => {
                        x.classList.toggle('active', x === b);
                    });
                    if (self.syncToneExtraUI) self.syncToneExtraUI(self.gradeOf(self.image));
                });
            });
        }
        for (const ax of CB_AXES) {
            bindRange($('slCb' + ax.k.toUpperCase()), (v) => {
                const cur = self.gradeOf(self.image).cb || defaultCb();
                const z = Object.assign({}, cur[_cbZone] || {}, { [ax.k]: v });
                commit({ cb: Object.assign({}, cur, { [_cbZone]: z }) });
            });
        }
        const pres = $('cbCbPreserve');
        if (pres) {
            pres.addEventListener('change', () => {
                const cur = self.gradeOf(self.image).cb || defaultCb();
                commit({ cb: Object.assign({}, cur, { preserve: pres.checked ? 1 : 0 }) });
                self.rebuildGrade('full');
            });
        }
        const cbReset = $('btnCbReset');
        if (cbReset) {
            cbReset.addEventListener('click', () => {
                commit({ cb: null });
                self.rebuildGrade('full');
                self.setStatus('色彩平衡已重置');
            });
        }

        // 渐变映射
        const gmOn = $('cbGmOn');
        if (gmOn) {
            gmOn.addEventListener('change', () => {
                const cur = self.gradeOf(self.image).gm || defaultGm();
                commit({ gm: Object.assign({}, cur, { on: gmOn.checked ? 1 : 0 }) });
                self.rebuildGrade('full');
            });
        }
        const bindColor = (id, key) => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('input', () => {
                const cur = self.gradeOf(self.image).gm || defaultGm();
                commit({ gm: Object.assign({}, cur, { [key]: el.value, on: 1 }) });
                clearTimeout(el._gmT);
                el._gmT = setTimeout(() => self.rebuildGrade('full'), 200);
            });
            el.addEventListener('change', () => {
                const cur = self.gradeOf(self.image).gm || defaultGm();
                commit({ gm: Object.assign({}, cur, { [key]: el.value, on: 1 }) });
                self.rebuildGrade('full');
            });
        };
        bindColor('clGmDark', 'dark');
        bindColor('clGmLight', 'light');
        bindRange($('slGmAmount'), (v) => {
            const cur = self.gradeOf(self.image).gm || defaultGm();
            commit({ gm: Object.assign({}, cur, { amount: v, on: 1 }) });
        });

        // 镜头校正
        bindRange($('slLcDistort'), (v) => {
            commit({ lc: v ? { distort: v } : null });
        });
    }

    function syncToneExtraUI(p) {
        const $ = (id) => document.getElementById(id);
        const app = window.App;
        const text = (v) => (v === 0 ? '0' : (v > 0 ? '+' + v : String(v)));

        const cb = (p && p.cb) || null;
        const z = (cb && cb[_cbZone]) || { r: 0, g: 0, b: 0 };
        for (const ax of CB_AXES) {
            const id = 'Cb' + ax.k.toUpperCase();
            const inp = $('sl' + id);
            const v = Number(z[ax.k]) || 0;
            if (inp) inp.value = String(v);
            if (app.updateLabel) app.updateLabel('lbl' + id, text(v));
            else { const el = $('lbl' + id); if (el) el.textContent = text(v); }
        }
        const pres = $('cbCbPreserve');
        if (pres) pres.checked = !cb || cb.preserve !== 0;
        const grpCb = $('grpCb');
        if (grpCb) grpCb.classList.toggle('grade-on', !!cb);

        const gm = (p && p.gm) || null;
        const gmOn = $('cbGmOn');
        if (gmOn) gmOn.checked = !!(gm && gm.on !== 0);
        const dk = $('clGmDark'), lt = $('clGmLight');
        if (dk) dk.value = (gm && gm.dark) || '#101a33';
        if (lt) lt.value = (gm && gm.light) || '#ffd9a0';
        const amt = gm ? gm.amount : 100;
        const amtInp = $('slGmAmount');
        if (amtInp) amtInp.value = String(amt);
        if (app.updateLabel) app.updateLabel('lblGmAmount', String(amt));
        const grpGm = $('grpGm');
        if (grpGm) grpGm.classList.toggle('grade-on', !!gm);

        const lc = (p && p.lc) || null;
        const dv = lc ? (Number(lc.distort) || 0) : 0;
        const lcInp = $('slLcDistort');
        if (lcInp) lcInp.value = String(dv);
        if (app.updateLabel) app.updateLabel('lblLcDistort', text(dv));
        const grpLc = $('grpLc');
        if (grpLc) grpLc.classList.toggle('grade-on', !!lc);
    }

    Object.assign(window.App || (window.App = {}), {
        GRADE_FIELDS,
        DET_FIELDS,
        CAL_FIELDS,
        MIX_BANDS,
        MIX_METRICS,
        CG_ZONES,
        // 测试钩子：验证 LRU 淘汰确实把全尺寸画布的后备缓冲还了回去
        _releaseGradeBitmaps: releaseGradeBitmaps,
        defaultCg,
        sanitizeCg,
        isCgActive: cgActive,
        BW_BANDS, BW_KEYS, isBwActive: bwActive, defaultBw, sanitizeBw,
        CB_ZONES, CB_AXES, defaultCb, sanitizeCb, isCbActive: cbActive,
        defaultGm, sanitizeGm, isGmActive: gmActive, hexToRgb,
        defaultLc, sanitizeLc, isLcActive: lcActive,
        MASK_MODES, maskGroups,
        initToneExtra, syncToneExtraUI,

        isNeutralGrade: isNeutral,
        isCalActive: calActive,
        isDetActive: detActive,
        isMixActive: mixActive,
        calMatrixValues,
        normalizeGrade,
        defaultGrade,

        gradeOf(im) {
            return (im && im.grade) ? im.grade : defaultGrade();
        },

        // 调色预设缩略图：用当前照片走同一条烘焙管线，输出长边 ≤ maxEdge 的画布。
        // 只做同步一次，调用方负责缓存。bake 内部的亮度自适应/去薄雾都通过
        // window.App.image 取源，所以这里临时把 image 换成"同一张照片 + 预设参数"
        // 的临时对象，finally 恢复 —— 不碰用户真实的 grade/_grade 缓存。
        bakeGradePreview(p, maxEdge) {
            const im = this.image;
            const src = im && im.el;
            if (!src) return null;
            const w = src.naturalWidth || im.w || 0;
            const h = src.naturalHeight || im.h || 0;
            if (!w || !h) return null;
            const grade = normalizeGrade(Object.assign({}, p || {}, { masks: [] }));
            const temp = { el: src, w, h, grade, _grade: { neutral: false } };
            const prev = this.image;
            this.image = temp;
            try {
                return bake(temp, grade, maxEdge || 128);
            } finally {
                this.image = prev;
            }
        },

        // 白平衡吸管：屏幕点 → 照片像素 → 5×5 平均 → 反解 temp/tint。
        // 取样一律用原图（im.el），不用烘焙层：setGrade 是「替换白平衡」而不是叠加，
        // 若拿已经调过色的像素去解，解出来的值再套回原图会偏两倍。
        _pickWbAt(e) {
            const cv = this.dom && this.dom.canvas;
            const im = this.image;
            if (!cv || !im || !im.el) return false;
            const rect = cv.getBoundingClientRect();
            if (!rect.width || !rect.height) return false;
            const pr = this._photoRect;
            if (!pr || !(pr.w > 0) || !(pr.h > 0)) return false;
            // 与混色器吸管同一套坐标口径：_photoRect 与 _baseSize 都是「基准坐标」，
            // 不能拿 canvas.width 直接比（那样 DPR≠1 会整体偏一段）。
            const base = (typeof this._baseSize === 'function')
                ? this._baseSize() : { w: cv.width, h: cv.height };
            const bx = (e.clientX - rect.left) / rect.width * base.w;
            const by = (e.clientY - rect.top) / rect.height * base.h;
            const nx = (bx - pr.x) / pr.w, ny = (by - pr.y) / pr.h;
            if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) {
                this.setStatus('点在照片范围内取中性色（这里是画布或边框）');
                return true;
            }
            const src = im.el;
            const W = src.naturalWidth || src.width || 0;
            const H = src.naturalHeight || src.height || 0;
            if (!W || !H) return false;
            // 单点取样会被噪点和 JPEG 块效应带偏：取 5×5 求平均
            const R = 2, n = R * 2 + 1;
            const sx = Math.round(nx * W), sy = Math.round(ny * H);
            const x0 = Math.max(0, Math.min(W - n, sx - R));
            const y0 = Math.max(0, Math.min(H - n, sy - R));
            if (!this._wbCv) {
                this._wbCv = document.createElement('canvas');
                this._wbCv.width = n; this._wbCv.height = n;
                this._wbCtx = this._wbCv.getContext('2d', { willReadFrequently: true });
            }
            let d = null;
            try {
                this._wbCtx.clearRect(0, 0, n, n);
                this._wbCtx.drawImage(src, x0, y0, n, n, 0, 0, n, n);
                d = this._wbCtx.getImageData(0, 0, n, n).data;
            } catch (_) { d = null; }
            if (!d) { this.setStatus('这块像素读不出来，换一处点'); return true; }
            let r = 0, g = 0, b = 0;
            for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
            const cnt = d.length / 4;
            r /= cnt; g /= cnt; b /= cnt;
            // 端点没有色相可言：纯白/纯黑点下去，解出来的色温全是噪声
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            if (mx > 248 || mx < 14) {
                this.setStatus(mx > 248
                    ? '这里已经过曝，没有色相可解；换一块灰墙或中间调'
                    : '这里太暗，解不出可信的白平衡；换一块中间调');
                return true;
            }
            // 饱和色不能当白参考：绿叶/蓝天/红墙「也」能被解成中性，代价是把整张
            // 推向补色（点一片叶子，全图变品红）。这不是算法错，是选错了参考点。
            const sat = mx > 0 ? (mx - mn) / mx : 0;
            if (sat > 0.62) {
                this.setStatus('这个点颜色太浓，不是中性色；换一块灰墙 / 白纸 / 阴天天空');
                return true;
            }
            const A = window.QfsAcr;
            if (!A || typeof A.neutralize !== 'function' || (A.ready && !A.ready())) {
                this.setStatus('白平衡表还没就绪，稍等一下再点');
                return true;
            }
            const solved = A.neutralize(r, g, b);
            if (!solved || !isFinite(solved.spread)) {
                // 切图时 ACR 表会在后台重解一次，这一瞬（几十毫秒）解不出来。
                // 踢一下加载、稍后自动重试，别让用户「再点一次」。
                if (typeof A.ensure === 'function') A.ensure();
                this.setStatus('白平衡表还在准备，稍等一下…');
                clearTimeout(this._wbRetryT);
                this._wbRetryT = setTimeout(() => {
                    const s2 = A.neutralize(r, g, b);
                    if (s2 && isFinite(s2.spread)) this._applyWb(s2);
                    else this.setStatus('白平衡表还没就绪，稍后再点一次');
                }, 260);
                return true;
            }
            this._applyWb(solved, sat > 0.30
                ? '（这个点偏色较重，不是中性灰，结果可能夸张）' : '');
            return true;
        },

        // 反解结果落到参数上。单独拆出来是因为「表还没就绪」时要延迟重试，
        // 重试用的是同一段落值逻辑，不复制第二份。
        _applyWb(solved, warn) {
            if (this.pushUndo) this.pushUndo();
            const t = Math.round(solved.temperature), ti = Math.round(solved.tint);
            // global：即使当前选中了蒙版，白平衡也是整张照片的事（与自动调色同理）
            this.setGrade({ temp: t, tint: ti }, { global: true });
            // 与滑块一致：低清先出，80ms 后补全分辨率，松手那一下不僵
            clearTimeout(this._wbSettleT);
            this._wbSettleT = setTimeout(() => this.rebuildGrade('full'), 80);
            this.setStatus('白平衡：色温 ' + t + ' / 色调 ' + ti
                + (warn || (solved.spread > 30 ? '（这个点不太中性，结果可能偏，建议换一处）' : '')));
        },

        // 参数变了：立刻出一张降采样供拖动时看，静置 220ms 再补全分辨率
        setGrade(patch, opts) {
            const im = this.image;
            if (!im) return false;
            // 导入的照片可能没有 _grade 槽位：先确保它存在，否则下面
            // invalidateFullGrade 会因「!t._grade」直接返回，调色静默失效。
            this.ensureGrade(im);
            // 选中某个蒙版时，9 档滑块改的是**该蒙版的参数**（与 LR 一致）；
            // 曲线/校准/混色器/蒙版列表这类全局项仍然落到 grade 上。
            // 组合模式：滑块读写「组首」的参数（一组共用一套）
            const act = this.paramMask ? this.paramMask(im) : (this.activeMask ? this.activeMask(im) : null);
            const keys = Object.keys(patch || {});
            const onlySlider = keys.length > 0 && keys.every((k) => MASK_ROUTE_KEYS.indexOf(k) >= 0);
            // 自动调色是一次性的「整张照片」建议：即使当前选中了蒙版，也不能滑进蒙版参数。
            if (!(opts && opts.global) && act && onlySlider) {
                for (const k of keys) act.p[k] = clampGradeValue(k, patch[k]);
                this.invalidateGrade(im);
                this.rebuildGrade(opts && opts.full ? 'full' : 'low');
                this.syncGradeUI();
                if (this.scheduleRender) this.scheduleRender(true);
                if (this.scheduleDraft) this.scheduleDraft();
                return true;
            }
            // 选中蒙版却改了「不受蒙版控制」的档位（曲线/黑白/清晰度/镜头校正/色彩平衡/渐变映射…）：
            // 这些一直是全局的，用户很容易以为"蒙版没生效"。这里直接说清楚它落到整张照片了。
            if (act && keys.length) {
                // masks 是蒙版列表本身（所有蒙版操作都走这里），不是「全局调色档位」；
                // 不排除的话，每次加/删/停用蒙版都会弹一句「masks 是全局档位」。
                const globals = keys.filter((k) => k !== 'masks' && MASK_ROUTE_KEYS.indexOf(k) < 0);
                if (globals.length && this.setStatus) {
                    const names = globals.map((k) => {
                        const f = GRADE_FIELDS.find((x) => x.k === k);
                        return f ? f.label : ({ det: '清晰度/纹理', bw: '黑白', lc: '镜头校正', cg: '色彩平衡',
                            curve: '曲线', mix: '混色器', cal: '校准', gm: '渐变映射' }[k] || k);
                    });
                    this.setStatus('「' + names.join('、') + '」是全局档位，不受蒙版影响（已作用于整张照片）');
                    // 这条提示只解释「刚才那一下」，4 秒后清掉；否则它会一直挂在状态栏，
                    // 用户接着调蒙版档位时还看见"不受蒙版影响"，反而更糊涂。
                    clearTimeout(this._maskGlobalTipT);
                    this._maskGlobalTipT = setTimeout(() => {
                        const el = this.dom && this.dom.stCanvas;
                        if (el && String(el.textContent || '').indexOf('不受蒙版影响') >= 0) this.setStatus('');
                    }, 4000);
                }
            }
            // XMP 预设导入用 replace：未写进预设的档位归零，避免上一套参数
            // 残留在新预设里（否则同一张照片连续导入会越叠越不像）。
            const replace = !!(opts && opts.replace);
            const p = normalizeGrade(replace
                ? Object.assign({}, patch || {})
                : Object.assign({}, im.grade || {}, patch || {}));
            if (replace) this._activeMaskId = null;
            im.grade = p;
            // 只作废全分辨率画布：拖动参数时 low 那张 1600px 降采样图若 key 还对得上
            // 可以直接复用（rebuildGrade 会判断），不必每动一格就重新烘一张。
            this.invalidateFullGrade(im);
            this.rebuildGrade(opts && opts.full ? 'full' : 'low');
            this.syncGradeUI();
            if (this.scheduleRender) this.scheduleRender(true);
            if (this.scheduleDraft) this.scheduleDraft();
            return true;
        },

        // 只作废全分辨率烘焙，保留 low 缓存。
        // 参数变了之后 full 画布一定过期（它对应旧参数），但 low 那张 1600px 的
        // 降采样图是否还能用，要看 key —— rebuildGrade 自己会判断。
        // 以前 invalidateGrade 把两者一起清，等于每次拖一下滑块就丢掉一张
        // 已经烘好的 24MP 画布（≈96MB），还让 rebuildGrade 里的 key 判断成了死代码。
        invalidateFullGrade(im) {
            const t = im || this.image;
            if (!t || !t._grade) return;
            t._grade.canvas = null;
            t._grade.fullKey = '';
            // neutral 必须跟着参数更新：参数全零时整条烘焙链可以跳过。
            // （以前 neutral 只在 invalidateGrade 里算，而 setGrade 走的是本方法，
            //   结果调完色 neutral 还是 true → 渲染以为「没调色」直接用原图。）
            t._grade.neutral = isNeutral(t.grade);
        },

        invalidateGrade(im) {
            const t = im || this.image;
            if (!t) return;
            const neutral = isNeutral(t.grade);
            // low 画布**保留**（它只是一张小图，留着省一次重烘），
            // 但它的 key 必须作废：invalidateGrade 的调用点里有「换底图」的路径
            // （裁切/旋转/还原原图），底图变了却让 rebuildGrade 命中旧 key，
            // 就会复用裁切前烘的图 —— 画面看着没换，导出的也是旧图。
            // key 作废 → rebuildGrade 发现对不上 → 重新烘。
            t._grade = { neutral, canvas: null, low: t._grade ? t._grade.low : null, lowKey: '', fullKey: '' };
            // 按图缓存的测度必须跟源图一起作废：裁切/旋转/还原换了底图之后，
            // ACR 的对比度/高光/阴影仍按旧直方图选行，「去薄雾」也还在用旧图
            // 最亮 1% 当雾色 —— 换图之后这些参数等于作用在错误的图像上。
            delete t._acrBright;
            delete t._acrHaze;
            if (neutral) { t._grade.lowKey = ''; t._grade.fullKey = ''; return; }
            lruTouch(t);
        },

        // 兜底：任何图像首次进烘焙管线前都必须有 _grade 槽位。否则 setGrade→
        // invalidateFullGrade / rebuildGrade 都会因为「!t._grade」提前返回，导致调色
        // 静默失效（表现：导入照片后拖滑块毫无反应，直到某条会建 _grade 的路径——
        // 例如添加蒙版——把它建出来才恢复）。导入流程 imageFromPick 已初始化，这里
        // 再做一次防御，覆盖所有图像创建路径（示例图/预设图/草稿还原等）。
        ensureGrade(im) {
            const t = im || this.image;
            if (!t) return null;
            if (!t._grade) {
                t._grade = { neutral: isNeutral(t.grade || defaultGrade()), canvas: null, low: null, lowKey: '', fullKey: '' };
            }
            return t._grade;
        },

        rebuildGrade(level) {
            const im = this.image;
            if (!im) return false;
            this.ensureGrade(im);
            if (im._grade.neutral) return false;
            // key 里带上**源图版本**：裁切/旋转/还原原图会换掉 im.el，
            // 参数签名却一个字都没变 —— 只比参数就会命中裁切前烘的图，
            // 画面看着没换底图。多带一个版本号，这条路径就断死了。
            const src = im.el;
            // 源图版本号：每个 el 对象一个（换底图 = 换对象 = 新版本）。
            // 这里要确保它已存在，否则第一次的 key 是 @0、bake 之后变成 @1，
            // 下次就会因为「key 变了」白重烘一次。
            if (src && !src._qfsVer) src._qfsVer = ++_srcSeq;
            const srcVer = (src && src._qfsVer) ? src._qfsVer : 0;
            const key = signature(im.grade) + '@' + srcVer;
            if (level === 'full') {
                // full / low 各记各的 key：以前共用一个字段，
                // 「full 烘好了」会把 low 的 key 覆盖掉，之后 low 要么被误判为
                // 命中（其实对不上）要么被白清一次。两张画布的生命周期本来就不同，
                // 分开记最省心。
                if (im._grade.canvas && im._grade.fullKey === key) return true;
                const c = bake(im, im.grade, FULL_EDGE);
                if (c) { im._grade.canvas = c; im._grade.fullKey = key; lruTouch(im); }
                return !!c;
            }
            if (im._grade.low && im._grade.lowKey === key) return true;
            const c = bake(im, im.grade, LOW_EDGE);
            if (c) { im._grade.low = c; im._grade.lowKey = key; lruTouch(im); }
            return !!c;
        },

        resetGrade() {
            const im = this.image;
            if (!im) return false;
            im.grade = defaultGrade();
            this._activeMaskId = null;
            // 重置调色后没有可预览的「原图 vs 调色」差异，退出蒙版原图预览
            this._maskPreviewOriginal = false;
            if (this._syncMaskOrigHint) this._syncMaskOrigHint();
            im._gradeCache = null;
            this.invalidateGrade(im);
            this.syncGradeUI();
            if (this.renderFramedThumb) this.renderFramedThumb(im);
            if (this.scheduleRender) this.scheduleRender(true);
            if (this.scheduleDraft) this.scheduleDraft();
            this.setStatus('已重置调色');
            return true;
        },

        // 自动调色：本地直方图估算一次基础档位，走与拖滑块相同的 setGrade 管线。
        // 不碰蒙版（opts.global），一次点击只压一条撤销；连续点结果不变（读原图）。
        autoGrade() {
            const im = this.image;
            if (!im || !im.el) {
                if (this.setStatus) this.setStatus('先导入照片，再点自动调色');
                return false;
            }
            const A = window.QfsAutoGrade || {};
            const isRaw = !!im.raw;
            // RAW：显影层校白平衡，调色层只做色调/黑白场，避免两层都校一次色温。
            const rawPatch = isRaw && typeof A.suggestRaw === 'function' ? A.suggestRaw(im) : null;
            const patch = typeof A.suggest === 'function'
                ? A.suggest(im, { skipWhiteBalance: isRaw }) : null;
            if (!patch) {
                if (this.setStatus) this.setStatus('这张照片读不到像素，自动调整未执行');
                return false;
            }
            const wbChanged = !!(rawPatch && (rawPatch.temperature || rawPatch.tint));
            if (this.pushUndo) this.pushUndo();
            if (isRaw && wbChanged) {
                im.raw.params = Object.assign({}, this.rawParamsOf ? this.rawParamsOf(im) : {}, rawPatch);
                this._rawInvalidate && this._rawInvalidate(im);
                if (this._rawReload) {
                    const edge = this.RAW_PROXY_EDGE || 1600;
                    const p = this._rawReload(im, edge);
                    if (p && typeof p.then === 'function') {
                        p.then((ok) => {
                            if (ok && this._rawQueueFull) this._rawQueueFull(400);
                            else if (!ok && im.raw.error && this.setStatus) {
                                this.setStatus('RAW 白平衡已写入，但显影失败：点「重试显影」');
                            }
                        });
                    }
                }
            }
            this.setGrade(patch, { global: true });
            clearTimeout(this._autoGradeSettle);
            this._autoGradeSettle = setTimeout(() => {
                this.rebuildGrade('full');
                if (window.QfsHistogram) window.QfsHistogram.redraw();
            }, 180);
            if (window.QfsHistogram) window.QfsHistogram.redraw();
            if (this.setStatus) {
                this.setStatus(isRaw
                    ? (wbChanged
                        ? '已自动校正 RAW 白平衡并调色（本地计算，可撤销）'
                        : '已按直方图自动调色，RAW 白平衡已接近中性（可撤销）')
                    : '已按直方图自动调色（本地计算，可撤销）');
            }
            return true;
        },

        // 把当前照片的调色参数复制给指定下标。「应用到全部」和「应用到选中」
        // 共用这一份深拷贝逻辑，避免两个入口各写一遍、以后只修一处。
        _applyGradeTo(targets, message) {
            const im = this.image;
            if (!im) return false;
            const p = normalizeGrade(im.grade);
            let n = 0;
            for (const idx of new Set(targets || [])) {
                const it = (this.images || [])[idx];
                if (!it || it === im) continue;
                // 曲线是点数组的嵌套结构、混色器是两层的带参数结构，必须深拷贝：
                // 浅拷贝会让所有照片共用同一份数据互相串台
                const cv = p.curve ? JSON.parse(JSON.stringify(p.curve)) : null;
                const mx = p.mix ? JSON.parse(JSON.stringify(p.mix)) : null;
                const cg = p.cg ? JSON.parse(JSON.stringify(p.cg)) : null;
                const mk = JSON.parse(JSON.stringify(p.masks || []));
                it.grade = Object.assign({}, p, {
                    curve: cv, mix: mx, cg, masks: mk,
                    cal: p.cal ? Object.assign({}, p.cal) : null,
                    det: p.det ? Object.assign({}, p.det) : null
                });
                it._grade = { neutral: isNeutral(p), canvas: null, low: null, lowKey: '', fullKey: '' };
                n++;
            }
            if (this.buildThumbnails) this.buildThumbnails();
            if (this.scheduleDraft) this.scheduleDraft();
            // message 传 null 表示调用方自己写状态（例如「边框 + 调色」只报一次）
            if (message) this.setStatus(typeof message === 'function' ? message(n) : message);
            return true;
        },

        // 把当前照片的调色参数复制给所有照片（批量洗图的常见诉求）
        applyGradeToAll() {
            return this._applyGradeTo(
                (this.images || []).map((_, i) => i),
                (n) => n ? ('调色已应用到其余 ' + n + ' 张照片') : '只有一张照片，无需批量应用'
            );
        },

        // 胶片条多选的目标（去掉当前编辑图：它是同步源，不是目标）。
        // selectedIdx 同时被「单击缩略图」写，单选时只有 1 项，这里会被自然过滤掉。
        _gradeSelectedTargets() {
            const raw = (this.selectedIdx && this.selectedIdx.length)
                ? this.selectedIdx : (this.batchSel || []);
            const max = (this.images || []).length;
            return Array.from(new Set((raw || []).filter((i) =>
                Number.isInteger(i) && i >= 0 && i < max && i !== this.currentIdx)));
        },

        // 只把这套调色参数给勾选的照片：以前 ⋯ 菜单只有「应用到全部」，
        // 想洗其中几张就得先「应用到全部」再逐张改回来（或者走会连边框一起搬的
        // 复制/粘贴设置）。顶栏「同步到选中」只搬边框，两者互不替代。
        applyGradeToSelected() {
            const targets = this._gradeSelectedTargets();
            if (!targets.length) {
                this.setStatus('请先在胶片条多选要应用调色的照片（Ctrl / Shift + 单击，或 Ctrl+A 全选）');
                return false;
            }
            return this._applyGradeTo(targets,
                (n) => n ? ('调色已应用到选中的 ' + n + ' 张照片') : '选中的照片无需应用');
        },

        // 缩略图右键菜单用：目标由右键位置直接给出（单张或整批勾选），
        // 不读 selectedIdx/batchSel —— 右键落在未勾选的那张时只该影响那一张。
        // opts.silent 给「边框 + 调色」组合用，避免连报两条状态。
        applyGradeToTargets(idxs, opts) {
            const max = (this.images || []).length;
            const list = Array.from(new Set((idxs || []).filter((i) =>
                Number.isInteger(i) && i >= 0 && i < max && i !== this.currentIdx)));
            if (!list.length) {
                if (!(opts && opts.silent)) this.setStatus('右键目标就是当前编辑的这张，无需同步调色参数');
                return false;
            }
            const silent = !!(opts && opts.silent);
            return this._applyGradeTo(list, silent ? null
                : ((n) => '调色参数已同步到 ' + n + ' 张照片'));
        },

        syncGradeUI() {
            const d = this._gradeDom;
            if (!d) return;
            const p = this.gradeOf(this.image);
            const act = this.paramMask ? this.paramMask(this.image) : (this.activeMask ? this.activeMask(this.image) : null);
            const src = act ? act.p : p;
            for (const f of GRADE_FIELDS) {
                const inp = d.sliders[f.k];
                const v = Number(src[f.k]) || 0;
                if (inp) inp.value = String(v);
                // 标签必须走 updateLabel:它是数字框(.pval-num)的唯一同步入口,
                // 直接写 textContent 会让切照片/编程设值后数字框停在旧值。
                const id = 'lblGrade' + f.k.charAt(0).toUpperCase() + f.k.slice(1);
                const text = v === 0 ? '0' : (v > 0 ? '+' + v : String(v));
                if (typeof this.updateLabel === 'function') this.updateLabel(id, text);
                else if (d.labels[f.k]) d.labels[f.k].textContent = text;
            }
            if (d.wrap) {
                d.wrap.classList.toggle('grade-on', !isNeutral(p));
                d.wrap.classList.toggle('editing-mask', !!act);
            }
            if (this.syncMaskUI) this.syncMaskUI();
            if (this.syncCurveUI) this.syncCurveUI();
            if (this.syncGradeExtraUI) this.syncGradeExtraUI(p);
            if (this.syncColorGradeUI) this.syncColorGradeUI(p);
            if (this.syncBwUI) this.syncBwUI(p);
            if (this.syncToneExtraUI) this.syncToneExtraUI(p);
            // 参数被程序化改掉（撤销/切图/套预设/重置）时，「使用中」标记也要跟上。
            if (this._scheduleGradePresetActive) this._scheduleGradePresetActive();
            // 当前图是不是 RAW 决定「RAW 显影」这一组的显隐与状态，切图时必须同步。
            if (this.syncRawUI) this.syncRawUI();
            // 顶部的直方图取的就是这次烘焙出来的预览；分组「动过没动过」也在这里标。
            if (window.QfsHistogram) window.QfsHistogram.refresh(this.image);
            // 溢出警示与直方图同一份烘焙结果、同一档节流：拖滑块时红蓝块跟着走
            if (window.QfsClip) window.QfsClip.refresh(this.image);
            this.syncGradeSections(p);
            // 带出蒙版（草稿还原/切回照片）时自动展开蒙版组，别让列表藏在折叠里
            if (window.QfsPanelDensity) window.QfsPanelDensity.syncMasks(this.image);
        },

        // 亮 / 颜色 / 效果 三段的「已改」标记：标了才常驻显示复位按钮。
        // 只认自己那几档，锐化/曲线/混色器各自有组，不掺进来。
        syncGradeSections(p) {
            const wrap = document.getElementById('grpGrade');
            if (!wrap) return;
            // 晕影 / 颗粒并入「效果」后，它们挂在模板的 lightEffect 上（不归 grade 管），
            // 所以这里要单独读一份，否则拖了晕影「效果」段还显示「没动过」、复位按钮不出现。
            const le = (this.template && this.template.lightEffect) || {};
            const on = {
                light: !!(p && (p.exp || p.con || p.hi || p.sh || p.white || p.black || p.gam)),
                color: !!(p && (p.temp || p.tint || p.vib || p.sat)),
                fx: !!(p && p.det && (p.det.tex || p.det.clar || p.det.dhz))
                    // 必须带 enable：84 个预设存着 enable:0 + 强度:35 的模板默认值，
                    // 只看强度会让整库预设一打开就亮着「已改」。
                    || (le.vignetteEnable === 1 && Math.abs(Number(le.vignetteStrength) || 0) > 0)
                    || (le.filmGrainEnable === 1 && Number(le.filmGrainIntensity) > 0)
            };
            const subs = wrap.querySelectorAll('.pg-sub');
            for (const el of subs) {
                const k = el.dataset.sub;
                if (k) el.classList.toggle('is-dirty', !!on[k]);
            }
        },

        // 单段复位：Camera Raw 每组标题右侧那个复位箭头。
        // 走同一条 setGrade，所以撤销、蒙版路由、草稿保存都跟手拖滑块完全一致。
        resetGradeSection(name) {
            const im = this.image;
            if (!im) return false;
            const p = this.gradeOf(im);
            if (name === 'fx') {
                const det = Object.assign({}, (p && p.det) || {});
                det.tex = 0;
                det.clar = 0;
                det.dhz = 0;
                // 晕影 / 颗粒也在「效果」段里：一起归零，并把滑块与标签同步回来。
                // 它们存在模板的 lightEffect 上、不经过 grade 的 normalizeGrade，
                // 所以必须手动写回 + 手动回填；否则下一次 collect() 会把滑块上的旧值又写回去。
                const le = Object.assign({}, this.template.lightEffect || {});
                le.vignetteStrength = 0;
                le.vignetteEnable = 0;
                le.vignetteFeather = 50;
                le.filmGrainIntensity = 0;
                le.filmGrainEnable = 0;
                this.template.lightEffect = le;
                const $ = (id) => document.getElementById(id);
                const vg = $('slVignetteStrength'), vf = $('slVignetteFeather'), fg = $('slFilmGrain');
                if (vg) vg.value = '0';
                if (vf) vf.value = '50';
                if (fg) fg.value = '0';
                if (this.updateLabel) {
                    this.updateLabel('lblVignetteStrength', '0');
                    this.updateLabel('lblVignetteFeather', '50');
                    this.updateLabel('lblFilmGrain', '0');
                }
                this.setGrade({ det });
            } else {
                const keys = name === 'light' ? ['exp', 'con', 'hi', 'sh', 'white', 'black', 'gam']
                    : name === 'color' ? ['temp', 'tint', 'vib', 'sat'] : null;
                if (!keys) return false;
                const patch = {};
                for (const k of keys) patch[k] = 0;
                this.setGrade(patch);
            }
            // 复位后「已改」标记要立刻收掉（效果段还包含模板上的晕影/颗粒）
            if (this.syncGradeSections) this.syncGradeSections(this.gradeOf(im));
            this.setStatus(name === 'light' ? '已复位「亮」' : name === 'color' ? '已复位「颜色」' : '已复位「效果」');
            return true;
        },

        initGrade() {
            const $ = (id) => document.getElementById(id);
            const ids = {
                exp: 'slGradeExp', con: 'slGradeCon', sat: 'slGradeSat', vib: 'slGradeVib',
                temp: 'slGradeTemp', tint: 'slGradeTint', hi: 'slGradeHi', sh: 'slGradeSh',
                white: 'slGradeWhite', black: 'slGradeBlack', gam: 'slGradeGam'
            };
            const sliders = {}, labels = {};
            let any = false;
            for (const f of GRADE_FIELDS) {
                const s = $(ids[f.k]);
                if (s) { sliders[f.k] = s; any = true; }
                labels[f.k] = $('lblGrade' + f.k.charAt(0).toUpperCase() + f.k.slice(1));
            }
            if (!any) return;
            this._gradeDom = { sliders, labels, wrap: $('grpGrade') };
            ensureFilter();

            let settle = 0;
            // 调色后胶片条缩略图还是旧样子,用户会以为"调了没变化"。
            // 缩略图是整帧重渲(走同一条管线),所以只在停手后做一次,不跟拖动抢帧。
            const syncThumb = () => {
                const im = this.image;
                if (!im || typeof this.renderFramedThumb !== 'function') return;
                clearTimeout(im._gradeThumbT);
                im._gradeThumbT = setTimeout(() => this.renderFramedThumb(im), 260);
            };
            // 一次拖动只压一次撤销快照：拖动开始时记下「拖动前」的状态，
            // 拖动过程中 input 只改参数不压栈，否则一次拖动能生成几十个撤销点。
            // 去重不靠「标记 + change 重置」那种易漏的时序（change 不一定触发，
            // 例如键盘方向键调完、或程序化设值），改成比对栈顶快照的内容：
            // 只要栈顶快照与当前状态完全一样，说明这次拖动已经压过了，不再重复压。
            const pushGradeUndoOnce = () => {
                if (!this.pushUndo) return;
                const top = this.undoStack && this.undoStack[this.undoStack.length - 1];
                if (top && this.sameUndoState(top)) return;
                this.pushUndo();
            };
            for (const f of GRADE_FIELDS) {
                const s = sliders[f.k];
                if (!s) continue;
                s.addEventListener('focus', pushGradeUndoOnce);
                s.addEventListener('input', () => {
                    // 拖动中只换降采样，别让每一次 input 都去烘焙 2400 万像素
                    pushGradeUndoOnce();
                    this.setGrade({ [f.k]: Number(s.value) || 0 });
                    clearTimeout(settle);
                    settle = setTimeout(() => { this.rebuildGrade('full'); syncThumb(); }, 220);
                });
                s.addEventListener('change', () => {
                    clearTimeout(settle);
                    // 同上：松手不立刻同步烘全分辨率，先让这一帧的低清结果画出去，
                    // 80ms 后再在空闲时补全。syncThumb 也跟着这个时机走。
                    this.setGrade({ [f.k]: Number(s.value) || 0 });
                    settle = setTimeout(() => { this.rebuildGrade('full'); syncThumb(); }, 80);
                });
            }
            const reset = $('btnGradeReset');
            if (reset) reset.addEventListener('click', () => this.resetGrade());

            // ── 白平衡吸管 ────────────────────────────────────────────────
            // QfsAcr.neutralize 一直在（自动调色在用），但用户没有入口，只能靠
            // 眼睛猜色温。这里把它接成一次点击：点画面里的中性色，反解 temp/tint。
            const wbBtn = $('btnWbPick');
            if (wbBtn) {
                const pane = $('canvasPane');
                const setWb = (on) => {
                    this._wbPick = !!on;
                    wbBtn.classList.toggle('active', !!on);
                    wbBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
                    if (pane) pane.classList.toggle('wb-picking', !!on);
                    if (on) {
                        // 三套取色互斥：同时开着会抢同一个画布按下事件
                        if (this._mixPick && this._mixPick.setOn) this._mixPick.setOn(false);
                        if (this._pc && this._pc.setOn) this._pc.setOn(false);
                        this.setStatus('白平衡吸管：点一下画面里的中性色（灰墙 / 白纸 / 阴天天空）；再点「吸管」或 Esc 退出');
                    }
                };
                this._wbPickSetOn = setWb;
                wbBtn.addEventListener('click', (e) => { e.stopPropagation(); setWb(!this._wbPick); });
                // 必须挂在 document 的捕获段：画布自身的 mousedown（选中/拖动元素）
                // 是先注册的，挂在同一元素上即便 stopPropagation 也拦不住它。
                document.addEventListener('mousedown', (e) => {
                    if (!this._wbPick || e.button !== 0) return;
                    const t = e.target;
                    if (t !== this.dom.canvas && t !== this.dom.maskOverlay) return;
                    e.preventDefault(); e.stopPropagation();
                    this._pickWbAt(e);
                }, true);
                document.addEventListener('keydown', (e) => {
                    if (this._wbPick && e.key === 'Escape') {
                        setWb(false);
                        this.setStatus('已退出白平衡吸管');
                    }
                });
            }
            // 亮 / 颜色 / 效果：点标题收起，点右侧「复位」只清本段
            const subs = document.querySelectorAll('#grpGrade .pg-sub');
            for (const sub of subs) {
                const head = sub.querySelector('.pg-sub-head');
                if (!head) continue;
                head.addEventListener('click', (e) => {
                    if (e.target.closest('.pg-sub-reset') || e.target.closest('.pg-sub-tool')) return;
                    sub.classList.toggle('collapsed');
                    head.setAttribute('aria-expanded', sub.classList.contains('collapsed') ? 'false' : 'true');
                });
                head.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    head.click();
                });
                const btn = sub.querySelector('.pg-sub-reset');
                if (btn) {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.resetGradeSection(sub.dataset.sub);
                    });
                }
            }
            // 类 LR 参数导航：展开目标并滚到它。刻意不做互斥子页签——
            // 调色常常要同时看曝光与白平衡，其它组必须保持原样。
            const jump = $('gradeJump');
            if (jump) {
                jump.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-jump]');
                    if (!btn) return;
                    const key = btn.dataset.jump;
                    let target = null;
                    if (key === 'light' || key === 'color' || key === 'fx') {
                        // 旧偏好里整个「调色」组可能还是折叠的：只展开子组的话它仍不可见。
                        const parent = $('grpGrade');
                        if (parent && parent.classList.contains('collapsed')) {
                            parent.classList.remove('collapsed');
                            if (window.QfsPanelDensity && window.QfsPanelDensity.onFoldChange) {
                                window.QfsPanelDensity.onFoldChange(parent);
                            }
                        }
                        target = document.querySelector('#grpGrade .pg-sub[data-sub="' + key + '"]');
                        if (target) {
                            target.classList.remove('collapsed');
                            const head = target.querySelector('.pg-sub-head');
                            if (head) head.setAttribute('aria-expanded', 'true');
                        }
                    } else {
                        target = $(key);
                        if (target && target.classList.contains('param-group')) {
                            target.classList.remove('collapsed');
                            if (window.QfsPanelDensity && window.QfsPanelDensity.onFoldChange) {
                                window.QfsPanelDensity.onFoldChange(target);
                            }
                        }
                    }
                    if (!target) return;
                    const body = document.querySelector('#inspector .insp-body');
                    if (!body) return;
                    const tr = target.getBoundingClientRect();
                    const br = body.getBoundingClientRect();
                    body.scrollTop += (tr.top - br.top) - 8;
                });
            }
            // 轨道零点标记：按 defaultValue 算出默认档在轨道上的位置，
            // 写进行上的 --zero，CSS 画一枚小三角（排除色相/混色器等特殊轨道）。
            document.querySelectorAll('#panel-grade .param-row > input[type=range]').forEach((inp) => {
                if (inp.classList.contains('ctl-hue') || inp.classList.contains('rng-cb') || inp.classList.contains('rng-mix')) return;
                const mn = parseFloat(inp.min), mx = parseFloat(inp.max), dv = parseFloat(inp.defaultValue);
                if (!isFinite(mn) || !isFinite(mx) || !isFinite(dv) || mx <= mn) return;
                const row = inp.parentElement;
                if (!row) return;
                row.classList.add('has-zero');
                row.style.setProperty('--zero', Math.max(0, Math.min(1, (dv - mn) / (mx - mn))));
            });
            const all = $('btnGradeApplyAll');
            if (all) all.addEventListener('click', () => this.applyGradeToAll());
            const auto = $('btnGradeAuto');
            if (auto) auto.addEventListener('click', () => this.autoGrade());
            const some = $('btnGradeApplySelected');
            if (some) some.addEventListener('click', () => this.applyGradeToSelected());
            const cp = $('btnGradeCopySet');
            if (cp) cp.addEventListener('click', () => this.copySettings());
            const ps = $('btnGradePasteSet');
            if (ps) ps.addEventListener('click', () => this.pasteSettings());
            // 调色操作收进标题右侧：⋯ 菜单负责应用到全部 / 应用到选中 /
            // 复制 / 粘贴 / 导入 LR。
            // 标题本身是折叠开关，所以按钮区先拦掉冒泡，避免点操作时把整组收起。
            const titleActs = $('gradeTitleActions');
            if (titleActs) titleActs.addEventListener('click', (e) => e.stopPropagation());
            const moreBtn = $('btnGradeMore');
            const moreMenu = $('gradeMoreMenu');
            if (moreBtn && moreMenu) {
                const closeMore = () => {
                    moreMenu.hidden = true;
                    moreBtn.setAttribute('aria-expanded', 'false');
                };
                moreBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const open = moreMenu.hidden;
                    moreMenu.hidden = !open;
                    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
                });
                moreMenu.addEventListener('click', (e) => {
                    if (e.target.closest('button')) closeMore();
                });
                document.addEventListener('click', (e) => {
                    if (!e.target.closest('#gradeMoreWrap')) closeMore();
                });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') closeMore();
                });
            }
            if (this.initCurve) this.initCurve();
            if (this.initGradeExtra) this.initGradeExtra();
            if (this.initColorGrade) this.initColorGrade();
            if (this.initBw) this.initBw();
            if (this.initToneExtra) this.initToneExtra();
            if (this.initMasks) this.initMasks();
            this.syncGradeUI();
            // ACR 实测色表必须在启动时就加载。此前只有「导入 XMP 预设」会调 ensure()，
            // 普通用户永远拿不到表：toneStages 退回兜底公式（还能看出变化），
            // 而混色器 / 校准 / 饱和度 / 自然饱和度 / 颜色分级走的是 colorLut，
            // 表没就绪直接返回 null —— 表现就是「这些档位拖了完全没反应」。
            this.ensureAcrTables();
        },

        // 色表 / WebGL 降级不写状态栏长句：直方图脚注给一枚小 chip，
        // 具体原因放 title，既不丢信息，也不把画布尺寸挤出视野。
        setEnvTag(text, title) {
            const tag = document.getElementById('gradeEnvTag');
            if (!tag) return;
            tag.textContent = text || '';
            tag.title = title || '';
            tag.hidden = !text;
            tag.className = 'histo-raw histo-env';
        },

        // 空闲时加载色表（1.8MB，不阻塞启动）；加载完把当前图按真实表重烘一遍，
        // 否则之前用兜底公式算出来的结果会一直挂到下次参数变化才更新。
        ensureAcrTables() {
            const A = window.QfsAcr;
            if (!A || typeof A.ensure !== 'function') return;
            const load = () => {
                A.ensure().then((ok) => {
                    if (!ok) {
                        this.setEnvTag('简化调色', '调色色表未加载：混色器 / 校准 / 饱和度等档位会按简化公式计算');
                        return;
                    }
                    // GL 不可用时三维表用不上（bakeOne 里 useLut 依赖 usingGL），
                    // 校准与饱和度会退回简化算法 —— 机器上看着就是"拖了没反应"，
                    // 说清楚比让用户以为坏了好。
                    const glOk = !!(window.QfsColor && window.QfsColor.usingGL && window.QfsColor.usingGL());
                    this.setEnvTag(glOk ? '' : '简化调色',
                        glOk ? '' : '当前环境未启用 WebGL：校准 / 饱和度等档位会降级计算');
                    if (this.image && this.invalidateGrade && this.rebuildGrade) {
                        this.invalidateGrade(this.image);
                        this.rebuildGrade('full');
                        if (this.scheduleRender) this.scheduleRender(true);
                    }
                }).catch(() => {
                    // 色表缺失不阻塞使用，但要让用户知道当前是简化路径。
                    this.setEnvTag('简化调色', '调色色表加载失败：混色器 / 校准 / 饱和度等档位会按简化公式计算');
                });
            };
            if (typeof requestIdleCallback === 'function') requestIdleCallback(load, { timeout: 2000 });
            else setTimeout(load, 800);
        }
    });
})();

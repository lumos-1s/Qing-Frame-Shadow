/* ═══════════════════════════════════════════════════════════════
   LR XMP 调色预设导入 / 导出
   解析 Lightroom / Camera Raw 导出的 .xmp，把 crs: 命名空间的调色
   参数映射到清框影的 grade 对象（对齐 app-grade.js 的
   GRADE_FIELDS / DET_FIELDS / CAL_FIELDS / MIX_BANDS / curve / cg）。
   反向的 gradeToXmp 会写一份 LR 能识别的标准字段，并额外附上清框影
   自己的完整参数（qf:QfsGrade），让色彩平衡、渐变映射、色阶中间调
   这些 LR 没有的字段也能在本应用内完整往返。

   几个关键对齐（旧版最容易「大相径庭」的地方）：
   - Exposure2012 是 EV，不是 -100..100 的滑块；直接存 EV。
   - Temperature 是绝对 Kelvin。清框影的色温是相对值，所以以 5500K
     为基准、按 mired 差换算；WhiteBalance=As Shot/Auto 时不套用参考
     照片的绝对色温（否则整张会偏到一边）。
   - 真实 LR 预设大量使用 ParametricShadows/Darks/Lights/Highlights
     和 SplitToning/ColorGrade，而不是 ToneCurvePV2012；这些都要生成
     曲线/颜色分级，否则会丢掉预设最重要的风格。
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const NUM = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const round2 = (v) => Math.round(v * 100) / 100;

    // 相对色温基准。XMP 里的 Temperature 是**绝对开尔文**（针对 RAW 的 as-shot），
    // 而落到 JPEG 上时 Camera Raw 用的是 −100..100 的相对刻度。
    // 这个基准按 PS 的实际显示反推：同一份「001-滨田英明」预设里 Temperature=4769，
    // 在 PS（DSC09381.jpg，白平衡=自定）里色温滑块显示 −4；用 4900K 作基准算出来正是
    // −4.2 → −4。早期用 5500K 会算成 −21，整张偏冷偏绿，黄叶变柠檬色。
    // 用 mired（1e6/K）差而不是 Kelvin 差，短波端不会被压成一团。
    const WB_REF_K = 4900;
    const WB_MIRED_SCALE = 0.75;

    function kelvinToTemp(v) {
        if (!(v >= 1000)) return Math.round(clamp(v, -100, 100)); // 兼容非标准相对值
        const mired = 1e6 / v;
        const ref = 1e6 / WB_REF_K;
        return Math.round(clamp(-(mired - ref) * WB_MIRED_SCALE, -100, 100));
    }

    // 反向换算：清框影的相对色温 → LR 的绝对开尔文。与 kelvinToTemp 互逆，
    // 导入再导出能回到同一档（个位数的取整误差来自 mired 尺度，属预期）。
    function tempToKelvin(v) {
        const temp = clamp(NUM(v, 0), -100, 100);
        const ref = 1e6 / WB_REF_K;
        const mired = ref - temp / WB_MIRED_SCALE;
        return Math.round(clamp(1e6 / mired, 2000, 50000));
    }

    // ── 基础档：LR 值域多为 -100~100；Exposure2012 是 EV（±5 典型） ──
    // alt = 老 Process Version 的字段名；2012 版优先。
    const BASE = [
        { xmp: 'Exposure2012', alt: 'Exposure', key: 'exp', note: '曝光', ev: true },
        { xmp: 'Contrast2012', alt: 'Contrast', key: 'con', note: '对比度' },
        { xmp: 'Saturation', key: 'sat', note: '饱和度' },
        { xmp: 'Vibrance', key: 'vib', note: '自然饱和度' },
        { xmp: 'Highlights2012', alt: 'Highlights', key: 'hi', note: '高光' },
        { xmp: 'Shadows2012', alt: 'Shadows', key: 'sh', note: '阴影' },
        { xmp: 'Whites2012', alt: 'Whites', key: 'white', note: '白色' },
        { xmp: 'Blacks2012', alt: 'Blacks', key: 'black', note: '黑色' }
    ];

    // ── 细节（LR 的「细节」面板） ──
    const DET = [
        { xmp: 'Clarity2012', alt: 'Clarity', key: 'clar', note: '清晰度' },
        { xmp: 'Texture', key: 'tex', note: '纹理' },
        { xmp: 'Dehaze', key: 'dhz', note: '去除薄雾' }
    ];

    // ── 锐化（LR「细节」面板上半组 = 捕获锐化） ──
    // 关键坑：Lightroom 写 XMP 时**省略等于默认值的字段**。这份预设里
    // SharpenAmount 整个不存在，而 SharpenRadius=0.5 / Detail=60 / Masking=34
    // 都在 —— 因为 40 正是 LR 的默认锐化量。把缺失当成 0 就等于不锐化，
    // 和 LR 导出差一截，所以缺的字段一律按 LR 默认补：40 / 1.0 / 25 / 0。
    const SHARPEN = [
        { xmp: 'SharpenAmount', key: 'shp', min: 0, max: 150, dft: 40, note: '锐化量' },
        { xmp: 'SharpenRadius', key: 'shr', min: 0.3, max: 3, dft: 1, step: 0.1, note: '锐化半径' },
        { xmp: 'SharpenDetail', key: 'shd', min: 0, max: 100, dft: 25, note: '锐化细节' },
        { xmp: 'SharpenEdgeMasking', key: 'shm', min: 0, max: 100, dft: 0, note: '锐化蒙版' }
    ];

    // ── 校准（LR 相机校准，命名空间同为 crs:） ──
    const CAL = [
        { xmp: 'RedHue', key: 'rh', note: '红·色相' },
        { xmp: 'RedSaturation', key: 'rs', note: '红·饱和' },
        { xmp: 'GreenHue', key: 'gh', note: '绿·色相' },
        { xmp: 'GreenSaturation', key: 'gs', note: '绿·饱和' },
        { xmp: 'BlueHue', key: 'bh', note: '蓝·色相' },
        { xmp: 'BlueSaturation', key: 'bs', note: '蓝·饱和' }
    ];

    // ── 混色器：LR 的 8 色带与清框影 MIX_BANDS 完全对齐 ──
    const MIX_COLORS = [
        { xmp: 'Red', key: 'r', label: '红' }, { xmp: 'Orange', key: 'o', label: '橙' },
        { xmp: 'Yellow', key: 'y', label: '黄' }, { xmp: 'Green', key: 'g', label: '绿' },
        { xmp: 'Aqua', key: 'a', label: '青' }, { xmp: 'Blue', key: 'b', label: '蓝' },
        { xmp: 'Purple', key: 'p', label: '紫' }, { xmp: 'Magenta', key: 'm', label: '品红' }
    ];
    const MIX_CH = [
        { xmp: 'HueAdjustment', key: 'h' },
        { xmp: 'SaturationAdjustment', key: 's' },
        { xmp: 'LuminanceAdjustment', key: 'l' }
    ];

    // ── 黑白混色器：LR 的 GrayMixer，只在 ConvertToGrayscale 为真时生效 ──
    const BW_FIELDS = [
        { xmp: 'GrayMixerRed', key: 'r' }, { xmp: 'GrayMixerOrange', key: 'o' },
        { xmp: 'GrayMixerYellow', key: 'y' }, { xmp: 'GrayMixerGreen', key: 'g' },
        { xmp: 'GrayMixerAqua', key: 'a' }, { xmp: 'GrayMixerBlue', key: 'b' },
        { xmp: 'GrayMixerPurple', key: 'p' }, { xmp: 'GrayMixerMagenta', key: 'm' }
    ];

    // 常见但软件没有对应参数的 LR 字段（进 skipped，不硬塞）
    // 注意 Sharpen* 已经不在这里：它们映射到 det.shp/shr/shd/shm（见 SHARPEN）。
    const SKIP = ['Sharpness', 'NoiseReductionLuminance', 'NoiseReductionColor',
        'NoiseReductionDetail', 'LuminanceSmoothing', 'ColorNoiseReduction',
        'PostCropVignetteAmount', 'PostCropVignetteMidpoint', 'PostCropVignetteFeather',
        'PostCropVignetteRoundness', 'PostCropVignetteStyle', 'PostCropVignetteHighlightContrast',
        'GrainAmount', 'LensProfileEnable',
        'PerspectiveUpright', 'CameraProfile', 'CameraProfileDigest', 'HasSettings', 'HasCrop',
        'AlreadyApplied', 'RawFileName', 'Version', 'ProcessVersion', 'AutoLateralCA',
        'DefringePurpleAmount', 'DefringePurpleHueLo', 'DefringePurpleHueHi',
        'DefringeGreenAmount', 'DefringeGreenHueLo', 'DefringeGreenHueHi',
        'VignetteAmount', 'ShadowTint', 'ToneCurveName', 'ToneCurveName2012',
        'OverrideLookVignette'];

    // ── 收集 rdf:Description 节点上的「带前缀属性」：名称(local) → 值 ──
    function collectAttrs(desc) {
        const out = {};
        if (!desc || !desc.attributes) return out;
        for (let i = 0; i < desc.attributes.length; i++) {
            const a = desc.attributes[i];
            const nm = a.name || '';
            if (nm === 'xmlns' || nm.indexOf('xmlns:') === 0) continue;
            const colon = nm.indexOf(':');
            const local = colon >= 0 ? nm.slice(colon + 1) : nm;
            if (!local) continue;
            out[local] = a.value;
        }
        return out;
    }

    // ── 解析 .xmp 文本 → { values, found } ──
    function parseXmp(text) {
        const values = {}, found = [];
        if (!text || !text.indexOf) return { values, found };
        let doc = null;
        try {
            doc = new DOMParser().parseFromString(text, 'text/xml');
        } catch (e) { doc = null; }
        // 遍历全部元素找 localName 为 Description 的节点（兼容任意前缀）
        let descs = [];
        if (doc && !doc.getElementsByTagName('parsererror').length) {
            const all = doc.getElementsByTagName('*');
            for (let i = 0; i < all.length; i++) {
                const el = all[i];
                const ln = el.localName || el.tagName || '';
                if (ln === 'Description') descs.push(el);
            }
        }
        if (descs.length) {
            descs.forEach((d) => {
                const attrs = collectAttrs(d);
                Object.keys(attrs).forEach((k) => { if (!(k in values)) { values[k] = attrs[k]; found.push(k); } });
                const kids = d.children || [];
                for (let i = 0; i < kids.length; i++) {
                    const c = kids[i];
                    let ln = c.localName || c.tagName || '';
                    if (ln.indexOf(':') >= 0) ln = ln.slice(ln.indexOf(':') + 1);
                    if (!ln || (ln in values)) continue;
                    // 曲线等 rdf:Seq 子节点：把 li 的文本用逗号接起来，兼容
                    // 非标准/旧版把点坐标写成子元素的 XMP。
                    const lis = c.getElementsByTagName ? c.getElementsByTagName('li') : [];
                    let t = '';
                    if (lis && lis.length) {
                        const arr = [];
                        for (let j = 0; j < lis.length; j++) arr.push((lis[j].textContent || '').trim());
                        t = arr.join(',');
                    } else {
                        t = (c.textContent || '').trim();
                    }
                    if (t) { values[ln] = t; found.push(ln); }
                }
            });
            return { values, found };
        }
        // 正则兜底（宽松/非标准 xmp）：crs:xxx="..." 或 <crs:xxx>...</crs:xxx>
        const re = /(?:crs|cr|rdf):([\w-]+)\s*=\s*"([^"]*)"/g;
        let m;
        while ((m = re.exec(text))) { if (!(m[1] in values)) { values[m[1]] = m[2]; found.push(m[1]); } }
        const re2 = /<(?:crs|cr|rdf):([\w-]+)>([^<]*)<\//g;
        while ((m = re2.exec(text))) { if (!(m[1] in values)) { values[m[1]] = m[2].trim(); found.push(m[1]); } }
        return { values, found };
    }

    function rawOf(values, f) {
        let v = values[f.xmp];
        if ((v === undefined || v === null || v === '') && f.alt) v = values[f.alt];
        return v;
    }

    // ── LR 曲线点 "0,0, 32,22, ..."（0-255 坐标）→ 清框影 [[x,y]]（0-1） ──
    function parseCurve(str) {
        const nums = String(str).split(/[,\s]+/).map((x) => parseFloat(x)).filter((n) => Number.isFinite(n));
        if (nums.length < 4 || nums.length % 2) return null;
        const pts = [];
        for (let i = 0; i < nums.length; i += 2) {
            const x = clamp(nums[i] / 255, 0, 1), y = clamp(nums[i + 1] / 255, 0, 1);
            if (pts.length && Math.abs(x - pts[pts.length - 1][0]) < 0.005) {
                pts[pts.length - 1][1] = y;
            } else {
                pts.push([x, y]);
            }
        }
        return pts.length >= 2 ? pts : null;
    }

    function isIdentityCurve(pts) {
        if (!pts || pts.length < 2) return true;
        const a = pts[0], b = pts[pts.length - 1];
        if (Math.abs(a[0]) > 0.005 || Math.abs(a[1]) > 0.005) return false;
        if (Math.abs(b[0] - 1) > 0.005 || Math.abs(b[1] - 1) > 0.005) return false;
        // 中间点也必须落在 y=x 上，才算是“没动过的曲线”
        for (const p of pts) if (Math.abs(p[0] - p[1]) > 0.005) return false;
        return true;
    }

    // 点曲线不做采样/复合：原始控制点直接交给 app-curve.js 的单调三次插值。

    // LR 的「参数曲线」：4 个区域滑块 + 3 个分割点。真实预设里几乎全是
    // 这种曲线（ToneCurvePV2012 常常是空节点）。把每个区域滑块的权重放在
    // 区域中心，相邻中心之间用 smoothstep 过渡；这样纯黑只吃「阴影」、
    // 纯白只吃「高光」，Darks +50 不会把黑点一起抬起来。生成的控制点再
    // 交给 app-curve.js 的单调三次插值。
    function parametricCurve(values) {
        const amp = (k) => clamp(NUM(values[k], 0), -100, 100) / 100;
        const sh = amp('ParametricShadows'), dk = amp('ParametricDarks');
        const lt = amp('ParametricLights'), hi = amp('ParametricHighlights');
        if (!sh && !dk && !lt && !hi) return null;
        // 有 ACR 实测表时用实测对角线（公式换算的 A=0.24 在真实预设上偏强）
        const ACR = window.QfsAcr;
        if (ACR && ACR.ready()) {
            const pts = ACR.parametricDiag(sh * 100, dk * 100, lt * 100, hi * 100);
            if (pts) return pts;
        }
        let ss = clamp(NUM(values.ParametricShadowSplit, 25), 0, 100) / 100;
        let ms = clamp(NUM(values.ParametricMidtoneSplit, 50), 0, 100) / 100;
        let hs = clamp(NUM(values.ParametricHighlightSplit, 75), 0, 100) / 100;
        if (ms <= ss) ms = Math.min(0.99, ss + 0.04);
        if (hs <= ms) hs = Math.min(0.999, ms + 0.04);
        // 区域中心；必须严格递增，否则下面的线性查找会除零。
        const c1 = clamp((ss + ms) / 2, 0.02, 0.96);
        const c2 = clamp((ms + hs) / 2, c1 + 0.02, 0.98);
        const centers = [0, c1, c2, 1];
        const amps = [sh, dk, lt, hi];
        const A = 0.24;
        const pts = [];
        let prev = 0;
        for (let i = 0; i <= 16; i++) {
            const x = i / 16;
            let off;
            if (x <= centers[0]) off = amps[0];
            else if (x >= centers[3]) off = amps[3];
            else {
                let j = 0;
                while (j < 2 && x > centers[j + 1]) j++;
                const a = centers[j], b = centers[j + 1];
                let t = (x - a) / Math.max(1e-6, b - a);
                t = t * t * (3 - 2 * t);
                off = amps[j] * (1 - t) + amps[j + 1] * t;
            }
            let y = clamp(x + A * off, 0, 1);
            // 参数曲线本身是单调的；避免相邻区域一正一负时出现反转。
            if (y < prev) y = prev;
            prev = y;
            pts.push([round2(x), round2(y)]);
        }
        return pts;
    }

    function readColorGrade(values) {
        const pick = (k, d) => NUM(values[k], d);
        const hasModern = values.ColorGradeShadowHue !== undefined ||
            values.ColorGradeShadowSat !== undefined ||
            values.ColorGradeShadowLum !== undefined ||
            values.ColorGradeMidtoneHue !== undefined ||
            values.ColorGradeMidtoneSat !== undefined ||
            values.ColorGradeMidtoneLum !== undefined ||
            values.ColorGradeHighlightHue !== undefined ||
            values.ColorGradeHighlightSat !== undefined ||
            values.ColorGradeHighlightLum !== undefined ||
            values.ColorGradeGlobalHue !== undefined ||
            values.ColorGradeGlobalSat !== undefined ||
            values.ColorGradeGlobalLum !== undefined;
        if (hasModern) {
            const cg = {
                shadow: { h: pick('ColorGradeShadowHue', 0), s: pick('ColorGradeShadowSat', 0), l: pick('ColorGradeShadowLum', 0) },
                mid: { h: pick('ColorGradeMidtoneHue', 0), s: pick('ColorGradeMidtoneSat', 0), l: pick('ColorGradeMidtoneLum', 0) },
                high: { h: pick('ColorGradeHighlightHue', 0), s: pick('ColorGradeHighlightSat', 0), l: pick('ColorGradeHighlightLum', 0) },
                global: { h: pick('ColorGradeGlobalHue', 0), s: pick('ColorGradeGlobalSat', 0), l: pick('ColorGradeGlobalLum', 0) },
                blending: pick('ColorGradeBlending', 50),
                balance: pick('ColorGradeBalance', 0)
            };
            return { cg, note: '颜色分级' };
        }
        const hasSplit = values.SplitToningShadowHue !== undefined ||
            values.SplitToningShadowSaturation !== undefined ||
            values.SplitToningHighlightHue !== undefined ||
            values.SplitToningHighlightSaturation !== undefined;
        if (!hasSplit) return null;
        // 旧版 SplitToning 只有阴影/高光两个色相+饱和，映射到颜色分级
        // 的对应区域；中间调/全局留空，Blending 用 LR 默认 50。
        return {
            cg: {
                shadow: {
                    h: pick('SplitToningShadowHue', 0),
                    s: pick('SplitToningShadowSaturation', 0),
                    l: 0
                },
                mid: { h: 0, s: 0, l: 0 },
                high: {
                    h: pick('SplitToningHighlightHue', 0),
                    s: pick('SplitToningHighlightSaturation', 0),
                    l: 0
                },
                global: { h: 0, s: 0, l: 0 },
                blending: 50,
                balance: pick('SplitToningBalance', 0)
            },
            note: '分离色调'
        };
    }

    // 清框影自己写出的完整参数（base64 JSON）。有它就优先用，
    // 保证色彩平衡 / 渐变映射 / 色阶中间调 / 蒙版外全部字段原样回来。
    function readQfGrade(values) {
        const raw = values && values.QfsGrade;
        if (!raw) return null;
        try {
            const bin = String(raw).replace(/\s+/g, '');
            let json = '';
            if (window.App && typeof window.App._b64ToJson === 'function') {
                json = window.App._b64ToJson(bin);
            } else {
                const bytes = Uint8Array.from(atob(bin), (c) => c.charCodeAt(0));
                json = new TextDecoder().decode(bytes);
            }
            const data = JSON.parse(json);
            if (data && data.grade && typeof data.grade === 'object') return data;
        } catch (_) { /* 损坏的私有段按没有处理，继续走标准字段 */ }
        return null;
    }

    // ── 主入口：文本 → { patch, applied[], skipped[], hasAdjust } ──
    function mapXmp(text) {
        const { values, found } = parseXmp(text);
        const qf = readQfGrade(values);
        if (qf) {
            return {
                patch: qf.grade,
                applied: ['清框影完整调色'],
                skipped: [],
                hasAdjust: true,
                qf: true,
                name: String(qf.name || '')
            };
        }
        const patch = {};
        const applied = [];
        const skipped = [];
        const push = (list, s) => { if (s && list.indexOf(s) < 0) list.push(s); };

        // 基础档
        BASE.forEach((f) => {
            const raw = rawOf(values, f);
            if (raw === undefined || raw === null || raw === '') return;
            const v = NUM(raw, NaN);
            if (!Number.isFinite(v)) { push(skipped, f.note + '(' + f.xmp + ')'); return; }
            patch[f.key] = f.ev ? round2(clamp(v, -5, 5)) : Math.round(clamp(v, -100, 100));
            push(applied, f.note);
        });

        // 白平衡：只有 Custom（或没有明确写 As Shot/Auto）才套用绝对 Kelvin。
        // As Shot 预设里的 Temperature 是「制作预设那张照片的现场色温」，
        // 套到别的照片上会整张偏色；Lightroom 自己也会跟随新照片的 As Shot。
        const wb = String(values.WhiteBalance || '').trim().toLowerCase();
        if (values.Temperature !== undefined || values.Tint !== undefined) {
            if (wb === 'as shot' || wb === 'auto') {
                push(skipped, '色温/色调（' + values.WhiteBalance + '，随照片）');
            } else {
                if (values.Temperature !== undefined) {
                    const t = NUM(values.Temperature, NaN);
                    if (Number.isFinite(t)) {
                        patch.temp = kelvinToTemp(t);
                        push(applied, '色温(' + Math.round(t) + 'K→' + patch.temp + ')');
                    }
                }
                if (values.Tint !== undefined) {
                    const t = NUM(values.Tint, NaN);
                    if (Number.isFinite(t)) {
                        patch.tint = Math.round(clamp(t, -100, 100));
                        push(applied, '色调');
                    }
                }
            }
        }

        // 黑白：走真正的黑白混色器（8 色相带各自调亮调暗），不再用「饱和度 −100」糊过去。
        // GrayMixer* 只在 ConvertToGrayscale 为真时生效（LR 也是这个规则）。
        if (String(values.ConvertToGrayscale || '').toLowerCase() === 'true') {
            const bw = { on: 1 };
            let anyMix = false;
            for (const f of BW_FIELDS) {
                const v = NUM(values[f.xmp], NaN);
                if (!Number.isFinite(v)) continue;
                bw[f.key] = Math.round(clamp(v, -100, 100));
                if (bw[f.key]) anyMix = true;
            }
            patch.bw = bw;
            delete patch.vib;   // 黑白下自然饱和度没意义
            push(applied, anyMix ? '黑白（含混色器）' : '黑白');
        }

        // 细节
        const det = {};
        DET.forEach((f) => {
            const raw = rawOf(values, f);
            if (raw === undefined || raw === null || raw === '') return;
            const v = NUM(raw, NaN);
            if (!Number.isFinite(v)) return;
            det[f.key] = Math.round(clamp(v, -100, 100));
            push(applied, f.note);
        });

        // 锐化（捕获锐化）。只在预设里确实出现任一 Sharpen* 时才动手：
        // 纯调色预设（一个 Sharpen 字段都没有）在 LR 里也不改锐化，这里同样不动，
        // 免得导入一个黑白预设把整张照片悄悄锐化一遍。
        // 出现了就按 LR 的默认值补齐缺省项 —— LR 会省略等于默认值的字段，
        // 这份预设正是 SharpenAmount 缺席（= 默认 40）而 Radius/Detail/Masking 在场。
        const shpKeys = SHARPEN.filter((f) => {
            const raw = values[f.xmp];
            return !(raw === undefined || raw === null || raw === '');
        });
        if (shpKeys.length) {
            const implied = [];
            for (const f of SHARPEN) {
                const raw = values[f.xmp];
                const has = !(raw === undefined || raw === null || raw === '');
                const v = has ? NUM(raw, NaN) : NaN;
                if (!has) implied.push(f.note);
                const val = Number.isFinite(v) ? v : f.dft;
                const cl = clamp(val, f.min, f.max);
                det[f.key] = f.step ? Math.round(cl / f.step) * f.step : Math.round(cl);
            }
            push(applied, '锐化 ' + det.shp + '/' + det.shr.toFixed(1)
                + (implied.length ? '（' + implied.join('、') + '按 LR 默认）' : ''));
        }
        if (Object.keys(det).length) patch.det = det;

        // 校准
        const cal = {};
        CAL.forEach((f) => {
            const raw = values[f.xmp];
            if (raw === undefined || raw === null || raw === '') return;
            const v = NUM(raw, NaN);
            if (!Number.isFinite(v)) return;
            cal[f.key] = Math.round(clamp(v, -100, 100));
            push(applied, f.note);
        });
        if (Object.keys(cal).length) patch.cal = cal;

        // 混色器
        const mix = {};
        MIX_COLORS.forEach((c) => {
            let any = false;
            const cell = {};
            MIX_CH.forEach((ch) => {
                const raw = values[ch.xmp + c.xmp];
                if (raw === undefined || raw === null || raw === '') return;
                const v = NUM(raw, NaN);
                if (!Number.isFinite(v)) return;
                cell[ch.key] = Math.round(clamp(v, -100, 100));
                any = true;
            });
            if (any) { mix[c.key] = cell; push(applied, c.label + '色HSL'); }
        });
        if (Object.keys(mix).length) patch.mix = mix;

        // 曲线：点曲线（如果有）+ 参数曲线（绝大多数真实预设）。
        const curve = {};
        const CURVE = [
            { xmp: 'ToneCurvePV2012', key: 'rgb' },
            { xmp: 'ToneCurvePV2012Red', key: 'r' },
            { xmp: 'ToneCurvePV2012Green', key: 'g' },
            { xmp: 'ToneCurvePV2012Blue', key: 'b' }
        ];
        CURVE.forEach((c) => {
            const raw = values[c.xmp];
            if (raw === undefined || raw === null || raw === '') return;
            const pts = parseCurve(raw);
            if (pts && !isIdentityCurve(pts)) {
                curve[c.key] = pts;
                push(applied, c.key === 'rgb' ? '主曲线' : c.key.toUpperCase() + '曲线');
            } else if (!pts) {
                push(skipped, c.xmp + '(曲线)');
            }
        });
        const paramPts = parametricCurve(values);
        if (paramPts) {
            // ACR/LR 的曲线面板是「参数 / 点」两个页签，同一时刻只有一条曲线生效。
            // XMP 里两条都会留着（另存预设时不会清空另一页），但只要存在非线性的点曲线，
            // 渲染就只认点曲线——参数滑杆的值是失效残留。之前这里把两者复合，
            // 等于给整张图多叠了一层提亮：25% 分位被抬 +20 级、饱和度掉 6 个点。
            if (curve.rgb) {
                push(skipped, '参数曲线(已有主曲线)');
            } else {
                curve.rgb = paramPts;
                push(applied, '参数曲线');
            }
        }
        if (Object.keys(curve).length) patch.curve = curve;

        // 颜色分级：现代 ColorGrade* 优先，旧版 SplitToning* 兜底。
        const cgInfo = readColorGrade(values);
        if (cgInfo) {
            patch.cg = cgInfo.cg;
            push(applied, cgInfo.note);
        }

        // 镜头畸变：LR 的 LensManualDistortionAmount（−100..100，正 = 校正桶形）。
        // 我们的 distort 语义与它同向，直接照搬数值。
        const dist = NUM(values.LensManualDistortionAmount, NaN);
        if (Number.isFinite(dist) && Math.round(dist) !== 0) {
            patch.lc = { distort: Math.round(clamp(dist, -100, 100)) };
            push(applied, '镜头畸变 ' + (dist > 0 ? '+' : '') + Math.round(dist));
        }

        // 出现但未映射的常见 LR 字段 → skipped
        found.forEach((k) => { if (SKIP.indexOf(k) >= 0) push(skipped, k); });

        // 没有任何有效调整时，cg/curve 的空壳也不要留下
        if (patch.cg) {
            const anyCg = ['shadow', 'mid', 'high', 'global'].some((z) => {
                const v = patch.cg[z] || {};
                return (Number(v.s) || 0) || (Number(v.l) || 0);
            });
            if (!anyCg) delete patch.cg;
        }

        return { patch, applied, skipped, hasAdjust: Object.keys(patch).length > 0 };
    }

    // ── UI 入口：按钮 → 选文件 → 映射 → setGrade ──
    async function importXmpPreset() {
        const app = window.App;
        const api = window.qingframe;
        const say = (msg) => {
            if (app && app.setStatus) app.setStatus(msg);
            else console.warn(msg);
        };
        if (!api || !api.importXmp) { say('当前环境不支持导入 XMP（缺少 preload 桥）'); return; }
        // 等实测表就绪：参数曲线要用实测对角线，避免公式换算的偏差
        if (window.QfsAcr && QfsAcr.ensure) { try { await QfsAcr.ensure(); } catch (_) {} }
        let r;
        try { r = await api.importXmp(); }
        catch (e) { say('导入失败：' + (e && e.message ? e.message : String(e))); return; }
        if (!r) { say('导入失败：主进程没有返回结果'); return; }
        if (r.canceled) return;
        if (!r.ok) { say('导入失败：' + (r.error || '未知错误')); return; }
        const { patch, applied, skipped, hasAdjust } = mapXmp(r.text);
        if (!hasAdjust) {
            say('「' + r.name + '」里没有可识别的调色参数（请确认是 Lightroom/Camera Raw 导出的 .xmp）');
            return;
        }
        if (app && app.setGrade) app.setGrade(patch, { full: true, replace: true });
        const msg = '已导入 LR 预设「' + r.name + '」并替换当前调色：'
            + (applied.join('、') || '无')
            + (skipped.length ? '；未导入：' + skipped.join('、') : '');
        say(msg);
    }

    /* ══ 导出：清框影 grade → Lightroom / Camera Raw 可读的 .xmp ══
       只写 LR 有同义字段的参数；色彩平衡 / 渐变映射 / 色阶中间调是清框影
       自己的实现，LR 没有同义字段，不硬塞成别的参数（宁可少导，不导错）。
       标准字段全部写满（含 0 / 线性曲线），保证在 LR 里套用时不会残留上一套。
       qf:QfsGrade 里另附完整 grade，本应用重新导入时逐字段还原。 */
    const escAttr = (v) => String(v)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const numStr = (v) => String(Math.round((Number(v) || 0) * 100) / 100);
    const curveVals = (pts) => {
        const list = (pts && pts.length >= 2) ? pts : [[0, 0], [1, 1]];
        return list.map((p) => Math.round(clamp(Number(p[0]) || 0, 0, 1) * 255)
            + ', ' + Math.round(clamp(Number(p[1]) || 0, 0, 1) * 255));
    };

    function gradeToXmp(grade, name) {
        const App = window.App;
        const g = (App && App.normalizeGrade) ? App.normalizeGrade(grade) : (grade || {});
        const safeName = String(name || '调色预设').replace(/[<>]/g, '').replace(/--+/g, '-');
        const attrs = [];
        const add = (k, v) => attrs.push('    crs:' + k + '="' + escAttr(v) + '"');

        add('Version', '15.4');
        add('ProcessVersion', '15.4');
        add('PresetType', 'Normal');
        add('HasSettings', 'True');

        const BASE_OUT = [
            ['exp', 'Exposure2012'], ['con', 'Contrast2012'],
            ['sat', 'Saturation'], ['vib', 'Vibrance'],
            ['hi', 'Highlights2012'], ['sh', 'Shadows2012'],
            ['white', 'Whites2012'], ['black', 'Blacks2012']
        ];
        for (const f of BASE_OUT) add(f[1], numStr(g[f[0]]));

        if (Number(g.temp) || Number(g.tint)) {
            add('WhiteBalance', 'Custom');
            add('Temperature', tempToKelvin(g.temp));
            add('Tint', Math.round(Number(g.tint) || 0));
        } else {
            add('WhiteBalance', 'As Shot');
        }

        // 黑白：false 也要写，否则在 LR 里套完黑白预设再套彩色预设不会退出黑白。
        add('ConvertToGrayscale', (g.bw && g.bw.on) ? 'True' : 'False');
        if (g.bw && g.bw.on) {
            BW_FIELDS.forEach((f) => add(f.xmp, Math.round(Number(g.bw[f.key]) || 0)));
        }

        // 细节：全部写满，0 也写，避免上一套预设的锐化/清晰度残留。
        const det = g.det || {};
        DET.forEach((f) => add(f.xmp, Math.round(Number(det[f.key]) || 0)));
        add('SharpenAmount', Math.round(Number(det.shp) || 0));
        add('SharpenRadius', (Math.round((Number(det.shr) || 1) * 10) / 10).toFixed(1));
        add('SharpenDetail', Math.round(Number(det.shd) || 0));
        add('SharpenEdgeMasking', Math.round(Number(det.shm) || 0));

        const cal = g.cal || {};
        CAL.forEach((f) => add(f.xmp, Math.round(Number(cal[f.key]) || 0)));

        MIX_COLORS.forEach((c) => {
            const cell = (g.mix && g.mix[c.key]) || {};
            MIX_CH.forEach((ch) => add(ch.xmp + c.xmp, Math.round(Number(cell[ch.key]) || 0)));
        });

        const cg = g.cg || {};
        const ZONES_OUT = [
            ['Shadow', 'shadow'], ['Midtone', 'mid'],
            ['Highlight', 'high'], ['Global', 'global']
        ];
        for (const z of ZONES_OUT) {
            const v = cg[z[1]] || {};
            add('ColorGrade' + z[0] + 'Hue', Math.round(Number(v.h) || 0));
            add('ColorGrade' + z[0] + 'Sat', Math.round(Number(v.s) || 0));
            add('ColorGrade' + z[0] + 'Lum', Math.round(Number(v.l) || 0));
        }
        const blend = Number(cg.blending);
        add('ColorGradeBlending', Math.round(Number.isFinite(blend) ? blend : 50));
        add('ColorGradeBalance', Math.round(Number(cg.balance) || 0));

        add('LensManualDistortionAmount',
            Math.round(Number((g.lc && g.lc.distort) || 0)));

        // 曲线全部写满：没有调曲线时写直线，套预设才会清掉上一套曲线。
        const CV = window.QfsCurve;
        const hasCurve = CV ? CV.curveActive(g.curve)
            : !!(g.curve && (g.curve.rgb || g.curve.r || g.curve.g || g.curve.b));
        const CURVE_OUT = [
            ['ToneCurvePV2012', 'rgb'], ['ToneCurvePV2012Red', 'r'],
            ['ToneCurvePV2012Green', 'g'], ['ToneCurvePV2012Blue', 'b']
        ];
        const curveNodes = [];
        for (const c of CURVE_OUT) {
            const vals = curveVals(hasCurve && g.curve ? g.curve[c[1]] : null);
            curveNodes.push('    <crs:' + c[0] + '>\n'
                + '      <rdf:Seq>\n'
                + vals.map((v) => '        <rdf:li>' + v + '</rdf:li>').join('\n') + '\n'
                + '      </rdf:Seq>\n'
                + '    </crs:' + c[0] + '>');
        }

        // 清框影私有完整参数。base64 后是纯 ASCII，放进 XML 文本节点即可。
        let payload = '';
        try {
            if (App && typeof App._jsonToB64 === 'function') {
                payload = App._jsonToB64(JSON.stringify({
                    v: 1,
                    kind: 'qfs-grade-xmp',
                    name: safeName,
                    grade: Object.assign({}, g, { masks: [] })
                }));
            }
        } catch (_) { payload = ''; }

        const lines = [];
        lines.push('<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>');
        lines.push('<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Qingframe">');
        lines.push(' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">');
        lines.push('  <!-- ' + safeName + ' -->');
        lines.push('  <rdf:Description rdf:about=""');
        lines.push('    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"');
        lines.push('    xmlns:qf="https://qingframe.app/ns/grade/1.0/"');
        for (const a of attrs) lines.push(a);
        lines.push('  >');
        for (const n of curveNodes) lines.push(n);
        if (payload) lines.push('    <qf:QfsGrade>' + payload + '</qf:QfsGrade>');
        lines.push('  </rdf:Description>');
        lines.push(' </rdf:RDF>');
        lines.push('</x:xmpmeta>');
        lines.push('<?xpacket end="w"?>');
        return lines.join('\n');
    }

    window.AppXmp = { mapXmp, importXmpPreset, kelvinToTemp, tempToKelvin, gradeToXmp };

    function bind() {
        const btn = document.getElementById('btnGradeImportXmp');
        if (btn) btn.addEventListener('click', importXmpPreset);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();

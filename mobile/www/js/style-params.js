// 样式私有参数声明表 —— 「面板控件 ↔ 引擎字面量」的唯一事实来源。
//
// 背景:90 款预设 ≈ 70+ 个样式函数,内部常量全焊死在函数体里(styleCard3D 的
// 0.18 / 0.025 / 三层阴影…)。0.1.26 的「背景模糊」六项自由度做对了零回归
// (缺省 null / fallback 原字面量 / 复位 delete),但每加一个参数要改八处散抄。
// 本表把声明收成一处,UI 生成/绑定/回显/复位与状态读写全部从它派生。
//
// 两种落点:
//   path:'root'  —— 存量字段,写在模板根。0.1.26 及更早的工程/草稿/预设里
//                   这些字段已经存在,绝不能搬家,否则用户调过的参数会丢。
//   path:'style' —— 新字段,写在 t.styleParams[STYLE][key]。90 个样式都想叫
//                   thick/gap 时靠命名空间隔离,也不污染现有模板 schema。
//
// 三条铁律:① 缺省 null,绝不写默认值 ② 复位 delete,不写数字
//           ③ apply(def) === legacy —— 默认值就是引擎原来的字面量。
// 模板序列化是全量 JSON 深拷贝(cloneTemplate/coerceTemplate 没有字段白名单),
// 所以新字段自动进撤销栈、草稿、.qfs、分享码、配置导入导出,不用改那条链路。
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StyleParams = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // 所有滑块都用百分数,引擎量 = UI 值 / 100。声明表与引擎共用这个换算,
    // 于是「默认值等于原硬编码」可以被机器断言,而不是靠人记。
    const pct = (v) => Number(v) / 100;

    // ── 存量:背景模糊·经典 / 日期 六项(0.1.26 已有,字段名与 DOM id 保持不变) ──
    const BLUR = [
        { key: 'blurBackdropDim', label: '背景明暗', min: 0, max: 80, step: 2, def: 40, unit: '%',
          row: 'rowBlurBackdropDim', slider: 'slBlurBackdropDim', valueLabel: 'lblBlurBackdropDim',
          path: 'root', legacy: 0.4, apply: pct,
          hint: '模糊底上叠多少黑：0 = 不压暗，越大越深' },
        { key: 'blurBackdropZoom', label: '背景取景', min: 100, max: 200, step: 5, def: 100, unit: '%',
          row: 'rowBlurBackdropZoom', slider: 'slBlurBackdropZoom', valueLabel: 'lblBlurBackdropZoom',
          path: 'root', legacy: 1, apply: pct,
          hint: '把模糊底再放大，改变虚化色块的取景范围；100% = 默认铺满' },
        { key: 'blurSubjectShadow', label: '主体阴影', min: 0, max: 200, step: 10, def: 100, unit: '%',
          row: 'rowBlurSubjectShadow', slider: 'slBlurSubjectShadow', valueLabel: 'lblBlurSubjectShadow',
          path: 'root', legacy: 1, apply: pct,
          hint: '中间照片外侧的悬浮阴影：0 = 不要阴影，100 = 预设原样，拖大更立体' },
        { key: 'blurTextOffset', label: '上下位置', min: -100, max: 100, step: 5, def: 0, unit: '%',
          row: 'rowBlurTextOffset', slider: 'slBlurTextOffset', valueLabel: 'lblBlurTextOffset',
          path: 'root', legacy: 0, apply: pct,
          hint: '品牌+型号那一行在底部参数带里的上下位置：0 = 空白三份均分' },
        { key: 'blurTextGap', label: '行间距', min: 0, max: 300, step: 5, def: 100, unit: '%',
          row: 'rowBlurTextGap', slider: 'slBlurTextGap', valueLabel: 'lblBlurTextGap',
          path: 'root', legacy: 1, apply: pct, twoLineOnly: true,
          hint: '型号行与参数 / 日期行的上下间距：100% = 空白均分三份' },
        { key: 'blurBrandGap', label: '品牌间距', min: 0, max: 300, step: 5, def: 100, unit: '%',
          row: 'rowBlurBrandGap', slider: 'slBlurBrandGap', valueLabel: 'lblBlurBrandGap',
          path: 'root', legacy: 1, apply: pct, twoLineOnly: true,
          hint: '品牌与型号之间的水平间距：100% = 默认的一小段距离' }
    ];

    // ── 新参数:3D 卡片(第一块试金石)。legacy 就是 styleCard3D 里原来的字面量 ──
    const CARD_3D = [
        { key: 'padX', label: '左右留白', min: 5, max: 40, step: 1, def: 18, unit: '%',
          path: 'style', legacy: 0.18, apply: pct, group: '卡片几何',
          hint: '卡片左右两侧露出的桌面宽度，默认 18%' },
        { key: 'padBottom', label: '下留白', min: 5, max: 40, step: 1, def: 20, unit: '%',
          path: 'style', legacy: 0.2, apply: pct, group: '卡片几何',
          hint: '照片下方露出的卡纸宽度，默认 20%' },
        { key: 'thick', label: '卡片厚度', min: 0.5, max: 6, step: 0.5, def: 2.5, unit: '%',
          path: 'style', legacy: 0.025, apply: pct, group: '卡片几何',
          hint: '右下角露出的灰边厚度，默认 2.5%' },
        { key: 'shadow', label: '投影强度', min: 0, max: 200, step: 10, def: 100, unit: '%',
          path: 'style', legacy: 1, apply: pct, group: '悬浮投影',
          hint: '三层递进投影的位移与模糊倍率，默认 100% = 预设原样' }
    ];

    // ── 第二批:齿孔家族。两个样式各开放「大小 / 间距」,倍率缺省都是 1 ──
    const STAMP_POSTAGE = [
        { key: 'stampHoleSize', label: '齿孔大小', min: 50, max: 200, step: 10, def: 100, unit: '%',
          path: 'style', legacy: 1, apply: pct, group: '齿孔',
          hint: '邮票四周半圆齿孔的直径；默认 100% = 预设原样' },
        { key: 'stampHolePitch', label: '齿孔间距', min: 60, max: 220, step: 10, def: 100, unit: '%',
          path: 'style', legacy: 1, apply: pct, group: '齿孔',
          hint: '齿孔沿四边排布的节距；越小越密，默认 100%' }
    ];
    const FILM_TEAR = [
        { key: 'filmHoleSize', label: '齿孔大小', min: 50, max: 200, step: 10, def: 100, unit: '%',
          path: 'style', legacy: 1, apply: pct, group: '齿孔',
          hint: '胶片轨上方孔的尺寸；默认 100% = 预设原样' },
        { key: 'filmHoleGap', label: '齿孔间距', min: 60, max: 220, step: 10, def: 100, unit: '%',
          path: 'style', legacy: 1, apply: pct, group: '齿孔',
          hint: '相邻齿孔的中心距；越小越密，默认 100%' }
    ];

    // ── 齿孔家族(第三批票根 + 第四批纪念邮票):十个样式共用这一组声明。
    //    引擎侧三处票根绘制 + styleStamp 都调 ticketHoleGeom,改一处几何覆盖十款。
    //    key 沿用了第三批的 ticketHole*,是内部标识,面板只显示「齿孔大小 / 齿孔间距」。 ──
    const TICKET = [
        { key: 'ticketHoleSize', label: '齿孔大小', min: 50, max: 200, step: 10, def: 100, unit: '%',
          path: 'style', legacy: 1, apply: pct, group: '齿孔',
          hint: '票边半圆齿孔与撕线孔的半径；默认 100% = 预设原样' },
        { key: 'ticketHoleGap', label: '齿孔间距', min: 60, max: 220, step: 10, def: 100, unit: '%',
          path: 'style', legacy: 1, apply: pct, group: '齿孔',
          hint: '相邻齿孔的节距；越小越密，默认 100%' }
    ];

    const TABLE = { BLUR_CLASSIC: BLUR, BLUR_DATE: BLUR, CARD_3D: CARD_3D,
        STAMP_POSTAGE: STAMP_POSTAGE, FILM_TEAR: FILM_TEAR,
        TICKET_VINTAGE: TICKET, TICKET_SCRAP: TICKET, TICKET_CONCERT: TICKET,
        MOVIE_TICKET: TICKET, BOARDING_PASS: TICKET,
        TICKET_STAMP: TICKET, STAMP_KRAFT: TICKET, STAMP_BLUEPRINT: TICKET,
        STAMP_REDSEAL: TICKET, STAMP_GOLD: TICKET };

    function styleOf(t) { return String((t && t.photoFrameStyle) || '').toUpperCase(); }
    function forStyle(style) { return TABLE[String(style || '').toUpperCase()] || []; }
    function has(style) { return forStyle(style).length > 0; }
    function styleParams(style) { return forStyle(style).filter((p) => p.path === 'style'); }

    function clamp(p, v) {
        const n = Number(v);
        return Math.max(p.min, Math.min(p.max, isFinite(n) ? n : p.def));
    }

    // 读到的永远是 UI 值;字段不存在时给 def,但绝不写回模板。
    function get(t, style, p) {
        if (!t) return p.def;
        if (p.path === 'root') return t[p.key] == null ? p.def : clamp(p, t[p.key]);
        // 导入的工程 / 分享码里的 styleParams 可能不是对象(字符串、数组、null),
        // 一律当作「没有调过参数」,不让脏结构渗进面板。
        const root = t.styleParams;
        if (!root || typeof root !== 'object' || Array.isArray(root)) return p.def;
        const seg = root[String(style).toUpperCase()];
        if (!seg || typeof seg !== 'object' || Array.isArray(seg)) return p.def;
        return seg[p.key] == null ? p.def : clamp(p, seg[p.key]);
    }

    // 只有用户真的拖过滑块才调用这里 —— 缺省态保持「模板里没有这个字段」。
    function set(t, style, p, v) {
        if (!t) return p.def;
        const n = clamp(p, v);
        if (p.path === 'root') {
            t[p.key] = n;
        } else {
            const s = String(style).toUpperCase();
            // 数组虽然 typeof 是 object,但 JSON.stringify 会丢掉字符串键 —— 必须纠正成普通对象,
            // 否则导入过脏 styleParams 的工程里,用户调过的参数保存后再打开就没了。
            if (!t.styleParams || typeof t.styleParams !== 'object' || Array.isArray(t.styleParams)) t.styleParams = {};
            if (!t.styleParams[s] || typeof t.styleParams[s] !== 'object' || Array.isArray(t.styleParams[s])) t.styleParams[s] = {};
            t.styleParams[s][p.key] = n;
        }
        return n;
    }

    // 复位 = 删字段,不是写默认值。删完把空的命名空间也收掉,工程文件保持干净。
    function reset(t, style) {
        if (!t) return;
        // 复位顺手把导入工程里带进来的脏结构(字符串 / 数组)整个清掉。
        if (t.styleParams && (typeof t.styleParams !== 'object' || Array.isArray(t.styleParams))) delete t.styleParams;
        const s = String(style).toUpperCase();
        for (const p of forStyle(s)) {
            if (p.path === 'root') delete t[p.key];
            else if (t.styleParams && t.styleParams[s]) delete t.styleParams[s][p.key];
        }
        if (t.styleParams && t.styleParams[s] && !Object.keys(t.styleParams[s]).length) delete t.styleParams[s];
        if (t.styleParams && !Object.keys(t.styleParams).length) delete t.styleParams;
    }

    // 轻护栏:默认值必须与引擎原来的字面量严格相等,否则「零回归」只是口头约定。
    function defaultsOk() {
        const bad = [];
        for (const style of Object.keys(TABLE)) {
            for (const p of TABLE[style]) {
                const got = p.apply(p.def);
                if (!isFinite(got) || Math.abs(got - p.legacy) > 1e-9) {
                    bad.push(`${style}.${p.key}: apply(${p.def})=${got} ≠ ${p.legacy}`);
                }
            }
        }
        return bad;
    }

    // 引擎侧参考实现(engine-styles.js 的 spNum 与之同构,不直接依赖本模块:
    // design/regress.html 只加载引擎,不加载这张表,缺省态必须照样能渲染)。
    function engineValue(p, uiValue) { return p.apply(uiValue); }

    return { TABLE, pct, styleOf, forStyle, has, styleParams, clamp, get, set, reset,
        defaultsOk, engineValue };
});

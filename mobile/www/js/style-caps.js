// 风格能力表 —— 「面板控件 ↔ 引擎风格」绑定关系的唯一事实来源。
//
// 背景:这层绑定原先散在多处、互相抄写、各写各的:
//   - app.js 的 updatePersonalVisibility():一串 if/else + 内联 .includes([...]) 白名单
//   - tools/visual-regression.js:BRAND_STYLES 又抄了一份同样的名单
// 结果就是「某预设不响应滑块」:滑块在面板上对所有风格可见,引擎里却只有少数风格真的读它。
//   圆角 9/63 · 整体留白 3/63 · 图片缩放 9/63 · 背景模糊 6/63 · 参数字号 更少
//
// 本表把绑定拆成两半:
//
//   MEASURED —— 五个「数值滑块」维度,由 tools/gen-style-caps.js 从视觉回归基线**实测**生成:
//               某风格在极值下渲染指纹不变,就说明它压根不读这个参数。判断不依赖人脑,所以不会腐烂。
//   DECLARED —— 无法用像素差判定的语义能力(勾选项、分组),手写在此。
//
// 消费方:app.js(面板显隐)、tools/visual-regression.js(测试矩阵)、tools/gen-style-caps.js。
//
// 改完引擎后若某风格开始/不再响应某参数 → 跑 `npm run gen:caps` 重新生成。
// `npm run check:caps` 只校验不写文件,过期则退出码 1(CI 用)。
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StyleCaps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────────────
    // 维度定义(手写)。同时被面板显隐、视觉回归矩阵、能力表生成器共用 —— 不要在别处再抄一份。
    //   probe: 实测用的两个极值,范围对齐 index.html 里对应 input 的 min/max
    //   row  : 该滑块所在 .param-row 的 id(有些行原先没有 id,已补)
    // ────────────────────────────────────────────────────────────────────────
    const DIMS = [
        { key: 'pf', label: '参数字号', row: 'rowParamFontSize', slider: 'slParamFontSize', field: 'paramFontSize', probe: [16, 160] },
        { key: 'cr', label: '图片圆角', row: 'rowCornerRadius', slider: 'slCornerRadius', field: 'cornerConfig.cornerRadiusAll', probe: [0, 200] },
        { key: 'gm', label: '边距大小', row: 'rowGlobalMargin', slider: 'slGlobalMargin', field: 'baseMargin.globalMargin', probe: [0.4, 2.0] },
        { key: 'isc', label: '图片缩放', row: 'rowImgScale', slider: 'slImgScale', field: 'baseMargin.imgScale', probe: [0.6, 1.4] },
        { key: 'bi', label: '背景模糊程度', row: 'rowBgBlurInt', slider: 'slBgBlurInt', field: 'blurIntensity', probe: [10, 100] }
    ];

    // 用例 id 里的数值写法(0.4 → "04")。视觉回归基线的 key 依赖它,改了就等于作废整个基线。
    function caseSuffix(v) { return String(v).replace('.', ''); }
    function dimCaseId(style, dimKey, v) { return style + '__' + dimKey + caseSuffix(v); }

    // ────────────────────────────────────────────────────────────────────────
    // 风格分组(手写,从 app.js updatePersonalVisibility 原样搬过来,语义不变)
    // ────────────────────────────────────────────────────────────────────────
    const PERSONAL_STYLES = ['SIGNATURE', 'SIGN_PARAM', 'AVATAR_MEMO', 'AV_OVERLAY', 'AV_OVERLAY_TR', 'AV_OVERLAY_BR', 'AV_OVERLAY_BC', 'AV_OVERLAY_BC2'];
    // 「签名/头像行」默认关的风格:这五款预设自带 userSignature:'' + avatarShow:0,
    // 选中它们时画布是一张干净的票,想带签名/头像得在面板里显式开(面板行是开着的)。
    // 这张名单只是把「默认关」的判定收在一处,供 app.js 的自动填充与测试查询,
    // 它本身不参与任何渲染判定——渲染只认模板里的 avatarShow / userSignature。
    const SIG_ROW_DEFAULT_OFF = ['TICKET_VINTAGE', 'TICKET_SCRAP', 'TICKET_CONCERT', 'MOVIE_TICKET', 'BOARDING_PASS'];
    const OVERLAY_STYLES = ['OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM'];
    const BLUR_STYLES = ['BLUR_CLASSIC', 'BLUR_DATE'];
    const IMPRESSION_STYLES = ['IMP_FROSTED', 'OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM', 'CARD_LOGO_PARAM'];
    const WM_BRAND_STYLES = ['FUJI_WM_BRAND', 'DARK_BRAND_ONLY'];
    const BOTTOM_BAR_STYLES = ['SIGNATURE', 'SIGN_PARAM', 'AVATAR_MEMO'];
    const BRAND_LOGO_STYLES = [
        'WM_CLASSIC', 'WM_BRAND_LOGO', 'IMP_FROSTED', 'IMP_CLASSIC',
        'OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM',
        'CARD_LEICA', 'CARD_LOGO_PARAM', 'CARD_PURE_LOGO', 'CARD_SIMPLE', 'CARD_IMMERSION',
        'FUJI_WM_BRAND', 'DARK_BRAND_ONLY', 'OVERLAY_LOGO_BOTTOM',
        'SIGN_PARAM', 'SIGN_BLUR', 'BLUR_CLASSIC', 'BLUR_DATE',
        'FUJI_WHITE', 'COLOR_CLASSIC', 'ART_CARD', 'PARAM_CREDIT', 'LIQUID_GLASS', 'CARD_APPLE',
        'XIAOMI_LEICA'
    ];

    // 非风格引擎路径(路线2 卡片 bgBlurEnable / 路线3 图层模板)的能力。
    // 这两条路径不吃 MEASURED —— engine.js 的卡片/图层分支直接读 baseMargin.imgScale 与
    // cornerConfig(见 engine.js 卡片分支与图层分支),applyGlobalMargin 也照常作用于四边 margin。
    // 故一律保持「可见」,与接入能力表之前的行为完全一致;不参与收紧。
    const PATH_FALLBACK = { pf: true, cr: true, gm: true, isc: true, bi: false };

    // ── 生成区 BEGIN (tools/gen-style-caps.js)── 请勿手改,改动会在下次生成时被覆盖 ──
    const MEASURED = {
        ALBUM_CORNER: { cr: true },
        ART_CARD: { pf: true, cr: true },
        AVATAR_MEMO: { cr: true },
        AV_BLUR: { cr: true, bi: true },
        AV_OVERLAY: { cr: true },
        AV_OVERLAY_BC: { cr: true },
        AV_OVERLAY_BC2: { cr: true },
        AV_OVERLAY_BR: { cr: true },
        AV_OVERLAY_TR: { cr: true },
        BLUR_CLASSIC: { pf: true, cr: true, isc: true, bi: true },
        BLUR_DATE: { pf: true, cr: true, isc: true, bi: true },
        BOARDING_PASS: { cr: true, isc: true },
        BURNED_EDGE: { cr: true },
        CAMERA_PLATE: { pf: true, cr: true },
        CARD_3D: { cr: true },
        CARD_APPLE: { pf: true, cr: true, isc: true },
        CARD_IMMERSION: { pf: true },
        CARD_LEICA: { pf: true, cr: true },
        CARD_LOGO_PARAM: { pf: true },
        CARD_PURE_LOGO: { pf: true },
        CARD_SIMPLE: { pf: true, cr: true },
        COLOR_CLASSIC: { pf: true, cr: true },
        COLOR_PALETTE: { cr: true },
        COLOR_REFINED: { pf: true, cr: true },
        COMIC_PANEL: {  },
        CYANOTYPE: { cr: true },
        CYBER_GLITCH: { pf: true, cr: true, gm: true, isc: true, bi: true },
        DARK_BRAND_ONLY: { pf: true, cr: true, isc: true },
        DOUBLE_EXPOSURE: { cr: true },
        DOUBLE_LINE: { cr: true },
        DROP_SHADOW: { cr: true },
        FILM_STRIP: { cr: true },
        FILM_TEAR: { pf: true },
        FOLD_CORNER: { cr: true },
        FUJI_WHITE: { pf: true, cr: true },
        FUJI_WM: { pf: true, cr: true, isc: true },
        FUJI_WM_BRAND: { pf: true, cr: true, isc: true },
        GALLERY_MAT: { cr: true, isc: true },
        GRADIENT: { cr: true },
        HASSELBLAD: { pf: true, cr: true },
        IMP_CLASSIC: { pf: true, cr: true },
        IMP_FROSTED: { pf: true, cr: true, gm: true },
        INK_WASH: { cr: true },
        LIQUID_GLASS: { cr: true, bi: true },
        MAGAZINE_COVER: { cr: true },
        MAGAZINE_HEADER: { cr: true },
        MAGAZINE_MASTHEAD: { cr: true },
        MOVIE_TICKET: { cr: true, isc: true },
        NEON_GLOW: { cr: true },
        NEWSPAPER: { cr: true },
        OIL_BRUSH: { cr: true },
        OVERLAY_LOGO_BOTTOM: { pf: true, cr: true },
        OVERLAY_PARAM_BOTTOM: { pf: true, cr: true, gm: true, isc: true },
        OVERLAY_PARAM_LEFT: { pf: true, cr: true, isc: true },
        OVERLAY_PARAM_RIGHT: { pf: true, cr: true, isc: true },
        PARAM_BOTTOM_LEFT: { pf: true, cr: true },
        PARAM_BOTTOM_SINGLE: { pf: true, cr: true },
        PARAM_CREDIT: { pf: true, cr: true, isc: true },
        PARAM_STRIP: { pf: true, cr: true, isc: true },
        PARAM_TOP_LEFT: { pf: true, cr: true },
        PHOTO_CREDIT: { cr: true },
        PINBOARD_TAPE: { cr: true },
        POLAROID: { pf: true, cr: true },
        POLAROID_HAND: { cr: true },
        POP_COMIC: {  },
        PRESSED_FLOWER: { cr: true },
        PRISMATIC: { cr: true },
        ROUNDED: { cr: true },
        SIGNATURE: { cr: true },
        SIGN_BLUR: { pf: true, cr: true, bi: true },
        SIGN_PARAM: { pf: true, cr: true },
        SIG_BLUR: { cr: true, bi: true },
        SIMPLE: { cr: true },
        SIMPLE_FILM: { pf: true, cr: true },
        STAMP_BLUEPRINT: { cr: true, isc: true },
        STAMP_GOLD: { cr: true, isc: true },
        STAMP_KRAFT: { cr: true, isc: true },
        STAMP_POSTAGE: { pf: true },
        STAMP_REDSEAL: { cr: true, isc: true },
        TEARED_PAPER: { cr: true },
        TICKET_CONCERT: { cr: true, isc: true },
        TICKET_SCRAP: { cr: true, isc: true },
        TICKET_STAMP: { cr: true, isc: true },
        TICKET_VINTAGE: { cr: true, isc: true },
        TORN_JOURNAL: { cr: true },
        VHS_TAPE: { cr: true },
        VINTAGE: { cr: true },
        WATERCOLOR_BLEED: { cr: true },
        WAX_SEAL: { cr: true },
        WHITE_PLAIN: { cr: true },
        WM_AI: { pf: true, cr: true },
        WM_BRAND_LOGO: { pf: true, cr: true },
        WM_CLASSIC: { pf: true, cr: true },
        WM_SINGLE: { pf: true, cr: true },
        XIAOMI_IMP: { pf: true, cr: true },
        XIAOMI_LEICA: { cr: true },
    };
    // ── 生成区 END ──

    // 某风格是否具备某能力。未知风格(非 draw 映射表内,即卡片/图层路径)回落到 PATH_FALLBACK。
    function has(style, dimKey) {
        const s = String(style || '').toUpperCase();
        // 苹果信息卡:照片上/左/右贴边,没有「四周留白」这个维度 → 边距大小不适用
        if (s === 'CARD_APPLE' && dimKey === 'gm') return false;
        const m = MEASURED[s];
        if (m) return !!m[dimKey];
        return !!PATH_FALLBACK[dimKey];
    }

    function caps(style) {
        const out = {};
        for (const d of DIMS) out[d.key] = has(style, d.key);
        return out;
    }

    // ────────────────────────────────────────────────────────────────────────
    // 面板行显隐:app.js updatePersonalVisibility 的唯一实现。
    // 返回 { rowId: 是否可见 };app.js 只负责把结果写进 el.style.display。
    //
    // 与旧 if/else 梯子逐行核对过等价性(旧代码里"CARD_3D 先隐藏、后被覆盖"的那几处在
    // 覆盖后落到同一个值,故折叠无差异)。差异只有一处,且是有意的:pf / bi / cr / gm / isc
    // 这五行改由 MEASURED 实测决定,见 tools/test-panel-visibility.js 的收紧登记。
    // ────────────────────────────────────────────────────────────────────────
    // 面板行显隐是**纯函数**(输入只有风格名),而每次 refreshUI 都会问一次。
    // 结果按大写风格名缓存:返回的对象只被读取(updatePersonalVisibility 只取 rows[id]),
    // 所以复用同一份不会串味。键用大写名,保证 'signature' 与 'SIGNATURE' 共享一条。
    const _visibleRowsCache = new Map();
    function visibleRows(style) {
        const s = String(style || '').toUpperCase();
        const cached = _visibleRowsCache.get(s);
        if (cached) return cached;
        const v = computeVisibleRows(s);
        if (_visibleRowsCache.size > 256) _visibleRowsCache.clear();
        _visibleRowsCache.set(s, v);
        return v;
    }
    function computeVisibleRows(s) {
        const isPersonal = PERSONAL_STYLES.indexOf(s) >= 0;
        const isOverlay = OVERLAY_STYLES.indexOf(s) >= 0;
        const isLogoParam = s === 'CARD_LOGO_PARAM';
        const isBottomBar = BOTTOM_BAR_STYLES.indexOf(s) >= 0;

        // 签名/头像核心组:旧代码里 CARD_3D 先随组显示、再被单独隐藏,净效果等于不显示
        const sigCore = isPersonal || s === 'TICKET_STAMP' || s === 'STAMP_KRAFT' || s === 'STAMP_BLUEPRINT' || s === 'STAMP_REDSEAL' || s === 'STAMP_GOLD';
        // CARD_3D 只有签名文字四件套(内容/字体/颜色/字号),无头像,单独放行
        // PHOTO_CREDIT(摄影署名水印)同样只有签名四件套 + 署名内容切换,无头像
        const sigTextOnly = s === 'CARD_3D' || s === 'PHOTO_CREDIT';
        // 票券家族(票根三变体 + 撕边电影票 + 复古登机牌):签名四件套 + 头像两件套。
        // 与 sigCore 分开放:票券引擎画的是自己的票面配色,不读 paramColor,
        // 所以它们只该看到签名/头像这六行,不该多出一行「参数颜色」。
        const sigTicket = s === 'TICKET_VINTAGE' || s === 'TICKET_SCRAP' || s === 'TICKET_CONCERT' || s === 'MOVIE_TICKET' || s === 'BOARDING_PASS';
        const v = {};
        v.rowSignModel = s === 'SIGN_PARAM';
        v.rowCreditMode = s === 'PHOTO_CREDIT';
        v.rowSignText = sigCore || sigTextOnly || sigTicket;
        v.rowSignFont = sigCore || sigTextOnly || sigTicket;
        v.rowSignColor = sigCore || sigTextOnly || sigTicket;
        v.rowAvatarScale = sigCore || sigTicket;
        v.rowSignSize = sigCore || sigTextOnly || sigTicket;
        v.rowAvatarShow = sigCore || sigTicket;
        v.rowParamColor = sigCore;
        v.rowParamType = isBottomBar;
        v.rowParamPos = isBottomBar;
        // PHOTO_CREDIT(摄影署名水印)的引擎虽支持 signBgBlur,但产品上先不暴露这个入口:
        // 预设默认就是满幅原图 + 底部水印,避免用户在右侧误开模糊后还要找回来关。
        v.rowBgBlur = isPersonal || isOverlay || isLogoParam || s === 'PARAM_CREDIT';
        v.rowBrandSize = IMPRESSION_STYLES.indexOf(s) >= 0 || WM_BRAND_STYLES.indexOf(s) >= 0;
        // 「参数缩放」与「参数字号」都在改同一行字的最终大小(引擎里是相乘),属于重复控件。
        // 统一收口到「参数字号」:预设里的 paramScale 仍然生效(保持各预设有自己的比例),
        // 但不再露滑块,面板每个风格少一行、也不再有两个旋钮拧同一个数。
        v.rowParamScale = false;
        // 苹果信息卡有自己的「显示 Logo」开关和品牌/型号文本,不再复用通用品牌行
        v.rowBrandLogo = BRAND_LOGO_STYLES.indexOf(s) >= 0 && s !== 'CARD_APPLE';
        // 玻璃条大小:只有 LIQUID_GLASS 有底部玻璃条,其余风格显示这一行等于一个死滑块。
        // 这是 DECLARED 而非 MEASURED —— 它改的是"风格专属语义",像素差实测分不出来。
        v.rowGlassSize = s === 'LIQUID_GLASS';
        // 玻璃条「显示日期」:只有 LIQUID_GLASS 玻璃条上有日期行,其余风格没有可关的对象
        v.rowGlassDate = s === 'LIQUID_GLASS';
        // 拍立得底部文字:仅 POLAROID / POLAROID_HAND 底部有日期文字
        v.rowPolaroidCaption = s === 'POLAROID' || s === 'POLAROID_HAND';
        // 哈苏水印品牌文字:仅 HASSELBLAD 底部有品牌行
        v.rowHassyCaption = s === 'HASSELBLAD';
        // 苹果信息卡专属:文本内容 / 分区显隐 / 字号 / Logo / 竖线 / 配色。
        // 这是一整组 DECLARED 行(像素实测分不出"某个开关是否被读"),只在 CARD_APPLE 显形。
        const isApple = s === 'CARD_APPLE';
        v.rowAppleHint = isApple;
        v.rowAppleDate = isApple;    // 仅日期可自定义(品牌/型号/参数统一由下方相机参数驱动)
        v.rowAppleFont = isApple;
        v.rowAppleShow = isApple;    // 6 个显示开关合成一行胶囊
        v.rowAppleModelSize = isApple;
        v.rowAppleParamSize = isApple;
        v.rowAppleDateSize = isApple;
        v.rowAppleLogoSize = isApple;
        v.rowAppleLogoOpacity = isApple;
        v.rowAppleLineWidth = isApple;
        v.rowAppleColors = isApple;  // 4 个颜色合成一行色块
        // 联名水印专属:文本 / 显隐 / 对齐 / 字号 / Logo / 渐变 / 配色。
        // Logo 选择与「参数字号」走通用行(已加入 BRAND_LOGO_STYLES、字号由引擎实测),不另开重复入口。
        const isXm = s === 'XIAOMI_LEICA';
        v.rowXmHint = isXm;
        v.rowXmText1 = isXm;         // 品牌字标 + 主文案(均留空 = 自动)
        v.rowXmText2 = isXm;         // 副文案(留空 = 不显示)
        v.rowXmPartner = isXm;       // 联名 Logo(留空 = 跟随相机品牌)
        v.rowXmShow = isXm;          // 竖线 / 底部渐变
        v.rowXmAlign = isXm;         // 左下 / 底部居中 / 右下
        v.rowXmFont = isXm;          // 字体(默认 Arial,与参数横条同款)
        v.rowXmBrandSize = isXm;
        v.rowXmBrandTrack = isXm;    // 字标字距(槽级)
        v.rowXmLineWeight = isXm;    // 文案字重(槽级)
        v.rowXmLineSize = isXm;
        v.rowXmLogoSize = isXm;
        v.rowXmLogoOpacity = isXm;
        v.rowXmLogoColor = isXm;     // Logo 上色 / 原色
        v.rowXmPad = isXm;           // 水印离边缘的距离
        v.rowXmScrim = isXm;         // 渐变强度
        v.rowXmColors = isXm;        // 主文字 / 副文字 / 竖线
        // 五个数值滑块:实测决定。旧实现里 CARD_3D 无条件盖掉的几行,在实测口径下
        // 已被上面各自的判定吸收,故这里不需要额外的 is3d 分支。
        for (const d of DIMS) v[d.row] = has(s, d.key);
        return v;
    }

    // 该风格的「签名/头像行」是否默认关(需在面板里显式开启)。见 SIG_ROW_DEFAULT_OFF。
    function sigRowDefaultOff(style) {
        const s = String(style || '').toUpperCase();
        return SIG_ROW_DEFAULT_OFF.indexOf(s) >= 0;
    }

    return { DIMS, MEASURED, PATH_FALLBACK, PERSONAL_STYLES, SIG_ROW_DEFAULT_OFF, OVERLAY_STYLES, BLUR_STYLES, BRAND_LOGO_STYLES, caseSuffix, dimCaseId, has, caps, visibleRows, sigRowDefaultOff };
});

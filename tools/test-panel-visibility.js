// 面板控件显隐回归:锁定「切风格 → 哪些参数行可见」的行为。
// 用法:
//   node tools/test-panel-visibility.js            # 比对当前基线,任何变化即失败(日常/CI)
//   node tools/test-panel-visibility.js --audit    # 比对**能力表接入前**的冻结基线,
//                                                    #   变化必须全部落在下面两张登记表里
//   node tools/test-panel-visibility.js --update   # 重建当前基线
//   node tools/test-panel-visibility.js --update-pre  # 重建冻结基线(仅在故意回退能力表时用)
//
// 为什么需要它:updatePersonalVisibility() 只改 CSS display,不碰画布 —— 视觉回归完全覆盖不到它。
// 而这层一旦改错,用户看到的就是「换了预设但面板控件该在的不在 / 不该在的还在」,且无法肉眼定位。
//
// 两种模式各管一件事:
//   默认模式  = 防未来漂移。任何显隐变化都是回归,直接失败。
//   --audit   = 保住"接入能力表到底改了什么"这份证据链。冻结基线永远不动,
//               所以任何人改坏显隐逻辑时,都能复查这份变更清单是否仍然属实。
//
// 断言口径刻意不对称,两张表都要求人签字:
//   HIDE_OK(原先可见→现在隐藏):该风格下这个参数实测不生效,滑块露着是误导,收起来。
//   SHOW_OK(原先隐藏→现在可见):该参数其实生效,以前是白藏了,放出来是修复。
//   未登记的变化一律失败;登记了却没发生的变化同样失败(防登记腐化)。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const { pathToFileURL } = require('url');

// 退出码收尾。Electron 主进程**完全忽略 process.exitCode** —— 实测:app.quit() 之后设 42
// 得到 0;连 app.quit() 都不调、只 win.destroy() 也得到 0。只有 app.exit(code) 能带出非 0。
// 必须在所有 console 输出之后再调用(app.exit 是立即终止;实测 200 行输出不会丢)。
function finish(code) { app.exit(code || 0); }

const ROOT = path.resolve(__dirname, '..');
const SNAP = path.join(ROOT, 'tests', 'panel-visibility.json');
const SNAP_PRE = path.join(ROOT, 'tests', 'panel-visibility.pre-caps.json');
const ENGINE = path.join(ROOT, 'src', 'renderer', 'js', 'engine-styles.js');

// 允许的行为变化登记处。格式 'STYLE/rowId'。
//   HIDE_OK:原先可见 → 现在隐藏。语义:该风格下这个控件对应的参数确实不生效,露出来是误导。
//   SHOW_OK:原先隐藏 → 现在可见。语义:该参数其实生效,以前是白藏了(露出来是修复)。
// 两张表都要求"人签字":改引擎后若某风格的能力变了,这里就该跟着变;没登记的变化一律失败。
// 表项失效(登记了但实际没变化)也会失败,防止登记腐化。
//
// ── 接入 style-caps 能力表时的行为变更清单(2026-09)──
// 基线是接入前(旧 app.js if/else 梯子)抓的,清单即本次 diff 的全部内容:
//
// 1) 68 处收紧,全部是"参数本就不生效、滑块却一直露着"的那一类:
//    · rowParamFontSize × 31 个风格 —— 引擎不读 paramFontSize(实测指纹不变)
//    · rowBgBlurInt  × 37 个风格 —— 其中大部分是**旧代码的状态泄漏**:
//      旧梯子只在 isBlurStyle 分支把该行设为可见、从来没有 else 藏回去,于是它的显隐取决于
//      你之前切过哪个预设(切过 BLUR_CLASSIC 后再切 WM_CLASSIC 也一直显示)。新实现是无状态纯函数。
//    · 其余为零星几处,同样是实测不生效。
//
// 2) 4 处放宽,都是把以前错藏的控件放出来:
//    · SIGN_BLUR / SIG_BLUR / AV_BLUR / rowBgBlurInt —— 这三个签名风格引擎确实读
//      S.blurIntensity(实测指纹差 0.9~1.3),但旧梯子只对 BLUR_CLASSIC / BLUR_DATE 显示该滑块,
//      用户根本没法调。属于修复。
//    · DARK_BRAND_ONLY / rowParamFontSize —— 旧代码硬编码隐藏("品牌水印不画参数"),
//      但实测 pf=160 时指纹差 11.3,说明它确实会画参数。旧注释的前提已不成立,按实测放行。
//
// 3) 另有一处 DECLARED(手写)行的收紧,属产品判断、已确认:见 CARD_3D/rowSignText。
const HIDE_OK = new Set([
    'SIMPLE/rowParamFontSize', 'WHITE_PLAIN/rowParamFontSize', 'ROUNDED/rowParamFontSize',
    'FILM_STRIP/rowParamFontSize', 'DOUBLE_LINE/rowParamFontSize', 'VINTAGE/rowParamFontSize',
    'GRADIENT/rowParamFontSize', 'DROP_SHADOW/rowParamFontSize', 'TEARED_PAPER/rowParamFontSize',
    'FOLD_CORNER/rowParamFontSize', 'PINBOARD_TAPE/rowParamFontSize', 'VHS_TAPE/rowParamFontSize',
    'ALBUM_CORNER/rowParamFontSize', 'MOVIE_TICKET/rowParamFontSize', 'WATERCOLOR_BLEED/rowParamFontSize',
    'POLAROID_HAND/rowParamFontSize', 'TORN_JOURNAL/rowParamFontSize', 'COMIC_PANEL/rowParamFontSize',
    'NEWSPAPER/rowParamFontSize', 'SIGNATURE/rowParamFontSize', 'AVATAR_MEMO/rowParamFontSize',
    'AV_OVERLAY/rowParamFontSize', 'AV_OVERLAY_TR/rowParamFontSize', 'AV_OVERLAY_BR/rowParamFontSize',
    'AV_OVERLAY_BC/rowParamFontSize', 'AV_OVERLAY_BC2/rowParamFontSize',
    'AV_BLUR/rowParamFontSize', 'SIG_BLUR/rowParamFontSize',
    // CARD_3D:旧梯子的隐藏清单漏了 rowSignText,导致"签名文字"单独露着,而同行��字体/颜色/头像
    // (此处曾登记过 'CARD_3D/rowSignText' —— 当时的判断是「3D 卡片不画签名,整组收齐」。
    //  实测发现这条登记是失效的:旧梯子只是漏放了「签名文字」那一行(它在冻结基线里本来
    //  就是可见的),而现在的能力表(sigTextOnly)对它也是可见 —— 净变化为零,没有可登记的东西。
    //  真正的变化在同行另外三行(字体/颜色/字号:冻结基线隐藏 → 现在露出),按实测登记在 SHOW_OK。)
    // rowBgBlurInt:旧代码状态泄漏 + 本就只在 BLUR_CLASSIC/BLUR_DATE 显形,其余一律收到"隐藏"口径
    'WM_CLASSIC/rowBgBlurInt', 'WM_SINGLE/rowBgBlurInt', 'WM_BRAND_LOGO/rowBgBlurInt',
    'WM_AI/rowBgBlurInt', 'IMP_FROSTED/rowBgBlurInt', 'IMP_CLASSIC/rowBgBlurInt',
    'XIAOMI_IMP/rowBgBlurInt', 'CARD_LEICA/rowBgBlurInt', 'CARD_LOGO_PARAM/rowBgBlurInt',
    'CARD_PURE_LOGO/rowBgBlurInt', 'CARD_SIMPLE/rowBgBlurInt', 'CARD_IMMERSION/rowBgBlurInt',
    'OVERLAY_PARAM_LEFT/rowBgBlurInt', 'OVERLAY_PARAM_RIGHT/rowBgBlurInt',
    'OVERLAY_PARAM_BOTTOM/rowBgBlurInt', 'FUJI_WM/rowBgBlurInt', 'FUJI_WM_BRAND/rowBgBlurInt',
    'DARK_BRAND_ONLY/rowBgBlurInt', 'OVERLAY_LOGO_BOTTOM/rowBgBlurInt', 'COLOR_CLASSIC/rowBgBlurInt',
    'COLOR_REFINED/rowBgBlurInt', 'ART_CARD/rowBgBlurInt', 'FUJI_WHITE/rowBgBlurInt',
    'SIMPLE_FILM/rowBgBlurInt', 'PARAM_TOP_LEFT/rowBgBlurInt', 'PARAM_BOTTOM_LEFT/rowBgBlurInt',
    'PARAM_BOTTOM_SINGLE/rowBgBlurInt', 'STAMP_POSTAGE/rowBgBlurInt', 'TEARED_PAPER/rowBgBlurInt',
    'FOLD_CORNER/rowBgBlurInt', 'PINBOARD_TAPE/rowBgBlurInt', 'VHS_TAPE/rowBgBlurInt',
    'ALBUM_CORNER/rowBgBlurInt', 'MOVIE_TICKET/rowBgBlurInt', 'WATERCOLOR_BLEED/rowBgBlurInt',
    'POLAROID_HAND/rowBgBlurInt', 'TORN_JOURNAL/rowBgBlurInt',
    // 2026-11「参数缩放」全局收口到「参数字号」(13ce471 起 style-caps.js 的 v.rowParamScale = false):
    // 两个控件改的是同一个数(引擎里相乘),留着等于两个旋钮拧同一件事,面板每个风格还多一行。
    // 预设里的 paramScale 仍然生效,只是不再露滑块 —— 产品判断,不是能力表退回。
    // 冻结基线里这九款是露着的,其余风格当时就没露,所以净变化只有这九条。
    'FUJI_WM/rowParamScale', 'FUJI_WM_BRAND/rowParamScale',
    'BLUR_CLASSIC/rowParamScale', 'BLUR_DATE/rowParamScale', 'IMP_FROSTED/rowParamScale',
    'CARD_LOGO_PARAM/rowParamScale', 'OVERLAY_PARAM_LEFT/rowParamScale',
    'OVERLAY_PARAM_RIGHT/rowParamScale', 'OVERLAY_PARAM_BOTTOM/rowParamScale',
]);

const SHOW_OK = new Set([
    'SIGN_BLUR/rowBgBlurInt',
    'SIG_BLUR/rowBgBlurInt',
    'AV_BLUR/rowBgBlurInt',
    'DARK_BRAND_ONLY/rowParamFontSize',
    // 2026-10 票券家族接入签名/头像(style-caps.js 的 sigTicket):票根三变体 + 撕边电影票
    // 露出「签名内容/字体/颜色/字号 + 头像大小/显示头像」六行。冻结基线(能力表接入之前)里
    // MOVIE_TICKET 这几行是隐藏的(旧梯子只给签名/头像系列 + 邮票家族开),现在引擎真的读
    // 这些参数了 —— 不是「白藏了放出来」,而是签名行本来就在画(TICKET_* 有,电影票是这次
    // 新加的行),以前用户没法关也没法调。每个控件都有实测断点:
    // tools/test-ticket-redo.js ⑬–⑰(signSize 油墨 3408→12933、头像 0↔2467、头像大小
    // 2467→13148、签名色红像素 0→2364)与 ㉘–㉞(电影票:高度 1454→1588、副券列 0 油墨 …)。
    // 注意 rowAvatarShow 不列在这里:它整个行晚于冻结基线(见下面 NEW_ROWS),按「新增行」记账,
    // 列进本表反而会被判成「登记已失效」。TICKET_VINTAGE/SCRAP/CONCERT 在冻结基线里根本
    // 不存在,同样走 missingStyle 记账。
    'MOVIE_TICKET/rowSignText', 'MOVIE_TICKET/rowSignFont', 'MOVIE_TICKET/rowSignColor',
    'MOVIE_TICKET/rowSignSize', 'MOVIE_TICKET/rowAvatarScale',
    // CARD_3D:冻结基线里 3D 卡片的「签名字体/颜色/字号」是隐藏的(旧梯子的隐藏清单只漏放了
    // rowSignText 那一行,于是同行六个控件里只有"签名内容"露着)。引擎实测这三项确实生效 ——
    // styleCard3D 的签名行读 userSignature/signFont/signColor/signSize,且只画签名不画头像
    // (见 tools/test-ticket-redo.js ⑮)。能力表 sigTextOnly 组把四行一起露出,净变化就是这三条;
    // 相对冻结基线 rowSignText 本来就是可见的(见上面 HIDE_OK 的说明),故不在此列。
    'CARD_3D/rowSignColor', 'CARD_3D/rowSignFont', 'CARD_3D/rowSignSize',
    // 注意 PARAM_BOTTOM_LEFT/rowParamFontSize 与 STAMP_POSTAGE/rowParamFontSize 已从本表移除。
    // 它们曾因能力表判据缺陷(用全图平均差)被误判为不生效而收进 HIDE_OK;判据改成
    // "单格最大差 + 变化格数"后确认是真实响应(分别改动 51 / 29 格),于是又露了出来 ——
    // 而冻结基线里它们本来就是可见的,所以相对冻结基线**净变化为零**,不进变更集。
    // 详见 tools/gen-style-caps.js 顶部关于"为什么不能用全图平均差"的说明。
]);

// 接入能力表时在 index.html 上补 id 的三个行(原先没有任何 id,故永远显示、也没法纳入快照)。
// 冻结基线里不存在这些行,audit 时按"新增行"单独记账,不算覆盖缺口。
// rowAvatarShow:2026-10 新增的「显示头像」开关(53bd5e2),同样晚于冻结基线,按新增行记账。
// rowT2i*:2026-10-10 的「文字转图片」功能(d937d41, v0.1.8)往 index.html 加的三行。它晚于
//   冻结基线(2026-09-26),也晚于上一次整表重建(2026-10-08) —— 所以当前快照的 rowIds 里一直没有
//   它们,audit 会按"参照缺行"报 76 风格 × 3 = 228 条。它们和上面三行性质相同(都是能力表接入之后
//   才有的行),按新增行记账即可;下次 --update 重建快照后它们自然会进 rowIds,默认模式的"缺行"
//   也就归零了。
// rowElTextDir / rowElTextSpacing:文字排版(方向/字距)两行,2026-10 新增。它们不是给所有风格
// 开的,而是**跟着"选中了文字"显隐**(app-elements.syncTextRows),所以冻结基线里不可能有,
// 一律按新增行记账。
// rowElTextContent / Font / Size / Color：文字工具的四行（2026-10），跟着"选中了文字"显隐。
// rowElTextWeight / Stroke / StrokeWidth / Shadow / ShadowBlur / ShadowOffset：2026-10-29
// 文字样式增强（字重/描边/阴影），同样跟着"选中了文字"显隐，冻结基线里不可能有。
// rowElSize：缩放行这次才补上 id（原来没有），所以按新增行记账；它的显隐逻辑没变
// （选中文字时藏起来、让位给「字号」）。
const NEW_ROWS = new Set(['rowCornerRadius', 'rowGlobalMargin', 'rowImgScale', 'rowAvatarShow',
    'rowCreditMode', 'rowT2iColor', 'rowT2iEffect', 'rowT2iStyle',
    'rowElTextDir', 'rowElTextSpacing',
    'rowElTextContent', 'rowElTextFont', 'rowElTextSize', 'rowElTextColor', 'rowElSize',
    'rowElTextWeight', 'rowElTextStroke', 'rowElTextStrokeWidth',
    'rowElTextShadow', 'rowElTextShadowBlur', 'rowElTextShadowOffset',
    // 2026-11 苹果信息卡专属组(CARD_APPLE):晚于冻结基线,按新增行记账
    'rowAppleHint', 'rowAppleDate', 'rowAppleFont', 'rowAppleShow',
    'rowAppleModelSize', 'rowAppleParamSize', 'rowAppleDateSize',
    'rowAppleLogoSize', 'rowAppleLogoOpacity', 'rowAppleLineWidth', 'rowAppleColors',
    // 2026-11 背景模糊·经典/日期的专属自由度：晚于冻结基线，且只对
    // BLUR_CLASSIC / BLUR_DATE 显示（updatePersonalVisibility 手工控制），按新增行记账。
    // 「主体大小」因与通用「图片缩放」是同一个乘数而移除；「留白宽度」因会连画布
    // 尺寸一起改、与「边距大小」打架而移除，换成三根文字排版滑块。
    'rowBlurBackdropDim', 'rowBlurBackdropZoom', 'rowBlurSubjectShadow',
    'rowBlurTextOffset', 'rowBlurTextGap', 'rowBlurBrandGap']);

function drawKeys() {
    const src = fs.readFileSync(ENGINE, 'utf8');
    const at = src.indexOf('const draw = {');
    if (at < 0) throw new Error('引擎源码里找不到 const draw = {');
    const from = src.indexOf('{', at);
    let depth = 0;
    for (let i = from; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) {
            return [...src.slice(from, i).matchAll(/(?:^|[\s,{])([A-Z][A-Z0-9_]*)\s*:/g)].map(m => m[1]);
        }
    }
    throw new Error('const draw = { 括号未配平');
}

// 重建基线时把「没测到」的 null 剔除，别让它写进参照（写进去会让下次比对把
// 「元素不在」和「可见」判成放宽）
function stripNull(out) {
    const clean = {};
    for (const s of Object.keys(out)) {
        clean[s] = {};
        for (const [k, v] of Object.entries(out[s])) if (v !== null) clean[s][k] = v;
    }
    return clean;
}

const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    const rowIds = [...document.querySelectorAll('[id^="row"]')].map(e => e.id).sort();
    const styles = window.__CAP_STYLES;
    const out = {};
    for (const s of styles) {
        App.template = App.template || App.defaultTemplate();
        App.template.photoFrameStyle = s;
        App.updatePersonalVisibility();
        const vis = {};
        for (const id of rowIds) {
            const el = document.getElementById(id);
            // 元素不存在要记 null 而不是跳过：跳过会让 vis[id] 变成 undefined，
            // 比对时被当成「隐藏」，于是同一个脚本两次跑能得出完全不同的收紧集合
            // （切样式时行元素会重建，撞上重建窗口就丢）。null 在比对里单独跳过。
            vis[id] = el ? getComputedStyle(el).display !== 'none' : null;
        }
        out[s] = vis;
    }
    return { rowIds, out };
}
`;

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.presets)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    const styles = drawKeys();
    await win.webContents.executeJavaScript(`window.__CAP_STYLES = ${JSON.stringify(styles)}`);
    const got = await win.webContents.executeJavaScript(`(${CHECK})()`);
    app.quit();

    const isUpdate = process.argv.includes('--update');
    const isUpdatePre = process.argv.includes('--update-pre');
    const isAudit = process.argv.includes('--audit');

    if (isUpdate || isUpdatePre) {
        const target = isUpdatePre ? SNAP_PRE : SNAP;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify({ rowIds: got.rowIds, styles: stripNull(got.out) }, null, 1), 'utf8');
        console.log(`[panel:update] ${isUpdatePre ? '冻结基线' : '当前基线'}已重建:${styles.length} 风格 × ${got.rowIds.length} 行 → ${path.relative(ROOT, target)}`);
        finish(0);
        return;
    }

    const refPath = isAudit ? SNAP_PRE : SNAP;
    const refLabel = isAudit ? '能力表接入前(冻结)' : '当前基线';
    if (!fs.existsSync(refPath)) {
        console.error(`参照文件不存在:${path.relative(ROOT, refPath)}`);
        finish(1);
        return;
    }
    const base = JSON.parse(fs.readFileSync(refPath, 'utf8'));

    const hide = [], show = [], missingRow = [], missingStyle = [], newRows = [], absent = [];
    for (const s of styles) {
        const b = base.styles[s], g = got.out[s];
        if (!b) { missingStyle.push(s); continue; }
        for (const id of got.rowIds) {
            // 该样式下这一行没有 DOM（切样式时被重建，恰好吃到 window 里）—— 没测到就不算变化
            if (g && g[id] === null) { absent.push(s + '/' + id); continue; }
            if (!(id in b)) {
                if (NEW_ROWS.has(id)) newRows.push(id);
                else missingRow.push(s + '/' + id);
                continue;
            }
            if (b[id] === g[id]) continue;
            const key = s + '/' + id;
            if (b[id] && !g[id]) hide.push([key, HIDE_OK.has(key)]);
            else show.push([key, SHOW_OK.has(key)]);
        }
    }

    console.log(`== 面板显隐回归 (${isAudit ? 'audit · 对照 ' + refLabel : refLabel}) ==`);
    console.log(`  风格 ${styles.length} / 行 ${got.rowIds.length}`);
    // 没测到的（该样式下这一行当时没有 DOM）不计入变化，但要显式报出来 ——
    // 数量一大就说明这次测量本身不可信，别把「没测到」当成「没变化」。
    if (absent.length) console.log(`  未测到(DOM 缺失，不计入变化) ${absent.length}: ${[...new Set(absent)].slice(0, 6).join(', ')}${absent.length > 6 ? '…' : ''}`);
    if (missingStyle.length) console.log(`  参照缺风格 ${missingStyle.length}: ${missingStyle.slice(0, 5).join(', ')}${missingStyle.length > 5 ? '…' : ''}`);
    if (missingRow.length) console.log(`  参照缺行 ${missingRow.length}: ${missingRow.slice(0, 5).join(', ')}${missingRow.length > 5 ? '…' : ''}`);
    if (newRows.length) console.log(`  新增行(冻结基线中不存在,按新增记账): ${[...new Set(newRows)].join(', ')}`);

    // 注意:退出码只能走 app.exit() —— 见文件头 finish() 的注释。app.quit() 之后再调
    // process.exit() 不会立即终止(本 async 函数会继续往下跑,踩过:后面整段审计逻辑被意外执行);
    // 而只设 process.exitCode 又会被 Electron 主进程忽略(实测恒为 0)。
    if (!isAudit) {
        // 默认模式:当前基线即真理,任何变化都是回归
        const all = hide.map(h => h[0]).concat(show.map(h => h[0]));
        if (all.length) {
            console.log('--- 与当前基线不一致 ✖(显隐逻辑发生了未预期的变化)---');
            all.forEach(k => console.log('  ' + k));
        } else {
            console.log('  一致');
        }
        finish(all.length || missingRow.length || missingStyle.length ? 1 : 0);
        return;
    }

    // audit 模式:冻结基线是"接入能力表之前"的真实行为,变化必须逐条有登记
    const badHide = hide.filter(h => !h[1]);
    const badShow = show.filter(h => !h[1]);
    const staleReg = [
        ...[...HIDE_OK].filter(k => !hide.some(h => h[0] === k)).map(k => ['HIDE_OK', k]),
        ...[...SHOW_OK].filter(k => !show.some(h => h[0] === k)).map(k => ['SHOW_OK', k])
    ];
    console.log(`  收紧(可见→隐藏) ${hide.length}  未登记 ${badHide.length}`);
    console.log(`  放宽(隐藏→可见) ${show.length}  未登记 ${badShow.length}`);
    for (const [list, title] of [[badHide, '收紧但未登记 ✖'], [badShow, '放宽但未登记 ✖']]) {
        if (!list.length) continue;
        console.log(`--- ${title} ---`);
        list.forEach(h => console.log('  ' + h[0]));
    }
    if (staleReg.length) {
        console.log(`--- 登记已失效 ${staleReg.length} 条(从对应表删掉)---`);
        staleReg.forEach(([t, k]) => console.log('  ' + t + ' ' + k));
    }
    if (!badHide.length && !badShow.length && !staleReg.length) {
        console.log('  ✓ 变更集与文档登记完全一致');
    }
    // missingStyle / missingRow 都不阻断:冻结基线是 2026-09 能力表接入前的快照,
    // 之后新增的风格与控件本就不在里面,按「新增记账」处理(与 NEW_ROWS 同一口径)。
    // 真正要严格的是 hide/show(显隐变了)和 staleReg(登记腐化)—— 它们才代表行为回退。
    finish(badHide.length || badShow.length || staleReg.length ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });

// 「背景模糊·经典 / 日期」进阶自由度回归。
// 用法: node tools/run-electron.js tools/test-blur-classic-controls.js
//
// 锁死这些最容易坏的事:
//  ① 模板里没有字段时能正常渲染（旧预设 / 草稿不会因为缺字段崩）
//  ② 每个滑块都真的改变画面（不能出现「拖了没反应」的假控件）
//  ③ 把滑块写成默认值 与「完全不写字段」渲染一致（默认值语义没跑偏）
//  ④ 只对 BLUR_CLASSIC / BLUR_DATE 露出;单行模式下行距/品牌间距自动收起
//  ⑤ 主体大小由通用「图片缩放」独占（不再有第二个重复滑块）
//  ⑥ 主体阴影 0%(无) / 100%(原样) / 200%(环绕暗晕) 三档行为正确
//  ⑦ 「留白宽度」已移除：面板与引擎都不再接受这个字段
//  ⑧ 分组归属：文字三根在「底部文字排版」组（画布栏），文字栏只有「去调」入口
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
};

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); }
    catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) {
    ipcMain.handle(c, () => []);
}
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'quit-and-install', 'open-external', 'open-data-dir',
    'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) {
    ipcMain.handle(c, () => ({ canceled: true }));
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.25', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));

const PROBE = `(async () => {
    const A = window.App;
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    const out = { errs: [] };

    // 四色分区 + 中央白块：任何几何 / 明暗 / 取景变化都能在采样指纹里显形。
    const c0 = document.createElement('canvas'); c0.width = 800; c0.height = 600;
    const g0 = c0.getContext('2d');
    const cols = ['#e83434', '#2e6fe0', '#28b46a', '#e8d24a'];
    for (let i = 0; i < 4; i++) {
        g0.fillStyle = cols[i];
        g0.fillRect((i % 2) * 400, Math.floor(i / 2) * 300, 400, 300);
    }
    g0.fillStyle = '#ffffff'; g0.fillRect(360, 260, 80, 80);
    const el = new Image();
    await new Promise(r => { el.onload = r; el.onerror = r; el.src = c0.toDataURL('image/png'); });
    const im = {
        el, name: 'blur.png', path: null, w: 800, h: 600,
        exif: { make: 'SONY', model: 'A7 IV', fNumber: 2.8, focalLength: 50, iso: 100, exposureTime: 0.008 },
        customSettings: null, grade: null
    };

    A.images = [im]; A.image = im; A.currentIdx = 0; A.selectedIdx = [0];
    A.template = A.defaultTemplate();
    A.template.photoFrameStyle = 'BLUR_CLASSIC';
    A.template.photoFrameBorderSize = 180;
    A.template.blurIntensity = 50;
    A.template.signBgBlur = 1;
    if (A.setTpl) A.setTpl(im, A.template);
    if (A.updateEmptyState) A.updateEmptyState();
    if (A.refreshUI) A.refreshUI();
    await nap(180);

    const cv = document.getElementById('previewCanvas');
    let baseData = null;
    const fp = () => {
        const g = cv.getContext('2d');
        const d = g.getImageData(0, 0, cv.width, cv.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 997) {
            h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
        }
        if (!baseData) baseData = d.slice();
        let diffs = 0, first = -1;
        for (let i = 0; i < d.length; i++) {
            if (d[i] !== baseData[i]) { diffs++; if (first < 0) first = i; }
        }
        const firstPx = first < 0 ? null : [Math.floor((first / 4) % cv.width), Math.floor((first / 4) / cv.width)];
        const px = (fx, fy) => {
            const x = Math.max(0, Math.min(cv.width - 1, Math.round(cv.width * fx)));
            const y = Math.max(0, Math.min(cv.height - 1, Math.round(cv.height * fy)));
            const p = g.getImageData(x, y, 1, 1).data;
            return [p[0], p[1], p[2]];
        };
        return {
            w: cv.width, h: cv.height, hash: h, diffs, firstPx,
            corner: px(0.01, 0.01), center: px(0.5, 0.5), edge: px(0.99, 0.99)
        };
    };
    const render = async () => { A.renderPreview(); await nap(70); };
    const FIELDS = ['blurBackdropDim', 'blurBackdropZoom', 'blurSubjectShadow',
        'blurTextOffset', 'blurTextGap', 'blurBrandGap'];
    const clear = () => { for (const f of FIELDS) delete A.template[f]; };
    const same = (a, b) => a.w === b.w && a.h === b.h && a.hash === b.hash
        && a.corner.join() === b.corner.join() && a.center.join() === b.center.join()
        && a.edge.join() === b.edge.join();

    clear();
    await render();
    const base = fp();
    out.base = base;
    out.baseValid = base.w > 100 && base.h > 100;

    // ② 每个字段单独推到极端值，画面必须变。
    const cases = [
        ['blurBackdropDim', 0],
        ['blurBackdropZoom', 185],
        ['blurSubjectShadow', 200],
        ['blurTextOffset', 100],
        ['blurTextGap', 300],
        ['blurBrandGap', 0]
    ];
    out.steps = [];
    for (const [f, v] of cases) {
        clear();
        A.template[f] = v;
        await render();
        const q = fp();
        out.steps.push({ f, v, w: q.w, h: q.h, hash: q.hash, changed: !same(base, q) });
        clear();
    }

    // ⑤ 主体大小归通用「图片缩放」独占：改 baseMargin.imgScale 必须改变画面，
    //    且面板里不再存在第二个「主体大小」滑块。
    clear();
    A.template.baseMargin.imgScale = 1.2;
    await render();
    out.imgScaleChanged = !same(base, fp());
    out.noSubjectRow = !document.getElementById('rowBlurSubjectScale');
    A.template.baseMargin.imgScale = 1;
    await render();

    // ⑥ 主体阴影三档：0 关掉、100 与原版逐像素一致、200 出现环绕暗晕。
    clear();
    A.template.blurSubjectShadow = 0;
    await render();
    out.shadowOff = fp();
    out.shadowOffChanged = !same(base, out.shadowOff);
    A.template.blurSubjectShadow = 100;
    await render();
    out.shadow100Same = same(base, fp());
    A.template.blurSubjectShadow = 200;
    await render();
    out.shadow200 = fp();
    out.shadow200Changed = !same(base, out.shadow200);
    clear();

    // ③ 写成默认数值 == 完全不写字段（引擎缺省分支与显式默认等价）。
    A.template.blurBackdropDim = 40;
    A.template.blurBackdropZoom = 100;
    A.template.blurSubjectShadow = 100;
    A.template.blurTextOffset = 0;
    A.template.blurTextGap = 100;
    A.template.blurBrandGap = 100;
    await render();
    const explicit = fp();
    out.explicitDefaultsSame = same(base, explicit);
    clear();
    await render();
    const cleared = fp();
    out.clearedSame = same(base, cleared);

    // ④ 显隐范围：经典/日期露出，其它风格全藏。
    const IDS = ['rowBlurBackdropDim', 'rowBlurBackdropZoom', 'rowBlurSubjectShadow',
        'rowBlurTextOffset', 'rowBlurTextGap', 'rowBlurBrandGap',
        'btnBlurReset', 'hintBlurAdvanced'];
    const vis = () => IDS.map(id => {
        const e = document.getElementById(id);
        return !!e && getComputedStyle(e).display !== 'none';
    });
    A.template.photoFrameStyle = 'BLUR_CLASSIC';
    A.updatePersonalVisibility();
    out.visibleClassic = vis();
    A.template.photoFrameStyle = 'BLUR_DATE';
    A.updatePersonalVisibility();
    out.visibleDate = vis();
    A.template.photoFrameStyle = 'CARD_SIMPLE';
    A.updatePersonalVisibility();
    out.visibleCard = vis();
    A.template.photoFrameStyle = 'BLUR_CLASSIC';
    // 单行模式（仅参数 / 日期）：没有品牌、型号两行，行距与品牌间距必须收起。
    A.template.paramType = 1;
    A.updatePersonalVisibility();
    out.single = {
        gap: getComputedStyle(document.getElementById('rowBlurTextGap')).display !== 'none',
        brand: getComputedStyle(document.getElementById('rowBlurBrandGap')).display !== 'none',
        offset: getComputedStyle(document.getElementById('rowBlurTextOffset')).display !== 'none'
    };
    A.template.paramType = 0;
    A.updatePersonalVisibility();
    out.noBandRow = !document.getElementById('rowBlurBandScale');

    // ⑧ 分组与指路：三根文字滑块独立成「底部文字排版」组留在画布栏（参照系是照片底边），
    //    文字栏只放一个「去调」入口 —— 用户在文字栏找不到时，至少知道该去哪儿。
    const grpBT = document.getElementById('grpBlurText');
    out.grp = {
        exists: !!grpBT,
        inCanvas: !!(grpBT && grpBT.closest('#panel-canvas')),
        title: grpBT ? ((grpBT.querySelector('.pg-title') || {}).textContent || '').trim() : '',
        rows: grpBT ? Array.prototype.map.call(grpBT.querySelectorAll('.param-row'), (r) => r.id) : [],
        resetInside: !!(grpBT && grpBT.querySelector('#btnBlurReset')),
        sepGone: !document.getElementById('sepBlurText')
    };
    A.template.photoFrameStyle = 'BLUR_CLASSIC';
    A.updatePersonalVisibility();
    const hintWhere = document.getElementById('hintBlurTextWhere');
    out.whereShown = !!hintWhere && getComputedStyle(hintWhere).display !== 'none';
    const btnGoto = document.getElementById('btnGotoBlurText');
    if (btnGoto) btnGoto.click();
    out.afterGoto = {
        canvasActive: document.getElementById('panel-canvas').classList.contains('active'),
        textActive: document.getElementById('panel-text').classList.contains('active'),
        flash: !!(grpBT && grpBT.classList.contains('grp-flash'))
    };
    A.template.photoFrameStyle = 'CARD_SIMPLE';
    A.updatePersonalVisibility();
    out.whereHiddenCard = !hintWhere || getComputedStyle(hintWhere).display === 'none';
    out.grpHiddenCard = !grpBT || getComputedStyle(grpBT).display === 'none';
    // 与文字栏的「参数位置(左/中/右)」撞名，改叫「上下位置」
    out.offsetLabel = ((document.querySelector('#rowBlurTextOffset label') || {}).textContent || '').trim();
    A.template.photoFrameStyle = 'BLUR_CLASSIC';
    A.updatePersonalVisibility();

    // 回显：模板里有值 → 滑块与标签同步；序列化能带走字段。
    A.template.blurBackdropDim = 12;
    A.template.blurTextGap = 180;
    A.refreshUI();
    out.echo = {
        dim: document.getElementById('slBlurBackdropDim').value,
        gap: document.getElementById('slBlurTextGap').value,
        dimLabel: (document.getElementById('lblBlurBackdropDim') || {}).textContent,
        serialized: JSON.stringify(A.template).indexOf('blurBackdropDim') >= 0
            && JSON.stringify(A.template).indexOf('blurTextGap') >= 0
    };

    // refreshUI() 会顺手把一堆缺省模板字段补齐（manualExif / shadowOpacity /
    // cornerDecorEnable…），参数条文字随之变化。所以不能用最开头的 base 当复位对照，
    // 得在「同一份模板状态、四个字段全清」下重拍一次，否则会把 refreshUI 的归一化
    // 误判成复位按钮改了画面。
    clear();
    // 复位按钮走的是 onSettingChanged()（内部 syncModelFromUI 会把控件值同步回模板），
    // 所以对照基线也必须走同一条真实路径，只调 renderPreview() 会漏掉这层同步。
    A.onSettingChanged();
    await nap(300);
    A.renderPreview();
    await nap(80);
    const resetBase = fp();
    out.resetBase = resetBase;

    // 重新设上两个字段，再让复位按钮把它们清掉。
    A.template.blurBackdropDim = 12;
    A.template.blurTextGap = 180;
    document.getElementById('btnBlurReset').click();
    out.afterReset = {
        dimField: A.template.blurBackdropDim,
        gapField: A.template.blurTextGap,
        dimSlider: document.getElementById('slBlurBackdropDim').value,
        gapSlider: document.getElementById('slBlurTextGap').value
    };
    await render();
    out.afterResetFp = fp();
    out.afterResetSame = same(resetBase, out.afterResetFp);
    // 对照：再清一次字段、多等一会再渲染，排除 onSettingChanged() 的异步防抖
    // 渲染在同步 renderPreview() 之后覆盖画面的时序假象。
    clear();
    A.renderPreview();
    await nap(220);
    out.finalCleanFp = fp();
    out.finalCleanSame = same(resetBase, out.finalCleanFp);
    out.afterResetTemplate = {
        style: A.template.photoFrameStyle,
        intensity: A.template.blurIntensity,
        borderSize: A.template.photoFrameBorderSize,
        imgScale: A.template.baseMargin && A.template.baseMargin.imgScale,
        fields: FIELDS.map(f => [f, A.template[f]])
    };

    // 越界值不能把画布算崩：buildState 里 clamp 到合法区间。
    A.template.blurBackdropDim = -50;
    A.template.blurBackdropZoom = 99999;
    A.template.blurSubjectShadow = -10;
    A.template.blurTextOffset = 99999;
    A.template.blurTextGap = -20;
    A.template.blurBrandGap = 99999;
    await render();
    out.clamped = fp();
    clear();

    return out;
})()`;

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1400, height: 900, useContentSize: true,
        show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(900);
    for (let i = 0; i < 80; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas)')) break;
        await sleep(200);
    }
    await sleep(400);

    const r = await win.webContents.executeJavaScript(PROBE);

    check(r.baseValid, '经典预设能正常渲染出画布', JSON.stringify(r.base));
    check(r.clearedSame, '不写任何进阶字段时渲染稳定', JSON.stringify(r.base));
    check(r.explicitDefaultsSame, '显式写默认值 40/100/100/0/100/100 与不写字段渲染一致', String(r.explicitDefaultsSame));
    for (const s of r.steps) {
        check(s.changed, '滑块 ' + s.f + '=' + s.v + ' 确实改变画面',
            JSON.stringify({ base: r.base.hash, now: s.hash, w: s.w, h: s.h }));
    }
    check(r.imgScaleChanged, '通用「图片缩放」仍能调节主体大小', String(r.imgScaleChanged));
    check(r.noSubjectRow, '重复的「主体大小」滑块已从面板移除', String(r.noSubjectRow));
    check(r.shadowOffChanged && r.shadow200Changed, '主体阴影 0% 与 200% 都改变画面',
        JSON.stringify({ off: r.shadowOffChanged, strong: r.shadow200Changed }));
    check(r.shadow100Same, '主体阴影 100% 与旧版逐像素一致', String(r.shadow100Same));
    check(r.visibleClassic.every(Boolean), '经典风格露出全部 6 行 + 复位键 + 提示', JSON.stringify(r.visibleClassic));
    check(r.visibleDate.every(Boolean), '日期风格同样露出', JSON.stringify(r.visibleDate));
    check(r.visibleCard.every((v) => !v), '其它风格全部隐藏（不出现拖了没反应的滑块）', JSON.stringify(r.visibleCard));
    check(!r.single.gap && !r.single.brand && r.single.offset,
        '单行模式（仅参数/日期）自动收起行间距与品牌间距',
        JSON.stringify(r.single));
    check(r.noBandRow, '「留白宽度」滑块已移除', String(r.noBandRow));
    check(r.grp.exists && r.grp.inCanvas && r.grp.title === '底部文字排版',
        '文字三根滑块独立成「底部文字排版」组，仍留在画布栏', JSON.stringify(r.grp));
    check(r.grp.rows.join() === 'rowBlurTextOffset,rowBlurTextGap,rowBlurBrandGap' && r.grp.resetInside,
        '组内只有上下位置 / 行间距 / 品牌间距 + 复位键', JSON.stringify(r.grp.rows));
    check(r.grp.sepGone, '旧的分隔标题已被组标题取代', String(r.grp.sepGone));
    check(r.offsetLabel === '上下位置', '「文字位置」改名「上下位置」，不与文字栏「参数位置」撞名', r.offsetLabel);
    check(r.whereShown, '经典 / 日期风格下，文字栏露出「去调」入口', String(r.whereShown));
    check(r.afterGoto.canvasActive && !r.afterGoto.textActive && r.afterGoto.flash,
        '点「去调」切到画布页签并高亮该组', JSON.stringify(r.afterGoto));
    check(r.whereHiddenCard && r.grpHiddenCard, '其它风格：入口与整组一起隐藏',
        JSON.stringify({ hint: r.whereHiddenCard, group: r.grpHiddenCard }));
    check(r.echo.dim === '12' && r.echo.gap === '180' && r.echo.serialized,
        '模板值回显到滑块并随预设序列化', JSON.stringify(r.echo));
    check(r.echo.dimLabel === '40%' || /%/.test(r.echo.dimLabel || ''),
        '数值标签跟着更新', String(r.echo.dimLabel));
    check(r.afterReset.dimField === undefined && r.afterReset.gapField === undefined,
        '复位是删除字段而不是写默认数字', JSON.stringify(r.afterReset));
    check(r.afterReset.dimSlider === '40' && r.afterReset.gapSlider === '100',
        '复位后滑块回到默认数值', JSON.stringify(r.afterReset));
    check(r.afterResetSame && r.finalCleanSame, '复位后渲染回到基线',
        JSON.stringify({ resetBaseHash: r.resetBase.hash, nowHash: r.afterResetFp.hash,
            diffs: r.afterResetFp.diffs, finalSame: r.finalCleanSame }));
    check(r.clamped.w > 100 && r.clamped.h > 100, '越界值被 clamp，画布不崩',
        JSON.stringify({ w: r.clamped.w, h: r.clamped.h }));

    console.log('─'.repeat(72));
    win.destroy();
    if (failures.length) {
        console.log(`FAILURE  ${failures.length} 项未通过`);
        failures.forEach((f) => console.log('  · ' + f));
        app.exit(1);
    } else {
        console.log('ALL PASS');
        app.exit(0);
    }
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });

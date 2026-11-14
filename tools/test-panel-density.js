// 参数栏减负回归：一行页签 / 密度分级 / 低频组默认折叠 / 状态收敛。
// 用法：node tools/run-electron.js tools/test-panel-density.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); }
    catch (_) { return null; }
});
const EMPTY = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, EMPTY);
for (const c of ['save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'quit-and-install', 'open-external', 'open-data-dir']) ipcMain.handle(c, OK);
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(c, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.25', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const prefCalls = [];
ipcMain.handle('save-prefs', (_e, patch) => {
    if (patch && typeof patch === 'object') prefCalls.push(patch);
    return { ok: true };
});

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label);
}

const PROBE = `(async () => {
    const A = window.App;
    const D = window.QfsPanelDensity;
    const $ = (id) => document.getElementById(id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!A || !D) return { missing: true };
    await wait(250);

    // ── 1. 页签收成一行 ──
    const allTabs = Array.prototype.slice.call(document.querySelectorAll('#inspTabs .tab[data-tab]'));
    const primary = allTabs.filter((t) => !t.closest('#tabMoreMenu')).map((t) => t.dataset.tab);
    const inMenu = allTabs.filter((t) => !!t.closest('#tabMoreMenu')).map((t) => t.dataset.tab);
    const sep = !!document.querySelector('#inspTabs .tab-sep, #inspTabs .tabs-tool-label');
    const tabsH = $('inspTabs').getBoundingClientRect().height;
    // 高度取整会卡在 45.5→46 的边界；直接按子项中心点判断是不是同一行。
    const tabRows = new Set(Array.prototype.slice.call($('inspTabs').children)
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => {
            const r = el.getBoundingClientRect();
            return Math.round((r.top + r.bottom) / 2 / 10);
        })).size;

    // ── 2. 更多菜单：打开 / 选中 / 回显 / 关闭 ──
    const moreBtn = $('btnTabMore');
    const menu = $('tabMoreMenu');
    moreBtn.click();
    const opened = !menu.hidden && moreBtn.getAttribute('aria-expanded') === 'true';
    // 「弹层没 hidden」不等于「用户看得见」：页签栏为了单行曾加 overflow-x:auto，
    // 祖先带 overflow 会把这层绝对定位的菜单整块裁掉（菜单高 169px、栏高 46px），
    // 点开就是一片空白。用命中测试断言它真的画在最上层。
    const mr = menu.getBoundingClientRect();
    const hitEl = document.elementFromPoint(
        Math.round(mr.left + mr.width / 2), Math.round(mr.top + mr.height / 2));
    const menuPaint = {
        inMenu: !!hitEl && !!hitEl.closest('#tabMoreMenu'),
        hit: hitEl ? (hitEl.id || hitEl.className || hitEl.tagName) : null,
        h: Math.round(mr.height)
    };
    menu.querySelector('[data-tab="template"]').click();
    await wait(60);
    const onTemplate = $('panel-template').classList.contains('active');
    const label = moreBtn.textContent.trim();
    const closed = menu.hidden;
    A.switchTab('grade');
    await wait(60);

    // ── 2b. 调色操作收进标题 + 降级 chip ──
    const gradeGrp = $('grpGrade');
    const gradeTitleText = ((gradeGrp.querySelector('.pg-title-text') || {}).textContent || '').trim();
    const oldActRow = Array.prototype.slice.call(gradeGrp.children)
        .some((el) => el.classList.contains('param-row') && el.classList.contains('grade-acts'));
    const gradeActionIds = ['btnGradeApplyAll', 'btnGradeApplySelected', 'btnGradeCopySet', 'btnGradePasteSet', 'btnGradeImportXmp']
        .filter((id) => !!$(id));
    $('btnGradeMore').click();
    const gradeMenuOpen = !$('gradeMoreMenu').hidden
        && $('btnGradeMore').getAttribute('aria-expanded') === 'true'
        && !gradeGrp.classList.contains('collapsed');
    document.body.click();
    const gradeMenuClosed = $('gradeMoreMenu').hidden;
    const sideDup = !!document.querySelector('.side-subhead > span');
    A.setEnvTag('简化调色', '测试：色表未加载');
    const envChip = { text: $('gradeEnvTag').textContent, hidden: $('gradeEnvTag').hidden };
    A.setEnvTag('');
    const envOff = $('gradeEnvTag').hidden;

    // ── 3. 低频组默认折叠 + 提示行 ──
    const defFolded = D.state().folded.slice();
    const noticeShown = !$('foldNotice').hidden;
    const noticeText = ($('foldNoticeText') || {}).textContent || '';
    $('btnExpandAll').click();
    const afterExpand = { folded: D.state().folded.length, noticeHidden: $('foldNotice').hidden };
    $('btnMenuFoldReset').click();
    const afterReset = D.state().folded.slice();

    // 折叠组不能被 syncEmptyGroups 当成「空组」把标题一起藏掉
    if (A.syncEmptyGroups) A.syncEmptyGroups();
    const foldAlive = ['grpMask', 'grpBw', 'grpCal'].map((id) => {
        const g = $(id);
        return { id, display: g ? getComputedStyle(g).display : 'missing',
                 inline: g ? g.style.display : '', empty: g ? (g.dataset.emptyCollapsed || '') : '' };
    });
    const titleAlive = foldAlive.every((x) => x.empty !== '1' && x.inline !== 'none');

    // ── 4. 密度分级 ──
    const insp = $('inspector');
    const densityVar = () => getComputedStyle(insp).getPropertyValue('--density').trim();
    A.switchTab('canvas');
    const autoCanvas = { compact: D.state().compact, density: densityVar() };
    A.switchTab('grade');
    const autoGrade = { compact: D.state().compact, density: densityVar() };
    $('btnDensityCompact').click();
    A.switchTab('canvas');
    const forcedCompact = D.state().compact;
    $('btnDensityComfortable').click();
    A.switchTab('grade');
    const forcedComfortable = D.state().compact;
    $('btnDensityAuto').click();
    A.switchTab('grade');
    const backAuto = { pref: D.state().density, compact: D.state().compact };

    // ── 5. 状态收敛 ──
    A.template = A.defaultTemplate();
    A.updatePersonalVisibility();
    // 状态栏的「样式 · …」由 applyModeControls 写入。以前只靠启动时的异步调用
    // 顺带写好，probe 早一步就读到空串 —— 同一份代码一会儿绿一会儿红。
    // 这里显式刷一次，断言的是「位置搬对了」而不是「启动时序碰巧赶上了」。
    if (typeof A.applyModeControls === 'function') A.applyModeControls();
    const modeHidden = getComputedStyle($('modeStatus')).display === 'none';
    const styleInStatus = ($('stStyle') || {}).textContent || '';
    const prevImage = A.image;
    A.image = { raw: { full: false, edge: 1600 }, w: 1600, h: 1069, path: 'x.arw', grade: null };
    A.syncRawUI();
    const rawProxy = { hidden: $('gradeRawTag').hidden, text: $('gradeRawTag').textContent };
    A.image.raw.full = true;
    A.syncRawUI();
    const rawFull = $('gradeRawTag').textContent;
    A.image = prevImage;
    A.syncRawUI();
    const rawOff = $('gradeRawTag').hidden;

    // ── 6. 折叠与密度都写进 prefs（字段级合并，不覆盖界面缩放）──
    const bwTitle = document.querySelector('#grpBw .pg-title.collapsible');
    bwTitle.click();
    $('btnDensityCompact').click();
    $('btnDensityAuto').click();
    $('btnMenuFoldReset').click();

    // ── 7. 最窄栏宽下页签不横向溢出 ──
    insp.style.width = '260px';
    await wait(140);
    const narrow = { sw: $('inspTabs').scrollWidth, cw: $('inspTabs').clientWidth };
    insp.style.width = '';

    return {
        primary, inMenu, sep, tabsH, tabRows, opened, menuPaint, onTemplate, label, closed,
        gradeTitleText, oldActRow, gradeActionIds, gradeMenuOpen, gradeMenuClosed,
        sideDup, envChip, envOff,
        defFolded, noticeShown, noticeText, afterExpand, afterReset, titleAlive, foldAlive,
        autoCanvas, autoGrade, forcedCompact, forcedComfortable, backAuto,
        modeHidden, styleInStatus, rawProxy, rawFull, rawOff,
        narrow
    };
})()`;

async function main() {
    const win = new BrowserWindow({
        width: 1440, height: 960, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await win.webContents.executeJavaScript(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    let res = null;
    try { res = await win.webContents.executeJavaScript(PROBE); }
    catch (e) { check(false, '探针执行', String(e && e.message)); }
    if (res) {
        if (res.missing) check(false, '模块已加载', 'QfsPanelDensity 未定义');
        check(res.primary.join(',') === 'canvas,text,border,grade,logo'
            && res.inMenu.join(',') === 'template,puzzle,grid' && !res.sep
            && res.tabRows === 1 && res.tabsH < 60,
            '页签收成一行：主 5 个 + 更多 3 个，高度不再占两排',
            JSON.stringify({ primary: res.primary, inMenu: res.inMenu, sep: res.sep, h: res.tabsH, rows: res.tabRows }));
        check(res.menuPaint && res.menuPaint.inMenu,
            '「更多」弹层真的画出来了（不被页签栏 overflow 裁掉）',
            JSON.stringify(res.menuPaint));
        check(res.opened && res.onTemplate && res.closed && /样式/.test(res.label),
            '更多菜单可开合，切到隐藏页签后按钮回显当前页签名',
            JSON.stringify({ opened: res.opened, onTemplate: res.onTemplate, closed: res.closed, label: res.label }));
        check(res.gradeTitleText === '基础' && !res.oldActRow && res.gradeActionIds.length === 5,
            '调色操作收进组标题，原来的五按钮行不再占位',
            JSON.stringify({ title: res.gradeTitleText, oldActRow: res.oldActRow, ids: res.gradeActionIds }));
        check(res.gradeMenuOpen && res.gradeMenuClosed,
            '调色「⋯」菜单可开合，点标题里的按钮不会误收起整组',
            JSON.stringify({ open: res.gradeMenuOpen, closed: res.gradeMenuClosed }));
        check(!res.sideDup && res.envChip.text === '简化调色' && !res.envChip.hidden && res.envOff,
            '重复的「边框」小标题已移除；降级提示收进直方图 chip',
            JSON.stringify({ sideDup: res.sideDup, env: res.envChip, off: res.envOff }));
        check(res.defFolded.join(',') === 'grpMask,grpBw,grpCb,grpGm,grpLc,grpCal',
            '六组低频参数默认收起', res.defFolded.join(','));
        check(res.noticeShown && /组已收起/.test(res.noticeText),
            '折叠提示写明收了几组、怎么展开', res.noticeText);
        check(res.afterExpand.folded === 0 && res.afterExpand.noticeHidden
            && res.afterReset.length === 6,
            '全部展开后提示消失；恢复默认折叠可以再收回去',
            JSON.stringify(res.afterExpand) + ' / ' + res.afterReset.length);
        check(res.titleAlive, '折叠组不会被空组收敛逻辑连标题一起藏掉', JSON.stringify(res.foldAlive));
        check(res.autoCanvas.compact === false && res.autoGrade.compact === true
            && res.autoGrade.density !== res.autoCanvas.density,
            '自动档：调色页紧凑、其余页签舒适',
            JSON.stringify({ canvas: res.autoCanvas, grade: res.autoGrade }));
        check(res.forcedCompact === true && res.forcedComfortable === false,
            '设置里可强制全程紧凑 / 全程舒适',
            `compact=${res.forcedCompact} comfortable=${res.forcedComfortable}`);
        check(res.backAuto.pref === 'auto' && res.backAuto.compact === true,
            '切回自动档恢复「调色紧凑」', JSON.stringify(res.backAuto));
        check(res.modeHidden && /样式 · /.test(res.styleInStatus),
            '当前样式条从参数栏顶部移到状态栏', res.styleInStatus);
        check(res.rawProxy.hidden === false && res.rawProxy.text === 'RAW 代理'
            && res.rawFull === 'RAW 全尺寸' && res.rawOff === true,
            'RAW 显影阶段并进直方图卡，导出非 RAW 时自动收起',
            JSON.stringify({ proxy: res.rawProxy, full: res.rawFull, off: res.rawOff }));
        const foldCall = prefCalls.some((c) => c.panelFolds && c.panelFolds.grpBw === false);
        const densityCall = prefCalls.some((c) => c.panelDensity === 'compact');
        const noOverwrite = prefCalls.every((c) => !('fontScale' in c) && !('theme' in c));
        check(foldCall && densityCall && noOverwrite,
            '折叠状态与密度写入 prefs，且不会覆盖界面缩放 / 主题等其它字段',
            JSON.stringify({ fold: foldCall, density: densityCall, noOverwrite, n: prefCalls.length }));
        check(res.narrow.sw <= res.narrow.cw + 1,
            '260px 最窄栏宽下页签不横向溢出',
            JSON.stringify(res.narrow));
    }

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

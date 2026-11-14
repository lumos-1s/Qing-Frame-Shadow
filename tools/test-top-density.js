// 顶栏收纳 + 左侧预设树收拢 + 边框参数空态回归。
// 2026-11 布局收口后，顶栏保留「导入 / 导出 / 复制 / 撤销 / 重做 / ⋯ / 适应」，
// 文件夹入口收进「导入 ▾」，同步 / 重置 / 随机收进「⋯」。这里冻结这套形态。
// 用法：node tools/run-electron.js tools/test-top-density.js
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
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
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
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label);
}

const PROBE = `(async () => {
    const A = window.App;
    const $ = (id) => document.getElementById(id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!A) return { missing: true };
    await A.loadPresets();
    try {
        localStorage.removeItem('qfs_preset_groups');
        localStorage.removeItem('qfs_side_mode');
    } catch (_) {}
    A.setSideMode('border');
    // 「最近使用」分组只在 localStorage 里真有记录时才渲染，而记录来自启动后的
    // 异步副作用（一会儿有一条、一会儿没有）。显式造一条，让断言不再看运气。
    try {
        const names = (A.presets || []).map(p => p.templateName).filter(Boolean).slice(0, 1);
        if (names.length) localStorage.setItem('qfs_recent_presets', JSON.stringify(names));
    } catch (_) {}
    A.buildTree('');
    await wait(120);

    // ── 1. 顶栏收纳：主操作常驻，文件夹进「导入 ▾」，同步/重置/随机进「⋯」──
    const allBtns = Array.prototype.slice.call(document.querySelectorAll('#toolbar button'));
    const visible = allBtns.filter((b) => b.offsetParent !== null);
    const labels = visible.map((b) => (b.textContent || '').trim()).filter(Boolean);
    const folderInPop = !!($('btnOpenFolder') && $('btnOpenFolder').closest('#importPop'));
    const moreItems = ['btnSyncSel', 'btnReset', 'btnRandom'].every((id) => {
        const el = $(id);
        return !!el && !!el.closest('#toolbarMoreMenu');
    });
    const moreMenu = $('toolbarMoreMenu'), importPop = $('importPop');
    const moreHidden = !!(moreMenu && moreMenu.hidden);
    $('btnToolbarMore').click();
    const moreOpened = !!(moreMenu && !moreMenu.hidden)
        && $('btnToolbarMore').getAttribute('aria-expanded') === 'true';
    $('btnToolbarMore').click();
    const moreClosed = !!(moreMenu && moreMenu.hidden);
    const importHidden = !!(importPop && importPop.hidden);
    $('btnImportMore').click();
    const importOpened = !!(importPop && !importPop.hidden);
    document.body.click();
    const menusClosed = !!(importPop && importPop.hidden) && !!(moreMenu && moreMenu.hidden);
    const themeInRight = !!($('btnTheme') && $('btnTheme').closest('.toolbar-group.right'));
    const g = document.querySelector('.toolbar-group');
    const cs = g ? getComputedStyle(g) : null;
    const pillBack = !!cs && cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
        && cs.backgroundColor !== 'transparent' && parseFloat(cs.borderTopWidth) > 0;

    // ── 3. 左侧分组默认展开状态 ──
    const tree = $('presetTree');
    const groups = Array.prototype.slice.call(tree.querySelectorAll('.preset-group'));
    const openNames = groups.filter((x) => x.classList.contains('open'))
        .map((x) => (x.querySelector('.group-name') || {}).textContent || '');
    const visibleItems = () => Array.prototype.slice.call(tree.querySelectorAll('.preset-item'))
        .filter((el) => getComputedStyle(el).display !== 'none').length;
    const defaultVisible = visibleItems();
    const recent = groups.find((x) => /最近使用/.test(x.textContent || ''));
    const recentCollapsed = !!recent && !recent.classList.contains('open');
    const recentCount = recent ? recent.querySelectorAll('.preset-item').length : -1;

    // 手动展开一组 → 写盘 → 重建后仍展开
    const closed = groups.find((x) => !x.classList.contains('open') && x.querySelector('.group-name[draggable]'));
    let persisted = null, rebuiltOpen = null;
    if (closed) {
        // 组头文本以「▸ + emoji + 组名 · 数量」开头，键只要中文组名
        const key = (closed.querySelector('.group-name').textContent || '').trim()
            .split(' · ')[0].replace(/^[^\u4e00-\u9fa5]+/, '');
        closed.querySelector('.group-name').click();
        persisted = key;
        const raw = localStorage.getItem('qfs_preset_groups');
        const st = raw ? JSON.parse(raw) : {};
        persisted = { key, saved: st[key], beforeRebuild: visibleItems() };
        A.buildTree('');
        rebuiltOpen = !!Array.prototype.slice.call(tree.querySelectorAll('.preset-group'))
            .find((x) => x.classList.contains('open') && (x.querySelector('.group-name') || {}).textContent.includes(key));
    }

    // 搜索时强制展开命中组，结果不能藏在折叠里
    A.filterTree('参数');
    const searchOpen = Array.prototype.slice.call(tree.querySelectorAll('.preset-group.open')).length;
    const searchVisible = visibleItems();
    A.filterTree('');

    // ── 4. 左侧栏不再有「可编辑边框」筛选：DOM / 状态 / 方法三处都不能剩 ──
    // 用户明确要求不要这个入口。它原来是常驻在搜索框下方的一枚 chip，
    // 现在左侧栏只留「搜索 + 预设树」，所以这里反向守着：万一哪天又长回来，测试会先红。
    try { localStorage.removeItem('qfs_recent_presets'); localStorage.removeItem('qfs_fav_presets'); } catch (_) {}
    A.buildTree('');
    const editableExpected = A.presets.filter(p => A.isEditablePreset(p)).length;
    const filterGone = {
        row: !!document.getElementById('sideFilterRow'),
        btn: !!$('btnPresetEditable'),
        label: !!$('presetEditableCount'),
        fn: typeof A.togglePresetEditable,
        allVisible: tree.querySelectorAll('.preset-item').length
    };
    try { localStorage.removeItem('qfs_preset_groups'); } catch (_) {}

    // ── 5. 边框参数页按渲染管线切换：图层组 / 预设说明卡 ──
    const findPreset = (fn) => (A.presets || []).find(fn);
    const styleP = findPreset(p => {
        const pf = String(p.photoFrameStyle || '').toUpperCase();
        return !!pf && pf !== 'NONE';
    });
    const layerP = findPreset(p => A.isEditablePreset(p));
    const cardP = findPreset(p => (((p.baseMargin || {}).bgBlurEnable) || 0) === 1);
    const savedTpl = A.template;
    const clone = (p) => JSON.parse(JSON.stringify(p));
    const layerGroupsVisible = () => Array.prototype.slice.call(document.querySelectorAll('#panel-border .ctl-grp-layers'))
        .filter(el => el.style.display !== 'none').length;
    const stateInfo = () => ({
        visible: !!$('borderPresetState') && !$('borderPresetState').hidden,
        kind: $('borderPresetState') ? ($('borderPresetState').dataset.kind || '') : '',
        title: $('borderPresetTitle') ? $('borderPresetTitle').textContent : '',
        text: $('borderPresetText') ? $('borderPresetText').textContent : '',
        count: ($('borderEditableCount') || {}).textContent || ''
    });
    A.template = clone(styleP); A.applyModeControls();
    const styleState = Object.assign(stateInfo(), { groups: layerGroupsVisible() });
    A.template = clone(layerP); A.applyModeControls();
    const layerState = Object.assign(stateInfo(), { groups: layerGroupsVisible() });
    A.template = clone(cardP); A.applyModeControls();
    const cardState = Object.assign(stateInfo(), { groups: layerGroupsVisible() });
    // 空态只剩「去风格墙挑选」：原来那枚「筛出可编辑边框」的按钮随筛选一起移除
    A.template = clone(styleP); A.applyModeControls();
    const ctaState = {
        cta: !!$('btnBorderBackWall'),
        pick: !!$('btnBorderPickEditable')
    };
    A.template = savedTpl; A.applyModeControls();

    return {
        labels, folderInPop, moreItems, moreHidden, moreOpened, moreClosed,
        importHidden, importOpened, menusClosed, themeInRight, pillBack,
        openNames, defaultVisible, recentCollapsed, recentCount,
        persisted, rebuiltOpen, searchOpen, searchVisible, groupCount: groups.length,
        filterGone, editableExpected, styleState, layerState, cardState, ctaState,
        hasStyleP: !!styleP, hasLayerP: !!layerP, hasCardP: !!cardP
    };
})()`;

async function main() {
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false, paintWhenInitiallyHidden: true,
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
        if (res.missing) check(false, '模块已加载', 'App 未定义');
        check(res.labels.some((l) => l.includes('导入')) && /导出/.test(res.labels.join(''))
            && /撤销/.test(res.labels.join('')) && /⋯/.test(res.labels.join('')),
            '顶栏常驻主操作（导入 / 导出 / 撤销 / 更多）', JSON.stringify(res.labels));
        check(res.folderInPop && res.moreItems,
            '文件夹入口在「导入 ▾」内，同步/重置/随机在「⋯」内',
            JSON.stringify({ folderInPop: res.folderInPop, moreItems: res.moreItems }));
        check(res.moreHidden && res.moreOpened && res.moreClosed,
            '「⋯」默认收起，点开/再点收起且 aria-expanded 同步',
            JSON.stringify({ hidden: res.moreHidden, opened: res.moreOpened, closed: res.moreClosed }));
        check(res.importHidden && res.importOpened && res.menusClosed,
            '「导入 ▾」默认收起，点开后可再次点空白处关闭',
            JSON.stringify({ hidden: res.importHidden, opened: res.importOpened, closed: res.menusClosed }));
        check(res.pillBack, '工具组 pill 底色与边框已恢复');
        check(res.themeInRight, '主题按钮回到右侧工具组（设置里那个也仍在）');
        check(res.openNames.filter((n) => !/最近使用|收藏/.test(n)).length <= 1,
            '默认只展开一个常规分组（当前选中项所在组）', JSON.stringify(res.openNames));
        check(res.recentCollapsed && res.recentCount > 0 && res.recentCount <= 4,
            '「最近使用」默认收起且最多 4 项', JSON.stringify({ collapsed: res.recentCollapsed, n: res.recentCount }));
        check(res.defaultVisible > 0 && res.defaultVisible <= 8,
            '默认可见的预设条目不超过 8 行（原来两组同时展开有 12+ 行）', String(res.defaultVisible));
        check(!!res.persisted && res.persisted.saved === true && res.rebuiltOpen === true,
            '手动展开的分组写进 localStorage，重建后仍展开',
            JSON.stringify({ persisted: res.persisted, rebuiltOpen: res.rebuiltOpen }));
        check(res.searchOpen > 0 && res.searchVisible > 0,
            '搜索时命中组强制展开，结果不会被折叠藏住',
            JSON.stringify({ open: res.searchOpen, visible: res.searchVisible }));
        check(res.hasStyleP && res.hasLayerP && res.hasCardP,
            '三类预设（相框 / 图层 / 卡片）都能在预设池里找到',
            JSON.stringify({ style: res.hasStyleP, layer: res.hasLayerP, card: res.hasCardP }));
        check(res.filterGone.row === false && res.filterGone.btn === false
            && res.filterGone.label === false && res.filterGone.fn === 'undefined'
            && res.filterGone.allVisible > res.editableExpected,
            '「可编辑边框」筛选已从左侧栏移除（DOM / 文案 / 方法都不再存在）',
            JSON.stringify(res.filterGone));
        check(res.styleState.visible && res.styleState.groups === 0
            && res.styleState.kind === 'frame' && /预设绘制/.test(res.styleState.title)
            && /填充、描边、圆角、阴影/.test(res.styleState.text)
            && res.styleState.count === String(res.editableExpected),
            '相框预设：图层组隐藏，空态说明 + 可编辑数量出现',
            JSON.stringify(res.styleState));
        check(!res.layerState.visible && res.layerState.groups >= 5
            && res.layerState.kind === 'layer',
            '图层预设：5 个边框参数组正常显示，空态卡片隐藏',
            JSON.stringify(res.layerState));
        check(res.cardState.visible && res.cardState.groups === 0
            && res.cardState.kind === 'card' && /卡片/.test(res.cardState.title),
            '卡片预设：也给出对应说明，不留空面板',
            JSON.stringify(res.cardState));
        check(res.ctaState.cta && !res.ctaState.pick,
            '空态只留「去风格墙挑选」，不再出现已移除的筛选按钮',
            JSON.stringify(res.ctaState));
    }

    // 静态检查：状态栏引导语别再指错方向
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'app.js'), 'utf8');
    check(!/点右上角「导入照片」/.test(appSrc) && /点工具栏左侧「导入照片」/.test(appSrc),
        '示例照片提示改为「工具栏左侧」（按钮本来就在左上）');
    // 四角装饰括号已没有 UI；只保留预设自带值（「杂志大刊头」）。
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
    check(!/cbCornerDecorType|四角装饰括号/.test(htmlSrc) && !/syncCornerDecorState/.test(appSrc),
        '四角装饰括号的控件与联动代码已移除');

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

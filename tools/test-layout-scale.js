// 布局压力回归：1000×700 窗口 + 140% 界面缩放。
// 锁死三件最容易坏的事：页签不换行、顶栏右侧按钮不出屏、参数标签不竖排。
// 用法：node tools/run-electron.js tools/test-layout-scale.js
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
// 关键：启动 prefs 直接给 140%，让真实启动路径跑一遍缩放。
ipcMain.handle('get-prefs', () => ({ fontScale: 1.4, theme: 'dark' }));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.25', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));

async function main() {
    const win = new BrowserWindow({
        width: 1000, height: 700, useContentSize: true,
        show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await win.webContents.executeJavaScript(`(() => {
        try {
            localStorage.setItem('qfs_intro_done', '1');
            localStorage.removeItem('qfs_sidebar_collapsed');
            localStorage.removeItem('qfs_inspector_collapsed');
            localStorage.removeItem('qfs_settings_tab');
            // 这些宽度是用户拖拽后持久化的。上一次手工把参数栏拖到 236px 时，
            // 容器查询会把页签内边距改成 4px，收起按钮贴着窗口边 4px；
            // 下面的「不出屏」断言就会拿到因机器状态而异的 right，误报为回归。
            localStorage.removeItem('qfs_inspector_width');
            localStorage.removeItem('qfs_sidebar_width');
        } catch (_) {}
        return true;
    })()`);
    // 先清掉上一次测试可能留下的收起状态，再重载一次，让 initPanelCollapse 走「用户没手动设过」的分支。
    await win.webContents.reload();
    await sleep(400);
    for (let i = 0; i < 80; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.inspector)')) break;
        await sleep(200);
    }
    await sleep(500);

    const exec = (expr) => win.webContents.executeJavaScript(expr);
    const base = await exec(`(() => {
        const A = window.App;
        A.buildTree('');
        A.setSideMode('border');
        A.syncToolbarOverflow();
        const tb = document.getElementById('toolbar');
        const tabsWrap = document.getElementById('inspTabs');
        const tabs = [...tabsWrap.querySelectorAll('.tab')].filter((t) => t.getClientRects().length > 0);
        const vis = (el) => !!el && el.getClientRects().length > 0;
        // 「顶栏按钮不出屏」只量真正的顶栏按钮。参数栏的收起按钮在右栏最右端，
        // 设计上就允许离窗口边只有几像素（窄栏时容器查询把内边距压到 4px），
        // 混在一起量会让断言随用户上次拖过的栏宽时红时绿。
        const rightEls = ['btnSettings', 'btnTheme']
            .map((id) => document.getElementById(id)).filter(vis);
        const collapseEl = document.getElementById('btnInspectorCollapse');
        return {
            scale: getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim(),
            innerW: window.innerWidth, innerH: window.innerHeight,
            sidebarCollapsed: document.body.classList.contains('sidebar-collapsed'),
            railVisible: vis(document.getElementById('btnSidebarRail')),
            toolbar: {
                tight: tb.classList.contains('toolbar-tight'),
                scrollW: Math.round(tb.scrollWidth),
                clientW: Math.round(tb.clientWidth),
                labels: [...tb.querySelectorAll('.tbtn-label')].filter(vis).length
            },
            rightmost: rightEls.length ? Math.round(Math.max(...rightEls.map((el) => el.getBoundingClientRect().right))) : -1,
            collapseRight: (collapseEl && vis(collapseEl)) ? Math.round(collapseEl.getBoundingClientRect().right) : -1,
            tabsWrapH: Math.round(tabsWrap.getBoundingClientRect().height),
            tabMaxH: tabs.reduce((m, t) => Math.max(m, t.getBoundingClientRect().height), 0),
            tabs: tabs.map((t) => ({
                text: t.textContent.trim(),
                h: Math.round(t.getBoundingClientRect().height),
                single: t.scrollHeight <= t.clientHeight + 1,
                nowrap: getComputedStyle(t).whiteSpace === 'nowrap'
            })),
            tabsWrapScrollW: Math.round(tabsWrap.scrollWidth),
            tabsWrapClientW: Math.round(tabsWrap.clientWidth)
        };    })()`);

    check(base.scale === '1.4' && base.innerW <= 1004,
        '启动即 140% 界面缩放 / 1000px 窗口', JSON.stringify({ scale: base.scale, w: base.innerW }));
    // 行高不写死像素：140% + 系统字体不同，单个页签本身就有 30~35px。
    // 真正的回归是「页签变成两排/竖排」——那会达到单行高度的两倍左右。
    check(base.tabs.length >= 6 && base.tabs.every((t) => t.nowrap && t.single)
        && base.tabsWrapH <= base.tabMaxH + 24,
        '140% 下页签保持单行、没有竖排换行',
        JSON.stringify({ rowH: base.tabsWrapH, tabMaxH: Math.round(base.tabMaxH), tabs: base.tabs }));
    check(base.tabsWrapScrollW <= base.tabsWrapClientW + 1,
        '页签整行不横向溢出（短导航不出现滚动条）',
        `${base.tabsWrapScrollW} / ${base.tabsWrapClientW}`);

    // 参数栏拖到最窄（236px）时，六个页签仍要各自完整显示。
    // 之前容器查询把字号降到 11px，但 .tab 的 transition: all 让字号/内边距
    // 一直停在过渡中间，窄栏里实际被截掉 4~7px。
    const narrow = await exec(`(async () => {
        const insp = document.getElementById('inspector');
        const prev = insp.style.width;
        insp.style.width = '236px';
        await new Promise((r) => setTimeout(r, 160));
        const wrap = document.getElementById('inspTabs');
        const tabs = [...wrap.querySelectorAll('.tab')].filter((t) => t.getClientRects().length > 0);
        const res = {
            w: Math.round(insp.getBoundingClientRect().width),
            font: tabs.length ? getComputedStyle(tabs[0]).fontSize : '',
            clipped: tabs.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent.trim()),
            wrapOver: wrap.scrollWidth > wrap.clientWidth + 1,
            parts: tabs.map((t) => t.textContent.trim() + ':' + t.clientWidth + '/' + t.scrollWidth)
        };
        insp.style.width = prev;
        return res;
    })()`);
    check(narrow.w === 236 && !narrow.wrapOver && narrow.clipped.length === 0,
        '236px 最窄参数栏 + 140%：页签文字不被截断',
        JSON.stringify(narrow));

    check(base.toolbar.scrollW <= base.toolbar.clientW + 1,
        '140% 下顶栏内容不溢出（自动退成图标模式）',
        JSON.stringify(base.toolbar));
    check(base.rightmost > 0 && base.rightmost <= base.innerW - 8,
        '顶栏最右侧按钮（设置）完整留在窗口内', String(base.rightmost));
    check(base.collapseRight > 0 && base.collapseRight <= base.innerW - 1,
        '参数栏收起按钮完整留在窗口内', String(base.collapseRight));
    check(base.sidebarCollapsed && base.railVisible,
        '1000px 窄窗口自动收起左侧素材栏，并留出展开轨', JSON.stringify({ c: base.sidebarCollapsed, rail: base.railVisible }));

    // 参数标签：切到「边框参数」页，检查可见标签是否单行。
    const labels = await exec(`(() => {
        const A = window.App;
        A.switchTab('border');
        const list = [...document.querySelectorAll('#inspector .param-row > label')]
            .filter((el) => el.getClientRects().length > 0);
        const lineOf = (el) => {
            const cs = getComputedStyle(el);
            const lh = parseFloat(cs.lineHeight);
            const fs = parseFloat(cs.fontSize) || 16;
            return lh > 0 ? lh : fs * 1.6;
        };
        return {
            count: list.length,
            nowrap: list.every((el) => getComputedStyle(el).whiteSpace === 'nowrap'),
            heights: list.map((el) => Math.round(el.getBoundingClientRect().height)),
            lines: list.map((el) => Math.round(el.getBoundingClientRect().height / lineOf(el)))
        };
    })()`);
    check(labels.count > 3 && labels.nowrap && labels.lines.every((n) => n <= 1),
        '140% 下参数标签保持单行（不再逐字竖排）', JSON.stringify(labels).slice(0, 220));

    // 设置弹窗：140% 下宽度不超窗、页签单行、内容区可滚。
    await exec(`window.App.openSettings()`);
    await sleep(250);
    const settings = await exec(`(() => {
        const card = document.querySelector('#settingsModal .settings-card');
        const tabs = [...document.querySelectorAll('#settingsModal .settings-tab')];
        const body = document.querySelector('#settingsModal .settings-body');
        const general = document.querySelector('#settingsModal [data-settings-panel="general"]');
        const r = card.getBoundingClientRect();
        const labels = [...general.querySelectorAll('.settings-label')];
        return {
            w: Math.round(r.width), h: Math.round(r.height),
            left: Math.round(r.left), right: Math.round(r.right),
            innerW: window.innerWidth, innerH: window.innerHeight,
            tabs: tabs.map((t) => ({ text: t.textContent.trim(), h: Math.round(t.getBoundingClientRect().height), single: t.scrollHeight <= t.clientHeight + 1 })),
            tabsInside: tabs.every((t) => t.getBoundingClientRect().right <= r.right + 1),
            scrollable: body.scrollHeight > body.clientHeight + 1,
            labelLines: labels.map((l) => {
                const cs = getComputedStyle(l);
                const lh = parseFloat(cs.lineHeight);
                const fs = parseFloat(cs.fontSize) || 16;
                return Math.round(l.getBoundingClientRect().height / (lh > 0 ? lh : fs * 1.6));
            })
        };
    })()`);
    check(settings.left >= 0 && settings.right <= settings.innerW && settings.w <= settings.innerW,
        '140% 下设置弹窗完整落在窗口内', JSON.stringify({ w: settings.w, l: settings.left, r: settings.right, vw: settings.innerW }));
    check(settings.h <= settings.innerH && settings.scrollable,
        '140% 下设置弹窗不超出窗口高度，内容区内部滚动', JSON.stringify({ h: settings.h, vh: settings.innerH, scroll: settings.scrollable }));
    check(settings.tabs.every((t) => t.h > 0 && t.single) && settings.tabsInside,
        '140% 下设置页签单行且不超出卡片', JSON.stringify(settings.tabs));
    check(settings.labelLines.every((n) => n <= 1),
        '140% 下设置标签不折行', JSON.stringify(settings.labelLines));

    await exec(`window.App.closeSettings()`);

    // 状态栏视觉层级：引导语 / 批量导入提示中性化，成功绿只留给真正的操作结果。
    // 140% 下这是最容易忽略的一处「颜色抢视线」，固化成断言防止改回绿色。
    const statusProbe = await exec(`(() => {
        const A = window.App;
        const el = document.getElementById('stCanvas');
        const info = document.getElementById('stInfo');
        const snap = (msg) => { A.setStatus(msg); return { cls: el.className, text: el.textContent }; };
        const guide = snap('已进入工作台，从左侧工具栏导入照片开始');
        const imported = snap('已导入 3 张图片，跳过 1 个不支持的文件');
        const ok = snap('导出成功');
        A.setStatus('');
        return { guide, imported, ok, infoColor: getComputedStyle(info).color };
    })()`);
    check(/st-hint/.test(statusProbe.guide.cls) && !/st-ok|st-err/.test(statusProbe.guide.cls),
        '引导语用中性色，不再挂成功绿', statusProbe.guide.cls);
    check(/st-hint/.test(statusProbe.imported.cls)
        && /已导入 3 张图片/.test(statusProbe.imported.text)
        && /跳过 1 个/.test(statusProbe.imported.text),
        '批量导入结果降权但完整保留跳过数等信息', statusProbe.imported.cls);
    check(/st-ok/.test(statusProbe.ok.cls),
        '真正的操作结果仍是成功绿', statusProbe.ok.cls);
    check(!!statusProbe.infoColor && statusProbe.infoColor !== 'rgba(0, 0, 0, 0)',
        '文件信息有独立可读的前景色', statusProbe.infoColor);

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

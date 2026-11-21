// 预设墙顶部栏：窗口变窄 / 界面缩放放大时，左侧报头（品牌行）不得被右侧控件压住，
// 且**始终与控件同处一行**——曾经按 1450px 一刀切换成两行，品牌孤零零留在上面、控件另起一行，
// 看起来像整条顶栏错位了。现在窄窗只压缩装饰与间距，不换行。
// 用法: node tools/run-electron.js tools/test-preset-wall-head.js
'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('list-wall-covers', () => []);
ipcMain.handle('list-grade-presets', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);
for (const channel of ['save-image-base64', 'save-images-batch', 'save-template', 'load-template',
    'delete-template', 'rename-template', 'export-template', 'import-template', 'export-qfs',
    'open-qfs', 'save-user', 'logout-user', 'open-external', 'open-data-dir', 'copy-text',
    'check-for-updates', 'start-update-download', 'quit-and-install']) {
    ipcMain.handle(channel, () => ({ ok: true }));
}
for (const channel of ['open-images', 'open-sticker-image', 'pick-export-location',
    'write-export-files', 'read-exif', 'open-image', 'pick-default-export-dir']) {
    ipcMain.handle(channel, () => ({ canceled: true }));
}

const MEASURE = `(() => {
    const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        // display:contents 的元素自身没有盒子，仍按 DOM 返回但尺寸为 0，重叠判定会自然跳过
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                 right: Math.round(r.right), bottom: Math.round(r.bottom), sw: el.scrollWidth, cw: el.clientWidth };
    };
    const m = {};
    for (const k of ['brand', 'meta', 'tools', 'acts', 'winbtns', 'right', 'head', 'rail', 'grid']) {
        const sel = { brand: '.pw-brand', meta: '.pw-head-meta',
            tools: '.pw-head-tools', acts: '.pw-head-acts', winbtns: '.pw-winbtns',
            right: '.pw-head-right', head: '.pw-head', rail: '.pw-rail', grid: '.pw-grid' }[k];
        m[k] = pick(sel);
    }
    m.vw = innerWidth;
    m.headStyle = getComputedStyle(document.querySelector('.pw-head')).display;
    return m;
})()`;

const overlap = (A, B) => !!(A && B && A.w > 0 && B.w > 0
    && A.right > B.x && B.right > A.x && A.bottom > B.y && B.bottom > A.y);

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#10171a',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await sleep(400);
    win.showInactive();
    await exec(`(() => {
        try {
            localStorage.setItem('qfs_intro_done', '1');
            localStorage.removeItem('qfs_wall_mode');
            localStorage.removeItem('qfs_wall_card_scale');
        } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1400);
    await exec(`(() => {
        if (window.App && App.initPresetWall) App.initPresetWall();
        if (window.App && App.openPresetWall) App.openPresetWall(false);
        if (window.App && App.setWallMode) App.setWallMode('finite');
        return true;
    })()`);
    await sleep(700);

    const verify = async (label) => {
        const m = await exec(MEASURE);
        const pairs = [
            ['brand', 'tools'], ['brand', 'acts'], ['brand', 'winbtns'],
            ['meta', 'tools'], ['meta', 'acts'], ['meta', 'winbtns']
        ];
        const bad = pairs.filter(([a, b]) => overlap(m[a], m[b])).map((p) => p.join('/'));
        check(bad.length === 0, `${label}：品牌报头与右侧控件无重叠`, JSON.stringify(bad));
        check(m.brand && m.brand.w > 0 && m.brand.sw <= m.brand.cw + 1,
            `${label}：品牌行文字没有溢出自己的盒子`, JSON.stringify(m.brand));
        check(m.tools && m.acts && m.winbtns && m.head
            && m.tools.bottom <= m.head.bottom + 1
            && m.acts.bottom <= m.head.bottom + 1
            && m.winbtns.bottom <= m.head.bottom + 1,
            `${label}：三组控件都留在顶部栏内`, JSON.stringify({ head: m.head, tools: m.tools, acts: m.acts }));
        check(m.rail && m.head && m.grid && m.rail.h > 0
            && m.rail.y >= m.head.bottom - 1 && m.rail.bottom <= m.grid.bottom + 2,
            `${label}：有限墙进度条贴在网格内，不穿进头部`,
            JSON.stringify({ rail: m.rail, headBottom: m.head && m.head.bottom, gridBottom: m.grid && m.grid.bottom }));
        // 一行布局：控件组与报头块底边对齐；换行时控件会整体落到报头下方，底边必然对不上。
        check(m.right && m.meta && Math.abs(m.right.bottom - m.meta.bottom) <= 5
            && m.right.y < m.meta.bottom - 2,
            `${label}：控件与品牌同处一行`,
            JSON.stringify({ metaBottom: m.meta && m.meta.bottom, rightY: m.right && m.right.y, rightBottom: m.right && m.right.bottom }));
        // 换行会让顶栏长高（两行 = 报头高 + 行距 + 控件高），单行高度不该超过最高的那组。
        const oneRowMax = Math.max(m.meta ? m.meta.h : 0, m.right ? m.right.h : 0) + 42;
        check(m.head && m.head.h <= oneRowMax,
            `${label}：顶栏没有被撑成两行`, JSON.stringify({ headH: m.head && m.head.h, oneRowMax: oneRowMax }));
    };

    for (const w of [1000, 1100, 1200, 1300, 1400, 1600]) {
        win.setContentSize(w, 780);
        await sleep(450);
        await verify(`${w}px`);
    }

    // 界面缩放 140% 时，控件变宽最容易把标题挤掉；只测最小宽度这个极端
    await exec(`(() => { if (window.App && App.applyFontScale) App.applyFontScale(1.4); return true; })()`);
    await sleep(300);
    win.setContentSize(1000, 780);
    await sleep(450);
    await verify('1000px@140%');
    await exec(`(() => { if (window.App && App.applyFontScale) App.applyFontScale(1); return true; })()`);

    console.log(failures.length
        ? `\n未通过 ${failures.length} 项：` + failures.map((f) => '\n - ' + f).join('')
        : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
    console.error('FAIL', e && e.stack ? e.stack : e);
    app.exit(1);
});

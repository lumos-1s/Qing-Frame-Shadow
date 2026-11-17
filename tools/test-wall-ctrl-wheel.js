// 预设墙 Ctrl/Cmd + 滚轮缩放回归：缩放卡片、不平移墙、不触发页面级缩放、夹在上下界。
// 用法: node tools/run-electron.js tools/test-wall-ctrl-wheel.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, String(name).replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, EMPTY);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install']) ipcMain.handle(c, OK);
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'read-exif',
    'open-image']) ipcMain.handle(c, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({ version: require('../package.json').version, electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT }));

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1400, height: 900, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (x) => win.webContents.executeJavaScript(x);
    await sleep(400);
    win.showInactive();
    await exec(`(() => {
        try {
            localStorage.setItem('qfs_intro_done', '1');
            localStorage.removeItem('qfs_wall_mode');
            localStorage.removeItem('qfs_wall_card_scale');
        } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        if (window.App && App.initPresetWall) App.initPresetWall();
        if (window.App && App.openPresetWall) App.openPresetWall(false);
        return true;
    })()`);
    for (let i = 0; i < 80; i++) {
        if (await exec('document.querySelectorAll("#presetWallGrid .pw-tile").length > 0')) break;
        await sleep(150);
    }
    await sleep(500);

    const out = await exec(`(async () => {
        const A = window.App;
        const g = document.getElementById('presetWallGrid');
        A._wallReduceOverride = false;
        A.stopWallMotion(); A.panWallTo(0, 0);
        A.setWallCardScale(0.85);
        const pan0 = { x: A._wallPan.x, y: A._wallPan.y };
        const fire = (dy, ctrl) => {
            const ev = new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true, ctrlKey: ctrl });
            g.dispatchEvent(ev);
            return ev.defaultPrevented;
        };
        const preventedUp = fire(-100, true);
        await new Promise((r) => setTimeout(r, 150));
        const bigger = A.wallCardScale();
        const preventedDown = fire(100, true);
        await new Promise((r) => setTimeout(r, 150));
        const back = A.wallCardScale();
        for (let i = 0; i < 20; i++) fire(-120, true);
        await new Promise((r) => setTimeout(r, 200));
        const capped = A.wallCardScale();
        for (let i = 0; i < 20; i++) fire(120, true);
        await new Promise((r) => setTimeout(r, 200));
        const floored = A.wallCardScale();
        // 无 ctrl 的滚轮仍走平移，不改卡片大小
        const beforePlain = A.wallCardScale();
        fire(100, false);
        await new Promise((r) => setTimeout(r, 150));
        const afterPlain = A.wallCardScale();
        A._wallReduceOverride = null;
        return { preventedUp, preventedDown, bigger, back, capped, floored, beforePlain, afterPlain,
                 panMoved: Math.abs(A._wallPan.x - pan0.x) + Math.abs(A._wallPan.y - pan0.y),
                 stored: localStorage.getItem('qfs_wall_card_scale'),
                 slider: (document.getElementById('pwZoomRange') || {}).value,
                 boxTitle: (document.getElementById('pwZoom') || {}).title || '' };
    })()`);

    check(out.preventedUp && out.preventedDown,
        'Ctrl+滚轮调用 preventDefault（不被页面级缩放吞掉）',
        JSON.stringify({ up: out.preventedUp, down: out.preventedDown }));
    check(out.bigger > 0.86 && out.back < out.bigger && out.back >= 0.84,
        'Ctrl+滚轮上滚放大、下滚缩小', JSON.stringify({ bigger: out.bigger, back: out.back }));
    check(out.capped <= 1.3 && out.capped >= 1.29, '连续放大夹在上限 1.3', String(out.capped));
    check(out.floored >= 0.55 && out.floored <= 0.56, '连续缩小夹在下限 0.55', String(out.floored));
    check(Math.abs(out.afterPlain - out.beforePlain) < 0.001 && out.panMoved > 5,
        '无 Ctrl 的滚轮仍只平移墙、不改卡片大小',
        JSON.stringify({ scale: [out.beforePlain, out.afterPlain], panMoved: Math.round(out.panMoved) }));
    check(/Ctrl/.test(out.boxTitle), '缩放控件提示了 Ctrl 滚轮快捷方式', out.boxTitle);

    console.log(failures.length ? `\n未通过 ${failures.length} 项：` + failures.map((f) => '\n - ' + f).join('') : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); app.exit(1); });

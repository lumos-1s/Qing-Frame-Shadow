// UI 改造前后对比：依次截取编辑器 / 预设墙 / 设置三页 / 更新内容 / 窄窗墙。
// 用法: node tools/run-electron.js tools/shot-ui-audit.js（或 npm run shot:ui）
// 输出: .tmp/ui-audit/*.png（.tmp 已 gitignore）
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const SAMPLE_DIR = path.join(ROOT, 'design', 'home-prototype-assets', 'samples');
const OUT = path.join(ROOT, '.tmp', 'ui-audit');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter(n => n.endsWith('.json')).map(n => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); } catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'copy-text', 'save-diagnostics', 'check-for-updates', 'quit-and-install',
    'open-external', 'open-data-dir', 'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({ fontScale: 1, theme: 'dark', autoCheck: 'off' }));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({ version: '0.1.26', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT }));

async function main() {
    const win = new BrowserWindow({
        width: 1600, height: 1000, useContentSize: true, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(ROOT, 'tools', 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (x) => win.webContents.executeJavaScript(x);
    await sleep(500);
    win.showInactive();
    await exec(`(() => { localStorage.setItem('qfs_intro_done','1'); try{App.closeIntro&&App.closeIntro();}catch(_){} return true; })()`);
    for (let i = 0; i < 60; i++) {
        if (await exec('!!(window.App && App.presets && App.presets.length)')) break;
        await sleep(200);
    }
    const data = 'data:image/webp;base64,' + fs.readFileSync(path.join(SAMPLE_DIR, 'portrait.webp')).toString('base64');
    const info = await exec(`(async () => {
        const A = window.App;
        const img = new Image();
        await new Promise((r) => { img.onload = r; img.onerror = r; img.src = ${JSON.stringify(data)}; });
        const im = { el: img, name: 'portrait.webp', w: img.naturalWidth, h: img.naturalHeight,
            exif: { make:'SONY', model:'ILCE-7RM4', iso:'100', focal:'85 毫米', aperture:'f/1.8', shutter:'1/250 秒' },
            thumb: ${JSON.stringify(data)}, customSettings: null };
        const preset = A.presets.find(p => p.templateName === 'VHS录像带') || A.presets[0];
        const tpl = JSON.parse(JSON.stringify(preset));
        im.customSettings = tpl;
        A.images = [im]; A.currentIdx = 0; A.image = im; A.selectedIdx = [0]; A.batchSel = [];
        A.imageTemplates = new Map([[im, tpl]]);
        A.template = JSON.parse(JSON.stringify(tpl));
        A.buildThumbnails(); A.updateEmptyState(); A.afterImageSelect();
        A.switchTab('grade'); A.scheduleRender(true);
        await new Promise(r => setTimeout(r, 1400));
        return { presets: A.presets.length, preset: preset.templateName, w: img.naturalWidth, h: img.naturalHeight };
    })()`);
    console.log('SETUP', JSON.stringify(info));

    const shot = async (name, sel) => {
        const box = await exec(`(() => {
            const el = document.querySelector(${JSON.stringify(sel)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        })()`);
        await win.webContents.capturePage(box && box.width > 10 ? box : undefined);
        await sleep(180);
        const img = await win.webContents.capturePage(box && box.width > 10 ? box : undefined);
        const file = path.join(OUT, name + '.png');
        fs.writeFileSync(file, img.toPNG());
        console.log('SHOT', file);
    };

    await shot('editor', 'body');
    await exec(`App.openPresetWall(false)`);
    await sleep(900);
    await shot('wall', '#presetWall');
    await exec(`App.closePresetWall(false)`);
    await sleep(400);
    await exec(`App.openSettings()`);
    await exec(`App.switchSettingsTab('general')`);
    await sleep(500);
    await shot('settings-general', '#settingsModal');
    await exec(`App.switchSettingsTab('update')`);
    await sleep(400);
    await shot('settings-update', '#settingsModal');
    await exec(`App.switchSettingsTab('about')`);
    await sleep(400);
    await shot('settings-about', '#settingsModal');
    // 真实路径：关于页「更新内容」打开的是 changelogModal（叠在设置之上），不是更新横幅那个弹窗
    await exec(`App.openChangelog()`);
    await sleep(500);
    await shot('changelog', '#changelogModal');
    await exec(`App.closeChangelog(); App.closeSettings();`);
    await sleep(300);
    // 窄窗：顶部控件应整组落到第二行，标题保持左对齐
    await exec(`App.openPresetWall(false)`);
    await sleep(700);
    win.setContentSize(1280, 860);
    await sleep(900);
    await shot('wall-narrow', '#presetWall');
    win.destroy();
    app.exit(0);
}
app.whenReady().then(main).catch((e) => { console.error(e && e.stack || e); app.exit(1); });

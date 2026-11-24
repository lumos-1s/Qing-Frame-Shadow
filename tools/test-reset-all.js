'use strict';
// 顶栏「重置全部」回归：边框样式 + 调色/蒙版 + 裁切旋转 + 显影参数一起回到默认，
// 保留一次撤销，取消时什么都不改。
// 用法：node tools/run-electron.js tools/test-reset-all.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) fails.push(label + (extra ? ': ' + extra : ''));
}

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => { try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, n + '.json'), 'utf8')); } catch (_) { return null; } });
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets', 'list-custom-icons']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'open-wall-covers-dir',
    'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.28', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(500); win.showInactive();
    const exec = (x) => win.webContents.executeJavaScript(x);
    await exec(`(() => { try { localStorage.setItem('qfs_intro_done','1'); } catch(_){}
        if (window.App && App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(1000);

    const r = await exec(`(async () => {
        const A = window.App;
        const mkEl = async (w, h) => {
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, w, h);
            const el = new Image();
            await new Promise((res) => { el.onload = res; el.onerror = res; el.src = c.toDataURL('image/png'); });
            return el;
        };
        const origEl = await mkEl(400, 300);
        const editedEl = await mkEl(200, 200);
        const im = { el: editedEl, name: 'reset.png', path: null, w: 200, h: 200,
            orig: { el: origEl, w: 400, h: 300, raw: null },
            geoOps: [{ t: 'f', x: 0, y: 0, w: 0.5, h: 0.5 }, { t: 'r' }], rotate: 1,
            grade: { exp: 1.2, masks: [{ id: 'm1' }] },
            _grade: { neutral: false, canvas: document.createElement('canvas'), low: null, lowKey: '', fullKey: '' },
            exif: {}, customSettings: null };
        A.images = [im]; A.image = im; A.currentIdx = 0; A.selectedIdx = []; A.batchSel = [];
        A.template = A.defaultTemplate();
        A.template.photoFrameStyle = 'VHS_TAPE';
        A.template.baseMargin.marginTop = 44;
        A.template.puzzle.enabled = 1;
        A.setTpl(im, A.template);
        A.updateEmptyState();
        await new Promise((res) => setTimeout(res, 200));

        // 取消：一点都不改
        const origConfirm = window.confirm;
        window.confirm = () => false;
        const cancelled = A.resetAll();
        const afterCancel = { exp: im.grade.exp, style: A.template.photoFrameStyle, el: im.el === editedEl };
        window.confirm = () => true;
        const done = A.resetAll();
        window.confirm = origConfirm;
        await new Promise((res) => setTimeout(res, 150));
        const after = {
            style: A.template.photoFrameStyle || '',
            margin: (A.template.baseMargin || {}).marginTop || 0,
            puzzle: !!(A.template.puzzle && A.template.puzzle.enabled),
            exp: Number((im.grade || {}).exp) || 0,
            masks: (im.grade || {}).masks || null,
            geo: (im.geoOps || []).length,
            rotate: Number(im.rotate) || 0,
            elRestored: im.el === origEl,
            origKept: !!im.orig,
            status: A.statusMsg || ''
        };
        A.undo();
        await new Promise((res) => setTimeout(res, 250));
        const undone = {
            style: A.template.photoFrameStyle || '',
            exp: Number((im.grade || {}).exp) || 0,
            masks: ((im.grade || {}).masks || []).length,
            geo: (im.geoOps || []).length,
            rotate: Number(im.rotate) || 0,
            w: im.w
        };
        return { cancelled, afterCancel, done, after, undone };
    })()`);

    check(r.cancelled === false && r.afterCancel.exp === 1.2
          && r.afterCancel.style === 'VHS_TAPE' && r.afterCancel.el,
        '取消重置时边框/调色/位图一点都不改', JSON.stringify({ cancelled: r.cancelled, afterCancel: r.afterCancel }));
    check(r.done === true, '确认后执行重置全部', String(r.done));
    check(!r.after.style && r.after.margin === 0 && !r.after.puzzle,
        '边框样式/边距/拼图版式已回到默认', JSON.stringify(r.after));
    check(r.after.exp === 0 && (!r.after.masks || r.after.masks.length === 0),
        '调色与蒙版已清空', JSON.stringify({ exp: r.after.exp, masks: r.after.masks }));
    check(r.after.geo === 0 && r.after.rotate === 0 && r.after.elRestored,
        '裁切/旋转已撤销，位图换回原图', JSON.stringify(r.after));
    check(r.after.origKept && /撤销/.test(r.after.status),
        '保留原图引用以便撤销，并提示可撤销', r.after.status);
    check(r.undone.style === 'VHS_TAPE' && r.undone.exp === 1.2 && r.undone.masks === 1
          && r.undone.geo === 2 && r.undone.rotate === 1,
        'Ctrl+Z 一次恢复边框、调色、蒙版与裁切旋转', JSON.stringify(r.undone));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });

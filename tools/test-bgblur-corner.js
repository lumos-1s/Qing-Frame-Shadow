// 背景模糊卡片的圆角照片：不得在弧边透出 Step 1 的白色衬底（白边）。
// 用法: node tools/run-electron.js tools/test-bgblur-corner.js
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

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1200, height: 1000, useContentSize: true, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (x) => win.webContents.executeJavaScript(x);
    await sleep(400);
    win.showInactive();
    await exec(`localStorage.setItem('qfs_intro_done','1'); if(App.closeIntro)App.closeIntro(); true`);
    for (let i = 0; i < 60; i++) { if (await exec('!!(window.App && App.presets && App.presets.length)')) break; await sleep(200); }

    const info = await exec(`(async () => {
      try {
        const A = window.App;
        // 用真实样张（没有纯白区域）：模糊底和照片都非纯白，任何纯白像素都只可能来自白色衬底透边。
        const url = 'data:image/webp;base64,' + ${JSON.stringify(fs.readFileSync(path.join(ROOT, 'design', 'home-prototype-assets', 'samples', 'portrait.webp')).toString('base64'))};
        const img = new Image();
        await new Promise((r) => { img.onload = r; img.onerror = r; img.src = url; });
        const im = { el: img, name: 'portrait.webp', w: img.naturalWidth, h: img.naturalHeight, exif: {}, customSettings: null };
        const preset = A.presets.find((p) => p.templateName === '磨砂玻璃卡');
        if (!preset) return { error: '没有磨砂玻璃卡预设' };
        const tpl = JSON.parse(JSON.stringify(preset));
        im.customSettings = tpl;
        A.images = [im]; A.currentIdx = 0; A.image = im;
        A.template = JSON.parse(JSON.stringify(tpl));
        A.setTpl(im, A.template); A.updateEmptyState(); A.afterImageSelect();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 900));
        const cv = A.dom.canvas;
        if (!cv || !cv.width) {
            return { error: 'canvas 未就绪', id: cv && cv.id, w: cv && cv.width, h: cv && cv.height,
                     domKeys: Object.keys(A.dom || {}).slice(0, 8) };
        }
        const ctx = cv.getContext('2d');
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        // 白色衬底只在照片圆角矩形范围内，按 _photoRect 换算到设备像素后框定检测区，
        // 排除底部独立的 FROSTED 文字（纯白）干扰。
        const rect = A._photoRect || null;
        if (!rect) return { error: '没有 _photoRect' };
        const scale = cv.width / (A._canvasBaseW || cv.width);
        const rx = Math.max(0, Math.floor(rect.x * scale));
        const ry = Math.max(0, Math.floor(rect.y * scale));
        const rw = Math.min(cv.width, Math.ceil((rect.x + rect.w) * scale)) - rx;
        const rh = Math.min(cv.height, Math.ceil((rect.y + rect.h) * scale)) - ry;
        let pureWhite = 0, nearWhite = 0, minX = 99999, maxX = -1, minY = 99999, maxY = -1;
        for (let y = ry; y < ry + rh; y++) {
            for (let x = rx; x < rx + rw; x++) {
                const i = (y * cv.width + x) * 4;
                if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) {
                    pureWhite++;
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                }
                else if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) nearWhite++;
            }
        }
        return { name: preset.templateName, w: cv.width, h: cv.height, pureWhite, nearWhite,
                 whiteBox: pureWhite ? [minX, minY, maxX, maxY] : null, rect: A._photoRect || null };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`);
    check(!info.error && info.pureWhite === 0,
        '圆角边缘不露白色衬底（纯白像素为 0）', JSON.stringify(info));
    check(info.nearWhite !== undefined && info.nearWhite < 50,
        '也没有可见的近白细边', JSON.stringify({ nearWhite: info.nearWhite }));

    // 结构回归：圆角照片必须走离屏镂空，不能再回到 clip + drawImage（clip 抗锯齿会透白）。
    const engineSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'engine.js'), 'utf8');
    check(engineSrc.includes('drawPhotoWithCorners(ctx, img, drawX')
        && !/buildRoundedPath\(ctx, drawX, drawY, drawW, drawH, prTL, prTR, prBL, prBR\);\s*ctx\.clip\(\);/.test(engineSrc),
        '圆角照片走离屏 punchRoundedCorners，而非 clip + drawImage');

    // 背景模糊·经典/日期走 engine-styles.js 的 drawMainPhoto，是独立的第二处白边来源。
    const classic = await exec(`(async () => {
      try {
        const A = window.App;
        const preset = A.presets.find((p) => p.templateName === '背景模糊-经典');
        if (!preset) return { error: '没有背景模糊-经典预设' };
        const tpl = JSON.parse(JSON.stringify(preset));
        A.image.customSettings = tpl;
        A.template = JSON.parse(JSON.stringify(tpl));
        A.setTpl(A.image, A.template);
        A.afterImageSelect();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 1000));
        const cv = A.dom.canvas;
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        // 只扫上半部分：底部参数文字是设计上的白字，不算白边。
        let white = 0, minX = 99999, minY = 99999, maxX = -1, maxY = -1;
        for (let y = 0; y < Math.floor(cv.height * 0.6); y++) {
            for (let x = 0; x < cv.width; x++) {
                const i = (y * cv.width + x) * 4;
                if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) {
                    white++;
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                }
            }
        }
        return { name: preset.templateName, white, box: white ? [minX, minY, maxX, maxY] : null };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`);
    check(!classic.error && classic.white === 0,
        '背景模糊·经典：圆角不露白边（上半幅纯白像素为 0）', JSON.stringify(classic));

    const stylesSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'engine-styles.js'), 'utf8');
    check(stylesSrc.includes('drawPhotoPunched(g, img, dx, dy, dw, dh, radius)')
        && !/roundRectPath\(g, dx, dy, dw, dh, radius\);\s*g\.clip\(\);\s*g\.drawImage\(img, dx, dy, dw, dh\);/.test(stylesSrc),
        'drawMainPhoto 走离屏镂空，而非 clip + drawImage');

    console.log(failures.length ? `\n未通过 ${failures.length} 项：` + failures.map((f) => '\n - ' + f).join('') : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); app.exit(1); });

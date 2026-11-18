// 重新生成 README「真实效果」里的两张图：
//   assets/readme/app-ui.png      —— 从当前代码真实渲染的应用界面
//   assets/readme/preset-wall.webp —— 用真实封面图重拼的六款预设墙（数字改为实测值）
// 用法：node tools/run-electron.js tools/gen-readme-proof.js
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'readme');
const PRESETS = path.join(ROOT, 'shared', 'presets');
const COVERS = path.join(ROOT, 'src', 'renderer', 'assets', 'preset-wall', 'covers');
const SAMPLE = path.join(ROOT, 'design', 'home-prototype-assets', 'samples', 'desert.webp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 最小 IPC：让渲染进程能把 App 正常启动起来
ipcMain.handle('list-presets', () => fs.readdirSync(PRESETS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESETS, String(n).replace(/\.json$/, '') + '.json'), 'utf8')); }
    catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-grade-presets', 'list-wall-covers']) ipcMain.handle(c, () => []);
for (const c of ['get-prefs']) ipcMain.handle(c, () => ({}));
ipcMain.handle('get-user', () => null);
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'save-prefs', 'save-user', 'save-template', 'export-template', 'export-qfs', 'pick-export-location',
    'write-export-files', 'load-acr-tables', 'load-acr-shadows']) ipcMain.handle(c, () => ({ canceled: true, ok: true }));

const sampleUrl = 'data:image/webp;base64,' + fs.readFileSync(SAMPLE).toString('base64');

async function shotUI() {
    const win = new BrowserWindow({
        width: 1600, height: 920, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#151817',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: false,
            deviceScaleFactor: 2, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (x) => win.webContents.executeJavaScript(x);
    await sleep(500);
    win.showInactive();
    win.setContentSize(1600, 920);
    await exec(`(() => { localStorage.setItem('qfs_intro_done','1'); if (App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(1200);

    const setup = await exec(`(async () => {
        const App = window.App;
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        for (let i=0; i<80 && (!App.presets || App.presets.length<6); i++) await wait(100);
        const img = new Image();
        await new Promise((res, rej) => { img.onload=res; img.onerror=rej; img.src=${JSON.stringify(sampleUrl)}; });
        const im = { el: img, name: '示例照片.jpg', w: img.naturalWidth, h: img.naturalHeight,
            exif: {}, thumb: ${JSON.stringify(sampleUrl)}, customSettings: null };
        App.images = [im]; App.currentIdx = 0; App.image = im; App.selectedIdx = [0]; App.batchSel = [];
        App.imageTemplates = new Map();
        const pick = App.presets.find(p => (p.templateName||'') === '复古双线')
            || App.presets.find(p => String(p.photoFrameStyle||'').toUpperCase() === 'VINTAGE')
            || App.presets[0];
        const tpl = JSON.parse(JSON.stringify(pick));
        App.imageTemplates.set(im, tpl);
        App.template = tpl;
        App._followFit = false;
        App.buildThumbnails();
        App.updateEmptyState();
        App.afterImageSelect();
        if (App.selectPreset) App.selectPreset(pick);
        await wait(900);
        return { count: App.presets.length, preset: tpl.templateName || tpl.photoFrameStyle };
    })()`);
    console.log('UI setup', JSON.stringify(setup));
    await sleep(700);
    const png = (await win.webContents.capturePage()).toPNG();
    fs.writeFileSync(path.join(OUT, 'app-ui.png'), png);
    console.log('wrote app-ui.png', png.length);
    return win;
}

async function shotWall(win) {
    const presets = [
        { cn: 'VHS 录像带', en: 'VHS TAPE', cover: 'c04' },
        { cn: '复古报纸', en: 'THE EVENING POST', cover: 'c19' },
        { cn: '复古双线', en: '1970s DOUBLE LINE', cover: 'c18' },
        { cn: '仿古邮票', en: 'COMMEMORATIVE STAMP', cover: 'c05' },
        { cn: '复古胶片撕裂', en: 'TORN FILM', cover: 'c22' },
        { cn: '老相册角贴', en: 'ALBUM CORNERS', cover: 'c74' }
    ].map((p) => ({
        ...p,
        src: 'data:image/webp;base64,' + fs.readFileSync(path.join(COVERS, p.cover + '.webp')).toString('base64')
    }));
    const presetCount = fs.readdirSync(PRESETS).filter((f) => f.endsWith('.json')).length;
    // 风格数从引擎 draw 分发表实测（与 check-readme-counts.js 同口径）
    const eng = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'engine-styles.js'), 'utf8');
    const s = eng.indexOf('const draw = {'), e = eng.indexOf('}[styleName];', s);
    const styleCount = new Set([...eng.slice(s, e).matchAll(/(?:^|[,{\s])([A-Z][A-Z0-9_]+)\s*:/g)].map((m) => m[1])).size;

    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
        const presets = ${JSON.stringify(presets)};
        const presetCount = ${presetCount}, styleCount = ${styleCount};
        const W = 1768, H = 1224, PAD = 48, GAP = 24;
        const headY = 62, footY = H - 48;
        const cardW = (W - PAD * 2 - GAP * 2) / 3;
        const cardH = (H - 132 - PAD - GAP) / 2;
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        g.fillStyle = '#f4eee0'; g.fillRect(0, 0, W, H);
        const F = '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';
        const M = 'ui-monospace, Menlo, Consolas, monospace';
        g.fillStyle = '#6b5f4d'; g.font = '600 17px ' + M;
        g.fillText('REAL RENDERS / QINGFRAME', PAD, 44);
        g.textAlign = 'right';
        g.fillText(presetCount + ' PRESETS · ' + styleCount + ' STYLES', W - PAD, 44);
        g.textAlign = 'left';
        g.strokeStyle = 'rgba(90,78,60,.28)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(PAD, headY); g.lineTo(W - PAD, headY); g.stroke();

        let k = 0;
        for (const p of presets) {
            const cx = PAD + (k % 3) * (cardW + GAP);
            const cy = headY + 20 + Math.floor(k / 3) * (cardH + GAP);
            g.save();
            g.shadowColor = 'rgba(70,55,35,.16)'; g.shadowBlur = 16; g.shadowOffsetY = 6;
            g.fillStyle = '#fffdf7';
            g.beginPath(); g.roundRect(cx, cy, cardW, cardH, 10); g.fill();
            g.restore();
            g.strokeStyle = 'rgba(90,78,60,.14)';
            g.beginPath(); g.roundRect(cx, cy, cardW, cardH, 10); g.stroke();

            const im = new Image();
            await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = p.src; });
            const imgTop = cy + 22, imgH = cardH - 96;
            const s = Math.min((cardW - 44) / im.naturalWidth, imgH / im.naturalHeight);
            const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
            g.drawImage(im, cx + (cardW - dw) / 2, imgTop + (imgH - dh) / 2, dw, dh);

            g.fillStyle = '#2c2620'; g.font = '600 27px ' + F;
            g.fillText(p.cn, cx + 24, cy + cardH - 44);
            g.fillStyle = '#9a8b76'; g.font = '14px ' + M;
            g.fillText(p.en, cx + 24, cy + cardH - 20);
            g.textAlign = 'right';
            g.fillText(String(k + 1).padStart(2, '0'), cx + cardW - 24, cy + cardH - 20);
            g.textAlign = 'left';
            k++;
        }

        g.strokeStyle = 'rgba(90,78,60,.28)';
        g.beginPath(); g.moveTo(PAD, footY - 18); g.lineTo(W - PAD, footY - 18); g.stroke();
        g.fillStyle = '#8b7d68'; g.font = '13px ' + M;
        g.fillText('SAMPLE PHOTO: PROJECT SELF-DRAWN · ENGINE OUTPUT', PAD, footY + 8);
        g.textAlign = 'right';
        g.fillStyle = '#3f7a5e';
        g.fillText('● NO UPLOAD · LOCAL RENDER', W - PAD, footY + 8);
        g.textAlign = 'left';
        return cv.toDataURL('image/webp', 0.9);
    })()`);
    fs.writeFileSync(path.join(OUT, 'preset-wall.webp'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote preset-wall.webp', fs.statSync(path.join(OUT, 'preset-wall.webp')).size, 'presets', presetCount, 'styles', styleCount);
}

app.whenReady().then(async () => {
    const win = await shotUI();
    await shotWall(win);
    app.exit(0);
});

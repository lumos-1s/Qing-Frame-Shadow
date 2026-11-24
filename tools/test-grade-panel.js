// 调色页签顶部（直方图 + 参数条）与 亮/颜色/效果 三段布局的回归。
// 用法：node tools/run-electron.js tools/test-grade-panel.js
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
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); }
    catch (_) { return null; }
});
const EMPTY = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(channel, EMPTY);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir', 'list-grade-presets', 'save-grade-presets']) ipcMain.handle(channel, OK);
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => {
    try {
        const zlib = require('zlib');
        const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-tables.bin'));
        if (raw.slice(0, 4).toString('ascii') !== 'CRT4') return null;
        const planes = zlib.inflateSync(raw.slice(10));
        return { size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
            data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength) };
    } catch (_) { return null; }
});
ipcMain.handle('load-acr-shadows', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.24', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label);
}

const PROBE = `(async () => {
    const A = window.App;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const $ = (id) => document.getElementById(id);

    // 一张从左到右变亮的灰阶图：直方图应该集中在中间，加减曝光能看出整体平移
    const c = document.createElement('canvas');
    c.width = 900; c.height = 600;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 900, 0);
    grad.addColorStop(0, '#1a1a1a');
    grad.addColorStop(0.5, '#8a8a8a');
    grad.addColorStop(1, '#efefef');
    g.fillStyle = grad; g.fillRect(0, 0, 900, 600);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });

    const im = {
        el, name: 'grad.jpg', path: null, w: 900, h: 600,
        exif: { iso: 'ISO100', focal: '50mm', aperture: 'f/2.8', shutter: '1/125s' },
        customSettings: null, grade: null
    };
    A.images = [im]; A.image = im; A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = [];
    A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.setTpl(im, A.template);
    A.updateEmptyState();
    A.refreshUI();
    A.switchTab('grade');
    await wait(500);

    // ── 1. 直方图留在调色页签内（属于 #panel-grade，且排在蒙版组之前）──
    const card = $('gradeHistoCard');
    const maskGrp = $('grpMask');
    const inGrade = !!(card && card.closest('#panel-grade'));
    const beforeMask = !!(card && maskGrp && (card.compareDocumentPosition(maskGrp) & Node.DOCUMENT_POSITION_FOLLOWING));
    const cv = $('gradeHisto');
    // 直方图卡在调色页内应钉在栏顶（滚动长参数时不跟走）
    const cs = card ? getComputedStyle(card) : null;
    const stickyPinned = !!(cs && cs.position === 'sticky' && parseFloat(cs.top) === 0 && parseInt(cs.zIndex, 10) >= 1);

    // ── 2. 统计随调色变化：曝光 +1.5 后平均亮度右移 ──
    const meanOf = (s) => {
        let sum = 0, n = 0;
        for (let i = 0; i < 256; i++) { sum += i * s.y[i]; n += s.y[i]; }
        return n ? sum / n : 0;
    };
    const base = window.QfsHistogram.statsOf(im);
    const baseMean = base ? meanOf(base) : 0;
    const baseTotal = base ? base.total : 0;
    A.setGrade({ exp: 1.5 });
    await wait(260);
    const bright = window.QfsHistogram.statsOf(im);
    const brightMean = bright ? meanOf(bright) : 0;
    A.setGrade({ exp: 0 });
    await wait(220);

    // ── 3. 参数条：有 EXIF 时逐项显示，没有时给一句说明 ──
    window.QfsHistogram.refresh(im);
    await wait(260);
    const exifText = ($('gradeExif').textContent || '').replace(/\\s+/g, ' ').trim();
    im.exif = {};
    window.QfsHistogram.refresh(im);
    await wait(260);
    const exifEmpty = ($('gradeExif').textContent || '').trim();
    im.exif = { iso: 'ISO100', focal: '50mm', aperture: 'f/2.8', shutter: '1/125s' };
    window.QfsHistogram.refresh(im);
    await wait(220);

    // ── 4. 三段分组与归属 ──
    const subs = Array.prototype.slice.call(document.querySelectorAll('#grpGrade .pg-sub'));
    const keys = subs.map((s) => s.dataset.sub);
    const inside = (sub, ids) => {
        const box = document.querySelector('#grpGrade .pg-sub[data-sub="' + sub + '"]');
        return !!box && ids.every((id) => {
            const row = $(id) && $(id).closest('.param-row');
            return !!(row && box.contains(row));
        });
    };
    const lightOk = inside('light', ['slGradeExp', 'slGradeCon', 'slGradeHi', 'slGradeSh', 'slGradeWhite', 'slGradeBlack', 'slGradeGam']);
    const colorOk = inside('color', ['slGradeTemp', 'slGradeTint', 'slGradeVib', 'slGradeSat']);
    const fxOk = inside('fx', ['slDetTex', 'slDetClar', 'slDetDhz',
        'slVignetteStrength', 'slVignetteFeather', 'slFilmGrain']);
    const detOnlySharpen = !$('grpDet').contains($('slDetClar')) && !!$('grpDet').contains($('slDetShp'));

    // ── 5. 分段复位只清自己那几档 ──
    A.resetGrade();
    A.setGrade({ exp: 1, con: 12, temp: 20, tint: 8, det: Object.assign({}, A.gradeOf(im).det, { tex: 30, clar: 20 }) });
    A.resetGradeSection('light');
    const afterLight = A.gradeOf(im);
    const lightReset = afterLight.exp === 0 && afterLight.con === 0;
    const othersKept = afterLight.temp === 20 && afterLight.det.tex === 30;
    // 晕影/颗粒也属于「效果」段：先给非零值，复位后应一起归零
    A.template.lightEffect = Object.assign({}, A.template.lightEffect, {
        vignetteSignV2: 2, vignetteEnable: 1, vignetteStrength: -33,
        vignetteFeather: 70, filmGrainEnable: 1, filmGrainIntensity: 18
    });
    A.resetGradeSection('fx');
    const afterFx = A.gradeOf(im);
    // 三段全零后 det 会被 sanitizeDet 收成 null（= 这组没开），读的时候按空对象兜底
    const fxDet = afterFx.det || {};
    const leFx = A.template.lightEffect || {};
    const fxReset = (fxDet.tex || 0) === 0 && (fxDet.clar || 0) === 0 && afterFx.temp === 20
        && (leFx.vignetteStrength || 0) === 0 && (leFx.vignetteEnable || 0) === 0
        && (leFx.vignetteFeather == null ? 50 : leFx.vignetteFeather) === 50
        && (leFx.filmGrainIntensity || 0) === 0;
    A.resetGradeSection('color');
    const afterColor = A.gradeOf(im);
    const colorReset = afterColor.temp === 0 && afterColor.tint === 0;

    // ── 6. 收起 / 展开 ──
    // 类 LR：默认只展开「亮」，颜色/效果收起；点标题切换，行可见性跟着走。
    const colorSub = document.querySelector('#grpGrade .pg-sub[data-sub="color"]');
    const head = colorSub.querySelector('.pg-sub-head');
    const rowTemp = $('rowGradeTemp');
    const subBefore = colorSub.classList.contains('collapsed');
    head.click();
    await wait(60);
    const toggled = colorSub.classList.contains('collapsed') !== subBefore;
    const stateOk = head.getAttribute('aria-expanded') === String(!colorSub.classList.contains('collapsed'))
        && (getComputedStyle(rowTemp).display === 'none') === colorSub.classList.contains('collapsed');
    head.click();
    await wait(60);
    const restored = colorSub.classList.contains('collapsed') === subBefore;
    const jump = $('gradeJump');
    const jumpBtns = jump ? Array.prototype.slice.call(jump.querySelectorAll('[data-jump]')).map((b) => b.dataset.jump) : [];
    const foldInJump = !!jump && !!jump.querySelector('#foldNotice');
    // ── 7. 行布局：标签在上、轨道整宽、数值靠右 ──
    A.resetGrade();
    A.setGrade({ con: 18 });
    await wait(200);
    const row = $('rowGradeCon');
    const rng = $('slGradeCon');
    const lab = row.querySelector('label');
    const val = row.querySelector('.pval-num');
    const unit = row.querySelector('.pval-unit');
    const rr = row.getBoundingClientRect();
    const ir = rng.getBoundingClientRect();
    const lr = lab.getBoundingClientRect();
    const vr = val.getBoundingClientRect();
    const layout = {
        rowW: Math.round(rr.width), trackW: Math.round(ir.width),
        labelAbove: lr.bottom <= ir.top + 1,
        labelLeft: Math.abs(lr.left - ir.left) <= 2,
        valueRight: Math.abs((rr.right - 4) - vr.right) <= 6,
        fullWidth: ir.width >= rr.width * 0.82
    };
    // 正数标签「+18」不能把「+」当成单位留在数值右边
    const unitText = (unit.textContent || '').trim();
    const numVal = val.value;

    // ── 8. 侧栏 260~440 三个宽度都不横向溢出、标签不压住数值 ──
    const insp = document.getElementById('inspector');
    const widthRows = [];
    for (const w of [260, 308, 440]) {
        insp.style.width = w + 'px';
        await wait(140);
        const rows = Array.prototype.slice.call(document.querySelectorAll('#panel-grade .param-row'))
            .filter((r) => r.querySelector('input[type=range]'));
        let worst = 0;
        for (const r of rows) {
            const num = r.querySelector('.pval-num');
            const lbl = r.querySelector('label');
            worst = Math.max(worst, r.scrollWidth - r.clientWidth);
            if (num && lbl) {
                const a = lbl.getBoundingClientRect();
                const b = num.getBoundingClientRect();
                if (a.right > b.left + 1) worst = Math.max(worst, Math.round(a.right - b.left));
            }
        }
        widthRows.push({ w, worst, n: rows.length });
    }
    insp.style.width = '';

    // ── 9. 直方图画布真的画了东西 ──
    const cw = cv.width, ch = cv.height;
    let painted = 0;
    if (cw && ch) {
        const px = cv.getContext('2d').getImageData(0, 0, cw, ch).data;
        for (let i = 3; i < px.length; i += 4 * 97) if (px[i] > 0) painted++;
    }

    return {
        inGrade, beforeMask, hasCanvas: !!cv, stickyPinned,
        baseTotal, baseMean: Math.round(baseMean * 10) / 10, brightMean: Math.round(brightMean * 10) / 10,
        exifText, exifEmpty,
        keys, lightOk, colorOk, fxOk, detOnlySharpen,
        lightReset, othersKept, fxReset, colorReset,
        subBefore, toggled, stateOk, restored, jumpBtns, foldInJump,
        layout, unitText, numVal, cw, ch, painted, widthRows
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
    try {
        res = await win.webContents.executeJavaScript(PROBE);
    } catch (e) {
        check(false, '探针执行', String(e && e.message));
    }
    if (res) {
        check(res.inGrade && res.beforeMask && res.hasCanvas && res.cw > 0 && res.ch > 0,
            '直方图卡留在调色页签内（#panel-grade），且排在蒙版组之前', JSON.stringify({ inGrade: res.inGrade, beforeMask: res.beforeMask, cw: res.cw, ch: res.ch }));
        check(res.stickyPinned,
            '直方图卡在调色页内用 sticky 钉在栏顶（下滑长参数时不跟走）',
            JSON.stringify({ stickyPinned: res.stickyPinned }));
        check(res.baseTotal > 1000, '直方图统计读到了预览像素', `total=${res.baseTotal}`);
        check(res.brightMean > res.baseMean + 4,
            '曝光 +1.5 后直方图整体右移（统计的是调色后的像素）',
            `${res.baseMean} → ${res.brightMean}`);
        check(res.painted > 0, '直方图画布真的画出了内容', `采样非空像素=${res.painted}`);
        check(/ISO 100/.test(res.exifText) && /50mm/.test(res.exifText)
            && /f\/2\.8/.test(res.exifText) && /1\/125s/.test(res.exifText),
            '参数条按 ISO / 焦距 / 光圈 / 快门 显示', res.exifText);
        check(res.exifEmpty === '未读取到 EXIF 参数', '没有 EXIF 时参数条给一句说明', res.exifEmpty);
        check(res.keys.join(',') === 'light,color,fx', '调色分成 亮 / 颜色 / 效果 三段', res.keys.join(','));
        check(res.lightOk && res.colorOk && res.fxOk,
            '三段各自装着自己的滑块（效果段接管纹理/清晰度/去薄雾/晕影/颗粒）',
            JSON.stringify({ lightOk: res.lightOk, colorOk: res.colorOk, fxOk: res.fxOk }));
        check(res.detOnlySharpen, '「锐化」组只剩锐化四档');
        check(res.lightReset && res.othersKept,
            '「亮」复位只清曝光/对比度等，颜色与效果保持不动',
            JSON.stringify({ lightReset: res.lightReset, othersKept: res.othersKept }));
        check(res.fxReset, '「效果」复位清纹理/清晰度/去薄雾/晕影/颗粒，颜色保持不动');
        check(res.colorReset, '「颜色」复位只清白平衡与饱和');
        check(res.subBefore && res.toggled && res.stateOk && res.restored,
            '默认只展开「亮」；段标题可切换，折叠状态与行可见性一致',
            JSON.stringify({ before: res.subBefore, toggled: res.toggled, stateOk: res.stateOk, restored: res.restored }));
        check(res.jumpBtns.join(',') === 'light,color,fx,grpCurve,grpDet,grpMask' && res.foldInJump,
            '参数导航直接跳到各段，收起提示并进同一行而不是单独占位',
            JSON.stringify({ btns: res.jumpBtns, fold: res.foldInJump }));
        check(res.layout.labelAbove && res.layout.fullWidth && res.layout.valueRight && res.layout.labelLeft,
            '滑块行：标签在上、轨道整宽、数值靠右', JSON.stringify(res.layout));
        check(res.unitText === '' && res.numVal === '18',
            '正数标签的「+」不会漏成数值框后面的单位', `unit="${res.unitText}" num="${res.numVal}"`);
        check(res.widthRows.every((r) => r.worst <= 1),
            '260 / 308 / 440 三个栏宽下，滑块行不溢出、标签不压数值',
            res.widthRows.map((r) => r.w + ':' + r.worst + '/' + r.n).join(' '));
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

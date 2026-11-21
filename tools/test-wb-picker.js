// 白平衡吸管回归：点击取样 → 反解 temp/tint → 落进全局调色（不是蒙版）。
// 用法: node tools/run-electron.js tools/test-wb-picker.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const c of ['list-presets', 'list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
ipcMain.handle('load-preset', () => null);
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
for (const c of ['save-prefs', 'save-user', 'logout-user']) ipcMain.handle(c, () => ({ ok: true }));

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1200, height: 820, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    for (let i = 0; i < 120; i++) {
        if (await exec('!!(window.App && App.dom)')) break;
        await sleep(250);
    }
    for (let i = 0; i < 80; i++) {
        if (await exec('!!(window.QfsAcr && QfsAcr.ready())')) break;
        await sleep(100);
    }
    await exec(`(() => { localStorage.setItem('qfs_intro_done','1'); if (App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(200);
    await exec(`(() => { if (App.switchTab) App.switchTab('grade'); return true; })()`);
    await sleep(400);

    // ── 1) 反解本身：暖色要往冷推、冷色要往暖推、中性灰要收敛到 0 附近 ──
    const solved = await exec(`(() => {
        const mk = (r, g, b) => QfsAcr.neutralize(r, g, b);
        return { warm: mk(224, 198, 156), cool: mk(150, 190, 225), gray: mk(128, 128, 128) };
    })()`);
    check(solved.warm && solved.warm.temperature < -5,
        '暖色（偏黄）解出负色温（往冷拉）', JSON.stringify(solved.warm));
    check(solved.cool && solved.cool.temperature > 5,
        '冷色（偏蓝）解出正色温（往暖拉）', JSON.stringify(solved.cool));
    check(solved.gray && Math.abs(solved.gray.temperature) <= 8 && Math.abs(solved.gray.tint) <= 8,
        '中性灰收敛在 0 附近', JSON.stringify(solved.gray));

    // ── 2) 点击路径：像素 → 坐标 → 反解 → setGrade ──
    const picked = await exec(`(() => {
        const c = document.createElement('canvas'); c.width = 240; c.height = 160;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.fillStyle = 'rgb(224,198,156)'; g.fillRect(0, 0, 240, 160);
        const im = { el: c, w: 240, h: 160, name: 'warm', grade: null, _grade: null };
        App.images = [im]; App.image = im; App.currentIdx = 0; App.selectedIdx = [];
        if (App.ensureGrade) App.ensureGrade(im);
        const cv = App.dom.canvas;
        // 测试窗口里画布还没布局（0×0），这里给它一个确定的视觉矩形，
        // 测的是坐标换算与反解，不是浏览器排版。
        cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 });
        const rect = cv.getBoundingClientRect();
        const base = App._baseSize();
        App._photoRect = { x: 0, y: 0, w: base.w, h: base.h };
        const before = JSON.parse(JSON.stringify(im.grade || {}));
        const ret = App._pickWbAt({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 });
        return { ret: ret, rectW: rect.width, rectH: rect.height, cvW: cv.width, cvH: cv.height,
            base: base, pr: App._photoRect, hasEl: !!im.el, elW: im.el && im.el.width,
            status: (App.dom.stCanvas || {}).textContent,
            before: before, after: im.grade,
            slider: document.getElementById('slGradeTemp') ? document.getElementById('slGradeTemp').value : null,
            label: document.getElementById('lblGradeTemp') ? document.getElementById('lblGradeTemp').textContent : null };
    })()`);
    check(picked.after && picked.after.temp < -5,
        '在暖色照片上点一下，色温变成负值', JSON.stringify({ temp: picked.after && picked.after.temp, tint: picked.after && picked.after.tint }));
    check(picked.slider !== null && Number(picked.slider) === Number(picked.after.temp),
        '色温滑块跟着吸管结果走', 'slider=' + picked.slider + ' grade=' + (picked.after && picked.after.temp));

    // ── 3) 点在照片外：不该改参数 ──
    const outside = await exec(`(() => {
        const im = App.image;
        const cv = App.dom.canvas;
        cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 });
        const rect = cv.getBoundingClientRect();
        const base = App._baseSize();
        App._photoRect = { x: 0, y: 0, w: base.w * 0.5, h: base.h * 0.5 };
        const t0 = im.grade.temp, i0 = im.grade.tint;
        App._pickWbAt({ clientX: rect.left + rect.width - 2, clientY: rect.top + rect.height - 2, button: 0 });
        return { t0: t0, t1: im.grade.temp, i0: i0, i1: im.grade.tint };
    })()`);
    check(outside.t0 === outside.t1 && outside.i0 === outside.i1,
        '点在照片范围外不改参数', JSON.stringify(outside));

    // ── 4) 过曝点：没有色相可解，不该动参数 ──
    const clipped = await exec(`(() => {
        const c = document.createElement('canvas'); c.width = 200; c.height = 140;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.fillStyle = 'rgb(255,255,255)'; g.fillRect(0, 0, 200, 140);
        const im = { el: c, w: 200, h: 140, name: 'clipped', grade: null, _grade: null };
        App.images = [im]; App.image = im; App.currentIdx = 0;
        if (App.ensureGrade) App.ensureGrade(im);
        App.setGrade({ temp: 0, tint: 0 }, { global: true });
        const cv = App.dom.canvas;
        cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 });
        const rect = cv.getBoundingClientRect();
        const base = App._baseSize();
        App._photoRect = { x: 0, y: 0, w: base.w, h: base.h };
        App._pickWbAt({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 });
        return { temp: im.grade.temp, tint: im.grade.tint };
    })()`);
    check(clipped.temp === 0 && clipped.tint === 0,
        '过曝点不解白平衡、参数保持原样', JSON.stringify(clipped));

    // ── 5) 高饱和点不是中性参考：应拒绝，别把整张推向补色 ──
    const green = await exec(`(() => {
        const c = document.createElement('canvas'); c.width = 200; c.height = 140;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.fillStyle = 'rgb(60,160,60)'; g.fillRect(0, 0, 200, 140);
        const im = { el: c, w: 200, h: 140, name: 'green', grade: null, _grade: null };
        App.images = [im]; App.image = im; App.currentIdx = 0;
        if (App.ensureGrade) App.ensureGrade(im);
        App.setGrade({ temp: 0, tint: 0 }, { global: true });
        const cv = App.dom.canvas;
        cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 });
        const base = App._baseSize();
        App._photoRect = { x: 0, y: 0, w: base.w, h: base.h };
        App._pickWbAt({ clientX: 400, clientY: 300, button: 0 });
        return { temp: im.grade.temp, tint: im.grade.tint, status: (App.dom.stCanvas || {}).textContent };
    })()`);
    check(green.temp === 0 && green.tint === 0,
        '高饱和色（绿叶）不被当作白参考', JSON.stringify(green));
    check(String(green.status).indexOf('不是中性色') >= 0,
        '高饱和点给出明确提示', green.status);

    win.destroy();
    if (failures.length) {
        console.log('\n' + failures.length + ' 项未通过');
        failures.forEach((f) => console.log('  - ' + f));
        app.exit(1);
    } else {
        console.log('\n白平衡吸管：全部通过');
        app.exit(0);
    }
}).catch((e) => { console.error(e); app.exit(1); });

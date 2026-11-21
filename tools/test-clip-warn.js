// 溢出警示回归：高光红 / 暗部蓝、J 键开关、只涂在照片矩形内、对比时收起。
// 用法: node tools/run-electron.js tools/test-clip-warn.js
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
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);
for (const c of ['save-prefs', 'save-user', 'logout-user']) ipcMain.handle(c, () => ({ ok: true }));

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1200, height: 820, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    for (let i = 0; i < 120; i++) {
        if (await exec('!!(window.App && App.dom && window.QfsClip)')) break;
        await sleep(250);
    }
    await exec(`(() => { localStorage.setItem('qfs_intro_done','1'); if (App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(600);

    // ── 造一张四段照片：纯白 / 只有 R 顶到 255 的橙色 / 只有 R 压到 0 的深蓝 / 中性灰 ──
    // 前三段各占 1/4，最后一段不该被涂。橙色与深蓝这两段是重点：
    // 溢出判定必须按「任一通道」，按「三通道同时」就会漏掉偏色高光与偏色暗部。
    const setup = await exec(`(() => {
        const c = document.createElement('canvas'); c.width = 400; c.height = 300;
        const g = c.getContext('2d');
        g.fillStyle = 'rgb(255,255,255)'; g.fillRect(0, 0, 400, 75);
        g.fillStyle = 'rgb(255,120,90)';  g.fillRect(0, 75, 400, 75);
        g.fillStyle = 'rgb(0,40,60)';     g.fillRect(0, 150, 400, 75);
        g.fillStyle = 'rgb(128,128,128)'; g.fillRect(0, 225, 400, 75);
        const im = { el: c, w: 400, h: 300, name: 'clip-fixture', grade: null, _grade: null };
        App.images = [im]; App.image = im; App.currentIdx = 0; App.selectedIdx = [];
        if (App.ensureGrade) App.ensureGrade(im);
        // 测试窗口里引擎还没渲染过，这里直接给出「基准画布 + 照片矩形」的口径
        App._canvasBaseW = 800; App._canvasBaseH = 600;
        App._photoRect = { x: 200, y: 150, w: 400, h: 300 };
        App.draggingCompare = false; App._maskPreviewOriginal = false;
        // 这一份是纯像素/几何测试：停掉渲染队列，避免后台的启动帧把
        // 照片矩形和画布尺寸改回真实布局
        App.scheduleRender = () => {};
        const cv = App.dom.canvas;
        cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 });
        App.dom.stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 });
        return { ok: !!document.getElementById('clipOverlay'), btn: !!document.getElementById('btnClipWarn') };
    })()`);
    check(setup.ok, '画布里有独立的警示层 #clipOverlay');
    check(setup.btn, '调色面板有「溢出」开关');

    const on = await exec('QfsClip.setOn(true)');
    await sleep(120);
    const st = await exec('QfsClip.stats()');
    check(on === true && (await exec('QfsClip.isOn()')) === true, 'setOn(true) 打开警示');
    check(st && Math.abs(st.hi - 0.5) < 0.02,
        '高光占比 ≈ 50%（纯白 + 只有 R 顶到 255）', JSON.stringify(st));
    check(st && Math.abs(st.lo - 0.25) < 0.02,
        '暗部占比 ≈ 25%（只有 R 压到 0 的深蓝也算）', JSON.stringify(st));
    check(st && st.w === 400 && st.h === 300, '警示图按原尺寸取样（小图不放大）', JSON.stringify(st));

    // 叠加层像素：只该出现在照片矩形里，且高光是红、暗部是蓝
    const px = await exec(`(() => {
        const ov = document.getElementById('clipOverlay');
        const g = ov.getContext('2d');
        const k = ov.width / 800;                    // CSS→backing 的换算（dpr）
        const at = (bx, by) => {
            const d = g.getImageData(Math.round(bx * k), Math.round(by * k), 1, 1).data;
            return [d[0], d[1], d[2], d[3]];
        };
        return {
            k,
            // 照片矩形 200,150 400x300：第一段(白)在 y≈150+37，第二段(橙)在 y≈150+112，
            // 第三段(深蓝)在 y≈150+187，第四段(灰)在 y≈150+262
            white: at(400, 187), orange: at(400, 262), dark: at(400, 337), gray: at(400, 412),
            outside: at(20, 20), offPhoto: at(760, 40)
        };
    })()`);
    check(px.white[0] > 200 && px.white[1] < 100 && px.white[3] > 180,
        '纯白区域涂红', JSON.stringify(px.white));
    check(px.orange[0] > 200 && px.orange[1] < 100 && px.orange[3] > 180,
        '只有 R 顶到 255 的橙色也涂红', JSON.stringify(px.orange));
    check(px.dark[2] > 180 && px.dark[0] < 100 && px.dark[3] > 180,
        '只有 R 压到 0 的深蓝涂蓝', JSON.stringify(px.dark));
    check(px.gray[3] === 0, '中性灰不涂', JSON.stringify(px.gray));
    check(px.outside[3] === 0 && px.offPhoto[3] === 0,
        '照片矩形外（边框/留白）一个像素都不涂', JSON.stringify([px.outside, px.offPhoto]));

    // J 键：一次关、再一次开
    await exec(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); return true; })()`);
    await sleep(60);
    const afterOff = await exec(`(() => {
        const ov = document.getElementById('clipOverlay');
        const d = ov.getContext('2d').getImageData(Math.round(400 * (ov.width / 800)), Math.round(187 * (ov.height / 600)), 1, 1).data;
        return { on: QfsClip.isOn(), alpha: d[3] };
    })()`);
    check(afterOff.on === false && afterOff.alpha === 0, 'J 键关闭并把画面擦干净', JSON.stringify(afterOff));

    await exec(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); return true; })()`);
    await sleep(60);
    check((await exec('QfsClip.isOn()')) === true, 'J 键再按一次重新打开');

    // 对比原图：画面换回原图，警示必须收起；松开后回来
    const sup = await exec(`(() => {
        App.draggingCompare = true; QfsClip.setSuppressed();
        const ov = document.getElementById('clipOverlay');
        const g = ov.getContext('2d');
        const d = g.getImageData(Math.round(400 * (ov.width / 800)), Math.round(187 * (ov.height / 600)), 1, 1).data;
        const off = d[3];
        App.draggingCompare = false; QfsClip.setSuppressed();
        return { off, onAgain: QfsClip.stats().hi > 0 };
    })()`);
    await sleep(160);
    const supBack = await exec(`(() => {
        const ov = document.getElementById('clipOverlay');
        const d = ov.getContext('2d').getImageData(Math.round(400 * (ov.width / 800)), Math.round(187 * (ov.height / 600)), 1, 1).data;
        return d[3];
    })()`);
    check(sup.off === 0, '按住空格对比原图时警示收起', JSON.stringify(sup));
    check(supBack > 180, '松开后警示回到画面上', String(supBack));

    // 缩放：画布显示尺寸减半，警示跟着照片矩形缩放，不重扫像素
    const zoom = await exec(`(() => {
        App.dom.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 });
        QfsClip.sync();
        const ov = document.getElementById('clipOverlay');
        const g = ov.getContext('2d');
        const k = ov.width / 400;
        const at = (bx, by) => {
            const d = g.getImageData(Math.round(bx * k), Math.round(by * k), 1, 1).data;
            return d[3];
        };
        return { css: ov.style.width, w: ov.width, h: ov.height, dpr: window.devicePixelRatio || 1,
            // 半尺寸后照片矩形是 CSS 100,75 200x150；第一段(白)在 y≈75+18
            inPhoto: at(200, 93),
            // 这个点在旧矩形（200..600 × 150..450）里，在新矩形外：必须已经不涂
            oldOnly: at(350, 250),
            outside: at(10, 10) };
    })()`);
    check(zoom.css === '400px' && zoom.w === Math.round(Math.min(2, zoom.dpr) * 400),
        '缩放后警示层跟着画布的视觉尺寸走', JSON.stringify(zoom));
    check(zoom.inPhoto > 180 && zoom.outside === 0 && zoom.oldOnly === 0,
        '缩放后仍只盖住照片（位置随视觉矩形重算，不是留在旧位置）', JSON.stringify(zoom));

    // 换成一张没有溢出的灰图：读数归零、画面清空
    const none = await exec(`(() => {
        const c = document.createElement('canvas'); c.width = 320; c.height = 240;
        const g = c.getContext('2d');
        g.fillStyle = 'rgb(120,122,124)'; g.fillRect(0, 0, 320, 240);
        const im = { el: c, w: 320, h: 240, name: 'flat', grade: null, _grade: null };
        App.images = [im]; App.image = im; App.currentIdx = 0;
        if (App.ensureGrade) App.ensureGrade(im);
        QfsClip.redraw();
        const st = QfsClip.stats();
        const ov = document.getElementById('clipOverlay');
        const d = ov.getContext('2d').getImageData(Math.round(200 * (ov.width / 400)), Math.round(93 * (ov.height / 300)), 1, 1).data;
        return { hi: st.hi, lo: st.lo, alpha: d[3], badge: document.getElementById('clipBadgeHi').textContent };
    })()`);
    check(none.hi === 0 && none.lo === 0 && none.alpha === 0,
        '没有溢出时干净：读数 0、画布不留残影', JSON.stringify(none));
    check(none.badge === '0%', '角标读数归零', none.badge);

    console.log(failures.length ? ('\n' + failures.length + ' 项失败') : '\n全部通过');
    await win.close();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => {
    console.error(e && e.stack || e);
    app.exit(1);
});

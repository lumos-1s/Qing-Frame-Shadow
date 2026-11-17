// 自动调色回归：本地确定性估算（不联网/不跑模型），读原图、幅度保守、可撤销、不落进蒙版。
// 用法: node tools/run-electron.js tools/test-auto-grade.js
'use strict';

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
        if (await exec('!!(window.App && App.dom)')) break;
        await sleep(250);
    }
    await exec(`(() => { localStorage.setItem('qfs_intro_done','1'); if (App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(300);

    // 页面内造四张已知分布的测试图（直接给 canvas，suggest 只依赖 el）
    await exec(`window.__agMake = (kind) => {
        const c = document.createElement('canvas'); c.width = 200; c.height = 120;
        const g = c.getContext('2d', { willReadFrequently: true });
        const d = g.createImageData(c.width, c.height);
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4, v = (x + y) % 90;
            let R, G, B;
            if (kind === 'dark') { R = G = B = 28 + v; }
            else if (kind === 'bright') { R = G = B = 170 + v; }
            else if (kind === 'cast') { R = 225 + (v >> 2); G = 200; B = 150; }
            else { R = G = B = 50 + v * 2; }
            d.data[i] = R; d.data[i+1] = G; d.data[i+2] = B; d.data[i+3] = 255;
        }
        g.putImageData(d, 0, 0);
        return c;
    }; true`);

    const sugg = await exec(`(() => {
        const out = {};
        for (const k of ['dark', 'bright', 'cast', 'neutral']) {
            const im = { el: window.__agMake(k) };
            out[k] = window.QfsAutoGrade.suggest(im);
            out[k + 'Again'] = window.QfsAutoGrade.suggest(im);
        }
        out.module = !!window.QfsAutoGrade && typeof window.QfsAutoGrade.suggest === 'function';
        out.noImage = window.QfsAutoGrade.suggest(null);
        return out;
    })()`);
    check(sugg.module && sugg.noImage === null, '自动调色模块已加载，空图返回 null',
        JSON.stringify({ module: sugg.module, noImage: sugg.noImage }));
    check(sugg.dark && sugg.dark.exp > 0 && sugg.dark.con > 0,
        '偏暗低对比照片：曝光/对比度给正档', JSON.stringify(sugg.dark));
    check(sugg.bright && sugg.bright.exp < 0,
        '偏亮照片：曝光给负档', JSON.stringify(sugg.bright));
    check(sugg.cast && sugg.cast.temp < 0,
        '偏暖照片：色温往冷侧校（保守幅度）', JSON.stringify(sugg.cast));

    const keys = ['exp', 'con', 'sat', 'vib', 'temp', 'tint', 'hi', 'sh', 'white', 'black', 'gam'];
    const finite = Object.keys(sugg).filter((k) => /^(dark|bright|cast|neutral)$/.test(k))
        .every((k) => keys.every((f) => Number.isFinite(sugg[k][f])));
    const bounded = Object.keys(sugg).filter((k) => /^(dark|bright|cast|neutral)$/.test(k))
        .every((k) => Math.abs(sugg[k].exp) <= 0.8 && Math.abs(sugg[k].temp) <= 18
            && Math.abs(sugg[k].tint) <= 12 && Math.abs(sugg[k].con) <= 26);
    check(finite && bounded, '参数全为有限值且不超出保守上限', JSON.stringify({ finite, bounded }));
    const stable = ['dark', 'bright', 'cast', 'neutral'].every((k) =>
        JSON.stringify(sugg[k]) === JSON.stringify(sugg[k + 'Again']));
    check(stable, '同一张原图重复估算结果不变（无累积/无随机）');

    // UI 链路：按钮在直方图脚、点击落参数、压一次撤销；opts.global 保证不滑进蒙版
    const ui = await exec(`(async () => {
        const A = window.App;
        const btn = document.getElementById('btnGradeAuto');
        const inFoot = !!(btn && btn.closest('.histo-foot'));
        const el = window.__agMake('dark');
        const im = { el, name: 'auto-test', w: el.width, h: el.height, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        if (A.ensureGrade) A.ensureGrade(im);
        if (A.setTpl) { A.template = A.defaultTemplate(); A.setTpl(im, A.template); }
        const before = A.undoStack ? A.undoStack.length : 0;
        const want = window.QfsAutoGrade.suggest(im);
        btn.click();
        await new Promise((r) => setTimeout(r, 120));
        const sliderVal = parseFloat((document.getElementById('slGradeExp') || {}).value);
        const got = { inFoot, undoDelta: (A.undoStack ? A.undoStack.length : 0) - before,
            grade: JSON.parse(JSON.stringify(im.grade)), want, sliderVal,
            status: (document.getElementById('stCanvas') || {}).textContent || '' };
        A.undo();
        await new Promise((r) => setTimeout(r, 120));
        got.afterUndoExp = im.grade ? im.grade.exp : null;
        // 单独验证 global 路由：临时换掉 setGrade，看它收到的 opts
        let captured = null;
        const orig = A.setGrade;
        A.setGrade = (patch, opts) => { captured = { patch, opts }; return true; };
        const activeMask = A.activeMask;
        A.activeMask = () => ({ p: {} });
        A.autoGrade();
        A.activeMask = activeMask;
        A.setGrade = orig;
        got.global = !!(captured && captured.opts && captured.opts.global === true);
        return got;
    })()`);
    check(ui.inFoot, '「自动」按钮在直方图脚，和曲线/波形同处一处');
    check(ui.grade && Math.abs(ui.grade.exp - ui.want.exp) < 0.001 && ui.grade.con === ui.want.con,
        '点按钮把建议写进当前照片的调色参数', JSON.stringify({ got: ui.grade && ui.grade.exp, want: ui.want && ui.want.exp }));
    check(ui.undoDelta === 1, '一次点击只压一条撤销', String(ui.undoDelta));
    check(ui.afterUndoExp === null || ui.afterUndoExp === 0, '撤销回到自动调色前的中性参数', String(ui.afterUndoExp));
    check(ui.global, '即使有活动蒙版也作用于整张照片（global）', String(ui.global));
    check(/自动调色/.test(ui.status), '状态栏给出本地计算/可撤销反馈', ui.status.slice(0, 90));

    console.log(failures.length ? `\n未通过 ${failures.length} 项：` + failures.map((f) => '\n - ' + f).join('') : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); app.exit(1); });

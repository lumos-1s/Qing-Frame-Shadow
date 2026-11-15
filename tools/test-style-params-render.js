// 样式私有参数骨架 · 真实渲染回归
//   node tools/run-electron.js tools/test-style-params-render.js
//
// 纯 node 的 test-style-params.js 管声明与接线,这里管「真的画出来了」:
//  ① 声明表生成 4 行控件、组按样式显隐
//  ② 把默认值写进模板 与「完全不写字段」逐像素一致（零回归的硬证据）
//  ③ 每个参数推到极值都真的改变画面（不出现拖了没反应的假控件）
//  ④ 滑块输入 → 写进 t.styleParams[STYLE];复位按钮 → delete 干净
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (ok, label, extra) => {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
};

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); }
    catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'quit-and-install', 'open-external', 'open-data-dir',
    'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.26', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));

const PROBE = `(async () => {
    const A = window.App, SP = window.StyleParams;
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    const out = { errs: [] };
    if (!SP || !window.QfsStyleParamsUI) return { errs: ['声明表或 UI 模块未加载'] };

    const c0 = document.createElement('canvas'); c0.width = 800; c0.height = 600;
    const g0 = c0.getContext('2d');
    const cols = ['#e83434', '#2e6fe0', '#28b46a', '#e8d24a'];
    for (let i = 0; i < 4; i++) { g0.fillStyle = cols[i]; g0.fillRect((i % 2) * 400, Math.floor(i / 2) * 300, 400, 300); }
    g0.fillStyle = '#ffffff'; g0.fillRect(360, 260, 80, 80);
    const el = new Image();
    await new Promise(r => { el.onload = r; el.onerror = r; el.src = c0.toDataURL('image/png'); });
    const im = { el, name: 'sp.png', path: null, w: 800, h: 600,
        exif: { make: 'SONY', model: 'A7 IV', fNumber: 2.8, focalLength: 50, iso: 100, exposureTime: 0.008 },
        customSettings: null, grade: null };
    for (let i = 0; i < 80 && (!A.presets || !A.presets.length); i++) await nap(100);
    const preset = (A.presets || []).find(p => String(p.photoFrameStyle || '').toUpperCase() === 'CARD_3D');
    A.images = [im]; A.image = im; A.currentIdx = 0; A.selectedIdx = [0];
    A.template = JSON.parse(JSON.stringify(preset || A.defaultTemplate()));
    A.template.photoFrameStyle = 'CARD_3D';
    if (A.setTpl) A.setTpl(im, A.template);
    if (A.updateEmptyState) A.updateEmptyState();
    if (A.switchTab) A.switchTab('canvas');
    if (A.refreshUI) A.refreshUI();
    if (A.updatePersonalVisibility) A.updatePersonalVisibility();
    await nap(200);

    const cv = document.getElementById('previewCanvas');
    const fp = () => {
        const g = cv.getContext('2d');
        const d = g.getImageData(0, 0, cv.width, cv.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i] + d[i+1] * 3 + d[i+2] * 7) >>> 0;
        return { w: cv.width, h: cv.height, hash: h };
    };
    const same = (a, b) => a.w === b.w && a.h === b.h && a.hash === b.hash;
    const render = async () => { A.renderPreview(); await nap(90); };
    const specs = SP.forStyle('CARD_3D');
    const clear = () => { delete A.template.styleParams; };

    // ① UI 生成与显隐
    const grp = document.getElementById('grpStyleParams');
    out.group = { exists: !!grp, shown: !!grp && getComputedStyle(grp).display !== 'none',
        inCanvas: !!(grp && grp.closest('#panel-canvas')) };
    out.rows = specs.map(p => {
        const row = document.getElementById('row_sp_CARD_3D_' + p.key);
        const sl = document.getElementById('sl_sp_CARD_3D_' + p.key);
        return { key: p.key, row: !!row, slider: !!sl,
            label: row ? (row.querySelector('label') || {}).textContent : null,
            min: sl ? Number(sl.min) : null, max: sl ? Number(sl.max) : null };
    });

    // ② 缺省态 = 写满默认值
    clear(); await render();
    const base = fp();
    out.base = base;
    for (const p of specs) SP.set(A.template, 'CARD_3D', p, p.def);
    await render();
    out.defSame = same(base, fp());

    // ③ 每个参数推到极值都要真的改变画面
    out.changed = {};
    for (const p of specs) {
        clear();
        SP.set(A.template, 'CARD_3D', p, p.max);
        await render();
        const now = fp();
        out.changed[p.key] = { diff: !same(base, now), w: now.w, h: now.h };
    }

    // ④ 复位回基线 + 字段清理
    SP.reset(A.template, 'CARD_3D');
    await render();
    out.resetSame = same(base, fp());
    out.resetClean = A.template.styleParams === undefined;

    // ④ 真实滑块输入 → 写字段;复位按钮 → delete
    clear();
    if (A.refreshUI) A.refreshUI();
    if (A.updatePersonalVisibility) A.updatePersonalVisibility();
    await nap(80);
    const slPad = document.getElementById('sl_sp_CARD_3D_padX');
    if (slPad) {
        slPad.value = '32';
        slPad.dispatchEvent(new Event('input', { bubbles: true }));
    }
    out.inputWrite = !!(A.template.styleParams && A.template.styleParams.CARD_3D
        && A.template.styleParams.CARD_3D.padX === 32);
    out.serialized = JSON.stringify(A.template).indexOf('styleParams') >= 0;
    if (A.cloneTemplate) {
        const snap = A.cloneTemplate();
        out.undoCarries = !!(snap.styleParams && snap.styleParams.CARD_3D
            && snap.styleParams.CARD_3D.padX === 32);
    }
    const btn = document.getElementById('btnStyleParamsReset');
    if (btn) btn.click();
    out.btnReset = A.template.styleParams === undefined;

    // 切到未声明的样式:整组收起,不留假滑块
    A.template.photoFrameStyle = 'CARD_SIMPLE';
    if (A.updatePersonalVisibility) A.updatePersonalVisibility();
    out.hiddenOther = !!grp && getComputedStyle(grp).display === 'none';
    return out;
})()`;

async function main() {
    const win = new BrowserWindow({
        width: 1400, height: 950, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await sleep(500);
    await exec(`(() => { try { localStorage.setItem('qfs_intro_done','1'); } catch(_){} if (window.App && App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(1200);

    const o = await exec(PROBE);
    if (!o || (o.errs && o.errs.length)) {
        check(false, '探针可用', JSON.stringify(o && o.errs));
        app.exit(1);
        return;
    }
    check(!!o.base && o.base.w > 100 && o.base.h > 100, '⓪ CARD_3D 真实渲染有画面',
        JSON.stringify(o.base));
    check(o.group.exists && o.group.shown && o.group.inCanvas,
        '① 样式参数组出现在画布栏且可见', JSON.stringify(o.group));
    check(o.rows.length === 4 && o.rows.every(r => r.row && r.slider && r.label && r.max > r.min),
        '① 声明表生成 4 行控件（标签 + 滑块 + 范围）', JSON.stringify(o.rows));
    check(o.defSame === true, '② 写满默认值与完全不写字段逐像素一致', JSON.stringify(o.base));
    for (const p of ['padX', 'padBottom', 'thick', 'shadow']) {
        check(o.changed[p] && o.changed[p].diff, `③ ${p} 推到极值真的改变画面`,
            JSON.stringify(o.changed[p]));
    }
    check(o.resetSame === true && o.resetClean === true,
        '④ 复位后画面回基线、字段删干净', `same=${o.resetSame} clean=${o.resetClean}`);
    check(o.inputWrite === true, '④ 真实滑块输入写进 t.styleParams.CARD_3D');
    check(o.serialized === true, '④ 新字段随模板序列化（工程/分享码自动带上）');
    check(o.undoCarries === true, '④ 撤销栈快照全量带上新字段');
    check(o.btnReset === true, '④ 复位按钮走 delete 而不是写默认数字');
    check(o.hiddenOther === true, '① 未声明的样式整组收起');

    // QF_SP_SHOT=<path> 时顺手拍一张面板图(仅供人工验收,不参与断言)
    if (process.env.QF_SP_SHOT) {
        await exec(`(() => {
            const A = window.App;
            A.template.photoFrameStyle = 'CARD_3D';
            if (A.updatePersonalVisibility) A.updatePersonalVisibility();
            const grp = document.getElementById('grpStyleParams');
            const b = document.querySelector('.insp-body');
            if (grp && b) b.scrollTop = Math.max(0, grp.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop - 20);
            return true;
        })()`);
        win.showInactive();
        await sleep(350);
        await win.webContents.capturePage();
        await sleep(200);
        const box = await exec(`(() => { const r = document.getElementById('inspector').getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
        const img = await win.webContents.capturePage(box);
        fs.writeFileSync(path.resolve(process.env.QF_SP_SHOT), img.toPNG());
        console.log('SHOT', path.resolve(process.env.QF_SP_SHOT));
    }

    console.log('─'.repeat(72));
    console.log(failures.length ? `✖ ${failures.length} 项未通过` : 'ALL PASS');
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
    console.error('探针异常:', (e && e.stack) || String(e));
    app.exit(1);
});

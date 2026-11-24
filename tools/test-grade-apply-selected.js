// 调色参数「应用到选中」回归：以前 ⋯ 菜单只有「应用到全部」，
// 手动拖出来的一套参数想给其中几张，只能全量覆盖后逐张改回来。
// 顶栏「同步到选中」只搬边框，预设右键的「应用到选中照片」只针对已保存预设，
// 两者都不覆盖这个场景。
//
// 用法：node tools/run-electron.js tools/test-grade-apply-selected.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => { try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, n + '.json'), 'utf8')); } catch (_) { return null; } });
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.26', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

async function main() {
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
        const imgs = [];
        for (let k = 0; k < 4; k++) {
            const c = document.createElement('canvas'); c.width = 200; c.height = 140;
            const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, 200, 140);
            const el = new Image();
            await new Promise((r2) => { el.onload = r2; el.onerror = r2; el.src = c.toDataURL('image/png'); });
            imgs.push({ el, name: 'p' + k + '.png', path: null, w: 200, h: 140,
                        grade: { exp: 0, con: 0 }, exif: {}, customSettings: null });
        }
        A.images = imgs; A.image = imgs[0]; A.currentIdx = 0;
        A.selectedIdx = [0]; A.batchSel = [0];
        A.template = A.defaultTemplate(); A.updateEmptyState();
        const vals = () => A.images.map((im) => [Number((im.grade || {}).exp) || 0, Number((im.grade || {}).con) || 0]);
        const src = imgs[0].grade;
        src.exp = 0.55; src.con = 20;
        const before = vals();

        // ① 菜单两个入口都在，且按钮确实绑定了新方法
        const menu = { all: !!document.getElementById('btnGradeApplyAll'),
                       selected: !!document.getElementById('btnGradeApplySelected'),
                       label: (document.getElementById('btnGradeApplySelected') || {}).textContent || '' };

        // ② 没多选时：不动任何图，给出明确提示
        const noSel = { ret: A.applyGradeToSelected(), vals: vals(), status: A.statusMsg || '' };

        // ③ 只选 0 + 2（0 是同步源）：2 号被覆盖，1、3 号保持原样
        A.selectedIdx = [0, 2]; A.batchSel = [0, 2];
        document.getElementById('btnGradeApplySelected').click();
        const partial = { vals: vals(), status: A.statusMsg || '' };

        // ④ 曲线必须深拷贝：改源图不能把目标的点串掉
        imgs[0].grade.curve = { rgb: [[0, 0.15], [1, 1]] };
        A.selectedIdx = [0, 1]; A.batchSel = [0, 1];
        A.applyGradeToSelected();
        const ca = imgs[0].grade.curve, cb = imgs[1].grade.curve;
        const curve = { same: ca === cb, b0: cb && cb.rgb && cb.rgb[0] && cb.rgb[0][1] };
        if (ca && ca.rgb) ca.rgb[0][1] = 0.9;
        curve.after = cb && cb.rgb && cb.rgb[0] && cb.rgb[0][1];

        // ⑤ Ctrl+A 式的全选走「应用到选中」：其余 3 张全部更新
        imgs[0].grade.exp = 0.7;
        A.selectedIdx = [0, 1, 2, 3]; A.batchSel = [0, 1, 2, 3];
        A.applyGradeToSelected();
        const allSel = { vals: vals(), status: A.statusMsg || '' };

        // ⑥ 老的「应用到全部」入口保持行为不变（多个测试用例直接调它）
        imgs[0].grade.exp = 0.9;
        A.applyGradeToAll();
        const all = { vals: vals(), status: A.statusMsg || '' };
        return { before, menu, noSel, partial, curve, allSel, all,
        presetUndo: (() => {
            // 批量应用预设后，切到被改的其它照片按 Ctrl+Z，应能各自撤销。
            const fake = { disp: '测试预设', grade: A.normalizeGrade({ exp: 0.33, con: 12 }) };
            const before = imgs.map((im) => Number((im.grade || {}).exp) || 0);
            A.currentIdx = 0; A.image = imgs[0];
            A.applyGradePreset(fake, [0, 1, 2]);
            const applied = imgs.map((im) => Number((im.grade || {}).exp) || 0);
            A.selectImage(1);
            A.undo();
            const undone = imgs.map((im) => Number((im.grade || {}).exp) || 0);
            return { before, applied, undone, status: A.statusMsg || '' };
        })() };
    })()`);

    check(r.menu.all && r.menu.selected && r.menu.label.indexOf('应用到选中') >= 0,
        '调色 ⋯ 菜单里「应用到全部」「应用到选中」并存', JSON.stringify(r.menu));
    check(r.noSel.ret === false && r.noSel.status.indexOf('请先') >= 0
        && JSON.stringify(r.noSel.vals) === JSON.stringify(r.before),
        '没多选时不改任何照片，给出操作提示', `status=${r.noSel.status}`);
    check(r.partial.vals[2][0] === 0.55 && r.partial.vals[2][1] === 20
        && r.partial.vals[1][0] === 0 && r.partial.vals[3][0] === 0
        && r.partial.vals[0][0] === 0.55,
        '只应用到选中：第 3 张变、其余不动、源图不变',
        JSON.stringify(r.partial.vals));
    check(r.partial.status.indexOf('选中的 1 张') >= 0,
        '状态栏说明实际写入了几张', r.partial.status);
    check(!r.curve.same && r.curve.b0 === 0.15 && r.curve.after === 0.15,
        '应用到选中也深拷贝曲线（改源图不串台）', JSON.stringify(r.curve));
    check(r.allSel.vals.every((v) => v[0] === 0.7) && r.allSel.status.indexOf('选中的 3 张') >= 0,
        'Ctrl+A 全选后走「应用到选中」：其余 3 张都更新',
        `${JSON.stringify(r.allSel.vals)} status=${r.allSel.status}`);
    check(r.all.vals.every((v) => v[0] === 0.9) && r.all.status.indexOf('应用到其余 3 张') >= 0,
        '「应用到全部」行为保持不变（两个入口共用深拷贝）', r.all.status);
    check(r.presetUndo.applied[1] === 0.33 && r.presetUndo.undone[1] === r.presetUndo.before[1]
          && r.presetUndo.undone[2] === 0.33 && /撤销/.test(r.presetUndo.status),
        '批量应用调色预设后，切到目标照片可逐张撤销', JSON.stringify(r.presetUndo));

    console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e && e.stack ? e.stack : e); app.exit(1); });

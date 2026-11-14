// .qfs 工程文件保存透明图的回归：
// 旋转/裁切透明 PNG、艺术卡、羽化边框后 im.el 是带 alpha 的 canvas。
// qfsReusableSource 会把它当「可复用画布」直接 toDataURL('image/jpeg')，
// 透明像素被写成黑块 —— 存工程再打开就整片黑（与早期「旋转变黑」同源）。
//
// 用法：node tools/run-electron.js tools/test-qfs-alpha.js
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

    let r = null;
    try {
    r = await exec(`(async () => { try {
        const A = window.App;
        window.ensureFullGrade = () => {};   // 只测编码路径，跳过 ACR 烘焙
        const W = 200, H = 150;
        const mk = (cutCorners) => {
            const c = document.createElement('canvas'); c.width = W; c.height = H;
            const g = c.getContext('2d');
            g.clearRect(0, 0, W, H);
            g.fillStyle = '#cc3333'; g.fillRect(0, 0, W, H);
            if (cutCorners) {
                g.clearRect(0, 0, 20, 20); g.clearRect(W - 20, 0, 20, 20);
                g.clearRect(0, H - 20, 20, 20); g.clearRect(W - 20, H - 20, 20, 20);
            }
            return c;
        };
        const cornerOf = (b64) => new Promise((res) => {
            const i = new Image();
            i.onload = () => {
                const c = document.createElement('canvas');
                c.width = i.naturalWidth; c.height = i.naturalHeight;
                const g = c.getContext('2d'); g.drawImage(i, 0, 0);
                res(Array.from(g.getImageData(2, 2, 1, 1).data));
            };
            i.onerror = () => res([-1, -1, -1, -1]);
            i.src = 'data:image/jpeg;base64,' + b64;
        });
        const imOf = (c) => ({ el: window.qfsCanvasSource(c), name: 't.png', path: null,
            w: W, h: H, exif: {}, customSettings: null });

        const trans = mk(true);
        const imT = imOf(trans);
        A.images = [imT]; A.image = imT; A.currentIdx = 0;
        A.selectedIdx = [0]; A.batchSel = [0]; A.template = A.defaultTemplate();
        const reusable = A.qfsReusableSource(imT) === imT.el;
        const opaqueFlag = window.qfsAllOpaque(trans);
        const b64T = A.imageToQfsBase64(imT, 'image/jpeg', 0.92);
        const cornerT = await cornerOf(b64T);
        // 反向自检：旧行为直接对这块 canvas 编码，角必然是黑的
        const legacy = trans.toDataURL('image/jpeg', 0.92).split(',')[1];
        const cornerLegacy = await cornerOf(legacy);

        const solid = mk(false);
        const imO = imOf(solid);
        const opaqueSolid = window.qfsAllOpaque(solid);
        const b64O = A.imageToQfsBase64(imO, 'image/jpeg', 0.92);
        const cornerO = await cornerOf(b64O);

        // 旧工程（0.1.25 之前）的 exif 里可能还留着原始 orientation=6。
        // .qfs 存的是烘焙后的正方向像素，恢复时绝不能再按它转第二次。
        const old = document.createElement('canvas'); old.width = 200; old.height = 100;
        const og = old.getContext('2d'); og.fillStyle = '#3366cc'; og.fillRect(0, 0, 200, 100);
        const bundle = {
            images: [{ name: 'old.qfs', data: old.toDataURL('image/jpeg', 0.92),
                       exif: { orientation: 6, make: 'Canon' }, w: 100, h: 200 }],
            template: A.defaultTemplate(), session: { currentIdx: 0 }
        };
        // 只验数据重建：工程恢复会连带一整串 UI 刷新，精简窗口里没必要跑，
        // 垫空桩避免无关异常把 probe 打断。
        ['onSettingCommit','queueThumb','invalidateStyleCaches','buildThumbnails',
         'afterImageSelect','onGradePresetImageChange','refreshUI','scheduleRender',
         'scheduleDraft','saveDraftNow','setStatus','finishImportProgress',
         'setTpl','queueThumb'].forEach((k) => { A[k] = () => {}; });
        let restoreErr = '';
        try { await A.restoreQfsProject(bundle, 'old.qfs'); }
        catch (e) { restoreErr = String((e && e.message) || e); }
        const rim = A.images[0];
        const legacyProject = rim ? { w: rim.w, h: rim.h,
            orientation: rim.exif && rim.exif.orientation,
            make: rim.exif && rim.exif.make, tag: rim.el && rim.el.tagName } : null;
        return { reusable, opaqueFlag, cornerT, cornerLegacy, opaqueSolid, cornerO, legacyProject, restoreErr };
    } catch (e) { return { fatal: String((e && e.stack) || e) }; } })()`);
    } catch (e) { console.log('EXECERR ' + String((e && e.stack) || e).slice(0, 700)); r = { fatal: 'exec' }; }

    if (r.fatal) console.log('FATAL ' + r.fatal.slice(0, 900));
    check(r.reusable === true && r.opaqueFlag === false,
        '带透明角的 canvas 结构上可复用，但 qfsAllOpaque 判定为不可用',
        `reusable=${r.reusable} opaque=${r.opaqueFlag}`);
    check(r.cornerT[0] > 200 && r.cornerT[1] > 200 && r.cornerT[2] > 200,
        '存 .qfs 时透明角被铺白底，不再是黑块', `rgba=${r.cornerT.join(',')}`);
    check(r.cornerLegacy[0] < 90 && r.cornerLegacy[1] < 90 && r.cornerLegacy[2] < 90,
        '反向自检：旧路径直接编码确实会变黑（断言不是空跑）',
        `rgba=${r.cornerLegacy.join(',')}`);
    check(r.opaqueSolid === true && r.cornerO[0] > 180 && r.cornerO[1] < 110,
        '全不透明的普通照片仍走复用优化，红色像素保持',
        `opaque=${r.opaqueSolid} rgba=${r.cornerO.join(',')}`);
    check(r.legacyProject && r.legacyProject.w === 200 && r.legacyProject.h === 100
        && r.legacyProject.orientation === 1 && r.legacyProject.make === 'Canon'
        && r.legacyProject.tag === 'IMG',
        '旧工程带 orientation=6 也不二次旋转，宽高与元数据保持',
        JSON.stringify({ legacyProject: r.legacyProject, restoreErr: r.restoreErr }));

    console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e && e.stack ? e.stack : e); app.exit(1); });

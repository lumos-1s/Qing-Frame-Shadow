// 主进程集成用例：真实主进程 + 真实 preload + 真实渲染页，不 mock IPC。
//
// 覆盖 opencode 那轮加固的核心承诺（每一条都曾是真实缺陷）：
//   1. sandbox 开着时 preload 仍可用（contextIsolation + sandbox）
//   2. 草稿里的大 data: 图能外置成 qfasset: 再原样还原（localStorage 超限丢图）
//   3. qflocal:// 只服务主进程登记过的图片（未登记 → 加载失败）
//   4. 文件夹导入会登记每一张（曾漏登记导致整批 403）
//   5. 没有 pick-export-location 令牌就不能写盘
//   6. 导出文件名里的 ../ 不能逃出目标目录
//   7. .qfs 流式导出（begin→add→finish）能回读，且逐张写、不整包驻留内存
//   8. EXIF 方向只应用一次（Chromium 已转正，主进程不再报告原始 orientation）
//   9. load-preset 的 ../ 读不到预设目录外
//  10. 非 file:// 主框架调不动 IPC（统一来源校验）
//  11. 蒙版列表不把 id 拼成 HTML（防 UI 注入）
//
// 注意：不依赖 shared/brandlogos（那是本机素材、不入库、CI 上没有）。
// 示例图在临时目录里现生成。
'use strict';
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-it-'));
const qfsOut = path.join(tmp, 'roundtrip.qfs');
const exportDir = path.join(tmp, 'export-out');
const folderImport = path.join(tmp, 'folder-import');
fs.mkdirSync(exportDir, { recursive: true });
fs.mkdirSync(folderImport, { recursive: true });

// 1×1 PNG：既当"导入文件夹里的照片"，也当 .qfs 里的图
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = 'data:image/png;base64,' + PNG_B64;
const importedPhoto = path.join(folderImport, 'folder-photo.png');
// 这张必须放在导入目录**之外**：放进去了就会被文件夹导入一并登记，测不到"未登记"分支
const notRegisteredPhoto = path.join(tmp, 'not-registered.png');
fs.writeFileSync(importedPhoto, Buffer.from(PNG_B64, 'base64'));
fs.writeFileSync(notRegisteredPhoto, Buffer.from(PNG_B64, 'base64'));

// 合成一张带指定 EXIF Orientation 的 JPEG：在 SOI 之后插入 APP1/Exif。
// 用于验证「Chromium 解码时已按 Orientation 转向，主进程/渲染层不能转第二次」。
function withExifOrientation(jpeg, orientation) {
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0, 'ascii');
    tiff.writeUInt16LE(0x2a, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    tiff.writeUInt32LE(0, 22);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const app1 = Buffer.alloc(4);
    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}
let openImageTarget = null;

app.setPath('userData', path.join(tmp, 'userData'));

// load-preset 穿越回归用的「目录外 JSON」：内容无所谓，能读到就说明穿越成功。
const secretJson = path.join(tmp, 'secret.json');
fs.writeFileSync(secretJson, '{"secret":123}', 'utf-8');
const relToSecret = path.relative(path.join(__dirname, '..', 'shared', 'presets'), secretJson)
    .replace(/\.json$/i, '');

const fmt = (p) => p.replace(/\\/g, '\\\\');
dialog.showSaveDialog = async (opts) => {
    if (opts && opts.title === '导出工程 (.qfs)') return { canceled: false, filePath: qfsOut };
    if (opts && opts.title === '导出图片') return { canceled: false, filePath: path.join(exportDir, 'one.png') };
    return { canceled: true };
};
dialog.showOpenDialog = async (opts) => {
    if (opts && opts.title === '打开工程 (.qfs)') return { canceled: false, filePaths: [qfsOut] };
    if (opts && opts.title === '选择导出目录') return { canceled: false, filePaths: [exportDir] };
    if (opts && opts.title === '选择照片文件夹（含子文件夹）') return { canceled: false, filePaths: [folderImport] };
    if (opts && opts.title === '选择照片' && openImageTarget) return { canceled: false, filePaths: [openImageTarget] };
    return { canceled: true };
};

require('../src/main/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
let total = 0;
const check = (ok, label, detail) => {
    total++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
    if (detail) console.log(`       ${detail}`);
    if (!ok) fails.push(label);
};

(async () => {
    await app.whenReady();
    await sleep(2500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { console.log('FAIL 没有打开窗口'); app.exit(1); return; }

    console.log('主进程集成（sandbox / 草稿外置 / qflocal 白名单 / 导出令牌 / 流式 qfs / EXIF 方向 / IPC 来源 / 蒙版注入）');
    console.log('─'.repeat(84));

    const prefs = win.webContents.getLastWebPreferences();
    check(prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false,
        '窗口是 sandbox + contextIsolation + 无 nodeIntegration',
        `sandbox=${prefs.sandbox} contextIsolation=${prefs.contextIsolation} nodeIntegration=${prefs.nodeIntegration}`);

    const out = await win.webContents.executeJavaScript(`(async () => {
        const api = window.qingframe;
        const r = { api: !!api, sandboxProbe: typeof require, errors: [] };
        const load = (p) => new Promise((res) => {
            const img = new Image();
            img.onload = () => res(true);
            img.onerror = () => res(false);
            img.src = 'qflocal://img?p=' + encodeURIComponent(p);
        });
        try {
            // 1) 草稿附件：大 data: → qfasset: → 还原
            const big = ${JSON.stringify('data:image/png;base64,')} + 'A'.repeat(10000);
            const draft = { v: 1, template: { logoElements: [{ dataUrl: big }] } };
            const ext = await api.externalizeDraft(draft);
            r.draftMarker = !!(ext.ok && /^qfasset:/.test(ext.draft.template.logoElements[0].dataUrl));
            const hyd = await api.hydrateDraft(ext.draft);
            r.draftRoundtrip = !!(hyd.ok && hyd.draft.template.logoElements[0].dataUrl === big);
            r.sandboxProbe = typeof require;

            // 2) qflocal：登记过的能读，没登记的读不到
            const allowed = ${JSON.stringify(fmt(importedPhoto))};
            const denied = ${JSON.stringify(fmt(notRegisteredPhoto))};
            await api.readExif(allowed);          // read-exif 会登记该路径
            r.qflocalAllowed = await load(allowed);
            r.qflocalDenied = await load(denied);

            // 3) 文件夹导入：整批都要登记（曾漏登记 → 全部 403）
            const folder = await api.openImageFolder();
            r.folderItems = folder && folder.items ? folder.items.length : 0;
            r.folderLoad = r.folderItems ? await load(folder.items[0].path) : false;

            // 4) 没有令牌不能写盘
            const wr = await api.writeExportFiles({ location: { mode: 'dir', dir: ${JSON.stringify(fmt(exportDir))} },
                files: [{ data: 'AAAA', filename: 'x.png' }] });
            r.exportBlocked = !!(wr && wr.error && /未授权/.test(wr.error));

            // 5) 文件名里的 ../ 必须被夹在目录内
            const locDir = await api.pickExportLocation({ count: 2, hintName: 'x' });
            const wr2 = await api.writeExportFiles({ location: locDir,
                files: [{ data: ${JSON.stringify(PNG_DATA_URL)}, filename: '..\\\\..\\\\escape.png', subdir: '..\\\\..' }] });
            r.traversalWrite = !!(wr2 && wr2.ok === 1);

            // 6) 流式 .qfs：begin → add → finish → 回读
            const begin = await api.qfsBeginExport({ name: '集成测试', session: { currentIdx: 0 }, template: { templateName: 't' } });
            if (!begin.ok) throw new Error('begin: ' + begin.error);
            const add = await api.qfsAddImage({ id: begin.id, entry: { name: '..\\\\..\\\\evil', w: 1, h: 1, exif: {} },
                data: ${JSON.stringify(PNG_DATA_URL)} });
            if (!add.ok) throw new Error('add: ' + add.error);
            const fin = await api.qfsFinishExport(begin.id);
            if (!fin.ok) throw new Error('finish: ' + fin.error);
            const back = await api.openQfs();
            r.qfs = !!(back.ok && back.data.images && back.data.images.length === 1 && back.data.images[0].data);
            r.qfsName = back.ok && back.data.images[0] ? back.data.images[0].name : '';

            // 7) load-preset 的名字只能当单个文件名：带 ../ 不能读到预设目录外
            r.presetTraversal = await api.loadPreset(${JSON.stringify(relToSecret)});
        } catch (e) { r.errors.push(String(e && e.message || e)); }
        return r;
    })()`);

    check(out.api === true, 'preload 暴露 window.qingframe', null);
    check(out.sandboxProbe === 'undefined', 'sandbox 下渲染页拿不到 require', `typeof require = ${out.sandboxProbe}`);
    check(out.draftMarker === true, '草稿大图被外置为 qfasset:', null);
    check(out.draftRoundtrip === true, '草稿还原后与原 data: 完全一致', null);
    check(out.qflocalAllowed === true, 'qflocal 能读已登记的图片', null);
    check(out.qflocalDenied === false, 'qflocal 拒绝未登记的图片', null);
    check(out.folderItems === 1, '文件夹导入返回 1 张', `items=${out.folderItems}`);
    check(out.folderLoad === true, '文件夹导入的图已登记、能加载', null);
    check(out.exportBlocked === true, '没有导出令牌时拒绝写盘', null);

    const escaped = fs.existsSync(path.join(exportDir, '..', '..', 'escape.png'));
    const inDir = fs.existsSync(path.join(exportDir, 'escape.png'));
    check(out.traversalWrite === true && inDir && !escaped, '导出文件名的 ../ 被夹在目标目录内',
        `写入目录内=${inDir} 逃出目录=${escaped}`);

    check(out.qfs === true, '.qfs 流式导出后能回读（begin→add→finish）', `name=${JSON.stringify(out.qfsName)}`);
    check(out.presetTraversal === null, 'load-preset 的 ../ 不能读到预设目录外', JSON.stringify(out.presetTraversal));
    check(fs.existsSync(qfsOut) && fs.statSync(qfsOut).size > 0, '.qfs 文件已落盘',
        fs.existsSync(qfsOut) ? `size=${fs.statSync(qfsOut).size}B` : 'missing');
    check(!out.errors.length, '渲染侧无异常', out.errors.join(' | '));

    // 8) EXIF 方向：Chromium 解码 JPEG 时已按 Orientation 转过像素，主进程不能再报原始值，
    //    否则渲染层 applyOrientation() 会转第二次，竖拍照片导入后横躺。
    //    800×600 的原图写 Orientation=6：正确结果应是 600×800，且红(原上方)在右、蓝在左。
    const orientedJpeg = path.join(tmp, 'oriented.jpg');
    const jpegB64 = await win.webContents.executeJavaScript(`(() => {
        const c = document.createElement('canvas'); c.width = 800; c.height = 600;
        const g = c.getContext('2d');
        g.fillStyle = '#ff0000'; g.fillRect(0, 0, 800, 300);
        g.fillStyle = '#0000ff'; g.fillRect(0, 300, 800, 300);
        return c.toDataURL('image/jpeg', 1).split(',')[1];
    })()`);
    fs.writeFileSync(orientedJpeg, withExifOrientation(Buffer.from(jpegB64, 'base64'), 6));
    openImageTarget = orientedJpeg;
    const orient = await win.webContents.executeJavaScript(`(async () => {
        await window.App.openImage();
        await new Promise((r) => setTimeout(r, 250));
        const im = window.App.image;
        if (!im || !im.el) return { err: '没有导入成功' };
        const c = document.createElement('canvas');
        c.width = im.el.naturalWidth || im.el.width;
        c.height = im.el.naturalHeight || im.el.height;
        const g = c.getContext('2d');
        g.drawImage(im.el, 0, 0);
        const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3);
        const exif = await window.qingframe.readExif(im.path);
        return {
            w: im.w, h: im.h,
            left: px(8, c.height >> 1), right: px(c.width - 9, c.height >> 1),
            orientation: exif && exif.orientation
        };
    })()`);
    openImageTarget = null;
    const bluish = (p) => !!p && p[2] > 180 && p[0] < 80;
    const reddish = (p) => !!p && p[0] > 180 && p[2] < 80;
    check(orient.w === 600 && orient.h === 800,
        'EXIF Orientation=6 的 JPEG 导入后是正方向（600×800）', JSON.stringify(orient));
    check(bluish(orient.left) && reddish(orient.right),
        'EXIF 方向只转一次：蓝在左、红在右', JSON.stringify(orient));
    check(orient.orientation === 1,
        '主进程对 Chromium 已校正的格式报告 orientation=1', String(orient.orientation));

    // 9) 导航兜底：拖放落到没人处理的区域时，Chromium 会按默认行为导航到那个 file://，
    //    整个窗口被一张图替换（用户以为"拖进去把软件弄坏了"）。主进程必须拦下任何导航。
    const beforeNav = win.webContents.getURL();
    try {
        await win.webContents.executeJavaScript(`location.href = 'file:///C:/Windows/win.ini'; true`);
    } catch (_) { /* 导航被拦时 executeJavaScript 可能被中断，属预期 */ }
    await sleep(600);
    const afterNav = win.webContents.getURL();
    check(afterNav === beforeNav, '导航到 file:// 被拦住（窗口不会被拖入的文件替换）', afterNav);

    // 10) IPC 来源兜底：非 file:// 主框架（被注入的 iframe / 异常窗口）调不到 IPC。
    //     用同一份 preload 开一个 data: 窗口，get-app-info 必须返回 BLOCKED 而不是真实路径。
    const untrustedWin = new BrowserWindow({
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    let untrusted = null;
    try {
        await untrustedWin.loadURL('data:text/html,<title>untrusted</title>');
        untrusted = await untrustedWin.webContents.executeJavaScript('window.qingframe.getAppInfo()');
    } catch (e) {
        untrusted = { error: String(e && e.message || e) };
    }
    try { untrustedWin.destroy(); } catch (_) { /* 忽略 */ }
    check(untrusted && untrusted.ok === false && /不允许/.test(untrusted.error || ''),
        '非 file:// 来源调用 IPC 被拒绝', JSON.stringify(untrusted));

    // 11) 蒙版列表：id 只能当文本，不能被拼成 HTML（防 UI 注入）。
    const maskProbe = await win.webContents.executeJavaScript(`(() => {
        const prev = window.App.image;
        const evil = '"><img src=x onerror="window.__maskXss=1">';
        window.App.image = { grade: { masks: [{ id: evil, type: 'linear', mode: 'new', on: 1, p: {}, shape: {} }] } };
        window.App._activeMaskId = null;
        window.App.syncMaskUI();
        const list = document.getElementById('maskList');
        const rows = list.querySelectorAll('[data-mask-id]');
        const injected = !!list.querySelector('img');
        const id = rows.length > 1 ? rows[1].dataset.maskId : null;
        const xss = !!window.__maskXss;
        window.App.image = prev;
        window.App.syncMaskUI();
        return { injected, id, xss };
    })()`);
    check(!maskProbe.injected && !maskProbe.xss && String(maskProbe.id).indexOf('<img') >= 0,
        '蒙版列表把 id 当文本，不会生成 HTML 元素', JSON.stringify(maskProbe));

    console.log('─'.repeat(84));
    console.log(fails.length ? `✖ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 ${total} 项通过`);

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* Electron 仍占用 userData */ }
    app.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); app.exit(1); });

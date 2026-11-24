// 体验收口回归：导出失败清单 / 只重试失败项 / 打开导出位置 / 导出尺寸记忆 /
// 无照片时顶栏置灰 / 删元素反馈 / 快捷键文案 / 大画布显式释放。
// 用法：node tools/run-electron.js tools/test-export-feedback.js
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
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
}

// 可变的 IPC 桩：prefs 与写盘结果都能在用例之间切换
let prefs = {};
let exportResult = { ok: 1, fail: 0 };
let openedPath = null;
const writeCalls = [];

ipcMain.handle('get-prefs', () => prefs);
ipcMain.handle('save-prefs', (_e, p) => { prefs = Object.assign({}, prefs, p || {}); return { ok: true }; });
let callSeq = 0;
ipcMain.handle('write-export-files', (_e, payload) => {
    writeCalls.push(payload);
    // 数组 = 逐张返回不同结果，用来模拟「前几张成功、某一张写盘失败」
    if (Array.isArray(exportResult)) return exportResult[Math.min(callSeq++, exportResult.length - 1)];
    return exportResult;
});
ipcMain.handle('show-item-in-folder', (_e, p) => { openedPath = p; return { ok: true, opened: 'dir' }; });
let exportLoc = { mode: 'dir', dir: 'C:\\out', token: 'tok' };
ipcMain.handle('pick-export-location', () => exportLoc);
ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, n + '.json'), 'utf8')); } catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'open-wall-covers-dir',
    'save-image-base64', 'save-images-batch']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'pick-default-export-dir', 'read-exif', 'open-image']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);
ipcMain.handle('get-app-info', () => ({ version: '0.1.26', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT }));

(async () => {
    await app.whenReady();
    const win = new BrowserWindow({ width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true,
            nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(600);
    win.showInactive();
    const exec = (x) => win.webContents.executeJavaScript(x);
    await exec(`(() => { try { localStorage.setItem('qfs_intro_done','1'); } catch(_){} if (window.App && App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(1000);

    // ── ① 导出尺寸跨会话记忆 ──
    await exec(`(async () => {
        const sel = document.getElementById('selExportSize');
        sel.value = '2048';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 80));
        return true;
    })()`);
    check(String(prefs.exportSize) === '2048',
        '改导出尺寸会写进 prefs', JSON.stringify(prefs));

    const restored = await exec(`(async () => {
        const sel = document.getElementById('selExportSize');
        sel.value = '0';
        await window.App.loadPrefs();
        return sel.value;
    })()`);
    check(restored === '2048', '重开后 loadPrefs 把尺寸恢复成 2048px', restored);

    prefs.exportSize = '999';
    const dirty = await exec(`(async () => {
        await window.App.loadPrefs();
        return document.getElementById('selExportSize').value;
    })()`);
    check(dirty === '2048', 'prefs 里的非法档位不会被写进下拉', dirty);
    prefs.exportSize = '2048';

    // ── ② 快捷键帮助与实际行为一致 ──
    const help = await exec(`(() => {
        const box = document.querySelector('.about-shortcuts');
        const keys = box ? Array.from(box.querySelectorAll('kbd')).map(k => k.textContent) : [];
        return { text: box ? box.textContent : '', f11: keys.indexOf('F11') >= 0 };
    })()`);
    check(help.text.indexOf('删除勾选的多张照片') >= 0 && help.f11,
        '帮助：Delete 只承诺删「多张勾选照片」，并补上 F11 全屏',
        `f11=${help.f11} text=${help.text.slice(-60)}`);

    // ── ③ 无照片时顶栏动作置灰，导入后恢复 ──
    const gray = await exec(`(() => {
        const A = window.App;
        A.images = []; A.image = null; A.updateEmptyState();
        return ['btnReset', 'btnRandom', 'btnSyncSel'].map(id => document.getElementById(id).disabled);
    })()`);
    check(gray.length === 3 && gray.every(Boolean), '无照片时顶栏三个空转按钮置灰', JSON.stringify(gray));

    const withPhoto = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas'); c.width = 400; c.height = 300;
        const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, 400, 300);
        const el = new Image();
        await new Promise(r => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        const im = { el, name: 'x.png', path: null, w: 400, h: 300, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.updateEmptyState();
        return ['btnReset', 'btnRandom', 'btnSyncSel'].map(id => document.getElementById(id).disabled);
    })()`);
    check(withPhoto.every(v => !v), '有照片后三个按钮自动恢复可用', JSON.stringify(withPhoto));

    // ── ④ 删除选中元素有状态栏反馈 ──
    const del = await exec(`(() => {
        const A = window.App;
        try {
            const obj = { id: 'e1', dataUrl: '', size: 10, x: 0.1, y: 0.1 };
            A.template = A.defaultTemplate();
            A.template.logoElements = [obj];
            A.selectedEls = [{ kind: 'logo', obj }];
            A.setStatus('上一句状态');
            A.deleteElement();
            return { status: A.statusMsg, left: A.template.logoElements.length };
        } catch (e) { return { error: String((e && e.message) || e) }; }
    })()`);
    check(!del.error && del.left === 0 && /已删除 1 个选中元素/.test(del.status || ''),
        '删元素后状态栏明确反馈，不再停在上一句', JSON.stringify(del));

    // ── ⑤ 导出完成后的两个补救入口 ──
    const acts = await exec(`(async () => {
        const A = window.App;
        const failed = { filename: 'a.jpg', data: 'ENCODED', bytes: null };
        A._lastExportDest = 'C:\\\\out';
        A._exportRetry = { loc: { token: 'tok' }, files: [failed] };
        A._syncExportActions();
        const open = document.getElementById('btnExportOpen');
        const retry = document.getElementById('btnExportRetry');
        const shown = { open: open.style.display !== 'none', retry: retry.style.display !== 'none',
                        label: retry.textContent };
        open.click();
        await new Promise(r => setTimeout(r, 140));
        retry.click();
        await new Promise(r => setTimeout(r, 200));
        return { shown, status: A.statusMsg, cleared: A._exportRetry === null, released: failed.data === null,
                 retryHidden: retry.style.display === 'none' };
    })()`);
    check(acts.shown.open && acts.shown.retry && /重试失败 1 张/.test(acts.shown.label),
        '导出后显示「打开导出位置」与「重试失败 N 张」', JSON.stringify(acts.shown));
    check(openedPath === 'C:\\out', '点「打开导出位置」真的调用了 showItemInFolder', String(openedPath));
    check(writeCalls.length === 1 && writeCalls[0].files[0].filename === 'a.jpg'
          && writeCalls[0].location.token === 'tok',
        '点重试只把失败那张重发一次（不重跑整批）', JSON.stringify(writeCalls));
    check(acts.cleared && acts.released && acts.retryHidden && /重试完成：1 张已写入/.test(acts.status || ''),
        '重试成功后释放位图、收起按钮、给出反馈', JSON.stringify(acts));

    // ── ⑥ 重试仍失败时把原因带出来 ──
    exportResult = { ok: 0, fail: 1, failures: [{ name: 'a.jpg', reason: '磁盘已满' }] };
    const again = await exec(`(async () => {
        const A = window.App;
        const failed = { filename: 'a.jpg', data: 'ENCODED2', bytes: null };
        A._exportRetry = { loc: { token: 'tok' }, files: [failed] };
        A._syncExportActions();
        document.getElementById('btnExportRetry').click();
        await new Promise(r => setTimeout(r, 200));
        return { status: A.statusMsg, cleared: A._exportRetry === null, released: failed.data === null };
    })()`);
    check(/磁盘已满/.test(again.status || '') && again.cleared && again.released,
        '重试仍失败：状态栏报出具体原因，且不残留位图', JSON.stringify(again));

    // ── ⑦ LRU 淘汰真的释放全尺寸画布（含共享引用去重） ──
    const release = await exec(`(() => {
        const A = window.App;
        const mk = () => { const c = document.createElement('canvas'); c.width = 200; c.height = 150; return c; };
        const shared = mk(), low = mk(), layer = mk(), base = mk();
        const im = { _grade: { canvas: shared, low },
            _gradeCache: { '200x150': { base: shared, chain: [{ key: 'k', canvas: layer }, { key: 'k2', canvas: base }] } } };
        try { A._releaseGradeBitmaps(im); } catch (e) { return { error: String((e && e.message) || e) }; }
        return { dims: [shared.width, low.width, layer.width, base.width] };
    })()`);
    check(!release.error && release.dims && release.dims.every(v => v === 0),
        '淘汰时 4 张画布（含共享引用）后备缓冲都归零', JSON.stringify(release));

    // ── ⑧ 完整导出流程：第 1 张成功、第 2 张写盘失败 ──
    // 真渲染 + 真写盘桩，验证失败项带名字/原因进状态栏，且只有失败那张可重试。
    callSeq = 0;
    writeCalls.length = 0;
    exportResult = [
        { ok: 1, fail: 0 },
        { ok: 0, fail: 1, failures: [{ name: 'b_边框.jpg', reason: 'EACCES: 目录只读' }] }
    ];
    const full = await exec(`(async () => {
        const A = window.App;
        try {
            const mk = async (name) => {
                const c = document.createElement('canvas'); c.width = 240; c.height = 180;
                const g = c.getContext('2d'); g.fillStyle = '#567'; g.fillRect(0, 0, 240, 180);
                const el = new Image();
                await new Promise(r => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
                return { el, name, path: null, w: 240, h: 180, exif: {}, customSettings: null, grade: null };
            };
            A.images = [await mk('a.png'), await mk('b.png')];
            A.image = A.images[0]; A.currentIdx = 0;
            A.selectedIdx = [0, 1]; A.batchSel = [0, 1];
            A.template = A.defaultTemplate(); A.setTpl(A.images[0], A.template);
            A.updateEmptyState(); A.scheduleRender(true);
            await new Promise(r => setTimeout(r, 350));
            await A.exportImage();
            await new Promise(r => setTimeout(r, 250));
            return { status: A.statusMsg,
                     retryNames: A._exportRetry && A._exportRetry.files.map(f => f.filename || f.stem),
                     openShown: document.getElementById('btnExportOpen').style.display !== 'none',
                     retryShown: document.getElementById('btnExportRetry').style.display !== 'none' };
        } catch (e) { return { error: String((e && e.stack) || e).slice(0, 500) }; }
    })()`);
    check(!full.error && /成功 1/.test(full.status || '') && /失败 1/.test(full.status || '')
          && /b_边框\.jpg/.test(full.status || '') && /目录只读/.test(full.status || ''),
        '完整导出：状态栏同时给出成功数、失败文件名与失败原因', JSON.stringify(full));
    check(!full.error && full.retryShown && full.openShown
          && Array.isArray(full.retryNames) && full.retryNames.length === 1,
        '完整导出：只留失败那 1 张可重试，成功产物可一键定位', JSON.stringify(full));
    check(writeCalls.length >= 2, '完整导出确实逐张调用了写盘桩', String(writeCalls.length));

    // ── ⑨ 单张 / 文件模式写盘失败：必须有重试入口，且不能谎报「已存到」 ──
    // pending 分支和目录多张分支是两条路：单张走 pending，最容易漏掉重试收集。
    callSeq = 0;
    writeCalls.length = 0;
    exportResult = { ok: 0, fail: 1, failures: [{ name: 'single.jpg', reason: '磁盘已满' }] };
    exportLoc = { mode: 'file', filePath: 'C:\\out\\single.jpg', token: 'tok' };
    const single = await exec(`(async () => {
        const A = window.App;
        try {
            const c = document.createElement('canvas'); c.width = 240; c.height = 180;
            const g = c.getContext('2d'); g.fillStyle = '#567'; g.fillRect(0, 0, 240, 180);
            const el = new Image();
            await new Promise(r => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
            const im = { el, name: 'single.png', path: null, w: 240, h: 180, exif: {}, customSettings: null, grade: null };
            A.images = [im]; A.image = im; A.currentIdx = 0;
            A.selectedIdx = [0]; A.batchSel = [0];
            A.template = A.defaultTemplate(); A.setTpl(im, A.template);
            A.updateEmptyState(); A.scheduleRender(true);
            await new Promise(r => setTimeout(r, 350));
            await A.exportImage();
            await new Promise(r => setTimeout(r, 250));
            return {
                status: A.statusMsg,
                retry: !!(A._exportRetry && A._exportRetry.files.length === 1),
                retryShown: document.getElementById('btnExportRetry').style.display !== 'none',
                openShown: document.getElementById('btnExportOpen').style.display !== 'none',
                lastDest: A._lastExportDest
            };
        } catch (e) { return { error: String((e && e.stack) || e).slice(0, 500) }; }
    })()`);
    check(!single.error && /成功 0/.test(single.status || '') && /失败 1/.test(single.status || '')
          && /single\.jpg/.test(single.status || '') && /磁盘已满/.test(single.status || '')
          && !/已存到/.test(single.status || ''),
        '单张导出失败：状态栏不谎报已存到，并给出失败文件与原因', JSON.stringify(single));
    check(!single.error && single.retry && single.retryShown && !single.openShown && single.lastDest === null,
        '单张导出失败：出现「重试失败 1 张」，打开位置保持隐藏', JSON.stringify(single));

    // 重试成功后补回「打开导出位置」：首轮全失败时 _lastExportDest 原本是 null。
    exportResult = { ok: 1, fail: 0 };
    const singleRetry = await exec(`(async () => {
        const A = window.App;
        await A._retryFailedExport();
        await new Promise(r => setTimeout(r, 100));
        return {
            status: A.statusMsg,
            lastDest: A._lastExportDest,
            retryShown: document.getElementById('btnExportRetry').style.display !== 'none',
            openShown: document.getElementById('btnExportOpen').style.display !== 'none'
        };
    })()`);
    check(!singleRetry.error && /重试完成：1 张已写入/.test(singleRetry.status || '')
          && String(singleRetry.lastDest || '').replace(/\//g, '\\') === 'C:\\out'
          && singleRetry.openShown && !singleRetry.retryShown,
        '单张重试成功：补回打开导出位置并收起重试按钮', JSON.stringify(singleRetry));
    check(writeCalls.length >= 2 && writeCalls[writeCalls.length - 1].location.mode === 'file'
          && writeCalls[writeCalls.length - 1].files.length === 1,
        '单张重试只重发失败的那 1 张', String(writeCalls.length));

    // ── ⑩ 全尺寸渲染抛错：导出必须结束并还原临时档位，不能永久卡在「正在导出」 ──
    const flushFail = await exec(`(async () => {
        const A = window.App;
        await A.flushRender().catch(() => {});
        const orig = A.renderPreview;
        A.renderPreview = () => { throw new Error('preview boom'); };
        const t0 = Date.now();
        let outcome;
        try {
            outcome = await Promise.race([
                A.flushRender().then(() => 'resolved', (e) => 'rejected:' + ((e && e.message) || e)),
                new Promise((r) => setTimeout(() => r('timeout'), 2000))
            ]);
        } finally {
            A.renderPreview = orig;
            A.scheduleRender(true);
        }
        return { outcome, ms: Date.now() - t0 };
    })()`);
    check(flushFail.outcome === 'rejected:preview boom' && flushFail.ms < 1500,
        '预览渲染抛错时 flushRender 明确拒绝，不再永久等待', JSON.stringify(flushFail));

    const renderFail = await exec(`(async () => {
        const A = window.App;
        await A.flushRender().catch(() => {});
        const orig = window.__render;
        window.__render = () => { throw new Error('render boom'); };
        const before = { dpr: A.uiDprOverride, scale: A.exportScale, idx: A.currentIdx };
        const t0 = Date.now();
        let outcome;
        try {
            outcome = await Promise.race([
                A.exportImage().then(() => 'done', (e) => 'rejected:' + ((e && e.message) || e)),
                new Promise((r) => setTimeout(() => r('timeout'), 3000))
            ]);
        } finally {
            window.__render = orig;
            A.scheduleRender(true);
        }
        return {
            outcome, ms: Date.now() - t0, status: A.statusMsg,
            dpr: A.uiDprOverride, scale: A.exportScale,
            idx: A.currentIdx, name: A.image && A.image.name,
            before
        };
    })()`);
    check(renderFail.outcome === 'done' && /失败 1/.test(renderFail.status || '')
          && /渲染失败/.test(renderFail.status || ''),
        '全尺寸渲染抛错时导出正常收尾并报失败，不再悬死', JSON.stringify(renderFail));
    check(renderFail.dpr === undefined && renderFail.scale === undefined,
        '渲染失败后 uiDprOverride / exportScale 已还原', JSON.stringify(renderFail));
    check(renderFail.idx === renderFail.before.idx && renderFail.name === 'single.png',
        '渲染失败后当前照片指针已还原', JSON.stringify(renderFail));

    // ── ⑪ 相框「不放大」提示已与现实相反（引擎早已按 exportScale 上采样）──
    const frameNote = await exec(`(() => {
        const A = window.App;
        A.template = A.defaultTemplate();
        A.template.photoFrameStyle = 'POLAROID_HAND';
        A.dom.selExportSize.value = '8192';
        A.updateExportSizeNote();
        const n = A.dom.exportSizeNote;
        return { display: n ? n.style.display : '', text: n ? n.textContent : '' };
    })()`);
    check(frameNote.display === 'none' && !frameNote.text,
        '小图 + 相框 + 8192 档不再显示错误的「不放大」提示', JSON.stringify(frameNote));

    console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); app.exit(1); });

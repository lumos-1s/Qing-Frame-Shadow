'use strict';
// AI 破框：离屏验证「按钮 → 取源图 → 调图像接口 → 结果入库」整条链。
// 不联网：QfsAiProvider.image 被换成桩，只检查发出去的参数和回来的落点。
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..');

for (const c of ['list-presets', 'list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);
ipcMain.handle('frames:list', () => []);
ipcMain.handle('frames:watch', () => true);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.28', electron: '45', chrome: '1', node: '1', platform: 'win32',
    arch: 'x64', packaged: false, portable: false, userData: ROOT, appPath: ROOT
}));

const failures = [];
function check(ok, label, detail) {
    if (ok) console.log('OK   ' + label + (detail ? ' | ' + detail : ''));
    else { failures.push(label); console.log('FAIL ' + label + (detail ? ' | ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload-frame-panel.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (x) => win.webContents.executeJavaScript(x);
    await sleep(600);
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done','1'); localStorage.removeItem('qfs_ai_gallery_v1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    await exec(`(async () => {
        const c = document.createElement('canvas'); c.width = 600; c.height = 800;
        const g = c.getContext('2d');
        const sky = g.createLinearGradient(0, 0, 0, 800);
        sky.addColorStop(0, '#8fb7cf'); sky.addColorStop(0.6, '#d9d2c3'); sky.addColorStop(1, '#5a4a3a');
        g.fillStyle = sky; g.fillRect(0, 0, 600, 800);
        g.fillStyle = '#2f3b2e'; g.fillRect(0, 560, 600, 240);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.src = c.toDataURL('image/png'); });
        const im = { el, name: 'break.jpg', path: null, w: 600, h: 800, exif: {}, customSettings: null, grade: null };
        App.images = [im]; App.image = im; App.currentIdx = 0;
        App.template = App.defaultTemplate(); App.setTpl(im, App.template); App.updateEmptyState();
        App.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 400));
        return true;
    })()`);
    await sleep(400);

    await exec(`(() => { window.QfsFramePanel.init(window.App); window.QfsFramePanel.open(); return true; })()`);
    await sleep(400);

    const hasBtn = await exec(`(() => { const b = document.getElementById('btnFrameBreak'); return !!b && /AI 破框/.test(b.textContent); })()`);
    check(hasBtn === true, '面板里有「AI 破框」入口', String(hasBtn));

    // ① 没配图像模型：只提示 + 打开设置，不发请求
    await exec(`(() => {
        window.__imgCalls = [];
        const P = window.QfsAiProvider;
        P.imageReady = () => false;
        P.image = async (p) => { window.__imgCalls.push(p); return { ok: true, image: 'data:image/png;base64,AA==' }; };
        document.getElementById('btnFrameBreak').click();
        return true;
    })()`);
    await sleep(400);
    const unset = await exec(`({ calls: window.__imgCalls.length,
        status: document.getElementById('frameStatus').textContent,
        setup: (getComputedStyle(document.getElementById('aiSetupModal')).display === 'flex') })`);
    check(unset.calls === 0, '没配图像模型时不会打接口', String(unset.calls));
    check(/先填图像模型/.test(unset.status), '状态栏说清要先填图像模型', unset.status);
    check(unset.setup === true, '顺手把 AI 设置弹层打开', String(unset.setup));

    await exec(`(() => {
        const m = document.getElementById('aiSetupModal');
        if (m) m.style.display = 'none';
        return true;
    })()`);

    // ② 配好后：参数要对，结果要入库
    const before = await exec(`App.images.length`);
    await exec(`(() => {
        const P = window.QfsAiProvider;
        P.imageReady = () => true;
        P.image = async (p) => {
            window.__imgCalls.push(p);
            const c = document.createElement('canvas'); c.width = 1024; c.height = 1536;
            const g = c.getContext('2d');
            g.fillStyle = '#f6f2e8'; g.fillRect(0, 0, 1024, 1536);
            g.fillStyle = '#8fb7cf'; g.fillRect(140, 320, 744, 900);
            return { ok: true, image: c.toDataURL('image/png'), path: 'edits' };
        };
        document.getElementById('btnFrameBreak').click();
        return true;
    })()`);

    let done = null;
    for (let i = 0; i < 40; i++) {
        await sleep(150);
        done = await exec(`({ calls: window.__imgCalls.length, n: App.images.length,
            status: document.getElementById('frameStatus').textContent,
            btnDisabled: document.getElementById('btnFrameBreak').disabled })`);
        if (done.n > before) break;
    }
    check(done.calls === 1, '只发一次请求', String(done.calls));
    check(done.n === before + 1, '结果作为一张新照片入库', before + ' → ' + done.n);
    check(/已生成一张/.test(done.status), '状态栏确认已生成', done.status);
    check(done.btnDisabled === false, '跑完按钮恢复可点', String(done.btnDisabled));

    const sent = await exec(`(() => {
        const p = window.__imgCalls[0] || {};
        return { size: p.size, prompt: String(p.prompt || '').slice(0, 40),
            promptLen: String(p.prompt || '').length,
            srcType: String(p.source || '').slice(0, 22),
            srcLen: String(p.source || '').length };
    })()`);
    check(sent.size === '1024x1536', '尺寸走竖版 1024×1536', sent.size);
    check(/破框/.test(sent.prompt) && sent.promptLen > 80, '带上了整段破框描述', sent.promptLen + ' 字');
    check(/^data:image\/jpeg;base64/.test(sent.srcType), '源图是压缩后的 JPEG', sent.srcType);
    check(sent.srcLen < 3 * 1024 * 1024, '源图没撑爆请求体（<3MB 字符）', Math.round(sent.srcLen / 1024) + 'KB');

    const added = await exec(`(() => {
        const im = App.images[App.images.length - 1] || {};
        return { name: im.name, w: im.w, h: im.h, idx: App.currentIdx, total: App.images.length };
    })()`);
    check(added.name === 'AI 破框', '新照片名字标清来源', String(added.name));
    check(added.w === 1024 && added.h === 1536, '尺寸按接口返回落库', added.w + '×' + added.h);
    check(added.idx === added.total - 1, '生成完自动选中这张', String(added.idx));

    // ③ 接口报错：要说人话，且不往库里塞东西
    const beforeErr = await exec(`App.images.length`);
    await exec(`(() => {
        const P = window.QfsAiProvider;
        P.image = async () => ({ ok: false, error: 'HTTP 402：额度不足' });
        document.getElementById('btnFrameBreak').click();
        return true;
    })()`);
    await sleep(600);
    const err = await exec(`({ n: App.images.length, status: document.getElementById('frameStatus').textContent })`);
    check(err.n === beforeErr, '失败不会往照片列表里塞东西', String(err.n));
    check(/生成失败/.test(err.status) && /额度不足/.test(err.status), '错误照原样透出，不吞掉', err.status);

    console.log('');
    if (failures.length) { console.log('FAILED ' + failures.length + ' · AI 破框'); app.exit(1); return; }
    console.log('ALL PASS · AI 破框');
    app.quit();
}).catch((e) => { console.error(e); app.exit(1); });

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
    check(/已生成「AI 破框」/.test(done.status), '状态栏确认已生成', done.status);
    check(/1024×1536/.test(done.status), '状态栏写明成片尺寸，别等导出才发现变小了', done.status);
    check(done.btnDisabled === false, '跑完按钮恢复可点', String(done.btnDisabled));

    const sent = await exec(`(() => {
        const p = window.__imgCalls[0] || {};
        return { size: p.size, prompt: String(p.prompt || '').slice(0, 40),
            promptLen: String(p.prompt || '').length,
            hasExtra: /补充要求/.test(String(p.prompt || '')),
            srcType: String(p.source || '').slice(0, 22),
            srcLen: String(p.source || '').length };
    })()`);
    check(sent.size === '1024x1536', '竖图走竖版 1024×1536', sent.size);
    check(/破框/.test(sent.prompt) && sent.promptLen > 80, '带上了整段破框描述', sent.promptLen + ' 字');
    check(sent.hasExtra === false, '输入框空着时不硬塞「补充要求」', String(sent.hasExtra));
    check(/^data:image\/jpeg;base64/.test(sent.srcType), '源图是压缩后的 JPEG', sent.srcType);
    check(sent.srcLen < 3 * 1024 * 1024, '源图没撑爆请求体（<3MB 字符）', Math.round(sent.srcLen / 1024) + 'KB');

    const added = await exec(`(() => {
        const im = App.images[App.images.length - 1] || {};
        return { name: im.name, w: im.w, h: im.h, idx: App.currentIdx, total: App.images.length,
            gen: im.aiGenerated, from: im.aiFrom };
    })()`);
    check(added.name === 'AI 破框', '新照片名字标清来源', String(added.name));
    check(added.w === 1024 && added.h === 1536, '尺寸按接口返回落库', added.w + '×' + added.h);
    check(added.idx === added.total - 1, '生成完自动选中这张', String(added.idx));
    check(added.gen === true && added.from === 'break.jpg', '记下这是 AI 成片、出自哪张', String(added.from));

    const follow = await exec(`(() => {
        const sel = document.getElementById('frameSamplePhoto');
        const last = String(App.images.length - 1);
        const opt = [...sel.options].find((o) => o.value === last);
        return { has: !!opt, value: sel.value, target: last };
    })()`);
    check(follow.has === true && follow.value === follow.target,
        '面板的照片下拉跟着新图走，不会一直预览旧图', JSON.stringify(follow));

    // ③ 横图 + 输入框写了补充要求：尺寸要跟着横过来，文字要带进 prompt
    await exec(`(async () => {
        const c = document.createElement('canvas'); c.width = 1200; c.height = 800;
        const g = c.getContext('2d');
        const sky = g.createLinearGradient(0, 0, 0, 800);
        sky.addColorStop(0, '#c8d6e0'); sky.addColorStop(1, '#7a6a55');
        g.fillStyle = sky; g.fillRect(0, 0, 1200, 800);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.src = c.toDataURL('image/png'); });
        App.images.push({ el: el, name: 'sunset.jpg', path: null, sample: false, w: 1200, h: 800, exif: {}, customSettings: null });
        App.selectImage(App.images.length - 1);
        await window.QfsFramePanel.open();
        document.getElementById('framePrompt').value = '纸面再黄一点，相框细一些';
        const P = window.QfsAiProvider;
        P.image = async (p) => {
            window.__imgCalls.push(p);
            const cc = document.createElement('canvas'); cc.width = 1536; cc.height = 1024;
            const gg = cc.getContext('2d');
            gg.fillStyle = '#f6f2e8'; gg.fillRect(0, 0, 1536, 1024);
            return { ok: true, image: cc.toDataURL('image/png'), path: 'edits' };
        };
        return true;
    })()`);
    await sleep(300);
    const beforeWide = await exec(`App.images.length`);
    await exec(`(() => { document.getElementById('btnFrameBreak').click(); return true; })()`);
    let wide = null;
    for (let i = 0; i < 40; i++) {
        await sleep(150);
        wide = await exec(`({ n: App.images.length, calls: window.__imgCalls.length,
            status: document.getElementById('frameStatus').textContent })`);
        if (wide.n > beforeWide) break;
    }
    const sent2 = await exec(`(() => {
        const p = window.__imgCalls[window.__imgCalls.length - 1] || {};
        return { size: p.size, prompt: String(p.prompt || ''),
            hasOrient: /横版 3:2/.test(String(p.prompt || '')),
            hasExtra: /补充要求：纸面再黄一点，相框细一些/.test(String(p.prompt || '')) };
    })()`);
    check(wide.n === beforeWide + 1, '横图也能生成并入库', beforeWide + ' → ' + wide.n);
    check(sent2.size === '1536x1024', '横图走横版 1536×1024，不把画面压进竖框', sent2.size);
    check(sent2.hasOrient === true, 'prompt 里的画幅方向跟着尺寸走', String(sent2.hasOrient));
    check(sent2.hasExtra === true, '输入框的字作为补充要求进了 prompt', String(sent2.hasExtra));

    // ④ 接口报错：要说人话，且不往库里塞东西
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

    // ⑤ 网关没开 edits：原文照留，但补一句人能看懂的原因
    await exec(`(() => {
        window.QfsAiProvider.image = async () => ({ ok: false, status: 404, error: 'HTTP 404：not found' });
        document.getElementById('btnFrameBreak').click();
        return true;
    })()`);
    await sleep(600);
    const err404 = await exec(`document.getElementById('frameStatus').textContent`);
    check(/HTTP 404/.test(err404) && /edits/.test(err404),
        '404 不是只丢状态码，补一句「网关没开 edits」', err404);

    console.log('');
    if (failures.length) { console.log('FAILED ' + failures.length + ' · AI 破框'); app.exit(1); return; }
    console.log('ALL PASS · AI 破框');
    app.quit();
}).catch((e) => { console.error(e); app.exit(1); });

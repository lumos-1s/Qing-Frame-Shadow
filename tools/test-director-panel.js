// 导演选框面板回归：看图 → 选现成边框 → 写文案 → 套用；失败自动退回本地初选。
// 用法: node tools/run-electron.js tools/test-director-panel.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-director-'));
const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── IPC：与真实主进程同名同形，但方案由页面里的 stub 提供 ──────────
ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, String(n).replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'copy-text', 'save-diagnostics', 'check-for-updates', 'quit-and-install']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'pick-export-location', 'write-export-files', 'read-exif', 'open-image', 'pick-default-export-dir']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.29', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: TMP, appPath: ROOT
}));
ipcMain.handle('frames:list', () => []);
ipcMain.handle('frames:read', () => null);
ipcMain.handle('frames:save', () => ({ ok: true }));
ipcMain.handle('frames:dir', () => ({ path: TMP }));
ipcMain.handle('frames:openDir', () => ({ ok: true }));
ipcMain.handle('frames:watch', () => ({ ok: true }));
ipcMain.handle('frames:remove', () => ({ ok: true }));
ipcMain.handle('frames:skill', () => ({ ok: true, text: '' }));
ipcMain.handle('agent:detect', () => []);

const PICK_NAMES = ['Canva错位拼贴', '拍立得签名', '复古报纸', 'VHS录像带'];

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
        try { localStorage.setItem('qfs_intro_done','1'); localStorage.removeItem('qfs_ai_gallery_v1'); localStorage.removeItem('qfs_frame_mode'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    // 注入一张竖幅照片（导演要靠它判断比例与构图）
    await exec(`(async () => {
        const c = document.createElement('canvas'); c.width = 600; c.height = 800;
        const g = c.getContext('2d');
        const sky = g.createLinearGradient(0, 0, 0, 800);
        sky.addColorStop(0, '#8fb7cf'); sky.addColorStop(0.6, '#d9d2c3'); sky.addColorStop(1, '#5a4a3a');
        g.fillStyle = sky; g.fillRect(0, 0, 600, 800);
        g.fillStyle = '#2f3b2e'; g.fillRect(0, 560, 600, 240);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.src = c.toDataURL('image/png'); });
        const im = { el, name: 'director.jpg', path: null, w: 600, h: 800, exif: { make: 'FUJIFILM', model: 'X-T5' }, customSettings: null, grade: null };
        App.images = [im]; App.image = im; App.currentIdx = 0;
        App.template = App.defaultTemplate(); App.setTpl(im, App.template); App.updateEmptyState();
        if (App.invalidateGrade) App.invalidateGrade(im);
        App.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 400));
        return true;
    })()`);
    await sleep(500);

    // 打开面板（离屏，不弹窗）。AI 窗口本版默认不发布，测试里显式放行。
    await exec(`(() => {
        window.QfsFeatures.override('aiPanel', true);
        window.QfsFramePanel.syncFeatureGates();
        window.QfsFramePanel.init(window.App);
        window.QfsFramePanel.open();
        return true;
    })()`);
    await sleep(400);
    const opened = await exec(`(() => {
        const link = document.getElementById('btnFrameDirector');
        return getComputedStyle(document.getElementById('frameModal')).display === 'flex'
            && !!link && !link.classList.contains('active')
            && document.getElementById('btnGenerate').textContent === '生成 4 款';
    })()`);
    check(opened === true, '面板打开时导演是收起的（默认走自由造型，不逼用户先选模式）', String(opened));

    // 接管 AI 通道：页面里 stub chat，能直接检查发出去的消息（是否带图）
    await exec(`(() => {
        const P = window.QfsAiProvider;
        window.__aiCalls = [];
        window.__aiPicks = ${JSON.stringify(PICK_NAMES.map((n, i) => ({
            preset: n, why: ['竖幅留白适合这张', '底部有字位，能写日期', '满幅压字，像报纸', '录像带壳，适合街拍'][i],
            copy: { title: ['京都的雨', '鸭川边', '', ''][i], subtitle: ['十一月', '', '', ''][i] },
            fontScale: 1.05, pad: i === 1 ? 6 : 0
        })))};
        P.channel = () => 'api';
        P.ready = () => true;
        P.load = () => ({ baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'vision-test' });
        P.chat = async (msgs) => {
            window.__aiCalls.push(msgs);
            return { ok: true, content: '好的，这是这一轮：\\n' + JSON.stringify({ picks: window.__aiPicks }) };
        };
        return true;
    })()`);

    // 点兜底入口切到导演模式 → 生成
    await exec(`(() => {
        document.getElementById('btnFrameDirector').click();
        document.getElementById('framePrompt').value = '做成旅行手账，想写标题';
        document.getElementById('btnGenerate').click();
        return true;
    })()`);

    let cards = null;
    for (let i = 0; i < 60; i++) {
        await sleep(200);
        cards = await exec(`(() => {
            const els = [...document.querySelectorAll('#frameGallery .frame-swatch')];
            return { n: els.length, names: els.map(e => (e.querySelector('.frame-swatch-name') || {}).textContent || ''),
                whys: els.map(e => (e.querySelector('.frame-swatch-why') || {}).textContent || ''),
                imgs: document.querySelectorAll('#frameGallery .frame-swatch-img img').length };
        })()`);
        if (cards.n >= 4 && cards.imgs >= 4) break;
    }
    check(cards.n === 4, '导演给出 4 款方案', JSON.stringify(cards.names));
    check(cards.imgs === 4, '每款都渲染出照片预览', String(cards.imgs));
    check(cards.whys.filter(Boolean).length === 4, '每张卡都写了「为什么选它」', cards.whys.join(' / ').slice(0, 80));

    const sent = await exec(`(() => {
        const m = window.__aiCalls[0] || [];
        const user = m.find(x => x.role === 'user');
        const parts = user && Array.isArray(user.content) ? user.content : [];
        const text = (parts.find(p => p.type === 'text') || {}).text || '';
        return { roles: m.map(x => x.role), parts: parts.map(p => p.type),
            hasCatalog: text.indexOf('可选边框') >= 0, hasName: text.indexOf('Canva错位拼贴') >= 0,
            hasRule: m.some(x => x.role === 'system' && /只能从清单里选/.test(String(x.content))) };
    })()`);
    check(sent.parts.join(',') === 'text,image_url', '请求带上了照片缩略图（模型真的能看）', JSON.stringify(sent.parts));
    check(sent.hasCatalog && sent.hasName && sent.hasRule, '请求里有边框清单 + 只许从清单选', JSON.stringify(sent));

    // 套用第一款：模板名、文案、留白都要落到 App.template 上
    const directorStatus = await exec(`document.getElementById('frameStatus').textContent`);
    check(/导演挑了 4 款/.test(directorStatus), '状态栏说明这批是导演挑的', directorStatus);
    const applied = await exec(`(async () => {
        document.querySelectorAll('#frameGallery .frame-swatch')[0].click();
        await new Promise(r => setTimeout(r, 600));
        const t = window.App.template || {};
        const lines = ((t.decorConfig || {}).textLines || []).filter(l => l.align !== 'free');
        return { name: t.templateName, texts: lines.map(l => l.text), font: lines.map(l => l.fontSize),
            hasLayers: Array.isArray(t.aiLayers) || Array.isArray(t.layers),
            status: document.getElementById('frameStatus').textContent };
    })()`);
    check(applied.name === PICK_NAMES[0], '套用后模板就是导演选的边框', String(applied.name));
    check(applied.texts.indexOf('京都的雨') >= 0, '文案写进了边框的文字位', JSON.stringify(applied.texts));
    check(applied.hasLayers === false, '没有写入任何坐标图层（导演不画版式）', String(applied.hasLayers));
    check(/已套用/.test(applied.status), '套用后状态切回「已套用」', applied.status);

    // 模型编造名字：应丢弃并补齐 4 款
    await exec(`(() => {
        window.__aiPicks = [
            { preset: '根本不存在的边框', why: '编的', copy: { title: '假' } },
            { preset: '复古报纸', why: '满幅压字', copy: { title: '真标题' } }
        ];
        document.getElementById('btnGenerate').click();
        return true;
    })()`);
    let afterFake = null;
    for (let i = 0; i < 50; i++) {
        await sleep(200);
        afterFake = await exec(`({ n: document.querySelectorAll('#frameGallery .frame-swatch').length,
            status: document.getElementById('frameStatus').textContent })`);
        if (afterFake.n >= 4 && /丢弃/.test(afterFake.status)) break;
    }
    check(afterFake.n === 4, '编造名被丢弃后用本地补齐 4 款', JSON.stringify(afterFake));
    check(/编造的边框名已丢弃/.test(afterFake.status), '状态里说明丢弃了编造名', afterFake.status);

    // 未配置 AI：本地初选也能出 4 款，且不再调模型
    const beforeCalls = await exec(`window.__aiCalls.length`);
    await exec(`(() => { window.QfsAiProvider.ready = () => false; document.getElementById('btnGenerate').click(); return true; })()`);
    let local = null;
    for (let i = 0; i < 40; i++) {
        await sleep(200);
        local = await exec(`({ n: document.querySelectorAll('#frameGallery .frame-swatch').length,
            status: document.getElementById('frameStatus').textContent, calls: window.__aiCalls.length })`);
        if (local.n >= 4 && /本地初选/.test(local.status)) break;
    }
    check(local.n === 4, '没配 AI 也能出 4 款（本地初选）', JSON.stringify(local));
    check(local.calls === beforeCalls, '本地初选不偷偷调模型', String(local.calls - beforeCalls));

    console.log('');
    if (failures.length) {
        console.log('FAILED ' + failures.length + ' · 导演选框面板');
        app.exit(1);
        return;
    }
    console.log('ALL PASS · 导演选框面板');
    app.quit();
}).catch((e) => {
    console.error(e);
    app.exit(1);
});

// 用户资料入口回归：顶栏不再有账号样式的头像环，昵称/头像改成「签名 / 头像」参数组里的一颗按钮。
// 这条用例守的是「入口搬家」——按钮在不在、点了开不开、保存后按钮上有没有名字、清除后回不回默认。
// 用法: node tools/run-electron.js tools/test-user-profile-entry.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// 主进程侧保存的用户资料：doLogin / doLogout 会写它，再读回来验证「保存后弹窗进的是资料页」
let userStub = null;
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('save-prefs', () => ({ ok: true }));
ipcMain.handle('get-user', () => userStub);
ipcMain.handle('save-user', (_e, u) => { userStub = u; return { ok: true }; });
ipcMain.handle('logout-user', () => { userStub = null; return { ok: true }; });
ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('get-app-info', () => ({
    version: require('../package.json').version, electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) {
    ipcMain.handle(c, () => []);
}
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template',
    'export-qfs', 'read-exif', 'save-image-base64', 'save-images-batch',
    'pick-export-location', 'write-export-files']) {
    ipcMain.handle(c, () => (c.startsWith('open') || c.startsWith('pick') ? { canceled: true } : { ok: true }));
}
for (const c of ['open-external', 'open-data-dir', 'copy-text', 'save-diagnostics', 'check-for-updates',
    'start-update-download', 'quit-and-install']) {
    ipcMain.handle(c, () => ({ ok: true }));
}

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url);
            const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });

    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload-about.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom)')) break;
        await sleep(250);
    }
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await exec(`(() => { try { localStorage.removeItem('qfs_intro_done'); } catch (_) {} ; return true; })()`);

    // ── A：结构 —— 顶栏没有账号入口，按钮落在「签名 / 头像」组里 ──
    const sA = await exec(`(() => {
        const btn = document.getElementById('btnEditUserProfile');
        const group = btn ? btn.closest('.param-group') : null;
        return {
            topPill: !!document.getElementById('loginStatus'),
            topAvatar: !!document.getElementById('topAvatar'),
            topName: !!document.getElementById('topUserName'),
            accountBox: !!document.querySelector('#topbar .account, header .account'),
            hasBtn: !!btn,
            inTextPanel: !!(btn && btn.closest('#panel-text')),
            inSignGroup: !!(group && group.querySelector('#rowAvatarShow')),
            text: btn ? btn.textContent.trim() : ''
        };
    })()`);
    check(!sA.topPill && !sA.topAvatar && !sA.topName && !sA.accountBox,
        '顶栏不再有「设置用户」头像环', JSON.stringify(sA));
    check(sA.hasBtn && sA.inTextPanel && sA.inSignGroup,
        '昵称/头像入口在「文字 → 签名 / 头像」组里', JSON.stringify(sA));
    check(/^昵称与头像/.test(sA.text), '按钮文字从「昵称与头像」开始', sA.text);

    // ── B：可点性 —— 载入一个支持签名的预设后，入口所在组必须真的显形 ──
    // 无照片时右栏所有参数组都按「当前样式」隐藏，所以先铺一张 800×600 的图和「签名 + 参数」预设。
    const signPreset = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', '签名+参数.json'), 'utf8'));
    await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas'); c.width = 800; c.height = 600;
        const g0 = c.getContext('2d'); g0.fillStyle = '#4a6f9c'; g0.fillRect(0, 0, 800, 600);
        const im = new Image();
        await new Promise(r => { im.onload = r; im.onerror = r; im.src = c.toDataURL('image/jpeg', 0.95); });
        A.image = { el: im, name: 'p.jpg', w: 800, h: 600, exif: {} };
        A.images = [A.image]; A.imageTemplates = new Map();
        A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = []; A.selectedEls = [];
        A.template = ${JSON.stringify(signPreset)};
        A.normalizeTemplate();
        A.afterImageSelect();
        A.switchTab('text');
        return true;
    })()`);
    await sleep(400);
    const shown = await exec(`(() => {
        const b = document.getElementById('btnEditUserProfile');
        const group = b && b.closest('.param-group');
        const r = b ? b.getBoundingClientRect() : null;
        return {
            panelActive: document.getElementById('panel-text').classList.contains('active'),
            groupShown: !!group && getComputedStyle(group).display !== 'none',
            h: r ? Math.round(r.height) : 0,
            w: r ? Math.round(r.width) : 0
        };
    })()`);
    check(shown.panelActive && shown.groupShown && shown.h > 10 && shown.w > 40,
        '「签名 + 参数」预设下，入口按钮在「文字」页签里可见可点', JSON.stringify(shown));

    await exec(`document.getElementById('btnEditUserProfile').click()`);
    await sleep(150);
    const sB = await exec(`(() => ({
        modal: getComputedStyle(document.getElementById('loginModal')).display,
        form: getComputedStyle(document.getElementById('loginFormView')).display,
        profile: getComputedStyle(document.getElementById('loginProfileView')).display
    }))()`);
    check(sB.modal === 'flex' && sB.form !== 'none' && sB.profile === 'none',
        '点按钮打开「昵称与头像」表单（还没有资料时是表单页）', JSON.stringify(sB));

    await exec(`(() => {
        document.getElementById('loginUsername').value = '阿岚';
        document.getElementById('loginSubmit').click();
        return true;
    })()`);
    await sleep(300);
    const sC = await exec(`(() => {
        const b = document.getElementById('btnEditUserProfile');
        return {
            user: window.App.user && window.App.user.username,
            btn: b ? b.textContent.trim() : '',
            modal: getComputedStyle(document.getElementById('loginModal')).display,
            status: document.getElementById('stCanvas').textContent
        };
    })()`);
    check(sC.user === '阿岚', '保存后写进 App.user', JSON.stringify(sC));
    check(/阿岚/.test(sC.btn), '按钮上回显名字', sC.btn);
    check(sC.modal === 'none', '保存后弹窗关闭', sC.modal);
    check(/已保存「阿岚」/.test(sC.status), '状态栏给出保存反馈', sC.status);

    // ── C：再点开进资料页，且不再显示「@用户名」这种账号味文案 ──
    await exec(`document.getElementById('btnEditUserProfile').click()`);
    await sleep(150);
    const sD = await exec(`(() => ({
        form: getComputedStyle(document.getElementById('loginFormView')).display,
        profile: getComputedStyle(document.getElementById('loginProfileView')).display,
        name: document.getElementById('loginDisplayName').textContent,
        sub: document.getElementById('loginUsernameDisplay').textContent
    }))()`);
    check(sD.form === 'none' && sD.profile !== 'none', '有资料时点开直接进资料页', JSON.stringify(sD));
    check(sD.name === '阿岚', '资料页显示名字', sD.name);
    const sF = await exec(`(() => ({
        clear: document.getElementById('loginLogout').textContent.trim(),
        title: document.getElementById('loginLogout').title,
        hints: Array.from(document.querySelectorAll('#loginFormView .login-field-hint')).map(x => x.textContent),
        note: document.querySelector('#loginFormView .login-hint').textContent
    }))()`);
    check(/清除名称与昵称/.test(sF.clear) && /头像保留/.test(sF.title), '清除按钮与提示文案统一', JSON.stringify(sF));
    check(sF.hints.length === 2 && /本机标识/.test(sF.hints[0]) && /显示名/.test(sF.hints[1]),
        '名称/昵称两个字段各有用途说明', JSON.stringify(sF.hints));
    check(/昵称只用于本机显示/.test(sF.note), '弹窗不再暗示昵称会印在照片上', sF.note);
    check(!/^@/.test(sD.sub) && /仅保存在本机/.test(sD.sub),
        '资料页说明是「仅保存在本机」而不是 @用户名', sD.sub);

    // ── C2：资料页「编辑昵称」回表单，预填当前值，保存后头像不动 ──
    await exec(`(() => {
        try { localStorage.setItem('qfs_user_avatar', 'data:image/jpeg;base64,AAAA'); } catch (_) {}
        document.getElementById('btnEditProfile').click();
        return true;
    })()`);
    await sleep(180);
    const sC2 = await exec(`(() => ({
        form: getComputedStyle(document.getElementById('loginFormView')).display,
        profile: getComputedStyle(document.getElementById('loginProfileView')).display,
        username: document.getElementById('loginUsername').value,
        nickname: document.getElementById('loginNickname').value,
        submit: document.getElementById('loginSubmit').textContent
    }))()`);
    check(sC2.form !== 'none' && sC2.profile === 'none' && sC2.username === '阿岚' && sC2.nickname === '阿岚',
        '「编辑昵称」回到表单并预填当前名称与昵称', JSON.stringify(sC2));
    check(/保存修改/.test(sC2.submit), '编辑态按钮写「保存修改」', sC2.submit);
    await exec(`(() => {
        document.getElementById('loginNickname').value = '阿岚工作室';
        document.getElementById('loginSubmit').click();
        return true;
    })()`);
    await sleep(300);
    const sC3 = await exec(`(() => ({
        nick: window.App.user && window.App.user.nickname,
        avatar: localStorage.getItem('qfs_user_avatar'),
        btn: document.getElementById('btnEditUserProfile').textContent.trim()
    }))()`);
    check(sC3.nick === '阿岚工作室' && /阿岚工作室/.test(sC3.btn), '昵称改好了且按钮回显', JSON.stringify(sC3));
    check(sC3.avatar === 'data:image/jpeg;base64,AAAA', '改昵称后头像没丢', String(sC3.avatar).slice(0, 30));
    await exec(`(() => { document.getElementById('btnEditUserProfile').click(); return true; })()`);
    await sleep(150);
    const sC4 = await exec(`document.getElementById('loginDisplayName').textContent`);
    check(sC4 === '阿岚工作室', '再打开资料页显示改后的昵称', sC4);
    await exec(`document.getElementById('loginModalClose').click()`);

    // ── D：清除资料 → 按钮回到默认文案 ──
    await exec(`document.getElementById('loginLogout').click()`);
    await sleep(300);
    const sE = await exec(`(() => ({
        user: window.App.user,
        btn: document.getElementById('btnEditUserProfile').textContent.trim(),
        status: document.getElementById('stCanvas').textContent
    }))()`);
    // userStashNull 不在页面里，用主进程侧状态判定更直接
    check(sE && sE.user === null, '清除后 App.user 归零', JSON.stringify(sE && { user: sE.user }));
    check(sE && /^昵称与头像…?$/.test(sE.btn), '按钮回到「昵称与头像…」', sE && sE.btn);
    check(sE && /已清除名称与昵称，头像保留/.test(sE.status), '状态栏文案统一为「清除名称与昵称，头像保留」', sE && sE.status);
    check(userStub === null, '主进程侧资料也清掉了', JSON.stringify(userStub));

    console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });

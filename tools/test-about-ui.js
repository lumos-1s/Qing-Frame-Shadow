// 设置-「关于」区回归:ARIA / Esc / 焦点循环 / 更新状态机 / 诊断内联反馈。
// 关于已并入设置弹窗(无独立 aboutModal),这里统一通过「打开设置」进入关于区验证。
// 用法: node tools/run-electron.js tools/test-about-ui.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net, clipboard } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
};

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
ipcMain.handle('get-app-info', () => ({
    version: '0.1.21',
    electron: '31.7.7',
    chrome: '126.0.6478.234',
    node: '20.18.3',
    platform: 'win32',
    arch: 'x64',
    packaged: true,
    portable: false,
    osRelease: '10.0.22631',
    userData: 'C:\\Users\\lumos\\AppData\\Roaming\\qingframe-web-release',
    appPath: ROOT
}));
ipcMain.handle('open-external', () => ({ ok: true }));
ipcMain.handle('open-data-dir', () => ({ ok: true }));
// 无头环境可能没有剪贴板后端：writeText 静默失败、readText 读回旧内容。
// 真正要验的是「渲染端把诊断日志整段交给了主进程」，所以记下收到的文本再断言。
let lastCopiedText = '';
ipcMain.handle('copy-text', (_e, text) => {
    lastCopiedText = String(text || '');
    try { clipboard.writeText(lastCopiedText); } catch (_) { /* 环境无剪贴板 */ }
    return { ok: true };
});
ipcMain.handle('save-diagnostics', () => ({ ok: true, path: path.join(process.env.TEMP || '.', 'qf-diag.txt') }));
ipcMain.handle('check-for-updates', () => ({ ok: true }));
ipcMain.handle('start-update-download', () => ({ ok: true }));
ipcMain.handle('quit-and-install', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url);
            const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) {
            return new Response('NF', { status: 404 });
        }
    });

    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        show: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload-about.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));


    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom)')) break;
        await new Promise(r => setTimeout(r, 250));
    }

    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await exec(`(() => {
        const b = document.getElementById('btnSettings');
        if (b) b.focus();
        window.App.presets = new Array(87).fill(0);
    })()`);
    await exec('window.App.openSettings()');
    await new Promise(r => setTimeout(r, 300));
    await exec(`window.App.switchSettingsTab('about')`);
    await new Promise(r => setTimeout(r, 100));

    const state = await exec(`(() => {
        const modal = document.getElementById('settingsModal');
        const image = document.querySelector('.about-logo');
        const panel = document.getElementById('settingsPanelAbout');
        return {
            dialogRole: modal.getAttribute('role'),
            ariaModal: modal.getAttribute('aria-modal'),
            labelled: modal.getAttribute('aria-labelledby'),
            titleId: document.getElementById('settingsTitle') ? document.getElementById('settingsTitle').id : '',
            aboutSec: !!document.getElementById('aboutSec'),
            aboutVisible: !!panel && panel.getClientRects().length > 0,
            focus: document.activeElement && document.activeElement.id,
            version: document.getElementById('aboutInfo').textContent,
            packageType: document.getElementById('aboutPackageType').textContent,
            system: document.getElementById('aboutRuntimePlatform').textContent,
            stats: document.getElementById('aboutStatsText').textContent,
            // 期望值按运行时数据现算:边框数由本用例塞的占位决定,风格数来自真实 StyleCaps,
            // 写死会在每次新增边框/风格时误报(本版新增 3 个预设就红在这)。
            statsExpect: (window.App.presets ? window.App.presets.length : 0) + ' 款边框、'
                + (window.StyleCaps && window.StyleCaps.MEASURED ? Object.keys(window.StyleCaps.MEASURED).length : 0) + ' 种风格',
            icon: { complete: image.complete, w: image.naturalWidth },
            shortcuts: [...document.querySelectorAll('.about-shortcuts .about-keys')].map(x => x.textContent).join(' '),
            note: document.querySelector('.about-note').textContent,
            updateStatus: document.getElementById('aboutUpdateStatus').textContent,
            updateAction: { text: document.getElementById('aboutUpdateAction').textContent, display: document.getElementById('aboutUpdateAction').style.display },
            diagStatus: document.getElementById('aboutDiagStatus').textContent
        };
    })()`);
    check(state.dialogRole === 'dialog', 'ARIA role=dialog');
    check(state.ariaModal === 'true', 'ARIA aria-modal=true');
    check(state.labelled === 'settingsTitle' && state.titleId === 'settingsTitle', 'ARIA labelledby/title');
    check(state.aboutSec, '设置里有「关于」区');
    check(state.aboutVisible, '「关于」页签下关于区可见', String(state.aboutVisible));
    check(state.focus === 'settingsClose', '打开时焦点在关闭按钮', state.focus);
    check(state.version.includes('Windows x64') && state.version.includes('安装版'), '版本行含平台/安装类型', state.version);
    check(state.packageType === '安装版', '安装类型行', state.packageType);
    check(state.system.includes('10.0.22631'), '系统行含 Windows 版本', state.system);
    check(state.stats === state.statsExpect && state.stats !== '0 款边框、0 种风格', '动态边框/风格数量', state.stats + '  期望: ' + state.statsExpect);
    check(state.icon.complete && state.icon.w > 0, '关于页图标加载', JSON.stringify(state.icon));
    check(state.shortcuts.includes('CtrlShiftZ'), '快捷键包含 Ctrl+Shift+Z');
    check(state.note.includes('无修饰键') || state.note.includes('保留给文本编辑'), '输入框快捷键说明已修正');
    check(state.updateStatus === '', '非便携打包版初始不显示更新状态', state.updateStatus);
    check(state.updateAction.display === 'none', '更新操作初始隐藏');

    // 更新状态机
    await exec(`(() => { window.App._aboutInfo = { packaged: true, portable: false }; window.App._updater = { state: 'available' }; window.App._updateInfo = { version: '0.1.21' }; window.App._onUpdaterEvent({ type: 'available', version: '0.1.21' }); })()`);
    let s = await exec(`({ text: document.getElementById('aboutUpdateStatus').textContent, action: document.getElementById('aboutUpdateAction').textContent, mode: document.getElementById('aboutUpdateAction').dataset.mode, display: document.getElementById('aboutUpdateAction').style.display })`);
    check(s.text.includes('发现新版本') && s.action === '立即更新' && s.mode === 'download' && s.display === '', 'available 内联状态/动作', JSON.stringify(s));
    await exec(`window.App._onUpdaterEvent({ type: 'progress', percent: 42.5 })`);
    s = await exec(`({ text: document.getElementById('aboutUpdateStatus').textContent, action: document.getElementById('aboutUpdateAction').textContent })`);
    check(s.text.includes('42.5%') && s.action === '', 'progress 内联进度', JSON.stringify(s));
    await exec(`window.App._onUpdaterEvent({ type: 'downloaded' })`);
    s = await exec(`({ text: document.getElementById('aboutUpdateStatus').textContent, action: document.getElementById('aboutUpdateAction').textContent, mode: document.getElementById('aboutUpdateAction').dataset.mode })`);
    check(s.text.includes('重启') && s.action === '立即重启' && s.mode === 'install', 'downloaded 内联状态/动作', JSON.stringify(s));
    await exec(`window.App._onUpdaterEvent({ type: 'error', message: '网络异常' })`);
    s = await exec(`({ text: document.getElementById('aboutUpdateStatus').textContent, action: document.getElementById('aboutUpdateAction').textContent })`);
    check(s.text.includes('网络异常') && s.action === '重试下载', 'error 内联状态/重试', JSON.stringify(s));
    await exec(`(() => { window.App._aboutInfo = { packaged: true, portable: true }; window.App.syncAboutUpdateState(); })()`);
    s = await exec(`({ text: document.getElementById('aboutUpdateStatus').textContent, action: document.getElementById('aboutUpdateAction').textContent, mode: document.getElementById('aboutUpdateAction').dataset.mode })`);
    check(s.text.includes('便携版') && s.action === '前往 Releases' && s.mode === 'releases', 'portable 手动下载提示', JSON.stringify(s));
    await exec(`(() => { window.App._aboutInfo = { packaged: false, portable: false }; window.App.syncAboutUpdateState(); })()`);
    s = await exec(`document.getElementById('aboutUpdateStatus').textContent`);
    check(s.includes('开发模式'), '开发模式提示', s);

    // 更新详情：releaseNotes 可能是 GitHub 生成的 HTML（<h2>/<ul>/<a>），
    // 旧实现把它交给 Markdown 渲染器转义，弹窗里直接显示标签源码。
    await exec(`(() => {
        window.App._updateInfo = {
            version: '0.1.22',
            releaseNotes: [
                { version: '0.1.22', note: '<h2>本次更新</h2><ul><li><strong>导出</strong>支持重试</li><li><a href="https://github.com/example/repo">提交说明</a></li></ul><script>window.__rnXss = 1</script><img src=x onerror="window.__rnXss = 2">' },
                { version: '0.1.21', note: '<p>旧版本</p>' }
            ]
        };
        window.App.showUpdateNotes();
    })()`);
    const rn = await exec(`(() => {
        const b = document.getElementById('updateNotesBody');
        const a = b.querySelector('a');
        return {
            display: document.getElementById('updateNotesModal').style.display,
            text: (b.textContent || '').replace(/\\s+/g, ' ').trim(),
            rawTag: /<(?:h2|ul|li|script)\\b/i.test(b.textContent || ''),
            heading: !!b.querySelector('.rn-h'),
            items: b.querySelectorAll('.rn-list li').length,
            href: a ? a.getAttribute('href') : '',
            target: a ? a.getAttribute('target') : '',
            xss: !!window.__rnXss
        };
    })()`);
    check(rn.display === 'flex' && !rn.rawTag && rn.heading && rn.items === 2
          && rn.text.includes('本次更新') && rn.text.includes('导出支持重试')
          && !rn.text.includes('旧版本'),
        '更新详情：HTML releaseNotes 渲染为富文本，不再显示标签源码', JSON.stringify(rn));
    check(rn.href === 'https://github.com/example/repo' && rn.target === '_blank'
          && !rn.xss, '更新详情：只保留安全链接，脚本/图片被丢弃', JSON.stringify(rn));
    await exec('window.App.hideUpdateNotes()');

    // Markdown 仍走原渲染路径（不能被 HTML 分支误吞）
    await exec(`(() => {
        window.App._updateInfo = { version: '0.1.22', releaseNotes: '## 标题\\n这是一段 **加粗** 文本\\n- 条目' };
        window.App.showUpdateNotes();
    })()`);
    const rnMd = await exec(`(() => {
        const b = document.getElementById('updateNotesBody');
        return {
            heading: !!b.querySelector('.rn-h'),
            items: b.querySelectorAll('.rn-list li').length,
            strong: !!b.querySelector('strong'),
            text: b.textContent
        };
    })()`);
    check(rnMd.heading && rnMd.items === 1 && rnMd.strong && !rnMd.text.includes('**'),
        '更新详情：Markdown releaseNotes 仍正常渲染', JSON.stringify(rnMd));
    await exec('window.App.hideUpdateNotes()');

    // Tab 焦点循环:设置弹窗内最后一个可聚焦元素按 Tab 回到关闭按钮;关闭按钮 Shift+Tab 回到最后一个。
    const lastFocus = await exec(`(() => {
        const items = [...document.querySelectorAll('#settingsModal button:not([disabled]), #settingsModal summary')]
            .filter(el => el.getClientRects().length > 0);
        const last = items[items.length - 1];
        last.focus();
        return last.id || last.textContent;
    })()`);
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))`);
    s = await exec(`document.activeElement && document.activeElement.id`);
    check(s === 'settingsClose', 'Tab 从末尾回到关闭按钮', lastFocus + ' -> ' + s);
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))`);
    s = await exec(`document.activeElement && document.activeElement.id`);
    check(s !== 'settingsClose' && s !== '', 'Shift+Tab 从关闭按钮回到末尾', s);

    // 诊断内联反馈 + 剪贴板
    await exec(`window.App.copyDiagnostics()`);
    await new Promise(r => setTimeout(r, 400));
    const diag = await exec(`document.getElementById('aboutDiagStatus').textContent`);
    check(lastCopiedText.includes('清框影 诊断日志'), '复制诊断信息交给主进程（内容含标题）',
        (lastCopiedText || '').slice(0, 40));
    check(diag.includes('已复制'), '复制诊断信息内联反馈', diag);
    await exec(`window.App.openDataDir()`);
    await new Promise(r => setTimeout(r, 250));
    const dir = await exec(`document.getElementById('aboutDiagStatus').textContent`);
    check(dir.includes('已打开'), '打开数据目录内联反馈', dir);
    await exec(`window.App.exportDiagnostics()`);
    await new Promise(r => setTimeout(r, 250));
    const exported = await exec(`document.getElementById('aboutDiagStatus').textContent`);
    check(exported.includes('已保存'), '导出诊断日志内联反馈', exported);

    // Esc + 焦点恢复
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await new Promise(r => setTimeout(r, 100));
    s = await exec(`({ display: document.getElementById('settingsModal').style.display, focus: document.activeElement && document.activeElement.id })`);
    check(s.display === 'none' && s.focus === 'btnSettings', 'Esc 关闭并恢复焦点', JSON.stringify(s));

    if (failures.length) {
        console.error('\n设置-关于区检查失败: ' + failures.length);
        failures.forEach(f => console.error(' - ' + f));
        app.exit(1);
    } else {
        console.log('\n设置-关于区检查全部通过');
        app.exit(0);
    }
}).catch((e) => {
    console.error(e && e.stack || e);
    app.exit(1);
});

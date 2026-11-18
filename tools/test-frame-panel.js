// AI 边框协作面板回归：打开、列表、读写、体检、预览、应用，全流程走真实面板 JS + mock IPC。
// 用法: node tools/run-electron.js tools/test-frame-panel.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-frames-'));
const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── IPC mock（frames:* 用临时目录，其余沿用测量桩） ──
ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => { try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, String(n).replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; } });
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'copy-text', 'save-diagnostics', 'check-for-updates', 'quit-and-install']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'pick-export-location', 'write-export-files', 'read-exif', 'open-image', 'pick-default-export-dir']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({ version: require('../package.json').version, electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: TMP, appPath: ROOT }));

const frameFile = (name) => path.join(TMP, name.endsWith('.json') ? name : name + '.json');
ipcMain.handle('frames:list', () => fs.readdirSync(TMP).filter((n) => n.endsWith('.json')).sort());
ipcMain.handle('frames:read', (_e, name) => {
    const p = frameFile(path.basename(String(name || '')));
    try { return fs.existsSync(p) ? { name: path.basename(p), text: fs.readFileSync(p, 'utf8') } : null; } catch (_) { return null; }
});
ipcMain.handle('frames:save', (_e, name, text) => {
    try {
        JSON.parse(String(text || ''));
        fs.writeFileSync(frameFile(path.basename(String(name || ''))), String(text || ''), 'utf8');
        return { ok: true };
    } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('frames:dir', () => ({ path: TMP }));
ipcMain.handle('frames:openDir', () => ({ ok: true }));
ipcMain.handle('frames:watch', () => ({ ok: true }));
ipcMain.handle('agent:detect', () => [{ id: 'opencode', name: 'OpenCode', installed: true, path: 'mock', acp: true, acpPath: 'mock' }]);
ipcMain.handle('frames:skill', () => ({ ok: true, text: '# 清框影边框设计规范' }));

app.whenReady().then(async () => {
    // 放一份示例 frame
    const sample = JSON.parse(fs.readFileSync(path.join(PRESET_DIR, '3D卡片.json'), 'utf8'));
    fs.writeFileSync(frameFile('sample'), JSON.stringify(sample, null, 2), 'utf8');

    const win = new BrowserWindow({ width: 1200, height: 860, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, 'preload-frame-panel.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (x) => win.webContents.executeJavaScript(x);
    await sleep(500);
    win.showInactive();
    await exec(`(() => { localStorage.setItem('qfs_intro_done','1'); if (App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(1200);

    // 1) 打开面板
    await exec(`document.getElementById('btnFramePanel').click(); true`);
    await sleep(400);
    const opened = await exec(`getComputedStyle(document.getElementById('frameModal')).display === 'flex'
        && document.querySelectorAll('#frameList .frame-file').length`);
    check(opened === true || opened >= 1, '点按钮打开面板且列出边框文件', String(opened));

    // 2) 选中 sample → JSON 填入
    await exec(`[...document.querySelectorAll('#frameList .frame-file')].find(b => b.textContent === 'sample.json').click(); true`);
    await sleep(250);
    const filled = await exec(`document.getElementById('frameText').value.length`);
    check(filled > 50, '选中文件后 JSON 填入编辑框', String(filled));

    // 3) 体检：合法 JSON 应通过
    await exec(`document.getElementById('btnFrameCheck').click(); true`);
    await sleep(100);
    const okStatus = await exec(`document.getElementById('frameStatus').textContent`);
    check(/通过/.test(okStatus), '体检对合法边框报通过', okStatus);

    // 4) 体检：非法 JSON 报错
    await exec(`document.getElementById('frameText').value = '{bad json'; document.getElementById('btnFrameCheck').click(); true`);
    await sleep(100);
    const badStatus = await exec(`document.getElementById('frameStatus').className + '|' + document.getElementById('frameStatus').textContent`);
    check(/bad/.test(badStatus.split('|')[0]), '体检对非法 JSON 报红', badStatus.slice(0, 100));

    // 5) 恢复合法 + 渲染预览
    await exec(`(() => { const t = ${JSON.stringify(JSON.stringify(sample, null, 2))}; document.getElementById('frameText').value = t; return true; })()`);
    await sleep(300); // 等示例底图 Image 异步 load 完（naturalWidth 就绪）
    await exec(`document.getElementById('btnFramePreview').click(); true`);
    await sleep(500);
    const preview = await exec(`({ imgs: document.querySelectorAll('#framePreviewStage img').length, status: document.getElementById('frameStatus').textContent })`);
    check(preview.imgs === 1, '渲染预览输出一张图片', JSON.stringify(preview));

    // 6) 应用到当前（mergePreset 保留用户内容）
    await exec(`document.getElementById('btnFrameApply').click(); true`);
    await sleep(300);
    const applied = await exec(`({ status: document.getElementById('frameStatus').textContent, name: App.template && App.template.templateName })`);
    check(/已应用/.test(applied.status), '应用到当前照片成功', JSON.stringify(applied));

    console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); app.exit(1); });

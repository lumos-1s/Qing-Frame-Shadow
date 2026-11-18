// AI 造型面板回归：一句话生成 4 宫格方案画廊、点选套用、高级区仍可用。
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

const frameFile = (name) => path.join(TMP, path.basename(String(name || '')));
ipcMain.handle('frames:list', () => fs.readdirSync(TMP).filter((n) => n.endsWith('.json')).sort());
ipcMain.handle('frames:read', (_e, name) => {
    const p = frameFile(name);
    try { return fs.existsSync(p) ? { name: path.basename(p), text: fs.readFileSync(p, 'utf8') } : null; } catch (_) { return null; }
});
ipcMain.handle('frames:save', (_e, name, text) => {
    try { JSON.parse(String(text || '')); fs.writeFileSync(frameFile(name), String(text || ''), 'utf8'); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('frames:dir', () => ({ path: TMP }));
ipcMain.handle('frames:openDir', () => ({ ok: true }));
ipcMain.handle('frames:watch', () => ({ ok: true }));
ipcMain.handle('frames:remove', (_e, name) => { try { const p = frameFile(name); if (fs.existsSync(p)) fs.unlinkSync(p); return { ok: true }; } catch (e) { return { ok: false }; } });
ipcMain.handle('frames:skill', () => ({ ok: true, text: '# 清框影边框设计规范' }));
ipcMain.handle('agent:detect', () => [{ id: 'opencode', name: 'OpenCode', installed: true, path: 'mock', acp: true, acpPath: 'mock' }]);
ipcMain.handle('agent:start', () => ({ ok: true, key: 'k1', agent: 'opencode', name: 'OpenCode', modelId: 'model',
    models: [{ value: 'm1', name: '模型一', current: true }] }));
ipcMain.handle('agent:setModel', () => ({ ok: true }));
ipcMain.handle('agent:close', () => ({ ok: true }));
ipcMain.handle('agent:cancel', () => ({ ok: true }));
// 关键：agent:prompt 模拟 agent 写 4 个方案 JSON
ipcMain.handle('agent:prompt', () => {
    // 模拟 AI 输出 4 个「图层边框」文档（新设计，非现成预设）
    const designs = [
        { name: '细线胶片', layers: [
            { type: 'rect', x: 0.06, y: 0.06, w: 0.88, h: 0.88, radius: 0.01, fill: '#10171a', fillOpacity: 0.0, stroke: '#dcba79', strokeWidth: 2 },
            { type: 'line', x1: 0.12, y1: 0.8, x2: 0.88, y2: 0.8, color: '#dcba79', width: 1 },
            { type: 'text', x: 0.5, y: 0.87, text: 'FILM', size: 0.03, color: '#f2e4c4', align: 'center' }
        ]},
        { name: '圆章留白', layers: [
            { type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.8, radius: 0.02, fill: '#ffffff', fillOpacity: 0.9 },
            { type: 'circle', cx: 0.5, cy: 0.25, r: 0.1, fill: '#129e78' }
        ]},
        { name: '双线极简', layers: [
            { type: 'line', x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.1, color: '#e6d9b8', width: 2 },
            { type: 'text', x: 0.5, y: 0.92, text: 'QINGFRAME', size: 0.025, color: '#e6d9b8', align: 'center' }
        ]},
        { name: '墨绿边框', layers: [
            { type: 'rect', x: 0.04, y: 0.04, w: 0.92, h: 0.92, radius: 0.015, fill: '#1e3a2f', fillOpacity: 0.0, stroke: '#dcba79', strokeWidth: 3 }
        ]}
    ];
    designs.forEach((d, i) => fs.writeFileSync(frameFile('a' + (i + 1) + '.json'), JSON.stringify({ templateName: d.name, layers: d.layers }, null, 2), 'utf8'));
    return { ok: true };
});

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1200, height: 860, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, 'preload-frame-panel.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (x) => win.webContents.executeJavaScript(x);
    await sleep(500); win.showInactive();
    await exec(`(() => { localStorage.setItem('qfs_intro_done','1'); if (App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(1200);

    // 注入 2 张已导入照片（模拟用户导入），验证画廊示例图可选
    await exec(`(async () => {
        const mk = (color) => { const c=document.createElement('canvas'); c.width=400;c.height=500;
            const g=c.getContext('2d'); g.fillStyle=color; g.fillRect(0,0,400,500); return c; };
        const img = async (color) => { const im=new Image(); await new Promise(r=>{im.onload=r;im.src=mk(color).toDataURL('image/png')}); return im; };
        const a = await img('#c0392b'), b = await img('#2980b9');
        App.images = [ {name:'红色照片.jpg', el:a, thumb:'', w:400,h:500,exif:{}},
                       {name:'蓝色照片.jpg', el:b, thumb:'', w:400,h:500,exif:{}} ];
        App.image = App.images[0]; App.currentIdx = 0;
        return true;
    })()`);
    await sleep(200);

    // 1) 打开面板，空态引导出现
    await exec(`document.getElementById('btnFramePanel').click(); true`);
    await sleep(400);
    const opened = await exec(`getComputedStyle(document.getElementById('frameModal')).display === 'flex' && !!document.getElementById('frameGalleryEmpty')`);
    check(opened === true, '打开面板显示空态引导（一句话 + 4 款）', String(opened));

    // 2) 输入想法 → 生成 → 4 宫格
    await exec(`document.getElementById('framePrompt').value = '暖色胶片、底部加日期'; document.getElementById('btnGenerate').click(); true`);
    await sleep(1500);
    const cards = await exec(`({ n: document.querySelectorAll('#frameGallery .frame-swatch').length,
        names: [...document.querySelectorAll('.frame-swatch-name')].map(x=>x.textContent),
        imgs: document.querySelectorAll('.frame-swatch-img img').length })`);
    check(cards.n === 4, '生成 4 宫格方案', JSON.stringify(cards));
    check(cards.imgs === 4, '每张方案都渲染出缩略图', String(cards.imgs));
    check(cards.names.join(',') === '细线胶片,圆章留白,双线极简,墨绿边框',
        '展示的是 AI 全新设计的图层边框（非现成预设）', cards.names.join(','));

    // 2.5) 示例照片下拉：列出已导入照片，切换后画廊用新照片重渲染
    const sample = await exec(`(() => {
        const sel = document.getElementById('frameSamplePhoto');
        return { n: sel.options.length, labels: [...sel.options].map(o=>o.textContent), value: sel.value };
    })()`);
    check(sample.n === 2 && /红色照片/.test(sample.labels.join(' ')) && /蓝色照片/.test(sample.labels.join(' ')),
        '示例照片下拉列出已导入照片', JSON.stringify(sample));
    const before = await exec(`document.querySelector('.frame-swatch-img img').src`);
    await exec(`(() => { const s=document.getElementById('frameSamplePhoto'); s.value='1'; s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    await sleep(300);
    const after = await exec(`document.querySelector('.frame-swatch-img img').src`);
    check(before !== after, '切换示例照片后画廊重新渲染（用新照片）',
        JSON.stringify({ changed: before !== after, beforeLen: before.length, afterLen: after.length }));

    // 3) 点第 2 张 → 真正套用：合成图成为当前照片位图
    await exec(`document.querySelectorAll('#frameGallery .frame-swatch')[1].click(); true`);
    await sleep(600);
    const applied = await exec(`({ status: document.getElementById('frameStatus').textContent, src: App.image.el && App.image.el.src ? App.image.el.src.slice(0,40) : 'canvas' })`);
    check(/已套用/.test(applied.status), '点 AI 图层样片真正套用', JSON.stringify(applied));

    // 4) 高级区仍可用：助手/模型已就绪
    const adv = await exec(`({ hasAdvanced: !!document.querySelector('.frame-advanced'), modelLabel: document.getElementById('frameModelLabel').textContent, agentSel: (document.getElementById('frameAgentSelect')||{}).value })`);
    check(adv.hasAdvanced && adv.agentSel === 'opencode', '高级区保留且助手已就绪', JSON.stringify(adv));

    console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); app.exit(1); });

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
            { type: 'photo', x: 0.12, y: 0.12, w: 0.76, h: 0.6, fit: 'cover' },
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
    // 目录里预置一份上一轮的旧方案（普通预设）：本轮生成不能把它混进 4 宫格
    fs.writeFileSync(frameFile('z-old.json'), JSON.stringify({ templateName: '旧方案', photoFrameStyle: 'CARD_3D' }), 'utf8');

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

    // 3) 点第 2 张 → 套用「模板」：照片本身不能被替换/降分辨率
    await exec(`(() => { App.image.el.__qfsOrig = true; window.__srcBefore = App.image.el.src; return true; })()`);
    await exec(`document.querySelectorAll('#frameGallery .frame-swatch')[1].click(); true`);
    await sleep(600);
    const applied = await exec(`({
        status: document.getElementById('frameStatus').textContent,
        sameEl: !!(App.image.el && App.image.el.__qfsOrig),
        sameSrc: App.image.el && App.image.el.src === window.__srcBefore,
        w: App.image.el && App.image.el.width, h: App.image.el && App.image.el.height,
        aiLayers: (App.template && Array.isArray(App.template.aiLayers)) ? App.template.aiLayers.length : 0,
        name: App.template && App.template.templateName,
        photoRect: App._photoRect
    })`);
    check(/已套用/.test(applied.status), '点 AI 图层样片真正套用', JSON.stringify({ status: applied.status, name: applied.name }));
    check(applied.sameEl && applied.sameSrc, '套用不替换照片位图（原图/调色/裁切保留）', JSON.stringify({ sameEl: applied.sameEl, sameSrc: applied.sameSrc }));
    check(applied.w === 400 && applied.h === 500, '照片分辨率不变（不再压成 480×620）', applied.w + 'x' + applied.h);
    check(applied.aiLayers > 0, '边框以 template.aiLayers 形式落地（不是贴成品图）', 'layers=' + applied.aiLayers);
    check(!!applied.photoRect && applied.photoRect.w > 0 && applied.photoRect.w < 400 * 2,
        '照片按槽位渲染并记录 _photoRect', JSON.stringify(applied.photoRect));
    const center = await exec(`(() => { const cv = App.dom.canvas; const g = cv.getContext('2d');
        const d = g.getImageData(Math.round(cv.width / 2), Math.round(cv.height / 2), 1, 1).data;
        return [d[0], d[1], d[2], d[3]]; })()`);
    check(center[0] > center[1] + 30 && center[0] > center[2] + 30,
        '画布中心仍是红色照片（没有被背景层盖住）', JSON.stringify(center));

    // 4) 高级区仍可用：助手/模型已就绪；助手与模型选择有记忆
    const adv = await exec(`({ hasAdvanced: !!document.querySelector('.frame-advanced'), modelLabel: document.getElementById('frameModelLabel').textContent, agentSel: (document.getElementById('frameAgentSelect')||{}).value,
        memAgent: localStorage.getItem('qfs_ai_agent'), memModel: localStorage.getItem('qfs_ai_model:opencode') })`);
    check(adv.hasAdvanced && adv.agentSel === 'opencode', '高级区保留且助手已就绪', JSON.stringify(adv));
    check(adv.memAgent === 'opencode' && adv.memModel === 'm1', '记住助手与按助手分键的模型', JSON.stringify({ agent: adv.memAgent, model: adv.memModel }));
    check(adv.modelLabel === '模型一', '模型标签与会话实际模型一致', adv.modelLabel);

    // 5) 高级区粘贴 layers JSON → 也按模板应用（不再套成默认预设）
    const layersDoc = JSON.stringify({
        templateName: '高级图层测试',
        layers: [
            { type: 'rect', x: 0.02, y: 0.02, w: 0.96, h: 0.96, fill: '#10171a' },
            { type: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 0.65 },
            { type: 'text', x: 0.5, y: 0.88, text: 'ADV', size: 0.03, color: '#f2e4c4', align: 'center', maxW: 0.8, maxLines: 1 }
        ]
    });
    await exec(`document.getElementById('frameText').value = ${JSON.stringify(layersDoc)}; document.getElementById('btnFrameApply').click(); true`);
    await sleep(400);
    const advApplied = await exec(`({ status: document.getElementById('frameStatus').textContent, name: App.template && App.template.templateName,
        n: (App.template && Array.isArray(App.template.aiLayers)) ? App.template.aiLayers.length : 0, sameEl: !!(App.image.el && App.image.el.__qfsOrig) })`);
    check(advApplied.n === 3 && advApplied.name === '高级图层测试', '高级区 layers JSON 按模板应用', JSON.stringify(advApplied));
    check(advApplied.sameEl === true, '高级区应用同样不动照片', String(advApplied.sameEl));

    // 6) 再套一个普通预设：必须清掉 aiLayers，不能继续画 AI 图层（否则就是框中框）
    const plainDoc = JSON.stringify({ templateName: '普通预设', photoFrameStyle: 'CARD_3D' });
    await exec(`document.getElementById('frameText').value = ${JSON.stringify(plainDoc)}; document.getElementById('btnFrameApply').click(); true`);
    await sleep(500);
    const plain = await exec(`({ name: App.template && App.template.templateName,
        layers: (App.template && Array.isArray(App.template.aiLayers)) ? App.template.aiLayers.length : 0,
        sameEl: !!(App.image.el && App.image.el.__qfsOrig) })`);
    check(plain.name === '普通预设' && plain.layers === 0, '切回普通预设会清掉 AI 图层（不会框中框）', JSON.stringify(plain));
    check(plain.sameEl === true, '切回普通预设仍不动照片', String(plain.sameEl));

    console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); app.exit(1); });

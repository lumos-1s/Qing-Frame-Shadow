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
for (const c of ['save-prefs', 'save-user', 'logout-user', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'copy-text', 'save-diagnostics', 'check-for-updates', 'quit-and-install']) ipcMain.handle(c, () => ({ ok: true }));
const savedTemplates = [];
ipcMain.handle('save-template', (_e, payload) => {
    savedTemplates.push(payload || {});
    return { ok: true };
});
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
// 关键：agent:prompt 模拟 agent 写 4 个方案 JSON，并按用例切换「慢速 / 失败一次 / 变体」。
let failOnce = false;
let lastAgentPrompt = '';
let lastApiPrompt = '';
function writeDesigns(names, text) {
    const designs = [
        { name: names[0], layers: [
            { type: 'rect', x: 0.06, y: 0.06, w: 0.88, h: 0.88, radius: 0.01, fill: '#10171a', fillOpacity: 0.0, stroke: '#dcba79', strokeWidth: 2 },
            { type: 'line', x1: 0.12, y1: 0.8, x2: 0.88, y2: 0.8, color: '#dcba79', width: 1 },
            { type: 'text', x: 0.5, y: 0.87, text: text || 'FILM', size: 0.03, color: '#f2e4c4', align: 'center', maxW: 0.8, maxLines: 1 }
        ]},
        { name: names[1], layers: [
            { type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.8, radius: 0.02, fill: '#ffffff', fillOpacity: 0.9 },
            { type: 'photo', x: 0.12, y: 0.12, w: 0.76, h: 0.6, fit: 'cover' },
            { type: 'circle', cx: 0.5, cy: 0.25, r: 0.1, fill: '#129e78' }
        ]},
        { name: names[2], layers: [
            { type: 'line', x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.1, color: '#e6d9b8', width: 2 },
            { type: 'text', x: 0.5, y: 0.92, text: 'QINGFRAME', size: 0.025, color: '#e6d9b8', align: 'center', maxW: 0.8, maxLines: 1 }
        ]},
        { name: names[3], layers: [
            { type: 'rect', x: 0.04, y: 0.04, w: 0.92, h: 0.92, radius: 0.015, fill: '#1e3a2f', fillOpacity: 0.0, stroke: '#dcba79', strokeWidth: 3 }
        ]}
    ];
    designs.forEach((d, i) => fs.writeFileSync(frameFile('a' + (i + 1) + '.json'), JSON.stringify({ templateName: d.name, layers: d.layers }, null, 2), 'utf8'));
}
// API 通道：不写文件，直接回一段（可能裹着围栏的）JSON，专门塞两款「会被体检修掉」的方案
let aiCalls = 0;
ipcMain.handle('ai:chat', (_e, cfg, messages) => {
    aiCalls++;
    if (!cfg || !cfg.apiKey || !cfg.model) return { ok: false, error: '缺配置（模拟）' };
    const txt = String((messages && messages[0] && messages[0].content) || '');
    lastApiPrompt = txt;
    if (txt.indexOf('模拟空回') >= 0) return { ok: true, content: '抱歉，这次我没想法' };
    if (txt.indexOf('模拟保守') >= 0) {
        // 第一次回四款「传统相框」，应触发带原因的重出；重出那次给满版压字
        if (txt.indexOf('上一批四款平均大胆度') < 0) {
            const plain = (n) => ({ templateName: n, layers: [
                { type: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#f7f5f0' },
                { type: 'photo', x: 0.08, y: 0.08, w: 0.84, h: 0.62, fit: 'cover' },
                { type: 'text', x: 0.5, y: 0.82, text: 'QINGFRAME', size: 0.032, color: '#222222', align: 'center', maxW: 0.8, maxLines: 1 }
            ] });
            return { ok: true, content: JSON.stringify([plain('保守一'), plain('保守二'), plain('保守三'), plain('保守四')]) };
        }
        const bold = (n) => ({ templateName: n, layers: [
            { type: 'photo', x: 0, y: 0, w: 1, h: 1, fit: 'cover' },
            { type: 'rect', x: 0, y: 0.7, w: 1, h: 0.3, fill: '#111111' },
            { type: 'text', x: 0, y: 0.86, text: '重出', size: 0.12, color: '#f5efe0', align: 'left', maxW: 0.96, maxLines: 1 }
        ] });
        return { ok: true, content: JSON.stringify([bold('重出一'), bold('重出二'), bold('重出三'), bold('重出四')]) };
    }
    const mk = (name, color, extra, slot) => ({
        templateName: name, layers: [
            { type: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#f7f5f0' },
            Object.assign({ type: 'photo', x: 0, y: 0, w: 1, h: 1, fit: 'cover' }, slot || {}),
            Object.assign({ type: 'text', x: 0, y: 0.9, text: 'QINGFRAME', size: 0.12, color, align: 'left', maxW: 0.96, maxLines: 1 }, extra || {})
        ]
    });
    const plans = [
        mk('接口款一', '#1b1b1b'),
        mk('接口款二', '#fbfbfb', { y: 0.1 }, { x: 0, y: 0.5, w: 1, h: 0.5 }),    // 白字落在纸底 → 自动改色
        { templateName: '接口款三', layers: [{ type: 'photo', x: 0.3, y: 0.42, w: 0.4, h: 0.10 }] }, // 细缝槽位 → 自动放宽
        mk('接口款四', '#3a3a3a', { y: 0.45, size: 0.045 })                     // 小字压照片 → 抬高可读性
    ];
    return { ok: true, content: '好的，这是 4 款：\n```json\n' + JSON.stringify(plans) + '\n```' };
});
ipcMain.handle('ai:models', () => ({ ok: true, models: ['mock-1'] }));

ipcMain.handle('agent:prompt', (_e, _key, text) => {
    const t = String(text || '');
    lastAgentPrompt = t;
    if (t.indexOf('慢速') >= 0) {
        return new Promise((resolve) => setTimeout(() => {
            writeDesigns(['慢速一', '慢速二', '慢速三', '慢速四']);
            resolve({ ok: true });
        }, 1200));
    }
    if (t.indexOf('模拟失败') >= 0 && !failOnce) {
        failOnce = true;
        return { ok: false, error: '助手连接中断（模拟）' };
    }
    if (t.indexOf('参考这一版') >= 0) {
        writeDesigns(['变体一', '变体二', '变体三', '变体四'], 'VARIANT');
        return { ok: true };
    }
    if (t.indexOf('模拟失败') >= 0) {
        writeDesigns(['重试方案 A', '重试方案 B', '重试方案 C', '重试方案 D']);
        return { ok: true };
    }
    writeDesigns(['细线胶片', '圆章留白', '双线极简', '墨绿边框']);
    return { ok: true };
});

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1200, height: 860, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, 'preload-frame-panel.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (x) => win.webContents.executeJavaScript(x);
    await sleep(500); win.showInactive();
    await exec(`(() => { localStorage.setItem('qfs_intro_done','1'); localStorage.removeItem('qfs_ai_gallery_v1'); if (App.closeIntro) App.closeIntro(); return true; })()`);
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
    const agentFamBlock = /本轮四款的构图语法与顺序[^\n]*\n([\s\S]*?)\n本批硬指标/.exec(lastAgentPrompt);
    const agentFams = agentFamBlock ? agentFamBlock[1].split('\n').filter((l) => /^\d\./.test(l)) : [];
    const agentFamNames = agentFams.map((l) => l.replace(/^\d\.\s*/, '').split('：')[0]);
    check(/本轮四款的构图语法与顺序/.test(lastAgentPrompt) && /反默认/.test(lastAgentPrompt)
        && /至少两款有 size ≥0\.14 的展示字/.test(lastAgentPrompt) && /不要写负坐标/.test(lastAgentPrompt),
        '生成提示带上构图语法 / 反默认 / 展示字硬指标 / 出血边界',
        JSON.stringify({ fam: /构图语法与顺序/.test(lastAgentPrompt), quota: /≥0\.14/.test(lastAgentPrompt) }));
    check((lastAgentPrompt.match(/本轮四款的构图语法与顺序/g) || []).length === 1,
        '一条提示里只出现一组四款构图（不再抽两次打架）',
        String((lastAgentPrompt.match(/本轮四款的构图语法与顺序/g) || []).length));
    check(agentFams.length === 4 && new Set(agentFamNames).size === 4,
        '本轮四款构图语法互不重复', agentFamNames.join(' / '));
    const quietN = agentFamNames.filter((n) => ['档案票据', '极简光学', '取景器'].includes(n)).length;
    check(quietN === 1, '每批固定 3 破格 + 1 安静（不再一半一半）', '安静款 ' + quietN + ' / ' + agentFamNames.join(' '));
    check(agentFams.every((l) => /\d/.test((l.split('：')[1] || ''))),
        '每族都带硬指标（照片占比 / 字号 / 色块比例）', agentFams.map((l) => l.slice(0, 26)).join(' | '));
    check(agentFams.every((l) => /photo 槽位写成 [xy]?=?0?/.test(l)),
        '每族给出可抄的 photo 坐标原型（不再只写「贴边」）', agentFams.map((l) => l.slice(0, 30)).join(' | '));

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

    // 2.6) 大图预览 / 原图对比 / 收藏 / 历史
    await exec(`(() => { document.querySelectorAll('#frameGallery .frame-swatch')[0].querySelector('[data-act="expand"]').click(); return true; })()`);
    await sleep(400);
    const lb = await exec(`({ visible: !document.getElementById('frameLightbox').hidden,
        name: document.getElementById('frameLightboxName').textContent,
        src: document.getElementById('frameLightboxImg').src })`);
    check(lb.visible && lb.name === '细线胶片' && lb.src.length > 5000,
        '点放大看大图（更高分辨率预览）', JSON.stringify({ visible: lb.visible, name: lb.name, len: lb.src.length }));
    const cmpBefore = lb.src;
    await exec(`(() => { const b = document.getElementById('btnFrameLightboxCompare');
        b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
    await sleep(120);
    const cmpSrc = await exec(`document.getElementById('frameLightboxImg').src`);
    await exec(`(() => { const b = document.getElementById('btnFrameLightboxCompare');
        b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return true; })()`);
    check(cmpSrc !== cmpBefore, '按住可看原图（和成品对比）', JSON.stringify({ changed: cmpSrc !== cmpBefore, len: cmpSrc.length }));
    await exec(`document.getElementById('btnFrameLightboxClose').click(); true`);
    await sleep(120);
    const lbClosed = await exec(`document.getElementById('frameLightbox').hidden`);
    check(lbClosed === true, '大图预览可关闭', String(lbClosed));

    await exec(`document.querySelectorAll('#frameGallery .frame-swatch')[0].querySelector('[data-act="fav"]').click(); true`);
    await sleep(250);
    const favState = await exec(`({ star: document.querySelector('#frameGallery .frame-swatch [data-act="fav"]').textContent,
        count: document.getElementById('frameFavCount').textContent,
        stored: JSON.parse(localStorage.getItem('qfs_ai_gallery_v1')||'{}').favs.length })`);
    check(favState.star === '★' && favState.stored === 1, '方案可收藏并持久化', JSON.stringify(favState));

    await exec(`document.querySelector('.frame-tab[data-view="history"]').click(); true`);
    await sleep(600);
    const hist = await exec(`({ n: document.querySelectorAll('#frameGallery .frame-swatch').length,
        head: (document.querySelector('.frame-round-head') || {}).textContent || '',
        rounds: JSON.parse(localStorage.getItem('qfs_ai_gallery_v1')||'{}').rounds.length })`);
    check(hist.n === 4 && hist.rounds === 1 && /暖色胶片/.test(hist.head), '历史保留本轮 4 款（重启可读）', JSON.stringify(hist));

    await exec(`document.querySelector('.frame-tab[data-view="favs"]').click(); true`);
    await sleep(450);
    const favTab = await exec(`({ n: document.querySelectorAll('#frameGallery .frame-swatch').length,
        name: (document.querySelector('.frame-swatch-name') || {}).textContent })`);
    check(favTab.n === 1 && favTab.name === '细线胶片', '收藏标签可回看常用款', JSON.stringify(favTab));
    await exec(`document.querySelector('.frame-tab[data-view="current"]').click(); true`);
    await sleep(250);

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

    // 3.5) 套用后微调：留白 / 底色 / 文字
    await exec(`document.querySelectorAll('#frameGallery .frame-swatch')[0].click(); true`);
    await sleep(500);
    const tweak = await exec(`({ visible: !document.getElementById('frameTweak').hidden,
        name: document.getElementById('frameTweakName').textContent,
        pad: document.getElementById('frameTweakPad').value,
        texts: document.querySelectorAll('#frameTweakTexts input[type="text"]').length })`);
    check(tweak.visible && tweak.name === '细线胶片' && tweak.texts >= 1, '套用后出现微调（文字可编辑）', JSON.stringify(tweak));
    const photoBefore = await exec(`(() => { const l = (App.template.aiLayers || []).find(x => x.type === 'photo') || {};
        return { x: l.x, y: l.y, w: l.w, h: l.h }; })()`);
    await exec(`(() => { const p = document.getElementById('frameTweakPad'); p.value = '30';
        p.dispatchEvent(new Event('input', { bubbles: true }));
        p.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(500);
    const photoAfter = await exec(`(() => { const l = (App.template.aiLayers || []).find(x => x.type === 'photo') || {};
        return { x: l.x, y: l.y, w: l.w, h: l.h, bg: App.template.aiBackground }; })()`);
    check(photoAfter.w < photoBefore.w && photoAfter.x > photoBefore.x,
        '留白滑块真正移动照片槽位', JSON.stringify({ before: photoBefore, after: photoAfter }));

    await exec(`(() => { const b = document.getElementById('frameTweakBg'); b.value = '#102030';
        b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(400);
    const bgAfter = await exec(`App.template.aiBackground`);
    check(bgAfter === '#102030', '微调可改边框底色', String(bgAfter));

    await exec(`(() => { const inp = document.querySelector('#frameTweakTexts input[type="text"]');
        inp.value = '2026.11.18'; inp.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(500);
    const textAfter = await exec(`(App.template.aiLayers || []).filter(x => x.type === 'text').map(x => x.text)`);
    check(textAfter.indexOf('2026.11.18') >= 0, '微调可改边框里的文字', JSON.stringify(textAfter));

    await exec(`document.getElementById('btnTweakReset').click(); true`);
    await sleep(500);
    const tweakReset = await exec(`(() => { const l = (App.template.aiLayers || []).find(x => x.type === 'photo') || {};
        return { x: l.x, w: l.w, bg: App.template.aiBackground,
            texts: (App.template.aiLayers || []).filter(x => x.type === 'text').map(x => x.text) }; })()`);
    check(Math.abs((tweakReset.w || 0) - (photoBefore.w || 0)) < 0.002 && tweakReset.bg === '#ffffff'
        && tweakReset.texts.indexOf('2026.11.18') < 0, '微调可一键还原', JSON.stringify(tweakReset));

    // 3.5.1) 直接在主画布上编辑 AI 图层：点选 / 拖动 / 撤销 / 双击改字 / 拖角缩放
    await exec(`document.getElementById('btnFrameEditOnCanvas').click(); true`);
    const jump = await exec(`({ hidden: document.getElementById('frameModal').style.display === 'none',
        kind: (App.selectedEls[0] || {}).kind })`);
    check(jump.hidden && jump.kind === 'aiLayer', '「在画布上改」关面板并选中 AI 图层', JSON.stringify(jump));
    await exec(`document.getElementById('btnFramePanel').click(); true`);
    await sleep(300);

    // 测试窗口里 stage 可能因无布局而为 0×0；真实界面有照片时一定有尺寸，这里补上类名。
    await exec(`(() => { App.dom.stage.classList.add('has-img');
        App.dom.canvas.style.display='block'; App.dom.placeholder.style.display='none'; return true; })()`);
    const canvasBefore = await exec(`(() => { const l=(App.template.aiLayers||[]).find(x=>x.type==='text')||{};
        return { x:l.x, y:l.y, text:l.text, size:l.size, src:(App.image.el&&App.image.el.src)||'' }; })()`);
    const picked = await exec(`(() => {
        const cv=App.dom.canvas, r=cv.getBoundingClientRect();
        const l=(App.template.aiLayers||[]).find(x=>x.type==='text');
        const cx=r.left+l.x*r.width, cy=r.top+l.y*r.height;
        document.getElementById('previewCanvas').dispatchEvent(new MouseEvent('mousedown',{
            bubbles:true, button:0, clientX:cx, clientY:cy, screenX:cx, screenY:cy }));
        const s=App.selectedEls[0]||{}; return { kind:s.kind, type:(s.obj||{}).type }; })()`);
    check(picked.kind === 'aiLayer' && picked.type === 'text',
        '画布上能直接点中 AI 图层的文字', JSON.stringify(picked));

    const dragged = await exec(`(() => {
        const cv=App.dom.canvas, r=cv.getBoundingClientRect();
        const l=(App.template.aiLayers||[]).find(x=>x.type==='text');
        const cx=r.left+l.x*r.width, cy=r.top+l.y*r.height;
        window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:cx+40,clientY:cy+20,screenX:cx+40,screenY:cy+20}));
        window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
        return { x:l.x, y:l.y, src:(App.image.el&&App.image.el.src)||'' }; })()`);
    check(dragged.x > canvasBefore.x + 0.01 && dragged.y > canvasBefore.y + 0.005,
        '拖动 AI 文字直接改图层坐标', JSON.stringify({ before:canvasBefore.x, after:dragged.x }));
    check(dragged.src === canvasBefore.src, '画布拖动 AI 图层不动照片位图', dragged.src === canvasBefore.src);

    const undone = await exec(`(() => { App.undo(); const l=(App.template.aiLayers||[]).find(x=>x.type==='text')||{};
        App.redo(); const r=(App.template.aiLayers||[]).find(x=>x.type==='text')||{};
        return { undoX:l.x, redoX:r.x }; })()`);
    check(Math.abs(undone.undoX - canvasBefore.x) < 0.002 && Math.abs(undone.redoX - dragged.x) < 0.002,
        '一次画布拖动 = 一步撤销', JSON.stringify(undone));

    const editOpened = await exec(`(() => {
        const cv=App.dom.canvas, r=cv.getBoundingClientRect();
        const l=(App.template.aiLayers||[]).find(x=>x.type==='text');
        const cx=r.left+l.x*r.width, cy=r.top+l.y*r.height;
        document.getElementById('previewCanvas').dispatchEvent(new MouseEvent('dblclick',{
            bubbles:true, button:0, clientX:cx, clientY:cy, screenX:cx, screenY:cy }));
        const ta=document.querySelector('.canvas-text-editor');
        return { has:!!ta, value:ta?ta.value:'' }; })()`);
    check(editOpened.has && editOpened.value === canvasBefore.text,
        '双击 AI 文字打开画布内编辑器', JSON.stringify(editOpened));
    await exec(`(() => { const ta=document.querySelector('.canvas-text-editor'); if(!ta) return false;
        ta.value='2026 画布改字'; ta.dispatchEvent(new Event('input',{bubbles:true}));
        App.commitTextEditor(); return true; })()`);
    await sleep(300);
    const edited = await exec(`(() => ({ text:((App.template.aiLayers||[]).find(x=>x.type==='text')||{}).text,
        hasEditor:!!document.querySelector('.canvas-text-editor'),
        src:(App.image.el&&App.image.el.src)||'' }))()`);
    check(edited.text === '2026 画布改字' && !edited.hasEditor && edited.src === canvasBefore.src,
        '画布内改字写回 AI 图层且不动照片', JSON.stringify(edited));

    const resized = await exec(`(() => { if(!App._resizeHandles) App.drawSelectionBox();
        const h=App._resizeHandles&&App._resizeHandles[0]; if(!h) return null;
        const l=(App.template.aiLayers||[]).find(x=>x.type==='text'); const before=l.size;
        const rs=App.beginResize({x:h.x,y:h.y}); if(!rs) return null;
        App.applyResize({x:h.x-30,y:h.y-30});   // 角手柄向外拖 = 放大
        window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
        return { before, after:l.size }; })()`);
    check(resized && resized.after > resized.before,
        '拖四角直接缩放 AI 图层字号', JSON.stringify(resized));

    // 吸附 + 参考线：拖到画布中线附近会自动对齐，拖动中能看到绿色高亮线，松手清掉
    await exec(`(() => { const cv=App.dom.canvas, l=(App.template.aiLayers||[]).find(x=>x.type==='text');
        App._testPrevMax = App.displayMax; App.displayMax = 3600;
        window.AiLayers.setLayerCenter(l, cv.width*0.48, cv.height*0.62, cv.width, cv.height);
        App.selectedEls=[{kind:'aiLayer',obj:l,index:App.template.aiLayers.indexOf(l)}];
        App.scheduleRender(true); return true; })()`);
    await sleep(250);
    await exec(`(() => {
        const r=App.dom.canvas.getBoundingClientRect();
        const cx=r.left+0.48*r.width, cy=r.top+0.62*r.height;
        document.getElementById('previewCanvas').dispatchEvent(new MouseEvent('mousedown',{
            bubbles:true, button:0, clientX:cx, clientY:cy, screenX:cx, screenY:cy }));
        window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:cx+3,clientY:cy+2,screenX:cx+3,screenY:cy+2}));
        return true; })()`);
    await sleep(250);   // 让 rAF 真正渲一帧，背景缓存才会建好
    const snapped = await exec(`(() => {
        const cv=App.dom.canvas, l=(App.template.aiLayers||[]).find(x=>x.type==='text');
        const cvb=window.AiLayers.layerBounds(App.aiMeasureCtx(),l,cv.width,cv.height);
        const res={ x:l.x, guides:(App._aiGuides||[]).length,
            types:JSON.stringify(App._aiGuides), cw:cv.width, rectW:cv.getBoundingClientRect().width,
            bounds:cvb, start:(App._dragEl||{}).x, snap:App._aiSnap,
            fast:App._dragBaseValid(), lowMax:App.displayMax };
        window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
        res.cleared=(App._aiGuides||[]).length;
        res.restored=App.displayMax;
        App.displayMax=App._testPrevMax; App._testPrevMax=null;
        return res; })()`);
    const guide = JSON.parse(snapped.types)[0] || {};
    const midX = snapped.x * snapped.cw;
    const edges = [midX - snapped.bounds.w / 2, midX, midX + snapped.bounds.w / 2];
    const aligned = guide.axis === 'v' && edges.some((v) => Math.abs(v - guide.pos) < 2);
    check(aligned && snapped.guides > 0 && snapped.cleared === 0,
        '拖动自动吸附到对齐线并显示参考线', JSON.stringify({ x: snapped.x, guide, guides: snapped.guides, cleared: snapped.cleared }));
    check(snapped.fast === true && snapped.lowMax === 3600 && snapped.restored === 3600,
        '拖动走背景缓存快通道且不动预览档位',
        JSON.stringify({ fast: snapped.fast, max: snapped.lowMax, restored: snapped.restored }));

    // 拖动不能改显示尺寸：曾经在按下时把 displayMax 压到 1200，画面整幅缩一圈，
    // 且 _dragEl.x0 是旧画布像素口径，除以新宽度后元素直接飞到画外。
    await exec(`(() => { const cv=App.dom.canvas, l=(App.template.aiLayers||[]).find(x=>x.type==='text');
        window.AiLayers.setLayerCenter(l, cv.width*0.35, cv.height*0.5, cv.width, cv.height);
        App.selectedEls=[{kind:'aiLayer',obj:l,index:App.template.aiLayers.indexOf(l)}];
        App.scheduleRender(true); return true; })()`);
    await sleep(300);
    const dragBefore = await exec(`(() => {
        const cv=App.dom.canvas, r=cv.getBoundingClientRect(), l=(App.template.aiLayers||[]).find(x=>x.type==='text');
        const c=window.AiLayers.layerCenter(l, cv.width, cv.height);
        return { cw:cv.width, ch:cv.height, rw:r.width, rh:r.height, max:App.displayMax,
                 lx:l.x, ly:l.y, sx:r.left + c.x/cv.width*r.width, sy:r.top + c.y/cv.height*r.height };
    })()`);
    await exec(`(() => {
        const cv=App.dom.canvas, r=cv.getBoundingClientRect(), l=(App.template.aiLayers||[]).find(x=>x.type==='text');
        const c=window.AiLayers.layerCenter(l, cv.width, cv.height);
        const sx=r.left + c.x/cv.width*r.width, sy=r.top + c.y/cv.height*r.height;
        window.__d = { sx, sy };
        document.getElementById('previewCanvas').dispatchEvent(new MouseEvent('mousedown',{
            bubbles:true, button:0, clientX:sx, clientY:sy, screenX:sx, screenY:sy }));
        return true; })()`);
    await sleep(250);
    const atDown = await exec(`(() => {
        const cv=App.dom.canvas, r=cv.getBoundingClientRect();
        return { cw:cv.width, rw:r.width, max:App.displayMax, drag:!!App._dragEl,
                 x0:App._dragEl && App._dragEl.x, cw0:App._dragEl && App._dragEl.cw0 };
    })()`);
    // 按住 Alt 关吸附，量「鼠标走多少、元素走多少」
    await exec(`(() => {
        const p=window.__d;
        window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,altKey:true,
            clientX:p.sx+60, clientY:p.sy, screenX:p.sx+60, screenY:p.sy}));
        return true; })()`);
    await sleep(250);
    const afterDrag = await exec(`(() => {
        const cv=App.dom.canvas, r=cv.getBoundingClientRect(), l=(App.template.aiLayers||[]).find(x=>x.type==='text');
        const res={ cw:cv.width, rw:r.width, max:App.displayMax, lx:l.x, ly:l.y, guides:(App._aiGuides||[]).length };
        window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
        res.afterMax=App.displayMax;
        return res; })()`);
    const movedCanvas = (afterDrag.lx - dragBefore.lx) * afterDrag.cw;
    const expectCanvas = 60 * (afterDrag.cw / afterDrag.rw);
    check(atDown.cw === dragBefore.cw && Math.abs(atDown.rw - dragBefore.rw) < 1 && atDown.max === dragBefore.max,
        '按下瞬间不改画布尺寸/预览档位（画面不缩）',
        JSON.stringify({ cw0: dragBefore.cw, cw1: atDown.cw, rw0: Math.round(dragBefore.rw), rw1: Math.round(atDown.rw), max0: dragBefore.max, max1: atDown.max }));
    check(Math.abs(movedCanvas - expectCanvas) <= 3 && Math.abs(afterDrag.ly - dragBefore.ly) < 0.002
        && afterDrag.afterMax === dragBefore.max,
        '拖动位移与鼠标精确同比例（不漂移）',
        JSON.stringify({ movedCanvas: Math.round(movedCanvas), expect: Math.round(expectCanvas),
            lx0: dragBefore.lx, lx1: afterDrag.lx, dy: +(afterDrag.ly - dragBefore.ly).toFixed(4), max: afterDrag.afterMax }));

    // Delete 删图层（照片槽位保留），Esc 取消选中
    const del = await exec(`(() => { const t=App.template.aiLayers||[];
        const l=t.find(x=>x.type==='text'); const before=t.length;
        App.selectedEls=[{kind:'aiLayer',obj:l,index:t.indexOf(l)}];
        App.deleteElement();
        const after=(App.template.aiLayers||[]).length;
        const photo=(App.template.aiLayers||[]).some(x=>x.type==='photo');
        App.undo();
        return { before, after, photo, restored:(App.template.aiLayers||[]).length }; })()`);
    check(del.after === del.before - 1 && del.photo && del.restored === del.before,
        'Delete 删除 AI 图层但保留照片槽位，可撤销', JSON.stringify(del));
    await exec(`(() => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true; })()`);
    const esc = await exec(`({ n: App.selectedEls.length, guides:(App._aiGuides||[]).length })`);
    check(esc.n === 0 && esc.guides === 0, 'Esc 取消选中并清掉参考线', JSON.stringify(esc));

    // Esc 的「取消修改」语义：拖动到一半按 Esc 要回到按下前，而不是把半截位移留在模板里。
    const cancelDrag = await exec(`(() => {
        const t = App.template.aiLayers || [];
        const l = t.find(x => x.type === 'text');
        const cv = App.dom.canvas, r = cv.getBoundingClientRect();
        const c = window.AiLayers.layerCenter(l, cv.width, cv.height);
        const sx = r.left + c.x / cv.width * r.width, sy = r.top + c.y / cv.height * r.height;
        App.selectedEls = [{ kind: 'aiLayer', obj: l, index: t.indexOf(l) }];
        const undo0 = App.undoStack.length;
        document.getElementById('previewCanvas').dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 0, clientX: sx, clientY: sy, screenX: sx, screenY: sy }));
        window.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, altKey: true, clientX: sx + 70, clientY: sy + 40, screenX: sx + 70, screenY: sy + 40 }));
        const moved = { x: l.x, y: l.y, drag: !!App._dragEl };
        const undoDrag = App.undoStack.length;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const res = { x0: l.x, y0: l.y, moved, drag: !!App._dragEl, sel: App.selectedEls.length,
            undo0, undoDrag, undo1: App.undoStack.length, guides: (App._aiGuides || []).length };
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return res;
    })()`);
    check(cancelDrag.moved.drag && Math.abs(cancelDrag.moved.x - cancelDrag.x0) > 0.002
        && cancelDrag.drag === false && cancelDrag.sel === 0 && cancelDrag.guides === 0
        && cancelDrag.undo1 === cancelDrag.undo0,
        '拖动中按 Esc 回到按下前并丢弃本次撤销步',
        JSON.stringify(cancelDrag));

    // 输入框还有焦点时点画布元素：以前 mousedown 的 preventDefault 会把焦点留在输入框，
    // setupShortcuts 把随后的 Esc 当成「正在打字」直接 return，选择框永远取消不掉。
    const focusEsc = await exec(`(() => {
        const t = App.template.aiLayers || [];
        const l = t.find(x => x.type === 'text');
        const cv = App.dom.canvas, r = cv.getBoundingClientRect();
        const c = window.AiLayers.layerCenter(l, cv.width, cv.height);
        const sx = r.left + c.x / cv.width * r.width, sy = r.top + c.y / cv.height * r.height;
        App.selectedEls = [];
        const inp = document.createElement('input');
        inp.type = 'text'; inp.id = 'tmpEscFocus';
        inp.style.cssText = 'position:fixed;left:8px;bottom:8px;width:60px;z-index:99999';
        document.body.appendChild(inp); inp.focus();
        const before = document.activeElement === inp;
        document.getElementById('previewCanvas').dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 0, clientX: sx, clientY: sy, screenX: sx, screenY: sy }));
        const blurred = document.activeElement !== inp;
        const selected = App.selectedEls.length;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const res = { before, blurred, selected, after: App.selectedEls.length };
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        inp.remove();
        return res;
    })()`);
    check(focusEsc.before && focusEsc.blurred && focusEsc.selected > 0 && focusEsc.after === 0,
        '输入框聚焦时点画布元素后 Esc 仍能取消', JSON.stringify(focusEsc));

    // 点画布外的留白也要能退出编辑（原来的 document click 分支只有注释，没有行为）。
    const outside = await exec(`(() => {
        const t = App.template.aiLayers || [];
        const l = t.find(x => x.type === 'text');
        App.selectedEls = [{ kind: 'aiLayer', obj: l, index: t.indexOf(l) }];
        if (App.refreshElList) App.refreshElList();
        const stage = document.querySelector('.stage');
        stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        stage.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { n: App.selectedEls.length };
    })()`);
    check(outside.n === 0, '点画布外取消选中', JSON.stringify(outside));

    // 3.6) 多选照片 → 批量套用
    await exec(`(() => { App.selectedIdx = [0, 1]; App.currentIdx = 0;
        document.getElementById('frameModalClose').click();
        document.getElementById('btnFramePanel').click(); return true; })()`);
    await sleep(500);
    const batchUI = await exec(`({ hidden: document.getElementById('frameBatchWrap').hidden,
        label: document.getElementById('frameBatchLabel').textContent })`);
    check(batchUI.hidden === false && /1 张/.test(batchUI.label), '多选照片时提供批量套用', JSON.stringify(batchUI));
    await exec(`(() => { document.getElementById('frameBatchApply').checked = true;
        document.querySelectorAll('#frameGallery .frame-swatch')[1].click(); return true; })()`);
    await sleep(800);
    const batch = await exec(`(() => { const t = App.getTpl(App.images[1]);
        return { n: t && Array.isArray(t.aiLayers) ? t.aiLayers.length : 0,
            status: document.getElementById('frameStatus').textContent,
            sameEl: !!(App.image.el && App.image.el.__qfsOrig) }; })()`);
    check(batch.n > 0 && /另外 1 张/.test(batch.status), '批量套用到选中的其它照片', JSON.stringify(batch));
    check(batch.sameEl === true, '批量套用同样不动照片', String(batch.sameEl));
    await exec(`(() => { App.selectedIdx = [0]; App.currentIdx = 0;
        document.getElementById('frameBatchApply').checked = false; return true; })()`);

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

    // 7) 生成可停止，迟到的结果不能覆盖画廊
    await exec(`(() => { document.getElementById('framePrompt').value = '慢速生成';
        document.getElementById('btnGenerate').click(); return true; })()`);
    await sleep(250);
    const running = await exec(`({ progress: !document.getElementById('frameProgress').hidden,
        btn: document.getElementById('btnGenerate').textContent })`);
    check(running.progress === true && /生成中/.test(running.btn), '生成中显示进度与停止按钮', JSON.stringify(running));
    await exec(`document.getElementById('btnFrameCancel').click(); true`);
    await sleep(1600);
    const cancelled = await exec(`({ status: document.getElementById('frameStatus').textContent,
        btn: document.getElementById('btnGenerate').textContent,
        progress: document.getElementById('frameProgress').hidden,
        names: [...document.querySelectorAll('.frame-swatch-name')].map(x => x.textContent) })`);
    check(/已停止/.test(cancelled.status) && cancelled.btn === '生成 4 款' && cancelled.progress === true,
        '可以停止生成，迟到结果不会覆盖画廊', JSON.stringify(cancelled));
    check(cancelled.names.join(',') !== '慢速一,慢速二,慢速三,慢速四',
        '停止后忽略助手迟到的文件', cancelled.names.join(','));

    // 8) 失败原因可视化 + 一键重试
    await exec(`(() => { document.getElementById('framePrompt').value = '模拟失败';
        document.getElementById('btnGenerate').click(); return true; })()`);
    await sleep(800);
    const failed = await exec(`({ errorHidden: document.getElementById('frameError').hidden,
        msg: document.getElementById('frameErrorMsg').textContent,
        status: document.getElementById('frameStatus').textContent })`);
    check(failed.errorHidden === false && /模拟|中断/.test(failed.msg),
        '生成失败在主界面显示原因', JSON.stringify(failed));
    await exec(`document.getElementById('btnFrameErrLog').click(); true`);
    await sleep(120);
    const logShown = await exec(`!document.getElementById('frameErrorLog').hidden`);
    check(logShown === true, '失败原因可展开助手日志', String(logShown));
    await exec(`document.getElementById('btnFrameRetry').click(); true`);
    await sleep(1400);
    const retried = await exec(`({ errorHidden: document.getElementById('frameError').hidden,
        names: [...document.querySelectorAll('.frame-swatch-name')].map(x => x.textContent),
        status: document.getElementById('frameStatus').textContent })`);
    check(retried.errorHidden === true && retried.names.join(',') === '重试方案 A,重试方案 B,重试方案 C,重试方案 D',
        '失败后可一键重试并拿到新方案', JSON.stringify(retried));

    // 9) 基于某一款继续改
    await exec(`document.querySelector('#frameGallery .frame-swatch [data-act="tweak"]').click(); true`);
    await sleep(250);
    const iterUI = await exec(`({ visible: !document.getElementById('frameIterate').hidden,
        name: document.getElementById('frameIterateName').textContent })`);
    check(iterUI.visible && iterUI.name === '重试方案 A', '卡片可基于这一款继续改', JSON.stringify(iterUI));
    await exec(`document.querySelector('#frameIterateChips [data-iter="color"]').click(); true`);
    await sleep(1600);
    const iterated = await exec(`({ names: [...document.querySelectorAll('.frame-swatch-name')].map(x => x.textContent),
        iterHidden: document.getElementById('frameIterate').hidden })`);
    check(iterated.names.join(',') === '变体一,变体二,变体三,变体四' && iterated.iterHidden === true,
        '继续改会产出 4 个变体', JSON.stringify(iterated));

    // 10) 大图预览里保存为样式模板
    await exec(`(() => { App.promptText = async () => '测试AI模板';
        document.querySelectorAll('#frameGallery .frame-swatch')[0].querySelector('[data-act="expand"]').click(); return true; })()`);
    await sleep(400);
    await exec(`document.getElementById('btnFrameLightboxSave').click(); true`);
    await sleep(500);
    const saved = await exec(`({ btn: document.getElementById('btnFrameLightboxSave').textContent,
        status: document.getElementById('frameStatus').textContent })`);
    check(savedTemplates.length === 1 && savedTemplates[0].name === '测试AI模板'
        && savedTemplates[0].data && Array.isArray(savedTemplates[0].data.aiLayers)
        && savedTemplates[0].data.aiLayers.length > 0,
        '方案可保存为样式模板（图层数据完整）',
        JSON.stringify({ saved: savedTemplates.length, name: savedTemplates[0] && savedTemplates[0].name }));
    check(/已保存模板/.test(saved.status), '保存模板有可见反馈', JSON.stringify(saved));
    await exec(`document.getElementById('btnFrameLightboxClose').click(); true`);

    // 11) 关掉再开：历史与收藏还在
    await exec(`document.getElementById('frameModalClose').click();
        document.getElementById('btnFramePanel').click(); true`);
    await sleep(500);
    await exec(`document.querySelector('.frame-tab[data-view="history"]').click(); true`);
    await sleep(700);
    const hist2 = await exec(`({ n: document.querySelectorAll('#frameGallery .frame-swatch').length,
        rounds: JSON.parse(localStorage.getItem('qfs_ai_gallery_v1')||'{}').rounds.length,
        heads: document.querySelectorAll('.frame-round-head').length })`);
    check(hist2.rounds >= 3 && hist2.n >= 8 && hist2.heads >= 2, '历史跨面板重开保留（多轮）', JSON.stringify(hist2));
    await exec(`document.querySelector('.frame-tab[data-view="favs"]').click(); true`);
    await sleep(450);
    const fav2 = await exec(`document.querySelectorAll('#frameGallery .frame-swatch').length`);
    check(fav2 === 1, '收藏跨面板重开保留', String(fav2));

    // 12) 照片速写：面板要能读出这张照片的骨架
    await exec(`document.querySelector('.frame-tab[data-view="current"]').click(); true`);
    await sleep(300);
    const brief = await exec(`(() => {
        const el = document.getElementById('frameBrief');
        return { shown: !el.hidden, text: el.textContent, title: el.title,
            app: App._frameBrief && { ratio: App._frameBrief.ratio, tone: App._frameBrief.luma.tone, x: App._frameBrief.centroid.x } };
    })()`);
    check(brief.shown === true && /已读照片/.test(brief.text), '面板显示「已读照片」速写', JSON.stringify(brief.text));
    check(!!brief.app && brief.app.ratio === '4:5', '速写识别出 4:5 竖幅', JSON.stringify(brief.app));
    check(/主色/.test(brief.title) && /重心/.test(brief.title), '速写标题带主色与重心', String(brief.title).slice(0, 80));

    // 13) API 通道：没配置时拒绝生成
    await exec(`window.QfsAiProvider.setChannel('api'); window.QfsAiProvider.save({baseUrl:'https://mock.local/v1', apiKey:'', model:''}); true`);
    await exec(`document.getElementById('framePrompt').value = '暖色胶片'; document.getElementById('btnGenerate').click(); true`);
    await sleep(500);
    const noCfg = await exec(`document.getElementById('frameStatus').textContent`);
    check(/还没配好/.test(noCfg), 'API 通道未配置时给出明确提示', noCfg);

    // 14) API 通道：回 4 个 JSON（含两款不合格）→ 出 4 款 + 自动体检修正
    await exec(`window.QfsAiProvider.save({baseUrl:'https://mock.local/v1', apiKey:'sk-test-1234', model:'mock-1'}); true`);
    const beforeAi = aiCalls;
    await exec(`document.getElementById('btnGenerate').click(); true`);
    await sleep(2000);
    const apiRun = await exec(`({ names: [...document.querySelectorAll('.frame-swatch-name')].map(x=>x.textContent),
        imgs: document.querySelectorAll('.frame-swatch-img img').length,
        badges: [...document.querySelectorAll('.frame-swatch-lint')].map(x=>x.textContent),
        status: document.getElementById('frameStatus').textContent,
        channel: window.QfsAiProvider.channel() })`);
    check(aiCalls - beforeAi === 1, 'API 通道真的被调用一次', String(aiCalls - beforeAi));
    check(apiRun.names.join(',') === '接口款一,接口款二,接口款三,接口款四', 'API 通道出 4 款（围栏 JSON 也能解析）', apiRun.names.join(','));
    const apiFamBlock = /本轮四款的构图语法与顺序[^\n]*\n([\s\S]*?)\n本批硬指标/.exec(lastApiPrompt);
    const apiFams = apiFamBlock ? apiFamBlock[1].split('\n').filter((l) => /^\d\./.test(l)) : [];
    check(/本轮四款的构图语法与顺序/.test(lastApiPrompt) && /反默认/.test(lastApiPrompt)
        && /至少两款有 size ≥0\.14 的展示字/.test(lastApiPrompt) && apiFams.length === 4,
        'API 提示同样带四族构图 / 反默认 / 展示字硬指标',
        JSON.stringify({ fam: apiFams.length, quota: /≥0\.14/.test(lastApiPrompt) }));
    check((lastApiPrompt.match(/本轮四款的构图语法与顺序/g) || []).length === 1,
        'API 一条提示只出现一组四款构图',
        String((lastApiPrompt.match(/本轮四款的构图语法与顺序/g) || []).length));
    check(apiRun.imgs === 4, 'API 方案都渲染出缩略图', String(apiRun.imgs));
    check(/自动修正/.test(apiRun.status), '状态栏报告自动修正处数', apiRun.status);
    check(apiRun.badges.length >= 2, '不合格方案挂上体检标记', JSON.stringify(apiRun.badges));
    const fixedDoc = await exec(`(() => {
        const st = JSON.parse(localStorage.getItem('qfs_ai_gallery_v1') || '{}');
        const r = (st.rounds || [])[0];
        const bad = r && r.items.find(x => x.templateName === '接口款二');
        const narrow = r && r.items.find(x => x.templateName === '接口款三');
        const slot = narrow && narrow.layers.find(l => l.type === 'photo');
        const txt = bad && bad.layers.find(l => l.type === 'text');
        return { color: txt && txt.color, slot: slot && [slot.w, slot.h] };
    })()`);
    check(fixedDoc.color && fixedDoc.color !== '#fbfbfb', '白字白底被改成可读颜色', String(fixedDoc.color));
    check(fixedDoc.slot && fixedDoc.slot[1] > 0.10 && fixedDoc.slot[0] >= 0.4, '细缝槽位被放宽', JSON.stringify(fixedDoc.slot));

    // 14b) 一批全是「传统相框」→ 自动带原因重出一次，卡片标出大胆度
    const beforeBold = aiCalls;
    await exec(`document.getElementById('framePrompt').value = '模拟保守'; document.getElementById('btnGenerate').click(); true`);
    await sleep(4200);
    const boldRun = await exec(`({ names: [...document.querySelectorAll('.frame-swatch-name')].map(x=>x.textContent),
        status: document.getElementById('frameStatus').textContent,
        bold: [...document.querySelectorAll('.frame-swatch-bold')].map(x=>x.textContent) })`);
    check(aiCalls - beforeBold === 2, '整批太保守自动重出一次', String(aiCalls - beforeBold));
    check(boldRun.names.length === 4 && boldRun.names[0] === '重出一', '重出后展示新一批', boldRun.names.join(','));
    check(boldRun.bold.length === 4 && /破格/.test(boldRun.bold[0]), '卡片标出大胆度', JSON.stringify(boldRun.bold));
    check(/平均大胆度只有 \d+ 分/.test(lastApiPrompt), '重出提示带上一批的评分与原因', lastApiPrompt.slice(-180));

    // 15) API 回垃圾文本 → 明确报错，不是静默空白
    await exec(`document.getElementById('framePrompt').value = '模拟空回'; document.getElementById('btnGenerate').click(); true`);
    await sleep(1200);
    const garbage = await exec(`({ msg: document.getElementById('frameErrorMsg').textContent,
        hidden: document.getElementById('frameError').hidden })`);
    check(garbage.hidden === false && /可解析/.test(garbage.msg), '模型回垃圾时给出可读原因', JSON.stringify(garbage));
    await exec(`window.QfsAiProvider.setChannel('local'); true`);

    console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); app.exit(1); });

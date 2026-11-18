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
ipcMain.handle('agent:prompt', (_e, _key, text) => {
    const t = String(text || '');
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

    console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); app.exit(1); });

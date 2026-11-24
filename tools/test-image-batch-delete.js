// 验证「Ctrl+A 全选缩略图 → 右键删除 / 按 Delete」能一次删掉全部照片。
//
// 回归背景(改动前的三条死路):
//   1) Delete 快捷键只处理「拼图字幕」与「画布元素(selectedEls)」,完全没有 batchSel 分支,
//      而 Ctrl+A 改的是 batchSel —— 全选后按 Delete 等于没按;
//   2) 缩略图右键菜单的「删除」写死只删右键的那一张(ctxI),没有批量入口;
//   3) removeImage 有 `images.length <= 1 → 至少保留一张照片` 的硬保护,逐张删到最后一张还删不掉。
//
// 现在:批量统一走 removeImages(降序 splice / 拼图槽位引用平移 / 允许删到 0 张回空状态),
// 且右键落在"已勾选的缩略图"上时对整个勾选批操作。
// 用 CDP 真实按键(Input.dispatchKeyEvent)走完整 keydown 链;右键菜单用真实 contextmenu 事件。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8')));
for (const c of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

// 造 N 张照片并设为当前会话(每张一个纯色 canvas,够渲染缩略图)
const setup = (n) => `(async () => {
    const A = window.App;
    const make = async (i) => {
        const c = document.createElement('canvas'); c.width = 400; c.height = 300;
        const g = c.getContext('2d'); g.fillStyle = ['#5a86bb','#bb5a5a','#5abb7a','#bbbb5a'][i % 4]; g.fillRect(0, 0, 400, 300);
        const im = new Image();
        await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.9); });
        return { el: im, name: 'p' + i + '.jpg', w: 400, h: 300, exif: {} };
    };
    const list = [];
    for (let i = 0; i < ${n}; i++) list.push(await make(i));
    A.images = list;
    A.imageTemplates = new Map();
    A.image = list[0];
    A.currentIdx = 0;
    A.selectedIdx = [0];
    A.batchSel = [];
    A.selectedEls = [];
    A.template = A.defaultTemplate();
    A.normalizeTemplate(); A.invalidateStyleCaches();
    A.buildThumbnails();
    A.updateEmptyState();
    A.scheduleRender(true);
    await new Promise(r => setTimeout(r, 600));
    // 确认框打桩:批量删除会弹 window.confirm,headless 下会阻塞渲染进程
    window.confirm = () => true;
    return { images: A.images.length, thumbs: document.querySelectorAll('#thumbStrip .thumb-item').length };
})()
`;

// 右键缩略图并点菜单里指定文案的那一项（不按下标：菜单已经扩成 4 项）
const rightClick = (idx, label) => `(async () => {
    const A = window.App;
    const wrap = document.querySelectorAll('#thumbStrip .thumb-item')[${idx}];
    if (!wrap) return { error: '缩略图不存在' };
    wrap.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }));
    await new Promise(r => setTimeout(r, 50));
    const items = Array.from(document.querySelectorAll('.ctx-menu button'));
    const labels = items.map(b => b.textContent);
    const btn = items.find(b => b.textContent === ${JSON.stringify(label)})
        || items.find(b => b.textContent.startsWith(${JSON.stringify(label)}));
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 300));
    A.closeCtx();
    return { labels, found: !!btn };
})()`;
// 找菜单里以指定文案开头的按钮并点它（用于内联脚本）
const clickCtx = (label) => `(async () => {
    const items = Array.from(document.querySelectorAll('.ctx-menu button'));
    const labels = items.map(b => b.textContent);
    const btn = items.find(b => b.textContent === ${JSON.stringify(label)})
        || items.find(b => b.textContent.startsWith(${JSON.stringify(label)}));
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 300));
    return { labels };
})()`;

const READ = `(() => {
    const A = window.App;
    return {
        images: A.images.length,
        batch: (A.batchSel || []).length,
        image: !!A.image,
        template: !!A.template,
        placeholder: getComputedStyle(A.dom.placeholder).display,
        canvas: getComputedStyle(A.dom.canvas).display,
        strip: getComputedStyle(A.dom.thumbStrip).display,
        thumbs: A.dom.thumbStrip.children.length,
        stRes: A.dom.stRes.textContent,
        stInfo: A.dom.stInfo.textContent,
        status: String(A.statusMsg || ''),
        sideMode: A._sideMode,
        photoTabHidden: !!(document.getElementById('sideTabPhoto') || {}).hidden,
    };
})()`;

// 退出码收尾:Electron 主进程完全忽略 process.exitCode,只有 app.exit(code) 能带出非 0。
function finish(code) { app.exit(code || 0); }

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, l, m) => { const s = String(m); if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 180)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    // 等启动期的「首帧预设选择」(requestIdleCallback,timeout 1500ms)跑完再开始造数据,
    // 否则它会在用例中途把 this.template 换成预设 —— 那是测试时序问题,不是产品行为。
    await new Promise(r => setTimeout(r, 2200));

    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const press = async (key, code, vk, modifiers) => {
        await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: modifiers || 0 });
        await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: modifiers || 0 });
        await new Promise(r => setTimeout(r, 500));
    };
    const ctrlA = () => press('a', 'KeyA', 65, 2); // modifiers 2 = Ctrl

    const fails = [];
    const line = (ok, label, got, expect) => {
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
        console.log(`       ${got}${expect ? '   期望: ' + expect : ''}`);
        if (!ok) fails.push(label);
    };

    console.log('胶片条批量删除(Ctrl+A 全选 → 右键删除 / Delete)');
    console.log('─'.repeat(90));

    // ① Ctrl+A 全选缩略图
    let s = await win.webContents.executeJavaScript(setup(4));
    await ctrlA();
    let a = await win.webContents.executeJavaScript(READ);
    line(s.images === 4 && a.batch === 4, '① Ctrl+A 全选 4 张缩略图',
        `batchSel=${a.batch}  状态「${a.status}」`, 'batchSel=4');

    // ② 右键任一张 → 菜单出现「删除选中 4 张」→ 点它 → 全删 + 回到空状态
    const m2 = await win.webContents.executeJavaScript(rightClick(1, '删除选中 4 张'));
    a = await win.webContents.executeJavaScript(READ);
    const c2 = [
        ['菜单项=4(3 同步 + 删除)', m2.labels && m2.labels.length === 4],
        ['前 3 项是三种同步', /^同步调色参数/.test((m2.labels && m2.labels[0]) || '')
            && /^同步边框 \+ 调色/.test((m2.labels && m2.labels[1]) || '')
            && /^同步边框（/.test((m2.labels && m2.labels[2]) || '')],
        ['末项=删除选中 4 张', /^删除选中 4 张$/.test((m2.labels && m2.labels[3]) || '')],
        ['按文案点中了删除', !!m2.found],
        ['images=0', a.images === 0],
        ['image 清空', !a.image],
        ['template 清空', !a.template],
        ['placeholder=flex', a.placeholder === 'flex'],
        ['canvas=none', a.canvas === 'none'],
    ];
    line(c2.every(x => x[1]),
        '② 右键「删除选中 4 张」→ 一次删光并回到空状态',
        `菜单=${JSON.stringify(m2.labels)}  images=${a.images}  placeholder=${a.placeholder}  canvas=${a.canvas}  状态「${a.status}」\n       ${c2.filter(x => !x[1]).map(x => '未过:' + x[0]).join(' / ') || '全部条件通过'}`,
        'images=0 / placeholder=flex / canvas=none');

    // ③ Ctrl+A 后按 Delete 键(不点右键)→ 同样删光
    s = await win.webContents.executeJavaScript(setup(3));
    await ctrlA();
    await press('Delete', 'Delete', 46);
    a = await win.webContents.executeJavaScript(READ);
    line(s.images === 3 && a.images === 0 && !a.image, '③ Ctrl+A 后按 Delete → 全删',
        `images ${s.images}→${a.images}  状态「${a.status}」`, 'images=0');

    // ④ 只选了 1 张(点缩略图单选)时,右键删除仍是"删这一张",不影响其它
    s = await win.webContents.executeJavaScript(setup(3));
    await win.webContents.executeJavaScript(`(() => { const w = document.querySelectorAll('#thumbStrip .thumb-item')[0]; w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 })); return 1; })()`);
    a = await win.webContents.executeJavaScript(READ); // 只为拿到 status 前状态,忽略
    const m4 = await win.webContents.executeJavaScript(clickCtx('删除'));
    a = await win.webContents.executeJavaScript(READ);
    line(m4.labels.length === 4 && m4.labels[3] === '删除' && a.images === 2,
        '④ 未勾选时右键删除只删右键那一张(菜单文案为「删除」)',
        `菜单=${JSON.stringify(m4.labels)}  images ${s.images}→${a.images}`, 'images=2 且菜单第二项=「删除」');

    // ⑤ 只剩 1 张时也能删掉(旧代码在这里被"至少保留一张照片"挡住)
    s = await win.webContents.executeJavaScript(setup(1));
    await win.webContents.executeJavaScript(`(() => { const w = document.querySelectorAll('#thumbStrip .thumb-item')[0]; w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 })); return 1; })()`);
    await win.webContents.executeJavaScript(clickCtx('删除'));
    a = await win.webContents.executeJavaScript(READ);
    line(s.images === 1 && a.images === 0 && !a.image && a.status != null && !/至少保留/.test(a.status),
        '⑤ 只剩 1 张也能删(不再被"至少保留一张照片"挡住)',
        `images ${s.images}→${a.images}  状态「${a.status}」`, 'images=0');

    // ⑥ 拼图页的照片库模式下删光：左栏退出照片模式，入口收起，再导入不会卡在空列表
    s = await win.webContents.executeJavaScript(setup(2));
    await win.webContents.executeJavaScript(`(() => {
        const A = window.App;
        A.template.puzzle.enabled = 1;
        A.template.puzzle.layout = 'grid4';
        A.template.puzzle.slots = { 0: { imageIndex: 0 }, 1: { imageIndex: 1 } };
        A.setTpl(A.image, JSON.parse(JSON.stringify(A.template)));
        A.switchTab('puzzle');
        A.setSideMode('photo');
        return 1;
    })()`);
    await win.webContents.executeJavaScript(`(() => {
        const A = window.App;
        A.removeImages([0, 1]);
        return 1;
    })()`);
    a = await win.webContents.executeJavaScript(READ);
    line(a.images === 0 && a.sideMode === 'border' && a.photoTabHidden,
        '⑥ 拼图照片库模式下删光照片，左栏退回素材库且照片入口收起',
        `images=${a.images} sideMode=${a.sideMode} photoTabHidden=${a.photoTabHidden}`,
        'images=0 / sideMode=border / photoTabHidden=true');

    console.log('─'.repeat(90));
    console.log(fails.length ? `✖ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 6 项通过`);
    dbg.detach();
    finish(fails.length ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });

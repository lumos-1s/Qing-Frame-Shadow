// 当前照片预览墙回归测试：
//   1. 没有照片时不显示「本图预览」；
//   2. 有照片时打开墙，88 个预设全部用当前照片离屏渲染；
//   3. 无限墙 4 份拷贝同步、切有限墙不丢预览、切回封面能恢复；
//   4. 渲染不污染当前模板 / 画布 / 图片 / 蒙版几何。
// 用法：node tools/run-electron.js tools/test-preset-wall-photo.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── IPC mock：与真实主进程契约一致（list-presets 不带 .json） ──
ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); }
    catch (_) { return null; }
});
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) {
    ipcMain.handle(channel, EMPTY_LIST);
}
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) {
    ipcMain.handle(channel, OK);
}
for (const channel of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location',
    'write-export-files', 'read-exif']) {
    ipcMain.handle(channel, CANCEL);
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.23', electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));

const CHECK = `
async () => {
    const A = window.App;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = [];
    const add = (label, ok, got, expect) => out.push({ label, ok: !!ok, got, expect });
    const grid = document.getElementById('presetWallGrid');
    const btn = document.getElementById('pwPhoto');
    const items = (window.PRESET_WALL && window.PRESET_WALL.items) || [];

    // 等预设加载完（墙初始化时只建了内置封面）
    for (let i = 0; i < 120 && !(A.presets && A.presets.length); i++) await wait(100);
    for (let i = 0; i < 80 && !grid.querySelectorAll('.pw-tile').length; i++) await wait(100);

    // 没有照片：按钮隐藏，强制打开也不进入本图预览
    A.openPresetWall();
    await wait(80);
    add('没有照片时不显示「本图预览」', btn && btn.hidden && !A._wallPhotoMode,
        'hidden=' + !!(btn && btn.hidden) + ' mode=' + !!A._wallPhotoMode, 'hidden=true mode=false');

    // 本条用例固定从无限墙开始，才能覆盖「同一预设的 4 份拷贝同步换图」。
    A.setWallMode('infinite');
    await wait(250);

    // 造一张纯绿照片：只要缩略图里出现明显绿色，就证明用的是当前照片而不是内置样片
    const c = document.createElement('canvas');
    c.width = 900; c.height = 700;
    const g = c.getContext('2d');
    g.fillStyle = '#00e000';
    g.fillRect(0, 0, c.width, c.height);
    // 中间加一小块深色，避免某些边框正好把中心遮住时误判；照片主体仍是绿色
    g.fillStyle = '#1e5a2a';
    g.fillRect(360, 280, 180, 120);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    const im = { el, name: '本图预览测试.jpg', w: el.naturalWidth, h: el.naturalHeight, exif: {}, customSettings: null };
    A.images = [im];
    A.image = im;
    A.currentIdx = 0;
    A.selectedIdx = [0];
    A.template = A.defaultTemplate();
    A.normalizeTemplate();
    A.refreshUI();
    A.scheduleRender(true);
    // 先把主画布这一帧跑完，再记基准。否则对比的是「主画布还没渲染」时的空几何，
    // 后面主画布正常渲染一次都会被误判成预览污染。
    if (typeof A.flushRender === 'function') await A.flushRender();
    await wait(120);
    const before = {
        template: A.template,
        image: A.image,
        canvas: A.dom.canvas,
        photoRect: A._photoRect,
        baseW: A._canvasBaseW,
        baseH: A._canvasBaseH,
        scale: A._canvasScale
    };

    // 打开当前照片预览
    A.openPresetWall(true);
    await wait(120);
    add('有照片时显示「本图预览」并进入预览模式',
        btn && !btn.hidden && A._wallPhotoMode && grid.classList.contains('pw-photo-mode'),
        'hidden=' + !!(btn && btn.hidden) + ' mode=' + !!A._wallPhotoMode + ' class=' + grid.classList.contains('pw-photo-mode'),
        'hidden=false mode=true class=true');
    add('按钮进入后变成「看封面」', btn && btn.textContent === '看封面', btn && btn.textContent, '看封面');
    add('按钮显示选中态（当前照片预览）', btn && btn.classList.contains('is-on'),
        btn && btn.className, '带 is-on');

    // 等 88 张全部渲染完（软件渲染下每张 5~25ms，多留余量）
    const total = items.length;
    let done = 0;
    for (let i = 0; i < 600; i++) {
        done = A._wallPhotoDone || 0;
        if (!A._wallPhotoRunning && A._wallPhotoCache && A._wallPhotoCache.thumbs.size >= total) break;
        await wait(100);
    }
    const cacheN = A._wallPhotoCache ? A._wallPhotoCache.thumbs.size : 0;
    add('全部预设渲染完成', !A._wallPhotoRunning && cacheN === total,
        'running=' + A._wallPhotoRunning + ' cache=' + cacheN + '/' + total, 'cache=' + total);

    const tiles = Array.from(grid.querySelectorAll('.pw-tile'));
    const covers = tiles.map((t) => t.querySelector('.pw-tile-cover img'));
    const dataN = covers.filter((img) => img && /^data:image\\//.test(img.getAttribute('src') || '')).length;
    add('墙上的卡片都换成当前照片缩略图', tiles.length > 0 && dataN === tiles.length,
        dataN + '/' + tiles.length, '全部 data:image');

    // 同一预设的 4 份拷贝必须同图（无限墙 4 个周期块）
    const groups = new Map();
    for (const t of tiles) {
        const src = t.querySelector('.pw-tile-cover img').getAttribute('src');
        const id = t.dataset.idx;
        if (!groups.has(id)) groups.set(id, new Set());
        groups.get(id).add(src);
    }
    const mismatch = Array.from(groups.values()).filter((s) => s.size !== 1).length;
    add('同一预设的 4 份拷贝缩略图一致', mismatch === 0, 'mismatchGroups=' + mismatch, '0');

    // 颜色验证：至少一半缩略图中心区域出现绿色，证明不是内置样片
    const greenish = (img) => new Promise((resolve) => {
        try {
            const cv = document.createElement('canvas');
            cv.width = 32; cv.height = 32;
            const x = cv.getContext('2d');
            x.drawImage(img, 0, 0, 32, 32);
            const d = x.getImageData(8, 8, 16, 16).data;
            let hit = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 1] > 150 && d[i] < 130 && d[i + 2] < 130) hit++;
            }
            resolve(hit > 20);
        } catch (_) { resolve(false); }
    });
    let greenN = 0;
    for (const img of covers) {
        if (!img) continue;
        if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
        if (await greenish(img)) greenN++;
    }
    add('缩略图内容来自当前照片（绿色检出）', greenN >= Math.floor(tiles.length / 2),
        greenN + '/' + tiles.length, '>= ' + Math.floor(tiles.length / 2));

    // 渲染不能改主编辑状态
    add('预览渲染不换掉当前模板', A.template === before.template,
        'same=' + (A.template === before.template), 'true');
    add('预览渲染不换掉当前图片/画布',
        A.image === before.image && A.dom.canvas === before.canvas,
        'image=' + (A.image === before.image) + ' canvas=' + (A.dom.canvas === before.canvas), 'true/true');
    add('预览渲染还原蒙版几何',
        A._photoRect === before.photoRect && A._canvasBaseW === before.baseW
        && A._canvasBaseH === before.baseH && A._canvasScale === before.scale,
        JSON.stringify({ rect: A._photoRect === before.photoRect, bw: A._canvasBaseW === before.baseW,
            bh: A._canvasBaseH === before.baseH, sc: A._canvasScale === before.scale }),
        'all true');

    // 切有限墙：重建后仍应贴回当前照片，而不是回封面
    A.setWallMode('finite');
    await wait(400);
    const finiteTiles = Array.from(grid.querySelectorAll('.pw-tile'));
    const finiteData = finiteTiles.filter((t) => /^data:image\\//.test(t.querySelector('.pw-tile-cover img').getAttribute('src') || '')).length;
    add('切有限墙后保留本图预览', finiteTiles.length === total && finiteData === finiteTiles.length && A._wallPhotoMode,
        'tiles=' + finiteTiles.length + ' data=' + finiteData + ' mode=' + A._wallPhotoMode,
        'tiles=' + total + ' data=' + total);
    add('切有限墙后仍是当前照片模式', A._wallPhotoMode === true,
        'mode=' + A._wallPhotoMode, 'mode=true');

    // 切回封面
    btn.click();
    await wait(300);
    const restored = Array.from(grid.querySelectorAll('.pw-tile')).filter((t) => {
        const img = t.querySelector('.pw-tile-cover img');
        return img && img.getAttribute('src') === t.dataset.cover;
    }).length;
    add('再点「看封面」恢复内置封面', !A._wallPhotoMode && restored === finiteTiles.length,
        'mode=' + A._wallPhotoMode + ' restored=' + restored + '/' + finiteTiles.length,
        'false ' + finiteTiles.length + '/' + finiteTiles.length);
    add('恢复后按钮文案回到「本图预览」', btn.textContent === '本图预览', btn.textContent, '本图预览');

    // 再开一次：应该直接复用缓存，而不是又跑 88 次
    A.openPresetWall(true);
    await wait(150);
    add('再次打开复用缓存', A._wallPhotoMode && A._wallPhotoCache && A._wallPhotoCache.thumbs.size === total,
        'cache=' + (A._wallPhotoCache ? A._wallPhotoCache.thumbs.size : 0), total);

    // 点击卡片套用当前预设并进入编辑
    const tile = grid.querySelector('.pw-tile');
    const expectName = tile.querySelector('.pw-tile-name').textContent;
    tile.click();
    await wait(250);
    add('点击卡片套用预设并关闭墙',
        document.getElementById('presetWall').hidden
        && (A.template && A.template.templateName) === expectName
        && A.image === im,
        'hidden=' + document.getElementById('presetWall').hidden
        + ' tpl=' + (A.template && A.template.templateName)
        + ' expect=' + expectName
        + ' image=' + (A.image === im),
        'hidden=true tpl=' + expectName + ' image=true');
    add('关墙后取消预览模式', !A._wallPhotoMode && !A._wallPhotoRunning,
        'mode=' + A._wallPhotoMode + ' running=' + A._wallPhotoRunning, 'false false');

    // 这条用例会切到有限墙；恢复默认（无 localStorage 键 = 无限），避免污染后面的 test:wall。
    try { localStorage.removeItem('qfs_wall_mode'); } catch (_) {}

    return { out, total, tiles: tiles.length };
}
`;

async function main() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        show: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });
    win.webContents.on('console-message', (_event, level, message) => {
        if (level >= 2) console.log('  [renderer] ' + String(message).slice(0, 240));
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(400);
    win.showInactive();
    await win.webContents.executeJavaScript(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        try { localStorage.removeItem('qfs_wall_mode'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    const result = await win.webContents.executeJavaScript(`(${CHECK})()`);
    console.log('当前照片预览墙回归测试');
    console.log('─'.repeat(96));
    let fail = 0;
    for (const c of result.out) {
        if (!c.ok) fail++;
        console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.label.padEnd(36)} 实际=${c.got}  期望=${c.expect}`);
    }
    console.log('─'.repeat(96));
    console.log(`  预设 ${result.total} 个 / 卡片 ${result.tiles} 张`);
    console.log(fail ? `✖ ${fail} 项异常` : '✓ 全部通过');
    app.exit(fail ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
    console.error(e);
    app.exit(1);
});

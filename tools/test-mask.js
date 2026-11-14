// 蒙版调色回归：四种蒙版的权重形状、羽化/反相/浓度、多蒙版叠加、参数分流、
// 画布叠加层与指针涂抹、草稿持久化。
// 用法：node tools/run-electron.js tools/test-mask.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(channel, EMPTY);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(channel, OK);
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => {
    try {
        const zlib = require('zlib');
        const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-tables.bin'));
        if (raw.slice(0, 4).toString('ascii') !== 'CRT4') return null;
        const planes = zlib.inflateSync(raw.slice(10));
        return { size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
            data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength) };
    } catch (_) { return null; }
});
ipcMain.handle('get-app-info', () => ({
    version: '0.1.21', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(500);
    win.showInactive();
    await win.webContents.executeJavaScript(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        const s = document.getElementById('pwSkip');
        if (s) s.click();
        return true;
    })()`);
    await sleep(1200);
    const exec = (expr) => win.webContents.executeJavaScript(expr);

    // 灰底测试图：上/中/下三段同色，方便验证蒙版作用区
    await exec(`window.__mkGray = async (w, h, topHex, botHex) => {
        const c = document.createElement('canvas'); c.width = w || 600; c.height = h || 400;
        const g = c.getContext('2d');
        g.fillStyle = topHex || '#808080'; g.fillRect(0, 0, c.width, c.height);
        if (botHex) { g.fillStyle = botHex; g.fillRect(0, c.height / 2, c.width, c.height / 2); }
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        return el;
    }; true`);

    const setup = `(async () => {
        const A = window.App;
        const el = await window.__mkGray(600, 400);
        const im = { el, name: 'm', path: null, w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template); A.updateEmptyState();
        if (A.refreshUI) A.refreshUI();
        A.switchTab('grade');
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 500));
        return { has: !!window.QfsMask, types: window.QfsMask ? window.QfsMask.TYPES.map((t) => t.k) : [] };
    })()`;
    const s0 = await exec(setup);
    check(s0.has && s0.types.join(',') === 'linear,radial,brush,lum,color',
        '蒙版模块已加载（线性/椭圆/画笔/亮度/颜色）', JSON.stringify(s0));

    // ── 1. 面板与列表 ──
    const ui = await exec(`(() => {
        const grp = document.getElementById('grpMask');
        const btns = Array.prototype.slice.call(document.querySelectorAll('#maskTypes [data-mt]')).map((b) => b.dataset.mt);
        const rows = document.querySelectorAll('#maskList .mask-row').length;
        const optsHidden = document.getElementById('maskOpts').style.display === 'none';
        return { inPanel: !!grp && !!grp.closest('#panel-grade'), btns, rows, optsHidden };
    })()`);
    check(ui.inPanel && ui.btns.join(',') === 'linear,radial,brush,lum,color' && ui.rows === 1 && ui.optsHidden,
        '蒙版组在调色面板顶部：5 个类型按钮 + 列表默认只有「全局」', JSON.stringify(ui));

    // ── 2. 线性渐变：权重是 alpha 渐变（上 0 / 下 255），反相/浓度生效 ──
    const linear = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 120));
        const m = A.activeMask(im);
        const alphaAt = (mm) => {
            const c = window.QfsMask.render(mm, 60, 40, im.el);
            const g = c.getContext('2d');
            const at = (y) => g.getImageData(30, y, 1, 1).data[3];
            return { top: at(1), mid: at(20), bot: at(38) };
        };
        const base = alphaAt(m);
        m.inv = 1;
        const inv = alphaAt(m);
        m.inv = 0;
        m.density = 50;
        const half = alphaAt(m);
        m.density = 100;
        return { base, inv, half, type: m.type, exp: m.p.exp };
    })()`);
    check(linear.base.top === 0 && linear.base.bot === 255,
        '线性渐变：起点侧权重 0、终点侧 255', JSON.stringify(linear.base));
    check(linear.inv.top > 200 && linear.inv.bot < 60, '反相把权重翻过来', JSON.stringify(linear.inv));
    check(linear.half.bot > 100 && linear.half.bot < 160, '浓度 50 把权重压到一半', JSON.stringify(linear.half));

    // ── 3. 径向：中心满、角上零 ──
    const radial = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.addMask('radial');
        await new Promise((r) => setTimeout(r, 120));
        const m = A.activeMask(im);
        const c = window.QfsMask.render(m, 80, 80, im.el);
        const g = c.getContext('2d');
        const at = (x, y) => g.getImageData(x, y, 1, 1).data[3];
        return { center: at(40, 34), corner: at(2, 2), edge: at(40, 2) };
    })()`);
    check(radial.center > 200 && radial.corner < 40,
        '径向椭圆：中心满权重、四角为 0', JSON.stringify(radial));

    // ── 4. 亮度：只选暗部 ──
    const lum = await exec(`(async () => {
        const A = window.App, im = A.image;
        const el = await window.__mkGray(400, 200, '#202020', '#e8e8e8');
        im.el = el; im.w = 400; im.h = 200; im._gradeCache = null;
        A.addMask('lum');
        await new Promise((r) => setTimeout(r, 120));
        const m = A.activeMask(im);
        m.shape.lo = 0; m.shape.hi = 40;
        const c = window.QfsMask.render(m, 80, 40, el);
        const g = c.getContext('2d');
        const at = (x, y) => g.getImageData(x, y, 1, 1).data[3];
        const dark = at(40, 6), bright = at(40, 34);
        m.inv = 1;
        const c2 = window.QfsMask.render(m, 80, 40, el);
        const g2 = c2.getContext('2d');
        const darkInv = g2.getImageData(40, 6, 1, 1).data[3];
        m.inv = 0;
        return { dark, bright, darkInv };
    })()`);
    check(lum.dark > 200 && lum.bright < 40 && lum.darkInv < 40,
        '亮度范围：只选暗部，反相后选亮部', JSON.stringify(lum));

    // ── 4.5 亮度蒙版的羽化必须真的改变过渡带（以前 soft 固定 35%，滑块是死的）──
    const lumFeather = await exec(`(async () => {
        const A = window.App, im = A.image;
        const c = document.createElement('canvas'); c.width = 256; c.height = 256;
        const g = c.getContext('2d');
        const grd = g.createLinearGradient(0, 0, 0, 256);
        grd.addColorStop(0, '#000'); grd.addColorStop(1, '#fff');
        g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        im.el = el; im.w = 256; im.h = 256; im._gradeCache = null;
        A.resetGrade();
        A.addMask('lum');
        await new Promise((r) => setTimeout(r, 120));
        const m = A.activeMask(im);
        m.shape = { lo: 40, hi: 60 }; m.inv = 0; m.density = 100;
        const at = (feather, y) => {
            m.feather = feather;
            const cc = window.QfsMask.render(m, 256, 256, el);
            return cc.getContext('2d').getImageData(128, y, 1, 1).data[3];
        };
        const hard = at(0, 115);      // 45%：硬边应满权重
        const soft = at(100, 115);    // 羽化 100：同一位置应明显变淡
        const hardEdge = at(0, 103);  // 40.2%：刚过下阈值
        const softEdge = at(100, 103);
        return { hard, soft, hardEdge, softEdge };
    })()`);
    check(lumFeather.hard > 240 && lumFeather.soft < 180
          && lumFeather.softEdge < lumFeather.hardEdge,
        '亮度蒙版羽化真的改变过渡带（0=硬边、100=软边）',
        JSON.stringify(lumFeather));

    // ── 5. 画笔：没涂=全 0，涂过=笔迹处有权重 ──
    const brush = await exec(`(async () => {
        const A = window.App, im = A.image;
        const el = await window.__mkGray(600, 400);
        im.el = el; im.w = 600; im.h = 400; im._gradeCache = null;
        A.addMask('brush');
        await new Promise((r) => setTimeout(r, 120));
        const m = A.activeMask(im);
        const sample = () => {
            const c = window.QfsMask.render(m, 120, 80, el);
            const g = c.getContext('2d');
            return { at: g.getImageData(60, 40, 1, 1).data[3], far: g.getImageData(6, 6, 1, 1).data[3] };
        };
        const empty = sample();
        m.shape.strokes.push({ size: 20, erase: 0, pts: [[0.35, 0.5], [0.65, 0.5]] });
        const painted = sample();
        return { empty, painted, strokes: m.shape.strokes.length };
    })()`);
    check(brush.empty.at === 0 && brush.painted.at > 120 && brush.painted.far < 60,
        '画笔：未涂无权重、涂过的笔迹处有权重、远处为 0', JSON.stringify(brush));

    // ── 5.1 笔刷大小滑块：标签/数字框必须跟着滑块走（它没走 _patchMask）──
    const brushUi = await exec(`(async () => {
        const A = window.App, im = A.image;
        const m = A.masksOf(im).find((x) => x.type === 'brush');
        A.setActiveMask(m.id);
        await new Promise((r) => setTimeout(r, 120));
        const sl = document.getElementById('slMaskBrushSize');
        const lbl = document.getElementById('lblMaskBrushSize');
        const num = document.querySelector('#rowMaskBrush .pval-num');
        sl.value = '42';
        sl.dispatchEvent(new Event('input', { bubbles: true }));
        const during = { size: m.shape.size, label: lbl.textContent, num: num && num.value };
        sl.dispatchEvent(new Event('change', { bubbles: true }));
        return { during };
    })()`);
    check(brushUi.during.size === 42 && brushUi.during.label === '42'
          && brushUi.during.num === '42',
        '笔刷大小滑块：标签和数字框跟着滑块更新（不再停在旧值）',
        JSON.stringify(brushUi.during));

    // ── 5.2 滑块 input 期只烘低分辨率，松手才补全分辨率（大图不卡）──
    const bakeLevel = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.resetGrade();
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 150));
        const m = A.activeMask(im);
        m.p.exp = 1;
        A.commitMaskShape('live');
        const live = { low: !!im._grade.low, full: !!im._grade.canvas };
        A.commitMaskShape('full');
        const done = { low: !!im._grade.low, full: !!im._grade.canvas };
        return { live, done };
    })()`);
    // 注意 done.low 期望为 true：full 烘好后**保留** low 那张 1600px 的图。
    // 以前 rebuildGrade('full') 会把 low 清掉，但 low 才 7MB（full 是 96MB），
    // 留着它下次拖动滑块能立刻复用，不用重新烘一张。full/low 各记各的 key，
    // 不会串味（见 app-grade.js 的 fullKey / lowKey）。
    check(bakeLevel.live.low && !bakeLevel.live.full
          && bakeLevel.done.full && bakeLevel.done.low,
        '蒙版滑块 input 期低分辨率预览、松手补全分辨率（low 保留供下次复用）',
        JSON.stringify(bakeLevel));

    // ── 6. 参数分流：选中蒙版时 9 档改蒙版，点「全局」改整图 ──
    const route = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 120));
        A.setGrade({ exp: 2.5, sat: 20 });   // 曝光是 EV：2.5 = +2.5 档
        const act = A.activeMask(im);
        const onMask = { exp: act.p.exp, sat: act.p.sat, gExp: im.grade.exp, gSat: im.grade.sat };
        A.setActiveMask('');
        await new Promise((r) => setTimeout(r, 120));
        A.setGrade({ exp: 1.2 });
        return { onMask, global: { exp: im.grade.exp, maskExp: act.p.exp } };
    })()`);
    check(route.onMask.exp === 2.5 && route.onMask.sat === 20 && route.onMask.gExp === 0 && route.onMask.gSat === 0,
        '选中蒙版时 9 档滑块只改蒙版参数，不动全局', JSON.stringify(route.onMask));
    check(route.global.exp === 1.2 && route.global.maskExp === 2.5,
        '选中「全局」后 9 档改整图，蒙版参数保持不动', JSON.stringify(route.global));
    // 标题徽章：选中蒙版时显示「编辑蒙版」，避免误以为在调整张图
    const badge = await exec(`(() => {
        const A = window.App, im = A.image;
        const title = document.querySelector('#grpGrade .pg-title');
        const read = () => getComputedStyle(title, '::after').content;
        A.setActiveMask(im.grade.masks[0].id);
        const onMask = { text: read(), cls: document.getElementById('grpGrade').className };
        A.setActiveMask('');
        const onGlobal = { text: read(), cls: document.getElementById('grpGrade').className };
        return { onMask, onGlobal };
    })()`);
    check(/编辑蒙版/.test(badge.onMask.text) && /已调整/.test(badge.onGlobal.text),
        '调色组标题徽章随目标切换：编辑蒙版 / 已调整', JSON.stringify(badge));

    // ── 7. 烘焙：只有蒙版内像素变化 ──
    const bakeMask = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400);
        im.w = 600; im.h = 400; im._gradeCache = null;
        A.resetGrade();
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 120));
        const m = A.activeMask(im);
        m.shape.x1 = 0.5; m.shape.y1 = 0.0; m.shape.x2 = 0.5; m.shape.y2 = 0.35;
        m.feather = 0;
        A.setGrade({ exp: 80 }, { full: true });
        await new Promise((r) => setTimeout(r, 350));
        const src = window.photoSrcOf(im);
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0);
        const at = (y) => g.getImageData(300, y, 1, 1).data[0];
        return { top: at(10), bot: at(380), isCanvas: src !== im.el };
    })()`);
    check(bakeMask.isCanvas && bakeMask.top <= 130 && bakeMask.bot > 160,
        '烘焙结果：渐变区外像素不动、区内提亮', JSON.stringify(bakeMask));

    // ── 8. 多蒙版叠加：两块不同参数各管一片 ──
    const multi = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.resetGrade();
        const el = await window.__mkGray(600, 400);
        im.el = el; im.w = 600; im.h = 400; im._gradeCache = null;
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 80));
        let m = A.activeMask(im);
        // 线性蒙版语义：起点侧权重 0、终点侧 255，线段外按端点钳制。
        // 要「只作用上半部」= 从 y=0.3（透明）拖到 y=0（全权重）
        m.shape = { x1: 0.5, y1: 0.3, x2: 0.5, y2: 0.0 }; m.feather = 0;
        A.setGrade({ exp: 70 }, { full: true });
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 80));
        m = A.activeMask(im);
        m.shape = { x1: 0.5, y1: 0.7, x2: 0.5, y2: 1.0 }; m.feather = 0;
        A.setGrade({ exp: -60 }, { full: true });
        await new Promise((r) => setTimeout(r, 350));
        const src = window.photoSrcOf(im);
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0);
        const at = (y) => g.getImageData(300, y, 1, 1).data[0];
        return { count: im.grade.masks.length, top: at(10), mid: at(200), bot: at(390) };
    })()`);
    check(multi.count === 2 && multi.top > 160 && Math.abs(multi.mid - 128) < 6 && multi.bot < 100,
        '多蒙版叠加：上片提亮、下片压暗、中间不受影响',
        JSON.stringify(multi));

    // ── 9. 画布叠加层：尺寸跟随画布，涂抹真的写进笔迹 ──
    const overlay = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.resetGrade();
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 500));
        A.addMask('brush');
        await new Promise((r) => setTimeout(r, 200));
        const ov = document.getElementById('maskOverlay');
        const r = ov.getBoundingClientRect();
        const before = A.activeMask(im).shape.strokes.length;
        const ev = (type, x, y, extra) => ov.dispatchEvent(new PointerEvent(type, Object.assign({
            clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0
        }, extra || {})));
        const cx = r.left + r.width * 0.35, cy = r.top + r.height * 0.4;
        ev('pointerdown', cx, cy);
        ev('pointermove', cx + 12, cy + 6);
        ev('pointermove', cx + 24, cy + 10);
        ev('pointerup', cx + 24, cy + 10);
        await new Promise((r2) => setTimeout(r2, 300));
        const strokes = A.activeMask(im).shape.strokes;
        return {
            active: ov.classList.contains('active'),
            geo: { w: ov.style.width, h: ov.style.height, cv: A.dom.canvas.style.width },
            before, after: strokes.length,
            pts: strokes[0] ? strokes[0].pts.length : 0,
            rect: !!A._photoRect
        };
    })()`);
    check(overlay.active && overlay.geo.w === overlay.geo.cv,
        '蒙版叠加层显示且尺寸跟随画布', JSON.stringify(overlay.geo));
    check(overlay.rect && overlay.before === 0 && overlay.after === 1 && overlay.pts >= 3,
        '在叠加层上涂抹会写入笔迹（按下+两次移动）', JSON.stringify(overlay));
    // ── 9.5 大图（长边被缩到 1800）时，蒙版范围必须与照片严丝合缝 ──
    // 真实照片 4000×3000 会走 uiScale 降采样；漏乘这个比例，蒙版会被画成错位的小矩形。
    const bigAlign = await exec(`(async () => {
        const A = window.App, im = A.image;
        const el = await window.__mkGray(4000, 3000);
        im.el = el; im.w = 4000; im.h = 3000; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 700));
        // 用亮度蒙版：均匀灰图上 lo=0/hi=100 → 权重铺满整幅，范围框应严格等于照片矩形
        A.addMask('lum');
        await new Promise((r) => setTimeout(r, 250));
        const m = A.activeMask(im);
        m.shape = { lo: 0, hi: 100 }; m.inv = 0; m.feather = 20; m.density = 100;
        A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 200));
        const ov = document.getElementById('maskOverlay');
        const g = ov.getContext('2d');
        const d = g.getImageData(0, 0, ov.width, ov.height).data;
        let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
        for (let y = 0; y < ov.height; y++) {
            for (let x = 0; x < ov.width; x++) {
                const i = (y * ov.width + x) * 4;
                if (d[i + 3] > 24 && d[i + 1] > d[i] + 20) {
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                }
            }
        }
        const pr = A._photoRect;
        // 期望值不依赖实现里的公式：直接按「照片矩形占画布基准的比例 × 叠加层像素」算，
        // 这样无论内部用 canvasScale×zoom×dpr 还是别的方式，只要画面贴合就通过。
        const base = A._baseSize ? A._baseSize() : { w: A._canvasBaseW, h: A._canvasBaseH };
        const k = ov.width / Math.max(1, base.w);
        const exp = { x: pr.x * k, y: pr.y * k, w: pr.w * k, h: pr.h * k };
        // 指针换算往返：照片中心 → 归一化坐标应接近 0.5/0.5
        const r = ov.getBoundingClientRect();
        const mid = A._maskPoint({ clientX: r.left + (exp.x + exp.w / 2) / ov.width * r.width,
                                   clientY: r.top + (exp.y + exp.h / 2) / ov.height * r.height });
        return {
            canvasScale: +(A._canvasScale || 1).toFixed(3),
            bbox: { x0: minX, x1: maxX, y0: minY, y1: maxY },
            exp: { x0: Math.round(exp.x), x1: Math.round(exp.x + exp.w), y0: Math.round(exp.y), y1: Math.round(exp.y + exp.h) },
            mid,
            sizes: {
                zoom: +(A.zoom || 0).toFixed(4), dpr: Math.min(2, window.devicePixelRatio || 1),
                ovW: ov.width, ovH: ov.height, ovCssW: ov.style.width, ovCssH: ov.style.height,
                cvCssW: A.dom.canvas.style.width, cvCssH: A.dom.canvas.style.height,
                logW: A.dom.canvas._logW, logH: A.dom.canvas._logH,
                pr
            }
        };
    })()`);
    const bb = bigAlign.bbox, ee = bigAlign.exp;
    const near = (a, b, tol) => Math.abs(a - b) <= (tol || 4);
    check(bigAlign.canvasScale < 0.99
          && near(bb.x0, ee.x0) && near(bb.x1, ee.x1) && near(bb.y0, ee.y0) && near(bb.y1, ee.y1)
          && near(bigAlign.mid.x, 0.5, 0.02) && near(bigAlign.mid.y, 0.5, 0.02),
        '大图降采样后蒙版范围与照片矩形对齐（叠加层不再错位成小矩形）',
        JSON.stringify(bigAlign));

    // ── 9.6 单击不破坏蒙版；拖线整体平移；空白处拖出新渐变 ──
    const gesture = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 250));
        const m = A.activeMask(im);
        m.shape = { x1: 0.5, y1: 0.3, x2: 0.5, y2: 0.7 }; m.feather = 40;
        A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 200));

        const ov = document.getElementById('maskOverlay');
        const r = ov.getBoundingClientRect();
        const P = (nx, ny) => [r.left + nx * r.width, r.top + ny * r.height];
        const ev = (type, x, y) => ov.dispatchEvent(new PointerEvent(type, {
            clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0
        }));
        const shape = () => Object.assign({}, m.shape);

        // ① 在远离线的空白处单击（不拖）——位置必须原样
        const before = shape();
        let p = P(0.15, 0.12);
        ev('pointerdown', p[0], p[1]);
        ev('pointerup', p[0], p[1]);
        await new Promise((r2) => setTimeout(r2, 150));
        const afterClick = shape();

        // ② 抓到线上拖 → 整条线平移，长度不变
        p = P(0.5, 0.5);
        const mid = P(0.5, 0.5), dst = P(0.62, 0.58);
        ev('pointerdown', mid[0], mid[1]);
        ev('pointermove', dst[0], dst[1]);
        ev('pointerup', dst[0], dst[1]);
        await new Promise((r2) => setTimeout(r2, 200));
        const afterMove = shape();

        // ③ 空白处拖出新渐变（起点在按下处）
        const a = P(0.2, 0.2), b = P(0.3, 0.6);
        ev('pointerdown', a[0], a[1]);
        ev('pointermove', b[0], b[1]);
        ev('pointerup', b[0], b[1]);
        await new Promise((r2) => setTimeout(r2, 200));
        const afterNew = shape();

        return { before, afterClick, afterMove, afterNew };
    })()`);
    const sameShape = (a, b) => Math.abs(a.x1 - b.x1) < 1e-6 && Math.abs(a.y1 - b.y1) < 1e-6
        && Math.abs(a.x2 - b.x2) < 1e-6 && Math.abs(a.y2 - b.y2) < 1e-6;
    const gm = gesture.afterMove, gb = gesture.before;
    check(sameShape(gesture.before, gesture.afterClick),
        '蒙版上单击（不拖）不会改动已调好的位置',
        JSON.stringify({ before: gesture.before, after: gesture.afterClick }));
    check(Math.abs((gm.x2 - gm.x1) - (gb.x2 - gb.x1)) < 0.02
          && Math.abs((gm.y2 - gm.y1) - (gb.y2 - gb.y1)) < 0.02
          && Math.abs(gm.x1 - gb.x1) > 0.05,
        '抓到线上拖动 = 整条线平移（长度与方向不变）',
        JSON.stringify({ before: gesture.before, after: gesture.afterMove }));
    check(Math.abs(gesture.afterNew.x1 - 0.2) < 0.03 && Math.abs(gesture.afterNew.y1 - 0.2) < 0.03
          && Math.abs(gesture.afterNew.y2 - 0.6) < 0.03,
        '空白处拖出距离后才重画渐变（起点=按下处、终点=松手处）',
        JSON.stringify(gesture.afterNew));

    // ── 9.7 叠加层：渐变真的有梯度；椭圆拖边缘是等比缩放，不会越拖越小 ──
    const overlayShape = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));

        // 渐变：沿渐变轴采样叠加层 alpha，应该由 0 单调升到上限
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 200));
        const lm = A.activeMask(im);
        lm.shape = { x1: 0.5, y1: 0.1, x2: 0.5, y2: 0.9 };
        lm.feather = 60;
        A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 250));
        const ov = document.getElementById('maskOverlay');
        const g = ov.getContext('2d');
        const samples = [];
        for (let k = 0; k <= 8; k++) {
            const y = Math.round(ov.height * (0.12 + 0.76 * k / 8));
            // 采样点必须避开中间的虚线/手柄（x=0.5 那条），否则读到的是白线 255
            samples.push(g.getImageData(Math.round(ov.width * 0.3), y, 1, 1).data[3]);
        }
        const monotone = samples.every((v, i) => i === 0 || v >= samples[i - 1] - 2);
        const spread = Math.max.apply(null, samples) - Math.min.apply(null, samples);

        // 椭圆：斜着抓边缘连续拖三次（每次都往外一点点），半径应只增不减
        A.addMask('radial');
        await new Promise((r) => setTimeout(r, 200));
        const rm = A.activeMask(im);
        rm.shape = { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25 }; rm.feather = 40;
        A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 250));
        const r = ov.getBoundingClientRect();
        const ev = (t, x, y) => ov.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0 }));
        const sizes = [{ rx: rm.shape.rx, ry: rm.shape.ry }];
        for (let k = 0; k < 3; k++) {
            const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;
            // 抓取点用 _maskPoint 反解到「椭圆边缘 + 2%」，不依赖画布与照片是否等宽
            let ex = cx + r.width * rm.shape.rx, ey = cy + r.height * rm.shape.ry;
            for (let it = 0; it < 3; it++) {
                const p0 = A._maskPoint({ clientX: ex, clientY: ey });
                const rr = Math.hypot((p0.x - rm.shape.cx) / rm.shape.rx, (p0.y - rm.shape.cy) / rm.shape.ry);
                if (Math.abs(rr - 1.02) < 0.03) break;
                const k = 1.02 / Math.max(0.2, rr);
                ex = cx + (ex - cx) * k;
                ey = cy + (ey - cy) * k;
            }
            ev('pointerdown', ex, ey);
            ev('pointermove', ex + 6, ey + 6);
            ev('pointerup', ex + 6, ey + 6);
            await new Promise((r2) => setTimeout(r2, 200));
            sizes.push({ rx: rm.shape.rx, ry: rm.shape.ry });
        }
        return { samples, monotone, spread, sizes };
    })()`);
    check(overlayShape.monotone && overlayShape.spread > 40,
        '渐变蒙版的叠加层是真渐变（沿轴 alpha 单调上升）',
        JSON.stringify(overlayShape.samples));
    const sz = overlayShape.sizes;
    const grew = sz.every((v, i) => i === 0 || v.rx >= sz[i - 1].rx - 1e-6);
    const ratioKept = sz.every((v) => Math.abs(v.rx - v.ry) < 1e-6);
    check(grew && ratioKept && sz[3].rx > sz[0].rx + 0.02,
        '椭圆拖边缘 = 等比缩放（连拖三次逐步变大，rx/ry 保持相等）',
        JSON.stringify(sz));

    // ── 9.8 调完色再点回蒙版，范围必须一模一样 ──
    // 用户报的就是这个：调完色（在蒙版内压暗）后重新选中蒙版，绿色范围变了。
    // 根因是亮度蒙版的取样源用了「已调色的烘焙图」——压暗后原本不达标的像素落进
    // 亮度区间，选区自己长大，越调越漂。取样源必须固定为原图。
    const drift = await exec(`(async () => {
        const A = window.App, im = A.image;
        // 下半用 #a8a8a8（66%）：离 hi=45 足够远，落在羽化区外，
        // 这样才能断言"蒙版外一个像素都不动"（#707070 是 44%，紧贴阈值，本来就有 7% 权重）
        im.el = await window.__mkGray(400, 200, '#202020', '#a8a8a8');
        im.w = 400; im.h = 200; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 700));
        A.addMask('lum');
        await new Promise((r) => setTimeout(r, 250));
        const m = A.activeMask(im);
        m.shape = { lo: 0, hi: 45 }; m.inv = 0; m.feather = 30; m.density = 100;
        A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 300));

        const alpha = (src) => {
            const c = window.QfsMask.render(m, 80, 80, src);
            const g = c.getContext('2d');
            return { top: g.getImageData(40, 8, 1, 1).data[3], bot: g.getImageData(40, 72, 1, 1).data[3] };
        };
        const bbox = () => {
            const ov = document.getElementById('maskOverlay');
            const g = ov.getContext('2d');
            const d = g.getImageData(0, 0, ov.width, ov.height).data;
            let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
            for (let y = 0; y < ov.height; y++) {
                for (let x = 0; x < ov.width; x++) {
                    const i = (y * ov.width + x) * 4;
                    if (d[i + 3] > 24 && d[i + 1] > d[i] + 18) {
                        n++;
                        if (x < minX) minX = x; if (x > maxX) maxX = x;
                        if (y < minY) minY = y; if (y > maxY) maxY = y;
                    }
                }
            }
            return n ? { x0: minX, x1: maxX, y0: minY, y1: maxY, n } : null;
        };
        // 叠加层只表示范围：浓度 20 时这里的绿色 alpha 应与 100 时一致
        const ovAlpha = () => {
            const ov = document.getElementById('maskOverlay');
            const g = ov.getContext('2d');
            const pr = A._photoRect, base = A._baseSize();
            const k = ov.width / Math.max(1, base.w);
            return g.getImageData(Math.round((pr.x + pr.w * 0.5) * k),
                Math.round((pr.y + pr.h * 0.1) * k), 1, 1).data[3];
        };
        const px = (src) => {
            const c = document.createElement('canvas'); c.width = 400; c.height = 200;
            const g = c.getContext('2d'); g.drawImage(src, 0, 0, 400, 200);
            const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3);
            return { top: at(200, 20), bot: at(200, 180) };
        };

        const before = { alpha: alpha(im.el), box: bbox(), ov: ovAlpha(), px: px(window.photoSrcOf(im)) };

        // 选中蒙版状态下压暗（走真实路由：9 档 → mask.p）
        A.setGrade({ exp: -2.5 });
        A.rebuildGrade('full');
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 900));
        const after = {
            alpha: alpha(im.el),
            box: bbox(),
            ov: ovAlpha(),
            px: px(window.photoSrcOf(im)),
            // 旧口径（用烘焙图当源）会漂成什么，作为对照存证
            legacyAlpha: alpha(window.photoSrcOf(im)),
            maskExp: A.activeMask(im).p.exp, globalExp: im.grade.exp
        };

        // 浓度调低：叠加层表示的是「范围」，不该跟着变淡/消失
        m.density = 20; A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 300));
        const lowDens = { box: bbox(), ov: ovAlpha() };
        m.density = 100; A.syncMaskUI();
        return { before, after, lowDens };
    })()`);
    const ab = drift.before.alpha, aa = drift.after.alpha;
    check(drift.before.alpha.top > 200 && drift.before.alpha.bot < 20,
        '亮度蒙版只选暗部（上 255 / 下 0）', JSON.stringify(ab));
    check(Math.abs(aa.top - ab.top) < 6 && Math.abs(aa.bot - ab.bot) < 6
          && drift.after.maskExp === -2.5 && drift.after.globalExp === 0,
        '调完色再点回蒙版：亮度蒙版选区一个像素都不变',
        JSON.stringify({ before: ab, after: aa, legacy: drift.after.legacyAlpha }));
    const bb1 = drift.before.box, bb2 = drift.after.box;
    check(bb1 && bb2 && Math.abs(bb1.x0 - bb2.x0) < 2 && Math.abs(bb1.x1 - bb2.x1) < 2
          && Math.abs(bb1.y0 - bb2.y0) < 2 && Math.abs(bb1.y1 - bb2.y1) < 2,
        '调完色再点回蒙版：叠加层范围包围盒不动（差 <2px）',
        JSON.stringify({ before: bb1, after: bb2 }));
    // 蒙版内变暗、蒙版外（下半）保持原样 —— 这才是用户看到的"范围是否正确"
    check(drift.after.px.top[0] < drift.before.px.top[0] - 8
          && Math.abs(drift.after.px.bot[0] - drift.before.px.bot[0]) <= 3,
        '压暗只落在蒙版内：上半变暗、下半一个像素都没动',
        JSON.stringify({ before: drift.before.px, after: drift.after.px }));
    const bd = drift.lowDens.box;
    check(bd && bb2 && Math.abs(bd.n - bb2.n) / Math.max(1, bb2.n) < 0.08,
        '浓度调低不改变叠加层显示的范围（叠层只表示范围，不表示强度）',
        JSON.stringify({ full: bb2 && bb2.n, dens20: bd && bd.n }));
    check(Math.abs(drift.lowDens.ov - drift.before.ov) < 12,
        '浓度调低不改变叠加层绿色强度（亮度/画笔类蒙版也一样）',
        JSON.stringify({ full: drift.before.ov, dens20: drift.lowDens.ov }));

    // ── 9.9 组合模式：添加 / 减去 / 相交 ──
    // 用户的原话是「想修个边缘只能重画」。这一组测的就是「不用重画」：
    // 组头压暗整块、成员只改范围，参数归属始终在组首。
    const combo = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const el = await window.__mkGray(600, 400, '#808080');
        im.el = el; im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        const flush = async () => {
            A._renderDirty = true;
            if (typeof A._drainRenderQueue === 'function') A._drainRenderQueue();
            await new Promise((r) => setTimeout(r, 260));
        };
        const sample = () => {
            const cv = A.dom.canvas;
            const s = document.createElement('canvas'); s.width = 120; s.height = 120;
            const g = s.getContext('2d'); g.drawImage(cv, 0, 0, 120, 120);
            const at = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return (d[0] + d[1] + d[2]) / 3; };
            return {
                topL: +at(20, 24).toFixed(1), topC: +at(60, 36).toFixed(1), topR: +at(100, 24).toFixed(1),
                bot: +at(60, 108).toFixed(1)
            };
        };
        await flush();
        const base = sample();

        // 组头：整幅压暗 -2EV。用亮度蒙版（lo=0/hi=100 → 全幅满权重），
        // 线性渐变两端是 0/1，无论怎么拉都盖不满整幅，会让下面的断言站不住脚。
        A.addMask('lum');
        A.masksOf(im)[0].shape = { lo: 0, hi: 100 };
        A.masksOf(im)[0].feather = 5;
        A.setActiveMask(A.masksOf(im)[0].id);
        A.setGrade({ exp: -2 });
        await flush();
        const darkAll = sample();

        // 减去：中心一块椭圆挖掉（参数仍在组首，挖掉处恢复原亮度）
        A.addMask('radial');
        A.masksOf(im)[1].mode = 'subtract';
        A.masksOf(im)[1].shape = { cx: 0.5, cy: 0.3, rx: 0.14, ry: 0.14 };
        A.masksOf(im)[1].feather = 8;
        A.commitMaskShape('full');
        await flush();
        const withCut = sample();

        // 注意：addMask 会走 setGrade({masks}) → normalizeGrade 重建整个 masks 数组，
        // 之前抓到的对象引用立刻失效。所以后面每次都要重新从 A.masksOf(im) 取。
        A.setActiveMask(A.masksOf(im)[1].id);
        A.setGrade({ exp: -1 });
        await flush();
        const routed = {
            headExp: A.masksOf(im)[0].p.exp,
            cutExp: A.masksOf(im)[1].p.exp,
            paramIsHead: A.paramMask(im).id === A.masksOf(im)[0].id
        };

        // 相交：只保留交集（先把成员改回 add 再测 intersect 与 add 的差别）
        A.masksOf(im)[1].mode = 'add';
        A.masksOf(im)[1].shape = { cx: 0.5, cy: 0.3, rx: 0.30, ry: 0.30 };
        A.commitMaskShape('full');
        await flush();
        const added = sample();
        A.masksOf(im)[1].mode = 'intersect';
        A.masksOf(im)[1].shape = { cx: 0.5, cy: 0.3, rx: 0.30, ry: 0.30 };
        A.commitMaskShape('full');
        await flush();
        const intersect = sample();

        // 分组结构 + 持久化
        const groups = window.QfsMask.maskGroups(A.masksOf(im)).map((g) => ({
            n: g.members.length, modes: g.members.map((m) => m.mode)
        }));
        const saved = JSON.parse(JSON.stringify(A.gradeOf(im).masks));
        const roundTrip = window.QfsMask.sanitizeMasks(saved).map((m) => m.mode);
        A.resetGrade();
        return { base, darkAll, withCut, routed, added, intersect, groups, roundTrip };
    })()`);
    check(combo.darkAll.topC < combo.base.topC - 30 && combo.darkAll.bot < combo.base.bot - 30,
        '组合·组头：整幅压暗生效', `${JSON.stringify(combo.base)} → ${JSON.stringify(combo.darkAll)}`);
    check(combo.withCut.topL < combo.base.topL - 30 && combo.withCut.topC > combo.base.topC - 6
          && combo.withCut.topR < combo.base.topR - 30,
        '组合·减去：中心那块恢复原亮度，两侧仍然压暗（不用重画整个蒙版）',
        JSON.stringify(combo.withCut));
    check(combo.routed.paramIsHead && combo.routed.headExp === -1 && combo.routed.cutExp === 0,
        '组合·参数归属：选中「减去」成员时 9 档写的是组首（整组共用一套参数）',
        JSON.stringify(combo.routed));
    // 差别在**椭圆外**：组头本来就盖满全幅，
    // add 让椭圆外也保持压暗（范围并进来），intersect 只留交集中的椭圆内 → 椭圆外恢复原亮度。
    check(combo.added.topL < combo.base.topL - 30 && combo.intersect.topL > combo.base.topL - 6
          && combo.intersect.topC < combo.base.topC - 30,
        '组合·添加 vs 相交：添加让椭圆外仍压暗，相交只在椭圆内生效（外面恢复原亮度）',
        `add 外${combo.added.topL}/内${combo.added.topC}  intersect 外${combo.intersect.topL}/内${combo.intersect.topC}（原 ${combo.base.topL}）`);
    check(combo.groups.length === 1 && combo.groups[0].n === 2
          && combo.roundTrip.join(',') === 'new,intersect',
        '组合：整组只算一个调整层，组合方式随草稿原样往返',
        JSON.stringify({ groups: combo.groups, roundTrip: combo.roundTrip }));

    // ── 9.10 颜色蒙版：按色相选区 + 画布点选取色 ──
    const colorMask = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        // 上半天蓝、下半天绿
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#7fb2e5'; g.fillRect(0, 0, 600, 200);
        g.fillStyle = '#6aa84f'; g.fillRect(0, 200, 600, 200);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        im.el = el; im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        A.addMask('color');
        const m = A.activeMask(im);
        m.shape = { h: 210, tol: 30, minS: 10 };
        const alpha = (mm) => {
            const a = window.QfsMask.render(mm, 60, 40, im.el);
            const gg = a.getContext('2d');
            return {
                sky: gg.getImageData(30, 5, 1, 1).data[3],
                grass: gg.getImageData(30, 34, 1, 1).data[3]
            };
        };
        const picked = alpha(m);
        // 点画布上的草地取色 → 目标色相应变成绿色那一带
        A.pickMaskColor(0.5, 0.85);
        const afterPick = { h: m.shape.h, minS: m.shape.minS };
        const pickedGreen = alpha(m);
        // 灰图：颜色蒙版不该选中任何东西
        const grayEl = await window.__mkGray(600, 400, '#808080');
        const grayAlpha = (() => {
            const a = window.QfsMask.render(m, 60, 40, grayEl);
            const gg = a.getContext('2d');
            return gg.getImageData(30, 20, 1, 1).data[3];
        })();
        A.resetGrade();
        return { picked, afterPick, pickedGreen, grayAlpha };
    })()`);
    check(colorMask.picked.sky > 200 && colorMask.picked.grass < 20,
        '颜色蒙版：只选天空的蓝（天空 255 / 草地 0）', JSON.stringify(colorMask.picked));
    check(colorMask.afterPick.h > 90 && colorMask.afterPick.h < 150
          && colorMask.pickedGreen.grass > 200 && colorMask.pickedGreen.sky < 40,
        '画布点选取色：点草地后目标色相变绿，选中的区域整体换过去',
        JSON.stringify(colorMask.afterPick) + ' ' + JSON.stringify(colorMask.pickedGreen));
    check(colorMask.grayAlpha === 0,
        '颜色蒙版不选中中性灰（灰没有色相，不该被任何色带带走）', String(colorMask.grayAlpha));

    // ── 9.9 大图（uiScale < 1）上抓渐变线身：命中测试必须用基准坐标 ──
    // 叠加层是按 base 坐标画的，命中却用 _logW（= base × uiScale）算，
    // 4000px 照片上会偏到 2 倍开外 —— 看起来就是“线抓不住/一拖就重画”。
    const bigLine = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(4000, 3000); im.w = 4000; im.h = 3000; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 700));
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 250));
        const m = A.activeMask(im);
        m.shape = { x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.8 }; m.feather = 40;
        A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 250));

        const ov = document.getElementById('maskOverlay');
        const r = ov.getBoundingClientRect();
        const pr = A._photoRect, base = A._baseSize();
        const toClient = (nx, ny) => ({
            x: r.left + ((pr.x + nx * pr.w) / base.w) * r.width,
            y: r.top + ((pr.y + ny * pr.h) / base.h) * r.height
        });
        const ev = (t, x, y) => ov.dispatchEvent(new PointerEvent(t, {
            clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0
        }));
        const before = Object.assign({}, m.shape);
        const p = toClient(0.5, 0.5), q = toClient(0.6, 0.55);
        ev('pointerdown', p.x, p.y);
        ev('pointermove', q.x, q.y);
        ev('pointerup', q.x, q.y);
        await new Promise((r2) => setTimeout(r2, 250));
        return { before, after: Object.assign({}, m.shape), base, logW: A.dom.canvas._logW, pr };
    })()`);
    const bl = bigLine.after, bl0 = bigLine.before;
    check(Math.abs(bl.x1 - (bl0.x1 + 0.1)) < 0.03 && Math.abs(bl.y1 - (bl0.y1 + 0.05)) < 0.03
          && Math.abs((bl.x2 - bl.x1) - (bl0.x2 - bl0.x1)) < 0.02,
        '大图上抓渐变线身 = 整条线平移（命中按基准坐标，不再重画）',
        JSON.stringify(bigLine));

    // ── 9.10 空白处拖出新椭圆后继续拖：drag 状态必须带半径基准 ──
    // pending 升级成 size 拖动时若忘了写 rx0/ry0/d0，第二次 pointermove 会算出 NaN。
    const newRadial = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        A.addMask('radial');
        await new Promise((r) => setTimeout(r, 200));
        const m = A.activeMask(im);
        m.shape = { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 }; m.feather = 40;
        A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 250));
        const ov = document.getElementById('maskOverlay');
        const r = ov.getBoundingClientRect();
        const P = (nx, ny) => [r.left + nx * r.width, r.top + ny * r.height];
        const ev = (t, x, y) => ov.dispatchEvent(new PointerEvent(t, {
            clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0
        }));
        const a = P(0.1, 0.1), b = P(0.2, 0.2), c = P(0.3, 0.3);
        ev('pointerdown', a[0], a[1]);
        ev('pointermove', b[0], b[1]);
        ev('pointermove', c[0], c[1]);
        ev('pointerup', c[0], c[1]);
        await new Promise((r2) => setTimeout(r2, 250));
        return { shape: Object.assign({}, m.shape) };
    })()`);
    const nr = newRadial.shape;
    check(Number.isFinite(nr.rx) && Number.isFinite(nr.ry)
          && nr.rx > 0.05 && nr.ry > 0.05
          && Math.abs(nr.cx - 0.1) < 0.03 && Math.abs(nr.cy - 0.1) < 0.03,
        '空白处拖出新椭圆后继续拖：半径保持有效（不再变成 NaN）',
        JSON.stringify(newRadial));

    // ── 9.11 椭圆反相：中心不选、四周全选 ──
    // fillRadial 原先只填椭圆内部；反相时椭圆外仍是透明，等于“反相只反了里面”。
    const radialInv = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        A.addMask('radial');
        await new Promise((r) => setTimeout(r, 200));
        const m = A.activeMask(im);
        m.shape = { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3 }; m.feather = 30; m.inv = 1;
        A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 250));
        const c = window.QfsMask.render(m, 80, 80, im.el);
        const g = c.getContext('2d');
        const at = (x, y) => g.getImageData(x, y, 1, 1).data[3];
        const alpha = { center: at(40, 40), corner: at(2, 2) };

        const ov = document.getElementById('maskOverlay');
        const og = ov.getContext('2d');
        const pr = A._photoRect, base = A._baseSize();
        const k = ov.width / Math.max(1, base.w);
        const ovAt = (nx, ny) => og.getImageData(
            Math.round((pr.x + nx * pr.w) * k),
            Math.round((pr.y + ny * pr.h) * k), 1, 1).data[3];
        const overlay = { inside: ovAt(0.5, 0.35), outside: ovAt(0.05, 0.05) };
        return { alpha, overlay };
    })()`);
    check(radialInv.alpha.center < 40 && radialInv.alpha.corner > 200,
        '椭圆反相：中心权重 0、椭圆外权重 255', JSON.stringify(radialInv.alpha));
    check(radialInv.overlay.outside > radialInv.overlay.inside + 40,
        '椭圆反相的叠加层：椭圆外染色、内部透明', JSON.stringify(radialInv.overlay));

    // ── 9.13 羽化内圈：遮罩渐变 / 叠加层染色 / 内圈线共用同一个 inner ──
    // 以前只有一条外圈虚线，看着像「框内全作用」，调羽化时框还一动不动。
    // 这里用 spy 抓叠加层真正的 ellipse 调用，直接验证内圈线画在 rx*inner 上。
    const innerRing = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade(); A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        A.addMask('radial');
        await new Promise((r) => setTimeout(r, 200));
        const m = A.activeMask(im);
        m.shape = { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.4, rot: 0 };
        m.inv = 0; m.density = 100;
        const innerOf = (f) => { m.feather = f; return window.QfsMask.radialInner(m); };
        const i0 = innerOf(0), i50 = innerOf(50), i100 = innerOf(100);
        // 遮罩权重：inner 内满权重、inner..1 衰减、外面归零
        m.feather = 50;
        const c = window.QfsMask.render(m, 200, 200, im.el);
        const g = c.getContext('2d');
        const rad = 0.4 * 200;
        const atR = (r) => g.getImageData(Math.round(100 + r * rad), 100, 1, 1).data[3];
        const alpha = { r25: atR(0.25), r50: atR(0.5), r75: atR(0.75), r100: atR(1.0), r110: atR(1.1) };
        // 叠加层真的画了第二条椭圆，且半径 = 外圈 * inner
        const proto = CanvasRenderingContext2D.prototype;
        const orig = proto.ellipse;
        const calls = [];
        proto.ellipse = function (x, y, rx, ry, rot, a, b, cc) {
            calls.push([rx, ry, rot]);
            return orig.call(this, x, y, rx, ry, rot, a, b, cc);
        };
        m.feather = 50; A.drawMaskOverlay(); const at50 = calls.slice();
        calls.length = 0;
        m.feather = 0; A.drawMaskOverlay(); const at0 = calls.slice();
        calls.length = 0;
        m.feather = 100; A.drawMaskOverlay(); const at100 = calls.slice();
        proto.ellipse = orig;
        m.feather = 50; A.drawMaskOverlay();
        return { i0, i50, i100, alpha, at0, at50, at100 };
    })()`);
    check(Math.abs(innerRing.i0 - 0.999) < 0.01 && Math.abs(innerRing.i50 - 0.5) < 1e-6
          && innerRing.i100 === 0,
        '羽化 inner 半径：0→近 1、50→0.5、100→0', JSON.stringify([innerRing.i0, innerRing.i50, innerRing.i100]));
    const ia = innerRing.alpha;
    check(ia.r25 > 240 && ia.r50 > 240 && ia.r75 > 60 && ia.r75 < 200 && ia.r100 < 20 && ia.r110 < 20,
        '遮罩渐变起点与 inner 一致（内圈满权重、外圈归零）', JSON.stringify(ia));
    const r50 = innerRing.at50, r0 = innerRing.at0, r100 = innerRing.at100;
    const outerX = r50.length ? r50[0][0] : 0, outerY = r50.length ? r50[0][1] : 0;
    // 不依赖 ellipse 的调用顺序（clip 和外圈轮廓各画一次）：找半径正好是外圈一半的那次
    const hasHalfRing = (list) => list.some((c) => Math.abs(c[0] - outerX * 0.5) < 0.6
        && Math.abs(c[1] - outerY * 0.5) < 0.6);
    check(hasHalfRing(r50) && !hasHalfRing(r0) && !hasHalfRing(r100),
        '叠加层画了内圈细点线，半径正好是外圈×inner；羽化 0（硬边）/100（全软）时自动隐藏',
        JSON.stringify({ f50: r50, f0: r0, f100: r100 }));

    // ── 9.14 Shift 约束：正圆 / 等比联动两轴 / 不按 Shift 仍只改单轴 ──
    const shiftDrag = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade(); A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        A.addMask('radial');
        await new Promise((r) => setTimeout(r, 200));
        const m = A.activeMask(im), pr = A._photoRect;
        const ov = document.getElementById('maskOverlay');
        const r = ov.getBoundingClientRect();
        const P = (nx, ny) => [r.left + nx * r.width, r.top + ny * r.height];
        const ev = (t, x, y, shift) => ov.dispatchEvent(new PointerEvent(t, {
            clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, shiftKey: !!shift
        }));
        const reset = () => { m.shape = { cx: .5, cy: .5, rx: .3, ry: .2, rot: 0 }; m.feather = 40; };
        const pxEq = (s) => Math.abs(s.rx * pr.w - s.ry * pr.h);

        // ① 空白处拖出新椭圆 + Shift → 屏幕正圆（rx/ry 归一化值不相等才对）
        reset(); A.drawMaskOverlay();
        const a = P(0.15, 0.15), b = P(0.35, 0.26);
        ev('pointerdown', a[0], a[1], true);
        ev('pointermove', b[0], b[1], true);
        ev('pointerup', b[0], b[1], true);
        await new Promise((r2) => setTimeout(r2, 150));
        const s1 = Object.assign({}, m.shape), roundGap = pxEq(s1);

        // ② 拖 +X 轴手柄 + Shift → 另一轴按同一倍率联动
        reset(); A.drawMaskOverlay();
        const h0 = P(0.8, 0.5), h1 = P(0.9, 0.5);
        ev('pointerdown', h0[0], h0[1], true);
        ev('pointermove', h1[0], h1[1], true);
        ev('pointerup', h1[0], h1[1], true);
        await new Promise((r2) => setTimeout(r2, 150));
        const s2 = Object.assign({}, m.shape);
        const ratioKept = Math.abs((s2.ry * pr.h / (s2.rx * pr.w)) - (0.2 * pr.h / (0.3 * pr.w))) < 0.02;

        // ③ 同样的拖动不按 Shift → 只改长轴，短轴原封不动（回归保护）
        reset(); A.drawMaskOverlay();
        ev('pointerdown', h0[0], h0[1], false);
        ev('pointermove', h1[0], h1[1], false);
        ev('pointerup', h1[0], h1[1], false);
        await new Promise((r2) => setTimeout(r2, 150));
        const s3 = Object.assign({}, m.shape);

        // ④ 拖边缘 + Shift → 锁成正圆
        reset(); A.drawMaskOverlay();
        const e0 = P(0.5 + 0.3 * 0.72, 0.5 + 0.2 * 0.72);
        const e1 = P(0.5 + 0.3 * 0.95, 0.5 + 0.2 * 0.95);
        ev('pointerdown', e0[0], e0[1], true);
        ev('pointermove', e1[0], e1[1], true);
        ev('pointerup', e1[0], e1[1], true);
        await new Promise((r2) => setTimeout(r2, 150));
        const s4 = Object.assign({}, m.shape), roundGap4 = pxEq(s4);
        return { s1, roundGap, s2, ratioKept, s3, s4, roundGap4, ratio: pr.w / pr.h };
    })()`);
    check(shiftDrag.roundGap < 1.5 && Math.abs(shiftDrag.s1.rx - shiftDrag.s1.ry) > 0.02,
        'Shift 拖出新椭圆 = 屏幕正圆（像素半径相等，归一化值本就不等）',
        JSON.stringify({ s1: shiftDrag.s1, gap: shiftDrag.roundGap, ratio: shiftDrag.ratio }));
    check(shiftDrag.ratioKept && shiftDrag.s2.rx > 0.34 && shiftDrag.s2.ry > 0.22,
        'Shift 拖轴向手柄 = 两轴等比联动（形状比例不变）', JSON.stringify(shiftDrag.s2));
    check(Math.abs(shiftDrag.s3.ry - 0.2) < 0.005 && shiftDrag.s3.rx > 0.34,
        '不按 Shift 拖轴向手柄：只改被拖的那根轴（行为不变）', JSON.stringify(shiftDrag.s3));
    check(shiftDrag.roundGap4 < 1.5,
        'Shift 拖边缘 = 等比缩放后锁正圆', JSON.stringify({ s4: shiftDrag.s4, gap: shiftDrag.roundGap4 }));

    // ── 9.12 离开调色页签要退出蒙版编辑：编辑层不能继续挡 Logo/文字的画布操作 ──
    const tabLeave = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 200));
        const ov = document.getElementById('maskOverlay');
        const onGrade = { active: ov.classList.contains('active'), id: A._activeMaskId };
        A.switchTab('logo');
        await new Promise((r) => setTimeout(r, 100));
        const onLogo = { active: ov.classList.contains('active'), id: A._activeMaskId,
            pe: getComputedStyle(ov).pointerEvents };
        A.switchTab('grade');
        return { onGrade, onLogo };
    })()`);
    check(tabLeave.onGrade.active && tabLeave.onGrade.id
          && !tabLeave.onLogo.active && !tabLeave.onLogo.id
          && tabLeave.onLogo.pe === 'none',
        '切到其它页签自动退出蒙版编辑（编辑层不再挡画布）',
        JSON.stringify(tabLeave));

    // ── 9.13 相框/卡片样式如今会上报照片矩形(drawImage 劫持,engine-styles):蒙版可画布定位 ──
    // 旧断言"明确提示无法定位"属于劫持缺失的年代;劫持到位后这里反过来验证定位真的可用。
    const unsupportedStyle = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate();
        A.template.photoFrameStyle = 'CARD_3D';
        A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 700));
        const before = { pr: A._photoRect, supported: A.maskPositionSupported() };
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 250));
        const ov = document.getElementById('maskOverlay');
        const tip = document.getElementById('maskEditTip');
        const out = {
            before, active: ov.classList.contains('active'), mask: !!A.activeMask(im),
            tip: tip.textContent, status: A.statusMsg
        };
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade(); A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 500));
        return out;
    })()`);
    check(!!unsupportedStyle.before.pr && unsupportedStyle.before.supported
          && unsupportedStyle.active && unsupportedStyle.mask
          && /线的一侧/.test(unsupportedStyle.tip) && /混色器/.test(unsupportedStyle.tip),
        '相框样式添加蒙版可画布定位（照片矩形已上报，提示含渐变语义说明）',
        JSON.stringify(unsupportedStyle));

    // ── 9.14 眼睛开关：停用后不参与烘焙、叠加层收掉，参数/形状保留 ──
    const maskEye = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 200));
        const m = A.activeMask(im);
        m.shape = { x1: 0.5, y1: 0.3, x2: 0.5, y2: 0.0 };
        m.feather = 0;
        A.setGrade({ exp: 2 }, { full: true });
        await new Promise((r) => setTimeout(r, 350));
        const sampleTop = () => {
            const c = document.createElement('canvas'); c.width = 600; c.height = 400;
            const g = c.getContext('2d'); g.drawImage(window.photoSrcOf(im), 0, 0);
            return g.getImageData(300, 10, 1, 1).data[0];
        };
        const on = { top: sampleTop(), neutral: A.isNeutralGrade(im.grade) };
        const row = document.querySelector('#maskList .mask-row.active');
        const eyeBtn = row && row.querySelector('[data-mask-toggle]');
        const ov = document.getElementById('maskOverlay');
        const globalEye = document.querySelector('#maskList .mask-row[data-mask-id=""] [data-mask-toggle]');
        if (eyeBtn) eyeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 350));
        const off = {
            top: sampleTop(), on: A.masksOf(im)[0].on, neutral: A.isNeutralGrade(im.grade),
            overlay: ov.classList.contains('active'), rowOff: !!document.querySelector('#maskList .mask-row.off'),
            status: A.statusMsg, hasEye: !!eyeBtn, globalHasEye: !!globalEye,
            persisted: JSON.parse(JSON.stringify(im.grade)).masks[0].on
        };
        A.toggleMask(A.masksOf(im)[0].id);
        await new Promise((r) => setTimeout(r, 350));
        const back = {
            top: sampleTop(), on: A.masksOf(im)[0].on,
            overlay: ov.classList.contains('active'), status: A.statusMsg
        };
        return { on, off, back, shape: Object.assign({}, A.masksOf(im)[0].shape), exp: A.masksOf(im)[0].p.exp };
    })()`);
    check(maskEye.off.hasEye && !maskEye.off.globalHasEye && maskEye.on.top > 160,
        '眼睛开关：每个蒙版有独立开关，全局行没有', JSON.stringify(maskEye.off));
    check(maskEye.off.on === 0 && maskEye.off.top < 140 && maskEye.off.neutral
          && !maskEye.off.overlay && maskEye.off.rowOff && maskEye.off.persisted === 0,
        '停用蒙版：烘焙回到原图、叠加层收掉、列表显示 off、状态随草稿保存',
        JSON.stringify(maskEye.off));
    check(maskEye.back.on === 1 && maskEye.back.top > 160 && maskEye.back.overlay
          && maskEye.exp === 2 && Math.abs(maskEye.shape.y1 - 0.3) < 1e-6,
        '重新启用：参数和形状原样恢复、叠加层回来',
        JSON.stringify(maskEye.back) + ' ' + JSON.stringify(maskEye.shape));

    // ── 9.15 复制 / 粘贴蒙版：跨照片保留形状 + 组首参数，独立成 new ──
    const maskClip = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.resetGrade();
        A.addMask('radial');
        await new Promise((r) => setTimeout(r, 160));
        const m = A.activeMask(im);
        m.shape = { cx: 0.3, cy: 0.6, rx: 0.2, ry: 0.25, rot: 37 };
        m.feather = 23; m.inv = 1;
        A.setGrade({ exp: 1.5, temp: 20 });
        A.syncMaskUI();
        const copied = A.copyMask();
        const clip = {
            type: A._maskClip.type, shape: JSON.parse(JSON.stringify(A._maskClip.shape)),
            p: JSON.parse(JSON.stringify(A._maskClip.p)), mode: A._maskClip.mode,
            srcId: A._maskClip.anchorId, status: A.statusMsg
        };
        const im2 = { el: await window.__mkGray(300, 200, '#a0a0a0'), name: 'm2', path: null,
            w: 300, h: 200, exif: {}, customSettings: null, grade: null };
        A.images = [im, im2]; A.image = im2; A.currentIdx = 1; A._activeMaskId = null;
        A.template = A.defaultTemplate(); A.setTpl(im2, A.template);
        A.syncGradeUI();
        const pasted = A.pasteMask();
        await new Promise((r) => setTimeout(r, 120));
        const m2 = A.masksOf(im2)[0];
        const cross = {
            pasted, count: A.masksOf(im2).length, status: A.statusMsg,
            type: m2 && m2.type, mode: m2 && m2.mode, on: m2 && m2.on,
            shape: m2 && m2.shape, p: m2 && { exp: m2.p.exp, temp: m2.p.temp },
            freshId: !!(m2 && m2.id !== clip.srcId),
            sameShape: !!(m2 && JSON.stringify(m2.shape) === JSON.stringify(clip.shape))
        };

        // 同一张照片里复制组合成员：粘贴必须保留组合方式并插在原成员之后
        A.setActiveMask(m2.id);
        A.addMask('radial');
        await new Promise((r) => setTimeout(r, 160));
        const member = A.activeMask(im2);
        member.mode = 'add';
        member.shape = { cx: 0.7, cy: 0.4, rx: 0.1, ry: 0.12, rot: 0 };
        A.setGrade({ masks: A.masksOf(im2) });
        A.setActiveMask(member.id);
        A.copyMask();
        const beforeCombo = A.masksOf(im2).length;
        A.pasteMask();
        const list = A.masksOf(im2);
        const anchor = list.findIndex((x) => x.id === member.id);
        const combo = {
            before: beforeCombo, after: list.length,
            mode: list[anchor + 1] && list[anchor + 1].mode,
            insertedAfter: anchor >= 0 && list[anchor + 1] && list[anchor + 1].id !== member.id,
            status: A.statusMsg
        };

        // 上限：已有 12 个时拒绝粘贴
        const twelve = [];
        for (let i = 0; i < 12; i++) {
            const nm = window.QfsMask.newMask('linear');
            nm.id = 'lim' + i;
            twelve.push(nm);
        }
        im2.grade.masks = twelve;
        const limited = A.pasteMask();
        const limitStatus = A.statusMsg;

        // 切回原图，后面的测试从干净状态开始
        A.images = [im]; A.image = im; A.currentIdx = 0; A._activeMaskId = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade(); A.syncGradeUI(); A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 300));
        return { copied, clip, cross, combo, limited, limitStatus };
    })()`);
    check(maskClip.copied && maskClip.clip.type === 'radial' && maskClip.clip.mode === 'new'
          && maskClip.clip.srcId && /已复制蒙版/.test(maskClip.clip.status),
        '复制蒙版：记录类型/形状/组首参数', JSON.stringify(maskClip.clip));
    check(maskClip.cross.pasted && maskClip.cross.count === 1 && maskClip.cross.freshId
          && maskClip.cross.type === 'radial' && maskClip.cross.mode === 'new'
          && maskClip.cross.on === 1 && maskClip.cross.sameShape
          && maskClip.cross.p.exp === 1.5 && maskClip.cross.p.temp === 20
          && /已粘贴蒙版（独立调整层）/.test(maskClip.cross.status),
        '粘贴到另一张照片：形状/参数原样、独立成组、id 重新生成',
        JSON.stringify(maskClip.cross));
    check(maskClip.combo.after === maskClip.combo.before + 1
          && maskClip.combo.mode === 'add' && maskClip.combo.insertedAfter
          && /已粘贴蒙版（并入原组合）/.test(maskClip.combo.status),
        '同一张照片复制组合成员：粘贴保留组合方式并插在原成员后',
        JSON.stringify(maskClip.combo));
    check(maskClip.limited === false && /最多 12 个蒙版/.test(maskClip.limitStatus),
        '12 个蒙版上限：粘贴被拒绝并说明原因', maskClip.limitStatus);

    // ── 9.16 画笔光标圈：尺寸按照片显示短边换算，Alt 提示擦除，切换/停用即隐藏 ──
    const brushCursor = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        A.addMask('brush');
        await new Promise((r) => setTimeout(r, 200));
        const m = A.activeMask(im);
        m.shape.size = 40;
        A.syncMaskUI();
        const cur = document.getElementById('maskBrushCursor');
        const initialHidden = cur.hidden;
        const ov = document.getElementById('maskOverlay');
        const r = ov.getBoundingClientRect();
        const x = r.left + r.width * 0.5, y = r.top + r.height * 0.5;
        const ev = (extra) => ov.dispatchEvent(new PointerEvent('pointermove', Object.assign({
            clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0
        }, extra || {})));
        ev();
        const pr = A._photoRect, base = A._baseSize();
        const pw = pr.w / Math.max(1, base.w) * r.width;
        const ph = pr.h / Math.max(1, base.h) * r.height;
        const expected = Math.max(4, 0.4 * Math.min(pw, ph));
        const stage = document.querySelector('.stage');
        const sr = stage.getBoundingClientRect();
        const style = {
            hidden: cur.hidden,
            w: parseFloat(cur.style.width), h: parseFloat(cur.style.height),
            centerX: parseFloat(cur.style.left) + parseFloat(cur.style.width) / 2,
            centerY: parseFloat(cur.style.top) + parseFloat(cur.style.height) / 2
        };
        const wantX = x - sr.left - (stage.clientLeft || 0);
        const wantY = y - sr.top - (stage.clientTop || 0);
        ev({ altKey: true });
        const erase = cur.classList.contains('erase');
        A.addMask('linear');
        await new Promise((r2) => setTimeout(r2, 160));
        const hiddenOnLinear = cur.hidden;
        A.setActiveMask(m.id);
        ev();
        const shownAgain = !cur.hidden;
        A.toggleMask(m.id);
        await new Promise((r2) => setTimeout(r2, 160));
        const hiddenWhenOff = cur.hidden;
        return { initialHidden, style, expected, wantX, wantY, erase, hiddenOnLinear, shownAgain, hiddenWhenOff };
    })()`);
    check(brushCursor.initialHidden, '画笔光圈：未把指针移到画布上时不显示', JSON.stringify(brushCursor));
    check(!brushCursor.style.hidden
          && Math.abs(brushCursor.style.w - brushCursor.expected) < 0.6
          && Math.abs(brushCursor.style.h - brushCursor.expected) < 0.6
          && Math.abs(brushCursor.style.centerX - brushCursor.wantX) < 0.8
          && Math.abs(brushCursor.style.centerY - brushCursor.wantY) < 0.8,
        '画笔光圈：直径 = 笔刷大小% × 照片显示短边，中心跟随指针',
        JSON.stringify(brushCursor.style) + ' expected=' + brushCursor.expected);
    check(brushCursor.erase && brushCursor.hiddenOnLinear
          && brushCursor.shownAgain && brushCursor.hiddenWhenOff,
        '画笔光圈：Alt 显示擦除色；切类型/停用后隐藏，切回画笔恢复',
        JSON.stringify(brushCursor));

    // ── 10. 持久化 / 中性 / 深拷贝 / 重置 ──
    const persist = await exec(`(async () => {
        const A = window.App, im = A.image;
        im.el = await window.__mkGray(600, 400); im.w = 600; im.h = 400; im._gradeCache = null;
        A.resetGrade();
        A.addMask('linear');
        await new Promise((r) => setTimeout(r, 80));
        A.setGrade({ exp: 2.4 });
        const dirty = !A.isNeutralGrade(im.grade);
        const json = JSON.stringify(im.grade);
        const keeps = json.indexOf('"masks"') >= 0 && json.indexOf('"type":"linear"') >= 0;
        // 批量应用深拷贝
        const el2 = await window.__mkGray(300, 200);
        const im2 = { el: el2, name: 'm2', path: null, w: 300, h: 200, exif: {}, customSettings: null, grade: null };
        A.images = [im, im2];
        A.applyGradeToAll();
        const m1 = im.grade.masks[0], m2 = im2.grade.masks && im2.grade.masks[0];
        const deep = !!(m1 && m2) && m1 !== m2;
        if (m2) m2.p.exp = -2.4;
        const isolated = m1.p.exp === 2.4;
        A.resetGrade();
        const after = A.isNeutralGrade(im.grade) && A.masksOf(im).length === 0;
        A.images = [im]; A.currentIdx = 0;
        return { dirty, keeps, deep, isolated, after };
    })()`);
    check(persist.dirty && persist.keeps, '蒙版随草稿持久化（JSON 可序列化）且计入「已调整」',
        JSON.stringify(persist));
    check(persist.deep && persist.isolated, '「应用到全部」深拷贝蒙版（改一张不串台）',
        JSON.stringify(persist));
    check(persist.after, '重置清空蒙版并回到原图取源');

    console.log('');
    if (failures.length) {
        console.log(`FAILURE  ${failures.length} 项未通过`);
        failures.forEach((f) => console.log('  · ' + f));
        app.exit(1);
    } else {
        console.log('ALL PASS');
        app.exit(0);
    }
}

main().catch((e) => { console.error(e); app.exit(1); });

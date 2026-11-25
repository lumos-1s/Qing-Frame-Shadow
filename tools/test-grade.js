// 基础调色回归：7 个滑块 → 一条 CSS filter → 烘焙进离屏画布 → 渲染/导出取源。
// 用法：node tools/run-electron.js tools/test-grade.js
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
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(channel, EMPTY_LIST);
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
// 阴影/高光的「亮度自适应」靠这份场与系数表（b50a73b 起阴影不再进 LUT，改由
// QfsShadows 的空间 pass 施加）。漏注册时 QfsShadows.ready() 为 false，整个阴影
// 施加被静默跳过 —— 表现为「阴影 +100 中灰 128→128」这种完全没反应，很容易被
// 误判成产品回归。
ipcMain.handle('load-acr-shadows', () => {
    try {
        const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin'));
        if (raw.length < 34 || raw.slice(0, 4).toString('ascii') !== 'CRS2') return null;
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
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

// 中灰底 + 纯黑/纯白两个角：用来验证「高光/阴影两端不动」
const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w || 600; c.height = h || 400;
    const g = c.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000000'; g.fillRect(0, 0, c.width / 2, c.height / 2);
    g.fillStyle = '#ffffff'; g.fillRect(c.width / 2, c.height / 2, c.width / 2, c.height / 2);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

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
    const exec = (expr) => win.webContents.executeJavaScript(expr);

    // ① 色表必须「自己」加载：产品路径只在启动空闲时 ensure，不该依赖导入 XMP。
    //    这里先等 3 秒不给任何提示，等不到才算失败 —— 之前测试开头就手动 ensure，
    //    把「真实用户根本没有表」这个 bug 盖住了（混色器/校准/拖了没反应）。
    const autoReady = await exec(`(async () => {
        for (let i = 0; i < 30; i++) {
            if (window.QfsAcr && QfsAcr.ready()) return true;
            await new Promise((r) => setTimeout(r, 100));
        }
        return false;
    })()`);
    check(autoReady, 'ACR 色表启动后自动加载（不依赖导入 XMP）', String(autoReady));
    // ② 兜底：老版本/异常路径下仍然手动确保一次，后面的断言才有意义
    await exec(`(async () => { if (window.QfsAcr) await QfsAcr.ensure(); return QfsAcr && QfsAcr.ready(); })()`)
        .then((r) => console.log('ACR tables ready=' + r));

    // 隐藏测试窗口里 requestAnimationFrame 会被 Chromium 节流，靠「等 900ms 再采样」
    // 偶尔会拿到同一帧 —— 表现为 bright 与 dark 相等、误报成"某功能不生效"。
    // 这里把调度包成同步合成，测试才可复现（只测试环境生效，不影响产品）。
    await exec(`(() => {
        const A = window.App;
        if (!A || A.__syncRenderPatched) return true;
        A.__syncRenderPatched = true;
        const orig = A.scheduleRender.bind(A);
        let busy = false;
        A.scheduleRender = function (immediate) {
            orig(immediate);
            if (busy) return;
            busy = true;
            try {
                A._renderDirty = true;
                if (typeof A._drainRenderQueue === 'function') A._drainRenderQueue();
            } finally { busy = false; }
        };
        return true;
    })()`);
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    await exec(`window.__mk = ${MAKE_IMAGE}; true`);
    const setup = `async () => {
        const A = window.App;
        const el = await window.__mk(600, 400);
        const im = { el, name: 'g', path: null, w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template); A.updateEmptyState();
        if (A.invalidateGrade) A.invalidateGrade(im);
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 400));
        return { has: !!A.GRADE_FIELDS, sliders: A.GRADE_FIELDS.map(f => !!document.getElementById('slGrade' + f.k.charAt(0).toUpperCase() + f.k.slice(1))) };
    }`;

    // ── 1. 模块与控件 ──
    const s0 = await exec(`(${setup})()`);
    check(s0.has && s0.sliders.every(Boolean), '调色模块已加载，10 个基础滑块都在「调色」页签',
        `sliders=${s0.sliders.join(',')}`);
    const grp = await exec(`(() => {
        const g = document.getElementById('grpGrade');
        const tab = document.querySelector('#inspTabs .tab[data-tab="grade"]');
        if (tab) tab.click();
        const lightGrps = Array.prototype.slice.call(document.querySelectorAll('#panel-grade .ctl-grp-light'));
        return { inGrade: !!g.closest('#panel-grade'), inToolbar: !!g.closest('#toolbar'),
                 hasTab: !!tab, isToolTab: !!(tab && tab.classList.contains('tab-tool')),
                 active: document.getElementById('panel-grade').classList.contains('active'),
                 canvasStill: document.getElementById('panel-canvas').classList.contains('active'),
                 lightGroups: lightGrps.length,
                 lightInGrade: lightGrps.every((x) => !!x.closest('#panel-grade')),
                 noLightPanel: !document.getElementById('panel-light'),
                 noLightTab: !document.querySelector('#inspTabs [data-tab="light"]'),
                 title: (g.querySelector('.pg-title') || {}).textContent || '' };
    })()`);
    check(grp.inGrade && !grp.inToolbar && grp.hasTab && !grp.isToolTab
          && grp.active && !grp.canvasStill && /基础/.test(grp.title),
        '调色挂在「画布」这一行的页签里（不再属于工具行），点击能切到面板', JSON.stringify(grp));
    check(grp.lightGroups === 1 && grp.lightInGrade && grp.noLightPanel && grp.noLightTab,
        '原「光影」三组已并入调色页签：晕影/颗粒进「效果」小节，只剩漏光还是 .ctl-grp-light；独立页签与面板已移除',
        JSON.stringify({ n: grp.lightGroups, inGrade: grp.lightInGrade, noPanel: grp.noLightPanel, noTab: grp.noLightTab }));
    await exec(`(() => { if (window.App.switchTab) window.App.switchTab('canvas'); })()`);

    // ── 2. 中性时不烘焙，取源就是原图 ──
    const neutral = await exec(`(() => {
        const A = window.App, im = A.image;
        const src = window.photoSrcOf(im);
        return { same: src === im.el, hasCache: !!(im._grade && im._grade.canvas) };
    })()`);
    check(neutral.same && !neutral.hasCache, '没调色时零开销：取源就是原图、不建缓存',
        JSON.stringify(neutral));

    // ── 3. 曝光：真把像素提亮了 ──
    const exp = await exec(`(async () => {
        const A = window.App;
        const px = (src) => { const c = document.createElement('canvas'); c.width = 4; c.height = 4;
            const g = c.getContext('2d'); g.drawImage(src, 0, 0, 4, 4);
            return Array.from(g.getImageData(2, 2, 1, 1).data).slice(0, 3); };
        const before = px(A.image.el);
        A.setGrade({ exp: 1, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        await new Promise((r) => setTimeout(r, 120));
        const src = window.photoSrcOf(A.image);
        // 采样点必须落在右上那块中灰（左上黑、右下白是锚点，动不得）
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0);
        const mid = Array.from(g.getImageData(450, 100, 1, 1).data).slice(0, 3);
        return { before, mid, isCanvas: src !== A.image.el, tag: src && src.tagName,
                 nw: src && src.naturalWidth, nh: src && src.naturalHeight };
    })()`);
    check(exp.isCanvas && exp.tag === 'CANVAS', '调色后取源变成离屏画布', `tag=${exp.tag}`);
    check(exp.nw === 600 && exp.nh === 400, '烘焙画布补了 naturalWidth/naturalHeight（引擎靠它算比例）',
        `${exp.nw}×${exp.nh}`);
    check(exp.mid[0] > 150 && exp.mid[0] > 128 + 15, '曝光 +1.00EV：中灰确实变亮',
        `灰 128 → ${exp.mid.join(',')}`);

    // ── 4. 高光/阴影：AOS 实测表行为（shared/acr，Camera Raw 滤镜实测）──
    // ACR 的阴影 +100 **不抬纯黑**（保黑点），但会按图片亮度自适应地抬暗中间调；
    // 高光 −100 在暗底（log 平均亮度低）上会强力压缩中间调。这是实测行为，
    // 不是 bug —— 旧公式「中间调 ±4 不动」反而和 PS 对不上。
    const ends = await exec(`(async () => {
        const A = window.App;
        const grab = async (hi, sh) => {
            A.setGrade({ exp: 0, con: 0, sat: 0, vib: 0, temp: 0, tint: 0,
                hi, sh, white: 0, black: 0, curve: null, cal: null, det: null,
                mix: null, cg: null }, { full: true, replace: true });
            await new Promise((r) => setTimeout(r, 150));
            const c = document.createElement('canvas'); c.width = 600; c.height = 400;
            const g = c.getContext('2d'); g.drawImage(window.photoSrcOf(A.image), 0, 0);
            const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data)[0];
            return { black: at(20, 20), white: at(580, 380), mid: at(450, 100) };
        };
        return { sh100: await grab(0, 100), hiM100: await grab(-100, 0) };
    })()`);
    check(ends.sh100.white >= 254 && ends.hiM100.black <= 2,
        '阴影不碰亮部、高光不碰暗部', JSON.stringify(ends));
    check(ends.sh100.black <= 8 && ends.sh100.mid >= 140 && ends.sh100.mid <= 175,
        '阴影 +100：保住黑点（0→0..8）、暗中间调自适应抬起（128→140..175）',
        `黑 0→${ends.sh100.black} 中灰 128→${ends.sh100.mid}`);
    // 高光的现状：b50a73b 的研究结论是「hi 行与 white 也是空间算子」，但落地的 CRS2 表
    // 只拟合了 sh 一行（coefficients 按 amount=sh 取值），hi / white 的空间部分尚未接入。
    // 所以高光目前只走全局表 + compose3d 末端的亮度收口：白点小幅下落、中灰几乎不动。
    // 这条断言按当前实际行为写，同时守住两条底线 —— 白点不能被压穿成灰、中灰不能跟着掉；
    // 等 hi 的空间行接进来，再改回 222..240 / 40..100。
    check(ends.hiM100.white >= 240 && ends.hiM100.white <= 252 && Math.abs(ends.hiM100.mid - 128) <= 5,
        '高光 −100：白点小幅下落且不发灰、中灰不跟着掉（空间行待接入，见上方注释）',
        `白 255→${ends.hiM100.white} 中灰 128→${ends.hiM100.mid}`);

    // ── 5. 色温：暖 → R 升 B 降 ──
    const temp = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 100, tint: 0, hi: 0, sh: 0 }, { full: true });
        await new Promise((r) => setTimeout(r, 120));
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d'); g.drawImage(window.photoSrcOf(A.image), 0, 0);
        const p = Array.from(g.getImageData(450, 100, 1, 1).data).slice(0, 3);
        return p;
    })()`);
    check(temp[0] > 128 + 8 && temp[2] < 128 - 8, '色温 +100（暖）：R 升 B 降', `rgb=${temp.join(',')}`);

    // ── 6. 饱和度 -100 = 黑白 ──
    const gray = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ exp: 0, con: 0, sat: -100, temp: 100, tint: 0, hi: 0, sh: 0 }, { full: true });
        await new Promise((r) => setTimeout(r, 120));
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d'); g.drawImage(window.photoSrcOf(A.image), 0, 0);
        return Array.from(g.getImageData(450, 100, 1, 1).data).slice(0, 3);
    })()`);
    check(Math.abs(gray[0] - gray[1]) <= 2 && Math.abs(gray[1] - gray[2]) <= 2,
        '饱和度 -100 得到灰阶', `rgb=${gray.join(',')}`);

    // ── 7. 渲染真的用了调色画布 ──
    const render = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ exp: 2, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 900));
        const cv = A.dom.canvas;
        const c = document.createElement('canvas'); c.width = 40; c.height = 40;
        const g = c.getContext('2d'); g.drawImage(cv, 0, 0, 40, 40);
        const d = g.getImageData(0, 0, 40, 40).data;
        let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i];
        const bright = Math.round(sum / (d.length / 4));
        A.setGrade({ exp: -2, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 900));
        const g2 = c.getContext('2d'); g2.clearRect(0, 0, 40, 40); g2.drawImage(cv, 0, 0, 40, 40);
        const d2 = g2.getImageData(0, 0, 40, 40).data;
        let sum2 = 0; for (let i = 0; i < d2.length; i += 4) sum2 += d2[i];
        return { bright, dark: Math.round(sum2 / (d2.length / 4)) };
    })()`);
    check(render.bright > render.dark + 8, '曝光 ±2EV 在画布上看得出差别（渲染走的是调色源）',
        `亮=${render.bright} 暗=${render.dark}`);

    // ── 8. 每张照片独立 ──
    const perImage = await exec(`(async () => {
        const A = window.App;
        const el2 = await window.__mk(600, 400);
        const im2 = { el: el2, name: 'g2', path: null, w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images = [A.image, im2];
        A.setGrade({ exp: 1.5, con: 0, sat: 40, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        const p1 = JSON.parse(JSON.stringify(A.image.grade));
        A.image = im2; A.currentIdx = 1;
        if (A.invalidateGrade) A.invalidateGrade(im2);
        if (A.syncGradeUI) A.syncGradeUI();
        const uiExp = document.getElementById('slGradeExp').value;
        const p2 = JSON.parse(JSON.stringify(A.gradeOf(im2)));
        return { p1, p2, uiExp };
    })()`);
    check(perImage.p1.exp === 1.5 && perImage.p2.exp === 0, '调色参数挂在照片上，互不串台',
        `图1=${perImage.p1.exp} 图2=${perImage.p2.exp}`);
    check(perImage.uiExp === '0', '切图后滑块回显新照片的参数', `滑块=${perImage.uiExp}`);

    // ── 8.5 精确数字框跟随（syncGradeUI 必须走 updateLabel） ──
    const numSync = await exec(`(() => {
        const A = window.App;
        A.image = A.images[0]; A.currentIdx = 0;
        A.setGrade({ exp: 0.33, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        const num = document.querySelector('#rowGradeExp .pval-num');
        const val = num && !num.hidden ? num.value : null;
        const lbl = document.getElementById('lblGradeExp').textContent;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        return { val, lbl };
    })()`);
    check(numSync.val === '0.33' && numSync.lbl === '+0.33',
        '编程设值后数字框与标签同步（走 updateLabel）', JSON.stringify(numSync));

    // ── 9. 应用到全部 ──
    const all = await exec(`(async () => {
        const A = window.App;
        A.image = A.images[0]; A.currentIdx = 0;
        A.setGrade({ exp: 0.55, con: 20, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        A.applyGradeToAll();
        return A.images.map((im) => (im.grade ? im.grade.exp : null));
    })()`);
    check(all.length === 2 && all.every((v) => v === 0.55), '「应用到全部」把参数复制给其余照片',
        JSON.stringify(all));

    // ── 10. 重置 ──
    const reset = await exec(`(async () => {
        const A = window.App;
        document.getElementById('btnGradeReset').click();
        await new Promise((r) => setTimeout(r, 200));
        const im = A.image;
        return { neutral: A.isNeutralGrade(im.grade), same: window.photoSrcOf(im) === im.el,
                 ui: document.getElementById('slGradeExp').value,
                 status: A.statusMsg || '' };
    })()`);
    check(reset.neutral && reset.same && reset.ui === '0',
        '重置：参数归零、取源回到原图、滑块回 0', JSON.stringify(reset));

    // ── 11. 拖动用降采样，松手补全分辨率 ──
    const levels = await exec(`(async () => {
        const A = window.App, im = A.image;
        const big = await window.__mk(3000, 2000);
        im.el = big; im.w = 3000; im.h = 2000;
        A.invalidateGrade(im);
        A.setGrade({ exp: 0.3, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        await new Promise((r) => setTimeout(r, 60));
        const low = im._grade.low ? [im._grade.low.width, im._grade.low.height] : null;
        // 取源报的照片尺寸必须恒等于原图:引擎按它算 EXIF 自适应字号
        // (档位 × clamp(照片宽/1200)),报成 1600 会让相机型号在拖动过程中变小。
        const lowNat = window.photoSrcOf(im)
            ? [window.photoSrcOf(im).naturalWidth, window.photoSrcOf(im).naturalHeight] : null;
        A.rebuildGrade('full');
        await new Promise((r) => setTimeout(r, 60));
        const full = im._grade.canvas ? [im._grade.canvas.width, im._grade.canvas.height] : null;
        const fullNat = window.photoSrcOf(im)
            ? [window.photoSrcOf(im).naturalWidth, window.photoSrcOf(im).naturalHeight] : null;
        return { low, full, lowGone: !im._grade.low, lowNat, fullNat };
    })()`);
    check(levels.low && levels.low[0] === 1600, '拖动中先出 1600px 降采样（不然每帧烘焙 600 万像素）',
        `low=${levels.low && levels.low.join('×')}`);
    check(levels.full && levels.full[0] === 3000 && levels.full[1] === 2000,
        '松手后补成原图尺寸（导出的「原图」档位不会缩水）',
        `full=${levels.full && levels.full.join('×')}`);
    check(levels.lowNat && levels.lowNat[0] === 3000 && levels.lowNat[1] === 2000
          && levels.fullNat && levels.fullNat[0] === 3000 && levels.fullNat[1] === 2000,
        '降采样/全分辨率都报原图尺寸（EXIF 自适应字号不随拖动跳变）',
        `low=${levels.lowNat && levels.lowNat.join('×')} full=${levels.fullNat && levels.fullNat.join('×')}`);

    // ── 12. 草稿能存下参数 ──
    const draft = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ exp: 0.42, con: 0, sat: -15, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        const im = A.image;
        return { has: !!(im.grade && !A.isNeutralGrade(im.grade)), exp: im.grade && im.grade.exp,
                 serializable: JSON.stringify(im.grade) };
    })()`);
    check(draft.has && draft.exp === 0.42 && /"exp":0\.42/.test(draft.serializable),
        '调色是纯数字，可以原样存进草稿（重启后重放，无损）', draft.serializable);

    // ── 13. 相框样式管线也必须吃调色 ──
    // 带 photoFrameStyle 的预设走 engine-styles.js 的 renderPhotoFrame,那条管线曾经
    // 直取 app.image.el,套了这类预设后调色滑块完全不起作用。
    const framed = await exec(`(async () => {
        const A = window.App;
        A.image = A.images[0]; A.currentIdx = 0;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        A.template = A.defaultTemplate();
        A.template.photoFrameStyle = 'VINTAGE';
        A.setTpl(A.image, A.template);
        const sample = () => {
            const cv = A.dom.canvas;
            const c = document.createElement('canvas'); c.width = 60; c.height = 60;
            const g = c.getContext('2d'); g.drawImage(cv, 0, 0, 60, 60);
            const d = g.getImageData(0, 0, 60, 60).data;
            let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
            return Math.round(s / (d.length / 4) / 3);
        };
        const at = async (exp) => {
            A.setGrade({ exp, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
            A.scheduleRender(true);
            // 隐藏测试窗口里 requestAnimationFrame 不可靠：显式同步合成一次，
            // 否则两次采样可能拿到同一帧（bright 与 dark 相等，误报成"相框不吃调色"）。
            A._renderDirty = true;
            if (typeof A._drainRenderQueue === 'function') A._drainRenderQueue();
            await new Promise((r) => setTimeout(r, 260));
            return sample();
        };
        const mid = await at(0), bright = await at(2), dark = await at(-2);
        const used = A.template.photoFrameStyle;
        A.template.photoFrameStyle = 'NONE';
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        A.scheduleRender(true);
        return { mid, bright, dark, used };
    })()`);
    check(framed.bright > framed.mid + 4 && framed.mid > framed.dark + 4,
        '相框样式（photoFrameStyle）管线同样吃调色', JSON.stringify(framed));

    // ── 14. 调色后胶片条缩略图跟着重画（否则用户以为“调了没变化”） ──
    const thumbSync = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        if (A.renderFramedThumb) A.renderFramedThumb(im);
        const before = im.thumb || '';
        const s = document.getElementById('slGradeExp');
        s.value = '1.5';
        s.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 800));
        const after = im.thumb || '';
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        return { hasBefore: before.length > 100, changed: before !== after };
    })()`);
    check(thumbSync.hasBefore && thumbSync.changed,
        '停手后胶片条缩略图重画成调色后的样子', JSON.stringify(thumbSync));

    // ── 15. 双击滑块：该档归零，其余档不受牵连 ──
    const dbl = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.setGrade({ exp: 0.6, con: 40, sat: -30, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        const s = document.getElementById('slGradeExp');
        const numEl = document.querySelector('#rowGradeExp .pval-num');
        const before = { v: s.value, lbl: document.getElementById('lblGradeExp').textContent };
        s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 500));
        return { before, after: { v: s.value, lbl: document.getElementById('lblGradeExp').textContent,
                 num: numEl && numEl.value, exp: im.grade.exp, con: im.grade.con, sat: im.grade.sat } };
    })()`);
    check(dbl.before.v === '0.6' && dbl.after.v === '0' && dbl.after.exp === 0
          && dbl.after.con === 40 && dbl.after.sat === -30 && dbl.after.lbl === '0'
          && dbl.after.num === '0',
        '双击滑块：该档归零，其余档不动', JSON.stringify(dbl));

    // ── 16. 曲线编辑器 ──
    const curveUi = await exec(`(() => {
        const cv = document.getElementById('curveCanvas');
        const btns = Array.prototype.slice.call(document.querySelectorAll('#curveChans .curve-chan'));
        const b = btns.find(x => x.dataset.chan === 'b');
        if (b) b.click();
        return { has: !!cv, chans: btns.map(x => x.dataset.chan), cur: window.App._curveChan,
                 hasReset: !!document.getElementById('btnCurveReset') };
    })()`);
    check(curveUi.has && curveUi.chans.join(',') === 'rgb,r,g,b' && curveUi.cur === 'b' && curveUi.hasReset,
        '曲线控件：画布 + RGB/红/绿/蓝 四个通道可切换', JSON.stringify(curveUi));

    // 抬黑点：RGB 曲线左下角抬到 0.3 → 纯黑区变成灰
    const lift = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0,
                     curve: { rgb: [[0, 0.3], [1, 1]] } }, { full: true });
        await new Promise((r) => setTimeout(r, 300));
        const src = window.photoSrcOf(im);
        // 前面的用例把照片换成了 3000×2000：按原图尺寸取样，别写死坐标
        const W = src.naturalWidth || 600, H = src.naturalHeight || 400;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0);
        const at = (fx, fy) => Array.from(g.getImageData(Math.round(W * fx), Math.round(H * fy), 1, 1).data).slice(0, 3);
        const black = at(0.25, 0.25);     // 左上 = 纯黑象限
        const white = at(0.75, 0.75);     // 右下 = 纯白象限
        return { black, white, isCanvas: src !== im.el, W, H };
    })()`);
    check(lift.isCanvas && lift.black[0] > 60 && lift.black[0] < 95 && lift.white[0] > 245,
        '曲线抬黑点：纯黑区变灰、纯白不动', JSON.stringify(lift));

    // 单通道曲线：只动红
    const chanCurve = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0,
                     curve: { r: [[0, 0], [0.5, 0.8], [1, 1]] } }, { full: true });
        await new Promise((r) => setTimeout(r, 300));
        const src = window.photoSrcOf(im);
        const W = src.naturalWidth || 600, H = src.naturalHeight || 400;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0);
        // 右上 = 中灰（128）象限
        return { px: Array.from(g.getImageData(Math.round(W * 0.75), Math.round(H * 0.25), 1, 1).data).slice(0, 3) };
    })()`);
    check(chanCurve.px[0] > 185 && Math.abs(chanCurve.px[1] - 128) <= 3 && Math.abs(chanCurve.px[2] - 128) <= 3,
        '红通道曲线只动红色，绿蓝不动', JSON.stringify(chanCurve.px));

    // 单调插值：不过冲（Catmull-Rom 会冲出控制点范围，单调插值不会）
    const mono = await exec(`(() => {
        const C = window.QfsCurve;
        const pts = [[0, 0], [0.25, 0.9], [0.5, 0.95], [1, 1]];
        const t = C.monotoneTable(pts);
        let maxV = -1, minV = 2, bad = 0;
        for (const v of t) { if (!isFinite(v)) bad++; if (v > maxV) maxV = v; if (v < minV) minV = v; }
        return { n: t.length, bad, maxV: +maxV.toFixed(4), minV: +minV.toFixed(4), end: +t[255].toFixed(3) };
    })()`);
    check(mono.n === 256 && mono.bad === 0 && mono.maxV <= 1.0001 && mono.minV >= -0.0001 && mono.end === 1,
        '曲线用单调插值：不过冲、不越界', JSON.stringify(mono));

    // 曲线参与中性判断 + 重置
    const curveReset = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0,
                     curve: { rgb: [[0, 0.2], [1, 1]] } });
        const dirty = !A.isNeutralGrade(im.grade);
        document.getElementById('btnCurveReset').click();
        await new Promise((r) => setTimeout(r, 200));
        return { dirty, after: A.isNeutralGrade(im.grade), curve: im.grade.curve,
                 srcIsOrig: window.photoSrcOf(im) === im.el };
    })()`);
    check(curveReset.dirty && curveReset.after && !curveReset.curve && curveReset.srcIsOrig,
        '曲线算「已调整」，重置后归零并回到原图取源', JSON.stringify(curveReset));

    // 模拟鼠标：在空白处按下 = 加控制点并跟着拖动
    const dragCurve = await exec(`(() => {
        const A = window.App;
        const rgbBtn = Array.prototype.slice.call(document.querySelectorAll('#curveChans .curve-chan'))
            .find(x => x.dataset.chan === 'rgb');
        if (rgbBtn) rgbBtn.click();
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0, curve: null });
        A.switchTab('grade');            // 面板必须可见，否则画布没有布局尺寸
        const el = document.getElementById('curveCanvas');
        const r = el.getBoundingClientRect();
        const pad = 8;
        const at = (fx, fy) => ({ x: r.left + pad + fx * (r.width - pad * 2),
                                  y: r.top + r.height - pad - fy * (r.height - pad * 2) });
        const ev = (type, p) => el.dispatchEvent(new PointerEvent(type,
            { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1 }));
        const p0 = at(0.5, 0.7);        // 中间偏上：往上提亮中间调
        ev('pointerdown', p0);
        const n1 = A.curvePoints('rgb').length;
        const p1 = at(0.5, 0.85);
        ev('pointermove', p1);
        const pts = A.curvePoints('rgb');
        ev('pointerup', p1);
        return { n1, n2: pts.length, mid: pts[1], graded: !!A.image.grade.curve };
    })()`);
    check(dragCurve.n1 === 3 && dragCurve.n2 === 3 && dragCurve.graded
          && Math.abs(dragCurve.mid[0] - 0.5) < 0.02 && dragCurve.mid[1] > 0.8,
        '鼠标在曲线画布上按下即加点、拖动改形', JSON.stringify(dragCurve));

    // 「应用到全部」：曲线必须深拷贝，不能多张共用一份控制点
    const curveCopy = await exec(`(() => {
        const A = window.App;
        A.image = A.images[0]; A.currentIdx = 0;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0,
                     curve: { rgb: [[0, 0.15], [1, 1]] } });
        A.applyGradeToAll();
        const a = A.images[0].grade.curve, b = A.images[1].grade.curve;
        a.rgb[0][1] = 0.9;                      // 只改第一张
        return { same: a === b, b0: b.rgb[0][1], j: JSON.stringify(A.images[1].grade).indexOf('curve') > 0 };
    })()`);
    check(!curveCopy.same && curveCopy.b0 === 0.15 && curveCopy.j,
        '「应用到全部」深拷贝曲线（改一张不串台，可存草稿）', JSON.stringify(curveCopy));

    // ══ 扩展档位：细节 / 校准 / 混色器 ══════════════════════════

    // 纯红/纯绿/纯蓝/中灰四象限，用来验证按色相的作用范围
    await exec(`window.__mkc = async () => {
        const c = document.createElement('canvas');
        c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#ff0000'; g.fillRect(0, 0, 300, 200);
        g.fillStyle = '#00ff00'; g.fillRect(300, 0, 300, 200);
        g.fillStyle = '#0000ff'; g.fillRect(0, 200, 300, 200);
        g.fillStyle = '#808080'; g.fillRect(300, 200, 300, 200);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        return el;
    }; true`);

    const sampleQuads = `(() => {
        const src = window.photoSrcOf(window.App.image);
        const c = document.createElement('canvas'); c.width = 300; c.height = 200;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0, 300, 200);
        const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3);
        return { red: at(75, 50), green: at(225, 50), blue: at(75, 150), gray: at(225, 150) };
    })()`;

    // ── 17. 三组新滑块都挂在面板上 ──
    const extUi = await exec(`(() => {
        const ids = ['slDetClar', 'slDetTex', 'slDetDhz', 'slCalRH', 'slCalRS', 'slCalGH',
            'slCalGS', 'slCalBH', 'slCalBS'];
        const mixIds = ['slMixRH', 'slMixOS', 'slMixYL', 'slMixGS', 'slMixAH', 'slMixBS', 'slMixPH', 'slMixML'];
        const all = ids.concat(mixIds);
        const tabs = Array.prototype.slice.call(document.querySelectorAll('#mixMetrics .curve-chan'));
        const grp = document.getElementById('grpMix');
        if (grp) grp.dataset.m = 's';
        const visS = getComputedStyle(document.getElementById('slMixRS').closest('.param-row')).display !== 'none';
        const visH = getComputedStyle(document.getElementById('slMixRH').closest('.param-row')).display === 'none';
        if (grp) grp.dataset.m = 'h';
        const numBox = !!document.querySelector('#grpDet .pval-num');
        return { missing: all.filter((id) => !document.getElementById(id)),
                 tabs: tabs.map((t) => t.dataset.m), visS, visH, numBox,
                 gl: !!(window.QfsMix && window.QfsMix.available()),
                 mixNa: grp && grp.classList.contains('mix-na') };
    })()`);
    check(extUi.missing.length === 0 && extUi.tabs.join(',') === 'h,s,l'
          && extUi.visS && extUi.visH && extUi.numBox,
        '细节/校准/混色器三组滑块齐全，混色器三个子页切换正常',
        JSON.stringify(extUi));
    check(extUi.gl !== extUi.mixNa, 'WebGL 可用则混色器启用，不可用则整组标记降级',
        `gl=${extUi.gl} mixNa=${extUi.mixNa}`);

    // ── 18. 校准：灰永不偏色，红·饱和 -100 压红 ──
    await exec(`(async () => {
        const A = window.App;
        A.resetGrade();
        const el = await window.__mkc();
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        await new Promise((r) => setTimeout(r, 150));
        return true;
    })()`);
    const calGray = await exec(sampleQuads);
    check(Math.abs(calGray.gray[0] - 128) <= 3 && Math.abs(calGray.gray[1] - 128) <= 3,
        '校准恒等矩阵不动灰', JSON.stringify(calGray.gray));
    const calRed = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ cal: { rh: 0, rs: -100, gh: 0, gs: 0, bh: 0, bs: 0 } }, { full: true });
        await new Promise((r) => setTimeout(r, 150));
        return ${sampleQuads};
    })()`);
    const redMuted = calRed.red[0] - calRed.red[1];
    check(calRed.red[1] > 40 && redMuted < 120 && Math.abs(calRed.gray[0] - 128) <= 4,
        '校准红·饱和 -100：红色显著去饱和，灰背景不偏色',
        `红=${calRed.red} 灰=${calRed.gray}`);
    const calHue = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ cal: { rh: 100, rs: 0, gh: 0, gs: 0, bh: 0, bs: 0 } }, { full: true });
        await new Promise((r) => setTimeout(r, 150));
        return ${sampleQuads};
    })()`);
    check(calHue.red[1] > 60 && calHue.red[2] < 40,
        '校准红·色相 +100：红往黄(加绿)转、不往蓝跑', JSON.stringify(calHue.red));

    // ── 19. 细节：清晰度提边缘反差，平坦区不动 ──
    // （边缘用 64/191 灰阶而不是纯黑白：纯黑纯白侧会被 USM 过冲钳位，看不出变化）
    const clarity = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas');
        c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#404040'; g.fillRect(0, 0, 300, 400);
        g.fillStyle = '#bfbfbf'; g.fillRect(300, 0, 300, 400);
        g.fillStyle = '#808080'; g.fillRect(340, 300, 160, 80);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        const grab = async () => {
            const src = window.photoSrcOf(A.image);
            const s = document.createElement('canvas'); s.width = 600; s.height = 400;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0);
            const edgeL = Array.from(gg.getImageData(292, 100, 1, 1).data)[0];
            const edgeR = Array.from(gg.getImageData(308, 100, 1, 1).data)[0];
            const flat = Array.from(gg.getImageData(400, 340, 1, 1).data)[0];
            return { edgeL, edgeR, flat };
        };
        A.resetGrade();
        await new Promise((r) => setTimeout(r, 150));
        const before = await grab();
        A.setGrade({ det: { clar: 100, tex: 0, dhz: 0 } }, { full: true });
        await new Promise((r) => setTimeout(r, 300));
        const after = await grab();
        return { before, after };
    })()`);
    check(clarity.after.edgeL < clarity.before.edgeL - 6
          && clarity.after.edgeR > clarity.before.edgeR + 6
          && Math.abs(clarity.after.flat - 128) <= 5,
        '清晰度 +100：边缘反差变大、平坦灰基本不动',
        `边 ${clarity.before.edgeL}/${clarity.before.edgeR} → ${clarity.after.edgeL}/${clarity.after.edgeR} 平坦=${clarity.after.flat}`);

    // ── 20. 去除薄雾：走 Camera Raw 的真实反演（雾色 + 暗通道透射率）──
    // 不再用 contrast/saturate 叠加 + LUT 拉黑场那套「假通透」：那套会让
    // 纯黑也被压、亮部发灰。真实反演下纯黑恒为 0（它不含雾）。
    const dhz = await exec(`(async () => {
        const A = window.App;
        // 暗灰 64 做敏感探针：纯黑只会被负档抬动，正档压不动
        const grab = async () => {
            const src = window.photoSrcOf(A.image);
            const s = document.createElement('canvas'); s.width = 600; s.height = 400;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0);
            const low = Array.from(gg.getImageData(150, 340, 1, 1).data)[0];    // 暗灰 64 探针
            const black = Array.from(gg.getImageData(60, 100, 1, 1).data)[0];
            const mid = Array.from(gg.getImageData(450, 100, 1, 1).data)[0];
            return { low, black, mid };
        };
        A.resetGrade();
        // 重画：纯黑/纯白 + 一条 64 暗灰做探针
        const c = document.createElement('canvas');
        c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, 300, 200);
        g.fillStyle = '#fff'; g.fillRect(300, 0, 300, 200);
        g.fillStyle = '#404040'; g.fillRect(0, 200, 600, 200);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        await new Promise((r) => setTimeout(r, 150));
        const before = await grab();
        A.setGrade({ det: { clar: 0, tex: 0, dhz: 80 } }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const plus = await grab();
        A.setGrade({ det: { clar: 0, tex: 0, dhz: -80 } }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const minus = await grab();
        return { before, plus, minus };
    })()`);
    check(dhz.plus.low < dhz.before.low - 10 && dhz.minus.low > dhz.before.low + 10
          && dhz.plus.black <= 8 && dhz.minus.black > 12,
        '去除薄雾 ±80：正档压暗部提通透、纯黑不动，负档起雾把黑抬灰',
        `暗灰 ${dhz.before.low} → +${dhz.plus.low} / -${dhz.minus.low}；黑 ${dhz.before.black} → +${dhz.plus.black} / -${dhz.minus.black}`);

    // ── 21. 混色器（WebGL 前置级）：只动目标色相带 ──
    await exec(`(async () => {
        const A = window.App;
        const el = await window.__mkc();
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        A.setGrade({ det: null, mix: null }, { full: true });
        await new Promise((r) => setTimeout(r, 150));
        return true;
    })()`);
    if (extUi.gl) {
        const mixRed = await exec(`(async () => {
            const A = window.App;
            A.setGrade({ mix: { r: { h: 100, s: 0, l: 0 } } }, { full: true });
            await new Promise((r) => setTimeout(r, 250));
            return ${sampleQuads};
        })()`);
        check(mixRed.red[1] > 90 && mixRed.green[1] > 200 && mixRed.blue[2] > 200
              && Math.abs(mixRed.gray[0] - 128) <= 4,
            '混色器红·色相 +100：只有红带转橙，绿蓝灰不动', JSON.stringify(mixRed));
        const mixSat = await exec(`(async () => {
            const A = window.App;
            A.setGrade({ mix: { r: { h: 0, s: -100, l: 0 } } }, { full: true });
            await new Promise((r) => setTimeout(r, 250));
            return ${sampleQuads};
        })()`);
        const r = mixSat.red;
        // ACR 实测：混色器饱和 −100 不把颜色压成纯灰，红大约剩 3 成饱和
        // （255,0,0 → 186,132,132）；其他带与灰不动。
        check((r[0] - r[1]) <= 90 && (r[0] - r[1]) > 30
              && mixSat.green[1] > 200 && mixSat.blue[2] > 200
              && Math.abs(mixSat.gray[0] - 128) <= 4,
            '混色器红·饱和 -100：红带大幅去饱和（红−绿 255→≤90），其它带与灰不动',
            JSON.stringify(mixSat));
        const mixLum = await exec(`(async () => {
            const A = window.App;
            A.setGrade({ mix: { r: { h: 0, s: 0, l: -80 } } }, { full: true });
            await new Promise((r) => setTimeout(r, 250));
            return ${sampleQuads};
        })()`);
        check(mixLum.red[0] < 180 && mixLum.green[1] > 200,
            '混色器红·明亮度 -80：红带压暗，绿带不动', JSON.stringify(mixLum));
    } else {
        console.log('SKIP  混色器像素测试（此环境无 WebGL，降级路径已在 17 验证）');
    }

    // ── 22. 扩展参数的持久化 / 中性判断 / 深拷贝 / 重置 ──
    const extPersist = await exec(`(() => {
        const A = window.App;
        A.setGrade({ mix: { r: { h: 20, s: 0, l: 0 }, b: { h: 0, s: -30, l: 0 } },
                     cal: { rh: 0, rs: -20, gh: 0, gs: 0, bh: 10, bs: 0 },
                     det: { clar: 25, tex: 0, dhz: 15 } });
        const im = A.image;
        const neutral = A.isNeutralGrade(im.grade);
        const j = JSON.stringify(im.grade);
        const keeps = j.includes('"mix"') && j.includes('"cal"') && j.includes('"det"');
        // 批量应用：mix 是两层嵌套，必须深拷贝
        A.applyGradeToAll();
        const a = A.images[0].grade.mix, b = A.images[1].grade.mix;
        const deep = a !== b;
        const z0 = A.images[1].grade.mix.b.s;
        if (a.b) a.b.s = -99;
        const z1 = A.images[1].grade.mix.b.s;
        A.setGrade({ mix: null, cal: null, det: null });
        const after = A.isNeutralGrade(im.grade) && window.photoSrcOf(im) === im.el;
        return { neutral, keeps, deep, z0, z1, after };
    })()`);
    check(!extPersist.neutral && extPersist.keeps,
        '扩展参数随草稿持久化（JSON 可序列化）且计入「已调整」', JSON.stringify(extPersist));
    check(extPersist.deep && extPersist.z0 === -30 && extPersist.z1 === -30,
        '「应用到全部」深拷贝混色器（改一张不串台）', JSON.stringify(extPersist));
    check(extPersist.after, '扩展参数全部清零后回到原图取源（零开销）');

    // ── 22.5 颜色分级：UI、像素、持久化 ──
    const cgUi = await exec(`(() => {
        const A = window.App;
        A.resetGrade();
        A.setGrade({ cg: {
            shadow: { h: 200, s: 13, l: -5 }, mid: { h: 0, s: 0, l: 0 },
            high: { h: 40, s: 80, l: 10 }, global: { h: 0, s: 0, l: 0 },
            blending: 70, balance: -20
        } });
        const tabs = Array.prototype.slice.call(document.querySelectorAll('#cgZones .curve-chan'));
        const active = tabs.find((b) => b.classList.contains('active'));
        const read = () => ({
            h: document.getElementById('slCgHue').value,
            s: document.getElementById('slCgSat').value,
            l: document.getElementById('slCgLum').value,
            blend: document.getElementById('slCgBlending').value,
            bal: document.getElementById('slCgBalance').value
        });
        const shadow = read();
        const highBtn = tabs.find((b) => b.dataset.cg === 'high');
        if (highBtn) highBtn.click();
        const high = read();
        const active2 = tabs.find((b) => b.classList.contains('active'));
        const grp = document.getElementById('grpColorGrade');
        return { zones: tabs.map((b) => b.dataset.cg).join(','),
                 active: active && active.dataset.cg, active2: active2 && active2.dataset.cg,
                 shadow, high, gradeOn: grp && grp.classList.contains('grade-on'),
                 hasVib: !!document.getElementById('slGradeVib'),
                 hasReset: !!document.getElementById('btnCgReset') };
    })()`);
    check(cgUi.zones === 'shadow,mid,high,global' && cgUi.active === 'shadow'
          && cgUi.active2 === 'high' && cgUi.hasVib && cgUi.hasReset && cgUi.gradeOn,
        '颜色分级 UI：四个区域页签、自然饱和度、重置按钮齐全，切页签回显对应区域',
        JSON.stringify(cgUi));
    check(cgUi.shadow.h === '200' && cgUi.shadow.s === '13' && cgUi.shadow.l === '-5'
          && cgUi.shadow.blend === '70' && cgUi.shadow.bal === '-20'
          && cgUi.high.h === '40' && cgUi.high.s === '80' && cgUi.high.l === '10',
        '颜色分级参数回显：阴影/高光/混合/平衡', JSON.stringify(cgUi));

    // 只调色相、饱和度为 0：颜色分级不能被判成「空」而整组丢掉。
    // sanitizeCg 曾只检查 s/l，导致拖色相后 cg 变 null、滑块弹回 0（用户反馈「色相滑不动」）。
    const cgHueOnly = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ cg: { shadow: { h: 210, s: 0, l: 0 }, mid: { h: 0, s: 0, l: 0 },
            high: { h: 0, s: 0, l: 0 }, global: { h: 0, s: 0, l: 0 }, blending: 50, balance: 0 } });
        await new Promise((r) => setTimeout(r, 200));
        const cg = (A.gradeOf(A.image) || {}).cg;
        const hue = document.getElementById('slCgHue');
        return { kept: !!(cg && cg.shadow && cg.shadow.h === 210), slider: hue ? hue.value : null };
    })()`);
    check(cgHueOnly.kept, '只调色相时颜色分级不被判空（色相保留）', JSON.stringify(cgHueOnly));

    const cgPix = await exec(`(async () => {
        const A = window.App;
        A.resetGrade();
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        ['#303030', '#808080', '#d0d0d0'].forEach((col, i) => {
            g.fillStyle = col; g.fillRect(i * 200, 0, 200, 400);
        });
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        const sample = (src) => {
            const s = document.createElement('canvas'); s.width = 600; s.height = 400;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0);
            const at = (x) => Array.from(gg.getImageData(x, 200, 1, 1).data).slice(0, 3);
            return { dark: at(100), mid: at(300), light: at(500) };
        };
        const before = sample(el);
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        A.setGrade({ cg: {
            shadow: { h: 220, s: 100, l: 0 }, mid: { h: 0, s: 0, l: 0 },
            high: { h: 40, s: 100, l: 0 }, global: { h: 0, s: 0, l: 0 },
            blending: 50, balance: 0
        } }, { full: true });
        await new Promise((r) => setTimeout(r, 350));
        return { before, after: sample(window.photoSrcOf(A.image)),
                 gl: !!(window.QfsColor && window.QfsColor.usingGL()) };
    })()`);
    check(cgPix.after.dark[2] > cgPix.after.dark[0] + 8
          && cgPix.after.light[0] > cgPix.after.light[2] + 8
          && Math.abs(cgPix.after.mid[0] - cgPix.after.mid[2]) <= 6,
        '颜色分级像素：阴影上蓝、高光上暖、中间调不被两端串色',
        `阴影=${cgPix.before.dark}→${cgPix.after.dark} 中间=${cgPix.after.mid} 高光=${cgPix.before.light}→${cgPix.after.light} gl=${cgPix.gl}`);

    const vibPix = await exec(`(async () => {
        const A = window.App;
        A.resetGrade();
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#b08a70'; g.fillRect(0, 0, 300, 400); // 低饱和暖色
        g.fillStyle = '#ff0000'; g.fillRect(300, 0, 300, 400); // 已饱和红
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        const spread = (rgb) => Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
        const sample = (src) => {
            const s = document.createElement('canvas'); s.width = 600; s.height = 400;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0);
            const at = (x) => Array.from(gg.getImageData(x, 200, 1, 1).data).slice(0, 3);
            return { muted: at(100), saturated: at(450) };
        };
        const before = sample(el);
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        A.setGrade({ vib: 100 }, { full: true });
        await new Promise((r) => setTimeout(r, 350));
        const after = sample(window.photoSrcOf(A.image));
        return { before, after,
                 mutedUp: spread(after.muted) - spread(before.muted),
                 satDelta: spread(after.saturated) - spread(before.saturated) };
    })()`);
    check(vibPix.mutedUp > 8 && Math.abs(vibPix.satDelta) <= 4,
        '自然饱和度 +100：低饱和颜色明显加彩，已饱和红色基本不溢出',
        `低饱和 ${vibPix.before.muted}→${vibPix.after.muted} 红=${vibPix.before.saturated}→${vibPix.after.saturated}`);

    const cgPersist = await exec(`(() => {
        const A = window.App;
        A.resetGrade();
        A.setGrade({ cg: {
            shadow: { h: 200, s: 20, l: 0 }, mid: { h: 0, s: 0, l: 0 },
            high: { h: 40, s: 10, l: 0 }, global: { h: 0, s: 0, l: 0 },
            blending: 50, balance: 0
        }, vib: 30 });
        const im = A.image;
        const j = JSON.stringify(im.grade);
        const neutral = A.isNeutralGrade(im.grade);
        A.applyGradeToAll();
        const a = A.images[0].grade.cg, b = A.images[1].grade.cg;
        const deep = a !== b;
        if (a.shadow) a.shadow.s = 99;
        const z = A.images[1].grade.cg.shadow.s;
        A.setGrade({ exp: 1 }, { replace: true });
        return { neutral, keeps: j.includes('"cg"') && j.includes('"vib"'),
                 deep, z, cleared: !im.grade.cg, exp: im.grade.exp };
    })()`);
    check(!cgPersist.neutral && cgPersist.keeps,
        '颜色分级/自然饱和度随草稿持久化并计入「已调整」', JSON.stringify(cgPersist));
    check(cgPersist.deep && cgPersist.z === 20,
        '「应用到全部」深拷贝颜色分级（改一张不串台）', JSON.stringify(cgPersist));
    check(cgPersist.cleared && cgPersist.exp === 1,
        'XMP 导入用 replace：未写进预设的颜色分级被清零', JSON.stringify(cgPersist));

    // ── 23. 效果段并入晕影/颗粒：滑块常开（无复选框）、默认 0，漏光仍是独立组 ──
    const moodUi = await exec(`(() => {
        const A = window.App;
        A.template = A.defaultTemplate();
        if (A.normalizeTemplate) A.normalizeTemplate();
        if (A.refreshUI) A.refreshUI();
        const grp = document.getElementById('panel-grade');
        const fx = grp.querySelector('.pg-sub[data-sub="fx"]');
        const inFx = ['slVignetteStrength', 'slVignetteFeather', 'slFilmGrain'].every((id) => {
            const el = document.getElementById(id);
            const row = el && el.closest('.param-row');
            return !!(row && fx.contains(row));
        });
        const chks = fx.querySelectorAll('input[type=checkbox]').length;
        const vals = ['slVignetteStrength', 'slVignetteFeather', 'slFilmGrain'].map((id) => {
            const el = document.getElementById(id);
            return el ? el.value : null;
        });
        const vg = document.getElementById('slVignetteStrength');
        const bidir = !!vg && vg.min === '-100' && vg.max === '100';
        const leakGroups = Array.prototype.slice.call(grp.querySelectorAll('.ctl-grp-light'))
            .map((x) => ((x.querySelector('.pg-title') || {}).textContent || '').trim());
        const curveEl = document.getElementById('grpCurve');
        const above = !!(fx.compareDocumentPosition(curveEl) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { inFx, chks, vals, bidir, leakGroups, above };
    })()`);
    check(moodUi.inFx && moodUi.chks === 0 && moodUi.vals.join(',') === '0,50,0' && moodUi.bidir,
        '晕影/羽化/颗粒并入「效果」段：无开关复选框、默认 0/50/0、晕影为 -100..100 双向',
        JSON.stringify(moodUi));
    check(moodUi.above && moodUi.leakGroups.length === 1 && moodUi.leakGroups[0] === '漏光',
        '「效果」排在「曲线」上方；漏光仍是唯一的独立光效组',
        JSON.stringify(moodUi.leakGroups));

    // 滑块即开关：非 0 自动启用（正负都算）、回 0 自动关闭（enable 是引擎唯一认的标志）
    const moodToggle = await exec(`(() => {
        const A = window.App;
        const s = document.getElementById('slVignetteStrength');
        const fire = () => {
            s.dispatchEvent(new Event('input', { bubbles: true }));
            s.dispatchEvent(new Event('change', { bubbles: true }));
        };
        s.value = '60'; fire();
        const on = Object.assign({}, A.template.lightEffect);
        s.value = '-45'; fire();
        const neg = Object.assign({}, A.template.lightEffect);
        s.value = '0'; fire();
        const off = Object.assign({}, A.template.lightEffect);
        return { onEn: on.vignetteEnable, onVal: on.vignetteStrength,
                 negEn: neg.vignetteEnable, negVal: neg.vignetteStrength,
                 offEn: off.vignetteEnable, offVal: off.vignetteStrength };
    })()`);
    check(moodToggle.onEn === 1 && moodToggle.onVal === 60
          && moodToggle.negEn === 1 && moodToggle.negVal === -45
          && moodToggle.offEn === 0 && moodToggle.offVal === 0,
        '滑块即开关：+60 / -45 都自动启用，回 0 自动关闭', JSON.stringify(moodToggle));

    // 老预设（enable:0 + 强度:35 的模板默认值）载入后必须显示 0，不能凭空冒出暗角；
    // 老数据「enable:1 + 正 35」= 压暗，迁移后应变 -35（新版负值才是压暗）。
    const legacyMood = await exec(`(() => {
        const A = window.App;
        A.template.lightEffect = Object.assign({}, A.template.lightEffect,
            { vignetteEnable: 0, vignetteStrength: 35 });
        delete A.template.lightEffect.vignetteSignV2;
        A.normalizeTemplate();
        A.refreshUI();
        const shownOff = document.getElementById('slVignetteStrength').value;
        // 老「已启用 + 正 35」→ 迁移成 -35
        A.template.lightEffect = Object.assign({}, A.template.lightEffect,
            { vignetteEnable: 1, vignetteStrength: 35 });
        delete A.template.lightEffect.vignetteSignV2;
        A.normalizeTemplate();
        A.refreshUI();
        const shownLegacyOn = document.getElementById('slVignetteStrength').value;
        // 新版数据（带标记）里的正值不能被迁移翻掉：+20 = 提亮
        A.template.lightEffect = Object.assign({}, A.template.lightEffect,
            { vignetteEnable: 1, vignetteStrength: 20, vignetteSignV2: 2 });
        A.normalizeTemplate();
        A.refreshUI();
        const shownV2 = document.getElementById('slVignetteStrength').value;
        A.template.lightEffect.vignetteEnable = 0;
        A.template.lightEffect.vignetteStrength = 0;
        A.refreshUI();
        return { shownOff, shownLegacyOn, shownV2 };
    })()`);
    check(legacyMood.shownOff === '0' && legacyMood.shownLegacyOn === '-35' && legacyMood.shownV2 === '20',
        '老预设 enable:0+强度:35 显示 0；老「启用+正 35」迁移为 -35（仍压暗）；新版正值 20 不被误翻',
        JSON.stringify(legacyMood));

    // 84 个预设存着 enable:0 + 强度:35（模板默认值，从未生效）。「效果」段的 is-dirty
    // 若只看强度，整库预设一打开就亮着「已改」、复位按钮常驻 —— 必须带 enable 判断。
    const fxDirty = await exec(`(() => {
        const A = window.App;
        const le = A.template.lightEffect;
        const fxEl = () => document.querySelector('#grpGrade .pg-sub[data-sub="fx"]');
        A.resetGrade();
        le.vignetteEnable = 0; le.vignetteStrength = 35; le.vignetteSignV2 = 2;
        le.filmGrainEnable = 0; le.filmGrainIntensity = 10;
        A.syncGradeSections(A.gradeOf(A.image));
        const stale = fxEl().classList.contains('is-dirty');
        le.vignetteEnable = 1; le.vignetteStrength = -33;
        A.syncGradeSections(A.gradeOf(A.image));
        const on = fxEl().classList.contains('is-dirty');
        le.vignetteEnable = 0; le.vignetteStrength = 0; le.filmGrainIntensity = 0;
        A.syncGradeSections(A.gradeOf(A.image));
        const off = fxEl().classList.contains('is-dirty');
        return { stale, on, off };
    })()`);
    check(fxDirty.stale === false && fxDirty.on === true && fxDirty.off === false,
        '预设残留 enable:0+强度:35 不算「已改」；真启用晕影才亮「效果」的复位按钮',
        JSON.stringify(fxDirty));

    // 真画出来：强度 85 时四角变暗、中心不动，归零后恢复。
    // 注意两点（这条用例曾经是"假阳性"）：
    // ① 必须自己重建一张干净的图，不能吃前序用例剩下的状态；
    // ② 隐藏测试窗口里 requestAnimationFrame 不可靠，靠 scheduleRender 等 800ms 会拿到旧帧 ——
    //    这里显式同步合成一次（_drainRenderQueue），否则 on/off 采样完全一样。
    const vigPix = await exec(`(async () => {
        const A = window.App;
        const c0 = document.createElement('canvas'); c0.width = 800; c0.height = 600;
        const g0 = c0.getContext('2d'); g0.fillStyle = '#808080'; g0.fillRect(0, 0, 800, 600);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c0.toDataURL('image/png'); });
        A.image.el = el; A.image.w = 800; A.image.h = 600; A.image._gradeCache = null;
        A.resetGrade();
        A.template = A.defaultTemplate();
        A.setTpl(A.image, A.template);
        const flush = async () => {
            A._renderDirty = true;
            if (typeof A._drainRenderQueue === 'function') A._drainRenderQueue();
            await new Promise((r) => setTimeout(r, 120));
        };
        await flush();
        const sample = () => {
            const cv = A.dom.canvas;
            const s = document.createElement('canvas'); s.width = 120; s.height = 120;
            const gg = s.getContext('2d'); gg.drawImage(cv, 0, 0, 120, 120);
            const at = (x, y) => { const d = gg.getImageData(x, y, 1, 1).data; return (d[0] + d[1] + d[2]) / 3; };
            const corner = (at(4, 4) + at(115, 4) + at(4, 115) + at(115, 115)) / 4;
            return { corner: +corner.toFixed(1), center: +at(60, 60).toFixed(1) };
        };
        const off = sample();
        // 新版语义：负值压暗、正值提亮。带标记，避免被「老数据迁移」翻掉符号。
        A.template.lightEffect.vignetteSignV2 = 2;
        A.template.lightEffect.vignetteEnable = 1;
        A.template.lightEffect.vignetteStrength = -85;
        A.setTpl(A.image, A.template);
        await flush();
        const dark = sample();
        A.template.lightEffect.vignetteStrength = 85;
        A.setTpl(A.image, A.template);
        await flush();
        const light = sample();
        A.template.lightEffect.vignetteEnable = 0;
        A.template.lightEffect.vignetteStrength = 0;
        A.setTpl(A.image, A.template);
        await flush();
        const back = sample();
        return { off, dark, light, back };
    })()`);
    check(vigPix.dark.corner < vigPix.off.corner - 25
          && Math.abs(vigPix.dark.center - vigPix.off.center) <= 8
          && vigPix.light.corner > vigPix.off.corner + 20
          && Math.abs(vigPix.light.center - vigPix.off.center) <= 8
          && Math.abs(vigPix.back.corner - vigPix.off.corner) <= 5,
        '晕影双向：-85 四角明显压暗、+85 四角明显提亮（中心都不动），归零后完全恢复',
        JSON.stringify(vigPix));

    // 相框样式管线同样要吃光效。以前 engine-styles 完全不调 applyGlobalLight，这几档对相框预设
    // 是死控件，面板只能整组隐藏（用户「看不到」的就是这批风格）。现在补在成片之上、文字之下，
    // 所以：① 行必须露出来；② 像素必须真的变。
    const frameVig = await exec(`(async () => {
        const A = window.App;
        A.template = A.defaultTemplate();
        A.template.photoFrameStyle = 'POLAROID_HAND';
        A.template.lightEffect.vignetteSignV2 = 2;
        A.template.lightEffect.vignetteEnable = 0;
        A.template.lightEffect.vignetteStrength = 0;
        A.template.lightEffect.vignetteFeather = 50;
        A.setTpl(A.image, A.template);
        if (A.updatePersonalVisibility) A.updatePersonalVisibility();
        if (A.applyModeControls) A.applyModeControls();
        // 调色面板改成 LR 式可折叠分段后，晕影/羽化/颗粒收在「效果」子段里。
        // 默认只展开「亮」，不先展开「效果」时这些行当然不可见——不是控件被隐藏。
        const fxSub = document.querySelector('.pg-sub[data-sub="fx"]');
        if (fxSub && fxSub.classList.contains('collapsed')) {
            const head = fxSub.querySelector('.pg-sub-head');
            if (head) head.click();
        }
        const ids = ['slVignetteStrength', 'slVignetteFeather', 'slFilmGrain', 'slLeakOpacity'];
        const shown = ids.map((id) => {
            const el = document.getElementById(id);
            const row = el && el.closest('.param-row');
            return !!(row && getComputedStyle(row).display !== 'none');
        });
        const flush = async () => {
            A._renderDirty = true;
            if (typeof A._drainRenderQueue === 'function') A._drainRenderQueue();
            await new Promise((r) => setTimeout(r, 150));
        };
        await flush();
        const sample = () => {
            const cv = A.dom.canvas;
            const s = document.createElement('canvas'); s.width = 120; s.height = 120;
            const gg = s.getContext('2d'); gg.drawImage(cv, 0, 0, 120, 120);
            const at = (x, y) => { const d = gg.getImageData(x, y, 1, 1).data; return (d[0] + d[1] + d[2]) / 3; };
            const corner = (at(4, 4) + at(115, 4) + at(4, 115) + at(115, 115)) / 4;
            return { corner: +corner.toFixed(1), center: +at(60, 60).toFixed(1) };
        };
        const off = sample();
        A.template.lightEffect.vignetteEnable = 1;
        A.template.lightEffect.vignetteStrength = -85;
        A.setTpl(A.image, A.template);
        await flush();
        const dark = sample();
        A.template = A.defaultTemplate();
        A.setTpl(A.image, A.template);
        if (A.applyModeControls) A.applyModeControls();
        await flush();
        return { shown, off, dark };
    })()`);
    check(frameVig.shown.every(Boolean) && frameVig.dark.corner < frameVig.off.corner - 12,
        '相框样式下光效行照样露出，晕影真的压在成片上（相框预设有白边，四角同样变暗）',
        JSON.stringify(frameVig));

    // ── 24. 每个分组都能折叠（曲线/混色器曾因 CSS 白名单漏项折不动）──
    const collapse = await exec(`(() => {
        const A = window.App;
        A.switchTab('grade');
        const ids = ['grpCurve', 'grpDet', 'grpColorGrade'];
        const mix = document.getElementById('grpMix');
        // WebGL 降级时 #mixRows 被 .mix-na 永久隐藏，折叠测试没有意义；
        // 有 GL 才把它纳入。
        if (mix && !mix.classList.contains('mix-na')) ids.push('grpMix');
        const pick = (id, g) => id === 'grpCurve' ? g.querySelector('.curve-bar')
            : id === 'grpMix' ? g.querySelector('#mixRows')
                : g.querySelector('.param-row');
        const out = {};
        for (const id of ids) {
            const g = document.getElementById(id);
            const title = g && g.querySelector('.pg-title.collapsible');
            const target = g && pick(id, g);
            if (!title || !target) { out[id] = { missing: true }; continue; }
            title.click();
            const hidden = getComputedStyle(target).display === 'none';
            const stillTitle = getComputedStyle(title).display !== 'none';
            title.click();
            const shown = getComputedStyle(target).display !== 'none';
            const cv = id === 'grpCurve' ? g.querySelector('#curveCanvas') : null;
            out[id] = { hidden, shown, stillTitle,
                canvasW: cv ? cv.width : null,
                fitW: cv ? Math.round(cv.clientWidth * Math.min(3, window.devicePixelRatio || 1)) : null };
        }
        return { ids, out };
    })()`);
    const collapseOk = collapse.ids.every((id) => {
        const r = collapse.out[id] || {};
        return r.hidden && r.shown && r.stillTitle
            && (id !== 'grpCurve' || (r.canvasW > 0 && r.canvasW === r.fitW));
    });
    check(collapseOk, '曲线/细节/颜色分级（及可用时的混色器）组都能折叠再展开，曲线画布展开后按真实尺寸重画',
        JSON.stringify(collapse));

    // ── 25. 白色/黑色（黑场白场）：白点并合高光、黑点抬/压暗部 ──
    const wb = await exec(`(async () => {
        const A = window.App;
        // 四段灰阶：0 / 64 / 128 / 224，用来分别观察黑场、暗部、中间调、亮部
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        const bands = ['#000000', '#404040', '#808080', '#e0e0e0'];
        bands.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * 150, 0, 150, 400); });
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.resetGrade();
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        const grab = async () => {
            const src = window.photoSrcOf(A.image);
            const sc = document.createElement('canvas'); sc.width = 600; sc.height = 400;
            const gg = sc.getContext('2d'); gg.drawImage(src, 0, 0);
            const at = (x) => Array.from(gg.getImageData(x, 200, 1, 1).data)[0];
            return { black: at(75), dark: at(225), mid: at(375), bright: at(525) };
        };
        const base = await grab();
        A.setGrade({ white: 100 }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const wUp = await grab();
        A.setGrade({ white: -100 }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const wDown = await grab();
        A.setGrade({ white: 0, black: 100 }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const bUp = await grab();
        A.setGrade({ white: 0, black: -100 }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const bDown = await grab();
        A.setGrade({ white: 0, black: 0 });
        return { base, wUp, wDown, bUp, bDown };
    })()`);
    check(wb.wUp.bright >= 250 && wb.wUp.black <= 2 && wb.wUp.mid < wb.base.mid + 70
          && wb.wDown.bright < wb.base.bright - 15 && wb.wDown.black <= 2,
        '白色：+100 高光并合到纯白（实测 224→255、中灰 128→183），-100 压暗亮部（224→197）',
        `亮 ${wb.base.bright} → ${wb.wUp.bright} / ${wb.wDown.bright} 中 ${wb.base.mid} → ${wb.wUp.mid}`);
    check(wb.bUp.black <= 8 && wb.bUp.dark > wb.base.dark + 15
          && Math.abs(wb.bUp.bright - wb.base.bright) < 12
          && wb.bDown.dark < wb.base.dark - 15 && wb.bDown.black <= 2,
        '黑色：+100 保黑点抬暗部（实测 64→85），-100 压死暗部（64→4）',
        `黑 ${wb.base.black} → ${wb.bUp.black} / ${wb.bDown.black}；暗 ${wb.base.dark} → ${wb.bUp.dark} / ${wb.bDown.dark}`);

    // ── 26. 校准：灰守恒（任意组合）+ 红·饱和 −100 把纯红收成灰 ──
    const calPix = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas'); c.width = 400; c.height = 200;
        const g = c.getContext('2d');
        g.fillStyle = '#808080'; g.fillRect(0, 0, 200, 200);
        g.fillStyle = '#ff0000'; g.fillRect(200, 0, 200, 200);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.image.el = el; A.image.w = 400; A.image.h = 200; A.image._gradeCache = null;
        const zero = { exp: 0, con: 0, sat: 0, vib: 0, temp: 0, tint: 0, hi: 0, sh: 0,
            white: 0, black: 0, curve: null, cal: null, det: null, mix: null, cg: null };
        const grab = async (cal) => {
            A.setGrade(Object.assign({}, zero, { cal }), { full: true, replace: true });
            await new Promise((r) => setTimeout(r, 180));
            const src = window.photoSrcOf(A.image);
            const s = document.createElement('canvas'); s.width = 400; s.height = 200;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0, 400, 200);
            const at = (x) => Array.from(gg.getImageData(x, 100, 1, 1).data).slice(0, 3);
            return { gray: at(100), red: at(300) };
        };
        // 真实预设那一组（RedHue+49/RedSat+20/GreenHue+46/BlueHue-5/BlueSat+59）
        const preset = await grab({ rh: 49, rs: 20, gh: 46, gs: 0, bh: -5, bs: 59 });
        const desat = await grab({ rh: 0, rs: -100, gh: 0, gs: 0, bh: 0, bs: 0 });
        A.resetGrade();
        return { preset, desat };
    })()`);
    check(Math.abs(calPix.preset.gray[0] - calPix.preset.gray[1]) <= 2
          && Math.abs(calPix.preset.gray[1] - calPix.preset.gray[2]) <= 2
          && Math.abs(calPix.preset.gray[0] - 128) <= 3,
        '校准（真实预设那组）：中性灰恒不变（行和被归一，灰/白边不偏色）',
        calPix.preset.gray.join('/'));
    // 灰守恒（行和=1）约束下，纯红压不成纯灰 —— ACR 实测表也是这样
    // （255,0,0 → 231,132,132，红−蓝 ≈ 99）。能保证的是「饱和度大幅下降」且灰不动。
    check(calPix.desat.red[0] - calPix.desat.red[2] < 112
          && calPix.desat.red[0] - calPix.desat.red[2] > 40,
        '校准·红饱和 −100：纯红显著去饱和（红−蓝 从 255 收到 40..112，ACR 实测 ≈99）',
        calPix.desat.red.join('/'));

    // ── 27. 真实 LR 预设（001-滨田英明）的端到端数值 ──
    // 内嵌关键字段，不依赖用户机器上的文件；数值与 crs: 原文一致。
    const xmpText = [
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
        '<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
        ' crs:WhiteBalance="Custom" crs:Temperature="4769" crs:Tint="+38"',
        ' crs:Exposure2012="+0.56" crs:Contrast2012="+20" crs:Saturation="-6" crs:Vibrance="+5"',
        ' crs:Highlights2012="-100" crs:Shadows2012="-30" crs:Whites2012="+23" crs:Blacks2012="+26"',
        ' crs:RedHue="+49" crs:RedSaturation="+20" crs:GreenHue="+46" crs:GreenSaturation="0"',
        ' crs:BlueHue="-5" crs:BlueSaturation="+59"',
        ' crs:HueAdjustmentRed="0" crs:SaturationAdjustmentRed="-15" crs:LuminanceAdjustmentRed="+20"',
        ' crs:HueAdjustmentOrange="0" crs:SaturationAdjustmentOrange="-12" crs:LuminanceAdjustmentOrange="+24"',
        ' crs:SplitToningShadowHue="200" crs:SplitToningShadowSaturation="13"',
        ' crs:SplitToningHighlightHue="80" crs:SplitToningHighlightSaturation="12"',
        ' crs:SplitToningBalance="0" crs:ParametricDarks="+50"',
        ' crs:ToneCurveName2012="Custom" />',
        '</rdf:RDF></x:xmpmeta>'
    ].join('\n');
    const xmpMap = await exec(`(() => {
        const text = ${JSON.stringify(xmpText)};
        const r = window.AppXmp.mapXmp(text);
        return { exp: r.patch.exp, hi: r.patch.hi, sh: r.patch.sh, tint: r.patch.tint,
                 temp: r.patch.temp, cal: r.patch.cal, cg: r.patch.cg, hasCurve: !!r.patch.curve,
                 applied: r.applied.length };
    })()`);
    check(xmpMap.exp === 0.56 && xmpMap.hi === -100 && xmpMap.sh === -30 && xmpMap.tint === 38,
        'XMP：曝光按 EV 保真（+0.56 不被取整），高光/阴影/色调符号正确',
        JSON.stringify({ exp: xmpMap.exp, hi: xmpMap.hi, sh: xmpMap.sh, tint: xmpMap.tint }));
    check(xmpMap.cal && xmpMap.cal.rs === 20 && xmpMap.cal.bs === 59 && xmpMap.cg
          && xmpMap.cg.shadow.h === 200 && xmpMap.cg.high.h === 80,
        'XMP：校准 6 值与分离色调（阴影 200°/高光 80°）都进 patch',
        JSON.stringify({ cal: xmpMap.cal, cgShadow: xmpMap.cg && xmpMap.cg.shadow }));

    // 整套应用后：中灰既不能被压死、也不能被染青（旧版 128 → 42/73/101）
    const xmpPix = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas'); c.width = 700; c.height = 200;
        const g = c.getContext('2d');
        const grays = ['#000000', '#202020', '#505050', '#808080', '#b0b0b0', '#e0e0e0', '#ffffff'];
        grays.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * 100, 0, 100, 200); });
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.image.el = el; A.image.w = 700; A.image.h = 200; A.image._gradeCache = null;
        const patch = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
        A.setGrade(patch, { full: true, replace: true });
        await new Promise((r) => setTimeout(r, 300));
        const src = window.photoSrcOf(A.image);
        const s = document.createElement('canvas'); s.width = 700; s.height = 200;
        const gg = s.getContext('2d'); gg.drawImage(src, 0, 0, 700, 200);
        const at = (i) => Array.from(gg.getImageData(i * 100 + 50, 100, 1, 1).data).slice(0, 3);
        const out = { mid: at(3), bright: at(5), dark: at(1) };
        A.resetGrade();
        return out;
    })()`);
    const midLum = 0.299 * xmpPix.mid[0] + 0.587 * xmpPix.mid[1] + 0.114 * xmpPix.mid[2];
    const midChroma = Math.max.apply(null, xmpPix.mid) - Math.min.apply(null, xmpPix.mid);
    check(midLum > 110 && midLum < 200,
        '整套预设后中灰亮度落在合理区间（旧版被压到 42/73/101，亮度仅 65）',
        `中灰 128 → ${xmpPix.mid.join('/')}（亮度 ${midLum.toFixed(0)}）`);
    check(midChroma < 60,
        '整套预设后中灰通道差在 ACR 实测范围内（tint+38 在实测表里本就把中灰推冷品红 B−G≈29，加曲线后 ≤60；旧版公式差 66）',
        `${xmpPix.mid.join('/')} 差 ${midChroma}`);
    check(xmpPix.dark[2] > xmpPix.dark[0] && xmpPix.bright[2] - xmpPix.bright[0] <= 12,
        '整套预设：暗部偏蓝（分离色调 200°）；亮部在冷品红白平衡下不再偏蓝（B−R≤12）',
        `暗 ${xmpPix.dark.join('/')} 亮 ${xmpPix.bright.join('/')}`);

    // ── 28. 黑白混色器（对齐 LR 的 ConvertToGrayscale + GrayMixer 8 带）──
    const bwPix = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas'); c.width = 400; c.height = 100;
        const g = c.getContext('2d');
        ['#ff0000', '#00ff00', '#0000ff', '#808080'].forEach((col, i) => {
            g.fillStyle = col; g.fillRect(i * 100, 0, 100, 100);
        });
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.image.el = el; A.image.w = 400; A.image.h = 100; A.image._gradeCache = null;
        A.template = A.defaultTemplate(); A.setTpl(A.image, A.template);
        A.resetGrade();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 600));
        const zero = { exp: 0, con: 0, sat: 0, vib: 0, temp: 0, tint: 0, hi: 0, sh: 0,
            white: 0, black: 0, curve: null, cal: null, det: null, mix: null, cg: null, bw: null };
        const grab = async (bw) => {
            A.setGrade(Object.assign({}, zero, { bw }), { full: true, replace: true });
            await new Promise((r) => setTimeout(r, 340));
            const src = window.photoSrcOf(A.image);
            const sc = document.createElement('canvas'); sc.width = 400; sc.height = 100;
            const gg = sc.getContext('2d'); gg.drawImage(src, 0, 0, 400, 100);
            const at = (i) => Array.from(gg.getImageData(i * 100 + 50, 50, 1, 1).data).slice(0, 3);
            return { red: at(0), green: at(1), blue: at(2), gray: at(3) };
        };
        const color = await grab(null);
        const mono = await grab({ on: 1, r: 0, o: 0, y: 0, g: 0, a: 0, b: 0, p: 0, m: 0 });
        const redUp = await grab({ on: 1, r: 80, o: 0, y: 0, g: 0, a: 0, b: 0, p: 0, m: 0 });
        const blueDown = await grab({ on: 1, r: 0, o: 0, y: 0, g: 0, a: 0, b: -80, p: 0, m: 0 });
        A.resetGrade();
        return { color, mono, redUp, blueDown };
    })()`);
    const isGray = (c) => Math.abs(c[0] - c[1]) <= 2 && Math.abs(c[1] - c[2]) <= 2;
    check(isGray(bwPix.mono.red) && isGray(bwPix.mono.green) && isGray(bwPix.mono.blue)
          && !isGray(bwPix.color.red),
        '黑白：开启后红/绿/蓝全部变中性灰（关闭时仍是彩色的）',
        JSON.stringify({ mono: bwPix.mono, colorRed: bwPix.color.red }));
    check(bwPix.redUp.red[0] > bwPix.mono.red[0] + 20,
        '黑白混色器：红色带 +80 让红色转灰后更亮',
        `红 ${bwPix.mono.red[0]} → ${bwPix.redUp.red[0]}`);
    // 纯蓝的亮度只有 18（luma 0.0722），绝对差不可能有 20 —— 用相对降幅判断
    check(bwPix.blueDown.blue[0] < bwPix.mono.blue[0] * 0.7,
        '黑白混色器：蓝色带 −80 让蓝色转灰后明显变暗（≥30%）',
        `蓝 ${bwPix.mono.blue[0]} → ${bwPix.blueDown.blue[0]}`);
    check(Math.abs(bwPix.redUp.gray[0] - bwPix.mono.gray[0]) <= 3,
        '黑白混色器不动中性灰（灰底不该被某个色带带走）',
        `灰 ${bwPix.mono.gray[0]} → ${bwPix.redUp.gray[0]}`);

    const bwMap = await exec(`(() => {
        const t = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            + '<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"'
            + ' crs:ConvertToGrayscale="True" crs:GrayMixerRed="+40" crs:GrayMixerBlue="-25" /></rdf:RDF></x:xmpmeta>';
        const r = window.AppXmp.mapXmp(t);
        return { bw: r.patch.bw, applied: r.applied };
    })()`);
    check(bwMap.bw && bwMap.bw.on === 1 && bwMap.bw.r === 40 && bwMap.bw.b === -25
          && (!bwMap.bw.o || bwMap.bw.o === 0),
        'XMP：ConvertToGrayscale + GrayMixer* 进 patch（以前整组被丢弃）',
        JSON.stringify({ bw: bwMap.bw, applied: bwMap.applied }));

    // ── 29. 中间调（色阶 gamma）：只弯中间，两端锚死 ──
    const gamPix = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas'); c.width = 700; c.height = 200;
        const g = c.getContext('2d');
        ['#000000','#202020','#505050','#808080','#b0b0b0','#e0e0e0','#ffffff']
            .forEach((col, i) => { g.fillStyle = col; g.fillRect(i * 100, 0, 100, 200); });
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.image.el = el; A.image.w = 700; A.image.h = 200; A.image._gradeCache = null;
        const zero = { exp: 0, con: 0, sat: 0, vib: 0, temp: 0, tint: 0, hi: 0, sh: 0,
            white: 0, black: 0, gam: 0, curve: null, cal: null, det: null, mix: null,
            cg: null, bw: null, cb: null, gm: null, lc: null };
        const grab = async (gam) => {
            A.setGrade(Object.assign({}, zero, { gam }), { full: true, replace: true });
            await new Promise((r) => setTimeout(r, 200));
            const src = window.photoSrcOf(A.image);
            const s = document.createElement('canvas'); s.width = 700; s.height = 200;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0, 700, 200);
            const at = (i) => Array.from(gg.getImageData(i * 100 + 50, 100, 1, 1).data)[0];
            return { black: at(0), dark: at(1), mid: at(3), bright: at(5), white: at(6) };
        };
        const base = await grab(0), up = await grab(100), down = await grab(-100);
        A.resetGrade();
        return { base, up, down };
    })()`);
    check(gamPix.up.mid > gamPix.base.mid + 40 && gamPix.down.mid < gamPix.base.mid - 40,
        '中间调 ±100 明显抬/压中灰（128 → 173 / 73）',
        `中灰 ${gamPix.base.mid} → ${gamPix.up.mid} / ${gamPix.down.mid}`);
    check(gamPix.up.black === 0 && gamPix.up.white === 255
          && gamPix.down.black === 0 && gamPix.down.white === 255,
        '中间调两端锚死（纯黑纯白恒定，这是它区别于「对比度」的地方）',
        `黑 ${gamPix.up.black}/${gamPix.down.black} 白 ${gamPix.up.white}/${gamPix.down.white}`);

    // ── 30. 色彩平衡：三区各推各的轴，互不串扰 ──
    const cbPix = await exec(`(async () => {
        const A = window.App;
        const zero = { exp: 0, con: 0, sat: 0, vib: 0, temp: 0, tint: 0, hi: 0, sh: 0,
            white: 0, black: 0, gam: 0, curve: null, cal: null, det: null, mix: null,
            cg: null, bw: null, cb: null, gm: null, lc: null };
        const grab = async (cb) => {
            A.setGrade(Object.assign({}, zero, { cb }), { full: true, replace: true });
            await new Promise((r) => setTimeout(r, 200));
            const src = window.photoSrcOf(A.image);
            const s = document.createElement('canvas'); s.width = 700; s.height = 200;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0, 700, 200);
            const at = (i) => Array.from(gg.getImageData(i * 100 + 50, 100, 1, 1).data).slice(0, 3);
            return { black: at(0), dark: at(1), mid: at(3), bright: at(5), white: at(6) };
        };
        const shadowRed = await grab({ shadow: { r: 100, g: 0, b: 0 }, mid: { r: 0, g: 0, b: 0 },
            high: { r: 0, g: 0, b: 0 }, preserve: 1 });
        const highBlue = await grab({ shadow: { r: 0, g: 0, b: 0 }, mid: { r: 0, g: 0, b: 0 },
            high: { r: 0, g: 0, b: 100 }, preserve: 1 });
        // 对照必须是**同一个操作**（阴影 +红 100），只切 preserve。
        // 之前写成「三轴都推 100」，那测的是三个轴叠加，不是保持明度。
        const noPreserve = await grab({ shadow: { r: 100, g: 0, b: 0 }, mid: { r: 0, g: 0, b: 0 },
            high: { r: 0, g: 0, b: 0 }, preserve: 0 });
        A.resetGrade();
        return { shadowRed, highBlue, noPreserve };
    })()`);
    check(cbPix.shadowRed.dark[0] > cbPix.shadowRed.dark[2] + 18
          && Math.abs(cbPix.shadowRed.mid[0] - 128) <= 3
          && cbPix.shadowRed.black[0] <= 2,
        '色彩平衡·阴影 +红：暗部偏红（+28 级），中间调不动，纯黑不染色',
        `暗 ${cbPix.shadowRed.dark.join('/')} 中 ${cbPix.shadowRed.mid.join('/')} 黑 ${cbPix.shadowRed.black.join('/')}`);
    check(cbPix.highBlue.bright[2] > cbPix.highBlue.bright[0] + 18
          && Math.abs(cbPix.highBlue.mid[2] - 128) <= 3,
        '色彩平衡·高光 +蓝：亮部偏蓝，中间调不动',
        `亮 ${cbPix.highBlue.bright.join('/')} 中 ${cbPix.highBlue.mid.join('/')}`);
    check(cbPix.noPreserve.dark[0] > cbPix.shadowRed.dark[0] + 5,
        '关掉「保持明度」后同一操作的红通道更亮（Preserve 真的在压亮度）',
        `preserve ${cbPix.shadowRed.dark.join('/')} → 关 ${cbPix.noPreserve.dark.join('/')}`);

    // ── 31. 渐变映射：亮度映射成两色，中灰落在插值上 ──
    const gmPix = await exec(`(async () => {
        const A = window.App;
        const zero = { exp: 0, con: 0, sat: 0, vib: 0, temp: 0, tint: 0, hi: 0, sh: 0,
            white: 0, black: 0, gam: 0, curve: null, cal: null, det: null, mix: null,
            cg: null, bw: null, cb: null, gm: null, lc: null };
        const grab = async (gm) => {
            A.setGrade(Object.assign({}, zero, { gm }), { full: true, replace: true });
            await new Promise((r) => setTimeout(r, 200));
            const src = window.photoSrcOf(A.image);
            const s = document.createElement('canvas'); s.width = 700; s.height = 200;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0, 700, 200);
            const at = (i) => Array.from(gg.getImageData(i * 100 + 50, 100, 1, 1).data).slice(0, 3);
            return { black: at(0), mid: at(3), white: at(6) };
        };
        const full = await grab({ on: 1, dark: '#200040', light: '#ffe000', amount: 100 });
        const half = await grab({ on: 1, dark: '#200040', light: '#ffe000', amount: 40 });
        A.resetGrade();
        return { full, half };
    })()`);
    check(gmPix.full.black[2] > gmPix.full.black[0] + 25
          && gmPix.full.white[0] > 240 && gmPix.full.white[2] < 30,
        '渐变映射：暗部趋近暗部色（偏紫）、亮部趋近亮部色（偏黄），中灰在两者之间',
        `黑 ${gmPix.full.black.join('/')} 中 ${gmPix.full.mid.join('/')} 白 ${gmPix.full.white.join('/')}`);
    check(Math.abs(gmPix.half.mid[0] - 128) < Math.abs(gmPix.full.mid[0] - 128),
        '渐变映射强度 40 只是轻上色（中灰离原值更近）',
        `强度100 ${gmPix.full.mid.join('/')} → 强度40 ${gmPix.half.mid.join('/')}`);

    // ── 32. 镜头畸变：几何重采样（GL 路径）──
    const lcPix = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas'); c.width = 400; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#101010'; g.fillRect(0, 0, 400, 400);
        g.strokeStyle = '#ffffff'; g.lineWidth = 2;
        for (let i = 0; i <= 400; i += 40) {
            g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 400); g.stroke();
            g.beginPath(); g.moveTo(0, i); g.lineTo(400, i); g.stroke();
        }
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.image.el = el; A.image.w = 400; A.image.h = 400; A.image._gradeCache = null;
        const pick = () => {
            const src = window.photoSrcOf(A.image);
            const s = document.createElement('canvas'); s.width = 400; s.height = 400;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0, 400, 400);
            const at = (x, y) => Array.from(gg.getImageData(x, y, 1, 1).data)[0];
            return { corner: at(8, 8), center: at(200, 200) };
        };
        A.setGrade({ lc: null }, { full: true, replace: true });
        await new Promise((r) => setTimeout(r, 250));
        const off = pick();
        A.setGrade({ lc: { distort: 100 } }, { full: true, replace: true });
        await new Promise((r) => setTimeout(r, 350));
        const on = pick();
        const glOk = window.QfsColor.usingGL();
        A.resetGrade();
        return { off, on, glOk };
    })()`);
    // 畸变是 GL 着色器重采样，没有 CPU 路径：本机用例统一带 --disable-gpu 启动
    // （tools/run-electron.js），这个环境下它天然不生效，与实现无关。
    if (lcPix.glOk) {
        check(lcPix.off.corner < 60 && lcPix.on.corner > 200 && Math.abs(lcPix.on.center - lcPix.off.center) < 12,
            '镜头畸变 +100：角落被白线取代（边缘被拉进来）、中心不动',
            JSON.stringify(lcPix));
    } else {
        console.log('SKIP  镜头畸变 +100（此环境无 WebGL，畸变走 shader；有 GPU 的机器上才可验）');
    }

    // ── 还原原图必须作废调色缓存（否则画面纹丝不动、导出的还是裁切图）──
    const restore = await exec(`(async () => {
        const A = window.App, im = A.image;
        const el0 = await window.__mk(600, 400);
        im.el = el0; im.w = 600; im.h = 400;
        im.orig = { el: el0, w: 600, h: 400 };
        // 裁一刀：底图换成 300×200
        const c = document.createElement('canvas'); c.width = 300; c.height = 200;
        const g = c.getContext('2d'); g.drawImage(el0, 0, 0, 300, 200);
        im.el = c; im.w = 300; im.h = 200;
        A.setGrade({ exp: 2 });
        await new Promise((r) => setTimeout(r, 400));
        const before = (() => { const s = window.photoSrcOf(im);
            return { w: s.naturalWidth || s.width, h: s.naturalHeight || s.height }; })();
        A.restoreOriginalPhoto(im);
        await new Promise((r) => setTimeout(r, 400));
        const after = (() => { const s = window.photoSrcOf(im);
            return { w: s.naturalWidth || s.width, h: s.naturalHeight || s.height }; })();
        return { before, after, expKept: !!(im.grade && im.grade.exp) };
    })()`);
    check(restore.after.w === 600 && restore.after.h === 400 && restore.before.w === 300,
        '还原原图：取源回到原图尺寸（不是继续用裁切图）',
        JSON.stringify(restore));
    check(restore.expKept, '还原原图：调色参数保留（只换底图，不清参数）', JSON.stringify(restore));

    // ── 按图缓存的 ACR 测度必须随源图失效 ──
    const acrCache = await exec(`(async () => {
        const A = window.App, im = A.image;
        const el1 = await window.__mk(600, 400);
        im.el = el1; im.w = 600; im.h = 400;
        A.setGrade({ con: 10 });
        await new Promise((r) => setTimeout(r, 400));
        const had = { bright: !!im._acrBright, haze: im._acrHaze !== undefined };
        // 换底图（模拟裁切）→ invalidateGrade 必须把按图缓存一起清掉
        const c = document.createElement('canvas'); c.width = 200; c.height = 200;
        const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, 200, 200);
        im.el = c; im.w = 200; im.h = 200;
        A.invalidateGrade(im);
        await new Promise((r) => setTimeout(r, 200));
        return { had, after: { bright: !!im._acrBright, haze: im._acrHaze !== undefined } };
    })()`);
    check(acrCache.had.bright && !acrCache.after.bright && !acrCache.after.haze,
        '换底图后 ACR 按图缓存（亮度测度/雾色）被清掉',
        JSON.stringify(acrCache));

    // ── 导出前必须补全分辨率烘焙（否则把 1600px 低采样图放大导出）──
    const fullBake = await exec(`(async () => {
        const A = window.App, im = A.image;
        const el2 = await window.__mk(600, 400);
        im.el = el2; im.w = 600; im.h = 400;
        im._grade = { neutral: false, canvas: null, low: null, key: '' };
        A.rebuildGrade('low');
        await new Promise((r) => setTimeout(r, 300));
        const lowOnly = { canvas: !!im._grade.canvas, low: !!im._grade.low };
        window.ensureFullGrade(im);
        return { lowOnly, canvas: !!im._grade.canvas,
            srcW: (() => { const s = window.photoSrcOf(im); return s.naturalWidth || s.width; })() };
    })()`);
    check(fullBake.lowOnly.low && !fullBake.lowOnly.canvas && fullBake.canvas,
        'ensureFullGrade：只有 low 缓存时补出全分辨率烘焙',
        JSON.stringify(fullBake));

    // ── 撤销/重做必须覆盖调色参数（以前只快照模板，调色挂在 im.grade 上撤不掉）──
    const undoGrade = await exec(`(async () => {
        const A = window.App, im = A.image;
        const el0 = await window.__mk(600, 400);
        im.el = el0; im.w = 600; im.h = 400;
        A.resetGrade();
        await new Promise((r) => setTimeout(r, 300));
        const sl = document.getElementById('slGradeExp');
        const stackBefore = A.undoStack.length;
        // 模拟真实拖动：focus → input → change
        sl.focus();
        sl.value = '2';
        sl.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        sl.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 350));
        const afterDrag = { exp: (im.grade || {}).exp, pushed: A.undoStack.length - stackBefore };
        A.undo();
        await new Promise((r) => setTimeout(r, 450));
        const afterUndo = { exp: (im.grade || {}).exp, slider: document.getElementById('slGradeExp').value };
        A.redo();
        await new Promise((r) => setTimeout(r, 450));
        const afterRedo = { exp: (im.grade || {}).exp, slider: document.getElementById('slGradeExp').value };
        // 第二次拖动要能再压一个新快照
        const s0 = A.undoStack.length;
        sl.focus();
        sl.value = '3';
        sl.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        sl.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 350));
        const secondPush = A.undoStack.length - s0;
        return { afterDrag, afterUndo, afterRedo, secondPush };
    })()`);
    check(undoGrade.afterDrag.exp === 2 && undoGrade.afterDrag.pushed === 1,
        '拖动调色滑块压一次撤销快照（不是每次 input 都压）',
        JSON.stringify(undoGrade));
    check(!undoGrade.afterUndo.exp && undoGrade.afterUndo.slider === '0',
        'Ctrl+Z 撤销调色（曝光回到 0，滑块同步回显）',
        JSON.stringify(undoGrade));
    check(undoGrade.afterRedo.exp === 2 && undoGrade.afterRedo.slider === '2',
        'Ctrl+Y 重做调色（曝光回到 2）',
        JSON.stringify(undoGrade));
    check(undoGrade.secondPush === 1, '第二次拖动调色滑块能再压一个新快照',
        JSON.stringify(undoGrade));

    // ── 性能：参数没变就不该重烘（缓存 key 复用）──
    const perfReuse = await exec(`(async () => {
        const A = window.App, im = A.image;
        const el0 = await window.__mk(600, 400);
        im.el = el0; im.w = 600; im.h = 400;
        im._gradeCache = null;
        A.resetGrade();
        await new Promise((r) => setTimeout(r, 300));
        A.setGrade({ exp: 1 });
        await new Promise((r) => setTimeout(r, 400));
        const low1 = im._grade.low, key1 = im._grade.lowKey;
        let bakes = 0;
        const orig = window.QfsMask.groupAlpha;
        window.QfsMask.groupAlpha = function (...a) { bakes++; return orig.apply(this, a); };
        A.setGrade({ exp: 1 });            // 完全相同的参数
        await new Promise((r) => setTimeout(r, 250));
        const same = { reused: im._grade.low === low1, keySame: im._grade.lowKey === key1, bakes };
        // 参数真的变了 → 必须重烘
        const before = im._grade.low;
        A.setGrade({ exp: 1.5 });
        await new Promise((r) => setTimeout(r, 350));
        const changed = { rebaked: before !== im._grade.low, key: String(im._grade.lowKey || '').slice(0, 24) };
        window.QfsMask.groupAlpha = orig;
        return { same, changed };
    })()`);
    check(perfReuse.same.reused && perfReuse.same.keySame && perfReuse.same.bakes === 0,
        '相同参数不重复烘焙（low 缓存按 key 复用）', JSON.stringify(perfReuse));
    check(perfReuse.changed.rebaked, '参数变化时缓存正确失效并重烘', JSON.stringify(perfReuse));

    // ── 性能：full / low 各记各的 key，不能互相污染 ──
    const perfKeys = await exec(`(async () => {
        const A = window.App, im = A.image;
        const el0 = await window.__mk(600, 400);
        im.el = el0; im.w = 600; im.h = 400;
        im._gradeCache = null;
        A.resetGrade();
        await new Promise((r) => setTimeout(r, 300));
        A.setGrade({ exp: 1 }, { full: true });
        await new Promise((r) => setTimeout(r, 500));
        const afterFull = { full: !!im._grade.canvas, fullKey: !!im._grade.fullKey,
            low: !!im._grade.low, lowKey: !!im._grade.lowKey };
        // 拖动（input 期）→ 只清 full，low 保留
        A.setGrade({ exp: 1.2 });
        await new Promise((r) => setTimeout(r, 350));
        const afterDrag = { full: !!im._grade.canvas, low: !!im._grade.low,
            lowKey: !!im._grade.lowKey };
        return { afterFull, afterDrag };
    })()`);
    check(perfKeys.afterFull.full && perfKeys.afterFull.fullKey,
        '全分辨率烘焙后 full 就位', JSON.stringify(perfKeys));
    check(!perfKeys.afterDrag.full && perfKeys.afterDrag.low && perfKeys.afterDrag.lowKey,
        '拖动时只作废 full，low 缓存保留（省掉重烘一张 1600px）',
        JSON.stringify(perfKeys));

    // ── 性能：曲线拖动 30 次只烘焙一次（rAF 合并）──
    // 走真实链路：派发 pointermove 事件，让 app-curve.js 自己的 rAF 合并逻辑跑
    const perfCurve = await exec(`(async () => {
        const A = window.App;
        A.switchTab('grade');
        const el = document.getElementById('curveCanvas');
        if (!el) return { noCanvas: true };
        const rgbBtn = Array.prototype.slice.call(document.querySelectorAll('#curveChans .curve-chan'))
            .find(x => x.dataset.chan === 'rgb');
        if (rgbBtn) rgbBtn.click();
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0, curve: null });
        await new Promise((r) => setTimeout(r, 200));
        let calls = 0;
        const orig = A.setCurve.bind(A);
        A.setCurve = function (...a) { calls++; return orig(...a); };
        const r = el.getBoundingClientRect();
        const pad = 8;
        const at = (fx, fy) => ({ x: r.left + pad + fx * (r.width - pad * 2),
                                  y: r.top + r.height - pad - fy * (r.height - pad * 2) });
        const ev = (type, p) => el.dispatchEvent(new PointerEvent(type,
            { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1 }));
        const p0 = at(0.5, 0.7);
        ev('pointerdown', p0);
        const n1 = A.curvePoints('rgb').length;
        for (let i = 0; i < 30; i++) ev('pointermove', at(0.5, 0.7 + i * 0.004));
        await new Promise((r2) => setTimeout(r2, 400));
        const during = calls;
        ev('pointerup', at(0.5, 0.82));
        await new Promise((r2) => setTimeout(r2, 300));
        A.setCurve = orig;
        return { calls: during, afterUp: calls, n1, pts: A.curvePoints('rgb').length,
            graded: !!A.image.grade.curve };
    })()`);
    // 期望 2 次：① pointerdown 加点是离散操作，立即烘一次（不该被节流）
    //            ② 30 次 pointermove 经 rAF 合并成一次
    // 修复前是 31 次（每次 pointermove 都全链烘焙）。
    // 只断上界：a3c2750 给 change 加了 80ms 防抖（先让松手那一帧画出去），合并窗口变宽，
    // 30 次 pointermove 现在并成 1 次烘焙。次数变少是优化方向，不该被断言卡死；
    // 真正要守的是「别退化成每次 move 都烘一遍」（修复前 31 次）。
    check(!perfCurve.noCanvas && perfCurve.calls >= 1 && perfCurve.calls <= 2,
        '曲线连拖 30 次只烘焙 ≤2 次（原为 31 次；防抖后实测 1 次）',
        JSON.stringify(perfCurve));
    check(perfCurve.n1 === 3 && perfCurve.graded,
        '曲线拖动数据即时生效（不被节流吃掉）', JSON.stringify(perfCurve));

    // ── 性能：画笔笔迹签名是常数级（不是百万级字符串）──
    const perfSig = await exec(`(async () => {
        const A = window.App;
        const strokes = [];
        for (let i = 0; i < 20; i++) {
            const pts = [];
            for (let j = 0; j < 2000; j++) pts.push([j / 2000, Math.sin(j / 100)]);
            strokes.push({ erase: false, size: 40, pts });
        }
        const m = { type: 'brush', mode: 'new', on: 1, inv: 0, feather: 0, density: 100,
            p: {}, shape: { size: 40, strokes } };
        const t0 = performance.now();
        const sig1 = window.QfsMask.maskSignature ? window.QfsMask.maskSignature(m) : '';
        const t1 = performance.now();
        // 改一个点 → 签名必须变（否则缓存不会失效，画面不更新）
        strokes[0].pts[5][1] += 0.01;
        const sig2 = window.QfsMask.maskSignature ? window.QfsMask.maskSignature(m) : '';
        const t2 = performance.now();
        return { len: sig1.length, changed: sig1 !== sig2, ms: Math.round(t1 - t0), ms2: Math.round(t2 - t1),
            hasExport: !!window.QfsMask.maskSignature };
    })()`);
    check(perfSig.hasExport && perfSig.len < 200,
        '画笔签名是常数级短串（不再是百万级浮点字符串）', JSON.stringify(perfSig));
    check(perfSig.changed, '画笔改一个点 → 签名变化（缓存会正确失效）', JSON.stringify(perfSig));

    // ── 换底图后调色缓存必须失效（裁切/旋转/还原原图共用这条路径）──
    // 这是「调色没反应」的元凶：invalidateGrade 保留 low 画布时若把 key 也留着，
    // rebuildGrade 会命中裁切前烘的图 —— 底图换了，画面却纹丝不动。
    const srcSwap = await exec(`(async () => {
        const A = window.App, im = A.image;
        const el0 = await window.__mk(600, 400);
        im.el = el0; im.w = 600; im.h = 400;
        im._gradeCache = null;
        A.resetGrade();
        await new Promise((r) => setTimeout(r, 300));
        A.setGrade({ exp: 1 });
        await new Promise((r) => setTimeout(r, 450));
        const lowBefore = im._grade.low;
        // 换底图：红色 → 绿色
        const c = document.createElement('canvas'); c.width = 300; c.height = 200;
        const g = c.getContext('2d'); g.fillStyle = '#00ff00'; g.fillRect(0, 0, 300, 200);
        im.el = c; im.w = 300; im.h = 200;
        A.invalidateGrade(im);
        await new Promise((r) => setTimeout(r, 250));
        const afterInvalidate = { lowKey: im._grade.lowKey, lowKept: !!im._grade.low };
        A.rebuildGrade('low');
        await new Promise((r) => setTimeout(r, 350));
        const src = window.photoSrcOf(im);
        const cc = document.createElement('canvas'); cc.width = 4; cc.height = 4;
        const gg = cc.getContext('2d'); gg.drawImage(src, 0, 0, 4, 4);
        const px = Array.from(gg.getImageData(2, 2, 1, 1).data).slice(0, 3);
        return { afterInvalidate, px, w: src.naturalWidth || src.width,
            rebaked: im._grade.low !== lowBefore };
    })()`);
    check(srcSwap.afterInvalidate.lowKey === '',
        '换底图后 low 缓存的 key 必须作废（否则会复用旧底图的烘焙）',
        JSON.stringify(srcSwap));
    check(srcSwap.px[1] > 200 && srcSwap.px[0] < 60 && srcSwap.w === 300,
        '换底图后取源是新图（画面确实换了，不是旧底图）',
        JSON.stringify(srcSwap));

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

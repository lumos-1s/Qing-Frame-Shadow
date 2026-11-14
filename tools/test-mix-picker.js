// 混色器吸管（对齐 LR 的目标调整工具 TAT）—— 真实 Electron 渲染进程回归
//   node tools/run-electron.js tools/test-mix-picker.js
//
// 验证：
//  ① 吸管按钮存在且挂在混色器组内，默认未激活
//  ② 激活后画布进入十字光标态（#canvasPane.mix-picking），按钮 .active
//  ③ 取色命中：红/黄/绿/蓝四个色块分别锁到 r/y/g/b 带（与着色器同一套权重）
//  ④ 照片外的点返回 null（不会误锁色带）
//  ⑤ 单击不改数值（只锁色带）
//  ⑥ 上下拖动只改「当前子页」的指标：色相页拖 +100px → r.h = +50
//  ⑦ 切到饱和度页再拖 → r.s 变，r.h 保持 ⑥ 的结果
//  ⑧ Esc 退出吸管，光标态解除
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
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(channel, EMPTY_LIST);
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
ipcMain.handle('load-acr-shadows', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.25', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

// 四色横条图：红 / 黄 / 绿 / 蓝，每块 200px（800×500）
const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w || 800; c.height = h || 500;
    const g = c.getContext('2d');
    const cols = ['#ff0000', '#ffff00', '#00ff00', '#0000ff'];
    cols.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * 200, 0, 200, 500); });
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

async function main() {
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
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    // 造图并摆成已导入状态（默认模板，照片不被裁切）
    const s = await exec(`(async () => {
        const A = window.App;
        if (!A._mixPick && A.initGrade) A.initGrade();
        const makeImage = ${MAKE_IMAGE};
        const el = await makeImage(800, 500);
        const im = { el, name: '混色器吸管.png', path: null, w: 800, h: 500, exif: {}, customSettings: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.selectedIdx = [0]; A.batchSel = [0];
        A.template = A.defaultTemplate();
        A.setTpl(im, A.template);
        A.updateEmptyState();
        A.scheduleRender(true);
        await A.flushRender();
        await new Promise((r) => setTimeout(r, 140));
        return { inited: !!A._mixPick, pr: A._photoRect, base: A._baseSize() };
    })()`);
    check(s.inited === true, '⓪ 吸管模块已初始化', `inited=${s.inited}`);
    check(!!s.pr && s.pr.w > 0, '⓪ 渲染后拿到照片矩形', `pr=${s.pr ? `${s.pr.x.toFixed(0)},${s.pr.y.toFixed(0)} ${s.pr.w.toFixed(0)}×${s.pr.h.toFixed(0)}` : 'null'}`);

    /* ① 按钮存在且挂在混色器组内 */
    const btn = await exec(`(() => {
        const b = document.getElementById('btnMixPick');
        if (!b) return { exists: false };
        return { exists: true, inMix: !!b.closest('#grpMix'), active: b.classList.contains('active'),
                 label: b.textContent.trim() };
    })()`);
    check(btn.exists && btn.inMix, '① 吸管按钮在混色器组内', `inMix=${btn.inMix}`);
    check(btn.active === false, '① 默认未激活', `active=${btn.active}`);

    /* ② 激活 → 画布十字光标态 */
    await exec(`document.getElementById('btnMixPick').click()`);
    const on = await exec(`(() => {
        const A = window.App;
        return { on: !!A._mixPick.on, btnActive: document.getElementById('btnMixPick').classList.contains('active'),
                 panePicking: document.getElementById('canvasPane').classList.contains('mix-picking'),
                 cursor: getComputedStyle(A.dom.canvas).cursor };
    })()`);
    check(on.on === true && on.btnActive === true, '② 点击按钮进入吸管模式', `on=${on.on} btn=${on.btnActive}`);
    check(on.panePicking === true && on.cursor === 'crosshair', '② 画布切到十字光标', `picking=${on.panePicking} cursor=${on.cursor}`);

    /* ③ 四个色块分别命中 r/y/g/b */
    const hits = await exec(`(() => {
        const A = window.App, cv = A.dom.canvas;
        const ptOf = (nx, ny) => {
            const rect = cv.getBoundingClientRect();
            const base = A._baseSize();
            const pr = A._photoRect;
            const bx = pr.x + nx * pr.w, by = pr.y + ny * pr.h;
            return { clientX: rect.left + bx / base.w * rect.width,
                     clientY: rect.top + by / base.h * rect.height };
        };
        const probe = (nx) => {
            const s = A._mixPickSample(ptOf(nx, 0.5));
            return s ? { band: s.band.k, hue: Math.round(s.hue), flat: s.flat } : null;
        };
        return { red: probe(0.125), yellow: probe(0.375), green: probe(0.625), blue: probe(0.875) };
    })()`);
    check(hits.red && hits.red.band === 'r', '③ 红块命中「红色」带', hits.red ? `band=${hits.red.band} hue=${hits.red.hue}` : 'null');
    check(hits.yellow && hits.yellow.band === 'y', '③ 黄块命中「黄色」带', hits.yellow ? `band=${hits.yellow.band} hue=${hits.yellow.hue}` : 'null');
    check(hits.green && hits.green.band === 'g', '③ 绿块命中「绿色」带', hits.green ? `band=${hits.green.band} hue=${hits.green.hue}` : 'null');
    check(hits.blue && hits.blue.band === 'b', '③ 蓝块命中「蓝色」带', hits.blue ? `band=${hits.blue.band} hue=${hits.blue.hue}` : 'null');

    /* ④ 归一化越界（照片/画布外的点）一律返回 null，不会误锁色带 */
    const outside = await exec(`(() => {
        const A = window.App, cv = A.dom.canvas;
        const rect = cv.getBoundingClientRect();
        const base = A._baseSize();
        const pr = A._photoRect;
        const mk = (nx, ny) => {
            const bx = pr.x + nx * pr.w, by = pr.y + ny * pr.h;
            return { clientX: rect.left + bx / base.w * rect.width,
                     clientY: rect.top + by / base.h * rect.height };
        };
        return { beyond: A._mixPickSample(mk(1.5, 0.5)) === null,
                 negative: A._mixPickSample(mk(-0.4, 0.5)) === null };
    })()`);
    check(outside.beyond === true, '④ 右侧越界的点返回 null', `nulled=${outside.beyond}`);
    check(outside.negative === true, '④ 左侧越界的点返回 null', `nulled=${outside.negative}`);

    /* ⑤ 单击（不移动）只锁色带，不动数值 */
    const click = await exec(`(async () => {
        const A = window.App, cv = A.dom.canvas, st = A._mixPick;
        const ptOf = (nx, ny) => {
            const rect = cv.getBoundingClientRect();
            const base = A._baseSize();
            const pr = A._photoRect;
            const bx = pr.x + nx * pr.w, by = pr.y + ny * pr.h;
            return { clientX: rect.left + bx / base.w * rect.width,
                     clientY: rect.top + by / base.h * rect.height };
        };
        const p = ptOf(0.125, 0.5);
        const before = JSON.stringify((A.gradeOf(A.image).mix || {}));
        cv.dispatchEvent(new MouseEvent('mousedown', Object.assign({ button: 0, bubbles: true, cancelable: true }, p)));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 60));
        const after = JSON.stringify((A.gradeOf(A.image).mix || {}));
        return { before, after, band: st.band ? st.band.k : null,
                 hot: !!document.querySelector('#mixRows .mix-row.mix-hot'),
                 status: (A.dom.stCanvas ? A.dom.stCanvas.textContent : '') };
    })()`);
    check(click.before === click.after && click.band === 'r', '⑤ 单击只锁色带、不改数值',
        `before=${click.before} after=${click.after} band=${click.band}`);
    check(click.hot === true, '⑤ 命中的色带行被高亮', `hot=${click.hot}`);
    check(String(click.status).indexOf('已选中') >= 0, '⑤ 状态栏给出选中反馈', `status=${click.status}`);

    /* ⑥ 色相页拖动 +100px → r.h = +50（灵敏度 0.5/px） */
    const dragH = await exec(`(async () => {
        const A = window.App, cv = A.dom.canvas, st = A._mixPick;
        const ptOf = (nx, ny) => {
            const rect = cv.getBoundingClientRect();
            const base = A._baseSize();
            const pr = A._photoRect;
            const bx = pr.x + nx * pr.w, by = pr.y + ny * pr.h;
            return { clientX: rect.left + bx / base.w * rect.width,
                     clientY: rect.top + by / base.h * rect.height };
        };
        const p = ptOf(0.125, 0.5);
        cv.dispatchEvent(new MouseEvent('mousedown', Object.assign({ button: 0, bubbles: true, cancelable: true }, p)));
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: p.clientX, clientY: p.clientY - 100, bubbles: true, cancelable: true }));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        const mix = A.gradeOf(A.image).mix || {};
        return { h: mix.r ? mix.r.h : 0, s: mix.r ? mix.r.s : 0, metric: st.metric, moved: st.moved,
                 slider: document.getElementById('slMixRH').value };
    })()`);
    check(dragH.h === 50, '⑥ 色相页上拖 +100px → 红色色相 +50', `h=${dragH.h} metric=${dragH.metric}`);
    check(dragH.slider === '50', '⑥ 面板滑块同步到 +50', `slider=${dragH.slider}`);

    /* ⑦ 切到饱和度页再拖 +60px → r.s = +30，r.h 不变 */
    const dragS = await exec(`(async () => {
        const A = window.App, cv = A.dom.canvas, st = A._mixPick;
        // ⑥ 把红色色相推到了 +50，画面里那块已经偏橙；吸管按「看到的颜色」取样，
        // 再点同一处会命中橙色带。先清零，让 ⑦ 从原始红色重新开始。
        A.setGrade({ mix: null });
        await new Promise((r) => setTimeout(r, 700));
        document.querySelector('#mixMetrics [data-m="s"]').click();
        await new Promise((r) => setTimeout(r, 40));
        const ptOf = (nx, ny) => {
            const rect = cv.getBoundingClientRect();
            const base = A._baseSize();
            const pr = A._photoRect;
            const bx = pr.x + nx * pr.w, by = pr.y + ny * pr.h;
            return { clientX: rect.left + bx / base.w * rect.width,
                     clientY: rect.top + by / base.h * rect.height };
        };
        const p = ptOf(0.125, 0.5);
        cv.dispatchEvent(new MouseEvent('mousedown', Object.assign({ button: 0, bubbles: true, cancelable: true }, p)));
        // 色带已锁定，再把色相设回 +50：验证拖饱和度不会把色相覆盖掉
        A.setGrade({ mix: { r: { h: 50, s: 0, l: 0 } } });
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: p.clientX, clientY: p.clientY - 60, bubbles: true, cancelable: true }));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        const mix = A.gradeOf(A.image).mix || {};
        return { h: mix.r ? mix.r.h : 0, s: mix.r ? mix.r.s : 0, metric: st.metric,
                 band: st.band ? st.band.k : null, hue: Math.round(st.hue || 0),
                 sliderS: document.getElementById('slMixRS').value };
    })()`);
    check(dragS.s === 30, '⑦ 饱和度页上拖 +60px → 红色饱和 +30', `s=${dragS.s} metric=${dragS.metric} band=${dragS.band} hue=${dragS.hue}`);
    check(dragS.h === 50, '⑦ 色相数值未被覆盖', `h=${dragS.h}`);
    check(dragS.sliderS === '30', '⑦ 饱和度滑块同步到 +30', `slider=${dragS.sliderS}`);

    /* ⑧ Esc 退出 */
    const off = await exec(`(async () => {
        const A = window.App;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
        return { on: !!A._mixPick.on, btnActive: document.getElementById('btnMixPick').classList.contains('active'),
                 picking: document.getElementById('canvasPane').classList.contains('mix-picking'),
                 hot: !!document.querySelector('#mixRows .mix-row.mix-hot') };
    })()`);
    check(off.on === false && off.btnActive === false, '⑧ Esc 退出吸管模式', `on=${off.on} btn=${off.btnActive}`);
    check(off.picking === false, '⑧ 画布十字光标态解除', `picking=${off.picking}`);
    check(off.hot === false, '⑧ 色带高亮清除', `hot=${off.hot}`);
    /* ⑨ 侧栏三个宽度下，吸管按钮不挤坏「色相/饱和度/明亮度」子页 */
    const layout = await exec(`(() => {
        const insp = document.getElementById('inspector');
        if (window.App.switchTab) window.App.switchTab('grade');
        const grp = document.getElementById('grpMix');
        const hadNa = grp.classList.contains('mix-na');
        if (hadNa) grp.classList.remove('mix-na');
        const diag = { inspW: Math.round(insp.getBoundingClientRect().width),
                       panelCls: document.getElementById('panel-grade').className,
                       grpCls: grp.className, grpDisplay: getComputedStyle(grp).display,
                       grpW: Math.round(grp.getBoundingClientRect().width) };
        const out = [];
        for (const w of [260, 308, 440]) {
            insp.style.width = w + 'px';
            const bar = document.querySelector('#grpMix .curve-bar');
            const chans = document.getElementById('mixMetrics');
            const pick = document.getElementById('btnMixPick');
            const pr = pick.getBoundingClientRect();
            out.push({
                w,
                over: bar.scrollWidth - bar.clientWidth,
                pickW: Math.round(pr.width),
                pickH: Math.round(pr.height),
                chanW: Math.round(chans.getBoundingClientRect().width)
            });
        }
        insp.style.width = '';
        if (hadNa) grp.classList.add('mix-na');
        return { diag, out };
    })()`);
    console.log('    [layout-diag] ' + JSON.stringify(layout.diag));
    for (const l of layout.out) {
        check(l.over <= 1, `⑨ ${l.w}px 栏宽下混色器标题行不溢出`, `over=${l.over} pick=${l.pickW} chans=${l.chanW}`);
        check(l.pickW >= 38 && l.pickH <= 30, `⑨ ${l.w}px 栏宽下吸管按钮尺寸正常`, `w=${l.pickW} h=${l.pickH}`);
        check(l.chanW >= 80, `⑨ ${l.w}px 栏宽下三个子页仍有可用宽度`, `chans=${l.chanW}`);
    }


    if (failures.length) {
        console.log(`FAILED: ${failures.length}`);
        app.exit(1);
    } else {
        console.log('ALL PASS');
        app.exit(0);
    }
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });

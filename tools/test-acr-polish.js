// 参考 Lightroom / Camera Raw 补的六个信息设计细节，回归用。
// 用法：node tools/run-electron.js tools/test-acr-polish.js
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
    .filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); }
    catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'quit-and-install', 'open-external', 'open-data-dir',
    'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) {
    ipcMain.handle(c, () => ({ canceled: true }));
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.25', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label);
}

const PROBE = `(async () => {
    const A = window.App;
    const $ = (id) => document.getElementById(id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!A) return { missing: true };
    await A.loadPresets();
    try {
        localStorage.removeItem('qfs_preset_groups');
        localStorage.removeItem('qfs_side_mode');
    } catch (_) {}
    A.setSideMode('border');

    const solid = async (color, w, h) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = color;
        g.fillRect(0, 0, w, h);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.src = c.toDataURL(); });
        return el;
    };
    const mk = (el, name) => ({ el, name, w: el.naturalWidth, h: el.naturalHeight, exif: {}, thumb: '', customSettings: null, grade: null });

    // 三张照片：当前张调过色并挂了模板，用来验证复制/粘贴设置
    const els = await Promise.all([solid('#808080', 80, 60), solid('#606060', 80, 60), solid('#a0a0a0', 80, 60)]);
    const imgs = [mk(els[0], 'city.jpg'), mk(els[1], 'desert.jpg'), mk(els[2], 'forest.jpg')];
    A.images = imgs; A.currentIdx = 0; A.image = imgs[0];
    A.selectedIdx = [0]; A.batchSel = []; A.imageTemplates = new Map();
    const tpl = JSON.parse(JSON.stringify(A.presets[0]));
    imgs.forEach((im) => A.imageTemplates.set(im, JSON.parse(JSON.stringify(tpl))));
    A.template = A.getTpl(imgs[0]);
    A.buildThumbnails(); A.updateEmptyState(); A.afterImageSelect(); A.switchTab('grade');
    await wait(250);

    // ── 1. 剪切统计口径：任一通道到端点就算，纯黑/纯白只是细分 ──
    const H = window.QfsHistogram;
    const half = document.createElement('canvas');
    half.width = 60; half.height = 40;
    const hg = half.getContext('2d');
    hg.fillStyle = '#000'; hg.fillRect(0, 0, 30, 40);
    hg.fillStyle = '#fff'; hg.fillRect(30, 0, 30, 40);
    const halfEl = new Image();
    await new Promise((r) => { halfEl.onload = r; halfEl.src = half.toDataURL(); });
    const halfIm = mk(halfEl, 'half.png');
    const redEl = await solid('#ff0000', 40, 40);
    const redIm = mk(redEl, 'red.png');
    const halfClip = H.clipOf(halfIm);
    const redClip = H.clipOf(redIm);
    // 空图/无源对象不应抛异常（旧版 statsOf/clipOf 会对 null 源直接取 naturalWidth）
    let emptySafe = false;
    try { emptySafe = H.statsOf({}) === null && H.clipOf({}) === null; } catch (e) { emptySafe = false; }
    H.refresh(halfIm);
    await wait(260);
    const lo = $('gradeClipLo'), hi = $('gradeClipHi');
    const numLo = $('gradeClipNumLo'), numHi = $('gradeClipNumHi');
    const clipOn = lo.classList.contains('is-on') && hi.classList.contains('is-on');
    const clipText = lo.title + ' | ' + hi.title;
    const clipPct = parseFloat(lo.dataset.pct);
    const clipNums = { lo: numLo.textContent, hi: numHi.textContent,
        visible: !numLo.hidden && !numHi.hidden };
    lo.click();
    const marked = H.clipMarked() && lo.classList.contains('is-mark') && hi.classList.contains('is-mark');
    lo.click();
    const unmarked = !H.clipMarked();

    // ── 2. 标题栏文件名 + 前后张快捷键 ──
    A.updateStatusBar();
    const tf = $('titlebarFile');
    const fileText = tf.textContent;
    const fileVisible = !tf.hidden && getComputedStyle(tf).pointerEvents === 'none';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await wait(120);
    const afterNext = { idx: A.currentIdx, file: tf.textContent };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await wait(120);
    const afterPrev = { idx: A.currentIdx, file: tf.textContent };

    // ── 3. 零点标记 ──
    const plain = Array.prototype.slice.call(document.querySelectorAll('#panel-grade .param-row > input[type=range]'))
        .filter((i) => !i.classList.contains('ctl-hue') && !i.classList.contains('rng-cb') && !i.classList.contains('rng-mix'));
    const noZero = plain.filter((i) => !i.parentElement.classList.contains('has-zero')).map((i) => i.id);
    const allInRange = plain.every((i) => {
        const z = parseFloat(i.parentElement.style.getPropertyValue('--zero'));
        return isFinite(z) && z >= 0 && z <= 1;
    });
    const expZero = parseFloat($('slGradeExp').parentElement.style.getPropertyValue('--zero'));
    const shpZero = parseFloat($('slDetShp').parentElement.style.getPropertyValue('--zero'));

    // ── 4. 饱和度渐变轨道 ──
    const grad = (id) => getComputedStyle($(id)).getPropertyValue('--rng-bg').trim();
    const tracks = { vib: grad('slGradeVib'), sat: grad('slGradeSat'), temp: grad('slGradeTemp'), tint: grad('slGradeTint') };

    // ── 5. 工具入口 / 编辑态 / 配置文件可点 ──
    // 蒙版新建入口已移到下方「蒙版」折叠组（直方图卡上不再有 ＋ 蒙版 按钮）
    const beforeMasks = (A.image.grade && A.image.grade.masks || []).length;
    const linearBtn = document.querySelector('#grpMask .curve-chan[data-mt="linear"]');
    if (linearBtn) linearBtn.click();
    await wait(350);
    const afterMasks = (A.image.grade && A.image.grade.masks || []).length;
    const maskCreated = afterMasks > beforeMasks;
    // 带蒙版时 syncMasks 自动展开「蒙版」组
    const maskExpanded = !$('grpMask').classList.contains('collapsed');

    const origBuild = A.buildTree;
    let buildCalls = 0;
    A.buildTree = function () { buildCalls++; return origBuild.apply(this, arguments); };
    $('stStyle').click();
    A.buildTree = origBuild;
    const styleClickable = buildCalls > 0 && $('stStyle').getAttribute('role') === 'button';

    // ── 6. 复制 / 粘贴设置 ──
    A.currentIdx = 0; A.image = imgs[0];
    imgs[0].grade = Object.assign({}, imgs[0].grade || {}, { exp: 1.25, con: 18 });
    imgs[1].grade = null; imgs[2].grade = null;
    $('btnGradeCopySet').click();
    const copied = !!A._copiedSettings && A._copiedSettings.grade.exp === 1.25;
    A.selectedIdx = [0, 1];
    $('btnGradePasteSet').click();
    const pasted = imgs[1].grade && imgs[1].grade.exp === 1.25 && imgs[1].grade.con === 18;
    const untouched = !imgs[2].grade;
    const tplCopied = !!(A.getTpl(imgs[1]) && A.getTpl(imgs[1]).templateName === A.getTpl(imgs[0]).templateName);
    A.selectedIdx = [0];
    $('btnGradePasteSet').click();   // 只剩当前张，应给出提示而不是静默失败
    const noTargetMsg = /多选/.test($('stCanvas').textContent || '');
    delete A._copiedSettings;
    $('btnGradePasteSet').click();
    const noCopyMsg = /先点/.test($('stCanvas').textContent || '');

    return {
        halfClip, redClip, emptySafe, clipOn, clipText, clipPct, clipNums, marked, unmarked,
        fileText, fileVisible, afterNext, afterPrev,
        plainCount: plain.length, noZero, allInRange, expZero, shpZero,
        tracks, beforeMasks, afterMasks, maskCreated, maskExpanded,
        styleClickable, copied, pasted, untouched, tplCopied, noTargetMsg, noCopyMsg
    };
})()`;

async function main() {
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await win.webContents.executeJavaScript(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && window.App.closeIntro) window.App.closeIntro();
        return true;
    })()`);
    await sleep(1400);

    let res = null;
    try { res = await win.webContents.executeJavaScript(PROBE); }
    catch (e) { check(false, '探针执行', String(e && e.message)); }
    if (res) {
        if (res.missing) check(false, '模块已加载', 'App 未定义');
        check(res.halfClip && Math.abs(res.halfClip.lo - 0.5) < 0.02 && Math.abs(res.halfClip.hi - 0.5) < 0.02,
            '半黑半白：阴影/高光各剪切 50%', JSON.stringify(res.halfClip));
        check(res.redClip && res.redClip.lo === 0 && res.redClip.hi === 0,
            '纯红图（饱和色）不算过曝/过暗，两角都不亮', JSON.stringify(res.redClip));
        check(res.emptySafe, '直方图空源不抛异常（statsOf/clipOf 返回 null）');
        check(res.clipOn && res.clipPct > 40 && /%/.test(res.clipText),
            '两角角标点亮，悬停文案带精确百分比', res.clipText);
        check(res.clipNums.visible && /%/.test(res.clipNums.lo) && /%/.test(res.clipNums.hi),
            '直方图角上直接标出过曝/压黑比例，不用悬停读 title', JSON.stringify(res.clipNums));
        check(res.marked && res.unmarked, '点角标在波形上标出端点，再点关闭');
        check(/city\.jpg/.test(res.fileText) && /1\/4|1\/3/.test(res.fileText) && res.fileVisible,
            '标题栏中间显示「文件名 · 第几张」且不拦截拖拽', res.fileText);
        check(res.afterNext.idx === 1 && /desert\.jpg/.test(res.afterNext.file) && res.afterPrev.idx === 0,
            '← / → 切图时标题栏同步更新（快捷键本来就有，不新增入口）',
            JSON.stringify({ next: res.afterNext, prev: res.afterPrev }));
        check(res.plainCount > 20 && res.noZero.length === 0 && res.allInRange,
            '调色页所有普通滑块都标了零点，位置在 0~1 之间',
            JSON.stringify({ n: res.plainCount, missing: res.noZero }));
        check(Math.abs(res.expZero - 0.5) < 0.001 && res.shpZero === 0,
            '曝光零点在中点、锐化零点在最左（默认值并不总在中点）',
            JSON.stringify({ exp: res.expZero, shp: res.shpZero }));
        check(Object.values(res.tracks).every((v) => /linear-gradient/.test(v)),
            '色温/色调/自然饱和度/饱和度四条轨道都是渐变', JSON.stringify(res.tracks));
        check(res.maskCreated && res.maskExpanded,
            '「蒙版」组的线性渐变能新建，且蒙版组自动展开',
            JSON.stringify({ before: res.beforeMasks, after: res.afterMasks, created: res.maskCreated }));
        check(res.styleClickable, '状态栏「当前样式」可点，跳到左侧边框列表重建');
        check(res.copied && res.pasted && res.untouched && res.tplCopied,
            '复制/粘贴设置把调色 + 边框搬给多选照片，未选中的不受影响',
            JSON.stringify({ copied: res.copied, pasted: res.pasted, untouched: res.untouched, tpl: res.tplCopied }));
        check(res.noTargetMsg && res.noCopyMsg, '没多选 / 没复制时给出明确提示，不静默失败',
            JSON.stringify({ target: res.noTargetMsg, copy: res.noCopyMsg }));
    }

    console.log('─'.repeat(72));
    win.destroy();
    if (failures.length) {
        console.log(`FAILURE  ${failures.length} 项未通过`);
        failures.forEach((f) => console.log('  · ' + f));
        app.exit(1);
    } else {
        console.log('ALL PASS');
        app.exit(0);
    }
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });

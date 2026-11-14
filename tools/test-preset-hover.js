// 边框预设列表：紧凑行高 + 悬停即在照片上预览。
//
// 背景：预设一多，50px 一行的卡片列表一屏只放得下 9 个；26px 的纯文字行能扫二十来行，
// 「看清效果」则交给悬停预览：鼠标停留 160ms 就把预设套到画布上，移开还原，点击才真正应用。
//
// 覆盖：
//  ① 行高收到 26 上下、行内没有封面缩略图（密度），组头也跟着收
//  ② 悬停后画布真的换成了该预设，行上有 previewing 标记
//  ③ 预览不写盘：不改「最近使用」、不压撤销栈、不写每图模板、不进草稿
//  ④ 移开还原成预览前的模板（含用户 logo/文字，不因预览丢失）
//  ⑤ 连续划过两行只看最后一行的预览，且还原回到最初模板（快照不层层叠加）
//  ⑥ 预览中点一下 = 正常应用：模板保留、最近使用更新、压一条撤销
//  ⑦ 没有照片时悬停不做任何事
//
// 用法：node tools/run-electron.js tools/test-preset-hover.js
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
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); } catch (_) { return null; }
});
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) {
    ipcMain.handle(channel, () => []);
}
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir', 'save-image-base64', 'save-images-batch', 'externalize-draft']) {
    ipcMain.handle(channel, () => ({ ok: true }));
}
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) {
    ipcMain.handle(channel, () => ({ canceled: true }));
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.24', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT,
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w || 600; c.height = h || 400;
    const g = c.getContext('2d');
    g.fillStyle = '#5a86bb'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#e8d6a8'; g.fillRect(0, 0, c.width / 2, c.height / 2);
    const im = new Image();
    await new Promise((r) => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.9); });
    return im;
}`;

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
        },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(500);
    win.showInactive();
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(900);
    await exec(`window.__mk = ${MAKE_IMAGE}; true`);

    const setup = await exec(`(async () => {
        const A = window.App;
        if (typeof A.loadPresets === 'function') { try { await A.loadPresets(); } catch (_) {} }
        const el = await window.__mk(600, 400);
        const im = { el, name: 'hover.jpg', path: 'C:/fake/hover.jpg', w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = [];
        A.imageTemplates = new Map();
        A.template = A.defaultTemplate(); A.setTpl(im, A.template); A.updateEmptyState();
        A.buildTree('');
        await A.flushRender();
        return { presets: (A.presets || []).length, rows: document.querySelectorAll('#presetTree .preset-item').length };
    })()`);
    check(setup.presets > 0 && setup.rows > 0, '预设库与列表已就绪',
        JSON.stringify(setup));

    // ── 密度：行高、缩略图、组头 ──
    const density = await exec(`(() => {
        const rows = [...document.querySelectorAll('#presetTree .preset-item')]
            .filter((r) => r.offsetParent !== null);
        const one = rows[0] || document.querySelector('#presetTree .preset-item');
        const head = document.querySelector('#presetTree .group-name');
        const thumb = one && one.querySelector('.preset-thumb');
        const img = thumb && thumb.querySelector('img');
        return {
            rowH: one ? one.getBoundingClientRect().height : 0,
            thumbs: rows.filter((r) => r.querySelector('.preset-thumb img')).length,
            thumbSrc: img ? (img.getAttribute('src') || '') : '',
            thumbIcon: thumb && !img ? thumb.textContent : '',
            giconSvg: !!(head && head.querySelector('.g-icon svg')),
            name: one && one.querySelector('.preset-name') ? one.querySelector('.preset-name').textContent : '',
            headH: head ? head.getBoundingClientRect().height : 0,
            visible: rows.length,
        };
    })()`);
    check(density.rowH > 0 && density.rowH <= 34,
        '预设行保持紧凑（缩略图 24px，行高 ≤ 34）', JSON.stringify(density));
    check(density.visible > 0 && density.thumbs === density.visible && /covers\/c\d+\.webp/.test(density.thumbSrc),
        '每行都有封面缩略图（复用风格墙封面）',
        `thumbs=${density.thumbs}/${density.visible} src=${density.thumbSrc}`);
    check(!!density.name && density.giconSvg,
        '预设名保留，分类图标已换成统一 SVG', JSON.stringify({ name: density.name, svg: density.giconSvg }));
    check(density.headH > 0 && density.headH <= 30, '组头跟着收紧', density.headH + 'px');

    // ── 悬停预览：换画面但不落盘 ──
    const hovered = await exec(`(async () => {
        const A = window.App;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const rows = [...document.querySelectorAll('#presetTree .preset-item')]
            .filter((r) => r.offsetParent !== null);
        const base = A.template && A.template.templateName;
        const pick = rows.filter((r) => r.dataset.name && r.dataset.name !== base).slice(0, 2);
        if (pick.length < 2) return { error: '可见预设不足两个', n: rows.length };
        const [a, b] = pick;
        const recent0 = JSON.stringify(A.getRecent ? A.getRecent() : []);
        const undo0 = (A.undoStack || []).length;
        const saved0 = (A.getTpl(A.image) || {}).templateName || '';

        a.dispatchEvent(new MouseEvent('mouseenter'));
        await wait(340);
        await A.flushRender();
        A.saveDraftNow();
        await wait(260);
        let draftName = '';
        try {
            const d = JSON.parse(localStorage.getItem('qfs_draft_v1') || 'null');
            draftName = (d && d.template && d.template.templateName) || '';
        } catch (_) {}
        const state = {
            base,
            shown: (A.template || {}).templateName,
            previewing: a.classList.contains('previewing'),
            hoverName: A._presetHover && A._presetHover.name,
            recentSame: JSON.stringify(A.getRecent ? A.getRecent() : []) === recent0,
            undoDelta: (A.undoStack || []).length - undo0,
            saved: (A.getTpl(A.image) || {}).templateName || '',
            draft: draftName,
            nameA: a.dataset.name,
            activeA: a.classList.contains('active'),
        };

        a.dispatchEvent(new MouseEvent('mouseleave'));
        await wait(280);
        await A.flushRender();
        const restored = {
            shown: (A.template || {}).templateName,
            hover: !!A._presetHover,
            previewing: a.classList.contains('previewing'),
            saved: (A.getTpl(A.image) || {}).templateName || '',
        };

        // 移出后很快又移回同一行：不能被待执行的还原定时器关掉
        a.dispatchEvent(new MouseEvent('mouseenter'));
        await wait(330);
        a.dispatchEvent(new MouseEvent('mouseleave'));
        await wait(40);
        a.dispatchEvent(new MouseEvent('mouseenter'));
        await wait(320);
        const reenter = {
            shown: (A.template || {}).templateName,
            hoverName: A._presetHover && A._presetHover.name,
            previewing: a.classList.contains('previewing'),
        };
        a.dispatchEvent(new MouseEvent('mouseleave'));
        await wait(220);
        await A.flushRender();

        // 连续划过两行：只看后者；还原回到最初模板
        a.dispatchEvent(new MouseEvent('mouseenter'));
        await wait(50);
        b.dispatchEvent(new MouseEvent('mouseenter'));
        await wait(360);
        await A.flushRender();
        const afterBC = {
            shown: (A.template || {}).templateName,
            nameB: b.dataset.name,
            hoverName: A._presetHover && A._presetHover.name,
            aPreviewing: a.classList.contains('previewing'),
            bPreviewing: b.classList.contains('previewing'),
            snapshot: A._presetHover && A._presetHover.snapshot && A._presetHover.snapshot.templateName,
        };
        b.dispatchEvent(new MouseEvent('mouseleave'));
        await wait(280);
        await A.flushRender();
        const backToBase = (A.template || {}).templateName;

        // 预览中点一下 = 真正应用
        b.dispatchEvent(new MouseEvent('mouseenter'));
        await wait(330);
        b.dispatchEvent(new MouseEvent('click'));
        await wait(320);
        await A.flushRender();
        const committed = {
            shown: (A.template || {}).templateName,
            nameB: b.dataset.name,
            recentFirst: (A.getRecent ? A.getRecent() : [])[0] || '',
            undoDelta: (A.undoStack || []).length - undo0,
            hover: !!A._presetHover,
            previewing: b.classList.contains('previewing'),
            active: b.classList.contains('active'),
            saved: (A.getTpl(A.image) || {}).templateName || '',
        };

        // 没有照片时悬停不做事
        const keep = A.image;
        A.image = null;
        a.dispatchEvent(new MouseEvent('mouseenter'));
        await wait(260);
        const noImageHover = !!A._presetHover;
        A.image = keep;

        return { state, restored, reenter, afterBC, backToBase, committed, saved0, noImageHover, error: '' };
    })()`);
    if (hovered.error) {
        check(false, '悬停预览用例前置条件', hovered.error + ' / ' + hovered.n);
    } else {
        const s = hovered.state;
        check(s.shown === s.nameA && s.hoverName === s.nameA,
            '悬停后画布换成该预设（模板临时替换）', JSON.stringify({ shown: s.shown, name: s.nameA }));
        check(s.previewing === true && s.activeA === false,
            '预览行有 previewing 标记，但不会被当成「已应用」', JSON.stringify({ p: s.previewing, a: s.activeA }));
        check(s.recentSame === true && s.undoDelta === 0,
            '预览不进「最近使用」、不压撤销栈', JSON.stringify({ recentSame: s.recentSame, undoDelta: s.undoDelta }));
        check(s.saved === hovered.saved0 && s.draft !== s.nameA,
            '预览不写每图模板、也不写进草稿',
            JSON.stringify({ base: s.base, saved0: hovered.saved0, saved: s.saved, draft: s.draft, nameA: s.nameA }));
        check(hovered.restored.shown === s.base && hovered.restored.hover === false
            && hovered.restored.previewing === false,
            '移开后还原成预览前的模板', JSON.stringify(hovered.restored));
        check(hovered.reenter.shown === s.nameA && hovered.reenter.hoverName === s.nameA
            && hovered.reenter.previewing === true,
            '移出后很快移回同一行，预览不会被待还原的定时器关掉', JSON.stringify(hovered.reenter));
        check(hovered.afterBC.shown === hovered.afterBC.nameB
            && hovered.afterBC.hoverName === hovered.afterBC.nameB
            && hovered.afterBC.aPreviewing === false && hovered.afterBC.bPreviewing === true
            && hovered.afterBC.snapshot === s.base,
            '连续划过两行只看后者，快照仍是最初的模板',
            JSON.stringify(hovered.afterBC));
        check(hovered.backToBase === s.base,
            '从第二行移开后回到最初模板（预览不层层叠加）', hovered.backToBase);
        check(hovered.committed.shown === hovered.committed.nameB
            && hovered.committed.saved === hovered.committed.nameB
            && hovered.committed.recentFirst === hovered.committed.nameB
            && hovered.committed.undoDelta >= 1
            && hovered.committed.hover === false && hovered.committed.previewing === false
            && hovered.committed.active === true,
            '预览中点一下 = 正常应用（模板/最近使用/撤销/高亮都落定）',
            JSON.stringify(hovered.committed));
        check(hovered.noImageHover === false, '没有照片时悬停不做任何事', String(hovered.noImageHover));
    }

    console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e && e.stack || e);
    app.exit(1);
});

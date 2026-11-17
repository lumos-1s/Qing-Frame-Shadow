// 新手引导回归：从「欢迎页风格」改成暗房流程卡——发丝线分步、等宽步号、金色品牌标记、
// 单一绿色主按钮，且布局完全由 CSS 驱动（不靠内联样式）。同时守住「开始使用 / 重新查看」链路。
// 用法: node tools/run-electron.js tools/test-intro-ui.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('save-prefs', () => ({ ok: true }));
ipcMain.handle('get-user', () => null);
ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('get-app-info', () => ({
    version: require('../package.json').version, electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) {
    ipcMain.handle(c, () => []);
}
for (const c of ['load-acr-tables', 'load-acr-shadows', 'open-external', 'open-data-dir', 'copy-text',
    'check-for-updates', 'start-update-download', 'quit-and-install']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'read-exif',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files']) {
    ipcMain.handle(c, () => ({ canceled: true }));
}

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const p = new URL(req.url).searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });

    const win = new BrowserWindow({ width: 1000, height: 720, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, 'preload-about.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom)')) break;
        await sleep(250);
    }
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    win.showInactive();
    await exec(`(() => { try { localStorage.removeItem('qfs_intro_done'); } catch (_) {} return true; })()`);
    await exec(`App.showIntroIfNeeded(); true`);
    await sleep(250);

    const shape = await exec(`(() => {
        const m = document.getElementById('introModal');
        const card = m.querySelector('.intro-card');
        const steps = [...m.querySelectorAll('.intro-step')];
        const num = [...m.querySelectorAll('.intro-num')].map((n) => n.textContent.trim());
        const first = steps[0] ? getComputedStyle(steps[0]) : null;
        const cta = m.querySelector('#btnIntroDone');
        const cs = cta ? getComputedStyle(cta) : null;
        return {
            visible: getComputedStyle(m).display === 'flex',
            inlineCard: card ? card.getAttribute('style') : 'no-card',
            steps: steps.length, num,
            circled: /[①②③]/.test(m.textContent),
            mark: !!m.querySelector('.intro-mark'),
            eyebrow: (m.querySelector('.intro-eyebrow') || {}).textContent || '',
            oldWelcome: /欢迎使用/.test(m.textContent),
            stats: (m.querySelector('#introStatsText') || {}).textContent || '',
            stepBorder: first ? first.borderTopWidth : '',
            stepBg: first ? first.backgroundColor : '',
            ctaCount: m.querySelectorAll('.ub-btn.primary').length,
            ctaBg: cs ? cs.backgroundColor : '',
            ctaImage: cs ? cs.backgroundImage : '',
            footnote: (m.querySelector('.intro-footnote') || {}).textContent || ''
        };
    })()`);
    check(shape.visible, '首次启动能弹出引导', JSON.stringify(shape.visible));
    check(shape.inlineCard === null, '卡片布局不靠内联样式', String(shape.inlineCard));
    check(shape.steps === 3 && shape.num.join(',') === '01,02,03' && !shape.circled,
        '三步用等宽序号而非圆圈数字', JSON.stringify({ steps: shape.steps, num: shape.num, circled: shape.circled }));
    check(shape.mark && /QINGFRAME/.test(shape.eyebrow) && !shape.oldWelcome,
        '品牌报头替换「欢迎使用」', JSON.stringify({ mark: shape.mark, eyebrow: shape.eyebrow }));
    check(/\d+\s*款边框/.test(shape.stats), '统计数字保留静态兜底', shape.stats);
    check(shape.stepBorder === '1px' && shape.stepBg === 'rgba(0, 0, 0, 0)',
        '步骤用发丝线分隔且无卡片底色', JSON.stringify({ border: shape.stepBorder, bg: shape.stepBg }));
    check(shape.ctaCount === 1 && shape.ctaImage === 'none',
        '只有一个纯色主按钮，没有渐变 CTA', JSON.stringify({ count: shape.ctaCount, bg: shape.ctaBg, image: shape.ctaImage }));
    check(/重新查看/.test(shape.footnote), '说明可从设置重新查看', shape.footnote);

    // 1000px / 140%：卡片不能溢出窗口
    await exec(`App.applyFontScale(1.4); true`);
    await sleep(250);
    const fit = await exec(`(() => {
        const r = document.querySelector('.intro-card').getBoundingClientRect();
        return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), vw: innerWidth, vh: innerHeight };
    })()`);
    check(fit.l >= 0 && fit.r <= fit.vw && fit.t >= 0 && fit.b <= fit.vh,
        '1000px / 140% 下引导卡完整落在窗口内', JSON.stringify(fit));
    await exec(`App.applyFontScale(1); true`);

    // 开始使用 → 落标记；关于 → 重新查看 → 统计走运行时数据
    await exec(`document.getElementById('btnIntroDone').click(); true`);
    await sleep(150);
    const closed = await exec(`(() => ({ display: getComputedStyle(document.getElementById('introModal')).display,
        done: localStorage.getItem('qfs_intro_done') }))()`);
    check(closed.display === 'none' && closed.done === '1', '开始使用关闭并记住', JSON.stringify(closed));

    const reopened = await exec(`(() => {
        App.presets = new Array(91).fill(0);
        window.StyleCaps = { MEASURED: Object.fromEntries(new Array(96).fill(0).map((_, i) => ['S' + i, {}])) };
        App.showIntroAgain();
        return { display: getComputedStyle(document.getElementById('introModal')).display,
                 done: localStorage.getItem('qfs_intro_done'),
                 stats: document.getElementById('introStatsText').textContent };
    })()`);
    check(reopened.display === 'flex' && reopened.done === null,
        '关于页可重新调出引导并清掉标记', JSON.stringify(reopened));
    check(/91\s*款边框、96\s*种风格/.test(reopened.stats), '统计数字来自运行时数据', reopened.stats);

    console.log(failures.length ? `\n未通过 ${failures.length} 项：` + failures.map((f) => '\n - ' + f).join('') : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); app.exit(1); });

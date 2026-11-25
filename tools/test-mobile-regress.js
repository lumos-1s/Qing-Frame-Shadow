'use strict';
// 手机版回归：把这一批抓到的逻辑 bug 逐条钉住，避免以后又改回去。
// 依赖 `npm run mobile:serve`（4173 端口）：RAW 桥是 ES module，file:// 会被 CORS 拦。
const { app, BrowserWindow } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const fails = [];
const check = (ok, label, extra) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) fails.push(label);
};

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 420, height: 860, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2 || /未注册的相框风格|render failed|Uncaught/.test(message)) errors.push(message);
    });
    await win.loadURL('http://127.0.0.1:4173/');
    await new Promise((r) => setTimeout(r, 700));

    const r = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const mk = () => {
            const c = document.createElement('canvas'); c.width = 400; c.height = 300;
            const g = c.getContext('2d');
            const gr = g.createLinearGradient(0, 0, 400, 300);
            gr.addColorStop(0, '#d33'); gr.addColorStop(1, '#223');
            g.fillStyle = gr; g.fillRect(0, 0, 400, 300);
            c.naturalWidth = 400; c.naturalHeight = 300; c.complete = true;
            return { el: c, name: 'regress.jpg', w: 400, h: 300, grade: null };
        };
        const cv = document.getElementById('previewCanvas');
        window.qfsNative.pickImages = async () => [mk()];
        document.getElementById('btnPick').click();
        await wait(350);

        // 1) 预设没有 photoFrameStyle 时，不能拿 templateName 去冒充相框风格。
        //    之前「极简细线」等 23 个预设因此被渲染成灰占位图。
        const presets = window.QF_PRESETS || [];
        const idx = presets.findIndex((p) => p.templateName === '极简细线');
        const card = document.querySelector('[data-preset="' + idx + '"]');
        if (card) card.click();
        await wait(300);
        const tplPf = String((window.App.template && window.App.template.photoFrameStyle) || '');
        const presetPf = String(presets[idx].photoFrameStyle || '');
        const styleW = cv.width, styleH = cv.height;

        // 2) 从拼图切回风格页，画布必须重画成当前照片，导出文件名也不能还是「拼图」。
        document.querySelector('[data-tab="puzzle"]').click();
        await wait(400);
        const puzzleW = cv.width;
        document.querySelector('[data-tab="style"]').click();
        await wait(400);
        const backW = cv.width, backH = cv.height;
        let exported = '';
        const origSave = window.qfsNative.saveImage;
        window.qfsNative.saveImage = async (d, n) => { exported = n; return { ok: true, mode: 'test' }; };
        document.getElementById('btnExport').click();
        await wait(350);
        window.qfsNative.saveImage = origSave;

        // 3) 切图要切「加了风格/调色」的成品画布，且 9 块文件名不能互相覆盖。
        const saved = [];
        window.qfsNative.saveImage = async (d, n) => {
            const dims = await new Promise((res) => {
                const im = new Image();
                im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight);
                im.onerror = () => res('bad');
                im.src = d;
            });
            saved.push({ n, dims });
            return { ok: true };
        };
        document.querySelector('[data-tab="crop"]').click();
        await wait(400);
        document.getElementById('btnExport').click();
        await wait(1600);
        window.qfsNative.saveImage = origSave;

        // 4) 调色页切走再切回：直方图必须画在新面板的画布上，而且统计的是调色后像素。
        document.querySelector('[data-tab="grade"]').click();
        await wait(350);
        const exp = document.querySelector('[data-grade="exp"]');
        exp.value = '1.5';
        exp.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(450);
        document.querySelector('[data-tab="style"]').click();
        await wait(300);
        document.querySelector('[data-tab="grade"]').click();
        await wait(450);
        const histo = document.getElementById('gradeHisto');
        const hd = histo.getContext('2d').getImageData(0, 0, histo.width, histo.height).data;
        let hsum = 0;
        for (let i = 3; i < hd.length; i += 4) hsum += hd[i];

        // 5) libraw-wasm 的 3 通道像素不能再按 w*h*4 取（之前 100% 抛 RangeError）。
        let rawErr = '';
        let rawPx = [];
        try {
            const rawCv = window.qfRawRgbToCanvas(new Uint8Array([255, 0, 0, 0, 255, 0]), 2, 1);
            rawPx = Array.from(rawCv.getContext('2d').getImageData(0, 0, 2, 1).data);
        } catch (e) { rawErr = String(e && e.message || e); }

        return {
            idx, tplPf, presetPf, styleW, styleH, puzzleW, backW, backH, exported,
            cropNames: saved.map((s) => s.n), cropDims: saved.map((s) => s.dims), cropCount: saved.length,
            histoConnected: histo.isConnected, histoSum: hsum,
            gradeExp: Number((window.App.image.grade && window.App.image.grade.exp) || 0),
            rawErr, rawPx,
            rawBridge: typeof window.qfRawDecode === 'function'
        };
    })()`);

    check(r.idx >= 0 && r.tplPf === r.presetPf,
        '预设没有 photoFrameStyle 时不伪造相框风格', JSON.stringify({ preset: r.idx, tplPf: r.tplPf, presetPf: r.presetPf }));
    check(r.styleW > 0 && r.styleH > 0 && r.backW === r.styleW && r.backH === r.styleH && r.backW !== r.puzzleW,
        '拼图切回风格页后画布按当前照片重画', JSON.stringify({ style: r.styleW + 'x' + r.styleH, puzzleW: r.puzzleW, back: r.backW + 'x' + r.backH }));
    check(/_清框影\.jpg$/.test(r.exported) && !/_拼图\.jpg$/.test(r.exported),
        '切回后导出的是当前照片而不是上一页拼图', r.exported);

    check(r.cropCount === 9 && new Set(r.cropNames).size === 9,
        '切图 9 块文件名互不重复（不再都叫 IMG_1234.jpg）', JSON.stringify(r.cropNames.slice(0, 3)));
    check(r.cropDims.every((d) => d !== 'bad' && Number(String(d).split('x')[0]) > 100),
        '切图块来自加风格后的成品画布而不是原图', JSON.stringify(r.cropDims.slice(0, 3)));

    check(r.gradeExp > 1.4 && r.histoConnected && r.histoSum > 0,
        '调色页切走再切回后直方图仍画在新画布上', JSON.stringify({ exp: r.gradeExp, connected: r.histoConnected, sum: r.histoSum }));

    check(r.rawBridge && !r.rawErr && r.rawPx.join(',') === '255,0,0,255,0,255,0,255',
        'RAW 3 通道像素补 alpha 后正确（不再 RangeError）', JSON.stringify({ err: r.rawErr, px: r.rawPx.slice(0, 8) }));

    check(errors.length === 0, '本次回归全程无相框占位/渲染失败警告', errors.slice(0, 3).join(' / '));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });

'use strict';
// 手机版回归：把这一批抓到的逻辑 bug 逐条钉住，避免以后又改回去。
// 依赖 `npm run mobile:serve`（4173 端口）：RAW 桥是 ES module，file:// 会被 CORS 拦。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
// 测试图来自 strukturag/libheif 的 tests/data/rainbow-451x461.heic（BSD 许可），只用于回归
const heicB64 = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rainbow-451x461.heic')).toString('base64');
// RAW 样本在 .tmp（不入库）：有就顺手验一次全尺寸重解，没有就跳过这一条
const rawSample = path.join(ROOT, '.tmp', 'rawspike', 'sample.ARW');
const rawTestName = '.tmp-raw-full.ARW';
const rawTestFile = path.join(ROOT, 'mobile', 'www', rawTestName);
if (fs.existsSync(rawSample)) fs.copyFileSync(rawSample, rawTestFile);

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
        // 后面还会再导入一张图并重绘面板，这里必须当场取样，不能等到 return 时再读
        const histoConnected = histo.isConnected;
        const gradeExp = Number((window.App.image.grade && window.App.image.grade.exp) || 0);

        // 5) libraw-wasm 的 3 通道像素不能再按 w*h*4 取（之前 100% 抛 RangeError）。
        let rawErr = '';
        let rawPx = [];
        try {
            const rawCv = window.qfRawRgbToCanvas(new Uint8Array([255, 0, 0, 0, 255, 0]), 2, 1);
            rawPx = Array.from(rawCv.getContext('2d').getImageData(0, 0, 2, 1).data);
        } catch (e) { rawErr = String(e && e.message || e); }

        // 8) HEIC 系统解不了时，libheif(WASM) 兜底必须真能解出像素
        let heic = {}, heicErr = '', heicBytes = null, heicFull = {}, heicFullErr = '';
        try {
            const bin = atob(${JSON.stringify(heicB64)});
            heicBytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) heicBytes[i] = bin.charCodeAt(i);
            const cv = await window.qfHeicDecode(heicBytes);
            heic = {
                w: cv.width, h: cv.height,
                px: Array.from(cv.getContext('2d').getImageData(0, 0, 1, 1).data)
            };
            cv.width = 0; cv.height = 0;
        } catch (e) { heicErr = String(e && e.message || e); }

        try {
            const small = document.createElement('canvas');
            small.width = 160; small.height = 160;
            small.naturalWidth = 160; small.naturalHeight = 160; small.complete = true;
            const file = new File([heicBytes], 'sample.heic', { type: 'image/heic' });
            const src = await window.qfFullSource({
                el: small, name: 'sample.heic', w: 160, h: 160,
                srcW: 451, srcH: 461, heic: true, grade: null, file
            });
            heicFull = { w: src.canvas.width, h: src.canvas.height, changed: src.changed };
            src.release();
        } catch (e) { heicFullErr = String(e && e.message || e); }

        // 9) 导出必须按原图尺寸，不能把 3000×2000 的图停在 1600px 预览
        let fullExport = {}, fullExportErr = '';
        try {
            const big = document.createElement('canvas');
            big.width = 3000; big.height = 2000;
            const bg = big.getContext('2d');
            bg.fillStyle = '#345'; bg.fillRect(0, 0, 3000, 2000);
            bg.fillStyle = '#fff'; bg.fillRect(100, 100, 800, 800);
            const blob = await new Promise((res) => big.toBlob(res, 'image/jpeg', 0.9));
            const file = new File([blob], 'full.jpg', { type: 'image/jpeg' });
            const pv = document.createElement('canvas');
            pv.width = 1600; pv.height = 1067;
            pv.getContext('2d').drawImage(big, 0, 0, 1600, 1067);
            pv.naturalWidth = 1600; pv.naturalHeight = 1067; pv.complete = true;
            window.qfsNative.pickImages = async () => [{
                el: pv, name: 'full.jpg', w: 1600, h: 1067,
                srcW: 3000, srcH: 2000, grade: null, file
            }];
            document.getElementById('btnPick').click();
            await wait(600);
            let dims = '', name = '';
            const save0 = window.qfsNative.saveImage;
            window.qfsNative.saveImage = async (d, n) => {
                name = n;
                dims = await new Promise((res) => {
                    const im = new Image();
                    im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight);
                    im.onerror = () => res('bad');
                    im.src = d;
                });
                return { ok: true, mode: 'test' };
            };
            document.getElementById('btnExport').click();
            await wait(4500);
            window.qfsNative.saveImage = save0;
            fullExport = {
                dims, name,
                after: document.getElementById('previewCanvas').width,
                exportScale: window.App.exportScale
            };
        } catch (e) { fullExportErr = String(e && e.message || e); }

        // 10) 拼图导出走 4000px 版式，不能停在 1600px 预览
        let puzzleExport = {}, puzzleExportErr = '';
        try {
            document.querySelector('[data-tab="puzzle"]').click();
            await wait(450);
            let pdims = '';
            const save1 = window.qfsNative.saveImage;
            window.qfsNative.saveImage = async (d) => {
                pdims = await new Promise((res) => {
                    const im = new Image();
                    im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight);
                    im.onerror = () => res('bad');
                    im.src = d;
                });
                return { ok: true, mode: 'test' };
            };
            document.getElementById('btnExport').click();
            await wait(2500);
            window.qfsNative.saveImage = save1;
            puzzleExport = {
                dims: pdims,
                after: document.getElementById('previewCanvas').width,
                exportScale: window.App.exportScale
            };
        } catch (e) { puzzleExportErr = String(e && e.message || e); }

        // 11) 切图从全尺寸成品上切，而不是 1600px 预览块
        let cropFull = {}, cropFullErr = '';
        try {
            document.querySelector('[data-tab="crop"]').click();
            await wait(550);
            const dims = [];
            const save2 = window.qfsNative.saveImage;
            window.qfsNative.saveImage = async (d) => {
                dims.push(await new Promise((res) => {
                    const im = new Image();
                    im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight);
                    im.onerror = () => res('bad');
                    im.src = d;
                }));
                return { ok: true };
            };
            document.getElementById('btnExport').click();
            await wait(3500);
            window.qfsNative.saveImage = save2;
            cropFull = { dims: dims.slice(0, 2), count: dims.length };
        } catch (e) { cropFullErr = String(e && e.message || e); }

        // 12) 编辑 › 边框页：控件能改到模板，且状态条跟着切换
        let edit = {}, editErr = '';
        try {
            document.querySelector('[data-tab="edit"]').click();
            await wait(450);
            edit = {
                tabs: document.querySelectorAll('#tabs .tab').length,
                subs: document.querySelectorAll('[data-edit-sub]').length,
                ctls: document.querySelectorAll('[data-ctl]').length,
                stageName: document.getElementById('stageName').textContent
            };
            const setByLabel = (label, value) => {
                const row = Array.from(document.querySelectorAll('.ctl-row')).find((x) => {
                    const l = x.querySelector('label');
                    return l && l.textContent === label;
                });
                const el = row && row.querySelector('[data-ctl]');
                if (!el) return false;
                el.value = String(value);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            };
            edit.changedStroke = setByLabel('描边宽度', 40);
            edit.changedFill = setByLabel('填充颜色', '#00ff00');
            await wait(350);
            const layer = (window.App.template.layerList || [])[0] || {};
            edit.stroke = (layer.strokeConfig || {}).strokeWidth;
            edit.fill = (layer.fillConfig || {}).fillHex;
            document.querySelector('[data-edit-sub="text"]').click();
            await wait(200);
            edit.textPlaceholder = (document.querySelector('#panel .panel-note') || {}).textContent || '';
            document.querySelector('[data-tab="crop"]').click();
            await wait(250);
        } catch (e) { editErr = String(e && e.message || e); }

        // 13) RAW 全尺寸重解（本地有样本时）
        let rawFull = {}, rawFullErr = '';
        if (${JSON.stringify(fs.existsSync(rawSample))}) {
            try {
                const resp = await fetch('/' + ${JSON.stringify(rawTestName)});
                if (!resp.ok) throw new Error('RAW 样本 HTTP ' + resp.status);
                const blob = await resp.blob();
                const file = new File([blob], 'sample.ARW');
                const cv = await window.qfRawDecodeFull(file);
                rawFull = {
                    w: cv.width, h: cv.height,
                    px: Array.from(cv.getContext('2d').getImageData(0, 0, 1, 1).data)
                };
                cv.width = 0; cv.height = 0;
            } catch (e) { rawFullErr = String(e && e.message || e); }
        }

        return {
            idx, tplPf, presetPf, styleW, styleH, puzzleW, backW, backH, exported,
            cropNames: saved.map((s) => s.n), cropDims: saved.map((s) => s.dims), cropCount: saved.length,
            histoConnected, histoSum: hsum,
            gradeExp,
            rawErr, rawPx,
            rawBridge: typeof window.qfRawDecode === 'function',
            heic, heicErr, heicFull, heicFullErr, fullExport, fullExportErr,
            puzzleExport, puzzleExportErr, cropFull, cropFullErr,
            edit, editErr, rawFull, rawFullErr
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

    check(!r.heicErr && r.heic.w === 451 && r.heic.h === 461 && r.heic.px.some((v) => v > 0),
        'HEIC 系统解码失败时 libheif(WASM) 兜底解出正确像素', JSON.stringify({ heic: r.heic, err: r.heicErr }));
    check(!r.heicFullErr && r.heicFull.w === 451 && r.heicFull.h === 461 && r.heicFull.changed,
        '全尺寸导出从 HEIC 原文件重解而不是放大 1600px 预览', JSON.stringify({ heicFull: r.heicFull, err: r.heicFullErr }));

    check(!r.fullExportErr && Number(String(r.fullExport.dims).split('x')[0]) >= 2400,
        '导出按原图尺寸而不是 1600px 预览', JSON.stringify({ export: r.fullExport, err: r.fullExportErr }));
    check(Number(r.fullExport.after) < 1800 && !r.fullExport.exportScale,
        '导出后画布和临时档位都回到 1600px 预览', JSON.stringify(r.fullExport));

    check(!r.puzzleExportErr && Number(String(r.puzzleExport.dims).split('x')[0]) >= 3000
        && Number(r.puzzleExport.after) < 1800 && !r.puzzleExport.exportScale,
        '拼图导出按 4000px 版式且导出后回到 1600px 预览', JSON.stringify({ puzzle: r.puzzleExport, err: r.puzzleExportErr }));

    check(!r.cropFullErr && Number(String(r.cropFull.dims[0]).split('x')[0]) >= 800 && r.cropFull.count === 9,
        '切图从全尺寸成品上切出 9 块', JSON.stringify({ crop: r.cropFull, err: r.cropFullErr }));

    check(!r.editErr && r.edit.tabs === 5 && r.edit.subs === 4 && r.edit.ctls > 10
        && r.edit.stageName === '编辑 · 边框' && /后续版本开放/.test(r.edit.textPlaceholder),
        '编辑页五个页签、四个子页与边框控件都在', JSON.stringify({ edit: r.edit, err: r.editErr }));
    check(!r.editErr && r.edit.changedStroke && r.edit.changedFill && r.edit.stroke === 40 && r.edit.fill === '00ff00',
        '边框控件写入 template.layerList（描边宽度/填充颜色）', JSON.stringify({ edit: r.edit, err: r.editErr }));

    if (fs.existsSync(rawSample)) {
        check(!r.rawFullErr && r.rawFull.w >= 3000 && r.rawFull.h >= 2000 && r.rawFull.px.some((v) => v > 0),
            'RAW 导出前能按原图尺寸重解（不再是半尺寸代理）', JSON.stringify({ raw: r.rawFull, err: r.rawFullErr }));
    }

    check(errors.length === 0, '本次回归全程无相框占位/渲染失败警告', errors.slice(0, 3).join(' / '));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    if (fs.existsSync(rawTestFile)) fs.unlinkSync(rawTestFile);
    app.exit(fails.length ? 1 : 0);
}).catch((e) => {
    console.error(e && e.stack || e);
    if (fs.existsSync(rawTestFile)) fs.unlinkSync(rawTestFile);
    app.exit(1);
});

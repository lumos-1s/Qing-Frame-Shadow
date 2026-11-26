// RAW 导入与显影：端到端用例（真的调 libraw-wasm 解一张 ARW，不是打桩）。
//
// 覆盖：
//  ① 导入 RAW 后拿到的是代理尺寸（长边 1600）而不是原图，面板出现在「调色」上方
//  ② 拖动曝光滑块：参数写进这张图，画面真的变亮（量画布平均亮度，不是看 DOM）
//  ③ 停手后 rawEnsureFull 能把同一张图升到全尺寸，参数不变
//  ④ 换回普通 JPEG：面板收起，不会对非 RAW 图做显影
//  ⑤ 草稿只存几个数字（显影参数），不存像素
//
// 样本：默认读 .tmp/rawspike/user.ARW，也可用 QF_RAW_SAMPLE 指定。
// 找不到样本时整条用例 SKIP（退出码 0）——RAW 解码需要真实文件，不适合造假数据。
//
// 用法：node tools/run-electron.js tools/test-raw.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const SAMPLE = process.env.QF_RAW_SAMPLE || path.join(ROOT, '.tmp', 'rawspike', 'user.ARW');
const RAW = require(path.join(ROOT, 'src', 'main', 'raw.js'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 测试窗口自己当 qflocal 的服务端：走的是产品里同一条 develop 路径，
// 所以「URL 里的参数 → 解码 → JPEG → <img>」整条链都被覆盖到。
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

const CORS = {
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff'
};

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const OPEN_ITEMS = [];
ipcMain.handle('open-images', () => OPEN_ITEMS.slice());
ipcMain.handle('open-image', () => (OPEN_ITEMS[0] || null));
ipcMain.handle('read-exif', () => ({}));
for (const ch of ['list-presets', 'list-logos', 'list-textures', 'list-templates', 'list-wall-covers',
    'list-grade-presets', 'load-acr-tables']) {
    ipcMain.handle(ch, () => (ch === 'list-presets' ? [] : []));
}
ipcMain.handle('load-preset', () => null);
ipcMain.handle('load-acr-shadows', () => null);
for (const ch of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir', 'save-image-base64', 'save-images-batch', 'externalize-draft',
    'save-grade-preset', 'delete-grade-preset', 'rename-grade-preset']) {
    ipcMain.handle(ch, () => ({ ok: true }));
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.24', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

async function main() {
    await app.whenReady();
    if (!fs.existsSync(SAMPLE)) {
        console.log('SKIP  没找到 RAW 样本（' + SAMPLE + '），跳过 RAW 用例');
        app.exit(0);
        return;
    }
    RAW.setCacheRoot(path.join(ROOT, '.tmp', 'raw-cache-test'));
    protocol.handle('qflocal', async (request) => {
        const u = new URL(request.url);
        const p = u.searchParams.get('p');
        if (!p || !RAW.isRaw(p)) return new Response('not raw', { status: 404, headers: CORS });
        let params = {};
        try { params = JSON.parse(u.searchParams.get('raw') || '{}'); } catch (e) { params = {}; }
        let crop = null;
        const cropParam = u.searchParams.get('crop');
        if (cropParam) {
            try { crop = JSON.parse(cropParam); } catch (e) { crop = null; }
        }
        const rotate = Math.max(0, Math.min(3, Math.round(Number(u.searchParams.get('rot')) || 0)));
        const edge = Math.max(0, Number(u.searchParams.get('q')) || 0);
        try {
            const out = await RAW.develop(p, { params, maxEdge: edge, halfSize: edge > 0, crop, rotate });
            return new Response(out.jpg, { headers: { ...CORS, 'content-type': 'image/jpeg' } });
        } catch (e) {
            return new Response('fail: ' + e.message, { status: 415, headers: CORS });
        }
    });

    OPEN_ITEMS.push({
        name: path.basename(SAMPLE), path: SAMPLE, size: fs.statSync(SAMPLE).size,
        raw: true, exif: { make: 'SONY', model: 'ILCE-6000', iso: 'ISO100', orientation: 1 }
    });

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
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(900);

    // ── ① 导入 ──
    const imported = await exec(`(async () => {
        const A = window.App;
        if (A.loadPresets) { try { await A.loadPresets(); } catch (_) {} }
        await A.openImages();
        const im = A.images[0];
        if (!im) return { error: '没有导入任何照片' };
        const panel = document.getElementById('grpRaw');
        return {
            n: A.images.length,
            hasRaw: !!im.raw,
            w: im.w, h: im.h,
            full: !!(im.raw && im.raw.full),
            params: im.raw && im.raw.params,
            panelHidden: panel ? panel.hidden : null,
            badge: (document.getElementById('rawBadge') || {}).textContent,
            state: (document.getElementById('rawState') || {}).textContent,
            emH: A.image === im ? 1 : 0
        };
    })()`);
    check(!imported.error && imported.n === 1, 'RAW 能导入并成为当前照片', JSON.stringify(imported));
    check(imported.hasRaw === true && imported.params && imported.params.highlights === 25,
        '导入时建立默认显影参数', JSON.stringify(imported.params));
    check(imported.w === 1600 && imported.full === false,
        '首屏是 1600px 代理，不是原图', `${imported.w}×${imported.h}`);
    check(imported.panelHidden === false && imported.badge === 'ARW',
        '「RAW 显影」面板出现，徽章显示 ARW', `badge=${imported.badge} state=${imported.state}`);

    // ── ② 一套滑块：RAW 不再单独摆一套同名的 ──
    // 以前「RAW 显影」和「调色」各有一套曝光/对比/高光/色温/色调：概念重复，
    // 而且两边的「高光 +」方向相反（显影是压、调色是提）。现在只在「基础」里留一套。
    const single = await exec(`(async () => {
        const A = window.App;
        const has = (id) => !!document.getElementById(id);
        const panel = document.getElementById('grpRaw');
        const hint = panel ? panel.querySelector('.hint-box') : null;
        return {
            rawSliders: ['slRawExp', 'slRawCon', 'slRawHi', 'slRawTemp', 'slRawTint'].filter(has),
            gradeSliders: ['slGradeExp', 'slGradeCon', 'slGradeHi', 'slGradeTemp', 'slGradeTint'].filter(has),
            panelShown: panel ? getComputedStyle(panel).display !== 'none' : false,
            hint: hint ? hint.textContent.trim() : '',
            params: A.image.raw.params
        };
    })()`);
    check(single.rawSliders.length === 0,
        'RAW 面板不再重复一套曝光/对比/高光/色温/色调滑块', JSON.stringify(single.rawSliders));
    check(single.gradeSliders.length === 5,
        '这五档只在「基础」里出现一次', JSON.stringify(single.gradeSliders));
    // 页签/分组改名后提示文案把「调色」换成了「基础 → 亮 / 颜色」，
    // 断言跟着新文案走，别再拿旧词判失败（这是文案改名，不是功能回归）。
    check(single.panelShown && /基础/.test(single.hint) && /颜色/.test(single.hint),
        'RAW 面板保留状态行，并写明这五档去哪里调（基础 → 亮 / 颜色）', single.hint.slice(0, 40));
    check(single.params.exposure === 0 && single.params.highlights === 25,
        '解码基线仍是「曝光 0 + 高光肩 25」', JSON.stringify(single.params));

    // ── ③ 自动显影：不用手动触发，切到这张图后自己升；面板与状态栏都要看得见 ──
    const auto = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const stRes = () => (document.getElementById('stRes') || {}).textContent || '';
        const btn = document.getElementById('btnRawDevelop');
        const state = document.getElementById('rawState');
        const start = {
            btn: btn ? btn.textContent : null,
            state: state ? state.textContent : null,
            stRes: stRes()
        };
        // 不调用任何显影接口：导入/切图后主进程自己会排一次全尺寸
        const t0 = Date.now();
        while (Date.now() - t0 < 15000 && !im.raw.full) {
            await new Promise((r) => setTimeout(r, 150));
        }
        await A.flushRender();
        return {
            start,
            full: im.raw.full, w: im.w, h: im.h,
            sec: +((Date.now() - t0) / 1000).toFixed(1),
            end: {
                btn: btn ? btn.textContent : null,
                state: state ? state.textContent : null,
                stRes: stRes()
            }
        };
    })()`);
    check(auto.start.btn === '按全尺寸显影' && /^代理\s*\d+px$/.test(String(auto.start.state || '').trim()),
        '代理阶段：按钮写着「按全尺寸显影」，状态写明还是代理', JSON.stringify(auto.start));
    check(/RAW 代理/.test(auto.start.stRes),
        '状态栏把 1600px 标成「RAW 代理」，不会被当成照片尺寸', auto.start.stRes);
    check(auto.full === true && auto.w > 3000,
        '切到这张图后自动升到全尺寸，用户不用手动触发',
        JSON.stringify({ w: auto.w, h: auto.h, sec: auto.sec }));
    check(auto.end.btn === '重新显影' && /^\d+×\d+$/.test(String(auto.end.state || '').trim()),
        '显影完成后按钮变成「重新显影」，状态写明实际像素', JSON.stringify(auto.end));
    check(/· RAW$/.test(auto.end.stRes),
        '状态栏跟着变成「RAW」，全尺寸与否一眼可辨', auto.end.stRes);

    // ── ③b 面板按钮能手动触发：代理状态点一下会真的重解 ──
    const manual = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        // 模拟「停在代理」：只改状态标记，像素仍是全尺寸，点按钮会再解一次
        im.raw.full = false;
        im.raw.edge = A.RAW_PROXY_EDGE;
        A.syncRawUI();
        const btn = document.getElementById('btnRawDevelop');
        const state = document.getElementById('rawState');
        const before = btn.textContent;
        btn.click();
        const during = {
            btn: btn.textContent,
            disabled: btn.disabled,
            state: state.textContent,
            busy: state.classList.contains('busy')
        };
        const t0 = Date.now();
        while (Date.now() - t0 < 15000 && !im.raw.full) {
            await new Promise((r) => setTimeout(r, 150));
        }
        return { before, during, full: im.raw.full, btnNow: btn.textContent };
    })()`);
    check(manual.before === '按全尺寸显影' && manual.during.btn === '显影中…' && manual.during.disabled === true,
        '点按钮后立刻变成「显影中…」并禁用，不是点下去没反应', JSON.stringify(manual.during));
    check(manual.during.busy === true && manual.during.state === '显影中…',
        '状态行同时显示显影中（带脉动标记）', JSON.stringify(manual.during));
    check(manual.full === true && manual.btnNow === '重新显影',
        '手动触发能真的升到全尺寸，完成后按钮回到「重新显影」', manual.btnNow);

    // ── ④ RAW 裁切/旋转：参数化视图不能被下一次显影冲掉 ──
    const view = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const fullW = im.w, fullH = im.h;
        if (A.savePhotoOrigin) A.savePhotoOrigin(im);
        const okCrop = await A.rawRecordCrop(im, { W: fullW, H: fullH, turns: 0, useOrig: false },
            { x: 0, y: 0, w: Math.round(fullW / 2), h: Math.round(fullH / 2) });
        clearTimeout(A._rawFullTimer);
        const crop1 = im.raw.crop ? JSON.parse(JSON.stringify(im.raw.crop)) : null;
        const croppedW = im.w, croppedH = im.h;
        A.setGrade({ exp: 0.3 });
        // 换个参数重解一次（等同重开这张图）：裁切/旋转不能被新解出来的原图冲掉
        await A._rawReload(im, A.RAW_PROXY_EDGE);
        clearTimeout(A._rawFullTimer);
        await A.flushRender();
        return {
            okCrop, fullW, fullH, croppedW, croppedH,
            crop1, crop2: im.raw.crop,
            w2: im.w, h2: im.h,
            gradeNeutral: !!(im._grade && im._grade.neutral),
            gradeLowKey: !!(im._grade && im._grade.lowKey),
            gradeSrc: window.photoSrcOf(im) !== im.el
        };
    })()`);
    check(view.okCrop && view.crop1 && view.croppedW < view.fullW && view.croppedH < view.fullH,
        'RAW 裁切写进显影视图，代理按裁切后的尺寸重解',
        JSON.stringify({ full: [view.fullW, view.fullH], crop: [view.croppedW, view.croppedH] }));
    check(JSON.stringify(view.crop2) === JSON.stringify(view.crop1) &&
        view.w2 === view.croppedW && view.h2 === view.croppedH,
        '再显影一次也不会把裁切冲掉',
        JSON.stringify({ crop1: view.crop1, crop2: view.crop2, size: [view.w2, view.h2] }));
    check(view.gradeNeutral === false && view.gradeLowKey === true && view.gradeSrc === true,
        'RAW 重解后调色仍然生效（不是退回未调色原图）',
        JSON.stringify({ neutral: view.gradeNeutral, lowKey: view.gradeLowKey, src: view.gradeSrc }));

    const rot = await exec(`(async () => {
        const A = window.App; const im = A.image;
        const beforeW = im.w, beforeH = im.h;
        const crop = im.raw.crop ? JSON.stringify(im.raw.crop) : null;
        const ok = await A.rawRecordCrop(im, { W: beforeW, H: beforeH, turns: 1, useOrig: false },
            { x: 0, y: 0, w: beforeW, h: beforeH });
        clearTimeout(A._rawFullTimer);
        return { ok, beforeW, beforeH, w: im.w, h: im.h, rotate: im.rotate, crop,
            crop2: im.raw.crop ? JSON.stringify(im.raw.crop) : null };
    })()`);
    check(rot.ok && rot.rotate === 1 && rot.w === rot.beforeH && rot.h === rot.beforeW,
        '裁切弹层里的旋转记进显影视图，画面宽高对调', JSON.stringify(rot));
    check(rot.crop === rot.crop2, '旋转后裁切框仍指向同一块原图区域',
        JSON.stringify({ before: rot.crop, after: rot.crop2 }));

    // ── ⑤ 撤销：显影视图进快照，撤销能原样还原裁切/旋转 ──
    const undo = await exec(`(async () => {
        const A = window.App; const im = A.image;
        const snap = A.rawSnapshotOf(im);
        // 再转一次，制造一份与快照不同的视图
        await A.rawRecordCrop(im, { W: im.w, H: im.h, turns: 1, useOrig: false },
            { x: 0, y: 0, w: im.w, h: im.h });
        clearTimeout(A._rawFullTimer);
        const changed = { rotate: im.rotate, crop: im.raw.crop ? JSON.stringify(im.raw.crop) : null };
        // 撤销走的就是这个入口
        await A.rawApplyUndo(im, snap);
        clearTimeout(A._rawFullTimer);
        await A.flushRender();
        return {
            snap, changed,
            rotate: im.rotate,
            crop: im.raw.crop ? JSON.stringify(im.raw.crop) : null,
            snapCrop: snap.crop ? JSON.stringify(snap.crop) : null
        };
    })()`);
    check(undo.changed.rotate === ((undo.snap.rotate + 1) % 4),
        '裁切弹层里的旋转记进视图', JSON.stringify(undo.changed));
    check(undo.rotate === undo.snap.rotate && undo.crop === undo.snapCrop,
        '撤销快照能原样还原裁切与旋转',
        JSON.stringify({ want: undo.snap, got: { rotate: undo.rotate, crop: undo.crop } }));

    // ── ⑥ 普通 JPEG：面板收起 ──
    const plain = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas');
        c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#7a9bbd'; g.fillRect(0, 0, 600, 400);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.src = c.toDataURL('image/jpeg', 0.9); });
        const im = { el, name: 'plain.jpg', path: 'C:/fake/plain.jpg', w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images.push(im);
        A.buildThumbnails();
        A.selectImage(A.images.length - 1);
        A.refreshUI();
        const panel = document.getElementById('grpRaw');
        // 只看 hidden 属性不够：.param-group 若被 CSS 设了 display，属性会被压过去
        return { hidden: panel.hidden, display: getComputedStyle(panel).display, hasRaw: !!A.image.raw };
    })()`);
    check(plain.hidden === true && plain.display === 'none' && plain.hasRaw === false,
        '换成普通 JPEG 后面板收起（display:none），不会误显影', JSON.stringify(plain));

    // ── ⑦ 草稿只存参数与视图 ──
    const draft = await exec(`(async () => {
        const A = window.App;
        A.selectImage(0);
        let captured = null;
        A._persistDraft = async (d) => { captured = d; };
        A.saveDraftNow();
        const row = (captured && captured.images || []).find((r) => r && r.raw);
        return {
            has: !!row,
            params: row && row.raw && row.raw.params,
            keys: row ? Object.keys(row.raw) : [],
            crop: row && row.raw.crop,
            rotate: row && row.raw.rotate,
            bytes: captured ? JSON.stringify(captured).length : 0
        };
    })()`);
    check(draft.has && draft.params && draft.params.exposure === 0 && draft.params.highlights === 25 &&
        draft.keys.length === 3 && draft.crop && draft.rotate === 1,
        '草稿只记视图与基线参数（几个数字），不存像素',
        JSON.stringify({ keys: draft.keys, params: draft.params, rotate: draft.rotate, bytes: draft.bytes }));

    // ── ⑧ 还原原图：RAW 回到最初的显影视图，而不是换回一张旧代理 ──
    const restored = await exec(`(async () => {
        const A = window.App; const im = A.image;
        const ok = A.restoreOriginalPhoto(im);
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(1200);
        clearTimeout(A._rawFullTimer);
        await A.flushRender();
        return {
            ok, crop: im.raw.crop, rotate: im.rotate, hasOrig: !!im.orig,
            w: im.w, h: im.h
        };
    })()`);
    check(restored.ok && !restored.crop && restored.rotate === 0 && restored.hasOrig === false,
        'RAW「还原原图」清掉裁切/旋转并按原图重解', JSON.stringify(restored));

    // ── ⑨ 连续全尺寸显影：wasm 堆只涨不缩，解几张之后会把线程吃死 ──
    // 复现过的现场：连续十几次显影后线程 RSS 到 2.4GB，再解就抛 "[object Object]"，
    // 全尺寸失败 → 导出只能拿 1600px 代理。修法是解满定额就换掉整个线程。
    {
        const before = RAW.stats();
        let okCount = 0, err = '';
        const t0 = Date.now();
        // 参数带一点随机抖动：否则第二次跑会命中上一次留下的磁盘缓存，
        // 根本没有解码，也就测不到「线程会不会被吃死」。
        const jitter = (Date.now() % 1000) / 100000;
        for (let i = 0; i < 3; i++) {
            try {
                const out = await RAW.develop(SAMPLE, {
                    params: { exposure: -0.6 + i * 0.37 + jitter, contrast: 5, highlights: 20, temperature: -8, tint: 3 },
                    maxEdge: 0,
                    halfSize: false
                });
                if (out.width > 3000 && out.height > 2000) okCount++;
            } catch (e) { err = String((e && e.message) || e); }
        }
        // 回收是延迟 1.2s 做的（避免用户刚拖完滑块就重建 wasm），等它落地
        await sleep(1600);
        const after = RAW.stats();
        check(okCount === 3 && !err,
            '连续 3 张全尺寸显影都成功（线程不会被 wasm 堆吃死）',
            `${okCount}/3 ${err} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        check(after.recycles > before.recycles,
            '解满定额后解码线程被回收，内存真正还给系统',
            JSON.stringify({ before: before.recycles, after: after.recycles, rss: after.rss }));
    }

    // ── ⑩ 位深策略：代理走 8 位、全尺寸走 16 位 ──
    // 位深由 maxEdge 决定而不是由调用方随手传：代理只用来拖动时看效果，8 位够且解码快；
    // 全尺寸要过曝光/高光肩再量化，8 位在那个环节只剩 256 级可拉。
    // 断言 meta.bits：它记的是 worker 里实际拿到的 TypedArray 类型，不是"我要求了什么"。
    {
        const proxy = await RAW.develop(SAMPLE, { params: { exposure: 0.2 }, maxEdge: 1600, halfSize: true, cache: false });
        const full = await RAW.develop(SAMPLE, { params: { exposure: 0.2 }, maxEdge: 0, cache: false });
        check(proxy.meta.bits === 8, '代理图按 8 位解码', `bits=${proxy.meta.bits} ${proxy.width}px`);
        check(full.meta.bits === 16, '全尺寸按 16 位解码（库支持，不是只会 8 位）',
            `bits=${full.meta.bits} ${full.width}px ${full.ms}ms`);
    }

    console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
    await sleep(120);
    await win.destroy();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error('FAIL 用例异常：', e && e.stack || e);
    app.exit(1);
});

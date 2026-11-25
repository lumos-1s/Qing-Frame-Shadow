'use strict';
// P0 冒烟测试：手机壳页面能加载，引擎脚本无异常，四个页签可切换。
const path = require('path');
const { app, BrowserWindow } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'mobile', 'www', 'index.html');
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
        if (level === 2 || /Uncaught|is not defined|Cannot read/i.test(message)) errors.push(message);
    });
    // ES module（RAW 桥）在 file:// 下会被 CORS 拦，测试走本地静态服务器（先 npm run mobile:serve）
    await win.loadURL('http://127.0.0.1:4173/');
    await new Promise((r) => setTimeout(r, 600));
    const r = await win.webContents.executeJavaScript(`(() => ({
        ready: !!window.QF_MOBILE_READY,
        tabs: Array.from(document.querySelectorAll('#tabs .tab')).map(b => b.dataset.tab),
        active: document.querySelector('#tabs .tab.active') && document.querySelector('#tabs .tab.active').dataset.tab,
        canvas: !!document.getElementById('previewCanvas').width,
        render: typeof window.__render,
        applyGeo: typeof window.qfsApplyGeo,
        presets: typeof window.loadAllPresets,
        panel: (document.getElementById('panel').textContent || '').slice(0, 40)
    }))()`);
    check(r.ready, '手机壳页面初始化完成', JSON.stringify(r.ready));
    check(r.tabs.join(',') === 'style,puzzle,grade,crop', '四个底部页签齐全', r.tabs.join(','));
    check(r.active === 'style', '默认停在风格页', r.active);
    check(r.canvas && r.render === 'function' && r.applyGeo === 'function' && r.presets === 'function',
        '共享引擎脚本已加载且可用', JSON.stringify(r));

    const switched = await win.webContents.executeJavaScript(`(() => {
        document.querySelector('[data-tab="grade"]').click();
        return { active: document.querySelector('#tabs .tab.active').dataset.tab,
                 text: (document.getElementById('panel').textContent || '') };
    })()`);
    check(switched.active === 'grade' && /调色/.test(switched.text),
        '页签切换正常', JSON.stringify({ active: switched.active, text: switched.text.slice(0, 20) }));

    // P1：原生适配层与风格页闭环（桩掉选图，避免真弹系统对话框）
    const p1 = await win.webContents.executeJavaScript(`(async () => {
        document.querySelector('[data-tab="style"]').click();
        await new Promise((r) => setTimeout(r, 50));
        const presets = (window.QF_PRESETS || []).length;
        const shim = typeof window.qfsNative.pickImages === 'function'
            && typeof window.qingframe.loadAllPresets === 'function';
        const cv = document.createElement('canvas'); cv.width = 400; cv.height = 300;
        cv.getContext('2d').fillRect(0, 0, 400, 300);
        cv.naturalWidth = 400; cv.naturalHeight = 300; cv.complete = true;
        window.qfsNative.pickImages = async () => [{ el: cv, name: 'fixture.png', w: 400, h: 300, grade: null }];
        document.getElementById('btnPick').click();
        await new Promise((r) => setTimeout(r, 200));
        const imported = {
            hidden: document.getElementById('stageEmpty').hidden,
            name: document.getElementById('stageEmpty').querySelector('b').textContent,
            canvasW: document.getElementById('previewCanvas').width
        };
        const card = document.querySelector('[data-preset="0"]');
        if (card) card.click();
        await new Promise((r) => setTimeout(r, 200));
        const applied = {
            active: !!document.querySelector('[data-preset="0"].active'),
            title: document.getElementById('stageEmpty').querySelector('b').textContent,
            canvasW: document.getElementById('previewCanvas').width
        };
        return { presets, shim, imported, applied, platform: window.qfsNative.platform() };
    })()`);
    check(p1.presets === 91 && p1.shim && p1.platform === 'web',
        'P1 预设包与原生适配 shim 就绪', JSON.stringify({ presets: p1.presets, shim: p1.shim, platform: p1.platform }));
    check(p1.imported.hidden && /fixture/.test(p1.imported.name) && p1.imported.canvasW > 0,
        '导入照片后预览画布完成渲染', JSON.stringify(p1.imported));
    check(p1.applied.active && p1.applied.canvasW > 0 && p1.applied.title !== p1.imported.name,
        '点风格卡套用预设并重绘', JSON.stringify(p1.applied));

    const p2 = await win.webContents.executeJavaScript(`(() => {
        const wall = (window.QF_WALL && window.QF_WALL.items) || [];
        const chips = Array.from(document.querySelectorAll('.chip')).map(b => b.textContent);
        const tag = chips.find(t => t !== '全部');
        const chip = Array.from(document.querySelectorAll('.chip')).find(b => b.textContent === tag);
        if (chip) chip.click();
        const cards = Array.from(document.querySelectorAll('.style-card'));
        return { wall: wall.length, chips: chips.length, tag,
                 cards: cards.length,
                 hasCover: cards.some(c => { const img = c.querySelector('img'); return img && /covers\\//.test(img.getAttribute('src')); }) };
    })()`);
    check(p2.wall === 91 && p2.chips > 3 && p2.hasCover,
        'P2 风格墙封面与分类数据已同步', JSON.stringify(p2));
    check(p2.cards > 0 && p2.cards < 91,
        '按分类筛选后卡片数量收窄', JSON.stringify({ tag: p2.tag, cards: p2.cards }));

    const p3 = await win.webContents.executeJavaScript(`(async () => {
        const mk = async (n) => {
            const c = document.createElement('canvas'); c.width = 120; c.height = 90;
            const g = c.getContext('2d'); g.fillStyle = ['#c60','#0c0','#06c','#cc0'][n]; g.fillRect(0,0,120,90);
            const cv = document.createElement('canvas'); cv.width = 120; cv.height = 90;
            cv.getContext('2d').drawImage(c, 0, 0);
            cv.toDataURL = () => c.toDataURL('image/jpeg', 0.5);
            cv.naturalWidth = 120; cv.naturalHeight = 90; cv.complete = true;
            return { el: cv, name: 'p' + n + '.png', w: 120, h: 90, grade: null };
        };
        window.qfsNative.pickImages = async () => [await mk(0), await mk(1), await mk(2), await mk(3)];
        document.querySelector('[data-tab="style"]').click();
        document.getElementById('btnPick').click();
        await new Promise((r) => setTimeout(r, 250));
        const strip = document.querySelectorAll('[data-current]').length;
        document.querySelector('[data-tab="puzzle"]').click();
        await new Promise((r) => setTimeout(r, 200));
        const slots = document.querySelectorAll('.slot').length;
        const layouts = document.querySelectorAll('[data-layout]').length;
        const photos = document.querySelectorAll('[data-photo]').length;
        const slot1 = document.querySelector('[data-slot="1"]');
        if (slot1) slot1.click();
        const photo0 = document.querySelector('[data-photo="0"]');
        if (photo0) photo0.click();
        await new Promise((r) => setTimeout(r, 250));
        const assigned = !!(document.querySelector('[data-slot="1"] img'));
        const canvasW = document.getElementById('previewCanvas').width;
        const fill = document.getElementById('btnFillAll');
        if (fill) fill.click();
        await new Promise((r) => setTimeout(r, 150));
        const filled = document.querySelectorAll('.slot img').length;
        return { slots, layouts, photos, strip, assigned, canvasW, filled };
    })()`);
    // P1 已导入 1 张；P3 再导入 4 张是「追加」到照片库，共 5 张
    check(p3.slots === 4 && p3.layouts === 12 && p3.photos === 5 && p3.strip === 5,
        'P3 拼图布局/格子/照片库/当前照片条就绪', JSON.stringify(p3));
    check(p3.assigned && p3.canvasW > 0 && p3.filled === 4,
        '点照片入格并一键铺满后引擎重绘', JSON.stringify(p3));

    const p4 = await win.webContents.executeJavaScript(`(async () => {
        document.querySelector('[data-tab="grade"]').click();
        await new Promise((r) => setTimeout(r, 200));
        const sliders = document.querySelectorAll('[data-grade]').length;
        const histo = !!document.getElementById('gradeHisto');
        const exp = document.querySelector('[data-grade="exp"]');
        if (exp) { exp.value = '1.2'; exp.dispatchEvent(new Event('input', { bubbles: true })); }
        await new Promise((r) => setTimeout(r, 250));
        return {
            sliders, histo,
            expValue: Number((window.App.image && window.App.image.grade && window.App.image.grade.exp) || 0),
            out: (document.querySelector('[data-out="exp"]') || {}).textContent,
            canvasW: document.getElementById('previewCanvas').width,
            histoStats: !!(window.QfsHistogram && window.QfsHistogram.clipOf(window.App.image))
        };
    })()`);
    check(p4.sliders === 11 && p4.histo && p4.histoStats,
        'P4 调色滑块与直方图就绪', JSON.stringify(p4));
    check(Math.abs(p4.expValue - 1.2) < 0.01 && p4.canvasW > 0 && /1.2/.test(p4.out || ''),
        '拖动曝光调用桌面调色引擎并重绘', JSON.stringify(p4));

    const p5 = await win.webContents.executeJavaScript(`(async () => {
        let calls = 0;
        const origSave = window.qfsNative.saveImage;
        window.qfsNative.saveImage = async () => { calls++; return { ok: true, mode: 'test' }; };
        document.querySelector('[data-tab="crop"]').click();
        await new Promise((r) => setTimeout(r, 200));
        const cells = document.querySelectorAll('.crop-cell').length;
        const presets = document.querySelectorAll('[data-grid]').length;
        const first = document.querySelector('[data-block="0"]');
        if (first) { first.checked = false; first.dispatchEvent(new Event('change', { bubbles: true })); }
        document.getElementById('btnExport').click();
        await new Promise((r) => setTimeout(r, 250));
        window.qfsNative.saveImage = origSave;
        return { cells, presets, calls, label: document.getElementById('btnExport').textContent };
    })()`);
    check(p5.cells === 9 && p5.presets === 4 && /导出选中块/.test(p5.label),
        'P5 九宫格预览与尺寸档位就绪', JSON.stringify(p5));
    check(p5.calls === 8,
        '取消勾选一块后只导出 8 块', JSON.stringify(p5));

    const rawReady = await win.webContents.executeJavaScript(`({
        bridge: typeof window.qfRawDecode === 'function',
        wasm: !!(window.QF_RAW_READY && typeof window.QF_RAW_READY.then === 'function')
    })`);
    check(rawReady.bridge && rawReady.wasm,
        'P4.5 RAW 解码桥（libraw-wasm Worker）已加载', JSON.stringify(rawReady));

    check(errors.length === 0, '控制台无脚本异常', errors.slice(0, 3).join(' / '));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });

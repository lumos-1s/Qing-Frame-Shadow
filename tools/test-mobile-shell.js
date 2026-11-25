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
    await win.loadFile(INDEX);
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
    check(errors.length === 0, '控制台无脚本异常', errors.slice(0, 3).join(' / '));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });

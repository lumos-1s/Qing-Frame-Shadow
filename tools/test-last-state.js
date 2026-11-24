// 启动状态恢复回归：qfs_last_state 必须在预设加载完成后真正生效。
// 旧版 restoreLastState 在 init 里同步执行，那时 presets=[]、template=null，
// 按预设名找不到、字段兜底也全部被 null 挡住，等于完全没恢复。
// 用法：node tools/run-electron.js tools/test-last-state.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
}

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); }
    catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) {
    ipcMain.handle(c, () => []);
}
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
ipcMain.handle('get-prefs', () => ({ fontScale: 1, theme: 'dark' }));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.26', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));

async function main() {
    const win = new BrowserWindow({
        width: 1000, height: 700, useContentSize: true,
        show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(ROOT, 'tools', 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            backgroundThrottling: false,
            // 允许这一条用例读取 qfs_last_state；其它 GUI 用例默认不继承开发机状态。
            additionalArguments: ['--qf-allow-last-state']
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (x) => win.webContents.executeJavaScript(x);

    const waitFor = async (expr, timeout = 10000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            try { if (await exec(expr)) return true; } catch (_) { /* 页面还在初始化 */ }
            await sleep(120);
        }
        return false;
    };

    const seed = async (state) => {
        await exec(`(() => {
            try {
                localStorage.setItem('qfs_intro_done', '1');
                localStorage.removeItem('qfs_draft_v1');
                localStorage.removeItem('qfs_inspector_width');
                localStorage.removeItem('qfs_sidebar_width');
                localStorage.setItem('qfs_last_state', ${JSON.stringify(JSON.stringify(state))});
            } catch (_) {}
            return true;
        })()`);
        await win.webContents.reload();
        if (!await waitFor('!!(window.App && window.App._presetsLoaded && window.App._lastStateApplied)', 15000)) {
            throw new Error('startup state restore did not finish');
        }
        await sleep(300);
    };

    // ① 保存的预设名能在重启后真正选中（含相框样式）
    await seed({ presetName: 'VHS录像带', photoFrameStyle: 'VHS_TAPE' });
    let restored = await exec(`(() => {
        const A = window.App;
        return {
            applied: A._lastStateApplied,
            presets: (A.presets || []).length,
            name: A.template ? A.template.templateName : '',
            style: A.template ? A.template.photoFrameStyle : ''
        };
    })()`);
    check(restored.applied && restored.presets > 80 && restored.name === 'VHS录像带'
          && restored.style === 'VHS_TAPE',
        '重启后按 presetName 恢复上次选中的预设', JSON.stringify(restored));
    // 空闲回调里的「选第一个预设」不能把它覆盖掉
    await sleep(1800);
    restored = await exec(`(() => {
        const A = window.App;
        return { name: A.template ? A.template.templateName : '', style: A.template ? A.template.photoFrameStyle : '' };
    })()`);
    check(restored.name === 'VHS录像带' && restored.style === 'VHS_TAPE',
        '恢复的预设不会被首帧「选第一个」覆盖', JSON.stringify(restored));

    // ①b 命中预设时，用户在预设上改过的字段必须覆盖回模板（旧实现直接 return 丢掉）
    await seed({
        presetName: 'VHS录像带',
        photoFrameStyle: 'VHS_TAPE',
        userSignature: '跨重启签名',
        cornerRadiusAll: 33,
        paramColor: '#123456',
        liquidGlassDate: 0,
        polaroidCaption: '拍立得文字',
        hassyCaption: '哈苏文字'
    });
    const tweaked = await exec(`(() => {
        const A = window.App;
        const t = A.template || {};
        const cc = t.cornerConfig || {};
        return {
            applied: A._lastStateApplied,
            name: t.templateName || '',
            signature: t.userSignature || '',
            corner: cc.cornerRadiusAll || 0,
            color: t.paramColor || '',
            glassDate: t.liquidGlassDate,
            polaroid: t.polaroidCaption || '',
            hassy: t.hassyCaption || ''
        };
    })()`);
    check(tweaked.applied && tweaked.signature === '跨重启签名' && tweaked.corner === 33
          && tweaked.color === '#123456' && tweaked.glassDate === 0
          && tweaked.polaroid === '拍立得文字' && tweaked.hassy === '哈苏文字',
        '命中预设时仍恢复签名/圆角/参数色/玻璃日期/拍立得/哈苏文字', JSON.stringify(tweaked));

    // ①c autoSaveState 必须真的写出这三项（旧版只读不写，重启永远回默认）
    const savedFields = await exec(`(() => {
        const A = window.App;
        A.template = A.template || A.defaultTemplate();
        A.template.liquidGlassDate = 0;
        A.template.polaroidCaption = '存档拍立得';
        A.template.hassyCaption = '存档哈苏';
        A.autoSaveState();
        try { return JSON.parse(localStorage.getItem('qfs_last_state') || '{}'); } catch (_) { return {}; }
    })()`);
    check(savedFields.liquidGlassDate === 0 && savedFields.polaroidCaption === '存档拍立得'
          && savedFields.hassyCaption === '存档哈苏',
        '自动存档写入玻璃日期/拍立得/哈苏文字', JSON.stringify({
            glassDate: savedFields.liquidGlassDate,
            polaroid: savedFields.polaroidCaption,
            hassy: savedFields.hassyCaption
        }));

    // ② 预设被删/改名时，字段兜底必须真的写进模板（旧版 template=null 全跳过）
    await seed({
        presetName: '不存在的预设',
        photoFrameStyle: 'VHS_TAPE',
        userSignature: '测试签名',
        cornerRadiusAll: 37,
        borderRadius: 21,
        paramColor: '#ff0000'
    });
    const fallback = await exec(`(() => {
        const A = window.App;
        const t = A.template || {};
        const cc = t.cornerConfig || {};
        return {
            applied: A._lastStateApplied,
            style: t.photoFrameStyle || '',
            signature: t.userSignature || '',
            corner: cc.cornerRadiusAll || 0,
            radius: t.borderRadius || 0,
            color: t.paramColor || ''
        };
    })()`);
    check(fallback.applied && fallback.style === 'VHS_TAPE' && fallback.signature === '测试签名'
          && fallback.corner === 37 && fallback.radius === 21 && fallback.color === '#ff0000',
        '预设找不到时，字段兜底真正落到模板上', JSON.stringify(fallback));

    console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
    console.error('TEST ERROR', e);
    app.exit(1);
});

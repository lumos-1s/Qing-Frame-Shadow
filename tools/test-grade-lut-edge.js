// 三维表取样在「蓝通道 = 255」这一端的连续性。
// 根因：lutLookup 先算 fb=z-floor(z) 再把 b0 夹到 g-2。b=1.0 时 b0=32 被夹成 31、
// fb 仍是 0，于是采样退回第 31 片 —— 比 b=254 的像素还往回跳一片，恒等表下不单调。
// 用法: node tools/run-electron.js tools/test-grade-lut-edge.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter(n => n.endsWith('.json')).map(n => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => { try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, n + '.json'), 'utf8')); } catch (_) { return null; } });
for (const ch of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(ch, () => []);
for (const ch of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'open-wall-covers-dir']) ipcMain.handle(ch, () => ({ ok: true }));
for (const ch of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) ipcMain.handle(ch, () => ({ canceled: true }));
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

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

// 恒等三维表：格子 (r,g,b) 的值就是它自己的坐标。
// 表是 33 张 33×33 切片横向拼成的（宽 33*33、高 33），
// 纹理 X = 蓝片号*33 + 红，Y = 绿。
const HELPERS = `
window.__identityLut = (grid) => {
    const g = grid, W = g * g;
    const rgba = new Uint8Array(W * g * 4);
    for (let gy = 0; gy < g; gy++) {
        for (let b = 0; b < g; b++) {
            for (let r = 0; r < g; r++) {
                const i = ((gy * W) + b * g + r) * 4;
                rgba[i] = Math.round(r / (g - 1) * 255);
                rgba[i + 1] = Math.round(gy / (g - 1) * 255);
                rgba[i + 2] = Math.round(b / (g - 1) * 255);
                rgba[i + 3] = 255;
            }
        }
    }
    return { grid: g, rgba, token: Date.now() };
};
// 竖条：每列一个确定的蓝色值，方便一次读回整排
window.__blueStrip = (vals) => {
    const c = document.createElement('canvas');
    c.width = vals.length; c.height = 4;
    const x = c.getContext('2d');
    vals.forEach((v, i) => { x.fillStyle = 'rgb(128,128,' + v + ')'; x.fillRect(i, 0, 1, 4); });
    return c;
};
window.__readRow = (src) => {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const x = c.getContext('2d');
    x.drawImage(src, 0, 0);
    const d = x.getImageData(0, 1, src.width, 1).data;
    const out = [];
    for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]);
    return out;
};
true;
`;

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (e) => win.webContents.executeJavaScript(e);
    await sleep(400);
    win.showInactive();
    await exec(`(() => { try { localStorage.setItem('qfs_intro_done','1'); } catch(_) {}
        if (window.App && App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(900);
    await exec(HELPERS);

    const gl = await exec('!!(window.QfsColor && window.QfsColor.usingGL())');
    if (!gl) {
        console.log('SKIP  没有可用的 WebGL，取样只在 GL 通道里发生');
        app.exit(0);
        return;
    }

    // 恒等表 + 全零参数：输出必须等于输入。蓝通道取 250…255 连着六列。
    const run = await exec(`(async () => {
        const vals = [250, 252, 253, 254, 255];
        const src = window.__blueStrip(vals);
        const lut = window.__identityLut(33);
        const p = Object.assign(window.App.defaultGrade(), {
            exp: 0, con: 0, sat: 0, vib: 0, temp: 0, tint: 0, hi: 0, sh: 0,
            white: 0, black: 0, gam: 0, curve: null, cal: null, det: null,
            mix: null, cg: null, bw: null, cb: null, gm: null, lc: null, samples: null
        });
        const out = window.QfsColor.pass(src, p, src.width, src.height, lut, null, null);
        if (!out) return { err: 'pass 返回空' };
        return { vals, src: window.__readRow(src), out: window.__readRow(out) };
    })()`);

    if (run.err) {
        check(false, '三维表取样通道可用', run.err);
    } else {
        const bOut = run.out.map((v) => v[2]);
        console.log('   输入蓝 ' + run.vals.join('/') + '  输出蓝 ' + bOut.join('/'));
        // 1) 恒等表下不许改变输入（容差 1 级：8 位量化 + 三线性）
        const maxErr = Math.max(...bOut.map((v, i) => Math.abs(v - run.vals[i])));
        check(maxErr <= 1, '恒等表原样返回（蓝 250…255，误差 ≤1 级）', `最大差 ${maxErr} 级`);

        // 2) 必须单调不减：之前 255 会掉回 247 左右，比 254 还低
        let mono = true;
        for (let i = 1; i < bOut.length; i++) if (bOut[i] < bOut[i - 1]) mono = false;
        check(mono, '蓝通道在 254 → 255 之间不回跳', bOut.join('/'));

        // 3) 端点必须真的到 255（不是被夹在 31/32 = 247）
        check(bOut[bOut.length - 1] >= 254, '蓝 255 的输出仍在 255 附近', String(bOut[bOut.length - 1]));
    }

    console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    app.exit(1);
});

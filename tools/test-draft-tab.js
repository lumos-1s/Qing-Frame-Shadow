// 「继续上次会话」要回到离开时的页签（尤其是拼图）。
//
// 旧行为：草稿只存照片/模板，不存右侧页签。拼图模板其实已经挂回照片，
// 但界面仍停在「画布」，用户看到一堆照片 + 单图面板，会以为拼图没恢复。
//
// 用法：node tools/run-electron.js tools/test-draft-tab.js
// 离屏运行；userData 用临时目录，绝不碰用户真实草稿。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const TMP_UD = path.join(os.tmpdir(), 'qfs-test-drafttab-' + process.pid);
app.setPath('userData', TMP_UD);
process.on('exit', () => { try { fs.rmSync(TMP_UD, { recursive: true, force: true }); } catch (e) {} });

for (const c of ['list-presets', 'list-logos', 'list-textures', 'list-marks', 'list-templates',
    'list-custom-icons', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['save-template', 'load-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif',
    'save-image-base64', 'save-images-batch', 'check-for-updates',
    'start-update-download', 'quit-and-install', 'write-export-files']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template',
    'open-qfs', 'pick-export-location']) ipcMain.handle(c, () => ({ canceled: true }));

const RUN = `(async () => {
  const A = window.App;
  const out = [];
  const add = (ok, label, got) => out.push({ ok: !!ok, label: label, got: String(got) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── 布景：一张照片 + 启用中的拼图模板，停在拼图页签 ──
  const cv = document.createElement('canvas'); cv.width = 400; cv.height = 300;
  const g = cv.getContext('2d'); g.fillStyle = '#b85c38'; g.fillRect(0, 0, 400, 300);
  const el = new Image();
  await new Promise(r => { el.onload = r; el.onerror = r; el.src = cv.toDataURL('image/png'); });

  const im = { el: el, name: '拼图.png', path: 'test://puzzle.png', w: 400, h: 300, exif: {}, customSettings: null };
  A.images = [im]; A.image = im; A.currentIdx = 0;
  A.template = A.defaultTemplate();
  const pk = A.template.puzzle;
  pk.enabled = 1; pk.layout = 'grid4'; pk.layoutType = 6; pk.canvasRatio = 'auto';
  A.setTpl(im, JSON.parse(JSON.stringify(A.template)));
  A.buildThumbnails();
  A.switchTab('puzzle');
  A.saveDraftNow();
  await sleep(300);

  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(A._draftKey) || 'null'); } catch (e) { draft = null; }
  add(draft && draft.tab === 'puzzle', '草稿记下了离开时的页签', draft && draft.tab);
  add(!!(draft && draft.template && draft.template.puzzle && draft.template.puzzle.enabled),
      '草稿模板里的拼图没有被丢掉', draft && draft.template && draft.template.puzzle ? 'enabled=' + draft.template.puzzle.enabled : 'missing');

  // 恢复时不走文件解码：只验「页签/模板/面板」这条 UI 链，假图对象足够
  A.imageFromMeta = async (meta, tpl) => ({
    el: el, name: meta.name, path: meta.path, w: 400, h: 300, exif: {},
    customSettings: tpl ? JSON.parse(JSON.stringify(tpl)) : null
  });

  const resetToCanvas = () => {
    if (A._draftTimer) { clearTimeout(A._draftTimer); A._draftTimer = null; }
    A.images = []; A.image = null; A.template = null; A.currentIdx = 0;
    A.switchTab('canvas');
  };
  const activeTab = () => {
    const t = document.querySelector('#inspTabs .tab.active');
    return t ? t.dataset.tab : '';
  };

  // ① 正常恢复：回到拼图页签，面板与导出按钮都要跟着
  resetToCanvas();
  await A.restoreDraft();
  add(activeTab() === 'puzzle', '恢复后回到拼图页签', activeTab());
  add(!!(A.template && A.template.puzzle && A.template.puzzle.enabled), '恢复后的模板仍是拼图', A.template && A.template.puzzle ? 'enabled=' + A.template.puzzle.enabled : 'missing');
  add(document.getElementById('panel-puzzle').classList.contains('active'), '拼图面板真的显示出来', document.getElementById('panel-puzzle').className);
  const saveLabel = document.getElementById('btnSaveLabel');
  add(!!saveLabel && saveLabel.textContent === '导出拼图', '主导出按钮变成「导出拼图」', saveLabel && saveLabel.textContent);

  // ② 老草稿没有 tab 字段：拼图开着就兜底回拼图，不能停在画布
  let raw = JSON.parse(localStorage.getItem(A._draftKey) || 'null');
  if (raw) { delete raw.tab; localStorage.setItem(A._draftKey, JSON.stringify(raw)); }
  resetToCanvas();
  await A.restoreDraft();
  add(activeTab() === 'puzzle', '老草稿没有 tab，也按拼图兜底', activeTab());

  // ③ 记下的页签优先：离开时在调色，就回调色，不因为拼图开着被拽走
  raw = JSON.parse(localStorage.getItem(A._draftKey) || 'null');
  if (raw) { raw.tab = 'grade'; localStorage.setItem(A._draftKey, JSON.stringify(raw)); }
  resetToCanvas();
  await A.restoreDraft();
  add(activeTab() === 'grade', '记下的页签优先于拼图兜底', activeTab());

  if (A._draftTimer) { clearTimeout(A._draftTimer); A._draftTimer = null; }
  try { localStorage.removeItem(A._draftKey); } catch (e) {}
  return out;
})()`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1200, height: 800, show: false,
        webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
    });
    win.webContents.on('console-message', (_e, l, m) => {
        const s = String(m);
        if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 200));
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 60; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    await new Promise(r => setTimeout(r, 800));

    const fails = [];
    console.log('草稿恢复页签：拼图回到拼图 / 老草稿兜底 / 记下的页签优先');
    console.log('─'.repeat(78));
    let res = null;
    try {
        res = await win.webContents.executeJavaScript(RUN);
    } catch (e) {
        console.log('  执行异常: ' + (e && e.message));
        fails.push('执行异常');
    }
    if (Array.isArray(res)) {
        for (const r of res) {
            console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.label}${r.got ? ' | ' + r.got : ''}`);
            if (!r.ok) fails.push(r.label);
        }
    } else {
        console.log('  FAIL 页面探针应返回数组 | ' + String(res));
        fails.push('页面探针应返回数组');
    }
    console.log('─'.repeat(78));
    console.log(fails.length ? `FAILED ${fails.length} · 草稿恢复页签` : `ALL PASS · 草稿恢复页签（${(res || []).length} 项）`);
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });

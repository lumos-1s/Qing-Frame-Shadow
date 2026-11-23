// 编辑界面布局回归（离屏，show:false）：
//   ① 拼图/切图提到右侧主页签，边框参数收进「更多」
//   ② 相机参数(自动识别)默认收起，不再把后面的分区顶出视口
//   ③ 状态栏尺寸与消息分段；启动引导语有照片后不再挂着
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const TMP_UD = path.join(os.tmpdir(), 'qfs-test-uilayout-' + process.pid);
app.setPath('userData', TMP_UD);
process.on('exit', () => { try { fs.rmSync(TMP_UD, { recursive: true, force: true }); } catch (e) {} });

for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates', 'list-custom-icons', 'list-presets', 'load-all-presets', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'copy-text', 'save-diagnostics', 'check-for-updates', 'quit-and-install', 'open-external', 'open-data-dir', 'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'read-exif']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('open-image', () => ({ canceled: true }));
ipcMain.handle('pick-export-location', () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);

const RUN = `(async () => {
  const A = window.App;
  const res = [];
  const add = (ok, label, got) => res.push({ ok: !!ok, label: label, got: String(got) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);

  try {
    if (A.closeIntro) A.closeIntro();
    await sleep(200);
    const skip = $('pwSkip'); if (skip) skip.click();
    await sleep(400);

    // ① 页签层级
    const tabs = Array.from(document.querySelectorAll('#inspTabs .tab'));
    const primary = tabs.filter(t => !t.closest('#tabMoreMenu')).map(t => t.dataset.tab);
    const inMenu = tabs.filter(t => !!t.closest('#tabMoreMenu')).map(t => t.dataset.tab);
    add(primary.indexOf('puzzle') >= 0 && primary.indexOf('grid') >= 0,
        '拼图/切图升到主页签', primary.join(','));
    add(inMenu.indexOf('template') >= 0 && inMenu.indexOf('border') < 0,
        '「更多」只留样式，边框不再藏在两级菜单', inMenu.join(','));
    add(!!document.querySelector('#canvasSubTabs [data-subtab="border"]'),
        '边框参数并进画布页的子页签', 'canvasSubTabs');
    add(document.querySelector('#inspTabs .tab-icon[data-tab="puzzle"]')
        && document.querySelector('#inspTabs .tab-icon[data-tab="grid"]'),
        '两个主页签用紧凑图标，不挤占宽度', 'ok');

    // ② 相机参数默认收起
    const cam = Array.from(document.querySelectorAll('.param-group'))
        .find(g => /相机参数\\(自动识别\\)/.test(g.textContent));
    add(!!cam && cam.classList.contains('collapsed'),
        '相机参数默认收起', cam && cam.className);

    // ③ 状态栏分段
    add(!!$('stSize') && !!$('stMsg') && $('stSize').parentElement.id === 'stCanvas',
        '尺寸口径与状态消息拆成两段', $('stCanvas').textContent);

    A.images = []; A.currentIdx = -1; A.image = null;
    A.setStatus('已进入工作台，从左侧工具栏导入照片开始');
    add(/已进入工作台/.test($('stMsg').textContent),
        '空工作区仍显示启动引导语', $('stMsg').textContent);

    const cv = document.createElement('canvas'); cv.width = 600; cv.height = 800;
    const g = cv.getContext('2d'); g.fillStyle = '#a06040'; g.fillRect(0, 0, 600, 800);
    const pic = new Image();
    await new Promise(r => { pic.onload = r; pic.onerror = r; pic.src = cv.toDataURL('image/jpeg', 0.8); });
    A.images = [{ el: pic, name: '01.jpg', w: 600, h: 800, exif: {}, customSettings: null }];
    A.currentIdx = 0; A.image = A.images[0];
    A.template = A.defaultTemplate();
    A.buildThumbnails(); A.updateEmptyState(); A.afterImageSelect();
    A.setStatus('已进入工作台，从左侧工具栏导入照片开始');
    add($('stMsg').textContent === '', '有照片后启动引导语不再挂着', $('stMsg').textContent);
    add(/输出/.test($('stSize').textContent), '尺寸段始终在', $('stSize').textContent);

    // ④ 画布子页 / 左栏跟随页签 / 胶片条外置
    A.switchTab('border');
    add($('panel-canvas').classList.contains('active') && !$('panel-border').hidden
        && $('canvasSubBasic').hidden,
        'switchTab(border) 落到画布页的边框子页',
        JSON.stringify({ canvas: $('panel-canvas').classList.contains('active'),
            border: !$('panel-border').hidden, basic: !$('canvasSubBasic').hidden }));
    document.querySelector('#canvasSubTabs [data-subtab="basic"]').click();
    add(!$('canvasSubBasic').hidden && $('panel-border').hidden,
        '点子页签回到画布与照片',
        JSON.stringify({ basic: !$('canvasSubBasic').hidden, border: !$('panel-border').hidden }));

    A.switchTab('grade');
    add($('sideTabGrade').classList.contains('active') && !$('sideGradeBody').hidden,
        '进调色页，左栏自动切到调色预设',
        JSON.stringify({ active: $('sideTabGrade').classList.contains('active'), hidden: $('sideGradeBody').hidden }));
    A.switchTab('canvas');
    add($('sideTabBorder').classList.contains('active') && !$('sideBorderBody').hidden,
        '离开调色页，左栏还原素材库',
        JSON.stringify({ active: $('sideTabBorder').classList.contains('active'), hidden: $('sideBorderBody').hidden }));

    A.switchTab('grid');
    add(document.body.classList.contains('sidebar-collapsed') && !$('btnSidebarRail').hidden,
        '切图页自动收起左栏，把宽度让给切割预览',
        JSON.stringify({ collapsed: document.body.classList.contains('sidebar-collapsed'),
            rail: !$('btnSidebarRail').hidden }));
    A.switchTab('canvas');
    add(!document.body.classList.contains('sidebar-collapsed'),
        '离开切图页恢复左栏', document.body.className);

    const sr = document.querySelector('.stage').getBoundingClientRect();
    const tr = $('thumbStrip').getBoundingClientRect();
    add(tr.top >= sr.bottom - 1,
        '胶片条落在画布卡片下方的预留带，不遮画面',
        'strip.top=' + Math.round(tr.top) + ' stage.bottom=' + Math.round(sr.bottom));

    A.setStatus('已导入 3 张图片，跳过 1 个不支持的文件');
    add($('stMsg').textContent === '已导入 3 张图片，跳过 1 个不支持的文件'
        && /跳过 1 个/.test($('stCanvas').textContent),
        '真实的批量结果仍完整保留（不是启动语就不隐藏）', $('stCanvas').textContent);
  } catch (e) {
    res.push({ ok: false, label: '脚本异常', got: (e && e.stack) || String(e) });
  }
  return res;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 960, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise(r => setTimeout(r, 1400));
  let rows = [];
  try { rows = await win.webContents.executeJavaScript(RUN, true); }
  catch (e) { rows = [{ ok: false, label: '执行失败', got: (e && e.message) || String(e) }]; }
  let pass = 0;
  for (const r of rows) {
    if (r.ok) pass++;
    console.log((r.ok ? '  OK   ' : '  FAIL ') + r.label + '\n       ' + r.got);
  }
  console.log('─'.repeat(90));
  console.log((pass === rows.length ? '✓ 全部 ' : '✗ ') + rows.length + ' 项' + (pass === rows.length ? '通过' : '，通过 ' + pass));
  app.exit(pass === rows.length ? 0 : 1);
});

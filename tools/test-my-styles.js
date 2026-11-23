// 「我的样式」回归（离屏，show:false）：
//   ① 套用自己的样式不再清掉正在编辑的拼图/Logo/贴纸/自由文字（与内置预设同口径）
//   ② 同名保存先确认；另存为写新文件、原样式保留
//   ③ 列表显示修改时间，支持最近修改/最近使用排序，收藏与只看收藏
//   ④ 缩略图缓存键改短 hash，不再把整份 JSON 塞进 Map
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const TMP_UD = path.join(os.tmpdir(), 'qfs-test-mystyles-' + process.pid);
app.setPath('userData', TMP_UD);
process.on('exit', () => { try { fs.rmSync(TMP_UD, { recursive: true, force: true }); } catch (e) {} });

const store = new Map();
const mtimes = new Map();
let clock = 1700000000000;
const put = (name, data) => { store.set(name, data); mtimes.set(name, clock += 60000); return { ok: true }; };
put('甲的样式', { templateName: '甲的样式', templateTag: '旅行', baseMargin: { imgScale: 1.1 }, layerList: [] });
put('乙的样式', { templateName: '乙的样式', templateTag: '人像', baseMargin: { imgScale: 1.2 }, layerList: [] });
put('丙的样式', { templateName: '丙的样式', templateTag: '旅行', baseMargin: { imgScale: 1.3 }, layerList: [] });

ipcMain.handle('save-template', (_e, { name, data }) => put(name, data));
ipcMain.handle('list-templates', () => Array.from(store.keys()));
ipcMain.handle('list-template-meta', () => Array.from(store.keys()).map(n => ({ name: n, mtime: mtimes.get(n) || 0 })));
ipcMain.handle('load-template', (_e, n) => store.get(n) || null);
ipcMain.handle('delete-template', (_e, n) => { store.delete(n); return { ok: true }; });
ipcMain.handle('rename-template', () => ({ ok: false }));
for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates', 'list-custom-icons', 'list-presets', 'load-all-presets', 'list-wall-covers', 'list-grade-presets']) {
    if (c !== 'list-templates') ipcMain.handle(c, () => []);
}
for (const c of ['save-prefs', 'save-user', 'logout-user', 'export-template', 'export-qfs', 'copy-text', 'save-diagnostics', 'check-for-updates', 'quit-and-install', 'open-external', 'open-data-dir', 'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
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
  const origConfirm = window.confirm;

  try {
    if (A.closeIntro) A.closeIntro();
    await sleep(200);
    const skip = $('pwSkip'); if (skip) skip.click();
    await sleep(400);
    const cv = document.createElement('canvas'); cv.width = 600; cv.height = 800;
    const g = cv.getContext('2d'); g.fillStyle = '#a06040'; g.fillRect(0, 0, 600, 800);
    const pic = new Image();
    await new Promise(r => { pic.onload = r; pic.onerror = r; pic.src = cv.toDataURL('image/jpeg', 0.8); });
    A.images = [{ el: pic, name: 'a.png', w: 600, h: 800, exif: {}, customSettings: null }];
    A.currentIdx = 0; A.image = A.images[0]; A.template = A.defaultTemplate();
    A.buildThumbnails(); A.updateEmptyState(); A.afterImageSelect();
    A.switchTab('template');
    await sleep(200);
    await A.refreshTemplates();
    await sleep(150);

    // ① 套用自己的样式：拼图与用户内容不能被清掉
    const pk = A.template.puzzle;
    pk.enabled = 1; pk.layout = 'grid4';
    pk.slots = { 0: { imageIndex: 0 } };
    pk.captions = { 0: { line1: '我的字幕', size1: 28 } };
    A.template.logoElements = [{ id: 'logo-keep' }];
    A.template.decorConfig = A.template.decorConfig || {};
    A.template.decorConfig.stickers = [{ id: 'sticker-keep' }];
    A.template.decorConfig.textLines = [{ align: 'free', text: '我自己写的字' }];
    A.template.userSignature = '我的签名';
    const sigInput = $('inpSignature'); if (sigInput) sigInput.value = '我的签名';
    await A.loadTemplateByName('甲的样式');
    const after = A.template;
    add(after.puzzle && after.puzzle.enabled === 1 && after.puzzle.layout === 'grid4',
        '应用样式后拼图仍在', (after.puzzle || {}).layout);
    add(!!(after.puzzle && after.puzzle.captions && after.puzzle.captions[0]),
        '拼图字幕也保住了', JSON.stringify(after.puzzle && after.puzzle.captions));
    add(!!(after.logoElements && after.logoElements[0].id === 'logo-keep'), 'Logo 保住了',
        JSON.stringify(after.logoElements));
    add(!!(after.decorConfig && after.decorConfig.stickers && after.decorConfig.stickers[0].id === 'sticker-keep'),
        '贴纸保住了', JSON.stringify(after.decorConfig && after.decorConfig.stickers));
    add(!!(after.decorConfig && after.decorConfig.textLines && after.decorConfig.textLines.some(t => t.align === 'free')),
        '自由文字保住了', JSON.stringify(after.decorConfig && after.decorConfig.textLines));
    add(after.userSignature === '我的签名', '签名保住了', after.userSignature);

    // ② 同名保存先确认；取消就不写
    $('tfTemplateName').value = '乙的样式';
    let asks = 0;
    window.confirm = () => { asks++; return false; };
    await A.saveTemplate();
    const untouched = (await window.qingframe.loadTemplate('乙的样式')).baseMargin.imgScale;
    add(asks === 1 && untouched === 1.2, '同名保存会先问，取消就不覆盖', asks + ' / ' + untouched);
    window.confirm = () => { asks++; return true; };
    await A.saveTemplate();
    const overwritten = (await window.qingframe.loadTemplate('乙的样式')).baseMargin.imgScale;
    add(overwritten !== 1.2, '确认后才覆盖', overwritten);
    window.confirm = origConfirm;

    // ③ 另存为：新名字写新文件，原样式一个字不动
    const origPrompt = A.promptText;
    A.promptText = async () => '丁的又一版';
    $('tfTemplateName').value = '甲的样式';
    await A.saveTemplateAs();
    A.promptText = origPrompt;
    const names = await window.qingframe.listTemplates();
    add(names.indexOf('丁的又一版') >= 0 && names.indexOf('甲的样式') >= 0,
        '另存为写出新样式且原来那个还在', names.join(','));
    add((await window.qingframe.loadTemplate('甲的样式')).baseMargin.imgScale === 1.1,
        '原样式内容没被改', (await window.qingframe.loadTemplate('甲的样式')).baseMargin.imgScale);

    // ④ 修改时间显示 / 最近修改排序 / 最近使用排序
    await A.refreshTemplates();
    await sleep(150);
    const row = $('lvPresets').querySelector('.tpl-row');
    add(!!row && !!row.querySelector('.tpl-mtime') && row.querySelector('.tpl-mtime').textContent.length > 0,
        '列表行显示修改时间', row && row.querySelector('.tpl-mtime').textContent);
    const nameOrder = () => Array.from($('lvPresets').querySelectorAll('.tpl-row')).map(r => r.dataset.tplDisp);
    $('cbTplSort').value = 'mtime'; $('cbTplSort').dispatchEvent(new Event('change', { bubbles: true }));
    const byTime = nameOrder();
    add(byTime[0] === '丁的又一版', '最近修改排在最前', byTime.join(' > '));
    A.pushRecentTemplate('丙的样式');
    A._tplSort = 'recent'; $('cbTplSort').value = 'recent';
    A._applyTplFilter();
    const byRecent = nameOrder();
    add(byRecent[0] === '丙的样式', '最近使用排在最前', byRecent.join(' > '));

    // ⑤ 收藏 / 只看收藏 / 星标
    A.toggleFavTemplate('丙的样式');
    add(A.getFavTemplates().indexOf('丙的样式') >= 0, '菜单收藏写入偏好', A.getFavTemplates().join(','));
    $('btnTplFavOnly').click();
    const favs = nameOrder();
    add(favs.length === 1 && favs[0] === '丙的样式', '只看收藏时只剩收藏的那条', favs.join(','));
    const star = $('lvPresets').querySelector('.tpl-fav-star');
    add(star && !star.hidden, '收藏行显示星标', star && star.hidden);
    $('btnTplFavOnly').click();
    A.toggleFavTemplate('丙的样式');
    add(A.getFavTemplates().indexOf('丙的样式') < 0, '再点一次取消收藏', A.getFavTemplates().join(','));

    // ⑥ 缩略图键不再塞整份 JSON
    const r0 = (A._tplCache || [])[0];
    const key = A._tplThumbKey(r0);
    let json = '';
    try { json = JSON.stringify(r0.tpl); } catch (e) {}
    add(key.length < 80 && json.length > 0 && key.indexOf(json) < 0, '缩略图键是短 hash，不是整份模板',
        key.length + ' vs JSON ' + json.length);
    const key2 = A._tplThumbKey(r0);
    add(key === key2, '同一模板的键稳定', key);

    window.confirm = origConfirm;
  } catch (e) {
    res.push({ ok: false, label: '脚本异常', got: (e && e.stack) || String(e) });
  }
  return res;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1680, height: 1080, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise(r => setTimeout(r, 1400));
  let rows = [];
  try {
    rows = await win.webContents.executeJavaScript(RUN, true);
  } catch (e) {
    rows = [{ ok: false, label: '执行失败', got: (e && e.message) || String(e) }];
  }
  let pass = 0;
  for (const r of rows) {
    if (r.ok) pass++;
    console.log((r.ok ? '  OK   ' : '  FAIL ') + r.label + '\n       ' + r.got);
  }
  console.log('─'.repeat(90));
  console.log((pass === rows.length ? '✓ 全部 ' : '✗ ') + rows.length + ' 项' + (pass === rows.length ? '通过' : '，通过 ' + pass));
  app.exit(pass === rows.length ? 0 : 1);
});

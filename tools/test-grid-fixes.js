// 切图修复回归（离屏，show:false）：
//   ① 「渲染长边」真的改变输出像素，且不受上一次主导出残留的 exportScale 劫持
//   ② 画面提交/撤销会让预览切块缓存失效；批量只补全当前那张的全尺寸
//   ③ 留白标签带百分比；放大预览按真实导出格式，不再拿 JPEG 0.8 糊弄
//   ④ 预览里可取消勾选，只导出选中的块（块号保持原样）
//   ⑤ 构图偏移把主体从切分线上挪开，缓存键也跟着偏移变
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const TMP_UD = path.join(os.tmpdir(), 'qfs-test-gridfix-' + process.pid);
app.setPath('userData', TMP_UD);
process.on('exit', () => { try { fs.rmSync(TMP_UD, { recursive: true, force: true }); } catch (e) {} });

for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates', 'list-custom-icons', 'list-presets', 'load-all-presets', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'copy-text', 'save-diagnostics', 'check-for-updates', 'quit-and-install', 'open-external', 'open-data-dir', 'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template', 'read-exif']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('open-image', () => ({ canceled: true }));
ipcMain.handle('pick-export-location', () => ({ mode: 'dir', canceled: false, path: 'TEST-DIR' }));

let written = [];
let testWin = null;
ipcMain.handle('write-export-files', (_e, p) => {
    written = (p && p.files || []).map(f => ({ name: f.filename, size: (f.data || '').length }));
    // contextBridge 暴露的对象是冻结的，渲染层桩不掉；从主进程把结果注回页面
    if (testWin) {
        testWin.webContents.executeJavaScript('window.__gridWritten = ' + JSON.stringify(written)).catch(() => {});
    }
    return { ok: written.length, fail: 0 };
});
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);

const RUN = `(async () => {
  const A = window.App;
  const res = [];
  const add = (ok, label, got) => res.push({ ok: !!ok, label: label, got: String(got) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);

  try {
    const need = ['selGridSize', 'slGridPad', 'selGridRender', 'cbGridSubdir', 'slGridOffsetX', 'slGridOffsetY',
      'lblGridOffsetX', 'lblGridPad', 'gridPreviewGrid', 'btnGridPreviewExport', 'gridPreviewZoomImg',
      'btnGridZoomBack', 'btnGridPreviewExport', 'selFormat'];
    const missing = need.filter(x => !$(x));
    if (missing.length) { res.push({ ok: false, label: '控件缺失', got: missing.join(',') }); return res; }
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 800;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 1200, 0);
    grd.addColorStop(0, '#000000'); grd.addColorStop(1, '#ffffff');
    g.fillStyle = grd; g.fillRect(0, 0, 1200, 800);
    const img = new Image();
    await new Promise(r => { img.onload = r; img.onerror = r; img.src = cv.toDataURL('image/jpeg', 0.9); });
    A.images = [{ el: img, name: 'grad.png', w: 1200, h: 800, exif: {}, customSettings: null }];
    A.currentIdx = 0; A.image = A.images[0];
    A.template = A.defaultTemplate();
    A.buildThumbnails(); A.updateEmptyState(); A.afterImageSelect();
    await sleep(350);
    $('selGridSize').value = '3';
    $('slGridPad').value = '0';
    $('cbGridSubdir').checked = false;
    if (A.loadGridPrefs) A.loadGridPrefs();
    // loadGridPrefs 会读 localStorage 里的旧值，重设一次保证起点一致
    $('selGridSize').value = '3'; $('slGridPad').value = '0'; $('slGridOffsetX').value = '0'; $('slGridOffsetY').value = '0';
    $('cbGridSubdir').checked = false; A.invalidateGridCache();

    // ① 长边选项真的生效
    const seen = {};
    for (const v of ['3000', '4000', 'original']) {
      $('selGridRender').value = v;
      const src = await A._renderGridFrame(A.image);
      seen[v] = [src.width, src.height];
      await A._awaitFrameRender();
    }
    add(seen['3000'][0] === 3000 && seen['4000'][0] === 4000 && seen['original'][0] === 1200,
        '3000 / 4000 / 原图 三档输出真的不同', JSON.stringify(seen));
    add(Math.abs(seen['3000'][1] - 2000) <= 2 && Math.abs(seen['4000'][1] - 2667) <= 2,
        '放大时长边/短边按原比例一起缩放', seen['3000'].join('x') + ' / ' + seen['4000'].join('x'));

    // ② 残留 exportScale 不再劫持；函数自己会恢复调用方的值
    A.exportScale = 6000;
    $('selGridRender').value = '3000';
    const clean = await A._renderGridFrame(A.image);
    add(clean.width === 3000, '上一次主导出残留的 exportScale 不再顶掉界面选项', clean.width);
    add(A.exportScale === 6000, '_renderGridFrame 结束后恢复调用方的 exportScale', A.exportScale);
    delete A.exportScale;
    $('selGridRender').value = '3000';

    // ③ 批量只补全当前那张（旧实现对所有 images 都补）
    const calls = [];
    const origFull = window.ensureFullGrade;
    window.ensureFullGrade = (im) => calls.push(im && im.name);
    A.images.push({ el: img, name: 'other.png', w: 1200, h: 800, exif: {}, customSettings: null });
    await A._renderGridFrame(A.images[1]);
    add(calls.length === 1 && calls[0] === 'other.png', '批量切图只补全当前那张的全尺寸', calls.join(','));
    window.ensureFullGrade = origFull;
    A.images.pop();

    // ④ 留白标签带百分比；长边变了百分比也跟着变
    $('slGridPad').value = '12'; $('slGridPad').dispatchEvent(new Event('input', { bubbles: true }));
    const lbl12 = $('lblGridPad').textContent;
    $('selGridRender').value = '4000'; $('selGridRender').dispatchEvent(new Event('change', { bubbles: true }));
    const lbl4k = $('lblGridPad').textContent;
    add(/px/.test(lbl12) && /%/.test(lbl12) && /0\\.8%/.test(lbl12), '留白标签同时给出像素与百分比', lbl12);
    add(lbl4k !== lbl12 && /0\\.6%/.test(lbl4k), '换长边后百分比重新计算', lbl4k);
    $('slGridPad').value = '0'; $('slGridPad').dispatchEvent(new Event('input', { bubbles: true }));
    $('selGridRender').value = '3000'; $('selGridRender').dispatchEvent(new Event('change', { bubbles: true }));

    // ⑤ 画面提交 / 撤销让预览缓存失效
    A._gridBlocks = [{ width: 1 }]; A._gridCacheKey = '3x3@0:0,0';
    A.onSettingCommit();
    add(A._gridBlocks === null && A._gridCacheKey === '', '改了画面就作废切图预览缓存', String(A._gridBlocks));
    A._gridBlocks = [{ width: 1 }]; A._gridCacheKey = '3x3@0:0,0';
    A.undo();
    add(A._gridBlocks === null, '撤销后也不会拿旧切块去导出', String(A._gridBlocks));

    // ⑥ 构图偏移：切分区域从左侧裁掉 25%，第一块内容明显变亮（渐变图）
    const frame = await A._renderGridFrame(A.image);
    const b0 = A._sliceGrid(frame, 1, 2, 0, 0, 0)[0];
    const b1 = A._sliceGrid(frame, 1, 2, 0, 25, 0)[0];
    const mid = (cv) => {
      const d = cv.getContext('2d').getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
      return (d[0] + d[1] + d[2]) / 3;
    };
    add(mid(b1) > mid(b0) + 25, '水平偏移 25% 后第一块取到更靠右的画面', Math.round(mid(b0)) + ' → ' + Math.round(mid(b1)));
    const v0 = A._sliceGrid(frame, 2, 1, 0, 0, 0)[0];
    const v1 = A._sliceGrid(frame, 2, 1, 0, 0, 25)[0];
    add(v1.height < v0.height, '垂直偏移裁掉顶部，块高变小', v0.height + ' → ' + v1.height);
    $('slGridOffsetX').value = '25'; $('slGridOffsetX').dispatchEvent(new Event('input', { bubbles: true }));
    add(/右移 25%/.test($('lblGridOffsetX').textContent), '偏移滑杆说人话', $('lblGridOffsetX').textContent);

    // ⑦ 预览放大按真实导出格式，勾选框齐全
    $('slGridOffsetX').value = '0'; $('slGridOffsetX').dispatchEvent(new Event('input', { bubbles: true }));
    $('selFormat') && ($('selFormat').value = 'png');
    await A.renderGridPreview();
    await sleep(250);
    const cells = Array.from(document.querySelectorAll('#gridPreviewGrid .grid-preview-cell'));
    add(cells.length === 9 && cells.every(c => c.querySelector('.grid-pick')), '预览每块都有勾选框', cells.length);
    add(cells.every(c => c.querySelector('.grid-pick').checked === true), '默认全选', cells.filter(c => c.querySelector('.grid-pick').checked).length);
    cells[0].click();
    const zoomSrc = $('gridPreviewZoomImg').src;
    add(/^data:image\\/png/.test(zoomSrc), '放大看到的是 PNG 原画质，不是 JPEG 0.8 缩略图', zoomSrc.slice(0, 24));
    $('btnGridZoomBack').click();

    // ⑧ 缓存键含偏移；取消勾选后只导出选中的块，块号保持原样
    const key0 = A._gridCacheKey;
    $('slGridOffsetY').value = '10'; $('slGridOffsetY').dispatchEvent(new Event('input', { bubbles: true }));
    add(!A._gridBlocks, '改偏移让预览缓存失效', String(A._gridBlocks));
    $('slGridOffsetY').value = '0'; $('slGridOffsetY').dispatchEvent(new Event('input', { bubbles: true }));
    await A.renderGridPreview();
    await sleep(200);
    add(/@0:0,0\\|/.test(A._gridCacheKey), '缓存键里记着构图偏移', A._gridCacheKey);
    // 缓存不能跨照片/跨调色复用：旧键只有行列/留白/偏移，换图后会拿上一张的块
    // 配新文件名写出去。现在键里必须带图片身份与画面指纹。
    const keyBase = A.gridCacheKey();
    const prevGrade = A.image.grade;
    A.image.grade = { exposure: 20 };
    add(A.gridCacheKey() !== keyBase, '改调色后切块缓存键不同', A.gridCacheKey());
    A.image.grade = prevGrade;
    const other = { el: document.createElement('canvas'), name: 'other.png', w: 100, h: 80, exif: {}, customSettings: null };
    A.images.push(other);
    const otherKey = A.gridCacheKey(other);
    A.images.pop();
    add(otherKey !== keyBase, '换照片后切块缓存键不同', otherKey);
    add(A.gridCacheKey() === keyBase, '切回原图后缓存键可命中', A.gridCacheKey());

    // 第二次预览重建了 DOM，必须重新取 cells（旧引用已经 detached）
    const cells2 = Array.from(document.querySelectorAll('#gridPreviewGrid .grid-preview-cell'));
    cells2[1].querySelector('.grid-pick').checked = false;
    cells2[5].querySelector('.grid-pick').checked = false;
    cells2[1].querySelector('.grid-pick').dispatchEvent(new Event('change', { bubbles: true }));
    add(/导出选中的 7 张/.test($('btnGridPreviewExport').textContent), '导出按钮跟着勾选数变', $('btnGridPreviewExport').textContent);
    await A.exportGridCrop();
    await sleep(200);
    const names = (window.__gridWritten || []).map(w => w.name);
    add(names.length === 7, '只写出勾选的 7 块', names.length);
    add(!names.some(n => /_2\\./.test(n) || /_6\\./.test(n)), '未勾选的块没有写出', names.join(' '));
    add((names[0] || '').indexOf('_九宫格_1.') > 0 && (names[names.length - 1] || '').indexOf('_九宫格_9.') > 0,
        '块号沿用预览里的编号（1 与 9 都在）', names.join(' '));

    // ⑨ 进切图页签退出拼图（现已推广到所有拼图外页签），版式与格子保留，切回不再自动恢复
    const pk = A.template.puzzle;
    pk.enabled = 1; pk.layout = 'grid4'; pk.layoutType = 6;
    pk.slots = { 0: { imageIndex: 0 }, 1: { imageIndex: 0 } };
    A.switchTab('puzzle');
    add(A.tplPuzzle() !== null, '先在拼图页签确认拼图开着', String(!!A.tplPuzzle()));
    A.switchTab('grid');
    add(A.template.puzzle.enabled === 0, '切到切图页签时退出拼图', A.template.puzzle.enabled);
    add(/退出拼图/.test(A.statusMsg), '状态栏说清为什么退出', A.statusMsg);
    add(A.template.puzzle.layout === 'grid4'
        && A.template.puzzle.slots[0].imageIndex === 0 && A.template.puzzle.slots[1].imageIndex === 0,
        '版式与已放好的格子没有丢', A.template.puzzle.layout + ' ' + Object.keys(A.template.puzzle.slots).join(','));
    A.switchTab('puzzle');
    add(A.template.puzzle.enabled === 0 && A.tplPuzzle() === null,
        '切回拼图页签不再自动恢复，需要重新选版式', A.template.puzzle.enabled);

    // 收尾
    $('slGridPad').value = '0'; $('slGridOffsetX').value = '0'; $('slGridOffsetY').value = '0';
    A.hideGridPreview();
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
  testWin = win;
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

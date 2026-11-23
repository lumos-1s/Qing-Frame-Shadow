// 拼图字幕：字号被「格子间距」压死的老毛病，以及这一轮补的对齐/竖排/选中即编辑。
// 离屏运行（show:false），不弹窗。
//
//   ① 字号真的生效：默认间距下 28 与 200 必须渲染成不同大小（旧实现完全一样）
//   ② 字幕带按字号让位：底部有字幕时格子整体上移、变矮，且点选与画面一致
//   ③ 「字幕带高度」独立于「格子间距」，调大只压格子、不加宽缝隙
//   ④ 对齐左/中/右，格子字幕也能竖排
//   ⑤ 选中即编辑（空位置也开编辑器）、副标题 0.7 联动、样式刷、清空自动删
//   ⑥ 门牌号说人话：不再出现「横间隙 H2」这种内部键名
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const TMP_UD = path.join(os.tmpdir(), 'qfs-test-caption-' + process.pid);
app.setPath('userData', TMP_UD);
process.on('exit', () => { try { fs.rmSync(TMP_UD, { recursive: true, force: true }); } catch (e) {} });

for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates', 'list-custom-icons', 'list-presets', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'copy-text', 'save-diagnostics', 'check-for-updates', 'quit-and-install', 'open-external', 'open-data-dir', 'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template', 'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);

const RUN = `(async () => {
  const A = window.App;
  const res = [];
  const add = (ok, label, got) => res.push({ ok: !!ok, label: label, got: String(got) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
  const COLORS = ['#c03030', '#30a030', '#3050c0', '#c0a020'];
  const RGB = [[192,48,48],[48,160,48],[48,80,192],[192,160,32]];
  const ims = [];
  for (let i = 0; i < 4; i++) {
    const c = document.createElement('canvas'); c.width = 120; c.height = 90;
    const g = c.getContext('2d'); g.fillStyle = COLORS[i]; g.fillRect(0, 0, 120, 90);
    const src = c.toDataURL('image/png');
    const img = new Image();
    await new Promise(r => { img.onload = r; img.onerror = r; img.src = src; });
    ims.push({ el: img, name: 'p' + i + '.png', w: 120, h: 90, exif: {}, customSettings: null, thumb: src });
  }
  A.images = ims; A.currentIdx = 0; A.image = ims[0]; A.selectedIdx = [0]; A.batchSel = [];
  A.template = A.defaultTemplate();
  const pk = A.template.puzzle;
  pk.enabled = 1; pk.layout = 'grid4'; pk.layoutType = 6; pk.gap = 6; pk.capBand = 0;
  pk.slots = { 0:{imageIndex:0}, 1:{imageIndex:1}, 2:{imageIndex:2}, 3:{imageIndex:3} };
  pk.captions = {}; pk.gapCaptions = {};
  ims[0].customSettings = A.template;
  A.imageTemplates.set(ims[0], A.template);
  A.buildThumbnails(); A.updateEmptyState(); A.afterImageSelect();
  A.switchTab('puzzle');
  await sleep(150);

  // ── 拦截 fillText：直接读实际渲染字号/位置，比数像素稳
  const P = CanvasRenderingContext2D.prototype;
  const origFill = P.fillText;
  let hits = [];
  const spy = () => {
    hits = [];
    P.fillText = function (t, x, y) {
      hits.push({ t: String(t), x: x, y: y, align: this.textAlign, font: this.font });
      return origFill.apply(this, arguments);
    };
  };
  const unspy = () => { P.fillText = origFill; };
  const hitOf = (needle) => hits.find(o => o.t.indexOf(needle) >= 0) || null;
  const fontPx = (needle) => {
    const h = hitOf(needle);
    if (!h) return null;
    const m = String(h.font).match(/([\\d.]+)px/);
    return m ? parseFloat(m[1]) : null;
  };
  const render = (exportMode) => { window.__renderPuzzle(A, false, exportMode !== false); };
  const geo = () => window.__puzzleGeometry(pk, A.dom.canvas.width, A.dom.canvas.height);
  const bgColor = () => {
    const c = A.dom.canvas, g = c.getContext('2d');
    const d = g.getImageData(4, 4, 1, 1).data;
    return [d[0], d[1], d[2]].join(',');
  };

  // ① 字号必须真的生效（旧实现：gap=6 时 28 与 200 渲染结果完全一样）
  pk.gapCaptions = { h1: { line1: '标题甲', size1: 28, color: '000000', bgBar: 0, spacing: 0, align: 'center' } };
  spy(); render(); const px28 = fontPx('标题甲'); unspy();
  pk.gapCaptions = { h1: { line1: '标题甲', size1: 200, color: '000000', bgBar: 0, spacing: 0, align: 'center' } };
  spy(); render(); const px200 = fontPx('标题甲'); unspy();
  add(px28 > 0 && px200 > 0, '两条字号都画出了字', px28 + ' / ' + px200);
  add(px200 / px28 > 5, '默认间距下字号 28 → 200 明显变大（旧实现是 1 倍）', (px200 / px28).toFixed(2) + 'x');
  add(geo().bandFrac > 0.05, '字号变大时字幕带自动撑高', geo().bandFrac.toFixed(3));
  const gB = geo();
  add(gB.yScale < 0.99 && gB.yScale > 0.35, '格子为字幕带让位（整体上移+变矮）', gB.yScale.toFixed(3));

  // ② 点选与画面必须一致：每格中心既要是这张照片，也要点得中这一格
  render();
  const canvas = A.dom.canvas;
  const cv = canvas.getContext('2d');
  let hitOk = 0, colorOk = 0;
  gB.rects.forEach((r, i) => {
    const cx = Math.round((r[0] + r[2] / 2) * canvas.width);
    const cy = Math.round((r[1] + r[3] / 2) * canvas.height);
    const got = A.puzzleSlotAtPx(cx, cy);
    if (got === i) hitOk++;
    const d = cv.getImageData(cx, cy, 1, 1).data;
    const e = RGB[i];
    if (Math.abs(d[0] - e[0]) < 40 && Math.abs(d[1] - e[1]) < 40 && Math.abs(d[2] - e[2]) < 40) colorOk++;
  });
  add(hitOk === 4, '四格中心都点得中自己', hitOk + '/4');
  add(colorOk === 4, '四格中心画的就是这一格的照片', colorOk + '/4');
  const bandY = Math.round((1 - gB.bandFrac / 2) * canvas.height);
  add(A.puzzleSlotAtPx(Math.round(canvas.width / 2), bandY) === null,
      '字幕带里点不出格子（不会误选）', A.puzzleSlotAtPx(Math.round(canvas.width / 2), bandY));

  // ②b 行间字幕不能借用底部标题带的高度：底部一条大字会把行间的底条也撑成一条宽带
  pk.gapCaptions = {
    h0: { line1: '行间', size1: 28, color: '000000', bgBar: 1, spacing: 0, align: 'center' },
    h1: { line1: '大字标题', size1: 200, color: '000000', bgBar: 1, spacing: 0, align: 'center' }
  };
  const origRect = CanvasRenderingContext2D.prototype.fillRect;
  let bars = [];
  CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
    bars.push({ x: x, y: y, w: w, h: h, fs: String(this.fillStyle) });
    return origRect.apply(this, arguments);
  };
  spy(); render(); unspy();
  CanvasRenderingContext2D.prototype.fillRect = origRect;
  const HnLogic = (window.__lastPuzzleGeom && window.__lastPuzzleGeom.Hn) || 1000;
  const bandH = geo().bandFrac * HnLogic;
  const midBar = bars.filter(b => /rgba|rgb/.test(b.fs) && b.y > HnLogic * 0.35 && b.y < HnLogic * 0.75 && b.h < HnLogic * 0.3).sort((a, b) => b.h - a.h)[0] || null;
  add(midBar && midBar.h < bandH * 0.5, '行间字幕底条不借用底部标题带的高度',
      midBar ? (Math.round(midBar.h) + ' vs 底部带 ' + Math.round(bandH)) : '没找到行间底条');
  add(midBar && Math.abs(midBar.y + midBar.h / 2 - HnLogic * 0.5 * geo().yScale) < HnLogic * 0.02,
      '行间字幕仍居中在缝隙上（跟着格子一起压缩）',
      midBar ? Math.round(midBar.y + midBar.h / 2) + ' vs ' + Math.round(HnLogic * 0.5 * geo().yScale) : '×');
  const t1 = hits.find(o => o.t.indexOf('大字标题') >= 0);
  add(t1 && t1.y < HnLogic, '大字号底部标题不会画到画布外', t1 && Math.round(t1.y) + ' / ' + Math.round(HnLogic));

  // ③ 字幕带高度独立于间距：调大只压格子，缝隙不变
  pk.gapCaptions = {};
  pk.capBand = 0;
  const g0 = geo();
  pk.capBand = 100;
  const g1 = geo();
  add(Math.abs(g1.gapPx - g0.gapPx) < 0.01, '调字幕带不改变格子间距', g0.gapPx.toFixed(2) + ' → ' + g1.gapPx.toFixed(2));
  add(g1.bandFrac > g0.bandFrac && g1.yScale < g0.yScale, '字幕带变高、格子让位', g0.bandFrac.toFixed(3) + ' → ' + g1.bandFrac.toFixed(3));
  pk.capBand = 900;
  add(geo().bandFrac <= 0.6001, '字幕带高度封顶 60%，不会把拼图压没', geo().bandFrac.toFixed(3));
  pk.capBand = 0;

  // ④ 对齐：左/右必须真的靠边，而不是永远居中
  pk.gapCaptions = { h1: { line1: '标题甲', size1: 60, color: '000000', bgBar: 0, spacing: 0, align: 'left' } };
  spy(); render(); const hl = hitOf('标题甲'); unspy();
  pk.gapCaptions = { h1: { line1: '标题甲', size1: 60, color: '000000', bgBar: 0, spacing: 0, align: 'right' } };
  spy(); render(); const hr = hitOf('标题甲'); unspy();
  // x 是逻辑坐标（ctx.scale 之前），不能拿设备像素宽比
  const Wn = (window.__lastPuzzleGeom && window.__lastPuzzleGeom.Wn) || A.dom.canvas.width;
  add(hl && hl.align === 'left' && hl.x < Wn * 0.15, '左对齐真的靠左', hl && (hl.align + ' x=' + Math.round(hl.x) + ' / ' + Wn));
  add(hr && hr.align === 'right' && hr.x > Wn * 0.85, '右对齐真的靠右', hr && (hr.align + ' x=' + Math.round(hr.x) + ' / ' + Wn));

  // ⑤ 格子字幕也能竖排（以前只有间隙可用）
  pk.gapCaptions = {};
  pk.captions = { 0: { line1: '甲乙丙', size1: 40, color: 'ffffff', bgBar: 0, spacing: 0, direction: 'vertical', align: 'center' } };
  spy(); render(); unspy();
  const chars = ['甲', '乙', '丙'].map(ch => hits.find(o => o.t === ch) || null);
  add(chars.every(Boolean), '格子竖排逐字绘制', chars.map(c => c ? c.t : '×').join(''));
  add(chars[0] && chars[1] && chars[2]
      && Math.abs(chars[0].x - chars[2].x) < 0.5
      && chars[1].y > chars[0].y && chars[2].y > chars[1].y,
      '竖排同列、逐字向下', chars.map(c => c ? Math.round(c.x) + '@' + Math.round(c.y) : '×').join(' '));

  // ⑥ 选中即编辑：空位置也打开编辑器，标题说人话
  pk.captions = {};
  const pick = A.$('cbPuzzleGapPick');
  const opts = Array.from(pick.options).map(o => ({ v: o.value, t: o.textContent.replace('● ', '') }));
  add(opts.some(o => /底部标题带/.test(o.t)) && opts.some(o => /第 1 行下方/.test(o.t)) && opts.some(o => /第 1 列右侧/.test(o.t)),
      '门牌号改成人话（第 1 行下方 / 底部标题带 / 第 1 列右侧）', opts.map(o => o.t).join(' | '));
  add(!opts.some(o => /横间隙|竖间隙/.test(o.t)), '不再出现「横间隙 / 竖间隙」', opts.map(o => o.t).join(' | '));
  pick.value = 's1'; A.onPuzzleSlotChange(); await sleep(120);
  const ed = A.$('vbCaptionEditor');
  add(ed && ed.style.display !== 'none', '空格子也直接打开编辑器（不必先按「添加字幕」）', ed && ed.style.display);
  add(/格子 2/.test(A.$('lblEditingCap').textContent) && !/S1/.test(A.$('lblEditingCap').textContent),
      '编辑器标题说「格子 2」而不是「S1」', A.$('lblEditingCap').textContent);

  // ⑦ 两行各自独立：主标题 100/Georgia，副标题 30/KaiTi，互不覆盖
  A.$('tfCapLine1').value = '主标题'; A.$('tfCapLine2').value = '副标题';
  A.$('slCapSize1').value = 100; A.$('cbCapFont1').value = 'Georgia';
  A.$('slCapSize2').value = 30; A.$('cbCapFont2').value = 'KaiTi';
  A.captureCaptionToModel('s1');
  const c1 = pk.captions[1];
  add(c1 && c1.size1 === 100 && c1.font1 === 'Georgia' && c1.size2 === 30 && c1.font2 === 'KaiTi',
      '第一行 / 第二行的字号与字体各自独立', c1 && (c1.size1 + ' ' + c1.font1 + ' / ' + c1.size2 + ' ' + c1.font2));
  A.loadCaptionFromModel();
  add(A.$('slCapSize2').value === '30' && A.$('cbCapFont2').value === 'KaiTi' && A.$('slCapSize1').value === '100',
      '切回来时两行各自回读，不会互相顶掉',
      A.$('slCapSize1').value + '/' + A.$('slCapSize2').value + ' ' + A.$('cbCapFont2').value);

  // ⑧ 样式刷到同类型：只刷排版，不动文字
  pk.captions[0] = { line1: '一', size1: 28, size2: 20, font1: 'Microsoft YaHei', color: 'ffffff', bgBar: 0, spacing: 0, align: 'center', vAlign: 'top' };
  A.$('cpCapColor').value = '#ff0000';
  A.$('slCapSize1').value = 64;
  A.copyCaptionStyle();
  await sleep(80);
  const c0 = pk.captions[0];
  add(c0.size1 === 64 && c0.color === 'ff0000', '样式刷同类型：字号与颜色都过去了', c0.size1 + '/' + c0.color);
  add(c0.line1 === '一', '样式刷不动文字', c0.line1);
  add(c0.vAlign === 'top', '样式刷不动位置（贴顶仍贴顶）', c0.vAlign);

  // ⑨ 两行都清空 = 删掉这条，但编辑器不收起（接着打字能建回来）
  A.$('tfCapLine1').value = ''; A.$('tfCapLine2').value = '';
  A.captureCaptionToModel('s1');
  add(pk.captions[1] === undefined, '两行都清空就删掉这条字幕', pk.captions[1]);
  A.loadCaptionFromModel();
  A.renderCaptionEditorVisibility();
  add(ed.style.display !== 'none' && A.$('lblEditingCap').textContent.trim() !== '', '清空后编辑器仍开着，可以接着写', ed.style.display);

  // ⑩ 旧控件彻底退场
  add(!!A.$('slCapSize2') && !!A.$('cbCapFont2'), '第二行有独立的字号与字体控件', 'ok');
  add(!A.$('btnEditGapCaption'), '「添加/编辑字幕」按钮已移除（选中即编辑）', 'ok');
  add(!!A.$('slCapBand') && !!A.$('btnCapStyleAll') && !!A.$('cbCapAlign') && !!A.$('cbCapVAlign'),
      '新控件都在：字幕带高度 / 样式刷 / 对齐 / 位置', 'ok');

  // 收尾：恢复默认，别把状态留给后面的断言
  pk.captions = {}; pk.gapCaptions = {}; pk.capBand = 0;
  A.scheduleRender(true);
} catch (e) {
  res.push({ ok: false, label: '脚本异常', got: (e && e.stack) || String(e) });
}
return res;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1680, height: 1000, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise(r => setTimeout(r, 1500));
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

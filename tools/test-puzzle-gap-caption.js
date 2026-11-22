// 拼图「间距与字幕」几何回归(带壳:加载真实 index.html,调 window.__renderPuzzle 后按像素测量)。
//
// 这一组断言对应五个"看起来像玄学"的逻辑 bug:
//   1. 外边距 ≠ 内部缝隙 —— 引擎对每一格的**四条边**都内缩 gapPx,格子之间于是 4*gapPx,
//      画布外边距只有 2*gapPx:缝隙是外边距的两倍,方块看起来粘太紧、外边留白又太窄。
//   2. 点选范围与画面不符 —— app 的 puzzleSlotAtPx 只对贴边的边内缩(= 注释里的设计意图),
//      引擎却对所有边内缩,于是点缝里的空白会选中格子、点格子边缘会落空。
//   3. 底部字幕带让位判定恒真 —— 用 r[1](像素) 去比 hAxRow(0-1 归一化轴位),混单位;
//      gap>0 时**每一行**都被削掉 gth,照片下方多出一条白带。
//   4. 竖排间隙字幕恒定画 55% 黑条(背景条勾选框无效),且只读 line1 ——
//      第二行与"间距"被静默丢弃。
//   5. 六个取色器一个监听都没挂 —— 字幕颜色/边框色改完模型不更新、画面不重绘,
//      要拖一下别的控件颜色才"补"上来。第 5 段专测这条(清画布 + 只派发事件 + 等两帧)。
//
// 判定全部走像素(照片填纯色 #c06030、字幕纯黑),不依赖任何布局公式,改实现也照样有效。
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const NO_OP = ['save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch', 'check-for-updates', 'start-update-download', 'quit-and-install', 'write-export-files'];
for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates', 'list-custom-icons', 'list-presets']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of NO_OP) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'pick-export-location']) ipcMain.handle(c, () => ({ canceled: true }));

// 在页面里跑:渲染 → 当场取像素快照(同一张 canvas 下一帧会覆盖)→ 断言,返回 [{ok,label,got}]
const RUN = `(async () => {
  const A = window.App;
  const res = [];
  const add = (ok, label, got) => res.push({ ok: !!ok, label: label, got: String(got) });

  // 纯色照片:便于把"照片/留白/字幕"三类像素分开
  const c = document.createElement('canvas'); c.width = 1200; c.height = 1200;
  const g0 = c.getContext('2d'); g0.fillStyle = '#c06030'; g0.fillRect(0, 0, 1200, 1200);
  const img = new Image();
  await new Promise(r => { img.onload = r; img.onerror = r; img.src = c.toDataURL('image/png'); });
  const im = { el: img, name: 'p.png', w: 1200, h: 1200, exif: {}, customSettings: null };
  A.images = [im]; A.image = im; A.currentIdx = 0;
  A.displayMax = 4000; A.uiDprOverride = 1;

  const BASE = {
    enabled: 1, layout: 'grid4', layoutType: 6, gap: 60, bgMode: 0, borderColor: 'ffffff',
    canvasRatio: 'auto', axisVals: {}, captions: {}, gapCaptions: {}, cornerRadius: 3,
    slots: { 0: { imageIndex: 0 }, 1: { imageIndex: 0 }, 2: { imageIndex: 0 }, 3: { imageIndex: 0 } },
  };
  const shot = (patch) => {
    A.template = A.defaultTemplate();
    const pk = A.template.puzzle;
    for (const k in BASE) pk[k] = (BASE[k] && typeof BASE[k] === 'object') ? JSON.parse(JSON.stringify(BASE[k])) : BASE[k];
    Object.assign(pk, patch || {});
    window.__renderPuzzle(A, false, true);
    const cv = A.dom.canvas;
    const W = cv.width, H = cv.height;
    const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
    return { W: W, H: H, d: d, geom: JSON.parse(JSON.stringify(window.__lastPuzzleGeom || {})) };
  };

  const isPhoto = (d, i) => d[i] > 150 && d[i] < 225 && d[i + 1] > 55 && d[i + 1] < 145 && d[i + 2] < 110;
  // 沿一条线切:照片段 'P' / 其余 'G'
  const scan = (S, dir, at) => {
    const n = dir === 'row' ? S.W : S.H;
    const o = []; let k = null, st = 0;
    for (let p = 0; p < n; p++) {
      const i = (dir === 'row' ? at * S.W + p : p * S.W + at) * 4;
      const cur = isPhoto(S.d, i) ? 'P' : 'G';
      if (cur !== k) { if (k) o.push({ k: k, from: st, len: p - st }); k = cur; st = p; }
    }
    o.push({ k: k, from: st, len: n - st });
    return o;
  };
  const shape = (rs) => rs.map(r => r.k + ':' + r.len).join(' ');
  const barPx = (S) => { let n = 0; for (let i = 0; i < S.d.length; i += 4) { const r = S.d[i], gg = S.d[i + 1], b = S.d[i + 2]; if (Math.abs(r - gg) < 10 && Math.abs(gg - b) < 10 && r > 90 && r < 150) n++; } return n; };
  const inkBox = (S) => { let top = -1, bot = -1; for (let y = 0; y < S.H; y++) for (let x = 0; x < S.W; x++) { const i = (y * S.W + x) * 4; if (S.d[i] < 60 && S.d[i + 1] < 60 && S.d[i + 2] < 60) { if (top < 0) top = y; bot = y; } } return { top: top, bot: bot, h: top < 0 ? 0 : bot - top + 1 }; };
  const sameMap = (a, b) => { if (a.d.length !== b.d.length) return false; for (let i = 0; i < a.d.length; i += 4) if (a.d[i] !== b.d[i]) return false; return true; };

  // ── 1. 外边距 = 内部缝隙 = 2*gapPx ──
  for (const gap of [6, 60]) {
    const S = shot({ gap: gap });
    const gp = S.geom.gapPx;
    const row = scan(S, 'row', Math.floor(S.H * 0.25));
    const col = scan(S, 'col', Math.floor(S.W * 0.25));
    add(gp > 0 && row.length === 5 && row[0].k === 'G' && row[1].k === 'P' && row[2].k === 'G' && row[3].k === 'P' && row[4].k === 'G',
      'gap=' + gap + ' 横切通道形状应为 G P G P G', shape(row));
    add(Math.abs(row[0].len - gp * 2) <= 2 && Math.abs(row[2].len - gp * 2) <= 2,
      'gap=' + gap + ' 左右外边距 = 格子间隙 = 2*gapPx', '外边距 ' + row[0].len + 'px / 缝隙 ' + row[2].len + 'px / 2*gapPx = ' + (gp * 2).toFixed(2) + 'px');
    add(col.length === 5 && Math.abs(col[0].len - col[2].len) <= 2 && Math.abs(col[2].len - gp * 2) <= 2,
      'gap=' + gap + ' 上下外边距 = 格子间隙 = 2*gapPx', '外边距 ' + col[0].len + 'px / 缝隙 ' + col[2].len + 'px / 2*gapPx = ' + (gp * 2).toFixed(2) + 'px');
  }

  // ── 2. 画布点选范围与画面像素一致 ──
  {
    const S = shot({ gap: 60 });
    const y = Math.floor(S.H * 0.25);
    const row = scan(S, 'row', y);
    const photos = row.filter(r => r.k === 'P');
    const idx = photos.map(r => A.puzzleSlotAtPx(r.from + Math.floor(r.len / 2), y));
    // 行优先后，上半部两格是 0（左上）和 1（右上）；旧实现列优先时是 0 / 2。
    add(photos.length === 2 && JSON.stringify(idx) === '[0,1]', '点画面上半部的两格中心:命中 0 / 1', JSON.stringify(idx));
    const seam = row[2];
    const seamX = seam.from + Math.floor(seam.len / 2);
    add(A.puzzleSlotAtPx(seamX, y) === null, '点两格之间的空白(缝隙中心)不应选中任何格子', 'x=' + seamX + ' → ' + String(A.puzzleSlotAtPx(seamX, y)));
    const outX = Math.floor(row[0].len / 2);
    add(A.puzzleSlotAtPx(outX, y) === null, '点画布外边距不选中任何格子', 'x=' + outX + ' → ' + String(A.puzzleSlotAtPx(outX, y)));
  }

  // ── 3. 底部字幕带不再削掉每行 gth ──
  {
    const x = 650;
    const S0 = shot({ gap: 60 });
    const S1 = shot({ gap: 60, gapCaptions: { h1: { line1: 'ABC', line2: '', size1: 28, size2: 20, color: 'ffffff', bgBar: 1, spacing: 0 } } });
    const p0 = scan(S0, 'col', Math.floor(S0.W * 0.25)).filter(r => r.k === 'P').map(r => r.from + '+' + r.len);
    const p1 = scan(S1, 'col', Math.floor(S1.W * 0.25)).filter(r => r.k === 'P').map(r => r.from + '+' + r.len);
    add(p0.length === 2 && JSON.stringify(p0) === JSON.stringify(p1),
      '底部字幕带不改变照片行高(旧实现每行都缩 gth)', '无字幕 [' + p0.join(', ') + '] 有字幕 [' + p1.join(', ') + ']');
    const last = scan(S1, 'col', x).filter(r => r.k === 'P').pop();
    const want = S1.H - S1.geom.gapPx * 2;
    add(!!last && Math.abs((last.from + last.len) - want) <= 2,
      '底行照片下沿 = 画布下沿 - 2*gapPx(字幕带就在下外边距里)', '下沿 ' + (last ? last.from + last.len : 'n/a') + 'px / 期望 ' + want.toFixed(1) + 'px');
  }

  // ── 4. 字幕参数:竖排(背景条/第二行/间距)与横排对照组 ──
  const V = (patch) => shot(Object.assign({ gap: 60, gapCaptions: { v0: Object.assign({ line1: 'AB', line2: '', size1: 28, size2: 20, color: '000000', bgBar: 0, spacing: 0, direction: 'vertical' }, patch) } }));
  const vOff = V({});
  const vOn = V({ bgBar: 1 });
  const grayOff = barPx(vOff), grayOn = barPx(vOn);
  add(grayOn > grayOff + 200, '竖排字幕:背景条勾选会画出半透明条', '未勾选 ' + grayOff + 'px(约等于只有抗锯齿) / 勾选 ' + grayOn + 'px');
  add(vOn.H > 0 && !sameMap(vOff, vOn), '竖排字幕:背景条开关真的改变画面', '同一参数唯一差异 = bgBar');
  const vTwo = V({ line1: 'AB', line2: 'CD' });
  add(!sameMap(vOff, vTwo), '竖排字幕:第二行会被画出来(旧实现静默丢弃)', 'line2 "" → "CD"');
  const vSp0 = V({ line1: 'ABCDEF', spacing: 0 });
  const vSp2 = V({ line1: 'ABCDEF', spacing: 200 });
  const b0 = inkBox(vSp0), b2 = inkBox(vSp2);
  add(b0.h > 0 && b2.h > b0.h * 1.2, '竖排字幕:间距滑块拉开字距', '间距 0 → 字列高 ' + b0.h + 'px / 200 → ' + b2.h + 'px');

  const HCap = (line2, spacing, bgBar) => shot({ gap: 60, gapCaptions: { h0: { line1: 'AB', line2: line2 || '', size1: 60, size2: 40, color: '000000', bgBar: bgBar || 0, spacing: spacing || 0 } } });
  const h0 = HCap('', 0, 0), h2 = HCap('CD', 0, 0);
  add(!sameMap(h0, h2), '横排字幕:第二行有效(对照组,未回归)', 'line2 "" → "CD"');
  const hs0 = HCap('EF', 0, 0), hs2 = HCap('EF', 200, 0);
  const hb0 = inkBox(hs0), hb2 = inkBox(hs2);
  add(hb0.h > 0 && hb2.h > hb0.h * 1.2, '横排字幕:间距滑块拉开行距', '间距 0 → 高 ' + hb0.h + 'px / 200 → ' + hb2.h + 'px');

  // ── 5. 字幕色/边框色取色器:改完当场生效,不等下一个控件 ──
  // 旧实现:六个 <input type=color> 一个监听都没挂(只有滑块/复选框/下拉/文本框有),
  // 取色后模型不更新、画面不重绘 —— 要拖一下别的滑块颜色才"补"上来。
  // 判定:先清空画布,只派发取色器事件,等两帧(不主动调渲染),看画面是否被应用自己的重绘恢复。
  {
    A.template = A.defaultTemplate();
    const pk = A.template.puzzle;
    pk.enabled = 1; pk.layout = 'grid4'; pk.layoutType = 6; pk.gap = 60; pk.bgMode = 0;
    pk.borderColor = 'ffffff'; pk.canvasRatio = 'auto'; pk.axisVals = {};
    pk.captions = {};
    pk.gapCaptions = { h1: { line1: 'AB', line2: '', size1: 40, size2: 20, color: 'ffffff', bgBar: 0, spacing: 0 } };
    pk.slots = { 0: { imageIndex: 0 }, 1: { imageIndex: 0 }, 2: { imageIndex: 0 }, 3: { imageIndex: 0 } };
    im.customSettings = A.template; // renderPreview 认这张模板,否则回落到默认模板(不画拼图)
    A._puzzleSlot = 'h1';
    A.refreshPuzzleUI();
    await A.flushRender();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const shotNow = () => A.dom.canvas.getContext('2d').getImageData(0, 0, A.dom.canvas.width, A.dom.canvas.height).data;
    const countPx = (test) => { const d = shotNow(); let n = 0; for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++; return n; };
    const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const capEl = document.getElementById('cpCapColor');
    const bdEl = document.getElementById('cpPuzzleBorder');

    // 字幕颜色 @input(取色器里拖动):写进"当前编辑槽位"的模型 + 当场重绘
    A.dom.canvas.getContext('2d').clearRect(0, 0, A.dom.canvas.width, A.dom.canvas.height);
    capEl.value = '#00ff00';
    capEl.dispatchEvent(new Event('input', { bubbles: true }));
    await raf2();
    const cap = A.template.puzzle.gapCaptions['h1'];
    add(cap && cap.color === '00ff00', '字幕色 input:即时写入当前编辑槽位的模型', cap ? cap.color : '(字幕被删)');
    const green = countPx((r, g, b) => r < 120 && g > 200 && b < 120);
    add(green > 20, '字幕色 input:画布已按新颜色重绘(绿色墨迹)', green + 'px 绿');

    // 字幕颜色 @change(关闭取色器):提交路径同样写模型 + 重绘
    A.dom.canvas.getContext('2d').clearRect(0, 0, A.dom.canvas.width, A.dom.canvas.height);
    capEl.value = '#0000ff';
    capEl.dispatchEvent(new Event('change', { bubbles: true }));
    await raf2();
    const cap2 = A.template.puzzle.gapCaptions['h1'];
    add(cap2 && cap2.color === '0000ff', '字幕色 change:提交后模型为新颜色', cap2 ? cap2.color : '(字幕被删)');
    const blueCap = countPx((r, g, b) => r < 120 && g < 120 && b > 200);
    add(blueCap > 20, '字幕色 change:画布墨迹变蓝', blueCap + 'px 蓝');

    // 边框色 @change:pk.borderColor 生效,画布底色/格边当场换色,并入撤销栈
    A.dom.canvas.getContext('2d').clearRect(0, 0, A.dom.canvas.width, A.dom.canvas.height);
    const undo0 = A.undoStack.length;
    bdEl.value = '#00ffff';
    bdEl.dispatchEvent(new Event('change', { bubbles: true }));
    await raf2();
    add(A.template.puzzle.borderColor === '00ffff', '边框色 change:写入 pk.borderColor', A.template.puzzle.borderColor);
    const cyan = countPx((r, g, b) => r < 100 && g > 200 && b > 200);
    add(cyan > 1000, '边框色 change:画布背景/格边已换新色(青色铺满)', cyan + 'px 青');
    add(A.undoStack.length === undo0 + 1, '取色器 change 压入撤销栈(可 Ctrl+Z 回退)', '撤销栈 ' + undo0 + ' → ' + A.undoStack.length);
  }

  // ── 6. 画布比例只裁画布,不改变间距厚度 ──
  // (gapPx 若跟画布短边走,选 4:3 会把同一档间距渲染得更粗/更细 —— 实测 v3 3.00→2.25px、h3 3.00→7.02px)
  for (const layout of ['v3', 'h3']) {
    const cell = { layout: layout, layoutType: A.layoutTypeOf(layout), gap: 6, canvasRatio: 'auto',
                   slots: { 0: { imageIndex: 0 }, 1: { imageIndex: 0 }, 2: { imageIndex: 0 } } };
    const A0 = shot(cell);
    const A1 = shot(Object.assign({}, cell, { canvasRatio: '4:3' }));
    add(Math.abs(A0.geom.gapPx - A1.geom.gapPx) < 0.01,
      layout + ':画布比例不改变间距厚度(基准 = 版式原生短边)',
      'gapPx auto ' + A0.geom.gapPx.toFixed(2) + 'px / 4:3 ' + A1.geom.gapPx.toFixed(2) + 'px');
    add(Math.abs(A1.W / A1.H - 4 / 3) < 0.01,
      layout + ':画布被裁成所选 4:3', A1.W + 'x' + A1.H + ' = ' + (A1.W / A1.H).toFixed(4) + ':1');
    // 逐像素复核:选比例后缝隙仍 = 2*gapPx
    const dir = layout === 'h3' ? 'row' : 'col';
    const at = Math.floor((dir === 'row' ? A1.H : A1.W) * 0.5);
    const rs = scan(A1, dir, at).filter(r => r.k === 'G');
    const seams = rs.slice(1, -1);
    add(seams.length === 2 && seams.every(r => Math.abs(r.len - A1.geom.gapPx * 2) <= 2),
      layout + '@4:3:缝隙仍 = 2*gapPx', '缝隙 ' + seams.map(r => r.len).join('/') + 'px / 2*gapPx = ' + (A1.geom.gapPx * 2).toFixed(2) + 'px');
  }

  // ── 7. 分隔线轴位模型:拖一条轴不丢其他轴;切换布局不残留旧轴 ──
  {
    const h3 = window.__clampPuzzleAxes('h3', { v: [0.4] });
    add(h3.v.length === 2 && window.__buildPuzzleSlots('h3', h3).length === 3,
      'h3:拖第 1 条轴后仍保留 2 条竖轴(3 列)', JSON.stringify(h3.v));

    const h2 = window.__clampPuzzleAxes('h2', { v: [0.4, 0.6], h: [0.4] });
    add(h2.v.length === 1 && h2.h.length === 0 && window.__buildPuzzleSlots('h2', h2).length === 2,
      'h2:切换布局残留的 h 轴不生效(仍 2 格)', JSON.stringify(h2));

    const g9 = window.__clampPuzzleAxes('grid9', { v: [0.4], h: [0.4] });
    add(g9.v.length === 2 && g9.h.length === 2 && window.__buildPuzzleSlots('grid9', g9).length === 9,
      'grid9:拖一条轴不丢同方向另一条(仍 9 格)', JSON.stringify(g9));

    const squeezed = window.__clampPuzzleAxes('h4', { v: [0.9, 0.9, 0.9] });
    add(squeezed.v.every((v, i) => i === 0 || v - squeezed.v[i - 1] >= 0.12 - 1e-9),
      'h4:三条轴挤在一起时强制 ≥12% 间距', JSON.stringify(squeezed.v));
  }

  return res;
})()`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1200, height: 800, show: false,
        webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, l, m) => {
        const s = String(m);
        if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 200));
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 60; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.__renderPuzzle)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    await new Promise(r => setTimeout(r, 800));

    const fails = [];
    const line = (ok, label, got, expect) => {
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
        console.log(`       ${got}${expect ? '   期望: ' + expect : ''}`);
        if (!ok) fails.push(label);
    };

    console.log('拼图:间距(外边距/缝隙/点选) + 字幕(底部让位/竖排背景条/第二行/间距) + 取色实时生效');
    console.log('─'.repeat(90));

    let res = null;
    try {
        res = await win.webContents.executeJavaScript(RUN);
    } catch (e) {
        console.log('  执行异常: ' + (e && e.message));
        fails.push('执行异常');
    }
    if (Array.isArray(res)) for (const r of res) line(r.ok, r.label, r.got);
    else line(false, '页面探针应返回数组', String(res), 'array');

    console.log('─'.repeat(90));
    console.log(fails.length ? `✗ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 ${(res || []).length} 项通过`);
    app.exit(fails.length ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });

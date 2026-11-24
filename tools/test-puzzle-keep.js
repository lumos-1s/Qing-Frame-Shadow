// 拼图「放久后卡死 / 变回单张照片」修复回归(带壳:加载真实 index.html 走真实 API)。
//
// 覆盖四组修复:
//   ① 保拼图 —— 拼图进行中导入不再打回单图(旧:defaultTemplate+selectImage);
//      离开拼图照片时状态栏提示「拼图保存在哪张上」;undo 把拼图整个撤掉时提示 Ctrl+Y,
//      redo 能把拼图整体找回。afterImageSelect 里那段恒无效的"伪保拼图"已删除。
//   ② 导出不悬死 —— 渲染抛错时 _awaitFrameRender 必须拒掉 Promise(旧写法 res 永不执行,
//      exportImage/exportPuzzle/_renderGridFrame 全部悬死,uiDprOverride/displayMax/exportScale
//      被钉死);三个临时档位在抛错路径也必须还原。
//   ③ 草稿瘦身 —— 30 秒兜底只在 _draftDirty 时写;超 2MB 剥大 data: 串(只动副本);
//      剥完仍超 8MB 跳过写入并记诊断日志。
//   ④ 导入并发池 —— 加载任务并发数有界(=3),几十张大图不再同时开跑。
//   ⑤ 拼图主导出尺寸 —— 顶部「导出」在“原图尺寸”档(sizeOpt=0)也必须按 4000px
//      长边渲染;旧行为:拼图版式坐标固定 1000 单位、不设 exportScale,画布停在
//      1000~3000px,默认 JPG q92 只有几百 KB。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
// 本用例要真读写 localStorage(草稿),必须与用户正在使用的真实 userData 隔离:
// 共享 leveldb 既有与运行中实例的锁竞争,也可能覆盖用户真实的"继续上次会话"草稿
const TMP_UD = path.join(os.tmpdir(), 'qfs-test-puzzlekeep-' + process.pid);
app.setPath('userData', TMP_UD);
process.on('exit', () => { try { fs.rmSync(TMP_UD, { recursive: true, force: true }); } catch (e) {} });
const NO_OP = ['save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch', 'check-for-updates', 'start-update-download', 'quit-and-install', 'write-export-files'];
for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates', 'list-custom-icons', 'list-presets']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of NO_OP) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'pick-export-location']) ipcMain.handle(c, () => ({ canceled: true }));

const RUN = `(async () => {
  const A = window.App;
  const res = [];
  const add = (ok, label, got) => res.push({ ok: !!ok, label: label, got: String(got) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 草稿测试会临时占用真实 localStorage:先抓住原始值,结束时原样还回去
  const ORIG_DRAFT = (() => { try { return localStorage.getItem(A._draftKey); } catch (e) { return null; } })();
  const restoreDraftRaw = () => {
    try { if (ORIG_DRAFT == null) localStorage.removeItem(A._draftKey); else localStorage.setItem(A._draftKey, ORIG_DRAFT); } catch (e) {}
  };

  try {
    // ── 布景:一张主图 + 启用中的拼图模板 ──
    const img = new Image();
    {
      const c = document.createElement('canvas'); c.width = 400; c.height = 300;
      const g = c.getContext('2d'); g.fillStyle = '#c06030'; g.fillRect(0, 0, 400, 300);
      await new Promise(r => { img.onload = r; img.onerror = r; img.src = c.toDataURL('image/png'); });
    }
    const im0 = { el: img, name: '主图.png', path: 'test://主图.png', w: 400, h: 300, exif: {}, customSettings: null };
    const enablePuzzle = () => {
      const pk = A.template.puzzle;
      pk.enabled = 1; pk.layout = 'grid4'; pk.layoutType = 6; pk.gap = 60;
      pk.slots = { 0: { imageIndex: 0 }, 1: { imageIndex: 0 }, 2: { imageIndex: 0 }, 3: { imageIndex: 0 } };
    };
    A.images = [im0]; A.currentIdx = 0; A.image = im0;
    A.template = A.defaultTemplate(); enablePuzzle();
    im0.customSettings = JSON.parse(JSON.stringify(A.template));
    A.imageTemplates.set(im0, im0.customSettings);
    A.buildThumbnails();

    // ── ①+④ 拼图进行中导入:保拼图 + 3 并发池 ──
    const mkFile = async (name) => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240;
      const g = c.getContext('2d'); g.fillStyle = '#3060c0'; g.fillRect(0, 0, 320, 240);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      return new File([blob], name, { type: 'image/png' });
    };
    const files = [];
    for (let i = 1; i <= 8; i++) files.push(await mkFile('导入' + i + '.png'));
    let inflight = 0, maxInflight = 0, calls = 0;
    // 导入管线已改走 importPicked → imageFromPick;测试没有 preload 的 qflocal:,
    // 因此用一个从 File/Blob 直接解码的替身,仍然量 importPicked 里的 3 并发池。
    const origImageFromPick = A.imageFromPick;
    A.imageFromPick = async (item) => {
      calls++; inflight++; if (inflight > maxInflight) maxInflight = inflight;
      await sleep(25);
      const f = item && item.file;
      const url = URL.createObjectURL(f);
      const el = new Image();
      await new Promise(r => { el.onload = r; el.onerror = r; el.src = url; });
      URL.revokeObjectURL(url);
      inflight--;
      if (!el.naturalWidth) return null;
      return { el, name: item.name, path: 'test://' + item.name, w: el.naturalWidth, h: el.naturalHeight, exif: {}, customSettings: null };
    };
    A._draftDirty = false;
    await A.importPicked(files.map(f => ({ name: f.name, file: f })), 0);
    A.imageFromPick = origImageFromPick;
    add(calls === 8, '导入 8 张文件都进加载管线', 'calls=' + calls);
    add(maxInflight === 3, '④ 加载并发数有界 = 3(旧实现 8 张同时开跑)', 'maxInflight=' + maxInflight);
    add(A.images.length === 9, '导入后胶片条 1+8 张', A.images.length + ' 张');
    add(A.image === im0 && A.currentIdx === 0, '① 拼图进行中导入不切主图', 'currentIdx=' + A.currentIdx);
    add(!!A.tplPuzzle(), '① 主图模板仍是拼图(未被打回 defaultTemplate)', A.tplPuzzle() ? 'enabled' : 'null');
    add(/拼图保持/.test(A.statusMsg), '① 状态栏提示拼图保持在哪张上', A.statusMsg);
    add(A._draftDirty === true, '③ 导入完成主动 scheduleDraft(脏标记置位)', '_draftDirty=' + A._draftDirty);

    // ── ① 切走/切回:提示去向 + 切回恢复 ──
    A.selectImage(1);
    add(!A.tplPuzzle(), '切到无预设的新图:画面为单图(默认模板)', A.tplPuzzle() ? 'puzzle' : 'single');
    add(/拼图保存在「主图/.test(A.statusMsg), '① 离开拼图照片时提示拼图保存在哪张上', A.statusMsg);
    A.selectImage(0);
    add(!!A.tplPuzzle(), '① 切回主图:拼图随该图预设恢复', A.tplPuzzle() ? 'enabled' : 'null');

    // ── ① undo 撤掉拼图:Ctrl+Y 提示 + redo 找回 ──
    A.undoStack = []; A.redoStack = [];
    A.template = A.defaultTemplate();
    A.pushUndo();                       // 栈顶 = 单图快照(即"启用拼图"操作前的状态)
    enablePuzzle();
    A.saveCurrentTemplate();
    A.undo();
    add(!A.tplPuzzle() && /Ctrl\\+Y/.test(A.statusMsg), '① undo 把拼图整个撤掉时提示 Ctrl+Y 可恢复', A.statusMsg);
    A.redo();
    add(!!A.tplPuzzle() && /已重做/.test(A.statusMsg), '① redo 立即把拼图整体找回', A.statusMsg);

    // ── ② 导出渲染抛错:不悬死、临时档位必还原 ──
    const origRender = window.__render;
    window.__render = () => { throw new Error('boom-render'); };
    let rejected = false;
    try { await A._awaitFrameRender(); } catch (e) { rejected = true; }
    add(rejected, '② _awaitFrameRender 渲染抛错时转为 Promise 拒绝(旧写法 res 永不执行)', 'rejected=' + rejected);

    A.displayMax = 777; A.uiDprOverride = 2;
    let gridRej = false;
    try { await A._renderGridFrame(); } catch (e) { gridRej = true; }
    add(gridRej && A.displayMax === 777 && A.uiDprOverride === 2,
      '② _renderGridFrame 抛错后 displayMax/uiDprOverride 已还原', 'displayMax=' + A.displayMax + ' uiDprOverride=' + A.uiDprOverride);
    window.__render = origRender;

    const origRenderPuzzle = window.__renderPuzzle;
    window.__renderPuzzle = () => { throw new Error('boom-puzzle'); };
    A.displayMax = 777; A.uiDprOverride = 2; A.exportScale = 456;
    const t0 = Date.now();
    await A.exportPuzzle();
    const dt = Date.now() - t0;
    window.__renderPuzzle = origRenderPuzzle;
    add(dt < 4000, '② exportPuzzle 渲染抛错不悬死', dt + 'ms');
    add(A.displayMax === 777 && A.uiDprOverride === 2 && A.exportScale === 456,
      '② exportPuzzle 临时档位(4000 档)已还原', 'displayMax=' + A.displayMax + ' dpr=' + A.uiDprOverride + ' scale=' + A.exportScale);
    add(/导出失败/.test(A.statusMsg), '② exportPuzzle 抛错给出失败提示', A.statusMsg);

    // ── ③ 草稿:脏写 / 剥 data: / 超限跳过 ──
    A.template = JSON.parse(JSON.stringify(im0.customSettings || A.template));
    A._draftDirty = false; A._draftTimer = null;
    try { localStorage.removeItem(A._draftKey); } catch (e) {}
    A.scheduleDraft();
    add(A._draftDirty === true, '③ scheduleDraft 置脏', '_draftDirty=' + A._draftDirty);
    await sleep(1900);
    let stored = null; try { stored = localStorage.getItem(A._draftKey); } catch (e) {}
    let parsed = null; try { parsed = JSON.parse(stored); } catch (e) {}
    add(A._draftDirty === false && !!parsed && Array.isArray(parsed.images) && parsed.images.length === A.images.length,
      '③ 防抖到期落盘并清脏(下次 interval 不再重复写)', 'dirty=' + A._draftDirty + ' images=' + (parsed && parsed.images ? parsed.images.length : 'n/a'));

    A.template.decorConfig = { textLines: [{ text: 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024 + 200000) }] };
    A.saveDraftNow();
    let raw2 = null; try { raw2 = localStorage.getItem(A._draftKey); } catch (e) {}
    add(!!raw2 && raw2.length < 2 * 1024 * 1024, '③ 超 2MB 草稿剥掉大 data: 串后成功写入', 'raw=' + (raw2 ? (raw2.length / 1048576).toFixed(2) + 'MB' : 'null'));
    let stripped = null; try { stripped = JSON.parse(raw2).template.decorConfig.textLines[0].text; } catch (e) {}
    add(stripped === '', '③ 剥离只动草稿副本,落盘值已清空', JSON.stringify(stripped).slice(0, 40));
    add(A.template.decorConfig.textLines[0].text.length > 2 * 1024 * 1024, '③ 内存中的模板原样保留', (A.template.decorConfig.textLines[0].text.length / 1048576).toFixed(1) + 'MB');

    A.template.decorConfig = { textLines: [{ text: 'x'.repeat(8 * 1024 * 1024 + 200000) }] };
    const logs = [];
    const origDiag = A.diagLog;
    A.diagLog = (m) => logs.push(String(m));
    const rawBefore = (() => { try { return localStorage.getItem(A._draftKey); } catch (e) { return null; } })();
    const tSkip0 = Date.now();
    A.saveDraftNow();
    const skipMs = Date.now() - tSkip0;
    const rawAfter = (() => { try { return localStorage.getItem(A._draftKey); } catch (e) { return null; } })();
    A.diagLog = origDiag;
    add(rawBefore === rawAfter && logs.some(l => /跳过/.test(l)),
      '③ 剥离后仍超 8MB:跳过写入并记诊断日志', 'skip=' + skipMs + 'ms ' + (logs.find(l => /跳过/.test(l)) || logs.join('|').slice(0, 80)));

    // ── ⑤ 主导出拼图:原图尺寸档 → 4000px 长边 ──
    // 本用例无 preload,window.qingframe 不存在;在渲染进程里补一个最小桩接住
    // 保存位置/写盘,让 exportImage 走完整真实流程。
    let EXPORTED = null;
    window.qingframe = Object.assign({}, window.qingframe || {}, {
      pickExportLocation: async () => ({ mode: 'dir', dir: 'qfs-test-export' }),
      writeExportFiles: async (payload) => {
        // 渲染层写盘成功后会就地清空同一批 file 对象的 data/bytes 释放内存
        // (app-export.js 的 pending.forEach)，桩若只存数组引用，第⑤项读尺寸时
        // 手里只剩空壳。这里浅拷贝一层，把编码结果留在自己手里。
        EXPORTED = ((payload && payload.files) || []).map(f => ({ ...f }));
        return { ok: EXPORTED.length, fail: 0 };
      },
      showItemInFolder: async () => ({ ok: true })
    });
    const tpl5 = A.defaultTemplate();
    tpl5.puzzle.enabled = 1;
    tpl5.puzzle.layout = 'grid4';
    tpl5.puzzle.gap = 6;
    tpl5.puzzle.bgMode = 0;
    tpl5.puzzle.slots = { 0: { imageIndex: 0 }, 1: { imageIndex: 0 }, 2: { imageIndex: 0 }, 3: { imageIndex: 0 } };
    A.template = JSON.parse(JSON.stringify(tpl5));
    im0.customSettings = JSON.parse(JSON.stringify(tpl5));
    A.imageTemplates.set(im0, im0.customSettings);
    A.currentIdx = 0; A.image = im0;
    A.dom.selFormat.value = 'jpeg';
    A.dom.selExportSize.value = '0';
    A.dom.slExportQuality.value = '92';
    A.dom.chkKeepExif.checked = false;
    // 拼图页签下即使胶片条还勾着别的照片，主按钮也只导当前这张拼图。
    A.selectedIdx = [0, 1]; A.batchSel = [0, 1];
    A.switchTab('puzzle');
    await A.exportImage();
    add(/导出完成/.test(A.statusMsg || ''), '⑤ 主导出拼图(原图尺寸档)完成', A.statusMsg || '(空)');
    add(EXPORTED && EXPORTED.length === 1, '⑤ 拼图页签忽略批量勾选，只导出当前拼图', EXPORTED && EXPORTED.length);
    const f5 = EXPORTED && EXPORTED[0];
    let dim5 = null;
    if (f5 && (f5.bytes || f5.data)) {
      const im5 = new Image();
      const src5 = f5.bytes
        ? URL.createObjectURL(new Blob([f5.bytes], { type: 'image/jpeg' }))
        : 'data:image/jpeg;base64,' + f5.data;
      await new Promise(r => { im5.onload = r; im5.onerror = r; im5.src = src5; });
      if (f5.bytes) URL.revokeObjectURL(src5);
      dim5 = { w: im5.naturalWidth, h: im5.naturalHeight };
    }
    add(!!(dim5 && Math.max(dim5.w, dim5.h) === 4000),
      '⑤ 主导出拼图原图尺寸档 → 长边 4000px(旧:1000~3000)',
      dim5 ? dim5.w + 'x' + dim5.h + ' / ' + Math.round((f5.bytes ? f5.bytes.length : f5.data.length * 0.75) / 1024) + 'KB' : '未捕获导出数据');
  } catch (e) {
    add(false, '探针执行异常', (e && e.message) || String(e));
  } finally {
    restoreDraftRaw();
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

    console.log('拼图保活:导入保拼图/提示去向/undo 提示 + 导出异常还原 + 草稿脏写与瘦身 + 导入并发池 + 主导出尺寸');
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

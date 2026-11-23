// 拼图三处「会弄坏结果/打断编辑」的回归：
//   ① 导出不再把空格画成灰块（预览仍保留灰块提示）
//   ② 导出前若有空格，先确认；取消就不弹保存位置
//   ③ 单格偏移滑块与拖拽同一量程（±100），不再被 50 截断
//   ④ 拼图进行中「导入照片」只追加 + 补进第一个空格，不切走主图/模板
//   ⑤ 两处过时文案不再指错位置（照片库在左侧、布局不再自动铺满）
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const TMP_UD = path.join(os.tmpdir(), 'qfs-test-puzzlefix-' + process.pid);
app.setPath('userData', TMP_UD);
process.on('exit', () => { try { fs.rmSync(TMP_UD, { recursive: true, force: true }); } catch (e) {} });

for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates', 'list-custom-icons', 'list-presets', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'copy-text', 'save-diagnostics', 'check-for-updates', 'quit-and-install', 'open-external', 'open-data-dir', 'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template', 'read-exif']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('open-image', () => ({ canceled: true }));   // 真值即可，图片由页面内的桩函数提供
ipcMain.handle('pick-export-location', () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);

const RUN = `(async () => {
  const A = window.App;
  const res = [];
  const add = (ok, label, got) => res.push({ ok: !!ok, label: label, got: String(got) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    // 5 张真实可解码的小图（拼图渲染要真实像素）
    const ims = [];
    for (let i = 0; i < 5; i++) {
      const c = document.createElement('canvas'); c.width = 120; c.height = 90;
      const g = c.getContext('2d');
      g.fillStyle = ['#c06030', '#30a060', '#3060c0', '#c0a030', '#8030c0'][i];
      g.fillRect(0, 0, 120, 90);
      const src = c.toDataURL('image/png');
      const img = new Image();
      await new Promise(r => { img.onload = r; img.onerror = r; img.src = src; });
      ims.push({ el: img, name: 'p' + i + '.png', w: 120, h: 90, exif: {}, customSettings: null, thumb: src });
    }
    A.images = ims; A.currentIdx = 0; A.image = ims[0]; A.selectedIdx = [0]; A.batchSel = [];
    A.template = A.defaultTemplate();
    const pk = A.template.puzzle;
    pk.enabled = 1; pk.layout = 'grid4'; pk.layoutType = 6; pk.gap = 10;
    pk.slots = { 0:{imageIndex:0}, 1:{imageIndex:1}, 2:{imageIndex:2} };   // 4 格只放 3 张
    ims[0].customSettings = JSON.parse(JSON.stringify(A.template));
    A.imageTemplates.set(ims[0], ims[0].customSettings);
    A.buildThumbnails(); A.updateEmptyState(); A.afterImageSelect();

    const countGray = () => {
      const c = A.dom.canvas;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === 224 && d[i + 1] === 224 && d[i + 2] === 224) n++;
      }
      return n;
    };

    // ① 预览仍有灰块，导出成片没有。
    // 必须在同一个同步块里渲染+读像素：中间只要让出一帧，排队的预览帧就会
    // 把导出画面重新盖回灰块（第一次就是这么误判的）。
    window.__renderPuzzle(A, false, false);
    const grayPreview = countGray();
    window.__renderPuzzle(A, false, true);
    const grayExport = countGray();
    window.__renderPuzzle(A, false, false);
    add(grayPreview > 1000, '预览里空格仍是灰块（编辑时看得见）', grayPreview);
    add(grayExport === 0, '导出渲染不再画灰块', grayExport);

    // ② 空格数统计与确认：取消就不去选保存位置
    add(A.puzzleEmptySlotCount(A.template) === 1, '数得清拼图空格', A.puzzleEmptySlotCount(A.template));
    A.selectedIdx = [0];
    const origConfirm = window.confirm;
    let asked = '';
    window.confirm = (msg) => { asked = msg; return false; };
    await A.exportImage();
    await sleep(120);
    add(/还有 1 个格子没放照片/.test(asked) && /一键铺满/.test(asked),
        '导出前提示空格数并指出补救入口', asked.replace(/\\n/g, ' '));
    add(/已取消导出/.test(A.statusMsg) && /空格/.test(A.statusMsg),
        '取消后停在导出前，不继续写文件', A.statusMsg);
    window.confirm = (msg) => { asked = msg; return true; };
    await A.exportImage();
    await sleep(150);
    add(A.statusMsg.trim() === '已取消导出',
        '确认继续后才走到选保存位置（测试桩取消）', A.statusMsg);
    // 格子放满后不该再拦一次——确认只在真有空格时出现
    A.template.puzzle.slots[3] = { imageIndex: 3 };
    let confirms = 0;
    window.confirm = () => { confirms++; return true; };
    await A.exportImage();
    await sleep(120);
    add(confirms === 0, '格子放满后不再弹空格确认', confirms);
    delete A.template.puzzle.slots[3];
    window.confirm = origConfirm;

    // ③ 滑块量程与拖拽一致：±100，不再被 50 截断
    const slX = A.$('slSlotOffsetX'), slY = A.$('slSlotOffsetY');
    add(slX.min === '-100' && slX.max === '100' && slY.min === '-100' && slY.max === '100',
        '偏移滑块量程是 ±100', [slX.min, slX.max, slY.min, slY.max].join('/'));
    A.setSlotOffsetSliders({ offsetX: 100, offsetY: -80 });
    add(slX.value === '100' && slY.value === '-80' && A.$('lblSlotOffsetX').textContent === '100',
        '拖到 100 时滑块与标签不再停在 50', [slX.value, slY.value, A.$('lblSlotOffsetX').textContent].join('/'));
    A.setSlotOffsetSliders({ offsetX: 0, offsetY: 0 });

    // ④ 拼图里导入照片：只追加、补第一个空格、不切主图
    const extra = document.createElement('canvas'); extra.width = 160; extra.height = 120;
    extra.getContext('2d').fillStyle = '#20c0c0'; extra.getContext('2d').fillRect(0, 0, 160, 120);
    const extraSrc = extra.toDataURL('image/png');
    const extraEl = new Image();
    await new Promise(r => { extraEl.onload = r; extraEl.onerror = r; extraEl.src = extraSrc; });
    const origAppend = A.appendImageFromPick;
    A.appendImageFromPick = async () => {
      A.images.push({ el: extraEl, name: 'new.png', w: 160, h: 120, exif: {}, customSettings: null, thumb: extraSrc });
      return A.images.length - 1;
    };
    const origSelect = A.selectImage;
    let selCalls = 0;
    A.selectImage = function () { selCalls++; return origSelect.apply(this, arguments); };
    const tplBefore = A.template;
    await A.openImage();
    await sleep(200);
    add(selCalls === 0 && A.currentIdx === 0 && A.template === tplBefore,
        '拼图中导入照片不切主图/不换模板', [selCalls, A.currentIdx, A.template === tplBefore].join('/'));
    add(A.images.length === 6 && A.template.puzzle.slots[3] && A.template.puzzle.slots[3].imageIndex === 5,
        '新照片自动补进第一个空格', JSON.stringify(A.template.puzzle.slots[3] || {}));
    add(/格子 4 已使用/.test(A.statusMsg), '状态栏说明放进了哪一格', A.statusMsg);

    // 格子已满：新照片仍进胶片条，但不覆盖任何格
    await A.openImage();
    await sleep(200);
    add(A.images.length === 7 && A.template.puzzle.slots[0].imageIndex === 0,
        '格子满时只加入胶片条，不动已放好的格', A.images.length + '/' + A.template.puzzle.slots[0].imageIndex);
    add(/已加入胶片条/.test(A.statusMsg), '格子满时状态栏说明照片在哪', A.statusMsg);
    A.appendImageFromPick = origAppend;
    A.selectImage = origSelect;
  } catch (e) {
    add(false, '执行异常', e && e.message);
  }
  return res;
})()`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1600, height: 1000, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 60; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && App.dom && App.dom.canvas)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    await new Promise(r => setTimeout(r, 700));
    await win.webContents.executeJavaScript(`localStorage.setItem('qfs_intro_done','1'); try{App.closeIntro&&App.closeIntro();}catch(_){} true`);

    const fails = [];
    const line = (ok, label, got) => {
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
        console.log(`       ${got}`);
        if (!ok) fails.push(label);
    };
    console.log('拼图收尾:空格导出 / 导出确认 / 偏移量程 / 拼图中导入照片');
    console.log('─'.repeat(90));

    // ⑤ 文案：照片库在左侧、布局不再自动铺满（静态文件检查，和界面渲染无关）
    const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
    line(html.includes('再用「一键铺满」按勾选顺序填入'), '照片库提示指向「一键铺满」', 'ok');
    line(html.includes('再点左侧照片放入'), '拼图提示指明照片库在左侧', 'ok');
    line(!html.includes('再点布局按勾选顺序铺满') && !html.includes('再点下方照片放入'),
        '两处过时文案已不存在', 'ok');

    let res = null;
    try { res = await win.webContents.executeJavaScript(RUN); }
    catch (e) { console.log('  执行异常: ' + (e && e.message)); fails.push('执行异常'); }
    if (Array.isArray(res)) for (const r of res) line(r.ok, r.label, r.got);
    else line(false, '页面探针应返回数组', String(res));
    console.log('─'.repeat(90));
    console.log(fails.length ? `✗ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 ${(res || []).length + 3} 项通过`);
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });

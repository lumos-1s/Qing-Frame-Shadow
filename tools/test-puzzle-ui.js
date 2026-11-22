// 拼图 UX 回归（带壳：加载真实 index.html 走真实 App）：
//   ① 进拼图页签，左侧素材栏自动切成照片库，画布左上角出现「退出拼图」
//   ② 点左侧照片 = 放进选中格；胶片条与照片库同步显示已用格子角标
//   ③ 一键风格只改间距/圆角/底色/比例，保留每格照片；手动改参数后不高亮
//   ④ 退出拼图：关掉入口、还原用户原来的素材栏模式
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const TMP_UD = path.join(os.tmpdir(), 'qfs-test-puzzleui-' + process.pid);
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
  // 真实鼠标会先发 mousedown；只调 el.click() 会漏掉「点画布以外清选中」的全局监听
  const realClick = (el) => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.click();
  };

  try {
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
    pk.slots = { 0:{imageIndex:0}, 1:{imageIndex:1}, 2:{imageIndex:2}, 3:{imageIndex:3} };
    ims[0].customSettings = JSON.parse(JSON.stringify(A.template));
    A.imageTemplates.set(ims[0], ims[0].customSettings);
    A.buildThumbnails(); A.updateEmptyState(); A.afterImageSelect();

    // ① 非拼图页签：照片入口 / 退出按钮都不该出现
    A.switchTab('canvas');
    await sleep(120);
    add(A.$('sideTabPhoto').hidden, '非拼图页签：照片入口隐藏', A.$('sideTabPhoto').hidden);
    add(A.$('btnPuzzleExit').hidden, '非拼图页签：退出拼图入口隐藏', A.$('btnPuzzleExit').hidden);

    // ② 进拼图页签：照片库接管左栏，退出按钮出现
    A.switchTab('puzzle');
    await sleep(250);
    add(!A.$('sideTabPhoto').hidden && !A.$('sidePhotoBody').hidden && A._sideMode === 'photo',
        '拼图页签：左侧自动切成照片库', A._sideMode);
    add(A.$('photoLibGrid').children.length === 5, '照片库列出全部 5 张照片', A.$('photoLibGrid').children.length);
    add(A.$('photoLibGrid').querySelectorAll('.photo-lib-slot').length === 4,
        '照片库标出已入格的 4 张', A.$('photoLibGrid').querySelectorAll('.photo-lib-slot').length);
    add(!A.$('btnPuzzleExit').hidden, '拼图页签：退出拼图入口出现', A.$('btnPuzzleExit').hidden);
    add(A.$('puzzleStyles').children.length === 4, '风格预设 4 个按钮', A.$('puzzleStyles').children.length);
    const stText = A.dom.stCanvas.textContent;
    add(stText.indexOf('画布') === 0 && stText.indexOf('导出 4000') > 0,
        '状态栏区分预览画布与 4000px 导出尺寸', stText);

    // ③ 选中格子浮层出现，操作按钮可用
    A.setActivePuzzleSlot(0);
    await sleep(120);
    add(!A.$('puzzleSlotBar').hidden && A.$('psbTitle').textContent.indexOf('格子 1/4') === 0,
        '选中格子后画布浮层出现', A.$('psbTitle').textContent);
    add(!A.$('psbRotate').disabled && !A.$('psbReset').disabled && !A.$('psbClear').disabled,
        '有图格子：旋转/复位/清空按钮可用', [A.$('psbRotate').disabled, A.$('psbReset').disabled, A.$('psbClear').disabled].join('/'));

    // ④ 点照片库第 5 张 → 放进选中格 0，两个入口都出现角标
    realClick(A.$('photoLibGrid').children[4]);
    await sleep(250);
    add(A.template.puzzle.slots[0].imageIndex === 4, '点照片库照片放进选中格', A.template.puzzle.slots[0].imageIndex);
    add(A._activePuzzleSlot === 0, '点照片库不会先清掉选中格', A._activePuzzleSlot);
    add(A.currentIdx === 0, '放图不切走当前主图', A.currentIdx);
    realClick(A.dom.thumbStrip.querySelectorAll('.thumb')[0]);
    await sleep(150);
    add(A.template.puzzle.slots[0].imageIndex === 0, '点胶片条照片放进选中格', A.template.puzzle.slots[0].imageIndex);
    realClick(A.$('photoLibGrid').children[4]); // 复原成第 5 张，供后面核对「风格不改格子内容」
    await sleep(150);
    const cardBadge = A.$('photoLibGrid').children[4].querySelector('.photo-lib-slot');
    const thumbBadge = A.dom.thumbStrip.querySelectorAll('.thumb-item')[4].querySelector('.thumb-used');
    add(!!cardBadge && cardBadge.textContent === '1', '照片库出现已用角标', cardBadge && cardBadge.textContent);
    add(!!thumbBadge && thumbBadge.textContent === '1', '胶片条出现已用角标', thumbBadge && thumbBadge.textContent);

    // ⑤ 浮层按钮真的改模型
    realClick(A.$('psbRotate'));
    await sleep(120);
    add(A.template.puzzle.slots[0].rotate === 1, '浮层旋转按钮生效', A.template.puzzle.slots[0].rotate);
    add(A._activePuzzleSlot === 0, '点浮层按钮不会先清掉选中格', A._activePuzzleSlot);
    realClick(A.$('psbReset'));
    await sleep(120);
    add(A.template.puzzle.slots[0].zoom == null, '浮层复位按钮清掉手动缩放', A.template.puzzle.slots[0].zoom);
    realClick(A.$('psbClear'));
    await sleep(150);
    add(A.template.puzzle.slots[0].imageIndex == null, '浮层清空按钮清掉该格照片', A.template.puzzle.slots[0].imageIndex);
    add(A.$('psbRotate').disabled && A.$('psbTitle').textContent.indexOf('空') > 0,
        '空格子：操作按钮置灰且标题标空', A.$('psbTitle').textContent);
    realClick(A.$('photoLibGrid').children[4]); // 复原，供后面的风格测试核对「保留格子内容」
    await sleep(150);

    // ⑥ 风格：改参数不改格子；手动改间距后不高亮
    A.$('puzzleStyles').querySelector('[data-val="ink"]').click();
    await sleep(200);
    const p2 = A.template.puzzle;
    add(p2.gap === 12 && p2.cornerRadius === 0 && p2.borderColor === '16181a',
        '一键风格写入间距/圆角/边框色', [p2.gap, p2.cornerRadius, p2.borderColor].join('/'));
    add(p2.slots[0].imageIndex === 4, '一键风格保留每格照片', p2.slots[0].imageIndex);
    add(A.$('puzzleStyles').querySelector('[data-val="ink"]').classList.contains('active'), '风格按钮回显高亮', 'ink');
    A.$('slPuzzleGap').value = 33;
    A.$('slPuzzleGap').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    add(!A.$('puzzleStyles').querySelector('.active'), '手动改参数后风格不高亮',
        Array.from(A.$('puzzleStyles').querySelectorAll('.active')).map(b => b.dataset.val).join(','));

    // ⑤ 退出拼图：入口关闭、照片入口收起、素材栏还原
    A.$('btnPuzzleExit').click();
    await sleep(180);
    add(A.template.puzzle.enabled === 0, '退出后拼图关闭', A.template.puzzle.enabled);
    add(A.$('btnPuzzleExit').hidden && A.$('sideTabPhoto').hidden, '退出后两个入口都收起', A.$('sideTabPhoto').hidden);
    add(A._sideMode === 'border', '退出后素材栏还原为边框模式', A._sideMode);
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
    console.log('拼图 UX:照片库接管左栏 / 照片入格角标 / 一键风格 / 退出拼图');
    console.log('─'.repeat(90));
    let res = null;
    try { res = await win.webContents.executeJavaScript(RUN); }
    catch (e) { console.log('  执行异常: ' + (e && e.message)); fails.push('执行异常'); }
    if (Array.isArray(res)) for (const r of res) line(r.ok, r.label, r.got);
    else line(false, '页面探针应返回数组', String(res));
    console.log('─'.repeat(90));
    console.log(fails.length ? `✗ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 ${(res || []).length} 项通过`);
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });

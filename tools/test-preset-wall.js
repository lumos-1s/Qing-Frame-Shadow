// 预设墙启动主页回归：启动默认显示墙、87 张卡片渲染、点击进编辑（sidebar 隐藏）、返回墙、跳过入口。
// 用法：node tools/run-electron.js tools/test-preset-wall.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── IPC mock：让渲染进程的 presets.js 能读到 shared/presets ──
// 与 src/main/index.js 的真实契约对齐：list-presets 返回**不带 .json** 的名字。
// 之前这里返回带扩展名的文件名，把"墙数据 preset 带 .json → 查找永不命中"这个 bug 全遮住了。
ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
// open-image 在自动移除示例图的用例里需要返回一张真实选择结果，其余时候保持取消
let openImageResult = CANCEL();
ipcMain.handle('open-image', () => openImageResult);
for (const channel of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(channel, EMPTY_LIST);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install']) ipcMain.handle(channel, OK);
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({ version: '0.1.21', electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT }));
// 预设墙自定义封面：默认空，用例里临时塞一条再清掉
let wallCovers = {};
ipcMain.handle('list-wall-covers', () => wallCovers);
ipcMain.handle('open-wall-covers-dir', () => ({ ok: true, path: 'C:/tmp/wall-covers' }));
const failures = [];

function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

async function main() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        show: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(400);
    win.showInactive();
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1600);

    const setup = await exec(`(async () => {
      try {
        const App = window.App;
        if (!App) return { error: 'App 未加载' };
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        // tools/preload-measure.js 会注入 window.__qfTest，app.js 因此跳过「启动即开墙」，
        // 否则墙的覆盖层会挡住其它用例的真实鼠标事件。本用例是墙自己的测试，显式打开。
        App.openPresetWall();
        for (let i = 0; i < 80 && (!App.presets || App.presets.length < 4); i++) await wait(100);
        for (let i = 0; i < 80 && !document.getElementById('presetWallGrid').querySelectorAll('.pw-tile').length; i++) await wait(100);
        return { ok: true, presets: App.presets.length, tiles: document.getElementById('presetWallGrid').querySelectorAll('.pw-tile').length };
      } catch (e) { return { error: String(e) }; }
    })()`);
    check(setup.ok, 'App 与预设墙就绪（显式打开）', setup.error || `presets=${setup.presets} tiles=${setup.tiles}`);

    // 0. 无障碍：只有第 0 份拷贝参与 Tab 与读屏（否则 360 个 Tab 停点、同一张卡播报四遍）
    const a11y = await exec(`(() => ({
        all: document.querySelectorAll('.pw-tile').length,
        focusable: document.querySelectorAll('.pw-tile[tabindex="0"]').length,
        ariaHidden: document.querySelectorAll('.pw-tile[aria-hidden="true"]').length
    }))()`);
    check(a11y.all === 360 && a11y.focusable === 90 && a11y.ariaHidden === 270,
        'Tab 停点只有 90 个（3 份拷贝 aria-hidden）', JSON.stringify(a11y));

    // 0.5 首屏对齐格心：没有任何预设时也要让中心卡是 1.25，而不是落在格间隙的 1.05
    const bootFocus = await exec(`(() => {
        const g = document.getElementById('presetWallGrid');
        const r = g.getBoundingClientRect();
        const sc = (t) => { const ts = t.style.transform; const p = ts.indexOf('scale('); return p >= 0 ? parseFloat(ts.slice(p + 6)) : 1; };
        let best = 0, bd = Infinity;
        for (const t of g.querySelectorAll('.pw-tile')) {
            const q = t.getBoundingClientRect();
            const d = Math.hypot(q.left + q.width / 2 - (r.left + r.width / 2), q.top + q.height / 2 - (r.top + r.height / 2));
            if (d < bd) { bd = d; best = sc(t); }
        }
        return { scale: best, dist: Math.round(bd) };
    })()`);
    check(bootFocus.scale > 1.2, '首屏中心卡即 1.25（开局对齐到格心）',
        `scale=${bootFocus.scale} dist=${bootFocus.dist}`);

    // 1. 启动默认显示预设墙（hidden=false）
    const wallVisible = await exec(`(() => {
        const w = document.getElementById('presetWall');
        return !!(w && !w.hidden && w.getClientRects().length > 0);
    })()`);
    check(wallVisible, '启动默认显示预设墙');

    // 2. 90 格周期网格渲染（87 张预设循环填充）+ 每张有封面图
    const tiles = await exec(`(() => {
        const g = document.getElementById('presetWallGrid');
        const list = Array.from(g.querySelectorAll('.pw-tile'));
        // 名称必须真的落在卡片可视区内：曾经 img 被设成整卡高、把名称挤出 overflow，
        // textContent 仍在、旧断言全绿，但用户一个字都看不到。
        const clipped = list.filter((t) => {
            const el = t.querySelector('.pw-tile-name');
            if (!el || !el.textContent) return true;
            const tb = t.getBoundingClientRect(), nb = el.getBoundingClientRect();
            return nb.height < 1 || nb.top < tb.top - 0.5 || nb.bottom > tb.bottom + 0.5;
        }).length;
        return {
            blocks: g.querySelectorAll('.pw-block').length,
            count: list.length,
            noCover: list.filter(t => !t.querySelector('.pw-tile-cover img')).length,
            noName: list.filter(t => !t.querySelector('.pw-tile-name') || !t.querySelector('.pw-tile-name').textContent).length,
            clipped,
            nameFs: list.length ? parseFloat(getComputedStyle(list[0].querySelector('.pw-tile-name')).fontSize) : 0,
            // 封面是「照片+边框」的合成图，object-fit 必须是 contain：
            // 改 cover 会切掉边框和主体，用户一眼就能看出"图没显示全"
            objectFit: list.length ? getComputedStyle(list[0].querySelector('.pw-tile-cover img')).objectFit : '',
            sub: (document.getElementById('pwSub') || {}).textContent || ''
        };
    })()`);
    check(tiles.count === 360 && tiles.blocks === 4, '4 份拷贝 × 90 格 = 360 张卡片',
        `blocks=${tiles.blocks} count=${tiles.count}`);
    check(tiles.noCover === 0, '每张卡片都有封面图', `noCover=${tiles.noCover}`);
    check(tiles.noName === 0, '每张卡片都有名称', `noName=${tiles.noName}`);
    check(tiles.clipped === 0, '名称落在卡片可视区内（没被封面图挤出 overflow）', `clipped=${tiles.clipped}`);
    check(tiles.nameFs >= 12, '名称字号可读（≥12px）', `fontSize=${tiles.nameFs}`);
    check(tiles.objectFit === 'contain', '封面完整显示（不许裁切）', `object-fit=${tiles.objectFit}`);

    // 2.5 方向键移动选中（上下左右，周期内循环）
    const kb = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const first = g.querySelector('.pw-tile');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
      return { selCount: g.querySelectorAll('.pw-tile.selected').length, selC: App._wallSel.c, selR: App._wallSel.r };
    })()`);
    check(kb.selCount === 4, '方向键移动出现选中框（4 份拷贝同步高亮）', `selected=${kb.selCount}`);
    check(kb.selC === 1 && kb.selR === 0, '方向键右移选中下一格', `c=${kb.selC} r=${kb.selR}`);

    const kb2 = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const first = g.querySelector('.pw-tile');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
      return { selC: App._wallSel.c, selR: App._wallSel.r };
    })()`);
    check(kb2.selC === 0 && kb2.selR === 0, '方向键左移选中上一格', `c=${kb2.selC} r=${kb2.selR}`);

    const kb3 = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const first = g.querySelector('.pw-tile');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
      return { selC: App._wallSel.c, selR: App._wallSel.r };
    })()`);
    check(kb3.selR === 1 && kb3.selC === 0, '方向键下移选中下一行', `r=${kb3.selR} c=${kb3.selC}`);

    // 2.6 无限磁贴墙：周期块覆盖视口 + 中间卡片最显眼 + 拖动平移 + 取模回绕
    const wall = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const block = g.querySelector('.pw-block');
      const tiles = Array.from(g.querySelectorAll('.pw-tile'));
      const b = App._wallBounds;
      // 无限墙基础：周期块宽高均大于视口（任意偏移下视口内都有卡）
      const covers = !!b && b.BW > g.clientWidth && b.BH > g.clientHeight;
      // 中间卡片（视口中心附近）scale 最大（inline transform 由 JS focusWall 写入）
      const sc = (t) => { const ts = t.style.transform; const p = ts.indexOf('scale('); return p >= 0 ? parseFloat(ts.slice(p + 6)) : 1; };
      let maxS = 0;
      for (const t of tiles) { const v = sc(t); if (v > maxS) maxS = v; }
      const vr = g.getBoundingClientRect();
      // 4 份拷贝的同一格 scale 相同，取离视口中心最近的那一份量距离
      let centerDist = Infinity;
      for (const t of tiles) {
          if (sc(t) < maxS - 0.01) continue;
          const tr = t.getBoundingClientRect();
          centerDist = Math.min(centerDist, Math.hypot((tr.left + tr.width / 2) - (vr.left + vr.width / 2),
                                                        (tr.top + tr.height / 2) - (vr.top + vr.height / 2)));
      }
      const centerFocus = centerDist < b.tw * 0.9;
      // 模拟按住拖动（横向 + 纵向）：整墙应跟随平移
      const r = g.getBoundingClientRect();
      g.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: r.left + 600, clientY: r.top + 400, bubbles: true }));
      g.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: r.left + 600 - 2000, clientY: r.top + 400 - 1500, bubbles: true }));
      g.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
      await new Promise((x) => setTimeout(x, 120));
      // 断言用未回绕的累计位移：回绕后的 _wallOffset 被压在 [-span,0]，拿它比 -1000 会误判
      const ox1 = App._wallPan.x, oy1 = App._wallPan.y;
      const wallMoved = ox1 < -1000 && oy1 < -1000;
      // 拖到任意位置，周期块都必须仍然盖住视口（否则墙会露白）
      // 2×2 份拷贝拼成一张连续的面：四条边各自越出视口即视为不露白
      const coversViewport = () => {
          const rs = Array.from(g.querySelectorAll('.pw-block')).map((bl) => bl.getBoundingClientRect());
          if (!rs.length) return false;
          const left = Math.min(...rs.map((q) => q.left)), right = Math.max(...rs.map((q) => q.right));
          const top = Math.min(...rs.map((q) => q.top)), bottom = Math.max(...rs.map((q) => q.bottom));
          return left <= vr.left + 1 && right >= vr.right - 1 && top <= vr.top + 1 && bottom >= vr.bottom - 1;
      };
      const coversAfterDrag = coversViewport();
      // 取模回绕：连续拖 4 个周期宽，偏移仍被约束在 [-BW, 0]（墙无尽头）
      g.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: r.left + 600, clientY: r.top + 400, bubbles: true }));
      for (let i = 0; i < 4; i++) {
        g.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: r.left + 600 - (i + 1) * b.BW, clientY: r.top + 400, bubbles: true }));
      }
      g.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
      await new Promise((x) => setTimeout(x, 120));
      const ox2 = App._wallOffsetX;
      const spanW = App.wallWrapSpan().w;
      const wrapped = ox2 <= 0 && ox2 > -b.BW;
      const coveredAtWrap = coversViewport();
      return { tileCount: tiles.length, covers, maxS, centerDist, centerFocus, ox1, oy1, wallMoved,
               coversAfterDrag, ox2, wrapped, coveredAtWrap, spanW, bw: b.BW, bh: b.BH, vw: g.clientWidth, vh: g.clientHeight };
    })()`);
    check(wall.tileCount === 360, '拖动后仍是 4 份 × 90 格（360 张）', `count=${wall.tileCount}`);
    check(wall.covers, '周期块覆盖视口（无限墙基础）', `BW=${wall.bw} BH=${wall.bh} vw=${wall.vw} vh=${wall.vh}`);
    check(wall.centerFocus, '最中间的图片最显眼', `scale=${wall.maxS} dist=${Math.round(wall.centerDist)}`);
    check(wall.wallMoved, '按住拖动后整墙跟随鼠标平移', `pan=${Math.round(wall.ox1)},${Math.round(wall.oy1)}`);
    check(wall.coversAfterDrag, '拖到任意位置周期块仍盖满视口（不露白）');
    check(wall.wrapped, '拖动超界自动取模回绕（墙无尽头）', `ox2=${wall.ox2} BW=${wall.bw}`);
    check(wall.coveredAtWrap, '回绕边界处视口仍被卡片填满', `span=${wall.spanW} ox=${wall.ox2}`);

    // 2.65 回绕一致性：偏移跨过整整一个周期后，视口正中必须还是同一张卡。
    // 这直接对应"移动时图片会跳、像刷新"——周期块只有一份、回绕跨度又不是整周期时，
    // 回绕瞬间屏幕内容整体换一遍；2×2 份拷贝 + 整周期回绕之后，两侧内容逐格相同。
    const seam = await exec(`(async () => {
        const g = document.getElementById('presetWallGrid');
        App.stopWallMotion();
        const b = App._wallBounds;
        App.panWallTo(-300, -200);
        await new Promise((x) => setTimeout(x, 60));
        const r = g.getBoundingClientRect();
        const cx = r.left + g.clientWidth / 2, cy = r.top + g.clientHeight / 2;
        // 取中心附近那张卡的中心作为采样点（正中可能正好落在格间隙）
        let best = null, bd = Infinity;
        for (const t of g.querySelectorAll('.pw-tile')) {
            const q = t.getBoundingClientRect();
            const d = Math.hypot(q.left + q.width / 2 - cx, q.top + q.height / 2 - cy);
            if (d < bd) { bd = d; best = q; }
        }
        const px = best.left + best.width / 2, py = best.top + best.height / 2;
        const at = () => {
            const el = document.elementFromPoint(px, py);
            const tile = el && el.closest ? el.closest('.pw-tile') : null;
            return tile ? tile.dataset.idx : null;
        };
        const before = at();
        App.panWallTo(-300 - b.BW, -200 - b.BH);
        await new Promise((x) => setTimeout(x, 60));
        const after = at();
        App.panWallTo(-300 - b.BW / 2, -200 - b.BH / 2);
        await new Promise((x) => setTimeout(x, 60));
        const midEl = document.elementFromPoint(cx, cy);
        const midInBlock = !!(midEl && midEl.closest && midEl.closest('.pw-block'));
        return { before, after, midInBlock, bw: b.BW };
    })()`);
    check(seam.before !== null && seam.before === seam.after,
        '跨一个周期回绕后同一位置仍是同一张卡（不跳不换）', `${seam.before} → ${seam.after}`);
    check(seam.midInBlock, '半周期处视口仍是墙面而不是空白');

    // 2.66 无限 / 有限 切换：用户抱怨"不知道划没划过"，所以给了个开关。
    //      有限墙必须是「每张预设只出现一次 + 拖到头就停 + 有进度条」，否则等于没修。
    const finite = await exec(`(async () => {
        const A = window.App;
        const g = document.getElementById('presetWallGrid');
        A.setWallMode('finite');
        await new Promise((r) => setTimeout(r, 250));
        const b = A._wallBounds;
        const tiles = Array.from(g.querySelectorAll('.pw-tile'));
        const uniq = new Set(tiles.map((t) => Number(t.dataset.idx)));
        const n = (window.PRESET_WALL.items || []).length;
        // 往左上猛拖：偏移不能越过"第一屏"，否则又成了循环墙
        A.panWallTo(900, 900);
        const top = { x: A._wallOffsetX, y: A._wallOffsetY };
        const topBar = document.querySelector('#pwRail i').style.top;
        // 往右下猛拖：偏移停在最后一屏
        A.panWallTo(-99999, -99999);
        const bottom = { x: A._wallOffsetX, y: A._wallOffsetY };
        const rail = document.getElementById('pwRail');
        // 方向键到边不能再绕到另一端
        const t0 = g.querySelector('.pw-tile');
        t0.focus();
        A._wallSel = { r: 0, c: 0 };
        t0.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        t0.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 50));
        const sel0 = { r: A._wallSel.r, c: A._wallSel.c };
        A._wallSel = { r: 0, c: b.P - 1 };
        t0.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 50));
        const selEdge = { r: A._wallSel.r, c: A._wallSel.c };
        return {
            blocks: g.querySelectorAll('.pw-block').length, tiles: tiles.length, uniq: uniq.size, n,
            P: b.P, Q: b.Q, BW: b.BW, BH: b.BH, vw: g.clientWidth, vh: g.clientHeight,
            top, bottom, topBar,
            railShown: !!rail && !rail.hidden,
            railHeight: rail ? rail.querySelector('i').style.height : '',
            onBtn: document.querySelector('#pwMode [data-wall-mode="finite"]').classList.contains('is-on'),
            infiniteBtn: document.querySelector('#pwMode [data-wall-mode="infinite"]').classList.contains('is-on'),
            stored: localStorage.getItem('qfs_wall_mode'),
            sub: document.getElementById('pwSub').textContent,
            sel0, selEdge,
            expectTop: {
                x: b.BW <= g.clientWidth ? Math.round((g.clientWidth - b.BW) / 2) : 0,
                y: b.BH <= g.clientHeight ? Math.round((g.clientHeight - b.BH) / 2) : 0
            },
            // 横向装得下就居中（列数取整后总会剩几十像素），装不下才夹到右边界
            expectBottom: {
                x: b.BW <= g.clientWidth ? Math.round((g.clientWidth - b.BW) / 2) : g.clientWidth - b.BW,
                y: b.BH <= g.clientHeight ? Math.round((g.clientHeight - b.BH) / 2) : g.clientHeight - b.BH
            }
        };
    })()`);
    check(finite.blocks === 1 && finite.tiles === finite.n && finite.uniq === finite.n,
        '有限墙：只铺一份，每张预设只出现一次（不再循环）',
        `blocks=${finite.blocks} tiles=${finite.tiles} uniq=${finite.uniq} n=${finite.n}`);
    check(finite.P * finite.Q >= finite.n && finite.BW > finite.vw && finite.BH > finite.vh,
        '有限墙：沿用 9×10 网格，横竖都留出可拖余量',
        `P=${finite.P} Q=${finite.Q} BW=${finite.BW} vw=${finite.vw} BH=${finite.BH} vh=${finite.vh}`);
    check(Math.abs(finite.bottom.x - finite.top.x) > 100,
        '有限墙：左右能拖（不是死轴），且有硬边界',
        `x ${finite.top.x} → ${finite.bottom.x}`);
    check(Math.abs(finite.top.x - finite.expectTop.x) <= 1 && Math.abs(finite.top.y - finite.expectTop.y) <= 1,
        '有限墙：往左上拖到头就停（第一屏之外没有东西）',
        `offset=${finite.top.x},${finite.top.y} expect=${finite.expectTop.x},${finite.expectTop.y} railTop=${finite.topBar}`);
    check(Math.abs(finite.bottom.x - finite.expectBottom.x) <= 1
        && Math.abs(finite.bottom.y - finite.expectBottom.y) <= 1,
        '有限墙：往右下拖到底就停（不绕回开头）',
        `offset=${finite.bottom.x},${finite.bottom.y} expect=${finite.expectBottom.x},${finite.expectBottom.y}`);
    check(finite.sel0.r === 0 && finite.sel0.c === 0 && finite.selEdge.c === finite.P - 1,
        '有限墙：方向键到边停住（不循环）', JSON.stringify({ sel0: finite.sel0, selEdge: finite.selEdge, P: finite.P }));
    check(finite.railShown && finite.railHeight && parseFloat(finite.railHeight) < 100,
        '有限墙：右侧显示浏览进度条（能看出看了多少）',
        `shown=${finite.railShown} thumb=${finite.railHeight}`);
    check(finite.onBtn && !finite.infiniteBtn && finite.stored === 'finite',
        '切换按钮状态 + 选择被记住（localStorage）', `stored=${finite.stored}`);
    // 副标题要让人看出「到头就停，不会绕回开头」。文案会改（"有首有尾"→"有限边界"），
    // 断言语义而不是某一句原文，否则改个措辞就把用例打红。
    check(/有限边界|有首有尾|不循环|拖到头即止/.test(finite.sub), '副标题写明"不循环"', finite.sub);

    // 切回无限：必须恢复 4 份拷贝、回绕、进度条隐藏，并且不再重建（避免来回切抖动）
    const backToInfinite = await exec(`(async () => {
        const A = window.App;
        A.setWallMode('infinite');
        await new Promise((r) => setTimeout(r, 250));
        const g = document.getElementById('presetWallGrid');
        const b = A._wallBounds;
        A.panWallTo(-b.BW * 2 - 10, -b.BH * 2 - 10);
        const ox = A._wallOffsetX, oy = A._wallOffsetY;
        A._wallMode = null;                    // 模拟重启后从 localStorage 读回
        const restored = A.wallMode();
        return {
            tiles: g.querySelectorAll('.pw-tile').length,
            blocks: g.querySelectorAll('.pw-block').length,
            railShown: !document.getElementById('pwRail').hidden,
            wrapped: ox <= 0 && ox > -b.BW && oy <= 0 && oy > -b.BH,
            stored: localStorage.getItem('qfs_wall_mode'),
            restored,
            sub: document.getElementById('pwSub').textContent
        };
    })()`);
    check(backToInfinite.tiles === 360 && backToInfinite.blocks === 4,
        '切回无限墙：恢复 2×2 份拷贝（360 张）',
        `tiles=${backToInfinite.tiles} blocks=${backToInfinite.blocks}`);
    check(backToInfinite.wrapped && !backToInfinite.railShown,
        '切回无限墙：重新取模回绕、进度条隐藏', `wrapped=${backToInfinite.wrapped} rail=${backToInfinite.railShown}`);
    check(backToInfinite.stored === 'infinite' && backToInfinite.restored === 'infinite',
        '浏览方式重启后仍按上次选择恢复', `stored=${backToInfinite.stored} restored=${backToInfinite.restored}`);
    check(backToInfinite.sub.indexOf('按住拖动浏览') > 0, '无限墙副标题恢复原文案', backToInfinite.sub);

    // 2.68 自定义封面：userData/wall-covers/<预设名>.webp 覆盖内置封面，删掉即回落
    wallCovers = { '3D卡片': 'C:/Users/lumos/Pictures/我的封面.webp' };
    const coverOn = await exec(`(async () => {
        const applied = await App.refreshWallCovers(true);
        const tile = Array.from(document.querySelectorAll('.pw-tile'))
            .find((t) => t.querySelector('.pw-tile-name').textContent === '3D卡片');
        return { applied, src: tile.querySelector('.pw-tile-cover img').getAttribute('src'), cover: tile.dataset.cover };
    })()`);
    check(coverOn.src.indexOf('qflocal:') === 0 && decodeURIComponent(coverOn.src).indexOf('我的封面') >= 0,
        '自定义封面覆盖内置封面', coverOn.src.slice(0, 40) + '…');
    check(coverOn.src.indexOf('&v=') > 0,
        '自定义封面 URL 带版本号(同名文件替换不会命中旧缓存)', coverOn.src.slice(-16));

    // 编辑页侧栏：缩略图复用风格墙封面，名字照旧；没开自定义封面时用内置图。
    const sideCoverOn = await exec(`(() => {
        App.buildTree('');
        const item = Array.from(document.querySelectorAll('#presetTree .preset-item'))
            .find((x) => x.dataset.name === '3D卡片');
        const thumb = item && item.querySelector('.preset-thumb');
        const img = thumb && thumb.querySelector('img');
        const name = item && item.querySelector('.preset-name');
        return {
            img: !!(img && img.getAttribute('src')),
            src: img ? img.getAttribute('src') : '',
            name: name ? name.textContent : '',
        };
    })()`);
    check(!!sideCoverOn.img && /covers\/c\d+\.webp/.test(sideCoverOn.src) && sideCoverOn.name === '3D卡片',
        '编辑页侧栏显示封面缩略图与名字', JSON.stringify(sideCoverOn));

    wallCovers = {};
    const coverOff = await exec(`(async () => {
        await App.refreshWallCovers(true);
        const tile = Array.from(document.querySelectorAll('.pw-tile'))
            .find((t) => t.querySelector('.pw-tile-name').textContent === '3D卡片');
        return { src: tile.querySelector('.pw-tile-cover img').getAttribute('src'), cover: tile.dataset.cover };
    })()`);
    check(coverOff.src === coverOff.cover, '删掉自定义封面回落到内置封面', coverOff.src);

    // 2.7 真实输入回归（sendInputEvent 走完整命中测试 + pointer capture）
    //     合成的 tile.click() 会绕过 pointerdown/mousedown/capture，历史上正是这个盲区让
    //     「点一下整墙跳位」「拖完松手直接进编辑」两个 bug 全绿通过。这里必须用真实事件流。
    const centerTile = () => exec(`(() => {
        const g = document.getElementById('presetWallGrid');
        const r = g.getBoundingClientRect();
        const tiles = Array.from(g.querySelectorAll('.pw-tile'));
        let best = null, bd = Infinity;
        for (const t of tiles) {
            const b = t.getBoundingClientRect();
            const d = Math.hypot(b.left + b.width / 2 - (r.left + r.width / 2), b.top + b.height / 2 - (r.top + r.height / 2));
            if (d < bd) { bd = d; best = t; }
        }
        const bb = best.getBoundingClientRect();
        return { x: Math.round(bb.left + bb.width / 2), y: Math.round(bb.top + bb.height / 2) };
    })()`);
    const wallState = () => exec(`(() => {
        const g = document.getElementById('presetWallGrid');
        return { sx: g.scrollLeft, sy: g.scrollTop, ox: App._wallOffsetX, oy: App._wallOffsetY,
                 hidden: document.getElementById('presetWall').hidden };
    })()`);

    // 前面的拖动惯性可能还在滑，先停稳再量坐标——否则鼠标按下的那一刻卡片已经挪走，点击落到格间隙
    await exec('window.App.stopWallMotion(); true');
    await sleep(150);
    const p0 = await centerTile();
    const s0 = await wallState();
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p0.x, y: p0.y, button: 'left', clickCount: 1 });
    await sleep(60);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p0.x, y: p0.y, button: 'left', clickCount: 1 });
    await sleep(450);
    const s1 = await wallState();
    check(s1.sx === 0 && s1.sy === 0, '真实单击不产生滚动偏移（整墙不跳位）', `sx=${s1.sx} sy=${s1.sy}`);
    check(Math.abs(s1.ox - s0.ox) < 1 && Math.abs(s1.oy - s0.oy) < 1, '真实单击不改变墙偏移',
        `${Math.round(s1.ox - s0.ox)},${Math.round(s1.oy - s0.oy)}`);
    check(s1.hidden, '真实单击进入编辑（点击链路没被 capture 吞掉）');

    // 2.72 点选容差：按下后手抖 9px（已越过 7px 拖动阈值）也必须算点击。
    // 没有这条容差时，越过阈值会被判成拖动并吞掉 click，用户看到的就是"点模板没反应"。
    await exec('window.App.openPresetWall(); true');
    await sleep(500);
    const pj = await centerTile();
    win.webContents.sendInputEvent({ type: 'mouseDown', x: pj.x, y: pj.y, button: 'left', clickCount: 1 });
    await sleep(40);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: pj.x + 9, y: pj.y + 4, button: 'left', modifiers: ['leftButtonDown'] });
    await sleep(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: pj.x + 9, y: pj.y + 4, button: 'left', clickCount: 1 });
    await sleep(500);
    const sj = await wallState();
    check(sj.hidden, '按下时手抖 9px 仍算点击（进入编辑）', `hidden=${sj.hidden}`);

    await exec('window.App.openPresetWall(); true');
    await sleep(500);
    const p1 = await centerTile();
    const s2 = await wallState();
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p1.x, y: p1.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
        await sleep(20);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: p1.x - i * 40, y: p1.y - i * 15, button: 'left', modifiers: ['leftButtonDown'] });
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p1.x - 240, y: p1.y - 90, button: 'left', clickCount: 1 });
    await sleep(450);
    const s3 = await wallState();
    check(!s3.hidden, '真实拖动松手不会误进编辑');
    check(Math.abs(s3.ox - s2.ox) > 100, '真实拖动整墙跟手平移', `Δx=${Math.round(s3.ox - s2.ox)}`);
    check(s3.sx === 0 && s3.sy === 0, '拖动全程无滚动偏移', `sx=${s3.sx} sy=${s3.sy}`);

    // 2.72 那条手抖用例会进编辑器、把墙藏起来；惯性/滚轮必须在**墙可见**时测
    await exec('window.App.openPresetWall(); true');
    await sleep(600);

    // 2.8 手感参数（照抄 folia-major wallPanMotion）：松手惯性 + 滚轮平滑
    const coast = await exec(`(async () => {
        const g = document.getElementById('presetWallGrid');
        // CI 的 Windows runner 默认关掉了系统动画（prefers-reduced-motion: reduce），
        // 那会按设计禁掉惯性/平滑——这里必须显式要求"正常动效"再测手感。
        App._wallReduceOverride = false;
        App.stopWallMotion(); App.panWallTo(0, 0);
        // 先把上一段手势残留的 rAF 彻底停干净再开始，否则起手会被上一次惯性带偏
        await new Promise((x) => setTimeout(x, 120));
        // 诊断：确认 coastWall 到底有没有被调用、速度多少、是否被降动效吃掉
        let coastCalled = false, coastSpeed = 0;
        const origCoast = App.coastWall.bind(App);
        App.coastWall = function (vx, vy) { coastCalled = true; coastSpeed = Math.round(Math.hypot(vx, vy)); return origCoast(vx, vy); };
        const r = g.getBoundingClientRect();
        g.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 3, clientX: r.left + 700, clientY: r.top + 400, bubbles: true }));
        await new Promise((x) => setTimeout(x, 24));
        g.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: r.left + 440, clientY: r.top + 400, bubbles: true }));
        await new Promise((x) => setTimeout(x, 12));
        g.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, clientX: r.left + 440, clientY: r.top + 400, bubbles: true }));
        const atRelease = App._wallPan.x;
        // 轮询到"朝预期方向确实滑起来了"：慢帧下固定采样会误判，而残留的旧 rAF
        // 也可能先把 pan 推别的方向，所以判据必须是"比松手时更负"，不能只看"变了"。
        // 上限给到 2s：软件渲染（swiftshader）下首帧可能几百毫秒，卡片放大后更容易超时；
        // 正常环境第一轮就 break，不会拖慢用例。
        for (let i = 0; i < 100; i++) {
            await new Promise((x) => setTimeout(x, 20));
            if (App._wallPan.x < atRelease - 5) break;
        }
        const afterCoast = App._wallPan.x;
        App.stopWallMotion();
        App.coastWall = origCoast;
        App._wallReduceOverride = null;
        return { atRelease, afterCoast, coastCalled, coastSpeed, reduce: App.wallReducedMotion(),
                 hidden: document.getElementById('presetWall').hidden };
    })()`);
    check(coast.coastCalled && coast.afterCoast < coast.atRelease - 5, '松手后有惯性滑行（inertia）',
        `called=${coast.coastCalled} v=${coast.coastSpeed} ${Math.round(coast.atRelease)} → ${Math.round(coast.afterCoast)} reduce=${coast.reduce} hidden=${coast.hidden}`);

    const wheel = await exec(`(async () => {
        const g = document.getElementById('presetWallGrid');
        App._wallReduceOverride = false;   // 同上：滚轮的逐帧收敛只在正常动效下发生
        App.stopWallMotion(); App.panWallTo(0, 0);
        g.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true }));
        // 轮询等它动起来：固定 60ms 采样会被偶发的长帧挤掉，之前出现过 mid=0 的假红
        let mid = 0;
        for (let i = 0; i < 100; i++) {
            await new Promise((x) => setTimeout(x, 20));
            mid = App._wallPan.y;
            if (mid < -40) break;
        }
        // 等逐帧追到停（settled）而不是干等固定时长：τ=80ms 理论 500ms 量级就走完，
        // 但软件渲染下一次 rAF 可能几百毫秒，固定 700ms 会假红。settled 就立刻跳出。
        let end = App._wallPan.y, settled = false;
        for (let i = 0; i < 150; i++) {
            await new Promise((x) => setTimeout(x, 20));
            end = App._wallPan.y;
            settled = !App._wallWheelFrame && !App._wallWheelPending;
            if (settled) break;
        }
        App._wallReduceOverride = null;
        return { mid, end, settled };
    })()`);
    check(wheel.mid < -20, '滚轮能推墙（不再被 preventDefault 吞掉）', `mid=${Math.round(wheel.mid)}`);
    // 一格 100px 应当走满并停住。不再用「end 比 mid 再走 10px」——快帧下第一帧就到位，
    // mid 已经是 -100，那条反而会假红。
    check(wheel.end <= -95 && wheel.settled, '滚轮位移逐帧收敛并停住（走满一格后停住）',
        `${Math.round(wheel.mid)} → ${Math.round(wheel.end)} settled=${wheel.settled}`);

    // 2.9 降级动效（prefers-reduced-motion）：惯性/滚轮/入场全部退化，但功能仍可用
    const reduce = await exec(`(async () => {
        const g = document.getElementById('presetWallGrid');
        App._wallReduceOverride = true;
        App.stopWallMotion(); App.panWallTo(0, 0);
        const before = App._wallPan.y;
        App.coastWall(3200, 1100);
        await new Promise((r) => setTimeout(r, 220));
        const afterCoast = App._wallPan.y;
        g.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 30));
        const afterWheel = App._wallPan.y;
        App._wallReduceOverride = null;
        return { before, afterCoast, afterWheel };
    })()`);
    check(reduce.afterCoast === reduce.before, '降级动效：松手不滑行',
        `${reduce.before} → ${reduce.afterCoast}`);
    check(reduce.afterWheel <= reduce.afterCoast - 99, '降级动效：滚轮一帧到位（无逐帧追）',
        `y=${Math.round(reduce.afterWheel)}`);

    const anim = await exec(`(() => {
        App._wallReduceOverride = true;
        App.renderPresetWall();
        const reduced = (document.querySelector('.pw-wall') || {}).style ? document.querySelector('.pw-wall').style.animation : '';
        App._wallReduceOverride = false;   // 显式要求"正常动效"，别跟随 CI 的系统设置
        App.renderPresetWall();
        const normal = (document.querySelector('.pw-wall') || {}).style ? document.querySelector('.pw-wall').style.animation : '';
        App._wallReduceOverride = null;
        return { reduced: reduced || '', normal: normal || '' };
    })()`);
    check(anim.reduced === '' && anim.normal.indexOf('pwWallIn') >= 0, '降级动效：入场淡入被跳过',
        `reduced="${anim.reduced}" normal="${anim.normal}"`);

    // 3. 点击第一张卡片 → 进入编辑：墙隐藏、body.editing、sidebar 隐藏、模板已应用
    const enter = await exec(`(async () => {
      const App = window.App;
      const tile = document.querySelector('#presetWallGrid .pw-tile');
      const expectName = tile.querySelector('.pw-tile-name').textContent;
      tile.click();
      await new Promise((r) => setTimeout(r, 400));
      const w = document.getElementById('presetWall');
      const side = document.getElementById('sidebar');
      const cs = side ? getComputedStyle(side) : null;
      return {
        expectName,
        wallHidden: !!(w && w.hidden),
        editing: document.body.classList.contains('editing'),
        sidebarVisible: !!(cs && cs.display !== 'none'),
        pending: (App.pendingPreset && App.pendingPreset.templateName) || '',
        tplName: (App.template && (App.template.templateName || '')) || ''
      };
    })()`);
    check(enter.wallHidden, '点击卡片后预设墙隐藏');
    check(enter.editing, '进入编辑模式 body.editing');
    check(enter.sidebarVisible, '编辑模式左侧预设栏常驻可见（B1：墙只做首屏）');
    check(enter.pending === enter.expectName, '无照片时把墙选的风格记为待应用', `pending=${enter.pending}`);
    check(enter.tplName === enter.expectName, '模板已应用为所选预设', `${enter.tplName} vs ${enter.expectName}`);

    // 4. 工具栏「预设墙」按钮 → 返回墙
    const back = await exec(`(async () => {
      const btn = document.getElementById('btnBackWall');
      const visible = !!(btn && btn.offsetParent);
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      const w = document.getElementById('presetWall');
      return {
        btnVisible: visible,
        wallShown: !!(w && !w.hidden && w.getClientRects().length > 0),
        editing: document.body.classList.contains('editing'),
        selected: ((document.querySelector('#presetWallGrid .pw-tile.selected .pw-tile-name') || {}).textContent) || '',
        tpl: (window.App.template && window.App.template.templateName) || ''
      };
    })()`);
    check(back.btnVisible, '编辑模式工具栏显示「预设墙」按钮');
    check(back.wallShown, '点击后返回预设墙');
    check(!back.editing, '返回后移除 body.editing');
    check(back.selected && back.selected === back.tpl, '回墙自动选中当前图的预设并居中',
        `selected=${back.selected} tpl=${back.tpl}`);

    // 5. 跳过入口：pwSkip → 进工作台（不应用新模板、sidebar 隐藏）
    const skip = await exec(`(async () => {
      const tplBefore = window.App.template ? (window.App.template.templateName || '') : '';
      document.getElementById('pwSkip').click();
      await new Promise((r) => setTimeout(r, 200));
      const w = document.getElementById('presetWall');
      return {
        wallHidden: !!(w && w.hidden),
        editing: document.body.classList.contains('editing'),
        tplBefore,
        tplAfter: window.App.template ? (window.App.template.templateName || '') : ''
      };
    })()`);
    check(skip.wallHidden, '「进入工作台」隐藏预设墙');
    check(skip.editing, '进入工作台后 body.editing');
    check(skip.tplAfter === skip.tplBefore, '跳过不改变当前模板', `${skip.tplBefore} → ${skip.tplAfter}`);

    // 6. 空态从墙里选好预设后点「示例图」：示例图必须直接带上该预设，
    //    不能因为示例图没有历史模板就回退到 defaultTemplate()。
    const sample = await exec(`(async () => {
        const App = window.App;
        const expected = (App.template && App.template.templateName) || '';
        const before = App.images.length;
        await App.loadSamplePhoto();
        await new Promise((r) => setTimeout(r, 100));
        const im = App.image;
        const tpl = im && App.getTpl(im);
        return {
            expected,
            before,
            after: App.images.length,
            name: (im && im.name) || '',
            isSample: !!(im && im.sample),
            tplName: (tpl && tpl.templateName) || '',
            live: (App.template && App.template.templateName) || '',
            pending: (App.pendingPreset && App.pendingPreset.templateName) || ''
        };
    })()`);
    check(sample.after === sample.before + 1 && sample.isSample && sample.name === '示例照片',
        '示例图进入胶片条并成为当前图', JSON.stringify(sample));
    check(!!sample.expected && sample.tplName === sample.expected && sample.live === sample.expected,
        '示例图沿用墙里选好的预设（不是原图默认模板）',
        `expected=${sample.expected} tpl=${sample.tplName} live=${sample.live}`);
    check(!sample.pending, '示例图落盘后清掉 pendingPreset');

    // 7. 导入自己的照片后，示例图必须自动移除
    const auto = await exec(`(async () => {
        const A = window.App;
        const mkEl = async (color) => {
            const c = document.createElement('canvas');
            c.width = 120; c.height = 80;
            const g = c.getContext('2d');
            g.fillStyle = color; g.fillRect(0, 0, 120, 80);
            const el = new Image();
            await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
            return el;
        };
        const mkOwn = async (name, color) => {
            const el = await mkEl(color);
            const im = { el, name, path: 'test://' + name, w: 120, h: 80, exif: {}, customSettings: null };
            A.queueThumb(im);
            return im;
        };
        const orig = A.imageFromPick;
        try {
            A.imageFromPick = async (item) => await mkOwn((item && item.name) || '自己的照片.png', '#2f8');
            A._draftDirty = false;
            await A.importPicked([{ name: '自己的照片.png' }], 0);
            const afterImport = {
                names: A.images.map((im) => im.name),
                samples: A.images.filter((im) => im && im.sample).length,
                current: (A.image && A.image.name) || '',
                tpl: (A.template && A.template.templateName) || ''
            };

            // 单张追加：模拟“导入照片”按钮的 append 路径
            const sampleEl = await mkEl('#777');
            const fakeSample = {
                el: sampleEl, name: '示例照片', path: null, sample: true,
                w: 120, h: 80, exif: {}, customSettings: null
            };
            A.images = [fakeSample];
            A.image = fakeSample;
            A.currentIdx = 0;
            A.template = A.defaultTemplate();
            A.buildThumbnails();
            const appendIdx = await A.appendImageFromPick({ name: '追加照片.png' });
            A.selectImage(appendIdx);
            const afterAppend = {
                names: A.images.map((im) => im.name),
                samples: A.images.filter((im) => im && im.sample).length,
                idx: appendIdx,
                current: (A.image && A.image.name) || ''
            };
            return { afterImport, afterAppend };
        } finally {
            A.imageFromPick = orig;
        }
    })()`);
    check(auto.afterImport.names.length === 1 && auto.afterImport.names[0] === '自己的照片.png'
        && auto.afterImport.samples === 0 && auto.afterImport.current === '自己的照片.png',
        '多选/拖拽导入后示例图自动移除', JSON.stringify(auto.afterImport));
    check(auto.afterImport.tpl === sample.expected,
        '移除示例图后仍沿用示例图上的预设', `expected=${sample.expected} tpl=${auto.afterImport.tpl}`);
    check(auto.afterAppend.names.length === 1 && auto.afterAppend.names[0] === '追加照片.png'
        && auto.afterAppend.samples === 0 && auto.afterAppend.idx === 0 && auto.afterAppend.current === '追加照片.png',
        '单张追加导入后示例图自动移除', JSON.stringify(auto.afterAppend));

    // 8. 拼图中导入：示例图退出，槽位转给新图，不留下空格
    openImageResult = { name: '插入照片.png', path: 'test://insert.png' };
    const puzzleInsert = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas');
        c.width = 120; c.height = 80;
        const g = c.getContext('2d');
        g.fillStyle = '#36c'; g.fillRect(0, 0, 120, 80);
        const ownEl = new Image();
        await new Promise((r) => { ownEl.onload = r; ownEl.onerror = r; ownEl.src = c.toDataURL('image/png'); });
        const own = { el: ownEl, name: '插入照片.png', path: 'test://insert.png', w: 120, h: 80, exif: {}, customSettings: null };
        const sampleEl = new Image();
        sampleEl.src = c.toDataURL('image/png');
        await new Promise((r) => { sampleEl.onload = r; sampleEl.onerror = r; });
        const fakeSample = { el: sampleEl, name: '示例照片', path: null, sample: true, w: 120, h: 80, exif: {}, customSettings: null };
        const tpl = A.defaultTemplate();
        tpl.puzzle.enabled = 1;
        tpl.puzzle.layout = 'single';
        tpl.puzzle.layoutType = 0;
        tpl.puzzle.slots = { 0: { imageIndex: 0 } };
        A.images = [fakeSample];
        A.image = fakeSample;
        A.currentIdx = 0;
        A.template = JSON.parse(JSON.stringify(tpl));
        A.setTpl(fakeSample, A.template);
        A.buildThumbnails();
        const orig = A.imageFromPick;
        A.imageFromPick = async () => { A.queueThumb(own); return own; };
        try {
            await A.insertImageFromPick(0);
        } finally {
            A.imageFromPick = orig;
        }
        return {
            names: A.images.map((im) => im.name),
            samples: A.images.filter((im) => im && im.sample).length,
            current: (A.image && A.image.name) || '',
            puzzle: !!(A.tplPuzzle && A.tplPuzzle()),
            slot0: (A.template && A.template.puzzle && A.template.puzzle.slots[0])
                ? A.template.puzzle.slots[0].imageIndex : null
        };
    })()`);
    openImageResult = CANCEL();
    check(puzzleInsert.names.length === 1 && puzzleInsert.names[0] === '插入照片.png'
        && puzzleInsert.samples === 0 && puzzleInsert.current === '插入照片.png',
        '拼图中插入照片后示例图自动移除', JSON.stringify(puzzleInsert));
    check(puzzleInsert.puzzle && puzzleInsert.slot0 === 0,
        '示例图的拼图槽位转给新图（不再是空槽）', JSON.stringify(puzzleInsert));

    // 9. 双击拼图槽位换图：示例图退出，槽位落到新图
    openImageResult = { name: '换槽照片.png', path: 'test://slot.png' };
    const slotReplace = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas');
        c.width = 120; c.height = 80;
        const g = c.getContext('2d');
        g.fillStyle = '#c63'; g.fillRect(0, 0, 120, 80);
        const ownEl = new Image();
        await new Promise((r) => { ownEl.onload = r; ownEl.onerror = r; ownEl.src = c.toDataURL('image/png'); });
        const own = { el: ownEl, name: '换槽照片.png', path: 'test://slot.png', w: 120, h: 80, exif: {}, customSettings: null };
        const sampleEl = new Image();
        sampleEl.src = c.toDataURL('image/png');
        await new Promise((r) => { sampleEl.onload = r; sampleEl.onerror = r; });
        const fakeSample = { el: sampleEl, name: '示例照片', path: null, sample: true, w: 120, h: 80, exif: {}, customSettings: null };
        const tpl = A.defaultTemplate();
        tpl.puzzle.enabled = 1;
        tpl.puzzle.layout = 'single';
        tpl.puzzle.layoutType = 0;
        tpl.puzzle.slots = { 0: { imageIndex: 0 } };
        A.images = [fakeSample];
        A.image = fakeSample;
        A.currentIdx = 0;
        A.template = JSON.parse(JSON.stringify(tpl));
        A.setTpl(fakeSample, A.template);
        A.buildThumbnails();
        const orig = A.imageFromPick;
        A.imageFromPick = async () => { A.queueThumb(own); return own; };
        try {
            await A.openSlotImage(0);
        } finally {
            A.imageFromPick = orig;
        }
        return {
            names: A.images.map((im) => im.name),
            samples: A.images.filter((im) => im && im.sample).length,
            current: (A.image && A.image.name) || '',
            puzzle: !!(A.tplPuzzle && A.tplPuzzle()),
            slot0: (A.template && A.template.puzzle && A.template.puzzle.slots[0])
                ? A.template.puzzle.slots[0].imageIndex : null
        };
    })()`);
    openImageResult = CANCEL();
    check(slotReplace.names.length === 1 && slotReplace.names[0] === '换槽照片.png'
        && slotReplace.samples === 0 && slotReplace.current === '换槽照片.png',
        '拼图槽位换图后示例图自动移除', JSON.stringify(slotReplace));
    check(slotReplace.puzzle && slotReplace.slot0 === 0,
        '双击槽位换图后拼图槽位指向新图', JSON.stringify(slotReplace));

    console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
});

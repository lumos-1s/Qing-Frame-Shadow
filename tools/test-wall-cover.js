// 预设墙「换封面」交互回归：
//   ① 每张卡带入口按钮，默认隐身且不可点（避免误触）
//   ② 顶部「换封面」进入封面编辑模式：按钮常显、点卡片任意位置都能换、Esc/「完成」退出
//   ③ 选图后自动按预设名落盘（不用手动命名），同预设的 4 份拷贝一起刷新并描金
//   ④ 右键菜单按「有没有自定义封面」给出「恢复默认封面」
//   ⑤ 恢复默认后回落到内置封面
//   ⑥ 切换「无限/有限」重建卡片后，自定义封面不能丢
// 用法：node tools/run-electron.js tools/test-wall-cover.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROFILE = path.join(__dirname, '..', '.tmp', 'test-wall-cover-' + Date.now());
fs.mkdirSync(PROFILE, { recursive: true });
app.setPath('userData', PROFILE);
const PHOTO = path.join(ROOT, 'shared', 'textures', 'denim.png');

require('../src/main/index.js');

let pass = 0, fail = 0;
const check = (ok, label, detail) => {
    if (ok) { pass++; console.log('PASS  ' + label + (detail ? ' | ' + detail : '')); }
    else { fail++; console.log('FAIL  ' + label + (detail ? ' | ' + detail : '')); }
};

async function main() {
    await app.whenReady();
    let win = null;
    for (let i = 0; i < 40 && !win; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (!win) await sleep(500); }
    for (let i = 0; i < 60 && win.webContents.isLoading(); i++) await sleep(500);
    await sleep(1800);
    win.show(); win.focus();
    await sleep(600);

    const out = await win.webContents.executeJavaScript(`(async () => {
        const A = window.App;
        const go = document.getElementById('btnIntroDone');
        if (go) go.click();
        await new Promise(r => setTimeout(r, 600));
        const r = {};
        const btn = document.getElementById('pwCovers');
        const grid = document.getElementById('presetWallGrid');
        const pickTile = () => [...document.querySelectorAll('.pw-tile')].find((x) => {
            const b = x.getBoundingClientRect();
            return b.left > 80 && b.top > 80 && b.right < innerWidth - 80 && b.bottom < innerHeight - 80;
        });
        const tile = pickTile();
        r.tileCount = document.querySelectorAll('.pw-tile').length;
        r.btnCount = document.querySelectorAll('.pw-tile-coverbtn').length;

        // ① 默认态
        const cb = tile.querySelector('.pw-tile-coverbtn');
        const st = getComputedStyle(cb);
        r.idle = { opacity: st.opacity, pe: st.pointerEvents, tabIndex: cb.tabIndex, text: cb.textContent };
        r.idleTitle = btn.title;

        // ② 进入封面模式
        btn.click();
        await new Promise(r => setTimeout(r, 350));
        r.modeOn = {
            text: btn.textContent,
            cls: grid.classList.contains('pw-cover-mode'),
            pressed: btn.getAttribute('aria-pressed'),
            title: btn.title,
            opacity: getComputedStyle(cb).opacity,
            pe: getComputedStyle(cb).pointerEvents,
        };

        // ③ 模式内点卡片空白 → 换封面（桩掉方法，避免真的弹选图框）
        let picked = null, entered = null;
        const oPick = A.pickWallCoverFor, oEnter = A.enterEditorFromWall;
        A.pickWallCoverFor = (t) => { picked = A.wallTileName(t); return Promise.resolve(); };
        A.enterEditorFromWall = (i) => { entered = i; };
        const grid2 = document.getElementById('presetWallGrid');
        const b = tile.getBoundingClientRect();
        const cx = Math.round(b.left + 18), cy = Math.round(b.top + 18);
        const PE = (type) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 21,
            pointerType: 'mouse', isPrimary: true, clientX: cx, clientY: cy,
            button: 0, buttons: type === 'pointerup' ? 0 : 1 });
        grid2.dispatchEvent(PE('pointerdown'));
        await new Promise(r => setTimeout(r, 25));
        grid2.dispatchEvent(PE('pointerup'));
        await new Promise(r => setTimeout(r, 220));
        r.modeClick = { picked, entered, stillWall: !document.getElementById('presetWall').hidden };

        // ④ Esc 退出
        grid2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 260));
        r.afterEsc = { text: btn.textContent, cls: grid.classList.contains('pw-cover-mode'), opacity: getComputedStyle(cb).opacity };

        // ⑤ 真实换封面（注入路径，跳过系统选图框）——先把方法恢复回来
        A.pickWallCoverFor = oPick;
        A.enterEditorFromWall = oEnter;
        const name = A.wallTileName(tile);
        r.name = name;
        const before = tile.querySelector('.pw-tile-cover img').getAttribute('src');
        await A.pickWallCoverFor(tile, ${JSON.stringify(PHOTO)});
        await new Promise(r => setTimeout(r, 700));
        const same = [...document.querySelectorAll('.pw-tile')].filter(t => A.wallTileName(t) === name);
        r.afterPick = {
            sameName: same.length,
            marked: same.filter(t => t.dataset.customCover === '1').length,
            srcChanged: same[0].querySelector('img').getAttribute('src') !== before,
            isLocal: String(same[0].querySelector('img').getAttribute('src')).startsWith('qflocal://'),
            status: document.getElementById('stCanvas').textContent,
            files: Object.keys(await window.qingframe.listWallCovers() || {}),
        };

        // ⑥ 右键菜单（有自定义）
        A.openWallCoverMenu(same[0], 400, 320);
        await new Promise(r => setTimeout(r, 140));
        r.menuCustom = [...document.querySelectorAll('.ctx-menu button')].map(x => x.textContent);
        A.closeCtx();

        // ⑥b 重复扫描不能换 URL：版本号曾经取「每次扫描的时间戳」，于是开墙 /
        //     窗口聚焦 / 切模式都会把自定义封面重新读盘解码一遍，卡片肉眼可见地闪。
        //     现在版本号取自文件 mtime，文件没动 URL 就必须稳定。
        const srcNow = () => { const t = [...document.querySelectorAll('.pw-tile')].find(x => x.dataset.customCover === '1');
            return t ? t.querySelector('img').getAttribute('src') : null; };
        const v0 = srcNow();
        await A.refreshWallCovers(true);
        await new Promise(r => setTimeout(r, 300));
        const v1 = srcNow();
        await A.refreshWallCovers(true);
        await new Promise(r => setTimeout(r, 300));
        r.versionStable = { same: v0 === srcNow() && v0 === v1, v0: String(v0).slice(-14) };

        // ⑦ 切换有限墙（重建 360 张卡）后封面要还在
        A.setWallMode('finite');
        await new Promise(r => setTimeout(r, 900));
        const afterMode = [...document.querySelectorAll('.pw-tile')].filter(t => A.wallTileName(t) === name);
        r.afterModeSwitch = {
            tiles: document.querySelectorAll('.pw-tile').length,
            sameName: afterMode.length,
            stillLocal: afterMode.length ? String(afterMode[0].querySelector('img').getAttribute('src')).startsWith('qflocal://') : false,
            marked: afterMode.length ? afterMode[0].dataset.customCover === '1' : false,
        };
        A.setWallMode('infinite');
        await new Promise(r => setTimeout(r, 900));

        // ⑧ 恢复默认
        const cur = [...document.querySelectorAll('.pw-tile')].filter(t => A.wallTileName(t) === name)[0];
        await A.clearWallCoverFor(cur);
        await new Promise(r => setTimeout(r, 700));
        const back = [...document.querySelectorAll('.pw-tile')].filter(t => A.wallTileName(t) === name)[0];
        r.afterClear = {
            marked: back.dataset.customCover === '1',
            isBuiltin: String(back.querySelector('.pw-tile-cover img').getAttribute('src')).includes('assets/preset-wall'),
            status: document.getElementById('stCanvas').textContent,
        };
        A.openWallCoverMenu(back, 400, 320);
        await new Promise(r => setTimeout(r, 140));
        r.menuNoCustom = [...document.querySelectorAll('.ctx-menu button')].map(x => x.textContent);
        A.closeCtx();

        // 菜单点空白处要自己收起，别一直浮着挡卡片
        A.openWallCoverMenu(back, 300, 300);
        await new Promise(r => setTimeout(r, 120));
        const openedBefore = !!document.querySelector('.ctx-menu');
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await new Promise(r => setTimeout(r, 120));
        r.menuDismiss = { opened: openedBefore, closed: !document.querySelector('.ctx-menu') };

        // ⑨ 把图片拖到卡片上：整卡高亮提示"松手就换这张"
        const t2 = pickTile();
        const dt = new DataTransfer();
        t2.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        r.dropOn = t2.classList.contains('pw-drop-target');
        t2.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
        r.dropOff = !t2.classList.contains('pw-drop-target');
        A.pickWallCoverFor = oPick; A.enterEditorFromWall = oEnter;
        return r;
    })()`);

    // ⑩ 真实右键：必须过 mousedown → contextmenu 这条链（之前 mousedown 无差别
    //    preventDefault，把 contextmenu 一起吃掉，右键菜单根本弹不出来）
    const hit = await win.webContents.executeJavaScript(`(() => {
        const t = [...document.querySelectorAll('.pw-tile')].find((x) => {
            const b = x.getBoundingClientRect();
            return b.left > 80 && b.top > 80 && b.right < innerWidth - 80 && b.bottom < innerHeight - 80;
        });
        if (!t) return null;
        const b = t.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    if (hit) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: hit.x, y: hit.y });
        await sleep(200);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: hit.x, y: hit.y, button: 'right', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: hit.x, y: hit.y, button: 'right', clickCount: 1 });
        await sleep(500);
        out.realCtx = await win.webContents.executeJavaScript(`(() => {
            const m = document.querySelector('.ctx-menu');
            const items = m ? [...m.querySelectorAll('button')].map((b) => b.textContent) : null;
            if (window.App && window.App.closeCtx) window.App.closeCtx();
            return { opened: !!m, items };
        })()`);
    }

    check(out.tileCount > 0 && out.btnCount === out.tileCount, '每张卡片都有换封面入口', out.btnCount + '/' + out.tileCount);
    check(out.idle.opacity === '0' && out.idle.pe === 'none', '默认隐身且不抢点击', JSON.stringify(out.idle));
    check(out.idle.tabIndex === -1, '按钮不进 Tab 焦点序（360 张卡不会各多一个焦点）', String(out.idle.tabIndex));
    check(out.modeOn.text === '完成' && out.modeOn.cls === true && out.modeOn.pressed === 'true', '顶部「换封面」进入封面模式', JSON.stringify(out.modeOn));
    check(out.modeOn.opacity === '1' && out.modeOn.pe === 'auto', '模式内入口常显可点');
    check(out.modeOn.text === '完成' && /换封面/.test(out.idleTitle || ''), '进入封面模式后按钮变为「完成」', JSON.stringify({ on: out.modeOn.text, idle: out.idleTitle }));
    check(out.modeClick.picked === out.name && out.modeClick.entered === null && out.modeClick.stillWall, '模式内点卡片 = 换封面（不会误进编辑器）', JSON.stringify(out.modeClick));
    check(out.afterEsc.text === '换封面' && out.afterEsc.cls === false && out.afterEsc.opacity === '0', 'Esc 退出模式并复原', JSON.stringify(out.afterEsc));
    check(out.afterPick.sameName >= 1 && out.afterPick.marked === out.afterPick.sameName, '同一预设的所有拷贝一起换上自定义封面', out.afterPick.marked + '/' + out.afterPick.sameName);
    check(out.afterPick.srcChanged && out.afterPick.isLocal, '卡片立刻指向新封面（带版本号绕开缓存）', out.afterPick.status);
    check(out.afterPick.files.length === 1 && out.afterPick.files[0] === out.name, '按预设名自动落盘，无需手动命名', out.afterPick.files.join(','));
    check(out.menuCustom.includes('更换封面…') && out.menuCustom.includes('恢复默认封面'), '右键菜单：有自定义封面时可恢复默认', out.menuCustom.join(' / '));
    check(!!(out.realCtx && out.realCtx.opened) && (out.realCtx.items || []).includes('更换封面…'),
        '真实右键能弹出菜单（mousedown 不能吞掉 contextmenu）', JSON.stringify(out.realCtx));
    check(out.versionStable && out.versionStable.same, '重复扫描不换封面 URL（不重复解码）', JSON.stringify(out.versionStable));
    check(out.afterModeSwitch.stillLocal && out.afterModeSwitch.marked, '无限/有限切换重建卡片后封面不丢', JSON.stringify(out.afterModeSwitch));
    check(!out.afterClear.marked && out.afterClear.isBuiltin, '恢复默认后回落内置封面', JSON.stringify(out.afterClear));
    check(!out.menuNoCustom.includes('恢复默认封面'), '没有自定义封面时不显示「恢复默认」', out.menuNoCustom.join(' / '));
    check(out.dropOn && out.dropOff, '拖图到卡片有明确高亮，离开即撤', JSON.stringify({ on: out.dropOn, off: out.dropOff }));
    check(out.menuDismiss.opened && out.menuDismiss.closed, '点空白处菜单自动收起', JSON.stringify(out.menuDismiss));

    console.log('\n' + (fail ? 'FAILED ' + fail : 'ALL PASS') + '  (' + pass + ' passed)');
    await win.close();
    app.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FAIL', e && e.message); app.exit(1); });

// 样式私有参数骨架回归（纯 node,不起 Electron）。
//   node tools/test-style-params.js
//
// 锁死三件最容易悄悄坏掉的事:
//   ① apply(def) === legacy —— 默认值必须就是引擎原来的字面量,否则「零回归」只是口头约定
//   ② 声明表与 engine-styles.js 里的 spNum 缺省值不能各走各的（防漂移）
//   ③ 缺省 null / 复位 delete / 存量字段留在模板根 / 新字段进命名空间
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SP = require(path.join(ROOT, 'src', 'renderer', 'js', 'style-params.js'));
const engineSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'engine-styles.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'app.js'), 'utf8');

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
}

/* ① 默认值语义 */
const badDefaults = SP.defaultsOk();
check(badDefaults.length === 0, '① 每个参数的 apply(def) 严格等于引擎 legacy', badDefaults.join('; ') || '全部对齐');

/* ② 声明表 ↔ 引擎字面量（静态提取 spNum('key', legacy)） */
const legacyMap = {};
for (const m of engineSrc.matchAll(/spNum\('([A-Za-z]\w*)',\s*([\d.]+)\)/g)) legacyMap[m[1]] = Number(m[2]);
const card = SP.forStyle('CARD_3D');
check(card.length > 0 && Object.keys(legacyMap).length === card.length,
    '② 引擎 spNum 缺省项数量与声明表一致', `表 ${card.length} / 引擎 ${Object.keys(legacyMap).length}`);
for (const p of card) {
    check(legacyMap[p.key] === p.legacy,
        `② CARD_3D.${p.key} 引擎字面量未漂移`, `legacy=${p.legacy} engine=${legacyMap[p.key]}`);
}

/* ③ 表结构 */
const all = [];
for (const style of Object.keys(SP.TABLE)) for (const p of SP.TABLE[style]) all.push([style, p]);
check(all.every(([, p]) => p.key && p.label && typeof p.def === 'number'
    && p.min < p.max && p.step > 0 && typeof p.legacy === 'number'
    && typeof p.apply === 'function' && (p.path === 'root' || p.path === 'style')),
    '③ 每条声明字段齐全、范围合法、路径只有 root/style', `共 ${all.length} 条`);
check(all.filter(([, p]) => p.path === 'root').every(([, p]) => p.row && p.slider && p.valueLabel),
    '③ 存量 root 项都带手写 DOM 的 row/slider/label id');
check(SP.forStyle('BLUR_DATE') === SP.forStyle('BLUR_CLASSIC'),
    '③ BLUR_DATE 与 BLUR_CLASSIC 共用同一组声明');
check(!SP.has('NONE') && !SP.has('POLAROID'), '③ 未声明的样式返回空数组');

/* ④ 读写与零回归 */
const t = { photoFrameStyle: 'CARD_3D' };
const pPad = card.find((p) => p.key === 'padX');
check(SP.get(t, 'CARD_3D', pPad) === 18 && t.styleParams === undefined,
    '④ 缺省读 def,且绝不往模板里写字段');
SP.set(t, 'CARD_3D', pPad, 30);
check(t.styleParams && t.styleParams.CARD_3D.padX === 30,
    '④ set 写进 t.styleParams[STYLE][key] 命名空间');
check(SP.engineValue(pPad, SP.get(t, 'CARD_3D', pPad)) === 0.3,
    '④ 引擎量换算 = UI 值 / 100');
SP.reset(t, 'CARD_3D');
check(t.styleParams === undefined && t.padX === undefined,
    '④ reset 用 delete,连空的命名空间一起收掉');

const b = { photoFrameStyle: 'BLUR_CLASSIC', blurBackdropDim: 65 };
const pDim = SP.forStyle('BLUR_CLASSIC').find((p) => p.key === 'blurBackdropDim');
check(SP.get(b, 'BLUR_CLASSIC', pDim) === 65, '④ 存量 root 字段仍从模板根读（旧工程不丢参数）');
SP.set(b, 'BLUR_CLASSIC', pDim, 20);
check(b.blurBackdropDim === 20 && b.styleParams === undefined,
    '④ root 项 set 不新建 styleParams');
SP.reset(b, 'BLUR_CLASSIC');
check(b.blurBackdropDim === undefined, '④ root 项 reset 也是 delete');
check(SP.clamp(pDim, 999) === 80 && SP.clamp(pDim, -5) === 0, '④ clamp 把越界值夹回声明范围');

/* ⑤ 接线:脚本 / 容器 / 散抄已收口 */
check(html.includes('js/style-params.js') && html.includes('js/app-style-params.js'),
    '⑤ index.html 按序加载声明表与 UI 模块');
check(html.includes('id="grpStyleParams"') && html.includes('id="styleParamsRows"'),
    '⑤ 样式参数容器与动态行挂载点存在');
check(!appSrc.includes('BLUR_ADV_CONTROLS'),
    '⑤ app.js 里手写的六元组数组已删除');
check(appSrc.includes('QfsStyleParamsUI.bind') && appSrc.includes('QfsStyleParamsUI.refresh')
    && appSrc.includes('QfsStyleParamsUI.updateVisibility') && appSrc.includes('QfsStyleParamsUI.reset'),
    '⑤ app.js 四处散抄已改为调用统一绑定器');
check(engineSrc.includes('styleParams: (t.styleParams'),
    '⑤ buildState 把命名空间挂进渲染状态 S');

console.log('─'.repeat(72));
if (failures.length) {
    console.log(`✖ ${failures.length} 项未通过:`);
    failures.forEach((f) => console.log('   - ' + f));
    process.exit(1);
}
console.log('✓ 样式参数骨架全部通过');
process.exit(0);

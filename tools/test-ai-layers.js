// AI 自由图层渲染器单测：图元规范化 + 渲染调用（mock context，不依赖浏览器）。
// 用法: node tools/test-ai-layers.js
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-ai-layers.js'));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};

// 1) 支持 5 种图元
check(L.TYPES.join(',') === 'rect,circle,line,text,image', '支持 rect/circle/line/text/image', L.TYPES.join(','));

// 2) normalize 过滤非法类型、保留合法
check(L.normalize({ type: 'rect', x: 0.1, w: 0.5 }) !== null, '合法 rect 通过');
check(L.normalize({ type: 'triangle' }) === null, '非法图元被过滤');
check(L.normalize(null) === null, 'null 被过滤');
check(L.normalize({ type: 'rect', x: 'abc' }).x === 0, '非数字坐标归零');

// 3) withAlpha 把 hex 转成 rgba
check(L.withAlpha('#ff0000', 0.5) === 'rgba(255,0,0,0.5)', 'hex+alpha → rgba', L.withAlpha('#ff0000', 0.5));
check(L.withAlpha('#0f0', 1) === 'rgba(0,255,0,1)', '短 hex 支持', L.withAlpha('#0f0', 1));

// 4) 渲染：mock ctx 记录调用，验证每种图元都真的画了
function mockCtx() {
    const calls = [];
    const noop = (name) => (...a) => calls.push([name, ...a]);
    const ctx = {
        calls, save: noop('save'), restore: noop('restore'), beginPath: noop('beginPath'),
        moveTo: noop('moveTo'), lineTo: noop('lineTo'), arc: noop('arc'), fill: noop('fill'),
        stroke: noop('stroke'), clip: noop('clip'), fillText: noop('fillText'),
        drawImage: noop('drawImage'), setLineDash: noop('setLineDash'),
        rect: noop('rect'), roundRect: noop('roundRect')
    };
    ctx.fillStyle = ''; ctx.strokeStyle = ''; ctx.lineWidth = 0; ctx.font = ''; ctx.textAlign = '';
    return ctx;
}
const ctx = mockCtx();
L.render(ctx, [
    { type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.8, fill: '#ffffff' },
    { type: 'circle', cx: 0.5, cy: 0.3, r: 0.1, fill: '#123456' },
    { type: 'line', x1: 0, y1: 0.5, x2: 1, y2: 0.5, color: '#000000', width: 2 },
    { type: 'text', x: 0.5, y: 0.9, text: '你好', size: 0.05, color: '#ffffff' }
], 1000, 1200);
const fillCount = ctx.calls.filter((c) => c[0] === 'fill').length;
const strokeCount = ctx.calls.filter((c) => c[0] === 'stroke').length;
const hasText = ctx.calls.some((c) => c[0] === 'fillText' && c[1] === '你好');
check(fillCount >= 2, 'rect + circle 都执行了 fill', 'fill=' + fillCount);
check(strokeCount >= 1, 'line 执行了 stroke', 'stroke=' + strokeCount);
check(hasText, 'text 绘制了内容', String(hasText));

// 5) 非法图层不崩溃
let threw = false;
try { L.render(mockCtx(), [{ type: 'bogus' }, null, { type: 'rect', w: 0 }], 100, 100); } catch (e) { threw = true; }
check(!threw, '非法/空图层不抛异常', String(threw));

console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;

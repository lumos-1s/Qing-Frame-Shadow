// AI 自由图层渲染器单测：图元规范化 + 渲染调用 + 照片槽位尺寸（mock context，不依赖浏览器）。
// 用法: node tools/test-ai-layers.js
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-ai-layers.js'));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};

// 1) 支持 6 种图元（photo 是照片槽位，不直接绘制）
check(L.TYPES.join(',') === 'rect,circle,line,text,image,photo', '支持 rect/circle/line/text/image/photo', L.TYPES.join(','));

// 2) normalize 过滤非法类型、保留合法
check(L.normalize({ type: 'rect', x: 0.1, w: 0.5 }) !== null, '合法 rect 通过');
check(L.normalize({ type: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 0.8 }) !== null, '合法 photo 槽位通过');
check(L.normalize({ type: 'triangle' }) === null, '非法图元被过滤');
check(L.normalize(null) === null, 'null 被过滤');
check(L.normalize({ type: 'rect', x: 'abc' }).x === 0, '非数字坐标归零');

// 3) withAlpha：hex / rgba / 8 位 hex 都要认，未知格式不画黑
check(L.withAlpha('#ff0000', 0.5) === 'rgba(255,0,0,0.5)', 'hex+alpha → rgba', L.withAlpha('#ff0000', 0.5));
check(L.withAlpha('#0f0', 1) === 'rgba(0,255,0,1)', '短 hex 支持', L.withAlpha('#0f0', 1));
check(L.withAlpha('rgba(255, 0, 0, 0.5)', 1) === 'rgba(255,0,0,0.5)', 'rgba() 原样解析', L.withAlpha('rgba(255, 0, 0, 0.5)', 1));
check(L.withAlpha('rgba(255,0,0,0.5)', 0.5) === 'rgba(255,0,0,0.25)', 'rgba() 透明度相乘', L.withAlpha('rgba(255,0,0,0.5)', 0.5));
check(/^rgba\(255,0,0,0\.50/.test(L.withAlpha('#ff000080', 1)), '8 位 hex 支持', L.withAlpha('#ff000080', 1));
check(L.withAlpha('red', 0.5) === 'red', '未知格式原样返回（不画黑）', L.withAlpha('red', 0.5));

// 4) 渲染：mock ctx 记录调用，验证每种图元都真的画了；photo 不直接画
function mockCtx() {
    const calls = [];
    const noop = (name) => (...a) => calls.push([name, ...a]);
    const ctx = {
        calls, save: noop('save'), restore: noop('restore'), beginPath: noop('beginPath'),
        moveTo: noop('moveTo'), lineTo: noop('lineTo'), arc: noop('arc'), fill: noop('fill'),
        stroke: noop('stroke'), clip: noop('clip'), fillText: noop('fillText'),
        drawImage: noop('drawImage'), setLineDash: noop('setLineDash'),
        rect: noop('rect'), roundRect: noop('roundRect'),
        measureText: (s) => ({ width: String(s).length * 10 }),
        font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
        textAlign: '', textBaseline: '', globalAlpha: 1,
        shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0
    };
    return ctx;
}
const ctx = mockCtx();
L.render(ctx, [
    { type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.8, fill: '#ffffff' },
    { type: 'circle', cx: 0.5, cy: 0.3, r: 0.1, fill: '#123456' },
    { type: 'line', x1: 0, y1: 0.5, x2: 1, y2: 0.5, color: '#000000', width: 2 },
    { type: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    { type: 'text', x: 0.5, y: 0.9, text: '你好', size: 0.05, color: '#ffffff' }
], 1000, 1200);
const fillCount = ctx.calls.filter((c) => c[0] === 'fill').length;
const strokeCount = ctx.calls.filter((c) => c[0] === 'stroke').length;
const hasText = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]).join('');
check(fillCount >= 2, 'rect + circle 都执行了 fill', 'fill=' + fillCount);
check(strokeCount >= 1, 'line 执行了 stroke', 'stroke=' + strokeCount);
check(/你好/.test(hasText), 'text 绘制了内容', hasText);
check(L.findPhotoIndex([{ type: 'rect' }, { type: 'photo' }, { type: 'text' }]) === 1, 'findPhotoIndex 找到槽位');

// 5) 非法图层不崩溃
let threw = false;
try { L.render(mockCtx(), [{ type: 'bogus' }, null, { type: 'rect', w: 0 }], 100, 100); } catch (e) { threw = true; }
check(!threw, '非法/空图层不抛异常', String(threw));

// 6) 长文字折行 + 不溢出：用不同 y 判断行数（逐字绘制后 fillText 次数=字数，不能再拿次数当行数）
const ctx2 = mockCtx();
const longText = '这是一段非常非常长的文字用来测试自动折行是否会超出画布边界清框影';
L.render(ctx2, [{ type: 'text', x: 0.5, y: 0.5, text: longText, size: 0.05, align: 'center', maxW: 0.5 }], 400, 600);
const drawn = ctx2.calls.filter((c) => c[0] === 'fillText');
const lineCount = new Set(drawn.map((c) => Math.round(c[3] * 100))).size;
check(lineCount >= 2, '超长文字被折成多行', '行数=' + lineCount);
const inside = drawn.every((c) => c[2] >= 0 && c[2] <= 400 && c[3] >= 0 && c[3] <= 600);
check(inside, '每行文字坐标都落在画布内', JSON.stringify(drawn.slice(0, 2)));

// 7) AI 把 size 写成像素（24）或超大比例：硬夹到 20% 画布高
const ctx3 = mockCtx();
L.render(ctx3, [{ type: 'text', x: 0.5, y: 0.5, text: '巨大文字', size: 24, align: 'center', maxW: 0.8 }], 400, 600);
const fontPx = parseFloat((/(\d+(?:\.\d+)?)px/.exec(ctx3.font) || [])[1] || '0');
check(fontPx > 0 && fontPx <= 600 * 0.2 + 0.5, '像素字号被硬夹到 20% 画布高', 'font=' + ctx3.font);

// 8) 照片槽位：画布比例按槽位/照片比例算，预览 maxEdge 生效
const f = L.computeFrameSize(400, 500, [{ type: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 0.8 }], {});
const slotAspect = (f.slot.w * f.W) / (f.slot.h * f.H);
check(Math.abs(slotAspect - 400 / 500) < 0.01, '照片槽位像素比例=照片比例（不拉伸）', 'slot=' + slotAspect.toFixed(3));
const small = L.computeFrameSize(4000, 5000, [{ type: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 0.8 }], { maxEdge: 320 });
check(Math.max(small.W, small.H) <= 320, '预览 maxEdge 限制长边', small.W + 'x' + small.H);
check(L.computeFrameSize(400, 500, [{ type: 'photo' }], {}).photoIndex === 0, 'computeFrameSize 返回槽位索引');

// 9) 画布直接编辑的几何：包围盒 / 命中（从上到下）/ 移动 / 缩放
const layers = [
    { type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.8, fill: '#fff' },
    { type: 'photo', x: 0.15, y: 0.15, w: 0.7, h: 0.6 },
    { type: 'text', x: 0.5, y: 0.85, text: 'DATE', size: 0.05, align: 'center', maxW: 0.8 }
];
const rb = L.layerBounds(ctx, layers[0], 1000, 800);
check(Math.abs(rb.x - 100) < 0.01 && Math.abs(rb.y - 80) < 0.01 && Math.abs(rb.w - 800) < 0.01,
    'layerBounds 把框类比例换算成像素', JSON.stringify(rb));
const tb = L.layerBounds(ctx, layers[2], 1000, 800);
check(tb.w > 0 && tb.h > 0 && tb.x >= 0 && tb.x + tb.w <= 1000,
    'layerBounds 用文字布局算出真实可见框', JSON.stringify(tb));
const hitText = L.hitTest(ctx, layers, 500, 680, 1000, 800, 4);
check(hitText && hitText.index === 2 && hitText.layer.type === 'text',
    'hitTest 命中上层文字（不是它的下层）', JSON.stringify(hitText && hitText.index));
const hitPhoto = L.hitTest(ctx, layers, 500, 400, 1000, 800, 4);
check(hitPhoto && hitPhoto.index === 1 && hitPhoto.layer.type === 'photo',
    'hitTest 命中照片槽位', JSON.stringify(hitPhoto && hitPhoto.index));
check(!L.hitTest(ctx, layers, 5, 5, 1000, 800, 0), 'hitTest 画布空白处未命中');

const mv = { type: 'photo', x: 0.15, y: 0.15, w: 0.7, h: 0.6 };
L.setLayerCenter(mv, 600, 400, 1000, 800);
check(Math.abs((mv.x + mv.w / 2) - 0.6) < 1e-6 && Math.abs((mv.y + mv.h / 2) - 0.5) < 1e-6,
    'setLayerCenter 按中心写回比例坐标（可拖动照片槽位）', JSON.stringify(mv));
const tx = { type: 'text', x: 0.5, y: 0.8, text: 'A', size: 0.05 };
L.moveLayer(tx, 100, -80, 1000, 800);
check(Math.abs(tx.x - 0.6) < 1e-6 && Math.abs(tx.y - 0.7) < 1e-6,
    'moveLayer 按像素位移换算成比例位移', JSON.stringify(tx));
const sc = { type: 'rect', x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
const scCenter = L.layerCenter(sc, 1000, 800);
L.scaleLayer(sc, 2, 1000, 800);
const scAfter = L.layerCenter(sc, 1000, 800);
check(Math.abs(sc.w - 0.8) < 1e-6 && Math.abs(scCenter.x - scAfter.x) < 1e-6,
    'scaleLayer 放大框类尺寸且中心不漂移', JSON.stringify(sc));
const st = { type: 'text', x: 0.5, y: 0.5, text: 'A', size: 0.05 };
L.scaleLayer(st, 1.5, 1000, 800);
check(st.size > 0.05 && st.size <= 0.2, 'scaleLayer 缩放文字字号', String(st.size));

console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;

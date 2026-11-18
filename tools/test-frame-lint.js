// 边框体检单测：文字越界/对比度/槽位过窄/照片被盖/文字重叠 + 自动修正。纯 Node。
// 用法: node tools/test-frame-lint.js
'use strict';

const path = require('path');
const F = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-frame-lint.js'));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};

// mock ctx：textLayout 只需要 font / textAlign / measureText
function mockCtx() {
    let font = '16px sans-serif';
    return {
        get font() { return font; },
        set font(v) { font = String(v); },
        textAlign: 'left',
        textBaseline: 'alphabetic',
        fillStyle: '#000',
        measureText(s) {
            const m = /(\d+(?:\.\d+)?)px/.exec(font);
            const size = m ? parseFloat(m[1]) : 16;
            return { width: String(s).length * size * 0.6 };
        }
    };
}
const ctx = mockCtx();
const photo = { ar: 1.5, lumaMean: 70 };

const baseDoc = () => ({
    templateName: '测试',
    layers: [
        { type: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#f7f5f0' },
        { type: 'photo', x: 0.08, y: 0.08, w: 0.84, h: 0.76, fit: 'cover' },
        { type: 'text', x: 0.08, y: 0.93, text: 'HASSELBLAD 500CM', size: 0.035, color: '#1c1c1c', maxW: 0.84, maxLines: 1 }
    ]
});

// 0) 对比度工具
check(Math.round(F.contrast(F.parseColor('#000000'), F.parseColor('#ffffff'))) === 21, '黑白对比度 = 21');
check(F.parseColor('#0f0').g === 255, '短 hex 解析');
check(F.parseColor('rgba(10, 20, 30, 0.5)').a === 0.5, 'rgba 解析');
check(F.parseColor('红色') === null, '非法颜色返回 null');

// 1) 健康方案：零 error
const ok1 = F.lint(baseDoc(), { ctx, photo, bg: '#f7f5f0' });
check(ok1.issues.filter((i) => i.level === 'error').length === 0, '健康方案无 error', JSON.stringify(ok1.issues));
check(ok1.size.H === 1200 && Math.abs(ok1.size.W / 1200 - 1.5 * 0.76 / 0.84) < 0.05, '画布尺寸按槽位与照片比例推导', JSON.stringify(ok1.size));

// 2) 白字白底 → low-contrast，自动改成深色
const lowC = baseDoc();
lowC.layers[2].color = '#fbfbfb';
const lc = F.lint(lowC, { ctx, photo, bg: '#f7f5f0' });
check(lc.issues.some((i) => i.code === 'low-contrast' && i.level === 'error'), '白字白底判 low-contrast error');
const lcFix = F.checkAndFix(lowC, { ctx, photo, bg: '#f7f5f0' });
check(lcFix.fixes.includes('low-contrast'), '自动修正对比度', lcFix.fixes.join(','));
check(F.parseColor(lcFix.doc.layers[2].color) && F.contrast(F.parseColor(lcFix.doc.layers[2].color), F.parseColor('#f7f5f0')) >= 3, '修正后对比度达标', lcFix.doc.layers[2].color);

// 3) 槽位窄成一条缝 → slot-narrow，自动放宽
const narrow = baseDoc();
narrow.layers[1].w = 0.42; narrow.layers[1].h = 0.30;
const nr = F.lint(narrow, { ctx, photo, bg: '#f7f5f0' });
check(nr.issues.some((i) => i.code === 'slot-narrow' && i.level === 'error'), '窄槽位判 error');
const nrFix = F.checkAndFix(narrow, { ctx, photo, bg: '#f7f5f0' });
check(nrFix.fixes.includes('slot-narrow'), '自动放宽槽位');
const slotAfter = nrFix.doc.layers.find((l) => l.type === 'photo');
check(slotAfter.w > 0.42 && slotAfter.h > 0.30, '槽位真的变大了', slotAfter.w + '×' + slotAfter.h);

// 4) 文字压在照片主体上 → text-on-photo warn，自动挪到留白带
const onPhoto = baseDoc();
onPhoto.layers[2].y = 0.45;
const op = F.lint(onPhoto, { ctx, photo, bg: '#f7f5f0' });
check(op.issues.some((i) => i.code === 'text-on-photo'), '压住照片的文字被点出来');
const opFix = F.checkAndFix(onPhoto, { ctx, photo, bg: '#f7f5f0' });
check(opFix.fixes.includes('text-off-photo'), '自动把文字挪出照片', opFix.fixes.join(','));
check(opFix.doc.layers[2].y > 0.84 || opFix.doc.layers[2].y < 0.08, '文字落到照片外的留白带', String(opFix.doc.layers[2].y));

// 4b) 压在照片上但对比度够（白字 + 暗照片）→ 这是设计，不该被挪走
const overlay = baseDoc();
overlay.layers[2].y = 0.45;
overlay.layers[2].color = '#ffffff';
const ovFix = F.checkAndFix(overlay, { ctx, photo, bg: '#f7f5f0' });
check(!ovFix.fixes.includes('text-off-photo') && ovFix.doc.layers[2].y === 0.45,
    '可读的压图标题不被挪走', JSON.stringify({ y: ovFix.doc.layers[2].y, fixes: ovFix.fixes }));


const covered = baseDoc();
covered.layers.push({ type: 'rect', x: 0.05, y: 0.05, w: 0.9, h: 0.9, fill: '#222222' });
const cv = F.lint(covered, { ctx, photo, bg: '#f7f5f0' });
check(cv.issues.some((i) => i.code === 'photo-covered' && i.level === 'error'), '照片被盖判 error');
const cvFix = F.checkAndFix(covered, { ctx, photo, bg: '#f7f5f0' });
check(cvFix.fixes.includes('photo-covered'), '自动调整被盖的层');
const slotI = cvFix.doc.layers.findIndex((l) => l.type === 'photo');
const darkI = cvFix.doc.layers.findIndex((l) => l.fill === '#222222');
check(darkI < slotI, '盖照片的层被挪到照片之前', 'slot=' + slotI + ' dark=' + darkI);

// 6) 字太小 → text-tiny，自动抬到 16px
const tiny = baseDoc();
tiny.layers[2].size = 0.006;
const tn = F.lint(tiny, { ctx, photo, bg: '#f7f5f0' });
check(tn.issues.some((i) => i.code === 'text-tiny' && i.level === 'error'), '过小字判 error');
const tnFix = F.checkAndFix(tiny, { ctx, photo, bg: '#f7f5f0' });
check(Math.round(tnFix.doc.layers[2].size * 1200) >= 16, '字号被抬到可读', String(tnFix.doc.layers[2].size));

// 7) 尺寸为零的装饰层 → 自动清掉，不让它占图层
const degen = baseDoc();
degen.layers.push({ type: 'line', x1: 0.2, y1: 0.2, x2: 0.2, y2: 0.2, color: '#000000', width: 0 });
const dg = F.lint(degen, { ctx, photo, bg: '#f7f5f0' });
check(dg.issues.some((i) => i.code === 'degenerate'), '零尺寸层被点出');
const dgFix = F.checkAndFix(degen, { ctx, photo, bg: '#f7f5f0' });
check(dgFix.fixes.includes('degenerate') && dgFix.doc.layers.length === degen.layers.length - 1, '零尺寸层被清掉');

// 8) 多写一个槽位 → 只留面积最大的
const multi = baseDoc();
multi.layers.splice(2, 0, { type: 'photo', x: 0.2, y: 0.2, w: 0.2, h: 0.2 });
const ml = F.lint(multi, { ctx, photo, bg: '#f7f5f0' });
check(ml.issues.some((i) => i.code === 'multi-photo' && i.level === 'error'), '多槽位判 error');
const mlFix = F.checkAndFix(multi, { ctx, photo, bg: '#f7f5f0' });
check(mlFix.doc.layers.filter((l) => l.type === 'photo').length === 1, '只留一个槽位');

// 9) 完全没槽位 → 自动补一个
const noSlot = { layers: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#fffdf7' }, { type: 'text', x: 0.5, y: 0.5, text: 'hello', size: 0.05, color: '#111', align: 'center' }] };
const ns = F.lint(noSlot, { ctx, photo, bg: '#fffdf7' });
check(ns.issues.some((i) => i.code === 'no-photo' && i.level === 'error'), '缺槽位判 error');
const nsFix = F.checkAndFix(noSlot, { ctx, photo, bg: '#fffdf7' });
check(nsFix.doc.layers.some((l) => l.type === 'photo'), '自动补上槽位');
check(nsFix.usable === true, '补完槽位后可用', JSON.stringify(nsFix.issues));

// 10) 两段文字重叠 → text-collision 提醒
const collide = baseDoc();
collide.layers.push({ type: 'text', x: 0.08, y: 0.93, text: '2026.11.18', size: 0.035, color: '#1c1c1c', maxW: 0.84 });
const cl = F.lint(collide, { ctx, photo, bg: '#f7f5f0' });
check(cl.issues.some((i) => i.code === 'text-collision'), '叠字被点出');

// 11) summary 文案
check(/自动修正/.test(lcFix.summary), 'summary 带修正说明', lcFix.summary);
check(F.describe(cl.issues).includes('·'), 'describe 输出列表');

// 12) 脏数据不炸
check(F.lint({}, { ctx }) !== null, '空 doc 不炸');
check(F.lint({ layers: [] }, { ctx }).issues[0].code === 'empty', '空图层判 empty');
check(F.checkAndFix({ layers: [{ type: 'rect' }] }, { ctx, photo }).doc !== null, '缺字段的层不炸');

console.log('');
if (failures.length) {
    console.log('FAILED ' + failures.length + ' 项：' + failures.join(' / '));
    process.exit(1);
}
console.log('ALL PASS · 边框体检');

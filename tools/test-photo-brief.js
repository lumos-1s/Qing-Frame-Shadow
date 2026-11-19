// 照片速写单测：宽高比、主/辅色、亮暗、重心、prompt 文案。纯 Node，不需要浏览器。
// 用法: node tools/test-photo-brief.js
'use strict';

const path = require('path');
const B = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-photo-brief.js'));

const failures = [];
let total = 0;
const check = (ok, label, extra) => {
    total++;
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};

// 造一张图：左块深蓝 + 右块暖橙，可按列数比例混
function build(w, h, leftShare, leftRgb, rightRgb, alphaZero) {
    const data = new Uint8ClampedArray(w * h * 4);
    const cut = Math.round(w * leftShare);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const c = x < cut ? leftRgb : rightRgb;
            data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
            data[i + 3] = (alphaZero && x < cut) ? 0 : 255;
        }
    }
    return data;
}

// 1) 比例标签
check(B.ratioLabel(3000, 2000) === '3:2', '3000×2000 → 3:2', B.ratioLabel(3000, 2000));
check(B.ratioLabel(2000, 3000) === '2:3', '2000×3000 → 2:3', B.ratioLabel(2000, 3000));
check(B.ratioLabel(1000, 1000) === '1:1', '1000×1000 → 1:1', B.ratioLabel(1000, 1000));
check(B.ratioLabel(1080, 1920) === '9:16', '1080×1920 → 9:16', B.ratioLabel(1080, 1920));
check(/^\d+:\d+$|:1$/.test(B.ratioLabel(1234, 999)), '怪比例也有可读结果', B.ratioLabel(1234, 999));

// 2) 颜色命名
check(B.colorName('#1b2a4a') === '深蓝', '#1b2a4a → 深蓝', B.colorName('#1b2a4a'));
check(B.colorName('#e08a3c') === '橙', '#e08a3c → 橙', B.colorName('#e08a3c'));
check(B.colorName('#f5f5f5') === '近白', '#f5f5f5 → 近白', B.colorName('#f5f5f5'));
check(B.colorName('#111111') === '近黑', '#111111 → 近黑', B.colorName('#111111'));
check(B.colorName('#6b4423') === '深棕', '#6b4423 → 深棕', B.colorName('#6b4423'));

// 3) 统计：七成深蓝 + 三成橙 → 偏暗、主色深蓝、辅色橙
const dark = B.analyzePixels(build(100, 100, 0.7, [27, 42, 74], [224, 138, 60]), 100, 100);
check(!!dark, 'analyzePixels 返回结果');
check(dark.ratio === '1:1' && dark.orient === '方', '方图识别', dark.ratio + '/' + dark.orient);
check(dark.luma.tone === '偏暗', '整体偏暗', dark.luma.tone + ' mean=' + dark.luma.mean);
check(dark.dominant.name === '深蓝', '主色=深蓝', dark.dominant.name + ' ' + dark.dominant.hex);
check(dark.accent.name === '橙', '辅色=橙', dark.accent.name + ' ' + dark.accent.hex);
check(Math.abs(dark.dominant.share - 0.7) < 0.05, '主色占比≈70%', String(dark.dominant.share));
check(dark.palette.length >= 2, '调色板至少两色', String(dark.palette.length));

// 4) 重心：中间灰底 + 右侧一块高饱和红 → 偏右
const w = 100, h = 100;
const data = build(w, h, 1, [128, 128, 128], [128, 128, 128]);
for (let y = 10; y < 90; y++) {
    for (let x = 75; x < 95; x++) {
        const i = (y * w + x) * 4;
        data[i] = 220; data[i + 1] = 20; data[i + 2] = 20;
    }
}
const c = B.analyzePixels(data, w, h);
check(c.centroid.x > 0.55, '视觉重心偏右', c.centroid.x + ',' + c.centroid.y + ' ' + c.centroid.label);
check(c.sat.label === '中等' || c.sat.label === '低', '饱和度标签合理', c.sat.label);

// 5) 全平灰图：重心应该落在中间，不能因权重为 0 而 NaN
const flat = B.analyzePixels(build(48, 48, 1, [128, 128, 128], [128, 128, 128]), 48, 48);
check(flat && Math.abs(flat.centroid.x - 0.5) < 0.08 && Math.abs(flat.centroid.y - 0.5) < 0.08, '纯色图重心居中', JSON.stringify(flat.centroid));
check(flat.luma.contrast === '弱', '纯色图对比弱', flat.luma.contrast);
check(flat.sat.label === '低', '纯色图饱和低', flat.sat.label);

// 6) 透明像素跳过，不把全透明当黑
const withAlpha = B.analyzePixels(build(40, 40, 0.5, [0, 0, 0], [240, 240, 240], true), 40, 40);
check(withAlpha && withAlpha.dominant.name === '近白', '全透明区不参与统计', withAlpha && withAlpha.dominant.name);

// 7) 异常输入不炸
check(B.analyzePixels(null, 10, 10) === null, 'null 像素返回 null');
check(B.analyzePixels(new Uint8ClampedArray(8), 10, 10) === null, '像素不足返回 null');
check(B.analyzePixels(new Uint8ClampedArray(0), 0, 0) === null, '零尺寸返回 null');

// 8) 文案：数字、主色、EXIF 都要进 prompt
const text = B.toPromptText(dark, { make: 'SONY', model: 'ILCE-7M3', iso: 'ISO400', aperture: 'f/1.8', shutter: '1/250s', focal: '35mm' });
check(/1:1\s*方构图/.test(text), '文案带比例与构图', text.split('\n')[0]);
check(text.includes('深蓝') && text.includes('橙'), '文案带主色/辅色');
check(text.includes('偏暗'), '文案带明暗');
check(text.includes('EXIF') && text.includes('ILCE-7M3') && text.includes('ISO400'), '文案带 EXIF');
check(!/undefined|NaN/.test(text), '文案没有 undefined/NaN', text);
check(B.toPromptText(null, {}) === '', '无速写返回空串');

// 9) 建议：暗调照片应该建议浅色卡纸
const advice = B.toAdvice(dark);
check(/暗调/.test(advice) && /明度|浅字|亮卡纸/.test(advice), '暗调给出明度分离建议', advice);
check(/。$/.test(advice), '建议以句号结尾');
const rightHeavy = B.toAdvice(c);
check(/偏右|左侧/.test(rightHeavy), '重心偏右建议文字放左', rightHeavy);
check(B.toAdvice(null) === '', '无速写无建议');

console.log('');
if (failures.length) {
    console.log('FAILED ' + failures.length + ' 项：' + failures.join(' / '));
    process.exit(1);
}
console.log('ALL PASS · 照片速写 ' + total + ' 项');

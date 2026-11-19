// 拾景纸刊编译器单测：两条路径 / 画布比例 / 现场读取 / 色彩结构 / 微文字。纯 Node。
// 用法: node tools/test-zine-compiler.js
'use strict';

const path = require('path');
const Z = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-zine-compiler.js'));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};

const portrait = {
    w: 1000, h: 1500, ar: 0.667, orient: '竖', ratio: '2:3',
    luma: { mean: 118, p10: 38, p50: 112, p90: 205, shadow: 0.19, highlight: 0.16, tone: '中间调', contrast: '中等', range: 0.65 },
    sat: { mean: 0.34, label: '中等' },
    palette: [{ hex: '#C9A227', name: '银杏黄' }, { hex: '#2E4A32', name: '墨绿' }],
    dominant: { hex: '#C9A227', name: '银杏黄', share: 0.31 },
    accent: { hex: '#2E4A32', name: '墨绿', share: 0.22 },
    centroid: { x: 0.33, y: 0.64, label: '偏左下' }
};
const landscape = Object.assign({}, portrait, { w: 1500, h: 1000, ar: 1.5, orient: '横', ratio: '3:2', centroid: { x: 0.72, y: 0.32, label: '偏右上' } });

// 1) 两条路径都产出可用 prompt
const collage = Z.compile(portrait, { path: 'collage', subject: '银杏下的背影', mood: '秋末的等待' });
const distill = Z.compile(portrait, { path: 'distill', subject: '银杏下的背影', mood: '秋末的等待' });
check(collage.path === 'collage' && collage.prompt.length > 600, '实景拼贴产出完整提示词', collage.chars + ' 字');
check(distill.path === 'distill' && distill.prompt.length > 600, '影像蒸馏产出完整提示词', distill.chars + ' 字');
check(collage.needsSourceImage === true && distill.needsSourceImage === false, '拼贴带源图、蒸馏不带');
check(/银杏下的背影/.test(collage.prompt) && /银杏下的背影/.test(distill.prompt),
    '用户填的主体真的写进提示词', collage.prompt.split('\n')[1].slice(-40));

// 2) 两条路径的分工写清楚了（不是同一段话换个标题）
check(/truthful as the visual anchor/.test(collage.prompt) && /hand-torn/.test(collage.prompt),
    '拼贴强调照片真实 + 撕纸边界');
check(/no photographic pixels anywhere/.test(distill.prompt) && /semantic evidence/.test(distill.prompt),
    '蒸馏明确不要照片像素');
check(collage.prompt !== distill.prompt && !/no photographic pixels/.test(collage.prompt),
    '两条路径不是同一段提示换皮');

// 3) 画布按照片方向推导，且可覆盖
check(collage.ratio === '3:5' && Z.compile(landscape, {}).ratio === '5:3', '竖照 3:5 / 横照 5:3', collage.ratio + ' / ' + Z.compile(landscape, {}).ratio);
check(Z.compile(portrait, { ratio: '1:1' }).ratio === '1:1', '用户可覆盖画布比例');

// 4) Scene Card 真的读了现场
const card = Z.sceneCard(portrait, { make: 'Hasselblad', model: '500CM', focal: '80mm' });
check(card.subjectLow === true && card.quiet === 'upper', '重心偏下 → 留白留在上方', JSON.stringify({ low: card.subjectLow, quiet: card.quiet }));
check(Z.sceneCard(landscape, null).gesture === 'leftward', '重心偏右 → 视线向左');
check(/Hasselblad/.test(card.exif) && /80mm/.test(card.exif), 'EXIF 进入现场卡', card.exif);
check(card.dark === false && card.inkArea[0] < card.fieldArea[0], '中间调：色块小、插画场大', JSON.stringify({ ink: card.inkArea, field: card.fieldArea }));

// 5) 颜色必须承担结构，不是装饰
const accent = Z.accentLine(card);
check(/2E4A32/.test(accent) && /eye path|balance/.test(accent) && /Remove it/.test(accent),
    '色从辅色导出 + 结构作用 + 可移除检验', accent.slice(0, 80));
check(/detached/.test(collage.negative) === false && /watermark/.test(collage.negative), '硬禁项包含水印等');

// 6) 微文字：不编造名言、不给日期坐标，语言三态
check(Z.compile(portrait, { lang: 'en' }).microText.length > 0, '英文题字自动写一句');
const zh = Z.compile(portrait, { lang: 'zh' }).microText;
const bi = Z.compile(portrait, { lang: 'bi' }).microText;
check(!/\d{4}/.test(zh) && !/\d{4}/.test(bi), '自动题字不带年份', zh + ' / ' + bi);
const given = Z.compile(portrait, { microText: '银杏', lang: 'en' });
check(given.microText === '银杏' && /"银杏"/.test(given.prompt), '用户给的题字原样用');

// 7) 暗调场景收紧色块
const darkBrief = Object.assign({}, portrait, { luma: Object.assign({}, portrait.luma, { mean: 72, shadow: 0.42, tone: '偏暗' }) });
const darkCard = Z.sceneCard(darkBrief, null);
check(darkCard.dark === true && darkCard.inkArea[1] < card.inkArea[1], '暗调照片压小色块', JSON.stringify(darkCard.inkArea));

// 8) 空输入不炸
const empty = Z.compile(null, {});
check(empty && empty.prompt && empty.ratio === '3:5', '没有速写也能出稿');

console.log('');
if (failures.length) { console.log('FAILED ' + failures.length + ' 项：' + failures.join(' / ')); process.exit(1); }
console.log('ALL PASS · 拾景纸刊编译器');

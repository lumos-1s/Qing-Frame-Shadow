// 导演型 AI 单测：从手工边框里挑、写文案、只调两个安全参数。
// 用法: node tools/test-frame-director.js
'use strict';

const fs = require('fs');
const path = require('path');
const D = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-frame-director.js'));
const P = require(path.join(__dirname, '..', 'src', 'main', 'ai-provider.js'));

const PRESET_DIR = path.join(__dirname, '..', 'shared', 'presets');
const presets = fs.readdirSync(PRESET_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(PRESET_DIR, f), 'utf8')))
    .sort((a, b) => String(a.templateName).localeCompare(String(b.templateName), 'zh'));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};
const byName = (n) => presets.find((p) => p.templateName === n);
const brief = {
    ar: 0.75, orient: '竖', luma: { mean: 72, tone: '偏暗', contrast: '中等' },
    dominant: { name: '棕', hex: '#6b4f3a' }, accent: { name: '灰', hex: '#9a9a9a' },
    centroid: { x: 0.45, y: 0.6, label: '偏下' }
};

// ── 1. 特征提取 ────────────────────────────────────────────────
const vhs = D.traitsOf(byName('VHS录像带'));
check(vhs.name === 'VHS录像带' && vhs.layout === '满幅' && vhs.textSlots === 0,
    '满幅款识别为「满幅 + 无文字」', JSON.stringify(vhs));
const canva = D.traitsOf(byName('Canva错位拼贴'));
check(/留白/.test(canva.layout) && canva.textSlots === 1 && canva.traits.indexOf('文字×1') >= 0,
    '留白款识别出文字位', canva.traits);
const ratioPreset = presets.find((p) => p.canvasRatio === '3:4');
check(ratioPreset && /固定3:4/.test(D.traitsOf(ratioPreset).traits),
    '固定比例写进特征（供模型避坑）', ratioPreset && D.traitsOf(ratioPreset).traits);

// ── 2. 目录：全量、可读、token 可控 ─────────────────────────────
const cat = D.catalogText(presets);
const missing = presets.filter((p) => cat.indexOf(p.templateName) < 0).map((p) => p.templateName);
check(missing.length === 0, '91 款边框全部出现在清单里', missing.slice(0, 5).join('、'));
check(cat.length < 6000, '清单压得够短（<6000 字，约 2k token）', String(cat.length));
check(cat.split('\n').length === new Set(presets.map((p) => p.templateTag || '其他')).size,
    '按标签分组，一行一组', String(cat.split('\n').length));

// ── 3. 本地初选：懂关键词、懂文字位、四个方向不重样 ─────────────
const copyCtx = { brief, intent: '做一张旅行手账，想写标题和日期' };
const picks = D.localPicks(presets, copyCtx, 4, 0);
check(picks.length === 4, '本地初选给满 4 款', String(picks.length));
check(new Set(picks.map((p) => p.preset.templateName)).size === 4, '4 款不重复');
check(picks.every((p) => D.traitsOf(p.preset).textSlots > 0),
    '要写文案时，只挑有文字位的款', picks.map((p) => p.preset.templateName).join(' / '));
check(new Set(picks.map((p) => D.traitsOf(p.preset).tag)).size >= 3,
    '4 款覆盖至少 3 个标签（不是同一类换皮）', picks.map((p) => D.traitsOf(p.preset).tag).join('/'));

const polaroid = D.localPicks(presets, { brief, intent: '拍立得' }, 4, 0);
check(polaroid.slice(0, 2).some((p) => /拍立得/.test(p.preset.templateName)),
    '点名「拍立得」时排在最前', polaroid.map((p) => p.preset.templateName).join(' / '));

const seedA = D.localPicks(presets, { brief, intent: '复古' }, 4, 1).map((p) => p.preset.templateName).join('|');
const seedB = D.localPicks(presets, { brief, intent: '复古' }, 4, 2).map((p) => p.preset.templateName).join('|');
check(seedA !== seedB, '换一批能换出不同组合', seedA + ' vs ' + seedB);

// 「换一批」把上一轮的款塞进 avoid 时必须真的避开，否则用户点两次看到同一批。
const firstRound = D.localPicks(presets, copyCtx, 4, 0).map((p) => p.preset.templateName);
const secondRound = D.localPicks(presets, Object.assign({}, copyCtx, { avoid: firstRound }), 4, 0)
    .map((p) => p.preset.templateName);
check(secondRound.length === 4 && secondRound.every((n) => firstRound.indexOf(n) < 0),
    '传了 avoid 后不再重复上一轮的款', firstRound.join(' / ') + ' → ' + secondRound.join(' / '));

// ── 4. 文案写进文字位 ─────────────────────────────────────────
const target = picks[0].preset;
const beforeLines = ((target.decorConfig || {}).textLines || []).filter((l) => l.align !== 'free');
const composed = D.composePreset(target, {
    copy: { title: '京都的雨', subtitle: '十一月，鸭川边' }, fontScale: 1.1, pad: 6
});
const afterLines = ((composed.preset.decorConfig || {}).textLines || []).filter((l) => l.align !== 'free');
check(afterLines[0].text === '京都的雨' && afterLines[0].fontSize >= beforeLines[0].fontSize * 1.05,
    '标题写进最大字阶，字号跟随 fontScale', JSON.stringify(afterLines.map((l) => [l.text, l.fontSize])));
const extraFilled = afterLines.length > 2 && afterLines.slice(2).some((l) => l.text);
check(!extraFilled, '没有文案的额外文字位被清空（不留占位日期/刊号）',
    JSON.stringify(afterLines.map((l) => l.text)));
const twoSlot = presets.find((p) => D.traitsOf(p).textSlots >= 2);
const twoSlotOut = D.composePreset(twoSlot, { copy: { title: '京都的雨', subtitle: '鸭川边' } });
check(twoSlotOut.warnings.length === 0, '文字位够用时没有警告', twoSlotOut.warnings.join('；'));

// 满幅款：文案跳过 + 留白调不了，两件事都要说清
const fullBleed = D.composePreset(byName('VHS录像带'), { copy: { title: '夜行' }, pad: 8 });
check(fullBleed.warnings.some((w) => /没有文字位/.test(w)) && fullBleed.warnings.some((w) => /留白/.test(w)),
    '无文字位/满幅款把限制说明白', fullBleed.warnings.join('；'));

// 只有 1 个文字位却给 3 段文案：不静默丢，给出提示
const oneSlot = D.composePreset(byName('Canva错位拼贴'), {
    copy: { title: '一', subtitle: '二', meta: '三' }
});
check(oneSlot.warnings.some((w) => /文字位/.test(w)), '文案多过文字位时给出提示', oneSlot.warnings.join('；'));

// 留白：只对本来就有留白的款生效
const padded = D.composePreset(byName('Canva错位拼贴'), { pad: 10 });
check(padded.preset.baseMargin.marginTop > byName('Canva错位拼贴').baseMargin.marginTop,
    '留白参数加到原留白上', String(padded.preset.baseMargin.marginTop));

// ── 5. 解析模型回复 ──────────────────────────────────────────
const good = JSON.stringify({
    picks: [
        { preset: '复古报纸', why: '竖幅 + 满幅压字', copy: { title: '雨停之后', subtitle: '鸭川' }, fontScale: 1.1, pad: 4 },
        { preset: '复古报纸', why: '重复项应被去掉' },
        { preset: 'VHS录像带 · 导演版', why: '带后缀也应认识' },
        { preset: '不存在的框', why: '编造项应被丢弃' }
    ]
});
const parsed = D.parsePicks('好的，这是方案：\n```json\n' + good + '\n```', presets);
check(parsed.picks.length === 2, '宽容解析 + 去重 + 丢弃编造名', String(parsed.picks.length));
check(parsed.picks[0].preset.templateName === '复古报纸', '精确名直接命中');
check(parsed.picks[1].preset.templateName === 'VHS录像带', '带后缀的名字也能模糊命中', parsed.picks[1].preset.templateName);
check(parsed.dropped.length === 1 && parsed.dropped[0] === '不存在的框', '丢弃项带原因', parsed.dropped.join('、'));

const clamped = D.parsePicks(JSON.stringify({
    picks: [{
        preset: '复古报纸',
        copy: { title: '这是一个非常非常非常长的标题超过上限', subtitle: 'x'.repeat(80) },
        fontScale: 9, pad: -999
    }]
}), presets).picks[0];
check(clamped.copy.title.length <= 16 && clamped.fontScale === 1.15 && clamped.pad === -15,
    '越界参数被夹紧', JSON.stringify({ t: clamped.copy.title.length, f: clamped.fontScale, p: clamped.pad }));

const noJson = D.parsePicks('抱歉，我这次没想法', presets);
check(noJson.picks.length === 0 && noJson.dropped.length === 0, '非 JSON 回复不崩');

// ── 6. 给模型的消息：带图、带事实、带目录 ─────────────────────
const msgs = D.buildMessages({
    presets, brief, intent: '给妈妈的生日卡', count: 4,
    briefText: '照片 4000×5333（3:4 竖构图）\n明暗：偏暗',
    exif: { make: 'FUJIFILM', model: 'X-T5', focal: '35mm' },
    image: 'data:image/jpeg;base64,AAAA'
});
check(msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user', '系统规则 + 用户消息两条');
check(Array.isArray(msgs[1].content) && msgs[1].content[1].type === 'image_url',
    '带图请求用 OpenAI content parts', JSON.stringify(msgs[1].content.map((p) => p.type)));
const textPart = msgs[1].content[0].text;
check(textPart.indexOf('可选边框') >= 0 && textPart.indexOf('复古报纸') >= 0 && textPart.indexOf('FUJIFILM') >= 0,
    '用户消息里有目录、EXIF、照片事实');
check(/preset/.test(msgs[0].content) && /只能从清单里选/.test(msgs[0].content), '系统规则写明只能从清单里选与 JSON 格式');
const noImage = D.buildMessages({ presets, brief, intent: '', image: '' });
check(noImage[1].content.length === 1, '没有缩略图时不发空的 image part');
const avoided = D.buildMessages({ presets, brief, intent: '再来一批', image: '', avoid: ['拍立得签名', '复古报纸'] });
check(/上一轮已经出过/.test(avoided[1].content[0].text) && /拍立得签名/.test(avoided[1].content[0].text),
    '换一批时把上一轮用过的款告诉模型');

// ── 7. 主进程：带图消息的边界 ─────────────────────────────────
const okStr = P.normalizeContent('hello');
check(okStr.ok && okStr.content === 'hello', '旧字符串消息保持原样');
const okArr = P.normalizeContent([
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
]);
check(okArr.ok && okArr.content.length === 2, '文本 + 内联图通过');
check(!P.normalizeContent([{ type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }]).ok,
    '拒绝远程图片地址（防 SSRF）');
check(!P.normalizeContent([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }
]).ok, '一条消息最多两张图');
check(!P.normalizeContent([{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024 + 8) } }]).ok,
    '超大图被拒（上限约 6MB）');
check(!P.normalizeContent([{ type: 'audio', data: 'x' }]).ok, '未知内容类型被拒');

console.log('');
if (failures.length) {
    console.log('FAILED ' + failures.length + ' · 导演型 AI');
    process.exit(1);
}
console.log('ALL PASS · 导演型 AI');

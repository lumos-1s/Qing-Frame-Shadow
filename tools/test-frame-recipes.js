// 本地配方单测：不调模型，验证 4 款都能过体检、照片槽位比例正确、文字有边界。
// 用法: node tools/test-frame-recipes.js
'use strict';

const path = require('path');
const R = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-frame-recipes.js'));
const L = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-frame-lint.js'));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};

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

const layersOf = (d) => (Array.isArray(d) ? d : (d && d.layers) || []);
const photosOf = (d) => layersOf(d).filter((l) => l && l.type === 'photo');
const textsOf = (d) => layersOf(d).filter((l) => l && l.type === 'text');

const ARS = [1.5, 0.667, 1.0, 2.4, 0.42];
const PROMPTS = ['', '展览海报，大字压图', '极简留白', '胶片复古档案', '手账旅行拼贴', '时尚杂志封面', '大胆撞色波普'];

let cases = 0, usable = 0, boldSum = 0;
for (const ar of ARS) {
    for (const prompt of PROMPTS) {
        cases++;
        const brief = { ar: ar, luma: { mean: 96, tone: '中间调' }, dominant: { hex: '#8a6a4a' }, accent: { hex: '#b4472f' } };
        const docs = R.designPlans({ brief: brief, prompt: prompt, seed: 12345, count: 4 });
        check(docs.length === 4, `四款 · ${ar} · ${prompt || '默认'}`, String(docs.length));
        const names = docs.map((d) => d.templateName);
        const ids = docs.map((d) => d.recipeId);
        check(new Set(ids).size === docs.length, '四款配方互不重复', ids.join(','));
        check(new Set(names).size >= 3, '四款名字不完全相同', names.join(','));
        let ok = true, boldAvg = 0;
        for (const d of docs) {
            const ps = photosOf(d);
            if (ps.length !== 1) { ok = false; check(false, '每款只有一个照片槽位', d.templateName + ':' + ps.length); continue; }
            const p = ps[0];
            const inside = p.x >= 0 && p.y >= 0 && p.w > 0.05 && p.h > 0.05 && p.x + p.w <= 1.0001 && p.y + p.h <= 1.0001;
            if (!inside) { ok = false; check(false, '照片槽位在画布内', JSON.stringify(p)); }
            const canvasAr = R.canvasArFor(d.recipeId, ar);
            const slotAr = (p.w * canvasAr) / p.h;
            if (Math.abs(slotAr - ar) / ar > 0.02) {
                ok = false;
                check(false, '槽位像素比例=照片比例', `${d.templateName} slot=${slotAr.toFixed(3)} photo=${ar}`);
            }
            for (const t of textsOf(d)) {
                if (!(t.maxW > 0) || !(t.maxLines >= 1)) {
                    ok = false;
                    check(false, '文字带 maxW/maxLines', `${d.templateName}:${t.text}`);
                }
            }
            const res = L.checkAndFix(d, { bg: d.aiBackground, photo: { ar: ar, lumaMean: 96 }, ctx: ctx });
            if (!res.usable) {
                ok = false;
                check(false, '体检可用', `${d.templateName}: ` + L.describe(res.issues));
            }
            if (res.fixes.length) {
                ok = false;
                check(false, '一次成型、不靠自动修正', `${d.templateName}: ` + res.fixes.join(','));
            }
            const b = L.boldness(d, { photo: { ar: ar, lumaMean: 96 }, ctx: ctx });
            boldAvg += b.score;
        }
        if (ok) usable++;
        boldSum += boldAvg / docs.length;
        check(boldAvg / docs.length >= 25, '四款平均大胆度 ≥ 25', String(Math.round(boldAvg / docs.length)));
        check(Math.max(...docs.map((d) => L.boldness(d, { photo: { ar: ar, lumaMean: 96 }, ctx: ctx }).score)) >= 40, '每批至少一款够大胆');
    }
}
check(usable === cases, '全部组合一次过体检', `${usable}/${cases}`);
check(boldSum / cases >= 30, '整体平均大胆度 ≥ 30', String(Math.round(boldSum / cases)));

// 换一批：同提示不同 seed 应该换配方组合
const brief = { ar: 1.5, luma: { mean: 96 }, dominant: { hex: '#8a6a4a' }, accent: { hex: '#b4472f' } };
const combos = new Set();
for (let s = 1; s <= 6; s++) combos.add(R.designPlans({ brief: brief, prompt: '海报', seed: s }).map((d) => d.recipeId).join(','));
check(combos.size >= 3, '换一批会换配方组合', Array.from(combos).join(' / '));

// 基于某一款改：骨架不变，四套配色
const base = R.designPlans({ brief: brief, prompt: '极简留白', seed: 7 })[0];
const vars = R.variantsOf(base, { brief: brief, prompt: '换个配色', seed: 8 });
check(vars.length === 4, '变体出 4 款', String(vars.length));
check(vars.every((d) => d.recipeId === base.recipeId), '变体保持同一配方', vars.map((d) => d.recipeId).join(','));
check(new Set(vars.map((d) => d.aiBackground)).size >= 3, '变体换了纸色', vars.map((d) => d.aiBackground).join(','));
check(vars.every((d) => photosOf(d).length === 1), '变体仍有唯一照片槽位');
const firstText = textsOf(base)[0] && textsOf(base)[0].text;
check(vars.every((d) => !firstText || textsOf(d).some((t) => t.text === firstText)), '变体保留原标题', String(firstText));

// 确定性：同 seed 同输出
const d1 = JSON.stringify(R.designPlans({ brief: brief, prompt: '胶片', seed: 99 }));
const d2 = JSON.stringify(R.designPlans({ brief: brief, prompt: '胶片', seed: 99 }));
check(d1 === d2, '同 seed 输出稳定');

console.log('');
if (failures.length) {
    console.log('FAILED ' + failures.length + ' · 本地配方');
    process.exit(1);
}
console.log('ALL PASS · 本地配方');

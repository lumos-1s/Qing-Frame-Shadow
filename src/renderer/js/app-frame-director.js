'use strict';
/* 导演型 AI：模型只做「挑 · 写 · 调」，不做版式。
 *
 * 为什么不让模型画坐标：LLM 不擅长空间精度，给 0..1 的矩形只会得到
 * 「照片缩在中间、四边等宽、大字乱压」的几何拼贴。这里换分工 ——
 *   · 挑：从 90+ 个手工边框里选，必须逐字命中清单；质量下限就是手工框
 *   · 写：按照片事实写标题/副标题/参数行，写进预设自带的文字位
 *   · 调：只给留白与字号两个安全参数，不碰颜色与图层
 * 渲染、导出、撤销仍走现有引擎，AI 出错最多是「选错框」，不会产畸形版式。
 *
 * 本模块是纯函数（Node 单测与渲染层共用），不碰 DOM、不发请求。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.QfsFrameDirector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const clone = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; } };
    const clean = (v, n) => String(v == null ? '' : v)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, n || 80);

    const ALIGN_LABEL = {
        bottom: '底部', top: '顶部', left: '左侧', right: '右侧',
        center: '居中', exif: '参数位', free: '自由'
    };

    // 用户口头语 → 边框名字/标签里的词。只做加法，不做同义改写，
    // 因为最终仍然要靠「名字里有没有这个词」来打分。
    const INTENT = [
        { say: ['海报', '展览', '宣传', 'poster'], want: ['海报', '展览', '杂志', '大片', '标题'] },
        { say: ['胶片', '底片', '胶卷', 'film'], want: ['胶片', '底片', '录像', '复古'] },
        { say: ['极简', '留白', '干净', '安静', '简约'], want: ['极简', '留白', '现代'] },
        { say: ['手账', '拼贴', '日记', '旅行', 'journal'], want: ['手账', '拼贴', '胶带', '相册', '拍立得', '手作'] },
        { say: ['档案', '报纸', '票据', '老照片', 'archive'], want: ['档案', '报纸', '票根', '邮票', '复古'] },
        { say: ['杂志', '封面', '刊号', '时尚', 'magazine'], want: ['杂志', '封面', '刊'] },
        { say: ['生日', '贺卡', '祝福', '礼物', 'card'], want: ['卡', '票', '纪念', '祝福'] },
        { say: ['黑白', '单色', 'mono', 'bw'], want: ['黑白', '单色', '银盐'] },
        { say: ['夜景', '霓虹', '赛博', 'neon'], want: ['霓虹', '赛博', '光'] },
        { say: ['水彩', '手绘', '插画', '画'], want: ['水彩', '手绘', '墨', '画'] },
        { say: ['签名', '水印', '署名', 'logo'], want: ['签名', '水印', '署名', '参数'] }
    ];

    function textLinesOf(preset) {
        const lines = (preset && preset.decorConfig && preset.decorConfig.textLines) || [];
        return (Array.isArray(lines) ? lines : []).filter((l) => l && l.align !== 'free');
    }

    // ── 边框速写：给模型看的「设计特征」，不是渲染参数 ───────────────
    function traitsOf(preset) {
        const p = preset || {};
        const m = p.baseMargin || {};
        const t = num(m.marginTop, 0), b = num(m.marginBottom, 0);
        const l = num(m.marginLeft, 0), r = num(m.marginRight, 0);
        const zero = !t && !b && !l && !r;
        const uniform = (Math.max(t, b, l, r) - Math.min(t, b, l, r)) <= 1;
        const layout = zero ? '满幅' : (uniform ? '等宽留白' : '非对称留白');

        const lines = textLinesOf(p);
        const aligns = [];
        for (const line of lines) {
            const label = ALIGN_LABEL[line.align] || '锚点';
            if (aligns.indexOf(label) < 0) aligns.push(label);
        }

        const fx = [];
        const le = p.lightEffect || {};
        if (le.vignetteEnable) fx.push('暗角');
        if (le.lightLeakEnable) fx.push('漏光');
        if ((p.filmTearConfig || {}).filmPerforationEnable) fx.push('齿孔');
        if (m.bgBlurEnable) fx.push('背景模糊');
        if (((p.decorConfig || {}).stickers || []).length) fx.push('贴纸');
        if (num(p.blurIntensity, 0) > 0) fx.push('柔焦');
        if ((p.layerList || []).length) fx.push('多图层');
        if (num((p.cornerConfig || {}).cornerRadiusAll, 0) > 0) fx.push('圆角');

        const ratio = p.canvasRatio && p.canvasRatio !== 'original' ? String(p.canvasRatio) : '';
        const traits = [
            layout,
            lines.length ? ('文字×' + lines.length + '(' + aligns.join('/') + ')') : '无文字'
        ].concat(fx.slice(0, 2));
        if (ratio) traits.push('固定' + ratio);

        return {
            name: clean(p.templateName, 40),
            tag: clean(p.templateTag, 12) || '其他',
            layout: layout,
            textSlots: lines.length,
            textAligns: aligns,
            ratio: ratio,
            traits: traits.join('·')
        };
    }

    // 按标签分组，一行一款。90 多款压进 ~2k token，模型能全部看见，
    // 不至于因为「短名单」把真正合适的那款提前排除。
    function catalogText(presets) {
        const groups = new Map();
        for (const p of (presets || [])) {
            const t = traitsOf(p);
            if (!t.name) continue;
            if (!groups.has(t.tag)) groups.set(t.tag, []);
            groups.get(t.tag).push(t.name + '（' + t.traits + '）');
        }
        const out = [];
        for (const [tag, items] of groups) out.push('【' + tag + '】' + items.join('、'));
        return out.join('\n');
    }

    function parseRatio(s) {
        const m = /^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)$/.exec(String(s || ''));
        if (!m) return 0;
        const a = Number(m[1]), b = Number(m[2]);
        return a > 0 && b > 0 ? a / b : 0;
    }

    function scorePreset(preset, ctx) {
        const t = traitsOf(preset);
        const hay = (t.name + ' ' + t.tag).toLowerCase();
        const intent = String((ctx && ctx.intent) || '').toLowerCase();
        let score = 0;
        const reasons = [];

        for (const group of INTENT) {
            if (!group.say.some((w) => intent.indexOf(String(w).toLowerCase()) >= 0)) continue;
            const hit = group.want.filter((w) => hay.indexOf(String(w).toLowerCase()) >= 0);
            if (hit.length) {
                score += 20 * Math.min(2, hit.length);
                reasons.push('命中「' + hit.join('/') + '」');
            }
        }
        // 用户直接说了名字里的词（如「拍立得」「邮票」）时给更高权重
        const tokens = intent.split(/[\s,，。;；、/]+/).filter((x) => x.length >= 2);
        for (const token of tokens) {
            if (hay.indexOf(token) >= 0) { score += 16; reasons.push('点名「' + token + '」'); }
        }

        const brief = ctx && ctx.brief;
        if (brief && t.ratio) {
            const target = parseRatio(t.ratio);
            if (target) {
                const diff = Math.abs(Math.log((brief.ar || 1) / target));
                if (diff > 0.18) score -= 35;
                else { score += 4; reasons.push('比例相合'); }
            }
        }
        // 要写文案时，有没有文字位是硬条件：没有文字位再好看也放不下标题。
        const wantsCopy = /标题|文案|日期|参数|签名|字|名字|地点/.test(intent);
        if (wantsCopy) score += t.textSlots ? 10 : -4;
        if (!intent && t.textSlots) score += 2;
        return { preset: preset, score: score, reasons: reasons };
    }

    function shortlist(presets, ctx, limit) {
        const n = Math.max(1, num(limit, 10));
        return (presets || [])
            .filter((p) => p && p.templateName)
            .map((p) => scorePreset(p, ctx))
            .sort((a, b) => b.score - a.score || String(a.preset.templateName).localeCompare(String(b.preset.templateName), 'zh'))
            .slice(0, n);
    }

    // 无 Key / API 失败时的兜底：选得出来，但不编文案（保留预设自带的字）。
    // 「换一批」靠 seed 在得分相近的池子里换起点，不是随机乱挑。
    function localPicks(presets, ctx, count, seed) {
        const want = Math.max(1, num(count, 4));
        const ranked = (presets || [])
            .filter((p) => p && p.templateName)
            .map((p) => scorePreset(p, ctx))
            .sort((a, b) => b.score - a.score || String(a.preset.templateName).localeCompare(String(b.preset.templateName), 'zh'));
        if (!ranked.length) return [];
        // 「换一批」要真的换：先把上一轮出过的款排到后面，剩得够挑就不用它们。
        // ctx.avoid 由面板把 lastRequest.avoid（上一次的模板名）塞进来。
        const avoid = new Set((ctx && Array.isArray(ctx.avoid) ? ctx.avoid : []).map(String));
        const fresh = avoid.size ? ranked.filter((x) => !avoid.has(String(x.preset.templateName))) : ranked;
        const ranked2 = fresh.length >= Math.max(want * 2, 4) ? fresh : ranked;
        // 用户明确要标题/日期时，先把「根本放不下字」的款剔掉：宁可少一个方向，
        // 也不要给出一款文案被静默跳过的方案。数量不够时再放开。
        const wantsCopy = /标题|文案|日期|参数|签名|字|名字|地点/.test(String((ctx && ctx.intent) || ''));
        const textCapable = wantsCopy ? ranked2.filter((x) => traitsOf(x.preset).textSlots > 0) : ranked2;
        const usable = textCapable.length >= want ? textCapable : ranked2;
        const pool = usable.slice(0, Math.max(want * 4, 10));
        // 「换一批」只在同分区间里换顺序：直接从池子中段起跳会把最高分的款漏掉，
        // 用户第一眼看到的反而不是最合适的。
        const tiers = [];
        for (const item of pool) {
            const last = tiers[tiers.length - 1];
            if (last && last[0].score === item.score) last.push(item);
            else tiers.push([item]);
        }
        const off = ((num(seed, 0) >>> 0) % 3);
        const order = [];
        for (const tier of tiers) {
            const k = tier.length > 1 ? (off % tier.length) : 0;
            order.push(...tier.slice(k), ...tier.slice(0, k));
        }
        const picked = [];
        const usedTag = new Set();
        const usedName = new Set();
        // 先保证标签不重复（4 款看起来才像四个方向），不够再用同标签补齐
        for (const strict of [true, false]) {
            for (const item of order) {
                if (picked.length >= want) break;
                const t = traitsOf(item.preset);
                if (usedName.has(t.name)) continue;
                if (strict && usedTag.has(t.tag)) continue;
                const bits = [];
                if (ctx && ctx.brief && ctx.brief.orient) bits.push(ctx.brief.orient + '幅');
                bits.push(item.reasons.length ? item.reasons[0] : t.layout);
                if (wantsCopy && !t.textSlots) bits.push('没有文字位，文案会跳过');
                picked.push({
                    preset: item.preset,
                    why: bits.join('，') + '；' + t.traits,
                    copy: null,
                    fontScale: 1,
                    pad: 0,
                    local: true
                });
                usedTag.add(t.tag);
                usedName.add(t.name);
            }
        }
        return picked;
    }

    function exifText(exif) {
        if (!exif) return '';
        const bits = [clean(exif.make, 20), clean(exif.model, 30)].filter(Boolean).join(' ');
        const shot = [exif.focal, exif.aperture, exif.shutter, exif.iso].filter(Boolean).join(' · ');
        const line = [bits, shot].filter(Boolean).join(' · ');
        return line ? 'EXIF：' + line : '';
    }

    function buildMessages(opts) {
        const o = opts || {};
        const presets = (o.presets || []).filter((p) => p && p.templateName);
        const ctx = { brief: o.brief || null, intent: o.intent || '' };
        const guesses = shortlist(presets, ctx, 8).map((x) => x.preset.templateName);
        const count = Math.max(2, num(o.count, 4));

        const facts = [
            clean(o.briefText, 700),
            exifText(o.exif),
            o.location ? ('地点（用户写过）：' + clean(o.location, 40)) : ''
        ].filter(Boolean).join('\n');

        const system = [
            '你是一位摄影集排版导演。你不设计版式，只从手工边框里挑选、配文、微调留白与字号。',
            '硬规则：',
            '1. 只能从清单里选，preset 必须与清单中的名字逐字一致；编造名字会被丢弃。',
            '2. 输出 ' + count + ' 个方案，彼此要有明显差异：至少 3 个不同标签，照片占比或文字位置也要不同。',
            '3. 只有标了「文字×N」的边框能放文案；给无文字边框写 copy 会被忽略。',
            '4. 文案只写已知事实。不知道地点/日期就不写，不要编相机、地名、人名。',
            '5. 标题 ≤12 字，副标题 ≤20 字，meta ≤24 字；中文标点，不要 emoji。',
            '6. why 要说这张照片的具体依据（比例、明暗、重心、主色），不要写「高级感」「氛围感」这类空话。',
            '7. 按推荐顺序排列，最好的在前。只输出 JSON，不要 markdown 围栏，不要解释。',
            '输出格式：{"picks":[{"preset":"清单里的名字","why":"≤40字","copy":{"title":"","subtitle":"","meta":""},"fontScale":1,"pad":0}]}',
            'fontScale 范围 0.8~1.15（字要更大就调大），pad 范围 -15~15（正数留白更多）。'
        ].join('\n');

        const user = [
            '照片事实：',
            facts || '（没有可用的像素统计，请只依据画面本身判断）',
            '',
            '用户这次想要：' + (clean(o.intent, 120) || '（没说，按照片本身判断）'),
            '',
            '可选边框（括号里是设计特征，只能从这里选）：',
            catalogText(presets),
            '',
            '本地按比例与关键词初选，仅供参考，可以不用：' + (guesses.join('、') || '（无）')
        ];
        // 换一批：明确告诉模型上一轮用过哪些，否则同一句话它往往原样再给一遍。
        const avoid = (Array.isArray(o.avoid) ? o.avoid : []).map((n) => clean(n, 24)).filter(Boolean).slice(0, 8);
        if (avoid.length) user.push('', '上一轮已经出过这几款，这次不要重复：' + avoid.join('、'));
        const parts = [{ type: 'text', text: user.join('\n') }];
        if (o.image && /^data:image\//.test(String(o.image))) {
            parts.push({ type: 'image_url', image_url: { url: o.image } });
        }
        return [
            { role: 'system', content: system },
            { role: 'user', content: parts }
        ];
    }

    function extractJson(raw) {
        let s = String(raw || '').trim();
        if (!s) return null;
        s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
        const tryParse = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };
        let v = tryParse(s);
        if (!v) {
            const a = s.indexOf('{'), b = s.lastIndexOf('}');
            if (a >= 0 && b > a) v = tryParse(s.slice(a, b + 1));
        }
        if (!v) {
            const a = s.indexOf('['), b = s.lastIndexOf(']');
            if (a >= 0 && b > a) v = tryParse(s.slice(a, b + 1));
        }
        return v;
    }

    function nameIndex(presets) {
        const map = new Map();
        const norm = (s) => String(s || '').replace(/[\s·・\-—_（）()【】「」《》"'\u2018\u2019\u201c\u201d]/g, '').toLowerCase();
        for (const p of (presets || [])) {
            if (!p || !p.templateName) continue;
            map.set(norm(p.templateName), p);
        }
        return { map: map, norm: norm };
    }

    function resolvePreset(rawName, presets, index) {
        const idx = index || nameIndex(presets);
        const key = idx.norm(rawName);
        if (!key) return null;
        if (idx.map.has(key)) return idx.map.get(key);
        // 模型偶尔会加后缀（「复古报纸 · 导演版」）或漏字，做一次包含匹配；
        // 多个都包含时取长度最接近的，避免「胶片」误配到「胶片撕裂」这种更长的名字。
        let best = null, bestDiff = Infinity;
        for (const [k, p] of idx.map) {
            if (k.indexOf(key) < 0 && key.indexOf(k) < 0) continue;
            const diff = Math.abs(k.length - key.length);
            if (diff < bestDiff) { best = p; bestDiff = diff; }
        }
        return best;
    }

    function parsePicks(raw, presets) {
        const v = extractJson(raw);
        let arr = [];
        if (Array.isArray(v)) arr = v;
        else if (v && Array.isArray(v.picks)) arr = v.picks;
        else if (v && Array.isArray(v.plans)) arr = v.plans;
        else if (v && typeof v.preset === 'string') arr = [v];
        const index = nameIndex(presets);
        const picks = [];
        const dropped = [];
        const seen = new Set();
        for (const item of arr) {
            if (!item || typeof item !== 'object') continue;
            const preset = resolvePreset(item.preset || item.name, presets, index);
            if (!preset) { dropped.push(clean(item.preset || item.name, 40) || '（无名）'); continue; }
            if (seen.has(preset.templateName)) continue;
            seen.add(preset.templateName);
            const copy = item.copy && typeof item.copy === 'object' ? item.copy : {};
            picks.push({
                preset: preset,
                why: clean(item.why || item.reason, 60),
                copy: {
                    title: clean(copy.title, 16),
                    subtitle: clean(copy.subtitle, 24),
                    meta: clean(copy.meta, 30)
                },
                fontScale: clamp(num(item.fontScale, 1), 0.8, 1.15),
                pad: clamp(num(item.pad, 0), -15, 15)
            });
        }
        return { picks: picks, dropped: dropped };
    }

    // 把文案与两个安全参数写进预设；不改颜色、不改图层、不改照片槽位。
    function composePreset(preset, pick, opts) {
        const out = clone(preset || {});
        const warnings = [];
        const p = pick || {};
        const copy = p.copy || {};
        const values = [copy.title, copy.subtitle, copy.meta].map((x) => clean(x, 40)).filter(Boolean);
        const nav = (opts && opts.nameSuffix) || '';

        if (values.length) {
            const lines = textLinesOf(out);
            if (!lines.length) {
                warnings.push('这款没有文字位，文案已跳过');
            } else {
                if (values.length > lines.length) {
                    warnings.push('只有 ' + lines.length + ' 个文字位，多余的文案已省略');
                }
                // 字号最大的那行通常是标题位：按字阶分配，不按数组顺序猜
                const order = lines.slice().sort((a, b) => num(b.fontSize, 0) - num(a.fontSize, 0));
                order.forEach((line, i) => {
                    const v = values[i];
                    if (v == null) { line.text = ''; return; }
                    const oldLen = String(line.text || '').trim().length || v.length;
                    const ratio = oldLen / Math.max(1, v.length);
                    line.text = v;
                    line.fontSize = Math.max(8, Math.round(num(line.fontSize, 12) * clamp(ratio, 0.62, 1.15) * num(p.fontScale, 1)));
                });
            }
        }

        const pad = num(p.pad, 0);
        const m = out.baseMargin;
        if (pad && m) {
            const keys = ['marginTop', 'marginBottom', 'marginLeft', 'marginRight'];
            const has = keys.some((k) => num(m[k], 0) > 0);
            if (!has) warnings.push('满幅款没有留白可调');
            else for (const k of keys) m[k] = Math.max(0, Math.round(num(m[k], 0) * (1 + pad / 100)));
        }

        if (nav) out.templateName = clean(out.templateName, 40) + nav;
        return { preset: out, warnings: warnings };
    }

    return {
        traitsOf, catalogText, shortlist, localPicks, buildMessages,
        parsePicks, composePreset, extractJson, resolvePreset, exifText
    };
});

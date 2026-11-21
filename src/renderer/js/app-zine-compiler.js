'use strict';
/* 清框影 · 拾景纸刊：把自己的照片编译成一张纸上作品。
 *
 * 方法学是自己的：先读现场（Scene Card），再定"保留什么 / 丢掉什么"，
 * 然后让颜色承担构图工作，最后按目标画布编排。不依赖任何现成 skill 的文本。
 *
 * 两条路径：
 *   collage  实景拼贴：照片作为真实锚点留在成品里，插画从现场长出去
 *   distill  影像蒸馏：照片只当语义来源，成品里不留照片像素
 *
 * compile(brief, opts) → { path, prompt, negative, scene, ratio, share, rationale }
 * 纯函数，不碰 DOM / 网络，Node 可直接测。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.QfsZine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const PATHS = ['collage', 'distill'];
    const RATIOS = ['3:5', '5:3', '4:5', '3:4', '1:1', 'original'];

    // 目标画布：竖照片给 3:5，横照片给 5:3，方/未知给 4:5。用户可以覆盖。
    // 'original' = 严格沿用照片宽高比（钢笔淡彩手账这类预设要求「原比例画幅」）。
    function canvasRatio(brief, want) {
        if (RATIOS.indexOf(want) >= 0) return want;
        const ar = brief && Number(brief.ar);
        if (!ar || !Number.isFinite(ar)) return '3:5';
        if (ar > 1.08) return '5:3';
        if (ar < 0.92) return '3:5';
        return '4:5';
    }

    // 把比例换算成图像接口能吃的尺寸；长边归一到 1536，短边按 64 取整。
    function imageSizeFor(brief, ratio) {
        const known = { '3:5': [1024, 1536], '5:3': [1536, 1024], '4:5': [1216, 1536], '3:4': [1152, 1536], '1:1': [1280, 1280] };
        const hit = known[String(ratio || '')];
        if (hit) return { w: hit[0], h: hit[1] };
        const ar = (brief && Number(brief.ar) > 0) ? Number(brief.ar) : 0.75;
        let w = ar >= 1 ? 1536 : Math.round(1536 * ar);
        let h = ar >= 1 ? Math.round(1536 / ar) : 1536;
        w = Math.round(Math.max(512, Math.min(2048, w)) / 64) * 64;
        h = Math.round(Math.max(512, Math.min(2048, h)) / 64) * 64;
        return { w, h };
    }

    // 从速写里读现场：这是编译器对照片的"理解"，不是色值复读。
    function sceneCard(brief, exif, opts) {
        const b = brief || {};
        const o = opts || {};
        const luma = b.luma || {};
        const dom = b.dominant || {};
        const acc = b.accent || {};
        const cen = b.centroid || {};
        const pal = Array.isArray(b.palette) ? b.palette : [];

        // 主体位置：重心在下半 → 主体偏低，留白在上；反之亦然
        const gy = Number(cen.y);
        const subjectLow = Number.isFinite(gy) && gy > 0.58;
        const subjectHigh = Number.isFinite(gy) && gy < 0.42;
        const quiet = subjectLow ? 'upper' : subjectHigh ? 'lower' : 'side';

        // 主导动势：重心偏左向右看，偏右向左看，居中用垂直
        const gx = Number(cen.x);
        const gesture = Number.isFinite(gx) && gx < 0.4 ? 'rightward'
            : Number.isFinite(gx) && gx > 0.6 ? 'leftward' : 'vertical';

        // 现场色与"加进去的那笔色"的关系：暖底加冷的、冷底加暖的，同源强化
        const domHex = String(dom.hex || '#8a8a8a').toUpperCase();
        const accHex = String(acc.hex || '#c8a04c').toUpperCase();
        const warmBase = warm(domHex);
        const hueRule = o.hueRule || (warmBase ? 'cool-counterpoint' : 'warm-bridge');

        // 视觉重量：暗部多则纸面要更亮、色块更小；高亮多则反之
        const dark = Number(luma.mean) < 100 || Number(luma.shadow) > 0.3;
        const inkArea = dark ? [2, 5] : [4, 8];       // 实色形占整幅 %
        const fieldArea = dark ? [35, 50] : [45, 65]; // 插画场占整幅 %

        return {
            subject: String(o.subject || '').trim(),
            mood: String(o.mood || '').trim(),
            microText: String(o.microText || '').trim(),
            lang: o.lang === 'zh' ? 'zh' : o.lang === 'bi' ? 'bi' : 'en',
            ratio: canvasRatio(brief, o.ratio),
            orientation: b.orient || (Number(b.ar) > 1.08 ? 'landscape' : 'portrait'),
            tone: luma.tone || '中间调',
            contrast: luma.contrast || '中等',
            dominant: { hex: domHex, name: dom.name || '主色', share: Number(dom.share) || 0 },
            accent: { hex: accHex, name: acc.name || '辅色', share: Number(acc.share) || 0 },
            palette: pal.slice(0, 5).map((c) => ({ hex: String(c.hex || '').toUpperCase(), name: c.name || '' })),
            centroid: { x: Number(cen.x) || 0.5, y: Number(cen.y) || 0.5, label: cen.label || '居中' },
            subjectLow, subjectHigh, quiet, gesture, hueRule,
            dark, inkArea, fieldArea,
            exif: pickExif(exif)
        };
    }

    function pickExif(e) {
        if (!e || typeof e !== 'object') return '';
        const bits = [e.make, e.model].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
        const shot = [e.focal, e.aperture, e.shutter, e.iso].map((x) => String(x || '').trim()).filter(Boolean).join(' / ');
        return [bits, shot].filter(Boolean).join(' · ');
    }

    // 判断主色偏暖还是偏冷（粗分，够用）；输入 #RRGGBB
    function warm(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m) return true;
        const n = parseInt(m[1], 16);
        const r = (n >> 16) & 255, b = n & 255;
        return r >= b;
    }

    // 语义最小：一句话说清"这张照片是什么"，供蒸馏路径写命题
    function semanticLine(scene) {
        const who = scene.subject || 'a lone figure';
        const mood = scene.mood || 'quiet residue';
        return `${who} · ${scene.tone} · ${mood}`;
    }

    // 微文字：用户没给就按现场写一句，不编造名人名言、不加日期坐标
    function microText(scene) {
        if (scene.microText) return { text: scene.microText, authored: false };
        const byLang = {
            en: ['Stillness', 'After the rain', 'Far and near', 'Almost home', 'Light, then quiet', 'Passing', 'Between', 'Held'],
            zh: ['静', '雨后', '远处', '光落下来', '刚好', '经过', '留白', '未说完'],
            bi: ['Stillness / 静', 'After the rain / 雨后', 'Far and near / 远近', 'Almost home / 将近']
        };
        const list = byLang[scene.lang] || byLang.en;
        const idx = Math.abs(hash(scene.dominant.hex + scene.centroid.label + scene.tone)) % list.length;
        return { text: list[idx], authored: true };
    }

    function hash(s) {
        let h = 2166136261;
        for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }

    // 加进去的那一笔色：从辅色/主色推，但要"高饱和、承担结构"
    function accentLine(scene) {
        const src = scene.accent.share > 0.06 ? scene.accent : scene.dominant;
        const base = src.hex && src.hex !== '#8A8A8A' ? src.hex : '#C8542D';
        const role = scene.hueRule === 'cool-counterpoint' ? 'a cool complementary counterpoint' : 'a warm bridge against the cool field';
        return `One print ink, saturated ${base}, used as ${role}. It must continue a real contour or silhouette from the scene across the paper boundary, and change the balance or the eye path. Remove it and the composition must visibly weaken.`;
    }

    // ── 原文模式：内置提示词直接进生成器，这里只替换占位符 + 补照片精确数据 ──
    function paletteHexes(brief, n) {
        const pal = (brief && Array.isArray(brief.palette)) ? brief.palette : [];
        const out = [];
        pal.forEach((c) => {
            const h = String((c && c.hex) || '').toUpperCase();
            if (/^#[0-9A-F]{6}$/.test(h) && out.indexOf(h) < 0) out.push(h);
        });
        return out.slice(0, n || 4);
    }
    function tonePhrase(brief) {
        const luma = (brief && brief.luma) || {};
        const mean = Number(luma.mean);
        if (Number.isFinite(mean) && mean < 95) return 'deep night tone';
        const dom = String((brief && brief.dominant && brief.dominant.hex) || '');
        if (dom && warm(dom)) return 'warm daylight tone';
        return 'cool landscape tone';
    }
    function ratioText(ar) {
        const table = [[1, '1:1'], [0.75, '3:4'], [0.8, '4:5'], [2 / 3, '2:3'], [1.5, '3:2'], [4 / 3, '4:3'], [16 / 9, '16:9']];
        let best = table[0], err = Infinity;
        table.forEach((p) => { const d = Math.abs(p[0] - ar); if (d < err) { err = d; best = p; } });
        return err < 0.04 ? best[1] : ar.toFixed(2) + ':1';
    }
    function fillRawPrompt(text, brief, opts) {
        const o = opts || {};
        const subject = String(o.subject || '').trim() || 'the main subject in the photo';
        const pal = paletteHexes(brief, 4);
        const shapes = pal.length >= 2
            ? pal.slice(0, 3).map((h) => 'flat matte ' + h.toLowerCase() + ' irregular blocks').join(', ')
            : 'flat matte dark emerald irregular blocks, flat matte warm brown irregular blocks';
        const swatches = pal.length >= 4 ? pal.join(', ') : '#C9A227, #2E4A32, #8A8A8A, #EDE4D3';
        const value = (key) => {
            if (/主体|巨物/.test(key)) return subject;
            if (/细节约束/.test(key)) return String(o.mood || '').trim();
            if (/平涂色形/.test(key)) return shapes;
            if (/小元素群/.test(key)) return 'small repeated details from the scene';
            if (/主色调/.test(key)) return swatches;
            if (/氛围底色|画面氛围/.test(key)) return tonePhrase(brief);
            if (/比例/.test(key)) return 'original';
            return '';
        };
        return String(text || '')
            .replace(/【([^】]+)】/g, (_m, key) => value(key))
            .replace(/,\s*,/g, ',')
            .replace(/\s+,/g, ',')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
    function referenceLine(brief) {
        const bits = [];
        const pal = paletteHexes(brief, 4);
        if (pal.length) bits.push('Reference palette (exact, from the photo): ' + pal.join(', ') + '.');
        bits.push('Background tone: ' + tonePhrase(brief) + '.');
        const ar = brief && Number(brief.ar);
        if (ar > 0 && Number.isFinite(ar)) bits.push('Original aspect ratio: ' + ratioText(ar) + '.');
        return '\n\n' + bits.join('\n');
    }

    function composeCollage(scene, text) {
        const subject = scene.subject ? ` The identifiable subject is ${scene.subject}; preserve it.` : '';
        return [
            `A flat scanned paper-zine poster, vertical ${scene.ratio} ratio, warm cream aged-paper surface, matte fibers, no frame, no mockup, no 3D depth.`,
            `Keep the supplied photograph truthful as the visual anchor. Its identifiable subject and the essential spatial relationship must survive. Do not trace or redraw the photographic part.${subject}`,
            `Around and partly behind the photo, build an abstract illustration field derived from the same scene: one dominant shape plus one or two quiet supporting marks. Merge repeated detail into broad masses; omit roughly 80 percent of small descriptive detail. The field influences around ${scene.fieldArea[0]}-${scene.fieldArea[1]} percent of the poster but stays mostly unprinted, with generous quiet paper.`,
            `${accentLine(scene)} Keep the saturated area small, about ${scene.inkArea[0]}-${scene.inkArea[1]} percent of the whole poster.`,
            `At the main photo-to-paper handoff, make a visibly hand-torn fibrous edge with warm paper tone showing through; keep it flat, never a uniform frame or a decorative deckled border.`,
            `One quiet micro-text line, ${text.authored ? 'authored from the scene' : 'exactly as supplied'}, language ${scene.lang}: "${text.text}". Small, paper-integrated, not a headline.`,
            `Hard avoids: clean digital clipping, sticker outlines, drop shadows, curled paper, dense scrapbooking, neon, glossy mockups, fake metadata, watermarks, large display typography, extra hues.`
        ].join('\n');
    }

    function composeDistill(scene, text) {
        const prop = scene.subject
            ? `${scene.subject}, ${scene.mood || 'a quiet tension'} — keep this subject recognizable even after abstraction`
            : 'an ordinary moment carrying an unresolved feeling';
        return [
            `An original editorial paper-poster artwork, ${scene.ratio} ratio, flat scan, warm cream paper, no photographic pixels anywhere.`,
            `Artistic proposition: ${prop}. Build one central tension from the scene — nearness and distance coexisting — and leave one relationship deliberately unanswered.`,
            `Use the source only as semantic evidence. Preserve one source-specific gesture and one spatial cue; discard the rest. Reinterpret with one primary illustration grammar: cut-paper mass or broken contour. Remove roughly 70-90 percent of descriptive detail.`,
            `${accentLine(scene)} Keep the saturated area around ${scene.inkArea[0]}-${scene.inkArea[1]} percent of the poster; all other printed forms in neutral charcoal or warm gray ink.`,
            `Let one form cross a torn-paper boundary, or let the subject sit as a clean isolated contour on bare paper. Keep at least 60 percent of the poster as quiet unprinted paper.`,
            `Typography is authorial: ${text.authored ? 'a short line written for this image' : 'the exact supplied wording'}, language ${scene.lang}: "${text.text}". Let it feel discovered on the paper, never a caption or a title block.`,
            `Hard avoids: any photographic fragment, tracing or rotoscoping, universal-symbol cliches, decorative dots or grids, kawaii or anime styling, 3D, cinematic lighting, depth of field, extra hues, watermarks.`
        ].join('\n');
    }

    const NEGATIVE = 'photorealistic skin, glossy render, 3d, lens flare, depth of field, heavy vignette, neon glow, sticker border, drop shadow, curled paper, fake timestamp, serial number, watermark, logo, UI mockup, saturated rainbow, multiple competing accent colors, busy composition, centered clipart, kitsch';

    function compile(brief, opts) {
        const o = opts || {};
        const path = PATHS.indexOf(o.path) >= 0 ? o.path : 'collage';
        const scene = sceneCard(brief, o.exif, o);

        // 原文模式：内置提示词（或用户手写的提示词）已经把创作方法说完了，
        // 不再拼默认的 composeCollage/composeDistill，避免两套指令互相打架。
        // 只做占位符替换、按元数据补比例/负面词，以及可选的照片精确数据。
        if (o.prompt && String(o.prompt).trim()) {
            let prompt = fillRawPrompt(o.prompt, brief, o);
            if (o.augment) prompt += referenceLine(brief, o);
            const ratio = canvasRatio(brief, o.ratio);
            return {
                path, prompt, raw: true, scene,
                negative: String(o.negative || NEGATIVE),
                ratio, size: imageSizeFor(brief, ratio),
                microText: String(o.microText || ''),
                rationale: String(o.rationale || ''),
                needsSourceImage: o.needsSourceImage === undefined ? path === 'collage' : !!o.needsSourceImage,
                chars: prompt.length
            };
        }

        const text = microText(scene);
        const prompt = path === 'collage' ? composeCollage(scene, text) : composeDistill(scene, text);
        const rationale = path === 'collage'
            ? `保留现场关系，把${scene.dominant.name}参照的形与那笔高饱和色延伸到纸面；照片的边缘用撕纸痕作为材料交接。`
            : `只取现场的动势与情绪，用纸片与中性墨重画；那笔颜色承担视线路径，留白里保留一个没有说答案的位置。`;
        return {
            path, prompt, negative: NEGATIVE, scene,
            ratio: scene.ratio,
            size: imageSizeFor(brief, scene.ratio),
            microText: text.text,
            rationale,
            needsSourceImage: path === 'collage',
            chars: prompt.length
        };
    }

    return { compile, sceneCard, canvasRatio, imageSizeFor, fillRawPrompt, referenceLine, microText, accentLine, PATHS, RATIOS, warm, hash, semanticLine };
});

'use strict';
/* 拾景纸刊 · 内置提示词库。
 * 每条是「用户原文 + 生成元数据」，选中后原文直接进 zinePrompt 输入框；
 * 元数据只填 path / ratio / needsSourceImage 等默认值，不改写用户原文。
 * 纯数据 + 纯函数：不碰 DOM/网络，Node 可直接 require 做单测。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.QfsZinePrompts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const CUSTOM_KEY = 'qfs_zine_prompts_custom';
    const SELECTED_KEY = 'qfs_zine_prompt_preset';

    const BUILTIN = [
        {
            id: 'tear-narrative',
            name: '撕口叙事',
            desc: '先读叙事焦点，撕口沿着画面结构生长',
            path: 'collage', ratio: '', lang: 'en', needsSourceImage: true,
            text: [
                '注意以下事项：',
                '先判断照片的叙事焦点。',
                '根据焦点设计撕口，不预设照片必须占 35% 或 50%。',
                '允许只保留人物、局部水面或建筑群。',
                '撕口沿海岸、水线、树冠或建筑结构发展，与原始画面共同营造出空间和层次穿越感。',
                '摄影区域外的插画必须来自同一个场景。',
                '撕口附近先保留原照片色彩，再逐渐转成网点、干刷或丝网印刷。',
                '用一条连续色彩或运动轨迹跨越摄影和插画。',
                '明确禁止矩形贴图、均匀白边和数码蒙版感。'
            ].join('\n')
        },
        {
            id: 'ink-bifold',
            name: '上实下墨明信片',
            desc: '上半实景、下半水墨重构，竖向二分',
            path: 'collage', ratio: '3:5', lang: 'en', needsSourceImage: true,
            text: [
                '2、一张采用竖向二分构图的哑光米白画册明信片。',
                '上半区（实景）：严格保留高清写实摄影风景原貌。完全沿用原始景物的空间布局、物理轮廓及原生低饱和度配色，零改动，维持原生光影质感。',
                '下半区 （水墨重构）：独立的米色留白区域，置入水墨扁平重构插画。提取上半部分全部景物，将其解构为极简几何形态。运用分层平涂的柔和色块，结合毛笔淡墨的晕染笔触，彻底摒弃锐利硬边。严格复刻原图整体色彩调性，但完全剔除所有细碎纹理、冗余杂物及复杂光影，仅保留纯粹的结构神韵。',
                '排版文字：画面最底端，底部居中排版。首行为优雅的衬线手写体英文标题，次行为字号更小的无衬印英文描述短句。',
                '整体质感：基于米白哑光特种纸底色，贯彻大面积留白理念。遵循极简主义东方建筑风景研究的版式逻辑，呈现出干净、克制、高级且具有学术感的视觉效果，无任何多余装饰元素。'
            ].join('\n')
        },
        {
            id: 'surreal-pop',
            name: '超现实波普拼贴',
            desc: '主体保留原色，背景换成巨大平涂色形',
            path: 'collage', ratio: '3:4', lang: 'en', needsSourceImage: true,
            text: [
                '3、超现实主义：@ice cream: surreal pop collage, vertical 3:4,',
                'keep the 【主体】 clearly recognizable, keep its original colors intact, 【可选细节约束：例如：hands empty, no props】,the background replaced by huge flat matte color shapes: 【2‑3个平涂色形+颜色，例：flat matte dark emerald irregular blocks, flat matte warm brown irregular blocks】,one impossible giant element: 【唯一巨物，必须源自原图】,【小元素群】 in graduated sizes following an arc,a few white hand‑drawn graffiti strokes,flat matte colors, no gradients, no shadows, no text, no watermark'
            ].join('\n')
        },
        {
            id: 'abstract-distill',
            name: '离像·色域重构',
            desc: '不出现原图：只取主色与明暗，重画成一张纸刊',
            path: 'distill', ratio: 'original', lang: 'en', needsSourceImage: false,
            text: [
                '参考原图的 4 个主色与明暗重心，重新画一张独立成立的纸刊作品。',
                '原图不出现在成品里：只用它的色彩关系和亮度骨架。',
                '把亮部放成更大的纸片，暗部收成小而重的色块；主形落在原图的视觉重心上。',
                '哑光特种纸底色，丝网印刷式的平涂色块与轻微错位，纸面有淡淡肌理。',
                '底部留白，手写英文标题与短句；不写日期、坐标或假名言。'
            ].join('\n')
        },
        {
            id: 'pen-wash-travel',
            name: '钢笔淡彩手账',
            desc: '钢笔勾线 + 淡彩晕染，外圈随照片氛围自动配色',
            path: 'collage', ratio: 'original', lang: 'en', needsSourceImage: true, augment: true,
            text: [
                '参考我发你的原图制作同比例图片，要求:原比例画幅，钢笔淡彩手账旅行插画，黑色细钢笔轻勾轮廓，低饱和度通透柔和淡彩水彩，画面景物四周不规则水彩晕染慢慢向外自然淡出，无硬边框、无切割分界线、无生硬折痕、无垂直分割线、无隔断，插画外圈留白背景色调跟随参考照片画面氛围自动适配配色，夜景就偏深调、日景暖景就配暖调、冷色风景就配冷调底色，景物与外圈背景平滑过渡完全融为一体。',
                '画面右下角摆放4个圆角方形色卡，色卡严格只提取参考原图当中的4种主色调，每个色卡都是纯色，禁止额外添加无关杂色，简约治愈，城市风景主题，纸面带有淡淡的水彩纸肌理，整体干净柔和。',
                '底部留白构图，添加与原画面符合的英文手写文字标题，标题下面是手写英文短句，字体随性，拒绝数字化。留白不能与原画面有割裂感保留质感，不添加多余装饰元素。'
            ].join('')
        },
        {
            id: 'ink-sketch',
            name: '手绘线稿',
            desc: '把照片重画一遍：淡彩平涂 + 墨线勾形 + 暗部排线',
            path: 'collage', ratio: 'original', lang: 'en', needsSourceImage: true,
            text: [
                '把这张照片重画成一张手绘淡彩，不要保留任何照片像素。',
                '先用低饱和水彩平涂出大色块，边界允许略微溢出色块，不要描边、不要渐变。',
                '再用细墨线勾轮廓：线条有粗细变化和轻微抖动，不是矢量的等宽线。',
                '暗部用排线加深，亮部直接留纸白，不铺色。',
                '整体像画在米白水彩纸上的一页速写，纸纹透在颜料里。'
            ].join('\n')
        }
    ];

    function readStore() {
        try {
            const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
            return Array.isArray(v) ? v.filter((p) => p && typeof p.text === 'string' && p.text.trim()) : [];
        } catch (_) { return []; }
    }
    function writeStore(list) {
        try { localStorage.setItem(CUSTOM_KEY, JSON.stringify((list || []).slice(0, 40))); return true; }
        catch (_) { return false; }
    }
    function all() { return BUILTIN.concat(readStore()); }
    function get(id) { return all().find((p) => p.id === id) || null; }
    function selectedId() { try { return localStorage.getItem(SELECTED_KEY) || ''; } catch (_) { return ''; } }
    function select(id) { try { if (id) localStorage.setItem(SELECTED_KEY, id); else localStorage.removeItem(SELECTED_KEY); } catch (_) {} }
    function save(name, text, meta) {
        const label = String(name || '').trim();
        const body = String(text || '').trim();
        if (!label || !body) return null;
        const p = Object.assign({}, meta || {}, {
            id: 'my:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name: label, desc: '我的提示词', text: body
        });
        const list = readStore();
        list.unshift(p);
        if (!writeStore(list)) return null;
        return p;
    }
    function remove(id) {
        const list = readStore().filter((p) => p.id !== id);
        return writeStore(list);
    }

    return { BUILTIN, CUSTOM_KEY, SELECTED_KEY, all, get, selectedId, select, save, remove };
});

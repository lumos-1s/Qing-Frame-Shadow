'use strict';
/* 模型回复里的方案 JSON 提取器。
 *
 * 各家模型都会往 JSON 外面裹东西：```json 围栏、一句「好的，这是方案：」、
 * 或者把数组塞进 {plans:[...]}。这里做一次宽容解析，解析不出来就返回空数组，
 * 由调用方决定报错文案。纯函数，好测。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FramePlans = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const isDoc = (x) => !!x && typeof x === 'object' && (Array.isArray(x.layers) || Array.isArray(x.aiLayers));

    function tryParse(t) {
        try { return JSON.parse(t); } catch (_) { return null; }
    }
    function sliceBetween(s, open, close) {
        const a = s.indexOf(open), b = s.lastIndexOf(close);
        return a >= 0 && b > a ? s.slice(a, b + 1) : '';
    }

    function plansFromText(raw) {
        let s = String(raw || '').trim();
        if (!s) return [];
        s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
        let v = tryParse(s);
        if (!v) v = tryParse(sliceBetween(s, '[', ']'));
        if (!v) v = tryParse(sliceBetween(s, '{', '}'));
        if (!v) return [];
        if (Array.isArray(v)) return v.filter(isDoc);
        if (Array.isArray(v.plans)) return v.plans.filter(isDoc);
        if (Array.isArray(v.方案)) return v.方案.filter(isDoc);
        if (isDoc(v)) return [v];
        if (v.preset && isDoc(v.preset)) return [v.preset];
        if (v.data && Array.isArray(v.data)) return v.data.filter(isDoc);
        return [];
    }

    return { plansFromText, isDoc };
});

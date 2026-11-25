// 35mm 等效焦距:只使用 EXIF 里相机/手机已经算好的 FocalLengthIn35mmFilm(0xA405),
// 不再按品牌型号猜画幅。勾选后直接用换算值替换实际焦距(35mm → 53mm);
// 没有这个标签时保持实际焦距 —— 错一个数字比不换算更糟。
// 浏览器挂在 window.FocalEq;Node 测试环境走 module.exports。
(function (root) {
    'use strict';

    // "50mm" / "50 mm" / "50" -> 50;解析失败返回 null
    function parseMm(s) {
        const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*mm/i);
        if (m) return parseFloat(m[1]);
        const n = String(s || '').trim();
        return /^\d+(?:\.\d+)?$/.test(n) ? parseFloat(n) : null;
    }

    // 按原图的 35mm 等效值算出当前焦距的等效值。
    // 用户手动改过焦距时,按 autoActual -> actual 的同比例缩放,避免把原图的等效值硬套到新焦距上。
    function equivalentFor(actual, autoActual, focal35) {
        const eq = Number(focal35);
        if (!(eq > 0)) return 0;
        const a = parseMm(actual), b = parseMm(autoActual);
        if (!(a > 0) || !(b > 0)) return 0;
        return Math.round(a * eq / b);
    }

    // 勾选等效焦距后,相机焦距只显示换算值:35mm + 0xA405=53 -> "53mm"。
    // 实际焦距解析失败、没有等效值或全幅(实际=等效)时保持原值。
    // 结果以 "mm" 结尾:部分风格会对 focal 做 replace(/mm$/,'') + 'mm' 的再拼接。
    function format(actual, equivalent) {
        const text = String(actual || '').trim();
        const actualMm = parseMm(text);
        if (!(actualMm > 0)) return text;
        const eq = Math.round(Number(equivalent));
        if (!(eq > 0)) return text;
        return eq + 'mm';
    }

    const api = { parseMm: parseMm, equivalentFor: equivalentFor, format: format };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.FocalEq = api;
})(typeof window !== 'undefined' ? window : globalThis);

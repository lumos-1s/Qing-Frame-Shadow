'use strict';
/* 导出色域的纯像素转换：sRGB → Display P3 / Adobe RGB (1998)。
 * 渲染层和 Node 单测共用；不碰 DOM、不碰 Buffer。
 * 矩阵由三套 CIE xy 原色算出（同为 D65 白点），与 icc-profile.js 生成的 profile 对应。 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else if (root) root.QfsColorSpace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MATRICES = {
        p3: [0.822462, 0.177538, 0, 0.033194, 0.966806, 0, 0.017083, 0.072397, 0.910520],
        adobergb: [0.715126, 0.284874, 0, 0, 1, 0, 0, 0.041162, 0.958838]
    };

    const SRGB_TO_LINEAR = (() => {
        const t = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            const v = i / 255;
            t[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        }
        return t;
    })();

    function makeEncodeLut(fn) {
        const t = new Uint8Array(4096);
        for (let i = 0; i < 4096; i++) t[i] = Math.round(255 * Math.max(0, Math.min(1, fn(i / 4095))));
        return t;
    }
    const ENCODE_LUT = {
        p3: makeEncodeLut((v) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055),
        adobergb: makeEncodeLut((v) => Math.pow(v, 256 / 563))  // gamma 563/256
    };

    // 就地转换 RGBA 像素（alpha 不动）。返回是否真的转换了。
    function convertRgbaInPlace(data, cs) {
        const m = MATRICES[cs], lut = ENCODE_LUT[cs];
        if (!m || !lut || !data) return false;
        const put = (v) => lut[Math.round(Math.max(0, Math.min(1, v)) * 4095)];
        for (let i = 0; i < data.length; i += 4) {
            const r = SRGB_TO_LINEAR[data[i]], g = SRGB_TO_LINEAR[data[i + 1]], b = SRGB_TO_LINEAR[data[i + 2]];
            data[i] = put(m[0] * r + m[1] * g + m[2] * b);
            data[i + 1] = put(m[3] * r + m[4] * g + m[5] * b);
            data[i + 2] = put(m[6] * r + m[7] * g + m[8] * b);
        }
        return true;
    }

    return { MATRICES, SRGB_TO_LINEAR, ENCODE_LUT, convertRgbaInPlace };
});

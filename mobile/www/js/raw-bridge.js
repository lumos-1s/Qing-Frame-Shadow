'use strict';
import LibRaw from './raw/index.js';

// 手机端 RAW 解码桥：浏览器/移动端 Worker 里跑 libraw-wasm。
window.QF_RAW_READY = Promise.resolve(true);

function downsample(cv, max) {
    const scale = Math.min(1, max / Math.max(cv.width, cv.height));
    if (scale === 1) return cv;
    const w = Math.max(1, Math.round(cv.width * scale));
    const h = Math.max(1, Math.round(cv.height * scale));
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(cv, 0, 0, w, h);
    out.naturalWidth = w; out.naturalHeight = h; out.complete = true;
    return out;
}

window.qfRawDecode = async (file) => {
    const raw = new LibRaw();
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await raw.open(bytes);
        let meta = {};
        try { meta = await raw.metadata(true) || {}; } catch (_) {}
        const img = await raw.imageData();
        const w = img.width || img.w, h = img.height || img.h;
        const src = img.data && (img.data.length === w * h * 4 || img.data.length === w * h * 3)
            ? img.data : (img.buffer || img.data);
        const full = document.createElement('canvas');
        full.width = w; full.height = h;
        const ctx = full.getContext('2d');
        if (src && src.length >= w * h * 3) {
            ctx.putImageData(new ImageData(new Uint8ClampedArray(src.buffer || src, 0, w * h * 4), w, h), 0, 0);
        } else {
            // 库返回 3 通道时，手工补 alpha
            const out = ctx.createImageData(w, h);
            for (let i = 0, j = 0; i < out.data.length && j < src.length; i += 4, j += 3) {
                out.data[i] = src[j]; out.data[i + 1] = src[j + 1]; out.data[i + 2] = src[j + 2]; out.data[i + 3] = 255;
            }
            ctx.putImageData(out, 0, 0);
        }
        const el = downsample(full, 1600);
        return {
            el, full, name: file.name, w: el.width, h: el.height,
            grade: null, isRaw: true, rawMeta: meta
        };
    } finally {
        try { raw.dispose(); } catch (_) {}
    }
};

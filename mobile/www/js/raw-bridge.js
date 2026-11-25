'use strict';
import LibRaw from './raw/index.js';

// 手机端 RAW 解码桥：浏览器/移动端 Worker 里跑 libraw-wasm。
window.QF_RAW_READY = Promise.resolve(true);

function downsample(cv, max) {
    const scale = Math.min(1, max / Math.max(cv.width, cv.height));
    // 即使不需要缩放也复制一份：full 会在下一张 RAW 解码时被清零，
    // 如果 el 和 full 是同一个画布，旧照片的预览会跟着一起变空。
    const w = Math.max(1, Math.round(cv.width * scale));
    const h = Math.max(1, Math.round(cv.height * scale));
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(cv, 0, 0, w, h);
    out.naturalWidth = w; out.naturalHeight = h; out.complete = true;
    return out;
}

// libraw-wasm 的 imageData() 可能返回：
//   · 8 位 3 通道（Uint8Array，length = w*h*3）
//   · 8 位 4 通道（Uint8Array，length = w*h*4）
//   · 16 位 3/4 通道（Uint16Array，length = w*h*3 / w*h*4）
// 旧代码只按 w*h*4 取字节视图，3 通道时必然抛
// "RangeError: Invalid typed array length" —— 手机端 RAW 导入 100% 失败。
function toImageData(img, w, h) {
    const data = img && img.data;
    const px = w * h;
    if (!data || !data.length || !px) throw new Error('RAW 解码没有返回像素数据');
    const ch = Math.round(data.length / px);
    const is16 = data.BYTES_PER_ELEMENT === 2 || data instanceof Uint16Array;
    const norm = (v) => {
        const n = is16 ? (v >> 8) : v;
        return n < 0 ? 0 : (n > 255 ? 255 : n);
    };
    // 最常见的 8 位 RGBA 直接复用内存，避免再拷 4 字节/像素
    if (!is16 && ch === 4) {
        return new ImageData(
            new Uint8ClampedArray(data.buffer, data.byteOffset || 0, px * 4), w, h);
    }
    const out = new ImageData(w, h);
    const o = out.data;
    for (let i = 0, p = 0; i < px; i++, p += 4) {
        const s = i * ch;
        if (ch >= 3) {
            o[p] = norm(data[s]);
            o[p + 1] = norm(data[s + 1]);
            o[p + 2] = norm(data[s + 2]);
            o[p + 3] = ch >= 4 ? norm(data[s + 3]) : 255;
        } else {
            const g = norm(data[s]);
            o[p] = g; o[p + 1] = g; o[p + 2] = g; o[p + 3] = 255;
        }
    }
    return out;
}

window.qfRawRgbToCanvas = (data, w, h) => {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').putImageData(toImageData({ data }, w, h), 0, 0);
    cv.naturalWidth = w; cv.naturalHeight = h; cv.complete = true;
    return cv;
};

window.qfRawDecode = async (file) => {
    const raw = new LibRaw();
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // 手机内存优先：先解半尺寸代理（6240px 的 ARW 半尺寸仍有 3120px，
        // 再缩到 1600 预览足够锐），避免一次 putImageData 就吃掉 100MB+。
        // 原文件保留在返回对象的 file 上，将来需要全尺寸导出时可重新解码。
        await raw.open(bytes, { halfSize: true });
        let meta = {};
        try { meta = await raw.metadata(true) || {}; } catch (_) {}
        const img = await raw.imageData();
        const w = Number(img.width || img.w) || 0;
        const h = Number(img.height || img.h) || 0;
        if (!w || !h) throw new Error('RAW 解码尺寸无效');
        const full = document.createElement('canvas');
        full.width = w; full.height = h;
        // 手机内存红线：同时只保留一张 RAW 的大图。释放旧画布时把所属照片的
        // full 也置空，别留下一个 width=0 的假画布让后续导出画出空白。
        if (window.QF_LAST_RAW_FULL && window.QF_LAST_RAW_FULL !== full) {
            const prev = window.QF_LAST_RAW_FULL;
            if (prev.__qfOwner) prev.__qfOwner.full = null;
            try { prev.width = 0; prev.height = 0; } catch (_) {}
        }
        window.QF_LAST_RAW_FULL = full;
        full.getContext('2d').putImageData(toImageData(img, w, h), 0, 0);
        const el = downsample(full, 1600);
        const out = {
            el, full, file, name: file.name, w: el.width, h: el.height,
            grade: null, isRaw: true, rawMeta: meta
        };
        full.__qfOwner = out;
        return out;
    } finally {
        try { raw.dispose(); } catch (_) {}
    }
};

'use strict';
/* 手机端全尺寸导出：预览常驻 1600px 代理，导出前才按需重新解一张原图。
   同一时刻只保留一张全尺寸画布；调用方在渲染/编码结束后必须调用 release()。
   长边上限 6000px：24MP 原片（6000×4000）能原样导出，再大的图会等比缩到 6000，
   避免 8K 画布在低内存手机上把 WebView 直接撑崩。 */
(function () {
    const MAX_EDGE = 6000;

    function longEdge(cv) {
        if (!cv) return 0;
        return Math.max(Number(cv.naturalWidth) || Number(cv.width) || 0,
            Number(cv.naturalHeight) || Number(cv.height) || 0);
    }

    function markCanvas(cv, w, h) {
        cv.naturalWidth = w; cv.naturalHeight = h; cv.complete = true;
        return cv;
    }

    function drawToCanvas(img, maxEdge) {
        const iw = Number(img.naturalWidth) || Number(img.width) || 0;
        const ih = Number(img.naturalHeight) || Number(img.height) || 0;
        if (!iw || !ih) throw new Error('图片尺寸无效');
        const k = (maxEdge > 0) ? Math.min(1, maxEdge / Math.max(iw, ih)) : 1;
        const w = Math.max(1, Math.round(iw * k));
        const h = Math.max(1, Math.round(ih * k));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        return markCanvas(cv, w, h);
    }

    // 只负责生成缩小副本；src 是否释放由调用方决定（im.full 是常驻代理，不能在这里清掉）
    function shrinkCanvas(src, maxEdge) {
        const long = longEdge(src);
        if (!long || long <= maxEdge) return src;
        const k = maxEdge / long;
        const w = Math.max(1, Math.round((src.naturalWidth || src.width) * k));
        const h = Math.max(1, Math.round((src.naturalHeight || src.height) * k));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(src, 0, 0, w, h);
        return markCanvas(cv, w, h);
    }

    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                try { URL.revokeObjectURL(url); } catch (_) {}
                resolve(img);
            };
            img.onerror = () => {
                try { URL.revokeObjectURL(url); } catch (_) {}
                reject(new Error('图片格式无法解码'));
            };
            img.src = url;
        });
    }

    async function decodeFile(file) {
        const img = await loadImage(file);
        return drawToCanvas(img, MAX_EDGE);
    }

    // 返回 { canvas, changed, capped, fallback, release() }
    // canvas 可能是 im.el（无需升级）、im.full（RAW 半尺寸兜底）或新解的全尺寸画布。
    window.qfFullSource = async function (im) {
        const el = im && im.el ? im.el : null;
        if (!im || !el) return null;

        const srcLong = Math.max(Number(im.srcW) || 0, Number(im.srcH) || 0)
            || (im.isRaw && im.full ? longEdge(im.full) * 2 : 0)
            || longEdge(el);
        const curLong = longEdge(el);
        const wanted = Math.min(srcLong || curLong || 1600, MAX_EDGE);
        const capped = !!(srcLong && srcLong > MAX_EDGE);

        // 已经是全尺寸（或没有原文件可重解）时直接用当前画布
        if (!im.file || !wanted || curLong >= wanted) {
            return {
                canvas: el, changed: false, capped,
                fallback: false, release() {}
            };
        }

        let canvas = null;
        let fallback = false;
        let owned = false;
        try {
            if (im.isRaw && typeof window.qfRawDecodeFull === 'function') {
                canvas = await window.qfRawDecodeFull(im.file);
                owned = true;
            } else if (im.heic && typeof window.qfHeicDecode === 'function') {
                canvas = await window.qfHeicDecode(im.file);
                owned = true;
            } else {
                canvas = await decodeFile(im.file);
                owned = true;
            }
        } catch (e) {
            console.warn('[mobile] full-size decode failed', e);
            fallback = true;
            // HEIC 在 Android WebView 里系统解不了：导入时走的就是 WASM，
            // 这里再兜一次，覆盖旧版本导入/系统解码抽风的情况。
            if (!im.isRaw && !im.heic && window.qfIsHeicName
                && window.qfIsHeicName(im.name) && typeof window.qfHeicDecode === 'function') {
                try {
                    canvas = await window.qfHeicDecode(im.file);
                    owned = true;
                    fallback = false;
                } catch (e2) {
                    console.warn('[mobile] HEIC full-size decode failed', e2);
                }
            }
            if (!canvas) {
                // RAW 至少还有半尺寸代理；普通图片回到 1600px 预览
                canvas = (im.isRaw && im.full && im.full.width) ? im.full : el;
                owned = false;
            }
        }

        if (canvas && canvas !== el && longEdge(canvas) > MAX_EDGE) {
            const big = canvas;
            canvas = shrinkCanvas(big, MAX_EDGE);
            // 只释放本次新解的大图；im.full 是常驻代理，不能顺手清掉
            if (owned && big !== canvas) {
                try { big.width = 0; big.height = 0; } catch (_) {}
            }
            owned = true;
        }

        const changed = canvas !== el;
        return {
            canvas,
            changed,
            capped,
            fallback,
            release() {
                if (!owned || !changed) return;
                try { canvas.width = 0; canvas.height = 0; } catch (_) {}
            }
        };
    };

    window.qfFullMaxEdge = MAX_EDGE;
})();

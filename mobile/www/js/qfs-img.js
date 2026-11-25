// 统一图片加载入口。
//
// 为什么必须走这里：照片是经 `qflocal://` 协议读的，而页面本身是 `file://` ——
// 两者不同源。不加 `crossOrigin` 就把图片画进 canvas 的话，画布会被标记为 tainted，
// 之后 getImageData / toBlob / toDataURL 一律抛
//   SecurityError: Tainted canvases may not be exported
// 表现出来就是：调色读不到像素、裁切点确定报错、导出直接失败。
//
// 设了 crossOrigin='anonymous' 后请求走 CORS 模式，主进程的 qflocal 响应带
// Access-Control-Allow-Origin，图片即被视为「可用于导出」；data:/blob: 图片设了也无害。
(function () {
    window.qfsImage = function (src) {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        if (src) im.src = src;
        return im;
    };

    // 把离屏画布转成可长期持有的 Image —— 所有「改像素」的操作（旋转、EXIF 方向
    // 校正、裁切）都必须走这里，不要再各自 toDataURL。
    //
    // 为什么只能是 PNG：JPEG 没有 alpha 通道，编码时透明像素会被当成黑色写进去。
    // 主照片旋转 / EXIF 方向校正以前用 toDataURL('image/jpeg')，于是带透明区域、
    // 圆角或羽化边缘的 PNG 一旋转就出现黑块（用户看到的「图片变黑」）；裁切一直
    // 用 PNG，所以没这毛病。统一入口后三处不再分叉。
    //
    // 用 blob URL 而不是 dataURL：大图的 base64 字符串会多占约 33% 内存，
    // blob 交给浏览器管理即可。decode 完成才 revoke，避免懒解码时拿到空图。
    window.qfsCanvasImage = function (canvas) {
        return new Promise((resolve) => {
            let asked = false;
            const fail = () => { if (!asked) { asked = true; resolve(null); } };
            try {
                canvas.toBlob((blob) => {
                    if (asked) return;
                    if (!blob) { fail(); return; }
                    const url = URL.createObjectURL(blob);
                    const im = window.qfsImage();
                    const finish = (ok) => {
                        if (asked) return;
                        asked = true;
                        URL.revokeObjectURL(url);
                        resolve(ok && im.naturalWidth ? im : null);
                    };
                    im.onload = () => {
                        if (im.decode) im.decode().then(() => finish(true), () => finish(true));
                        else finish(true);
                    };
                    im.onerror = () => finish(false);
                    im.src = url;
                }, 'image/png');
            } catch (_) {
                // 画布被 tainted（跨域又没走 qflocal）时 toBlob 会抛 SecurityError：
                // 宁可让调用方提示失败，也别把半张黑图换上去。
                fail();
            }
        });
    };

    // 采样统计「有内容的像素」比例（32×32 缩略，成本可忽略）。
    // 用途：旋转 / EXIF 校正是把源图 drawImage 到新画布，若源图设了
    // decoding='async' 又还没解码完，drawImage 可能画出一张全透明空画布；
    // 旧代码再把它编码成 JPEG，就是一整片不透明纯黑（用户看到的「变黑」）。
    // 前后各量一次即可区分「本来就是透明图」和「这次根本没画上」。
    // 画布被 tainted 时 getImageData 会抛错，返回 null = 不知道，不拦截。
    window.qfsOpaqueRatio = function (src) {
        if (!src) return null;
        const w = src.naturalWidth || src.width || 0;
        const h = src.naturalHeight || src.height || 0;
        if (!w || !h) return null;
        const c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!g) return null;
        try {
            g.drawImage(src, 0, 0, 32, 32);
            const d = g.getImageData(0, 0, 32, 32).data;
            let opaque = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
            return opaque / (32 * 32);
        } catch (_) { return null; }
    };

    // 便于确认当前进程跑的是不是含旋转修复的代码：
    // 开发者工具控制台输入 window.QFS_ROTATE_FIX，返回 undefined 就是旧进程/旧版本。
    window.QFS_ROTATE_FIX = 'rotate-fast-v4-20261111';

    // 一次性拿到「有内容比例」和「不透明近黑比例」。
    //
    // 为什么不能沿用 qfsOpaqueRatio 的 drawImage(整图 → 32×32)：
    // 对一张刚 drawImage 画完的 24MP 画布，那一步要先把它整张落定/读回，
    // 6000×4000 实测 140ms/次；而 getImageData 只读**请求的那几行**，同样图上 0.7ms。
    // 旋转一次要判两次（源图 + 结果），正好差出 ~300ms —— 也就是用户感觉到的「慢」。
    //
    // canvas 源走条带；Image 源读不到像素，只能退回缩放采样（~140ms）——
    // 那条路径只在「结果异常、回头诊断源图」时才走，正常旋转碰不到。
    window.qfsAlphaStats = function (src) {
        if (!src) return null;
        const w = src.naturalWidth || src.width || 0;
        const h = src.naturalHeight || src.height || 0;
        if (!w || !h) return null;
        const isCanvas = typeof src.getContext === 'function';
        if (!isCanvas) {
            // Image：先缩到小画布再读。保持老口径（32×32），只合并成一次遍历。
            const c = document.createElement('canvas');
            c.width = 32; c.height = 32;
            const g = c.getContext('2d', { willReadFrequently: true });
            if (!g) return null;
            try {
                g.drawImage(src, 0, 0, 32, 32);
                const d = g.getImageData(0, 0, 32, 32).data;
                let opaque = 0, black = 0;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 3] > 8) opaque++;
                    if (d[i + 3] > 200 && d[i] + d[i + 1] + d[i + 2] < 45) black++;
                }
                return { opaque: opaque / 1024, black: black / 1024, samples: 1024, method: 'scale' };
            } catch (_) { return null; }
        }
        const g = src.getContext('2d');
        if (!g) return null;
        // 8 条 × 2px：24MP 上总共 6.4 万样本，足够判「全空 / 全黑」——
        // 要区分的是"根本没画上"和"整片纯黑"，不是统计细节。
        // 16×4 要遍历 38 万像素，纯 JS 循环本身就吃掉几十毫秒，不值。
        const bands = 8;
        const bh = Math.max(1, Math.min(2, h));
        const span = Math.max(1, h - bh);
        let opaque = 0, black = 0, n = 0;
        try {
            for (let b = 0; b < bands; b++) {
                const y = Math.round((b + 0.5) * span / bands);
                const d = g.getImageData(0, y, w, bh).data;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 3] > 8) opaque++;
                    if (d[i + 3] > 200 && d[i] + d[i + 1] + d[i + 2] < 45) black++;
                }
                n += d.length / 4;
            }
        } catch (_) { return null; }
        if (!n) return null;
        return { opaque: opaque / n, black: black / n, samples: n, method: 'bands' };
    };

    // 把离屏画布直接当成图源交出去 —— 旋转、EXIF 方向校正这类**纯几何**操作
    // 根本不需要经过一次 PNG 压缩再解码。以前统一走 qfsCanvasImage：
    // 24MP 的 toBlob('image/png') 要 471ms，再重载解码 25ms，全花在「给像素搬家」上，
    // 而真正转那一下只要 13ms。
    //
    // 下游一律按 HTMLImageElement 读 el，所以这里把 canvas 缺的几个字段补齐
    // （engine.js 里的烘焙画布早就是这么干的）：naturalWidth/naturalHeight 给
    // 各处算比例用，complete 给预设墙的「这张图能出图吗」判断用 ——
    // canvas 没有 complete 会得到 undefined，`!undefined` 直接把整面墙判成未就绪。
    //
    // src 故意不伪造：canvas 没有 URL 可言，下游读 im.el.src 的地方已经各自兜底
    // （缩略图占位 / 预设墙缓存 key / 壁纸兜底都是 `|| ''`）。
    window.qfsCanvasSource = function (canvas) {
        if (!canvas) return null;
        if (!canvas.width || !canvas.height) return null;
        if (canvas.naturalWidth !== canvas.width) {
            try { canvas.naturalWidth = canvas.width; } catch (_) { /* 只读属性就跳过 */ }
        }
        if (canvas.naturalHeight !== canvas.height) {
            try { canvas.naturalHeight = canvas.height; } catch (_) { /* 同上 */ }
        }
        if (canvas.complete === undefined) {
            try { canvas.complete = true; } catch (_) { /* 同上 */ }
        }
        return canvas;
    };

    // ── 几何操作日志与重放 ──
    // 旋转/裁切以前只留下「换掉后的那张位图」：撤销栈不认它，草稿也没有它，
    // 于是 Ctrl+Z 撤不掉、重启后照片悄悄回到没裁没转的样子。
    // 这里把操作记成纯数字参数，任何时候都能从原图按序重放出同一张位图；
    // 渲染/导出/拼图/缩略图仍只认 im.el，不用改五条消费链。
    window.qfsGeoRotate = function (src, opts) {
        const w = src.naturalWidth || src.width || 0;
        const h = src.naturalHeight || src.height || 0;
        if (!w || !h) return null;
        const c = document.createElement('canvas');
        c.width = h; c.height = w;
        const g = c.getContext('2d', opts && opts.willReadFrequently ? { willReadFrequently: true } : undefined);
        if (!g) return null;
        g.imageSmoothingQuality = 'high';
        g.translate(h / 2, w / 2);
        g.rotate(Math.PI / 2);
        g.drawImage(src, -w / 2, -h / 2);
        return c;
    };

    // op 里存的都是数字，不依赖裁切弹层的状态：
    //   sw/sh = 被裁源图尺寸，W/H = 旋转后的取景平面，rad = 总旋转角，
    //   x/y/w/h = 取整后的裁切框，reset = 这次是从「还原原图」开始裁的。
    window.qfsGeoCrop = function (src, op, base) {
        const w = Math.max(1, Math.round(op.w));
        const h = Math.max(1, Math.round(op.h));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        if (!g) return null;
        g.imageSmoothingQuality = 'high';
        const from = op.reset && base ? base : src;
        if (op.rad) {
            g.translate(-op.x, -op.y);
            g.translate(op.W / 2, op.H / 2);
            g.rotate(op.rad);
            g.drawImage(from, -op.sw / 2, -op.sh / 2);
        } else {
            g.drawImage(from, op.x, op.y, w, h, 0, 0, w, h);
        }
        return c;
    };

    // 从原图按序重放所有几何操作。返回结果直接可以交给 im.el / im.w / im.h。
    window.qfsApplyGeo = function (base, ops) {
        let el = base;
        let w = base.naturalWidth || base.width || 0;
        let h = base.naturalHeight || base.height || 0;
        let turns = 0;
        for (const op of (ops || [])) {
            let c = null;
            if (op && op.t === 'r') { c = window.qfsGeoRotate(el); turns = (turns + 1) % 4; }
            else if (op && op.t === 'c') { c = window.qfsGeoCrop(el, op, base); turns = op.reset ? 0 : turns; }
            if (!c) continue;
            el = window.qfsCanvasSource(c);
            w = c.width; h = c.height;
        }
        return { el, w, h, turns };
    };

    // 画布是否「每个像素都完全不透明」。JPEG 没有 alpha 通道：只要有一个
    // alpha<255 的像素，直接 toDataURL('image/jpeg') 就会把它写成黑块。
    // 用 8 条横带 + 四个角取样；任何一处发现半透明就交给铺白底的路径。
    window.qfsAllOpaque = function (canvas) {
        if (!canvas || !canvas.width || !canvas.height || typeof canvas.getContext !== 'function') return false;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        if (!g) return false;
        const w = canvas.width, h = canvas.height;
        const probe = (x, y, bw, bh) => {
            const d = g.getImageData(x, y, bw, bh).data;
            for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false;
            return true;
        };
        try {
            for (let b = 0; b < 8; b++) {
                const y = Math.min(h - 1, Math.round((b + 0.5) * (h - 1) / 8));
                if (!probe(0, y, w, 1)) return false;
            }
            // 圆角 / 羽化边框的透明区常常只在最角上，横带可能刚好绕开
            if (!probe(0, 0, 2, 2) || !probe(w - 2, 0, 2, 2)
                || !probe(0, h - 2, 2, 2) || !probe(w - 2, h - 2, 2, 2)) return false;
        } catch (_) { return false; }
        return true;
    };

    // 不透明且近黑的像素比例。旋转前后各量一次，就能识别「源图正常、
    // 结果却整片纯黑」这种任何上游异常（解码 / 驱动 / 内存）都可能出现的坏图。
    window.qfsBlackRatio = function (src) {
        if (!src) return null;
        const w = src.naturalWidth || src.width || 0;
        const h = src.naturalHeight || src.height || 0;
        if (!w || !h) return null;
        const c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!g) return null;
        try {
            g.drawImage(src, 0, 0, 32, 32);
            const d = g.getImageData(0, 0, 32, 32).data;
            let black = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] > 200 && d[i] + d[i + 1] + d[i + 2] < 45) black++;
            }
            return black / (32 * 32);
        } catch (_) { return null; }
    };
})();

'use strict';
/* 溢出警示：把「高光顶到 255 / 暗部压到 0」的像素直接涂在照片上。
 *
 * 为什么要有
 * ─────────────────────────────────────────────────────────────
 * 直方图两角的小三角只回答「有多少」，不回答「在哪里」。修高光时真正要判断的
 * 是「哪块云先糊成一片」，这只能看图。Camera Raw 用 O / U 分开关高光与阴影，
 * Lightroom 用 J 一键把两者同时涂出来 —— 这里对齐 J，一个键、两种颜色：
 * 高光红、暗部蓝。
 *
 * 怎么画
 * ─────────────────────────────────────────────────────────────
 * 1) 取调色后的预览（im._grade.low / canvas），缩到长边 1280 取样；
 * 2) 逐像素判「任一通道顶到白端 / 压到 0」→ 红 / 蓝，其余全透明；判定与直方图
 *    两角三角同口径（任一通道即算剪切），白端是 254 不是 255 —— 这条烘焙管线
 *    的顶封在 254，只认 255 会把一整片过曝天空漏成 0.0%；
 * 3) 得到一张**照片坐标**的警示图，再按 engine 写的 app._photoRect 贴到画布上。
 *    这样边框、留白、照片在画布里的位置全都不用重算，蒙版层也不会被盖住。
 *
 * 为什么不画进 previewCanvas
 * ─────────────────────────────────────────────────────────────
 * 画进去就会跟着导出、跟着「对比原图」一起出现，而且每帧都要重扫像素。警示
 * 是观察工具，只该活在屏幕上：单独一层 DOM canvas，导出路径根本读不到它。
 *
 * 性能
 * ─────────────────────────────────────────────────────────────
 * 1280 长边 ≈ 90 万像素，扫一遍约 6~10ms；拖动滑块时按 110ms 节流，与直方图
 * 同频，不跟画布抢帧。关闭状态下一个像素都不读。
 */
(function () {
    const SAMPLE_MAX = 1280;
    const MIN_GAP = 110;
    // 警示色不透明度：盖住像素但留一点明暗层次，密集溢出区才看得出结构
    const ALPHA = 236;
    const HI_RGB = [240, 36, 36];
    const LO_RGB = [40, 104, 255];

    let on = false;
    // 「对比原图」/蒙版「原图预览」时画面不是调色结果，警示必须跟着收起来。
    // 这里不存标志位，直接问 App 的当前状态 —— 两条入口（空格对比、蒙版原图）
    // 各写各的标志，存一份本地副本迟早会打架（松手后还留着「已抑制」）。
    const sup = () => {
        const A = app();
        return !!(A && (A.draggingCompare || A._maskPreviewOriginal));
    };

    let ov = null, octx = null;
    let badge = null, badgeHi = null, badgeLo = null, btn = null;

    // 警示像素图（照片坐标，长边 ≤ SAMPLE_MAX）
    let mapCv = null, mctx = null, mapW = 0, mapH = 0, mapSrc = null;
    let pct = { hi: 0, lo: 0 };

    let timer = 0, lastAt = 0, pending = null, lastIm = null;
    let geomSig = '';
    let retryT = 0, retries = 0;

    const now = () => (window.performance && performance.now ? performance.now() : Date.now());
    const $ = (id) => document.getElementById(id);
    const app = () => window.App || null;

    function ensure() {
        if (!ov) {
            ov = $('clipOverlay');
            badge = $('clipBadge');
            badgeHi = $('clipBadgeHi');
            badgeLo = $('clipBadgeLo');
            btn = $('btnClipWarn');
            if (ov) octx = ov.getContext('2d');
        }
        return !!octx;
    }

    // 警示图取哪张像素：优先 low（1600px 降采样，拖动时屏幕上就是这一张），
    // 没有才退到全尺寸烘焙 / 原图。参数归零时 low/canvas 还挂着上一次的结果，
    // 必须回原图，否则重置后警示还停在旧位置（与直方图同一个坑）。
    function srcOf(im) {
        if (!im) return null;
        const g = im._grade;
        if (g && !g.neutral) return g.low || g.canvas || null;
        return im.el || null;
    }

    function build(im) {
        const src = srcOf(im);
        if (!src) return false;
        // 参数刚改、烘焙还没落地：宁可先空着，也不能拿原图当真值涂一遍
        if (src === mapSrc) return true;
        const iw = src.naturalWidth || src.width || 0;
        const ih = src.naturalHeight || src.height || 0;
        if (!iw || !ih) return false;
        const k = Math.min(1, SAMPLE_MAX / Math.max(iw, ih));
        const w = Math.max(1, Math.round(iw * k));
        const h = Math.max(1, Math.round(ih * k));
        if (!mapCv) {
            mapCv = document.createElement('canvas');
            mctx = mapCv.getContext('2d', { willReadFrequently: true });
            if (!mctx) return false;
        }
        if (mapW !== w || mapH !== h) {
            mapW = w; mapH = h;
            mapCv.width = w; mapCv.height = h;
        }
        mctx.setTransform(1, 0, 0, 1, 0, 0);
        mctx.clearRect(0, 0, w, h);
        mctx.imageSmoothingEnabled = true;
        mctx.imageSmoothingQuality = 'high';
        try { mctx.drawImage(src, 0, 0, w, h); } catch (_) { return false; }
        let img;
        try { img = mctx.getImageData(0, 0, w, h); } catch (_) { return false; }
        const d = img.data;
        let hi = 0, lo = 0;
        for (let i = 0, n = d.length; i < n; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            // 高光判 254：这条烘焙管线的白端实测封顶在 254（纯白过一遍调色出来是
            // 254,254,254）。只认 255 的话，整片过曝的天空会一个红点都没有 ——
            // 那不是「没溢出」，是判定漏了。暗部仍是 0，纯黑过调色不变。
            if (r >= 254 || g >= 254 || b >= 254) {
                d[i] = HI_RGB[0]; d[i + 1] = HI_RGB[1]; d[i + 2] = HI_RGB[2]; d[i + 3] = ALPHA;
                hi++;
            } else if (r === 0 || g === 0 || b === 0) {
                d[i] = LO_RGB[0]; d[i + 1] = LO_RGB[1]; d[i + 2] = LO_RGB[2]; d[i + 3] = ALPHA;
                lo++;
            } else {
                // 非溢出像素：只清 alpha，RGB 随便留着（透明即不可见）
                d[i + 3] = 0;
            }
        }
        try { mctx.putImageData(img, 0, 0); } catch (_) { return false; }
        mapSrc = src;
        const total = w * h || 1;
        pct = { hi: hi / total, lo: lo / total };
        return true;
    }

    // 叠加层几何：与蒙版层同一套算法 —— 直接按画布的**视觉矩形**摆，
    // 不复制 canvas.style（缩放/平移/侧栏收缩都有一条路径没写到就会跑位）。
    function syncGeometry(force) {
        if (!ensure()) return false;
        const A = app();
        const cv = A && A.dom && A.dom.canvas;
        if (!cv) return false;
        const cr = cv.getBoundingClientRect();
        if (!(cr.width > 0) || !(cr.height > 0)) return false;
        const host = ov.parentElement;
        const hr = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
        const bl = host ? (host.clientLeft || 0) : 0;
        const bt = host ? (host.clientTop || 0) : 0;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const bw = Math.max(1, Math.round(cr.width * dpr));
        const bh = Math.max(1, Math.round(cr.height * dpr));
        const sig = [cr.left - hr.left, cr.top - hr.top, cr.width, cr.height, bw, bh].join(',');
        if (!force && sig === geomSig && ov.width === bw && ov.height === bh) return true;
        geomSig = sig;
        ov.style.left = (cr.left - hr.left - bl) + 'px';
        ov.style.top = (cr.top - hr.top - bt) + 'px';
        ov.style.right = 'auto';
        ov.style.bottom = 'auto';
        ov.style.margin = '0';
        ov.style.width = Math.max(1, cr.width) + 'px';
        ov.style.height = Math.max(1, cr.height) + 'px';
        ov.style.transform = 'none';
        // 改 width/height 会清空画布，所以 paint() 必须在这之后重画
        if (ov.width !== bw || ov.height !== bh) {
            ov.width = bw;
            ov.height = bh;
        }
        return true;
    }

    function paint() {
        if (!on) return;
        if (!syncGeometry()) return;
        const g = octx;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, ov.width, ov.height);
        if (sup() || !mapCv) return;
        const A = app();
        const pr = A && A._photoRect;
        if (!pr || !(pr.w > 0) || !(pr.h > 0)) { retryPaint(); return; }
        const base = (typeof A._baseSize === 'function') ? A._baseSize() : { w: ov.width, h: ov.height };
        const sx = ov.width / Math.max(1, base.w);
        const sy = ov.height / Math.max(1, base.h);
        const x = pr.x * sx, y = pr.y * sy, w = pr.w * sx, h = pr.h * sy;
        // 放大时关掉插值：溢出边界要是硬边（插值会糊出一圈粉色光晕）；
        // 缩小时开着，否则稀疏的警示点会被抽掉，看着像没溢出。
        g.imageSmoothingEnabled = w < mapW;
        g.imageSmoothingQuality = 'high';
        g.drawImage(mapCv, 0, 0, mapW, mapH, x, y, w, h);
    }

    // 刚打开时 engine 可能还没写完 _photoRect（比如首帧正在排），补一次即可
    function retryPaint() {
        if (retryT || retries > 6) return;
        retries++;
        retryT = setTimeout(() => {
            retryT = 0;
            if (on && !sup()) paint();
        }, 150);
    }

    function fmtPct(v) {
        const p = v * 100;
        if (!p) return '0%';
        if (p < 0.1) return '<0.1%';
        return p.toFixed(p < 10 ? 1 : 0) + '%';
    }

    function paintBadge() {
        if (badgeHi) badgeHi.textContent = fmtPct(pct.hi);
        if (badgeLo) badgeLo.textContent = fmtPct(pct.lo);
        if (badge) badge.hidden = !on;
    }

    function rebuild(im) {
        if (!on || sup()) return;
        const t = im || (app() && app().image);
        if (!t) { paintBadge(); return; }
        lastIm = t;
        if (build(t)) paint();
        paintBadge();
    }

    function fire() {
        timer = 0;
        lastAt = now();
        const im = pending || lastIm || (app() && app().image);
        pending = null;
        rebuild(im);
    }

    function refresh(im) {
        if (!on || sup()) return;
        const A = app();
        const t = im || (A && A.image);
        if (!t) return;
        pending = t;
        if (timer) return;
        // 节流：领先一次、之后至少隔 MIN_GAP，与直方图同频
        timer = setTimeout(fire, Math.max(0, MIN_GAP - (now() - lastAt)));
    }

    function syncBtn() {
        if (!btn) return;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('is-on', on);
        btn.title = on
            ? '溢出警示已开：红＝高光顶到 255，蓝＝暗部压到 0（J 关闭）'
            : '溢出警示：高光顶到 255 涂红、暗部压到 0 涂蓝（J）';
    }

    function setOn(v) {
        const next = !!v;
        const A = app();
        if (next && !(A && A.image)) {
            if (A && A.setStatus) A.setStatus('溢出警示：先打开一张照片');
            return false;
        }
        if (!ensure()) return false;
        const changed = next !== on;
        on = next;
        retries = 0;
        syncBtn();
        if (!on) {
            pct = { hi: 0, lo: 0 };
            if (octx && ov) {
                octx.setTransform(1, 0, 0, 1, 0, 0);
                octx.clearRect(0, 0, ov.width, ov.height);
            }
            if (badge) badge.hidden = true;
            if (changed && A && A.setStatus) A.setStatus('溢出警示已关闭');
            return true;
        }
        rebuild(A.image);
        if (A && A.setStatus) {
            A.setStatus('溢出警示：红＝高光顶到 255，蓝＝暗部压到 0；只显示在屏幕上，导出不含');
        }
        return true;
    }

    function toggle() { return setOn(!on); }

    // 对比/原图预览开关时由调用方喊一声，这里只按 App 的**当前**状态重贴一次。
    // 不做「谁抑制了」的记账：两个入口各写各的标志，记账版本在
    // 「空格对比中途又勾了原图预览」这种叠法下会把抑制状态留在打开的一侧。
    function setSuppressed() {
        if (!on) return;
        const s = sup();
        if (s) {
            if (octx && ov) {
                octx.setTransform(1, 0, 0, 1, 0, 0);
                octx.clearRect(0, 0, ov.width, ov.height);
            }
        } else {
            // 退出对比：重新贴一次（期间参数可能已经变了）
            refresh(lastIm || (app() && app().image));
        }
    }

    // 视图变了（缩放/平移/窗口）：几何重算 + 重贴，不重扫像素
    function sync() {
        if (!on) return;
        if (syncGeometry()) paint();
    }

    function init() {
        ensure();
        syncBtn();
        if (btn && !btn._clipBound) {
            btn._clipBound = true;
            btn.addEventListener('click', () => toggle());
        }
        if (!init._keyBound) {
            init._keyBound = true;
            document.addEventListener('keydown', (e) => {
                if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
                if (String(e.key || '').toLowerCase() !== 'j') return;
                const A = app();
                if (A && A._immersionOpen) return;
                // 与 setupShortcuts 同一口径：文本框/数字输入里不抢键，range 滑块不算打字
                const el = document.activeElement;
                const tag = (el && el.tagName) || '';
                let typing = !!(el && el.isContentEditable);
                if (tag === 'INPUT') {
                    const itype = String(el.type || 'text').toLowerCase();
                    typing = ['text', 'search', 'number', 'password', 'email', 'url', 'tel'].includes(itype);
                } else if (tag === 'TEXTAREA') {
                    typing = true;
                }
                if (typing) return;
                e.preventDefault();
                toggle();
            });
        }
    }

    window.QfsClip = {
        init,
        toggle,
        setOn,
        setSuppressed,
        refresh,
        redraw() { if (on) rebuild((app() && app().image) || lastIm); },
        sync,
        isOn() { return on; },
        // 测试用：不读画布像素，直接拿最近一次扫描的结论
        stats() { return { hi: pct.hi, lo: pct.lo, w: mapW, h: mapH, ready: !!mapSrc }; }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();

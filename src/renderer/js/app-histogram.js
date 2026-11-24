'use strict';
/* 调色页签顶部：RGB 直方图 + EXIF 参数条（对齐 Camera Raw 的面板顶部）
 *
 * 为什么把直方图放在这里
 * ─────────────────────────────────────────────────────────────
 * 调色是「看结果」的活：高光推没推爆、暗部压没压死，数字看不出来，直方图一眼就懂。
 * 之前面板一打开就是 11 个滑块，用户只能凭感觉拖；参考图（Camera Raw）把
 * 直方图 + 参数条固定在面板最上方，滑块再往下排，视线顺序是对的。
 *
 * 取哪一张像素
 * ─────────────────────────────────────────────────────────────
 * 取「调色之后」的预览（im._grade.canvas / im._grade.low），所以拖滑块时直方图
 * 会跟着变；参数归零（neutral）时 low/full 可能还挂着上一次的烘焙结果，必须
 * 回退到原图 im.el，否则重置后直方图还是旧形状。
 *
 * 性能
 * ─────────────────────────────────────────────────────────────
 * 采样到长边 180px（约 2 万像素）再统计，一帧 < 1ms；拖动时按 120ms 节流，
 * 不跟画布渲染抢帧。页签收起（offsetWidth 为 0）时直接跳过。
 */
(function () {
    const BINS = 256;
    const SAMPLE_MAX = 180;
    const MIN_GAP = 120;

    let cv = null;
    let ctx = null;
    let exifEl = null;
    let smp = null;
    let sctx = null;
    let timer = 0;
    let lastAt = 0;
    let pending = null;
    let lastImage = null;
    // 点两角三角后，在波形上把被 capEnds 夹掉的首尾档单独标一根竖条
    let showClip = false;
    let clipBound = false;

    const $ = (id) => document.getElementById(id);

    function ensure() {
        if (cv && ctx) return true;
        cv = $('gradeHisto');
        exifEl = $('gradeExif');
        if (!cv) return false;
        ctx = cv.getContext('2d');
        smp = document.createElement('canvas');
        sctx = smp.getContext('2d', { willReadFrequently: true });
        if (ctx && window.ResizeObserver) {
            // 参数栏可拖宽：宽度一变就重画，否则图会被拉糊
            new ResizeObserver(() => { if (lastImage) refresh(lastImage); }).observe(cv);
        }
        if (!clipBound) {
            clipBound = true;
            for (const id of ['gradeClipLo', 'gradeClipHi']) {
                const b = $(id);
                if (!b) continue;
                b.addEventListener('click', () => {
                    showClip = !showClip;
                    for (const x of ['gradeClipLo', 'gradeClipHi']) {
                        const e = $(x);
                        if (e) e.classList.toggle('is-mark', showClip);
                    }
                    if (lastImage) refresh(lastImage);
                });
            }
        }
        return !!ctx && !!sctx;
    }

    function srcOf(im) {
        if (!im) return null;
        const g = im._grade;
        if (g && !g.neutral) return g.canvas || g.low || im.el || null;
        return im.el || null;
    }

    function sample(src) {
        const iw = src.naturalWidth || src.width || 0;
        const ih = src.naturalHeight || src.height || 0;
        if (!iw || !ih) return null;
        const k = Math.min(1, SAMPLE_MAX / Math.max(iw, ih));
        const w = Math.max(1, Math.round(iw * k));
        const h = Math.max(1, Math.round(ih * k));
        smp.width = w;
        smp.height = h;
        sctx.clearRect(0, 0, w, h);
        try { sctx.drawImage(src, 0, 0, w, h); } catch (_) { return null; }
        try { return sctx.getImageData(0, 0, w, h).data; } catch (_) { return null; }
    }

    function collect(data) {
        const r = new Uint32Array(BINS);
        const g = new Uint32Array(BINS);
        const b = new Uint32Array(BINS);
        const y = new Uint32Array(BINS);
        let total = 0, lo = 0, hi = 0;
        for (let i = 0; i < data.length; i += 4) {
            const R = data[i], G = data[i + 1], B = data[i + 2];
            r[R]++; g[G]++; b[B]++;
            // 亮度用 ITU-R BT.601 的整数近似，够画图用
            y[(R * 77 + G * 150 + B * 29) >> 8]++;
            total++;
            // 与溢出警示同口径：三通道同时到端点才算「失去细节」的过曝/过暗。
            // 任一通道到端点只是饱和色（饱和红/饱和蓝还有层次），不算溢出 ——
            // 否则偏色照片两角三角常亮，和画面上实际涂出来的红蓝也对不上。
            //
            // 高光端判 254 而不是 255：这条烘焙管线的白端实测封顶在 254。
            // 拿纯白（255,255,255）过一遍调色，输出是 (254,254,254)；只认 255
            // 的话，一整片过曝的天空会报 0.0%，两角三角永远不亮（用户实测的坑）。
            // 暗部没有这个问题：纯黑过调色仍是 0，所以仍判 0。
            if (!R && !G && !B) lo++;
            if (R >= 254 && G >= 254 && B >= 254) hi++;
        }
        return { r, g, b, y, total, lo, hi, loAll: lo, hiAll: hi };
    }

    // 3-bin 均值：单像素级的尖刺会让整张直方图看起来像噪声
    function smooth(a) {
        const out = new Float32Array(BINS);
        for (let i = 0; i < BINS; i++) {
            out[i] = ((a[i - 1] || 0) + a[i] * 2 + (a[i + 1] || 0)) / 4;
        }
        return out;
    }

    // 归一化基准取 1..254：整片纯黑/纯白时 bin0/bin255 会吞掉所有高度，
    // 中间调被压成一条线，直方图就失去意义了。
    function peak(a) {
        let m = 0;
        for (let i = 1; i < BINS - 1; i++) if (a[i] > m) m = a[i];
        return m || 1;
    }

    function paint(stat) {
        const clipLo = stat.total ? stat.lo / stat.total : 0;
        const clipHi = stat.total ? stat.hi / stat.total : 0;
        const rect = cv.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const W = Math.max(1, Math.round(rect.width * dpr));
        const H = Math.max(1, Math.round(rect.height * dpr));
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);

        // 四分之一的竖线：帮助判断「中间调在哪」，比刻度文字安静
        ctx.strokeStyle = 'rgba(255,255,255,.06)';
        ctx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) {
            const x = Math.round(W * i / 4) + 0.5;
            ctx.beginPath();
            ctx.moveTo(x, 2);
            ctx.lineTo(x, H - 2);
            ctx.stroke();
        }

        const base = H - 2;
        const span = base - 6;
        // 只描「曲线」本身，不描闭合出来的底边：否则每条通道都会在底部
        // 拉一根横线，看着像直方图自带的边框。
        const trace = (arr, max) => {
            ctx.beginPath();
            ctx.moveTo(0, base);
            for (let i = 0; i < BINS; i++) {
                // 0.55 次幂：暗部/亮部的尾巴也能看见，纯线性会只剩中间一根柱子
                const v = Math.pow(Math.min(1, arr[i] / max), 0.55);
                ctx.lineTo((i / (BINS - 1)) * W, base - v * span);
            }
        };
        const fillUnder = (arr, max) => {
            trace(arr, max);
            ctx.lineTo(W, base);
            ctx.closePath();
            ctx.fill();
        };

        // 首尾两档单独夹一下：纯黑/纯白的像素常常占掉几个百分点，
        // 按真实高度画就是贴在边上的一根满高柱子，会把整张图挤扁。
        // 截断信息交给两角的小三角，柱子本身只画到相邻档的高度。
        const capEnds = (a) => [
            Math.min(a[0], a[1] || 0),
            ...a.slice(1, BINS - 1),
            Math.min(a[BINS - 1], a[BINS - 2] || 0)
        ];

        const ys = smooth(capEnds(stat.y));
        ctx.fillStyle = 'rgba(226,232,226,.13)';
        fillUnder(ys, peak(ys));

        const chans = [
            { a: smooth(capEnds(stat.r)), fill: 'rgba(255,72,72,.40)', line: 'rgba(255,120,120,.85)' },
            { a: smooth(capEnds(stat.g)), fill: 'rgba(64,210,120,.40)', line: 'rgba(110,230,160,.85)' },
            { a: smooth(capEnds(stat.b)), fill: 'rgba(72,132,255,.44)', line: 'rgba(120,170,255,.88)' }
        ];
        // 加色叠加：三通道重合处发白，和 Camera Raw 的观感一致
        ctx.globalCompositeOperation = 'lighter';
        for (const c of chans) {
            const max = peak(c.a);
            ctx.fillStyle = c.fill;
            fillUnder(c.a, max);
            ctx.strokeStyle = c.line;
            ctx.lineWidth = 1;
            trace(c.a, max);
            ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';

        // capEnds 把首尾两档夹掉了（不然整片纯黑会把图挤扁）。点两角角标时
        // 在这里把这两档单独标出来，信息不丢，也不用去动画布渲染。
        if (showClip) {
            const bw = Math.max(2, Math.round(W / 128));
            if (clipLo > 0.002) { ctx.fillStyle = 'rgba(120,170,255,.45)'; ctx.fillRect(0, 0, bw, H); }
            if (clipHi > 0.002) { ctx.fillStyle = 'rgba(255,123,110,.45)'; ctx.fillRect(W - bw, 0, bw, H); }
        }
    }

    // 溢出角标：常驻两角，数据超阈值点亮。口径与画面上的红蓝块一致 ——
    // 三通道同时烧白/压黑才算过曝/过暗，饱和色不算。
    function setClip(stat) {
        const pct = (n) => (stat.total ? (n / stat.total) * 100 : 0);
        const set = (id, numId, side, any, end) => {
            const el = $(id);
            if (!el) return;
            const p = pct(any);
            el.classList.toggle('is-on', p > 0.2);
            el.dataset.pct = p.toFixed(2);
            el.dataset.allPct = p.toFixed(2);
            el.title = side + '溢出（' + end + '）' + p.toFixed(2) + '% · 点击在波形上标出端点';
            const num = $(numId);
            if (num) {
                // 阈值比角标点亮更低：0.1% 已经值得看见，但 0% 不占位置。
                num.hidden = p < 0.05;
                num.textContent = side + ' ' + p.toFixed(1) + '%';
            }
        };
        set('gradeClipLo', 'gradeClipNumLo', '暗部', stat.lo, '压黑');
        set('gradeClipHi', 'gradeClipNumHi', '高光', stat.hi, '烧白');
    }

    function setExif(im) {
        if (!exifEl) return;
        const e = (im && im.exif) || null;
        const parts = [];
        if (e) {
            // 自动识别给的是「ISO100」，手动参数条可能只写了「100」，统一补上前缀
            if (e.iso) {
                const iso = String(e.iso).trim();
                parts.push(/^ISO/i.test(iso) ? iso.replace(/^ISO\s*/i, 'ISO ') : 'ISO ' + iso);
            }
            const fl = e.focal || (e.focal35 ? e.focal35 + 'mm' : '');
            if (fl) parts.push(String(fl));
            if (e.aperture) parts.push(String(e.aperture));
            if (e.shutter) parts.push(String(e.shutter));
        }
        const key = parts.join('|');
        if (exifEl._exifKey === key) return;
        exifEl._exifKey = key;
        exifEl.textContent = '';
        if (!parts.length) {
            const span = document.createElement('span');
            span.className = 'he-empty';
            span.textContent = '未读取到 EXIF 参数';
            exifEl.appendChild(span);
            return;
        }
        parts.forEach((text, i) => {
            if (i) {
                const sep = document.createElement('span');
                sep.className = 'he-sep';
                sep.textContent = '·';
                exifEl.appendChild(sep);
            }
            const span = document.createElement('span');
            span.textContent = text;
            exifEl.appendChild(span);
        });
    }

    function fire() {
        timer = 0;
        lastAt = performance.now();
        const im = pending;
        pending = null;
        if (!im) return;
        setExif(im);
        // 页签没露出来（display:none）时画布宽度是 0，画了也看不到
        if (!cv || !cv.offsetWidth) return;
        const src = srcOf(im);
        if (!src) return;
        const data = sample(src);
        if (!data) return;
        const stat = collect(data);
        paint(stat);
        setClip(stat);
    }

    function refresh(im) {
        if (!ensure()) return;
        const target = im || (window.App && window.App.image) || null;
        if (!target) return;
        pending = target;
        lastImage = target;
        if (timer) return;
        // 节流：领先一次、之后至少隔 MIN_GAP 再画，拖动时不跟画布抢帧
        timer = setTimeout(fire, Math.max(0, MIN_GAP - (performance.now() - lastAt)));
    }

    window.QfsHistogram = {
        refresh,
        redraw() { if (lastImage) refresh(lastImage); },
        // 测试用：拿到最近一次统计，不依赖 canvas 像素（离屏读像素在不同 GL 后端下不稳定）
        statsOf(im) {
            const src = srcOf(im || (window.App && window.App.image));
            const data = src ? sample(src) : null;
            return data ? collect(data) : null;
        },
        clipOf(im) {
            const src = srcOf(im || (window.App && window.App.image));
            const data = src ? sample(src) : null;
            if (!data) return null;
            const st = collect(data);
            const n = st.total || 1;
            return { lo: st.lo / n, hi: st.hi / n, loAll: st.loAll / n, hiAll: st.hiAll / n, total: st.total };
        },
        clipMarked() { return showClip; }
    };
})();

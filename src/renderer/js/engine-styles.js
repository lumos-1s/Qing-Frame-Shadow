// 相框样式引擎(原版 BorderProcessor.java 移植,阶段一)
// 严格对齐原版:BorderProcessor.apply() 的 size 折算(size*2 → min边/1000 缩放)、cornerRadius 后处理
// (ROUNDED 用四角、其余统一圆角且 BLUR_CLASSIC/BLUR_DATE 不裁角)、try/catch 失败回退原图、
// addGradient 用 extractDominantColors(直方图 16bin + 平均亮度 35~225 + bin 距离≥30)。
// 阶段一 = 无相机/无 Logo 美术依赖的纯几何风格;文本类/Logo 类风格后续分批,未实现时渲染中性底+风格名。

(function () {
    'use strict';

    const DISPLAY_MAX = 1800;
    const NOW = new Date();

    function pad0(n) { return n < 10 ? '0' + n : '' + n; }
    function dateYMD() { return NOW.getFullYear() + '.' + pad0(NOW.getMonth() + 1) + '.' + pad0(NOW.getDate()); }
    function dateTimeYMD() {
        return dateYMD() + ' ' + pad0(NOW.getHours()) + ':' + pad0(NOW.getMinutes()) + ':' + pad0(NOW.getSeconds());
    }

    // ── 工具 ──
    function newCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = Number.isFinite(w) ? Math.max(1, Math.round(w)) : 1;
        c.height = Number.isFinite(h) ? Math.max(1, Math.round(h)) : 1;
        return c;
    }

    // 原版 apply(): scaled = max(5, size*2.0); ref=min(w,h); scaled = max(5, scaled*ref/1000)
    function scaledSize(img, size) {
        let scaled = Math.max(5, Math.floor(size * 2.0));
        const ref = Math.min(img.naturalWidth, img.naturalHeight);
        scaled = Math.max(5, Math.floor(scaled * ref / 1000.0));
        return scaled;
    }

    function rgbaC(c) { return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + (c.a == null ? 1 : c.a) + ')'; }
    function rgbJ(r, g, b) { return 'rgb(' + r + ',' + g + ',' + b + ')'; }

    // 文本度量(近似 Java FontMetrics:ascent≈0.78em,descent≈0.22em)
    function measureText(ctx, text, px, mono) {
        ctx.save();
ctx.font = px + 'px ' + (mono ? 'monospace' : 'sans-serif');
        const w = ctx.measureText(text).width;
        ctx.restore();
        return { w, ascent: Math.round(px * 0.78), descent: Math.round(px * 0.22), height: Math.round(px) };
    }
    function drawText(ctx, text, x, y, px, fill, mono, bold) {
        ctx.save();
        if (bold) ctx.font = 'bold ' + px + 'px ' + (mono ? 'monospace' : 'sans-serif');
        else ctx.font = px + 'px ' + (mono ? 'monospace' : 'sans-serif');
        ctx.fillStyle = fill;
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    // ── 图像主色(原版 extractDominantColors,16bin)──
    function smallImage(img, maxEdge) {
        const iw = Math.max(1, img.naturalWidth || 1);
        const ih = Math.max(1, img.naturalHeight || 1);
        const sw = Math.min(maxEdge, iw);
        const sh = Math.max(1, Math.round(sw * ih / iw));
        const c = newCanvas(sw, sh);
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.drawImage(img, 0, 0, sw, sh);
        return { c, g, sw, sh };
    }
    function extractDominant(img) {
        const key = imgKey(img) + ':dom';
        if (_domCache[key]) return _domCache[key];
        const { g, sw, sh } = smallImageCached(img, 64);
        const { data } = g.getImageData(0, 0, sw, sh);
        const bins = 16;
        const hist = {};
        for (let i = 0; i < sw * sh; i++) {
            const r = data[i * 4], gv = data[i * 4 + 1], b = data[i * 4 + 2];
            const ri = Math.floor(r * bins / 256);
            const gi = Math.floor(gv * bins / 256);
            const bi = Math.floor(b * bins / 256);
            const key = ri + ',' + gi + ',' + bi;
            hist[key] = (hist[key] || 0) + 1;
        }
        const list = [];
        for (const k in hist) {
            const p = k.split(',').map(Number);
            const avg = (p[0] * 256 / bins + p[1] * 256 / bins + p[2] * 256 / bins) / 3;
            if (avg < 35 || avg > 225) continue;
            list.push({ ri: p[0], gi: p[1], bi: p[2], count: hist[k] });
        }
        list.sort((a, b) => b.count - a.count);
        const toColor = b => ({ r: Math.min(255, b.ri * 256 / bins + 8), g: Math.min(255, b.gi * 256 / bins + 8), b: Math.min(255, b.bi * 256 / bins + 8) });
        if (!list.length) { const fb = [{ r: 100, g: 180, b: 255 }, { r: 255, g: 180, b: 100 }]; _domCache[key] = fb; return fb; }
        const f = list[0];
        let s = null;
        for (let i = 1; i < list.length; i++) {
            const d = Math.sqrt(Math.pow(list[i].ri - f.ri, 2) + Math.pow(list[i].gi - f.gi, 2) + Math.pow(list[i].bi - f.bi, 2));
            if (d >= 30) { s = list[i]; break; }
        }
        if (!s) s = f;
        const res = [toColor(f), toColor(s)];
        _domCache[key] = res;
        return res;
    }

    // ── 模糊(原版 fastBlur:降采样 → 高斯核卷积 → 双线性放大)──
    // 与 Java fastBlur 同算法:ks 高斯核(sigma=ks/4)、EDGE_NO_OP、二值线性插值放大。
    function fastBlurCanvas(src, radius) {
        const radiusN = Math.max(1, radius);
        const w = src.width, h = src.height;
        const scale = Math.max(1, Math.floor(radiusN / 6));
        const sw = Math.max(1, Math.floor(w / scale)), sh = Math.max(1, Math.floor(h / scale));
        if (sw === w && sh === h) { return src; }
        const small = newCanvas(sw, sh);
        const sg = small.getContext('2d');
        sg.imageSmoothingEnabled = true;
        sg.drawImage(src, 0, 0, sw, sh);
        let kSize = Math.max(3, Math.floor(radiusN / scale));
        if (kSize % 2 === 0) kSize++;
        const blurred = gaussianFilter(small, kSize);
        const out = newCanvas(w, h);
        const og = out.getContext('2d');
        og.imageSmoothingEnabled = true;
        og.drawImage(blurred, 0, 0, w, h);
        return out;
    }
    // Java fastBlur 的高斯核卷积(EDGE_NO_OP):sigma=ks/4,kernel 归一化
    // 优化:二维核(k×k)拆成可分离两遍(横 k + 竖 k),1D 核按 ks 缓存,结果与二维版一致
    const _gaussKernel = {};
    function gauss1DKernel(ks) {
        let k = _gaussKernel[ks];
        if (k) return k;
        const hl = Math.floor(ks / 2);
        const sigma = ks / 4;
        const raw = [];
        let sum = 0;
        for (let i = 0; i < ks; i++) {
            const v = Math.exp(-(Math.pow(i - hl, 2)) / (2 * sigma * sigma));
            raw.push(v); sum += v;
        }
        const kk = new Float64Array(ks);
        for (let i = 0; i < ks; i++) kk[i] = raw[i] / sum;
        k = { kk, hl };
        _gaussKernel[ks] = k;
        return k;
    }
    function gaussianFilter(srcCanvas, ks) {
        const iw = srcCanvas.width, ih = srcCanvas.height;
        const ctx = srcCanvas.getContext('2d');
        const src = ctx.getImageData(0, 0, iw, ih);
        const d = src.data;
        const { kk, hl } = gauss1DKernel(ks);
        // 横过一遍:左右边缘列保持原值(EDGE_NO_OP)
        const tmp = new Uint8ClampedArray(d.length);
        for (let y = 0; y < ih; y++) {
            const yb = y * iw;
            for (let x = 0; x < iw; x++) {
                const oi = (yb + x) * 4;
                if (x < hl || x >= iw - hl) {
                    tmp[oi] = d[oi]; tmp[oi + 1] = d[oi + 1]; tmp[oi + 2] = d[oi + 2]; tmp[oi + 3] = d[oi + 3];
                    continue;
                }
                let r = 0, g = 0, b = 0, a = 0;
                for (let kx = 0; kx < ks; kx++) {
                    const si = (yb + x - hl + kx) * 4;
                    const kv = kk[kx];
                    // Java 的 alpha 分量也参与卷积;RGB 按预乘权重叠加
                    a += d[si + 3] * kv;
                    r += d[si] * kv; g += d[si + 1] * kv; b += d[si + 2] * kv;
                }
                tmp[oi] = r; tmp[oi + 1] = g; tmp[oi + 2] = b; tmp[oi + 3] = a;
            }
        }
        // 竖过一遍:上下边缘行/左右边缘列均保持原值 → 边界环与二维版一致
        const out = new Uint8ClampedArray(d.length);
        for (let y = 0; y < ih; y++) {
            const yb = y * iw;
            for (let x = 0; x < iw; x++) {
                const oi = (yb + x) * 4;
                if (y < hl || y >= ih - hl || x < hl || x >= iw - hl) {
                    out[oi] = d[oi]; out[oi + 1] = d[oi + 1]; out[oi + 2] = d[oi + 2]; out[oi + 3] = d[oi + 3];
                    continue;
                }
                let r = 0, g = 0, b = 0, a = 0;
                for (let ky = 0; ky < ks; ky++) {
                    const si = ((y - hl + ky) * iw + x) * 4;
                    const kv = kk[ky];
                    a += tmp[si + 3] * kv;
                    r += tmp[si] * kv; g += tmp[si + 1] * kv; b += tmp[si + 2] * kv;
                }
                out[oi] = r; out[oi + 1] = g; out[oi + 2] = b; out[oi + 3] = a;
            }
        }
        src.data.set(out);
        ctx.putImageData(src, 0, 0);
        return srcCanvas;
    }

    // ── 渲染缓存(对齐 Java ConvolveOp/取色缓存):照片不变时模糊底与取色结果不重算 ──
    // 带上限的取色缓存。调色后 imgKey 会带上内容签名，每拖一次滑块就产生新 key；
    // 这些缓存原本只在切图/裁切时整体清空，长时间调色会一路堆条目。超过 64 条就
    // 整表清空重来 —— 存的都是 64px 缩略图 / 直方图，重算成本可以忽略。
    function boundedCache() {
        const store = {};
        return new Proxy(store, {
            set(t, k, v) {
                if (!Object.prototype.hasOwnProperty.call(t, k) && Object.keys(t).length >= 64) {
                    Object.keys(t).forEach((old) => delete t[old]);
                }
                t[k] = v;
                return true;
            }
        });
    }
    const _smallCache = boundedCache();
    const _edgeCache = boundedCache();
    const _bottomCache = boundedCache();
    const _domCache = boundedCache();
    const _multiCache = boundedCache();
    // 调色后的取源是 Canvas（没有 src），而且同一个 canvas 对象会被反复重绘。
    // 只按尺寸做 key 会让所有调色画面共用一个取色缓存 —— 艺术卡右下角色卡永远
    // 停在第一次取色，拖调色滑块"不能实时调整"。photoSrcOf 会把当前烘焙签名
    // （参数 + 源图版本）打在 _qfsGradeKey 上，纳入 key 即可精准失效；
    // 原图仍走 src，未调色时的缓存行为完全不变。
    const imgKey = img => {
        if (!img) return '';
        const ver = img._qfsGradeKey ? '#' + img._qfsGradeKey : '';
        return (img.src ? img.src : 'canvas') + ver + '@' + img.naturalWidth + 'x' + img.naturalHeight;
    };
    function smallImageCached(img, maxEdge) {
        const key = imgKey(img) + ':' + maxEdge;
        let e = _smallCache[key];
        if (!e) { e = smallImage(img, maxEdge); _smallCache[key] = e; }
        return e;
    }
    function clearStyleCaches() {
        for (const k in _smallCache) delete _smallCache[k];
        for (const k in _edgeCache) delete _edgeCache[k];
        for (const k in _bottomCache) delete _bottomCache[k];
        for (const k in _domCache) delete _domCache[k];
        for (const k in _multiCache) delete _multiCache[k];
        for (const k in _gaussKernel) delete _gaussKernel[k];
    }

    // ── 圆角后处理(原版 applyCornerRadius 单个/四角)──
    function roundRectPath(g, x, y, w, h, r) {
        x = x || 0; y = y || 0;
        g.beginPath();
        if (g.roundRect) { g.roundRect(x, y, w, h, r, r); return; }
        g.moveTo(x + r, y); g.lineTo(x + w - r, y);
        g.arcTo(x + w, y, x + w, y + r, r); g.lineTo(x + w, y + h - r);
        g.arcTo(x + w, y + h, x + w - r, y + h, r); g.lineTo(x + r, y + h);
        g.arcTo(x, y + h, x, y + h - r, r); g.lineTo(x, y + r);
        g.arcTo(x, y, x + r, y, r); g.closePath();
    }
    function singleCornerClip(src, radius) {
        const w = src.width, h = src.height;
        const r = Math.min(radius, Math.floor(Math.min(w, h) / 2));
        if (r <= 0) return src;
        const out = newCanvas(w, h);
        const g = out.getContext('2d');
        roundRectPath(g, 0, 0, w, h, r);
        g.clip();
        g.drawImage(src, 0, 0);
        return out;
    }

    // 9 参数的「画照片某个区域」：源矩形是按 natural 坐标写的，但拖动时 photoSrc
    // 给的是 1600px 的降采样烘焙画布 —— 直接传会超界，Chrome 按边界裁掉一块，
    // 玻璃条/漫画格里的照片就变成放大的一角。这里按「位图/自然」比把源矩形缩回去。
    function drawPhotoRegion(ctx, img, natW, natH, sx, sy, sw, sh, dx, dy, dw, dh) {
        const isBmp = !window.QFS_LEGACY_PHOTO_DRAW && !!(img && img.tagName === 'CANVAS');
        const kx = isBmp ? Math.max(1, img.width) / Math.max(1, natW) : 1;
        const ky = isBmp ? Math.max(1, img.height) / Math.max(1, natH) : 1;
        ctx.drawImage(img, sx * kx, sy * ky, sw * kx, sh * ky, dx, dy, dw, dh);
    }

    // ── 阶段一核心风格(纯几何/颜色,无相机无 Logo)──
    function styleSimple(img, size, g, iw, ih) {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, iw + size * 2, ih + size * 2);
        g.drawImage(img, size, size);
    }
    function styleWhitePlain(img, size, g, iw, ih) {
        g.fillStyle = '#cccccc';
        g.fillRect(0, 0, iw + size * 2, ih + size * 2);
        g.drawImage(img, size, size);
        g.strokeStyle = '#dddddd';
        g.lineWidth = 1;
        g.strokeRect(size - 1, size - 1, iw + 2, ih + 2);
    }
    function styleRounded(img, size, g, iw, ih) {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, iw + size * 2, ih + size * 2);
        g.drawImage(img, size, size);
    }
    function styleFilmStrip(img, size, g, iw, ih) {
        const railH = Math.max(20, size), sprocket = Math.max(6, Math.floor(railH / 4)), gap = sprocket * 2;
        const w = iw + size * 2, h = ih + railH * 2;
        g.fillStyle = '#000000';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#ffffff';
        for (let x = size + Math.floor(gap / 2); x < w - size; x += sprocket + gap) {
            g.fillRect(x, Math.floor(railH / 2 - sprocket / 2), sprocket, sprocket);
            g.fillRect(x, Math.floor(h - railH / 2 - sprocket / 2), sprocket, sprocket);
        }
        g.drawImage(img, size, railH);
    }
    function stylePolaroid(img, size, g, iw, ih, S) {
        const fs = Math.max(10, Math.round(autoExifSize(S.paramFs, iw)));
        const bottom = Math.max(size * 3, Math.round(fs * 2.6));
        const w = iw + size * 2, h = ih + size + bottom;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const date = (S && S.polaroidCaption) ? S.polaroidCaption : dateYMD();
        let fs2 = fs;
        const m = measureText(g, date, fs2, true);
        // 自定义文字可能很长:超出白条宽度则按比例缩字号
        if (m.w > w * 0.9 && fs2 > 8) {
            fs2 = Math.max(8, Math.floor(fs2 * (w * 0.9) / m.w));
        }
        const tx = Math.floor((w - m.w) / 2);
        const ty = ih + size + Math.floor((bottom - m.height) / 2) + m.ascent;
        drawText(g, date, tx, ty, fs2, 'rgb(160,160,160)', true);
    }
    function styleDoubleLine(img, size, g, iw, ih) {
        const outer = size, gap = Math.max(4, Math.floor(size / 3)), inner = size - gap;
        const w = iw + outer * 2, h = ih + outer * 2;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, outer, outer);
        g.strokeStyle = rgbJ(60, 60, 60);
        g.lineWidth = Math.max(1, Math.floor(gap / 2));
        const l = outer - inner;
        g.strokeRect(l, l, w - l * 2 - 1, h - l * 2 - 1);
        g.strokeStyle = rgbJ(40, 40, 40);
        g.lineWidth = Math.max(2, Math.floor(outer / 5));
        g.strokeRect(Math.floor(gap / 2), Math.floor(gap / 2), w - gap - 1, h - gap - 1);
    }
    function styleVintage(img, size, g, iw, ih) {
        const G = vintageGeom(iw, ih, size);
        const { frame, band, lineGap, w, h } = G;
        const cream = '#f4e6cb', terra = '#b24f2f', mustard = '#d89a3f', teal = '#2f6f66', ink = '#6b3522';
        // 奶油色纸面 + 陶土色外圈。
        const bg = g.createLinearGradient(0, 0, w, h);
        bg.addColorStop(0, '#f8eed9'); bg.addColorStop(0.55, cream); bg.addColorStop(1, '#e7cfa9');
        g.fillStyle = bg; g.fillRect(0, 0, w, h);
        g.fillStyle = terra; g.fillRect(0, 0, w, h);
        g.fillStyle = cream; g.fillRect(band, band, w - band * 2, h - band * 2);
        const rnd = styleNoise(iw, ih, 1974);
        g.fillStyle = 'rgba(120,80,45,0.045)';
        for (let i = 0; i < Math.min(420, Math.floor(w * h / 2600)); i++) {
            g.beginPath(); g.arc(rnd(w), rnd(h), 0.4 + rnd(2) * 0.4, 0, 6.2832); g.fill();
        }

        // 顶部半日纹:三层拱线,像 70 年代海报上的日落。
        const sunX = w / 2, sunY = Math.round(frame * 0.76), sunR = Math.max(9, Math.round(frame * 0.20));
        g.save();
        g.lineWidth = Math.max(1.5, Math.round(frame * 0.018));
        for (let k = 0; k < 3; k++) {
            g.strokeStyle = [terra, mustard, teal][k];
            g.beginPath(); g.arc(sunX, sunY, sunR * (1 - k * 0.24), Math.PI, Math.PI * 2); g.stroke();
        }
        g.strokeStyle = mustard; g.lineWidth = Math.max(1, Math.round(frame * 0.014));
        for (let i = 0; i < 7; i++) {
            const a = Math.PI + (i + 0.5) * Math.PI / 7;
            const r0 = sunR * 1.18, r1 = sunR * 1.48;
            g.beginPath();
            g.moveTo(sunX + Math.cos(a) * r0, sunY + Math.sin(a) * r0);
            g.lineTo(sunX + Math.cos(a) * r1, sunY + Math.sin(a) * r1);
            g.stroke();
        }
        g.restore();

        // 四角四分之一圆环。
        g.save();
        g.lineWidth = Math.max(1.2, Math.round(frame * 0.014));
        const corners = [[band, band, 0], [w - band, band, Math.PI / 2], [band, h - band, -Math.PI / 2], [w - band, h - band, Math.PI]];
        for (let ci = 0; ci < corners.length; ci++) {
            const [cx, cy, a0] = corners[ci];
            for (let k = 0; k < 3; k++) {
                g.strokeStyle = [teal, mustard, terra][k];
                g.beginPath();
                g.arc(cx, cy, frame * (0.28 + k * 0.11), a0, a0 + Math.PI / 2);
                g.stroke();
            }
        }
        g.restore();

        // 照片 + 双线框。
        g.drawImage(img, frame, frame, iw, ih);
        const outerInset = frame - lineGap;
        g.strokeStyle = terra;
        g.lineWidth = Math.max(2, Math.round(frame * 0.045));
        g.strokeRect(outerInset, outerInset, iw + (frame - outerInset) * 2, ih + (frame - outerInset) * 2);
        const innerInset = frame - Math.max(5, Math.round(lineGap * 0.45));
        g.strokeStyle = teal;
        g.lineWidth = Math.max(1.2, Math.round(frame * 0.018));
        g.strokeRect(innerInset, innerInset, iw + (frame - innerInset) * 2, ih + (frame - innerInset) * 2);

        // 底部字标。
        g.save();
        g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.font = '700 ' + Math.max(6, Math.round(frame * 0.075)) + 'px Georgia, serif';
        g.fillStyle = 'rgba(107,53,34,0.62)';
        g.fillText('EST. 1974', w / 2, h - Math.round(frame * 0.47));
        g.fillStyle = ink;
        g.font = '700 ' + Math.max(8, Math.round(frame * 0.13)) + 'px "Courier New", monospace';
        g.fillText('V I N T A G E', w / 2, h - Math.round(frame * 0.30));
        g.restore();
    }
    function styleGradient(img, size, g, iw, ih) {
        const w = iw + size * 2, h = ih + size * 2;
        const cols = extractDominant(img);
        const grad = g.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, rgbaC(cols[0]));
        grad.addColorStop(1, rgbaC(cols[1]));
        g.fillStyle = grad;
        g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
    }
    function fillRoundRectCtx(g, x, y, w, h, r) {
        g.beginPath();
        if (g.roundRect) { g.roundRect(x, y, w, h, r, r); g.fill(); return; }
        g.moveTo(x + r, y);
        g.lineTo(x + w - r, y);
        g.arcTo(x + w, y, x + w, y + r, r);
        g.lineTo(x + w, y + h - r);
        g.arcTo(x + w, y + h, x + w - r, y + h, r);
        g.lineTo(x + r, y + h);
        g.arcTo(x, y + h, x, y + h - r, r);
        g.lineTo(x, y + r);
        g.arcTo(x, y, x + r, y, r);
        g.closePath();
        g.fill();
    }
    function styleDropShadow(img, size, g, iw, ih) {
        const offset = Math.max(8, Math.floor(size / 2)), softness = Math.max(8, Math.floor(size / 2)), margin = size;
        const w = iw + margin * 2 + offset, h = ih + margin * 2 + offset;
        const shadow = newCanvas(w, h);
        const sg = shadow.getContext('2d');
        sg.fillStyle = '#000000';
        const arc = Math.max(5, Math.floor(size / 4));
        fillRoundRectCtx(sg, margin + offset, margin + offset, iw, ih, arc);
        const blurred = fastBlurCanvas(shadow, softness);
        g.drawImage(blurred, 0, 0);
        g.drawImage(img, margin, margin);
    }

    // ── 自研特色风格:仿古邮票 / 撕纸边 / 折角相纸 / 胶带挂片 ──
    // 确定性噪声:同照片同风格下渲染结果稳定(基于照片尺寸+盐的 Java LCG)
    function styleNoise(iw, ih, salt) { return javaRandom(iw * 7919 + ih * 104729 + salt); }

    // 仿古邮票:一枚贴在大版张上的纪念邮票。几何同时供 styleDims 使用,
    // 保证登记画布、邮票齿孔和照片位置永远一致。
    function stampPostageGeom(iw, ih, size) {
        const padX = Math.max(36, Math.round(iw * 0.055), Math.round(size * 0.60));
        const padTop = Math.max(50, Math.round(ih * 0.07), Math.round(size * 0.75));
        const padBottom = Math.max(66, Math.round(ih * 0.095), Math.round(size * 1.00));
        const d = Math.max(9, Math.round(Math.min(iw, ih) * 0.022));
        const stampW = iw + padX * 2, stampH = ih + padTop + padBottom;
        const sheetPadX = Math.max(22, Math.round(iw * 0.032));
        const sheetTop = Math.max(22, Math.round(ih * 0.028));
        const sheetBottom = Math.max(100, Math.round(ih * 0.16));
        const sheetW = stampW + sheetPadX * 2, sheetH = sheetTop + stampH + sheetBottom;
        const albumPad = Math.max(22, Math.round(Math.min(iw, ih) * 0.03), Math.round(size * 0.35));
        const stampX = albumPad + sheetPadX, stampY = albumPad + sheetTop;
        return {
            padX, padTop, padBottom, d, stampW, stampH, stampX, stampY,
            sheetX: albumPad, sheetY: albumPad, sheetW, sheetH, sheetPadX, sheetTop, sheetBottom, albumPad,
            w: sheetW + albumPad * 2, h: sheetH + albumPad * 2
        };
    }
    // 邮票齿孔:沿四周外缘打半圆孔(destination-out,露出透明底)
    function stampPerforate(g, w, h, d) {
        const r = d / 2, pitch = Math.max(Math.ceil(d * 1.6), d + 2);
        g.save();
        g.globalCompositeOperation = 'destination-out';
        for (let x = r; x < w; x += pitch) {
            g.beginPath(); g.arc(x, 0, r, 0, 6.2832); g.fill();
            g.beginPath(); g.arc(x, h, r, 0, 6.2832); g.fill();
        }
        for (let y = r; y < h; y += pitch) {
            g.beginPath(); g.arc(0, y, r, 0, 6.2832); g.fill();
            g.beginPath(); g.arc(w, y, r, 0, 6.2832); g.fill();
        }
        g.restore();
    }
    function newspaperGeom(iw) {
        const pad = Math.max(30, Math.round(iw * 0.04));
        const mastH = Math.round(iw * 0.13);
        const headH = Math.round(iw * 0.12);
        const bottomH = Math.round(iw * 0.22);
        return { pad, mastH, headH, bottomH, w: iw + pad * 2, h: 0 };
    }

    // 复古胶片撕裂:竖幅用竖条负片,横幅用横条负片;一端做锯齿撕口。
    function vintageGeom(iw, ih, size) {
        const frame = Math.max(50, Math.round(size));
        return { frame, band: Math.max(8, Math.round(frame * 0.18)), lineGap: Math.max(10, Math.round(frame * 0.16)), w: iw + frame * 2, h: ih + frame * 2 };
    }
    function albumGeom(iw, ih, size) {
        const padX = Math.max(52, Math.round(size * 1.00), Math.round(iw * 0.05));
        const padTop = Math.max(52, Math.round(size * 1.00), Math.round(ih * 0.05));
        const padBottom = Math.max(116, Math.round(size * 1.90), Math.round(ih * 0.15));
        const printBorder = Math.max(10, Math.round(size * 0.18));
        return { padX, padTop, padBottom, printBorder, w: iw + padX * 2, h: ih + padTop + padBottom, photoX: padX, photoY: padTop };
    }
    function filmTearGeom(iw, ih, size) {
        const vertical = ih >= iw * 0.98;
        const framePad = Math.max(10, Math.round(Math.min(iw, ih) * 0.018));
        const rail = Math.max(34, Math.round(size * 0.90), Math.round(Math.min(iw, ih) * 0.055));
        const endPad = Math.max(48, Math.round(Math.min(iw, ih) * 0.055));
        const tornPad = Math.max(52, Math.round(Math.min(iw, ih) * 0.060));
        const deskPad = Math.max(24, Math.round(size * 0.50), Math.round(Math.min(iw, ih) * 0.030));
        let filmW, filmH, photoX, photoY, tearY = 0, tearX = 0;
        if (vertical) {
            filmW = iw + framePad * 2 + rail * 2;
            filmH = ih + framePad * 2 + endPad + tornPad;
            photoX = rail + framePad;
            photoY = endPad + framePad;
            tearY = photoY + ih + framePad + Math.round(tornPad * 0.35);
        } else {
            filmW = iw + framePad * 2 + endPad + tornPad;
            filmH = ih + framePad * 2 + rail * 2;
            photoX = endPad + framePad;
            photoY = rail + framePad;
            tearX = photoX + iw + framePad + Math.round(tornPad * 0.35);
        }
        return {
            vertical, framePad, rail, endPad, tornPad, deskPad,
            filmW, filmH, photoX, photoY, tearY, tearX,
            w: filmW + deskPad * 2, h: filmH + deskPad * 2
        };
    }
    function styleStampPostage(img, size, g, iw, ih, S) {
        const G = stampPostageGeom(iw, ih, size);
        const { padX, padTop, padBottom, d, stampW, stampH, stampX, stampY,
            sheetX, sheetY, sheetW, sheetH, sheetBottom, w, h } = G;
        // 深绿卡纸底:像集邮册的一页,让邮票版张浮起来。
        const bg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.72);
        bg.addColorStop(0, '#33473b'); bg.addColorStop(0.62, '#223229'); bg.addColorStop(1, '#141d18');
        g.fillStyle = bg; g.fillRect(0, 0, w, h);
        const rnd = styleNoise(iw, ih, 4177);
        g.fillStyle = 'rgba(215,225,205,0.035)';
        const dots = Math.min(900, Math.floor(w * h / 3200));
        for (let i = 0; i < dots; i++) {
            const dx = rnd(w), dy = rnd(h), rr = 0.5 + rnd(2) * 0.5;
            g.beginPath(); g.arc(dx, dy, rr, 0, 6.2832); g.fill();
        }

        // 版张纸 + 双层版框。
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.48)';
        g.shadowBlur = Math.max(14, Math.round(size * 0.45));
        g.shadowOffsetY = Math.max(6, Math.round(size * 0.12));
        g.fillStyle = '#efe6d2';
        g.fillRect(sheetX, sheetY, sheetW, sheetH);
        g.restore();
        g.strokeStyle = 'rgba(100,82,55,0.55)'; g.lineWidth = 1.2;
        g.strokeRect(sheetX + 0.5, sheetY + 0.5, sheetW - 1, sheetH - 1);
        g.strokeStyle = 'rgba(180,155,105,0.35)'; g.lineWidth = 1;
        g.strokeRect(sheetX + 8.5, sheetY + 8.5, sheetW - 17, sheetH - 17);

        // 邮票本体画到独立画布,再整体打齿孔,避免把版张一起打穿。
        const stamp = newCanvas(stampW, stampH);
        const sg = stamp.getContext('2d');
        sg.fillStyle = '#fbf6e8'; sg.fillRect(0, 0, stampW, stampH);
        sg.drawImage(img, padX, padTop, iw, ih);
        // 轻微泛黄,让照片像旧票面。
        sg.fillStyle = 'rgba(128,88,46,0.055)';
        sg.fillRect(padX, padTop, iw, ih);
        sg.strokeStyle = 'rgba(96,79,54,0.55)'; sg.lineWidth = 1;
        sg.strokeRect(padX - 0.5, padTop - 0.5, iw + 1, ih + 1);

        const capFs = Math.max(11, Math.min(Math.round(autoExifSize(S ? S.paramFs : 33, iw)),
            Math.floor(padTop / 2.0)));
        sg.save();
        sg.textAlign = 'center'; sg.textBaseline = 'alphabetic';
        sg.font = '700 ' + capFs + 'px "SimSun", "Songti SC", serif';
        sg.fillStyle = 'rgba(62,52,37,0.86)';
        sg.fillText('中国邮政', stampW / 2, Math.round(padTop * 0.58));
        sg.font = 'bold ' + Math.max(7, Math.round(capFs * 0.38)) + 'px Georgia, serif';
        sg.fillStyle = 'rgba(96,79,54,0.62)';
        sg.fillText('POSTAGE', stampW / 2, Math.round(padTop * 0.84));
        const valFs = Math.max(13, Math.min(Math.round(autoExifSize(S ? S.paramFs : 33, iw) * 1.12),
            Math.floor(padBottom / 2.2)));
        sg.font = '700 ' + valFs + 'px "SimSun", "Songti SC", serif';
        sg.fillStyle = 'rgba(62,52,37,0.88)';
        sg.fillText('¥ 0.80', stampW / 2, stampH - Math.round(padBottom * 0.52));
        sg.font = 'bold ' + Math.max(7, Math.round(valFs * 0.34)) + 'px Georgia, serif';
        sg.fillStyle = 'rgba(96,79,54,0.58)';
        sg.fillText('POSTAGE & REVENUE', stampW / 2, stampH - Math.round(padBottom * 0.22));
        sg.restore();
        stampPerforate(sg, stampW, stampH, d);

        // 邮票投影 + 贴到版张上。
        g.save();
        g.shadowColor = 'rgba(40,30,18,0.30)';
        g.shadowBlur = Math.max(8, Math.round(size * 0.20));
        g.shadowOffsetY = Math.max(2, Math.round(size * 0.05));
        g.drawImage(stamp, stampX, stampY);
        g.restore();

        // 销印:压在邮票右下角并延伸出波浪线。
        const pr = Math.max(26, Math.round(Math.min(stampW, stampH) * 0.095));
        const pcx = stampX + stampW - Math.round(pr * 0.72);
        const pcy = stampY + stampH - Math.round(pr * 0.48);
        g.save();
        g.strokeStyle = 'rgba(58,54,112,0.34)';
        g.fillStyle = 'rgba(58,54,112,0.38)';
        g.lineWidth = 1.4;
        g.beginPath(); g.arc(pcx, pcy, pr, 0, 6.2832); g.stroke();
        g.beginPath(); g.arc(pcx, pcy, pr * 0.62, 0, 6.2832); g.stroke();
        g.font = 'bold ' + Math.max(8, Math.round(pr * 0.20)) + 'px Georgia, serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('1998. 6. 12', pcx, pcy - pr * 0.16);
        g.font = 'bold ' + Math.max(7, Math.round(pr * 0.16)) + 'px Georgia, serif';
        g.fillText('BEIJING', pcx, pcy + pr * 0.22);
        g.lineWidth = 1.2;
        for (let k = 0; k < 3; k++) {
            const yy = pcy - pr * 0.34 + k * pr * 0.30;
            g.beginPath();
            for (let x = 0; x <= pr * 2.6; x += 4) {
                const wy = yy + Math.sin((x / pr) * 3.2 + k) * pr * 0.06;
                if (x === 0) g.moveTo(pcx - pr * 3.2 + x, wy); else g.lineTo(pcx - pr * 3.2 + x, wy);
            }
            g.stroke();
        }
        g.restore();

        // 版张下边纸:纪念标题、编号和红色邮戳印。
        const selvY = stampY + stampH;
        const ruleY = selvY + Math.max(10, Math.round(sheetBottom * 0.10));
        g.strokeStyle = 'rgba(105,88,60,0.45)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(sheetX + 28, ruleY); g.lineTo(sheetX + sheetW - 28, ruleY); g.stroke();
        const titleFs = Math.max(17, Math.round(sheetW * 0.028));
        g.save();
        g.textAlign = 'left'; g.textBaseline = 'alphabetic';
        g.font = '700 ' + titleFs + 'px "SimSun", "Songti SC", serif';
        g.fillStyle = '#3b352b';
        g.fillText('纪念邮票', sheetX + 30, selvY + Math.round(sheetBottom * 0.48));
        const subFs = Math.max(8, Math.round(titleFs * 0.38));
        g.font = 'bold ' + subFs + 'px Georgia, serif';
        g.fillStyle = 'rgba(115,98,73,0.78)';
        g.fillText('COMMEMORATIVE ISSUE', sheetX + 32, selvY + Math.round(sheetBottom * 0.64));
        g.font = 'bold ' + subFs + 'px monospace';
        g.fillStyle = 'rgba(115,98,73,0.62)';
        g.fillText('NO. 0087  ·  1998', sheetX + 32, selvY + Math.round(sheetBottom * 0.82));

        // 红色票戳:略微歪一点,像手盖的。
        const seal = Math.max(30, Math.round(sheetW * 0.052));
        g.translate(sheetX + sheetW - 34 - seal / 2, selvY + sheetBottom * 0.40);
        g.rotate(-0.10);
        g.fillStyle = '#a83a2f';
        fillRoundRectCtx(g, -seal / 2, -seal / 2, seal, seal, Math.max(2, seal * 0.06));
        g.strokeStyle = 'rgba(255,238,216,0.62)'; g.lineWidth = 1;
        g.strokeRect(-seal / 2 + 4.5, -seal / 2 + 4.5, seal - 9, seal - 9);
        g.fillStyle = '#f6e8d3';
        g.font = '700 ' + Math.round(seal * 0.52) + 'px "SimSun", "Songti SC", serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('邮', 0, 1);
        g.restore();
    }

    // 撕纸边:照片轻微倾斜 + 白纸毛边镂空(角度/毛边均由尺寸+盐确定,稳定可复现)
    function tornPaperParams(iw, ih, size) {
        const rnd = styleNoise(iw, ih, 113);
        const deg = (rnd(500) - 250) / 250 * 2.4;
        const a = deg * 0.01745329252;
        const s = Math.sin(a), c = Math.cos(a);
        const bw = Math.ceil(iw * c + ih * Math.abs(s));
        const bh = Math.ceil(iw * Math.abs(s) + ih * c);
        const pad = Math.max(40, Math.floor(size * 1.4));
        return { a, bw, bh, pad, rnd };
    }
    function tornHolePath(rnd, iw, ih, amp) {
        const n = Math.max(3, Math.floor(Math.max(iw, ih) / 16));
        const p = new Path2D();
        const pts = [];
        const j = (v) => v + (rnd(3) - 1) * amp;
        const px0 = -iw / 2, py0 = -ih / 2;
        for (let i = 0; i <= n; i++) pts.push([j(px0 + iw * i / n), py0 + (rnd(3) - 1) * amp]);
        for (let i = 1; i <= n; i++) pts.push([iw / 2 + (rnd(3) - 1) * amp, j(py0 + ih * i / n)]);
        for (let i = 1; i <= n; i++) pts.push([j(iw / 2 - iw * i / n), ih / 2 + (rnd(3) - 1) * amp]);
        for (let i = 1; i <= n; i++) pts.push([-iw / 2 + (rnd(3) - 1) * amp, j(ih / 2 - ih * i / n)]);
        p.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
        p.closePath();
        return p;
    }
    function styleTornPaper(img, size, g, iw, ih) {
        const { a, bw, bh, pad, rnd } = tornPaperParams(iw, ih, size);
        const w = bw + pad * 2, h = bh + pad * 2;
        const cx = w / 2, cy = h / 2;
        const paper = '#fbfaf4';
        g.fillStyle = paper;
        g.fillRect(0, 0, w, h);
        g.save();
        g.translate(cx, cy);
        g.rotate(a);
        g.drawImage(img, -iw / 2, -ih / 2);
        g.restore();
        // 白纸覆盖(留毛边孔):先画纸,再按抖动照片轮廓挖空,边缘描淡影
        const ov = newCanvas(w, h);
        const og = ov.getContext('2d');
        og.fillStyle = paper;
        og.fillRect(0, 0, w, h);
        const amp = Math.max(3, Math.floor(Math.min(iw, ih) * 0.014));
        const hole = tornHolePath(rnd, iw, ih, amp);
        og.save();
        og.translate(cx, cy);
        og.rotate(a);
        og.globalCompositeOperation = 'destination-out';
        og.fillStyle = '#000';
        og.fill(hole);
        og.globalCompositeOperation = 'source-over';
        og.strokeStyle = 'rgba(0,0,0,0.07)';
        og.lineWidth = 2;
        og.stroke(hole);
        og.restore();
        g.drawImage(ov, 0, 0);
    }

    // 折角相纸:白卡纸四边留白,右上角撕折(缺角 + 翻起的纸角落在照片上)
    function styleFoldCorner(img, size, g, iw, ih) {
        const pad = Math.max(60, Math.round(iw * 0.06));
        const w = iw + pad * 2, h = ih + pad * 2;
        const px = pad, py = pad;
        // 桌面背景(浅灰)
        g.fillStyle = '#e9e6df';
        g.fillRect(0, 0, w, h);
        // 便签纸: 奶油黄, 圆角, 浮起投影, 比照片四周大一圈
        const m = Math.max(26, Math.round(size * 1.1));
        const bx = px - m, by = py - m, bw = iw + m * 2, bh = ih + m * 2;
        g.save();
        g.shadowColor = 'rgba(90,70,30,0.30)';
        g.shadowBlur = Math.max(14, Math.round(size * 0.6));
        g.shadowOffsetX = Math.round(size * 0.25);
        g.shadowOffsetY = Math.round(size * 0.6);
        g.fillStyle = '#fdf2d0';
        fillRoundRectCtx(g, bx, by, bw, bh, 3);
        g.restore();
        // 便签纸浅噪点(纸感)
        const rndf = styleNoise(w, h, 6601);
        g.fillStyle = 'rgba(150,120,60,0.07)';
        for (let i = 0; i < 90; i++) {
            const nx = rndf(w), ny = rndf(h), ns = 1 + (i % 3);
            g.fillRect(nx, ny, ns, ns);
        }
        // 照片: 白色贴纸边 + 居中贴便签上
        g.fillStyle = '#ffffff';
        fillRoundRectCtx(g, px - 6, py - 6, iw + 12, ih + 12, 2);
        g.drawImage(img, px, py);
        // 右上角折角: 便签纸+照片角一起折起(镂空露出桌面背景)
        const fl = Math.max(48, Math.round(Math.min(iw, ih) * 0.12));
        const P0 = [bx + bw, by], P1 = [bx + bw - fl, by], P2 = [bx + bw, by + fl], R = [bx + bw - fl, by + fl];
        g.save();
        g.globalCompositeOperation = 'destination-out';
        g.beginPath();
        g.moveTo(P0[0], P0[1]); g.lineTo(P1[0], P1[1]); g.lineTo(P2[0], P2[1]); g.closePath();
        g.fill();
        g.restore();
        // 折痕投影
        g.strokeStyle = 'rgba(0,0,0,0.18)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(P1[0] + 1, P1[1] + 3); g.lineTo(P2[0] + 3, P2[1] - 1);
        g.stroke();
        // 翻起的纸角(便签纸背, 深一档的黄)
        const lg = g.createLinearGradient(P2[0], P2[1], P1[0], P1[1]);
        lg.addColorStop(0, '#f5e3b3');
        lg.addColorStop(1, '#e9d190');
        g.fillStyle = lg;
        g.beginPath();
        g.moveTo(P1[0], P1[1]); g.lineTo(R[0], R[1]); g.lineTo(P2[0], P2[1]); g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(120,90,40,0.35)';
        g.lineWidth = 1;
        g.stroke();
        // 左下角便签小字
        g.fillStyle = 'rgba(120,95,50,0.55)';
        g.font = Math.max(11, Math.round(size * 0.55)) + 'px "Segoe Script", "Comic Sans MS", cursive';
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.fillText('memo', px + 8, py + ih - 4);
    }

    // ══ 双重曝光(2026-10重做): 深底 + 同图镜像滤色叠影 + 胶片颗粒 + 暗角 + 底部条 ──
    function styleDoubleExposure(img, size, g, iw, ih) {
        const pad = Math.max(50, Math.round(iw * 0.05));
        const w = iw + pad * 2, h = ih + pad * 2;
        const px = pad, py = pad;
        // 深色底
        g.fillStyle = '#141418';
        g.fillRect(0, 0, w, h);
        // 照片1: 正常
        g.drawImage(img, px, py, iw, ih);
        // 照片2: 同图放大 + 错位重影(不翻转), 滤色混合(双曝叠光)
        const off = Math.round(iw * 0.02);
        g.save();
        g.globalCompositeOperation = 'screen';
        g.globalAlpha = 0.55;
        g.drawImage(img, px - Math.round(iw * 0.25) + off, py - Math.round(ih * 0.25) + Math.round(off * 0.5), Math.round(iw * 1.5), Math.round(ih * 1.5));
        g.restore();
        // 局部柔光带(叠影高光区)
        g.save();
        g.globalCompositeOperation = 'soft-light';
        g.globalAlpha = 0.35;
        const lg = g.createLinearGradient(px, py, px + iw, py + ih);
        lg.addColorStop(0, 'rgba(255,255,255,0)');
        lg.addColorStop(0.45, 'rgba(255,245,220,0.5)');
        lg.addColorStop(0.7, 'rgba(255,255,255,0)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = lg;
        g.fillRect(px, py, iw, ih);
        g.restore();
        // 胶片颗粒
        const rndf = styleNoise(w, h, 7711);
        g.fillStyle = 'rgba(255,255,255,0.05)';
        for (let i = 0; i < 160; i++) {
            const nx = rndf(w), ny = rndf(h), ns = 1 + (i % 3);
            g.fillRect(nx, ny, ns, ns);
        }
        // 暗角
        const vg = g.createRadialGradient(px + iw / 2, py + ih / 2, Math.min(iw, ih) * 0.35, px + iw / 2, py + ih / 2, Math.max(iw, ih) * 0.75);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, 'rgba(0,0,0,0.38)');
        g.fillStyle = vg;
        g.fillRect(px, py, iw, ih);
    }

    // ══ 杂志大刊头(2026-10重做) ──
    function styleMagazineMasthead(img, size, g, iw, ih) {
        const pad = Math.max(50, Math.round(iw * 0.05));
        const topBar = Math.round(iw * 0.15);
        const botBar = Math.round(iw * 0.07);
        const w = iw + pad * 2, h = ih + pad * 2 + topBar + botBar;
        const px = pad, py = pad + topBar;
        // 深色底
        g.fillStyle = '#0d0d12';
        g.fillRect(0, 0, w, h);
        // 照片(细白框)
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.lineWidth = 1;
        g.strokeRect(px, py, iw, ih);
        g.drawImage(img, px, py);
        // 刊头区
        const cxm = w / 2;
        g.fillStyle = '#9a9aa5';
        g.font = '600 ' + Math.max(10, Math.round(topBar * 0.16)) + 'px "Courier New", monospace';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('THE WEEKLY PHOTO JOURNAL', cxm, pad + Math.round(topBar * 0.22));
        g.fillStyle = '#f2f0e8';
        g.font = '900 italic ' + Math.round(topBar * 0.5) + 'px Georgia, "Times New Roman", serif';
        g.fillText('M A G A Z I N E', cxm, pad + Math.round(topBar * 0.60));
        g.strokeStyle = 'rgba(255,255,255,0.35)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cxm - Math.round(iw * 0.30), pad + Math.round(topBar * 0.82));
        g.lineTo(cxm + Math.round(iw * 0.30), pad + Math.round(topBar * 0.82));
        g.stroke();
        // 底部条
        const bb = h - botBar;
        g.fillStyle = '#16161c';
        g.fillRect(0, bb, w, botBar);
        g.strokeStyle = '#3a3a44';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, bb); g.lineTo(w, bb); g.stroke();
        g.fillStyle = '#c8c8d0';
        g.font = '700 ' + Math.max(10, Math.round(botBar * 0.28)) + 'px "Courier New", monospace';
        g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText('VOL.08 — 2026', pad, bb + Math.round(botBar / 2));
        g.textAlign = 'right';
        g.fillText('STREET EDITION', w - pad, bb + Math.round(botBar / 2));
    }

    // ══ 杂志封面(2026-10重做) ──
    function styleMagazineCover(img, size, g, iw, ih) {
        const pad = Math.max(36, Math.round(iw * 0.045));
        const topBar = Math.round(iw * 0.105);
        const botBar = Math.round(iw * 0.055);
        const w = iw + pad * 2, h = ih + pad * 2 + topBar + botBar;
        const px = pad, py = pad + topBar;
        // 米白封底
        g.fillStyle = '#f7f5f0';
        g.fillRect(0, 0, w, h);
        // 照片(白贴纸边 + 细灰线)
        g.fillStyle = '#ffffff';
        g.fillRect(px - 8, py - 8, iw + 16, ih + 16);
        g.strokeStyle = '#d8d4cc';
        g.lineWidth = 1;
        g.strokeRect(px - 8.5, py - 8.5, iw + 17, ih + 17);
        g.drawImage(img, px, py);
        // 刊头区
        const cxm = w / 2;
        g.fillStyle = '#8a8578';
        g.font = '600 ' + Math.max(9, Math.round(topBar * 0.17)) + 'px "Courier New", monospace';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('PARIS · SPRING 2026', cxm, pad + Math.round(topBar * 0.20));
        g.fillStyle = '#141414';
        g.font = '900 italic ' + Math.round(topBar * 0.55) + 'px Georgia, "Times New Roman", serif';
        g.fillText('FASHION', cxm, pad + Math.round(topBar * 0.60));
        g.strokeStyle = '#141414';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(cxm - Math.round(iw * 0.28), pad + Math.round(topBar * 0.82));
        g.lineTo(cxm + Math.round(iw * 0.28), pad + Math.round(topBar * 0.82));
        g.stroke();
        // 底部
        g.fillStyle = '#141414';
        g.font = '700 ' + Math.max(9, Math.round(botBar * 0.30)) + 'px "Courier New", monospace';
        g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText('THE BEST MOMENTS', pad, h - Math.round(botBar / 2));
        g.textAlign = 'right';
        g.fillText('P. 08', w - pad, h - Math.round(botBar / 2));
    }

    // ══ 杂志页眉(2026-10重做) ──
    function styleMagazineHeader(img, size, g, iw, ih) {
        const pad = Math.max(36, Math.round(iw * 0.04));
        const topBar = Math.round(iw * 0.09);
        const botBar = Math.round(iw * 0.05);
        const w = iw + pad * 2, h = ih + pad * 2 + topBar + botBar;
        const px = pad, py = pad + topBar;
        // 白底
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        // 页眉条
        g.fillStyle = '#141414';
        g.font = '800 ' + Math.max(11, Math.round(topBar * 0.34)) + 'px Georgia, "Times New Roman", serif';
        g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText('MAGAZINE', pad, pad + Math.round(topBar * 0.42));
        g.fillStyle = '#777777';
        g.font = '600 ' + Math.max(9, Math.round(topBar * 0.22)) + 'px "Courier New", monospace';
        g.textAlign = 'right';
        g.fillText('VOL.16 · 2026', w - pad, pad + Math.round(topBar * 0.35));
        // 页眉双线
        const yl = pad + Math.round(topBar * 0.72);
        g.strokeStyle = '#141414'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(pad, yl); g.lineTo(w - pad, yl); g.stroke();
        g.strokeStyle = '#bbbbbb'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(pad, yl + 3); g.lineTo(w - pad, yl + 3); g.stroke();
        // 照片(细黑框)
        g.strokeStyle = '#222222';
        g.lineWidth = 1;
        g.strokeRect(px, py, iw, ih);
        g.drawImage(img, px, py);
        // 页脚
        g.fillStyle = '#999999';
        g.font = '600 ' + Math.max(8, Math.round(botBar * 0.26)) + 'px "Courier New", monospace';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('THE PHOTO ESSAY — CONTINUED ON P.14', w / 2, h - Math.round(botBar / 2));
    }

    // 胶带挂片:牛皮纸底 + 和纸胶带(半透明)压住照片
    function drawTape(g, x, y, len, th, ang, color) {
        g.save();
        g.translate(x, y);
        g.rotate(ang);
        g.fillStyle = color;
        fillRoundRectCtx(g, -len / 2, -th / 2, len, th, th / 2);
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = 1;
        const rr = th * 0.7;
        g.beginPath(); g.moveTo(-len / 2 + rr, -th / 2 + 1); g.quadraticCurveTo(-len / 2 + rr, 0, -len / 2 + rr, th / 2 - 1); g.stroke();
        g.beginPath(); g.moveTo(len / 2 - rr, -th / 2 + 1); g.quadraticCurveTo(len / 2 - rr, 0, len / 2 - rr, th / 2 - 1); g.stroke();
        g.restore();
    }
    function stylePinboardTape(img, size, g, iw, ih) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = '#f5f2ea';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const th = Math.max(14, Math.floor(size * 0.5));
        const len = Math.max(90, Math.floor(iw * 0.3));
        drawTape(g, size + Math.floor(len * 0.35), size - Math.floor(th * 0.3), len, th, -0.16, 'rgba(222,208,156,0.62)');
        drawTape(g, w - size - Math.floor(len * 0.35), size - Math.floor(th * 0.3), len, th, 0.16, 'rgba(156,178,208,0.55)');
        drawTape(g, w / 2, h - size + Math.floor(th * 0.3), Math.floor(len * 0.7), th, 0.04, 'rgba(190,168,190,0.5)');
    }
    // ── 四格创新边框:VHS录像带 / 老相册角贴 / 撕边电影票 / 水彩晕染 ──
    function styleVhsTape(img, size, g, iw, ih) {
        const padX = Math.max(14, Math.round(iw * 0.022), Math.round(size * 0.24));
        const topH = Math.max(46, Math.round(iw * 0.065), Math.round(size * 1.05));
        const botH = Math.max(64, Math.round(iw * 0.105), Math.round(size * 1.55));
        const w = iw + padX * 2, h = ih + topH + botH;
        const shellR = Math.max(8, Math.round(size * 0.22));
        // 黑色磁带壳:用深灰渐变而不是纯黑,避免缩略图糊成一团。
        g.fillStyle = '#08080a'; g.fillRect(0, 0, w, h);
        const shell = g.createLinearGradient(0, 0, 0, h);
        shell.addColorStop(0, '#1d1d21'); shell.addColorStop(0.52, '#121215'); shell.addColorStop(1, '#09090b');
        g.fillStyle = shell;
        roundRectPath(g, 2, 2, w - 4, h - 4, shellR); g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1;
        roundRectPath(g, 2.5, 2.5, w - 5, h - 5, Math.max(2, shellR - 1)); g.stroke();
        g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = 1;
        roundRectPath(g, 1, 1, w - 2, h - 2, shellR); g.stroke();

        // 顶部:磁带螺丝 + VHS 字标 + SP / T-120。
        const screwR = Math.max(2.2, Math.round(size * 0.055));
        const screwY = Math.max(9, Math.round(topH * 0.22));
        for (const sx of [Math.max(8, Math.round(padX * 0.45)), w - Math.max(8, Math.round(padX * 0.45))]) {
            g.fillStyle = '#2a2a2e'; g.beginPath(); g.arc(sx, screwY, screwR, 0, 6.2832); g.fill();
            g.strokeStyle = '#4b4b52'; g.lineWidth = 1; g.beginPath(); g.arc(sx, screwY, screwR, 0, 6.2832); g.stroke();
            g.strokeStyle = '#151518'; g.lineWidth = Math.max(1, Math.round(screwR * 0.4));
            g.beginPath(); g.moveTo(sx - screwR * 0.55, screwY); g.lineTo(sx + screwR * 0.55, screwY); g.stroke();
        }
        const logoFs = Math.max(15, Math.round(topH * 0.42));
        const logoX = padX;
        const logoBase = Math.round(topH * 0.60);
        g.fillStyle = '#e23b2e';
        g.fillRect(logoX, logoBase - Math.round(logoFs * 0.74), Math.max(3, Math.round(logoFs * 0.11)), Math.round(logoFs * 0.82));
        g.font = '900 ' + logoFs + 'px "Arial Black", Impact, sans-serif';
        g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.fillStyle = '#f4f0e4';
        g.fillText('VHS', logoX + Math.round(logoFs * 0.28), logoBase);
        const subFs = Math.max(7, Math.round(topH * 0.14));
        g.font = 'bold ' + subFs + 'px "Courier New", monospace';
        g.fillStyle = 'rgba(220,215,200,0.55)';
        g.fillText('VIDEO CASSETTE', logoX + Math.round(logoFs * 0.28), logoBase + Math.round(subFs * 1.45));

        const pillW = Math.max(30, Math.round(topH * 0.62));
        const pillH = Math.max(16, Math.round(topH * 0.36));
        const pillX = w - padX - pillW, pillY = Math.round(topH * 0.20);
        g.fillStyle = '#1e5d3f';
        fillRoundRectCtx(g, pillX, pillY, pillW, pillH, Math.max(3, pillH * 0.25));
        g.font = 'bold ' + Math.max(8, Math.round(pillH * 0.55)) + 'px monospace';
        g.fillStyle = '#b9ffd0'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('SP', pillX + pillW / 2, pillY + pillH / 2 + 1);
        g.textAlign = 'right'; g.textBaseline = 'alphabetic';
        g.font = 'bold ' + Math.max(8, Math.round(topH * 0.18)) + 'px monospace';
        g.fillStyle = 'rgba(220,215,200,0.65)';
        g.fillText('T-120', w - padX, Math.round(topH * 0.78));
        g.textAlign = 'left';

        // 相纸标签:照片四周留一圈旧纸边,让它像贴在磁带上的打印照片。
        const paperOff = Math.max(5, Math.round(size * 0.11));
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.58)';
        g.shadowBlur = Math.max(6, Math.round(size * 0.18));
        g.shadowOffsetY = Math.max(2, Math.round(size * 0.04));
        g.fillStyle = '#e8dec6';
        fillRoundRectCtx(g, padX - paperOff, topH - paperOff, iw + paperOff * 2, ih + paperOff * 2, Math.max(2, paperOff * 0.3));
        g.restore();
        g.drawImage(img, padX, topH);
        g.strokeStyle = 'rgba(40,32,22,0.40)'; g.lineWidth = 1;
        g.strokeRect(padX - 1.5, topH - 1.5, iw + 3, ih + 3);
        g.strokeStyle = 'rgba(255,255,255,0.34)'; g.lineWidth = 1;
        g.strokeRect(padX - paperOff + 1, topH - paperOff + 1, iw + paperOff * 2 - 2, ih + paperOff * 2 - 2);

        // 录像带画面:细扫描线 + 极轻的色边,保留照片本身可读性。
        g.save();
        g.fillStyle = 'rgba(0,0,0,0.05)';
        for (let yy = topH; yy < topH + ih; yy += 4) g.fillRect(padX, yy, iw, 1);
        const fringeW = Math.max(2, Math.round(iw * 0.004));
        g.fillStyle = 'rgba(0,255,180,0.035)'; g.fillRect(padX, topH, fringeW, ih);
        g.fillStyle = 'rgba(255,40,80,0.025)'; g.fillRect(padX + iw - fringeW, topH, fringeW, ih);
        g.restore();

        // VHS 屏显。
        const osdFs = Math.max(10, Math.round(iw * 0.016));
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 3; g.shadowOffsetX = 1; g.shadowOffsetY = 1;
        drawTextL(g, 'SP  12:34:56', padX + Math.round(osdFs * 0.8), topH + ih - Math.round(osdFs * 1.1), '#8dffb0', osdFs, true, true, 0);
        const playTxt = 'PLAY';
        const playW = textMetrics(g, playTxt, osdFs, true, false, 0).w;
        const playX = padX + iw - playW - Math.round(osdFs * 1.5);
        const playY = topH + Math.round(osdFs * 1.7);
        drawTextL(g, playTxt, playX, playY, '#f2f2ea', osdFs, true, false, 0);
        g.fillStyle = '#f2f2ea';
        const triX = playX + playW + Math.round(osdFs * 0.35);
        g.beginPath();
        g.moveTo(triX, playY - Math.round(osdFs * 0.68));
        g.lineTo(triX + Math.round(osdFs * 0.52), playY - Math.round(osdFs * 0.35));
        g.lineTo(triX, playY - Math.round(osdFs * 0.02));
        g.closePath(); g.fill();
        g.restore();

        // 底部:手写标签 + 条码 + 一截走带噪点。
        const labelY = topH + ih + Math.max(8, Math.round(botH * 0.12));
        const labelH = botH - (labelY - (topH + ih)) - Math.max(6, Math.round(botH * 0.10));
        const labelW = Math.round(iw * 0.64);
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 4; g.shadowOffsetY = 2;
        g.fillStyle = '#e6dcc3';
        fillRoundRectCtx(g, padX, labelY, labelW, labelH, 3);
        g.restore();
        g.strokeStyle = 'rgba(120,100,75,0.35)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(padX + 8, labelY + labelH * 0.58); g.lineTo(padX + labelW - 8, labelY + labelH * 0.58); g.stroke();
        g.beginPath(); g.moveTo(padX + 8, labelY + labelH * 0.84); g.lineTo(padX + labelW - 8, labelY + labelH * 0.84); g.stroke();
        g.fillStyle = '#b3372c';
        g.fillRect(padX, labelY, Math.max(3, Math.round(labelW * 0.012)), labelH);
        const handFs = Math.max(10, Math.round(labelH * 0.30));
        g.font = 'bold ' + handFs + 'px "Segoe Print", "Comic Sans MS", cursive';
        g.fillStyle = '#2f2a22'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
        g.fillText('HOME VIDEO', padX + 10, labelY + labelH * 0.47);
        const handFs2 = Math.max(8, Math.round(labelH * 0.20));
        g.font = 'bold ' + handFs2 + 'px "Segoe Print", "Comic Sans MS", cursive';
        g.fillStyle = 'rgba(55,45,35,0.78)';
        g.fillText("SUMMER '98  ·  SP", padX + 11, labelY + labelH * 0.76);

        const bcX = padX + labelW + Math.max(10, Math.round(iw * 0.025));
        const bcW = Math.max(18, w - padX - bcX);
        const bcY = labelY + Math.max(2, Math.round(labelH * 0.10));
        const bcH = Math.max(12, Math.round(labelH * 0.44));
        g.fillStyle = '#e6dcc3';
        fillRoundRectCtx(g, bcX - 6, bcY - 5, bcW + 8, bcH + Math.max(12, labelH * 0.35) + 10, 2);
        g.fillStyle = '#181716';
        let bx = bcX, bi = 0;
        while (bx < bcX + bcW) {
            const bw = 1 + ((bi * 7 + 3) % 3);
            const gap = 1 + ((bi * 5 + 1) % 2);
            if (bx + bw > bcX + bcW) break;
            g.fillRect(bx, bcY, bw, bcH);
            bx += bw + gap; bi++;
        }
        g.font = 'bold ' + Math.max(7, Math.round(labelH * 0.16)) + 'px monospace';
        g.fillStyle = '#2f2a22'; g.textAlign = 'center';
        g.fillText('T-120', bcX + bcW / 2, bcY + bcH + Math.max(9, labelH * 0.18));
        g.textAlign = 'left';

        const noiseY = h - Math.max(4, Math.round(botH * 0.06));
        for (let i = 0; i < Math.round(w / 12); i++) {
            const nx = (i * 37 + 11) % w;
            const nw = 5 + ((i * 13) % 17);
            const colors = ['rgba(230,230,225,0.20)', 'rgba(120,255,180,0.25)', 'rgba(255,70,90,0.18)'];
            g.fillStyle = colors[i % 3];
            g.fillRect(nx, noiseY + (i % 2), Math.min(nw, w - nx), 1);
        }
    }
    function styleAlbumCorner(img, size, g, iw, ih) {
        const G = albumGeom(iw, ih, size);
        const { padX, padTop, padBottom, printBorder, w, h, photoX, photoY } = G;
        // 深绿相册纸 + 纸纹 + 装订孔。
        const page = g.createLinearGradient(0, 0, w, h);
        page.addColorStop(0, '#34483c'); page.addColorStop(0.55, '#263a30'); page.addColorStop(1, '#16241d');
        g.fillStyle = page; g.fillRect(0, 0, w, h);
        const rnd = styleNoise(iw, ih, 1978);
        g.fillStyle = 'rgba(225,235,215,0.035)';
        for (let i = 0; i < Math.min(560, Math.floor(w * h / 2600)); i++) {
            g.beginPath(); g.arc(rnd(w), rnd(h), 0.4 + rnd(2) * 0.4, 0, 6.2832); g.fill();
        }
        g.strokeStyle = 'rgba(190,165,115,0.30)'; g.lineWidth = 1;
        g.strokeRect(12.5, 12.5, w - 25, h - 25);
        const holeR = Math.max(6, Math.round(padX * 0.13));
        const holeX = Math.round(padX * 0.36);
        for (const t of [0.24, 0.50, 0.76]) {
            const hy = Math.round(padTop + ih * t);
            g.fillStyle = '#0c110e';
            g.beginPath(); g.arc(holeX, hy, holeR, 0, 6.2832); g.fill();
            g.strokeStyle = 'rgba(190,165,115,0.55)'; g.lineWidth = Math.max(1.2, holeR * 0.18);
            g.beginPath(); g.arc(holeX, hy, holeR, 0, 6.2832); g.stroke();
            g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
            g.beginPath(); g.arc(holeX - holeR * 0.22, hy - holeR * 0.22, holeR * 0.55, 0, 6.2832); g.stroke();
        }

        // 米色照片纸 + 柔和投影。
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.48)';
        g.shadowBlur = Math.max(12, Math.round(size * 0.35));
        g.shadowOffsetY = Math.max(4, Math.round(size * 0.08));
        g.fillStyle = '#f2e7d2';
        g.fillRect(photoX - printBorder, photoY - printBorder, iw + printBorder * 2, ih + printBorder * 2);
        g.restore();
        g.strokeStyle = 'rgba(175,145,95,0.38)'; g.lineWidth = 1;
        g.strokeRect(photoX - printBorder + 0.5, photoY - printBorder + 0.5, iw + printBorder * 2 - 1, ih + printBorder * 2 - 1);
        g.drawImage(img, photoX, photoY, iw, ih);
        g.strokeStyle = 'rgba(60,45,30,0.30)'; g.lineWidth = 1;
        g.strokeRect(photoX - 0.5, photoY - 0.5, iw + 1, ih + 1);

        // 四个角贴:奶油色三角口袋,带折痕与投影。
        const cs = Math.max(30, Math.round(Math.min(iw, ih) * 0.075));
        const corners = [[photoX, photoY, 1, 1], [photoX + iw, photoY, -1, 1], [photoX, photoY + ih, 1, -1], [photoX + iw, photoY + ih, -1, -1]];
        for (const [cx, cy, sx, sy] of corners) {
            g.save();
            g.shadowColor = 'rgba(0,0,0,0.30)'; g.shadowBlur = 4; g.shadowOffsetX = 2; g.shadowOffsetY = 2;
            g.fillStyle = '#e4cfa8';
            g.beginPath();
            g.moveTo(cx, cy);
            g.lineTo(cx + sx * cs, cy);
            g.quadraticCurveTo(cx + sx * cs * 0.58, cy + sy * cs * 0.58, cx, cy + sy * cs);
            g.closePath(); g.fill();
            g.restore();
            g.strokeStyle = 'rgba(105,80,48,0.50)'; g.lineWidth = 1;
            g.beginPath();
            g.moveTo(cx + sx * cs * 0.90, cy + sy * 2.5);
            g.quadraticCurveTo(cx + sx * cs * 0.55, cy + sy * cs * 0.55, cx + sx * 2.5, cy + sy * cs * 0.90);
            g.stroke();
            g.strokeStyle = 'rgba(255,250,235,0.40)'; g.lineWidth = 1;
            g.beginPath();
            g.moveTo(cx + sx * 3, cy + sy * 3);
            g.lineTo(cx + sx * cs * 0.82, cy + sy * 5);
            g.stroke();
        }

        // 手写题注 + 日期/页码。
        const capTop = photoY + ih + printBorder;
        g.save();
        g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.fillStyle = 'rgba(239,226,203,0.94)';
        g.font = '700 ' + Math.max(18, Math.round(iw * 0.032)) + 'px "Segoe Script", "Comic Sans MS", cursive';
        g.fillText('Summer at the lake', w / 2, capTop + Math.round(padBottom * 0.34));
        g.font = 'bold ' + Math.max(8, Math.round(iw * 0.010)) + 'px Georgia, serif';
        g.fillStyle = 'rgba(232,216,188,0.62)';
        g.fillText('1978  ·  PAGE 07', w / 2, capTop + Math.round(padBottom * 0.53));
        g.textAlign = 'left';
        g.font = 'bold ' + Math.max(7, Math.round(iw * 0.008)) + 'px monospace';
        g.fillStyle = 'rgba(232,216,188,0.45)';
        g.fillText('ALBUM 07', padX, h - Math.max(12, Math.round(padBottom * 0.11)));
        g.textAlign = 'right';
        g.fillStyle = 'rgba(220,155,105,0.58)';
        g.font = 'bold ' + Math.max(8, Math.round(iw * 0.009)) + 'px "Courier New", monospace';
        g.fillText('JUN 12 1978', w - padX, h - Math.max(12, Math.round(padBottom * 0.11)));
        g.restore();
    }
    // ── 撕边电影票(MOVIE_TICKET)────────────────────────────────────────────────
    // 与票根家族同一套「真票券」做法:浮在模糊照片上、四边真齿孔、纸纹 multiply 叠、
    // 挖孔前显式黑笔刷。保留电影票自己的身份:深色票头(影院名+日期时间)/ 浅色信息带
    // (场次·影厅·座位·票价)/ 深色票脚(标语+票号)/ 右侧副券 + 竖向三角锯齿撕线 +
    // 竖排 ADMIT ONE + 虚线票框 + 检票后作废。与票根家族唯一的几何差别:撕线是竖向的
    // (副券在右),不是底部横向存根。
    // 可选签名/头像:照片与深色票脚之间多一条票纸行(与票根家族同款,有无决定 movieGeom 的 sigH)。
    //
    // 尺寸必须与 styleDims() 的 MOVIE_TICKET 分支同源 —— 旧版两处各写一套
    // (styleDims 是上下各 max(30,size*0.8),styleMovieTicket 却是 票头+信息带+票脚),
    // 登记的画布比实际画出来的票面矮 70 多像素,票脚整条被切掉。
    //
    // sigH:照片与深色票脚之间的可选「签名/头像行」,与票根家族同一套做法 ——
    // 只有真的有签名或头像时才存在(0 时几何与重做版逐像素一致,冻结指纹不动)。
    function movieGeom(iw, ih, size, hasAv, hasSig) {
        const side = Math.max(20, Math.round(size * 0.7));      // 照片左纸边(右侧是副券)
        const headH = Math.max(34, Math.round(size * 0.85));    // 深色票头
        const infoH = Math.max(26, Math.round(size * 0.62));    // 信息带
        const footH = Math.max(32, Math.round(size * 0.8));     // 深色票脚
        const sigH = (hasAv || hasSig) ? Math.max(40, Math.round(size * 1.5)) : 0;
        const stubW = Math.max(150, Math.round(iw * 0.28));     // 右侧副券
        const gap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
        const holeR = Math.max(3, Math.round(size * 0.225));
        const tooth = Math.max(6, Math.round(size * 0.18));     // 锯齿齿高
        const tw = iw + side * 2 + stubW;
        const th = headH + infoH + ih + sigH + footH;
        return {
            side: side, headH: headH, infoH: infoH, footH: footH, stubW: stubW, sigH: sigH,
            gap: gap, holeR: holeR, tooth: tooth, tw: tw, th: th, tearX: side + iw,
            w: tw + gap * 2, h: th + gap * 2
        };
    }

    function styleMovieTicket(img, size, g, iw, ih, S) {
        const hasAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete
            && window.__qfsAvatarImg.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        const hasSig = !!(S && S.userSignature);
        const G = movieGeom(iw, ih, size, hasAv, hasSig);
        const side = G.side, headH = G.headH, infoH = G.infoH, footH = G.footH, sigH = G.sigH;
        const gap = G.gap, holeR = G.holeR, tooth = G.tooth;
        const tw = G.tw, th = G.th, tearX = G.tearX, w = G.w, h = G.h;
        const pal = {
            paper: '#f7f2e9', band: '#ece4d4', ink: '#2c2720',
            gold: '#b08a3a', goldL: '#d8c188', sub: '#8a6d3b', body: '#5a4a33'
        };
        const fam = '"Arial", sans-serif';

        const d = new Date();
        const dateStr = d.getFullYear() + '/' + pad0(d.getMonth() + 1) + '/' + pad0(d.getDate());
        const timeStr = pad0(d.getHours()) + ':' + pad0(d.getMinutes());
        const noStr = 'NO.' + d.getFullYear() + pad0(d.getMonth() + 1) + pad0(d.getDate());
        const infoStr = '场次 20:30   ·   3号厅   ·   08排12号   ·   ¥35';

        // 逐级缩字号到实测宽度(带 track 的字距要算进去)
        const fitW = (text, startFs, maxW, bold, track) => {
            let fs = startFs;
            while (fs > 9 && ticketTextW(g, text, fs, fam, bold, track) > maxW) fs--;
            return fs;
        };

        // ① 模糊底(与票根家族同一套:外扩 + 叠自己两遍保证整幅不透明)
        const blurR = Math.max(14, Math.round(size * 0.8));
        const bgPad = blurR * 4;
        const bgScale = Math.max((w + bgPad) / iw, (h + bgPad) / ih);
        const bg = newCanvas(w, h);
        const bgG = bg.getContext('2d');
        bgG.filter = 'blur(' + blurR + 'px)';
        bgG.drawImage(img, (w - iw * bgScale) / 2, (h - ih * bgScale) / 2, iw * bgScale, ih * bgScale);
        bgG.filter = 'none';
        bgG.drawImage(bg, 0, 0);
        bgG.drawImage(bg, 0, 0);
        g.drawImage(bg, 0, 0);

        // ② 票面(离屏):纸底 → 纹理(multiply) → 深色票头/信息带/深色票脚 → 副券底纹 → 齿孔
        const tc = newCanvas(tw, th);
        const tg = tc.getContext('2d');
        tg.fillStyle = pal.paper;
        tg.fillRect(0, 0, tw, th);
        tg.save();
        tg.globalCompositeOperation = 'multiply';
        tg.fillStyle = ticketPaperPattern();
        tg.fillRect(0, 0, tw, th);
        tg.restore();
        tg.fillStyle = pal.ink;
        tg.fillRect(0, 0, tw, headH);
        tg.fillRect(0, th - footH, tw, footH);
        tg.fillStyle = pal.band;
        tg.fillRect(0, headH, tw, infoH);
        tg.strokeStyle = 'rgba(90,70,40,0.20)';
        tg.lineWidth = 1;
        tg.beginPath();
        tg.moveTo(0, headH + infoH - 0.5);
        tg.lineTo(tw, headH + infoH - 0.5);
        tg.stroke();
        // 副券底纹微暗:必须在挖孔之前(旧版画在锯齿之后,把齿尖两侧染出深浅差)
        tg.fillStyle = 'rgba(0,0,0,0.05)';
        tg.fillRect(tearX, headH + infoH, tw - tearX, ih + sigH);

        // 齿孔:四边 + 四角 + 竖向锯齿撕线(副券)
        const pitch = Math.max(holeR * 4, 9);
        tg.globalCompositeOperation = 'destination-out';
        tg.fillStyle = '#000000';   // ⚠ 显式设置,别沿用上面的低透明度填充
        const rowX = ticketPerfRow(tw, holeR * 2, pitch);
        const rowY = ticketPerfRow(th, holeR * 2, pitch);
        for (let i = 0; i < rowX.length; i++) {
            tg.beginPath(); tg.arc(rowX[i], 0, holeR, 0, 6.2832); tg.fill();
            tg.beginPath(); tg.arc(rowX[i], th, holeR, 0, 6.2832); tg.fill();
        }
        for (let i = 0; i < rowY.length; i++) {
            tg.beginPath(); tg.arc(0, rowY[i], holeR, 0, 6.2832); tg.fill();
            tg.beginPath(); tg.arc(tw, rowY[i], holeR, 0, 6.2832); tg.fill();
        }
        tg.beginPath(); tg.arc(0, 0, holeR, 0, 6.2832); tg.fill();
        tg.beginPath(); tg.arc(tw, 0, holeR, 0, 6.2832); tg.fill();
        tg.beginPath(); tg.arc(0, th, holeR, 0, 6.2832); tg.fill();
        tg.beginPath(); tg.arc(tw, th, holeR, 0, 6.2832); tg.fill();
        // 竖向锯齿撕线:贯穿整条票高(票头/票脚也咬穿,才像真撕开的边)
        tg.beginPath();
        for (let y = -tooth; y <= th; y += tooth * 2) {
            tg.moveTo(tearX - tooth, y);
            tg.lineTo(tearX, y + tooth);
            tg.lineTo(tearX + tooth, y);
        }
        tg.fill();
        tg.globalCompositeOperation = 'source-over';

        // ③ 贴到画布:票券浮在模糊照片上,四周留 gap(齿孔/锯齿透出的就是这圈模糊)
        g.drawImage(tc, gap, gap);

        // ④ 照片(带 imgScale / imgOffset / 圆角,与票根家族一致)
        const sc = (S && S.imgScale) || 1;
        const dw = iw * sc, dh = ih * sc;
        const rectX = gap + side, rectY = gap + headH + infoH;
        const px0 = rectX + (iw - dw) / 2 + ((S && S.imgOffsetX) || 0);
        const py0 = rectY + (ih - dh) / 2 + ((S && S.imgOffsetY) || 0);
        const arcR = S ? Math.min(S.cornerAll || 0, Math.min(iw, ih) / 2) : 0;
        g.save();
        g.beginPath();
        if (arcR > 1 && typeof g.roundRect === 'function') g.roundRect(rectX, rectY, iw, ih, arcR);
        else g.rect(rectX, rectY, iw, ih);
        g.clip();
        g.drawImage(img, px0, py0, dw, dh);
        g.restore();
        g.strokeStyle = 'rgba(90,70,40,0.30)';
        g.lineWidth = 1;
        if (arcR > 1 && typeof g.roundRect === 'function') {
            g.beginPath(); g.roundRect(rectX - 0.5, rectY - 0.5, iw + 1, ih + 1, arcR); g.stroke();
        } else {
            g.strokeRect(rectX - 0.5, rectY - 0.5, iw + 1, ih + 1);
        }

        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        const inset = Math.max(16, Math.round(side * 0.9));

        // ④b 签名/头像行(可选):照片正下方、深色票脚之上的一条票纸,与票根家族同一套做法。
        //     头像+签名作为一组居中,居中基准 = 照片中心(与照片对齐);可用宽度按照片宽度算,
        //     所以整组永远落在撕线左侧的主票面内,不会压在竖向锯齿上。
        //     没有签名也没有头像时 sigH=0,这一行连同它的高度都不存在。
        if (sigH > 0) {
            const rowY = gap + headH + infoH + ih + Math.round(sigH * 0.5);
            const cx = gap + side + iw / 2;
            const avatarR = Math.round(sigH * 0.19 * ((S && S.avatarScale) || 1));
            const sigBody = hasSig ? String(S.userSignature) : '';
            const gapA = Math.max(8, Math.round(avatarR * 0.25));
            const availW = iw - inset * 2 - (hasAv ? avatarR * 2 + gapA : 0);
            const fit = sigBody
                ? fitSignText(g, sigBody, Math.max(12, Math.round(sigH * 0.34 * ((S && S.signSize) || 1))),
                    (S && S.signFont) || 'Courier New', availW)
                : { fs: 0, text: '' };
            const sigWS = fit.text ? g.measureText(fit.text).width : 0;
            const totalW = (hasAv ? avatarR * 2 : 0) + (hasAv && sigWS ? gapA : 0) + sigWS;
            let px = cx - totalW / 2;
            if (hasAv) {
                const av = window.__qfsAvatarImg;
                const sc2 = Math.max(avatarR * 2 / av.width, avatarR * 2 / av.height);
                g.save();
                g.beginPath(); g.arc(px + avatarR, rowY, avatarR, 0, 6.2832); g.clip();
                g.drawImage(av, px + avatarR - av.width * sc2 / 2, rowY - av.height * sc2 / 2,
                    av.width * sc2, av.height * sc2);
                g.restore();
                g.strokeStyle = 'rgba(90,70,40,0.30)';
                g.lineWidth = 1.5;
                g.beginPath(); g.arc(px + avatarR, rowY, avatarR, 0, 6.2832); g.stroke();
                px += avatarR * 2 + (sigWS ? gapA : 0);
            }
            if (fit.text) {
                g.fillStyle = (S && S.signColor) || pal.ink;
                g.textAlign = 'left';
                g.textBaseline = 'middle';
                g.fillText(fit.text, px, rowY);
                g.textAlign = 'left';
                g.textBaseline = 'alphabetic';
            }
        }

        // ⑤ 票头:影院名(左) + 日期时间(右)
        const hFs = Math.max(13, Math.round(headH * 0.55));
        ticketText(g, 'CINEMA', gap + inset, gap + Math.round(headH * 0.70), pal.paper, hFs, fam, true, 1);
        const dtFs = Math.max(11, Math.round(hFs * 0.82));
        const dtStr = dateStr + '  ' + timeStr;
        const dtW = ticketTextW(g, dtStr, dtFs, fam, true, 1);
        ticketText(g, dtStr, gap + tw - inset - dtW, gap + Math.round(headH * 0.70), pal.goldL, dtFs, fam, true, 1);

        // ⑥ 信息带:场次·影厅·座位·票价(左对齐,右端不越撕线)
        const iFs = fitW(infoStr, Math.max(11, Math.round(infoH * 0.52)), tearX - inset - Math.round(size * 0.6), true, 0);
        ticketText(g, infoStr, gap + inset, gap + headH + Math.round(infoH * 0.70), pal.body, iFs, fam, true, 0);

        // ⑦ 票脚:标语(左) + 票号(右)
        const fFs = Math.max(11, Math.round(footH * 0.5));
        ticketText(g, 'MEMORY TICKET', gap + inset, gap + th - Math.round(footH * 0.35), pal.paper, fFs, fam, true, 1);
        const noFs = Math.max(10, Math.round(fFs * 0.85));
        const noW = ticketTextW(g, noStr, noFs, fam, true, 1);
        ticketText(g, noStr, gap + tw - inset - noW, gap + th - Math.round(footH * 0.35), pal.goldL, noFs, fam, true, 1);

        // ⑧ 副券:小标题 / 虚线票框 + ROW·SEAT·SCREEN / 检票后作废 / 竖排 ADMIT ONE
        const sL = gap + tearX + tooth + Math.max(10, Math.round(size * 0.14));   // 内容左边(避开齿尖)
        const sR = gap + tw - inset;                                             // 内容右边
        const sTop = gap + headH + infoH;                                        // 照片带上沿
        const sBot = sTop + ih;                                                  // 下沿
        const stFs = Math.max(10, Math.round(size * 0.32));
        const stTitle = '副券  STUB';
        const stW = ticketTextW(g, stTitle, stFs, fam, true, 1);
        ticketText(g, stTitle, Math.round((sL + sR - stW) / 2), sTop + Math.round(ih * 0.10), pal.sub, stFs, fam, true, 1);
        // 竖排 ADMIT ONE:贴副券右缘(旋转 -90° 后字身向左,票框右端让开它的列宽)
        const adFs = Math.max(14, Math.round(size * 0.42));
        const adStr = 'ADMIT ONE';
        const adW = ticketTextW(g, adStr, adFs, fam, true, 2);
        const adX = sR - Math.round(adFs * 0.72);
        g.save();
        g.translate(adX, Math.round((sTop + sBot) / 2));
        g.rotate(-Math.PI / 2);
        ticketText(g, adStr, -Math.round(adW / 2), Math.round(adFs * 0.36), pal.gold, adFs, fam, true, 2);
        g.restore();
        // 虚线票框 + 三行座位信息
        const frX = sL;
        const frW = Math.max(60, (adX - Math.round(adFs * 0.8)) - frX);
        const frY = sTop + Math.round(ih * 0.20);
        const frH = Math.round(ih * 0.50);
        g.save();
        g.strokeStyle = 'rgba(140,110,60,0.55)';
        g.lineWidth = 1;
        g.setLineDash([4, 3]);
        g.strokeRect(frX + 0.5, frY + 0.5, frW, frH);
        g.restore();
        const rFs = Math.max(11, Math.round(size * 0.30));
        const rRows = ['ROW 12', 'SEAT 08', 'SCREEN 7'];
        for (let i = 0; i < rRows.length; i++) {
            ticketText(g, rRows[i], frX + 14, frY + Math.round(frH * (0.30 + i * 0.25)), pal.body, rFs, fam, true, 1);
        }
        ticketText(g, '检票后作废', sL, sBot - Math.round(ih * 0.04), '#a08a5a', Math.max(9, Math.round(stFs * 0.8)), fam, false, 0);

        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
    }

    // ── 复古登机牌(BOARDING_PASS)──────────────────────────────────────────────
    // 与票根家族同一套「真票券」做法(模糊底 + 真齿孔 + 锯齿撕线),版式换成登机牌:
    //   票头(✈ BOARDING PASS + 出发地 → 目的地 + 航班号)→ 信息带(登机口/座位/登机时间)
    //   → 主照片 → 可选签名/头像行 → 票脚(航空名 + 票号);
    //   右侧一条竖向锯齿撕线切出副券(存根):小标题 + 条形码 + 竖排 BOARDING/SEAT/GATE。
    // 配色沿用旧「复古登机牌」预设的紫蓝四色渐变:旧实现是拿一张全幅渐变图层 + 胶片齿孔
    // 装饰假装票券,现在由本风格把渐变真画在票面上(渐变即票面底色,不再是背景图层)。
    // 尺寸必须与 styleDims() 的 BOARDING_PASS 分支同源 —— 两边都调 boardingGeom()。
    function boardingGeom(iw, ih, size, hasAv, hasSig) {
        const side = Math.max(22, Math.round(size * 1.0));       // 照片左纸边(右侧是副券)
        const headH = Math.max(64, Math.round(size * 2.3));      // 票头:标题 + 城市码 + 航班号
        const infoH = Math.max(30, Math.round(size * 1.05));     // 信息带:登机口/座位/登机时间
        const footH = Math.max(30, Math.round(size * 0.95));     // 票脚:航空名 + 票号
        const sigH = (hasAv || hasSig) ? Math.max(44, Math.round(size * 1.6)) : 0;
        const stubW = Math.max(150, Math.round(iw * 0.30));      // 右侧副券(存根)
        const gap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
        const holeR = Math.max(3, Math.round(size * 0.225));
        const tooth = Math.max(6, Math.round(size * 0.18));      // 锯齿齿高
        const tw = iw + side * 2 + stubW;
        const th = headH + infoH + ih + sigH + footH;
        return {
            side: side, headH: headH, infoH: infoH, footH: footH, stubW: stubW, sigH: sigH,
            gap: gap, holeR: holeR, tooth: tooth, tw: tw, th: th, tearX: side + iw,
            w: tw + gap * 2, h: th + gap * 2
        };
    }

    function styleBoardingPass(img, size, g, iw, ih, S) {
        const hasAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete
            && window.__qfsAvatarImg.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        const hasSig = !!(S && S.userSignature);
        const G = boardingGeom(iw, ih, size, hasAv, hasSig);
        const side = G.side, headH = G.headH, infoH = G.infoH, footH = G.footH, sigH = G.sigH;
        const stubW = G.stubW, gap = G.gap, holeR = G.holeR, tooth = G.tooth;
        const tw = G.tw, th = G.th, tearX = G.tearX;

        // 配色:旧预设的紫蓝渐变 + 米白字 + 暖金点缀
        const ink = '#f3f1fa', sub = 'rgba(243,241,250,0.74)', dim = 'rgba(243,241,250,0.44)';
        const gold = '#e9c98d', rule = 'rgba(243,241,250,0.30)';
        const fam = '"Arial", "Microsoft YaHei", sans-serif';
        const famDisplay = '"Georgia", "Times New Roman", serif';

        const d = new Date();
        const dateStr = d.getFullYear() + '.' + pad0(d.getMonth() + 1) + '.' + pad0(d.getDate());
        const noBase = 100 + Math.abs(iw * 29 + ih * 13) % 900;
        const noStr = 'NO.' + d.getFullYear() + '-' + String(noBase).padStart(3, '0');
        // 版式文字为装饰性常量(与票根家族一致:不取自 EXIF)
        const from = 'SZX', to = 'NRT', flight = 'QA 0808';
        const stubV = 'BOARDING   SEAT 08A   GATE A12';

        // ① 下层:模糊照片铺满画布 —— 齿孔/锯齿挖穿后透出的就是这一层。
        //    外扩 + 叠自己两遍保证整幅不透明(与票根/电影票同一套,理由见 styleTicket)
        const blurR = Math.max(14, Math.round(size * 0.8));
        const bgPad = blurR * 4;
        const bgScale = Math.max((G.w + bgPad) / iw, (G.h + bgPad) / ih);
        const bg = newCanvas(G.w, G.h);
        const bgG = bg.getContext('2d');
        bgG.filter = 'blur(' + blurR + 'px)';
        bgG.drawImage(img, (G.w - iw * bgScale) / 2, (G.h - ih * bgScale) / 2, iw * bgScale, ih * bgScale);
        bgG.filter = 'none';
        bgG.drawImage(bg, 0, 0);
        bgG.drawImage(bg, 0, 0);
        g.drawImage(bg, 0, 0);

        // ② 票面(离屏):紫蓝渐变 → 纸纹(multiply)→ 分区压暗/提亮 → 内框 → 真齿孔 + 竖向锯齿撕线
        const tc = newCanvas(tw, th);
        const tg = tc.getContext('2d');
        const lg = tg.createLinearGradient(0, 0, 0, th);
        lg.addColorStop(0, '#7b77a1');
        lg.addColorStop(0.45, '#6e6a96');
        lg.addColorStop(0.72, '#4a5275');
        lg.addColorStop(1, '#212839');
        tg.fillStyle = lg;
        tg.fillRect(0, 0, tw, th);
        // 纸纹颗粒:multiply 叠加(白底=1.0 不改配色,只加纤维颗粒;详见 styleTicket 注释)
        tg.save();
        tg.globalCompositeOperation = 'multiply';
        tg.fillStyle = ticketPaperPattern();
        tg.fillRect(0, 0, tw, th);
        tg.restore();
        tg.fillStyle = 'rgba(6,8,22,0.38)';           // 票头压暗(浅色字要有对比)
        tg.fillRect(0, 0, tw, headH);
        tg.fillStyle = 'rgba(6,8,22,0.30)';           // 票脚压暗
        tg.fillRect(0, th - footH, tw, footH);
        tg.fillStyle = 'rgba(255,255,255,0.10)';
        tg.fillRect(0, headH, tw, infoH);
        tg.fillStyle = 'rgba(0,0,0,0.10)';           // 副券整条微暗 —— 必须在挖孔之前
        tg.fillRect(tearX, 0, tw - tearX, th);
        // 签名/头像行直接印在票面上,不垫浅色条(与同族演唱会票根 TICKET_CONCERT 一致)。
        // 代价是引擎默认的签名色 #555(见此文件 buildState 的 signColor)在这张紫蓝卡上
        // 亮度差不到 1.5:1,等于看不见 —— 所以由预设显式给一个米白 signColor(#f3f1fa),
        // 面板里的「签名颜色」仍可随时改。
        // 内框(浅色细线)+ 信息带下边细线
        const fIn = Math.max(16, Math.round(holeR * 2.0));
        tg.strokeStyle = rule;
        tg.lineWidth = 1.4;
        tg.strokeRect(fIn, fIn, tw - fIn * 2, th - fIn * 2);
        tg.lineWidth = 1;
        tg.beginPath();
        tg.moveTo(0, headH + infoH - 0.5);
        tg.lineTo(tw, headH + infoH - 0.5);
        tg.stroke();

        // ③ 齿孔:四边 + 四角 + 竖向锯齿撕线(副券,贯穿整条票高)
        const pitch = Math.max(holeR * 4, 9);
        tg.globalCompositeOperation = 'destination-out';
        tg.fillStyle = '#000000';   // ⚠ 显式设置,别沿用上面的浅色描边(见文件头注释)
        const rowX = ticketPerfRow(tw, holeR * 2, pitch);
        const rowY = ticketPerfRow(th, holeR * 2, pitch);
        for (let i = 0; i < rowX.length; i++) {
            tg.beginPath(); tg.arc(rowX[i], 0, holeR, 0, 6.2832); tg.fill();
            tg.beginPath(); tg.arc(rowX[i], th, holeR, 0, 6.2832); tg.fill();
        }
        for (let i = 0; i < rowY.length; i++) {
            tg.beginPath(); tg.arc(0, rowY[i], holeR, 0, 6.2832); tg.fill();
            tg.beginPath(); tg.arc(tw, rowY[i], holeR, 0, 6.2832); tg.fill();
        }
        tg.beginPath(); tg.arc(0, 0, holeR, 0, 6.2832); tg.fill();
        tg.beginPath(); tg.arc(tw, 0, holeR, 0, 6.2832); tg.fill();
        tg.beginPath(); tg.arc(0, th, holeR, 0, 6.2832); tg.fill();
        tg.beginPath(); tg.arc(tw, th, holeR, 0, 6.2832); tg.fill();
        tg.beginPath();
        for (let y = -tooth; y <= th; y += tooth * 2) {
            tg.moveTo(tearX - tooth, y);
            tg.lineTo(tearX, y + tooth);
            tg.lineTo(tearX + tooth, y);
        }
        tg.fill();
        tg.globalCompositeOperation = 'source-over';

        // ④ 贴到画布:票券浮在模糊照片上,四周留 gap(齿孔/锯齿透出的就是这圈模糊)
        g.drawImage(tc, gap, gap);

        // ⑤ 照片(带 imgScale / imgOffset / 圆角,与票根家族一致)
        const sc = (S && S.imgScale) || 1;
        const dw = iw * sc, dh = ih * sc;
        const rectX = gap + side, rectY = gap + headH + infoH;
        const px0 = rectX + (iw - dw) / 2 + ((S && S.imgOffsetX) || 0);
        const py0 = rectY + (ih - dh) / 2 + ((S && S.imgOffsetY) || 0);
        const arcR = S ? Math.min(S.cornerAll || 0, Math.min(iw, ih) / 2) : 0;
        g.save();
        g.beginPath();
        if (arcR > 1 && typeof g.roundRect === 'function') g.roundRect(rectX, rectY, iw, ih, arcR);
        else g.rect(rectX, rectY, iw, ih);
        g.clip();
        g.drawImage(img, px0, py0, dw, dh);
        g.restore();
        g.strokeStyle = 'rgba(243,241,250,0.34)';
        g.lineWidth = 1;
        if (arcR > 1 && typeof g.roundRect === 'function') {
            g.beginPath(); g.roundRect(rectX - 0.5, rectY - 0.5, iw + 1, ih + 1, arcR); g.stroke();
        } else {
            g.strokeRect(rectX - 0.5, rectY - 0.5, iw + 1, ih + 1);
        }

        const inset = Math.max(16, Math.round(side * 0.9));

        // ⑥ 签名/头像行(可选):照片正下方、票脚之上;整组居中于「照片中线」(与票根家族同一套)。
        //    可用宽度只按照片宽度算 —— 整组永远落在撕线左侧的主票面内,不会压在竖向锯齿上。
        if (sigH > 0) {
            const rowY = gap + headH + infoH + ih + Math.round(sigH * 0.5);
            const cx = gap + side + iw / 2;
            const avatarR = Math.round(sigH * 0.19 * ((S && S.avatarScale) || 1));
            const sigBody = hasSig ? String(S.userSignature) : '';
            const gapA = Math.max(8, Math.round(avatarR * 0.25));
            const availW = iw - inset * 2 - (hasAv ? avatarR * 2 + gapA : 0);
            const fit = sigBody
                ? fitSignText(g, sigBody, Math.max(12, Math.round(sigH * 0.36 * ((S && S.signSize) || 1))),
                    (S && S.signFont) || 'Courier New', availW)
                : { fs: 0, text: '' };
            const sigWS = fit.text ? g.measureText(fit.text).width : 0;
            const totalW = (hasAv ? avatarR * 2 : 0) + (hasAv && sigWS ? gapA : 0) + sigWS;
            let px = cx - totalW / 2;
            if (hasAv) {
                const av = window.__qfsAvatarImg;
                const sc2 = Math.max(avatarR * 2 / av.width, avatarR * 2 / av.height);
                g.save();
                g.beginPath(); g.arc(px + avatarR, rowY, avatarR, 0, 6.2832); g.clip();
                g.drawImage(av, px + avatarR - av.width * sc2 / 2, rowY - av.height * sc2 / 2,
                    av.width * sc2, av.height * sc2);
                g.restore();
                g.strokeStyle = 'rgba(243,241,250,0.42)';   // 深色票面 → 头像描边用浅色(与票面文字同族)
                g.lineWidth = 1.5;
                g.beginPath(); g.arc(px + avatarR, rowY, avatarR, 0, 6.2832); g.stroke();
                px += avatarR * 2 + (sigWS ? gapA : 0);
            }
            if (fit.text) {
                g.fillStyle = (S && S.signColor) || ink;
                g.textAlign = 'left';
                g.textBaseline = 'middle';
                g.fillText(fit.text, px, rowY);
                g.textAlign = 'left';
                g.textBaseline = 'alphabetic';
            }
        }

        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';

        // ⑦ 票头:行1 = ✈ BOARDING PASS(左)+ 日期(右,止于撕线);行2 = 出发地 → 目的地 + 航班号
        const hFs = Math.max(11, Math.round(headH * 0.19));
        const hY = gap + Math.round(headH * 0.30);
        ticketText(g, '✈  BOARDING PASS', gap + inset, hY, sub, hFs, fam, true, 2);
        const dtW = ticketTextW(g, dateStr, hFs, fam, false, 1);
        ticketText(g, dateStr, gap + tearX - inset - dtW, hY, dim, hFs, fam, false, 1);
        const codeFs = Math.max(22, Math.round(headH * 0.40));
        const codeY = gap + Math.round(headH * 0.80);
        const codeTrack = 3;
        const fromW = ticketTextW(g, from, codeFs, famDisplay, true, codeTrack);
        ticketText(g, from, gap + inset, codeY, ink, codeFs, famDisplay, true, codeTrack);
        const arFs = Math.round(codeFs * 0.62);
        const arX = gap + inset + fromW + Math.round(codeFs * 0.34);
        const arW = ticketTextW(g, '→', arFs, fam, false, 0);
        ticketText(g, '→', arX, codeY - Math.round(codeFs * 0.06), gold, arFs, fam, false, 0);
        const toX = arX + arW + Math.round(codeFs * 0.34);
        ticketText(g, to, toX, codeY, ink, codeFs, famDisplay, true, codeTrack);
        const flFs = Math.max(12, Math.round(headH * 0.17));
        const flW = ticketTextW(g, flight, flFs, famDisplay, true, 3);
        ticketText(g, flight, gap + tearX - inset - flW, codeY - Math.round(codeFs * 0.05),
            gold, flFs, famDisplay, true, 3);

        // ⑧ 信息带:登机口/座位/登机时间(标签淡、值亮,单行内联)
        const iFs = Math.max(12, Math.round(infoH * 0.44));
        const iY = gap + headH + Math.round(infoH * 0.70);
        let sx = gap + inset;
        const seg = (label, value) => {
            const lf = Math.max(9, Math.round(iFs * 0.66));
            ticketText(g, label, sx, iY, dim, lf, fam, false, 1);
            sx += ticketTextW(g, label, lf, fam, false, 1) + Math.round(lf * 0.6);
            ticketText(g, value, sx, iY, ink, iFs, fam, true, 1);
            sx += ticketTextW(g, value, iFs, fam, true, 1) + Math.round(iFs * 1.5);
        };
        seg('GATE', 'A12');
        seg('SEAT', '08A');
        seg('BOARDING', '20:30');

        // ⑨ 票脚:航空名(左)+ 票号(右)
        const fFs = Math.max(11, Math.round(footH * 0.42));
        ticketText(g, 'MEMORY AIRLINES', gap + inset, gap + th - Math.round(footH * 0.34), gold, fFs, fam, true, 2);
        const noFs = Math.max(10, Math.round(fFs * 0.9));
        const noW = ticketTextW(g, noStr, noFs, fam, false, 1);
        ticketText(g, noStr, gap + tw - inset - noW, gap + th - Math.round(footH * 0.34), dim, noFs, fam, false, 1);

        // ⑩ 副券:小标题 + 横向条形码 + 竖排 BOARDING/SEAT/GATE + 底部票号(内容区避开撕线齿尖)
        const sL = gap + tearX + tooth + Math.max(10, Math.round(size * 0.16));
        const sR = gap + tw - inset;
        const sTop = gap + headH + infoH;
        const sBot = gap + headH + infoH + ih + sigH;
        const stFs = Math.max(10, Math.round(size * 0.22));
        ticketText(g, '登机牌  STUB', sL, sTop + Math.round(ih * 0.06), gold, stFs, fam, true, 1);
        const bcH = Math.max(24, Math.round(stubW * 0.16));
        const bcW = Math.max(60, sR - sL);
        const bcY = sTop + Math.round(ih * 0.12);
        const brnd = styleNoise(noBase, 913, 7);
        g.fillStyle = 'rgba(243,241,250,0.88)';
        let bx = 0;
        while (bx < bcW) {
            const bw = Math.max(1, Math.round(size * (0.05 + brnd(6) / 100)));
            if (brnd(4) !== 0) g.fillRect(sL + bx, bcY, bw, bcH);
            bx += bw + 1 + brnd(4);
        }
        const adFs = Math.max(12, Math.round(size * 0.28));
        const adW = ticketTextW(g, stubV, adFs, fam, true, 3);
        g.save();
        g.translate(sR - Math.round(adFs * 0.4), Math.round((sTop + sBot) / 2));
        g.rotate(-Math.PI / 2);
        ticketText(g, stubV, -Math.round(adW / 2), Math.round(adFs * 0.36), sub, adFs, fam, true, 3);
        g.restore();
        const snFs = Math.max(9, Math.round(size * 0.20));
        const snW = ticketTextW(g, noStr, snFs, fam, false, 1);
        ticketText(g, noStr, Math.round((sL + sR - snW) / 2), sBot - Math.round(ih * 0.05),
            dim, snFs, fam, false, 1);

        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
    }

    // ── 票根纸张纹理:256px tile(纤维颗粒+半调网点+双色噪点),缓存平铺一次,预览不卡 ──
    let ticketPaperCache = null;
    function ticketPaperPattern() {
        if (ticketPaperCache) return ticketPaperCache;
        const tw = 256, th = 256;
        const c = newCanvas(tw, th);
        const g2 = c.getContext('2d');
        const rnd = styleNoise(2026, 1005, 99);
        g2.fillStyle = '#ffffff';
        g2.fillRect(0, 0, tw, th);
        for (let i = 0; i < 1600; i++) {
            const light = rnd(2) === 0;
            const a = 0.025 + rnd(40) / 1000;
            g2.fillStyle = light ? 'rgba(255,255,250,' + a.toFixed(3) + ')' : 'rgba(40,35,25,' + a.toFixed(3) + ')';
            g2.fillRect(rnd(tw), rnd(th), 1 + rnd(2), 1 + rnd(2));
        }
        const gap = 13;
        for (let y = gap >> 1; y < th; y += gap) {
            for (let x = gap >> 1; x < tw; x += gap) {
                if (rnd(100) < 30) continue;
                const r = rnd(22) / 10;
                const light = rnd(2) === 0;
                const a = 0.03 + rnd(30) / 1000;
                g2.fillStyle = light ? 'rgba(255,255,250,' + a.toFixed(3) + ')' : 'rgba(90,80,55,' + a.toFixed(3) + ')';
                g2.beginPath(); g2.arc(x, y, r, 0, 6.2832); g2.fill();
            }
        }
        g2.fillStyle = 'rgba(255,255,245,0.06)';
        for (let i = 0; i < 70; i++) {
            g2.fillRect(rnd(tw), rnd(th), 2 + rnd(6), 1);
        }
        ticketPaperCache = g2.createPattern(c, 'repeat');
        return ticketPaperCache;
    }

    // 票根文字绘制:可指定字体族(复古印刷/手写体),track 逐字
    function ticketText(g, text, x, y, fill, fs, family, bold, track) {
        if (!text) return;
        g.font = (bold ? 'bold ' : '') + fs + 'px ' + family;
        g.fillStyle = fill;
        if (!track) { g.fillText(text, x, y); return; }
        let cx = x;
        for (let i = 0; i < text.length; i++) {
            g.fillText(text[i], cx, y);
            cx += g.measureText(text[i]).width + track;
        }
    }
    function ticketTextW(g, text, fs, family, bold, track) {
        g.font = (bold ? 'bold ' : '') + fs + 'px ' + family;
        if (!track) return g.measureText(text).width;
        let w = 0;
        for (let i = 0; i < text.length; i++) w += g.measureText(text[i]).width + track;
        return w - track;
    }

    // 签名文字的"画得下"收敛:先按可用宽度缩字号,缩到最小可读字号(10px)仍放不下时
    // 用省略号截断 —— 保证签名永远不会画出照片/画布之外。
    // 返回 { fs, text },并且已把 g.font 设为最终字号;颜色/对齐/基线由调用方自己设置。
    // maxW 由调用方按各版式的可用空间算好(照片内 / 底栏内)。
    // ⚠ 必须放在 IIFE 顶层:邮票等风格是 IIFE 顶层的函数声明,而头像系列在 renderPhotoFrame
    //   内部声明 —— 放在 renderPhotoFrame 里会导致顶层风格引用不到它(渲染整体回退成原图)。
    function fitSignText(g, text, fs, fontFamily, maxW) {
        const family = fontFamily || 'Courier New';
        const setFont = (s) => { g.font = 'italic ' + s + 'px "' + family + '", cursive'; };
        let str = String(text == null ? '' : text);
        setFont(fs);
        if (!str || !(maxW > 0)) return { fs: fs, text: str };
        let w = g.measureText(str).width;
        if (w <= maxW) return { fs: fs, text: str };
        const minFs = 10;
        const scaled = Math.max(minFs, Math.floor(fs * maxW / w));
        if (scaled < fs) { fs = scaled; setFont(fs); w = g.measureText(str).width; }
        if (w > maxW) {
            const ell = '…';
            const chars = Array.from(str);
            while (chars.length > 1 && g.measureText(chars.join('') + ell).width > maxW) chars.pop();
            str = chars.join('') + ell;
        }
        return { fs: fs, text: str };
    }

    // 五角星路径(cx/cy 中心,R 外接半径,rot 起始角,默认尖角朝上)
    function starPath(g, cx, cy, R, rot) {
        const inner = R * 0.382;   // 正五角星的内外半径比
        g.beginPath();
        for (let i = 0; i < 10; i++) {
            const rr = (i % 2 === 0) ? R : inner;
            const a = (rot || 0) - Math.PI / 2 + i * Math.PI / 5;
            const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
    }

    // 圆形纪念章:双圈 + 中心「纪念」 + 圈内小五角星,叠加手刻抖动 / 断墨颗粒 / 双次盖印。
    // 所有随机量都取自固定种子(styleNoise),反复重绘完全一致 —— 不会出现印章颗粒闪动。
    // 关键约束:圆心放在照片内(距左下角 inset),内容(字+星)半径 < 0.52R,内圈 0.745R,
    // 外圈 1.0R —— 内容和圈线之间必须留出干净空白(旧实现把 '★ 纪念 ★' 整行硬塞进去,
    // 两个星被挤进内外圈之间,看着像假章)。
    function drawRedSeal(g, cx, cy, r, rot) {
        const pad = Math.ceil(r * 0.28);
        const cv = newCanvas(r * 2 + pad * 2, r * 2 + pad * 2);
        const sg = cv.getContext('2d');
        const c = r + pad;
        const rnd = styleNoise(Math.round(r * 10), 2026, 4491);
        const RED = '181,26,26';
        const wobble = function (radius, width, alpha) {
            sg.beginPath();
            const N = 108;
            for (let i = 0; i <= N; i++) {
                const a = i / N * Math.PI * 2;
                const rr = radius * (1 + (rnd(1000) / 1000 - 0.5) * 0.035);
                const x = c + Math.cos(a) * rr, y = c + Math.sin(a) * rr;
                if (i === 0) sg.moveTo(x, y); else sg.lineTo(x, y);
            }
            sg.closePath();
            sg.lineWidth = width;
            sg.lineCap = 'round';
            sg.strokeStyle = 'rgba(' + RED + ',' + alpha + ')';
            sg.stroke();
        };
        // 第一次盖印:位置略偏、颜色略淡(手抖/重影)
        sg.save();
        sg.translate(r * 0.022, r * 0.016);
        wobble(r, Math.max(3.5, r * 0.09), 0.30);
        wobble(r * 0.745, Math.max(2, r * 0.045), 0.26);
        sg.restore();
        // 主印:外圈粗、内圈细
        wobble(r, Math.max(3.5, r * 0.09), 0.95);
        wobble(r * 0.745, Math.max(2, r * 0.045), 0.9);
        // 中心「纪念」
        sg.fillStyle = 'rgba(' + RED + ',0.95)';
        sg.textAlign = 'center';
        sg.textBaseline = 'middle';
        sg.font = 'bold ' + Math.round(r * 0.37) + 'px "KaiTi","STKaiti","SimSun",serif';
        sg.fillText('纪念', c, c - r * 0.15);
        // 小五角星(画路径,不依赖字体里有没有 ★ 字形)
        starPath(sg, c, c + r * 0.34, r * 0.145, 0);
        sg.fill();
        // 断墨颗粒:挖掉若干小点,模拟印油不匀(种子固定 → 不闪)
        sg.globalCompositeOperation = 'destination-out';
        sg.fillStyle = '#000';
        for (let i = 0; i < 30; i++) {
            const a = rnd(628) / 100, rr = rnd(1000) / 1000 * r * 0.98;
            const br = r * (0.012 + rnd(100) / 100 * 0.05);
            sg.globalAlpha = 0.3 + rnd(100) / 100 * 0.5;
            sg.beginPath(); sg.arc(c + Math.cos(a) * rr, c + Math.sin(a) * rr, br, 0, 6.2832); sg.fill();
        }
        sg.globalAlpha = 1;
        sg.globalCompositeOperation = 'source-over';
        // 贴到画布(整枚章微微倾斜)
        g.save();
        g.translate(cx, cy);
        g.rotate(rot);
        g.drawImage(cv, -c, -c);
        g.restore();
    }

    // ── 纪念邮票(2026-10):邮票浮在照片背景模糊上,白纸票面+齿孔挖空透出模糊色+照片+右下地点/日期+顶部签名 ──
    function styleStamp(img, size, g, iw, ih, S, variant) {
        const pal = ({
            classic:  { paper: '#f8fafd', ink: '#2f2a24', deco: 'whiteframe' },
            kraft:    { paper: '#d6b58c', ink: '#3a2a14', deco: 'paper' },
            blueprint:{ paper: '#1e3a5f', ink: '#e9f1fb', deco: 'grid' },
            redseal:  { paper: '#faf5ea', ink: '#2f2a24', deco: 'seal' },
            gold:     { paper: '#16130c', ink: '#d4af37', deco: 'goldline' }
        })[variant] || { paper: '#f8fafd', ink: '#2f2a24', deco: 'whiteframe' };
        const side = Math.max(16, Math.round(iw * 0.025), Math.round(size * 0.8));
        const blurGap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
        const hasAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete && window.__qfsAvatarImg.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        const hasSig = !!(S && S.userSignature);
        const textH = (hasAv || hasSig) ? Math.max(64, Math.round(size * 2.5)) : Math.max(46, Math.round(size * 1.8));
        const w = iw + side * 2 + blurGap * 2;
        const h = ih + side * 2 + textH + blurGap * 2;
        const x0 = blurGap, y0 = blurGap;
        const tw = iw + side * 2, th = ih + side * 2 + textH; // 票面矩形
        // 底层: 照片背景模糊铺满画布(参考图邮票下层就是背景模糊, 整帧只blur一次)。
        //       与票根/电影票同一套「两个必须」(不满足就是导出后深色背景上一条极淡的缝):
        //    a) 底图要比画布外扩一圈:如果 bgScale=max(w/iw,h/ih),图的边缘正好压在画布
        //       边上,模糊核会吸到画布外的透明像素,四周留出 alpha<255 的半透明带
        //       (实测:上下各约 39 行,左右整条边,min alpha 131)。
        //    b) 外扩之后边缘仍会有 1~2% 的 alpha 缺口,把模糊结果整幅贴自己两遍即可填满:
        //       同色叠自己不改颜色,只把 alpha 从 a 抬到 1-(1-a)²(0.984 → 0.999999)。
        const blurR = Math.max(16, Math.round(size * 0.9));
        const bgPad = blurR * 4;
        const bgScale = Math.max((w + bgPad) / iw, (h + bgPad) / ih);
        const bg = newCanvas(w, h);
        const bgG = bg.getContext('2d');
        bgG.filter = 'blur(' + blurR + 'px)';
        bgG.drawImage(img, (w - iw * bgScale) / 2, (h - ih * bgScale) / 2, iw * bgScale, ih * bgScale);
        bgG.filter = 'none';
        bgG.drawImage(bg, 0, 0);   // canvas 自绘前会先快照源,不会边读边写
        bgG.drawImage(bg, 0, 0);
        g.drawImage(bg, 0, 0);
        // 票面+齿孔: 离屏canvas做带半孔齿孔的米白票面(孔中心落在票面边缘线上,半圆天然只咬进票面内),
        // 孔内透明露出下层模糊背景; 一次性叠上, 避免逐孔重复绘制导致缩放卡顿
        const holeR = Math.max(3, Math.round(size * 0.225));
        const pitch = Math.max(9, holeR * 4);   // 边孔间距=孔径+孔径
        // 角孔两侧平直齿尖长: 至少等于孔直径, 图片越大自动加长(随 min(iw,ih) 缩放)
        const toothL = Math.max(Math.round(holeR * 2), Math.round(Math.min(iw, ih) * 0.012));
        const margin = holeR * 2 + toothL;  // 角点(45度角孔圆心)到第一边孔圆心
        // 沿边均布边孔: 两端各留 margin(角孔位), 孔位中心对称, 间距在 pitch 附近自适应微调
        const stampRow = function (len) {
            const span = len - 2 * margin;
            const count = Math.max(0, Math.floor(span / pitch) + 1);
            if (count <= 0) return [];
            const gap = count > 1 ? span / (count - 1) : 0;
            const out = [];
            for (let k = 0; k < count; k++) out.push(margin + gap * k);
            return out;
        };
        const tc = document.createElement('canvas');
        tc.width = tw; tc.height = th;
        const tg = tc.getContext('2d');
        tg.fillStyle = pal.paper;
        tg.fillRect(0, 0, tw, th);
        if (pal.deco === 'paper') {
            tg.fillStyle = ticketPaperPattern();
            tg.fillRect(0, 0, tw, th);
            const rndf = styleNoise(tw, th, 9527);
            // 大块斑驳晕斑: 牛皮纸天然深浅不均的做旧感
            for (let i = 0; i < 34; i++) {
                const bx = rndf(tw), by = rndf(th), br = 36 + rndf(60);
                tg.fillStyle = 'rgba(122,82,34,' + (0.10 + (i % 5) * 0.03) + ')';
                tg.beginPath(); tg.arc(bx, by, br, 0, 6.2832); tg.fill();
            }
            // 纤维短纹(加粗加密)
            tg.strokeStyle = 'rgba(96,64,22,0.28)';
            tg.lineWidth = 1.8;
            for (let i = 0; i < 220; i++) {
                const nx = rndf(tw), ny = rndf(th), nl = 6 + (i % 15);
                tg.beginPath(); tg.moveTo(nx, ny); tg.lineTo(nx + nl, ny + 1); tg.stroke();
            }
            // 四边做旧晕染(旧纸边缘发暗)
            const egX = tg.createLinearGradient(0, 0, tw, 0);
            egX.addColorStop(0, 'rgba(90,58,20,0.20)');
            egX.addColorStop(0.07, 'rgba(90,58,20,0)');
            egX.addColorStop(0.93, 'rgba(90,58,20,0)');
            egX.addColorStop(1, 'rgba(90,58,20,0.20)');
            tg.fillStyle = egX; tg.fillRect(0, 0, tw, th);
            const egY = tg.createLinearGradient(0, 0, 0, th);
            egY.addColorStop(0, 'rgba(90,58,20,0.20)');
            egY.addColorStop(0.07, 'rgba(90,58,20,0)');
            egY.addColorStop(0.93, 'rgba(90,58,20,0)');
            egY.addColorStop(1, 'rgba(90,58,20,0.20)');
            tg.fillStyle = egY; tg.fillRect(0, 0, tw, th);
        } else if (pal.deco === 'grid') {
            tg.strokeStyle = 'rgba(255,255,255,0.20)';
            tg.lineWidth = 1.5;
            for (let x = 12; x < tw; x += 12) { tg.beginPath(); tg.moveTo(x, 0); tg.lineTo(x, th); tg.stroke(); }
            for (let y = 12; y < th; y += 12) { tg.beginPath(); tg.moveTo(0, y); tg.lineTo(tw, y); tg.stroke(); }
        } else if (pal.deco === 'whiteframe') {
            tg.strokeStyle = 'rgba(0,0,0,0.12)';
            tg.lineWidth = 1.5;
            tg.strokeRect(5, 5, tw - 10, th - 10);
        } else if (pal.deco === 'goldline') {
            tg.strokeStyle = 'rgba(212,175,55,0.8)';
            tg.lineWidth = 3;
            tg.strokeRect(7, 7, tw - 14, th - 14);
        } else if (pal.deco === 'seal') {
            // 红章纪念邮票票面: 浅米纸 + 雕刻细线(安全纹) + 双细线内框 + 纸纹颗粒 ——
            // 让票面不再是一块"纯色块"。照片随后盖住中间, 四周留出一圈印刷纹理。
            const rndf = styleNoise(tw, th, 48271);
            tg.fillStyle = 'rgba(163,140,112,0.055)';
            for (let i = 0; i < 2400; i++) tg.fillRect(rndf(tw), rndf(th), 2, 2);
            const ringIn = Math.max(12, Math.round(holeR * 1.15));
            const step = Math.max(5, Math.round(holeR * 0.30));
            for (let k = 0; k < 4; k++) {
                const inset = ringIn + k * step;
                tg.strokeStyle = 'rgba(150,66,52,' + (0.15 - k * 0.02).toFixed(2) + ')';
                tg.lineWidth = 1;
                if (typeof tg.roundRect === 'function') {
                    tg.beginPath();
                    tg.roundRect(inset, inset, tw - inset * 2, th - inset * 2, Math.round(ringIn * 0.7));
                    tg.stroke();
                } else {
                    tg.strokeRect(inset, inset, tw - inset * 2, th - inset * 2);
                }
            }
            // 双细线内框(留出齿孔内缘)
            const fIn = Math.max(18, Math.round(holeR * 2.2));
            tg.strokeStyle = 'rgba(150,60,45,0.52)';
            tg.lineWidth = 2;
            tg.strokeRect(fIn, fIn, tw - fIn * 2, th - fIn * 2);
            const fIn2 = fIn + Math.max(4, Math.round(step * 0.8));
            tg.strokeStyle = 'rgba(150,60,45,0.34)';
            tg.lineWidth = 1;
            tg.strokeRect(fIn2, fIn2, tw - fIn2 * 2, th - fIn2 * 2);
        }
        tg.globalCompositeOperation = 'destination-out';
        tg.fillStyle = '#000000';
        const topHoles = stampRow(tw), leftHoles = stampRow(th);
        for (let i = 0; i < topHoles.length; i++) {
            tg.beginPath(); tg.arc(topHoles[i], 0, holeR, 0, Math.PI * 2); tg.fill();
            tg.beginPath(); tg.arc(topHoles[i], th, holeR, 0, Math.PI * 2); tg.fill();
        }
        for (let j = 0; j < leftHoles.length; j++) {
            tg.beginPath(); tg.arc(0, leftHoles[j], holeR, 0, Math.PI * 2); tg.fill();
            tg.beginPath(); tg.arc(tw, leftHoles[j], holeR, 0, Math.PI * 2); tg.fill();
        }
        // 四角: 45度朝向的半孔(角点挖圆,角变圆弧)
        tg.beginPath(); tg.arc(0, 0, holeR, 0, Math.PI * 2); tg.fill();
        tg.beginPath(); tg.arc(tw, 0, holeR, 0, Math.PI * 2); tg.fill();
        tg.beginPath(); tg.arc(0, th, holeR, 0, Math.PI * 2); tg.fill();
        tg.beginPath(); tg.arc(tw, th, holeR, 0, Math.PI * 2); tg.fill();
        g.drawImage(tc, x0, y0);
        // 照片(完整显示+缩放/偏移,圆角可选)
        const sc = (S && S.imgScale) || 1;
        const dw = iw * sc, dh = ih * sc;
        const dx = x0 + side + (iw - dw) / 2 + ((S && S.imgOffsetX) || 0);
        const dy = y0 + side + (ih - dh) / 2 + ((S && S.imgOffsetY) || 0);
        const arc = S ? Math.min(S.cornerAll || 0, Math.min(iw, ih) / 2) : 0;
        g.save();
        g.beginPath();
        if (arc > 1 && typeof g.roundRect === 'function') g.roundRect(x0 + side, y0 + side, iw, ih, arc);
        else g.rect(x0 + side, y0 + side, iw, ih);
        g.clip();
        g.drawImage(img, dx, dy, dw, dh);
        g.restore();
        // 票面顶部: 红章纪念邮票在顶边印票题「纪念邮票」(纸色题签压断内框细线 + 两侧引线),
        // 其余变体沿用旧的"顶部签名"位(签名文本字段, 预设未使用)。
        const sigStr = (S && S.signatureText) ? String(S.signatureText) : '';
        if (pal.deco === 'seal') {
            const bandH = Math.max(18, side - holeR * 1.2);
            const hFs = Math.max(11, Math.min(Math.round(size * 0.32), Math.round(bandH * 0.6)));
            const hCy = y0 + holeR * 1.2 + bandH / 2;
            const faceC = x0 + side + iw / 2;
            const title = '纪 念 邮 票';
            g.font = hFs + 'px "SimSun", serif';
            const tW = g.measureText(title).width;
            const boxW = tW + Math.round(hFs * 1.7);
            const boxH = Math.round(hFs * 1.5);
            g.fillStyle = pal.paper;
            if (typeof g.roundRect === 'function') {
                g.beginPath();
                g.roundRect(faceC - boxW / 2, hCy - boxH / 2, boxW, boxH, Math.round(hFs * 0.3));
                g.fill();
            } else {
                g.fillRect(faceC - boxW / 2, hCy - boxH / 2, boxW, boxH);
            }
            g.fillStyle = 'rgba(56,42,32,0.88)';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(title, faceC, hCy);
            const rIn = x0 + Math.max(24, Math.round(iw * 0.05));
            const rEnd = x0 + side + iw - Math.max(24, Math.round(iw * 0.05));
            g.strokeStyle = 'rgba(150,60,45,0.5)';
            g.lineWidth = 1.5;
            if (faceC - boxW / 2 - 10 > rIn) {
                g.beginPath(); g.moveTo(rIn, hCy); g.lineTo(faceC - boxW / 2 - 8, hCy); g.stroke();
            }
            if (rEnd > faceC + boxW / 2 + 10) {
                g.beginPath(); g.moveTo(faceC + boxW / 2 + 8, hCy); g.lineTo(rEnd, hCy); g.stroke();
            }
        } else if (sigStr) {
            const sigFs = Math.max(10, Math.round(size * 0.7));
            g.font = sigFs + 'px "SimSun", serif';
            g.fillStyle = pal.ink;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(sigStr, x0 + side + iw / 2, y0 + side * 0.55);
        }
        // 底部: 日期(地点可选)。红章纪念邮票重做为"票题式"底栏(分隔细线 + 居中铭文),
        // 其余变体沿用右对齐排版(含头像/签名一行)。
        const d = new Date();
        const dateStr = d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
        const locStr = (S && S.location) ? String(S.location) : '';
        const fFs = Math.max(13, Math.min(Math.round(size * 0.8), Math.round(iw * 0.03)));
        const textRX = x0 + side + iw - Math.max(36, Math.round(side * 0.5));
        const footerY = y0 + side + ih;
        if (pal.deco === 'seal') {
            const faceL = x0 + side, faceR = x0 + side + iw, faceC = faceL + iw / 2;
            const insetX = Math.max(20, Math.round(iw * 0.035));
            // 底栏分隔细线(承接票面内框)
            g.strokeStyle = 'rgba(150,60,45,0.42)';
            g.lineWidth = 1.5;
            const ruleY = footerY + Math.round(textH * 0.16);
            g.beginPath(); g.moveTo(faceL + insetX, ruleY); g.lineTo(faceR - insetX, ruleY); g.stroke();
            // 日期: 无地点时居中(拉开字距, 像票面铭文); 有地点时左地点/右日期, 避免互相压字
            const hasRow = hasAv || hasSig;
            const dateY = footerY + textH * (hasRow ? 0.42 : 0.56);
            g.font = fFs + 'px "SimSun", serif';
            g.fillStyle = 'rgba(56,42,32,0.92)';
            g.textBaseline = 'middle';
            g.textAlign = locStr ? 'right' : 'center';
            // ⚠ letterSpacing 必须给 CSS 长度字符串;给数字会被静默忽略(实测 0 效果)
            g.letterSpacing = Math.round(fFs * 0.18) + 'px';
            g.fillText(dateStr, locStr ? faceR - insetX : faceC, dateY);
            g.letterSpacing = '0px';
            if (locStr) {
                g.font = Math.round(fFs * 0.82) + 'px "SimSun", serif';
                g.fillStyle = 'rgba(56,42,32,0.66)';
                g.textAlign = 'left';
                g.fillText(locStr, faceL + insetX, dateY);
            }
            // 头像+签名: 作为一组居中放在日期下方(随侧栏签名字体/颜色/字号/头像大小)
            if (hasRow) {
                const sigBody = hasSig ? String(S.userSignature) : '';
                const avatarR = Math.round(textH * 0.17 * ((S && S.avatarScale) || 1));
                const rowY = footerY + textH * 0.76;
                const gapA = Math.max(8, Math.round(avatarR * 0.25));
                const availW = iw - insetX * 2 - (hasAv ? avatarR * 2 + gapA : 0);
                const fit = sigBody ? fitSignText(g, sigBody, Math.round(fFs * ((S && S.signSize) || 1)), (S && S.signFont) || 'Courier New', availW) : { text: '' };
                const sigWS = fit.text ? g.measureText(fit.text).width : 0;
                const totalW = (hasAv ? avatarR * 2 : 0) + (hasAv && sigWS ? gapA : 0) + sigWS;
                let px = faceC - totalW / 2;
                if (hasAv) {
                    const cxA = px + avatarR;
                    const sc2 = Math.max(avatarR * 2 / window.__qfsAvatarImg.width, avatarR * 2 / window.__qfsAvatarImg.height);
                    const aw = window.__qfsAvatarImg.width * sc2, ah = window.__qfsAvatarImg.height * sc2;
                    g.save();
                    g.beginPath(); g.arc(cxA, rowY, avatarR, 0, Math.PI * 2); g.clip();
                    g.drawImage(window.__qfsAvatarImg, cxA - aw / 2, rowY - ah / 2, aw, ah);
                    g.restore();
                    g.strokeStyle = 'rgba(150,60,45,0.45)'; g.lineWidth = 1.5;
                    g.beginPath(); g.arc(cxA, rowY, avatarR, 0, Math.PI * 2); g.stroke();
                    px += avatarR * 2 + (sigWS ? gapA : 0);
                }
                if (fit.text) {
                    g.fillStyle = (S && S.signColor) || '#2f2a24';
                    g.textAlign = 'left';
                    g.textBaseline = 'middle';
                    g.fillText(fit.text, px, rowY);
                }
            }
        } else {
            g.font = fFs + 'px "SimSun", serif';
            g.fillStyle = pal.ink;
            g.textAlign = 'right';
            g.textBaseline = 'middle';
            if (hasAv || hasSig) {
                // 日期/地点移到下方行
                if (locStr) g.fillText(locStr, textRX, footerY + textH * 0.60);
                g.fillText(dateStr, textRX, footerY + textH * (locStr ? 0.82 : 0.72));
                // 上方: 头像+签名(随侧栏签名字体/颜色/字号/头像大小设置)
                const sigBody = hasSig ? String(S.userSignature) : '';
                const avatarR = Math.round(textH * 0.22 * ((S && S.avatarScale) || 1));
                const sigFs = Math.round(fFs * ((S && S.signSize) || 1));
                g.font = 'italic ' + sigFs + 'px "' + ((S && S.signFont) || 'Courier New') + '", cursive';
                g.fillStyle = (S && S.signColor) || '#2f2a24';
                const sigW = sigBody ? g.measureText(sigBody).width : 0;
                const sigY = footerY + textH * 0.34;
                let avCX = textRX - avatarR;   // 无签名: 头像右缘=textRX
                if (sigBody) {
                    g.fillText(sigBody, textRX, sigY);
                    avCX = textRX - sigW - 10 - avatarR;
                }
                if (hasAv) {
                    g.save();
                    g.beginPath(); g.arc(avCX, sigY, avatarR, 0, Math.PI * 2); g.clip();
                    const s = Math.max(avatarR * 2 / window.__qfsAvatarImg.width, avatarR * 2 / window.__qfsAvatarImg.height);
                    g.drawImage(window.__qfsAvatarImg, avCX - avatarR, sigY - avatarR, window.__qfsAvatarImg.width * s, window.__qfsAvatarImg.height * s);
                    g.restore();
                    g.strokeStyle = 'rgba(0,0,0,0.30)'; g.lineWidth = 1.5;
                    g.beginPath(); g.arc(avCX, sigY, avatarR, 0, Math.PI * 2); g.stroke();
                }
            } else {
                if (locStr) g.fillText(locStr, textRX, footerY + textH * 0.34);
                g.fillText(dateStr, textRX, footerY + textH * (locStr ? 0.62 : 0.5));
            }
        }
        // 红章纪念邮票: 左下角盖一枚圆形纪念章(整枚章落在照片内, 双圈+中心「纪念」+小星)
        if (pal.deco === 'seal') {
            const r = Math.max(20, Math.round(Math.min(iw, ih) * 0.13));
            const inset = Math.max(16, Math.round(size * 0.32));
            drawRedSeal(g, x0 + side + r + inset, y0 + side + ih - r - inset, r, -0.18);
        }
    }

    // ── 票根家族(2026-10 重做):一张浮在模糊照片上的「真票券」──
    //
    // 版式(三个变体共用同一套,只换配色/字体/做旧/文案):
    //   票头 行1 票号(左)/票题(中)/日期(右) → 行2 英文副题 → 细线
    //   → 照片 → 信息栏(票券字段 + 可选签名头像行)
    //   → 横向撕线(一列真齿孔 + 两端比边孔更大的咬口) → 底部存根(存根号 + 条码 + 标语)
    //   票券四边/四角/撕线都真的挖穿齿孔,孔里透出下层模糊照片 —— 和邮票家族同一套做法。
    //
    // 两处「必须这样写」的理由,都是重做前实测出来的 bug:
    //  1) 齿孔走 destination-out 时必须显式 fillStyle='#000000'。沿用上一步那层低透明度
    //     暗角渐变时只挖掉百分之几 —— 实测孔心 alpha=235 而非 0,齿孔等于没画。
    //  2) 纸纹 ticketPaperPattern() 的 tile 是不透明白底,直接 source-over 会把配色盖成
    //     白纸(重做前三个变体底色一模一样)。用 multiply 叠:白底=1.0 不改配色,颗粒加深。
    //
    // 尺寸必须与 styleDims() 的 TICKET_* 分支同源:两边都调 ticketGeom(),否则画出来
    // 的票面和登记的画布尺寸对不上,齿孔/撕线会整片错位。
    function ticketGeom(iw, ih, size, hasAv, hasSig) {
        const side = Math.max(22, Math.round(size * 1.1));     // 照片左右纸边
        const headH = Math.max(58, Math.round(size * 2.0));    // 票头(两行 + 细线)
        const footBase = Math.max(44, Math.round(size * 1.6)); // 信息栏
        const sigH = (hasAv || hasSig) ? Math.max(50, Math.round(size * 1.9)) : 0;
        const stubH = Math.max(44, Math.round(size * 1.5));    // 底部存根(撕线以下)
        const gap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
        const holeR = Math.max(3, Math.round(size * 0.225));
        const tw = iw + side * 2;
        const th = headH + ih + footBase + sigH + stubH;
        return {
            side: side, headH: headH, footBase: footBase, sigH: sigH,
            footH: footBase + sigH, stubH: stubH, gap: gap, holeR: holeR,
            tw: tw, th: th, tearY: headH + ih + footBase + sigH,
            w: tw + gap * 2, h: th + gap * 2
        };
    }

    // 沿一条边均布齿孔的中心坐标:两端各留 margin(给角孔/撕线咬口),间距在 pitch 附近
    // 自适应微调(比固定 pitch 少一个「最后一孔贴边」或「末尾空半截」的问题)。
    function ticketPerfRow(len, margin, pitch) {
        const span = len - margin * 2;
        const count = Math.max(0, Math.floor(span / Math.max(4, pitch)) + 1);
        if (count <= 1) return count === 1 ? [len / 2] : [];
        const step = span / (count - 1);
        const out = [];
        for (let k = 0; k < count; k++) out.push(margin + step * k);
        return out;
    }

    function styleTicket(img, size, g, iw, ih, S, variant) {
        const hasAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete
            && window.__qfsAvatarImg.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        const hasSig = !!(S && S.userSignature);
        const G = ticketGeom(iw, ih, size, hasAv, hasSig);
        const side = G.side, headH = G.headH, footBase = G.footBase, sigH = G.sigH;
        const stubH = G.stubH, gap = G.gap, holeR = G.holeR;
        const tw = G.tw, th = G.th, tearY = G.tearY, w = G.w, h = G.h;
        const dark = variant === 'concert';
        const pal = ({
            vintage: { paper: '#f4eedd', ink: '#3a2b1a', sub: '#8a744f', title: '#5b4128', line: 'rgba(90,70,40,0.45)', bar: '#241c12' },
            concert: { paper: '#0e1b30', ink: '#e8f0ff', sub: '#6fd0ff', title: '#ffd27d', line: 'rgba(110,160,220,0.55)', bar: '#e8f0ff' },
            scrap:   { paper: '#ece3cf', ink: '#4a3a2a', sub: '#9a7f5f', title: '#7a4f3a', line: 'rgba(120,90,50,0.45)', bar: '#241c12' }
        })[variant] || { paper: '#f4eedd', ink: '#3a2b1a', sub: '#8a744f', title: '#5b4128', line: 'rgba(90,70,40,0.45)', bar: '#241c12' };
        const fams = ({
            vintage: { title: '"SimSun", serif', sub: '"Georgia", serif', body: '"SimSun", serif' },
            concert: { title: '"Arial", sans-serif', sub: '"Arial", sans-serif', body: '"Arial", sans-serif' },
            scrap:   { title: '"Georgia", serif', sub: '"Segoe Script", cursive', body: '"SimSun", serif' }
        })[variant] || { title: '"SimSun", serif', sub: '"Georgia", serif', body: '"SimSun", serif' };
        const rnd = styleNoise(iw, ih, 20261004
            + (variant === 'vintage' ? 1 : variant === 'scrap' ? 2 : 3));

        const d = new Date();
        const dateStr = d.getFullYear() + '.' + pad0(d.getMonth() + 1) + '.' + pad0(d.getDate());
        const noBase = 100 + Math.abs(iw * 31 + ih * 17) % 900;
        const noStr = 'NO.' + d.getFullYear() + '-' + String(noBase).padStart(3, '0');
        const C = ({
            vintage: {
                title: '旅 行 票 根', sub: 'MEMORY TICKET',
                info: '出发 07:20   ·   座席 08A   ·   票价 ¥35',
                stubL: '存根 ' + noStr, stubR: '把这一刻收藏起来'
            },
            concert: {
                title: '演 唱 会 票 根', sub: 'KEEP THE MOMENT',
                info: 'LIVE · 20:30   ·   A区 08排12号   ·   ¥280',
                stubL: '收藏联 TK-' + noBase, stubR: 'ADMIT ONE'
            },
            scrap: {
                title: '手 账 票 根', sub: 'PHOTO TICKET',
                info: '今日纪念   ·   把瞬间留下',
                stubL: '手账联 ' + noStr, stubR: 'MEMORIES'
            }
        })[variant] || { title: '票 根', sub: 'MEMORY TICKET', info: '', stubL: noStr, stubR: '' };

        // 字号自适应:按「最终字距」实测宽度逐级缩 —— fitFontFs 不算字距,带 track 的标题
        // 用它会算窄了导致出界。
        const fitTracked = (text, startFs, maxW, family, bold, trackRatio) => {
            let fs = startFs;
            while (fs > 9 && ticketTextW(g, text, fs, family, bold, Math.round(fs * trackRatio)) > maxW) fs--;
            return fs;
        };

        // ① 下层:照片模糊铺满画布 —— 齿孔挖穿后透出的就是这一层(所以永远不会是透明洞)
        //    两个「必须」:
        //    a) 底图要比画布外扩一圈:如果 bgScale=max(w/iw,h/ih),图的上下边正好压在画布
        //       边上,模糊核会吸到画布外的透明像素,画布上下各留几十行 alpha<255 的半透明带。
        //    b) 外扩之后边缘仍会有 1~2% 的 alpha 缺口(实测 min=251,上下各约 34 行),导出
        //       PNG 在深色背景上会看到一条极淡的缝。把模糊结果整幅贴自己两遍即可填满:
        //       同色叠自己不改颜色,只把 alpha 从 a 抬到 1-(1-a)² (0.984 → 0.999999)。
        const blurR = Math.max(14, Math.round(size * 0.8));
        const bgPad = blurR * 4;
        const bgScale = Math.max((w + bgPad) / iw, (h + bgPad) / ih);
        const bg = newCanvas(w, h);
        const bgG = bg.getContext('2d');
        bgG.filter = 'blur(' + blurR + 'px)';
        bgG.drawImage(img, (w - iw * bgScale) / 2, (h - ih * bgScale) / 2, iw * bgScale, ih * bgScale);
        bgG.filter = 'none';
        bgG.drawImage(bg, 0, 0);   // canvas 自绘前会先快照源,不会边读边写
        bgG.drawImage(bg, 0, 0);
        g.drawImage(bg, 0, 0);

        // ② 票面(离屏):纸底 → 纹理(multiply) → 分区底纹 → 变体做旧 → 内框 → 齿孔
        const tc = newCanvas(tw, th);
        const tg = tc.getContext('2d');
        tg.fillStyle = pal.paper;
        tg.fillRect(0, 0, tw, th);
        tg.save();
        tg.globalCompositeOperation = 'multiply';
        tg.fillStyle = ticketPaperPattern();
        tg.fillRect(0, 0, tw, th);
        tg.restore();
        // 分区底纹:票头/信息栏比纸边略深、存根再深一档(暗底票反过来略浅)
        const shade1 = dark ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.05)';
        tg.fillStyle = shade1;
        tg.fillRect(0, 0, tw, headH);
        tg.fillRect(0, headH + ih, tw, footBase + sigH);
        tg.fillStyle = dark ? 'rgba(255,255,255,0.085)' : 'rgba(0,0,0,0.075)';
        tg.fillRect(0, tearY, tw, stubH);

        if (variant === 'vintage') {
            // 泛黄 + 边缘磨损 + 暗角(都在配色纸面上,底色看得见)
            const yg = tg.createLinearGradient(0, 0, 0, th);
            yg.addColorStop(0, 'rgba(150,110,50,0.14)');
            yg.addColorStop(0.12, 'rgba(150,110,50,0)');
            yg.addColorStop(0.88, 'rgba(150,110,50,0)');
            yg.addColorStop(1, 'rgba(150,110,50,0.14)');
            tg.fillStyle = yg;
            tg.fillRect(0, 0, tw, th);
            tg.fillStyle = 'rgba(85,65,35,0.14)';
            for (let i = 0; i < Math.round((tw + th) / 3); i++) {
                const edge = rnd(4);
                let px, py;
                if (edge === 0) { px = rnd(tw); py = 2 + rnd(5); }
                else if (edge === 1) { px = rnd(tw); py = th - 7 + rnd(5); }
                else if (edge === 2) { px = 2 + rnd(5); py = rnd(th); }
                else { px = tw - 7 + rnd(5); py = rnd(th); }
                tg.fillRect(px, py, 1 + rnd(2), 1 + rnd(2));
            }
            const vg = tg.createRadialGradient(tw / 2, th / 2, Math.min(tw, th) * 0.34,
                tw / 2, th / 2, Math.max(tw, th) * 0.74);
            vg.addColorStop(0, 'rgba(0,0,0,0)');
            vg.addColorStop(1, 'rgba(95,72,40,0.16)');
            tg.fillStyle = vg;
            tg.fillRect(0, 0, tw, th);
        } else if (variant === 'scrap') {
            // 手账:票头手写涂鸦 + 右上小贴纸(压照片的胶带在贴完照片后才画)
            tg.strokeStyle = 'rgba(122,79,58,0.34)';
            tg.lineWidth = 1.4;
            for (let i = 0; i < 3; i++) {
                const x0 = Math.round(tw * (0.30 + rnd(34) / 100));
                const y0 = Math.round(headH * (0.20 + rnd(46) / 100));
                tg.beginPath();
                tg.moveTo(x0, y0);
                tg.quadraticCurveTo(x0 + 26, y0 - 7 - rnd(10), x0 + 54 + rnd(28), y0 + 2);
                tg.stroke();
            }
            const st = Math.round(size * 0.55);
            tg.fillStyle = 'rgba(214,196,160,0.78)';
            tg.fillRect(tw - Math.round(side * 0.5) - st, Math.round(headH * 0.24), st, st);
            const vg = tg.createRadialGradient(tw / 2, th / 2, Math.min(tw, th) * 0.34,
                tw / 2, th / 2, Math.max(tw, th) * 0.74);
            vg.addColorStop(0, 'rgba(0,0,0,0)');
            vg.addColorStop(1, 'rgba(120,90,50,0.15)');
            tg.fillStyle = vg;
            tg.fillRect(0, 0, tw, th);
        } else {
            // 演唱会:夜场冷色暗角 + 零星亮点
            const vg2 = tg.createRadialGradient(tw / 2, th * 0.42, Math.min(tw, th) * 0.26,
                tw / 2, th / 2, Math.max(tw, th) * 0.72);
            vg2.addColorStop(0, 'rgba(30,80,160,0.10)');
            vg2.addColorStop(1, 'rgba(0,0,15,0.34)');
            tg.fillStyle = vg2;
            tg.fillRect(0, 0, tw, th);
            for (let i = 0; i < 110; i++) {
                const x = rnd(tw), y = rnd(th);
                tg.fillStyle = 'rgba(255,255,255,' + (0.10 + rnd(45) / 100).toFixed(2) + ')';
                tg.beginPath();
                tg.arc(x, y, 0.6 + rnd(11) / 10, 0, 6.2832);
                tg.fill();
            }
        }

        // 印刷内框:双细线,内缘刚好避开齿孔咬进来的深度
        const fIn = Math.max(16, Math.round(holeR * 2.0));
        tg.strokeStyle = pal.line;
        tg.lineWidth = 2;
        tg.strokeRect(fIn, fIn, tw - fIn * 2, th - fIn * 2);
        tg.lineWidth = 1;
        tg.strokeRect(fIn + 5, fIn + 5, tw - (fIn + 5) * 2, th - (fIn + 5) * 2);

        // 齿孔:四边 + 四角 + 撕线一列 + 两端咬口
        const pitch = Math.max(holeR * 4, 9);
        tg.globalCompositeOperation = 'destination-out';
        tg.fillStyle = '#000000';   // ⚠ 显式设置,别沿用上面的低透明度渐变(见文件头注释)
        const rowX = ticketPerfRow(tw, holeR * 2, pitch);
        const rowY = ticketPerfRow(th, holeR * 2, pitch);
        for (let i = 0; i < rowX.length; i++) {
            tg.beginPath(); tg.arc(rowX[i], 0, holeR, 0, 6.2832); tg.fill();
            tg.beginPath(); tg.arc(rowX[i], th, holeR, 0, 6.2832); tg.fill();
        }
        for (let i = 0; i < rowY.length; i++) {
            tg.beginPath(); tg.arc(0, rowY[i], holeR, 0, 6.2832); tg.fill();
            tg.beginPath(); tg.arc(tw, rowY[i], holeR, 0, 6.2832); tg.fill();
        }
        tg.beginPath(); tg.arc(0, 0, holeR, 0, 6.2832); tg.fill();
        tg.beginPath(); tg.arc(tw, 0, holeR, 0, 6.2832); tg.fill();
        tg.beginPath(); tg.arc(0, th, holeR, 0, 6.2832); tg.fill();
        tg.beginPath(); tg.arc(tw, th, holeR, 0, 6.2832); tg.fill();
        const tearRow = ticketPerfRow(tw, holeR * 2.6, pitch);
        for (let i = 0; i < tearRow.length; i++) {
            tg.beginPath(); tg.arc(tearRow[i], tearY, holeR * 0.85, 0, 6.2832); tg.fill();
        }
        tg.beginPath(); tg.arc(0, tearY, holeR * 1.5, 0, 6.2832); tg.fill();
        tg.beginPath(); tg.arc(tw, tearY, holeR * 1.5, 0, 6.2832); tg.fill();
        tg.globalCompositeOperation = 'source-over';

        // ③ 贴到画布:票券浮在模糊照片上,四周留 gap(齿孔透出的就是这圈模糊)
        g.drawImage(tc, gap, gap);

        // ④ 照片(带 imgScale / imgOffset / 圆角)
        const sc = (S && S.imgScale) || 1;
        const dw = iw * sc, dh = ih * sc;
        const rectX = gap + side, rectY = gap + headH;
        const px0 = rectX + (iw - dw) / 2 + ((S && S.imgOffsetX) || 0);
        const py0 = rectY + (ih - dh) / 2 + ((S && S.imgOffsetY) || 0);
        const arcR = S ? Math.min(S.cornerAll || 0, Math.min(iw, ih) / 2) : 0;
        g.save();
        g.beginPath();
        if (arcR > 1 && typeof g.roundRect === 'function') g.roundRect(rectX, rectY, iw, ih, arcR);
        else g.rect(rectX, rectY, iw, ih);
        g.clip();
        g.drawImage(img, px0, py0, dw, dh);
        g.restore();
        g.strokeStyle = pal.line;
        g.lineWidth = 1;
        if (arcR > 1 && typeof g.roundRect === 'function') {
            g.beginPath();
            g.roundRect(rectX - 0.5, rectY - 0.5, iw + 1, ih + 1, arcR);
            g.stroke();
        } else {
            g.strokeRect(rectX - 0.5, rectY - 0.5, iw + 1, ih + 1);
        }

        // ⑤ 手账胶带:必须画在照片之后才会压上去(左上/右下各压一条)
        if (variant === 'scrap') {
            const tpH = Math.max(14, Math.round(size * 0.34));
            const tape = (cx, cy, tW, rot, col) => {
                g.save();
                g.translate(cx, cy);
                g.rotate(rot);
                g.fillStyle = col;
                g.fillRect(-tW / 2, -tpH / 2, tW, tpH);
                g.fillStyle = 'rgba(0,0,0,0.06)';
                for (let x = -tW / 2; x < tW / 2; x += 8) g.fillRect(x, tpH / 2 - 2, 3, 2);
                g.restore();
            };
            tape(rectX + iw * 0.13, rectY, iw * 0.24, -0.07, 'rgba(238,214,168,0.82)');
            tape(rectX + iw * 0.85, rectY + ih, iw * 0.20, 0.06, 'rgba(186,206,198,0.80)');
        }

        const inset = fIn + 6;
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';

        // ⑥ 票头行1: 票号(左) / 票题(中,逐字拉开) / 日期(右)
        const y1 = Math.round(headH * 0.50);
        const dFs = Math.max(12, Math.round(headH * 0.19));
        const dTrack = Math.round(dFs * 0.06);
        const noW = ticketTextW(g, noStr, dFs, fams.body, true, dTrack);
        ticketText(g, noStr, gap + inset, gap + y1, pal.ink, dFs, fams.body, true, dTrack);
        const dtW = ticketTextW(g, dateStr, dFs, fams.body, false, dTrack);
        ticketText(g, dateStr, gap + tw - inset - dtW, gap + y1, pal.ink, dFs, fams.body, false, dTrack);
        const availT = Math.max(60, tw - inset * 2 - Math.max(noW, dtW) * 2 - Math.round(tw * 0.12));
        const tFs0 = Math.max(22, Math.round(headH * 0.44));
        const tFs = fitTracked(C.title, tFs0, availT, fams.title, true, 0.16);
        const tTrack = Math.round(tFs * 0.16);
        const tW = ticketTextW(g, C.title, tFs, fams.title, true, tTrack);
        ticketText(g, C.title, gap + tw / 2 - tW / 2, gap + y1, pal.title, tFs, fams.title, true, tTrack);

        // ⑥ 票头行2: 英文副题(居中拉开) + 下方整幅细线
        const y2 = Math.round(headH * 0.74);
        const sFs0 = Math.max(11, Math.round(headH * 0.16));
        const sFs = fitTracked(C.sub, sFs0, tw - inset * 2, fams.sub, false, 0.20);
        const sTrack = Math.round(sFs * 0.20);
        const sW = ticketTextW(g, C.sub, sFs, fams.sub, false, sTrack);
        ticketText(g, C.sub, gap + tw / 2 - sW / 2, gap + y2, pal.sub, sFs, fams.sub, false, sTrack);
        const ruleY = gap + Math.round(headH * 0.90);
        g.strokeStyle = pal.line;
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(gap + inset, ruleY + 0.5);
        g.lineTo(gap + tw - inset, ruleY + 0.5);
        g.stroke();

        // ⑦ 信息栏:票券字段(居中) + 可选签名/头像行(留白随 sigH 长高)
        const ibTop = gap + headH + ih;
        const hasRow = hasAv || hasSig;
        const iFs0 = Math.max(12, Math.round(footBase * (hasRow ? 0.44 : 0.56)));
        const iFs = fitTracked(C.info, iFs0, tw - inset * 2, fams.body, false, 0.10);
        const iTrack = Math.round(iFs * 0.10);
        const iW = ticketTextW(g, C.info, iFs, fams.body, false, iTrack);
        const iY = ibTop + Math.round(footBase * (hasRow ? 0.50 : 0.60));
        ticketText(g, C.info, gap + tw / 2 - iW / 2, iY, pal.ink, iFs, fams.body, false, iTrack);
        if (hasRow) {
            const rowY = ibTop + footBase + Math.round(sigH * 0.5);
            const avatarR = Math.round(sigH * 0.17 * ((S && S.avatarScale) || 1));
            const sigBody = hasSig ? String(S.userSignature) : '';
            const gapA = Math.max(8, Math.round(avatarR * 0.25));
            const availW = tw - inset * 2 - (hasAv ? avatarR * 2 + gapA : 0);
            const fit = sigBody
                ? fitSignText(g, sigBody, Math.max(12, Math.round(sigH * 0.30 * ((S && S.signSize) || 1))),
                    (S && S.signFont) || 'Courier New', availW)
                : { fs: 0, text: '' };
            const sigWS = fit.text ? g.measureText(fit.text).width : 0;
            const totalW = (hasAv ? avatarR * 2 : 0) + (hasAv && sigWS ? gapA : 0) + sigWS;
            let px2 = gap + tw / 2 - totalW / 2;
            if (hasAv) {
                const cxA = px2 + avatarR;
                const av = window.__qfsAvatarImg;
                const sc2 = Math.max(avatarR * 2 / av.width, avatarR * 2 / av.height);
                g.save();
                g.beginPath(); g.arc(cxA, rowY, avatarR, 0, 6.2832); g.clip();
                g.drawImage(av, cxA - av.width * sc2 / 2, rowY - av.height * sc2 / 2,
                    av.width * sc2, av.height * sc2);
                g.restore();
                g.strokeStyle = pal.line;
                g.lineWidth = 1.5;
                g.beginPath(); g.arc(cxA, rowY, avatarR, 0, 6.2832); g.stroke();
                px2 += avatarR * 2 + (sigWS ? gapA : 0);
            }
            if (fit.text) {
                g.fillStyle = (S && S.signColor) || pal.ink;
                g.textAlign = 'left';
                g.textBaseline = 'middle';
                g.fillText(fit.text, px2, rowY);
                g.textAlign = 'left';
                g.textBaseline = 'alphabetic';
            }
        }

        // ⑧ 底部存根:存根号(左) + 条码(中) + 标语(右)
        const stTop = gap + tearY;
        const stFs = Math.max(11, Math.round(stubH * 0.26));
        const stBase = stTop + Math.round(stubH * 0.58);
        ticketText(g, C.stubL, gap + inset, stBase, pal.ink, stFs, fams.body, true, 1);
        const srW = ticketTextW(g, C.stubR, stFs, fams.sub, false, 1);
        ticketText(g, C.stubR, gap + tw - inset - srW, stBase, pal.sub, stFs, fams.sub, false, 1);
        const bcH = Math.round(stubH * 0.44);
        const bcW = Math.round(tw * 0.22);
        const bcX = gap + Math.round((tw - bcW) / 2);
        const bcY = stTop + Math.round((stubH - bcH) / 2);
        const brnd = styleNoise(noBase, 777, 5);
        g.fillStyle = pal.bar;
        let bx = 0;
        while (bx < bcW) {
            const bw = 1 + brnd(4);
            if (brnd(4) !== 0) g.fillRect(bcX + bx, bcY, bw, bcH);
            bx += bw + 1 + brnd(3);
        }

        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
    }

    function styleWatercolorBleed(img, size, g, iw, ih) {
        const bleed = Math.max(70, Math.floor(size * 1.8));
        const w = iw + bleed * 2, h = ih + bleed * 2;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        const palettes = [
            ['rgba(70,130,200,0.70)', 'rgba(150,120,200,0.60)', 'rgba(200,130,160,0.60)'],
            ['rgba(90,170,130,0.70)', 'rgba(225,185,110,0.60)', 'rgba(175,155,200,0.60)'],
            ['rgba(210,135,120,0.70)', 'rgba(145,180,220,0.60)', 'rgba(175,205,155,0.60)']
        ];
        const rnd = styleNoise(iw, ih, 777);
        const pal = palettes[rnd(palettes.length)];
        const px0 = bleed, py0 = bleed;
        for (let i = 0; i < 20; i++) {
            const edge = rnd(4);
            let px, py;
            if (edge === 0) { px = px0 + rnd(iw); py = py0 - Math.floor(bleed * 0.05) + rnd(Math.floor(bleed * 0.5)); }
            else if (edge === 1) { px = px0 + rnd(iw); py = py0 + ih - Math.floor(bleed * 0.05) + rnd(Math.floor(bleed * 0.5)); }
            else if (edge === 2) { px = px0 - Math.floor(bleed * 0.05) + rnd(Math.floor(bleed * 0.5)); py = py0 + rnd(ih); }
            else { px = px0 + iw - Math.floor(bleed * 0.05) + rnd(Math.floor(bleed * 0.5)); py = py0 + rnd(ih); }
            const pr = Math.max(40, Math.floor(bleed * (0.8 + rnd(100) / 100)));
            const col = pal[rnd(pal.length)];
            const grad = g.createRadialGradient(px, py, 0, px, py, pr);
            grad.addColorStop(0, col); grad.addColorStop(0.7, col.replace(/0.45|0.55/, '0.15')); grad.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.beginPath(); g.arc(px, py, pr, 0, 6.2832); g.fill();
        }
        g.drawImage(img, px0, py0);
    }

    // ── 艺术边框组(2026-09) ──
    function styleNeonGlow(img, size, g, iw, ih) {
        const pad = Math.max(50, Math.round(iw * 0.06));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#0a0a0f'; g.fillRect(0, 0, w, h);
        const rnd = styleNoise(iw, ih, 8801);
        const colors = ['#ff2d78', '#00e5ff', '#b388ff'];
        const col = colors[rnd(colors.length)];
        const px0 = pad, py0 = pad;
        g.save();
        g.shadowColor = col; g.shadowBlur = Math.round(pad * 0.9);
        g.fillStyle = '#000';
        g.fillRect(px0, py0, iw, ih);
        g.restore();
        g.drawImage(img, px0, py0);
        g.strokeStyle = col;
        g.lineWidth = Math.max(2, Math.round(pad * 0.08));
        g.strokeRect(px0, py0, iw, ih);
    }

    function styleBurnedEdge(img, size, g, iw, ih) {
        const pad = Math.max(40, Math.round(iw * 0.05));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#1a120c'; g.fillRect(0, 0, w, h);
        const px0 = pad, py0 = pad;
        const rnd = styleNoise(iw, ih, 8802);
        g.drawImage(img, px0, py0);
        const scorch = Math.max(12, Math.round(pad * 0.5));
        let grad = g.createLinearGradient(0, py0, 0, py0 + scorch);
        grad.addColorStop(0, 'rgba(10,5,2,0.85)'); grad.addColorStop(1, 'rgba(10,5,2,0)');
        g.fillStyle = grad; g.fillRect(px0, py0, iw, scorch);
        grad = g.createLinearGradient(0, py0 + ih, 0, py0 + ih - scorch);
        grad.addColorStop(0, 'rgba(10,5,2,0.85)'); grad.addColorStop(1, 'rgba(10,5,2,0)');
        g.fillStyle = grad; g.fillRect(px0, py0 + ih - scorch, iw, scorch);
        grad = g.createLinearGradient(px0, 0, px0 + scorch, 0);
        grad.addColorStop(0, 'rgba(10,5,2,0.85)'); grad.addColorStop(1, 'rgba(10,5,2,0)');
        g.fillStyle = grad; g.fillRect(px0, py0, scorch, ih);
        grad = g.createLinearGradient(px0 + iw, 0, px0 + iw - scorch, 0);
        grad.addColorStop(0, 'rgba(10,5,2,0.85)'); grad.addColorStop(1, 'rgba(10,5,2,0)');
        g.fillStyle = grad; g.fillRect(px0 + iw - scorch, py0, scorch, ih);
        for (let i = 0; i < 14; i++) {
            const edge = rnd(4);
            let bx, by;
            if (edge === 0) { bx = px0 + rnd(iw); by = py0 + rnd(Math.round(scorch * 0.6)); }
            else if (edge === 1) { bx = px0 + rnd(iw); by = py0 + ih - rnd(Math.round(scorch * 0.6)); }
            else if (edge === 2) { bx = px0 + rnd(Math.round(scorch * 0.6)); by = py0 + rnd(ih); }
            else { bx = px0 + iw - rnd(Math.round(scorch * 0.6)); by = py0 + rnd(ih); }
            const br = Math.max(4, Math.round(scorch * (0.3 + rnd(80) / 100)));
            const rg = g.createRadialGradient(bx, by, 0, bx, by, br);
            rg.addColorStop(0, 'rgba(5,2,0,0.7)'); rg.addColorStop(1, 'rgba(5,2,0,0)');
            g.fillStyle = rg;
            g.beginPath(); g.arc(bx, by, br, 0, 6.2832); g.fill();
        }
    }

    function styleInkWash(img, size, g, iw, ih) {
        const pad = Math.max(60, Math.round(iw * 0.08));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#f4efe3'; g.fillRect(0, 0, w, h);
        const px0 = pad, py0 = pad;
        const rnd = styleNoise(iw, ih, 8803);
        for (let i = 0; i < 16; i++) {
            const edge = rnd(4);
            let bx, by;
            if (edge === 0) { bx = px0 + rnd(iw); by = py0 - Math.round(pad * 0.05) + rnd(Math.round(pad * 0.6)); }
            else if (edge === 1) { bx = px0 + rnd(iw); by = py0 + ih - Math.round(pad * 0.05) + rnd(Math.round(pad * 0.6)); }
            else if (edge === 2) { bx = px0 - Math.round(pad * 0.05) + rnd(Math.round(pad * 0.6)); by = py0 + rnd(ih); }
            else { bx = px0 + iw - Math.round(pad * 0.05) + rnd(Math.round(pad * 0.6)); by = py0 + rnd(ih); }
            const br = Math.max(25, Math.round(pad * (0.6 + rnd(100) / 100)));
            const shade = 30 + rnd(60);
            const rg = g.createRadialGradient(bx, by, 0, bx, by, br);
            rg.addColorStop(0, 'rgba(' + shade + ',' + shade + ',' + shade + ',0.35)');
            rg.addColorStop(1, 'rgba(' + shade + ',' + shade + ',' + shade + ',0)');
            g.fillStyle = rg;
            g.beginPath(); g.arc(bx, by, br, 0, 6.2832); g.fill();
        }
        g.drawImage(img, px0, py0);
        const seal = Math.max(28, Math.round(iw * 0.035));
        const sx = px0 + iw - seal - Math.round(iw * 0.015);
        const sy = py0 + ih - seal - Math.round(iw * 0.015);
        g.fillStyle = '#c0392b';
        g.fillRect(sx, sy, seal, seal);
        g.fillStyle = '#f4efe3';
        g.font = 'bold ' + Math.round(seal * 0.6) + 'px serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('印', sx + seal / 2, sy + seal / 2 + 1);
    }

    function styleCyanotype(img, size, g, iw, ih) {
        const pad = Math.max(30, Math.round(iw * 0.035));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#164e7a'; g.fillRect(0, 0, w, h);
        const px0 = pad, py0 = pad;
        g.drawImage(img, px0, py0);
        g.fillStyle = 'rgba(20,80,140,0.38)';
        g.fillRect(px0, py0, iw, ih);
        g.strokeStyle = 'rgba(240,245,250,0.85)';
        g.lineWidth = Math.max(2, Math.round(pad * 0.12));
        g.strokeRect(px0, py0, iw, ih);
    }

    function styleOilBrush(img, size, g, iw, ih) {
        const pad = Math.max(55, Math.round(iw * 0.07));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#f0ebe0'; g.fillRect(0, 0, w, h);
        const px0 = pad, py0 = pad;
        const rnd = styleNoise(iw, ih, 8804);
        const palette = ['#c9a66b', '#8b7355', '#6b5b47', '#a89070', '#d4b896'];
        for (let i = 0; i < 24; i++) {
            const edge = rnd(4);
            let bx, by, ang;
            if (edge === 0) { bx = px0 + rnd(iw); by = py0 - rnd(Math.round(pad * 0.3)); ang = 0; }
            else if (edge === 1) { bx = px0 + rnd(iw); by = py0 + ih + rnd(Math.round(pad * 0.3)); ang = Math.PI; }
            else if (edge === 2) { bx = px0 - rnd(Math.round(pad * 0.3)); by = py0 + rnd(ih); ang = Math.PI / 2; }
            else { bx = px0 + iw + rnd(Math.round(pad * 0.3)); by = py0 + rnd(ih); ang = -Math.PI / 2; }
            const col = palette[rnd(palette.length)];
            g.save();
            g.translate(bx, by); g.rotate(ang + (rnd(20) - 10) * 0.1);
            g.fillStyle = col; g.globalAlpha = 0.55;
            g.beginPath();
            g.ellipse(0, 0, Math.max(8, Math.round(pad * 0.3)), Math.max(3, Math.round(pad * 0.1)), 0, 0, 6.2832);
            g.fill();
            g.restore();
        }
        g.globalAlpha = 1;
        g.drawImage(img, px0, py0);
    }

    function stylePressedFlower(img, size, g, iw, ih) {
        const pad = Math.max(50, Math.round(iw * 0.06));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#f7f3e8'; g.fillRect(0, 0, w, h);
        const px0 = pad, py0 = pad;
        g.drawImage(img, px0, py0);
        const leafColor = '#7a8450';
        const corners = [
            [px0, py0, 0],
            [px0 + iw, py0, Math.PI / 2],
            [px0 + iw, py0 + ih, Math.PI],
            [px0, py0 + ih, -Math.PI / 2]
        ];
        for (let ci = 0; ci < corners.length; ci++) {
            const cx = corners[ci][0], cy = corners[ci][1], rot = corners[ci][2];
            g.save();
            g.translate(cx, cy); g.rotate(rot);
            g.fillStyle = leafColor;
            g.beginPath();
            g.ellipse(0, 0, Math.round(pad * 0.28), Math.round(pad * 0.12), 0, 0, 6.2832);
            g.fill();
            g.strokeStyle = 'rgba(60,70,30,0.6)'; g.lineWidth = 1;
            g.beginPath(); g.moveTo(-Math.round(pad * 0.28), 0); g.lineTo(Math.round(pad * 0.28), 0); g.stroke();
            g.restore();
        }
    }

    function styleWaxSeal(img, size, g, iw, ih) {
        const pad = Math.max(45, Math.round(iw * 0.055));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#3a2a1f'; g.fillRect(0, 0, w, h);
        const px0 = pad, py0 = pad;
        g.fillStyle = '#f5f0e6';
        g.fillRect(px0 - Math.round(pad * 0.15), py0 - Math.round(pad * 0.15), iw + Math.round(pad * 0.3), ih + Math.round(pad * 0.3));
        g.drawImage(img, px0, py0);
        const sr = Math.round(iw * 0.05);
        const sx = px0 + iw + Math.round(pad * 0.05);
        const sy = py0 + ih + Math.round(pad * 0.05);
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
        const rg = g.createRadialGradient(sx - sr * 0.3, sy - sr * 0.3, sr * 0.1, sx, sy, sr);
        rg.addColorStop(0, '#e74c3c'); rg.addColorStop(1, '#922b21');
        g.fillStyle = rg;
        g.beginPath(); g.arc(sx, sy, sr, 0, 6.2832); g.fill();
        g.restore();
        g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
        g.beginPath(); g.arc(sx, sy, sr * 0.65, 0, 6.2832); g.stroke();
    }

    function stylePrismatic(img, size, g, iw, ih) {
        const pad = Math.max(40, Math.round(iw * 0.05));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#0d0d12'; g.fillRect(0, 0, w, h);
        const px0 = pad, py0 = pad;
        g.save();
        g.shadowColor = '#ffffff'; g.shadowBlur = Math.round(pad * 0.8);
        g.fillStyle = '#000';
        g.fillRect(px0, py0, iw, ih);
        g.restore();
        g.drawImage(img, px0, py0);
        const bw = Math.max(3, Math.round(pad * 0.1));
        let lg = g.createLinearGradient(px0, 0, px0 + iw, 0);
        lg.addColorStop(0, '#ff004c'); lg.addColorStop(0.25, '#ff8a00');
        lg.addColorStop(0.5, '#ffee00'); lg.addColorStop(0.75, '#00e676');
        lg.addColorStop(1, '#2979ff');
        g.fillStyle = lg;
        g.fillRect(px0, py0 - bw, iw, bw);
        g.fillRect(px0, py0 + ih, iw, bw);
        lg = g.createLinearGradient(0, py0, 0, py0 + ih);
        lg.addColorStop(0, '#ff004c'); lg.addColorStop(0.25, '#b388ff');
        lg.addColorStop(0.5, '#00e5ff'); lg.addColorStop(0.75, '#00e676');
        lg.addColorStop(1, '#ffee00');
        g.fillStyle = lg;
        g.fillRect(px0 - bw, py0, bw, ih);
        g.fillRect(px0 + iw, py0, bw, ih);
    }

    // ── 阶段二基设:风格序号 / Java Random(原件 cameraFor 的 seed RNG)──
    const ORD = { NONE:0,SIMPLE:1,POLAROID:2,FILM_STRIP:3,ROUNDED:4,DOUBLE_LINE:5,VINTAGE:6,GRADIENT:7,DROP_SHADOW:8,
        BLUR_CLASSIC:9,BLUR_DATE:10,WM_CLASSIC:11,WM_SINGLE:12,WM_BRAND_LOGO:13,WM_AI:14,IMP_FROSTED:15,IMP_CLASSIC:16,FUJI_WM:48,FUJI_WM_BRAND:49,DARK_BRAND_ONLY:50,
        XIAOMI_IMP:17,CARD_LEICA:18,CARD_LOGO_PARAM:19,CARD_PURE_LOGO:20,CARD_SIMPLE:21,CARD_IMMERSION:22,
        OVERLAY_PARAM_LEFT:23,OVERLAY_PARAM_RIGHT:24,OVERLAY_PARAM_BOTTOM:25,OVERLAY_LOGO_BOTTOM:26,
        COLOR_CLASSIC:27,COLOR_REFINED:28,ART_CARD:29,WHITE_PLAIN:30,FUJI_WHITE:31,
        PARAM_TOP_LEFT:32,PARAM_BOTTOM_LEFT:33,PARAM_BOTTOM_SINGLE:34,SIMPLE_FILM:35,
        STAMP_POSTAGE:36,TEARED_PAPER:37,FOLD_CORNER:38,PINBOARD_TAPE:39, VHS_TAPE:40,ALBUM_CORNER:41,MOVIE_TICKET:42,WATERCOLOR_BLEED:43,CYBER_GLITCH:51,POLAROID_HAND:52,TORN_JOURNAL:53,CARD_3D:54,COMIC_PANEL:55,NEWSPAPER:56,SIGNATURE:57,SIGN_PARAM:58,AVATAR_MEMO:59,
SIGN_BLUR:60,
SIG_BLUR:61,
AV_BLUR:62,
AV_OVERLAY:63,
AV_OVERLAY_TR:64,
AV_OVERLAY_BR:65,
AV_OVERLAY_BC:66,
AV_OVERLAY_BC2:67, GALLERY_MAT:68, BOARDING_PASS:69, FILM_TEAR:70, PARAM_STRIP:71, PHOTO_CREDIT:72, PARAM_CREDIT:73, CARD_APPLE:74, XIAOMI_LEICA:75 };
    const MASK48 = 0xffffffffffffn, MULT = 0x5deece66dn, INC = 0xbn;
    function javaRandom(seed64) {
        let s = (BigInt(seed64) ^ MULT) & MASK48;
        const next = bits => { s = (s * MULT + INC) & MASK48; return Number(s >> BigInt(48 - bits)); };
        return function nextInt(bound) {
            if (bound <= 0) return 0;
            if ((bound & -bound) === bound) return (bound * next(31)) >> 31;
            let bits, val;
            do { bits = next(31); val = bits % bound; } while (bits - val + (bound - 1) < 0);
            return val;
        };
    }

    // 网络 EXIF(± 字段)映射为相机规格;无数据走 Java 同 seed 随机
    function camHasData(exif) { return !!(exif && (exif.make || exif.model || exif.focal || exif.aperture || exif.iso || exif.shutter)); }
    // 品牌名规范化:把EXIF里的make字段映射成简洁品牌名
    function normalizeBrand(make, model) {
        const s = (make + ' ' + model).toLowerCase();
        if (!make && !model) return '';
        const map = [
            [/sony|sony corporation|sony corp/i, 'SONY'],
            [/canon|canon inc.|canon inc/i, 'Canon'],
            [/nikon|nikon corporation|nikon corp/i, 'Nikon'],
            [/fujifilm|fuji photo|fujinon|fuji/i, 'FUJIFILM'],
            [/leica|leica camera|leica geosystems/i, 'Leica'],
            [/panasonic|lumix|panasonic corp/i, 'Panasonic'],
            [/olympus|olympus imaging|om system|om digital/i, 'OM System'],
            [/pentax|ricoh|ricoh imaging|asahi pentax/i, 'PENTAX'],
            [/hasselblad/i, 'HASSELBLAD'],
            [/phase one|phaseone/i, 'Phase One'],
            [/samsung|samsung techwin/i, 'SAMSUNG'],
            [/xiaomi|xiaomi inc|redmi/i, 'Xiaomi'],
            [/huawei|huawei device/i, 'HUAWEI'],
            [/apple|iphone|apple inc./i, 'Apple'],
            [/google|pixel/i, 'Google'],
            [/oneplus|one+/i, 'OnePlus'],
            [/oppo|bbk electronic/i, 'OPPO'],
            [/vivo|vivoelectronics/i, 'vivo'],
            [/dji|shenzhen dj/i, 'DJI'],
            [/gopro/i, 'GoPro'],
            [/insta360|insta 360|arcsoft/i, 'Insta360'],
            [/zeiss|carl zeiss/i, 'ZEISS'],
            [/contax|kyocera/i, 'CONTAX'],
            [/konica|minolta|konica minolta/i, 'KONICA MINOLTA'],
            [/mamiya/i, 'Mamiya'],
            [/sinar/i, 'Sinar'],
            [/alpa/i, 'ALPA'],
            [/fujifilm|gfx/i, 'FUJIFILM'],
        ];
        for (const [re, name] of map) {
            if (re.test(s)) return name;
        }
        // 没匹配到就原样返回make的前20字符
        return (make || '').trim().substring(0, 20);
    }

    function cameraFor(styleName, iw, ih, exif) {
        const noBrandModel = (styleName === 'SIMPLE_FILM' || styleName === 'PARAM_BOTTOM_SINGLE');
        if (camHasData(exif)) {
            const focal = exif.focal || '50mm', aper = exif.aperture || 'f/2.8';
            const iso = exif.iso || 'ISO 400', shut = exif.shutter || '1/125';
            if (noBrandModel) return { brand: '', model: '', focal, aperture: aper, iso: '', shutter: '' };
            let b = normalizeBrand(exif.make, exif.model);
            let m = (exif.model || '').trim();
            // model里去掉品牌名重复部分
            if (m && b && m.toLowerCase().includes(b.toLowerCase())) {
                m = m.replace(new RegExp(b, 'gi'), '').trim();
            }
            if (!b && !m) b = 'CAMERA';
            return { brand: b, model: m, focal, aperture: aper, iso, shutter: shut };
        }
        const rnd = javaRandom(iw * 313 + ih * 997 + (ORD[styleName] || 0));
        const focals = ['24mm','28mm','35mm','50mm','85mm','135mm','200mm'];
        const apert = ['f/1.4','f/2.0','f/2.8','f/4.0','f/5.6','f/8.0','f/11'];
        const isos = ['ISO 100','ISO 200','ISO 400','ISO 800','ISO 1600','ISO 3200'];
        const shutters = ['1/60','1/125','1/250','1/500','1/1000','1/2000','1/4000'];
        const f = () => focals[rnd(focals.length)], a = () => apert[rnd(apert.length)],
            i = () => isos[rnd(isos.length)], s = () => shutters[rnd(shutters.length)];
        if (noBrandModel) return { brand: '', model: '', focal: f(), aperture: a(), iso: '', shutter: '' };
        let b, m;
        if (['CARD_LEICA','CARD_LOGO_PARAM','CARD_IMMERSION','OVERLAY_LOGO_BOTTOM'].includes(styleName)) { b='LEICA'; m='M10-P'; }
        else if (['FUJI_WHITE','OVERLAY_PARAM_BOTTOM','PARAM_STRIP'].includes(styleName)) { b='FUJIFILM'; m='X-T5'; }
        else if (['XIAOMI_IMP','IMP_FROSTED','IMP_CLASSIC','XIAOMI_LEICA'].includes(styleName)) { b='XIAOMI'; m='14 Ultra'; }
        else if (['ART_CARD','COLOR_CLASSIC','COLOR_REFINED'].includes(styleName)) { b='GFX'; m='100S'; }
        else if (['WM_CLASSIC','WM_SINGLE','WM_BRAND_LOGO','WM_AI','BLUR_CLASSIC','BLUR_DATE','OVERLAY_PARAM_LEFT'].includes(styleName)) { b='SONY'; m='A7 IV'; }
        else if (styleName === 'CARD_PURE_LOGO') { b='LEICA'; m='Q3'; }
        else if (styleName === 'PARAM_CREDIT') { b='CANON'; m='ILCE-7CM2'; }
        else if (['CARD_SIMPLE','PARAM_TOP_LEFT','PARAM_BOTTOM_LEFT','OVERLAY_PARAM_RIGHT'].includes(styleName)) { b='CANON'; m='EOS R5'; }
        else if (styleName === 'CARD_APPLE') { b='Apple'; m='iPhone'; }
        else return { brand: '', model: '', focal: '', aperture: '', iso: '', shutter: '' };
        return { brand: b, model: m, focal: f(), aperture: a(), iso: i(), shutter: s() };
    }
    function exifLine(cam) { return cam.focal + '  ' + cam.aperture + '  ' + cam.iso + '  ' + cam.shutter; }
    function buildParamString(cam, paramType) {
        const ap = cam.aperture.replace('f/', 'F');
        const ss = cam.shutter.endsWith('s') ? cam.shutter : cam.shutter + 's';
        if (paramType === 1) return cam.focal + '  ' + ap;
        if (paramType === 2) return dateYMD();
        return cam.focal + '  ' + ap + '  ' + ss + '  ' + cam.iso;
    }
    function positionOf(p) { return (p === '居左' || p === 'LEFT') ? 'LEFT' : (p === '居右' || p === 'RIGHT') ? 'RIGHT' : (p === '分列' || p === 'SPLIT') ? 'SPLIT' : 'CENTER'; }

    // ── 文本:字距(track)/度量/绘制 ──
    function setFont(g, px, mono, bold, family) {
        g.font = (bold ? 'bold ' : '') + px + 'px ' + (mono ? 'monospace' : (family || 'sans-serif'));
    }
    // 字符宽度记忆化:charW 每个字符都要一次 measureText,而一条参数条/水印一帧要量上千次
    // (fitFont 还会从 startFs 每次 -1 重试整串)。同一 (字号, 粗体, 字距, 字符) 的 measureText
    // 必然返回同一个浮点,所以缓存与直接调用逐比特等价。
    // 两个要点:
    //   ① 键必须含 letterSpacing —— Chromium 的 measureText 会把它计入宽度(见 :3273 的注释),
    //      漏掉就会在设了字距的风格里量出错值,那等于改像素;
    //   ② setFont 照旧每次都调,不改变 ctx.font 的既有副作用(有些调用方紧接着就 fillText)。
    const _charWCache = new Map();
    const _charWFCache = new Map();
    const CHARW_CACHE_MAX = 8192;
    function memoCharW(cache, key, compute) {
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        const v = compute();
        if (cache.size >= CHARW_CACHE_MAX) cache.clear();
        cache.set(key, v);
        return v;
    }
    function charW(g, ch, px, mono, bold) {
        if (mono) return Math.round(px * 0.60);
        setFont(g, px, mono, bold);
        return memoCharW(_charWCache, px + '|' + (bold ? 1 : 0) + '|' + (g.letterSpacing || '0px') + '|' + ch,
            () => g.measureText(ch).width);
    }
    function textMetrics(g, text, px, mono, bold, track) {
        const ascent = Math.round(px * 0.78), descent = Math.round(px * 0.22);
        let w = 0;
        for (let i = 0; i < text.length; i++) w += charW(g, text[i], px, mono, bold);
        w += (track || 0) * Math.max(0, text.length - 1);
        return { w, ascent, descent, height: ascent + descent, maxDescent: descent };
    }
    function drawTextL(g, text, x, y, fill, px, mono, bold, track) {
        if (!text) return;
        if (!track) { setFont(g, px, mono, bold); g.fillStyle = fill; g.fillText(text, x, y); return; }
        setFont(g, px, mono, bold);
        g.fillStyle = fill;
        let cx = x;
        for (let i = 0; i < text.length; i++) {
            g.fillText(text[i], cx, y);
            cx += charW(g, text[i], px, mono, bold) + track;
        }
    }
    function drawShadowTextL(g, text, x, y, px, fill, mono, bold, track) {
        const off = Math.max(1, Math.round(px / 24));
        drawTextL(g, text, x + off, y + off, 'rgba(0,0,0,0.59)', px, mono, bold, track);
        drawTextL(g, text, x, y, fill, px, mono, bold, track);
    }
    function fitFont(g, text, mono, bold, startFs, maxWidth, track) {
        let fs = Math.max(9, startFs);
        while (fs > 9) { if (textMetrics(g, text, fs, mono, bold, track).w <= maxWidth) break; fs--; }
        return fs;
    }
    function roundedPhoto(img, arc) {
        const c = newCanvas(img.naturalWidth, img.naturalHeight);
        const g = c.getContext('2d');
        roundRectPath(g, 0, 0, c.width, c.height, Math.max(1, arc));
        g.clip();
        g.drawImage(img, 0, 0);
        return c;
    }
    function drawCardSoftShadow(g, w, h, px, py, pw, ph, arc) {
        const blur = Math.max(6, Math.min(24, Math.floor(pw / 60)));
        const sh = newCanvas(w, h);
        const sg = sh.getContext('2d');
        sg.fillStyle = 'rgba(0,0,0,0.275)';
        fillRoundRectCtx(sg, px + Math.floor(blur / 3), py + Math.max(4, Math.floor(blur / 2)), pw, ph, Math.max(1, arc));
        g.drawImage(fastBlurCanvas(sh, blur), 0, 0);
    }
    const trim = s => String(s == null ? '' : s).trim().toUpperCase();

    // ── ColorSampler(原版 sampleEdgeColor / sampleBottomDarkColor)──
    function sampleEdgeColor(img) {
        const key = imgKey(img) + ':edge';
        if (_edgeCache[key]) return _edgeCache[key];
        const w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.max(1, Math.floor(Math.max(w, h) / 64));
        const sw = Math.floor(w / scale), sh = Math.floor(h / scale);
        const small = newCanvas(sw, sh);
        const sg = small.getContext('2d');
        sg.imageSmoothingEnabled = true; sg.drawImage(img, 0, 0, sw, sh);
        const { data } = sg.getImageData(0, 0, sw, sh);
        const stripW = Math.max(1, Math.floor(sw / 10)), stripH = Math.max(1, Math.floor(sh / 10));
        let r = 0, g = 0, b = 0, n = 0;
        const acc = i => { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; };
        for (let x = 0; x < sw; x++) for (let y = 0; y < stripH; y++) acc((y * sw + x) * 4);
        for (let x = 0; x < sw; x++) for (let y = sh - stripH; y < sh; y++) acc((y * sw + x) * 4);
        for (let y = stripH; y < sh - stripH; y++) {
            for (let x = 0; x < stripW; x++) acc((y * sw + x) * 4);
            for (let x = sw - stripW; x < sw; x++) acc((y * sw + x) * 4);
        }
        if (!n) { const fb2 = { r: 100, g: 120, b: 140 }; _edgeCache[key] = fb2; return fb2; }
        const res = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
        _edgeCache[key] = res;
        return res;
    }
    function sampleBottomDarkColor(img) {
        const key = imgKey(img) + ':bottom';
        if (_bottomCache[key]) return _bottomCache[key];
        const w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.max(1, Math.floor(Math.max(w, h) / 64));
        const sw = Math.floor(w / scale), sh = Math.floor(h / scale);
        const small = newCanvas(sw, sh);
        const sg = small.getContext('2d');
        sg.imageSmoothingEnabled = true; sg.drawImage(img, 0, 0, sw, sh);
        const { data } = sg.getImageData(0, 0, sw, sh);
        const stripH = Math.max(1, Math.floor(sh / 5));
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = sh - stripH; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
                const i = (y * sw + x) * 4;
                const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
                if (lum < 128) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
            }
        }
        if (!n) { const fb3 = { r: 25, g: 25, b: 30 }; _bottomCache[key] = fb3; return fb3; }
        const res = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
        _bottomCache[key] = res;
        return res;
    }

    // ── 模糊底/主照片/底部遮罩(原版 createBlurBacking/drawBlurBackground/drawMainPhoto/drawBottomMaskAndText)──
    const scaledPx = x => Math.round(x);
    function autoExifSize(paramFs, lastW) {
        if (!lastW) return paramFs;
        const k = Math.max(0.5, Math.min(8, lastW / 1200.0));
        return Math.max(2, Math.min(800, Math.round(paramFs * k)));
    }
    function scaledBlurRadius(blurIntensity) { return Math.max(6, Math.round((50 + blurIntensity / 2.0) * 1.0)); }
    // 个性签名/大标题背景模糊(z=42)半径:由滑块 blurIntensity(0-100) 线性映射,默认 50 → 30px
    function signBlurRad(S) {
        const b = (S && typeof S.blurIntensity === 'number') ? S.blurIntensity : 50;
        return Math.max(0, Math.round(b * 0.6));
    }
    // 模糊留白带:上/左/右/下的解析度统一,由"模糊半径"兜底,边框粗细不超过图片短边的 7%,避免大边框预设把照片框出大片空白
    // 注:刻意不开放「留白宽度」倍率 —— 它会连画布尺寸(导出分辨率)一起改,
    // 与通用「边距大小」互相打架,属于两个旋钮抢一个结果。
    function blurBand(size, iw, ih, intensity) {
        const blurRadius = scaledBlurRadius(intensity);
        const rim = Math.min(Math.max(scaledPx(50), Math.floor(size / 2)), Math.round(Math.min(iw, ih) * 0.07));
        return Math.max(blurRadius, rim);
    }
    // 参数文字字号:由照片宽度驱动(跟随 paramFs 滑块),不受模糊带高度压缩,保证清晰可读
    function blurExifSz(iw, ih, paramFs, paramScale) {
        const k = paramScale || 1;
        return Math.max(28, Math.min(Math.round(autoExifSize(paramFs, iw) * 1.5 * k), Math.round(Math.min(iw, ih) * 0.09)));
    }
    // 底部参数带:至少能放下 型号行+参数行,其余三边仍用紧凑的模糊带
    function blurBottom(size, iw, ih, S) {
        const side = blurBand(size, iw, ih, S.blurIntensity);
        const exifSz = blurExifSz(iw, ih, S.paramFs, S.paramScale);
        const blockH = (S.paramType === 0 ? (exifSz + scaledPx(4)) + scaledPx(6) + exifSz : exifSz);
        return Math.max(side, Math.round(blockH + scaledPx(24)));
    }
    function drawMainPhoto(g, img, cx, cy, arc, scale, offX, offY, shadowK) {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const sc = scale || 1;
        const dw = iw * sc, dh = ih * sc;
        const dx = cx + (iw - dw) / 2 + (offX || 0);
        const dy = cy + (ih - dh) / 2 + (offY || 0);
        const radius = Math.max(1, arc * sc);
        // 悬浮阴影:大小与糊度跟随照片尺寸及图片缩放同步放大(图片越大/越放大,影子越宽越柔和)
        // 原来只留一层向下飘远的淡影，照片看着像贴在背景上；shadowK 让用户把它调成立体浮起：
        //   k=1(缺省) —— alpha 0.5 / blur shBlur*1.5 / 向下偏移，逐像素等同旧版；
        //   k>1      —— 投影加深并收紧贴边，再叠一层无偏移的环绕接触阴影(照片四周一圈暗晕)；
        //   k=0      —— 完全不要阴影。
        const k = shadowK == null ? 1 : Math.max(0, Math.min(2, Number(shadowK)));
        const shBlur = Math.max(4, Math.round(Math.min(iw, ih) * 0.03 * sc));
        const shOff = Math.max(3, Math.round(shBlur * 0.8));
        g.save();
        g.shadowColor = 'rgba(0,0,0,' + Math.min(0.85, 0.5 * k).toFixed(3) + ')';
        g.shadowBlur = shBlur * 1.5 / Math.max(1, k * 0.75);
        g.shadowOffsetY = shOff * 1.5 / Math.max(1, k * 0.55);
        g.fillStyle = '#ffffff';
        roundRectPath(g, dx, dy, dw, dh, radius);
        g.fill();
        if (k > 1) {
            g.shadowColor = 'rgba(0,0,0,' + Math.min(0.6, (k - 1) * 0.6).toFixed(3) + ')';
            g.shadowBlur = Math.max(3, shBlur * 0.4);
            g.shadowOffsetY = 0;
            g.shadowOffsetX = 0;
            roundRectPath(g, dx, dy, dw, dh, radius);
            g.fill();
        }
        g.shadowBlur = 0;
        g.shadowOffsetY = 0;
        g.shadowOffsetX = 0;
        roundRectPath(g, dx, dy, dw, dh, radius);
        g.clip();
        g.drawImage(img, dx, dy, dw, dh);
        for (const [wd, al] of [[Math.max(1, scaledPx(2)), 28], [Math.max(1, scaledPx(5)), 16], [Math.max(1, scaledPx(8)), 8]]) {
            g.strokeStyle = 'rgba(120,120,120,' + (al / 255).toFixed(3) + ')';
            g.lineWidth = wd;
            g.beginPath();
            if (g.roundRect) { g.roundRect(dx + wd / 2, dy + wd / 2, Math.max(0, dw - wd), Math.max(0, dh - wd), Math.max(1, arc * sc - wd / 2), Math.max(1, arc * sc - wd / 2)); }
            else { g.rect(dx + wd / 2, dy + wd / 2, Math.max(0, dw - wd), Math.max(0, dh - wd)); }
            g.stroke();
        }
        g.restore();
    }
    // ── WatermarkRender.drawParamMask(原版,含底部遮罩输入 = 整图)──
    function drawParamMask(g, canvasEl, cw, ch, cam, position, paramFs, S) {
        const lines = [brandHidden(S) ? null : cam.brand, cam.model, cam.focal, cam.aperture, cam.iso, cam.shutter].filter(v => v && String(v).trim() !== '');
        if (!lines.length) return;
        if (position === 'SPLIT') {
            const mid = Math.floor(lines.length / 2);
            drawSingleMask(g, canvasEl, cw, ch, lines.slice(0, mid), 'LEFT', paramFs, S, true);
            drawSingleMask(g, canvasEl, cw, ch, lines.slice(mid), 'RIGHT', paramFs, S, false);
            return;
        }
        drawSingleMask(g, canvasEl, cw, ch, lines, position, paramFs, S, true);
    }
    function drawSingleMask(g, canvasEl, cw, ch, lines, pos, paramFs, S, brandFirst) {
        const fs = Math.max(11, autoExifSize(paramFs, cw));
        // 只有第一行确实是品牌行时才套品牌字体/品牌色。隐藏品牌时 lines[0] 是型号,
        // 若继续按 brandFirst 处理会把型号染成品牌色并套衬线字。
        const brandLine0 = !!(brandFirst && !brandHidden(S) && S.cam && S.cam.brand);
        const fm = textMetrics(g, lines[0], fs, true, false, 0);
        const markW0 = brandMarkW(S, fs);
        const logoOnly0 = !!(brandLine0 && S.brandLogo === 2 && markW0 > 0);
        const brandTxt0 = brandLine0 ? (prettyBrand(lines[0]) || lines[0]) : lines[0];
        const brandTrack0 = Math.round(fs * 0.15);
        const brandW0 = brandLine0 ? brandTextWidth(g, brandTxt0, fs, brandTrack0)
            : textMetrics(g, brandTxt0, fs, true, false, 0).w;
        let maxW = 0;
        for (let li = 0; li < lines.length; li++) {
            const w = ((li === 0 && brandLine0) ? brandW0 : textMetrics(g, lines[li], fs, true, false, 0).w)
                + ((li === 0 && brandLine0) ? (logoOnly0 ? 0 : markW0) : 0);
            if (w > maxW) maxW = w;
        }
        const lineH = fm.height;
        const maskW = maxW + 24, maskH = lines.length * lineH + (lines.length - 1) * 16 + 16;
        let x = (pos === 'RIGHT') ? cw - maskW - 12 : 12;
        let y = Math.floor((ch - maskH) / 2);
        let mx = Math.max(0, x), my = Math.max(0, y);
        let mw = Math.min(cw - mx, maskW), mh = Math.min(ch - my, maskH);
        if (mw <= 0 || mh <= 0) return;
        const sx = Math.min(mx, cw - 1), sy = Math.min(my, ch - 1);
        const sw = Math.min(mw, cw - sx), sh = Math.min(mh, ch - sy);
        if (sw <= 0 || sh <= 0) return;
        const sub = newCanvas(sw, sh);
        const sg = sub.getContext('2d');
        sg.drawImage(canvasEl, sx, sy, sw, sh, 0, 0, sw, sh);
        g.drawImage(fastBlurCanvas(sub, Math.max(8, Math.floor(fs / 2))), mx, my, mw, mh);
        g.fillStyle = 'rgba(0,0,0,0.22)';
        fillRoundRectCtx(g, mx, my, mw, mh, 12);
        g.save();
        roundRectPath(g, mx, my, mw, mh, 12);
        g.clip();
        let textY = my + 8 + fm.ascent;
        for (let li = 0; li < lines.length; li++) {
            const l = lines[li];
            if (li === 0 && brandLine0) {
                // 品牌行:统一 Times New Roman + 品牌色;型号行仍是参数无衬线字
                g.font = brandFont(fs, 700);
                g.letterSpacing = brandTrack0;
                g.fillStyle = brandInk(lines[0], true);
            } else {
                g.font = 'bold ' + fs + 'px sans-serif';
                g.letterSpacing = 0;
                g.fillStyle = '#ffffff';
            }
            if (li === 0 && brandLine0) {
                if (logoOnly0) {
                    const used = drawBrandMark(g, S, logoCenterX(S, fs, mx + 12, brandW0), textY, fs);
                    if (!used) g.fillText(brandTxt0, mx + 12, textY);
                } else {
                    const used = drawBrandMark(g, S, mx + 12, textY, fs);
                    g.fillText(brandTxt0, mx + 12 + used, textY);
                }
            } else {
                g.fillText(l, mx + 12, textY);
            }
            textY += lineH + 16;
        }
        g.letterSpacing = 0;
        g.restore();
    }

    // ── 阶段二:文本类风格(原版 addXxx 逐行移植)──
    const cx2 = (w, tw) => (w - tw) / 2;
    function styleBlurClassic(img, size, g, iw, ih, S, cwO, chO) {
        const side = blurBand(size, iw, ih, S.blurIntensity);
        const bottom = blurBottom(size, iw, ih, S);
        styleBlurCommon(img, size, g, iw, ih, S, side, bottom, false, cwO, chO);
    }
    function styleBlurDate(img, size, g, iw, ih, S, cwO, chO) {
        const side = blurBand(size, iw, ih, S.blurIntensity);
        const bottom = blurBottom(size, iw, ih, S);
        styleBlurCommon(img, size, g, iw, ih, S, side, bottom, true, cwO, chO);
    }
    function styleBlurCommon(img, size, g, iw, ih, S, blurMargin, blurBottom, dateLayout, cwO, chO) {
        // 全出血模糊:「背景模糊」设计就是模糊铺满画布。当目标画布因显式比例被扩边时,
        // 把自然内容块(照片+四周模糊带+底部参数带)在扩出的画布内居中,模糊底连续铺满
        // 整张画布——扩边处是同一张模糊的延伸,不出现硬性实色补边。
        const naturalW = blurMargin + iw + blurMargin;
        const naturalH = blurMargin + ih + blurBottom;
        const cw = cwO || naturalW;
        const ch = chO || naturalH;
        const exPadX = Math.max(0, Math.round((cw - naturalW) / 2));
        const exPadY = Math.max(0, Math.round((ch - naturalH) / 2));
        // 印象式模糊底:照片 cover 铺满整张画布,整体高斯模糊后压暗
        g.save();
        g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, cw, ch);
        // 两条新增自由度：背景取景放大 / 背景压暗。字段缺省时分别等于原来的
        // cover×1、0.4 黑叠加，渲染逐像素不变。
        // 主体占比保持引擎原有的 ×0.94：它由通用滑块「图片缩放」(S.imgScale) 调节，
        // 不再单列一个自由度 —— 两者本是同一个乘数，重复只会让用户不知道拖哪个。
        const bgZoom = S.blurBackdropZoom != null ? S.blurBackdropZoom / 100 : 1;
        const scale = Math.max(cw / iw, ch / ih) * bgZoom;
        const dw = iw * scale, dh = ih * scale;
        g.filter = 'blur(' + scaledBlurRadius(S.blurIntensity) + 'px)';
        g.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
        g.filter = 'none';
        g.fillStyle = S.blurBackdropDim == null
            ? 'rgba(0,0,0,0.4)'
            : 'rgba(0,0,0,' + (S.blurBackdropDim / 100).toFixed(3) + ')';
        g.fillRect(0, 0, cw, ch);
        g.restore();
        const photoCr = Math.min(S.cornerAll, Math.min(iw, ih) / 2);
        const cx = blurMargin + exPadX, cy = blurMargin + exPadY;
        const shadowK = S.blurSubjectShadow != null ? S.blurSubjectShadow / 100 : 1;
        drawMainPhoto(g, img, cx, cy, photoCr, (S.imgScale || 1) * 0.94, S.imgOffsetX, S.imgOffsetY, shadowK);

        if (!S.useExif) return;
        // 字号: 先按用户基准(paramFs + 参数缩放滑块)计算, 再根据照片底边与画布底边之间的
        // 可用高度实时自适应 —— 用户每次改变图片大小, 参数带都重新居中并缩放字号
        const baseSz = blurExifSz(iw, ih, S.paramFs, S.paramScale);
        const showModel = S.paramType === 0;
        const minH = baseSz + (showModel ? (baseSz + scaledPx(4) + scaledPx(6)) : 0) + scaledPx(24);
        const phBottom = cy + Math.round(ih * (1 + (S.imgScale || 1) * 0.94) / 2) + (S.imgOffsetY || 0);
        const topY = Math.max(cy, Math.min(phBottom, ch - minH));
        const maskH = ch - topY;
        const idealH = showModel ? (baseSz + (baseSz + scaledPx(4)) + scaledPx(24) + scaledPx(16)) : (baseSz + scaledPx(24) + scaledPx(12));
        const k = Math.min(1.15, Math.max(0.7, maskH / idealH));
        const exifSz = Math.round(baseSz * k);
        const modelSz = exifSz + scaledPx(4);
        const paramSz = exifSz;

        const bc = sampleBottomDarkColor(img);
        const grad = g.createLinearGradient(0, topY, 0, ch);
        grad.addColorStop(0, 'rgba(' + bc.r + ',' + bc.g + ',' + bc.b + ',0)');
        grad.addColorStop(1, 'rgba(' + bc.r + ',' + bc.g + ',' + bc.b + ',' + (200 / 255).toFixed(3) + ')');
        g.fillStyle = grad;
        g.fillRect(0, topY, cw, maskH);

        const pos = S.position;
        const padX = Math.max(scaledPx(20), scaledPx(10) + exifSz);
        const modelTrack = Math.max(1, Math.round(modelSz * 0.08));
        const paramTrack = Math.max(1, Math.round(paramSz * 0.10));
        const brandTxt = brandHidden(S) ? '' : prettyBrand(S.cam.brand);
        const modelTxt = brandHidden(S) ? '' : String(S.cam.model || '').trim();
        // 品牌↔型号的水平间距：默认 0.28×型号字号（原本就留的一小段距离），
        // 「品牌间距」按倍率缩放它（0 = 贴在一起，300% = 三倍宽）。
        const brandGapBase = (brandTxt && modelTxt) ? Math.round(modelSz * 0.28) : 0;
        const brandGapPct = S.blurBrandGap != null ? S.blurBrandGap / 100 : 1;
        const brandGap = Math.round(brandGapBase * brandGapPct);
        const brandW = brandTxt ? brandTextWidth(g, brandTxt, modelSz, modelTrack) : 0;
        const modelW0 = modelTxt ? textMetrics(g, modelTxt, modelSz, false, true, modelTrack).w : 0;
        const fullW = brandW + (modelTxt ? brandGap + modelW0 : 0);
        const text = dateLayout ? dateYMD() : buildParamString(S.cam, S.paramType);
        if (showModel) {
            const logoW = brandMarkW(S, modelSz);
            // 行距默认把「照片底边 → 画布底边」这段高度连同两行字均分成三份：
            // 上留白 = 行距 = 下留白 = (maskH - 型号行 - 参数行) / 3。
            // 「行间距」滑块按倍率缩放它（0~300%），0 时两行贴在一起。
            const gapBase = Math.max(0, Math.round((maskH - modelSz - paramSz) / 3));
            const gapPct = S.blurTextGap != null ? S.blurTextGap / 100 : 1;
            const gap = Math.round(Math.min(gapBase * gapPct, Math.max(0, maskH - modelSz - paramSz)));
            const blockH = modelSz + gap + paramSz;
            // 「上下位置」：整块两行字在参数带里上下移动。0 = 居中（即三份均分），
            // ±100% 走到头；夹在参数带内，拖满也不会把字顶出画布。
            const room = Math.max(0, maskH - blockH);
            const shift = Math.round((S.blurTextOffset != null ? S.blurTextOffset / 100 : 0) * (maskH / 2));
            const shiftClamped = Math.max(-Math.floor(room / 2), Math.min(Math.floor(room / 2), shift));
            const blockTop = topY + Math.round(room / 2) + shiftClamped;
            // 用字形盒(ascent/descent)而不是字号本身定位：字号里那 22% 的下缘留白
            // 若也算进「文字高度」，会全堆到文字上方，视觉上变成上宽下窄。
            const modelAsc = Math.round(modelSz * 0.78);
            const modelDesc = Math.round(modelSz * 0.22);
            const paramAsc = Math.round(paramSz * 0.78);
            const modelY = blockTop + modelAsc;
            const paramsY = modelY + modelDesc + gap + paramAsc;
            const onlyLogo = (S.brandLogo === 2 && logoW > 0);
            let mX;
            if (pos === 'LEFT' || pos === 'SPLIT') mX = padX;
            else if (pos === 'RIGHT') mX = cw - (onlyLogo ? fullW : fullW + logoW) - padX;
            else mX = cx2(cw, onlyLogo ? fullW : fullW + logoW);
            if (onlyLogo) {
                // 品牌词被 logo 替换:logo 画在 brand 词块位置(居中),model 保留原排布
                const used = drawBrandMark(g, S, logoCenterX(S, modelSz, mX, brandW), modelY, modelSz);
                if (!used && brandTxt) drawBrandText(g, brandTxt, mX, modelY, modelSz, brandInk(brandTxt, true), modelTrack);
                const modelX = mX + brandW + brandGap;
                if (modelTxt) drawTextL(g, modelTxt, modelX, modelY, 'rgba(255,255,255,0.922)', modelSz, false, true, modelTrack);
            } else {
                const lwUsed = drawBrandMark(g, S, mX, modelY, modelSz);
                const bx = mX + lwUsed;
                if (brandTxt) drawBrandText(g, brandTxt, bx, modelY, modelSz, brandInk(brandTxt, true), modelTrack);
                if (modelTxt) drawTextL(g, modelTxt, bx + brandW + brandGap, modelY, 'rgba(255,255,255,0.922)', modelSz, false, true, modelTrack);
            }
            const pw = textMetrics(g, text, paramSz, true, false, paramTrack);
            let pX;
            if (pos === 'RIGHT' || pos === 'SPLIT') pX = cw - pw.w - padX;
            else if (pos === 'LEFT') pX = padX;
            else pX = cx2(cw, pw.w);
            drawTextL(g, text, pX, paramsY, 'rgba(220,220,220,0.824)', paramSz, true, false, paramTrack);
        } else {
            // 单行（仅参数 / 日期）：同样支持上下移动，默认居中（按字形盒居中）。
            const room = Math.max(0, maskH - paramSz);
            const shift = Math.round((S.blurTextOffset != null ? S.blurTextOffset / 100 : 0) * (maskH / 2));
            const shiftClamped = Math.max(-Math.floor(room / 2), Math.min(Math.floor(room / 2), shift));
            const paramsY = topY + Math.round(room / 2) + Math.round(paramSz * 0.78) + shiftClamped;
            const pw = textMetrics(g, text, paramSz, true, false, paramTrack);
            let pX;
            if (pos === 'LEFT' || pos === 'SPLIT') pX = padX;
            else if (pos === 'RIGHT') pX = cw - pw.w - padX;
            else pX = cx2(cw, pw.w);
            drawTextL(g, text, pX, paramsY, 'rgba(220,220,220,0.824)', paramSz, true, false, paramTrack);
        }
    }
    function styleWmClassic(img, size, g, iw, ih, S) {
        const barH = Math.max(50, size), pad = size, w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const fs = Math.max(11, Math.floor(size / 3));
        g.fillStyle = 'rgb(30,30,30)'; g.fillRect(pad, barY, iw, barH);
        const brandWid = drawLogo(g, trim(S.cam.brand), pad + 10, barY + Math.floor(barH / 2) + Math.floor(fs / 3), fs, S);
        const line2 = S.cam.model + '  |  ' + S.cam.focal + '  ' + S.cam.aperture;
        drawTextL(g, line2, pad + 10 + Math.round(brandWid) + Math.round(fs * 0.8), barY + Math.floor(barH / 2) + Math.floor(fs / 3), 'rgb(180,180,180)', autoExifSize(S.paramFs, iw), true, false, 0);
    }
    function styleWmSingle(img, size, g, iw, ih, S) {
        const barH = Math.max(32, size), pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const line = S.cam.focal + '  ' + S.cam.aperture + '  ' + S.cam.iso + '  ' + S.cam.shutter;
        const f = autoExifSize(S.paramFs, iw);
        const fm = textMetrics(g, line, f, true, false, 0);
        drawTextL(g, line, cx2(w, fm.w), barY + Math.floor(barH / 2) + Math.floor(fm.ascent / 2), 'rgb(60,60,60)', f, true, false, 0);
    }
    const AI_FAMILIES = ['"Microsoft YaHei","sans-serif"', '"KaiTi","楷体","serif"', '"SimSun","宋体","serif"', 'monospace'];
    function textMetricsF(g, text, px, mono, bold, track, family) {
        const ascent = Math.round(px * 0.78), descent = Math.round(px * 0.22);
        setFont(g, px, mono, bold, family);
        // 字体在循环外设好一次(与原实现一致),循环内只把 measureText 的结果缓存起来
        const keyPrefix = px + '|' + (mono ? 1 : 0) + '|' + (bold ? 1 : 0) + '|' + (g.letterSpacing || '0px') + '|' + family + '|';
        let w = 0;
        for (const ch of text) w += memoCharW(_charWFCache, keyPrefix + ch, () => g.measureText(ch).width);
        w += (track || 0) * Math.max(0, text.length - 1);
        return { w, ascent, descent, height: ascent + descent, maxDescent: descent };
    }
    function fitFontFs(g, text, fs, maxWidth, family, mono) {
        while (fs > 9) { if (textMetricsF(g, text, fs, mono, true, 0, family).w <= maxWidth) break; fs--; }
        return fs;
    }
    function styleWmAi(img, size, g, iw, ih, S) {
        const cam = S.cam, cap = S.aiCaption;
        const twoLine = cap && S.aiCapLayout !== 1;
        let barH = Math.max(twoLine ? 64 : 44, Math.floor(size * (twoLine ? 3 : 2) / 2));
        barH += Math.floor(barH * Math.max(0, S.aiCapSizePct - 100) / 250);
        const pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad + barH;
        let capCol, paramCol;
        if (S.aiCapTheme === 1) {
            g.fillStyle = 'rgb(20,20,22)'; g.fillRect(0, 0, w, h);
            capCol = 'rgb(245,243,238)'; paramCol = 'rgb(160,160,165)';
        } else if (S.aiCapTheme === 2) {
            const main = sampleEdgeColor(img);
            g.fillStyle = 'rgb(' + main.r + ',' + main.g + ',' + main.b + ')'; g.fillRect(0, 0, w, h);
            const light = (main.r * 299 + main.g * 587 + main.b * 114) / 1000 <= 150;
            capCol = light ? 'rgb(245,243,238)' : 'rgb(35,35,35)';
            paramCol = light ? 'rgb(195,195,200)' : 'rgb(110,110,110)';
        } else {
            g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
            capCol = 'rgb(35,35,35)'; paramCol = 'rgb(150,150,150)';
        }
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const params = cam.focal + '  ' + cam.aperture + '  ' + cam.iso + '  ' + cam.shutter;
        if (!cap) {
            const f = autoExifSize(S.paramFs, iw);
            const fm = textMetrics(g, params, f, true, false, 0);
            drawTextL(g, params, cx2(w, fm.w), barY + Math.floor(barH / 2) + Math.floor(fm.ascent / 2), 'rgb(60,60,60)', f, true, false, 0);
            return;
        }
        const family = AI_FAMILIES[S.aiCapFontIdx];
        const mono = S.aiCapFontIdx === 3;
        let fs = Math.max(10, Math.floor(Math.max(12, Math.floor(size / 3)) * S.aiCapSizePct / 100));
        fs = fitFontFs(g, cap, fs, iw - 20, family, mono);
        const cfm = textMetricsF(g, cap, fs, mono, true, 0, family);
        const drawCap = (t, x, y) => { setFont(g, fs, mono, true, family); g.fillStyle = capCol; g.fillText(t, x, y); };
        const centered = S.aiCapLayout !== 0;
        if (!twoLine) {
            const x = centered ? cx2(w, cfm.w) : pad + 10;
            drawCap(cap, x, barY + Math.floor(barH / 2) + Math.floor(cfm.ascent / 2) - 2);
        } else {
            const capX = centered ? cx2(w, cfm.w) : pad + 10;
            drawCap(cap, capX, barY + Math.floor(barH / 4) + Math.floor(cfm.ascent / 2) - 2);
            const f2 = autoExifSize(S.paramFs, iw);
            const line2 = cam.model ? params + '   |   ' + cam.model : params;
            const pfm = textMetrics(g, line2, f2, true, false, 0);
            const pX = centered ? cx2(w, pfm.w) : pad + 10;
            drawTextL(g, line2, pX, barY + Math.floor(barH * 3 / 4) + Math.floor(pfm.ascent / 2) - 1, paramCol, f2, true, false, 0);
        }
    }
    function styleWmBrandLogo(img, size, g, iw, ih, S) {
        const barH = Math.max(56, Math.floor(size * 3 / 2)), pad = size;
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = 'rgb(20,20,20)'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        if (S.useExif) {
            const barY = ih + pad, textCenterY = barY + Math.floor(barH / 2);
            const logoFs = Math.max(14, autoExifSize(S.paramFs, iw) + 4);
            drawLogo(g, trim(S.cam.brand), pad + 16, textCenterY + Math.floor(logoFs / 3), logoFs, S);
            const ps = buildParamString(S.cam, S.paramType);
            if (ps) {
                const f = autoExifSize(S.paramFs, iw);
                const fmm = textMetrics(g, ps, f, true, false, Math.max(1, Math.round(f * 0.08)));
                drawTextL(g, ps, w - pad - 16 - fmm.w, textCenterY + Math.floor(fmm.ascent / 2), 'rgb(200,200,200)', f, true, false, Math.max(1, Math.round(f * 0.08)));
            }
        }
    }
    // ══ 色卡提取 ══ 从照片提取 5 个主色,照片下方深色条内显示色块+色码
    const _paletteCache = new WeakMap();
    function _sqDist(a, b) {
        const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
        return dr * dr + dg * dg + db * db;
    }
    function extractPalette(img, n) {
        const cached = _paletteCache.get(img);
        if (cached && cached.n === n) return cached.pal;
        const sw = 64;
        const sc = document.createElement('canvas');
        sc.width = sw;
        sc.height = Math.max(1, Math.round(sw * (img.height / Math.max(1, img.width))));
        const sctx = sc.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(img, 0, 0, sw, sc.height);
        let data = null;
        try { data = sctx.getImageData(0, 0, sw, sc.height).data; } catch (e) { data = null; }
        const k = n || 5;
        const fallback = ['#333333', '#666666', '#999999', '#bbbbbb', '#dddddd'];
        if (!data) return fallback.slice(0, k);
        const pts = [];
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 40) pts.push([data[i], data[i + 1], data[i + 2]]);
        }
        if (pts.length === 0) return fallback.slice(0, k);
        if (pts.length <= k) {
            const pal = pts.map(c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join(''));
            while (pal.length < k) pal.push('#888888');
            _paletteCache.set(img, { n: n, pal: pal });
            return pal;
        }
        const runK = (centers) => {
            const assign = new Array(pts.length).fill(0);
            for (let it = 0; it < 14; it++) {
                for (let p = 0; p < pts.length; p++) {
                    let b = 0, bd = Infinity;
                    for (let c = 0; c < centers.length; c++) { const d = _sqDist(pts[p], centers[c]); if (d < bd) { bd = d; b = c; } }
                    assign[p] = b;
                }
                const sums = Array.from({ length: centers.length }, () => [0, 0, 0, 0]);
                for (let p = 0; p < pts.length; p++) { sums[assign[p]][0] += pts[p][0]; sums[assign[p]][1] += pts[p][1]; sums[assign[p]][2] += pts[p][2]; sums[assign[p]][3]++; }
                let moved = false;
                for (let c = 0; c < centers.length; c++) {
                    if (sums[c][3]) {
                        const nc = [Math.round(sums[c][0] / sums[c][3]), Math.round(sums[c][1] / sums[c][3]), Math.round(sums[c][2] / sums[c][3])];
                        if (nc[0] !== centers[c][0] || nc[1] !== centers[c][1] || nc[2] !== centers[c][2]) moved = true;
                        centers[c] = nc;
                    }
                }
                if (!moved) break;
            }
            return assign;
        };
        // 初始种子:最远点法(确定性,避免大面积单一色被拆成多个相近簇)
        const centers = [];
        centers.push(pts[0].slice());
        for (let c = 1; c < k; c++) {
            let bestP = 0, bestD = -1;
            for (let p = 0; p < pts.length; p++) {
                let md = Infinity;
                for (const ct of centers) { const d = _sqDist(pts[p], ct); if (d < md) md = d; }
                if (md > bestD) { bestD = md; bestP = p; }
            }
            centers.push(pts[bestP].slice());
        }
        runK(centers);
        // 去重合并:两中心距离过近则用离其余中心最远的点替换其一并重新收敛
        for (let pass = 0; pass < 5; pass++) {
            let dup = -1, dup2 = -1;
            for (let a = 0; a < k && dup < 0; a++) {
                for (let b = a + 1; b < k && dup < 0; b++) {
                    if (_sqDist(centers[a], centers[b]) < 676) { dup = a; dup2 = b; }
                }
            }
            if (dup < 0) break;
            let bestP = 0, bestD = -1;
            for (let p = 0; p < pts.length; p++) {
                let md = Infinity;
                for (let c = 0; c < k; c++) { if (c !== dup2) { const d = _sqDist(pts[p], centers[c]); if (d < md) md = d; } }
                if (md > bestD) { bestD = md; bestP = p; }
            }
            centers[dup2] = pts[bestP].slice();
            runK(centers);
        }
        const pal = centers.map(c => '#' + c.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join(''));
        _paletteCache.set(img, { n: n, pal: pal });
        return pal;
    }
    function styleColorPalette(img, size, g, iw, ih) {
        const pad = Math.max(30, Math.round(iw * 0.03));
        const barH = Math.max(104, Math.round(iw * 0.12));
        const w = iw + pad * 2, h = pad + ih + barH;
        g.fillStyle = '#f6f4ee'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad, iw, ih);
        const by = pad + ih;
        g.fillStyle = '#ffffff'; g.fillRect(0, by, w, barH);
        const colors = extractPalette(img, 5);
        const dotD = Math.round(barH * 0.44);
        const cy = by + Math.round(barH * 0.36);
        const gap = Math.max(40, Math.round(iw * 0.12));
        const totalW = colors.length * dotD + (colors.length - 1) * gap;
        let x = (w - totalW) / 2 + dotD / 2;
        g.textAlign = 'center';
        for (const c of colors) {
            g.beginPath(); g.arc(x, cy, dotD / 2, 0, Math.PI * 2);
            g.fillStyle = c; g.fill();
            g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,0.18)'; g.stroke();
            g.fillStyle = '#1a1a1a';
            g.font = Math.max(12, Math.round(dotD * 0.36)) + 'px "Courier New", monospace';
            g.fillText('#FF' + c.slice(1).toUpperCase(), x, cy + Math.round(dotD * 0.78));
            x += dotD + gap;
        }
    }
    function styleHasselblad(img, size, g, iw, ih, S) {
        // OPPO 哈苏水印:白底相框 + 底部白条。左侧品牌型号(可输入任意文字,留空回落照片识别型号)垂直居中,
        // 右侧两栏整体垂直居中:上栏色块(从照片提取主色),下栏拍摄参数(与色块等宽,字号自适应)。
        const pad = Math.max(14, Math.floor(size / 2));
        const fp = autoExifSize(S.paramFs, iw);
        const fsB = Math.max(17, Math.round(fp * 1.35));
        const barH = Math.max(64, Math.round(fsB * 2.6));
        const barY = ih + pad;
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const cam = S.cam;
        const detected = prettyBrand(cam.brand);
        const typed = String((S && S.hassyCaption) || '').trim();
        const brandTxt = typed
            || ((detected + (cam.model ? ' ' + cam.model : '')).trim() || 'OPPO');
        // 品牌色:输入文字与照片识别品牌一致时,自动使用该品牌品牌色
        let brandInkColor = 'rgb(25,25,25)';
        if (typed && detected) {
            const du = detected.toUpperCase(), tu = typed.toUpperCase();
            if (tu === du || tu.indexOf(du) === 0 || du.indexOf(tu) === 0) {
                const phoneInk = {
                    OPPO: '#00a862', VIVO: '#415fff', HUAWEI: '#d0021b', HONOR: '#7a6cf0',
                    APPLE: '#333333', GOOGLE: '#4285f4', ONEPLUS: '#eb0028', SAMSUNG: '#1428a0',
                    REDMI: '#ff6900', XIAOMI: '#ff6900', REALME: '#e6a800', MOTOROLA: '#0068c7',
                    NUBIA: '#b91a3a', ASUS: '#0052a5', NOKIA: '#124191', MEIZU: '#0080ff',
                    LG: '#d0021b', TECNO: '#5c2d91', INFINIX: '#e60012'
                };
                brandInkColor = phoneInk[du] || brandInk(detected, false);
            }
        }
        const barMid = barY + barH / 2;
        // 左:品牌型号,白条内垂直居中,字体与右侧参数横条一致(monospace),加粗避免显得细
        const bX = pad + 12;
        const bBaseline = barMid + Math.round(fsB * 0.28);
        drawTextL(g, brandTxt, bX, bBaseline, brandInkColor, fsB, true, true, 0);
        // 右栏:照片提取主色色卡 + 拍摄参数,整体垂直居中,参数与色块等宽
        const colors = extractPalette(img, 8);
        const cardH = Math.max(6, Math.round(fsB * 0.3));
        const cardW = Math.round(cardH * 1.7);
        const gap = Math.max(3, Math.round(fsB * 0.12));
        const cardsW = colors.length * cardW + (colors.length - 1) * gap;
        const ss = (cam.shutter || '').endsWith('s') ? cam.shutter : (cam.shutter || '') + 's';
        const ps = cam.focal + '  ' + cam.aperture + '  ' + ss + '  ' + cam.iso;
        let pFs = fp, pm = null;
        if (String(ps).trim()) {
            const pm0 = textMetrics(g, ps, fp, true, false, 0);
            if (pm0.w > 0 && Math.abs(pm0.w - cardsW) > 2) {
                pFs = Math.max(11, Math.min(Math.round(fp * 1.6), Math.round(fp * cardsW / pm0.w)));
            }
            pm = textMetrics(g, ps, pFs, true, false, 0);
        }
        const gapV = Math.max(6, Math.round(fsB * 0.22));
        const groupH = cardH + gapV + (pm ? pFs : 0);
        const groupTop = Math.round(barMid - groupH / 2);
        const cardY = groupTop;
        let cx = w - pad - 12 - cardsW;
        for (let i = 0; i < colors.length; i++) {
            g.fillStyle = colors[i];
            g.fillRect(cx, cardY, cardW, cardH);
            cx += cardW + gap;
        }
        if (pm) {
            const pBaseline = groupTop + cardH + gapV + Math.round(pFs * 0.78);
            drawTextL(g, ps, w - pad - 12 - pm.w, pBaseline, 'rgb(35,35,35)', pFs, true, false, 0);
        }
    }
    function styleImpFrosted(img, size, g, iw, ih, S) {
        // 横版:左侧文字区,右侧照片
        const gm = S.globalMargin || 1;
        const leftW = Math.max(180, Math.round(iw * 0.35 * gm));
        const rightPad = Math.round(leftW / 2);
        const topBotPad = Math.max(50, Math.round(size * 1.2));
        const w = leftW + iw + rightPad;
        const h = ih + topBotPad * 2;
        // 1. 照片 cover 铺满做模糊底
        g.save();
        g.fillStyle = '#1a2a3a'; g.fillRect(0, 0, w, h);
        const scale = Math.max(w / iw, h / ih);
        const dw = iw * scale, dh = ih * scale;
        g.filter = 'blur(' + Math.max(18, Math.round(Math.min(w, h) / 20)) + 'px)';
        g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
        g.filter = 'none';
        g.restore();
        // 压暗
        g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(0, 0, w, h);
        // 2. 右侧照片(垂直居中,带圆角阴影)
        const px = leftW + 40 + (S.imgOffsetX || 0);
        const py = Math.round((h - ih) / 2) + (S.imgOffsetY || 0);
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.6)';
        g.shadowBlur = Math.max(24, Math.round(Math.min(iw, ih) * 0.07));
        g.shadowOffsetY = Math.max(10, Math.round(Math.min(iw, ih) * 0.03));
        g.fillStyle = '#ffffff';
        const r = Math.max(8, Math.round(Math.min(iw, ih) * 0.02));
        if (typeof g.roundRect === 'function') {
            g.beginPath(); g.roundRect(px, py, iw, ih, r); g.fill();
        } else {
            g.fillRect(px, py, iw, ih);
        }
        g.restore();
        g.save();
        if (typeof g.roundRect === 'function') {
            g.beginPath(); g.roundRect(px, py, iw, ih, r); g.clip();
        }
        g.drawImage(img, px, py);
        g.restore();
        // 3. 左侧品牌名
        const ml = Math.round(leftW * 0.25) + 40;
        const brand = brandHidden(S) ? '' : prettyBrand((S.cam && S.cam.brand) ? S.cam.brand : 'SONY');
        // 默认自适应:按照片宽度比例算,用户调参数字号时按比例缩放
        const pfScale = (S.paramFs != null && S.paramFs > 0) ? S.paramFs / 33 : 1;
        const fBrand = Math.max(22, Math.round(leftW * 0.14 * pfScale * (S.brandScale || 1)));
        g.fillStyle = brandInk(brand, true);
        g.font = brandFont(fBrand, 700);
        g.letterSpacing = Math.round(fBrand * 0.15);
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        // 仅Logo 模式:logo 左对齐 ml(与下方 F/ISO/S 参数框同线),不再按品牌词宽居中——
        // 居中会随字号放大把 logo 甩离左边缘(品牌词宽无上限增长),导致印象风格左留白错位。
        const bmLw = drawBrandMark(g, S, ml, Math.round(h * 0.28), fBrand);
        if (S.brandLogo !== 2 || !bmLw) g.fillText(brand, ml + (S.brandLogo === 2 ? 0 : bmLw), Math.round(h * 0.28));
        // 4. 三行圆角方框参数
        if (true && S.useExif && S.cam) {
            const ps = S.paramScale || 1;
            const boxW = Math.round(leftW * 0.28 * pfScale * ps);
            const boxH = Math.round(boxW * 0.55);
            const fBox = Math.max(11, Math.round(boxH * 0.45));
            const fVal = Math.max(13, Math.round(leftW * 0.08 * pfScale * ps));
            const rows = [
                { label: 'F', val: String(S.cam.aperture || '6.3').replace(/^f\//i, '').replace(/^F\//i, '') },
                { label: 'ISO', val: String(S.cam.iso || '100').replace(/^iso/i, '') },
                { label: 'S', val: String(S.cam.shutter || '1/125').replace(/s$/i, '').replace(/^"/, '').replace(/"$/, '') }
            ];
            let ry = Math.round(h * 0.48);
            rows.forEach(row => {
                g.strokeStyle = '#ffffff';
                g.lineWidth = Math.max(1.5, Math.round(boxH * 0.08));
                g.beginPath();
                if (typeof g.roundRect === 'function') g.roundRect(ml, ry - boxH, boxW, boxH, Math.round(boxH * 0.2));
                else g.rect(ml, ry - boxH, boxW, boxH);
                g.stroke();
                g.fillStyle = '#ffffff';
                g.font = 'bold ' + fBox + 'px sans-serif';
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillText(row.label, ml + boxW / 2, ry - boxH / 2);
                g.font = 'bold ' + fVal + 'px sans-serif';
                g.textAlign = 'left';
                g.fillText(row.val, ml + boxW + Math.round(leftW * 0.05 * ps), ry - boxH / 2);
                ry += Math.round(boxH * 1.9);
            });
        }
    }
    function styleImpClassic(img, size, g, iw, ih, S) {
        const pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = 'rgb(40,40,45)'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        if (S.useExif) drawParamMask(g, g.canvas, w, h, S.cam, S.position, Math.max(11, S.paramFs), S);
    }
    function styleXiaomiImp(img, size, g, iw, ih, S) {
        const topPad = Math.max(20, Math.floor(size / 2));
        const barH = Math.max(50, size * 2);
        const sidePad = Math.max(6, Math.floor(size / 3));
        const w = iw + sidePad * 2, h = ih + topPad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, sidePad, topPad);
        const barY = ih + topPad;
        const f = autoExifSize(S.paramFs, iw);
        const fm = textMetrics(g, S.cam.focal, f, true, false, 0);
        g.fillStyle = 'rgb(240,240,240)';
        g.fillRect(sidePad, barY, iw, barH);
        const btns = [['焦距', S.cam.focal], ['光圈', S.cam.aperture], ['ISO', S.cam.iso], ['快门', S.cam.shutter]];
        const btnW = Math.floor(iw / btns.length), btnGap = 8;
        for (let i = 0; i < btns.length; i++) {
            const bx = sidePad + i * btnW + Math.floor(btnGap / 2);
            const by = barY + 6;
            const bw = btnW - btnGap, bh = barH - 12;
            g.fillStyle = 'rgb(220,220,220)';
            fillRoundRectCtx(g, bx, by, bw, bh, 8);
            const lw = textMetrics(g, btns[i][0], f, true, false, 0);
            const vw = textMetrics(g, btns[i][1], f, true, false, 0);
            drawTextL(g, btns[i][0], bx + Math.floor((bw - lw.w) / 2), by + fm.ascent + 4, 'rgb(120,120,120)', f, true, false, 0);
            drawTextL(g, btns[i][1], bx + Math.floor((bw - vw.w) / 2), by + bh - 8, 'rgb(30,30,30)', f, true, false, 0);
        }
    }
    function styleCardLeica(img, size, g, iw, ih, S) {
        const pad = Math.max(24, Math.floor(size * 3 / 4));
        const brand = brandHidden(S) ? '' : prettyBrand(trim(S.cam.brand));
        const dotGap = Math.max(8, Math.floor(size / 4));
        const w = iw + pad * 2;
        let bf = Math.max(14, autoExifSize(S.paramFs, iw));
        while (bf > 9 && brandTextWidth(g, brand, bf, 0) > iw) bf--;
        const bm = {
            w: brandTextWidth(g, brand, bf, 0),
            ascent: Math.round(bf * 0.78),
            maxDescent: Math.round(bf * 0.22),
            height: bf
        };
        const dotD = Math.max(9, Math.floor(bf * 2 / 5));
        const pl = S.useExif ? exifLine(S.cam) : '';
        let pf = 0, pm = { w: 0, ascent: 0 };
        if (pl) {
            const reserved = pad * 2 + dotD + dotGap + bm.w + brandMarkW(S, bf) + Math.floor(autoExifSize(S.paramFs, iw) * 0.5);
            pf = fitFont(g, pl, true, false, Math.max(12, Math.floor(autoExifSize(S.paramFs, iw) * 2 / 3)), Math.max(60, w - reserved), 0);
            pm = textMetrics(g, pl, pf, true, false, 0);
        }
        const maxFs = Math.max(bf, pf);
        const bandH = Math.max(52, Math.floor(maxFs * 5 / 2));
        const h = ih + pad + bandH;
        const g2 = g;
        g2.fillStyle = '#ffffff'; g2.fillRect(0, 0, w, h);
        g2.drawImage(img, pad, pad);
        const baseY = ih + pad + Math.floor((bandH + bm.ascent - bm.maxDescent) / 2);
        g2.fillStyle = 'rgb(226,6,18)';
        const capCenter = baseY - Math.floor(bf * 72 / 200);
        g2.beginPath();
        g2.arc(pad + dotD / 2, capCenter, dotD / 2, 0, Math.PI * 2);
        g2.fill();
        // logo 顶替品牌文字时,本意是让 logo 居中于文字原来的区域(logoCenterX)。
        // 但 logo 比文字宽时,居中会把左边缘反向推到红点身上:Leica 是宽字标,
        // 实测 logo 宽高比 ≥6:1 (如 240×40) 时红点被完全盖住,≥10:1 (400×40) 时
        // logo 左缘还会越出画布。故夹住下界,永远不早于文字起点 brandX。
        // logo 比文字窄时居中结果本就在 brandX 右侧,夹取不生效,行为完全不变。
        const brandX = pad + dotD + dotGap;
        const brandLw = drawBrandMark(g2, S, S.brandLogo === 2 ? Math.max(brandX, logoCenterX(S, bf, brandX, bm.w)) : brandX, baseY, bf);
        if (!(S.brandLogo === 2 && brandLw)) drawBrandText(g2, brand, brandX + (S.brandLogo === 2 ? 0 : brandLw), baseY, bf, brandInk(brand, false), 0);
        if (pf && pl) drawTextL(g2, pl, w - pad - pm.w, baseY, 'rgb(120,120,120)', pf, true, false, 0);
    }
    // ══ 苹果信息卡:白底 + 照片 + 底部设备信息条 ──
    //   左:设备型号(粗体近黑,如「iPhone 18 Pro Max」);右:品牌 Logo(灰) + 拍摄参数(灰)。
    //   照片与信息条之间一道 Apple 风细分隔线(#d2d2d7);四周白边,照片与信息条居中于白色画布。
    // ── 苹果信息卡(CARD_APPLE):所有可自定义项 ──
    // 空串 = 自动:品牌/型号取自 EXIF(manualExif 优先),参数取自相机参数,日期取当前时间。
    // 其余字段缺省时用下面的中性默认值;脏值一律夹到合法区间,绝不把 NaN 带进画布。
    // 字体白名单:只用系统自带、Win/mac 都常见的字体;模板里的脏值一律回落到默认。
    const APPLE_CARD_FONTS = ['Trebuchet MS', 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Helvetica', 'Arial',
        'Georgia', 'Times New Roman', 'Book Antiqua', 'Bodoni MT', 'Courier New', 'Courier New', 'Arial Black'];
    const APPLE_CARD_FONT_DEFAULT = 'Trebuchet MS';
    function appleCardCfg(a) {
        a = (a && typeof a === 'object') ? a : {};
        const str = (v) => (typeof v === 'string' ? v.trim() : '');
        const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
        const on = (v, d) => (v == null ? d : (Number(v) ? 1 : 0));
        const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : d);
        const font = (v) => {
            const s = String(v || '').trim();
            return APPLE_CARD_FONTS.indexOf(s) >= 0 ? s : APPLE_CARD_FONT_DEFAULT;
        };
        return {
            dateText: str(a.dateText),
            showBrand: on(a.showBrand, 1), showModel: on(a.showModel, 1),
            showParams: on(a.showParams, 1), showDate: on(a.showDate, 1),
            showLogo: on(a.showLogo, 1), showLine: on(a.showLine, 1),
            modelScale: num(a.modelScale, 1, 0.4, 3),
            paramScale: num(a.paramScale, 1, 0.4, 3), dateScale: num(a.dateScale, 1, 0.4, 3),
            logoScale: num(a.logoScale, 1, 0.3, 3),
            logoOpacity: num(a.logoOpacity, 60, 0, 100),
            lineScale: num(a.lineScale, 1, 0.2, 5),
            fontFamily: font(a.fontFamily),
            textColor: hex(a.textColor, '#1d1d1f'),
            subColor: hex(a.subColor, '#86868b'),
            lineColor: hex(a.lineColor, '#d2d2d7'),
            barBg: hex(a.barBg, '#ffffff'),
        };
    }
    function appleCardText(S, A) {
        const cam = (S && S.cam) || {};
        const exif = (S && S.exif) || {};
        // 品牌/型号/参数统一由下方「相机参数(自动识别)」的品牌/型号/焦距/光圈/ISO/快门驱动,
        // 不再在苹果卡里另开一套覆盖输入(那是重复的第二事实来源)。仅日期没有对应 EXIF 字段,可自定义。
        const brand = (cam.brand || '').trim() || ((exif.make || '').trim()) || '';
        const model = ((exif.model || '').trim()) || cam.model || 'iPhone';
        const params = (S && S.useExif) ? exifLine(cam) : '';
        const date = A.dateText || dateTimeYMD();
        return { brand, model: String(model).trim(), params, date };
    }
    function cardAppleMetrics(iw, size, paramFs, A, T) {
        const base = Math.max(15, Math.round(autoExifSize(paramFs, iw) * 0.5));
        const fModel = Math.max(9, Math.round(base * A.modelScale));
        // 品牌与型号同字号;品牌只靠颜色/字重区分层级
        const fBrand = fModel;
        const fParam = Math.max(9, Math.round(base * 0.82 * A.paramScale));
        // 日期与参数同字号(只保留各自的缩放滑块做微调)
        const fDate = Math.max(8, Math.round(base * 0.82 * A.dateScale));
        const gapRD = Math.round(fParam * 0.3);
        const hasBrand = A.showBrand && !!T.brand;
        const hasModel = A.showModel && !!T.model;
        // 品牌与型号同一排:行高取两者较大者,不再上下叠加
        const leftH = (hasBrand || hasModel) ? Math.max(hasBrand ? fBrand : 0, hasModel ? fModel : 0) : 0;
        const rightH = (A.showParams && T.params ? fParam : 0)
            + ((A.showParams && T.params) && (A.showDate && T.date) ? gapRD : 0)
            + (A.showDate && T.date ? fDate : 0);
        // 默认 logo 再小一半:滑块 100% = 原先的 50%
        const logoH = A.showLogo ? Math.round(Math.max(fParam * 1.3, fModel * 0.95) * A.logoScale) : 0;
        const innerH = Math.max(leftH, rightH, logoH, 1);
        // 底部白边:在「内容 + 上下留白」基础上再放大 1.5 倍(用户要求再宽 0.5 倍)
        const capH = Math.round((innerH + Math.max(32, innerH * 0.82)) * 1.5);
        return { fBrand, fModel, fParam, fDate, gapRD, logoH, capH };
    }
    function styleCardApple(img, size, g, iw, ih, S) {
        const A = appleCardCfg(S.appleCard);
        const T = appleCardText(S, A);
        const M = cardAppleMetrics(iw, size, S.paramFs, A, T);
        const capH = M.capH;
        // 上/左/右贴边:照片直接顶到画布边缘,只有底部一条白色信息条
        const w = iw;
        const h = ih + capH;
        const FONT = "'" + A.fontFamily + "', 'Segoe UI', Arial, sans-serif";
        const meas = (txt, fs, bold) => {
            if (!txt) return 0;
            g.font = (bold ? 'bold ' : '') + fs + 'px ' + FONT;
            return g.measureText(txt).width;
        };
        // 左侧品牌/型号:沿用「相机参数水印」品牌行的衬线字体(Times New Roman / Georgia),
        // 与参数水印保持同一套气质;右侧参数/日期仍跟随面板「字体」下拉。
        const measL = (txt, fs, bold) => {
            if (!txt) return 0;
            g.font = brandFont(fs, bold ? 700 : 400);
            return g.measureText(txt).width;
        };

        // 背景:与信息条同色(图片缩放<100% / 圆角露出的也是这个颜色)
        g.fillStyle = A.barBg;
        g.fillRect(0, 0, w, h);

        // 照片:上/左/右贴边;支持图片缩放(居中缩放,超出画布部分自然裁切)
        const sc = Math.max(0.2, S.imgScale || 1);
        const dw = Math.round(iw * sc), dh = Math.round(ih * sc);
        const dx = Math.round((iw - dw) / 2), dy = Math.round((ih - dh) / 2);
        g.drawImage(img, dx, dy, dw, dh);

        const sepY = ih;                            // 信息条顶边 = 照片下沿
        const cy = sepY + capH / 2;                 // 信息条竖直中心
        g.textBaseline = 'alphabetic';
        g.letterSpacing = '0px';

        // 信息条底色(底部白边)
        g.fillStyle = A.barBg;
        g.fillRect(0, sepY, iw, capH);

        // 信息条内边距:文字不贴画布边缘(条内留白,不是外框)
        const innerPad = Math.max(10, Math.round(capH * 0.2));
        const leftX = innerPad;
        const rightEdge = iw - innerPad;

        // ── 左:品牌 + 型号 同一排(过长整体缩字号,不挤到右侧) ──
        const hasBrand = A.showBrand && !!T.brand;
        const hasModel = A.showModel && !!T.model;
        const maxLeftW = Math.max(30, iw * 0.56 - innerPad);
        let fBrandD = M.fBrand, fModelD = M.fModel;
        const brandGap = () => ((hasBrand && hasModel) ? Math.max(4, Math.round(Math.max(fBrandD, fModelD) * 0.32)) : 0);
        const comboW = () => (hasBrand ? measL(T.brand, fBrandD, false) : 0)
            + brandGap()
            + (hasModel ? measL(T.model, fModelD, true) : 0);
        // 同一排后整体变宽:按比例缩字号
        let lscale = 1;
        for (;;) {
            if (comboW() <= maxLeftW || lscale <= 0.35) break;
            lscale -= 0.03;
            fModelD = Math.max(9, Math.round(M.fModel * lscale));
            fBrandD = Math.max(8, Math.round(M.fBrand * lscale));
        }
        const leftTextW = comboW();
        const lineFs = Math.max(hasBrand ? fBrandD : 0, hasModel ? fModelD : 0, 1);
        const baseY = cy + Math.round(lineFs * 0.35); // 品牌与型号共用一条基线
        g.textAlign = 'left';
        let cursorX = leftX;
        if (hasBrand) {
            g.font = brandFont(fBrandD, 400);
            g.fillStyle = A.subColor;
            g.fillText(T.brand, cursorX, baseY);
            cursorX += measL(T.brand, fBrandD, false) + brandGap();
        }
        if (hasModel) {
            g.font = brandFont(fModelD, 700);
            g.fillStyle = A.textColor;
            g.fillText(T.model, cursorX, baseY);
        }

        // ── 右:大 logo + 竖线 + 参数/日期(同字号两行) ──
        const hasP = A.showParams && !!T.params;
        const hasD = A.showDate && !!T.date;
        const hasText = hasP || hasD;
        const showLine = A.showLine && hasText;
        let logoImg = null;
        if (A.showLogo && S.brandLogoImg && S.brandLogoImg.complete && S.brandLogoImg.naturalWidth) logoImg = S.brandLogoImg;

        const gapText = hasText ? Math.round(M.fModel * 0.5) : 0;   // 竖线 ↔ 文字
        const gapLogo = Math.round(M.fModel * 0.6);                 // logo ↔ 竖线
        let maxRightW = iw - innerPad * 2 - leftTextW - Math.round(M.fModel * 0.8);
        if (maxRightW < iw * 0.28) maxRightW = iw * 0.28;

        // 按可用宽度缩放右块(字号 + logo),避免溢出/与左块重叠
        let scale = 1, fp = M.fParam, fd = M.fDate, lh = M.logoH, lw = 0, textW = 0;
        for (;;) {
            fp = Math.max(8, Math.round(M.fParam * scale));
            fd = Math.max(7, Math.round(M.fDate * scale));
            const pW = hasP ? meas(T.params, fp, true) : 0;
            const dW = hasD ? meas(T.date, fd, false) : 0;
            textW = Math.max(pW, dW);
            lh = Math.round(M.logoH * scale);
            lw = logoImg ? Math.round(lh * (logoImg.naturalWidth / logoImg.naturalHeight)) : 0;
            let blockW = textW;
            if (showLine) blockW += gapText;
            if (lw) blockW += (showLine ? gapLogo : (hasText ? gapText : 0)) + lw;
            if (scale <= 0.3 || blockW <= maxRightW) break;
            scale -= 0.05;
        }

        const textLeft = rightEdge - textW;
        const lineX = textLeft - gapText - 0.5;
        const logoRight = showLine ? (lineX - gapLogo) : (textLeft - (hasText ? gapText : 0));
        const logoX = logoRight - lw;
        const logoY = cy - lh / 2;
        const gapRD = Math.round(fp * 0.3);
        const rightH = (hasP ? fp : 0) + (hasP && hasD ? gapRD : 0) + (hasD ? fd : 0);

        // 大 logo(不透明度可调,默认 60% 呈灰阶观感)
        if (logoImg) {
            g.save();
            g.globalAlpha = A.logoOpacity / 100;
            g.drawImage(logoImg, logoX, logoY, lw, lh);
            g.restore();
        }
        // 竖细分隔线(颜色/粗细可调)
        if (showLine) {
            const lineH = Math.min(lh || rightH, rightH) * 0.72;
            g.strokeStyle = A.lineColor;
            g.lineWidth = Math.max(0.5, Math.max(1, iw / 1000) * A.lineScale);
            g.beginPath();
            g.moveTo(lineX + 0.5, cy - lineH / 2);
            g.lineTo(lineX + 0.5, cy + lineH / 2);
            g.stroke();
        }

        // 右文字(右对齐):参数粗黑在上,日期小灰在下
        let ty = cy - rightH / 2;
        g.textAlign = 'right';
        if (hasP) {
            g.font = 'bold ' + fp + 'px ' + FONT;
            g.fillStyle = A.textColor;
            g.fillText(T.params, rightEdge, ty + fp);
            ty += fp + gapRD;
        }
        if (hasD) {
            g.font = fd + 'px ' + FONT;
            g.fillStyle = A.subColor;
            g.fillText(T.date, rightEdge, ty + fd);
        }
    }
    // ══ 联名水印(XIAOMI_LEICA):照片铺满画布,联名水印直接压在照片下沿 ──
    //   左:品牌字标(加粗 + 拉开字距,如 XIAOMI)→ 品牌 Logo(如 Leica 红圆标)→ 细竖线 →
    //   右:两行文案(上「Photo by Xiaomi 13」亮,下「Leica custom 徕卡定制」暗)。
    // ── 全部可自定义项 ──
    // 品牌字标/两行文案留空 = 自动:品牌大写取相机参数(手动 EXIF 优先),主文案 = Photo by 品牌 型号。
    // Logo 走通用「品牌显示」下拉(0 仅文字 / 1 文字+Logo / 2 仅Logo / 3 都不显示)与品牌 Logo 池,
    // 不在这里另开一套 Logo 选择;字号基准走通用「参数字号」滑块(autoExifSize),同样不重复造轮子。
    function xmLeicaCfg(a) {
        a = (a && typeof a === 'object') ? a : {};
        const str = (v) => (typeof v === 'string' ? v.trim() : '');
        const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
        const on = (v, d) => (v == null ? d : (Number(v) ? 1 : 0));
        const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : d);
        const font = (v) => {
            const s = String(v || '').trim();
            return APPLE_CARD_FONTS.indexOf(s) >= 0 ? s : 'Courier New';
        };
        return {
            brandText: str(a.brandText),          // 空 = 自动(相机品牌大写)
            line1: str(a.line1),                  // 空 = 自动 Photo by 品牌 型号
            line2: str(a.line2),                  // 空 = 不显示第二行
            partnerBrand: str(a.partnerBrand),    // 空 = Logo 跟随相机品牌;填品牌名(如 Leica)画联名 Logo
            showDiv: on(a.showDiv, 1),            // Logo/字标 与文案之间的细竖线
            showScrim: on(a.showScrim, 1),        // 底部黑色渐变(保证白字可读)
            align: num(a.align, 1, 0, 2),         // 0 左下 1 底部居中(默认,同联名水印官方版式) 2 右下
            brandScale: num(a.brandScale, 1, 0.4, 3),
            brandTracking: num(a.brandTracking, 0.16, 0, 0.5),   // 字标字距(× 字号)
            lineWeight: num(a.lineWeight, 600, 300, 700),        // 主文案字重
            lineScale: num(a.lineScale, 1, 0.4, 3),
            logoScale: num(a.logoScale, 1, 0.3, 3),
            logoOpacity: num(a.logoOpacity, 100, 0, 100),
            logoColor: hex(a.logoColor, ''),   // 单色 Logo 上色;空 = 原色
            logoRaw: on(a.logoRaw, 1),          // 勾选「原色」时忽略 logoColor
            padScale: num(a.padScale, 1, 0.4, 3),
            scrim: num(a.scrim, 45, 0, 100),
            fontFamily: font(a.fontFamily),
            textColor: hex(a.textColor, '#ffffff'),
            subColor: hex(a.subColor, '#d9d9d9'),
            divColor: hex(a.divColor, '#ffffff'),
        };
    }
    function xmLeicaText(S, A) {
        const cam = (S && S.cam) || {};
        const exif = (S && S.exif) || {};
        const brandRaw = ((cam.brand || '').trim() || (exif.make || '').trim() || 'XIAOMI').toUpperCase();
        const brand = (A.brandText || brandRaw).toUpperCase();
        const model = ((exif.model || '').trim()) || String(cam.model || '').trim();
        const line1 = A.line1 || ('Photo by ' + brand + (model ? ' ' + model : ''));
        return { brand, line1, line2: A.line2 };
    }
    // 字体栈:等宽族要落到 monospace,否则中文回退到系统无衬线后字距会塌
    function xmLeicaFontOf(A, fs, weight) {
        const w = weight === true ? 'bold ' : (typeof weight === 'number' && weight > 0 ? weight + ' ' : '');
        const mono = /courier|consolas|mono/i.test(A.fontFamily);
        const stack = mono ? "'Courier New', Consolas, monospace" : "'Segoe UI', Arial, sans-serif";
        return w + fs + "px '" + A.fontFamily + "', " + stack;
    }
    // 单色 Logo 上色:把图当 alpha 蒙版,用 source-in 填充目标色。
    // 彩色标(如徕卡红圆)会被整块覆盖成单色,所以面板默认勾「原色」,由用户决定要不要上色。
    const LOGO_TINT_CACHE = new WeakMap();
    function tintLogo(img, w, h, color) {
        let m = LOGO_TINT_CACHE.get(img);
        if (!m) { m = new Map(); LOGO_TINT_CACHE.set(img, m); }
        const key = w + 'x' + h + '|' + color;
        const hit = m.get(key);
        if (hit) return hit;
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, w); cv.height = Math.max(1, h);
        const cg = cv.getContext('2d');
        cg.drawImage(img, 0, 0, cv.width, cv.height);
        cg.globalCompositeOperation = 'source-in';
        cg.fillStyle = color;
        cg.fillRect(0, 0, cv.width, cv.height);
        if (m.size > 12) m.delete(m.keys().next().value);
        m.set(key, cv);
        return cv;
    }

    function styleXiaomiLeica(img, size, g, iw, ih, S) {
        const A = xmLeicaCfg(S.xmLeica);
        const T = xmLeicaText(S, A);
        // 照片铺满画布(水印直接压图,无边框)
        g.drawImage(img, 0, 0, iw, ih);

        // 字号基准直接按画布宽度算,不再挂全局「参数字号」:本风格不显示相机参数行,
        // 若再吃一次 paramFs,面板上「参数字号」与「文案字号」就成了两个都在改字号的滑块(重复)。
        // 系数 0.0125 等价于旧行为 paramFs=30 时的 autoExifSize*0.5,默认视觉不变。
        const base = Math.max(13, Math.round(iw * 0.0125));
        const fL1 = Math.max(9, Math.round(base * 0.9 * A.lineScale));       // 主文案
        const fL2 = Math.max(8, Math.round(fL1 * 0.82));                     // 副文案
        const fBrand = Math.max(11, Math.round(base * 1.15 * A.brandScale)); // 品牌字标
        const gapL = Math.max(3, Math.round(fL1 * 0.38));                    // 两行文案间距

        // 品牌显示走通用下拉:S.brandLogo 0 仅文字 / 1 文字+Logo / 2 仅Logo / 3 都不显示
        const mode = Number(S.brandLogo || 0);
        // Logo 来源:填了联名品牌(如 Leica)用联名 Logo,否则跟随相机品牌
        const logoSrc = (A.partnerBrand && S.xmPartnerImg && S.xmPartnerImg.complete && S.xmPartnerImg.naturalWidth)
            ? S.xmPartnerImg : S.brandLogoImg;
        const logoImg = ((mode === 1 || mode === 2) && logoSrc
            && logoSrc.complete && logoSrc.naturalWidth) ? logoSrc : null;
        const showBrandText = mode !== 2 && mode !== 3 && !!T.brand;
        const hasText = !!T.line1 || !!T.line2;
        const showDiv = A.showDiv && hasText && (showBrandText || !!logoImg);

        const meas = (txt, fs, bold, track) => {
            if (!txt) return 0;
            g.font = xmLeicaFontOf(A, fs, bold);
            g.letterSpacing = (track ? Math.max(0, Math.round(fs * A.brandTracking)) : 0) + 'px';
            const w = g.measureText(txt).width;
            g.letterSpacing = '0px';
            return w;
        };

        // 整块过宽时等比缩字号,绝不溢出画布
        let scale = 1, fb = fBrand, f1 = fL1, f2 = fL2, logoH = 0;
        const logoH0 = logoImg ? Math.round((mode === 2 ? fBrand * 1.05 : Math.max(fBrand, f1) * 0.95) * A.logoScale) : 0;
        const padBase = Math.max(12, Math.round(iw * 0.045));
        for (;;) {
            fb = Math.max(9, Math.round(fBrand * scale));
            f1 = Math.max(8, Math.round(fL1 * scale));
            f2 = Math.max(7, Math.round(fL2 * scale));
            logoH = Math.round(logoH0 * scale);
            const brandW = showBrandText ? meas(T.brand, fb, true, true) : 0;
            const logoW = logoImg ? Math.round(logoH * logoImg.naturalWidth / logoImg.naturalHeight) : 0;
            const textW = Math.max(T.line1 ? meas(T.line1, f1, A.lineWeight, false) : 0,
                T.line2 ? meas(T.line2, f2, 400, false) : 0);
            const gapB = (showBrandText && (logoImg || showDiv || hasText)) ? Math.round(fb * 0.55) : 0;
            const gapLg = (logoImg && (showDiv || hasText)) ? Math.round(fb * 0.5) : 0;
            const gapD = showDiv ? Math.round(fb * 0.55) : 0;
            const total = brandW + gapB + logoW + gapLg + (showDiv ? Math.max(1, Math.round(iw / 900)) + gapD : 0) + textW;
            const maxW = iw - padBase * 2 * A.padScale;
            if (total <= maxW || scale <= 0.3) {
                // 命中可用宽度,记录布局数据
                return xmDraw();
            }
            scale -= 0.04;
        }

        function xmDraw() {
            const pad = Math.round(padBase * A.padScale);
            const brandW = showBrandText ? meas(T.brand, fb, true, true) : 0;
            const logoW = logoImg ? Math.round(logoH * logoImg.naturalWidth / logoImg.naturalHeight) : 0;
            const w1 = T.line1 ? meas(T.line1, f1, A.lineWeight, false) : 0;
            const w2 = T.line2 ? meas(T.line2, f2, 400, false) : 0;
            const textW = Math.max(w1, w2);
            const divW = showDiv ? Math.max(1, Math.round(iw / 900)) : 0;
            const gapB = (showBrandText && (logoImg || showDiv || hasText)) ? Math.round(fb * 0.55) : 0;
            const gapLg = (logoImg && (showDiv || hasText)) ? Math.round(fb * 0.5) : 0;
            const gapD = showDiv ? Math.round(fb * 0.55) : 0;
            const total = brandW + gapB + logoW + gapLg + (showDiv ? divW + gapD : 0) + textW;

            // 对齐:0 左下 / 1 底部居中 / 2 右下
            let x0 = pad;
            if (A.align === 1) x0 = Math.round((iw - total) / 2);
            else if (A.align === 2) x0 = iw - pad - total;
            x0 = Math.max(pad, x0);

            // 块高度与垂直中心:取 字标/Logo/两行文案 的最大者
            const textH = (T.line1 ? f1 : 0) + (T.line1 && T.line2 ? gapL : 0) + (T.line2 ? f2 : 0);
            const brandH = showBrandText ? Math.round(fb * 0.78) : 0;
            const blockH = Math.max(brandH, logoH, textH, 1);
            const cy = ih - pad - blockH / 2;

            // 底部黑色渐变(scrim):从块上方一段距离渐入,保证白字在亮图上可读
            if (A.showScrim && A.scrim > 0) {
                const gradH = Math.max(blockH + pad * 2, ih * 0.22);
                const g0 = g.createLinearGradient(0, ih - gradH, 0, ih);
                const a = Math.min(0.92, A.scrim / 100 * 0.85);
                g0.addColorStop(0, 'rgba(0,0,0,0)');
                g0.addColorStop(1, 'rgba(0,0,0,' + a.toFixed(3) + ')');
                g.fillStyle = g0;
                g.fillRect(0, ih - gradH, iw, gradH);
            }

            g.textBaseline = 'alphabetic';
            g.textAlign = 'left';
            let cx = x0;
            // 品牌字标:加粗 + 拉开字距
            if (showBrandText) {
                g.font = xmLeicaFontOf(A, fb, true);
                g.letterSpacing = Math.max(0, Math.round(fb * A.brandTracking)) + 'px';
                g.fillStyle = A.textColor;
                g.fillText(T.brand, cx, cy + Math.round(fb * 0.36));
                g.letterSpacing = '0px';
                cx += brandW + gapB;
            }
            // 品牌 Logo(复用品牌池,透明度可调)
            if (logoImg) {
                g.save();
                g.globalAlpha = A.logoOpacity / 100;
                const logoDraw = (!A.logoRaw && A.logoColor)
                    ? tintLogo(logoImg, logoW, logoH, A.logoColor)
                    : logoImg;
                g.drawImage(logoDraw, cx, Math.round(cy - logoH / 2), logoW, logoH);
                g.restore();
                cx += logoW + gapLg;
            }
            // 细竖线
            if (showDiv) {
                const divH = Math.max(textH, Math.round(f1 * 1.2)) * 0.92;
                g.strokeStyle = A.divColor;
                g.globalAlpha = 0.85;
                g.lineWidth = divW;
                g.beginPath();
                g.moveTo(cx + divW / 2, cy - divH / 2);
                g.lineTo(cx + divW / 2, cy + divH / 2);
                g.stroke();
                g.globalAlpha = 1;
                cx += divW + gapD;
            }
            // 两行文案:主亮副暗
            const ty = cy - textH / 2;
            if (T.line1) {
                g.font = xmLeicaFontOf(A, f1, A.lineWeight);
                g.fillStyle = A.textColor;
                g.fillText(T.line1, cx, ty + Math.round(f1 * 0.8));
            }
            if (T.line2) {
                g.font = xmLeicaFontOf(A, f2, 400);
                g.fillStyle = A.subColor;
                g.fillText(T.line2, cx, ty + (T.line1 ? f1 + gapL : 0) + Math.round(f2 * 0.8));
            }
        }
    }
    function styleCardLogoParam(img, size, g, iw, ih, S, cwO, chO) {
        const pad = Math.max(28, Math.floor(size * 3 / 5));
        const arc = Math.max(12, Math.floor(size / 4));
        const brand = trim(S.cam.brand), model = S.cam.model || '';
        const brandTxt = brandHidden(S) ? '' : (prettyBrand(brand) || 'CAMERA');
        const modelTxt = brandHidden(S) ? '' : model.toUpperCase();
        const hasModel = !!modelTxt;
        const l2 = S.useExif ? exifLine(S.cam) : '';
        const innerW = Math.max(80, iw - Math.floor(pad * 2 / 3));
        // 品牌/参数行字号受品牌大小/参数缩放滑块放大(印象系列同规则)
        const brandScale = (S.brandScale || 1);
        const paramScale = (S.paramScale || 1);
        // 品牌行总宽(含字距):品牌 Times 衬线 + 型号无衬线,与「相机参数水印」同字体
        const brandTotal = (fs) => {
            const ls = Math.round(fs * 0.15), gap = Math.round(fs * 0.3);
            g.font = brandFont(fs, 700);
            g.letterSpacing = 0;
            const bw = g.measureText(brandTxt).width + ls * Math.max(0, brandTxt.length - 1);
            let tw = bw;
            if (hasModel) {
                g.font = 'bold ' + fs + "px 'Courier New', 'Courier New', monospace";
                g.letterSpacing = 0;
                tw += gap + g.measureText(modelTxt).width + ls * Math.max(0, modelTxt.length - 1);
            }
            g.letterSpacing = 0;
            return tw;
        };
        let fBrand = Math.max(14, Math.round(autoExifSize(S.paramFs, iw) * brandScale));
        while (fBrand > 9 && brandTotal(fBrand) > innerW) fBrand--;
        const f1 = fBrand;
        const m1 = { height: Math.round(f1 * 0.78) + Math.round(f1 * 0.22), ascent: Math.round(f1 * 0.78), maxDescent: Math.round(f1 * 0.22) };
        let f2 = null;
        let m2 = textMetrics(g, ' ', 10, true, false, 0);
        if (l2) {
            f2 = fitFont(g, l2, true, false, Math.max(12, Math.floor(autoExifSize(S.paramFs, iw) * 2 / 3 * paramScale)), innerW, 0);
            m2 = textMetrics(g, l2, f2, true, false, 0);
        }
        const gap = l2 ? Math.max(8, Math.floor(m1.height / 4)) : 0;
        const blockH = m1.height + (l2 ? gap + m2.height : 0);
        const bandH = Math.max(56, Math.floor(blockH + pad * 2 / 3));
        const natW = iw + pad * 2, natH = ih + pad + bandH;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        const w = natW, h = natH;
        // 背景:开启「背景模糊」时用模糊照片铺满+压暗,否则米白卡片底
        if (S.signBgBlur) {
            g.save();
            g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, cw, ch);
            g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.6)';
            const bs = Math.max(cw / iw, ch / ih);
            g.drawImage(img, (cw - iw * bs) / 2, (ch - ih * bs) / 2, iw * bs, ih * bs);
            g.filter = 'none';
            g.restore();
        } else {
            g.fillStyle = 'rgb(250,250,250)'; g.fillRect(0, 0, cw, ch);
        }
        g.save();
        g.translate(ox, oy);
        if (S.signBgBlur) {
            // 清晰圆角照片带悬浮阴影
            g.save();
            g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8;
            g.drawImage(roundedPhoto(img, arc), pad, pad);
            g.restore();
        } else {
            drawCardSoftShadow(g, w, h, pad, pad, iw, ih, arc);
            g.drawImage(roundedPhoto(img, arc), pad, pad);
        }
        const textColor = S.signBgBlur ? '#ffffff' : 'rgb(25,25,25)';
        const brandColor = brandInk(brand, !!S.signBgBlur);
        const paramColor = S.signBgBlur ? 'rgba(255,255,255,0.75)' : 'rgb(130,130,130)';
        const bandTop = ih + pad;
        const y1 = bandTop + Math.floor((bandH - blockH) / 2) + m1.ascent;
        // 品牌行:品牌 Times 衬线 + 品牌自动配色,型号无衬线,整体居中(开启品牌 logo 时 logo 在左并排)
        const tw1 = brandTotal(f1);
        const lw1 = brandMarkW(S, f1);
        const ls = Math.round(f1 * 0.15), gapT = Math.round(f1 * 0.3);
        g.font = brandFont(f1, 700);
        g.letterSpacing = 0;
        if (S.signBgBlur) { g.shadowColor = 'rgba(0,0,0,0.4)'; g.shadowBlur = 4; }
        const bw = g.measureText(brandTxt).width + ls * Math.max(0, brandTxt.length - 1);
        // mode2(仅Logo):品牌文字被 logo 替换,型号保留 → 块宽仍按品牌+型号原文计算,logo 居中于品牌词区域
        const onlyLogo = (S.brandLogo === 2 && lw1 > 0);
        const sx = cx2(w, tw1 + (onlyLogo ? 0 : lw1));
        g.textAlign = 'left';
        g.fillStyle = brandColor;
        const lw2 = onlyLogo ? drawBrandMark(g, S, logoCenterX(S, f1, sx, bw), y1, f1) : drawBrandMark(g, S, sx, y1, f1);
        if (!onlyLogo || !lw2) g.fillText(brandTxt, sx + lw2, y1);
        g.shadowBlur = 0;
        g.letterSpacing = 0;
        if (hasModel) {
            g.font = 'bold ' + f1 + "px 'Courier New', 'Courier New', monospace";
            g.letterSpacing = ls;
            g.fillStyle = textColor;
            g.fillText(modelTxt, sx + (onlyLogo ? (bw + gapT) : (lw2 + bw + gapT)), y1);
            g.letterSpacing = 0;
        }
        if (l2 && f2) {
            setFont(g, f2, true, false);
            const l2w = g.measureText(l2).width;
            drawTextL(g, l2, cx2(w, l2w), y1 + gap + m2.height, paramColor, f2, true, false, 0);
        }
        g.restore();
    }
    function styleCardPureLogo(img, size, g, iw, ih, S) {
        const pad = Math.max(32, size);
        const arc = Math.max(14, Math.floor(size / 3));
        const brand = brandHidden(S) ? '' : (prettyBrand(trim(S.cam.brand)) || 'PHOTO');
        let wf = Math.max(20, Math.min(96, Math.round(autoExifSize(S.paramFs, iw))));
        const maxBrandW = Math.max(80, iw - pad);
        while (wf > 9 && brandTextWidth(g, brand, wf, Math.max(1, Math.round(wf * 0.45))) > maxBrandW) wf--;
        const wm = {
            w: brandTextWidth(g, brand, wf, Math.max(1, Math.round(wf * 0.45))),
            height: wf,
            ascent: Math.round(wf * 0.78),
            maxDescent: Math.round(wf * 0.22)
        };
        const extra = Math.max(wm.height * 3, size);
        const w = iw + pad * 2, h = ih + pad + extra;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        drawCardSoftShadow(g, w, h, pad, pad, iw, ih, arc);
        g.drawImage(roundedPhoto(img, arc), pad, pad);
        const baseY = ih + pad + Math.floor((extra - wm.height) / 2) + wm.ascent;
        const lw = brandMarkW(S, wf);
        const onlyLogo = (S.brandLogo === 2 && lw > 0);
        const blockW = onlyLogo ? lw : wm.w + lw;
        const x0 = Math.round(w / 2 - blockW / 2);
        const lwUsed = drawBrandMark(g, S, x0, baseY, wf);
        if (!onlyLogo) drawTrackedBrandL(g, brand, w / 2, baseY, wf, brandInk(brand, false), 0.45, x0 + lwUsed);
    }
    function styleCardSimple(img, size, g, iw, ih, S) {
        const pad = Math.max(12, Math.floor(size / 2));
        const brand = brandHidden(S) ? '' : prettyBrand(trim(S.cam.brand));
        const rest = S.useExif ? exifLine(S.cam) : '';
        const line = S.useExif ? (brand ? (brand + ' · ' + rest) : rest) : brand;
        const maxLineW = Math.max(60, iw - pad * 3);
        let f = Math.max(12, autoExifSize(S.paramFs, iw));
        const sep = brand && rest ? ' · ' : '';
        const measureParts = () => ({
            brand: brandTextWidth(g, brand, f, 0),
            sep: sep ? textMetrics(g, sep, f, true, false, 0).w : 0,
            rest: rest ? textMetrics(g, rest, f, true, false, 0).w : 0
        });
        let parts = measureParts();
        while (f > 9 && parts.brand + parts.sep + parts.rest > maxLineW) {
            f--;
            parts = measureParts();
        }
        const fm = textMetrics(g, line, f, true, false, 0);
        const capH = Math.floor(fm.height * 5 / 3) + Math.max(6, Math.floor(pad / 4));
        const w = iw + pad * 2, h = ih + pad + capH + Math.max(10, Math.floor(pad / 2));
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        g.strokeStyle = 'rgb(230,230,230)'; g.lineWidth = 1;
        g.strokeRect(pad - 1, pad - 1, iw + 1, ih + 1);
        const baseY = ih + pad + Math.floor((capH + fm.ascent - fm.maxDescent) / 2);
        const lw = brandMarkW(S, f);
        const onlyLogo = (S.brandLogo === 2 && lw > 0);
        const brandWm = parts.brand;
        const sepW = parts.sep;
        const restW = parts.rest;
        const totalW = onlyLogo ? (brandWm + sepW + restW) : (brandWm + sepW + restW);
        const xStart = cx2(w, totalW + (onlyLogo ? 0 : lw));
        const lwUsed = drawBrandMark(g, S, onlyLogo ? logoCenterX(S, f, xStart, brandWm) : xStart, baseY, f);
        if (onlyLogo) {
            if (lwUsed) drawTextL(g, (sep + rest).trimStart(), xStart + brandWm, baseY, 'rgb(150,150,150)', f, true, false, 0);
        } else {
            const bx = xStart + lwUsed;
            if (brand) drawBrandText(g, brand, bx, baseY, f, brandInk(brand, false), 0);
            if (sep || rest) drawTextL(g, sep + rest, bx + brandWm, baseY, 'rgb(150,150,150)', f, true, false, 0);
        }
    }
    function styleCardImmersion(img, size, g, iw, ih, S) {
        const pad = Math.max(20, Math.floor(size * 2 / 5));
        const arc = Math.max(10, Math.floor(size / 4));
        const brand = brandHidden(S) ? '' : prettyBrand(trim(S.cam.brand));
        const rest = S.useExif ? exifLine(S.cam) : '';
        const line = S.useExif ? (brand ? (brand + '   ' + rest) : rest) : brand;
        const maxLineW = Math.max(60, iw - pad);
        let f = Math.max(12, autoExifSize(S.paramFs, iw));
        const sep = brand && rest ? '   ' : '';
        const measureParts = () => ({
            brand: brandTextWidth(g, brand, f, 0),
            sep: sep ? textMetrics(g, sep, f, true, false, 0).w : 0,
            rest: rest ? textMetrics(g, rest, f, true, false, 0).w : 0
        });
        let parts = measureParts();
        while (f > 9 && parts.brand + parts.sep + parts.rest > maxLineW) {
            f--;
            parts = measureParts();
        }
        const fm = textMetrics(g, line, f, true, false, 0);
        const bandH = fm.height * 2 + Math.max(10, Math.floor(pad / 2));
        const w = iw + pad * 2, h = ih + pad + bandH;
        g.fillStyle = 'rgb(17,17,17)'; g.fillRect(0, 0, w, h);
        g.drawImage(roundedPhoto(img, arc), pad, pad);
        const baseY = ih + pad + Math.floor((bandH + fm.ascent - fm.maxDescent) / 2);
        const lw = brandMarkW(S, f);
        const onlyLogo = (S.brandLogo === 2 && lw > 0);
        const brandWm = parts.brand, sepW = parts.sep, restW = parts.rest;
        const totalW = brandWm + sepW + restW;
        const xStart = cx2(w, totalW + (onlyLogo ? 0 : lw));
        const lwUsed = drawBrandMark(g, S, onlyLogo ? logoCenterX(S, f, xStart, brandWm) : xStart, baseY, f);
        if (onlyLogo) {
            if (lwUsed) drawTextL(g, (sep + rest).trimStart(), xStart + brandWm, baseY, 'rgb(185,185,185)', f, true, false, 0);
        } else {
            const bx = xStart + lwUsed;
            if (brand) drawBrandText(g, brand, bx, baseY, f, brandInk(brand, true), 0);
            if (sep || rest) drawTextL(g, sep + rest, bx + brandWm, baseY, 'rgb(185,185,185)', f, true, false, 0);
        }
    }
    function paintScrim(g, w, h, pos, band) {
        let grad;
        if (pos === 0) grad = g.createLinearGradient(0, 0, band, 0);
        else if (pos === 1) grad = g.createLinearGradient(w, 0, w - band, 0);
        else grad = g.createLinearGradient(0, h, 0, h - band);
        grad.addColorStop(0, 'rgba(0,0,0,0.431)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        if (pos === 0) g.fillRect(0, 0, band, h);
        else if (pos === 1) g.fillRect(w - band, 0, band, h);
        else g.fillRect(0, h - band, w, band);
    }
    // 背景模糊时给清晰照片加悬浮阴影,使照片与模糊底分离、看起来有厚度。
    // 两层:①环境阴影(四周均匀,零偏移)造出「一圈」包裹感;②主投影(向下偏移)定立体感。
    // 模糊半径/偏移随照片显示尺寸缩放(与 drawMainPhoto 同源公式),大图影子更宽更柔;
    // 圆角时先画圆角填充(阴影随填充渲染),再裁剪画照片;非模糊模式完全等低于原直绘。
    function drawLiftedPhoto(g, img, dx, dy, dw, dh, cr, blurOn) {
        g.save();
        if (blurOn) {
            const sb = Math.max(6, Math.round(Math.min(dw, dh) * 0.035));
            const so = Math.max(3, Math.round(sb * 0.8));
            g.fillStyle = '#ffffff';
            const path = () => { g.beginPath();
                if (cr > 0 && typeof g.roundRect === 'function') g.roundRect(dx, dy, dw, dh, cr);
                else g.rect(dx, dy, dw, dh); };
            // ①环境阴影:四边等量外扩,形成环绕照片的一圈暗边
            g.shadowColor = 'rgba(0,0,0,0.32)'; g.shadowBlur = sb * 1.1; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
            path(); g.fill();
            // ②主投影:向下偏移,压出悬浮感
            g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = sb * 1.5; g.shadowOffsetX = 0; g.shadowOffsetY = so * 1.5;
            path(); g.fill();
            g.shadowColor = 'transparent';
            g.shadowBlur = 0;
            g.shadowOffsetX = 0;
            g.shadowOffsetY = 0;
        }
        if (cr > 0 && typeof g.roundRect === 'function') { g.beginPath(); g.roundRect(dx, dy, dw, dh, cr); g.clip(); }
        g.drawImage(img, dx, dy, dw, dh);
        g.restore();
    }
    function styleOverlayParams(img, size, g, iw, ih, S, pos, cwO, chO) {
        // LEFT(pos=0): 白底+照片在右+左侧品牌名和参数
        if (pos === 0) {
            const pfScale = (S.paramFs != null && S.paramFs > 0) ? S.paramFs / 33 : 1;
            // 完全对齐印象毛玻璃布局,白底黑字(尺寸公式与 styleDims 一致,无 gm)
            const leftW = Math.max(180, Math.round(iw * 0.35));
            const topBotPad = Math.max(50, Math.round(size * 1.2));
            const natH = ih + topBotPad * 2;
            const h = natH;
            const oy = chO ? Math.max(0, Math.round((chO - natH) / 2)) : 0;
            // 背景:白底或模糊照片(50%模糊);背景必须铺满整个画布(styleDims 尺寸),否则最右侧会漏出透明缝
            if (S.signBgBlur) {
                const cw = g.canvas.width, ch = g.canvas.height;
                g.save();
                g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, cw, ch);
                g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.68)';
                const bs = Math.max(cw / iw, ch / ih);
                g.drawImage(img, (cw - iw * bs) / 2, (ch - ih * bs) / 2, iw * bs, ih * bs);
                g.filter = 'none';
                g.restore();
            } else {
                g.fillStyle = '#ffffff'; g.fillRect(0, 0, g.canvas.width, g.canvas.height);
            }
            // 照片严格垂直居中(用画布实际高度),支持缩放/偏移/圆角
            const px = leftW + 40;
            const py = Math.round((g.canvas.height / (g.getTransform().a || 1) - ih) / 2);
            const pscL = S.imgScale || 1;
            const pdwL = Math.round(iw * pscL), pdhL = Math.round(ih * pscL);
            const dpxL = px + Math.round((iw - pdwL) / 2) + (S.imgOffsetX || 0);
            const dpyL = py + Math.round((ih - pdhL) / 2) + (S.imgOffsetY || 0);
            const crL = S.cornerAll || 0;
            drawLiftedPhoto(g, img, dpxL, dpyL, pdwL, pdhL, crL, !!S.signBgBlur);
            // 左侧品牌+三行参数整体在"画布左缘→照片左缘(leftW+40)"空隙中水平居中
            g.save();
            g.translate(0, oy);
            const brand = brandHidden(S) ? '' : prettyBrand((S.cam && S.cam.brand) ? S.cam.brand : 'SONY');
            const fBrand = Math.max(22, Math.round(leftW * 0.14 * pfScale * (S.brandScale || 1)));
            const brandTrack = Math.round(fBrand * 0.15);
            const exifOn = S.useExif && S.cam;
            let boxW = 0, fVal = 0, valGap = 0, maxValW = 0, paramRows = [];
            if (exifOn) {
                const ps = S.paramScale || 1;
                boxW = Math.round(leftW * 0.28 * pfScale * ps);
                fVal = Math.max(13, Math.round(leftW * 0.08 * pfScale * ps));
                valGap = Math.round(leftW * 0.05 * ps);
                paramRows = [
                    { label: 'F', val: String(S.cam.aperture || '6.3').replace(/^f\//i, '').replace(/^F\//i, '') },
                    { label: 'ISO', val: String(S.cam.iso || '100').replace(/^iso/i, '') },
                    { label: 'S', val: String(S.cam.shutter || '1/125').replace(/s$/i, '') }
                ];
                let mv = 0;
                paramRows.forEach(row => { const w = textMetrics(g, row.val, fVal, false, true, 0).w; if (w > mv) mv = w; });
                maxValW = mv;
            }
            g.font = brandFont(fBrand, 700);
            g.letterSpacing = brandTrack;
            const brandW = g.measureText(brand).width;
            const markL = brandMarkW(S, fBrand);
            const onlyLogo = (S.brandLogo === 2 && markL > 0);
            // 品牌与参数解耦:各自按自身宽度在空隙中水平居中,调品牌大小只移动品牌,参数行保持原水平位置
            const txB = Math.max(0, Math.round((leftW + 40 - (onlyLogo ? brandMarkNetW(S, fBrand) : (brandW + markL))) / 2));
            const txP = Math.max(0, Math.round((leftW + 40 - (exifOn ? boxW + valGap + maxValW : 0)) / 2));
            g.fillStyle = brandInk(brand, !!S.signBgBlur);
            g.textAlign = 'left'; g.textBaseline = 'alphabetic';
            if (onlyLogo) {
                const used = drawBrandMark(g, S, logoCenterX(S, fBrand, txB, brandTextWidth(g, brand, fBrand, brandTrack)), Math.round(h * 0.28), fBrand);
                if (!used) g.fillText(brand, txB, Math.round(h * 0.28));
            } else {
                const markLUsed = drawBrandMark(g, S, txB, Math.round(h * 0.28), fBrand);
                g.fillText(brand, txB + markLUsed, Math.round(h * 0.28));
            }
            // 三行参数(和毛玻璃一致),锚定 txP,不受品牌大小影响
            if (exifOn) {
                const boxH = Math.round(boxW * 0.55);
                const fBox = Math.max(11, Math.round(boxH * 0.45));
                let ry = Math.round(h * 0.48);
                const boxColorL = S.signBgBlur ? '#ffffff' : '#333333';
                paramRows.forEach(row => {
                    g.strokeStyle = boxColorL;
                    g.lineWidth = Math.max(1.5, Math.round(boxH * 0.08));
                    g.beginPath();
                    if (typeof g.roundRect === 'function') g.roundRect(txP, ry - boxH, boxW, boxH, Math.round(boxH * 0.2));
                    else g.rect(txP, ry - boxH, boxW, boxH);
                    g.stroke();
                    g.fillStyle = boxColorL;
                    g.font = 'bold ' + fBox + 'px sans-serif';
                    g.textAlign = 'center'; g.textBaseline = 'middle';
                    g.fillText(row.label, txP + boxW / 2, ry - boxH / 2);
                    g.font = 'bold ' + fVal + 'px sans-serif';
                    g.textAlign = 'left';
                    g.fillText(row.val, txP + boxW + valGap, ry - boxH / 2);
                    ry += Math.round(boxH * 1.9);
                });
            }
            g.restore();
            return;
        }
        // BOTTOM(pos=2): 白底+照片在上+底部品牌名和参数
        if (pos === 2) {
            const gm = Math.min(1.1, S.globalMargin || 1);
            const pfScale = (S.paramFs != null && S.paramFs > 0) ? S.paramFs / 33 : 1;
            const bottomH = Math.max(120, Math.round(ih * 0.25 * gm));
            const sidePad = Math.max(30, Math.round(size * 0.8 * gm));
            const natW = iw + sidePad * 2, natH = ih + bottomH + sidePad;
            const cw2 = cwO || natW, ch2 = chO || natH;
            const ox = Math.max(0, Math.round((cw2 - natW) / 2));
            const oy = Math.max(0, Math.round((ch2 - natH) / 2));
const w = natW;
            // 背景:白底或模糊照片(80%模糊)
            if (S.signBgBlur) {
                g.save();
                g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, cw2, ch2);
                g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.68)';
                const bs = Math.max(cw2 / iw, ch2 / ih);
                g.drawImage(img, (cw2 - iw * bs) / 2, (ch2 - ih * bs) / 2, iw * bs, ih * bs);
                g.filter = 'none';
                g.restore();
            } else {
                g.fillStyle = '#ffffff'; g.fillRect(0, 0, cw2, ch2);
            }
            g.save();
            g.translate(ox, oy);
            const px = Math.round((w - iw) / 2);
            const py = sidePad;
            const pscB = S.imgScale || 1;
            const pdwB = Math.round(iw * pscB), pdhB = Math.round(ih * pscB);
            const dpxB = px + Math.round((iw - pdwB) / 2) + (S.imgOffsetX || 0);
            const dpyB = py + Math.round((ih - pdhB) / 2) + (S.imgOffsetY || 0);
            const crB = S.cornerAll || 0;
            drawLiftedPhoto(g, img, dpxB, dpyB, pdwB, pdhB, crB, !!S.signBgBlur);
            const by = py + ih + Math.round(bottomH * 0.3);
            const brand = brandHidden(S) ? '' : prettyBrand((S.cam && S.cam.brand) ? S.cam.brand : 'SONY');
            const fBrand = Math.max(18, Math.round(bottomH * 0.2 * pfScale * (S.brandScale || 1)));
            g.fillStyle = brandInk(brand, !!S.signBgBlur);
            g.font = brandFont(fBrand, 700);
            const markB = brandMarkW(S, fBrand);
            g.textAlign = 'center'; g.textBaseline = 'alphabetic';
            const onlyLogoB = (S.brandLogo === 2);
            if (!S.brandLogo) {
                g.fillText(brand, w / 2, by);
            } else {
                const bw = onlyLogoB ? 0 : g.measureText(brand).width;
                const bx0 = Math.round(w / 2 - (bw + (onlyLogoB ? brandMarkNetW(S, fBrand) : markB)) / 2);
                g.textAlign = 'left';
                const markLUsed = drawBrandMark(g, S, bx0, by, fBrand);
                if (!onlyLogoB || !markLUsed) g.fillText(brand, bx0 + markLUsed, by);
                g.textAlign = 'left';
            }
            if (S.useExif && S.cam) {
                const boxW = Math.round(Math.max(280, Math.min(w * 0.35, 440)) * pfScale * (S.paramScale || 1));
                const boxH = Math.round(boxW * 0.55);
                const fBox = Math.max(11, Math.round(boxH * 0.45));
                const fVal = Math.max(14, Math.round(boxH * 0.6));
                const rows = [
                    { label: 'F', val: String(S.cam.aperture || '6.3').replace(/^f\//i, '').replace(/^F\//i, '') },
                    { label: 'ISO', val: String(S.cam.iso || '100').replace(/^iso/i, '') },
                    { label: 'S', val: String(S.cam.shutter || '1/125').replace(/s$/i, '') }
                ];
                const valGap = Math.round(boxW * 0.3);
                const estValW = Math.round(boxW * 0.9);
                const itemW = boxW + valGap + estValW;
                const between = Math.round(itemW * 0.5);
                const totalW = rows.length * itemW + (rows.length - 1) * between;
                let bx = Math.round((w - totalW) / 2);
                const ry = by + Math.round(bottomH * 0.4);
                const boxColor = S.signBgBlur ? '#ffffff' : '#333333';
                rows.forEach(row => {
                    g.strokeStyle = boxColor;
                    g.lineWidth = Math.max(1.5, Math.round(boxH * 0.08));
                    g.beginPath();
                    if (typeof g.roundRect === 'function') g.roundRect(bx, ry - boxH, boxW, boxH, Math.round(boxH * 0.2));
                    else g.rect(bx, ry - boxH, boxW, boxH);
                    g.stroke();
                    g.fillStyle = boxColor;
                    g.font = 'bold ' + fBox + 'px sans-serif';
                    g.textAlign = 'center'; g.textBaseline = 'middle';
                    g.fillText(row.label, bx + boxW / 2, ry - boxH / 2);
                    g.font = 'bold ' + fVal + 'px sans-serif';
                    g.textAlign = 'left';
                    g.fillText(row.val, bx + boxW + valGap, ry - boxH / 2);
                    bx += itemW + between;
                });
            }
            g.restore();
            return;
        }
        // RIGHT(pos=1): 白底+照片在左+右侧品牌名和参数(印象右留白)
        if (pos === 1) {
            const pfScale = (S.paramFs != null && S.paramFs > 0) ? S.paramFs / 33 : 1;
            // 完全对齐印象毛玻璃镜像版,白底黑字(尺寸公式与 styleDims 一致,无 gm)
            const rightW = Math.max(180, Math.round(iw * 0.35));
            const leftPad = Math.round(rightW / 2);
            const topBotPad = Math.max(50, Math.round(size * 1.2));
            const natH = ih + topBotPad * 2;
            const h = natH;
            const oy = chO ? Math.max(0, Math.round((chO - natH) / 2)) : 0;
            // 背景:白底或模糊照片(50%模糊);背景必须铺满整个画布(styleDims 尺寸),否则最右侧会漏出透明缝
            if (S.signBgBlur) {
                const cw = g.canvas.width, ch = g.canvas.height;
                g.save();
                g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, cw, ch);
                g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.68)';
                const bs = Math.max(cw / iw, ch / ih);
                g.drawImage(img, (cw - iw * bs) / 2, (ch - ih * bs) / 2, iw * bs, ih * bs);
                g.filter = 'none';
                g.restore();
            } else {
                g.fillStyle = '#ffffff'; g.fillRect(0, 0, g.canvas.width, g.canvas.height);
            }
            // 照片严格垂直居中(用画布实际高度),支持缩放/偏移/圆角
            // 以左留白为基准做严格镜像:照片左缘距画布左边 = leftPad(=round(rightW/2)),
            // 与左留白照片右缘距画布右边(leftW/2)对称,右侧栏从照片右缘+40 起排
            const px = leftPad;
            const py = Math.round((g.canvas.height / (g.getTransform().a || 1) - ih) / 2);
            const pscR = S.imgScale || 1;
            const pdwR = Math.round(iw * pscR), pdhR = Math.round(ih * pscR);
            const dpxR = px + Math.round((iw - pdwR) / 2) + (S.imgOffsetX || 0);
            const dpyR = py + Math.round((ih - pdhR) / 2) + (S.imgOffsetY || 0);
            const crR = S.cornerAll || 0;
            drawLiftedPhoto(g, img, dpxR, dpyR, pdwR, pdhR, crR, !!S.signBgBlur);
            // 右侧品牌+三行参数整体在"照片右缘→画布右缘(rightW+40)"空隙中水平居中(与左留白镜像)
            g.save();
            g.translate(0, oy);
            const brand = brandHidden(S) ? '' : prettyBrand((S.cam && S.cam.brand) ? S.cam.brand : 'SONY');
            const fBrand = Math.max(22, Math.round(rightW * 0.14 * pfScale * (S.brandScale || 1)));
            const brandTrack = Math.round(fBrand * 0.15);
            const exifOn = S.useExif && S.cam;
            let boxW = 0, fVal = 0, valGap = 0, maxValW = 0, paramRows = [];
            if (exifOn) {
                const ps = S.paramScale || 1;
                boxW = Math.round(rightW * 0.28 * pfScale * ps);
                fVal = Math.max(13, Math.round(rightW * 0.08 * pfScale * ps));
                valGap = Math.round(rightW * 0.03 * ps);
                paramRows = [
                    { label: 'F', val: String(S.cam.aperture || '6.3').replace(/^f\//i, '').replace(/^F\//i, '') },
                    { label: 'ISO', val: String(S.cam.iso || '100').replace(/^iso/i, '') },
                    { label: 'S', val: String(S.cam.shutter || '1/125').replace(/s$/i, '') }
                ];
                let mv = 0;
                paramRows.forEach(row => { const w = textMetrics(g, row.val, fVal, false, true, 0).w; if (w > mv) mv = w; });
                maxValW = mv;
            }
            g.font = brandFont(fBrand, 700);
            g.letterSpacing = brandTrack;
            const brandW = g.measureText(brand).width;
            const markR = brandMarkW(S, fBrand);
            const onlyLogo = (S.brandLogo === 2);
            // 品牌与参数解耦:各自按自身宽度在右侧空隙中水平居中,调品牌大小只移动品牌,参数行保持原水平位置
            const gapW = rightW;
            const startXB = px + iw + Math.round((gapW - (onlyLogo ? brandMarkNetW(S, fBrand) : (brandW + markR))) / 2);
            const startXP = px + iw + Math.round((gapW - (exifOn ? boxW + valGap + maxValW : 0)) / 2);
            g.fillStyle = brandInk(brand, !!S.signBgBlur);
            g.textAlign = 'left';
            g.textBaseline = 'alphabetic';
            const markRUsed = drawBrandMark(g, S, startXB, Math.round(h * 0.28), fBrand);
            if (!onlyLogo || !markRUsed) g.fillText(brand, startXB + markRUsed, Math.round(h * 0.28));
            // 三行参数(和左留白镜像),锚定 startXP,不受品牌大小影响
            if (exifOn) {
                const boxH = Math.round(boxW * 0.55);
                const fBox = Math.max(11, Math.round(boxH * 0.45));
                let ry = Math.round(h * 0.48);
                const boxColorR = S.signBgBlur ? '#ffffff' : '#333333';
                paramRows.forEach(row => {
                    g.strokeStyle = boxColorR;
                    g.lineWidth = Math.max(1.5, Math.round(boxH * 0.08));
                    g.beginPath();
                    if (typeof g.roundRect === 'function') g.roundRect(startXP, ry - boxH, boxW, boxH, Math.round(boxH * 0.2));
                    else g.rect(startXP, ry - boxH, boxW, boxH);
                    g.stroke();
                    g.fillStyle = boxColorR;
                    g.font = 'bold ' + fBox + 'px sans-serif';
                    g.textAlign = 'center'; g.textBaseline = 'middle';
                    g.fillText(row.label, startXP + boxW / 2, ry - boxH / 2);
                    g.font = 'bold ' + fVal + 'px sans-serif';
                    g.textAlign = 'left';
                    g.fillText(row.val, startXP + boxW + valGap, ry - boxH / 2);
                    ry += Math.round(boxH * 1.9);
                });
            }
            g.restore();
            return;
        }
        // LEFT/BOTTOM 分支保持原样
        const inset = Math.max(12, Math.floor(size / 2));
        const brand = brandHidden(S) ? '' : trim(S.cam.brand), model = brandHidden(S) ? '' : (S.cam.model || '');
        const vertical = pos !== 2;
        let line = vertical ? (brand + ' ' + model).trim() : ((brand + ' ' + model).trim() + '   ' + exifLine(S.cam)).trim();
        if (!line && !brandHidden(S)) line = 'PHOTO';
        const along = vertical ? ih : iw;
        const f = fitFont(g, line, true, false, Math.max(12, Math.min(autoExifSize(S.paramFs, iw), Math.floor(along / 10))), Math.max(60, along - inset * 2), 0);
        const fm = textMetrics(g, line, f, true, false, 0);
        g.drawImage(img, 0, 0);
        paintScrim(g, iw, ih, pos, fm.height * 2 + inset);
        const textC = 'rgba(255,255,255,0.922)';
        if (vertical) {
            const ax = pos === 0 ? inset + fm.ascent : iw - inset - fm.ascent;
            const ay = pos === 0 ? ih - inset : inset;
            g.save();
            g.translate(ax, ay);
            g.rotate(pos === 0 ? -Math.PI / 2 : Math.PI / 2);
            drawShadowTextL(g, line, 0, 0, f, textC, true, false, 0);
            g.restore();
        } else {
            drawShadowTextL(g, line, cx2(iw, fm.w), ih - inset - fm.maxDescent, f, textC, true, false, 0);
        }
    }
    function styleOverlayLogo(img, size, g, iw, ih, S) {
        const inset = Math.max(14, Math.floor(size * 2 / 5));
        let brand = prettyBrand(trim(S.cam.brand));
        if (!brand) brand = 'PHOTO';
        if (brandHidden(S)) brand = '';
        let fs = Math.max(16, Math.min(96, Math.round(autoExifSize(S.paramFs, iw))));
        let track = 1, tw = 0;
        for (; fs > 10; fs--) {
            track = Math.max(1, Math.round(fs * 0.45));
            tw = brandTextWidth(g, brand, fs, track);
            if (tw <= iw - inset * 2) break;
        }
        track = Math.max(1, Math.round(fs * 0.45));
        const wm = { w: brandTextWidth(g, brand, fs, track), height: fs, ascent: Math.round(fs * 0.78), maxDescent: Math.round(fs * 0.22) };
        tw = wm.w;
        g.drawImage(img, 0, 0);
        paintScrim(g, iw, ih, 2, wm.height * 3 + inset);
        const baseY = ih - inset - wm.maxDescent;
        const lw = brandMarkW(S, fs);
        const onlyLogo = (S.brandLogo === 2 && lw > 0);
        const x = cx2(iw, onlyLogo ? brandMarkNetW(S, fs) : (tw + lw));
        const lwUsed = drawBrandMark(g, S, x, baseY, fs);
        const toff = Math.max(1, Math.floor(fs / 24));
        if (!onlyLogo) {
            g.save();
            g.font = brandFont(fs, 700);
            g.letterSpacing = track;
            g.textAlign = 'left';
            g.textBaseline = 'alphabetic';
            g.fillStyle = 'rgba(0,0,0,0.588)';
            g.fillText(brand, x + lwUsed + toff, baseY + toff);
            g.fillStyle = brandInk(brand, true);
            g.fillText(brand, x + lwUsed, baseY);
            g.restore();
        }
    }
    function extractMultipleDominant(img, n) {
        const key = imgKey(img) + ':multi:' + n;
        if (_multiCache[key]) return _multiCache[key].slice();
        const iw = Math.max(1, img.naturalWidth || 1), ih = Math.max(1, img.naturalHeight || 1);
        const sw = Math.min(48, iw);
        const sh = Math.max(1, Math.floor(sw * ih / iw));
        // smallImageCached 已按最小边 48 绘制缩略图,直接取数据,不必重复 drawImage
        const sg = smallImageCached(img, 48).g;
        const { data } = sg.getImageData(0, 0, sw, sh);
        const bins = 12;
        const map = {};
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
            const i = (y * sw + x) * 4;
            const ri = Math.floor(data[i] * bins / 256), gi = Math.floor(data[i + 1] * bins / 256), bi = Math.floor(data[i + 2] * bins / 256);
            const key = ri + ',' + gi + ',' + bi;
            map[key] = (map[key] || 0) + 1;
        }
        const keys = Object.keys(map).sort((a, k) => map[k] - map[a]);
        const rnd = javaRandom(42);
        const out = [];
        for (let i = 0; i < n; i++) {
            if (i < keys.length) {
                const p = keys[i].split(',').map(Number);
                out.push('rgb(' + Math.min(255, Math.floor(p[0] * 256 / bins + 8)) + ',' + Math.min(255, Math.floor(p[1] * 256 / bins + 8)) + ',' + Math.min(255, Math.floor(p[2] * 256 / bins + 8)) + ')');
            } else {
                out.push('rgb(' + (50 + rnd(180)) + ',' + (50 + rnd(180)) + ',' + (50 + rnd(180)) + ')');
            }
        }
        _multiCache[key] = out.slice();
        return out;
    }
    function styleColorClassic(img, size, g, iw, ih, S) {
        const fs = Math.max(10, Math.round(autoExifSize(S.paramFs, iw)));
        const barH = Math.max(40, size, Math.round(fs * 5 / 3)), pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const cols = extractMultipleDominant(img, 5);
        const swatchH = barH, swW = Math.floor(w / cols.length);
        for (let i = 0; i < cols.length; i++) { g.fillStyle = cols[i]; g.fillRect(i * swW, barY, swW, swatchH); }
        const brandTxt = brandHidden(S) ? '' : prettyBrand(S.cam.brand);
        const modelTxt = brandHidden(S) ? '' : String(S.cam.model || '');
        const onlyLogoClr = (S.brandLogo === 2 && brandMarkW(S, fs) > 0);
        g.fillStyle = '#ffffff';
        g.font = brandFont(fs, 700);
        const lblY = barY + Math.floor(barH / 2) + Math.floor(fs / 3);
        const clrBrandW = brandTextWidth(g, brandTxt, fs, 0);
        const gap = Math.round(fs * 0.45);
        const drawBrandAt = (x) => {
            if (!brandTxt) return;
            g.save();
            g.font = brandFont(fs, 700);
            g.letterSpacing = '0px';
            g.textAlign = 'left';
            g.textBaseline = 'alphabetic';
            g.shadowColor = 'rgba(0,0,0,0.45)';
            g.shadowBlur = Math.max(2, Math.round(fs * 0.18));
            g.fillStyle = brandInk(S.cam.brand, true);
            g.fillText(brandTxt, x, lblY);
            g.restore();
        };
        if (onlyLogoClr) {
            const used = drawBrandMark(g, S, logoCenterX(S, fs, 12, clrBrandW), lblY, fs);
            if (!used) {
                drawBrandAt(12);
                if (modelTxt) drawTextL(g, modelTxt, 12 + clrBrandW + gap, lblY, '#ffffff', fs, true, true, 0);
            } else if (modelTxt) {
                drawTextL(g, modelTxt, 12 + clrBrandW + gap, lblY, '#ffffff', fs, true, true, 0);
            }
        } else {
            const lwClr = drawBrandMark(g, S, 12, lblY, fs);
            const bx = 12 + lwClr;
            drawBrandAt(bx);
            if (modelTxt) drawTextL(g, modelTxt, bx + clrBrandW + (brandTxt ? gap : 0), lblY, '#ffffff', fs, true, true, 0);
        }
    }
    function styleColorRefined(img, size, g, iw, ih, S) {
        const barH = Math.max(50, Math.floor(size * 4 / 3)), pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = 'rgb(245,245,245)'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const cols = extractMultipleDominant(img, 5);
        const swatchH = Math.floor(barH * 3 / 5), swW = Math.floor(w / cols.length);
        for (let i = 0; i < cols.length; i++) { g.fillStyle = cols[i]; g.fillRect(i * swW, barY, swW, swatchH); }
        const f = autoExifSize(S.paramFs, iw);
        const line = S.cam.focal + '  ' + S.cam.aperture + '  ' + S.cam.iso + '  ' + S.cam.shutter;
        const fm = textMetrics(g, line, f, true, false, 0);
        drawTextL(g, line, 12, barY + swatchH + Math.floor((barH - swatchH + fm.ascent) / 2), 'rgb(60,60,60)', f, true, false, 0);
    }
    // ══ 艺术卡:画廊色彩卡 ══
    // 暖纸底 + 装裱照片 + 照片取色的色卡条 + 衬线品牌行 + 等宽 EXIF 行。
    // 几何由 artCardGeom 统一给出,styleDims 与绘制共用,避免旧版「画布按两行文字算、
    // 实际只画一条色带」导致品牌行被裁掉的问题。
    function artCardGeom(iw, ih, size, S) {
        const fs = Math.max(11, Math.round(autoExifSize((S && S.paramFs != null) ? S.paramFs : 12, iw)));
        const fs2 = Math.max(9, Math.round(fs * 0.62));
        const minSide = Math.min(iw, ih);
        const padX = Math.min(Math.max(18, Math.round(size * 0.55)), Math.round(minSide * 0.09));
        const padTop = padX;
        const barTop = padTop + ih;
        const ruleY = barTop + Math.round(fs * 1.15);
        const brandBase = ruleY + Math.round(fs * 1.05);
        const exifBase = brandBase + Math.round(fs2 * 1.9);
        const h = exifBase + Math.round(fs2 * 1.5);
        return { fs, fs2, padX, padTop, barTop, ruleY, brandBase, exifBase, w: iw + padX * 2, h };
    }

    function _artLuma(color) {
        let r = 0, g = 0, b = 0;
        const s = String(color || '');
        const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
        if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
        else {
            const m = /^#?([0-9a-f]{6})$/i.exec(s);
            if (!m) return 0;
            const v = parseInt(m[1], 16);
            r = (v >> 16) & 255; g = (v >> 8) & 255; b = v & 255;
        }
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function styleArtCard(img, size, g, iw, ih, S) {
        const G = artCardGeom(iw, ih, size, S);
        const { fs, fs2, padX, padTop, w, h, ruleY, brandBase, exifBase } = G;

        // 暖纸底:极轻的纵向渐变,避免纯白显得像未上色的模板
        const paper = g.createLinearGradient(0, 0, 0, h);
        paper.addColorStop(0, '#fbf8f2');
        paper.addColorStop(1, '#f2ece1');
        g.fillStyle = paper;
        g.fillRect(0, 0, w, h);

        // 照片装裱:白色卡纸 + 柔和投影 + 细描边
        const mat = Math.max(6, Math.round(fs * 0.32));
        const mx = padX - mat, my = padTop - mat;
        g.save();
        g.shadowColor = 'rgba(50,40,25,0.18)';
        g.shadowBlur = Math.max(8, Math.round(fs * 0.55));
        g.shadowOffsetY = Math.max(3, Math.round(fs * 0.18));
        g.fillStyle = '#fffdf8';
        g.fillRect(mx, my, iw + mat * 2, ih + mat * 2);
        g.restore();
        g.drawImage(img, padX, padTop, iw, ih);
        const keyW = Math.max(1, Math.round(fs * 0.03));
        g.strokeStyle = 'rgba(80,65,45,0.22)';
        g.lineWidth = keyW;
        g.strokeRect(mx + keyW / 2, my + keyW / 2, iw + mat * 2 - keyW, ih + mat * 2 - keyW);

        // 分隔线:细、低对比,像画廊标签的横线
        const lineH = Math.max(1, Math.round(fs * 0.035));
        g.fillStyle = 'rgba(70,58,40,0.26)';
        g.fillRect(padX, ruleY, iw, lineH);

        // 照片取色色卡:按明度排序,浅→深,像一张配色研究卡
        let pal = [];
        try {
            pal = extractMultipleDominant(img, 5).slice(0, 5)
                .sort((a, b) => _artLuma(a) - _artLuma(b));
        } catch (e) {
            pal = ['#3a3a3a', '#6b6b6b', '#9a9a9a', '#c4c4c4', '#e2e2e2'];
        }
        const chip = Math.max(8, Math.round(fs * 0.95));
        const chipGap = Math.max(4, Math.round(fs * 0.30));
        const chipsW = pal.length * chip + Math.max(0, pal.length - 1) * chipGap;
        const chipY = brandBase - chip;
        const chipsX = w - padX - chipsW;
        let chipX = chipsX;
        for (let i = 0; i < pal.length; i++) {
            const r = Math.max(1, Math.round(chip * 0.12));
            g.beginPath();
            if (g.roundRect) g.roundRect(chipX, chipY, chip, chip, r);
            else g.rect(chipX, chipY, chip, chip);
            g.fillStyle = pal[i];
            g.fill();
            g.strokeStyle = 'rgba(40,30,20,0.18)';
            g.lineWidth = Math.max(1, Math.round(chip * 0.035));
            g.stroke();
            chipX += chip + chipGap;
        }

        // 品牌行:Times 衬线 + 品牌自动配色;有 logo 时按既有 1/2/3 语义处理
        if (!brandHidden(S)) {
            const brand = String((S.cam && S.cam.brand) || '').trim();
            const brandLabel = prettyBrand(brand);
            const model = String((S.cam && S.cam.model) || '').trim();
            let label = brandLabel ? (model ? brandLabel + '  ' + model : brandLabel) : model;
            const onlyLogo = (S.brandLogo === 2 && brandMarkW(S, fs) > 0);
            if (onlyLogo) label = model;

            const modelColor = 'rgba(38,33,26,0.92)';
            const track = ratio => Math.round(fs * ratio) + 'px';
            const measure = (text, px) => {
                if (!text) return 0;
                g.save();
                g.font = brandFont(px, 700);
                g.letterSpacing = track(0.08);
                const tw = g.measureText(text).width;
                g.restore();
                return tw;
            };
            const logoW0 = brandMarkW(S, fs);
            const maxBrandW = Math.max(0, chipsX - chipGap * 2 - padX - logoW0);
            let fsBrand = Math.round(fs * 1.15);
            let tw = measure(label, fsBrand);
            if (tw > maxBrandW && tw > 0) {
                fsBrand = Math.max(Math.round(fs * 0.72), Math.floor(fsBrand * maxBrandW / tw));
                tw = measure(label, fsBrand);
            }
            if (tw > maxBrandW && label) {
                const chars = Array.from(label);
                while (chars.length > 1 && measure(chars.join('') + '…', fsBrand) > maxBrandW) chars.pop();
                label = chars.join('') + '…';
            }

            let tx = padX;
            if (brandMarkW(S, fsBrand) > 0) {
                tx += drawBrandMark(g, S, padX, brandBase, fsBrand);
            }
            if (label) {
                g.save();
                g.font = brandFont(fsBrand, 700);
                g.letterSpacing = track(0.08);
                g.fillStyle = brandInk(brand, false);
                g.textAlign = 'left';
                g.textBaseline = 'alphabetic';
                const brandPart = onlyLogo ? '' : label.slice(0, Math.min(label.length, brandLabel.length));
                if (brandPart) {
                    g.fillText(brandPart, tx, brandBase);
                    tx += g.measureText(brandPart).width;
                }
                const rest = label.slice(brandPart.length);
                if (rest) {
                    g.fillStyle = modelColor;
                    g.fillText(rest, tx, brandBase);
                }
                g.letterSpacing = '0px';
                g.restore();
            }
        }

        // EXIF 行:跟随全局参数类型(0=完整 / 1=焦段光圈 / 2=日期),等宽、灰色、字距略开。
        // 无相机信息时不画,避免 buildParamString 对空快门补出孤零零的 "s"。
        const cam = S.cam || {};
        const hasCam = ['focal', 'aperture', 'shutter', 'iso'].some(k => String(cam[k] || '').trim());
        const exif = (S.paramType === 2 || hasCam)
            ? String(buildParamString(cam, S.paramType != null ? S.paramType : 0) || '').trim()
            : '';
        g.save();
        g.font = fs2 + "px Consolas, 'Courier New', monospace";
        g.textBaseline = 'alphabetic';
        g.textAlign = 'left';
        g.letterSpacing = Math.round(fs2 * 0.08) + 'px';
        g.fillStyle = 'rgba(70,60,45,0.62)';
        if (exif) g.fillText(exif, padX, exifBase);
        const exifW = exif ? g.measureText(exif).width : 0;
        const mark = 'ART CARD';
        const markW = g.measureText(mark).width;
        if (exifW + markW + fs2 * 2 < iw) {
            g.textAlign = 'right';
            g.fillStyle = 'rgba(70,60,45,0.38)';
            g.fillText(mark, w - padX, exifBase);
        }
        g.letterSpacing = '0px';
        g.restore();
    }
    function styleFujiWhite(img, size, g, iw, ih, S) {
        const pad = Math.max(12, Math.round(iw * 0.02));
        const fs = Math.max(11, Math.round(autoExifSize(S.paramFs, iw)));
        const f2 = Math.round(fs * 0.85);
        const lineGap = Math.round(fs * 0.6);
        // 两行总高度 + 上下留白
        const totalTextH = fs + lineGap + f2;
        const padBottom = Math.round(fs * 0.6);
        const barH = totalTextH + padBottom * 2;
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        // 文字在barH内垂直居中
        const barY = ih + pad;
        const startY = barY + padBottom;
        // 品牌名跟着 EXIF 走(原先写死 FUJIFILM,佳能/尼康照片会印成 "FUJIFILM EOS R5")
        const brand = prettyBrand(String((S.cam && S.cam.brand) || 'FUJIFILM')) || 'FUJIFILM';
        const model = String((S.cam && S.cam.model) || '').trim();
        const line1 = brandHidden(S) ? '' : (model ? brand + ' ' + model : brand);
        // 品牌行字体:Times New Roman 衬线 + 拉开字距;品牌词走自动品牌色,型号保持深灰。
        const fBrandLine = 'bold ' + fs + "px 'Times New Roman', Cambria, serif";
        const brandTrack = Math.round(fs * 0.12);
        const measureBrand = (s) => {
            if (!s) return 0;
            g.save();
            g.font = fBrandLine; g.letterSpacing = brandTrack + 'px';
            const bw = g.measureText(s).width;
            g.restore();
            return bw;
        };
        const drawBrandLine = (s, x, y, color) => {
            if (!s) return;
            g.save();
            g.font = fBrandLine; g.letterSpacing = brandTrack + 'px';
            g.fillStyle = color || 'rgb(40,40,40)';
            g.textAlign = 'left'; g.textBaseline = 'alphabetic';
            g.fillText(s, x, y);
            g.letterSpacing = '0px';
            g.restore();
        };
        const m1w = measureBrand(line1);
        const lwFw = brandMarkW(S, fs);
        const onlyLogoFw = (S.brandLogo === 2 && lwFw > 0);
        const fwBrandW = measureBrand(brand + ' ');
        const brandColor = brandInk(brand, false);
        if (onlyLogoFw) {
            const x1 = cx2(w, m1w);
            const used = drawBrandMark(g, S, logoCenterX(S, fs, x1, fwBrandW), startY + fs, fs);
            if (!used) {
                drawBrandLine(brand, x1, startY + fs, brandColor);
                drawBrandLine(model, x1 + fwBrandW, startY + fs, 'rgb(40,40,40)');
            } else {
                drawBrandLine(model, x1 + fwBrandW, startY + fs, 'rgb(40,40,40)');
            }
        } else {
            const xLine = cx2(w, m1w + lwFw);
            const lwFwUsed = drawBrandMark(g, S, xLine, startY + fs, fs);
            drawBrandLine(brand, xLine + lwFwUsed, startY + fs, brandColor);
            drawBrandLine(model, xLine + lwFwUsed + fwBrandW, startY + fs, 'rgb(40,40,40)');
        }
        const line2 = S.cam.focal + '  ' + S.cam.aperture + '  ' + S.cam.iso + '  ' + S.cam.shutter;
        const m2 = textMetrics(g, line2, f2, true, false, 0);
        drawTextL(g, line2, cx2(w, m2.w), startY + fs + lineGap + f2, 'rgb(120,120,120)', f2, true, false, 0);
    }
    function styleSimpleFilm(img, size, g, iw, ih, S) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const f = autoExifSize(S.paramFs, iw);
        const info = S.cam.focal + '  ' + S.cam.aperture;
        const fm = textMetrics(g, info, f, true, false, 0);
        drawTextL(g, info, size + Math.floor((iw - fm.w) / 2), h - Math.floor(size / 2), 'rgb(140,140,140)', f, true, false, 0);
    }
    function styleParamTopLeft(img, size, g, iw, ih, S) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const fs = Math.max(9, Math.floor(size / 4));
        const f = autoExifSize(S.paramFs, iw);
        const line = S.cam.focal + '  ' + S.cam.aperture + '  ' + S.cam.iso + '  ' + S.cam.shutter;
        drawTextL(g, line, size + 8, size + fs + 4, 'rgb(100,100,100)', f, true, false, 0);
    }
    function styleParamBottomLeft(img, size, g, iw, ih, S) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const f = autoExifSize(S.paramFs, iw);
        const brand = brandHidden(S) ? '' : prettyBrand(S.cam.brand);
        const rest = ' ' + S.cam.model + '  |  ' + S.cam.focal + '  ' + S.cam.aperture + '  ' + S.cam.iso + '  ' + S.cam.shutter;
        const brandW = brandTextWidth(g, brand, f, 0);
        if (brand) {
            g.save();
            g.font = brandFont(f, 700);
            g.fillStyle = brandInk(brand, false);
            g.textAlign = 'left';
            g.textBaseline = 'alphabetic';
            g.fillText(brand, size + 8, h - size - 4);
            g.restore();
        }
        drawTextL(g, rest, size + 8 + brandW, h - size - 4, 'rgb(100,100,100)', f, true, false, 0);
    }
    function styleParamBottomSingle(img, size, g, iw, ih, S) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const f = autoExifSize(S.paramFs, iw);
        const info = S.cam.focal + '  ' + S.cam.aperture;
        const fm = textMetrics(g, info, f, true, false, 0);
        drawTextL(g, info, cx2(w, fm.w), h - Math.floor(size / 2), 'rgb(140,140,140)', f, true, false, 0);
    }
    // 未实现/未知风格:中性底 + 风格名(占位)
    // 注意这里有三条路径会走到:①导入的模板 photoFrameStyle 写错或来自更新版本
    // ②导出模板在旧版本打开 ③引擎新增风格但忘了注册进 draw 映射表。
    // 因此除了画占位图,还要在控制台留一条可诊断的线索——否则用户只看到灰底,
    // 无法区分「风格不支持」和「照片/程序坏了」。
    function stylePlaceholder(img, name, g, iw, ih) {
        g.fillStyle = '#f0f0f0';
        g.fillRect(0, 0, iw + 60, ih + 60);
        g.drawImage(img, 30, 30);
        g.strokeStyle = '#cccccc';
        g.lineWidth = 1;
        g.strokeRect(29.5, 29.5, iw + 1, ih + 1);
        drawText(g, name, 34, ih + 50, 16, '#999999', false, true);
        try {
            console.warn('[engine-styles] 未注册的相框风格:', name,
                '— 已渲染为占位图。请在 engine-styles.js 的 draw 映射表与 styleDims() 中登记该风格,'
                + '或检查模板里的 photoFrameStyle 是否为笔误。');
        } catch (e) { /* 忽略 */ }
    }

    // ── 品牌行统一语言 ───────────────────────────────────────────────
    // 相机参数水印的品牌字使用 Times New Roman 衬线,颜色按品牌自动映射;
    // 其他会出现相机品牌的风格也复用这一套,避免「Canon」在一个预设里是红衬线、
    // 在另一个预设里变成白色无衬线。
    const BRAND_SERIF = '"Times New Roman", Georgia, serif';
    const BRAND_SANS = '"Courier New", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

    function prettyBrand(brand) {
        const raw = String(brand == null ? '' : brand).trim();
        if (!raw) return '';
        const key = raw.toUpperCase();
        const names = {
            CANON: 'Canon', FUJIFILM: 'FUJIFILM', FUJI: 'FUJIFILM',
            NIKON: 'Nikon', SONY: 'SONY', LEICA: 'Leica',
            PANASONIC: 'Panasonic', LUMIX: 'LUMIX', 'OM SYSTEM': 'OM System',
            OLYMPUS: 'OLYMPUS', PENTAX: 'PENTAX', HASSELBLAD: 'HASSELBLAD',
            'PHASE ONE': 'Phase One', SAMSUNG: 'SAMSUNG', XIAOMI: 'Xiaomi',
            HUAWEI: 'HUAWEI', APPLE: 'Apple', GOOGLE: 'Google',
            ONEPLUS: 'OnePlus', OPPO: 'OPPO', VIVO: 'vivo', DJI: 'DJI',
            GOPRO: 'GoPro', INSTA360: 'Insta360', ZEISS: 'ZEISS',
            CONTAX: 'CONTAX', 'KONICA MINOLTA': 'KONICA MINOLTA',
            MAMIYA: 'Mamiya', SINAR: 'Sinar', ALPA: 'ALPA'
        };
        return names[key] || raw;
    }

    // 品牌色是给「品牌字」用的;白字/黑字仍是大多数背景下的兜底。
    // darkBg=true 用于模糊照片/深色条,light 用于白卡/米白纸。
    function brandInk(brand, darkBg) {
        const key = String(brand || '').trim().toUpperCase();
        if (!key) return darkBg ? '#ffffff' : '#1a1a1a';
        if (key === 'CANON') return '#d71920';
        if (key.indexOf('FUJI') === 0) return '#e60012';
        if (key === 'LEICA') return '#e30613';
        if (key === 'NIKON') return darkBg ? '#ffd400' : '#8a6d00';
        if (key === 'PANASONIC' || key === 'LUMIX') return darkBg ? '#63b3ff' : '#0046a6';
        if (key === 'XIAOMI' || key === 'REDMI') return '#ff6900';
        if (key === 'HASSELBLAD') return darkBg ? '#ffb35c' : '#9a4f00';
        if (key === 'PENTAX' || key === 'RICOH') return '#d71920';
        if (key === 'OM SYSTEM' || key === 'OLYMPUS') return darkBg ? '#8cbcff' : '#0b2a8a';
        return darkBg ? '#ffffff' : '#1a1a1a';
    }

    function brandFont(fs, weight) {
        return (weight || 700) + ' ' + fs + 'px ' + BRAND_SERIF;
    }

    function brandTextWidth(g, text, fs, track) {
        if (!text) return 0;
        g.save();
        g.font = brandFont(fs, 700);
        g.letterSpacing = (track || 0) + 'px';
        const w = g.measureText(text).width;
        g.restore();
        return w;
    }

    function drawBrandText(g, text, x, y, fs, color, track) {
        if (!text) return;
        g.save();
        g.font = brandFont(fs, 700);
        g.fillStyle = color;
        g.letterSpacing = (track || 0) + 'px';
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.fillText(text, x, y);
        g.restore();
    }

    function drawTrackedBrandL(g, text, cx, baselineY, fs, color, trackRatio, forcedX) {
        if (!text) return 0;
        const track = Math.max(1, Math.round(fs * trackRatio));
        const tw = brandTextWidth(g, text, fs, track);
        const x0 = forcedX != null ? forcedX : cx - Math.floor(tw / 2);
        g.save();
        g.font = brandFont(fs, 700);
        g.fillStyle = color;
        g.letterSpacing = track + 'px';
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.fillText(text, x0, baselineY);
        g.restore();
        return tw;
    }

    // 品牌池里是否有该品牌的彩色变体(Canon_Color / Fujifilm_Color ...)。
    // 有彩色版时所有品牌风格都优先彩色;没有时仍按背景明暗用 White/Black。
    function brandLogoHasColor(app, brand) {
        if (!app || !app.logos || !app.logos.length || !brand) return false;
        const b = String(brand).trim().toUpperCase();
        return app.logos.some(l => {
            if (!l || !l.name) return false;
            const n = String(l.name).replace(/\.(png|jpe?g|svg|gif|webp)$/i, '');
            if (!/[_-]color$/i.test(n)) return false;
            return n.replace(/[_-](white|black|color)$/i, '').trim().toUpperCase() === b;
        });
    }

    // 阶段二渲染状态(模板参数 → 原版静态参数)
    // 判定某样式 logo 出现的背景明暗,返回品牌 logo 变体偏好('white'|'black'|'color')。
    // 深背景(深色条/暗卡/模糊照片压暗)用 White,浅背景(米白/白卡底)用 Black。
    // 有「背景模糊」开关的样式随 signBgBlur 切换。
    function brandLogoPref(app, styleName, signBgBlur, brand) {
        // 自动配色:素材池里存在 Color 版时优先用 Color(Canon 红标、Fujifilm 绿标等),
        // 没有彩色版才回退到背景明暗对应的 White/Black。
        if (brandLogoHasColor(app, brand)) return 'color';
        const dark = [
            'WM_CLASSIC', 'WM_BRAND_LOGO', 'WM_AI',
            'BLUR_CLASSIC', 'BLUR_DATE', 'IMP_FROSTED', 'IMP_CLASSIC',
            'CARD_IMMERSION', 'OVERLAY_LOGO_BOTTOM',
            'FUJI_WM', 'FUJI_WM_BRAND', 'DARK_BRAND_ONLY',
            'SIGN_BLUR', 'SIG_BLUR', 'AV_BLUR'
        ].indexOf(styleName) !== -1;
        if (dark) return 'white';
        if (styleName === 'PARAM_CREDIT') return 'white';
        if (signBgBlur && ['OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM',
                           'CARD_LOGO_PARAM', 'SIGN_PARAM', 'SIGNATURE'].indexOf(styleName) !== -1) return 'white';
        return 'black';
    }

    function buildState(app, styleName, iw, ih, size) {
        const t = app.template;
        const cc = t.cornerConfig || {};
        const clampP = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v == null ? 0 : v)));
        // 合并 EXIF:面板手动(manualExif:brand/model/focal/aperture/iso/shutter)优先,缺失项用照片自动识别 exif
        const manual = (t.manualExif && typeof t.manualExif === 'object') ? t.manualExif : {};
        const auto = app.image.exif || {};
        const exif = {
            make: (manual.brand || '').trim() || auto.make || '',
            model: (manual.model || '').trim() || auto.model || '',
            focal: (manual.focal || '').trim() || auto.focal || '',
            focal35: Number(auto.focal35) || 0,
            aperture: (manual.aperture || '').trim() || auto.aperture || '',
            iso: (manual.iso || '').trim() || auto.iso || '',
            shutter: (manual.shutter || '').trim() || auto.shutter || '',
        };
        // 0(未指定) = 自适应:按照片短边/45,clamp 20~64(原版 autoParamFontSize 同规则)
        const rawPf = t.paramFontSize != null ? t.paramFontSize : 35;
        const autoPf = Math.max(20, Math.min(64, Math.round(Math.min(iw, ih) / 45)));
        const cam = cameraFor(styleName, iw, ih, exif);
        // 苹果信息卡:品牌/型号/参数统一由下方「相机参数(自动识别)」驱动(单一事实来源)
        const appleCfg = (t.appleCard && typeof t.appleCard === 'object') ? t.appleCard : {};
        // 联名水印:同样复用相机参数识别;Logo 走通用品牌 Logo 池
        const xmCfg = (t.xmLeica && typeof t.xmLeica === 'object') ? t.xmLeica : {};
        // 等效焦距(可选,cbFocalEq → t.focalEq):只认 EXIF 里相机写好的
        // FocalLengthIn35mmFilm(0xA405)。勾选后相机焦距直接显示换算值(35mm → 53mm),
        // 不再并列实际焦距;没有这个标签就保持实际焦距,不按机型猜画幅。
        // 手动改过焦距时按原图比例换算,避免把原图的等效值硬套到新焦距上。
        // cam 是 cameraFor 每次新建的对象,原地改 focal 不影响别处。
        if ((t.focalEq || 0) === 1 && exif.focal35 > 0 && exif.focal
            && camHasData(exif) && typeof window !== 'undefined' && window.FocalEq) {
            const eq = window.FocalEq.equivalentFor(exif.focal, auto.focal, exif.focal35);
            const converted = window.FocalEq.format(exif.focal, eq);
            if (converted && converted !== exif.focal) cam.focal = converted;
        }
        // 相机品牌->logo 图(勾选 brandLogo 且按品牌名匹配到品牌池时预载)
        // 变体按背景明暗选:同一品牌有黑白两版时,深背景用 White、浅背景用 Black/Color。
        let brandLogoImg = null, brandLogoData = '';
        const brandLogoVal = Number(t.brandLogo || 0);
        if ((brandLogoVal === 1 || brandLogoVal === 2) && cam.brand) {
            const hit = brandLogoEntry(app, cam.brand, brandLogoPref(app, styleName, Number(t.signBgBlur || 0), cam.brand));
        if (hit && hit.dataUrl) {
                brandLogoData = hit.dataUrl;
                let im = (app.logoImgCache && app.logoImgCache[brandLogoData]) || null;
                if (!im) {
                    im = window.qfsImage();
                    im.onload = () => { try { if (app.scheduleRender) app.scheduleRender(true); } catch (e) {} };
                    im.src = brandLogoData;
                    if (app.logoImgCache) app.logoImgCache[brandLogoData] = im;
                }
                brandLogoImg = im;
            }
        }
        // 联名水印:联名 Logo。填了 partnerBrand(如 Leica)就按联名品牌从同一个 Logo 池取图,
        // 覆盖「Logo 跟随相机品牌」的默认行为;没填就与其它风格一样用相机品牌 Logo。
        let xmPartnerImg = null;
        if ((brandLogoVal === 1 || brandLogoVal === 2) && xmCfg.partnerBrand) {
            const hitXm = brandLogoEntry(app, xmCfg.partnerBrand, brandLogoPref(app, styleName, Number(t.signBgBlur || 0), xmCfg.partnerBrand));
            if (hitXm && hitXm.dataUrl) {
                let imXm = (app.logoImgCache && app.logoImgCache[hitXm.dataUrl]) || null;
                if (!imXm) {
                    imXm = window.qfsImage();
                    imXm.onload = () => { try { if (app.scheduleRender) app.scheduleRender(true); } catch (e) {} };
                    imXm.src = hitXm.dataUrl;
                    if (app.logoImgCache) app.logoImgCache[hitXm.dataUrl] = imXm;
                }
                xmPartnerImg = imXm;
            }
        }
        return {
            size,
            exif,
            cam,
            appleCard: appleCfg,
            xmLeica: xmCfg,
            xmPartnerImg,
            brandLogo: Number(t.brandLogo || 0),
            brandLogoImg,
            brandLogoData,
            paramFs: rawPf > 0 ? clampP(rawPf, 2, 160) : autoPf,
            blurIntensity: clampP(t.blurIntensity != null ? t.blurIntensity : 50, 0, 100),
            // 背景模糊(经典/日期)的专属自由度。null = 用户没动过 → 引擎走缺省路径。
            // 视觉三项默认与旧版一致；文字三项的缺省值就是「空白均分三份 + 品牌间距 0.28 字号」。
            // 主体大小不设字段：它与 S.imgScale（通用「图片缩放」滑块）是同一个乘数。
            blurBackdropDim: t.blurBackdropDim != null ? clampP(t.blurBackdropDim, 0, 80) : null,
            blurBackdropZoom: t.blurBackdropZoom != null ? clampP(t.blurBackdropZoom, 100, 200) : null,
            blurSubjectShadow: t.blurSubjectShadow != null ? clampP(t.blurSubjectShadow, 0, 200) : null,
            // 底部文字排版：整块上下位置(±100% 半带高) / 两行间距倍率 / 品牌-型号水平间距倍率。
            blurTextOffset: t.blurTextOffset != null ? clampP(t.blurTextOffset, -100, 100) : null,
            blurTextGap: t.blurTextGap != null ? clampP(t.blurTextGap, 0, 300) : null,
            blurBrandGap: t.blurBrandGap != null ? clampP(t.blurBrandGap, 0, 300) : null,
            // 样式私有参数(style-params.js 的 path:'style')。null = 用户没动过,
            // 样式函数里的 spNum 会退回原字面量,旧预设与视觉基线逐像素不变。
            styleParams: (t.styleParams && t.styleParams[String(styleName).toUpperCase()]) || null,
            paramType: clampP(t.paramType != null ? t.paramType : 0, 0, 2),
            position: positionOf(t.paramPosition),
            useExif: true,
            cornerAll: cc.cornerRadiusAll != null ? cc.cornerRadiusAll : 30,
            imgScale: (t.baseMargin && (t.baseMargin.imgScale || 1)) || 1,
            imgOffsetX: (t.baseMargin && t.baseMargin.imgOffsetX) || 0,
            imgOffsetY: (t.baseMargin && t.baseMargin.imgOffsetY) || 0,
            globalMargin: (t.baseMargin && t.baseMargin.globalMargin) || 1,
            shadowSize: clampP(t.shadowSize != null ? t.shadowSize : 0, 0, 80),
            shadowDepth: clampP(t.shadowDepth != null ? t.shadowDepth : 30, 0, 100),
            shadowAlpha: 80,
            aiCaption: String(t.aiCaption || '').trim(),
            aiCapLayout: clampP(t.aiCapLayout != null ? t.aiCapLayout : 0, 0, 2),
            aiCapFontIdx: clampP(t.aiCapFontIdx != null ? t.aiCapFontIdx : 0, 0, 3),
            aiCapSizePct: clampP(t.aiCapSizePct != null ? t.aiCapSizePct : 100, 50, 200),
            aiCapTheme: clampP(t.aiCapTheme != null ? t.aiCapTheme : 0, 0, 2),
            userSignature: String(t.userSignature || '').trim(),
            signFont: String(t.signFont || 'Courier New'),
            // 未设置就保持空串 —— 各风格用 `(S && S.signColor) || 风格色` 取自己的兜底色
            // （票面 ink、报纸 #2f2a24、照片浮层 #fff…）。旧行为统一填引擎默认 #555，
            // 把风格兜底全压死了：深色票面上签名亮度差不到 1.5:1，等于看不见。
            // 真正以 #555/#444 为默认的绘制处自带 `S.signColor || '#555'` 写法，行为不变。
            signColor: String(t.signColor || ''),
            signIncludeModel: Number(t.signIncludeModel || 0),
            creditMode: Number(t.creditMode || 0),
            avatarScale: Number(t.avatarScale || 0.85),
            avatarShow: t.avatarShow === undefined ? 1 : Number(t.avatarShow),
            signSize: Number(t.signSize || 1),
            signBgBlur: Number(t.signBgBlur || 0),
            paramColor: String(t.paramColor || 'auto'),
            avatarOffX: Number(t.avatarOffX || 0),
            avatarOffY: Number(t.avatarOffY || 0),
            avatarSelected: !!t.avatarSelected,
            logoSize: clampP(t.logoSize != null ? t.logoSize : 14, 0, 200),
            brandScale: clampP(t.brandSize != null ? t.brandSize : 1, 0.5, 3),
            paramScale: clampP(t.paramScale != null ? t.paramScale : 1, 0.5, 3),
            // 「玻璃条大小」只有 LIQUID_GLASS 读:1 = APK 原尺寸(45dp 高)。
            // 滑块只能给出 50%~200%,所以超出这个语义的值(0 / 负数 / 非数字)一律回落 1,
            // 而不是夹到最小档 —— 0 等于"把玻璃条画没",那是用户看不出来也找不回来的状态。
            glassSize: (() => {
                const v = Number(t.liquidGlassSize);
                return clampP(Number.isFinite(v) && v > 0 ? v : 1, 0.5, 2);
            })(),
            glassDateShow: t.liquidGlassDate !== 0,
            // 拍立得底部自定义文字(留空=显示默认日期)
            polaroidCaption: String(t.polaroidCaption || ''),
            // 哈苏水印品牌文字(留空回落照片品牌型号)
            hassyCaption: String(t.hassyCaption || '').trim(),
        };
    }

    // 品牌→唯一文本(用于 LogoResource 目前"文字近似"的绘制)。S.brandLogo:1=文字+Logo 并排,2=仅 Logo(品牌文字被替换)。
    // 仅Logo 时 logo 顶替品牌词:占位按原词宽返回(后续元素位置不变),logo 水平居中于原词块。
    function drawLogo(g, brand, x, y, logoFs, S) {
        if (brandHidden(S)) return 0;
        const b = prettyBrand(brand) || 'CAMERA';
        const fs = logoFs;
        // 与「相机参数水印」统一:Times New Roman 品牌字 + 品牌自动配色。
        g.font = brandFont(fs, 700);
        g.fillStyle = brandInk(brand, true);
        const track = Math.round(fs * 0.15);
        g.letterSpacing = track;
        const only = S && S.brandLogo === 2;
        const tw = brandTextWidth(g, b, fs, track);
        if (S && S.brandLogo) {
            const lw = drawBrandMark(g, S, only ? logoCenterX(S, fs, x, tw) : x, y, fs);
            if (!only || !lw) g.fillText(b, only ? x : x + lw, y);
            g.letterSpacing = 0;
            return only && lw ? tw : lw + tw;
        }
        g.fillText(b, x, y);
        g.letterSpacing = 0;
        return tw;
    }

    // 品牌池匹配:把品牌名与池内文件去后缀(去掉 _White/_Black/_Color/-White/-Black/.png)后不区分大小写比对。
    // 自定义图标同样参与匹配,并按「文件名首个词」兜底 —— 用户导入 Canon.png / Canon EOS R5.png
    // 都能命中 EXIF 识别出的 CANON,使发行版(不带内置 Logo 包)也有可用的品牌 Logo 路径。
    // pref:'white'|'black'|'color'|''(默认)——按 logo 出现的背景明暗选变体:
    // 深背景优先 White、浅背景优先 Black(彩色变体居中兼容,纯净图兜底)。
    function brandLogoEntry(app, brand, pref) {
        if (!app || !app.logos || !app.logos.length || !brand) return null;
        const b = String(brand).trim().toUpperCase();
        if (!b) return null;
        const strip = n => n.replace(/\.(png|jpg|jpeg|svg|gif|webp)$/i, '')
            .replace(/[_-](white|black|color)$/i, '').trim();
        const m = app.logos.filter(l => {
            if (!l) return false;
            const full = strip(l.name).toUpperCase();
            if (full === b) return true;
            if (!l.custom) return false;
            // 自定义图标放宽比对,让「按文件名配品牌」覆盖到识别表之外的机型:
            //  a) 首个词相等          —— "Canon EOS R5.png" ← CANON
            //  b) 品牌以首个词+边界开头 —— "Hasselblad.png"  ← "Hasselblad AB"(make 原文)
            // 都要求词边界,避免 "Canonical.png" 误配 CANON
            const head = full.split(/[\s_\-·]+/)[0];
            if (head === b) return true;
            if (b.length > head.length && b.startsWith(head)) {
                const next = b.charAt(head.length);
                return /[\s_\-·.]/.test(next);
            }
            return false;
        });
        // 同品牌重名时优先内置素材(质量与黑白变体更可控),再按背景明暗排序
        const cands = m.filter(l => !l.custom);
        const pool = cands.length ? cands : m;
        if (!pool.length) return null;
        const variantOf = l => {
            // 名字带扩展名(如 Leica_Color.png),必须先去掉扩展名再锚定 $,
            // 否则永远匹配不到变体,排序退化成字母序(Black 恒在前),与 brandLogoHasColor 的判定矛盾。
            const match = (l.name || '').toLowerCase().replace(/\.(png|jpe?g|svg|gif|webp)$/i, '').match(/[_-](white|black|color)$/);
            return match ? match[1] : '';
        };
        const rank = l => {
            const v = variantOf(l);
            if (pref === 'white') {
                if (v === 'white') return 0;
                if (v === 'color') return 1;
                if (!v) return 2;
                return 3;
            }
            if (pref === 'black') {
                if (v === 'black') return 0;
                if (v === 'color') return 1;
                if (!v) return 2;
                return 3;
            }
            if (pref === 'color') {
                if (v === 'color') return 0;
                if (v === 'white') return 1;
                if (!v) return 2;
                return 3;
            }
            if (v === 'white') return 3;
            if (v === 'black') return 2;
            if (v === 'color') return 1;
            return 0;
        };
        // 排「将要返回的那一组」:pool 在无内置候选时会回退成 m(纯自定义)。
        // 排序与取值都基于 pool —— 之前排 cands 却取 cands[0],当兜底走到 pool=m 时
        // cands 为空数组,会永远返回 undefined(内置包因总带颜色后缀而恰好没暴露这个 bug)。
        pool.sort((a, c) => rank(a) - rank(c));
        return pool[0];
    }

    // 品牌行是否隐藏(不显示品牌名与 Logo,参数行保留)。S.brandLogo:3=隐藏。
    function brandHidden(S) { return !!(S && S.brandLogo === 3); }

    // 根据品牌字号算出 logo 绘制尺寸与水平占宽。S.brandLogo:1=文字+Logo(logo 高≈品牌字号,在左),2=仅Logo(品牌文字被 logo 替换,logo 放大到 1.6 倍字号)。
    // 返回 {img, w, h, gap} 或 null。img 未加载完返回 null → 纯文字退路;品牌行隐藏时也返回 null。
    function brandMarkSpec(S, fs) {
        if (brandHidden(S)) return null;
        const im = S.brandLogoImg;
        if (!S.brandLogo || !im || !(im.complete && im.naturalWidth)) return null;
        const h = Math.round(fs * (S.brandLogo === 2 ? 0.8 : 0.5));
        const w = Math.max(1, Math.round(h * im.naturalWidth / im.naturalHeight));
        return { img: im, w, h, gap: Math.round(fs * 0.35) };
    }

    // logo 在左、品牌文字在右:正常进入后把 logo 画到文字起始 x 左侧,返回总占宽(logo+gap+文字没算进去)。
    // 用于居中时先算总宽:return brandMarkSpec 的宽;真正绘制走 drawBrandMark。
    function brandMarkW(S, fs) {
        const sp = brandMarkSpec(S, fs);
        return sp ? sp.w + sp.gap : 0;
    }

    // 仅Logo 模式居中徽标时只用 logo 净宽(不带文字预留 gap),保证 logo 几何中心真正居中。
    function brandMarkNetW(S, fs) {
        const sp = brandMarkSpec(S, fs);
        return sp ? sp.w : 0;
    }

    // 仅Logo 模式:logo 应顶替品牌文字原来的位置。给出品牌文字左起点 x0 与文字宽 tw,
    // 返回让 logo 水平居中于原文字区域的绘制 x(无可用 logo 时原样返回 x0 → 走文字退路)。
    function logoCenterX(S, fs, x0, tw) {
        const sp = brandMarkSpec(S, fs);
        return sp ? Math.round(x0 + (tw - sp.w) / 2) : x0;
    }

    // 绘制 logo(左)此时 g 的文字字形与字号已经设为品牌文案用,基线在 y;返回 logo 占的横向宽度(不含文字)。
    // align: 'top'(textBaseline=top 用,logo 顶贴 y);默认 bottom 贴基线。
    // logo 替换文字(仅Logo 模式)时 logo 以文字行高垂直居中——行中心轴=基线 y - ascent(0.78fs)/2 即 y - 0.28fs。
    function drawBrandMark(g, S, x, y, fs, align) {
        const sp = brandMarkSpec(S, fs);
        if (!sp) return 0;
        const yy = align === 'top' ? Math.round(y)
            : (S.brandLogo === 2 ? Math.round(y - fs * 0.28 - sp.h / 2) : Math.round(y - sp.h));
        g.save();
        g.drawImage(sp.img, Math.round(x), yy, sp.w, sp.h);
        g.restore();
        return sp.w + sp.gap;
    }

    // 成品尺寸(与原版几何一致)
    // 参数横条几何:styleDims 在 renderPhotoFrame 之外,必须把几何函数放在同一层,
    // 否则 styleDims 看不到它,整条风格会回退成原图。
    function paramStripGeom(iw, ih, size) {
        const ref = Math.min(iw, ih);
        const pad = Math.max(24, Math.round(size * 0.35), Math.round(iw * 0.04));
        const top = Math.max(46, Math.round(ref * 0.07));
        const gap = Math.max(12, Math.round(ref * 0.024));
        // 参数轨必须跟短边等比缩放:此前把 barH 封顶 196,但字号仍按 ref 放大,
        // 高分辨率照片里三行文字会被压进同一个横条而互相重叠。
        const barH = Math.max(112, Math.round(ref * 0.20));
        const w = iw + pad * 2;
        const barY = top + ih + gap;
        return {
            ref, pad, top, gap, barH, w, h: barY + barH,
            photoX: pad, photoY: top, photoW: iw, photoH: ih, barY,
        };
    }

    // 相机参数水印几何:参考图 1276×1152 里照片约 1200×855,即照片占画布宽 94.04%、
    // 高 74.22%,上留白 8.25%、下文字区 17.5%。把这两个比例反推成画布尺寸,
    // styleDims 与绘制共用,避免画布比例和照片框各算一套。
    function paramCreditGeom(iw, ih) {
        return {
            cw: Math.max(1, Math.round(iw / 0.9404)),
            ch: Math.max(1, Math.round(ih / 0.7422)),
        };
    }

    // 头像纪念几何:styleDims 与 styleAvatarMemo 必须同源。
    // 旧版 styleDims 多算了 pad,且底栏按 iw*0.14 预留,而绘制按 iw*0.16,
    // 画布底部会留下一条没有被填充的透明带(PNG 里看起来是黑条)。
    function avatarMemoGeom(iw, ih) {
        const pad = Math.max(30, Math.round(iw * 0.05));
        const bottomH = Math.round(iw * 0.16);
        return { pad, bottomH, w: iw + pad * 2, h: ih + pad + bottomH };
    }

    function styleDims(name, iw, ih, size, S) {
        const pad2 = v => Math.max(v, Math.floor(size / 2));
        switch (name) {
            case 'SIMPLE':
            case 'ROUNDED':
            case 'WHITE_PLAIN':
            case 'GRADIENT':
            case 'DOUBLE_LINE':
            case 'SIMPLE_FILM':
            case 'PARAM_TOP_LEFT':
            case 'PARAM_BOTTOM_LEFT':
            case 'PARAM_BOTTOM_SINGLE':
                return { w: iw + size * 2, h: ih + size * 2 };
            case 'FILM_STRIP': {
                const railH = Math.max(20, size);
                return { w: iw + size * 2, h: ih + railH * 2 };
            }
            case 'FILM_TEAR': {
                const ft = filmTearGeom(iw, ih, size);
                return { w: ft.w, h: ft.h };
            }
            case 'VINTAGE': {
                const vg = vintageGeom(iw, ih, size);
                return { w: vg.w, h: vg.h };
            }
            case 'POLAROID': {
                const pfs = Math.max(10, Math.round(autoExifSize((S ? S.paramFs : 12), iw)));
                const pbottom = Math.max(size * 3, Math.round(pfs * 2.6));
                return { w: iw + size * 2, h: ih + size + pbottom };
            }
            case 'HASSELBLAD': {
                const hbFs = Math.max(17, Math.round(autoExifSize((S ? S.paramFs : 12), iw) * 1.35));
                const hbBar = Math.max(64, Math.round(hbFs * 2.6));
                // 尺寸必须与 styleHasselblad 同源:实际绘制用 pad=size/2(左右/顶部),底部 barH
                // 旧版此处用 size*2/size,画布比内容右侧/底部各多出 size/2 透明区,补边后两边不对称
                const hp = Math.max(14, Math.floor(size / 2));
                return { w: iw + hp * 2, h: ih + hp + hbBar };
            }
            case 'DROP_SHADOW': {
                const offset = Math.max(8, Math.floor(size / 2));
                return { w: iw + size * 2 + offset, h: ih + size * 2 + offset };
            }
            case 'BLUR_CLASSIC':
            case 'BLUR_DATE': {
                const side = blurBand(size, iw, ih, (S ? S.blurIntensity : 50), S);
                const bottom = S ? blurBottom(size, iw, ih, S) : side;
                return { w: iw + side * 2, h: ih + side + bottom };
            }
            case 'WM_CLASSIC': {
                const barH = Math.max(50, size);
                return { w: iw + size * 2, h: ih + size + barH };
            }
            case 'WM_SINGLE': {
                const barH = Math.max(32, size), pad = pad2(8);
                return { w: iw + pad * 2, h: ih + pad + barH };
            }
            case 'WM_BRAND_LOGO': {
                const barH = Math.max(56, Math.floor(size * 3 / 2));
                return { w: iw + size * 2, h: ih + size + barH };
            }
            case 'WM_AI': {
                const cap = S ? S.aiCaption : '';
                const twoLine = cap && (!S || S.aiCapLayout !== 1);
                let barH = Math.max(twoLine ? 64 : 44, Math.floor(size * (twoLine ? 3 : 2) / 2));
                const pct = S ? S.aiCapSizePct : 100;
                barH += Math.floor(barH * Math.max(0, pct - 100) / 250);
                const pad = pad2(8);
                return { w: iw + pad * 2, h: ih + pad + barH };
            }
            case 'IMP_FROSTED': {
                const lw = Math.max(180, Math.round(iw * 0.35));
                const rp = Math.round(lw / 2);
                const tbp = Math.max(50, Math.round(size * 1.2));
                return { w: lw + iw + rp, h: ih + tbp * 2 };
            }
            case 'FUJI_WM':
            case 'FUJI_WM_BRAND':
            case 'DARK_BRAND_ONLY': {
                const op = Math.max(15, Math.round(size * 0.5));
                return { w: iw + op * 2, h: ih + op * 2 };
            }
            case 'IMP_CLASSIC':
                return { w: iw + pad2(8) * 2, h: ih + pad2(8) * 2 };
            case 'XIAOMI_IMP': {
                const topPad = Math.max(20, Math.floor(size / 2));
                const barH = Math.max(50, size * 2);
                const sidePad = Math.max(6, Math.floor(size / 3));
                return { w: iw + sidePad * 2, h: ih + topPad + barH };
            }
            case 'CARD_LEICA': {
                const pad = Math.max(24, Math.floor(size * 3 / 4));
                const f1 = autoExifSize((S ? S.paramFs : 12), iw), f2 = Math.max(12, Math.floor(f1 * 2 / 3));
                const maxFs = Math.max(f1, f2);
                return { w: iw + pad * 2, h: ih + pad + Math.max(52, Math.floor(maxFs * 5 / 2)) };
            }
            case 'CARD_LOGO_PARAM': {
                const pad = Math.max(28, Math.floor(size * 3 / 5));
                const f1 = autoExifSize((S ? S.paramFs : 12), iw), f2 = Math.max(12, Math.floor(f1 * 2 / 3));
                const h1 = Math.round(f1), h2 = Math.round(f2);
                const gap = Math.max(8, Math.floor(h1 / 4));
                const bandH = Math.max(56, Math.floor((h1 + gap + h2) + pad * 2 / 3));
                return { w: iw + pad * 2, h: ih + pad + bandH };
            }
            case 'CARD_PURE_LOGO': {
                const pad = Math.max(32, size);
                const wf = Math.max(20, Math.min(96, Math.round(autoExifSize((S ? S.paramFs : 12), iw))));
                const extra = Math.max(Math.round(wf) * 3, size);
                return { w: iw + pad * 2, h: ih + pad + extra };
            }
            case 'CARD_SIMPLE': {
                const pad = Math.max(12, Math.floor(size / 2));
                const fmH = Math.round(autoExifSize((S ? S.paramFs : 12), iw));
                const capH = Math.floor(fmH * 5 / 3) + Math.max(6, Math.floor(pad / 4));
                return { w: iw + pad * 2, h: ih + pad + capH + Math.max(10, Math.floor(pad / 2)) };
            }
            case 'CARD_IMMERSION': {
                const pad = Math.max(20, Math.floor(size * 2 / 5));
                const fmH = Math.round(autoExifSize((S ? S.paramFs : 12), iw));
                const bandH = fmH * 2 + Math.max(10, Math.floor(pad / 2));
                return { w: iw + pad * 2, h: ih + pad + bandH };
            }
            case 'CARD_APPLE': {
                const A = appleCardCfg(S && S.appleCard);
                const T = appleCardText(S || {}, A);
                const M = cardAppleMetrics(iw, size, (S ? S.paramFs : 35), A, T);
                // 上/左/右贴边,只有底部信息条
                return { w: iw, h: ih + M.capH };
            }
            case 'XIAOMI_LEICA':
                // 照片铺满画布,联名水印直接压在照片上,画布 = 原图尺寸
                return { w: iw, h: ih };
            case 'COLOR_CLASSIC': {
                const pfs = Math.max(10, Math.round(autoExifSize((S ? S.paramFs : 12), iw)));
                const barH = Math.max(40, size, Math.round(pfs * 5 / 3)), pad = pad2(8);
                return { w: iw + pad * 2, h: ih + pad + barH };
            }
            case 'COLOR_REFINED': {
                const barH = Math.max(50, Math.floor(size * 4 / 3)), pad = pad2(8);
                return { w: iw + pad * 2, h: ih + pad + barH };
            }
            case 'ART_CARD': {
                const G = artCardGeom(iw, ih, size, S);
                return { w: G.w, h: G.h };
            }
            case 'FUJI_WHITE': {
                const af = Math.max(11, Math.round(autoExifSize((S ? S.paramFs : 12), iw)));
                const af2 = Math.round(af * 0.85);
                const pad = Math.max(12, Math.round(iw * 0.02));
                const lineGap = Math.round(af * 0.6);
                const padBottom = Math.round(af * 0.6);
                const barH = af + lineGap + af2 + padBottom * 2;
                return { w: iw + pad * 2, h: ih + pad + barH };
            }
            case 'STAMP_POSTAGE': {
                const sd = stampPostageGeom(iw, ih, size);
                return { w: sd.w, h: sd.h };
            }
            case 'TEARED_PAPER': {
                const tp = tornPaperParams(iw, ih, size);
                return { w: tp.bw + tp.pad * 2, h: tp.bh + tp.pad * 2 };
            }
            case 'FOLD_CORNER': {
                const padF = Math.max(60, Math.round(iw * 0.06));
                return { w: iw + padF * 2, h: ih + padF * 2 };
            }
            case 'PINBOARD_TAPE':
                return { w: iw + size * 2, h: ih + size * 2 };
            case 'DOUBLE_EXPOSURE': {
                const padD = Math.max(50, Math.round(iw * 0.05));
                return { w: iw + padD * 2, h: ih + padD * 2 };
            }
            case 'MAGAZINE_MASTHEAD': {
                const pM = Math.max(50, Math.round(iw * 0.05));
                return { w: iw + pM * 2, h: ih + pM * 2 + Math.round(iw * 0.22) };
            }
            case 'MAGAZINE_COVER': {
                const pC = Math.max(36, Math.round(iw * 0.045));
                return { w: iw + pC * 2, h: ih + pC * 2 + Math.round(iw * 0.16) };
            }
            case 'MAGAZINE_HEADER': {
                const pH = Math.max(36, Math.round(iw * 0.04));
                return { w: iw + pH * 2, h: ih + pH * 2 + Math.round(iw * 0.14) };
            }
            case 'VHS_TAPE': {
                const padX = Math.max(14, Math.round(iw * 0.022), Math.round(size * 0.24));
                const topH = Math.max(46, Math.round(iw * 0.065), Math.round(size * 1.05));
                const botH = Math.max(64, Math.round(iw * 0.105), Math.round(size * 1.55));
                return { w: iw + padX * 2, h: ih + topH + botH };
            }
            case 'ALBUM_CORNER': {
                const ag = albumGeom(iw, ih, size);
                return { w: ag.w, h: ag.h };
            }
            case 'MOVIE_TICKET': {
                // 尺寸与 styleMovieTicket 同源(共用 movieGeom),否则登记的画布和实际画出来的
                // 票面对不上 —— 旧版这里写「上下各 max(30,size*0.8)」,styleMovieTicket 却是
                // 票头+信息带+票脚,票脚整条被切掉。
                const mvAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete
                    && window.__qfsAvatarImg.naturalWidth) && (S ? S.avatarShow !== 0 : true);
                const mvSig = !!(S && S.userSignature);
                const mvG = movieGeom(iw, ih, size, mvAv, mvSig);
                return { w: mvG.w, h: mvG.h };
            }
            case 'BOARDING_PASS': {
                // 尺寸与 styleBoardingPass 同源(共用 boardingGeom),否则登记的画布和实际画出来的
                // 票面对不上,齿孔/撕线会整片错位。
                const bpAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete
                    && window.__qfsAvatarImg.naturalWidth) && (S ? S.avatarShow !== 0 : true);
                const bpSig = !!(S && S.userSignature);
                const bpG = boardingGeom(iw, ih, size, bpAv, bpSig);
                return { w: bpG.w, h: bpG.h };
            }

            case 'TICKET_VINTAGE':
            case 'TICKET_CONCERT':
            case 'TICKET_SCRAP': {
                // 尺寸与 styleTicket 同源(共用 ticketGeom),否则登记的画布和实际画出来的
                // 票面对不上,齿孔/撕线会整片错位。
                const tkAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete
                    && window.__qfsAvatarImg.naturalWidth) && (S ? S.avatarShow !== 0 : true);
                const tkSig = !!(S && S.userSignature);
                const tkG = ticketGeom(iw, ih, size, tkAv, tkSig);
                return { w: tkG.w, h: tkG.h };
            }
            case 'TICKET_STAMP':
            case 'STAMP_KRAFT':
            case 'STAMP_BLUEPRINT':
            case 'STAMP_REDSEAL':
            case 'STAMP_GOLD': {
                const side = Math.max(16, Math.round(iw * 0.025), Math.round(size * 0.8));
                const blurGap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
                const stampAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete && window.__qfsAvatarImg.naturalWidth) && (S ? S.avatarShow !== 0 : true);
                const stampSig = !!(S && S.userSignature);
                const textH = (stampAv || stampSig) ? Math.max(64, Math.round(size * 2.5)) : Math.max(46, Math.round(size * 1.8));
                return { w: iw + side * 2 + blurGap * 2, h: ih + side * 2 + textH + blurGap * 2 };
            }
            case 'WATERCOLOR_BLEED': {
                const bleed = Math.max(50, Math.floor(size * 1.5));
                return { w: iw + bleed * 2, h: ih + bleed * 2 };
            }
            case 'CYBER_GLITCH': {
                const p = Math.max(40, Math.round(iw * 0.04));
                return { w: iw + p * 2, h: ih + p * 2 };
            }
            case 'TORN_JOURNAL': {
                const p = Math.max(44, Math.round(iw * 0.05));
                return { w: iw + p * 2, h: ih + p * 2 };
            }
            case 'POLAROID_HAND': {
                const border = Math.max(30, Math.round(iw * 0.05));
                const bottomPad = Math.max(100, Math.round(iw * 0.15));
                return { w: iw + border * 2, h: ih + border + bottomPad };
            }
            case 'CARD_3D': {
                const padX = Math.round(iw * 0.18);
                const padTop = Math.round(iw * 0.1);
                const padBottom = Math.round(iw * 0.2);
                return { w: iw + padX * 2, h: ih + padTop + padBottom };
            }
            case 'COMIC_PANEL': {
                const gap = Math.round(iw * 0.015);
                return { w: iw + gap * 3, h: ih + gap * 3 + Math.round(iw * 0.08) };
            }
            case 'POP_COMIC': {
                const pad2 = Math.max(50, Math.round(iw * 0.05));
                return { w: iw + pad2 * 2, h: ih + pad2 * 2 + Math.round(iw * 0.07) };
            }
            case 'NEWSPAPER': {
                const ng = newspaperGeom(iw);
                return { w: ng.w, h: ih + ng.pad * 2 + ng.mastH + ng.headH + ng.bottomH };
            }
            case 'COLOR_PALETTE': {
                const pad = Math.max(30, Math.round(iw * 0.03));
                const barH = Math.max(104, Math.round(iw * 0.12));
                return { w: iw + pad * 2, h: pad + ih + barH };
            }
            case 'SIGNATURE': {
                const p = Math.max(30, Math.round(iw * 0.04));
                const bh = Math.round(iw * 0.12);
                return { w: iw + p * 2, h: ih + p + bh };
            }
            case 'SIGN_PARAM': {
                const p = Math.max(30, Math.round(iw * 0.04));
                const bh = Math.round(iw * 0.14);
                return { w: iw + p * 2, h: ih + p + bh };
            }
            case 'AVATAR_MEMO': {
                const am = avatarMemoGeom(iw, ih);
                return { w: am.w, h: am.h };
            }
            case 'SIGN_BLUR': {
                const p = Math.max(30, Math.round(iw * 0.04));
                const bh = Math.round(iw * 0.14);
                return { w: iw + p * 2, h: ih + p + bh };
            }
            case 'SIG_BLUR': {
                const p = Math.max(30, Math.round(iw * 0.04));
                const bh = Math.round(iw * 0.10);
                return { w: iw + p * 2, h: ih + p + bh };
            }
            case 'AV_BLUR': {
                const p = Math.max(30, Math.round(iw * 0.05));
                const bh = Math.round(iw * 0.11);
                return { w: iw + p * 2, h: ih + p * 2 + bh };
            }
            case 'AV_OVERLAY':
            case 'AV_OVERLAY_TR':
            case 'AV_OVERLAY_BR':
            case 'AV_OVERLAY_BC':
            case 'AV_OVERLAY_BC2': {
                const p = Math.max(20, Math.round(iw * 0.03));
                return { w: iw + p * 2, h: ih + p * 2 };
            }
            case 'PHOTO_CREDIT':
            case 'PARAM_CREDIT': {
                // 未开背景模糊:画布=原图尺寸,照片满幅,文字直接叠在照片上。
                // 开背景模糊:按参考图留出左右/上/下边距,照片不再缩到 0.95,
                // 而是占画布宽 94.04%、高 74.22%,文字落在底部独立区。
                if (name === 'PARAM_CREDIT' && S && S.signBgBlur) {
                    const pg = paramCreditGeom(iw, ih);
                    return { w: pg.cw, h: pg.ch };
                }
                return { w: iw, h: ih };
            }
            case 'LIQUID_GLASS':
                return { w: iw, h: ih };
            case 'GALLERY_MAT': {
                const refG = Math.min(iw, ih);
                const matG = Math.max(70, Math.round(refG * 0.09));
                const frameG = Math.max(12, Math.round(refG * 0.018));
                const filletG = Math.max(2, Math.round(refG * 0.003));
                const gapG = Math.max(2, Math.round(refG * 0.002));
                const labelH = Math.max(72, Math.round(matG * 0.8));
                const innerG = gapG + filletG + frameG;
                return { w: iw + innerG * 2 + matG * 2, h: ih + innerG * 2 + matG * 2 + labelH };
            }
            case 'PARAM_STRIP': {
                const ps = paramStripGeom(iw, ih, size);
                return { w: ps.w, h: ps.h };
            }
            case 'OVERLAY_PARAM_LEFT':
            case 'OVERLAY_PARAM_RIGHT': {
                // 与 IMP_FROSTED 印象毛玻璃保持同一套尺寸(lw=max(180,iw*0.35),rp=lw/2,tbp=max(50,size*1.2))
                const sideW = Math.max(180, Math.round(iw * 0.35));
                const oppPad = Math.round(sideW / 2);
                const topBotPad = Math.max(50, Math.round(size * 1.2));
                return { w: sideW + iw + oppPad, h: ih + topBotPad * 2 };
            }
            case 'OVERLAY_PARAM_BOTTOM': {
                const gm = Math.min(1.1, (S && S.globalMargin) || 1);
                const bottomH = Math.max(120, Math.round(ih * 0.25 * gm));
                const sidePad = Math.max(30, Math.round(size * 0.8 * gm));
                return { w: iw + sidePad * 2, h: ih + bottomH + sidePad };
            }
            case 'OVERLAY_LOGO_BOTTOM': {
                const p = Math.max(30, Math.round(iw * 0.05));
                const bh = Math.round(iw * 0.15);
                return { w: iw + p * 2, h: ih + p + bh };
            }
            case 'NEON_GLOW': { const p = Math.max(50, Math.round(iw * 0.06)); return { w: iw + p * 2, h: ih + p * 2 }; }
            case 'BURNED_EDGE': { const p = Math.max(40, Math.round(iw * 0.05)); return { w: iw + p * 2, h: ih + p * 2 }; }
            case 'INK_WASH': { const p = Math.max(60, Math.round(iw * 0.08)); return { w: iw + p * 2, h: ih + p * 2 }; }
            case 'CYANOTYPE': { const p = Math.max(30, Math.round(iw * 0.035)); return { w: iw + p * 2, h: ih + p * 2 }; }
            case 'OIL_BRUSH': { const p = Math.max(55, Math.round(iw * 0.07)); return { w: iw + p * 2, h: ih + p * 2 }; }
            case 'PRESSED_FLOWER': { const p = Math.max(50, Math.round(iw * 0.06)); return { w: iw + p * 2, h: ih + p * 2 }; }
            case 'WAX_SEAL': { const p = Math.max(45, Math.round(iw * 0.055)); return { w: iw + p * 2, h: ih + p * 2 }; }
            case 'PRISMATIC': { const p = Math.max(40, Math.round(iw * 0.05)); return { w: iw + p * 2, h: ih + p * 2 }; }
            default:
                return { w: iw + 60, h: ih + 60 };
        }
    }

    // 画布比例(只扩大、不裁切):渲染完成后按目标比例补齐画布,原图水平垂直居中,补边色取四角采样
    // 源图四角平均色。圆角会把全出血成片的四角裁成透明，若仍从成片取样，
    // 补边色就会随着圆角滑块从「照片角部色」变成「scrim 黑」/「兜底白」。
    const _cornerColorCache = new WeakMap();
    function cornerColorOf(src) {
        if (!src) return null;
        const nw = src.naturalWidth || src.width || 0;
        const nh = src.naturalHeight || src.height || 0;
        if (!nw || !nh) return null;
        const hit = _cornerColorCache.get(src);
        if (hit && hit.w === nw && hit.h === nh) return hit.color;
        const c = newCanvas(1, 1);
        const g = c.getContext('2d', { willReadFrequently: true });
        let rs = 0, gs = 0, bs = 0, n = 0;
        for (const [sx, sy] of [[0, 0], [nw - 1, 0], [0, nh - 1], [nw - 1, nh - 1]]) {
            try {
                g.clearRect(0, 0, 1, 1);
                g.drawImage(src, sx, sy, 1, 1, 0, 0, 1, 1);
                const d = g.getImageData(0, 0, 1, 1).data;
                if (d[3] > 60) { rs += d[0]; gs += d[1]; bs += d[2]; n++; }
            } catch (e) { /* 跨域/未解码时跳过该角 */ }
        }
        const color = n > 0 ? 'rgb(' + Math.round(rs / n) + ',' + Math.round(gs / n) + ',' + Math.round(bs / n) + ')' : '#ffffff';
        _cornerColorCache.set(src, { w: nw, h: nh, color });
        return color;
    }

    function expandToRatio(out, ratioStr, img, blurRadius, fillColor) {
        if (!ratioStr || ratioStr === 'original') return out;
        const wh = parseRatio(ratioStr);
        if (!wh || wh[0] <= 0 || wh[1] <= 0) return out;
        const target = wh[0] / wh[1];
        const cur = out.width / out.height;
        let nw = out.width, nh = out.height;
        if (cur > target) nh = Math.max(1, Math.round(out.width / target));
        else nw = Math.max(1, Math.round(out.height * target));
        if (nw <= out.width && nh <= out.height) return out;
        const big = newCanvas(nw, nh);
        const g = big.getContext('2d');
        // 补边:模糊图层直接拉伸填满整张延展画布(等比变形可忽略,模糊后不可感知)
        if (img && img.naturalWidth > 0) {
            const br = Math.max(1, Math.round(blurRadius || 30));
            const pad = Math.ceil(br * 3);
            const sw = nw + pad * 2, sh = nh + pad * 2;
            g.save();
            g.filter = 'blur(' + br + 'px)';
            g.drawImage(img, -pad, -pad, sw, sh);
            g.restore();
        } else {
            // 无照片回退:四角采样平均色
            let rs = 0, gs = 0, bs = 0, n = 0;
            if (!fillColor) {
                const g0 = out.getContext('2d');
                try {
                    const pts = [[0, 0], [out.width - 1, 0], [0, out.height - 1], [out.width - 1, out.height - 1]];
                    for (const [px, py] of pts) {
                        const d = g0.getImageData(Math.max(0, px), Math.max(0, py), 1, 1).data;
                        if (d[3] > 60) { rs += d[0]; gs += d[1]; bs += d[2]; n++; }
                    }
                } catch (e) { /* 忽略 */ }
            }
            g.fillStyle = fillColor || (n > 0 ? 'rgb(' + Math.round(rs / n) + ',' + Math.round(gs / n) + ',' + Math.round(bs / n) + ')' : '#ffffff');
            g.fillRect(0, 0, nw, nh);
        }
        g.drawImage(out, Math.round((nw - out.width) / 2), Math.round((nh - out.height) / 2));
        return big;
    }

    function renderPhotoFrame(app) {
        const t = app.template;
        const styleName = String(t.photoFrameStyle || 'NONE').toUpperCase();
        // 必须走 photoSrc:它是「调色过就取烘焙画布,否则取原图」的唯一入口。
        // 这里曾经直取 app.image.el,结果套了相框样式(带 photoFrameStyle 的预设)后
        // 调色滑块完全不起作用 —— 用户看到的就是"加框后调色没变化"。
        const img = (typeof window.photoSrc === 'function' ? window.photoSrc(app.image) : null) || app.image.el;
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const displayMax = app.displayMax || DISPLAY_MAX;
        const size = scaledSize(img, Math.max(5, t.photoFrameBorderSize || 5));
        const canvas = app.dom.canvas;

        if (styleName === 'NONE') {
            // “原图尺寸/预览”按显示上限封顶;选了 4096/8192 等导出选项时上采样到目标长边
            const exportScale = (typeof app.exportScale === 'number' && app.exportScale > 0) ? app.exportScale : 0;
            const scale = exportScale > 0 ? exportScale / Math.max(iw, ih) : Math.min(1, displayMax / Math.max(iw, ih));
            canvas.width = Math.max(1, Math.round(iw * scale));
            canvas.height = Math.max(1, Math.round(ih * scale));
            canvas._logW = canvas.width;
            canvas._logH = canvas.height;
            const g = canvas.getContext('2d');
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, canvas.width, canvas.height);
            g.save();
            g.scale(scale, scale);
            g.drawImage(img, 0, 0);
            g.restore();
            drawUserElements(g, t, canvas.width, canvas.height);
            // 这张管线是把照片按 scale 铺满画布：照片矩形就是整块基准画布
            app._canvasBaseW = iw;
            app._canvasBaseH = ih;
            app._canvasScale = scale;
            app._photoRect = { x: 0, y: 0, w: iw, h: ih };
            app.applyZoomStyle();
            return;
        }

    // 富士水印: 白底+照片(支持缩放/偏移,放大可盖过白边)+底部品牌名+参数
    function styleFujifilm(img, size, g, iw, ih, S, withBrand, showParams) { showParams = showParams !== false;
        const outerPad = Math.max(15, Math.round(size * 0.5));
        const w = iw + outerPad * 2;
        const h = ih + outerPad * 2;
        // 白外底
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        // 照片完整显示(支持缩放/偏移):不垫深色卡底——照片缩小/偏移后露出的是白底(与「参数横条」一致);
        // 放大时可盖过白边、裁切边界=画布外沿(旧实现被裁在卡片矩形内,白边永远在、缩小露深蓝 #0d1b2a)
        const cx = outerPad, cy = outerPad;
        const photoCr = Math.min(S.cornerAll || 0, Math.min(iw, ih) / 2);
        const sc = S.imgScale || 1;
        const dw = iw * sc, dh = ih * sc;
        const dx = cx + (iw - dw) / 2 + (S.imgOffsetX || 0);
        const dy = cy + (ih - dh) / 2 + (S.imgOffsetY || 0);
        g.save();
        // 有圆角时裁到照片自身矩形(圆角跟着照片走);无圆角不裁,溢出交给画布外沿
        if (photoCr > 0 && typeof g.roundRect === 'function') { g.beginPath(); g.roundRect(dx, dy, dw, dh, photoCr); g.clip(); }
        g.drawImage(img, dx, dy, dw, dh);
        g.restore();
        // 文字大小(从面板参数):参数字号 × 参数缩放;品牌字再乘 品牌大小(近印象系列映射)
        const fParam = Math.max(12, Math.round((S.paramFs || iw * 0.035) * (S.paramScale || 1)));
        const fBrand = Math.max(16, Math.round(fParam * 1.3 * (S.brandScale || 1)));
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        const bottomPad = Math.max(20, Math.round(ih * 0.06));
        // 文字锚点跟着照片下沿走(照片缩小时白字仍落在照片上);放大时取「原卡片下沿」与「照片下沿」的中点=下沉量减半
        let ty = (Math.min(cy + ih, dy + dh) + dy + dh) / 2 - bottomPad;
        if (withBrand && S.cam && !brandHidden(S)) {
            // 品牌字体/配色与「相机参数水印」统一:Times New Roman + 品牌自动色;参数行不变。
            g.font = brandFont(fBrand, 700);
            g.letterSpacing = Math.round(fBrand * 0.15);
            g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 6;
            const brand = prettyBrand(S.cam.brand || 'FUJIFILM') || 'FUJIFILM';
            g.fillStyle = brandInk(brand, true);
            // 无参数时品牌直接画在底部
            g.textAlign = 'left';
            const by = showParams ? ty - fParam * 1.5 : ty;
            const bw = g.measureText(brand).width;
            const lw = brandMarkW(S, fBrand);
            const onlyLogo = (S.brandLogo === 2 && lw > 0);
            const x0 = Math.round(w / 2 - (onlyLogo ? brandMarkNetW(S, fBrand) : bw + lw) / 2);
            const lwUsed = drawBrandMark(g, S, x0, by, fBrand);
            if (!onlyLogo) g.fillText(brand, x0 + lwUsed, by);
            g.letterSpacing = 0;
            g.shadowBlur = 0;
            g.textAlign = 'center';
        }
        if (showParams && S.useExif && S.cam) {
            const fLen = String(S.cam.focal || '450').replace(/mm$/i, '');
            const apt = String(S.cam.aperture || 'F6.3').replace(/^f\//i, 'F');
            const shut = String(S.cam.shutter || '1/125').replace(/s$/i, '');
            const iso = String(S.cam.iso || '100').replace(/^iso/i, '');
            const line = fLen + 'mm   ' + apt + '   ' + shut + 's   ISO' + iso;
            g.font = 'italic bold ' + fParam + 'px sans-serif';
            g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 6;
            g.fillStyle = '#ffffff';
            g.fillText(line, w / 2, ty);
            g.shadowBlur = 0;
        }
    }

    // ══ 画廊留白:一副“挂在画廊白墙上”的作品——深木画框+金色fillet+大留白+白底展签牌 ══
    function styleGalleryMat(img, size, g, iw, ih, S) {
        const ref = Math.min(iw, ih);
        const mat = Math.max(70, Math.round(ref * 0.09));      // 四周墙面大留白
        const frameW = Math.max(12, Math.round(ref * 0.018));  // 深色木框宽
        const fillet = Math.max(2, Math.round(ref * 0.003));   // 金色内衬线
        const gap = Math.max(2, Math.round(ref * 0.002));      // 照片→金线间隙
        const labelH = Math.max(72, Math.round(mat * 0.8));    // 展签牌区
        const inner = gap + fillet + frameW;                   // 照片外侧装饰总宽
        const w = iw + inner * 2 + mat * 2;
        const h = ih + inner * 2 + mat * 2 + labelH;
        // 1) 墙面:暖灰白(画廊白墙,略含暖色)
        g.fillStyle = '#efece5';
        g.fillRect(0, 0, w, h);
        // 照片实际绘制区(支持右侧卡缩放/偏移)
        const sc = (S && S.imgScale) || 1;
        const dw = iw * sc, dh = ih * sc;
        const px = mat + inner + (iw - dw) / 2 + ((S && S.imgOffsetX) || 0);
        const py = mat + inner + (ih - dh) / 2 + ((S && S.imgOffsetY) || 0);
        const frameL = px - gap - fillet - frameW;
        const frameT = py - gap - fillet - frameW;
        const frameR = px + dw + gap + fillet + frameW;
        const frameB = py + dh + gap + fillet + frameW;
        // 2) 整幅挂画投影(框+照片一体浮在墙上)
        g.save();
        g.shadowColor = 'rgba(40,35,28,0.30)';
        g.shadowBlur = Math.max(16, Math.round(ref * 0.02));
        g.shadowOffsetY = Math.max(6, Math.round(ref * 0.006));
        g.fillStyle = '#efece5';
        g.fillRect(frameL, frameT, frameR - frameL, frameB - frameT);
        g.restore();
        // 3) 深色画框(画廊木框黑)
        g.fillStyle = '#33302b';
        g.fillRect(frameL, frameT, frameR - frameL, frameB - frameT);
        // 4) 金色 fillet 内衬线
        g.fillStyle = '#b8a06a';
        g.fillRect(frameL + frameW, frameT + frameW, frameR - frameL - frameW * 2, frameB - frameT - frameW * 2);
        // 5) 照片(圆角由入口劫持自动应用)
        g.drawImage(img, px, py, dw, dh);
        // 6) 画廊展签牌:白底小卡+细边,挂在画框正下方
        const fs = Math.max(10, Math.round(mat * 0.11));
        const label = 'MOMENTS \u00b7 2026 \u00b7 No.01';
        g.font = '400 ' + fs + "px Georgia, 'Times New Roman', serif";
        const tw = Math.round(g.measureText(label).width + fs * 2.2);
        const lw2 = Math.max(88, tw), lh2 = Math.max(34, Math.round(fs * 1.7));
        const lx = Math.round((w - lw2) / 2);
        const ly = mat + inner + ih + inner + Math.round((labelH - lh2) / 2);
        g.fillStyle = '#fffefa';
        g.strokeStyle = 'rgba(150,140,120,0.6)';
        g.lineWidth = 1;
        g.beginPath(); g.rect(lx, ly, lw2, lh2); g.fill(); g.stroke();
        g.fillStyle = '#5a554b';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(label, lx + lw2 / 2, ly + lh2 / 2 + 1);
        g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    }

    // ══ 参数横条:暖纸卡 + 细边框照片 + 底部深色参数轨 ══
    // 与旧版“整块白底 + 超大字一行 EXIF”不同:把参数拆成四列可读的技术标签,
    // 品牌/机型占左侧,拍摄参数占右侧;上方留一条很小的接触印样信息。
    function styleParamStrip(img, size, g, iw, ih, S) {
        const G = paramStripGeom(iw, ih, size);
        const { ref, pad, top, gap, barH, w, h, photoX, photoY, barY } = G;
        const paperTop = '#f5f1e8', paperBottom = '#e9e2d4';
        const cream = '#f5f1e8', muted = '#8e897e', accent = '#c45d38';
        const barBg = '#1b1c19';

        // 1) 暖纸底:轻微纵向渐变,避免整块死白
        const bg = g.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, paperTop);
        bg.addColorStop(1, paperBottom);
        g.fillStyle = bg;
        g.fillRect(0, 0, w, h);

        // 2) 顶部接触印样信息
        const headerFs = Math.max(8, Math.round(ref * 0.0125));
        const headerY = Math.round(top * 0.55);
        const mark = Math.max(5, Math.round(headerFs * 0.62));
        g.fillStyle = accent;
        g.fillRect(pad, headerY - mark, mark, mark);
        g.fillStyle = muted;
        g.font = '600 ' + headerFs + 'px "Courier New", monospace';
        g.letterSpacing = Math.max(1, Math.round(headerFs * 0.18)) + 'px';
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.fillText('CONTACT SHEET', pad + mark + Math.round(headerFs * 0.9), headerY);
        g.letterSpacing = '0px';
        g.fillStyle = muted;
        g.font = '400 ' + headerFs + 'px "Courier New", monospace';
        g.textAlign = 'right';
        g.fillText('FRAME 01', w - pad, headerY);
        g.textAlign = 'left';

        // 细分隔线,像一张压在纸上的印样
        g.fillStyle = 'rgba(23,24,21,0.16)';
        g.fillRect(pad, top - Math.max(5, Math.round(gap * 0.35)), w - pad * 2, 1);

        // 3) 照片:细边框 + 很轻的纸面投影(缩放/偏移仍按面板能力生效)
        const sc = (S && S.imgScale) || 1;
        const dw = iw * sc, dh = ih * sc;
        const dx = photoX + (iw - dw) / 2 + ((S && S.imgOffsetX) || 0);
        const dy = photoY + (ih - dh) / 2 + ((S && S.imgOffsetY) || 0);
        const arc = Math.max(0, Math.min(Math.round((S && S.cornerAll) || 0), Math.floor(Math.min(iw, ih) / 2)));

        g.save();
        g.shadowColor = 'rgba(35,30,22,0.24)';
        g.shadowBlur = Math.max(8, Math.round(ref * 0.018));
        g.shadowOffsetY = Math.max(3, Math.round(ref * 0.006));
        g.fillStyle = paperBottom;
        if (arc > 0) {
            roundRectPath(g, photoX, photoY, iw, ih, arc);
            g.fill();
        } else {
            g.fillRect(photoX, photoY, iw, ih);
        }
        g.restore();

        g.save();
        if (arc > 0) {
            roundRectPath(g, photoX, photoY, iw, ih, arc);
            g.clip();
        } else {
            g.beginPath();
            g.rect(photoX, photoY, iw, ih);
            g.clip();
        }
        g.fillStyle = '#d8d0c0';
        g.fillRect(photoX, photoY, iw, ih);
        g.imageSmoothingEnabled = true;
        g.drawImage(img, dx, dy, dw, dh);
        g.restore();

        g.save();
        g.strokeStyle = 'rgba(23,24,21,0.82)';
        g.lineWidth = Math.max(1, Math.round(ref * 0.0015));
        if (arc > 0) {
            roundRectPath(g, photoX + 0.5, photoY + 0.5, iw - 1, ih - 1, Math.max(0, arc - 0.5));
            g.stroke();
        } else {
            g.strokeRect(photoX + 0.5, photoY + 0.5, iw - 1, ih - 1);
        }
        g.restore();

        // 4) 底部参数轨:深色横条,左品牌、右四列参数
        g.fillStyle = barBg;
        g.fillRect(0, barY, w, barH);
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(0, barY, w, 1);

        const pfBase = (S && Number(S.paramFs) > 0) ? Number(S.paramFs) : 35;
        const pfScale = Math.max(0.75, Math.min(1.8, pfBase / 35)) *
            Math.max(0.6, Math.min(1.8, (S && Number(S.paramScale)) || 1));
        const labelFs = Math.max(8, Math.round(ref * 0.0125 * Math.min(1.6, pfScale)));
        const valueFs = Math.max(14, Math.round(ref * 0.027 * pfScale));
        const brandFs = Math.max(16, Math.round(ref * 0.031));
        const modelFs = Math.max(10, Math.round(ref * 0.016));
        const contentW = w - pad * 2;
        const leftW = Math.round(contentW * 0.27);
        const dividerX = pad + leftW;
        const statsX = dividerX + Math.max(18, Math.round(ref * 0.032));
        const statsW = Math.max(1, w - pad - statsX);

        // 左侧橙色定位线 + CAMERA / 品牌 / 机型
        const accentW = Math.max(3, Math.round(ref * 0.0045));
        const accentX = pad;
        g.fillStyle = accent;
        g.fillRect(accentX, barY + Math.round(barH * 0.25), accentW, Math.round(barH * 0.50));
        const brandX = accentX + accentW + Math.max(10, Math.round(ref * 0.018));
        const brand = prettyBrand(String((S && S.cam && S.cam.brand) || '').trim()) || 'CAMERA';
        const model = String((S && S.cam && S.cam.model) || '').trim();

        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.fillStyle = muted;
        g.font = '600 ' + labelFs + 'px "Courier New", monospace';
        g.letterSpacing = Math.max(1, Math.round(labelFs * 0.6)) + 'px';
        g.fillText('CAMERA', brandX, barY + Math.round(barH * 0.30));
        g.letterSpacing = '0px';

        const brandMaxW = Math.max(20, leftW - (brandX - pad) - Math.round(ref * 0.012));
        let brandFit = brandFs;
        let brandTrack = Math.max(1, Math.round(brandFit * 0.045));
        while (brandFit > 9 && brandTextWidth(g, brand, brandFit, brandTrack) > brandMaxW) {
            brandFit--;
            brandTrack = Math.max(1, Math.round(brandFit * 0.045));
        }
        g.fillStyle = brandInk(brand, true);
        g.font = brandFont(brandFit, 700);
        g.letterSpacing = brandTrack + 'px';
        g.fillText(brand, brandX, barY + Math.round(barH * 0.57));
        g.letterSpacing = '0px';

        const modelText = model || 'NO MODEL';
        const modelFit = fitFont(g, modelText, true, false, modelFs,
            Math.max(20, leftW - (brandX - pad) - Math.round(ref * 0.012)), 0);
        g.fillStyle = muted;
        g.font = '400 ' + modelFit + 'px "Courier New", monospace';
        g.letterSpacing = Math.max(1, Math.round(modelFit * 0.10)) + 'px';
        g.fillText(modelText, brandX, barY + Math.round(barH * 0.77));
        g.letterSpacing = '0px';

        // 分隔线
        g.fillStyle = 'rgba(255,255,255,0.14)';
        g.fillRect(dividerX, barY + Math.round(barH * 0.25), 1, Math.round(barH * 0.50));

        // 参数列
        const stats = paramStripStats(S && S.cam, S ? S.paramType : 0);
        const cols = stats.length;
        const colW = statsW / Math.max(1, cols);
        const baseStatFs = cols >= 4 ? valueFs : Math.max(valueFs + 4, Math.round(ref * 0.036));
        const statLabelY = barY + Math.round(barH * 0.36);
        const statValueY = barY + Math.round(barH * 0.67);
        // 标签是带字距的全大写词,不能再只按“裸字宽”去 fitFont:窄列里字距会把
        // APERTURE / SHUTTER 顶到相邻列。这里统一把字号和字距一起收紧。
        const statLabelMaxW = colW * 0.78;
        let statLabelFs = Math.max(6, labelFs);
        let statLabelTrack = Math.max(1, Math.round(statLabelFs * 0.55));
        g.letterSpacing = '0px';
        const widestStatLabelW = () => {
            let mw = 0;
            for (const st of stats) {
                mw = Math.max(mw, textMetrics(g, st.label, statLabelFs, false, true, statLabelTrack).w);
            }
            return mw;
        };
        while (widestStatLabelW() > statLabelMaxW) {
            if (statLabelTrack > 0) {
                statLabelTrack--;
            } else if (statLabelFs > 6) {
                statLabelFs--;
                statLabelTrack = Math.max(1, Math.round(statLabelFs * 0.55));
            } else {
                break;
            }
        }
        for (let i = 0; i < cols; i++) {
            if (i > 0) {
                g.fillStyle = 'rgba(255,255,255,0.10)';
                g.fillRect(Math.round(statsX + colW * i) - Math.round(ref * 0.012), barY + Math.round(barH * 0.27), 1, Math.round(barH * 0.46));
            }
            const x = Math.round(statsX + colW * i);
            const valueFsFit = fitFont(g, stats[i].value, true, true, baseStatFs, colW * 0.82, 0);
            g.textAlign = 'left';
            g.fillStyle = muted;
            g.font = '600 ' + statLabelFs + 'px "Courier New", monospace';
            g.letterSpacing = statLabelTrack + 'px';
            g.fillText(stats[i].label, x, statLabelY);
            g.letterSpacing = '0px';

            g.fillStyle = cream;
            g.font = '600 ' + valueFsFit + 'px "Courier New", monospace';
            g.fillText(stats[i].value, x, statValueY);
        }
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
    }

    function paramStripStats(cam, paramType) {
        const c = cam || {};
        const raw = v => String(v == null ? '' : v).trim();
        const focal = raw(c.focal) ? raw(c.focal).replace(/\s*mm$/i, '') + 'mm' : '—';
        let aperture = raw(c.aperture).replace(/^[fFƒ]\s*/, '').replace(/^\//, '');
        if (aperture) aperture = 'f/' + aperture;
        let shutter = raw(c.shutter).replace(/\s*秒$/, '');
        if (shutter && !/s$/i.test(shutter)) shutter += 's';
        const iso = raw(c.iso).replace(/^ISO\s*/i, '') || '—';
        const all = [
            { label: 'FOCAL', value: focal },
            { label: 'APERTURE', value: aperture || '—' },
            { label: 'SHUTTER', value: shutter || '—' },
            { label: 'ISO', value: iso },
        ];
        if (paramType === 1) return all.slice(0, 2);
        if (paramType === 2) return [{ label: 'DATE', value: dateYMD().replace(/\./g, ' / ') }];
        return all;
    }


    // ══ 赛博故障风 ══
    function styleCyberGlitch(img, size, g, iw, ih) {
        const pad = Math.max(40, Math.round(iw * 0.04));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#0a0a0f'; g.fillRect(0, 0, w, h);
        // RGB色偏(加强)
        g.save();
        g.drawImage(img, pad, pad);
        g.globalCompositeOperation = 'screen';
        g.globalAlpha = 0.7;
        g.fillStyle = 'rgba(255,0,64,0.6)';
        g.drawImage(img, pad - 6, pad);
        g.globalAlpha = 0.7;
        g.fillStyle = 'rgba(0,255,255,0.6)';
        g.drawImage(img, pad + 6, pad);
        g.restore();
        // 扫描线
        g.fillStyle = 'rgba(0,0,0,0.2)';
        for (let y = pad; y < pad + ih; y += 4) g.fillRect(pad, y, iw, 2);
        // 错位条(更明显)
        for (let i = 0; i < 12; i++) {
            const by = pad + Math.floor(Math.random() * ih);
            const bh = Math.floor(Math.random() * 15) + 3;
            const off = Math.floor(Math.random() * 40) - 20;
            g.drawImage(img, pad, by, iw, bh, pad + off, by, iw, bh);
        }
        // 噪点
        for (let i = 0; i < 400; i++) {
            g.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.4) + ')';
            g.fillRect(pad + Math.random() * iw, pad + Math.random() * ih, 2, 2);
        }
        // REC红点+时间码(大字)
        g.fillStyle = '#ff0040';
        g.beginPath(); g.arc(pad + 25, pad + 30, 10, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#00ff88';
        g.font = 'bold 20px monospace';
        g.textAlign = 'left';
        g.fillText('● REC  12:34:56', pad + 45, pad + 37);
    }

    // ══ 拍立得手写风 ══
    function stylePolaroidHand(img, size, g, iw, ih, S) {
        const border = Math.max(24, Math.round(iw * 0.06));
        const bottomPad = Math.max(60, Math.round(iw * 0.2));
        const w = iw + border * 2, h = ih + border + bottomPad;
        // 白色相纸
        g.fillStyle = '#fefefe'; g.fillRect(0, 0, w, h);
        // 照片
        g.drawImage(img, border, border, iw, ih);
        // 底部手写日期
        // 字号原来硬编码 18px,而 border / bottomPad 都跟着 iw 缩放 —— 图越大字越小:
        // 18px 在 800px 图上占白条 16%,到 4000px 图只剩 3.2%,基本看不见。
        // 改为按照片下方**实际**白条高度取(白条高度 = 画布高 - 照片下缘,自动吸收
        // styleDims 与本函数 border/bottomPad 两处口径不同的历史差异),不会溢出画布。
        const bandH = h - (border + ih);
        const dateFs = Math.max(18, Math.round(bandH * 0.25));
        const dateTxt = (S && S.polaroidCaption) ? S.polaroidCaption : new Date().toLocaleDateString('zh-CN');
        let hfs = dateFs;
        g.font = 'italic ' + hfs + 'px "Comic Sans MS", cursive';
        const hw = g.measureText(dateTxt).width;
        if (hw > w * 0.7 && hfs > 10) hfs = Math.max(10, Math.floor(hfs * (w * 0.7) / hw));
        const baseY = border + ih + Math.round(bandH * 0.55);
        g.fillStyle = '#333';
        g.font = 'italic ' + hfs + 'px "Comic Sans MS", cursive';
        g.textAlign = 'center';
        g.save();
        g.translate(w / 2, baseY);
        g.rotate(-0.03);
        g.fillText(dateTxt, 0, 0);
        g.restore();
        // 小爱心装饰:贴在日期右端外侧,半径随字号缩放
        // (原来固定 +80px / r=4,字号一大就陷进文字里了)
        const heartR = Math.max(4, Math.round(dateFs * 0.22));
        g.fillStyle = '#ff6b9d';
        g.beginPath();
        g.arc(w / 2 + g.measureText(dateTxt).width / 2 + heartR * 3, baseY - dateFs * 0.3, heartR, 0, Math.PI * 2);
        g.fill();
    }

    // ══ 撕纸手账风:牛皮纸页 + 撕边白纸贴照片 + 和纸胶带 + 手写批注 ══
    function styleTornJournal(img, size, g, iw, ih) {
        const rnd = styleNoise(iw, ih, 521);
        const pad = Math.max(44, Math.round(iw * 0.05));
        const w = iw + pad * 2, h = ih + pad * 2;
        const sx = pad, sy = pad, sw = iw, sh = ih;
        const cx = sx + sw / 2, cy = sy + sh / 2;
        // 牛皮纸底(纵向渐变 + 四周暗角)
        const grad = g.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#f1e6cf');
        grad.addColorStop(0.5, '#e7d8b8');
        grad.addColorStop(1, '#d8c5a1');
        g.fillStyle = grad;
        g.fillRect(0, 0, w, h);
        // 纸纤维纹理(确定性噪声)
        for (let i = 0; i < 200; i++) {
            g.fillStyle = (i % 3) ? 'rgba(139,110,65,0.10)' : 'rgba(255,252,240,0.08)';
            g.fillRect(rnd(w), rnd(h), 3 + rnd(9), rnd(3) ? 1 : 2);
        }
        const vign = g.createRadialGradient(cx, cy, Math.min(sw, sh) * 0.4, cx, cy, Math.max(w, h) * 0.75);
        vign.addColorStop(0, 'rgba(0,0,0,0)');
        vign.addColorStop(1, 'rgba(90,60,25,0.16)');
        g.fillStyle = vign;
        g.fillRect(0, 0, w, h);
        // 撕边白纸片;照片略小于纸片即得毛边留白
        const amp = Math.max(8, Math.round(Math.min(iw, ih) * 0.032));
        const hole = tornHolePath(rnd, iw, ih, amp);
        g.save();
        g.translate(cx, cy);
        g.scale(1.05, 1.05);
        g.shadowColor = 'rgba(40,25,10,0.30)';
        g.shadowBlur = 16;
        g.shadowOffsetX = 2;
        g.shadowOffsetY = 4;
        g.fillStyle = '#fdfcf6';
        g.fill(hole);
        g.restore();
        // 照片裁进撕边孔,孔内缘留一点碎纸白
        g.save();
        g.translate(cx, cy);
        g.clip(hole);
        g.drawImage(img, -iw / 2, -ih / 2, iw, ih);
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = 3;
        g.stroke(hole);
        g.restore();
        // 和纸胶带(圆头,微旋,压住照片边缘)
        const tape = (tx, ty, tw, th, rot, col) => {
            g.save();
            g.translate(tx, ty);
            g.rotate(rot * Math.PI / 180);
            g.fillStyle = 'rgba(0,0,0,0.14)';
            fillRoundRectCtx(g, -tw / 2 + 1, -th / 2 + 3, tw, th, th / 2);
            g.fillStyle = col;
            fillRoundRectCtx(g, -tw / 2, -th / 2, tw, th, th / 2);
            g.restore();
        };
        tape(cx - sw * 0.33, sy - 2, 88 + iw * 0.04, 26, -9, 'rgba(222,193,112,0.72)');
        tape(cx + sw * 0.30, sy + sh - 2, 80 + iw * 0.04, 24, 9, 'rgba(129,161,140,0.5)');
        // 手写批注 + 横线(照片下方牛皮纸留白)
        const noteY = sy + sh + Math.round(pad * 0.42);
        g.fillStyle = 'rgba(120,86,52,0.5)';
        g.fillRect(cx - Math.min(sw, 560) / 2, noteY - 1, Math.min(sw, 560), 1.5);
        g.fillStyle = 'rgba(122,90,58,0.85)';
        g.font = Math.max(16, Math.round(pad * 0.5)) + 'px "Segoe Script","Comic Sans MS",cursive';
        g.textAlign = 'center';
        g.fillText(['开心的一天', '随手记一笔', '舍不得的风景', '老地方,老味道'][rnd(4)], cx, noteY - 8);
        // 小点缀:右上角圆贴纸
        g.fillStyle = 'rgba(210,132,116,0.5)';
        g.beginPath();
        g.arc(sx + sw + 14, sy + 14, 11, 0, 6.2832);
        g.fill();
    }

    // ══ 3D卡片翻转 ══
    function styleCard3D(img, size, g, iw, ih, S) {
        // 私有参数:字段缺省时 spNum 返回 legacy(原来的字面量),换算与 style-params.js
        // 的 apply 同构(UI 百分数 / 100)。声明表本身不参与渲染,所以 design/regress.html
        // 只加载引擎时也能照常出图。
        const SP = (S && S.styleParams) || {};
        const spNum = (k, legacy) => {
            const v = SP[k];
            if (v == null) return legacy;
            const n = Number(v);
            return (isFinite(n) ? Math.max(-1000, Math.min(1000, n)) : legacy * 100) / 100;
        };
        const padX = Math.round(iw * spNum('padX', 0.18));
        const padTop = Math.round(iw * 0.1);
        const padBottom = Math.round(iw * spNum('padBottom', 0.2));
        const w = iw + padX * 2, h = ih + padTop + padBottom;
        const cx = padX, cy = padTop;
        const thick = Math.max(16, Math.round(iw * spNum('thick', 0.025)));
        const shK = spNum('shadow', 1);
        const cr = Math.max(10, Math.round(iw * 0.006));
        // 冷灰黑桌面渐变
        const grad = g.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#34343e');
        grad.addColorStop(1, '#17171d');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
        // 桌面微弱网格(空间感)
        g.strokeStyle = 'rgba(255,255,255,0.05)';
        g.lineWidth = 1;
        const gs = Math.round(iw * 0.06);
        for (let gx = gs; gx < w; gx += gs) { g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, h); g.stroke(); }
        for (let gy = gs; gy < h; gy += gs) { g.beginPath(); g.moveTo(0, gy); g.lineTo(w, gy); g.stroke(); }
        // 三层递进悬浮投影
        const shadowLayers = [
            { ox: Math.round(iw * 0.06), oy: Math.round(iw * 0.09), blur: Math.round(iw * 0.05), color: 'rgba(0,0,0,0.55)' },
            { ox: Math.round(iw * 0.035), oy: Math.round(iw * 0.05), blur: Math.round(iw * 0.028), color: 'rgba(0,0,0,0.45)' },
            { ox: Math.round(iw * 0.012), oy: Math.round(iw * 0.018), blur: Math.round(iw * 0.012), color: 'rgba(0,0,0,0.38)' }
        ];
        g.save();
        if (shK > 0) {
            for (const L of shadowLayers) {
                g.shadowColor = L.color;
                g.shadowBlur = L.blur * shK;
                g.shadowOffsetX = L.ox * shK;
                g.shadowOffsetY = L.oy * shK;
                g.fillStyle = '#000000';
                fillRoundRectCtx(g, cx, cy, iw, ih, cr);
            }
        }
        g.restore();
        // 卡片厚度(右下露出, 渐变灰)
        const tGrad = g.createLinearGradient(cx, cy, cx + iw, cy + ih);
        tGrad.addColorStop(0, '#dcdce2');
        tGrad.addColorStop(0.75, '#b9b9c2');
        tGrad.addColorStop(1, '#9c9ca6');
        g.fillStyle = tGrad;
        fillRoundRectCtx(g, cx + thick, cy + thick, iw, ih, cr);
        // 白色正面卡
        g.fillStyle = '#ffffff';
        fillRoundRectCtx(g, cx, cy, iw, ih, cr);
        // 卡面顶部高光(光线反射)
        const hl = g.createLinearGradient(0, cy, 0, cy + Math.round(ih * 0.22));
        hl.addColorStop(0, 'rgba(255,255,255,0.55)');
        hl.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = hl;
        fillRoundRectCtx(g, cx, cy, iw, Math.round(ih * 0.22), cr);
        // 照片(圆角裁剪)贴卡面上部
        const m = Math.max(20, Math.round(iw * 0.02));
        const pw = iw - m * 2;
        const ph = Math.round(ih * 0.80);
        const pxx = cx + m, pyy = cy + m;
        g.save();
        g.beginPath();
        if (g.roundRect) { g.roundRect(pxx, pyy, pw, ph, cr); }
        else {
            g.moveTo(pxx + cr, pyy); g.lineTo(pxx + pw - cr, pyy);
            g.arcTo(pxx + pw, pyy, pxx + pw, pyy + cr, cr);
            g.lineTo(pxx + pw, pyy + ph - cr);
            g.arcTo(pxx + pw, pyy + ph, pxx + pw - cr, pyy + ph, cr);
            g.lineTo(pxx + cr, pyy + ph);
            g.arcTo(pxx, pyy + ph, pxx, pyy + ph - cr, cr);
            g.lineTo(pxx, pyy + cr);
            g.arcTo(pxx, pyy, pxx + cr, pyy, cr);
        }
        g.closePath();
        g.clip();
        g.drawImage(img, pxx, pyy, pw, ph);
        g.restore();
        // 照片细描边
        g.strokeStyle = 'rgba(0,0,0,0.10)';
        g.lineWidth = 1;
        if (g.roundRect) { g.beginPath(); g.roundRect(pxx, pyy, pw, ph, cr); g.stroke(); }
        else { g.beginPath(); g.rect(pxx, pyy, pw, ph); g.stroke(); }
        // 签名行(照片下方居中, 跟随右侧栏签名设置: userSignature/signFont/signColor/signSize)
        const sigStr3 = (S && S.userSignature) ? String(S.userSignature) : '';
        g.fillStyle = (S && S.signColor) || '#8a8a92';
        g.font = 'italic ' + Math.round(iw * 0.02 * ((S && S.signSize) || 1)) + 'px "' + ((S && S.signFont) || 'Courier New') + '", cursive';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(sigStr3, cx + iw / 2, cy + m + ph + Math.round((ih - m * 2 - ph) / 2));
    }

    // ══ 漫画分镜 ══
    // 与 styleDims('COMIC_PANEL') 保持同一套尺寸(gap=round(0.015*iw),底部条=round(iw*0.08)),
    // 保证画面内容不超出画布(修复原实现在固定 gap=8 / +60 下右、下被裁切的问题);
    // 2×2 照片网格整体在画布中水平垂直居中
    function styleComicPanel(img, size, g, iw, ih) {
        const gap = Math.round(iw * 0.015);
        const barH = Math.round(iw * 0.08);
        const cols = 2, rows = 2;
        const w = iw + gap * 3, h = ih + gap * 3 + barH;
        const cw = Math.floor(iw / cols), ch = Math.floor(ih / rows);
        // 波普黄底
        g.fillStyle = '#ffe600'; g.fillRect(0, 0, w, h);
        // 背景红色波点(错位排列)
        const dotR = Math.max(6, Math.round(iw * 0.006));
        const dotGap = dotR * 3;
        g.fillStyle = 'rgba(255,45,45,0.85)';
        for (let y = -dotGap; y < h + dotGap; y += dotGap) {
            const off = (Math.round(y / dotGap) % 2) ? dotGap / 2 : 0;
            for (let x = -dotGap; x < w + dotGap; x += dotGap) {
                g.beginPath(); g.arc(x + off, y, dotR, 0, 6.2832); g.fill();
            }
        }
        // 网格在上部区域(不含底部黑条)水平垂直居中
        const gridW = cw * cols + gap, gridH = ch * rows + gap;
        const topH = h - barH;
        const x0 = Math.round((w - gridW) / 2), y0 = Math.round((topH - gridH) / 2);
        // 四格: 照片叠黑色半调网点 + 白3px内框 + 黑4px外框
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x = x0 + c * (cw + gap), y = y0 + r * (ch + gap);
                const cvs = document.createElement('canvas');
                cvs.width = cw; cvs.height = ch;
                const cx = cvs.getContext('2d');
                drawPhotoRegion(cx, img, iw, ih, c * cw, r * ch, cw, ch, 0, 0, cw, ch);
                const dr2 = Math.max(2, Math.round(cw * 0.004));
                cx.fillStyle = 'rgba(0,0,0,0.18)';
                for (let py = 0; py < ch; py += dr2 * 3) {
                    for (let px = 0; px < cw; px += dr2 * 3) {
                        cx.beginPath(); cx.arc(px, py, dr2, 0, 6.2832); cx.fill();
                    }
                }
                g.drawImage(cvs, x, y);
                g.strokeStyle = '#fff'; g.lineWidth = 3;
                g.strokeRect(x - 2, y - 2, cw + 4, ch + 4);
                g.strokeStyle = '#111'; g.lineWidth = 4;
                g.strokeRect(x - 5, y - 5, cw + 10, ch + 10);
            }
        }
        // 拟声词贴纸(白字黑描边)
        const bang = (txt, bx, by, fs) => {
            g.save();
            g.font = 'bold ' + fs + 'px "Impact", "Arial Black", sans-serif';
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.lineJoin = 'round';
            g.strokeStyle = '#111'; g.lineWidth = Math.max(3, Math.round(fs * 0.16));
            g.strokeText(txt, bx, by);
            g.fillStyle = '#fff';
            g.fillText(txt, bx, by);
            g.restore();
        };
        const fs1 = Math.round(cw * 0.13);
        bang('POW!', x0 + cw - Math.round(cw * 0.12), y0 + Math.round(ch * 0.13), fs1);
        bang('BANG!', x0 + cw * 2 + gap - Math.round(cw * 0.12), y0 + ch + gap + Math.round(ch * 0.13), fs1);
        // WOW! 白色对话气泡(右上格左下角)
        const bubble = (txt, bx, by, fs) => {
            g.save();
            g.font = 'bold ' + fs + 'px "Impact", "Arial Black", sans-serif';
            const bw = g.measureText(txt).width + fs * 1.1, bh = fs * 1.7;
            g.fillStyle = '#fff';
            g.strokeStyle = '#111';
            g.lineWidth = Math.max(2, Math.round(fs * 0.12));
            g.beginPath(); g.ellipse(bx, by, bw / 2, bh / 2, -0.12, 0, 6.2832); g.fill(); g.stroke();
            g.beginPath();
            g.moveTo(bx - bw * 0.10, by + bh * 0.40);
            g.lineTo(bx - bw * 0.34, by + bh * 0.88);
            g.lineTo(bx + bw * 0.06, by + bh * 0.42);
            g.closePath(); g.fill(); g.stroke();
            g.fillStyle = '#111';
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(txt, bx + fs * 0.02, by + fs * 0.05);
            g.restore();
        };
        bubble('WOW!', x0 + cw + gap + Math.round(cw * 0.24), y0 + Math.round(ch * 0.24), Math.round(cw * 0.085));
        // 底部 POP ART 黑条
        g.fillStyle = '#111';
        g.fillRect(0, h - barH, w, barH);
        g.fillStyle = '#ffe600';
        g.font = 'bold ' + Math.max(13, Math.round(barH * 0.45)) + 'px "Impact", "Arial Black", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('POP ART ★ ' + new Date().getFullYear(), w / 2, h - barH / 2);
        // 红黑双外框
        g.strokeStyle = '#111'; g.lineWidth = 6;
        g.strokeRect(3, 3, w - 6, h - 6);
        g.strokeStyle = '#ff4500'; g.lineWidth = 2.5;
        g.strokeRect(10, 10, w - 20, h - 20);
    }

    // ══ 波普漫画风(2026-10): 单张大照片+波普黄底红波点+半调网点+拟声词气泡+POP ART底部条 ──
    function stylePopComic(img, size, g, iw, ih) {
        const pad = Math.max(50, Math.round(iw * 0.05));
        const barH = Math.round(iw * 0.07);
        const w = iw + pad * 2, h = ih + pad * 2 + barH;
        // 波普黄底
        g.fillStyle = '#ffe600'; g.fillRect(0, 0, w, h);
        // 背景红色波点(错位排列)
        const dotR = Math.max(6, Math.round(iw * 0.006));
        const dotGap = dotR * 3;
        g.fillStyle = 'rgba(255,45,45,0.85)';
        for (let y = -dotGap; y < h + dotGap; y += dotGap) {
            const off = (Math.round(y / dotGap) % 2) ? dotGap / 2 : 0;
            for (let x = -dotGap; x < w + dotGap; x += dotGap) {
                g.beginPath(); g.arc(x + off, y, dotR, 0, 6.2832); g.fill();
            }
        }
        // 照片在上半区域居中
        const topH = h - barH;
        const px = Math.round((w - iw) / 2), py = Math.round((topH - ih) / 2);
        // 照片叠黑色半调网点
        const cvs = document.createElement('canvas');
        cvs.width = iw; cvs.height = ih;
        const cx = cvs.getContext('2d');
        cx.drawImage(img, 0, 0, iw, ih);
        const dr2 = Math.max(2, Math.round(iw * 0.004));
        cx.fillStyle = 'rgba(0,0,0,0.18)';
        for (let pyy = 0; pyy < ih; pyy += dr2 * 3) {
            for (let pxx = 0; pxx < iw; pxx += dr2 * 3) {
                cx.beginPath(); cx.arc(pxx, pyy, dr2, 0, 6.2832); cx.fill();
            }
        }
        g.drawImage(cvs, px, py);
        // 漫画粗框: 白8px + 黑12px
        g.strokeStyle = '#fff'; g.lineWidth = 8;
        g.strokeRect(px - 4, py - 4, iw + 8, ih + 8);
        g.strokeStyle = '#111'; g.lineWidth = 12;
        g.strokeRect(px - 10, py - 10, iw + 20, ih + 20);
        // 拟声词贴纸(白字黑描边)
        const bang = (txt, bx, by, fs) => {
            g.save();
            g.font = 'bold ' + fs + 'px "Impact", "Arial Black", sans-serif';
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.lineJoin = 'round';
            g.strokeStyle = '#111'; g.lineWidth = Math.max(3, Math.round(fs * 0.16));
            g.strokeText(txt, bx, by);
            g.fillStyle = '#fff';
            g.fillText(txt, bx, by);
            g.restore();
        };
        const fs1 = Math.round(iw * 0.10);
        bang('POW!', px + iw - Math.round(iw * 0.10), py + Math.round(ih * 0.10), fs1);
        bang('BANG!', px + Math.round(iw * 0.10), py + ih - Math.round(ih * 0.10), fs1);
        // 对话气泡 WOW!(右下角)
        const bubble = (txt, bx, by, fs) => {
            g.save();
            g.font = 'bold ' + fs + 'px "Impact", "Arial Black", sans-serif';
            const bw = g.measureText(txt).width + fs * 1.1, bh = fs * 1.7;
            g.fillStyle = '#fff';
            g.strokeStyle = '#111';
            g.lineWidth = Math.max(2, Math.round(fs * 0.12));
            g.beginPath(); g.ellipse(bx, by, bw / 2, bh / 2, -0.12, 0, 6.2832); g.fill(); g.stroke();
            g.beginPath();
            g.moveTo(bx - bw * 0.10, by + bh * 0.40);
            g.lineTo(bx - bw * 0.34, by + bh * 0.88);
            g.lineTo(bx + bw * 0.06, by + bh * 0.42);
            g.closePath(); g.fill(); g.stroke();
            g.fillStyle = '#111';
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(txt, bx + fs * 0.02, by + fs * 0.05);
            g.restore();
        };
        bubble('WOW!', px + iw - Math.round(iw * 0.22), py + ih - Math.round(ih * 0.22), Math.round(iw * 0.075));
        // 底部 POP ART 黑条
        g.fillStyle = '#111';
        g.fillRect(0, h - barH, w, barH);
        g.fillStyle = '#ffe600';
        g.font = 'bold ' + Math.max(13, Math.round(barH * 0.45)) + 'px "Impact", "Arial Black", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('POP ART ★ ' + new Date().getFullYear(), w / 2, h - barH / 2);
        // 红黑双外框
        g.strokeStyle = '#111'; g.lineWidth = 6;
        g.strokeRect(3, 3, w - 6, h - 6);
        g.strokeStyle = '#ff4500'; g.lineWidth = 2.5;
        g.strokeRect(10, 10, w - 20, h - 20);
    }

    // ══ 复古报纸 ══
    // 头版版式:报头 + 大标题 + 半调照片 + 三栏正文 + 页脚。
    // 几何与 styleDims('NEWSPAPER') 共用 newspaperGeom,避免画布与照片错位。
    function styleNewspaper(img, size, g, iw, ih) {
        const G = newspaperGeom(iw);
        const { pad, mastH, headH, bottomH } = G;
        const w = iw + pad * 2, h = ih + pad * 2 + mastH + headH + bottomH;
        // 旧报纸底:米黄渐变 + 轻微纸纹。
        const paper = g.createLinearGradient(0, 0, w, h);
        paper.addColorStop(0, '#f3ecd9'); paper.addColorStop(0.55, '#efe6d2'); paper.addColorStop(1, '#e7dcc5');
        g.fillStyle = paper; g.fillRect(0, 0, w, h);
        const rnd = styleNoise(iw, ih, 8081);
        g.fillStyle = 'rgba(110,92,66,0.045)';
        for (let i = 0; i < Math.min(520, Math.floor(w * h / 2600)); i++) {
            const x = rnd(w), y = rnd(h), r = 0.4 + rnd(2) * 0.4;
            g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
        }
        g.strokeStyle = 'rgba(26,26,26,0.18)'; g.lineWidth = 1;
        g.strokeRect(12.5, 12.5, w - 25, h - 25);

        // 报头信息行。
        const metaFs = Math.max(8, Math.round(mastH * 0.095));
        g.save();
        g.font = 'bold ' + metaFs + 'px Georgia, serif';
        g.fillStyle = '#413a2f';
        g.textAlign = 'left'; g.textBaseline = 'alphabetic';
        g.fillText('VOL. CXXIV · NO. 87', pad, pad + Math.round(mastH * 0.10));
        g.textAlign = 'right';
        g.fillText('PRICE 25 CENTS', w - pad, pad + Math.round(mastH * 0.10));
        // 报头。
        g.textAlign = 'center';
        let mastFs = Math.max(24, Math.round(mastH * 0.48));
        g.font = '700 ' + mastFs + 'px Georgia, "Times New Roman", serif';
        while (mastFs > 18 && g.measureText('THE EVENING POST').width > iw * 0.94) {
            mastFs--; g.font = '700 ' + mastFs + 'px Georgia, "Times New Roman", serif';
        }
        g.fillStyle = '#171512';
        g.fillText('THE EVENING POST', w / 2, pad + Math.round(mastH * 0.56));
        // 双线。
        g.fillStyle = '#1b1b1b';
        g.fillRect(pad, pad + Math.round(mastH * 0.72), iw, Math.max(2, Math.round(metaFs * 0.20)));
        g.fillRect(pad, pad + Math.round(mastH * 0.72) + Math.max(4, Math.round(metaFs * 0.42)), iw, 1);
        g.font = Math.max(9, Math.round(metaFs * 1.08)) + 'px Georgia, serif';
        g.fillStyle = '#5d5342';
        g.fillText('SATURDAY, JUNE 12, 1998', w / 2, pad + Math.round(mastH * 0.92));
        g.restore();

        // 大标题区:红色 EXTRA 标 + 标题 + 副题。
        const kickY = pad + mastH + Math.max(6, Math.round(headH * 0.08));
        const kickW = Math.max(58, Math.round(iw * 0.09)), kickH = Math.max(18, Math.round(headH * 0.25));
        g.fillStyle = '#a8342a';
        fillRoundRectCtx(g, pad, kickY, kickW, kickH, 2);
        g.fillStyle = '#f6edd9';
        g.font = '700 ' + Math.max(9, Math.round(kickH * 0.46)) + 'px Georgia, serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('EXTRA', pad + kickW / 2, kickY + kickH / 2 + 1);
        let headFs = Math.max(25, Math.round(iw * 0.062));
        g.font = '700 ' + headFs + 'px Georgia, "Times New Roman", serif';
        while (headFs > 18 && g.measureText('THE WORLD IN FOCUS').width > iw * 0.95) {
            headFs--; g.font = '700 ' + headFs + 'px Georgia, "Times New Roman", serif';
        }
        g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.fillStyle = '#171512';
        g.fillText('THE WORLD IN FOCUS', w / 2, pad + mastH + Math.round(headH * 0.62));
        g.font = 'italic ' + Math.max(10, Math.round(iw * 0.018)) + 'px Georgia, serif';
        g.fillStyle = '#5d5342';
        g.fillText('A single frame from a longer story', w / 2, pad + mastH + Math.round(headH * 0.86));

        // 照片 + 半调网点 + 印刷边框。
        const px = pad, py = pad + mastH + headH;
        g.drawImage(img, px, py, iw, ih);
        const tile = newCanvas(6, 6);
        const tg = tile.getContext('2d');
        tg.fillStyle = 'rgba(0,0,0,0.58)';
        tg.beginPath(); tg.arc(3, 3, 1.15, 0, 6.2832); tg.fill();
        const pat = g.createPattern(tile, 'repeat');
        if (pat) {
            g.save(); g.globalAlpha = 0.08; g.fillStyle = pat;
            g.fillRect(px, py, iw, ih); g.restore();
        }
        g.strokeStyle = '#1b1b1b'; g.lineWidth = 2;
        g.strokeRect(px - 1, py - 1, iw + 2, ih + 2);

        // 照片下方:说明 + 三栏正文 + 页脚。
        const by = py + ih;
        g.fillStyle = '#1b1b1b'; g.fillRect(pad, by + Math.max(8, Math.round(bottomH * 0.06)), iw, 2);
        g.save();
        g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.font = 'italic ' + Math.max(13, Math.round(iw * 0.019)) + 'px Georgia, serif';
        g.fillStyle = '#2a2620';
        g.fillText('A moment in time, preserved in print.', w / 2, by + Math.round(bottomH * 0.17));
        g.font = 'bold ' + Math.max(7, Math.round(iw * 0.010)) + 'px Georgia, serif';
        g.fillStyle = '#7b6e58';
        g.fillText('THE EVENING POST  ·  ARCHIVE', w / 2, by + Math.round(bottomH * 0.26));
        g.restore();

        const colGap = Math.max(12, Math.round(iw * 0.022));
        const colW = (iw - colGap * 2) / 3;
        const colTop = by + Math.round(bottomH * 0.36);
        const cols = ['THE STORY', 'THE DETAILS', 'THE ARCHIVE'];
        const folioY = h - Math.max(12, Math.round(bottomH * 0.07));
        const lineH = Math.max(7, Math.round(bottomH * 0.055));
        const maxLines = Math.max(3, Math.floor((folioY - (colTop + 12)) / lineH));
        const lineCount = Math.min(10, maxLines);
        g.save();
        g.textBaseline = 'alphabetic';
        for (let c = 0; c < 3; c++) {
            const cx = pad + c * (colW + colGap);
            g.textAlign = 'left';
            g.font = '700 ' + Math.max(8, Math.round(iw * 0.0105)) + 'px Georgia, serif';
            g.fillStyle = c === 0 ? '#a8342a' : '#332d24';
            g.fillText(cols[c], cx, colTop);
            g.fillStyle = 'rgba(27,27,27,0.35)';
            g.fillRect(cx, colTop + 5, colW, 1);
            for (let i = 0; i < lineCount; i++) {
                const yy = colTop + 12 + i * lineH;
                const ww = i === 0 ? 0.99 : 0.56 + ((i * 29 + c * 17) % 40) / 100;
                g.fillStyle = i === 0 ? 'rgba(44,39,31,0.72)' : 'rgba(62,55,44,0.46)';
                g.fillRect(cx, yy, Math.max(20, colW * ww), Math.max(2, Math.round(lineH * 0.26)));
            }
        }
        g.font = 'bold ' + Math.max(7, Math.round(iw * 0.0085)) + 'px monospace';
        g.fillStyle = '#6e614d';
        g.textAlign = 'left';
        g.fillText('THE EVENING POST', pad, h - Math.max(12, Math.round(bottomH * 0.07)));
        g.textAlign = 'right';
        g.fillText('PAGE 01  ·  ARCHIVE EDITION', w - pad, h - Math.max(12, Math.round(bottomH * 0.07)));
        g.restore();
    }

    // ══ 复古胶片撕裂 ══
    // 暗房桌面 + 一条撕断的 35mm 负片:齿孔、片边码、划痕、日期戳都在底片上。
    function styleFilmTear(img, size, g, iw, ih, S) {
        const G = filmTearGeom(iw, ih, size);
        const { vertical, framePad, rail, endPad, tornPad, deskPad,
            filmW, filmH, photoX, photoY, tearY, tearX, w, h } = G;
        // 暗房桌面:深褐黑,带极淡的接触印相网格。
        const desk = g.createLinearGradient(0, 0, w, h);
        desk.addColorStop(0, '#231c15'); desk.addColorStop(0.58, '#15100c'); desk.addColorStop(1, '#090705');
        g.fillStyle = desk; g.fillRect(0, 0, w, h);
        g.strokeStyle = 'rgba(210,180,140,0.035)'; g.lineWidth = 1;
        const grid = Math.max(64, Math.round(Math.min(iw, ih) * 0.10));
        for (let x = deskPad; x < w; x += grid) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
        for (let y = deskPad; y < h; y += grid) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }

        const film = newCanvas(filmW, filmH);
        const fg = film.getContext('2d');
        const base = fg.createLinearGradient(0, 0, filmW, filmH);
        base.addColorStop(0, '#251c14'); base.addColorStop(0.55, '#17110c'); base.addColorStop(1, '#0d0906');
        fg.fillStyle = base; fg.fillRect(0, 0, filmW, filmH);
        fg.strokeStyle = 'rgba(210,180,135,0.16)'; fg.lineWidth = 1.5;
        fg.strokeRect(1, 1, filmW - 2, filmH - 2);

        // 照片 + 轻微泛黄 + 暗角。
        fg.drawImage(img, photoX, photoY, iw, ih);
        fg.fillStyle = 'rgba(132,86,36,0.06)'; fg.fillRect(photoX, photoY, iw, ih);
        const vign = fg.createRadialGradient(photoX + iw / 2, photoY + ih / 2, Math.min(iw, ih) * 0.32,
            photoX + iw / 2, photoY + ih / 2, Math.max(iw, ih) * 0.72);
        vign.addColorStop(0, 'rgba(0,0,0,0)'); vign.addColorStop(1, 'rgba(0,0,0,0.30)');
        fg.fillStyle = vign; fg.fillRect(photoX, photoY, iw, ih);

        // 划痕与灰尘:固定盐,渲染稳定。
        const rnd = styleNoise(iw, ih, 5150);
        fg.save();
        for (let i = 0; i < 10; i++) {
            const sx = photoX + rnd(iw), sy = photoY + rnd(ih);
            const len = Math.max(8, rnd(Math.max(12, Math.round(ih * 0.22))));
            fg.strokeStyle = i < 7 ? 'rgba(255,242,210,0.06)' : 'rgba(0,0,0,0.15)';
            fg.lineWidth = 1;
            fg.beginPath(); fg.moveTo(sx, sy); fg.lineTo(sx + (i % 2 ? len * 0.16 : -len * 0.16), sy + len); fg.stroke();
        }
        fg.fillStyle = 'rgba(255,245,220,0.10)';
        for (let i = 0; i < 18; i++) {
            fg.beginPath(); fg.arc(photoX + rnd(iw), photoY + rnd(ih), 0.6 + rnd(2) * 0.5, 0, 6.2832); fg.fill();
        }
        fg.restore();
        fg.strokeStyle = 'rgba(232,214,180,0.62)'; fg.lineWidth = 1.5;
        fg.strokeRect(photoX - 1.5, photoY - 1.5, iw + 3, ih + 3);
        fg.strokeStyle = 'rgba(0,0,0,0.40)'; fg.lineWidth = 1;
        fg.strokeRect(photoX - 3.5, photoY - 3.5, iw + 7, ih + 7);

        // 齿孔:竖条在左右轨,横条在上下轨。
        fg.fillStyle = 'rgba(232,220,196,0.92)';
        if (vertical) {
            const hw = Math.max(8, Math.round(rail * 0.36)), hh = Math.max(12, Math.round(rail * 0.55));
            const step = Math.max(hw + 4, Math.round(rail * 0.92));
            for (let y = Math.round(endPad * 0.45); y < filmH - Math.round(tornPad * 0.45); y += step) {
                for (const cx of [rail / 2, filmW - rail / 2]) {
                    fillRoundRectCtx(fg, Math.round(cx - hw / 2), y, hw, hh, Math.min(hw, hh) * 0.28);
                }
            }
        } else {
            const hw = Math.max(12, Math.round(rail * 0.55)), hh = Math.max(8, Math.round(rail * 0.36));
            const step = Math.max(hw + 4, Math.round(rail * 0.92));
            for (let x = Math.round(endPad * 0.45); x < filmW - Math.round(tornPad * 0.45); x += step) {
                for (const cy of [rail / 2, filmH - rail / 2]) {
                    fillRoundRectCtx(fg, x, Math.round(cy - hh / 2), hw, hh, Math.min(hw, hh) * 0.28);
                }
            }
        }

        // 片边码。
        const codeFs = Math.max(7, Math.round(Math.min(iw, ih) * 0.010));
        fg.save();
        fg.font = 'bold ' + codeFs + 'px "Courier New", monospace';
        fg.fillStyle = 'rgba(214,166,102,0.85)';
        fg.textBaseline = 'middle';
        if (vertical) {
            fg.textAlign = 'left';
            fg.fillText('KODAK 400TX · 12A', rail + framePad, Math.round(endPad * 0.62));
            fg.textAlign = 'right';
            fg.fillText('▷ 12', filmW - rail - framePad, Math.round(endPad * 0.62));
        } else {
            fg.translate(Math.round(endPad * 0.55), filmH / 2);
            fg.rotate(-Math.PI / 2);
            fg.textAlign = 'center';
            fg.fillText('KODAK 400TX · 12A', 0, 0);
        }
        fg.restore();

        // 经典橙色日期戳。
        const dateFs = Math.max(12, Math.min(Math.round(autoExifSize(S ? S.paramFs : 33, iw) * 1.15),
            Math.round(iw * 0.06)));
        fg.save();
        fg.font = 'bold ' + dateFs + 'px "Courier New", monospace';
        fg.textAlign = 'right'; fg.textBaseline = 'alphabetic';
        fg.shadowColor = 'rgba(255,110,20,0.60)'; fg.shadowBlur = Math.max(3, dateFs * 0.28);
        fg.fillStyle = '#ff9b45';
        fg.fillText('98 6 12', photoX + iw - Math.round(dateFs * 0.5), photoY + ih - Math.round(dateFs * 0.4));
        fg.restore();

        // 撕口:锯齿路径 + 亮色断口。
        const amp = Math.max(3, Math.round(Math.min(iw, ih) * 0.007));
        const count = Math.max(8, Math.floor((vertical ? filmW : filmH) / 14));
        const pts = [];
        for (let i = 0; i <= count; i++) {
            const t = i / count;
            if (vertical) pts.push([Math.round(t * filmW), Math.round(tearY + (rnd(amp * 2 + 1) - amp))]);
            else pts.push([Math.round(tearX + (rnd(amp * 2 + 1) - amp)), Math.round(t * filmH)]);
        }
        fg.save();
        fg.globalCompositeOperation = 'destination-out';
        fg.beginPath();
        if (vertical) {
            fg.moveTo(0, filmH); fg.lineTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) fg.lineTo(pts[i][0], pts[i][1]);
            fg.lineTo(filmW, filmH);
        } else {
            fg.moveTo(filmW, 0); fg.lineTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) fg.lineTo(pts[i][0], pts[i][1]);
            fg.lineTo(filmW, filmH);
        }
        fg.closePath(); fg.fill(); fg.restore();
        fg.save();
        fg.strokeStyle = 'rgba(242,224,190,0.82)';
        fg.lineWidth = Math.max(1, Math.round(size * 0.022));
        fg.beginPath();
        fg.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) fg.lineTo(pts[i][0], pts[i][1]);
        fg.stroke(); fg.restore();

        g.save();
        g.shadowColor = 'rgba(0,0,0,0.65)';
        g.shadowBlur = Math.max(12, Math.round(size * 0.35));
        g.shadowOffsetY = Math.max(4, Math.round(size * 0.08));
        g.drawImage(film, deskPad, deskPad);
        g.restore();

        const deskFs = Math.max(7, Math.round(iw * 0.009));
        g.save();
        g.font = 'bold ' + deskFs + 'px monospace';
        g.fillStyle = 'rgba(210,172,118,0.62)';
        g.textBaseline = 'alphabetic';
        const deskY = h - Math.max(8, Math.round(deskPad * 0.45));
        g.textAlign = 'left';
        g.fillText('35MM · KODAK 400TX', deskPad, deskY);
        g.textAlign = 'right';
        g.fillText('FRAME 12A · EST. 1998', w - deskPad, deskY);
        g.restore();
    }



    // ══ 签名纪念 ══
    function styleSignature(img, size, g, iw, ih, S, cwO, chO) {
        const pad = Math.max(30, Math.round(iw * 0.04));
        const bottomH = Math.round(iw * 0.10);
        const natW = iw + pad * 2, natH = ih + pad + bottomH;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        if (S.signBgBlur) {
            g.save();
            g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, cw, ch);
            g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.6)';
            const bs = Math.max(cw / iw, ch / ih);
            g.drawImage(img, (cw - iw * bs) / 2, (ch - ih * bs) / 2, iw * bs, ih * bs);
            g.filter = 'none';
            g.restore();
        } else {
            g.fillStyle = '#faf8f5'; g.fillRect(0, 0, cw, ch);
        }
        g.save();
        g.translate(ox, oy);
        g.save();
        if (S.signBgBlur) { g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8; }
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        g.fillStyle = S.signBgBlur ? '#fff' : (S.signColor || '#555');
        g.font = 'italic ' + Math.round(iw * 0.05 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Courier New') + '", cursive';
        g.textAlign = 'center';
        g.save();
        g.translate(natW / 2, pad + ih + Math.round(bottomH * 0.6));
        g.rotate(-0.02);
        g.fillText(S.userSignature || '', 0, 0);
        g.restore();
        g.restore();
    }

    // ══ 签名+参数:底部左头像+签名,右品牌+参数 ══
    function styleSignParam(img, size, g, iw, ih, S, cwO, chO) {
        const pad = Math.max(30, Math.round(iw * 0.04));
        const fs = Math.max(11, Math.round(autoExifSize(S.paramFs, iw)));
        const bottomH = Math.round(iw * 0.14);
        const natW = iw + pad * 2, natH = ih + pad + bottomH;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        const w = natW;
        if (S.signBgBlur) {
            g.save();
            g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, cw, ch);
            g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.6)';
            const bs = Math.max(cw / iw, ch / ih);
            g.drawImage(img, (cw - iw * bs) / 2, (ch - ih * bs) / 2, iw * bs, ih * bs);
            g.filter = 'none';
            g.restore();
        } else {
            g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
        }
        g.save();
        g.translate(ox, oy);
        g.save();
        if (S.signBgBlur) { g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8; }
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        const barY = pad + ih;
        const midY = barY + bottomH / 2;

        // ══ 左侧:头像+签名 ══
        const avatarR = Math.round(bottomH * 0.3 * (S.avatarScale || 1));
        const ax = pad + avatarR + 6, ay = midY;
        const globalAv = window.__qfsAvatarImg;
        const hasAv = !!(globalAv && globalAv.complete && globalAv.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        if (hasAv) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            if (S.avatarSelected) {
                g.shadowColor = '#10b981'; g.shadowBlur = 12;
                g.strokeStyle = '#10b981'; g.lineWidth = 3;
            } else {
                g.strokeStyle = '#eee'; g.lineWidth = 2;
            }
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowBlur = 0;
        }
        // 签名(头像右边;面板里关掉头像就顶回区块左缘,不留空档)
        g.fillStyle = S.signColor || '#444';
        g.font = 'italic ' + Math.round(iw * 0.022 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Courier New') + '", cursive';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(S.userSignature || '', hasAv ? ax + avatarR + 12 : ax - avatarR, ay);
        g.textBaseline = 'alphabetic';

        // ══ 右侧:品牌+参数,以参数行居中 ══
        const rx = w - pad;
        // 先测参数行宽度
        const paramStr = ((S.cam && S.cam.focal) || S.exif.focal || '') + '  ' + (S.exif.aperture||'') + '  ' + (S.exif.iso||'') + '  ' + (S.exif.shutter||'');
        g.font = fs + 'px sans-serif';
        const pw = g.measureText(paramStr).width;
        const cxRight = rx - pw / 2; // 参数行中心x
        // 品牌居中在参数行上方(与「相机参数水印」同款品牌字体/自动配色);型号用无衬线,数字 0/O 易区分
        const hasModel = !brandHidden(S) && !!(S.signIncludeModel && (S.exif.model || '').trim());
        const brandTxt = brandHidden(S) ? '' : (prettyBrand((S.cam && S.cam.brand) || S.exif.make) || 'Camera');
        const modelTxt = brandHidden(S) ? '' : (S.exif.model || '').trim().toUpperCase();
        let fBrand = Math.round(iw * 0.028 * (S.brandScale || 1));
        const pColor = S.paramColor === 'auto' ? (S.signBgBlur ? '#fff' : '#333') : S.paramColor;
        const pColorSoft = S.paramColor === 'auto' ? (S.signBgBlur ? 'rgba(255,255,255,0.7)' : '#999') : (S.paramColor === '#fff' ? 'rgba(255,255,255,0.7)' : '#999');
        // 品牌(含型号)太长时收缩居中不溢出右侧区域
        const lsTmp = Math.round(fBrand * 0.15);
        g.font = brandFont(fBrand, 700);
        g.letterSpacing = 0;
        const rawWTmp = g.measureText(hasModel ? brandTxt + ' ' + modelTxt : brandTxt).width;
        const bwTmp = Math.round(rawWTmp + lsTmp * Math.max(0, (hasModel ? brandTxt + ' ' + modelTxt : brandTxt).length - 1));
        const maxBrandW = Math.max(60, (rx - cxRight) * 2 * 0.92);
        const markWTmp = brandMarkW(S, fBrand);
        if (bwTmp + markWTmp > maxBrandW && fBrand > 8) fBrand = Math.max(8, Math.round(fBrand * (maxBrandW - markWTmp) / bwTmp));
        // 品牌:Times 衬线 + 品牌色 + 字距;型号:无衬线(同高度/同色),拼接与品牌保持在同一条基线上
        const gap = Math.round(fBrand * 0.3);
        const ls = Math.round(fBrand * 0.15);
        const sansFont = 'bold ' + fBrand + "px 'Courier New', 'Courier New', monospace";
        const brandW = (function () {
            g.font = brandFont(fBrand, 700);
            g.letterSpacing = 0;
            const base = g.measureText(brandTxt).width;
            return Math.round(base + ls * Math.max(0, brandTxt.length - 1));
        })();
        const modelW = hasModel ? (function () {
            g.font = sansFont;
            g.letterSpacing = 0;
            const base = g.measureText(modelTxt).width;
            return Math.round(base + ls * Math.max(0, modelTxt.length - 1));
        })() : 0;
        const totalW = brandW + (hasModel ? gap + modelW : 0);
        g.textAlign = 'left';
        g.textBaseline = 'top';
        const topY2 = barY + Math.round(bottomH * 0.15);
        const markW = brandMarkW(S, fBrand);
        const onlyLogoSum = (S.brandLogo === 2 && markW > 0);
        const sumW = onlyLogoSum ? totalW : (totalW + markW);
        const groupX = cxRight - sumW / 2;
        // 型号无衬线,避免衬线数字 0 与字母 o 混淆
        g.font = brandFont(fBrand, 700);
        g.fillStyle = brandInk(brandTxt, !!S.signBgBlur);
        const markUsed = onlyLogoSum ? drawBrandMark(g, S, logoCenterX(S, fBrand, groupX, brandW), topY2, fBrand, 'top') : drawBrandMark(g, S, groupX, topY2, fBrand, 'top');
        if (!onlyLogoSum || !markUsed) g.fillText(brandTxt, groupX + markUsed, topY2);
        g.letterSpacing = 0;
        if (hasModel) {
            g.font = sansFont;
            g.letterSpacing = ls;
            g.fillStyle = pColor;
            g.fillText(modelTxt, groupX + (onlyLogoSum ? brandW : markUsed + brandW) + gap, topY2);
            g.letterSpacing = 0;
        }
        // 参数行
        g.fillStyle = pColorSoft;
        g.font = fs + 'px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(paramStr, cxRight, barY + Math.round(bottomH * 0.65));
        g.textBaseline = 'alphabetic';
        g.textAlign = 'center';
        g.restore();
    }

    // ══ 头像纪念 ══
    function styleAvatarMemo(img, size, g, iw, ih, S, cwO, chO) {
        const AG = avatarMemoGeom(iw, ih);
        const pad = AG.pad, bottomH = AG.bottomH;
        const natW = AG.w, natH = AG.h;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        const w = natW;
        if (S.signBgBlur) {
            g.save();
            g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, cw, ch);
            g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.6)';
            const bs = Math.max(cw / iw, ch / ih);
            g.drawImage(img, (cw - iw * bs) / 2, (ch - ih * bs) / 2, iw * bs, ih * bs);
            g.filter = 'none';
            g.restore();
        } else {
            g.fillStyle = '#f5f0eb'; g.fillRect(0, 0, cw, ch);
        }
        g.save();
        g.translate(ox, oy);
        g.save();
        if (S.signBgBlur) { g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8; }
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        const barY = pad + ih;
        const avatarR = Math.round(bottomH * 0.32 * (S.avatarScale || 1));
        const offX = S.avatarOffX || 0, offY = S.avatarOffY || 0;
        const ax = pad + avatarR + 8 + offX, ay = barY + bottomH / 2 + offY;
        const globalAv = window.__qfsAvatarImg;
        const hasAv = !!(globalAv && globalAv.complete && globalAv.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        if (hasAv) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
        }
        g.fillStyle = S.signColor || '#555';
        // 头像纪念的签名在底部条里(照片之外),所以按"底栏宽度"收敛:右缘不超过画布右留白,
        // 否则 signSize 放大 / 签名过长时会被画布边缘切掉。
        // 关掉头像时签名顶回底栏左缘(ax - avatarR),把头像腾出来的宽度还给签名。
        const signX = hasAv ? ax + avatarR + 16 : ax - avatarR;
        const fit = fitSignText(g, S.userSignature || '', Math.round(iw * 0.022 * (S.signSize || 1)), S.signFont,
            w - pad - signX);
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(fit.text, signX, ay);
        g.textBaseline = 'alphabetic';
        g.textAlign = 'center';
        g.fillStyle = '#aaa';
        g.font = Math.round(iw * 0.018) + 'px sans-serif';
        g.textAlign = 'right';
        g.fillText(new Date().toLocaleDateString('zh-CN'), w - pad, barY + bottomH * 0.7);
        g.textAlign = 'center';
        g.restore();
    }

    // ══ 签名+背景模糊:模糊照片铺满背景,清晰照片+底部条 ══
    function styleSignBlur(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(iw * 0.04));
        const fs = Math.max(11, Math.round(autoExifSize(S.paramFs, iw)));
        const bottomH = Math.round(iw * 0.14);
        const w = iw + pad * 2, h = ih + pad + bottomH;
        // 模糊背景:把照片放大铺满画布
        g.save();
        g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
        g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.6)';
        const bs = Math.max(w / iw, h / ih);
        g.drawImage(img, (w - iw * bs) / 2, (h - ih * bs) / 2, iw * bs, ih * bs);
        g.filter = 'none';
        g.restore();
        // 清晰照片居中
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8;
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        const barY = pad + ih;
        const midY = barY + bottomH / 2;

        // 左侧头像+签名
        const avatarR = Math.round(bottomH * 0.3 * (S.avatarScale || 0.85));
        const ax = pad + avatarR + 6, ay = midY;
        const globalAv = window.__qfsAvatarImg;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
        }
        g.fillStyle = '#fff';
        g.font = 'italic ' + Math.round(iw * 0.022 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Courier New') + '", cursive';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(S.userSignature || '', ax + avatarR + 12, ay);
        g.textBaseline = 'alphabetic';

        // 右侧品牌+参数
        const rx = w - pad;
        const paramStr = ((S.cam && S.cam.focal) || S.exif.focal || '') + '  ' + (S.exif.aperture||'') + '  ' + (S.exif.iso||'') + '  ' + (S.exif.shutter||'');
        g.font = fs + 'px sans-serif';
        const pw = g.measureText(paramStr).width;
        const cxRight = rx - pw / 2;
        const brandTxt2 = brandHidden(S) ? '' : (prettyBrand((S.cam && S.cam.brand) || S.exif.make) || 'Camera');
        const fBrand2 = Math.round(iw * 0.028 * (S.brandScale || 1));
        g.fillStyle = brandInk(brandTxt2, true);
        g.font = brandFont(fBrand2, 700);
        g.letterSpacing = Math.round(fBrand2 * 0.15);
        g.textAlign = 'center';
        g.textBaseline = 'top';
        const topY2b = barY + Math.round(bottomH * 0.15);
        if (!S.brandLogo) {
            g.fillText(brandTxt2, cxRight, topY2b);
        } else {
            const onlyLogoBlur = (S.brandLogo === 2);
            const bw2 = onlyLogoBlur ? 0 : g.measureText(brandTxt2).width;
            const mark2 = brandMarkW(S, fBrand2);
            const bx2 = Math.round(cxRight - (bw2 + mark2) / 2);
            g.textAlign = 'left';
            const mark2Used = drawBrandMark(g, S, bx2, topY2b, fBrand2, 'top');
            if (!onlyLogoBlur || !mark2Used) g.fillText(brandTxt2, bx2 + mark2Used, topY2b);
            g.textAlign = 'left';
        }
        g.letterSpacing = 0;
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.font = fs + 'px sans-serif';
        g.textBaseline = 'middle';
        g.fillText(paramStr, cxRight, barY + Math.round(bottomH * 0.65));
        g.textBaseline = 'alphabetic';
        g.textAlign = 'center';
    }

    // ══ 签名·模糊:只签名居中,模糊背景 ══
    function styleSigBlur(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(iw * 0.04));
        const bottomH = Math.round(iw * 0.10);
        const w = iw + pad * 2, h = ih + pad + bottomH;
        g.save();
        g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
        g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.6)';
        const bs = Math.max(w / iw, h / ih);
        g.drawImage(img, (w - iw * bs) / 2, (h - ih * bs) / 2, iw * bs, ih * bs);
        g.filter = 'none';
        g.restore();
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8;
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        const barY = pad + ih;
        g.fillStyle = '#fff';
        g.font = 'italic ' + Math.round(iw * 0.05 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Courier New') + '", cursive';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.save();
        g.translate(w / 2, barY + bottomH / 2);
        g.rotate(-0.015);
        g.fillText(S.userSignature || '', 0, 0);
        g.restore();
        g.textBaseline = 'alphabetic';
    }

    // ══ 头像·模糊:头像+签名,模糊背景 ══
    function styleAvBlur(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(iw * 0.05));
        const bottomH = Math.round(iw * 0.11);
        const w = iw + pad * 2, h = ih + pad * 2 + bottomH;
        g.save();
        g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
        g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.6)';
        const bs = Math.max(w / iw, h / ih);
        g.drawImage(img, (w - iw * bs) / 2, (h - ih * bs) / 2, iw * bs, ih * bs);
        g.filter = 'none';
        g.restore();
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8;
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        const barY = pad + ih;
        const avatarR = Math.round(bottomH * 0.35 * (S.avatarScale || 0.85));
        const ax = pad + avatarR + 8, ay = barY + bottomH / 2;
        const globalAv = window.__qfsAvatarImg;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
        }
        g.fillStyle = '#fff';
        g.font = 'italic ' + Math.round(iw * 0.022 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Courier New') + '", cursive';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(S.userSignature || '', ax + avatarR + 16, ay);
        g.textBaseline = 'alphabetic';
        g.textAlign = 'right';
        g.fillStyle = 'rgba(255,255,255,0.6)';
        g.font = Math.round(iw * 0.018) + 'px sans-serif';
        g.fillText(new Date().toLocaleDateString('zh-CN'), w - pad, barY + bottomH * 0.7);
        g.textAlign = 'center';
    }

    // 头像系列通用边框:开启「背景模糊」用模糊照片铺满+压暗,否则纯白底;照片主体带悬浮阴影
    // px/py 为清晰照片的左上角,可从画布中心随内容块整体偏移(全出血时由前缀偏移注入)
    function drawAvBg(g, img, px, py, w, h, S) {
        if (!S.signBgBlur) {
            g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
            g.drawImage(img, px, py, img.naturalWidth, img.naturalHeight);
            return;
        }
        g.save();
        g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
        g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.6)';
        const bs = Math.max(w / img.naturalWidth, h / img.naturalHeight);
        g.drawImage(img, (w - img.naturalWidth * bs) / 2, (h - img.naturalHeight * bs) / 2, img.naturalWidth * bs, img.naturalHeight * bs);
        g.filter = 'none';
        g.restore();
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8;
        g.drawImage(img, px, py, img.naturalWidth, img.naturalHeight);
        g.restore();
    }

    // ══ 头像·左下:头像+签名直接放在照片上 ══
    function styleAvOverlay(img, size, g, iw, ih, S, cwO, chO) {
        const pad = Math.max(20, Math.round(iw * 0.03));
        const natW = iw + pad * 2, natH = ih + pad * 2;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        drawAvBg(g, img, pad + ox, pad + oy, cw, ch, S);
        // 头像/签名随照片一起居中
        g.save();
        g.translate(ox, oy);
        // 头像在左下角
        const avatarR = Math.round(Math.min(iw, ih) * 0.06 * (S.avatarScale || 0.85));
        const ax = pad + avatarR + Math.round(iw * 0.03);
        const ay = pad + ih - avatarR - Math.round(iw * 0.03);
        const globalAv = window.__qfsAvatarImg;
        const hasAv = !!(globalAv && globalAv.complete && globalAv.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        if (hasAv) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
            g.stroke();
            g.shadowBlur = 0;
        }
        // 签名在头像右边(自动适配宽度);面板里关掉头像就顶回左下角,不留空档
        const signTxt = S.userSignature || '';
        const signX = hasAv ? ax + avatarR + 12 : ax - avatarR;
        const maxSignW = pad + iw - signX - 10;
        const fit = fitSignText(g, signTxt, Math.round(iw * 0.022 * (S.signSize || 1)), S.signFont, maxSignW);
        g.fillStyle = S.signColor || '#fff';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
        g.fillText(fit.text, signX, ay);
        g.shadowBlur = 0;
        g.restore();
    }

    // ══ 头像·右上:头像在右上角,签名在下方 ══
    function styleAvOverlayTR(img, size, g, iw, ih, S, cwO, chO) {
        const pad = Math.max(20, Math.round(iw * 0.03));
        const natW = iw + pad * 2, natH = ih + pad * 2;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        drawAvBg(g, img, pad + ox, pad + oy, cw, ch, S);
        g.save();
        g.translate(ox, oy);
        const avatarR = Math.round(Math.min(iw, ih) * 0.06 * (S.avatarScale || 0.85));
        const ax = pad + iw - avatarR - Math.round(iw * 0.03);
        const ay = pad + avatarR + Math.round(iw * 0.03);
        const globalAv = window.__qfsAvatarImg;
        const hasAv = !!(globalAv && globalAv.complete && globalAv.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        if (hasAv) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
        }
        // 签名在头像下方居中(自动缩窄 + 锚点夹进照片内)
        const signTxt = S.userSignature || '';
        const sideIn = Math.round(iw * 0.02);
        const fit = fitSignText(g, signTxt, Math.round(iw * 0.022 * (S.signSize || 1)), S.signFont,
            iw - sideIn * 2);
        const tw = fit.text ? g.measureText(fit.text).width : 0;
        g.fillStyle = S.signColor || '#fff';
        // 头像在右上角,签名默认居中对齐在它正下方;字变长后若不把锚点夹进照片,
        // 文字右半边会直接落到照片外(旧代码只把字号压到 10px,仍旧会溢出)。
        // 面板里关掉头像时没有可对齐的锚点,签名改为照片内水平居中、贴照片上边距。
        const tx = hasAv ? Math.min(Math.max(ax, pad + sideIn + tw / 2), pad + iw - sideIn - tw / 2)
                         : pad + Math.round(iw / 2);
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
        g.fillText(fit.text, tx, hasAv ? ay + avatarR + Math.round(iw * 0.015) : ay - avatarR);
        g.shadowBlur = 0;
        g.restore();
    }

    // ══ 头像·右下:头像在右下角,签名在左边 ══
    function styleAvOverlayBR(img, size, g, iw, ih, S, cwO, chO) {
        const pad = Math.max(20, Math.round(iw * 0.03));
        const natW = iw + pad * 2, natH = ih + pad * 2;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        drawAvBg(g, img, pad + ox, pad + oy, cw, ch, S);
        g.save();
        g.translate(ox, oy);
        const avatarR = Math.round(Math.min(iw, ih) * 0.06 * (S.avatarScale || 0.85));
        const ax = pad + iw - avatarR - Math.round(iw * 0.03);
        const ay = pad + ih - avatarR - Math.round(iw * 0.03);
        const globalAv = window.__qfsAvatarImg;
        const hasAv = !!(globalAv && globalAv.complete && globalAv.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        if (hasAv) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
        }
        // 签名在头像左边(自动缩窄);面板里关掉头像时右缘对齐到照片右边距(原头像右缘)
        const signTxt = S.userSignature || '';
        const signRight = hasAv ? ax - avatarR - 12 : ax + avatarR;
        const maxSignW = signRight - pad - 10;
        const fit = fitSignText(g, signTxt, Math.round(iw * 0.022 * (S.signSize || 1)), S.signFont, maxSignW);
        g.fillStyle = S.signColor || '#fff';
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
        g.fillText(fit.text, signRight, ay);
        g.shadowBlur = 0;
        g.restore();
    }

    // ══ 头像·下中:头像底部居中,签名在下方 ══
    function styleAvOverlayBC(img, size, g, iw, ih, S, cwO, chO) {
        const pad = Math.max(20, Math.round(iw * 0.03));
        const natW = iw + pad * 2, natH = ih + pad * 2;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        drawAvBg(g, img, pad + ox, pad + oy, cw, ch, S);
        g.save();
        g.translate(ox, oy);
        const avatarR = Math.round(Math.min(iw, ih) * 0.06 * (S.avatarScale || 0.85));
        const ax = pad + Math.round(iw / 2);
        const globalAv = window.__qfsAvatarImg;
        const hasAv = !!(globalAv && globalAv.complete && globalAv.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        // 先定签名:字号受"照片可用宽度"约束(长签名缩窄 / 极端情况省略号截断)
        const signTxt = S.userSignature || '';
        const availL2 = ax - pad - 10, availR2 = (pad + iw) - ax - 10;
        const fit2 = fitSignText(g, signTxt, Math.round(iw * 0.022 * (S.signSize || 1)), S.signFont,
            2 * Math.max(20, Math.min(availL2, availR2)));
        const signFs = fit2.fs;
        const signGap = Math.round(iw * 0.012);
        // 头像圆心:让「头像 + 间距 + 签名」整块贴住照片下边沿(签名始终留在照片内)。
        // 旧式 ay = pad + ih - avatarR - round(iw*0.04) 里,0.04*iw 恰好 =
        // 0.006(签名下的留白)+ 0.022(默认字号)+ 0.012(间距) —— 只有在 signSize=1 时成立;
        // 一旦放大签名,字号变大而 ay 不动,签名就会顶出照片下沿落到白边上。
        // 现在按实际字号把多出来的高度从 ay 里扣掉:整块上移,signSize=1 时与原位置完全一致。
        // 面板里关掉头像时把头像高度当 0,整块只剩签名、底部依旧贴着照片下沿。
        const avR = hasAv ? avatarR : 0;
        const ay = pad + ih - avR - Math.round(iw * 0.04) - (signFs - Math.round(iw * 0.022));
        if (hasAv) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
        }
        // 签名在头像下方居中(字号/文本已由 fitSignText 收敛)
        g.fillStyle = S.signColor || '#fff';
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
        g.fillText(fit2.text, ax, ay + avR + signGap);
        g.shadowBlur = 0;
        g.restore();
    }

    // ══ 头像·下排:头像左+签名右,同一排,整体底部居中 ══
    function styleAvOverlayBC2(img, size, g, iw, ih, S, cwO, chO) {
        const pad = Math.max(20, Math.round(iw * 0.03));
        const natW = iw + pad * 2, natH = ih + pad * 2;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        drawAvBg(g, img, pad + ox, pad + oy, cw, ch, S);
        g.save();
        g.translate(ox, oy);
        const avatarR = Math.round(Math.min(iw, ih) * 0.05 * (S.avatarScale || 0.85));
        const globalAv = window.__qfsAvatarImg;
        const hasAv = !!(globalAv && globalAv.complete && globalAv.naturalWidth) && (S ? S.avatarShow !== 0 : true);
        // 先量签名宽度:字号受"照片可用宽度 − 头像块 − 间距 − 左右留白"约束,
        // 否则长签名在 signSize 放大后会把整行顶出照片右(左)边沿。
        const signTxt = S.userSignature || '';
        const gap = Math.round(iw * 0.015);
        const sideIn = Math.round(iw * 0.02);
        const fit = fitSignText(g, signTxt, Math.round(iw * 0.022 * (S.signSize || 1)), S.signFont,
            iw - sideIn * 2 - (hasAv ? avatarR * 2 + gap : 0));
        const tw = fit.text ? g.measureText(fit.text).width : 0;
        // 面板里关掉头像时整行只剩签名:totalW 里不含头像块,自然重新居中。
        const totalW = (hasAv ? avatarR * 2 + gap : 0) + tw;
        const startX = pad + Math.round((iw - totalW) / 2);
        const avR = hasAv ? avatarR : 0;
        const cy = pad + ih - avR - Math.round(iw * 0.04);
        // 头像
        let cx = startX;
        if (hasAv) {
            g.save();
            g.beginPath(); g.arc(cx + avatarR, cy, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, cx + avatarR - avatarR, cy - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(cx + avatarR, cy, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
        }
        // 签名在头像右边(关掉头像时紧接在居中的签名块左缘)
        g.fillStyle = S.signColor || '#fff';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
        g.fillText(fit.text, cx + (hasAv ? avatarR * 2 + gap : 0), cy);
        g.shadowBlur = 0;
        g.restore();
    }

    // ══ 摄影署名水印:原图满幅 + 底部居中「署名 | PHOTOGRAPHY ©年份」三段水印 ══
    // creditMode:0=个性签名,1=相机型号(品牌+型号)。三段同一字号同一行,位置大小一致;
    // 默认纯原图直加文字(白字带轻投影);signBgBlur=1 时才进入模糊压暗全出血模式。
    function stylePhotoCredit(img, size, g, iw, ih, S, cwO, chO) {
        const natW = iw, natH = ih;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        if (S.signBgBlur) {
            g.save();
            g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, cw, ch);
            g.filter = 'blur(' + signBlurRad(S) + 'px) brightness(0.55)';
            const bs = Math.max(cw / iw, ch / ih);
            g.drawImage(img, (cw - iw * bs) / 2, (ch - ih * bs) / 2, iw * bs, ih * bs);
            g.filter = 'none';
            g.restore();
        }
        // 原图满幅铺满画布(默认即此路径,无边框无背景)
        g.save();
        g.translate(ox, oy);
        g.drawImage(img, 0, 0, iw, ih);
        // 三段:署名 | PHOTOGRAPHY ©年份(年份自动取当年)。第一段=签名 或 相机型号。
        const useModel = Number(S.creditMode || 0) === 1;
        const make = (S.exif.make || '').trim().toUpperCase();
        const model = (S.exif.model || '').trim().toUpperCase();
        const first = useModel ? (make + (model ? ' ' + model : '')) : (S.userSignature || '');
        const year = new Date().getFullYear();
        const text = first ? (first + '  |  PHOTOGRAPHY © ' + year) : ('PHOTOGRAPHY © ' + year);
        // 三段同一字号,过长时先缩字号再省略号截断,始终压在原图底部同一位置
        const family = (S.signFont || 'Arial');
        let fs = Math.round(iw * 0.022 * (S.signSize || 1));
        const maxW = iw - Math.round(iw * 0.08);
        g.font = fs + 'px "' + family + '", sans-serif';
        g.letterSpacing = Math.round(fs * 0.5) + 'px';
        let tw = g.measureText(text).width;
        if (tw > maxW && fs > 10) {
            fs = Math.max(10, Math.floor(fs * maxW / tw));
            g.font = fs + 'px "' + family + '", sans-serif';
            g.letterSpacing = Math.round(fs * 0.5) + 'px';
            tw = g.measureText(text).width;
        }
        let str = text;
        if (tw > maxW) {
            const ell = '…';
            const chars = Array.from(str);
            while (chars.length > 1 && g.measureText(chars.join('') + ell).width > maxW) chars.pop();
            str = chars.join('') + ell;
        }
        // 压照片上的白字带轻投影保证可读;开模糊时也走白字
        g.fillStyle = S.signBgBlur ? '#fff' : (S.signColor || '#fff');
        g.letterSpacing = Math.round(fs * 0.5) + 'px';
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        const ay = ih - Math.round(iw * 0.045);
        g.shadowColor = 'rgba(0,0,0,0.5)';
        g.shadowBlur = S.signBgBlur ? 8 : 3;
        g.fillText(str, iw / 2, ay);
        g.shadowBlur = 0;
        g.letterSpacing = '0px';
        g.restore();
    }

    // ══ 相机参数水印:底部居中两行(品牌 型号 / 焦距 光圈 快门 ISO) ══
    // 开启背景模糊(signBgBlur)时:按参考图做全出血模糊底 + 居中圆角照片 + 底部独立文字区。
    // 画布/照片比例由 paramCreditGeom 统一给出:照片宽≈画布 94.04%、高≈74.22%,
    // 上留白 8.25%,底部 17.5% 放两行字。品牌优先用彩色 Logo(Canon 红标),没有
    // 素材时用品牌色文字兜底 —— 发行包不带 shared/brandlogos,不能把红标当硬依赖。
    // 未开启背景模糊时保持原来的满幅照片 + 压底文字,避免影响不想要留白的用户。
    function styleParamCredit(img, size, g, iw, ih, S, cwO, chO) {
        const cam = S.cam || {};
        const trim = (v) => (v == null ? '' : String(v).trim());
        const brandRaw = trim(cam.brand);
        const model = trim(cam.model);
        // 无模糊的旧版式沿用原始 EXIF 文案,保证既有视觉基线不因文案归一化而漂移
        const line2Raw = [trim(cam.focal), trim(cam.aperture), trim(cam.shutter), trim(cam.iso)].filter(Boolean).join('  ');
        // 参考图第二行写作 ISO100 / 1/200(无尾 s);EXIF 常见 ISO 100 / 1/200s,
        // 只在底部版式里归一化,不改 S.cam 本身。
        let iso = trim(cam.iso);
        if (iso) iso = /^ISO/i.test(iso) ? iso.replace(/^ISO\s*/i, 'ISO') : 'ISO' + iso.replace(/\s+/g, '');
        const shutter = trim(cam.shutter).replace(/s$/i, '');
        const line2 = [trim(cam.focal), trim(cam.aperture), shutter, iso].filter(Boolean).join('  ');
        // 品牌文字兜底:Canon 用带衬线的红色字,其他品牌用各自品牌色/白色
        const drawLine = (text, fs, font, ay, cx, maxW) => {
            g.font = fs + 'px ' + font;
            let f = fs;
            if (g.measureText(text).width > maxW && f > 8) {
                f = Math.max(8, Math.floor(f * maxW / g.measureText(text).width));
                g.font = f + 'px ' + font;
            }
            g.fillText(text, cx, ay);
        };
        // 照片绘制:应用用户圆角(S.cornerAll,不超过短边一半)
        const drawPhoto = (x, y, w, h) => {
            const r = Math.min(S.cornerAll || 0, Math.min(w, h) / 2);
            if (r > 0 && g.roundRect) {
                g.save();
                g.beginPath(); g.roundRect(x, y, w, h, r); g.clip();
                g.drawImage(img, x, y, w, h);
                g.restore();
            } else {
                g.drawImage(img, x, y, w, h);
            }
        };
        if (S.signBgBlur) {
            const cw = cwO || paramCreditGeom(iw, ih).cw;
            const ch = chO || paramCreditGeom(iw, ih).ch;
            // ① 背景:同一张照片 cover 铺满 + 模糊/压暗,直接铺到画布边缘,不裁圆角
            g.save();
            g.fillStyle = '#1a2630'; g.fillRect(0, 0, cw, ch);
            g.filter = 'blur(' + Math.max(0, signBlurRad(S)) + 'px) brightness(0.58) saturate(0.92)';
            const bs = Math.max(cw / iw, ch / ih);
            const bw = iw * bs, bh = ih * bs;
            CanvasRenderingContext2D.prototype.drawImage.call(g, img, (cw - bw) / 2, (ch - bh) / 2, bw, bh);
            g.filter = 'none';
            g.restore();

            // ② 照片框:按画布比例留白。默认画布就是按这两个比例算出来的,
            // 所以框内比例=原图比例;用户改画布比例时用 cover 裁切,不拉变形。
            const frameW = Math.max(1, Math.round(cw * 0.9404));
            const frameH = Math.max(1, Math.round(ch * 0.7422));
            const frameY = Math.round(ch * 0.0825);
            const frameBottom = frameY + frameH;
            const barH = Math.max(1, ch - frameBottom);
            const sc = Math.max(0.2, S.imgScale || 1);
            const pw = Math.max(1, Math.round(frameW * sc));
            const ph = Math.max(1, Math.round(frameH * sc));
            const px = Math.round((cw - pw) / 2);
            const py = Math.round(frameY + (frameH - ph) / 2);
            const photoR = Math.min(Math.max(0, S.cornerAll || 0), Math.min(pw, ph) / 2);

            // 多层柔和投影:远层大范围扩散 + 近层接触阴影,照片盖住暗块后只露出外圈,
            // 让照片从模糊背景上浮起来;圆角越大,投影也沿圆角走。
            g.save();
            g.beginPath(); g.rect(0, 0, cw, ch); g.clip();
            g.shadowColor = 'rgba(0,0,0,0.62)';
            g.shadowBlur = Math.max(24, Math.round(Math.min(pw, ph) * 0.080));
            g.shadowOffsetY = Math.max(8, Math.round(Math.min(pw, ph) * 0.018));
            g.fillStyle = 'rgba(0,0,0,0.55)';
            roundRectPath(g, px, py, pw, ph, photoR);
            g.fill();
            g.shadowColor = 'rgba(0,0,0,0.55)';
            g.shadowBlur = Math.max(8, Math.round(Math.min(pw, ph) * 0.016));
            g.shadowOffsetY = Math.max(3, Math.round(Math.min(pw, ph) * 0.004));
            g.fillStyle = 'rgba(0,0,0,0.62)';
            roundRectPath(g, px, py, pw, ph, photoR);
            g.fill();
            g.restore();

            // ③ 照片本体:cover 到框内,圆角裁剪;9 参数绘制会走引擎的圆角劫持,这里再裁一次
            const srcAspect = iw / ih, dstAspect = pw / ph;
            let sx = 0, sy = 0, sw = iw, sh = ih;
            if (srcAspect > dstAspect) { sw = ih * dstAspect; sx = (iw - sw) / 2; }
            else if (srcAspect < dstAspect) { sh = iw / dstAspect; sy = (ih - sh) / 2; }
            g.save();
            g.beginPath(); g.rect(0, 0, cw, ch); g.clip();
            if (photoR > 0) { roundRectPath(g, px, py, pw, ph, photoR); g.clip(); }
            g.drawImage(img, sx, sy, sw, sh, px, py, pw, ph);
            g.restore();

            // ④ 底部文字区:底部轻微压暗,保证白字在亮部背景上仍可读;参考图没有重黑条
            const barGrad = g.createLinearGradient(0, frameBottom, 0, ch);
            barGrad.addColorStop(0, 'rgba(0,0,0,0)');
            barGrad.addColorStop(1, 'rgba(0,0,0,0.16)');
            g.fillStyle = barGrad;
            g.fillRect(0, frameBottom, cw, barH);

            const paramScale = (S.paramFs != null && S.paramFs > 0) ? S.paramFs / 33 : 1;
            let fs1 = Math.max(12, Math.round(cw * 0.0235 * paramScale));
            let fs2 = Math.max(10, Math.round(cw * 0.018 * paramScale));
            const y1 = frameBottom + Math.round(barH * 0.31);
            const y2 = frameBottom + Math.round(barH * 0.665);
            const maxW = cw - Math.round(cw * 0.10);
            const family = BRAND_SANS;
            const logoIm = (S.brandLogo !== 3 && S.brandLogoImg && S.brandLogoImg.complete && S.brandLogoImg.naturalWidth)
                ? S.brandLogoImg : null;
            const brandText = S.brandLogo === 3 ? '' : prettyBrand(brandRaw);
            const measureGroup = () => {
                const lh = Math.max(1, Math.round(fs1 * 0.92));
                const lw = logoIm ? Math.max(1, Math.round(lh * logoIm.naturalWidth / logoIm.naturalHeight)) : 0;
                let bw = 0;
                if (!logoIm && brandText) {
                    g.letterSpacing = '0px';
                    g.font = brandFont(Math.round(fs1 * 1.02), 700);
                    bw = g.measureText(brandText).width;
                }
                g.letterSpacing = '0.5px';
                g.font = '500 ' + fs1 + 'px ' + family;
                const mw = model ? g.measureText(model).width : 0;
                const gp = ((lw || bw) && mw) ? Math.round(fs1 * 0.42) : 0;
                return { lh, lw, bw, mw, gp, total: lw + bw + gp + mw };
            };
            let group = measureGroup();
            if (group.total > maxW) {
                const k = maxW / group.total;
                fs1 = Math.max(8, Math.floor(fs1 * k));
                group = measureGroup();
            }
            const startX = Math.round(cw / 2 - group.total / 2);
            const modelY = y1 + Math.round(fs1 * 0.10);
            g.save();
            g.textAlign = 'left';
            g.textBaseline = 'middle';
            g.shadowColor = 'rgba(0,0,0,0.45)';
            g.shadowBlur = Math.max(1, Math.round(cw * 0.0015));
            g.shadowOffsetY = Math.max(1, Math.round(cw * 0.0008));
            let tx = startX;
            if (logoIm) {
                g.save();
                g.shadowColor = 'transparent';
                g.shadowBlur = 0;
                g.shadowOffsetY = 0;
                g.letterSpacing = '0px';
                g.drawImage(logoIm, tx, Math.round(y1 - group.lh / 2), group.lw, group.lh);
                g.restore();
                tx += group.lw + group.gp;
            } else if (brandText) {
                g.letterSpacing = '0px';
                g.font = brandFont(Math.round(fs1 * 1.02), 700);
                g.fillStyle = brandInk(brandRaw, true);
                g.fillText(brandText, tx, modelY);
                tx += group.bw + group.gp;
            }
            if (model) {
                g.letterSpacing = '0.5px';
                g.font = '500 ' + fs1 + 'px ' + family;
                g.fillStyle = '#ffffff';
                g.fillText(model, tx, modelY);
            }
            if (line2) {
                g.letterSpacing = '0px';
                const family2 = '"Segoe UI", Arial, "Microsoft YaHei", sans-serif';
                g.font = '400 ' + fs2 + 'px ' + family2;
                const tw = g.measureText(line2).width;
                if (tw > maxW) {
                    fs2 = Math.max(8, Math.floor(fs2 * maxW / tw));
                    g.font = '400 ' + fs2 + 'px ' + family2;
                }
                g.textAlign = 'center';
                g.fillStyle = '#ffffff';
                g.fillText(line2, cw / 2, y2);
            }
            g.restore();
            return;
        }
        // 纯原图直压:照片按 imgScale 缩放居中(缩小露深色底,放大居中裁切),带圆角
        const natW = iw, natH = ih;
        const cw = cwO || natW, ch = chO || natH;
        const ox = Math.max(0, Math.round((cw - natW) / 2));
        const oy = Math.max(0, Math.round((ch - natH) / 2));
        g.save();
        g.translate(ox, oy);
        const pw = Math.round(iw * (S.imgScale || 1)), ph = Math.round(ih * (S.imgScale || 1));
        if (pw < iw || ph < ih) { g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, iw, ih); }
        drawPhoto(Math.round((iw - pw) / 2), Math.round((ih - ph) / 2), pw, ph);
        const maxW = iw - Math.round(iw * 0.08);
        // 参数字号滑块对无模糊版式也生效;默认 33 时保持原来的固定字号不变。
        const pfScale = (S.paramFs != null && S.paramFs > 0) ? S.paramFs / 33 : 1;
        const fs1 = Math.max(14, Math.round(iw * 0.026 * pfScale));
        const fs2 = Math.max(11, Math.round(fs1 * 0.75));
        const ay2 = ih - Math.round(iw * 0.05);
        const ay1 = ay2 - Math.round(iw * 0.052);
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        g.fillStyle = S.signColor || '#fff';
        g.shadowColor = 'rgba(0,0,0,0.5)';
        g.shadowBlur = 3;
        drawLine(line2Raw, fs2, "'Courier New', 'Courier New', monospace", ay2, iw / 2, maxW);
        // 品牌词单独绘制:与相机参数水印/其他预设一致的品牌衬线字与品牌色。
        const brandTxt = S.brandLogo === 3 ? '' : prettyBrand(brandRaw);
        const modelTxt = model;
        const brandW = brandTxt ? brandTextWidth(g, brandTxt, fs1, 0) : 0;
        const modelW = modelTxt ? textMetrics(g, modelTxt, fs1, true, true, 0).w : 0;
        const brandGap = (brandTxt && modelTxt) ? Math.round(fs1 * 0.4) : 0;
        let totalW = brandW + brandGap + modelW;
        let drawFs = fs1;
        if (totalW > maxW && totalW > 0) {
            drawFs = Math.max(8, Math.floor(fs1 * maxW / totalW));
            totalW = brandW * drawFs / fs1 + brandGap + modelW * drawFs / fs1;
        }
        const bx = iw / 2 - totalW / 2;
        if (brandTxt) {
            g.textAlign = 'left';
            g.font = brandFont(drawFs, 700);
            g.letterSpacing = '0px';
            g.fillStyle = brandInk(brandRaw, false);
            g.fillText(brandTxt, bx, ay1);
        }
        if (modelTxt) {
            g.textAlign = 'left';
            g.font = '700 ' + drawFs + "px 'Helvetica Neue', Arial, sans-serif";
            g.letterSpacing = '0px';
            g.fillStyle = S.signColor || '#fff';
            g.fillText(modelTxt, bx + brandW * drawFs / fs1 + brandGap, ay1);
        }
        g.shadowBlur = 0;
        g.restore();
    }

    // ══ 液态玻璃 (Liquid Glass) ══
    // 复刻 com.dengziwl.bk 的 LiquidGlassWatermarkRenderer / LiquidGlassBackdropRenderer:
    // 全出血照片 + 底部胶囊玻璃条。玻璃条不是简单的半透明矩形,而是:
    //   背景裁切 → 饱和度 1.5 → 高斯模糊(8dp × haze)→ 圆角 SDF 折射(24dp × strength)
    //   → 暗色 tint → 45° 高光描边,最后叠白字(品牌/机型 + 参数/日期)。
    // 几何与 APK 一致:左右 8dp、底 6dp、高 45dp,dp = 画布宽 / 375;圆角 = 条高/2。
    // k = 面板「玻璃条大小」倍率(默认 1 = 原尺寸)。它只乘 dp 基准 scale,
    // 于是胶囊高/内边距/字号/Logo槽/分隔线/投影/折射带一起等比变化 ——
    // 放大后仍是同一张设计稿,而不是"框变大、字变小"。
    function lgRoundRect(g, x, y, w, h, r) {
        const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
        g.beginPath();
        if (typeof g.roundRect === 'function') { g.roundRect(x, y, w, h, rr); return; }
        g.moveTo(x + rr, y);
        g.arcTo(x + w, y, x + w, y + h, rr);
        g.arcTo(x + w, y + h, x, y + h, rr);
        g.arcTo(x, y + h, x, y, rr);
        g.arcTo(x, y, x + w, y, rr);
        g.closePath();
    }

    function liquidGlassGeom(iw, ih, k) {
        const kk = Math.max(0.2, Math.min(3, Number(k) || 1));
        const scale = Math.max(iw / 375, 0.01) * kk;
        const side = 8 * scale, bottomPad = 6 * scale;
        const left = side, right = Math.max(side, iw - side);
        const bottom = Math.max(0, ih - bottomPad);
        const capH = Math.min(Math.max(1, 45) * scale, ih);
        const top = Math.max(0, bottom - capH);
        const w = Math.max(1, right - left), h = Math.max(1, bottom - top);
        return { scale, left, top, right, bottom, w, h, radius: h / 2, side, bottomPad };
    }

    // 圆角矩形 SDF 折射。与 AGSL 版逐像素同构:边缘处采样向内偏移(圆环映射),
    // 偏移量在胶囊边缘最大、向内 refractionHeight 处衰减到 0。只处理边缘带,内部整行跳过。
    function liquidGlassRefract(data, w, h, radius, dp, strength) {
        const refH = 24 * dp * strength;
        if (!(refH > 0.5) || strength <= 0) return;
        const amount = -24 * dp * strength;
        const src = data.data;
        const dst = new Uint8ClampedArray(src);
        const hw = w / 2, hh = h / 2;
        const inW = hw - radius, inH = hh - radius;
        const gradR = Math.min(radius * 1.5, Math.min(hw, hh));
        const ginW = hw - gradR, ginH = hh - gradR;
        for (let y = 0; y < h; y++) {
            const cy = y + 0.5 - hh, acy = Math.abs(cy);
            const qy = acy - inH, qyG = acy - ginH;
            const oy = qy > 0 ? qy : 0;
            const row = y * w;
            for (let x = 0; x < w; x++) {
                const cx = x + 0.5 - hw, acx = Math.abs(cx);
                const qx = acx - inW;
                const ox = qx > 0 ? qx : 0;
                const outside = Math.sqrt(ox * ox + oy * oy) - radius;
                const inside = Math.min(Math.max(qx, qy), 0);
                const sd = outside + inside;
                if (-sd >= refH) continue;
                // 与 gradSdRoundedRect 同构(含 circleMap 的位移量)
                const gqx = acx - ginW, gqy = qyG;
                let gx, gy;
                if (gqx >= 0 || gqy >= 0) {
                    const nx = gqx > 0 ? gqx : 0, ny = gqy > 0 ? gqy : 0;
                    const nl = Math.sqrt(nx * nx + ny * ny) || 1;
                    gx = (cx < 0 ? -1 : 1) * nx / nl;
                    gy = (cy < 0 ? -1 : 1) * ny / nl;
                } else {
                    const sx = gqx >= gqy ? 1 : 0;
                    gx = (cx < 0 ? -1 : 1) * sx;
                    gy = (cy < 0 ? -1 : 1) * (1 - sx);
                }
                const gl = Math.sqrt(gx * gx + gy * gy);
                if (gl < 1e-6) continue;
                const t = 1 + Math.min(sd, 0) / refH;
                const disp = (1 - Math.sqrt(Math.max(0, 1 - t * t))) * amount / gl;
                let sx = x + 0.5 + disp * gx - 0.5;
                let sy = y + 0.5 + disp * gy - 0.5;
                if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1;
                if (sy < 0) sy = 0; else if (sy > h - 1) sy = h - 1;
                const x0 = sx | 0, y0 = sy | 0;
                const x1 = x0 + 1 < w ? x0 + 1 : w - 1;
                const y1 = y0 + 1 < h ? y0 + 1 : h - 1;
                const fx = sx - x0, fy = sy - y0;
                const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
                const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
                const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
                const w01 = (1 - fx) * fy, w11 = fx * fy;
                const o = (row + x) * 4;
                for (let ch = 0; ch < 3; ch++) {
                    dst[o + ch] = src[i00 + ch] * w00 + src[i10 + ch] * w10 + src[i01 + ch] * w01 + src[i11 + ch] * w11;
                }
                dst[o + 3] = 255;
            }
        }
        data.data.set(dst);
    }

    // 玻璃底板:只渲染胶囊区域,上限 2048(APK 为 4096;这里是每帧实时预览,分辨率对模糊底不可见)。
    function liquidGlassBitmap(img, iw, ih, geo, S) {
        const cap = Math.min(1, 2048 / Math.max(geo.w, geo.h));
        const gw = Math.max(1, Math.round(geo.w * cap));
        const gh = Math.max(1, Math.round(geo.h * cap));
        const dp = geo.scale * cap;
        // 面板的「背景模糊程度」直接映射 APK 的 haze:50 → 1(参考图观感),0 → 全清,100 → 2。
        const haze = Math.max(0, Math.min(2, (S && S.blurIntensity != null ? S.blurIntensity : 50) / 50));
        const blurPx = 8 * dp * haze;
        const pad = Math.ceil(blurPx * 2) + 4;

        // 1) 背景:按胶囊坐标系裁切,四周多画 pad 供模糊采样,避免边缘发黑。
        const pc = newCanvas(gw + pad * 2, gh + pad * 2);
        const pg = pc.getContext('2d');
        const padCss = pad / cap;
        const bx0 = geo.left - padCss, by0 = geo.top - padCss;
        const bx1 = geo.right + padCss, by1 = geo.bottom + padCss;
        const sx = Math.max(0, bx0), sy = Math.max(0, by0);
        const ex = Math.min(iw, bx1), ey = Math.min(ih, by1);
        if (ex > sx && ey > sy) {
            drawPhotoRegion(pg, img, iw, ih, sx, sy, ex - sx, ey - sy,
                (sx - bx0) * cap, (sy - by0) * cap, (ex - sx) * cap, (ey - sy) * cap);
        }

        const glass = newCanvas(gw, gh);
        const g = glass.getContext('2d');
        g.imageSmoothingEnabled = true;
        const filters = ['saturate(1.5)'];
        if (blurPx > 0.05) filters.push('blur(' + blurPx.toFixed(2) + 'px)');
        g.filter = filters.join(' ');
        g.drawImage(pc, -pad, -pad);
        g.filter = 'none';

        // 2) 折射(逐像素)
        const strength = 0.3; // APK 默认 liquidGlassStrength=30
        try {
            const im = g.getImageData(0, 0, gw, gh);
            liquidGlassRefract(im, gw, gh, Math.min(gh / 2, gw / 2), dp, strength);
            g.putImageData(im, 0, 0);
        } catch (e) { /* 取像素失败时保留未折射版本 */ }

        // 3) 暗色 tint(APK: rgba(18,18,18, 0.4*haze);上限 0.45 避免滑块拉满后死黑)
        const tintA = Math.min(0.45, 0.4 * haze);
        if (tintA > 0.001) {
            g.fillStyle = 'rgba(18,18,18,' + tintA.toFixed(3) + ')';
            g.fillRect(0, 0, gw, gh);
        }

        // 4) 45° 高光:APK 用 RuntimeShader 按法线强度画整圈描边,这里用加法混合的模糊描边近似
        const lw = Math.max(1, 2 * Math.ceil(Math.min(0.5 * dp, Math.min(gw, gh) / 2)));
        const inset = lw / 2;
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = lw;
        if (0.25 * dp > 0.05) g.filter = 'blur(' + (0.25 * dp).toFixed(2) + 'px)';
        lgRoundRect(g, inset, inset, Math.max(1, gw - lw), Math.max(1, gh - lw),
            Math.max(1, Math.min(gh / 2, gw / 2) - inset));
        g.stroke();
        g.restore();
        return glass;
    }

    function lgFitFont(g, text, basePx, weight, maxW, step) {
        let px = basePx;
        const minPx = basePx * 0.5;
        g.font = weight + ' ' + px + 'px ' + LG_FONT;
        while (px > minPx && g.measureText(text).width > maxW) {
            px -= step;
            g.font = weight + ' ' + px + 'px ' + LG_FONT;
        }
        return px;
    }

    const LG_FONT = '"Segoe UI", "Courier New", Arial, "Microsoft YaHei", sans-serif';

    function styleLiquidGlass(img, size, g, iw, ih, S) {
        const geo = liquidGlassGeom(iw, ih, S && S.glassSize);
        const scale = geo.scale, capW = geo.w, capH = geo.h;
        const radius = geo.radius;

        // 照片满幅(APK 先铺黑底再画图,透明 PNG 不会漏出画布底色)
        g.fillStyle = '#000000';
        g.fillRect(0, 0, iw, ih);
        g.drawImage(img, 0, 0, iw, ih);

        // 投影:rgba(0,0,0,0.1), blur 24dp, offsetY 4dp
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.1)';
        g.shadowBlur = 24 * scale;
        g.shadowOffsetY = 4 * scale;
        g.fillStyle = '#000000';
        lgRoundRect(g, geo.left, geo.top, capW, capH, radius);
        g.fill();
        g.restore();

        // 玻璃底板 + 胶囊裁切
        const glass = liquidGlassBitmap(img, iw, ih, geo, S);
        g.save();
        lgRoundRect(g, geo.left, geo.top, capW, capH, radius);
        g.clip();
        g.drawImage(glass, geo.left, geo.top, capW, capH);
        g.restore();

        // ── 文案 ──
        const cam = (S && S.cam) || {};
        const hidden = brandHidden(S);
        const im = (!hidden && S && S.brandLogoImg && S.brandLogoImg.complete && S.brandLogoImg.naturalWidth > 0)
            ? S.brandLogoImg : null;
        const wantsLogo = !!(im && S && (S.brandLogo === 1 || S.brandLogo === 2));
        let brand = hidden ? '' : (prettyBrand(cam.brand) || 'QINGFRAME');
        if (wantsLogo && S.brandLogo === 2) brand = '';
        let model = hidden ? '' : (cam.model ? String(cam.model).toUpperCase() : (cam.brand ? '' : 'QINGFRAME 100'));
        if (!brand && !model && !hidden && !wantsLogo) brand = 'QINGFRAME';

        let focal = String(cam.focal || '35mm');
        if (/^\d+(\.\d+)?$/.test(focal)) focal += 'mm';
        const ap = String(cam.aperture || 'f/1.8').replace(/^f\//i, 'F');
        let shut = String(cam.shutter || '1/125').toUpperCase();
        if (!/S$/.test(shut)) shut += 'S';
        let iso = String(cam.iso || 'ISO 300');
        if (!/^ISO/i.test(iso)) iso = 'ISO ' + iso;
        const paramText = [focal, ap, shut, iso].filter(Boolean).join('  ');
        const dateText = dateTimeYMD();

        const padX = 24 * scale;
        const step = 0.25 * scale;
        const maxRightW = Math.max(1, (capW - padX * 2) * 0.45);
        const textFs = lgFitFont(g, paramText, 11 * scale, 700, maxRightW, step);
        const showDate = !!(S && S.glassDateShow);
        const dateFs = showDate ? lgFitFont(g, dateText, 8 * scale, 400, maxRightW, step) : 0;
        g.font = '700 ' + textFs + 'px ' + LG_FONT;
        const textW = g.measureText(paramText).width;
        let dateW = 0;
        if (showDate) {
            g.font = '400 ' + dateFs + 'px ' + LG_FONT;
            dateW = g.measureText(dateText).width;
        }
        const rightW = showDate ? Math.min(maxRightW, Math.max(textW, dateW)) : Math.min(maxRightW, textW);
        const rightX = geo.right - padX - rightW;
        const dividerX = rightX - 6 * scale;
        // APK 无论 logo 位图是否存在,都按 24dp 预留中间 logo 槽(见 drawContent 的 f6/f11),
        // 左侧品牌名因此有固定可用宽度;只在真要画 logo 时才有图像落进这个槽。
        const logoSlot = Math.min(24 * scale, capH);
        const logoX = dividerX - 6 * scale - logoSlot;
        const leftX = geo.left + padX;
        const leftMaxW = Math.max(1, (logoX - leftX) - 12 * scale);

        const brandFs = lgFitFont(g, brand, 11 * scale, 700, leftMaxW, step);
        const modelFs = lgFitFont(g, model, 7.5 * scale, 400, leftMaxW, step);

        const h1 = 23 * scale, h2 = 17 * scale;
        // 左列品牌+型号两行始终整体居中;右列日期关闭时参数单行垂直居中、开启时与左列对齐
        const blockTopL = geo.top + capH / 2 - (h1 + h2) / 2;
        const baseL1 = blockTopL + 0.75 * h1;
        const baseL2 = blockTopL + h1 + 0.7 * h2;
        const baseR1 = showDate ? baseL1 : geo.top + capH / 2 - h1 / 2 + 0.75 * h1;
        const baseR2 = showDate ? baseL2 : 0;

        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.letterSpacing = '0px';
        if (brand) {
            g.font = '700 ' + brandFs + 'px ' + LG_FONT;
            g.fillStyle = '#ffffff';
            g.fillText(brand.toUpperCase(), leftX, baseL1);
        }
        if (model) {
            g.font = '400 ' + modelFs + 'px ' + LG_FONT;
            g.fillStyle = 'rgba(255,255,255,0.957)';
            g.fillText(model, leftX, baseL2);
        }

        if (wantsLogo) {
            const lw = im.naturalWidth, lh = im.naturalHeight;
            const k = Math.min(logoSlot / lw, logoSlot / lh);
            const dw = lw * k, dh = lh * k;
            g.drawImage(im, logoX + (logoSlot - dw) / 2, geo.top + capH / 2 - dh / 2, dw, dh);
        }

        // 竖分隔线:alpha 198/255,宽 0.5dp,上下各内缩 9dp
        g.strokeStyle = 'rgba(255,255,255,0.776)';
        g.lineWidth = Math.max(1, 0.5 * scale);
        g.beginPath();
        g.moveTo(dividerX, geo.top + 9 * scale);
        g.lineTo(dividerX, geo.top + capH - 9 * scale);
        g.stroke();

        g.font = '700 ' + textFs + 'px ' + LG_FONT;
        g.fillStyle = '#ffffff';
        g.fillText(paramText, rightX, baseR1);
        g.font = '400 ' + dateFs + 'px ' + LG_FONT;
        g.fillStyle = 'rgba(255,255,255,0.957)';
        if (showDate) {
            g.fillText(dateText, rightX, baseR2);
        }
    }

    const draw = {
            SIMPLE: styleSimple, WHITE_PLAIN: styleWhitePlain, ROUNDED: styleRounded,
            FILM_STRIP: styleFilmStrip, FILM_TEAR: styleFilmTear, POLAROID: stylePolaroid,
            DOUBLE_LINE: styleDoubleLine, VINTAGE: styleVintage,
            GRADIENT: styleGradient, DROP_SHADOW: styleDropShadow,
            BLUR_CLASSIC: styleBlurClassic, BLUR_DATE: styleBlurDate,
            WM_CLASSIC: styleWmClassic, WM_SINGLE: styleWmSingle, WM_BRAND_LOGO: styleWmBrandLogo, WM_AI: styleWmAi,
            HASSELBLAD: styleHasselblad,
            IMP_FROSTED: styleImpFrosted, IMP_CLASSIC: styleImpClassic, XIAOMI_IMP: styleXiaomiImp,
            CARD_LEICA: styleCardLeica, CARD_LOGO_PARAM: styleCardLogoParam, CARD_PURE_LOGO: styleCardPureLogo,
            CARD_SIMPLE: styleCardSimple, CARD_IMMERSION: styleCardImmersion, CARD_APPLE: styleCardApple,
            XIAOMI_LEICA: styleXiaomiLeica,
            OVERLAY_PARAM_LEFT: (img, size, g, iw, ih, S2, cwO, chO) => styleOverlayParams(img, size, g, iw, ih, S2, 0, cwO, chO),
            OVERLAY_PARAM_RIGHT: (img, size, g, iw, ih, S2, cwO, chO) => styleOverlayParams(img, size, g, iw, ih, S2, 1, cwO, chO),
            OVERLAY_PARAM_BOTTOM: (img, size, g, iw, ih, S2, cwO, chO) => styleOverlayParams(img, size, g, iw, ih, S2, 2, cwO, chO),
        FUJI_WM: (img,size,g,iw,ih,S) => styleFujifilm(img,size,g,iw,ih,S,false),
        FUJI_WM_BRAND: (img,size,g,iw,ih,S) => styleFujifilm(img,size,g,iw,ih,S,true),
        DARK_BRAND_ONLY: (img,size,g,iw,ih,S) => styleFujifilm(img,size,g,iw,ih,S,true,false),
            OVERLAY_LOGO_BOTTOM: styleOverlayLogo,
            COLOR_CLASSIC: styleColorClassic, COLOR_REFINED: styleColorRefined, ART_CARD: styleArtCard,
            FUJI_WHITE: styleFujiWhite, SIMPLE_FILM: styleSimpleFilm,
            PARAM_TOP_LEFT: styleParamTopLeft, PARAM_BOTTOM_LEFT: styleParamBottomLeft, PARAM_BOTTOM_SINGLE: styleParamBottomSingle,
            STAMP_POSTAGE: styleStampPostage, TEARED_PAPER: styleTornPaper,
            FOLD_CORNER: styleFoldCorner, PINBOARD_TAPE: stylePinboardTape, DOUBLE_EXPOSURE: styleDoubleExposure, MAGAZINE_MASTHEAD: styleMagazineMasthead, MAGAZINE_COVER: styleMagazineCover, MAGAZINE_HEADER: styleMagazineHeader,
            VHS_TAPE: styleVhsTape, ALBUM_CORNER: styleAlbumCorner,
                        MOVIE_TICKET: styleMovieTicket, BOARDING_PASS: styleBoardingPass, WATERCOLOR_BLEED: styleWatercolorBleed,
            TICKET_VINTAGE: (img, size, g, iw, ih, S) => styleTicket(img, size, g, iw, ih, S, 'vintage'),
            TICKET_CONCERT: (img, size, g, iw, ih, S) => styleTicket(img, size, g, iw, ih, S, 'concert'),
            TICKET_SCRAP: (img, size, g, iw, ih, S) => styleTicket(img, size, g, iw, ih, S, 'scrap'),
            TICKET_STAMP: (img, size, g, iw, ih, S) => styleStamp(img, size, g, iw, ih, S, 'classic'),
            STAMP_KRAFT: (img, size, g, iw, ih, S) => styleStamp(img, size, g, iw, ih, S, 'kraft'),
            STAMP_BLUEPRINT: (img, size, g, iw, ih, S) => styleStamp(img, size, g, iw, ih, S, 'blueprint'),
            STAMP_REDSEAL: (img, size, g, iw, ih, S) => styleStamp(img, size, g, iw, ih, S, 'redseal'),
            STAMP_GOLD: (img, size, g, iw, ih, S) => styleStamp(img, size, g, iw, ih, S, 'gold'),
            NEON_GLOW: styleNeonGlow, BURNED_EDGE: styleBurnedEdge,
            INK_WASH: styleInkWash, CYANOTYPE: styleCyanotype,
            OIL_BRUSH: styleOilBrush, PRESSED_FLOWER: stylePressedFlower,
            WAX_SEAL: styleWaxSeal, PRISMATIC: stylePrismatic,
            CYBER_GLITCH: styleCyberGlitch, POLAROID_HAND: (img, size, g, iw, ih, S) => stylePolaroidHand(img, size, g, iw, ih, S),
            TORN_JOURNAL: styleTornJournal, CARD_3D: styleCard3D,
            LIQUID_GLASS: styleLiquidGlass,
            COMIC_PANEL: styleComicPanel, POP_COMIC: stylePopComic, NEWSPAPER: styleNewspaper,
            COLOR_PALETTE: styleColorPalette,
            SIGNATURE: styleSignature, SIGN_PARAM: styleSignParam,
            AVATAR_MEMO: styleAvatarMemo,
            SIGN_BLUR: styleSignBlur,
            SIG_BLUR: styleSigBlur,
            AV_BLUR: styleAvBlur,
            AV_OVERLAY: styleAvOverlay,
            AV_OVERLAY_TR: styleAvOverlayTR,
            AV_OVERLAY_BR: styleAvOverlayBR,
            AV_OVERLAY_BC: styleAvOverlayBC,
            AV_OVERLAY_BC2: styleAvOverlayBC2,
            GALLERY_MAT: styleGalleryMat,
            PARAM_STRIP: styleParamStrip,
            PHOTO_CREDIT: stylePhotoCredit,
            PARAM_CREDIT: styleParamCredit,
        }[styleName];
        const S = buildState(app, styleName, iw, ih, size);

        try {
            let out;
            // 照片在「最终画布基准坐标」上的矩形（蒙版叠加层用）。由下面的 drawImage 劫持抓取，
            // expandToRatio 补边后再按居中偏移修正。
            let photoRect = null;
            // 照片是否正好铺满整张基础画布（全出血风格）。圆角后成片四角会变透明，
            // 需要把成片也裁到同一圆角里，避免水印/scrim 漏进被裁掉的角。
            let photoCoversCanvas = false;
            if (!draw) {
                const dims = styleDims('_PH', iw, ih, size);
                out = newCanvas(dims.w, dims.h);
                const g = out.getContext('2d');
                stylePlaceholder(img, styleName, g, iw, ih);
            } else {
                const dims = styleDims(styleName, iw, ih, size, S);
                // 全出血模糊铺满画布的风格:把显式比例算进画布本体,由风格自身铺模糊并居中内容块,
                // 扩边处是同一张模糊的延伸,不出现硬性实色补边。
                //  BLUR_CLASSIC/BLUR_DATE 恒定模糊底;签名/头像/印象留白/logo参数 只在用户
                //  开启「背景模糊」(signBgBlur)时才进入,未开模糊时保持原卡片样式不扩展。
                const BLUR_FULLBLEED = ['BLUR_CLASSIC', 'BLUR_DATE', 'SIGNATURE', 'SIGN_PARAM', 'AVATAR_MEMO',
                    'AV_OVERLAY', 'AV_OVERLAY_TR', 'AV_OVERLAY_BR', 'AV_OVERLAY_BC', 'AV_OVERLAY_BC2', 'PHOTO_CREDIT', 'PARAM_CREDIT',
                    'OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM', 'CARD_LOGO_PARAM'];
                const blurMode = BLUR_FULLBLEED.indexOf(styleName) !== -1 &&
                    (styleName === 'BLUR_CLASSIC' || styleName === 'BLUR_DATE' || (S && S.signBgBlur));
                let targetW = dims.w, targetH = dims.h;
                if (blurMode) {
                    const er2 = effectiveCanvasRatio(t);
                    const wh2 = parseRatio(er2);
                    if (wh2 && wh2[0] > 0 && wh2[1] > 0) {
                        const tr2 = wh2[0] / wh2[1], cr2 = dims.w / dims.h;
                        if (cr2 > tr2) targetH = Math.max(1, Math.round(dims.w / tr2));
                        else targetW = Math.max(1, Math.round(dims.h * tr2));
                    }
                }
                out = newCanvas(targetW, targetH);
                const g = out.getContext('2d');
                g.imageSmoothingEnabled = true;
                // 劫持 drawImage 做三件事：
                //  ① 画照片时套用 cornerConfig 圆角（原有行为）
                //  ② 记下照片在这张离屏画布上的矩形（基准坐标）—— 蒙版叠加层靠它
                //    把指针换算成「照片内坐标」。相框有 60 多款、各自排版，逐款上报
                //    不现实，统一在「画照片」这一次调用上抓最省事也最准。
                //  ③ 把「按位图尺寸画」换算成「按原图尺寸画」——见下面的 natW/downX。
                const cc = t.cornerConfig || {};
                const photoTl = cc.cornerRadiusTL || 0, photoTr = cc.cornerRadiusTR || 0;
                const photoBl = cc.cornerRadiusBL || 0, photoBr = cc.cornerRadiusBR || 0;
                const photoRAll = cc.cornerRadiusAll || 0;
                const hasPhotoRound = photoRAll > 0 || photoTl > 0 || photoTr > 0 || photoBl > 0 || photoBr > 0;
                const photoRound = photoRAll > 0 ? photoRAll : Math.min(photoTl, photoTr, photoBl, photoBr);
                const origDrawImage = g.drawImage.bind(g);
                // 拖动滑块时 photoSrc 返回的是 1600px 的降采样烘焙画布（app-grade 的
                // low 档），它的 width 只有原图的 1/3.7，但上游版式（iw/ih、size、pad、
                // 各种百分比）全是按 naturalWidth 算的。60 多款相框样式里有 100 多处
                // drawImage(img, x, y) —— 3 参数形式按**位图实际尺寸**落笔，于是照片被
                // 画成 27% 大小贴在左上角，松手补全分辨率才跳回来（用户实测：
                // 「每拖一次滑块画面就缩到左上角」）。
                // 这里统一把「画照片」这一次调用换算成 natural 尺寸：样式代码一行不用改，
                // 正常全分辨率源时 downX/downY 恒为 1，落笔参数与原来逐字节一致。
                const natW = Math.max(1, img.naturalWidth || img.width || 1);
                const natH = Math.max(1, img.naturalHeight || img.height || 1);
                // 测试用：把换算关掉，复现「拖滑块照片缩到左上角」的旧行为
                // （npm run test:lowres 会带 QF_LOWRES_LEGACY=1 验一次，确认用例真能抓到）
                const legacyDraw = !!window.QFS_LEGACY_PHOTO_DRAW;
                const isBmpCanvas = !legacyDraw && !!(img && img.tagName === 'CANVAS');
                const downX = isBmpCanvas ? Math.max(1, img.width) / natW : 1;
                const downY = isBmpCanvas ? Math.max(1, img.height) / natH : 1;
                g.drawImage = function(src, ...args) {
                    if (src !== img) { origDrawImage(src, ...args); return; }
                    let dx = 0, dy = 0;
                    let dw = legacyDraw ? (img.width || natW) : natW;
                    let dh = legacyDraw ? (img.height || natH) : natH;
                    // ⚠ args 不含 src:三/五/九参数形式的 rest 长度是 2/4/8。
                    //   这里曾经写成 3/5/9,永远不命中 → 恒走默认值 (0,0,img.width,img.height),
                    //   所有相框风格的蒙版范围都按"原图铺满画布"定位(照片越偏离画布原点错得越狠)。
                    if (args.length === 2) { dx = args[0]; dy = args[1]; }
                    else if (args.length === 4) { dx = args[0]; dy = args[1]; dw = args[2]; dh = args[3]; }
                    else if (args.length === 8) { dx = args[4]; dy = args[5]; dw = args[6]; dh = args[7]; }
                    // 真正落笔。3 参数要补成 5 参数（否则按位图尺寸画）；9 参数的
                    // 源矩形是按 natural 坐标写的，要按降采样比缩回位图坐标。
                    const put = () => {
                        if (args.length === 2) origDrawImage(img, dx, dy, dw, dh);
                        else if (args.length === 8) {
                            origDrawImage(img, args[0] * downX, args[1] * downY,
                                args[2] * downX, args[3] * downY, dx, dy, dw, dh);
                        } else origDrawImage(img, ...args);
                    };
                    // 模糊铺底画的也是同一张 img，但它是背景不是照片本身：
                    // 带 filter 的那次跳过，否则蒙版会按整张画布定位。
                    if (!photoRect && (!g.filter || g.filter === 'none') && dw > 0 && dh > 0) {
                        // 有些样式先 translate/rotate 再画照片（倾斜、手账类），dx/dy 是局部坐标：
                        // 用当前变换把四个角映射回画布坐标，取轴对齐包围盒。无变换时结果就是原矩形。
                        let x0 = dx, y0 = dy, x1 = dx + dw, y1 = dy + dh;
                        try {
                            const m = g.getTransform ? g.getTransform() : null;
                            if (m && (m.a !== 1 || m.b !== 0 || m.c !== 0 || m.d !== 1 || m.e !== 0 || m.f !== 0)) {
                                const pts = [[dx, dy], [dx + dw, dy], [dx, dy + dh], [dx + dw, dy + dh]]
                                    .map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
                                x0 = Math.min(...pts.map((p) => p[0])); x1 = Math.max(...pts.map((p) => p[0]));
                                y0 = Math.min(...pts.map((p) => p[1])); y1 = Math.max(...pts.map((p) => p[1]));
                            }
                        } catch (_) { /* 拿不到变换就按原矩形 */ }
                        photoRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
                    }
                    if (!hasPhotoRound || !(dw > 0 && dh > 0)) { put(); return; }
                    g.save();
                    if (photoRound > 0 && g.roundRect) {
                        g.beginPath(); g.roundRect(dx, dy, dw, dh, photoRound); g.clip();
                    }
                    put();
                    g.restore();
                };
                if (blurMode) draw(img, size, g, iw, ih, S, targetW, targetH);
                else draw(img, size, g, iw, ih, S);
                g.drawImage = origDrawImage;
                // 照片正好铺满整张画布（全出血风格）。这类风格通常没有独立底色：
                //  - 圆角时要连水印/scrim 一起裁，否则黑块漏进被裁掉的四角；
                //  - 补边取色要认准这张照片本身，否则圆角一改补边色就跟着变。
                // 但液态玻璃这类风格会先在画布上铺一层不透明黑底（那是画布背景，
                // 不是照片），它的四角在圆角外仍是不透明黑，不能一起裁掉。
                // 联名水印是已知的纯照片全出血（自身不铺任何底色），圆角 0 时也按
                // 源照片取补边色，避免从 0 调到 >0 时补边色从「含 scrim 的成片角」跳变。
                if (photoRect && photoRect.x <= 1 && photoRect.y <= 1
                    && photoRect.x + photoRect.w >= out.width - 1
                    && photoRect.y + photoRect.h >= out.height - 1) {
                    let noCanvasBg = styleName === 'XIAOMI_LEICA';
                    if (!noCanvasBg && hasPhotoRound && photoRound > 0) {
                        try {
                            const cg0 = out.getContext('2d');
                            const aL = cg0.getImageData(0, 0, 1, 1).data[3];
                            const aR = cg0.getImageData(out.width - 1, 0, 1, 1).data[3];
                            noCanvasBg = !(aL > 60 || aR > 60);
                        } catch (e) { /* 读不到就按有背景处理 */ }
                    }
                    if (noCanvasBg) {
                        photoCoversCanvas = true;
                        if (hasPhotoRound && photoRound > 0) {
                            const cg = out.getContext('2d');
                            cg.save();
                            cg.globalCompositeOperation = 'destination-in';
                            roundRectPath(cg, photoRect.x, photoRect.y, photoRect.w, photoRect.h, photoRound);
                            cg.fill();
                            cg.restore();
                        }
                    }
                }
                // 整体画布边框圆角
                const borderR = t.borderRadius || 0;
                if (borderR > 0) out = singleCornerClip(out, borderR);

                const decor = t.decorConfig || {};
                if ((decor.cornerDecorEnable || 0) === 1 && typeof window.drawCornerDecor === 'function') {
                    window.drawCornerDecor(out.getContext('2d'), decor.cornerDecorType || 'line', decor.cornerDecorSize || 30, out.width, out.height);
                }
            }

            // 相框样式也支持画布比例(只扩大、不裁切)。仅当用户启用了背景模糊(bgBlurEnable)
            // 时补边才用模糊照片延伸,否则回退四角采样纯色,避免没开模糊却出现模糊
            const useBlurFill = (t.baseMargin && (t.baseMargin.bgBlurEnable || 0) === 1);
            const preExpandW = out.width, preExpandH = out.height;
            // 全出血 + 圆角时四角已被裁成透明；补边色改从源照片四角取，
            // 这样只调「图片圆角」不会让画布底色跟着变（原来会变成 scrim 黑或兜底白）。
            const canvasRatio = effectiveCanvasRatio(t);
            const fillColor = (photoCoversCanvas && img && canvasRatio !== 'original')
                ? cornerColorOf(img) : null;
            out = expandToRatio(out, canvasRatio, useBlurFill ? img : null, (t.baseMargin && t.baseMargin.bgBlurRadius) || 30, fillColor);
            // 补边是「原画布居中贴进更大的画布」，照片矩形要跟着平移同样的偏移，
            // 否则按比例补边后蒙版范围会整体左/上偏（照片越偏离中心越明显）。
            const padX = Math.round((out.width - preExpandW) / 2);
            const padY = Math.round((out.height - preExpandH) / 2);

            // 导出时 app.exportScale 是用户选的 4096/8192 目标长边:相框样式也要真正
            // 上采样到该尺寸(旧实现 min(1, ...) 让小图永远停在原尺寸)。
            // 预览没有 exportScale,仍按 displayMax 只缩不放,避免每帧无谓放大。
            const longEdge = Math.max(out.width, out.height);
            const upscaleTarget = (app.exportScale && app.exportScale > 0)
                ? Math.min(8192, Math.max(1, app.exportScale))
                : 0;
            let finalScale = upscaleTarget
                ? (upscaleTarget / longEdge)
                : Math.min(1, displayMax / longEdge);
            // 苹果信息卡的信息条是内容驱动的:字号/开关一变,画布就变高,长边从宽换成高,
            // 比例整体变小,整张卡跟着缩一圈。这种「参数改变基尺寸」的缩放是错的,沿用上次比例。
            // 宽度变了(裁切/旋转/换图)、换风格、导出都照常重算。
            const PREVIEW_SCALE_BY_PHOTO = styleName === 'CARD_APPLE';
            const prevBaseW = Number(app._canvasBaseW) || 0;
            const prevScale = Number(app._canvasScale) || 0;
            let frozenToPrev = false;
            if (!upscaleTarget && !(app.uiDprOverride > 0) && PREVIEW_SCALE_BY_PHOTO && prevScale > 0
                && app._fitStyleName === styleName && !app._forceFitNext
                && Math.round(prevBaseW) === Math.round(out.width)) {
                finalScale = prevScale;
                frozenToPrev = true;
            }

            // ── 显示比例 ≠ 渲染比例 ──
            // 手势期 beginGesture 会把 displayMax 压到 900 做低清预览。降清只该减少画布像素,
            // 绝不能改变画面在屏幕上的尺寸:否则拖任意滑块的瞬间 canvas.width 变小 →
            // applyZoomStyle 按逻辑尺寸算 CSS 宽度 → 照片缩一圈,松手再弹回(跳动缩小)。
            // 所以显示比例一律按「手势前的 displayMax」算(与松手后完全一致),像素仍按当前 displayMax 渲。
            // 注意不能拿 finalScale===prevScale 当判据:手势里第二帧就相等了,会漏掉。
            let displayScale = finalScale;
            if (!upscaleTarget && !frozenToPrev) {
                const sizeMax = (app._gesture && app._gesturePrevMax != null) ? app._gesturePrevMax : displayMax;
                displayScale = Math.min(1, sizeMax / longEdge);
            }

            // 基准坐标 = out 的像素尺寸；_canvasScale 是基准→逻辑像素的比例（与 setupCanvas 同义）。
            // 蒙版叠加层靠这两个值 + _photoRect 把指针换算成照片内坐标，缺一个就拖不动。
            app._canvasBaseW = out.width;
            app._canvasBaseH = out.height;
            app._canvasScale = finalScale || 1;
            app._photoRect = photoRect
                ? { x: photoRect.x + padX, y: photoRect.y + padY, w: photoRect.w, h: photoRect.h }
                : null;
            canvas.width = Math.max(1, Math.round(out.width * finalScale));
            canvas.height = Math.max(1, Math.round(out.height * finalScale));
            canvas._logW = Math.max(1, Math.round(out.width * displayScale));
            canvas._logH = Math.max(1, Math.round(out.height * displayScale));
            const g = canvas.getContext('2d');
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, canvas.width, canvas.height);
            g.save();
            g.imageSmoothingEnabled = true;
            g.scale(finalScale, finalScale);
            g.drawImage(out, 0, 0);
            g.restore();
            // 光效（晕影 / 漏光 / 颗粒）必须叠在整张成片之上：相框样式走的是这条管线，
            // 以前完全不调 applyGlobalLight，"暗角/漏光/胶片颗粒"三组对相框预设是死控件，
            // 面板只好把整组藏起来（见 app.js 的 applyModeControls）。现在按默认管线的
            // 同一顺序补上：先成片（含白边/边框/补边），再光效，最后才是文字/Logo 叠层
            // （engine.js 的 renderTemplateStyle 也是 applyGlobalLight 在 drawUserElements 之前）。
            // 坐标取设备的 canvas.width/height：此时 g 的 transform 已 restore 回单位矩阵。
            // 90 个预设里只有「波普漫画风」是相框样式且声明了颗粒，其余都 enable:0，
            // 所以这条改动对既有预设的画面几乎无影响（那款本来就写着有颗粒，现在真的画出来）。
            if (typeof applyGlobalLight === 'function') {
                applyGlobalLight(g, t.lightEffect, canvas.width, canvas.height);
            }
            drawUserElements(g, t, canvas.width, canvas.height);
            app.applyZoomStyle();
        } catch (e) {
            console.error('[engine-styles] 风格渲染失败:', styleName, e);
            // 与原版 apply 一致:出错回退为原图
            const scale = Math.min(1, displayMax / Math.max(iw, ih));
            canvas.width = Math.max(1, Math.round(iw * scale));
            canvas.height = Math.max(1, Math.round(ih * scale));
            canvas._logW = canvas.width;
            canvas._logH = canvas.height;
            const g = canvas.getContext('2d');
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, canvas.width, canvas.height);
            g.save();
            g.scale(scale, scale);
            g.drawImage(img, 0, 0);
            g.restore();
            // 回退图同样按「铺满画布」处理，保证蒙版对照的仍是这张照片
            app._canvasBaseW = iw;
            app._canvasBaseH = ih;
            app._canvasScale = scale;
            app._photoRect = { x: 0, y: 0, w: iw, h: ih };
            app.applyZoomStyle();
        }
    }

    window.EngineStyles = { renderPhotoFrame, extractDominant, gaussianFilter, clearCaches: clearStyleCaches };
})();
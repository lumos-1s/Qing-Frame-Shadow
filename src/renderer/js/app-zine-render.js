'use strict';
/* 拾景纸刊 · 零配置本地渲染。
 *
 * 不调用任何图像模型：用当前照片 + 从照片取出的主色，在 Canvas 上画出
 * 撕口拼贴 / 上下二分 / 波普色块 / 钢笔淡彩 / 手绘线稿 / 色域重构六种纸感。
 *
 * 这一版把「像不像一张纸」当成第一目标：
 *   · 纸张不是纯色板：有云斑、帘纹、纤维、细颗粒和边角吃光
 *   · 撕口不是锯齿剪：三段振幅叠加 + 纸芯压痕 + 纤维毛边 + 网点侵蚀
 *   · 排版不是 UI 标签：衬线小字距 + 细线 + 会按宽度自己缩的字号
 *   · 水彩不是灰云：颜料提纯后以正片叠底上纸，深色照片改用滤色
 * 产物仍是普通 PNG data URL，沿用「作为照片导入 / 下载 PNG」的旧链路。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.QfsZineRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const PRESETS = ['tear-narrative', 'ink-bifold', 'surreal-pop', 'pen-wash-travel', 'ink-sketch', 'abstract-distill'];
    const SERIF = '"Iowan Old Style","Palatino Linotype","Book Antiqua",Palatino,Georgia,"Songti SC","Noto Serif CJK SC",serif';

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    function rng(seed) {
        let a = seed >>> 0;
        return () => {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function hash(s) {
        let h = 2166136261;
        const str = String(s || '');
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }
    function hex(r, g, b) {
        return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    function parseHex(h) {
        const s = String(h || '#888888').replace('#', '');
        const v = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s.slice(0, 6), 16);
        return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
    }
    function lum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
    function mix(a, b, t) {
        return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
    }
    function mixHex(a, b, t) { const c = mix(parseHex(a), parseHex(b), t); return hex(c.r, c.g, c.b); }
    function rgba(c, a) { return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + a + ')'; }
    function sat(c) { return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b); }
    function toHsl(c) {
        const r = c.r / 255, g = c.g / 255, b = c.b / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const l = (mx + mn) / 2;
        if (mx === mn) return { h: 0, s: 0, l: l };
        const d = mx - mn;
        const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        let h;
        if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (mx === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
        return { h: h, s: s, l: l };
    }
    function fromHsl(h, s, l) {
        if (s === 0) { const v = Math.round(l * 255); return hex(v, v, v); }
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const f = (t) => {
            let x = t;
            if (x < 0) x += 1;
            if (x > 1) x -= 1;
            if (x < 1 / 6) return p + (q - p) * 6 * x;
            if (x < 1 / 2) return q;
            if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
            return p;
        };
        return hex(f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255);
    }
    // 波普需要一块「照片里没有」的底色：把重音色转到补色，暖秋照就落在深青上
    function complement(hexColor, light) {
        const c = toHsl(parseHex(hexColor));
        return fromHsl((c.h + 0.5) % 1, Math.max(0.35, c.s), light == null ? 0.26 : light);
    }

    function canvasOf(w, h) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        return c;
    }
    function rounded(ctx, x, y, w, h, r) {
        const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
        ctx.beginPath();
        if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rad); return; }
        ctx.moveTo(x + rad, y);
        ctx.lineTo(x + w - rad, y); ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
        ctx.lineTo(x + w, y + h - rad); ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
        ctx.lineTo(x + rad, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
        ctx.lineTo(x, y + rad); ctx.quadraticCurveTo(x, y, x + rad, y);
        ctx.closePath();
    }

    // ── 读照片 ──────────────────────────────────────────────────
    // 明暗要按整张照片的面积算，不能拿「4 个主色求平均」：一张白天拍的
    // 秋日林荫道，主色里有大片深色树冠和楼影，平均下来会被误判成夜景，
    // 整张纸跟着变黑板。这里直接 32×32 采样求均值。
    function analyze(img) {
        const c = canvasOf(32, 32);
        const x = c.getContext('2d');
        try { x.drawImage(img, 0, 0, 32, 32); } catch (_) { return { mean: 140, warm: 0 }; }
        let d;
        try { d = x.getImageData(0, 0, 32, 32).data; } catch (_) { return { mean: 140, warm: 0 }; }
        let sum = 0, warm = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 128) continue;
            sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            warm += d[i] - d[i + 2];
            n++;
        }
        return { mean: n ? sum / n : 140, warm: n ? warm / n : 0 };
    }
    function toneFor(stats) {
        if (!stats) return 'warm';
        if (stats.mean < 86) return 'night';
        return stats.warm > 9 ? 'warm' : 'cool';
    }
    // 从照片取色：64×64 采样 + 4bit 分桶 + 距离去重；第一个是真正的主色。
    function samplePalette(img, n) {
        const want = n || 4;
        const c = canvasOf(64, 64);
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0, 64, 64);
        let d;
        try { d = x.getImageData(0, 0, 64, 64).data; } catch (_) { return ['#C9A227', '#2E4A32', '#8A8A8A', '#EDE4D3'].slice(0, want); }
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 128) continue;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const k = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
            const e = buckets.get(k) || { r: 0, g: 0, b: 0, n: 0 };
            e.r += r; e.g += g; e.b += b; e.n++;
            buckets.set(k, e);
        }
        const list = Array.from(buckets.values()).map((e) => ({
            r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, n: e.n
        }));
        list.sort((a, b) => b.n - a.n);
        const out = [];
        for (const c0 of list) {
            if (out.every((o) => Math.hypot(o.r - c0.r, o.g - c0.g, o.b - c0.b) > 58)) out.push(c0);
            if (out.length >= want) break;
        }
        // 兜底不能按引用去重：同一张平色照片会给出 4 个一模一样的色卡。
        for (const c0 of list) {
            if (out.length >= want) break;
            const hx = hex(c0.r, c0.g, c0.b);
            if (out.every((o) => hex(o.r, o.g, o.b) !== hx)) out.push(c0);
        }
        // 还不够就按明暗派生，保证四枚色卡互相区分
        let step = 0;
        while (out.length < want) {
            const base = out[out.length - 1] || { r: 200, g: 190, b: 170 };
            const to = step % 2 ? { r: 26, g: 30, b: 34 } : { r: 248, g: 244, b: 234 };
            const c1 = mix(base, to, 0.22 + step * 0.12);
            out.push({ r: c1.r, g: c1.g, b: c1.b });
            step++;
        }
        return out.slice(0, want).map((c0) => hex(c0.r, c0.g, c0.b));
    }
    function toneOf(pal) {
        const mean = pal.reduce((s, h) => s + lum(parseHex(h)), 0) / Math.max(1, pal.length);
        if (mean < 96) return 'night';
        const dom = parseHex(pal[0] || '#888888');
        return dom.r - dom.b > 12 ? 'warm' : 'cool';
    }
    // 重音色：主色里最饱和的一支；都不够饱和就自己提纯，避免整片灰。
    function accentOf(pal) {
        let best = pal[0] || '#C8542D', score = -1;
        (pal || []).forEach((c) => {
            const p = parseHex(c);
            const s = sat(p);
            if (s > score) { score = s; best = c; }
        });
        if (score >= 54) return best;
        const p = parseHex(best);
        const m = Math.max(p.r, p.g, p.b), mn = Math.min(p.r, p.g, p.b);
        if (m === mn) return '#B4552E';
        const k = Math.min(2.1, 120 / Math.max(18, m - mn));
        const mid = (m + mn) / 2;
        return hex(mid + (p.r - mid) * k, mid + (p.g - mid) * k, mid + (p.b - mid) * k);
    }
    // 墨色必须和纸对着来。纸永远是浅色的——照片再暗，也是一张印在纸上的
    // 夜景，不是一块黑板；深色纸会让题字和插画一起消失。
    function inkOf(pal, tone) {
        const sorted = (pal || []).map(parseHex).sort((a, b) => lum(a) - lum(b));
        const darkest = sorted[0] || { r: 40, g: 38, b: 36 };
        let m = mix(darkest, { r: 26, g: 24, b: 22 }, 0.55);
        const paper = parseHex(paperFor(tone));
        if (lum(paper) - lum(m) < 96) m = mix(m, { r: 18, g: 16, b: 15 }, 0.55);
        return hex(m.r, m.g, m.b);
    }
    function paperFor(tone) {
        return tone === 'cool' ? '#E9EDEE' : tone === 'night' ? '#E8E3D8' : '#F2E7D2';
    }

    // ── 纸张基底 ────────────────────────────────────────────────
    // 真正的纸不是一块色板：云斑、帘纹、纤维、细颗粒、边角吃光各来一层。
    function paperBase(ctx, W, H, tone, seed) {
        const paper = parseHex(paperFor(tone));
        ctx.fillStyle = hex(paper.r, paper.g, paper.b);
        ctx.fillRect(0, 0, W, H);
        const rand = rng(hash('sheet' + Math.round(W) + 'x' + Math.round(H) + tone + (seed || 0)));
        const night = tone === 'night';

        // 云斑：大尺度深浅，让纸面有厚度
        for (let i = 0; i < 9; i++) {
            const cx = rand() * W, cy = rand() * H;
            const r = Math.max(W, H) * (0.16 + rand() * 0.32);
            const warm = rand() > 0.42;
            const c = warm
                ? { r: paper.r + 7, g: paper.g + 3, b: paper.b - 7 }
                : { r: paper.r - 8, g: paper.g - 5, b: paper.b + 1 };
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
            g.addColorStop(0, rgba(c, 0.42));
            g.addColorStop(1, rgba(c, 0));
            ctx.fillStyle = g;
            ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }

        // 帘纹：横向极淡的抄纸纹路
        const gap = Math.max(3, Math.round(Math.min(W, H) / 150));
        ctx.save();
        ctx.lineWidth = 1;
        for (let y = 0; y < H; y += gap) {
            ctx.strokeStyle = night ? 'rgba(96,80,58,0.026)' : 'rgba(120,98,68,0.028)';
            ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
        }
        ctx.restore();

        // 纤维：短、方向随机、有深有浅
        const fibers = Math.round(W * H / 2200);
        ctx.save();
        ctx.lineWidth = 1;
        for (let i = 0; i < fibers; i++) {
            const x = rand() * W, y = rand() * H;
            const len = Math.min(W, H) * (0.006 + rand() * 0.022);
            const a = (rand() - 0.5) * 0.7;
            const dark = rand() > 0.38;
            ctx.strokeStyle = night
                ? (dark ? 'rgba(92,78,58,' + (0.03 + rand() * 0.05) + ')' : 'rgba(255,253,247,' + (0.04 + rand() * 0.05) + ')')
                : (dark ? 'rgba(112,92,62,' + (0.025 + rand() * 0.05) + ')' : 'rgba(255,252,244,' + (0.05 + rand() * 0.07) + ')');
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
            ctx.stroke();
        }
        ctx.restore();

        // 细颗粒
        const specks = Math.round(W * H / 620);
        ctx.fillStyle = 'rgba(74,60,42,0.032)';
        for (let i = 0; i < specks; i++) {
            ctx.fillRect(rand() * W, rand() * H, 1 + rand() * 1.2, 1 + rand() * 1.2);
        }

        // 边角吃光：像一张被光从中间打亮的纸
        const vg = ctx.createRadialGradient(W * 0.5, H * 0.46, Math.min(W, H) * 0.30,
            W * 0.5, H * 0.5, Math.max(W, H) * 0.80);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, night ? 'rgba(78,64,44,0.14)' : 'rgba(92,72,46,0.10)');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, W, H);
    }

    // 压在成品最上层的一点点纸感：纤维仍能透过照片看见，像印在同一张纸上。
    function printTexture(ctx, W, H, tone) {
        const rand = rng(hash('press' + Math.round(W) + 'x' + Math.round(H)));
        ctx.save();
        ctx.lineWidth = 1;
        const n = Math.round(W * H / 6000);
        for (let i = 0; i < n; i++) {
            const x = rand() * W, y = rand() * H;
            const len = Math.min(W, H) * (0.004 + rand() * 0.012);
            const a = (rand() - 0.5) * 0.6;
            ctx.strokeStyle = tone === 'night' ? 'rgba(255,252,246,0.062)' : 'rgba(255,252,246,0.048)';
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
            ctx.stroke();
        }
        ctx.restore();
    }

    function drawPhotoCover(ctx, img, x, y, w, h) {
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        if (!iw || !ih) return;
        const scale = Math.max(w / iw, h / ih);
        const sw = w / scale, sh = h / scale;
        ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
    }

    // ── 撕口 ────────────────────────────────────────────────────
    // 振幅三段叠加（大弧 / 指印 / 毛刺）+ 两端收边，才不会像锯齿剪。
    function tearOffsets(steps, seed, amp) {
        const rand = rng(seed);
        const p = [rand() * 6.2832, rand() * 6.2832, rand() * 6.2832];
        const out = [];
        let walk = 0;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            // 随机游走：相邻取样点相关，断口才会连成撕痕而不是白噪声
            walk = walk * 0.82 + (rand() - 0.5) * 0.55;
            const v = Math.sin(t * 6.2832 * 1.3 + p[0]) * 0.50
                + Math.sin(t * 6.2832 * 4.1 + p[1]) * 0.26
                + Math.sin(t * 6.2832 * 12.7 + p[2]) * 0.12
                + walk * 0.62;
            const taper = Math.pow(Math.sin(Math.PI * clamp(t, 0, 1)), 0.42);
            out.push(v * amp * taper);
        }
        return out;
    }

    // 沿矩形四条边生成撕口多边形；只撕 edges 里点名的边，其余保持直线。
    function tornPath(w, h, edges, seed, amp) {
        const steps = Math.max(20, Math.round(Math.max(w, h) / 22));
        const corners = [[0, 0], [w, 0], [w, h], [0, h]];
        const names = ['top', 'right', 'bottom', 'left'];
        const pts = [{ x: 0, y: 0 }];
        const segs = {};
        for (let e = 0; e < 4; e++) {
            const a = corners[e], b = corners[(e + 1) % 4];
            const on = edges.indexOf(names[e]) >= 0;
            const off = on ? tearOffsets(steps, hash(seed + names[e]), amp) : null;
            const nx = -(b[1] - a[1]), ny = b[0] - a[0];
            const len = Math.hypot(nx, ny) || 1;
            const ux = nx / len, uy = ny / len;
            const local = [{ x: a[0], y: a[1] }];
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const d = off ? off[i] : 0;
                const p = { x: a[0] + (b[0] - a[0]) * t + ux * d, y: a[1] + (b[1] - a[1]) * t + uy * d };
                pts.push(p);
                local.push(p);
            }
            if (on) segs[names[e]] = { pts: local, nx: ux, ny: uy };
        }
        return { pts, segs };
    }

    function polyPath(ctx, pts) {
        ctx.beginPath();
        pts.forEach((p, i) => { if (!i) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.closePath();
    }

    // 网点侵蚀：撕口内侧从「照片」慢慢退成「网点」再退成纸。
    // 用描边叠出的渐变带当遮罩，边缘朝向无关，四边形都能用。
    function halftoneErode(t, w, h, segs, band, seed) {
        const mask = canvasOf(w, h);
        const m = mask.getContext('2d');
        const pitch = Math.max(3, Math.min(w, h) / 130);
        const rand = rng(hash('dots' + seed));
        m.fillStyle = '#000';
        for (let y = pitch / 2; y < h; y += pitch) {
            for (let x = pitch / 2 + ((Math.round(y / pitch) % 2) ? pitch / 2 : 0); x < w; x += pitch) {
                const r = pitch * (0.18 + rand() * 0.18);
                m.beginPath(); m.arc(x, y, r, 0, 6.2832); m.fill();
            }
        }
        // 沿撕口叠出「越靠边越实」的带子：多层描边自然累积出渐变
        const grad = canvasOf(w, h);
        const g = grad.getContext('2d');
        g.strokeStyle = '#000';
        g.lineJoin = 'round';
        g.lineCap = 'butt';
        Object.keys(segs).forEach((k) => {
            const s = segs[k];
            for (let i = 1; i <= 12; i++) {
                g.globalAlpha = 0.10;
                g.lineWidth = band * 2 * (i / 12);
                g.beginPath();
                s.pts.forEach((p, j) => { if (!j) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y); });
                g.stroke();
            }
        });
        m.globalCompositeOperation = 'destination-in';
        m.drawImage(grad, 0, 0);
        m.globalCompositeOperation = 'source-over';
        t.globalCompositeOperation = 'destination-out';
        t.drawImage(mask, 0, 0);
        t.globalCompositeOperation = 'source-over';
    }

    // 撕口毛边：从断口向外伸出几毫米的纸纤维，多数浅、少数深。
    function fiberFringe(ctx, segs, seed, paper, ink, scale) {
        const rand = rng(hash('fringe' + seed));
        const each = Math.max(3, (scale || 800) * 0.012);
        Object.keys(segs).forEach((k) => {
            const s = segs[k];
            for (let i = 2; i < s.pts.length - 2; i += 2) {
                const p = s.pts[i];
                const count = 1 + Math.floor(rand() * 3);
                for (let j = 0; j < count; j++) {
                    const len = 2 + rand() * each * 2.4;
                    const sway = (rand() - 0.5) * 1.1;
                    const dx = s.nx + sway * -s.ny;
                    const dy = s.ny + sway * s.nx;
                    const dark = rand() > 0.8;
                    ctx.strokeStyle = dark ? rgba(ink, 0.08 + rand() * 0.10) : rgba(paper, 0.30 + rand() * 0.34);
                    ctx.lineWidth = 0.6 + rand() * 0.8;
                    ctx.beginPath();
                    ctx.moveTo(p.x, p.y);
                    ctx.lineTo(p.x + dx * len, p.y + dy * len);
                    ctx.stroke();
                }
            }
        });
    }

    // 一块被撕下来的照片：带旋转、纸芯压痕、毛边与网点过渡。
    function tornPhoto(ctx, img, box, opt) {
        const o = opt || {};
        const w = Math.round(box.w), h = Math.round(box.h);
        if (w < 8 || h < 8) return;
        const paper = parseHex(o.paper || '#F2E7D2');
        const ink = parseHex(o.ink || '#2C2A26');
        const { pts, segs } = tornPath(w, h, o.edges || ['left'], o.seed || 0, o.amp || Math.min(w, h) * 0.026);

        const tmp = canvasOf(w, h);
        const t = tmp.getContext('2d');
        t.save();
        polyPath(t, pts);
        t.clip();
        drawPhotoCover(t, img, 0, 0, w, h);
        t.restore();
        if (o.fade !== false) halftoneErode(t, w, h, segs, Math.max(5, Math.min(w, h) * 0.06), o.seed || 0);

        ctx.save();
        ctx.translate(box.x + w / 2, box.y + h / 2);
        ctx.rotate(o.rot || 0);
        ctx.translate(-w / 2, -h / 2);

        // 纸厚：撕口外侧一点点投影，先画，照片盖在上面
        ctx.save();
        ctx.translate(w * 0.002, h * 0.004);
        ctx.strokeStyle = 'rgba(46,34,22,0.13)';
        ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.005);
        ctx.lineJoin = 'round';
        Object.keys(segs).forEach((k) => {
            const s = segs[k];
            ctx.beginPath();
            s.pts.forEach((p, i) => { if (!i) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
            ctx.stroke();
        });
        ctx.restore();

        ctx.drawImage(tmp, 0, 0);

        // 纸芯：撕开的相纸会露出白边。断着画，别连成一条马克笔线。
        const cr = rng(hash('core' + (o.seed || 0)));
        ctx.strokeStyle = 'rgba(255,252,245,0.78)';
        ctx.lineWidth = Math.max(0.8, Math.min(w, h) * 0.0018);
        ctx.lineCap = 'round';
        Object.keys(segs).forEach((k) => {
            const s = segs[k];
            for (let i = 0; i < s.pts.length - 1; i++) {
                if (cr() < 0.32) continue;
                ctx.beginPath();
                ctx.moveTo(s.pts[i].x, s.pts[i].y);
                ctx.lineTo(s.pts[i + 1].x, s.pts[i + 1].y);
                ctx.stroke();
            }
        });
        fiberFringe(ctx, segs, (o.seed || 0) + 7, paper, ink, Math.min(w, h));
        ctx.restore();
    }

    // 剪纸分层：把照片压成 18×9 的明暗格子，再把每一行里连续的同级格子
    // 合成一条撕边纸条。得到的是"撕纸拼出来的风景"，不是一张被滤镜压过的照片。
    function paperCutLandscape(ctx, img, x, y, w, h, pal, opt) {
        const o = opt || {};
        const cols = o.cols || 18, rows = o.rows || 9;
        const small = canvasOf(cols, rows);
        const s = small.getContext('2d');
        const iw = img.naturalWidth || img.width || cols;
        const ih = img.naturalHeight || img.height || rows;
        const crop = o.crop || { x: 0, y: 0, w: 1, h: 1 };
        try { s.drawImage(img, iw * crop.x, ih * crop.y, iw * crop.w, ih * crop.h, 0, 0, cols, rows); } catch (_) { return; }
        let d;
        try { d = s.getImageData(0, 0, cols, rows).data; } catch (_) { return; }

        const levels = o.levels || 4;
        const paper = parseHex(paperFor(o.tone || 'warm'));
        const ink = parseHex(inkOf(pal, o.tone || 'warm'));
        const mid = o.tint ? mix(parseHex(o.tint), paper, 0.45) : mix(ink, paper, 0.6);
        const anchors = [ink, mid, paper];
        const ramp = [];
        for (let i = 0; i < levels; i++) {
            const tt = levels === 1 ? 1 : i / (levels - 1);
            const seg = tt * (anchors.length - 1);
            const k0 = Math.min(anchors.length - 2, Math.floor(seg));
            ramp.push(mix(anchors[k0], anchors[k0 + 1], seg - k0));
        }
        const lv = new Uint8Array(cols * rows);
        const raw = new Float32Array(cols * rows);
        let lo = 1, hi = 0;
        for (let i = 0; i < raw.length; i++) {
            const j = i * 4;
            const l = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
            raw[i] = l;
            if (l < lo) lo = l;
            if (l > hi) hi = l;
        }
        const span = Math.max(0.5, hi - lo);
        const center = (lo + hi) / 2;
        for (let i = 0; i < lv.length; i++) {
            const n = clamp((raw[i] - (center - span / 2)) / span, 0, 1);
            lv[i] = clamp(Math.round(Math.pow(n, o.lift || 0.92) * (levels - 1)), 0, levels - 1);
        }
        // 众数滤波：3×3 里出现最多的级别胜出。不去这一步，明暗一震荡，
        // 相邻纸条就会咬合成锯齿／条码，看上去像二维码而不是风景。
        const smooth = new Uint8Array(lv.length);
        for (let ry = 0; ry < rows; ry++) {
            for (let cx = 0; cx < cols; cx++) {
                const count = [];
                for (let k = 0; k < levels; k++) count.push(0);
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const yy = ry + dy, xx = cx + dx;
                        if (yy < 0 || yy >= rows || xx < 0 || xx >= cols) continue;
                        count[lv[yy * cols + xx]] += (Math.abs(dx) + Math.abs(dy) === 0) ? 2 : 1;
                    }
                }
                let best = lv[ry * cols + cx], bestN = -1;
                for (let k = 0; k < levels; k++) if (count[k] > bestN) { bestN = count[k]; best = k; }
                smooth[ry * cols + cx] = best;
            }
        }
        lv.set(smooth);

        const cellW = w / cols, cellH = h / rows;
        const rand = rng(hash('cut' + (o.seed || 0)));
        ctx.save();
        for (let ry = 0; ry < rows; ry++) {
            let start = 0, cur = lv[ry * cols];
            for (let cx = 1; cx <= cols; cx++) {
                const v = cx < cols ? lv[ry * cols + cx] : -1;
                if (v === cur) continue;
                const x0 = x + start * cellW, x1 = x + cx * cellW;
                const sw = x1 - x0, sh = cellH * (1.08 + rand() * 0.05);
                const { pts } = tornPath(sw, sh, ['top', 'bottom'],
                    (o.seed || 0) + ry * 37 + start * 7, Math.max(2, cellH * 0.17));
                ctx.save();
                ctx.translate(x0 + (rand() - 0.5) * cellW * 0.04, y + ry * cellH - sh * 0.04);
                // 纸条下的影：只偏移一点点，叠起来才有纸厚
                ctx.save();
                ctx.translate(0, Math.max(1, cellH * 0.05));
                ctx.fillStyle = 'rgba(48,36,24,0.13)';
                polyPath(ctx, pts);
                ctx.fill();
                ctx.restore();
                ctx.fillStyle = hex(ramp[cur].r, ramp[cur].g, ramp[cur].b);
                polyPath(ctx, pts);
                ctx.fill();
                ctx.restore();
                start = cx; cur = v;
            }
        }
        ctx.restore();
    }

    // ── 水彩 ────────────────────────────────────────────────────
    // 颜料化：低饱和的色不上纸，否则一叠就成灰云；暗调照片把墨量收一点。
    function wash(ctx, x, y, r, color, tone, alpha) {
        const c = parseHex(color);
        if (sat(c) < 26) return;
        const a = (alpha == null ? 0.30 : alpha) * (tone === 'night' ? 0.82 : 1);
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        for (let i = 0; i < 3; i++) {
            const jx = x + (i - 1) * r * 0.16, jy = y + (i - 1) * r * 0.12;
            const rr = r * (0.82 + i * 0.1);
            const g = ctx.createRadialGradient(jx, jy, rr * 0.06, jx, jy, rr);
            g.addColorStop(0, rgba(c, a * 0.5));
            g.addColorStop(0.5, rgba(c, a * 0.26));
            g.addColorStop(1, rgba(c, 0));
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(jx, jy, rr, 0, 6.2832); ctx.fill();
        }
        ctx.restore();
    }

    // ── 平涂重构 ────────────────────────────────────────────────
    // 先把照片压到很小再放大（细节并成块面），然后按明暗量化成 4 级墨阶。
    // 关键是「墨阶」而不是「调用主色」：主色之间常常只差一点亮度，
    // 直接映射会得到一片糊在一起的色块；用纸→墨的阶梯才能出层次。
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    function flatReconstruct(ctx, img, x, y, w, h, pal, opt) {
        const o = opt || {};
        const W = Math.max(8, Math.round(w)), H = Math.max(8, Math.round(h));
        const iw = img.naturalWidth || img.width || W;
        const ih = img.naturalHeight || img.height || H;
        const crop = o.crop || { x: 0, y: 0, w: 1, h: 1 };

        const small = canvasOf(Math.max(16, Math.round(W / (o.block || 10))), Math.max(12, Math.round(H / (o.block || 10))));
        const s = small.getContext('2d');
        s.imageSmoothingEnabled = true;
        try {
            s.drawImage(img, iw * crop.x, ih * crop.y, iw * crop.w, ih * crop.h, 0, 0, small.width, small.height);
        } catch (_) { return; }

        const tmp = canvasOf(W, H);
        const t = tmp.getContext('2d');
        t.imageSmoothingEnabled = true;
        try { t.imageSmoothingQuality = 'high'; } catch (_) {}
        t.drawImage(small, 0, 0, W, H);

        // 先糊再量化：边界才会连成块面，而不是一堆抖出来的豹纹
        let work = tmp;
        if (o.blur && 'filter' in t) {
            work = canvasOf(W, H);
            const wc = work.getContext('2d');
            wc.filter = 'blur(' + o.blur + 'px)';
            wc.drawImage(tmp, 0, 0);
            wc.filter = 'none';
        }
        let data;
        try { data = work.getContext('2d').getImageData(0, 0, W, H); } catch (_) { return; }
        const d = data.data;

        const levels = o.levels || 4;
        const paper = parseHex(paperFor(o.tone || 'warm'));
        const ink = parseHex(inkOf(pal, o.tone || 'warm'));
        const mid = o.tint ? mix(parseHex(o.tint), paper, 0.42) : mix(ink, paper, 0.62);
        const anchors = [ink, mid, paper];
        const ramp = [];
        for (let i = 0; i < levels; i++) {
            const tt = levels === 1 ? 1 : i / (levels - 1);
            const seg = tt * (anchors.length - 1);
            const k0 = Math.min(anchors.length - 2, Math.floor(seg));
            ramp.push(mix(anchors[k0], anchors[k0 + 1], seg - k0));
        }
        // 直方图归一，避免整张照片落在同一级
        let lo = 1, hi = 0;
        const L = new Float32Array(W * H);
        for (let i = 0; i < L.length; i++) {
            const j = i * 4;
            const l = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
            L[i] = l;
            if (l < lo) lo = l;
            if (l > hi) hi = l;
        }
        const span = Math.max(0.1, hi - lo);
        const dither = o.dither == null ? 0.9 : o.dither;
        const contrast = o.contrast || 1;
        const lift = o.lift || 1;
        for (let yy = 0; yy < H; yy++) {
            for (let xx = 0; xx < W; xx++) {
                const i = yy * W + xx;
                let n = (L[i] - lo) / span;
                n = clamp((n - 0.5) * contrast + 0.5, 0, 1);
                // 夜景这类暗调照片，直方图归一后亮部只剩几个孤岛；
                // 提一把中间调，墨阶才会连成面而不是豹纹。
                if (lift !== 1) n = Math.pow(n, lift);
                const v = n * (levels - 1) + (BAYER[(yy & 3) * 4 + (xx & 3)] / 16 - 0.5) * dither;
                const idx = clamp(Math.round(v), 0, levels - 1);
                const c = ramp[idx];
                const j = i * 4;
                d[j] = c.r; d[j + 1] = c.g; d[j + 2] = c.b; d[j + 3] = 255;
            }
        }
        t.putImageData(data, 0, 0);
        ctx.save();
        ctx.globalAlpha = o.alpha == null ? 0.96 : o.alpha;
        if (o.feather) {
            // 记忆层不该有硬边：用晕染遮罩裁一次，像隔纸看见的残影
            const soft = canvasOf(W, H);
            const sf = soft.getContext('2d');
            sf.drawImage(tmp, 0, 0);
            sf.globalCompositeOperation = 'destination-in';
            sf.drawImage(organicMask(W, H, (o.seed || 0) + 5), 0, 0);
            sf.globalCompositeOperation = 'source-over';
            ctx.drawImage(soft, x, y, w, h);
        } else {
            ctx.drawImage(tmp, x, y, w, h);
        }
        ctx.restore();
    }

    // 不规则晕染遮罩：几十个错位径向体叠在一起，边缘自然不齐，
    // 比圆角矩形更像水彩在纸上洇开。
    function organicMask(W, H, seed) {
        const c = canvasOf(W, H);
        const g = c.getContext('2d');
        // 基础形用撕口多边形（四条边都带随机游走），再糊一层，边界就不会是矩形
        const { pts } = tornPath(W, H, ['top', 'right', 'bottom', 'left'], seed, Math.min(W, H) * 0.055);
        g.fillStyle = '#000';
        g.save();
        g.translate(W * 0.03, H * 0.035);
        g.scale(0.94, 0.93);
        polyPath(g, pts);
        g.fill();
        g.restore();
        const soft = canvasOf(W, H);
        const sf = soft.getContext('2d');
        if ('filter' in sf) {
            sf.filter = 'blur(' + Math.max(4, Math.min(W, H) * 0.016) + 'px)';
            sf.drawImage(c, 0, 0);
            return soft;
        }
        return c;
    }

    // ── 手绘引擎 ────────────────────────────────────────────────
    // 手绘不是给照片盖一层滤镜，是把照片重画一遍：
    //   1) Kuwahara 把细碎纹理压成块面，照片的「像素感」先消失；
    //   2) 颜色归进十来个色团，再往纸色提亮，得到水彩式的平涂；
    //   3) 色团交界压一道深边，模仿水彩干后的积水线；
    //   4) 明暗差做 DoG 提轮廓，采样坐标加低频抖动，线才像手画的；
    //   5) 暗部补排线，最亮处干脆不铺色，让纸白自己说话。
    // 整层最后以正片叠底压在纸上，纸的纤维和颗粒从颜料里透出来。

    function photoPlane(img, aspect, maxEdge) {
        const w = aspect >= 1 ? maxEdge : Math.max(24, Math.round(maxEdge * aspect));
        const h = aspect >= 1 ? Math.max(24, Math.round(maxEdge / aspect)) : maxEdge;
        const c = canvasOf(w, h);
        const x = c.getContext('2d');
        x.imageSmoothingQuality = 'high';
        drawPhotoCover(x, img, 0, 0, w, h);
        return { canvas: c, ctx: x, w: w, h: h };
    }

    // 低分辨率明度平面：边缘检测和排线都在这上面做，
    // 缩得够小，纹理自己就没了，省得后面拿阈值去追。
    function grayOfPhoto(img, aspect, edge) {
        const lp = photoPlane(img, aspect, Math.max(64, Math.round(edge)));
        let ld;
        try { ld = lp.ctx.getImageData(0, 0, lp.w, lp.h); } catch (_) { return null; }
        const plane = new Float32Array(lp.w * lp.h);
        for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
            plane[p] = 0.2126 * ld.data[i] + 0.7152 * ld.data[i + 1] + 0.0722 * ld.data[i + 2];
        }
        return { plane: plane, w: lp.w, h: lp.h };
    }

    // 可分离盒式模糊：两遍就是高斯，工作分辨率下够快。
    function blurPlane(src, w, h, radius, passes) {
        const r = Math.max(1, Math.round(radius));
        const win = r * 2 + 1;
        let a = Float32Array.from(src);
        let b = new Float32Array(w * h);
        for (let p = 0; p < (passes || 1); p++) {
            for (let y = 0; y < h; y++) {
                const row = y * w;
                let sum = 0;
                for (let i = -r; i <= r; i++) sum += a[row + clamp(i, 0, w - 1)];
                for (let x = 0; x < w; x++) {
                    b[row + x] = sum / win;
                    sum += a[row + clamp(x + r + 1, 0, w - 1)] - a[row + clamp(x - r, 0, w - 1)];
                }
            }
            for (let x = 0; x < w; x++) {
                let sum = 0;
                for (let i = -r; i <= r; i++) sum += b[clamp(i, 0, h - 1) * w + x];
                for (let y = 0; y < h; y++) {
                    a[y * w + x] = sum / win;
                    sum += b[clamp(y + r + 1, 0, h - 1) * w + x] - b[clamp(y - r, 0, h - 1) * w + x];
                }
            }
        }
        return a;
    }

    // Kuwahara：四个象限里挑方差最小的那块取均值，边缘留住、纹理抹平。
    function kuwaharaPlane(src, w, h, radius) {
        const r = Math.max(1, radius | 0);
        const out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let best = Infinity, br = 0, bg = 0, bb = 0, ba = 0;
                for (let q = 0; q < 4; q++) {
                    const x0 = q & 1 ? x : Math.max(0, x - r);
                    const x1 = Math.min(w - 1, q & 1 ? x + r : x);
                    const y0 = q & 2 ? y : Math.max(0, y - r);
                    const y1 = Math.min(h - 1, q & 2 ? y + r : y);
                    let n = 0, sr = 0, sg = 0, sb = 0, sa = 0, sl = 0, sl2 = 0;
                    for (let yy = y0; yy <= y1; yy++) {
                        for (let xx = x0; xx <= x1; xx++) {
                            const i = (yy * w + xx) * 4;
                            const R = src[i], G = src[i + 1], B = src[i + 2];
                            const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
                            sr += R; sg += G; sb += B; sa += src[i + 3];
                            sl += L; sl2 += L * L; n++;
                        }
                    }
                    if (!n) continue;
                    const v = sl2 / n - (sl / n) * (sl / n);
                    if (v < best) {
                        best = v;
                        br = sr / n; bg = sg / n; bb = sb / n; ba = sa / n;
                    }
                }
                const o = (y * w + x) * 4;
                out[o] = br; out[o + 1] = bg; out[o + 2] = bb; out[o + 3] = ba;
            }
        }
        return out;
    }

    function percentileRange(vals, lo, hi) {
        const step = Math.max(1, Math.floor(vals.length / 6000));
        const pick = [];
        for (let i = 0; i < vals.length; i += step) pick.push(vals[i]);
        pick.sort((a, b) => a - b);
        const at = (t) => pick[clamp(Math.round((pick.length - 1) * t), 0, pick.length - 1)];
        return { lo: at(lo == null ? 0.02 : lo), hi: at(hi == null ? 0.98 : hi) };
    }

    // 颜料能表达的明度区间：夜景要暗但要有层次，白天要亮但别飘。
    function paintRange(mean) {
        // 只有真正压暗的片子才用「夜景区间」；林荫道这种只是偏暗的白天，
        // 也得把亮部画出来，否则整张会沉成一块黑。
        if (mean < 55) return { lo: 0.08, hi: 0.34, sat: 0.7 };
        // 上界别冲到 0.8：HSL 里明度一高，颜色就稀成米白，
        // 秋色会被洗掉。0.7 已经够亮，还能保住颜料的浓度。
        return { lo: 0.20, hi: 0.70, sat: 1 };
    }

    // 色团要做「减法」：邻域里谁占多数，中心就归谁。
    // 手绘不会把每片叶子都切成一个色块，碎色团并掉，画面才概括得起来。
    function modeFilter(idx, w, h, pass) {
        let cur = idx;
        for (let it = 0; it < (pass || 1); it++) {
            const next = new Uint8Array(cur.length);
            const cnt = new Uint16Array(16);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const p = y * w + x, a = cur[p];
                    const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
                    const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
                    cnt.fill(0);
                    let best = a, bn = 0;
                    for (let yy = y0; yy <= y1; yy++) {
                        const row = yy * w;
                        for (let xx = x0; xx <= x1; xx++) {
                            const v = cur[row + xx];
                            cnt[v]++;
                            if (cnt[v] > bn) { bn = cnt[v]; best = v; }
                        }
                    }
                    // 只有「多数」才改写，否则边界会自己蠕动
                    next[p] = bn >= 5 ? best : a;
                }
            }
            cur = next;
        }
        return cur;
    }

    // 细长的小色团是「照片纹理」的残渣：树皮、瓦片、草丛量化完就是一堆条纹。
    // 面积不够的整块并给邻域里占得最多的那一色，画面立刻从「贴图」变成「平涂」。
    function mergeSmall(idx, w, h, frac, keepFn) {
        const total = w * h;
        const minA = Math.max(6, Math.round(total * (frac == null ? 0.0035 : frac)));
        const seen = new Uint8Array(total);
        const stack = new Int32Array(total);
        const mem = new Int32Array(total);
        const out = Uint8Array.from(idx);
        for (let p0 = 0; p0 < total; p0++) {
            if (seen[p0]) continue;
            const v = idx[p0];
            let sp = 0, n = 0;
            stack[sp++] = p0;
            seen[p0] = 1;
            while (sp) {
                const p = stack[--sp];
                mem[n++] = p;
                const x = p % w, y = (p / w) | 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= h) continue;
                    const row = yy * w;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        const q = row + xx;
                        if (!seen[q] && idx[q] === v) { seen[q] = 1; stack[sp++] = q; }
                    }
                }
            }
            if (n >= minA) continue;
            // 透光的金叶、一件红衣服，面积虽小却是整张画的眼睛，
            // 按面积一刀切会先把它们并掉，画面就只剩下一片灰。
            if (keepFn && keepFn(v)) continue;
            const cnt = new Uint16Array(16);
            for (let i = 0; i < n; i++) {
                const p = mem[i], x = p % w, y = (p / w) | 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= h) continue;
                    const row = yy * w;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        const q = row + xx;
                        if (idx[q] !== v) cnt[idx[q]]++;
                    }
                }
            }
            let best = v, bn = 0;
            for (let k = 0; k < cnt.length; k++) if (cnt[k] > bn) { bn = cnt[k]; best = k; }
            if (best === v) continue;
            for (let i = 0; i < n; i++) out[mem[i]] = best;
        }
        return out;
    }

    // 线从色块来，不从像素来。画家勾的是「形和形的交界」，
    // 边缘检测勾的是「亮度的跳变」——后者会在树皮、草丛上长出一片碎线。
    // 只给明度差够大的交界落笔，线就天然连续、闭合，而且永远和色块对得上。
    function seamLayer(seam, opt) {
        const o = opt || {};
        const w = seam.w, h = seam.h, idx = seam.idx;
        const ink = parseHex(o.color || '#2A2622');
        const lums = seam.tints.map((c) => toHsl(c).l);
        const minD = o.minD == null ? 0.155 : o.minD;
        const boost = clamp(o.boost == null ? 1 : o.boost, 0.4, 2.4);
        const am = seam.alphaMask;
        const seed = o.seed || 0;
        const cv = canvasOf(w, h);
        const g = cv.getContext('2d');
        const img = g.createImageData(w, h);
        const d = img.data;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = y * w + x;
                const la = lums[idx[p]];
                let best = 0, bp = -1;
                if (x + 1 < w) {
                    const dd = la - lums[idx[p + 1]];
                    if (Math.abs(dd) > Math.abs(best)) { best = dd; bp = p + 1; }
                }
                if (y + 1 < h) {
                    const dd = la - lums[idx[p + w]];
                    if (Math.abs(dd) > Math.abs(best)) { best = dd; bp = p + w; }
                }
                if (bp < 0) continue;
                // 只压在暗的那一侧。亮侧（留白）不画线，
                // 否则每块纸白都会镶一圈黑边，像剪贴画。
                if (best > 0) continue;
                const ad = Math.abs(best);
                if (ad < minD) continue;
                // 一边是纸的地方不勾：那是留白，不是形体。
                // 给留白描边，整张画会变成一张地图。
                if (am && (am[p] < 46 || am[bp] < 46)) continue;
                // 手画的线不会一笔到底：留几处断口，像笔提起来又落下。
                // 不断的话，线就成了「描边」，一眼看出是程序画的。
                const brk = Math.sin(x * 0.07 + seed * 1.7) * Math.cos(y * 0.09 - seed)
                    + Math.sin((x + y) * 0.045 + seed * 2.1);
                const gapK = o.gap == null ? 0.72 : o.gap;
                if (brk < -gapK) continue;
                // 明度差越大，这一笔越重。手绘也是这么分轻重的。
                const a = clamp((ad - minD) * 5.2 * boost, 0, Math.min(0.84, 0.56 * boost))
                    * (0.86 + 0.14 * Math.sin(x * 0.07 + y * 0.05 + seed));
                const i = p * 4;
                d[i] = ink.r; d[i + 1] = ink.g; d[i + 2] = ink.b;
                d[i + 3] = a * 255;
            }
        }
        g.putImageData(img, 0, 0);
        return cv;
    }

    // 水彩层：色团平涂 + 湿边 + 高光留纸。
    function washLayer(rgba, w, h, pal, opt) {
        const o = opt || {};
        const seed = o.seed || 0;
        const bins = new Map();
        for (let i = 0; i < rgba.length; i += 8) {
            if (rgba[i + 3] < 180) continue;
            const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
            const k = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
            const e = bins.get(k) || { r: 0, g: 0, b: 0, n: 0 };
            e.r += r; e.g += g; e.b += b; e.n++;
            bins.set(k, e);
        }
        // 只按面积取色会把小面积的重音（一件红外套）整件丢掉，
        // 所以再把照片主色补进候选。
        const cand = [];
        Array.from(bins.values()).sort((a, b) => b.n - a.n).forEach((e) => {
            const c = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n };
            if (cand.every((x) => Math.hypot(x.r - c.r, x.g - c.g, x.b - c.b) > 42)) cand.push(c);
        });
        // 手绘用不了十一种颜色：四五块色就够搭起一张画。
        cand.length = Math.min(cand.length, 5);
        (pal || []).forEach((hx) => {
            const c = parseHex(hx);
            if (cand.every((x) => Math.hypot(x.r - c.r, x.g - c.g, x.b - c.b) > 26)) cand.push(c);
        });
        if (!cand.length) cand.push({ r: 150, g: 140, b: 126 });

        const gray = new Float32Array(w * h);
        for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
            gray[p] = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
        }
        const range = percentileRange(gray, 0.02, 0.99);

        const lift = o.lift == null ? 0.30 : o.lift;
        // 不要先把颜料混进纸色：混一次，饱和度就掉到原来的六分之一，
        // 之后再乘系数也救不回来，整张画会变成灰米色。
        // 水彩的亮是「纸透出来」，不是「颜料兑水」——提亮只动明度。
        let tints = cand.map((c) => {
            const hsl = toHsl(c);
            return parseHex(fromHsl(hsl.h, clamp(hsl.s * 1.06, 0, 0.92), clamp(hsl.l, 0.08, 0.94)));
        });
        // 明暗要铺满「颜料能表达的范围」：夜景不会被画成一团黑，
        // 大晴天也不会整张飘在淡黄里。这一步只改明度，色相和饱和度不动。
        const lums = tints.map((c) => toHsl(c).l);
        const loT = Math.min.apply(null, lums), hiT = Math.max.apply(null, lums);
        if (hiT - loT > 0.05) {
            let sum = 0;
            for (let p = 0; p < gray.length; p++) sum += gray[p];
            const vr = o.range || paintRange(sum / Math.max(1, gray.length));
            tints = tints.map((c) => {
                const hsl = toHsl(c);
                const t = clamp((hsl.l - loT) / (hiT - loT), 0, 1);
                const nl = clamp(vr.lo + t * (vr.hi - vr.lo) + (lift - 0.30) * 0.5, 0.05, 0.95);
                // 提亮会让颜色变稀，补一点饱和把颜料的浓度拉回来，
                // 否则金色会变成米白、赭石会变成灰褐。
                // 提亮补偿对淡彩是反作用：它已经把颜料调淡了，
                // 再补饱和就变成荧光色。所以给一个上限，也允许关掉补偿。
                const boostK = o.satBoost == null ? 1.1 : o.satBoost;
                const satCap = o.satCap == null ? 0.92 : o.satCap;
                const sat = clamp(Math.min(hsl.s * (vr.sat == null ? 1 : vr.sat)
                    * (1 + Math.max(0, nl - hsl.l) * boostK), satCap), 0, 0.94);
                return parseHex(fromHsl(hsl.h, sat, nl));
            });
        }

        const idx = new Uint8Array(w * h);
        for (let p = 0, i = 0; p < idx.length; p++, i += 4) {
            let best = 0, bd = Infinity;
            for (let k = 0; k < cand.length; k++) {
                const c = cand[k];
                const dr = rgba[i] - c.r, dg = rgba[i + 1] - c.g, db = rgba[i + 2] - c.b;
                const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
                if (d < bd) { bd = d; best = k; }
            }
            idx[p] = best;
        }
        // 先并小碎块，再做一次众数：条纹消失，剩下的是能拿笔刷出来的大色团。
        const merged = mergeSmall(idx, w, h, o.smallFrac, o.keepAccent === false
            ? null
            : (v) => {
                const hsl = toHsl(tints[v]);
                return hsl.s > 0.32 && hsl.l > 0.40;
            });
        idx.set(modeFilter(merged, w, h, o.merge == null ? 1 : o.merge));
        const rim = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = y * w + x, a = idx[p];
                if ((x + 1 < w && idx[p + 1] !== a) || (y + 1 < h && idx[p + w] !== a)) rim[p] = 1;
            }
        }
        const rimSoft = blurPlane(rim, w, h, 1, 1);
        // 亮部不铺色：手绘水彩最亮的那一片，本来就是纸自己的白。
        // 按明度跨度取比例，白天和夜景都不会被一律刮白。
        const span = Math.max(22, range.hi - range.lo);
        const cut = range.hi - span * (o.paperCut == null ? 0.12 : o.paperCut);
        const paperSoft = span * (o.paperSoft == null ? 0.13 : o.paperSoft);
        // 最浅的那一两块直接当纸：水彩画到最后，最亮处就是没上色的地方。
        const tLums = tints.map((c) => toHsl(c).l);
        const whiteCut = o.whiteCut == null ? 0.90 : o.whiteCut;

        const cv = canvasOf(w, h);
        const g = cv.getContext('2d');
        const imgData = g.createImageData(w, h);
        const d = imgData.data;
        const aPlane = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = y * w + x, i = p * 4;
                // 手抖一点。色块边界是「笔走出来的」，不是像素台阶；
                // 采样坐标轻轻晃，形状还是那块形，边却活了过来。
                const wx = Math.sin(y * 0.137 + seed) * 0.7 + Math.sin(x * 0.071 - seed * 0.6) * 0.5;
                const wy = Math.cos(x * 0.113 - seed) * 0.7 + Math.cos(y * 0.053 + seed * 0.4) * 0.5;
                const sp = clamp(Math.round(y + wy), 0, h - 1) * w + clamp(Math.round(x + wx), 0, w - 1);
                const c = tints[idx[sp]];
                const edge = 1 - 0.30 * rimSoft[sp];
                const grain = 1 + Math.sin(x * 0.081 + y * 0.057 + seed) * Math.sin(y * 0.033 - seed * 1.7) * 0.018;
                d[i] = clamp(c.r * edge * grain, 0, 255);
                d[i + 1] = clamp(c.g * edge * grain, 0, 255);
                d[i + 2] = clamp(c.b * edge * grain, 0, 255);
                // 高光不铺色：水彩画到最亮处，本来就是纸自己的颜色
                let av = clamp((cut - gray[sp]) / paperSoft, 0, 1) * 246;
                if (tLums[idx[sp]] > whiteCut) av = 0;
                aPlane[p] = av;
                d[i + 3] = av;
            }
        }
        g.putImageData(imgData, 0, 0);
        // 把「哪块色挨着哪块色」交给下游，线层要用它
        if (o.seamOut) o.seamOut.push({ idx: idx, tints: tints, w: w, h: h, alphaMask: aPlane });
        // 颜料落在湿纸上会往外洇：把整层糊一点点，边界立刻变软
        if (o.soften) {
            const soft = canvasOf(w, h);
            const sf = soft.getContext('2d');
            if ('filter' in sf) {
                sf.filter = 'blur(' + o.soften + 'px)';
                sf.drawImage(cv, 0, 0);
                return soft;
            }
        }
        return cv;
    }

    // 笔触层：不再逐像素填色，而是一笔一笔铺上去。
    // 起笔点靠近结构，落笔方向顺着当地的等高线；颜色从糊过的向导上取，
    // 所以每一笔都是「这一片的颜色」，不会把照片的噪点抄进去。
    function strokeLayer(img, W, H, pal, opt) {
        const o = opt || {};
        const seed = o.seed || 0;
        const rand = rng(hash('strokes' + seed + ':' + Math.round(W) + 'x' + Math.round(H)));
        const gp = photoPlane(img, W / H, 320);
        let gd;
        try { gd = gp.ctx.getImageData(0, 0, gp.w, gp.h); } catch (_) { return null; }
        const gw = gp.w, gh = gp.h;
        const guide = new Uint8ClampedArray(gd.data);
        for (let c = 0; c < 3; c++) {
            const plane = new Float32Array(gw * gh);
            for (let p = 0; p < plane.length; p++) plane[p] = guide[p * 4 + c];
            const soft = blurPlane(plane, gw, gh, 2, 1);
            for (let p = 0; p < plane.length; p++) guide[p * 4 + c] = soft[p];
        }
        const lum = new Float32Array(gw * gh);
        for (let p = 0; p < lum.length; p++) {
            lum[p] = 0.2126 * guide[p * 4] + 0.7152 * guide[p * 4 + 1] + 0.0722 * guide[p * 4 + 2];
        }
        // 和颜料层用同一套明度重分布：笔触不能把已经铺开的明暗又压回原样
        const lrange = percentileRange(lum, 0.02, 0.98);
        const lspan = Math.max(26, lrange.hi - lrange.lo);
        let lsum = 0;
        for (let p = 0; p < lum.length; p++) lsum += lum[p];
        const vr = o.range || paintRange(lsum / Math.max(1, lum.length));
        const normHex = (c) => {
            // 向导本身就是颜料色（色块层），再归一次会把对比推爆
            if (o.preNormalized) return { r: c.r, g: c.g, b: c.b };
            const hsl = toHsl(c);
            const t = clamp((0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b - lrange.lo) / lspan, 0, 1);
            return fromHsl(hsl.h, clamp(hsl.s * (vr.sat == null ? 1 : vr.sat), 0, 0.9), vr.lo + t * (vr.hi - vr.lo));
        };
        const gradAt = (x, y) => {
            const gx = clamp(Math.round(x), 1, gw - 2), gy = clamp(Math.round(y), 1, gh - 2);
            const i = gy * gw + gx;
            const dx = lum[i + 1] - lum[i - 1];
            const dy = lum[i + gw] - lum[i - gw];
            return { dx: dx, dy: dy, m: Math.abs(dx) + Math.abs(dy) };
        };
        const colorAt = (px, py) => {
            const i = (clamp(Math.round(py / H * gh), 0, gh - 1) * gw
                + clamp(Math.round(px / W * gw), 0, gw - 1)) * 4;
            return { r: guide[i], g: guide[i + 1], b: guide[i + 2] };
        };
        // 平的地方不下笔。手绘一整片天、一整面墙是不见笔痕的，
        // 落笔只发生在色块交界和明暗转折——笔触铺满整张，就成了「叶子雨」。
        const pick = () => {
            for (let k = 0; k < 8; k++) {
                const x = rand() * W, y = rand() * H;
                if (gradAt(x / W * gw, y / H * gh).m > 5) return { x: x, y: y };
            }
            return null;
        };

        const cv = canvasOf(W, H);
        const g = cv.getContext('2d');
        g.lineJoin = 'round';
        // 笔要「少而大」。一支大笔盖住的面积，胜过十支小笔反复描，
        // 小笔堆多了，画面就会退回照片的密度。
        // 这里只加「笔痕」，底色已经铺好了，所以每层都得是薄的。
        const layers = [
            { n: 30, w: 0.030, len: 0.32, alpha: 0.15, jitter: 0.9 },
            { n: 70, w: 0.016, len: 0.20, alpha: 0.13, jitter: 1.1 },
            { n: 120, w: 0.008, len: 0.10, alpha: 0.11, jitter: 1.4 }
        ];
        const base = Math.min(W, H);
        layers.forEach((L) => {
            for (let n = 0; n < L.n; n++) {
                const s0 = pick();
                if (!s0) continue;
                const c0 = colorAt(s0.x, s0.y);
                const gr = gradAt(s0.x / W * gw, s0.y / H * gh);
                // 有结构的跟着结构走，平的地方按随机方向甩笔。
                // 抖动必须大：全按结构法向排，树皮会自己长出电路板。
                let ang = gr.m > 5
                    ? Math.atan2(gr.dy, gr.dx) + Math.PI / 2
                    : rand() * 6.2832;
                ang += (rand() - 0.5) * L.jitter;
                const len = base * L.len * (0.65 + rand() * 0.8);
                const width = base * L.w * (0.7 + rand() * 0.65);
                const pts = [];
                let cx = s0.x, cy = s0.y, a = ang;
                for (let s = 0; s <= 8; s++) {
                    pts.push({ x: cx, y: cy });
                    a += (rand() - 0.5) * 0.09;
                    cx += Math.cos(a) * len / 8;
                    cy += Math.sin(a) * len / 8;
                    if (s > 2) {
                        const c = colorAt(cx, cy);
                        if (Math.abs(c.r - c0.r) + Math.abs(c.g - c0.g) + Math.abs(c.b - c0.b) > 58) break;
                    }
                }
                if (pts.length < 3) continue;
                const left = [], right = [];
                pts.forEach((p, i) => {
                    const t = pts.length <= 1 ? 0.5 : i / (pts.length - 1);
                    const w = width * Math.pow(Math.sin(Math.PI * clamp(t, 0, 1)), 0.22) * (0.82 + rand() * 0.34);
                    const q = pts[Math.min(i + 1, pts.length - 1)], r0 = pts[Math.max(i - 1, 0)];
                    const dx = q.x - r0.x, dy = q.y - r0.y, d = Math.hypot(dx, dy) || 1;
                    left.push({ x: p.x - dy / d * w, y: p.y + dx / d * w });
                    right.push({ x: p.x + dy / d * w, y: p.y - dx / d * w });
                });
                // 明度先归到颜料的区间，再抖一点：同一片颜色不会只有一支笔
                const hsl = toHsl(parseHex(normHex(c0)));
                const c = parseHex(fromHsl(
                    (hsl.h + (rand() - 0.5) * 0.012 + 1) % 1,
                    clamp(hsl.s * 1.14 + rand() * 0.03, 0, 0.62),
                    clamp(hsl.l * (0.96 + rand() * 0.08), 0.05, 0.96)
                ));
                g.fillStyle = 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ','
                    + (L.alpha * (0.88 + rand() * 0.18)).toFixed(3) + ')';
                polyPath(g, left.concat(right.reverse()));
                g.fill();
            }
        });
        // 笔尖压过纸面会留下一点细线，再补一层稀疏的挑笔
        g.lineCap = 'round';
        for (let n = 0; n < 80; n++) {
            const s0 = pick();
            if (!s0) continue;
            const c0 = colorAt(s0.x, s0.y);
            const tint = mix(parseHex(normHex(c0)), { r: 30, g: 26, b: 24 }, 0.22);
            const gr = gradAt(s0.x / W * gw, s0.y / H * gh);
            const ang = (gr.m > 5 ? Math.atan2(gr.dy, gr.dx) + Math.PI / 2 : rand() * 6.2832)
                + (rand() - 0.5) * 0.7;
            const len = base * (0.02 + rand() * 0.05);
            g.strokeStyle = 'rgba(' + Math.round(tint.r) + ',' + Math.round(tint.g) + ',' + Math.round(tint.b) + ','
                + (0.05 + rand() * 0.10).toFixed(3) + ')';
            g.lineWidth = base * (0.0012 + rand() * 0.0022);
            g.beginPath();
            g.moveTo(s0.x, s0.y);
            g.quadraticCurveTo(
                s0.x + Math.cos(ang) * len * 0.5 + (rand() - 0.5) * base * 0.01,
                s0.y + Math.sin(ang) * len * 0.5 + (rand() - 0.5) * base * 0.01,
                s0.x + Math.cos(ang) * len, s0.y + Math.sin(ang) * len
            );
            g.stroke();
        }
        return cv;
    }

    // 线必须成「线」。逐像素看邻居治不了霉斑——一小撮点互相挨着，照样能通过，
    // 一膨胀就变成黑陀。这里按连通分量筛：外接框不够长、面积不够大的整段丢掉。
    function pruneInk(alpha, w, h, minLen, maxThick) {
        const total = w * h;
        const on = new Uint8Array(total);
        for (let p = 0; p < total; p++) if (alpha[p] > 0.16) on[p] = 1;
        const seen = new Uint8Array(total);
        const stamp = new Int32Array(total);
        const stack = new Int32Array(total);
        const out = new Float32Array(total);
        const minPix = Math.max(10, Math.round(minLen * minLen * 0.35));
        let cur = 0;
        for (let p0 = 0; p0 < total; p0++) {
            if (!on[p0] || seen[p0]) continue;
            cur++;
            let sp = 0, n = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
            stack[sp++] = p0;
            seen[p0] = 1;
            stamp[p0] = cur;
            while (sp) {
                const p = stack[--sp];
                n++;
                const x = p % w, y = (p / w) | 0;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= h) continue;
                    const row = yy * w;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        const q = row + xx;
                        if (on[q] && !seen[q]) { seen[q] = 1; stamp[q] = cur; stack[sp++] = q; }
                    }
                }
            }
            const diag = Math.hypot(x1 - x0, y1 - y0);
            if (n < minPix || diag < minLen) continue;
            // 一笔线的平均厚度 = 面积 / 长度。成片的暗块算出来很厚，
            // 那是「阴影」，不是「线」，留着就会变成一块块黑斑。
            if (maxThick && n / Math.max(1, diag) > maxThick) continue;
            // 只把「确认是线」的那一段放回去，框里的其他分量不算
            for (let dy = y0; dy <= y1; dy++) {
                const row = dy * w;
                for (let dx = x0; dx <= x1; dx++) {
                    const q = row + dx;
                    if (stamp[q] === cur && alpha[q] > out[q]) out[q] = alpha[q];
                }
            }
        }
        return out;
    }

    // 墨线：DoG 找暗侧边缘，坐标加抖动，线宽随位置呼吸。
    function inkLayer(gray, w, h, opt) {
        const o = opt || {};
        const ink = parseHex(o.color || '#2A2622');
        const pre = blurPlane(gray, w, h, 1, 1);
        // 近邻模糊只当「去噪」，远邻模糊决定「多大的形才配一条线」：
        // 半径太小，每片叶子都会勾边，画面立刻变成铜版画。
        const wide = blurPlane(pre, w, h,
            Math.max(2, Math.round(Math.min(w, h) * (o.wideScale == null ? 0.02 : o.wideScale))), 2);
        const eps = o.eps == null ? 9 : o.eps;
        const soft = o.soft == null ? 24 : o.soft;
        const cutLine = o.cutLine == null ? 0.30 : o.cutLine;
        const ph = (o.seed || 0) * 0.9;
        const alpha = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            const wy = Math.sin(y * 0.058 + ph) * 0.9 + Math.sin(y * 0.019 + ph * 0.4) * 0.7;
            for (let x = 0; x < w; x++) {
                const wx = Math.sin(x * 0.049 + ph * 1.3) * 0.9 + Math.sin(x * 0.015) * 0.6;
                const i = clamp(Math.round(y + wy), 0, h - 1) * w + clamp(Math.round(x + wx), 0, w - 1);
                // 弱线直接丢掉，只留压过阈值的那几笔，线才会「果断」
                const raw = ((-(pre[i] - wide[i]) - eps) / soft - cutLine) / (1 - cutLine);
                // 亮处少压线：天空和高光不需要轮廓，暗处的结构才值得勾
                const dark = clamp((176 - pre[i]) / 120, 0.06, 1);
                const a = raw > 0
                    ? raw * dark * (0.72 + 0.28 * Math.sin(x * 0.023 + y * 0.019 + ph))
                    : 0;
                if (a > 0.02) alpha[y * w + x] = clamp(a * (o.strength == null ? 1 : o.strength), 0, 0.70);
            }
        }
        // 先把碎点筛掉，再谈粗细。顺序反了的话，霉点会先被膨胀养大。
        const keep = pruneInk(alpha, w, h,
            Math.max(18, Math.min(w, h) * (o.minLen == null ? 0.038 : o.minLen)),
            Math.max(4, Math.min(w, h) * (o.maxThick == null ? 0.014 : o.maxThick)));
        // 强笔向外吃一圈：线自然变粗，不是整片加深
        const thick = new Float32Array(w * h);
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const p = y * w + x;
                const a = keep[p];
                if (a < 0.5) continue;
                // 端点不收粗：只有中段连着两笔以上才往外吃，
                // 这样一根线是「两头细、中间重」，不是一根等粗的黑棍。
                let strong = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if ((dx || dy) && keep[p + dy * w + dx] > 0.42) strong++;
                    }
                }
                if (strong < 2) continue;
                const v = a * 0.72;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const q = p + dy * w + dx;
                        if (v > thick[q]) thick[q] = v;
                    }
                }
            }
        }
        for (let p = 0; p < keep.length; p++) if (thick[p] > keep[p]) keep[p] = thick[p];
        const cv = canvasOf(w, h);
        const g = cv.getContext('2d');
        const img = g.createImageData(w, h);
        const d = img.data;
        for (let p = 0; p < keep.length; p++) {
            if (keep[p] <= 0.02) continue;
            const i = p * 4;
            d[i] = ink.r; d[i + 1] = ink.g; d[i + 2] = ink.b;
            d[i + 3] = keep[p] * 255;
        }
        g.putImageData(img, 0, 0);
        return cv;
    }

    // 排线：只落在暗部，笔画分段、带弯曲，像铅笔一截一截压出来。
    function hatchLayer(gray, w, h, seed) {
        const cv = canvasOf(w, h);
        const g = cv.getContext('2d');
        const rand = rng(hash('hatch' + seed + ':' + w + 'x' + h));
        const diag = Math.hypot(w, h);
        const step = Math.max(3.4, Math.min(w, h) / 92);
        g.lineCap = 'round';
        g.lineWidth = Math.max(0.75, step * 0.19);
        [{ ang: -0.74, alpha: 0.26 }, { ang: 0.66, alpha: 0.20 }].forEach((p) => {
            const ax = Math.cos(p.ang), ay = Math.sin(p.ang);
            const nx = -ay, ny = ax;
            const n = Math.ceil(diag / step);
            for (let i = -n; i <= n; i++) {
                const ox = w / 2 + nx * i * step, oy = h / 2 + ny * i * step;
                let t = -diag / 2 - rand() * step;
                while (t < diag / 2) {
                    const seg = step * (2.2 + rand() * 3.4);
                    const a0 = t, a1 = Math.min(diag / 2, t + seg * (0.7 + rand() * 0.5));
                    if (a1 - a0 > 1.5) {
                        const bow = (rand() - 0.5) * step * 1.2;
                        g.strokeStyle = 'rgba(0,0,0,' + (p.alpha * (0.55 + rand() * 0.7)).toFixed(3) + ')';
                        g.beginPath();
                        g.moveTo(ox + ax * a0, oy + ay * a0);
                        g.quadraticCurveTo(
                            ox + ax * (a0 + a1) / 2 + nx * bow, oy + ay * (a0 + a1) / 2 + ny * bow,
                            ox + ax * a1, oy + ay * a1
                        );
                        g.stroke();
                    }
                    t = a1 + step * (0.4 + rand() * 1.1);
                }
            }
        });
        const mask = canvasOf(w, h);
        const m = mask.getContext('2d');
        const img = m.createImageData(w, h);
        const d = img.data;
        for (let p = 0; p < gray.length; p++) {
            const a = clamp((0.50 - gray[p] / 255) * 2.0, 0, 0.86);
            if (a <= 0.01) continue;
            d[p * 4 + 3] = a * 255;
        }
        m.putImageData(img, 0, 0);
        // 只留暗部：亮的地方用纸白，排线压上去会脏
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(mask, 0, 0);
        g.globalCompositeOperation = 'source-over';
        return cv;
    }

    // 一张手绘版画：水彩 + 排线 + 墨线，边缘用不规则遮罩化开。
    function sketchPlate(img, w, h, opt) {
        const o = opt || {};
        const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
        const seed = o.seed || 0;
        const aspect = W / H;
        const wp = photoPlane(img, aspect, Math.min(o.washEdge || 240, Math.max(W, H)));
        let wd;
        try { wd = wp.ctx.getImageData(0, 0, wp.w, wp.h); } catch (_) { return null; }
        if (o.mode === 'stroke') return strokeLayer(img, W, H, o.pal, { paper: o.paper, seed: seed, tone: o.tone });
        const seamOut = [];
        const smooth = kuwaharaPlane(wd.data, wp.w, wp.h, 2);
        const wash = washLayer(smooth, wp.w, wp.h, o.pal, {
            paper: o.paper, seed: seed, lift: o.lift, tone: o.tone, range: o.range,
            soften: o.soften == null ? 0.9 : o.soften, seamOut: seamOut,
            paperCut: o.paperCut, paperSoft: o.paperSoft, smallFrac: o.smallFrac,
            whiteCut: o.whiteCut, keepAccent: o.keepAccent, satCap: o.satCap, satBoost: o.satBoost
        });
        if (o.mode === 'wash') return wash;

        // 线默认从色块交界来：它和色块同源，所以每根线都闭合在一个形上，
        // 不会像边缘检测那样在树皮、草叶上长出一片碎线。
        const seam = seamOut[0];
        const useSeam = seam && o.seam !== false;
        let ink = null, hatch = null;
        if (useSeam) {
            ink = seamLayer(seam, { color: o.ink, seed: seed, minD: o.seamD, boost: o.strength });
            if (o.hatch) {
                const gg = grayOfPhoto(img, aspect, o.lineEdge || 380);
                if (gg) hatch = hatchLayer(blurPlane(gg.plane, gg.w, gg.h, 1, 1), gg.w, gg.h, seed);
            }
        } else {
            const gg = grayOfPhoto(img, aspect, o.lineEdge || 380);
            if (!gg) return null;
            ink = inkLayer(gg.plane, gg.w, gg.h, {
                color: o.ink, seed: seed, eps: o.eps, soft: o.soft,
                wideScale: o.wideScale, cutLine: o.cutLine, strength: o.strength
            });
            if (o.hatch) hatch = hatchLayer(blurPlane(gg.plane, gg.w, gg.h, 1, 1), gg.w, gg.h, seed);
        }
        if (o.mode === 'ink') return ink;
        if (o.mode === 'hatch') return hatch;

        // 笔触的向导必须是「已经概括过的色块」，不是原图。
        // 拿原图当向导，树皮、草丛、砖缝会被一笔一笔抄回来——那还是滤镜，不是画。
        const guideCv = canvasOf(W, H);
        const gc = guideCv.getContext('2d');
        gc.fillStyle = o.paper || '#F2E7D2';
        gc.fillRect(0, 0, W, H);
        gc.drawImage(wash, 0, 0, W, H);

        const plate = canvasOf(W, H);
        const g = plate.getContext('2d');
        // 颜料和线不能严丝合缝：错开一两个像素，才像手工套色
        const dx = (o.offset == null ? 0.0016 : o.offset) * W;
        const dy = (o.offset == null ? 0.0016 : o.offset) * H;
        g.drawImage(wash, -dx, dy, W + dx * 2, H + dy * 2);
        // 笔触压在底色上：色块有了，笔痕也有了
        if (o.strokes !== false) {
            const strokes = strokeLayer(guideCv, W, H, o.pal, {
                paper: o.paper, seed: seed + 3, tone: o.tone, range: o.range, preNormalized: true
            });
            if (strokes) {
                g.globalAlpha = o.strokeAlpha == null ? 0.9 : o.strokeAlpha;
                g.drawImage(strokes, 0, 0);
                g.globalAlpha = 1;
            }
        }
        if (hatch) {
            g.globalCompositeOperation = 'multiply';
            g.globalAlpha = 0.55;
            g.drawImage(hatch, 0, 0, W, H);
            g.globalAlpha = 1;
        }
        g.globalCompositeOperation = 'source-over';
        g.drawImage(ink, 0, 0, W, H);
        if (o.mask) {
            g.globalCompositeOperation = 'destination-in';
            g.drawImage(o.mask, 0, 0, W, H);
            g.globalCompositeOperation = 'source-over';
        }
        return plate;
    }

    // 比 organicMask 更轻的边：只让颜料在四边慢慢淡掉，不留一个框。
    function softMask(W, H, seed) {
        const c = canvasOf(W, H);
        const g = c.getContext('2d');
        const { pts } = tornPath(W, H, ['top', 'right', 'bottom', 'left'], seed, Math.min(W, H) * 0.018);
        g.fillStyle = '#000';
        g.save();
        g.translate(W * 0.006, H * 0.007);
        g.scale(0.988, 0.986);
        polyPath(g, pts);
        g.fill();
        g.restore();
        const soft = canvasOf(W, H);
        const sf = soft.getContext('2d');
        if ('filter' in sf) {
            sf.filter = 'blur(' + Math.max(1.5, Math.min(W, H) * 0.0022) + 'px)';
            sf.drawImage(c, 0, 0);
            return soft;
        }
        return c;
    }

    // ── 排版 ────────────────────────────────────────────────────
    function measureTracked(widths, tracking) {
        return widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, widths.length - 1);
    }
    function drawTracked(ctx, text, x, y, opt) {
        const chars = Array.from(String(text || ''));
        if (!chars.length) return 0;
        ctx.font = opt.font;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const widths = chars.map((c) => ctx.measureText(c).width);
        const tracking = opt.tracking || 0;
        const total = measureTracked(widths, tracking);
        let cx = opt.align === 'center' ? x - total / 2 : opt.align === 'right' ? x - total : x;
        chars.forEach((c, i) => { ctx.fillText(c, cx, y); cx += widths[i] + tracking; });
        return total;
    }
    // 按可用宽度自己缩字号：长标题不会溢出纸边，也不会被硬裁。
    function fitTitle(ctx, text, maxW, size, trackingRatio) {
        const chars = Array.from(String(text || ''));
        if (!chars.length) return { size: size, w: 0 };
        let s = size;
        for (let i = 0; i < 10; i++) {
            ctx.font = '500 ' + Math.round(s) + 'px ' + SERIF;
            const widths = chars.map((c) => ctx.measureText(c).width);
            const w = measureTracked(widths, s * trackingRatio);
            if (w <= maxW || s < 9) return { size: s, w: w };
            s = Math.max(9, Math.min(s * 0.94, s * (maxW / w)));
        }
        return { size: s, w: maxW };
    }

    // 题字块：可横可竖，可带一条细线。没字就不画——不编造假标题。
    function caption(ctx, W, H, opt) {
        const o = opt || {};
        const title = String(o.title || '').trim();
        const sub = String(o.subtitle || '').trim();
        if (!title && !sub) return;
        const color = o.color || '#2C2A26';
        const muted = o.muted || mixHex(color, paperFor(o.tone || 'warm'), 0.42);
        const maxW = o.maxW || W * 0.8;
        const baseSize = o.size || Math.min(W, H) * 0.055;
        const align = o.align || 'left';
        ctx.save();
        if (o.vertical) {
            ctx.translate(o.x, o.y);
            ctx.rotate(-Math.PI / 2);
        }
        const ox = o.vertical ? 0 : o.x;
        const oy = o.vertical ? 0 : o.y;
        const fit = title ? fitTitle(ctx, title, o.vertical ? maxW : maxW, baseSize, 0.13) : { size: 0, w: 0 };
        if (title) {
            const t = Array.from(title).map((c) => (/[a-z]/.test(c) ? c.toUpperCase() : c)).join('');
            ctx.fillStyle = color;
            if (o.rule) {
                const ry = oy - fit.size * 1.34;
                const rx = ox - (align === 'center' ? fit.w / 2 : align === 'right' ? fit.w : 0);
                ctx.fillRect(rx, ry, o.ruleW || fit.w * 0.22, Math.max(1, fit.size * 0.032));
            }
            drawTracked(ctx, t, ox, oy, { font: '500 ' + Math.round(fit.size) + 'px ' + SERIF, tracking: fit.size * 0.13, align: align });
        }
        if (sub) {
            const ss = baseSize * (title ? 0.30 : 0.46);
            ctx.fillStyle = muted;
            drawTracked(ctx, sub, ox, oy + (title ? baseSize * 0.72 : 0), {
                font: '400 ' + Math.round(Math.max(8, ss)) + 'px ' + SERIF,
                tracking: Math.max(1.4, ss * 0.26), align: align
            });
        }
        ctx.restore();
    }

    // 色卡：四枚小纸片，细边无投影，像贴上去的色票而不是界面按钮。
    function inkChips(ctx, W, H, pal, x, y, size, tone) {
        const s = size || Math.min(W, H) * 0.048;
        const gap = s * 0.34;
        const ink = parseHex(inkOf(pal, tone));
        ctx.save();
        pal.slice(0, 4).forEach((c, i) => {
            const cx = x - (3 - i) * (s + gap);
            ctx.fillStyle = c;
            rounded(ctx, cx, y, s, s, s * 0.08);
            ctx.fill();
            ctx.strokeStyle = rgba(ink, tone === 'night' ? 0.35 : 0.22);
            ctx.lineWidth = Math.max(0.8, s * 0.022);
            ctx.stroke();
        });
        ctx.restore();
    }

    // 跨介质的线：从照片里出来，穿过撕口，落到纸面。
    // 用路径两端透明 + 两道粗细叠出笔触感，不再是尺子画出来的直线。
    function thread(ctx, pts, color, width, alpha) {
        if (!pts || pts.length < 2) return;
        const c = parseHex(color);
        const a = alpha == null ? 0.9 : alpha;
        const path = new Path2D();
        path.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
            const xc = (pts[i][0] + pts[i + 1][0]) / 2;
            const yc = (pts[i][1] + pts[i + 1][1]) / 2;
            path.quadraticCurveTo(pts[i][0], pts[i][1], xc, yc);
        }
        const last = pts[pts.length - 1];
        path.lineTo(last[0], last[1]);
        const g = ctx.createLinearGradient(pts[0][0], pts[0][1], last[0], last[1]);
        g.addColorStop(0, rgba(c, 0));
        g.addColorStop(0.14, rgba(c, a));
        g.addColorStop(0.84, rgba(c, a));
        g.addColorStop(1, rgba(c, 0));
        ctx.save();
        ctx.strokeStyle = g;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.24;
        ctx.lineWidth = width * 2.4;
        ctx.stroke(path);
        ctx.globalAlpha = 1;
        ctx.lineWidth = width;
        ctx.stroke(path);
        ctx.restore();
    }

    // ── 六种纸感 ────────────────────────────────────────────────
    // 撕口叙事：竖图把标题竖排在左侧纸栏，照片从右上出血、只在左下撕开；
    // 横图让照片压满上 70%，撕口横贯整幅，题字落在下面的纸带里。
    function renderTear(ctx, img, W, H, pal, o) {
        const tone = o.tone;
        const paper = paperFor(tone);
        const ink = inkOf(pal, tone);
        const accent = accentOf(pal);
        const seed = o.seed || 0;
        const k = 0.35 + (o.bold || 0) * 1.2;
        const rand = rng(hash('tear' + pal.join('') + seed));
        const portrait = H >= W * 1.02;

        wash(ctx, W * (0.08 + rand() * 0.05), H * (0.12 + rand() * 0.06), Math.min(W, H) * (0.20 + rand() * 0.06), accent, tone, 0.16);
        wash(ctx, W * (0.10 + rand() * 0.05), H * (0.48 + rand() * 0.06), Math.min(W, H) * (0.24 + rand() * 0.08), pal[1] || accent, tone, 0.18);

        if (portrait) {
            const box = { x: W * 0.26, y: -H * 0.04, w: W * 0.80, h: H * (0.66 + rand() * 0.05) };
            tornPhoto(ctx, img, box, {
                edges: ['left', 'bottom'], seed: seed + 11,
                amp: Math.max(4, W * (0.026 + rand() * 0.012) * k),
                rot: (rand() - 0.5) * 0.022 * k, paper: paper, ink: ink
            });
            thread(ctx, [
                [W * 0.30, H * 0.55],
                [W * 0.38, H * 0.70],
                [W * 0.54, H * 0.79],
                [W * 0.80, H * 0.895]
            ], accent, Math.max(2.2, W * 0.0042), 0.8);
            inkChips(ctx, W, H, pal, W * 0.945, H * 0.955 - Math.min(W, H) * 0.040, Math.min(W, H) * 0.040, tone);
            caption(ctx, W, H, {
                title: o.title, subtitle: o.subtitle, tone: tone, color: ink,
                muted: mixHex(ink, paper, 0.44), vertical: true,
                x: W * 0.115, y: H * 0.90, align: 'left', maxW: H * 0.62,
                size: Math.min(W, H) * 0.060
            });
        } else {
            const box = { x: -W * 0.03, y: -H * 0.05, w: W * 1.02, h: H * (0.68 + rand() * 0.05) };
            tornPhoto(ctx, img, box, {
                edges: ['bottom'], seed: seed + 11,
                amp: Math.max(4, H * (0.026 + rand() * 0.014) * k),
                rot: (rand() - 0.5) * 0.014 * k, paper: paper, ink: ink
            });
            thread(ctx, [
                [W * 0.72, H * 0.42],
                [W * 0.80, H * 0.58],
                [W * 0.82, H * 0.76],
                [W * 0.80, H * 0.90]
            ], accent, Math.max(2.2, W * 0.004), 0.8);
            inkChips(ctx, W, H, pal, W * 0.925, H * 0.955 - Math.min(W, H) * 0.042, Math.min(W, H) * 0.042, tone);
            caption(ctx, W, H, {
                title: o.title, subtitle: o.subtitle, tone: tone, color: ink,
                muted: mixHex(ink, paper, 0.44),
                x: W * 0.07, y: H * 0.835, align: 'left', maxW: W * 0.62,
                size: Math.min(W, H) * 0.070, rule: true, ruleW: W * 0.09
            });
        }
    }

    function renderBifold(ctx, img, W, H, pal, o) {
        const tone = o.tone;
        const paper = paperFor(tone);
        const ink = inkOf(pal, tone);
        const seed = o.seed || 0;
        const k = 0.35 + (o.bold || 0) * 1.2;
        const rand = rng(hash('bifold' + pal.join('') + seed));
        const split = clamp(0.46 + (rand() - 0.5) * 0.06 * k, 0.40, 0.53);
        const top = H * split;
        const bottomH = H * 0.38;

        // 上半：实景，原样保留
        drawPhotoCover(ctx, img, 0, 0, W, top);

        // 下半：把同一张照片剪成一条条撕边纸，接在实景下面；只取中下段，形更大
        ctx.fillStyle = paper;
        ctx.fillRect(0, top, W, H - top);
        paperCutLandscape(ctx, img, 0, top + H * 0.012, W, bottomH, pal, {
            cols: 11, rows: 6, levels: 4, tone: tone, seed: seed,
            tint: accentOf(pal), lift: 0.92,
            crop: { x: 0.06, y: 0.30, w: 0.88, h: 0.70 }
        });

        // 分界的纸缝：一条纸白 + 一条墨线，像折页压过
        ctx.fillStyle = paper;
        ctx.globalAlpha = 0.94;
        ctx.fillRect(0, top - Math.max(2, H * 0.004), W, Math.max(3, H * 0.008));
        ctx.globalAlpha = 1;
        ctx.fillStyle = rgba(parseHex(ink), 0.45);
        ctx.fillRect(0, top - Math.max(1, H * 0.0016), W, Math.max(1, H * 0.0016));

        // 分界处补两团淡色，让上下不是硬切
        wash(ctx, W * (0.18 + rand() * 0.2), top + H * 0.05, Math.min(W, H) * 0.22, accentOf(pal), tone, 0.10);
        wash(ctx, W * (0.62 + rand() * 0.2), top + H * 0.09, Math.min(W, H) * 0.24, pal[1] || accentOf(pal), tone, 0.10);

        caption(ctx, W, H, {
            title: o.title, subtitle: o.subtitle, tone: tone, color: ink,
            muted: mixHex(ink, paper, 0.48),
            x: W / 2, y: H * 0.925, align: 'center', maxW: W * 0.80,
            size: Math.min(W, H) * 0.050
        });
    }

    function renderPop(ctx, img, W, H, pal, o) {
        const seed = o.seed || 0;
        const k = 0.35 + (o.bold || 0) * 1.2;
        const rand = rng(hash('pop' + pal.join('') + seed));
        const ink = inkOf(pal, 'warm');
        const accent = accentOf(pal);
        const bg = complement(accent, 0.24);
        const cream = '#F6F1E6';
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        // 背景巨形：一大圆吃掉右上角，全部平涂
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(W * (0.84 + (rand() - 0.5) * 0.06 * k), H * (0.10 + rand() * 0.05), W * 0.30, 0, 6.2832);
        ctx.fill();

        // 照片：带纸边的印刷品，微微歪着贴上去
        const pw = W * (0.60 + rand() * 0.05 * k), ph = H * (0.46 + rand() * 0.05 * k);
        const px = (W - pw) * (0.32 + rand() * 0.06 * k), py = (H - ph) * (0.20 + rand() * 0.06 * k);
        const rot = (rand() - 0.5) * 0.08 * k;
        ctx.save();
        ctx.translate(px + pw / 2, py + ph / 2);
        ctx.rotate(rot);
        // 错版块：底色透出一点，像丝网没套准
        ctx.fillStyle = rgba(parseHex(accent), 0.85);
        ctx.fillRect(-pw / 2 + W * 0.016, -ph / 2 + H * 0.018, pw, ph);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(-pw / 2 + W * 0.008, -ph / 2 + H * 0.010, pw, ph);
        ctx.fillStyle = cream;
        ctx.fillRect(-pw / 2 - W * 0.011, -ph / 2 - W * 0.011, pw + W * 0.022, ph + W * 0.022);
        ctx.save();
        ctx.beginPath();
        ctx.rect(-pw / 2, -ph / 2, pw, ph);
        ctx.clip();
        drawPhotoCover(ctx, img, -pw / 2, -ph / 2, pw, ph);
        ctx.restore();
        ctx.strokeStyle = rgba(parseHex(ink), 0.5);
        ctx.lineWidth = Math.max(1, W * 0.0018);
        ctx.strokeRect(-pw / 2, -ph / 2, pw, ph);
        ctx.restore();

        caption(ctx, W, H, {
            title: o.title, subtitle: o.subtitle, tone: 'night', color: cream,
            muted: 'rgba(246,241,230,0.70)',
            x: W * 0.075, y: H * 0.925, align: 'left', maxW: W * 0.62,
            size: Math.min(W, H) * 0.050
        });
    }

    function renderPenWash(ctx, img, W, H, pal, o) {
        const tone = o.tone;
        const paper = paperFor(tone);
        const ink = inkOf(pal, tone);
        const seed = o.seed || 0;
        const k = 0.35 + (o.bold || 0) * 1.2;
        const rand = rng(hash('wash' + pal.join('') + seed));

        // 先铺环境色，照片再压上去；晕染只出现在纸面上
        for (let i = 0; i < 6; i++) {
            wash(ctx, W * rand(), H * rand(), Math.min(W, H) * (0.18 + rand() * 0.22),
                pal[(i + 1) % pal.length], tone, tone === 'night' ? 0.16 : 0.20);
        }

        const pw = W * (0.86 + rand() * 0.05 * k), ph = H * (0.60 + rand() * 0.05 * k);
        const px = (W - pw) / 2 + (rand() - 0.5) * W * 0.03 * k;
        const py = H * (0.065 + rand() * 0.02);
        // 照片不再整张贴上去：先重画成水彩 + 墨线，再按晕染边落纸
        const mask = softMask(pw, ph, seed + 3);
        const layer = sketchPlate(img, pw, ph, {
            pal: pal, paper: paper, ink: ink, mask: mask, seed: seed, tone: tone,
            washEdge: 240, lift: 0.26, strokeAlpha: 0.62,
            // 淡彩是「水多颜料少」：明度高、饱和低，靠墨线立住形。
            // 这里不能沿用写生那套满饱和的颜料区间。
            range: { lo: 0.34, hi: 0.82, sat: 0.72 },
            paperCut: 0.12, seamD: 0.085, strength: 1.45, whiteCut: 0.76, keepAccent: false,
            smallFrac: 0.008, satCap: 0.46, satBoost: 0
        });
        if (!layer) return;
        ctx.save();
        ctx.translate(px + pw / 2, py + ph / 2);
        ctx.rotate((rand() - 0.5) * 0.012 * k);
        ctx.drawImage(layer, -pw / 2, -ph / 2);
        // 边缘再补几团同色水，让照片和纸真的接上
        for (let i = 0; i < 5; i++) {
            const side = i % 2;
            const wx = side ? pw * (0.74 + rand() * 0.20) : pw * (0.06 + rand() * 0.18);
            const wy = ph * (0.08 + rand() * 0.82);
            wash(ctx, wx - pw / 2, wy - ph / 2, Math.min(pw, ph) * (0.10 + rand() * 0.10), pal[i % pal.length], tone, 0.14);
        }
        ctx.restore();

        inkChips(ctx, W, H, pal, W * 0.915, H * 0.872, Math.min(W, H) * 0.042, tone);
        caption(ctx, W, H, {
            title: o.title, subtitle: o.subtitle, tone: tone, color: ink,
            muted: mixHex(ink, paper, 0.44),
            x: W / 2, y: H * 0.865, align: 'center', maxW: W * 0.78,
            size: Math.min(W, H) * 0.050
        });
    }

    // 手绘线稿：整页只有「一张手画的画」，没有任何照片像素。
    function renderSketch(ctx, img, W, H, pal, o) {
        const tone = o.tone;
        const paper = paperFor(tone);
        const ink = inkOf(pal, tone);
        const seed = o.seed || 0;
        const rand = rng(hash('sketch' + pal.join('') + seed));

        // 纸先吃几口水：色只落在边缘，中间留给画
        for (let i = 0; i < 4; i++) {
            wash(ctx, W * (i % 2 ? 0.84 + rand() * 0.14 : 0.02 + rand() * 0.16),
                H * (0.04 + rand() * 0.62), Math.min(W, H) * (0.16 + rand() * 0.14),
                pal[(i + 1) % pal.length], tone, 0.13);
        }

        // 画面按照片的比例落进纸面，不裁成统一画幅；
        // 横图直接出血到左右纸边，竖图留白居中——两种都不会在纸上缩成一小块。
        const aspect = (img.naturalWidth || img.width) / (img.naturalHeight || img.height) || 1;
        const box = { x: W * 0.055, y: H * 0.04, w: W * 0.89, h: H * 0.66 };
        let pw = box.w, ph = pw / aspect;
        if (ph > box.h) { ph = box.h; pw = ph * aspect; }
        if (pw > box.w) { pw = box.w; ph = pw / aspect; }
        const px = box.x + (box.w - pw) / 2;
        const py = box.y + (box.h - ph) / 2;
        const drawPx = px, drawPy = py, bleedK = 1;

        const t = o.tune || {};
        const plate = sketchPlate(img, pw, ph, {
            pal: pal, paper: paper, ink: ink, seed: seed, tone: tone,
            // 描线要在一张「已经缩小」的图上找：树皮、砖缝、草叶这些
            // 高频纹理在缩小时自己就没了，留下的才是值得勾的形。
            mask: softMask(pw, ph, seed + 6), washEdge: 240, lineEdge: 380,
            lift: t.lift == null ? 0.38 : t.lift,
            wideScale: t.wideScale == null ? 0.045 : t.wideScale,
            eps: t.eps, cutLine: t.cutLine, hatch: t.hatch, strokeAlpha: t.strokeAlpha,
            strokes: t.strokes, paperCut: t.paperCut, paperSoft: t.paperSoft,
            merge: t.merge, smallFrac: t.smallFrac
        });
        if (plate) {
            ctx.save();
            ctx.globalCompositeOperation = 'multiply';
            ctx.globalAlpha = 0.96;
            ctx.drawImage(plate, drawPx, drawPy, pw * bleedK, ph * bleedK);
            ctx.restore();
        }

        // 一条手画的界线：把画和题字分开，但不拿尺子画
        const ry = H * 0.785;
        ctx.save();
        ctx.strokeStyle = rgba(parseHex(ink), 0.34);
        ctx.lineWidth = Math.max(1, W * 0.0016);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(W * 0.075, ry);
        for (let i = 1; i <= 9; i++) {
            const t = i / 9;
            ctx.lineTo(W * (0.075 + 0.72 * t),
                ry + Math.sin(t * 6.4 + seed) * H * 0.0018 + (rand() - 0.5) * H * 0.0014);
        }
        ctx.stroke();
        ctx.restore();

        inkChips(ctx, W, H, pal, W * 0.905, H * 0.848, Math.min(W, H) * 0.040, tone);
        caption(ctx, W, H, {
            title: o.title, subtitle: o.subtitle, tone: tone, color: ink,
            muted: mixHex(ink, paper, 0.44),
            x: W * 0.075, y: H * 0.912, align: 'left', maxW: W * 0.56,
            size: Math.min(W, H) * 0.054
        });
    }

    function renderDistill(ctx, img, W, H, pal, o) {
        const tone = o.tone;
        const paper = paperFor(tone);
        const ink = inkOf(pal, tone);
        const accent = accentOf(pal);
        const seed = o.seed || 0;
        const k = 0.35 + (o.bold || 0) * 1.2;
        const rand = rng(hash('distill' + pal.join('') + seed));
        const grid = sceneGrid(img);

        // 记忆层：整张照片被压成很淡的墨阶，像隔着一层纸回想
        flatReconstruct(ctx, img, W * 0.05, H * 0.07, W * 0.90, H * 0.52, pal, {
            levels: 5, contrast: 1.15, dither: 1.2, tint: accentOf(pal), tone: tone, seed: seed,
            alpha: 0.30, feather: Math.min(W, H) * 0.10
        });

        // 两张被撕下来的色纸条，构成大关系
        for (let i = 0; i < 2; i++) {
            const w = W * (0.26 + rand() * 0.12) * (0.9 + k * 0.2);
            const h = H * (0.09 + rand() * 0.08);
            const { pts } = tornPath(w, h, ['top', 'bottom'], seed + i * 13, Math.min(w, h) * 0.22);
            const cx = W * (0.30 + rand() * 0.24);
            ctx.save();
            ctx.globalAlpha = 0.86;
            ctx.translate(cx - w / 2, H * (0.24 + rand() * 0.30) - h / 2);
            ctx.rotate((rand() - 0.5) * 0.36 * k);
            ctx.fillStyle = pal[(i + 1) % pal.length];
            polyPath(ctx, pts);
            ctx.fill();
            ctx.restore();
        }

        // 重心处的主形：从照片最亮的地方长出来
        if (grid) {
            const mx = W * clamp(grid.cx, 0.12, 0.88);
            const my = H * clamp(grid.cy * 0.8, 0.10, 0.60);
            const r = Math.min(W, H) * (0.070 + 0.030 * k);
            ctx.save();
            ctx.globalAlpha = 0.94;
            ctx.fillStyle = accent;
            ctx.beginPath(); ctx.arc(mx, my, r, 0, 6.2832); ctx.fill();
            ctx.strokeStyle = tone === 'night' ? 'rgba(240,235,220,0.5)' : 'rgba(44,42,38,0.4)';
            ctx.lineWidth = Math.max(1.5, W * 0.0028);
            ctx.beginPath(); ctx.arc(mx, my, r * 1.6, 0.6, 3.4); ctx.stroke();
            ctx.restore();
            thread(ctx, [
                [mx, my],
                [W * (0.74 + rand() * 0.06), H * (0.42 + rand() * 0.05)],
                [W * 0.94, H * (0.34 + rand() * 0.05)]
            ], accent, Math.max(1.8, W * 0.0032), 0.45);
        }

        caption(ctx, W, H, {
            title: o.title, subtitle: o.subtitle, tone: tone, color: ink,
            muted: mixHex(ink, paper, 0.44),
            x: W / 2, y: H * 0.865, align: 'center', maxW: W * 0.80,
            size: Math.min(W, H) * 0.047
        });
    }

    // 照片的明暗骨架：20×25 采样，只取亮度分布与重心，不保留任何照片像素。
    function sceneGrid(img) {
        const c = canvasOf(20, 25);
        const x = c.getContext('2d');
        try { x.drawImage(img, 0, 0, 20, 25); } catch (_) { return null; }
        let d;
        try { d = x.getImageData(0, 0, 20, 25).data; } catch (_) { return null; }
        const cells = [];
        let sx = 0, sy = 0, sw = 0;
        for (let gy = 0; gy < 25; gy++) {
            for (let gx = 0; gx < 20; gx++) {
                const i = (gy * 20 + gx) * 4;
                const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
                cells.push({ gx: gx, gy: gy, l: l });
                const w = l * l;
                sx += gx * w; sy += gy * w; sw += w;
            }
        }
        return { cells: cells, cx: sw ? sx / sw / 20 : 0.5, cy: sw ? sy / sw / 25 : 0.45 };
    }

    function sizeFor(img, id, maxEdge) {
        const iw = img.naturalWidth || img.width || 1200;
        const ih = img.naturalHeight || img.height || 1500;
        const ar = iw / ih;
        const ratio = id === 'ink-bifold' ? 0.64 : id === 'surreal-pop' ? 0.78
            : id === 'ink-sketch' ? clamp(ar, 0.7, 1.35) : ar;
        let w, h;
        if (ratio >= 1) { w = 1500; h = Math.round(w / ratio); }
        else { h = 1500; w = Math.round(h * ratio); }
        if (maxEdge) {
            const k = Math.min(1, maxEdge / Math.max(w, h));
            return { W: Math.max(60, Math.round(w * k)), H: Math.max(60, Math.round(h * k)) };
        }
        return { W: clamp(w, 640, 1900), H: clamp(h, 640, 1900) };
    }

    function render(id, img, opts) {
        if (!img) return null;
        const o = Object.assign({}, opts || {});
        o.seed = (o.seed == null ? 0 : Number(o.seed)) >>> 0;
        o.bold = clamp(Number(o.bold) || 0, 0, 1);
        const preset = PRESETS.indexOf(id) >= 0 ? id : PRESETS[0];
        const pal = samplePalette(img, 4);
        o.tone = toneFor(analyze(img));
        const sz = sizeFor(img, preset, o.maxEdge);
        const cv = canvasOf(sz.W, sz.H);
        const ctx = cv.getContext('2d');
        paperBase(ctx, sz.W, sz.H, o.tone, o.seed % 97);
        if (preset === 'tear-narrative') renderTear(ctx, img, sz.W, sz.H, pal, o);
        else if (preset === 'ink-bifold') renderBifold(ctx, img, sz.W, sz.H, pal, o);
        else if (preset === 'surreal-pop') renderPop(ctx, img, sz.W, sz.H, pal, o);
        else if (preset === 'ink-sketch') renderSketch(ctx, img, sz.W, sz.H, pal, o);
        else if (preset === 'abstract-distill') renderDistill(ctx, img, sz.W, sz.H, pal, o);
        else renderPenWash(ctx, img, sz.W, sz.H, pal, o);
        printTexture(ctx, sz.W, sz.H, o.tone);
        return { dataUrl: cv.toDataURL('image/png'), W: sz.W, H: sz.H, palette: pal, preset: preset, tone: o.tone };
    }

    return {
        PRESETS, render, samplePalette, analyze, toneFor, toneOf, paperFor, accentOf, inkOf,
        tornPath, tearOffsets, flatReconstruct, sketchPlate, softMask, strokeLayer
    };
});

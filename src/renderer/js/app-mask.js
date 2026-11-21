'use strict';
/* 蒙版调色：线性渐变 / 径向椭圆 / 画笔 / 亮度范围，多蒙版叠加，每个蒙版一套 9 档参数。
 *
 * 设计取舍
 * ─────────────────────────────────────────────────────────────
 * 1) 蒙版只作用于**像素调色**（9 档；曲线/校准/混色器仍是全局）。烘焙顺序：
 *    全局参数烘一次 → 依次「用该蒙版的参数再烘一层 → 按蒙版权重合成」。
 *    这样蒙版的调整天然叠在全局之上（与 PS 调整图层的堆叠语义一致），
 *    而且不用把 9 档参数和曲线/LUT 混进一个函数。
 * 2) 蒙版权重 = 一张灰度画布的 alpha。生成一次（线性/椭圆是渐变，画笔是描边后模糊，
 *    亮度范围读低分辨率像素再放大），合成时用 destination-in 当遮罩，不做逐像素 JS。
 * 3) 编辑期只重绘叠加层、不重烘照片：拖形状时 60fps 跟手，松手才烘一次。
 *    滑块（羽化/浓度/参数）才走实时烘焙。
 * 4) 坐标一律存**照片归一化坐标**（0..1），与缩放/画布尺寸/导出分辨率无关；
 *    叠加层用 engine 记录的 app._photoRect 把指针换算进来。
 */
(function () {
    const TYPES = [
        { k: 'linear', label: '渐变' },
        { k: 'radial', label: '椭圆' },
        { k: 'brush', label: '画笔' },
        { k: 'lum', label: '亮度' },
        { k: 'color', label: '颜色' }
    ];
    const MASK_KEYS = ['exp', 'con', 'sat', 'vib', 'temp', 'tint', 'hi', 'sh', 'white', 'black', 'gam'];
    // 组合模式：new 开一个新的调整层；add/subtract/intersect 并进上一个组。
    const MODES = ['new', 'add', 'subtract', 'intersect'];

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    function smoothstepLocal(a, b, x) {
        if (a === b) return x < a ? 0 : 1;
        const t = clamp01((x - a) / (b - a));
        return t * t * (3 - 2 * t);
    }
    function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

    function defaultMaskParams() {
        const p = {};
        for (const k of MASK_KEYS) p[k] = 0;
        return p;
    }

    function defaultShape(type) {
        if (type === 'linear') return { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.62 };
        // rot：椭圆自身轴的方向（度，0~360）。椭圆虽然 180° 对称，
        // 但直接拖手柄旋转时要把角度存满一圈，否则转过 180° 手柄会瞬移到对角。
        if (type === 'radial') return { cx: 0.5, cy: 0.42, rx: 0.34, ry: 0.28, rot: 0 };
        if (type === 'brush') return { size: 18, strokes: [] };
        if (type === 'color') return { h: 210, tol: 28, minS: 12, sat: 40 };  // 默认选蓝天那类色相
        return { lo: 0, hi: 45 };   // lum：只选亮度 0~45% 的区域
    }

    let _seq = 0;
    function newMask(type) {
        _seq += 1;
        return {
            id: 'mk' + Date.now().toString(36) + _seq,
            type: TYPES.some((t) => t.k === type) ? type : 'linear',
            mode: 'new',        // 新建的蒙版默认是独立调整层（改组合方式见 UI「组合」行）
            on: 1,
            inv: 0,
            feather: type === 'brush' ? 35 : 50,
            density: 100,
            shape: defaultShape(type),
            p: defaultMaskParams()
        };
    }

    function clampSlide(k, v) {
        const fields = (window.App && window.App.GRADE_FIELDS) || [];
        const f = fields.find((x) => x.k === k);
        const lo = f ? f.min : -100, hi = f ? f.max : 100;
        let n = Math.max(lo, Math.min(hi, num(v, 0)));
        if (f && f.step) n = Math.round(n / f.step) * f.step;
        return f && f.step ? Math.round(n * 100) / 100 : Math.round(n);
    }

    function sanitizeMask(m) {
        if (!m || !m.type) return null;
        const type = TYPES.some((t) => t.k === m.type) ? m.type : 'linear';
        const out = {
            id: String(m.id || ('mk' + (++_seq))),
            type,
            mode: MODES.indexOf(m.mode) >= 0 ? m.mode : 'new',
            on: m.on === 0 ? 0 : 1,
            inv: m.inv ? 1 : 0,
            feather: Math.max(0, Math.min(100, Math.round(num(m.feather, 50)))),
            density: Math.max(0, Math.min(100, Math.round(num(m.density, 100)))),
            shape: defaultShape(type),
            p: defaultMaskParams()
        };
        if (type === 'linear' || type === 'radial') {
            const keys = type === 'linear' ? ['x1', 'y1', 'x2', 'y2'] : ['cx', 'cy', 'rx', 'ry'];
            const s = m.shape || {};
            for (const k of keys) out.shape[k] = clamp01(num(s[k], out.shape[k]));
            if (type === 'radial') {
                out.shape.rx = Math.max(0.02, Math.min(1, num(s.rx, out.shape.rx)));
                out.shape.ry = Math.max(0.02, Math.min(1, num(s.ry, out.shape.ry)));
                // 旧草稿没有 rot 字段，缺省 0°（保持原来的水平椭圆）。
                // 存满 0~360：负角/超范围按整圈归一（-30°→330°、999°→279°）。
                // 虽然椭圆 180° 对称，但手柄方向依赖完整角度，不能只留 0~180。
                let r = num(s.rot, 0) % 360;
                if (r < 0) r += 360;
                out.shape.rot = Math.round(r) % 360;
            }
            if (type === 'linear' && Math.abs(out.shape.x2 - out.shape.x1) < 1e-4
                && Math.abs(out.shape.y2 - out.shape.y1) < 1e-4) {
                out.shape.y2 = clamp01(out.shape.y1 + 0.2);
            }
        } else if (type === 'brush') {
            const s = m.shape || {};
            out.shape.size = Math.max(2, Math.min(80, Math.round(num(s.size, 18))));
            out.shape.strokes = [];
            for (const st of (Array.isArray(s.strokes) ? s.strokes : []).slice(0, 400)) {
                if (!st || !Array.isArray(st.pts) || st.pts.length < 2) continue;
                const pts = [];
                for (const pt of st.pts.slice(0, 4000)) {
                    if (!Array.isArray(pt) || pt.length < 2) continue;
                    pts.push([clamp01(num(pt[0], 0)), clamp01(num(pt[1], 0))]);
                }
                if (pts.length >= 2) {
                    out.shape.strokes.push({
                        size: Math.max(2, Math.min(80, Math.round(num(st.size, out.shape.size)))),
                        erase: st.erase ? 1 : 0,
                        pts
                    });
                }
            }
        } else if (type === 'color') {
            const s = m.shape || {};
            out.shape.h = ((Math.round(num(s.h, 210)) % 360) + 360) % 360;
            out.shape.tol = Math.max(3, Math.min(90, Math.round(num(s.tol, 28))));
            out.shape.minS = Math.max(0, Math.min(90, Math.round(num(s.minS, 12))));
        } else {
            const s = m.shape || {};
            const lo = Math.max(0, Math.min(90, Math.round(num(s.lo, 0))));
            const hi = Math.max(lo + 5, Math.min(100, Math.round(num(s.hi, 45))));
            out.shape.lo = lo;
            out.shape.hi = hi;
        }
        const src = m.p || {};
        for (const k of MASK_KEYS) out.p[k] = clampSlide(k, src[k]);
        return out;
    }

    function sanitizeMasks(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const m of list.slice(0, 12)) {
            const s = sanitizeMask(m);
            if (s) out.push(s);
        }
        return out;
    }

    // 有参数才算「会改变画面」；只画了形状没调参数时不必重烘（但叠加层照常可编辑）
    function maskHasParams(m) {
        if (!m || !m.p) return false;
        for (const k of MASK_KEYS) if (Number(m.p[k]) || 0) return true;
        return false;
    }

    // ── 组合模式：一个「组」= 一个 new 蒙版 + 后续 add/subtract/intersect ──
    // 同一组共用组首的参数、共用一条烘焙层 —— 这就是「修边缘不用重画」的实现：
    // 加一个「减去」蒙版只改生效范围，参数的归属不变。
    function maskGroups(list) {
        const out = [];
        for (const m of (Array.isArray(list) ? list : [])) {
            if (!m) continue;
            const mode = (m.mode && m.mode !== 'new' && out.length) ? m.mode : 'new';
            if (mode === 'new') out.push({ head: m, members: [m] });
            else out[out.length - 1].members.push(m);
        }
        return out;
    }

    // 组合后的权重画布：按 mode 依次合并（add 取并集、subtract 挖掉、intersect 取交集）
    function groupAlpha(group, w, h, src, opts) {
        const members = group.members || [group.head];
        let acc = render(group.head, w, h, src, opts);
        for (let i = 1; i < members.length; i++) {
            const m = members[i];
            if (m.on === 0) continue;
            const a = render(m, w, h, src, opts);
            const c = newCanvas(w, h);
            const g = c.getContext('2d');
            if (!g) return acc;
            g.drawImage(acc, 0, 0);
            // destination-out：α乘(1−srcA) —— 正是「减去」；
            // destination-in：α乘srcA —— 正是「相交」；
            // lighter：α 相加（重叠处封顶 1）—— 比 max 更明确，且能保住软边。
            g.globalCompositeOperation = m.mode === 'subtract' ? 'destination-out'
                : m.mode === 'intersect' ? 'destination-in' : 'lighter';
            g.drawImage(a, 0, 0);
            acc = c;
        }
        return acc;
    }

    // 需要参与烘焙的组：组头本身有非零参数（组内成员只改范围，不产生新调整层）
    function activeGroups(list) {
        return maskGroups(list).filter((g) => g.head && g.head.on !== 0 && maskHasParams(g.head));
    }

    // 组的签名：组头参数 + 每个成员的形状/组合方式。
    // 组内任何成员改了形状都要触发重烘，所以不能只用 maskSignature(head)。
    function groupSignature(g) {
        return g.members.map((m) => maskSignature(m)).join('>');
    }

    function activeMasks(list) {
        return activeGroups(list).map((g) => g.head);
    }

    // 画笔笔迹的紧凑指纹：把每个点折成一个整数再滚进 32 位哈希。
    // 以前是把每个点 toFixed(3) 拼成字符串（400 描边 × 4000 点 = 160 万个
    // 浮点字符串），每次 input 都要构造并比较 MB 级字符串 —— 成本比它保护的
    // 那次烘焙还高。改成哈希后无论多少点都是常数级。
    //
    // 精度取 1/1000（与原 toFixed(3) 一致），所以「同一笔迹 → 同一指纹」不变，
    // 缓存失效的时机与以前完全相同。
    function brushFingerprint(strokes) {
        let h = 0x811c9dc5 >>> 0;
        let pts = 0;
        const mix = (n) => {
            h ^= (n >>> 0) & 0xffffffff;
            h = Math.imul(h, 0x01000193) >>> 0;
        };
        for (const st of strokes || []) {
            mix(st.erase ? 1 : 2);
            mix(Math.round(st.size * 1000));
            const p = st.pts || [];
            pts += p.length;
            for (let i = 0; i < p.length; i++) {
                // 定点化到 1/1000：和 toFixed(3) 同一个量化口径
                mix(Math.round(p[i][0] * 1000));
                mix(Math.round(p[i][1] * 1000));
            }
            mix(0xffff);   // 一笔结束的分隔，避免相邻两笔的点串味
        }
        // 带上点数：哈希撞了也不会误判「没变」（点数变了必然要重烘）
        return h.toString(36) + ':' + ((strokes || []).length) + ':' + pts;
    }

    function maskSignature(m) {
        const s = m.shape || {};
        const base = [m.type, m.mode || 'new', m.on, m.inv, m.feather, m.density,
            MASK_KEYS.map((k) => m.p ? m.p[k] : 0).join(',')];
        if (m.type === 'brush') {
            base.push(s.size, brushFingerprint(s.strokes));
        } else if (m.type === 'lum') {
            base.push(s.lo, s.hi);
        } else if (m.type === 'color') {
            base.push(s.h, s.tol, s.minS);
        } else {
            // rot 必须进签名：否则改方向不会让蒙版缓存失效，画面还按旧朝向合成
            base.push(s.x1, s.y1, s.x2, s.y2, s.cx, s.cy, s.rx, s.ry, s.rot);
        }
        return base.join('|');
    }

    // ── 蒙版权重画布（alpha 即权重） ─────────────────────────────
    function newCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        return c;
    }

    function fillGradient(g, w, h, m) {
        const s = m.shape;
        const f = Math.max(0.001, m.feather / 100);
        const x1 = s.x1 * w, y1 = s.y1 * h, x2 = s.x2 * w, y2 = s.y2 * h;
        const grad = g.createLinearGradient(x1, y1, x2, y2);
        const a = clamp01(0.5 - f / 2), b = clamp01(0.5 + f / 2);
        // 权重必须体现在 **alpha** 上（合成时走 destination-in）：
        // 用黑色填充 alpha 仍是 1，会把整张图都当蒙版内。
        const clear = 'rgba(255,255,255,0)';
        const solid = 'rgba(255,255,255,1)';
        const c0 = m.inv ? solid : clear;
        const c1 = m.inv ? clear : solid;
        grad.addColorStop(0, c0);
        grad.addColorStop(a, c0);
        grad.addColorStop(b, c1);
        grad.addColorStop(1, c1);
        g.fillStyle = grad;
        g.fillRect(0, 0, w, h);
    }

    /* 椭圆羽化的「满作用区」半径（单位圆坐标 0..1）：
       r <= inner 是满权重，inner..1 是过渡带，外面完全不作用。
       生成遮罩、叠加层染色、内圈轮廓线三处必须共用同一个值 ——
       各写一份 1-f 的话，将来改了一处，画出来的线就会骗人。 */
    function radialInner(m) {
        const f = Math.max(0.001, num(m && m.feather, 50) / 100);
        return Math.max(0, 1 - f);
    }

    function fillRadial(g, w, h, m) {
        const s = m.shape;
        const inner = radialInner(m);
        const cx = s.cx * w, cy = s.cy * h;
        const rx = Math.max(0.01, s.rx) * w, ry = Math.max(0.01, s.ry) * h;
        // 方向：与叠加层同一套「像素空间绕中心旋转」，两边角度自然一致
        const rot = (num(s.rot, 0) || 0) * Math.PI / 180;
        g.save();
        g.translate(cx, cy);
        if (rot) g.rotate(rot);
        g.scale(rx, ry);
        const grad = g.createRadialGradient(0, 0, inner, 0, 0, 1);
        if (m.inv) {
            // 反相椭圆 = 椭圆外全权重、椭圆内按羽化挖空。
            // 不能只把渐变颜色反过来再填椭圆内部：椭圆外仍是 alpha 0，
            // 结果“反相”只反了里面，外面一点没选中（用户看到的就是反相没效果）。
            g.restore();
            g.fillStyle = 'rgba(255,255,255,1)';
            g.fillRect(0, 0, w, h);
            g.save();
            g.translate(cx, cy);
            if (rot) g.rotate(rot);
            g.scale(rx, ry);
            const cut = g.createRadialGradient(0, 0, inner, 0, 0, 1);
            cut.addColorStop(0, 'rgba(255,255,255,1)');
            cut.addColorStop(1, 'rgba(255,255,255,0)');
            g.globalCompositeOperation = 'destination-out';
            g.fillStyle = cut;
            g.beginPath();
            g.arc(0, 0, 1.02, 0, Math.PI * 2);
            g.fill();
            g.restore();
            return;
        }
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(0, 0, 1.02, 0, Math.PI * 2);
        g.fill();
        g.restore();
    }

    // 画笔 = 若干条描边 + 羽化模糊。擦除用 destination-out，保证「先涂后擦」的顺序语义。
    function fillBrush(g, w, h, m, out) {
        const strokes = (m.shape.strokes || []);
        const short = Math.min(w, h);
        const draw = (ctx2, blurPx) => {
            for (const st of strokes) {
                const lw = Math.max(1, (st.size / 100) * short);
                ctx2.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
                ctx2.strokeStyle = '#fff';
                ctx2.fillStyle = '#fff';
                ctx2.lineWidth = lw;
                ctx2.lineCap = 'round';
                ctx2.lineJoin = 'round';
                const pts = st.pts;
                if (pts.length === 1) {
                    ctx2.beginPath();
                    ctx2.arc(pts[0][0] * w, pts[0][1] * h, lw / 2, 0, Math.PI * 2);
                    ctx2.fill();
                    continue;
                }
                ctx2.beginPath();
                ctx2.moveTo(pts[0][0] * w, pts[0][1] * h);
                for (let i = 1; i < pts.length; i++) ctx2.lineTo(pts[i][0] * w, pts[i][1] * h);
                ctx2.stroke();
            }
            void blurPx;
        };
        // 硬度由羽化控制：羽化越大边缘越糊。先画在临时层，再带模糊合成到目标层
        const tmp = newCanvas(w, h);
        const tg = tmp.getContext('2d');
        draw(tg, 0);
        const blur = (m.feather / 100) * Math.max(1, (m.shape.size / 100) * short) * 0.6;
        g.save();
        if (blur > 0.4) g.filter = 'blur(' + blur.toFixed(2) + 'px)';
        g.drawImage(tmp, 0, 0);
        g.filter = 'none';
        g.restore();
        if (m.inv) {
            // 反相：把当前 alpha 反过来（白色铺底后挖掉已有的）
            const inv = newCanvas(w, h);
            const ig = inv.getContext('2d');
            ig.fillStyle = '#fff';
            ig.fillRect(0, 0, w, h);
            ig.globalCompositeOperation = 'destination-out';
            ig.drawImage(out, 0, 0);
            g.save();
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, w, h);
            g.drawImage(inv, 0, 0);
            g.restore();
        }
    }

    function fillLuma(g, w, h, m, src) {
        const s = m.shape;
        // 低分辨率采样再放大：亮度蒙版本身就是软过渡，320px 足够，逐像素成本可控
        const tw = Math.max(32, Math.min(320, Math.round(w / 4)));
        const th = Math.max(1, Math.round(tw * h / w));
        const small = newCanvas(tw, th);
        const sg = small.getContext('2d');
        try { sg.drawImage(src, 0, 0, tw, th); } catch (_) { /* 源不可用时留空 */ }
        let data;
        try { data = sg.getImageData(0, 0, tw, th); } catch (_) { return; }
        const d = data.data;
        const lo = s.lo / 100, hi = s.hi / 100;
        // 羽化以前对亮度蒙版完全无效（soft 固定 35%），滑块拖了画面不动。
        // 现在按羽化控制阈值两侧的过渡带宽：0 = 硬边，100 = 很软的过渡；
        // 50 仍是原来的 35%，老草稿/测试的观感不变。
        const feather = Math.max(0, Math.min(100, Number(m.feather) || 0)) / 100;
        const soft = Math.max(0.001, (hi - lo) * (0.001 + 0.7 * feather));
        for (let i = 0; i < d.length; i += 4) {
            const y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
            let v = 0;
            if (y >= lo && y <= hi) {
                const a = Math.min(1, (y - lo) / soft);
                const b = Math.min(1, (hi - y) / soft);
                v = Math.min(a, b);
            }
            let a8 = Math.round(clamp01(v) * 255);
            if (m.inv) a8 = 255 - a8;
            d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = a8;
        }
        sg.putImageData(data, 0, 0);
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(small, 0, 0, w, h);
    }

    // 颜色蒙版：按「色相 + 最低饱和度」选区（PS/LR 的颜色范围最常用的一半）。
    // 与亮度蒙版同一条路子：320px 低分辨率算权重再放大，软过渡、成本可控。
    function fillColor(g, w, h, m, src) {
        const s = m.shape;
        const tw = Math.max(32, Math.min(320, Math.round(w / 4)));
        const th = Math.max(1, Math.round(tw * h / w));
        const small = newCanvas(tw, th);
        const sg = small.getContext('2d');
        try { sg.drawImage(src, 0, 0, tw, th); } catch (_) { /* 源不可用时留空 */ }
        let data;
        try { data = sg.getImageData(0, 0, tw, th); } catch (_) { return; }
        const d = data.data;
        const target = ((Number(s.h) || 0) % 360 + 360) % 360;
        const tol = Math.max(3, Number(s.tol) || 28);
        const minS = Math.max(0, Number(s.minS) || 0) / 100;
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
            const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), dd = mx - mn;
            let hue = 0;
            if (dd > 1e-6) {
                if (mx === r) hue = (((gg - b) / dd) % 6 + 6) % 6;
                else if (mx === gg) hue = (b - r) / dd + 2;
                else hue = (r - gg) / dd + 4;
                hue *= 60;
            }
            const sat = mx > 1e-6 ? dd / mx : 0;
            let dh = Math.abs(hue - target);
            if (dh > 180) dh = 360 - dh;
            // 色相：容差内满权重，到容差 1.6 倍处完全归零（软边）
            let v = 1 - smoothstepLocal(tol * 0.45, tol * 1.6, dh);
            // 饱和度门槛：灰/近白黑没有色相可言，必须挡掉，否则整片灰底被选中
            v *= smoothstepLocal(minS * 0.35, Math.max(minS * 0.35 + 0.06, minS * 1.15), sat);
            // 极暗/极亮也挡一下：那里色相不稳定
            v *= smoothstepLocal(0.02, 0.10, mx);
            let a8 = Math.round(clamp01(v) * 255);
            if (m.inv) a8 = 255 - a8;
            d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = a8;
        }
        sg.putImageData(data, 0, 0);
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        const blur = (m.feather / 100) * Math.min(w, h) * 0.02;
        if (blur > 0.4) g.filter = 'blur(' + blur.toFixed(2) + 'px)';
        g.drawImage(small, 0, 0, w, h);
        g.filter = 'none';
    }

    // 生成蒙版 alpha 画布（w×h 与烘焙图层一致）
    // opts.rawAlpha：忽略浓度，返回「纯范围」。叠加层只表示范围，不表示强度，
    // 否则把浓度调低后绿色范围跟着变淡/消失，看起来像蒙版自己缩小了。
    function render(m, w, h, src, opts) {
        const out = newCanvas(w, h);
        const g = out.getContext('2d');
        if (!g) return out;
        if (m.type === 'linear') fillGradient(g, out.width, out.height, m);
        else if (m.type === 'radial') fillRadial(g, out.width, out.height, m);
        else if (m.type === 'brush') fillBrush(g, out.width, out.height, m, out);
        else if (m.type === 'color') fillColor(g, out.width, out.height, m, src);
        else fillLuma(g, out.width, out.height, m, src);
        // 浓度：整体压权重（100 不动、0 完全无效）
        const dens = (opts && opts.rawAlpha) ? 1
            : Math.max(0, Math.min(100, m.density != null ? m.density : 100)) / 100;
        if (dens < 1) {
            const scaled = newCanvas(out.width, out.height);
            const sg = scaled.getContext('2d');
            sg.globalAlpha = dens;
            sg.drawImage(out, 0, 0);
            return scaled;
        }
        return out;
    }

    // base 打底，把 layer 按 alpha 的权重叠上去
    function composite(base, layer, alpha) {
        const w = base.width, h = base.height;
        const out = newCanvas(w, h);
        const g = out.getContext('2d');
        g.drawImage(base, 0, 0);
        const tmp = newCanvas(w, h);
        const t = tmp.getContext('2d');
        t.drawImage(layer, 0, 0);
        t.globalCompositeOperation = 'destination-in';
        t.drawImage(alpha, 0, 0);
        g.drawImage(tmp, 0, 0);
        return out;
    }

    window.QfsMask = {
        TYPES, MODES, MASK_KEYS, newMask, defaultMaskParams, sanitizeMasks, sanitizeMask,
        maskHasParams, activeMasks, maskSignature, render, composite,
        maskGroups, groupAlpha, activeGroups, groupSignature, radialInner
    };
})();

/* ── 面板与画布叠加层 ─────────────────────────────────────────── */
(function () {
    const $ = (id) => document.getElementById(id);
    const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));

    function overlayEl() { return $('maskOverlay'); }

    /* 把椭圆锁成「屏幕上的正圆」。rx/ry 各自归一化到照片宽/高，宽图上直接令
       rx===ry 反而是个横椭圆，必须先换算回像素。取较大的那根轴，避免按 Shift
       的瞬间椭圆突然缩小（与 PS/LR 的 Shift 约束同手感）。 */
    function roundRadial(m, pr) {
        if (!pr) return;
        const pw = Math.max(1, pr.w), ph = Math.max(1, pr.h);
        const Rx = Math.max(0.01, m.shape.rx) * pw;
        const Ry = Math.max(0.01, m.shape.ry) * ph;
        const R = Math.max(Rx, Ry);
        m.shape.rx = Math.max(0.02, Math.min(1, R / pw));
        m.shape.ry = Math.max(0.02, Math.min(1, R / ph));
    }

    // 眼睛图标用内联 SVG 构造，避免 innerHTML（蒙版列表可能来自草稿/工程文件）。
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function eyeIcon(off) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('class', 'mask-eye-svg');
        svg.setAttribute('aria-hidden', 'true');
        const outline = document.createElementNS(SVG_NS, 'path');
        outline.setAttribute('d', 'M1.3 8s2.5-4.3 6.7-4.3S14.7 8 14.7 8s-2.5 4.3-6.7 4.3S1.3 8 1.3 8Z');
        outline.setAttribute('fill', 'none');
        outline.setAttribute('stroke', 'currentColor');
        outline.setAttribute('stroke-width', '1.3');
        outline.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(outline);
        const pupil = document.createElementNS(SVG_NS, 'circle');
        pupil.setAttribute('cx', '8');
        pupil.setAttribute('cy', '8');
        pupil.setAttribute('r', '2.1');
        pupil.setAttribute('fill', off ? 'none' : 'currentColor');
        pupil.setAttribute('stroke', 'currentColor');
        pupil.setAttribute('stroke-width', '1.2');
        svg.appendChild(pupil);
        if (off) {
            const slash = document.createElementNS(SVG_NS, 'line');
            slash.setAttribute('x1', '2.2'); slash.setAttribute('y1', '13.8');
            slash.setAttribute('x2', '13.8'); slash.setAttribute('y2', '2.2');
            slash.setAttribute('stroke', 'currentColor');
            slash.setAttribute('stroke-width', '1.5');
            slash.setAttribute('stroke-linecap', 'round');
            svg.appendChild(slash);
        }
        return svg;
    }

    Object.assign(window.App || (window.App = {}), {
        _activeMaskId: null,
        _maskClip: null,        // 单蒙版剪贴板（只走内存，不碰系统剪贴板）
        _maskBrushPos: null,    // 画笔光标圈最后所在的 client 坐标
        _maskRotHover: false,   // 指针是否停在旋转手柄上（叠加层画高亮用）
        // 蒙版「原图预览」：亮度/颜色蒙版选区依赖像素内容，暂时隐藏调色看原图更好选。
        // _previewUseOriginal 只在主预览渲染的一帧内为 true（见 app-render.js / photoSrcOf）。
        _maskPreviewOriginal: false,
        _previewUseOriginal: false,

        masksOf(im) {
            const g = (im || this.image || {}).grade;
            return (g && Array.isArray(g.masks)) ? g.masks : [];
        },

        activeMask(im) {
            const list = this.masksOf(im);
            if (!this._activeMaskId) return null;
            for (const m of list) if (m.id === this._activeMaskId) return m;
            return null;
        },

        /* 参数归属：组合模式下一组共用组首的 p，所以滑块要读写组首。
           选中的可能是 add/subtract/intersect 成员，它的 p 只是占位。 */
        paramMask(im) {
            const act = this.activeMask(im);
            if (!act) return null;
            for (const g of window.QfsMask.maskGroups(this.masksOf(im))) {
                if (g.members.indexOf(act) >= 0) return g.head;
            }
            return act;
        },

        /* 当前选中蒙版所在的组（叠加层要显示组合后的范围） */
        activeGroup(im) {
            const act = this.activeMask(im);
            if (!act) return null;
            for (const g of window.QfsMask.maskGroups(this.masksOf(im))) {
                if (g.members.indexOf(act) >= 0) return g;
            }
            return null;
        },

        /* 当前选中蒙版所在组是否被整体停用（组首 on=0）。
           停用的组不参与烘焙，叠加层/原图预览/画笔光标也都不该出现。 */
        activeGroupDisabled(im) {
            const act = this.activeMask(im);
            if (!act || act.on === 0) return true;
            const grp = this.activeGroup(im);
            return !!(grp && grp.head && grp.head.on === 0);
        },

        /* 改组合方式：把某个成员设成 new/add/subtract/intersect。
           设成 new 会把它拆成独立的组（它自己的 p 立刻生效）。 */
        setMaskMode(id, mode) {
            const im = this.image;
            if (!im) return false;
            const list = this.masksOf(im);
            const m = list.find((x) => x.id === id);
            if (!m) return false;
            if (window.QfsMask.MODES.indexOf(mode) < 0) return false;
            const idx = list.indexOf(m);
            m.mode = (idx === 0 && mode !== 'new') ? 'new' : mode;   // 第一个只能是 new
            this.setGrade({ masks: list });
            this.setActiveMask(id);
            return true;
        },

        setActiveMask(id) {
            const list = this.masksOf(this.image);
            this._activeMaskId = (id && list.some((m) => m.id === id)) ? id : null;
            // 原图预览只服务亮度/颜色蒙版：切到别的蒙版或取消选中时恢复调色画面
            const act = this.activeMask(this.image);
            if (this._maskPreviewOriginal && (!act || (act.type !== 'lum' && act.type !== 'color'))) {
                this.setMaskOriginalPreview(false);
            }
            if (this.syncGradeUI) this.syncGradeUI();
            if (this.syncMaskUI) this.syncMaskUI();
            this.drawMaskOverlay();
            this._syncMaskOrigHint();
            return true;
        },

        /* 蒙版「原图预览」：把照片源临时换成未调色的 im.el（模板/边框/文字全部保留），
           让亮度/颜色蒙版在原图上选区。与「对比原图」旁路不同 —— 那个会去掉边框只画照片，
           这里不动布局，蒙版叠加层的几何也完全不变。
           切换时先抓一帧旧画面淡出，避免「啪」一下换图被误认为调色丢了。 */
        setMaskOriginalPreview(on, opts) {
            on = !!on;
            const act = this.activeMask(this.image);
            if (on && (!act || (act.type !== 'lum' && act.type !== 'color')
                || this.activeGroupDisabled(this.image))) on = false;
            if (this._maskPreviewOriginal === on) { this._syncMaskOrigHint(); return; }
            const snap = (opts && opts.instant) ? null : this._snapshotPreviewCanvas();
            this._maskPreviewOriginal = on;
            // 画面换成了未调色的原图：警示是按调色后像素算的，留着会指错地方
            if (window.QfsClip) window.QfsClip.setSuppressed();
            // 预览换的是渲染源：拖影/元素拖动缓存必须作废，否则下一帧可能拷到旧背景
            if (this._dropDragBase) this._dropDragBase();
            if (this.scheduleRender) this.scheduleRender(true);
            this._syncMaskOrigHint();
            if (snap) this._fadeSnapshot(snap);
        },

        _syncMaskOrigHint() {
            const act = this.activeMask(this.image);
            const on = !!this._maskPreviewOriginal && !!this.image && !!act
                && (act.type === 'lum' || act.type === 'color')
                && !this.activeGroupDisabled(this.image);
            const hint = document.getElementById('maskOrigHint');
            if (hint) hint.hidden = !on;
            const cb = document.getElementById('cbMaskViewOrig');
            if (cb && cb.checked !== on) cb.checked = on;
        },

        /* 切换源前抓一张当前画布：新帧渲染后由 _fadeSnapshot 淡出。
           快照贴在 stage 里、z-index 低于蒙版叠加层，所以过渡期间绿色范围仍可见。 */
        _snapshotPreviewCanvas() {
            const cv = this.dom && this.dom.canvas;
            const stage = this.dom && this.dom.stage;
            if (!cv || !stage || !cv.width || !cv.height) return null;
            try {
                const cr = cv.getBoundingClientRect();
                const sr = stage.getBoundingClientRect();
                if (!cr.width || !cr.height) return null;
                const dpr = Math.min(2, window.devicePixelRatio || 1);
                const snap = document.createElement('canvas');
                snap.className = 'mask-swap-fade';
                snap.width = Math.max(1, Math.round(cr.width * dpr));
                snap.height = Math.max(1, Math.round(cr.height * dpr));
                // 绝对定位的参照是 stage 的 padding box，要扣掉边框宽度（与 syncOverlayGeometry 一致）
                snap.style.left = (cr.left - sr.left - (stage.clientLeft || 0)) + 'px';
                snap.style.top = (cr.top - sr.top - (stage.clientTop || 0)) + 'px';
                snap.style.width = cr.width + 'px';
                snap.style.height = cr.height + 'px';
                const g = snap.getContext('2d');
                if (!g) return null;
                g.drawImage(cv, 0, 0, snap.width, snap.height);
                // 同一时刻只留一张：连续切换不会叠出多层残影
                if (this._maskFadeEl && this._maskFadeEl.parentNode) {
                    this._maskFadeEl.parentNode.removeChild(this._maskFadeEl);
                }
                stage.appendChild(snap);
                this._maskFadeEl = snap;
                return snap;
            } catch (_) { return null; }
        },

        _fadeSnapshot(snap) {
            if (!snap) return;
            // 等两帧让新画面先渲染，再开始淡出；否则可能先淡出、后换帧，闪一下旧图
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (snap.parentNode) snap.classList.add('is-out');
            }));
            setTimeout(() => {
                if (snap.parentNode) snap.parentNode.removeChild(snap);
                if (this._maskFadeEl === snap) this._maskFadeEl = null;
            }, 280);
        },

        // 只要渲染管线上报了「照片在画布上的矩形」，叠加层就能把指针换算成照片内坐标。
        // 默认图层、相框、卡片三条管线现在都会写 app._photoRect（见 engine.js / engine-styles.js），
        // 因此这里只看矩形在不在 —— 它就是「能不能在画布上拖蒙版」的唯一真相。
        maskPositionSupported() {
            return !!this._photoRect;
        },

        addMask(type) {
            const im = this.image;
            if (!im) return false;
            const p = this.gradeOf(im);
            // 与 sanitizeMasks 的上限一致：超过 12 个会被静默截掉，用户以为
            // 「刚加的蒙版没保存」。这里先挡住并说明原因。
            if ((p.masks || []).length >= 12) {
                this.setStatus('最多 12 个蒙版，先删掉不用的再添加');
                return false;
            }
            const m = window.QfsMask.newMask(type);
            const masks = (p.masks || []).concat([m]);
            this._activeMaskId = m.id;
            // 亮度/颜色蒙版的选区由像素内容决定：自动进入「原图预览」，方便看原图选范围。
            // 还没调过色时切了也一模一样，不切（避免出现无意义的提示）。
            // 没有 _grade 槽位 = 还没调过色（不能把 undefined 当成「非中性」）
            const neutral = !im._grade || im._grade.neutral;
            const wantOrig = (type === 'lum' || type === 'color') && !neutral;
            const changed = wantOrig !== !!this._maskPreviewOriginal;
            const snap = changed ? this._snapshotPreviewCanvas() : null;
            this._maskPreviewOriginal = wantOrig;
            this.setGrade({ masks });
            this._syncMaskOrigHint();
            if (snap) this._fadeSnapshot(snap);
            const label = (window.QfsMask.TYPES.find((t) => t.k === type) || {}).label;
            this.setStatus('已添加' + label + '蒙版'
                + (this.maskPositionSupported() ? '' : '；画布还在准备，稍等片刻再拖动'));
            return true;
        },

        removeMask(id) {
            const im = this.image;
            if (!im) return false;
            const p = this.gradeOf(im);
            const masks = (p.masks || []).filter((m) => m.id !== id);
            if (this._activeMaskId === id) this._activeMaskId = masks.length ? masks[masks.length - 1].id : null;
            // 删掉后如果选中的不再是亮度/颜色蒙版，先退出原图预览，再渲染
            const act = this.activeMask(im);
            if (this._maskPreviewOriginal && (!act || (act.type !== 'lum' && act.type !== 'color'))) {
                this._maskPreviewOriginal = false;
                this._syncMaskOrigHint();
            }
            this.setGrade({ masks });
            this.setStatus('已删除蒙版');
            return true;
        },

        /* 眼睛开关：on=0 的蒙版参数/形状都保留，只是不参与烘焙。
           组首被关掉 = 整个组合（含 add/subtract/intersect 成员）一起停用。 */
        toggleMask(id) {
            const im = this.image;
            if (!im) return false;
            const list = this.masksOf(im);
            const m = list.find((x) => x.id === id);
            if (!m) return false;
            const next = m.on === 0 ? 1 : 0;
            m.on = next;
            // 停用整个组时，亮度/颜色蒙版的「查看原图」必须退出：
            // 否则调色一直藏着，用户会以为停用把调色也弄丢了。
            if (!next) {
                const grp = this.activeGroup(im);
                if (grp && grp.head === m && this._maskPreviewOriginal) this._maskPreviewOriginal = false;
            }
            this.setGrade({ masks: list });
            this.setStatus(next ? '已启用蒙版' : '已停用蒙版（参数保留）');
            return true;
        },

        /* 单蒙版剪贴板：形状 + 组首参数。复制组合成员时带组首参数，
           粘到别的照片才是一块能独立生效的蒙版，而不是一组零参数的补丁。 */
        copyMask() {
            const im = this.image;
            const m = this.activeMask(im);
            if (!im || !m) {
                this.setStatus('先选中一个蒙版再复制');
                return false;
            }
            const head = this.paramMask(im) || m;
            this._maskClip = {
                type: m.type,
                mode: m.mode || 'new',
                inv: m.inv ? 1 : 0,
                feather: m.feather,
                density: m.density,
                shape: JSON.parse(JSON.stringify(m.shape || {})),
                p: JSON.parse(JSON.stringify(head.p || {})),
                anchorId: m.id,
                image: im
            };
            this.setStatus('已复制蒙版');
            this.syncMaskUI();
            return true;
        },

        /* 粘贴成新蒙版：
           · 粘到别的照片 → 独立调整层（组合成员也拆成 new，参数用组首那套）；
           · 在同一张照片里复制组合成员 → 保留 add/subtract/intersect，
             插在原成员后面，方便就地改形状扩一块。
           剪贴板里不存 on：粘出来一律启用，停用的蒙版拿去复用看起来像粘贴失败。 */
        pasteMask() {
            const im = this.image;
            if (!im) return false;
            const clip = this._maskClip;
            if (!clip) {
                this.setStatus('剪贴板里还没有蒙版，先复制一个');
                return false;
            }
            const list = this.masksOf(im);
            if (list.length >= 12) {
                this.setStatus('最多 12 个蒙版，先删掉不用的再粘贴');
                return false;
            }
            const sameImage = clip.image === im;
            const anchorIdx = sameImage ? list.findIndex((x) => x.id === clip.anchorId) : -1;
            const keepMode = anchorIdx >= 0 && clip.mode && clip.mode !== 'new';
            const fresh = window.QfsMask.newMask(clip.type);
            const clean = window.QfsMask.sanitizeMask(Object.assign({}, clip, {
                id: fresh.id,
                mode: keepMode ? clip.mode : 'new',
                on: 1,
                shape: JSON.parse(JSON.stringify(clip.shape || {}))
            }));
            if (!clean) {
                this.setStatus('粘贴失败：蒙版数据无效');
                return false;
            }
            const masks = list.slice();
            if (keepMode) masks.splice(anchorIdx + 1, 0, clean);
            else masks.push(clean);
            this._activeMaskId = clean.id;
            // 新蒙版不是亮度/颜色时，原图预览必须收回，否则画面会一直停在未调色源上
            if (this._maskPreviewOriginal && clean.type !== 'lum' && clean.type !== 'color') {
                this._maskPreviewOriginal = false;
            }
            this.setGrade({ masks });
            this.setStatus(keepMode ? '已粘贴蒙版（并入原组合）' : '已粘贴蒙版（独立调整层）');
            return true;
        },

        /* 蒙版形状改了：叠加层立刻重画，照片等松手再烘（拖动期不烘焙=跟手） */
        commitMaskShape(reason) {
            const im = this.image;
            if (!im) return;
            if (this.invalidateGrade) this.invalidateGrade(im);
            // 拖动/滑块 input 期只烘低分辨率，保证跟手；松手（full）再补全分辨率。
            // 以前 'live' 也走 full，羽化/浓度每动一格都全图重算，大图上会明显卡顿。
            if (this.rebuildGrade) this.rebuildGrade(reason === 'full' ? 'full' : 'low');
            if (this.scheduleRender) this.scheduleRender(true);
            if (this.scheduleDraft) this.scheduleDraft();
        },

        /* 叠加层几何与缩放同步（canvas 的 CSS 尺寸/位移变化时调用） */
        // 画布基准坐标宽高（模板/照片矩形用的那套单位）
        _baseSize() {
            const cv = this.dom && this.dom.canvas;
            if (!cv) return { w: 1, h: 1 };
            if (this._canvasBaseW && this._canvasBaseH) return { w: this._canvasBaseW, h: this._canvasBaseH };
            const sc = this._canvasScale || 1;
            return { w: Math.max(1, (cv._logW || cv.width) / sc),
                     h: Math.max(1, (cv._logH || cv.height) / sc) };
        },

        /* 叠加层几何：直接按画布的**视觉矩形**摆放。
           以前是复制 canvas.style.width 与 transform —— 只要有一条改样式的路径没走到
           applyZoomStyle（导出临时放大、窗口/侧栏变化、fit 重算），两边就会不同步，
           蒙版范围看起来就"跑位"了。现在每次都读真实矩形，不存在第二个真相。 */
        syncOverlayGeometry() {
            const ov = overlayEl();
            const cv = this.dom && this.dom.canvas;
            if (!ov || !cv) return;
            const host = ov.parentElement;
            const cr = cv.getBoundingClientRect();
            const hr = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
            const bl = host ? host.clientLeft : 0;
            const bt = host ? host.clientTop : 0;
            const cssW = Math.max(1, cr.width);
            const cssH = Math.max(1, cr.height);
            ov.style.left = (cr.left - hr.left - bl) + 'px';
            ov.style.top = (cr.top - hr.top - bt) + 'px';
            ov.style.right = 'auto';
            ov.style.bottom = 'auto';
            ov.style.margin = '0';
            ov.style.width = cssW + 'px';
            ov.style.height = cssH + 'px';
            ov.style.transform = 'none';
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const bw = Math.max(1, Math.round(cssW * dpr));
            const bh = Math.max(1, Math.round(cssH * dpr));
            // 画布视觉尺寸变了（缩放/窗口/侧栏），光圈的位置和直径立刻失效，
            // 先收掉，等下一次 pointermove 按新矩形重新算。
            if (ov.width !== bw || ov.height !== bh) {
                ov.width = bw; ov.height = bh;
                this._hideBrushCursor(true);
            }
        },

        /* 画笔光标圈：用一个绝对定位的 DOM 圆环跟随指针。
           不画在叠加层画布上 —— 那样每次 pointermove 都要重画整张蒙版光栅
           （亮度/颜色蒙版还有逐像素采样），仅为了一根光标不值得。 */
        _hideBrushCursor(keepPos) {
            const el = $('maskBrushCursor');
            if (el) el.hidden = true;
            if (!keepPos) this._maskBrushPos = null;
        },

        _updateBrushCursor(e) {
            const el = $('maskBrushCursor');
            if (!el) return;
            const im = this.image;
            const m = this.activeMask(im);
            if (!im || !m || m.type !== 'brush' || this.activeGroupDisabled(im)) {
                this._hideBrushCursor();
                return;
            }
            const x = Number(e && e.clientX), y = Number(e && e.clientY);
            if (!Number.isFinite(x) || !Number.isFinite(y)) { this._hideBrushCursor(); return; }
            const ov = overlayEl();
            const pr = this._photoRect;
            if (!ov || !pr) { this._hideBrushCursor(); return; }
            const r = ov.getBoundingClientRect();
            if (!(r.width > 0) || !(r.height > 0)) { this._hideBrushCursor(); return; }
            const base = this._baseSize();
            const bw = Math.max(1, base.w), bh = Math.max(1, base.h);
            const bx = (x - r.left) / r.width * bw;
            const by = (y - r.top) / r.height * bh;
            // 指针在照片外（画布留白/相框区域）不显示，避免暗示笔刷会落到照片外
            if (bx < pr.x || bx > pr.x + pr.w || by < pr.y || by > pr.y + pr.h) {
                this._hideBrushCursor();
                return;
            }
            // 直径口径与 fillBrush 一致：size% × 照片短边。这里换成屏幕 CSS 像素。
            const rawSize = Number(m.shape && m.shape.size);
            const size = Math.max(2, Math.min(80, Number.isFinite(rawSize) ? rawSize : 18));
            const pw = pr.w / bw * r.width;
            const ph = pr.h / bh * r.height;
            const d = Math.max(4, (size / 100) * Math.min(pw, ph));
            const host = el.parentElement;
            if (!host) { this._hideBrushCursor(); return; }
            const hr = host.getBoundingClientRect();
            el.style.width = d + 'px';
            el.style.height = d + 'px';
            el.style.left = (x - hr.left - (host.clientLeft || 0) - d / 2) + 'px';
            el.style.top = (y - hr.top - (host.clientTop || 0) - d / 2) + 'px';
            const erase = !!(e.altKey || ((e.buttons | 0) & 2));
            el.classList.toggle('erase', erase);
            el.hidden = false;
            this._maskBrushPos = {
                clientX: x, clientY: y, altKey: !!e.altKey, buttons: Number(e.buttons) || 0
            };
        },

        _refreshBrushCursor() {
            const p = this._maskBrushPos;
            if (p) this._updateBrushCursor(p);
        },

        /* 指针 → 照片归一化坐标 */
        _maskPoint(e) {
            const ov = overlayEl();
            if (!ov) return null;
            const r = ov.getBoundingClientRect();
            // 叠加层还没布局出来时（窗口被遮挡 / 首帧之前）别把指针夹到角落：
            // 0 宽高算出来的 x/y 是垃圾值，clamp01 会把它变成 (0,0)，
            // 表现为「点哪儿都选到左上角」。直接忽略这次指针事件。
            if (!(r.width > 0) || !(r.height > 0)) return null;
            const base = this._baseSize();
            // 叠加层就是画布的视觉矩形：比例直接乘基准宽高即可回到照片矩形所在的坐标
            const x = (e.clientX - r.left) / Math.max(1, r.width) * base.w;
            const y = (e.clientY - r.top) / Math.max(1, r.height) * base.h;
            const pr = this._photoRect;
            if (!pr) return null;
            return { x: clamp01((x - pr.x) / Math.max(1, pr.w)), y: clamp01((y - pr.y) / Math.max(1, pr.h)) };
        },

        /* 椭圆旋转手柄的位置（照片归一化坐标）：长轴端点再往外推 ~16 CSS px。
           角度在基准空间算（与绘制同一套），再换回归一化坐标；绘制与命中判定共用，
           保证「画在哪就能抓在哪」。 */
        maskRotHandle(shape) {
            const pr = this._photoRect;
            if (!pr || !shape) return null;
            const rot = (Number(shape.rot) || 0) * Math.PI / 180;
            const Rx = Math.max(0.01, shape.rx) * Math.max(1, pr.w);
            const Ry = Math.max(0.01, shape.ry) * Math.max(1, pr.h);
            // 手柄放在「屏幕上更长的那根轴」上（与长轴指示线一致；rx/ry 是比例，必须换成像素再比）
            const majorX = Rx >= Ry;
            const M = majorX ? Rx : Ry;
            const cos = Math.cos(rot), sin = Math.sin(rot);
            const ux = majorX ? cos : -sin;
            const uy = majorX ? sin : cos;
            // 1 CSS px = 多少基准单位：缩放/窗口变化后手柄与圆点的视觉间距保持不变
            const ov = overlayEl();
            const ovr = ov ? ov.getBoundingClientRect() : null;
            const base = this._baseSize();
            const perCss = (ovr && ovr.width > 1) ? (Math.max(1, base.w) / ovr.width) : 1;
            // 16px 外推 + 10px 命中半径：端点(0px 偏移)仍属于「改大小」，
            // 只有明确点到外侧圆点才旋转 —— 与既有手感/回归测试兼容。
            const dist = M + 16 * perCss;
            const cxB = pr.x + shape.cx * pr.w, cyB = pr.y + shape.cy * pr.h;
            let hx = (cxB + ux * dist - pr.x) / Math.max(1, pr.w);
            let hy = (cyB + uy * dist - pr.y) / Math.max(1, pr.h);
            // _maskPoint 会把指针 clamp 到照片内：大椭圆的手柄若跑到照片外就抓不到，
            // 收回边缘内一点；旋转只看「指针相对中心的方向」，手柄位置不影响功能。
            hx = Math.max(0.01, Math.min(0.99, hx));
            hy = Math.max(0.01, Math.min(0.99, hy));
            return { x: hx, y: hy };
        },

        /* 椭圆的四个「轴向手柄」（照片归一化坐标）：两条轴各自的 ± 端点。
           拖 ±X 只改 rx（变长变短）、拖 ±Y 只改 ry（变胖变瘦）——
           以前只能拖边缘做等比缩放，长轴短轴一起变，调不出更扁/更长的形状。 */
        maskAxisHandles(shape) {
            const pr = this._photoRect;
            if (!pr || !shape) return [];
            const rot = (Number(shape.rot) || 0) * Math.PI / 180;
            const cos = Math.cos(rot), sin = Math.sin(rot);
            const pw = Math.max(1, pr.w), ph = Math.max(1, pr.h);
            const Rx = Math.max(0.01, shape.rx) * pw;
            const Ry = Math.max(0.01, shape.ry) * ph;
            const cxB = pr.x + shape.cx * pw, cyB = pr.y + shape.cy * ph;
            // 轴太短时不给手柄：小椭圆的端点会挤在中心，8px 命中半径会把「拖动中心」
            // 抢成「改大小」，反而更难用。
            const ov = overlayEl();
            const ovr = ov ? ov.getBoundingClientRect() : null;
            const perCss = (ovr && ovr.width > 1) ? (pw / ovr.width) : 1;
            const minBase = 14 * perCss;
            // 基准像素 → 归一化；夹到照片内，保证手柄一定抓得到（_maskPoint 会 clamp 指针）
            const mk = (bx, by, axis) => ({
                x: Math.max(0.01, Math.min(0.99, (bx - pr.x) / pw)),
                y: Math.max(0.01, Math.min(0.99, (by - pr.y) / ph)),
                axis
            });
            const list = [
                mk(cxB + Rx * cos, cyB + Rx * sin, 'x'),
                mk(cxB - Rx * cos, cyB - Rx * sin, 'x'),
                mk(cxB - Ry * sin, cyB + Ry * cos, 'y'),
                mk(cxB + Ry * sin, cyB - Ry * cos, 'y')
            ];
            return list.filter((h) => (h.axis === 'x' ? Rx : Ry) >= minBase);
        },

        /* 叠加层绘制：蒙版范围染成青绿色 + 形状手柄；拖动期只跑这一条路径 */
        drawMaskOverlay() {
            const ov = overlayEl();
            if (!ov) return;
            this.syncOverlayGeometry();
            const g = ov.getContext('2d');
            if (!g) return;
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, ov.width, ov.height);
            const m = this.activeMask(this.image);
            if (!m || !this.image) { ov.classList.remove('active'); this._maskRotHover = false; this._hideBrushCursor(); return; }
            // 停用的蒙版不参与烘焙：不画范围、不给手柄，也不让叠加层继续挡画布操作。
            if (m.on === 0 || this.activeGroupDisabled(this.image)) {
                ov.classList.remove('active');
                this._maskRotHover = false;
                this._hideBrushCursor();
                return;
            }
            // 只有椭圆有旋转手柄；切到别的类型时清掉悬停态，避免切回来时残留高亮
            if (m.type !== 'radial') this._maskRotHover = false;
            const pr = this._photoRect;
            if (!pr) { ov.classList.remove('active'); return; }
            ov.classList.add('active');

            const dpr = Math.min(2, window.devicePixelRatio || 1);
            // 只用一个比例：叠加层像素 / 画布基准单位。
            // 以前是 canvasScale × zoom × dpr 三个比例相乘，任一环（fit 重算、导出临时放大、
            // 高分屏）取值不同步，蒙版范围就会跟着变；现在 ov 已贴在画布视觉矩形上，
            // 这个比例天然包含缩放与 DPR，没有第二个真相。
            const base = this._baseSize();
            const k = ov.width / Math.max(1, base.w);
            const sx = pr.x * k, sy = pr.y * k;
            const sw = pr.w * k, sh = pr.h * k;

            // 线性和椭圆直接在叠加层上用矢量渐变画：位置就是照片矩形本身，
            // 不经过「低分辨率遮罩 → 放大」，避免再出现错位/看起来是硬边矩形。
            // 画笔和亮度是像素型蒙版，仍走低分辨率遮罩放大。
            // 叠层只表示「范围」：不乘浓度。否则把浓度调低、或照片被压暗后，
            // 半透明绿在暗背景上几乎看不见，看起来就像蒙版自己缩小了。
            const TINT = [64, 208, 150];
            const baseA = 0.5;
            const rgba = (a) => 'rgba(' + TINT[0] + ',' + TINT[1] + ',' + TINT[2] + ',' + a.toFixed(3) + ')';
            const grp = this.activeGroup ? this.activeGroup(this.image) : null;
            const members = (grp && grp.members) || [m];
            // 椭圆方向（度→弧度）：叠加层、渐变、手柄、命中判定共用同一个角
            const rotRad = (Number(m.shape && m.shape.rot) || 0) * Math.PI / 180;
            const paintRaster = (alpha, color) => {
                const tint = document.createElement('canvas');
                tint.width = alpha.width; tint.height = alpha.height;
                const tg = tint.getContext('2d');
                if (!tg) return;
                tg.fillStyle = color;
                tg.fillRect(0, 0, alpha.width, alpha.height);
                tg.globalCompositeOperation = 'destination-in';
                tg.drawImage(alpha, 0, 0);
                g.imageSmoothingEnabled = true;
                g.drawImage(tint, sx, sy, sw, sh);
            };
            g.save();
            if (members.length > 1) {
                // 组合模式：合并运算（并集 / 挖掉 / 交集）只能在像素上做，
                // 所以这一组统一走低分辨率光栅 + 放大。绿=最终生效范围，
                // 红=当前这个「减去」成员挖掉的部分（让用户看得见自己在删哪里）。
                const pw = Math.max(64, Math.min(400, Math.round(pr.w)));
                const ph = Math.max(32, Math.round(pw * pr.h / Math.max(1, pr.w)));
                const raw = { rawAlpha: true };
                paintRaster(window.QfsMask.groupAlpha(grp, pw, ph, this.image.el, raw), rgba(1));
                if (m.mode === 'subtract') {
                    paintRaster(window.QfsMask.render(m, pw, ph, this.image.el, raw), 'rgba(232,96,86,0.55)');
                }
                g.restore();
            } else {
            g.beginPath();
            if (m.type === 'radial' && !m.inv) {
                g.ellipse(sx + m.shape.cx * sw, sy + m.shape.cy * sh,
                    Math.max(1, m.shape.rx * sw), Math.max(1, m.shape.ry * sh), rotRad, 0, Math.PI * 2);
            } else {
                // 反相椭圆要覆盖椭圆外的整幅照片，不能先裁到椭圆里
                g.rect(sx, sy, sw, sh);
            }
            g.clip();
            if (m.type === 'linear') {
                const f = Math.max(0.001, m.feather / 100);
                const grad = g.createLinearGradient(sx + m.shape.x1 * sw, sy + m.shape.y1 * sh,
                    sx + m.shape.x2 * sw, sy + m.shape.y2 * sh);
                const a = Math.max(0, 0.5 - f / 2), b = Math.min(1, 0.5 + f / 2);
                const c0 = rgba(m.inv ? baseA : 0), c1 = rgba(m.inv ? 0 : baseA);
                grad.addColorStop(0, c0);
                grad.addColorStop(a, c0);
                grad.addColorStop(b, c1);
                grad.addColorStop(1, c1);
                g.fillStyle = grad;
                g.fillRect(sx, sy, sw, sh);
            } else if (m.type === 'radial') {
                // 与遮罩生成共用同一个 inner：染色范围、内圈线、实际生效范围三者永远一致
                const inner = window.QfsMask.radialInner(m);
                const cx = sx + m.shape.cx * sw, cy = sy + m.shape.cy * sh;
                const rx = Math.max(1, m.shape.rx * sw), ry = Math.max(1, m.shape.ry * sh);
                if (m.inv) {
                    // 反相：整幅照片染绿，再把椭圆内部按羽化擦掉。
                    // 只把渐变颜色反过来的话，椭圆外根本没被 fillRect 覆盖，
                    // 看起来就像“反相只作用在椭圆里”。
                    g.fillStyle = rgba(baseA);
                    g.fillRect(sx, sy, sw, sh);
                    g.save();
                    g.translate(cx, cy);
                    if (rotRad) g.rotate(rotRad);
                    g.scale(rx, ry);
                    g.globalCompositeOperation = 'destination-out';
                    const cut = g.createRadialGradient(0, 0, inner, 0, 0, 1);
                    cut.addColorStop(0, 'rgba(255,255,255,1)');
                    cut.addColorStop(1, 'rgba(255,255,255,0)');
                    g.fillStyle = cut;
                    g.beginPath();
                    g.arc(0, 0, 1.02, 0, Math.PI * 2);
                    g.fill();
                    g.restore();
                } else {
                    g.translate(cx, cy);
                    if (rotRad) g.rotate(rotRad);
                    g.scale(rx, ry);
                    // 单位圆内的径向渐变：r<=inner 满权重，之外衰减到 0
                    const grad = g.createRadialGradient(0, 0, inner, 0, 0, 1);
                    grad.addColorStop(0, rgba(baseA));
                    grad.addColorStop(1, rgba(0));
                    g.fillStyle = grad;
                    g.fillRect(-1.05, -1.05, 2.1, 2.1);
                }
            } else if (m.type === 'brush' || m.type === 'lum' || m.type === 'color') {
                const pw = Math.max(64, Math.min(400, Math.round(pr.w)));
                const ph = Math.max(32, Math.round(pw * pr.h / Math.max(1, pr.w)));
                // 源必须是**原图**：亮度/颜色蒙版按像素内容选区，若用调过色的烘焙图，
                // 一压暗选区就变大、一提亮就变小 —— 用户看到的就是「调完色蒙版范围变了」。
                // rawAlpha：叠加层只显示范围，浓度调低不该让绿色范围跟着变淡。
                paintRaster(window.QfsMask.render(m, pw, ph, this.image.el, { rawAlpha: true }), rgba(1));
            }
            g.restore();
            }

            // 蒙版的作用边界 = 照片矩形：描一圈很淡的虚线框把它画出来。
            // ① 让「蒙版只作用于照片本体、盖不到相框/背景」这件事可见；
            // ② 框和照片对不上 = 某条管线把照片矩形抓错了，一眼就能发现（可自查的回归）。
            g.save();
            g.setLineDash([4 * dpr, 4 * dpr]);
            g.lineWidth = 1 * dpr;
            g.strokeStyle = 'rgba(255,255,255,.4)';
            g.strokeRect(sx + 0.5, sy + 0.5, Math.max(1, sw - 1), Math.max(1, sh - 1));
            g.setLineDash([]);
            g.restore();

            // 手柄（线性：两端点；径向：中心 + 四个方向点）
            const P = (x, y) => ({ x: sx + x * sw, y: sy + y * sh });
            const dot = (p, r) => {
                g.beginPath();
                g.arc(p.x, p.y, r * dpr, 0, Math.PI * 2);
                g.fillStyle = 'rgba(255,255,255,.95)';
                g.fill();
                g.lineWidth = 1.5 * dpr;
                g.strokeStyle = 'rgba(0,0,0,.55)';
                g.stroke();
            };
            g.save();
            if (m.type === 'linear') {
                const a = P(m.shape.x1, m.shape.y1), b = P(m.shape.x2, m.shape.y2);
                g.lineWidth = 1.4 * dpr;
                g.strokeStyle = 'rgba(255,255,255,.85)';
                g.setLineDash([5 * dpr, 4 * dpr]);
                g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
                g.setLineDash([]);
                dot(a, 5); dot(b, 5);
            } else if (m.type === 'radial') {
                const c = P(m.shape.cx, m.shape.cy);
                const rx = m.shape.rx * sw, ry = m.shape.ry * sh;
                g.lineWidth = 1.4 * dpr;
                g.strokeStyle = 'rgba(255,255,255,.85)';
                g.setLineDash([5 * dpr, 4 * dpr]);
                g.beginPath();
                g.ellipse(c.x, c.y, Math.max(2, rx), Math.max(2, ry), rotRad, 0, Math.PI * 2);
                g.stroke();
                g.setLineDash([]);
                // 羽化内圈：r<=inner 是「满作用区」，inner..1 才是过渡带。以前只有一条
                // 外圈虚线，看着像「框内全作用」，调羽化滑块时框还一动不动。这条细点线
                // 把满作用区圈出来，滑块一动它跟着缩/涨（反相时表示「完全挖空区」）。
                // 半径直接取遮罩生成用的同一个 inner，线画在哪、效果就到哪。
                // 硬边（inner≈1）时两条线几乎重合，画出来只会像外圈变粗；全软
                // （inner=0）时压根没有满作用区，也不该画。
                const innerR = window.QfsMask.radialInner(m);
                const irx = rx * innerR, iry = ry * innerR;
                if (innerR > 0.06 && innerR < 0.97 && irx > 7 * dpr && iry > 7 * dpr) {
                    g.save();
                    g.beginPath();
                    g.ellipse(c.x, c.y, irx, iry, rotRad, 0, Math.PI * 2);
                    g.lineWidth = 1 * dpr;
                    g.strokeStyle = 'rgba(255,255,255,.45)';
                    g.setLineDash([2 * dpr, 6 * dpr]);
                    g.stroke();
                    g.restore();
                }
                // 四个轴向手柄（两条轴的 ± 端点）：拖它只改这一根轴的长度。
                // 画成小方块，和「圆点=旋转」区分开，用户一眼知道有两套手柄。
                const axisHs = this.maskAxisHandles(m.shape);
                for (const h of axisHs) {
                    const hp = P(h.x, h.y);
                    const half = 3.5 * dpr;
                    g.beginPath();
                    g.rect(hp.x - half, hp.y - half, half * 2, half * 2);
                    g.fillStyle = 'rgba(255,255,255,.95)';
                    g.fill();
                    g.lineWidth = 1.2 * dpr;
                    g.strokeStyle = 'rgba(0,0,0,.62)';
                    g.stroke();
                }
                // 长轴指示线：rx≈ry 时椭圆接近正圆，光看轮廓看不出方向，
                // 这条线让「方向」始终可见（也方便确认滑块确实生效）。
                const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
                const tip = rx >= ry
                    ? { x: c.x + rx * cosR, y: c.y + rx * sinR }
                    : { x: c.x - ry * sinR, y: c.y + ry * cosR };
                g.beginPath();
                g.moveTo(c.x, c.y);
                g.lineTo(tip.x, tip.y);
                g.lineWidth = 1 * dpr;
                g.strokeStyle = 'rgba(255,255,255,.55)';
                g.stroke();
                // 旋转手柄(PS 式直接拖)：长轴端点外侧的小圆点，拖它绕中心转
                const rh = this.maskRotHandle(m.shape);
                if (rh) {
                    const hp = P(rh.x, rh.y);
                    const hot = !!this._maskRotHover;
                    // 连接线：悬停时一起提亮
                    g.beginPath();
                    g.moveTo(tip.x, tip.y);
                    g.lineTo(hp.x, hp.y);
                    g.lineWidth = (hot ? 1.5 : 1) * dpr;
                    g.strokeStyle = hot ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.5)';
                    g.stroke();
                    // 悬停反馈：外圈光晕 + 放大 + 绿色实心，明确「这个点能拖」
                    if (hot) {
                        g.beginPath();
                        g.arc(hp.x, hp.y, 12 * dpr, 0, Math.PI * 2);
                        g.fillStyle = 'rgba(64,208,150,.26)';
                        g.fill();
                    }
                    g.beginPath();
                    g.arc(hp.x, hp.y, (hot ? 8 : 6) * dpr, 0, Math.PI * 2);
                    g.fillStyle = hot ? 'rgba(64,208,150,.95)' : 'rgba(255,255,255,.95)';
                    g.fill();
                    g.lineWidth = (hot ? 2 : 1.5) * dpr;
                    g.strokeStyle = hot ? 'rgba(255,255,255,.95)' : 'rgba(0,0,0,.6)';
                    g.stroke();
                    g.beginPath();
                    g.arc(hp.x, hp.y, (hot ? 2.8 : 2.2) * dpr, 0, Math.PI * 2);
                    g.fillStyle = hot ? 'rgba(12,48,36,.9)' : 'rgba(64,208,150,1)';
                    g.fill();
                }
                dot(c, 5);
            }
            g.restore();
        },

        initMasks() {
            const types = $('maskTypes');
            if (types) {
                types.querySelectorAll('[data-mt]').forEach((b) => {
                    b.addEventListener('click', () => this.addMask(b.dataset.mt));
                });
            }
            const list = $('maskList');
            if (list) {
                list.addEventListener('click', (e) => {
                    const row = e.target.closest('[data-mask-id]');
                    if (!row) return;
                    if (e.target.closest('[data-mask-toggle]')) { this.toggleMask(row.dataset.maskId); return; }
                    if (e.target.closest('[data-mask-del]')) { this.removeMask(row.dataset.maskId); return; }
                    this.setActiveMask(row.dataset.maskId || null);
                });
            }
            const copy = $('btnMaskCopy');
            if (copy) copy.addEventListener('click', () => this.copyMask());
            const paste = $('btnMaskPaste');
            if (paste) paste.addEventListener('click', () => this.pasteMask());
            const del = $('btnMaskDel');
            if (del) {
                del.addEventListener('click', () => {
                    const m = this.activeMask(this.image);
                    if (m) this.removeMask(m.id);
                });
            }
            // 羽化/浓度/笔刷/亮度范围：改数值 → 重新烘焙
            const bindNum = (id, apply) => {
                const el = $(id);
                if (!el) return;
                el.addEventListener('input', () => { apply(Number(el.value) || 0, false); });
                el.addEventListener('change', () => { apply(Number(el.value) || 0, true); });
            };
            bindNum('slMaskFeather', (v, done) => this._patchMask({ feather: v }, done));
            bindNum('slMaskDensity', (v, done) => this._patchMask({ density: v }, done));
            bindNum('slMaskBrushSize', (v, done) => {
                const m = this.activeMask(this.image);
                if (!m || m.type !== 'brush') return;
                m.shape.size = v;
                // 这个滑块没有走 _patchMask，必须自己回写标签/数字框；
                // 否则拖完笔刷大小，面板上还停在旧值（其他蒙版滑块由 syncMaskUI 负责）。
                if (this.updateLabel) this.updateLabel('lblMaskBrushSize', String(v));
                // 光圈跟着滑块变大小（指针不在画布上时 _maskBrushPos 为空，什么也不做）
                this._refreshBrushCursor();
                // input 期用低分辨率预览，松手（change）补一次全分辨率烘焙。
                this.commitMaskShape(done ? 'full' : 'live');
            });
            // 椭圆方向：改的是 shape.rot（不走 _patchMask，它写的是蒙版顶层字段）
            bindNum('slMaskRot', (v, done) => {
                const m = this.activeMask(this.image);
                if (!m || m.type !== 'radial') return;
                m.shape.rot = Math.max(0, Math.min(360, Math.round(v)));
                if (this.updateLabel) this.updateLabel('lblMaskRot', m.shape.rot + '°');
                this.commitMaskShape(done ? 'full' : 'live');
                // commitMaskShape 只重烘照片，叠加层的椭圆/手柄要自己重画才跟手
                this.drawMaskOverlay();
            });
            bindNum('slMaskLo', (v, done) => this._patchLum(v, null, done));
            bindNum('slMaskHi', (v, done) => this._patchLum(null, v, done));
            const inv = $('cbMaskInv');
            if (inv) inv.addEventListener('change', () => this._patchMask({ inv: inv.checked ? 1 : 0 }, true));
            // 亮度/颜色蒙版：查看原图（隐藏调色，方便选区）；浮层上的「返回调色」走同一个开关
            const viewOrig = $('cbMaskViewOrig');
            if (viewOrig) viewOrig.addEventListener('change', () => this.setMaskOriginalPreview(viewOrig.checked));
            const backOrig = $('btnMaskOrigBack');
            if (backOrig) backOrig.addEventListener('click', () => this.setMaskOriginalPreview(false));
            // 组合方式：改的是「当前选中成员」的 mode（第一个只能是新建）
            const modes = $('maskModes');
            if (modes) {
                modes.querySelectorAll('[data-mm]').forEach((b) => {
                    b.addEventListener('click', () => {
                        const m = this.activeMask(this.image);
                        if (!m) { this.setStatus('先选一个蒙版，再选组合方式'); return; }
                        this.setMaskMode(m.id, b.dataset.mm);
                        const meta = (window.App.MASK_MODES || []).find((x) => x.k === b.dataset.mm) || {};
                        this.setStatus('组合方式：' + (meta.label || b.dataset.mm));
                    });
                });
            }
            // 颜色蒙版：色相 / 容差 / 最低饱和
            bindNum('slMaskHue', (v, done) => this._patchColor({ h: v }, done));
            bindNum('slMaskTol', (v, done) => this._patchColor({ tol: v }, done));
            bindNum('slMaskMinS', (v, done) => this._patchColor({ minS: v }, done));
            this._bindMaskOverlay();
            this.syncMaskUI();
            this.drawMaskOverlay();
        },

        _patchMask(patch, done) {
            const m = this.activeMask(this.image);
            if (!m) return;
            Object.assign(m, patch);
            this.commitMaskShape(done ? 'full' : 'live');
            this.syncMaskUI();
        },

        /* 画布点选取色：按归一化照片坐标采样原图色相。
           缩到 512px 再采样 —— 每次点击都 drawImage 一张 12MP 原图太浪费，
           而取色只需要大致色相（容差是 3~90 度级别的粗量）。 */
        pickMaskColor(nx, ny) {
            const im = this.image;
            const m = this.activeMask(im);
            if (!im || !m || m.type !== 'color' || !im.el) return false;
            const W = Math.max(1, im.el.naturalWidth || im.w || 1);
            const H = Math.max(1, im.el.naturalHeight || im.h || 1);
            const scale = Math.min(1, 512 / Math.max(W, H));
            const tw = Math.max(1, Math.round(W * scale));
            const th = Math.max(1, Math.round(H * scale));
            const c = document.createElement('canvas');
            c.width = tw; c.height = th;
            const g = c.getContext('2d');
            if (!g) return false;
            try { g.drawImage(im.el, 0, 0, tw, th); } catch (_) { return false; }
            let px;
            try {
                const x = Math.max(0, Math.min(tw - 1, Math.round(nx * tw)));
                const y = Math.max(0, Math.min(th - 1, Math.round(ny * th)));
                px = g.getImageData(x, y, 1, 1).data;
            } catch (_) { return false; }
            const r = px[0] / 255, gg = px[1] / 255, b = px[2] / 255;
            const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), d = mx - mn;
            let hue = m.shape.h;
            if (d > 0.02) {
                if (mx === r) hue = (((gg - b) / d) % 6 + 6) % 6;
                else if (mx === gg) hue = (b - r) / d + 2;
                else hue = (r - gg) / d + 4;
                hue *= 60;
            }
            m.shape.h = Math.round(((hue % 360) + 360) % 360);
            // 取色点的饱和度太低时把门槛降下来，否则「点了却一片都没选中」
            const sat = mx > 1e-6 ? d / mx : 0;
            m.shape.minS = Math.max(4, Math.min(60, Math.round(sat * 55)));
            this.commitMaskShape('full');
            this.syncMaskUI();
            this.setStatus('已取色：色相 ' + m.shape.h + '°');
            return true;
        },

        _patchColor(patch, done) {
            const m = this.activeMask(this.image);
            if (!m || m.type !== 'color') return;
            Object.assign(m.shape, patch);
            this.commitMaskShape(done ? 'full' : 'live');
            this.syncMaskUI();
        },

        _patchLum(lo, hi, done) {
            const m = this.activeMask(this.image);
            if (!m || m.type !== 'lum') return;
            if (lo != null) m.shape.lo = Math.max(0, Math.min(m.shape.hi - 5, lo));
            if (hi != null) m.shape.hi = Math.min(100, Math.max(m.shape.lo + 5, hi));
            this.commitMaskShape(done ? 'full' : 'live');
            this.syncMaskUI();
        },

        _bindMaskOverlay() {
            const ov = overlayEl();
            if (!ov) return;
            let drag = null;
            let pending = null;   // 按下但还没拖动：单击不应该改动蒙版
            const hit = (pt, target, rCss) => {
                const ovr = ov.getBoundingClientRect();
                // 照片矩形和蒙版坐标都是「基准画布」口径（_canvasBaseW/H），
                // 不是 _logW（= 基准 × uiScale）。混用会让大图上的 12px 容差
                // 实际变成 12×base/logW（4000px 图上约 27px），手感发飘。
                const base = this._baseSize();
                const lw = base.w || 1, lh = base.h || 1;
                const pr = this._photoRect;
                if (!pr) return false;
                const px = (pr.x + target.x * pr.w) / lw * ovr.width;
                const py = (pr.y + target.y * pr.h) / lh * ovr.height;
                const mx = (pr.x + pt.x * pr.w) / lw * ovr.width;
                const my = (pr.y + pt.y * pr.h) / lh * ovr.height;
                return Math.hypot(px - mx, py - my) <= rCss;
            };
            // 点到线段的距离（CSS 像素），用来判断「抓线整体拖」
            const distToLine = (pt, s) => {
                const ovr = ov.getBoundingClientRect();
                const pr = this._photoRect;
                if (!pr) return 1e9;
                const base = this._baseSize();
                const lw = base.w || 1, lh = base.h || 1;
                const toCss = (x, y) => ({ x: (pr.x + x * pr.w) / lw * ovr.width,
                                           y: (pr.y + y * pr.h) / lh * ovr.height });
                const a = toCss(s.x1, s.y1), b = toCss(s.x2, s.y2), p = toCss(pt.x, pt.y);
                const dx = b.x - a.x, dy = b.y - a.y;
                const len2 = dx * dx + dy * dy || 1e-6;
                let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
                t = t < 0 ? 0 : (t > 1 ? 1 : t);
                const cx = a.x + t * dx, cy = a.y + t * dy;
                return Math.hypot(p.x - cx, p.y - cy);
            };
            // 点到**旋转后**椭圆的「单位圆距离」：<1 在内部、≈1 在边缘、>1 在外面。
            // 必须先按 -rot 把点转回椭圆局部系，否则旋转过的椭圆会按未旋转的轴来判断，
            // 斜着拖边缘会被误判成「空白处按下」→ 拖出一个新椭圆。
            const radialRR = (pt, s) => {
                const pr = this._photoRect;
                if (!pr) return 1e9;
                const rot = (Number(s.rot) || 0) * Math.PI / 180;
                const pw = Math.max(1, pr.w), ph = Math.max(1, pr.h);
                const px = (pt.x - s.cx) * pw;
                const py = (pt.y - s.cy) * ph;
                const cos = Math.cos(rot), sin = Math.sin(rot);
                const u = px * cos + py * sin;
                const v = -px * sin + py * cos;
                const dx = u / Math.max(0.01, s.rx * pw);
                const dy = v / Math.max(0.01, s.ry * ph);
                return Math.hypot(dx, dy);
            };

            ov.addEventListener('pointerdown', (e) => {
                const m = this.activeMask(this.image);
                if (!m) return;
                if (m.on === 0 || this.activeGroupDisabled(this.image)) { this._hideBrushCursor(); return; }
                const pt = this._maskPoint(e);
                if (!pt) return;
                try { ov.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件没有活动指针 */ }
                e.preventDefault();
                if (m.type === 'linear') {
                    if (hit(pt, { x: m.shape.x1, y: m.shape.y1 }, 12)) drag = { kind: 'p1' };
                    else if (hit(pt, { x: m.shape.x2, y: m.shape.y2 }, 12)) drag = { kind: 'p2' };
                    else if (distToLine(pt, m.shape) <= 14) {
                        // 抓到线上 → 整条线平移，而不是重新画
                        drag = { kind: 'moveLine', px: pt.x, py: pt.y, orig: Object.assign({}, m.shape) };
                    } else {
                        // 空白处按下先不动：拖出距离才当成新渐变，
                        // 否则「点一下看看」会把调好的蒙版塌成一个点（用户踩过）。
                        pending = { kind: 'newLine', start: pt, orig: Object.assign({}, m.shape) };
                    }
                } else if (m.type === 'radial') {
                    const rr = radialRR(pt, m.shape);
                    const rh = this.maskRotHandle(m.shape);
                    // 轴向手柄最先判：它正好落在椭圆轮廓上，命中半径(8px)比旋转手柄(10px)小，
                    // 不先判就会被后面的「等比缩放」抢走，永远只改不了单轴。
                    const ah = this.maskAxisHandles(m.shape).find((h) => hit(pt, h, 8));
                    // 旋转手柄优先于「拖动/改大小」：它本来就落在 rr≈1 的边缘带里，
                    // 不先判就会被当成改大小，永远转不动。
                    if (ah) {
                        // 记下按下时的两轴，Shift 等比联动时按「被拖轴的变化倍率」缩放另一轴
                        drag = { kind: 'axis', axis: ah.axis, ax0: m.shape.rx, ay0: m.shape.ry };
                    } else if (rh && hit(pt, rh, 10)) {
                        drag = { kind: 'rotate' };
                    } else if (hit(pt, { x: m.shape.cx, y: m.shape.cy }, 12) || rr < 0.95) {
                        drag = { kind: 'move', ox: m.shape.cx, oy: m.shape.cy, px: pt.x, py: pt.y };
                    } else if (rr < 1.35) {
                        // 记住按下时的半径与位置：按「离中心的距离比」等比缩放。
                        // 直接取 |pt-cx| 作为新半径的话，斜着抓边缘会让两个轴同时跳小 —— 越拖越小。
                        drag = { kind: 'size', rx0: m.shape.rx, ry0: m.shape.ry,
                                 cx: m.shape.cx, cy: m.shape.cy,
                                 d0: Math.max(0.01, Math.hypot(pt.x - m.shape.cx, pt.y - m.shape.cy)) };
                    } else {
                        pending = { kind: 'newRadial', start: pt, orig: Object.assign({}, m.shape) };
                    }
                } else if (m.type === 'brush') {
                    drag = { kind: 'brush' };
                    m.shape.strokes = m.shape.strokes || [];
                    m.shape.strokes.push({
                        size: m.shape.size || 18,
                        erase: (e.altKey || e.button === 2) ? 1 : 0,
                        pts: [[pt.x, pt.y], [pt.x + 0.0005, pt.y]]
                    });
                } else if (m.type === 'color') {
                    // 点一下 = 取这里的颜色作为目标色相（PS 的「颜色范围」最常用的手势）
                    this.pickMaskColor(pt.x, pt.y);
                    drag = null;
                } else {
                    drag = null;
                }
                if (m.type === 'brush') this._updateBrushCursor(e);
                else this._hideBrushCursor();
                if (drag) this.drawMaskOverlay();
            });

            ov.addEventListener('pointermove', (e) => {
                const m = this.activeMask(this.image);
                if (!m) return;
                if (m.on === 0 || this.activeGroupDisabled(this.image)) { this._hideBrushCursor(); return; }
                // 注意：pending（按下未拖）也要进这里，否则「拖出新渐变」永远升级不了
                if (!drag && !pending) {
                    if (m.type === 'brush') this._updateBrushCursor(e);
                    else this._hideBrushCursor();
                    // 悬停光标：旋转手柄 grab / 内部 move / 边缘可缩放 / 空白 crosshair
                    let cur = '';
                    let overRot = false;
                    if (m.type === 'radial') {
                        const pt0 = this._maskPoint(e);
                        if (pt0) {
                            const rh = this.maskRotHandle(m.shape);
                            const ah = this.maskAxisHandles(m.shape).find((h) => hit(pt0, h, 8));
                            if (ah) {
                                // 轴向手柄：左右改长轴、上下改短轴
                                cur = ah.axis === 'x' ? 'ew-resize' : 'ns-resize';
                            } else if (rh && hit(pt0, rh, 10)) { cur = 'grab'; overRot = true; }
                            else {
                                const rr = radialRR(pt0, m.shape);
                                cur = rr < 0.95 ? 'move' : (rr < 1.35 ? 'nwse-resize' : 'crosshair');
                            }
                        }
                    }
                    if (ov.style.cursor !== cur) ov.style.cursor = cur;
                    // 手柄悬停高亮：只在状态变化时重画，避免每次 pointermove 都重绘叠加层
                    if (overRot !== !!this._maskRotHover) {
                        this._maskRotHover = overRot;
                        this.drawMaskOverlay();
                    }
                    return;
                }
                const pt = this._maskPoint(e);
                if (!pt) return;
                if (m.type === 'brush') this._updateBrushCursor(e);
                else this._hideBrushCursor();
                if (pending) {
                    // 拖动超过阈值才把「空白处按下」升级成新形状
                    const moved = Math.hypot(pt.x - pending.start.x, pt.y - pending.start.y);
                    if (moved < 0.008) return;
                    if (pending.kind === 'newLine') {
                        m.shape.x1 = pending.start.x; m.shape.y1 = pending.start.y;
                        m.shape.x2 = pt.x; m.shape.y2 = pt.y;
                        pending = null;
                        drag = { kind: 'p2' };
                    } else {
                        const cx = pending.start.x, cy = pending.start.y;
                        m.shape.cx = cx; m.shape.cy = cy;
                        m.shape.rx = Math.max(0.02, Math.abs(pt.x - cx));
                        m.shape.ry = Math.max(0.02, Math.abs(pt.y - cy));
                        if (e.shiftKey) roundRadial(m, this._photoRect);   // Shift 拖出正圆
                        pending = null;
                        // 新椭圆升级成 size 拖动时，必须把半径基准一起带上：
                        // 否则下一次 pointermove 读 drag.rx0/d0 全是 undefined，
                        // rx/ry 会算成 NaN，椭圆当场消失（用户看到的就是“拖不出来”）。
                        drag = {
                            kind: 'size', rx0: m.shape.rx, ry0: m.shape.ry,
                            cx: cx, cy: cy,
                            d0: Math.max(0.01, Math.hypot(pt.x - cx, pt.y - cy))
                        };
                    }
                    this.drawMaskOverlay();
                    return;
                }
                if (drag.kind === 'moveLine') {
                    const dx = pt.x - drag.px, dy = pt.y - drag.py;
                    m.shape.x1 = drag.orig.x1 + dx; m.shape.y1 = drag.orig.y1 + dy;
                    m.shape.x2 = drag.orig.x2 + dx; m.shape.y2 = drag.orig.y2 + dy;
                } else if (drag.kind === 'p1') { m.shape.x1 = pt.x; m.shape.y1 = pt.y; }
                else if (drag.kind === 'p2') { m.shape.x2 = pt.x; m.shape.y2 = pt.y; }
                else if (drag.kind === 'move') {
                    const dx = pt.x - drag.px, dy = pt.y - drag.py;
                    m.shape.cx = clamp01(drag.ox + dx);
                    m.shape.cy = clamp01(drag.oy + dy);
                } else if (drag.kind === 'axis') {
                    // 只改被拖的那一根轴：把指针投到椭圆局部轴上量长度。
                    // 必须在像素空间投影 —— rx/ry 是归一化比例，非正方形照片上直接
                    // 用归一化坐标算会把方向搞歪（宽图尤其明显）。
                    const pr = this._photoRect;
                    if (pr) {
                        const rot = (Number(m.shape.rot) || 0) * Math.PI / 180;
                        const cos = Math.cos(rot), sin = Math.sin(rot);
                        const pw = Math.max(1, pr.w), ph = Math.max(1, pr.h);
                        const px = (pt.x - m.shape.cx) * pw;
                        const py = (pt.y - m.shape.cy) * ph;
                        if (drag.axis === 'x') {
                            m.shape.rx = Math.max(0.02, Math.min(1, Math.abs(px * cos + py * sin) / pw));
                            // Shift：另一根轴按同一倍率联动，保持屏幕上的形状比例
                            if (e.shiftKey && drag.ay0) {
                                const k = m.shape.rx / Math.max(0.02, drag.ax0);
                                m.shape.ry = Math.max(0.02, Math.min(1, drag.ay0 * k));
                            }
                        } else {
                            m.shape.ry = Math.max(0.02, Math.min(1, Math.abs(-px * sin + py * cos) / ph));
                            if (e.shiftKey && drag.ax0) {
                                const k = m.shape.ry / Math.max(0.02, drag.ay0);
                                m.shape.rx = Math.max(0.02, Math.min(1, drag.ax0 * k));
                            }
                        }
                    }
                } else if (drag.kind === 'size') {
                    const d = Math.hypot(pt.x - drag.cx, pt.y - drag.cy);
                    const k = Math.max(0.05, d / drag.d0);
                    m.shape.rx = Math.max(0.02, Math.min(1, drag.rx0 * k));
                    m.shape.ry = Math.max(0.02, Math.min(1, drag.ry0 * k));
                    if (e.shiftKey) roundRadial(m, this._photoRect);   // Shift 拖边锁正圆
                } else if (drag.kind === 'rotate') {
                    const pr = this._photoRect;
                    if (pr) {
                        // 角度必须在**像素/基准空间**算：rx、ry 是归一化比例，
                        // 照片非正方形时直接用归一化坐标算 atan2 会歪（宽图尤其明显）。
                        const vx = (pt.x - m.shape.cx) * Math.max(1, pr.w);
                        const vy = (pt.y - m.shape.cy) * Math.max(1, pr.h);
                        const Rx = Math.max(0.01, m.shape.rx) * Math.max(1, pr.w);
                        const Ry = Math.max(0.01, m.shape.ry) * Math.max(1, pr.h);
                        let deg = Math.atan2(vy, vx) * 180 / Math.PI;
                        // 手柄挂在「屏幕更长的那根轴」上：rx 更长是局部 x 轴(角度=rot)，
                        // ry 更长是局部 y 轴(世界角 = rot+90°)，所以要减 90°
                        if (Rx < Ry) deg -= 90;
                        if (e.shiftKey) deg = Math.round(deg / 15) * 15;   // 与元素旋转一致的 15° 吸附
                        m.shape.rot = Math.round(((deg % 360) + 360) % 360);
                        // 拖动期同步「方向」滑块/标签，松手再统一 syncMaskUI
                        const rotRng = $('slMaskRot');
                        if (rotRng) rotRng.value = String(m.shape.rot);
                        if (this.updateLabel) this.updateLabel('lblMaskRot', m.shape.rot + '°');
                    }
                } else if (drag.kind === 'brush') {
                    const st = m.shape.strokes[m.shape.strokes.length - 1];
                    st.pts.push([pt.x, pt.y]);
                }
                this.drawMaskOverlay();
            });

            const end = (e) => {
                // 只是在蒙版上点了一下：保持原样，绝不重置已调好的位置
                pending = null;
                if (!drag) return;
                const wasBrush = drag.kind === 'brush';
                const wasRotate = drag.kind === 'rotate';
                drag = null;
                try { if (ov.hasPointerCapture(e.pointerId)) ov.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
                if (wasRotate) {
                    // 松手时按指针实际位置重算悬停态：拖到内侧松手时不该还亮着
                    const ptEnd = this._maskPoint(e);
                    const mEnd = this.activeMask(this.image);
                    const rhEnd = (ptEnd && mEnd) ? this.maskRotHandle(mEnd.shape) : null;
                    this._maskRotHover = !!(ptEnd && rhEnd && hit(ptEnd, rhEnd, 10));
                }
                // 松手烘一次全分辨率：拖动期只画叠加层，保证跟手
                this.commitMaskShape('full');
                // 旋转/画笔要回写面板（方向滑块、笔刷大小）；拖动/改大小面板本来就不用变
                if (wasBrush || wasRotate) this.syncMaskUI();
            };
            ov.addEventListener('pointerup', end);
            ov.addEventListener('pointercancel', end);
            // 指针离开叠加层：清掉悬停高亮与画笔光圈（拖动中如果还按着，
            // pointer capture 会继续送 move，光圈会按新位置重新出现）
            ov.addEventListener('pointerleave', () => {
                this._hideBrushCursor();
                if (drag || pending) return;
                if (this._maskRotHover) { this._maskRotHover = false; this.drawMaskOverlay(); }
                if (ov.style.cursor) ov.style.cursor = '';
            });
            // 滚轮缩放会改画布尺寸，光圈的位置/大小立刻失效；等下一次 pointermove 再显示
            ov.addEventListener('wheel', () => this._hideBrushCursor(), { passive: true });
            ov.addEventListener('contextmenu', (e) => { if (this.activeMask(this.image)) e.preventDefault(); });
        },

        syncMaskUI() {
            const list = $('maskList');
            const masks = this.masksOf(this.image);
            const act = this.activeMask(this.image);
            if (list) {
                // 用 DOM 构造而不是拼 innerHTML：m.id / m.type 来自草稿或工程文件，
                // 现在虽然只可能是程序生成的值，但一旦以后允许外部模板带蒙版，
                // 拼接就会变成 UI 注入（伪造按钮/布局）。textContent + dataset 天然免疫。
                const frag = document.createDocumentFragment();
                const addRow = (cls, id, name, type, del, eyeOn) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'mask-row' + cls;
                    b.dataset.maskId = id;
                    // 眼睛图标（sr-only 的语义用 title/aria 表达）：全局行放一个占位，
                    // 保证「全局」和下面蒙版的名字左对齐。
                    const eye = document.createElement('span');
                    eye.className = 'mask-eye' + (eyeOn === false ? ' off' : '')
                        + (eyeOn == null ? ' mask-eye-none' : '');
                    if (eyeOn == null) {
                        eye.setAttribute('aria-hidden', 'true');
                    } else {
                        eye.dataset.maskToggle = '1';
                        eye.setAttribute('role', 'switch');
                        eye.setAttribute('aria-checked', eyeOn ? 'true' : 'false');
                        eye.title = eyeOn ? '停用这个蒙版（参数保留）' : '启用这个蒙版';
                        eye.appendChild(eyeIcon(!eyeOn));
                    }
                    b.appendChild(eye);
                    const nameEl = document.createElement('span');
                    nameEl.className = 'mask-name';
                    nameEl.textContent = name;
                    b.appendChild(nameEl);
                    const typeEl = document.createElement('span');
                    typeEl.className = 'mask-type';
                    typeEl.textContent = type;
                    b.appendChild(typeEl);
                    if (del) {
                        const delEl = document.createElement('span');
                        delEl.className = 'mask-del';
                        delEl.dataset.maskDel = '1';
                        delEl.title = '删除';
                        delEl.textContent = '×';
                        b.appendChild(delEl);
                    }
                    frag.appendChild(b);
                };
                addRow(act ? '' : ' active', '', '全局', '整张图', false);
                // 注意：window.QfsMask.MODES 是**字符串数组**（内部校验用），
                // 带 label 的元数据在 window.App.MASK_MODES。这里要用后者，
                // 用错了会渲染出「蒙版 0 · undefined」（踩过）。
                const modes = (window.App && window.App.MASK_MODES) || [];
                let groupNo = 0;
                for (let i = 0; i < masks.length; i++) {
                    const m = masks[i];
                    const t = window.QfsMask.TYPES.find((x) => x.k === m.type) || { label: m.type };
                    const on = act && act.id === m.id;
                    const md = modes.find((x) => x.k === (m.mode || 'new')) || modes[0] || { k: 'new', label: '新建' };
                    if (md.k === 'new') groupNo += 1;
                    // 组合成员显示「+ 添加 / − 减去 / ∩ 相交」前缀，一眼看出这块是在给谁打补丁
                    const mark = md.k === 'add' ? '+ '
                        : md.k === 'subtract' ? '− '
                            : md.k === 'intersect' ? '∩ ' : '';
                    const label = md.k === 'new' ? ('蒙版 ' + groupNo)
                        : ('蒙版 ' + groupNo + ' · ' + md.label);
                    addRow((on ? ' active' : '') + (m.on === 0 ? ' off' : '') + (md.k !== 'new' ? ' combo' : ''),
                        String(m.id), mark + label, t.label, true, m.on !== 0);
                }
                list.replaceChildren(frag);
            }
            const copyBtn = $('btnMaskCopy');
            if (copyBtn) copyBtn.disabled = !act;
            const pasteBtn = $('btnMaskPaste');
            if (pasteBtn) pasteBtn.disabled = !this._maskClip;
            const opts = $('maskOpts');
            if (opts) opts.style.display = act ? '' : 'none';
            const brushRow = $('rowMaskBrush');
            if (brushRow) brushRow.style.display = (act && act.type === 'brush') ? '' : 'none';
            // 方向只对椭圆有意义（线性的方向由两端点决定）
            const rotRow = $('rowMaskRot');
            if (rotRow) rotRow.style.display = (act && act.type === 'radial') ? '' : 'none';
            const lumLo = $('rowMaskLo'), lumHi = $('rowMaskHi');
            if (lumLo) lumLo.style.display = (act && act.type === 'lum') ? '' : 'none';
            if (lumHi) lumHi.style.display = (act && act.type === 'lum') ? '' : 'none';
            const isColor = !!(act && act.type === 'color');
            for (const id of ['rowMaskHue', 'rowMaskTol', 'rowMaskMinS']) {
                const row = $(id);
                if (row) row.style.display = isColor ? '' : 'none';
            }
            // 「查看原图」只对亮度/颜色蒙版有意义（选区依赖像素内容，几何类不需要）
            const viewRow = $('rowMaskViewOrig');
            if (viewRow) viewRow.style.display = (act && (act.type === 'lum' || act.type === 'color')) ? '' : 'none';
            // 组合按钮：高亮当前方式；列表里第一个只能是「新建」
            const modesBar = $('maskModes');
            if (modesBar) {
                const idx = act ? masks.indexOf(act) : -1;
                const curMode = act ? (act.mode || 'new') : 'new';
                const first = idx === 0;
                modesBar.querySelectorAll('[data-mm]').forEach((b) => {
                    const k = b.dataset.mm;
                    b.classList.toggle('active', k === curMode);
                    b.disabled = !act || (first && k !== 'new');
                });
            }
            const tip = $('maskEditTip');
            if (tip) {
                tip.style.display = act ? '' : 'none';
                if (act) {
                    const pr = this._photoRect;
                    // 相框/卡片管线现在也会上报照片矩形，pr 为空只剩「还没渲染完」一种情况
                    const how = pr ? ({
                        linear: '线的一侧会被整片选中，过渡带宽度≈线的长度：两端点拉得越远过渡越柔；拖线身移动，空白处拖一下重画',
                        radial: '内侧细点圈=满作用区，外圈=羽化到零；拖内部移动、四个方块手柄调单轴、边缘等比缩放、外侧圆点旋转，外面拖出新椭圆。按住 Shift：正圆 / 等比联动两轴 / 旋转吸附 15°',
                        brush: '按住涂抹；按住 Alt 或右键涂抹 = 擦除',
                        lum: '按亮度自动选区，调下面的暗部/亮部阈值',
                        color: '在画布上点一下取色，再调色相/容差；灰和近白黑不会被选中'
                    })[act.type] : '蒙版叠加层还没准备好，稍等片刻再试';
                    if (act.on === 0) {
                        tip.textContent = '这个蒙版已停用（眼睛图标）：参数和形状都保留，点一下眼睛即可恢复。';
                    } else if (this.activeGroupDisabled(this.image)) {
                        tip.textContent = '这个组合的组首已停用：组内所有成员暂时不生效，点亮组首的眼睛即可恢复。';
                    } else {
                        // 编辑蒙版时混色器会被收起（CSS：#grpGrade.editing-mask ~ #grpMix）——
                        // 它只作用于整张照片、不跟蒙版走，不说一句用户会以为混色器丢了
                        tip.textContent = how + '；混色器只作用于整张照片，编辑蒙版时已暂时收起';
                    }
                }
            }
            const badge = $('grpMask');
            if (badge) badge.classList.toggle('mask-on', masks.length > 0);
            // 数值回显
            const setV = (id, v) => {
                const el = $(id);
                if (!el) return;
                el.value = String(v);
                const lbl = $('lbl' + id.slice(2));
                if (lbl && this.updateLabel) this.updateLabel(lbl.id, String(v));
            };
            if (act) {
                setV('slMaskFeather', act.feather);
                setV('slMaskDensity', act.density);
                if (act.type === 'brush') setV('slMaskBrushSize', act.shape.size);
                if (act.type === 'radial') {
                    // 不走 setV：它回显纯数字，会把角度单位「°」吃掉
                    // （updateLabel 会解析标签里的数字同步数字框，单位单独显示）
                    const rotV = act.shape.rot || 0;
                    const rotRng = $('slMaskRot');
                    if (rotRng) rotRng.value = String(rotV);
                    if (this.updateLabel) this.updateLabel('lblMaskRot', rotV + '°');
                }
                if (act.type === 'lum') { setV('slMaskLo', act.shape.lo); setV('slMaskHi', act.shape.hi); }
                if (act.type === 'color') {
                    setV('slMaskHue', act.shape.h);
                    setV('slMaskTol', act.shape.tol);
                    setV('slMaskMinS', act.shape.minS);
                }
                const inv = $('cbMaskInv');
                if (inv) inv.checked = act.inv === 1;
            }
            this.drawMaskOverlay();
            this._syncMaskOrigHint();
            // 光圈只在「选中画笔且未停用」时存在；切类型/停用/切图后立刻收掉
            if (act && act.type === 'brush' && !this.activeGroupDisabled(this.image)) {
                this._refreshBrushCursor();
            } else {
                this._hideBrushCursor();
            }
        }
    });
})();

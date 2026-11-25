'use strict';
/* 曲线编辑器：RGB / R / G / B 四条曲线 → 256 项查找表 → 接进调色的 LUT 滤镜。
 *
 * 设计取舍
 * ─────────────────────────────────────────────────────────────
 * 1) 单调三次插值（Fritsch–Carlson），不用 Catmull-Rom。
 *    Catmull-Rom 在控制点一密就会过冲：曲线冲出 0..1，暗部溢出成黑块、
 *    亮部翻转成死白。单调插值保证段内不过冲，这也是 PS/LR 曲线的默认行为。
 * 2) 曲线不额外走一遍像素：它和色温/高光/阴影共用同一条 feComponentTransfer
 *    的 256 项表（在 buildTables 里串联在其输出之后），所以开曲线不增加
 *    烘焙成本，拖动时仍走 1600px 降采样。
 * 3) 数据只存控制点（每通道一个 [[x,y]…] 数组），随草稿 JSON 持久化，
 *    与 7 个数值档一样是无损重放，不破坏原图。
 */
(function () {
    const N = 256;
    const HIT = 10;           // 命中控制点的像素半径
    const CHANS = [
        { k: 'rgb', label: 'RGB' },
        { k: 'r', label: '红' },
        { k: 'g', label: '绿' },
        { k: 'b', label: '蓝' }
    ];

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    // ── 数据 ──────────────────────────────────────────────────
    function sanitize(pts) {
        if (!Array.isArray(pts)) return null;
        const out = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (!Array.isArray(p) || p.length < 2) continue;
            const x = Number(p[0]), y = Number(p[1]);
            if (!isFinite(x) || !isFinite(y)) continue;
            out.push([clamp01(x), clamp01(y)]);
        }
        if (out.length < 2) return null;
        out.sort((a, b) => a[0] - b[0]);
        // 相邻 x 太近会让插值除零：合并成一点（保留后写的）
        const ded = [];
        for (let i = 0; i < out.length; i++) {
            const last = ded[ded.length - 1];
            if (last && Math.abs(out[i][0] - last[0]) < 0.005) ded[ded.length - 1] = out[i];
            else ded.push(out[i]);
        }
        return ded.length >= 2 ? ded : null;
    }

    function sanitizeCurve(cv) {
        if (!cv) return null;
        const out = {};
        let any = false;
        for (const c of CHANS) {
            const pts = sanitize(cv[c.k]);
            if (pts) { out[c.k] = pts; any = true; }
        }
        return any ? out : null;
    }

    // 直线（等于没调）：用来判断中性、决定要不要把数据写进草稿
    function isLinear(pts) {
        if (!pts) return true;
        for (let i = 0; i < pts.length; i++) {
            if (Math.abs(pts[i][1] - pts[i][0]) > 0.002) return false;
        }
        return true;
    }

    function curveActive(cv) {
        if (!cv) return false;
        for (const c of CHANS) if (!isLinear(cv[c.k])) return true;
        return false;
    }

    function curveSignature(cv) {
        if (!curveActive(cv)) return '-';
        const parts = [];
        for (const c of CHANS) {
            const pts = cv[c.k];
            if (!pts || isLinear(pts)) { parts.push(''); continue; }
            parts.push(pts.map((p) => p[0].toFixed(3) + ':' + p[1].toFixed(3)).join(','));
        }
        return parts.join('|');
    }

    // ── 单调三次插值 → 256 项表 ────────────────────────────────
    function monotoneTable(pts) {
        const m = pts.length;
        const xs = new Array(m), ys = new Array(m);
        for (let i = 0; i < m; i++) { xs[i] = pts[i][0]; ys[i] = pts[i][1]; }
        const dx = new Array(m - 1), ms = new Array(m - 1);
        for (let i = 0; i < m - 1; i++) {
            dx[i] = Math.max(1e-6, xs[i + 1] - xs[i]);
            ms[i] = (ys[i + 1] - ys[i]) / dx[i];
        }
        const c = new Array(m);
        c[0] = ms[0];
        c[m - 1] = ms[m - 2];
        for (let i = 1; i < m - 1; i++) {
            if (ms[i - 1] * ms[i] <= 0) c[i] = 0;
            else {
                const w1 = 2 * dx[i] + dx[i - 1];
                const w2 = dx[i] + 2 * dx[i - 1];
                c[i] = (w1 + w2) / (w1 / ms[i - 1] + w2 / ms[i]);
            }
        }
        const out = new Array(N);
        let seg = 0;
        for (let i = 0; i < N; i++) {
            const x = i / (N - 1);
            if (x <= xs[0]) { out[i] = clamp01(ys[0]); continue; }
            if (x >= xs[m - 1]) { out[i] = clamp01(ys[m - 1]); continue; }
            while (seg < m - 2 && x > xs[seg + 1]) seg++;
            const t = (x - xs[seg]) / dx[seg];
            const t2 = t * t, t3 = t2 * t;
            let v = (2 * t3 - 3 * t2 + 1) * ys[seg]
                + (t3 - 2 * t2 + t) * dx[seg] * c[seg]
                + (-2 * t3 + 3 * t2) * ys[seg + 1]
                + (t3 - t2) * dx[seg] * c[seg + 1];
            out[i] = clamp01(v);
        }
        return out;
    }

    function sampleLut(lut, v) {
        const i = Math.round(clamp01(v) * (N - 1));
        return lut[i < 0 ? 0 : (i > N - 1 ? N - 1 : i)];
    }

    // 每通道的最终表：先走本通道曲线，再走 RGB 总曲线（与 PS 的复合顺序一致）
    function buildCurveLuts(cv) {
        const rgb = cv.rgb && !isLinear(cv.rgb) ? monotoneTable(cv.rgb) : null;
        const mk = (pts) => {
            const ch = pts && !isLinear(pts) ? monotoneTable(pts) : null;
            if (!ch && !rgb) return null;
            const out = new Array(N);
            for (let i = 0; i < N; i++) {
                let v = i / (N - 1);
                if (ch) v = sampleLut(ch, v);
                if (rgb) v = sampleLut(rgb, v);
                out[i] = v;
            }
            return out;
        };
        return { r: mk(cv.r), g: mk(cv.g), b: mk(cv.b) };
    }

    window.QfsCurve = {
        N, CHANS, sanitizeCurve, isLinear, curveActive, curveSignature,
        monotoneTable, sampleLut, buildCurveLuts, clamp01
    };

    // ── 控件 ──────────────────────────────────────────────────
    Object.assign(window.App || (window.App = {}), {
        _curveChan: 'rgb',

        initCurve() {
            const $ = (id) => document.getElementById(id);
            const cvEl = $('curveCanvas');
            if (!cvEl) return;
            this._curveShowAll = false;
            this._curveCopyBuf = null;   // 曲线渠道复制缓冲：复制通道设置 / 粘贴通道设置
            this._curveDom = {
                canvas: cvEl, ctx: cvEl.getContext('2d'),
                chans: $('curveChans'), reset: $('btnCurveReset'),
                wrap: $('grpCurve')
            };
            const chanBtns = this._curveDom.chans
                ? Array.prototype.slice.call(this._curveDom.chans.querySelectorAll('.curve-chan')) : [];
            chanBtns.forEach((b) => {
                b.addEventListener('click', () => {
                    this._closeCurveCtxMenu();
                    this._curveChan = b.dataset.chan || 'rgb';
                    chanBtns.forEach((x) => x.classList.toggle('active', x === b));
                    this.drawCurve();
                });
            });
            if (this._curveDom.reset) {
                this._curveDom.reset.addEventListener('click', () => this.resetCurve());
            }
            this._bindCurvePointer(cvEl);
            // 画布在面板隐藏时是 0 尺寸，drawCurve 会直接返回（不画兜底位图，避免椭圆）。
            // 用 ResizeObserver 盯住画布：面板变为可见、拿到真实尺寸的那一刻（以及窗口缩放时）
            // 自动重画，圆点始终是正圆。这与顶部直方图用 ResizeObserver 即时重画的思路一致。
            if (typeof ResizeObserver === 'function') {
                this._curveRO = new ResizeObserver(() => { this.drawCurve(); });
                this._curveRO.observe(cvEl);
            }
            this.drawCurve();
        },

        // 当前照片的曲线数据（没有就是四条直线）
        curveOf(im) {
            const g = (im && im.grade) || null;
            return (g && g.curve) || null;
        },

        // 拖动中的即时曲线数据。放在 _curveLive 而不是 im.grade.curve 里：
        // 烘焙被 rAF 节流后（见 _bindCurvePointer），im.grade 里还是上一次的值，
        // 而 curvePoints 被 pointerdown 用来算「刚加的点现在排第几」——
        // 读到旧数据就会算错索引（症状：加点后拖动时抓错控制点）。
        // 数据立即更新、只推迟重烘焙：手感与正确性都不受影响。
        curvePoints(chan) {
            const live = this._curveLive;
            if (live && live.chan === chan) {
                return live.pts.map((p) => [p[0], p[1]]);
            }
            const cv = this.curveOf(this.image);
            const pts = cv && cv[chan];
            return pts ? pts.map((p) => [p[0], p[1]]) : [[0, 0], [1, 1]];
        },

        setCurve(chan, pts) {
            const im = this.image;
            if (!im) return false;
            const base = this.gradeOf(im);
            const cv = Object.assign({}, base.curve || {});
            const norm = window.QfsCurve.sanitizeCurve({ [chan]: pts });
            if (norm && norm[chan]) cv[chan] = norm[chan];
            else delete cv[chan];
            // 只剩直线就整份清掉，别把直线的控制点塞进草稿
            let any = false;
            for (const c of window.QfsCurve.CHANS) {
                if (cv[c.k] && !window.QfsCurve.isLinear(cv[c.k])) any = true;
            }
            return this.setGrade({ curve: any ? cv : null });
        },

        resetCurve() {
            const im = this.image;
            if (!im) return false;
            const r = this.setGrade({ curve: null });
            this.drawCurve();
            this.setStatus('已重置曲线');
            return r;
        },

        syncCurveUI() { this.drawCurve(); },

        // 曲线背后的直方图衬底数据：复用现成的 QfsHistogram.statsOf（与顶部直方图同口径）。
        // im 引用变化时即失效；拖曲线过程中锁成缓存（用输入分布做参考，避免每帧重采像素）；
        // 拖别的调色钮时按 160ms 节流重采，直方图会跟着变。
        getCurveHisto() {
            const im = this.image;
            if (!im || !window.QfsHistogram) return null;
            const now = (window.performance && performance.now) ? performance.now() : Date.now();
            const cache = this._curveHistoCache;
            if (cache && cache.im === im) {
                if (this._curveDragging) return cache.stats;
                if (now - (cache.t || 0) < 160) return cache.stats;
            }
            let stats = null;
            try { stats = window.QfsHistogram.statsOf(im); } catch (_) { /* 取不到直方图就只画曲线 */ }
            this._curveHistoCache = { im: im, stats: stats, t: now };
            return stats;
        },

        // ── 绘制 ──
        drawCurve() {
            const d = this._curveDom;
            if (!d || !d.canvas) return;
            const css = getComputedStyle(document.documentElement);
            const v = (n, f) => (css.getPropertyValue(n) || f).trim() || f;
            const line = v('--text', '#333'), grid = v('--border', '#ddd'),
                primary = v('--primary', '#4a8');
            const chanColor = { rgb: line, r: '#e0575b', g: '#4caf6d', b: '#4a86d8' };

            // 面板未布局 / 还隐藏时 clientWidth、clientHeight 为 0。这时候退到兜底尺寸
            // （旧逻辑 260×176）建位图，等 CSS 把画布拉成真实宽度，正圆就被横向拉成椭圆，
            // 且之后未必有「可见且尺寸真实」的重绘来纠正——表现为「第一次点开圆点椭圆」。
            // 所以尺寸为 0 时干脆不画，交给 initCurve 里的 ResizeObserver：面板一可见、
            // 拿到真实尺寸就自动重画，圆点永远是正圆。
            const w = d.canvas.clientWidth;
            const h = d.canvas.clientHeight;
            if (!w || !h) return;
            const dpr = Math.min(3, window.devicePixelRatio || 1);
            if (d.canvas.width !== Math.round(w * dpr) || d.canvas.height !== Math.round(h * dpr)) {
                d.canvas.width = Math.round(w * dpr);
                d.canvas.height = Math.round(h * dpr);
            }
            const g = d.ctx;
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, w, h);
            const pad = 8;
            const X = (px) => pad + px * (w - pad * 2);
            const Y = (py) => h - pad - py * (h - pad * 2);
            const cur = this._curveChan || 'rgb';

            // 直方图衬底：当前通道的输入色调分布，x 轴与曲线对齐（x = 输入亮度）。
            // 拖曲线时 _curveDragging 为真 → 用缓存里的输入分布做参考，不每帧重采像素；
            // 拖别的调色钮时按 160ms 节流重采，直方图会跟着变。
            const st = this.getCurveHisto();
            if (st) {
                const arr = cur === 'rgb' ? st.y : st[cur];
                if (arr && arr.length) {
                    let mx = 1;
                    for (let i = 0; i < arr.length; i++) if (arr[i] > mx) mx = arr[i];
                    const bins = arr.length;
                    const baseY = Y(0), plotH = baseY - Y(1);
                    g.beginPath();
                    g.moveTo(X(0), baseY);
                    for (let i = 0; i < bins; i++) {
                        const f = Math.pow(arr[i] / mx, 0.55); // 提升低值可见度，避免暗部糊成一条
                        g.lineTo(X(i / (bins - 1)), baseY - f * plotH);
                    }
                    g.lineTo(X(1), baseY);
                    g.closePath();
                    g.fillStyle = cur === 'rgb' ? line : chanColor[cur];
                    g.globalAlpha = 0.16;
                    g.fill();
                    g.globalAlpha = 1;
                }
            }

            // 网格 4×4
            g.strokeStyle = grid;
            g.lineWidth = 1;
            g.beginPath();
            for (let i = 1; i < 4; i++) {
                const t = i / 4;
                g.moveTo(Math.round(X(t)) + 0.5, pad);
                g.lineTo(Math.round(X(t)) + 0.5, h - pad);
                g.moveTo(pad, Math.round(Y(t)) + 0.5);
                g.lineTo(w - pad, Math.round(Y(t)) + 0.5);
            }
            g.globalAlpha = 0.55;
            g.stroke();
            g.globalAlpha = 1;
            // 边框
            g.strokeRect(pad + 0.5, pad + 0.5, w - pad * 2 - 1, h - pad * 2 - 1);

            // 先画其它通道（淡淡的），再画当前通道
            for (const c of window.QfsCurve.CHANS) {
                if (c.k === cur) continue;
                const pts = this.curvePoints(c.k);
                // 「显示所有曲线」开启时，连线性（对角线）通道也画出来；否则只画调过的
                if (!this._curveShowAll && window.QfsCurve.isLinear(pts)) continue;
                g.strokeStyle = chanColor[c.k];
                g.globalAlpha = 0.28;
                g.lineWidth = 1.4;
                this._strokeCurve(g, pts, X, Y);
                g.globalAlpha = 1;
            }
            // 当前通道
            const pts = this.curvePoints(cur);
            g.strokeStyle = cur === 'rgb' ? primary : chanColor[cur];
            g.lineWidth = 2;
            this._strokeCurve(g, pts, X, Y);

            // 控制点
            for (let i = 0; i < pts.length; i++) {
                const px = X(pts[i][0]), py = Y(pts[i][1]);
                g.beginPath();
                g.arc(px, py, 4, 0, Math.PI * 2);
                g.fillStyle = cur === 'rgb' ? primary : chanColor[cur];
                g.fill();
                g.strokeStyle = v('--surface', '#fff');
                g.lineWidth = 1.5;
                g.stroke();
            }
            if (d.wrap) d.wrap.classList.toggle('curve-on', this._curveDirty());
        },

        _strokeCurve(g, pts, X, Y) {
            const lut = window.QfsCurve.monotoneTable(pts);
            g.beginPath();
            for (let i = 0; i < window.QfsCurve.N; i++) {
                const x = X(i / (window.QfsCurve.N - 1));
                const y = Y(lut[i]);
                if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.stroke();
        },

        _curveDirty() {
            const cv = this.curveOf(this.image);
            return window.QfsCurve.curveActive(cv);
        },

        // ── 鼠标：拖动 / 加点 / 双击删点 ──
        _bindCurvePointer(el) {
            const self = this;
            let drag = -1;
            const pos = (e) => {
                const r = el.getBoundingClientRect();
                const pad = 8;
                const w = r.width - pad * 2, h = r.height - pad * 2;
                return {
                    x: self.QfsClamp01((e.clientX - r.left - pad) / Math.max(1, w)),
                    y: self.QfsClamp01(1 - (e.clientY - r.top - pad) / Math.max(1, h)),
                    px: e.clientX - r.left, py: e.clientY - r.top
                };
            };
            const hitTest = (p) => {
                const pts = self.curvePoints(self._curveChan);
                const r = el.getBoundingClientRect();
                const pad = 8;
                const X = (v) => pad + v * (r.width - pad * 2);
                const Y = (v) => r.height - pad - v * (r.height - pad * 2);
                for (let i = 0; i < pts.length; i++) {
                    if (Math.abs(X(pts[i][0]) - p.px) <= HIT && Math.abs(Y(pts[i][1]) - p.py) <= HIT) return i;
                }
                return -1;
            };
            el.addEventListener('pointerdown', (e) => {
                // 只让左键(0)参与加点/拖拽：右键(2)、中键(1)一律不处理。
                // 否则右键在空白处会先触发 pointerdown 而「顺手」加一个控制点（右键只该弹通道菜单）。
                if (e.button > 0) return;
                const p = pos(e);
                self._closeCurveCtxMenu();
                self._curveDragging = true;
                let idx = hitTest(p);
                if (idx < 0) {
                    // 空白处按下 = 加一个点。必须立刻写回数据：
                    // 只改内存里的副本的话，这一下加的点在松手前并不存在，
                    // 随后的 pointermove 还会按旧索引去挪端点。
                    const pts = self.curvePoints(self._curveChan);
                    const nx = Math.max(0.01, Math.min(0.99, p.x));
                    pts.push([nx, p.y]);
                    pts.sort((a, b) => a[0] - b[0]);
                    // 加点是离散操作，立刻生效（不等 rAF）
                    self._curveLive = null;
                    self.setCurve(self._curveChan, pts);
                    // 写回后按 x 重新定位索引（sanitize 可能微调过坐标）
                    const after = self.curvePoints(self._curveChan);
                    let best = 0, bd = 1e9;
                    for (let i = 0; i < after.length; i++) {
                        const d = Math.abs(after[i][0] - nx);
                        if (d < bd) { bd = d; best = i; }
                    }
                    idx = best;
                }
                drag = idx;
                try { el.setPointerCapture(e.pointerId); } catch (_) { /* 老浏览器忽略 */ }
                self.drawCurve();
            });
            el.addEventListener('pointermove', (e) => {
                if (drag < 0) return;
                const p = pos(e);
                const pts = self.curvePoints(self._curveChan);
                const isFirst = drag === 0, isLast = drag === pts.length - 1;
                let x = p.x, y = p.y;
                // 端点不再把 x 锁死在 0 / 1：允许沿底部 / 顶部左右拉，用来设定黑场 / 白场
                // （Lightroom、Photoshop 的曲线端点就是这么用的）。约束只有一个：端点必须始终是
                // 「最左 / 最右」那个点——只卡在相邻点的内侧，留 0.01 余量（顺便避开 sanitize 的
                // 0.005 合并阈值），这样拖到半路也不会被排序挤掉端点身份、更不会越过邻居。
                if (isFirst) {
                    const hi = pts.length > 1 ? pts[1][0] - 0.01 : 1;
                    x = Math.max(0, Math.min(hi, x));
                } else if (isLast) {
                    const lo = pts.length > 1 ? pts[pts.length - 2][0] + 0.01 : 0;
                    x = Math.max(lo, Math.min(1, x));
                } else {
                    const lo = pts[drag - 1][0] + 0.01;
                    const hi = pts[drag + 1][0] - 0.01;
                    x = Math.max(lo, Math.min(hi, x));
                }
                pts[drag] = [x, y];
                // pts 是 curvePoints 返回的**副本**（它做了 map 拷贝），
                // 直接改它不会更新 _curveLive —— 必须重新写一份回去。
                // 数据立即落地（curvePoints 读它），重烘焙合并到下一帧：
                // 高回报率鼠标每秒能发上百次 pointermove，每次都走
                // setCurve → setGrade → 全链烘焙（1600px + 25³ 三维表合成），
                // 一帧内多次移动合并成一次就够，画面跟手且不空转。
                self._curveLive = { chan: self._curveChan, pts: pts.map((p) => [p[0], p[1]]) };
                if (!self._curveRaf) {
                    self._curveRaf = requestAnimationFrame(() => {
                        self._curveRaf = 0;
                        const live = self._curveLive;
                        if (live) self.setCurve(live.chan, live.pts);
                    });
                }
            });
            const up = () => {
                if (drag < 0) return;
                drag = -1;
                self._curveDragging = false;
                // 停手时把还没跑的那帧立刻烘掉（rAF 可能还没到），
                // 否则最后一次移动会晚一帧才生效
                if (self._curveRaf) {
                    cancelAnimationFrame(self._curveRaf);
                    self._curveRaf = 0;
                    const live = self._curveLive;
                    if (live) self.setCurve(live.chan, live.pts);
                }
                self._curveLive = null;
                // 停手后补全分辨率 + 重画缩略图（与滑块的静置逻辑一致）
                const im = self.image;
                if (im) {
                    if (self.rebuildGrade) self.rebuildGrade('full');
                    if (self.renderFramedThumb) setTimeout(() => self.renderFramedThumb(im), 240);
                }
            };
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
            el.addEventListener('dblclick', (e) => {
                const p = pos(e);
                const idx = hitTest(p);
                const pts = self.curvePoints(self._curveChan);
                // 两个端点不能删，否则曲线没有定义域
                if (idx > 0 && idx < pts.length - 1) {
                    pts.splice(idx, 1);
                    self.setCurve(self._curveChan, pts);
                }
            });
            // 右键：统一调出通道菜单（重置 / 复制粘贴 / 显示所有曲线）。
            // 按需求「右键不能做控制点」——右键不提供删除控制点的入口（删除改由双击控制点完成），
            // 曲线画布上任意位置右键都弹出通道级菜单，与控制点是否命中无关。
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                self._closeCurveCtxMenu();
                const cur = self._curveChan;
                self._openCurveCtxMenu(e.clientX, e.clientY, [
                    {
                        label: '重置该通道', onClick: () => {
                            self.setCurve(cur, [[0, 0], [1, 1]]);
                            self.setStatus('已重置「' + self._chanLabel(cur) + '」曲线');
                        }
                    },
                    { label: '重置所有通道', onClick: () => { self.resetCurve(); } },
                    { sep: true },
                    {
                        label: '复制通道设置', onClick: () => {
                            const src = self.curvePoints(cur);
                            // 深拷贝，避免后续拖动把缓冲也改了
                            self._curveCopyBuf = src.map((p) => [p[0], p[1]]);
                            self.setStatus('已复制「' + self._chanLabel(cur) + '」曲线');
                        }
                    },
                    {
                        label: '粘贴通道设置', disabled: !self._curveCopyBuf, onClick: () => {
                            if (!self._curveCopyBuf) return;
                            // 深拷贝，避免粘贴后拖动当前通道把缓冲也改了
                            self.setCurve(cur, self._curveCopyBuf.map((p) => [p[0], p[1]]));
                            self.setStatus('已把复制的曲线粘贴到「' + self._chanLabel(cur) + '」');
                        }
                    },
                    { sep: true },
                    {
                        label: '显示所有曲线', checked: !!self._curveShowAll, onClick: () => {
                            self._curveShowAll = !self._curveShowAll;
                            self.drawCurve();
                        }
                    }
                ]);
            });
        },

        _chanLabel(k) {
            const c = window.QfsCurve.CHANS.find((x) => x.k === k);
            return c ? c.label : k;
        },

        // 轻量右键菜单：复用同一个浮层元素，自动处理定位、越界、外部点击 / Esc / resize 关闭
        _openCurveCtxMenu(x, y, items) {
            this._closeCurveCtxMenu();
            const menu = document.createElement('div');
            menu.className = 'curve-ctx-menu';
            items.forEach((it) => {
                if (it.sep) {
                    const sep = document.createElement('div');
                    sep.className = 'curve-ctx-sep';
                    menu.appendChild(sep);
                    return;
                }
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'curve-ctx-item' + (it.checked ? ' checked' : '') + (it.disabled ? ' is-disabled' : '');
                row.textContent = it.label;
                if (it.disabled) {
                    row.disabled = true;
                    row.setAttribute('aria-disabled', 'true');
                } else {
                    row.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        this._closeCurveCtxMenu();
                        it.onClick();
                    });
                }
                menu.appendChild(row);
            });
            document.body.appendChild(menu);
            const mw = menu.offsetWidth, mh = menu.offsetHeight;
            menu.style.left = Math.min(x, window.innerWidth - mw - 6) + 'px';
            menu.style.top = Math.min(y, window.innerHeight - mh - 6) + 'px';
            this._curveMenu = menu;
            const close = (ev) => {
                if (ev.type === 'keydown' && ev.key === 'Escape') this._closeCurveCtxMenu();
                else if (ev.type === 'resize') this._closeCurveCtxMenu();
                else if (!this._curveMenu || !this._curveMenu.contains(ev.target)) this._closeCurveCtxMenu();
            };
            // 用 capture 在第一个 pointerdown 就拦下，避免点菜单项时先触发别处的隐藏逻辑
            document.addEventListener('pointerdown', close, true);
            document.addEventListener('keydown', close, true);
            window.addEventListener('resize', close, true);
            menu._closers = close;
        },

        _closeCurveCtxMenu() {
            const m = this._curveMenu;
            if (!m) return;
            if (m._closers) {
                document.removeEventListener('pointerdown', m._closers, true);
                document.removeEventListener('keydown', m._closers, true);
                window.removeEventListener('resize', m._closers, true);
            }
            if (m.parentNode) m.parentNode.removeChild(m);
            this._curveMenu = null;
        },

        QfsClamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    });
})();

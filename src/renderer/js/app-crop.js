// 照片裁切工具：工具栏「裁切」→ 全屏弹层里拖框 → 应用后把 im.el 换成裁好的位图。
//
// 交互与几何参考 we-cropper（github.com/we-plugin/we-cropper）：
//   · 遮罩用四块矩形拼出来（ctx.fillRect 四次），不整体 clip——整块 clip 后再 drawImage
//     在 Chromium 里会走裁剪慢路径，缩放照片还会出摩尔纹横线（engine.js 里也踩过同一个坑）；
//   · 越界一律夹回边界（we-cropper 的 outsideBound 是同一个思路，只是它夹图片、我们夹框）；
//   · 角标只画四个 L 形，不画完整描边，裁切框落在暗部照片上仍然看得清；
//   · 结果从原始位图按源坐标取，不从屏幕画布取——屏幕画布是 DPR 缩放过的，二次采样会糊。
//
// 与 we-cropper 的差别：它是「裁切框固定、拖图片」，这里是「图片固定、框自由」。
// 桌面端鼠标直接拉框更直觉，也不需要 pinch 缩放那套；比例锁定时改由锚点+宽高比反算另一条边。
const CROP_MIN_SRC = 8;      // 裁切框最小边长（源像素）
// 运行时标记：开发者工具控制台输入 QFS_CROP_ROTATE，返回下面这串才是带「四角旋转手柄」的进程。
// 返回 undefined 说明窗口还是改代码之前启动的，关掉重开 npm start 即可（页面不会热重载）。
window.QFS_CROP_ROTATE = 'corner-handles-v2-20261111';

window.App = Object.assign(window.App || {}, {
    initCrop() {
        const $ = (id) => document.getElementById(id);
        const dom = {
            overlay: $('cropModal'),
            stage: $('cropStage'), canvas: $('cropCanvas'),
            size: $('cropSize'), ratios: $('cropRatios'), ratioInp: $('cropRatioCustom'),
            angle: $('cropAngle'), angleVal: $('cropAngleVal'),
            rotate: $('cropRotate'), reset: $('cropRevert'), restoreOrig: $('cropRestoreOriginal'),
            cancel: $('cropDiscard'), apply: $('cropApply'), close: $('cropClose')
        };
        if (!dom.overlay || !dom.canvas) return;
        this._cropDom = dom;
        this._crop = { open: false };

        const btn = $('btnCrop');
        if (btn) btn.addEventListener('click', () => this.openCrop());
        const btnRestore = $('btnRestoreOriginal');
        if (btnRestore) btnRestore.addEventListener('click', () => this.restoreOriginalPhoto());
        if (dom.close) dom.close.addEventListener('click', () => this.closeCrop());
        if (dom.cancel) dom.cancel.addEventListener('click', () => this.closeCrop());
        if (dom.apply) dom.apply.addEventListener('click', () => this.applyCrop());
        if (dom.rotate) dom.rotate.addEventListener('click', () => this.rotateCropImage());
        // 任意角度拉直：滑块 -45°~45°，双击归零。90° 用上面的按钮（它同时写 RAW 的 rotate 参数）
        if (dom.angle) {
            dom.angle.addEventListener('input', () => this.setCropAngle(Number(dom.angle.value)));
            dom.angle.addEventListener('dblclick', () => this.setCropAngle(0));
        }
        if (dom.angleVal) dom.angleVal.addEventListener('dblclick', () => this.setCropAngle(0));
        if (dom.reset) dom.reset.addEventListener('click', () => this.resetCrop());
        if (dom.restoreOrig) dom.restoreOrig.addEventListener('click', () => this.restoreCropSource());
        // 点弹层空白（不是卡片）也算取消：和系统弹窗一致，别逼用户找按钮
        if (dom.overlay) {
            dom.overlay.addEventListener('mousedown', (e) => {
                if (e.target === dom.overlay) this.closeCrop();
            });
        }

        if (dom.ratios) {
            dom.ratios.addEventListener('click', (e) => {
                const chip = (e.target instanceof Element) ? e.target.closest('[' + 'data-r]') : null;
                if (!chip) return;
                this.setCropRatio(chip.dataset.r);
            });
        }
        // 自定义比例：回车生效，失焦也生效（值没变就不重算，见 applyCustomCropRatio）
        if (dom.ratioInp) {
            dom.ratioInp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!this.applyCustomCropRatio()) {
                        dom.ratioInp.classList.add('is-bad');
                    }
                }
            });
            dom.ratioInp.addEventListener('input', () => dom.ratioInp.classList.remove('is-bad'));
            dom.ratioInp.addEventListener('blur', () => {
                if (this._crop && this._crop.open) this.applyCustomCropRatio();
            });
        }

        // 鼠标：按下在 canvas，移动/抬起挂 window —— 拖出窗口再松手不能把状态留在"拖拽中"
        dom.canvas.addEventListener('mousedown', (e) => this._cropDown(e));
        window.addEventListener('mousemove', (e) => this._cropMove(e));
        window.addEventListener('mouseup', (e) => this._cropUp(e));

        // 弹层尺寸变化（窗口缩放 / 侧栏折叠）后 canvas 要跟着改，否则坐标全错
        if (typeof ResizeObserver === 'function' && dom.stage) {
            this._cropRO = new ResizeObserver(() => {
                if (!this._crop || !this._crop.open) return;
                if (this._cropRaf) return;
                this._cropRaf = requestAnimationFrame(() => {
                    this._cropRaf = 0;
                    this.layoutCrop();
                });
            });
            this._cropRO.observe(dom.stage);
        }
    },

    // 打开裁切：以当前照片的位图为底，框默认铺满整张（不做"看起来像选区"的假内缩，
    // 否则用户直接点应用就白丢 8% 画面）
    openCrop() {
        const im = this.image;
        if (!im || !im.el) { this.setStatus('请先导入照片'); return false; }
        if (this._crop && this._crop.open) return true;
        const W = im.el.naturalWidth || im.w || 0;
        const H = im.el.naturalHeight || im.h || 0;
        if (!W || !H) { this.setStatus('这张照片还没加载完成，稍等一下再裁切'); return false; }
        const d = this._cropDom;
        if (!d) return false;
        this._crop = {
            open: true, src: im.el, W, H,
            // sw/sh：底图本身的像素尺寸（不随旋转变）；W/H：旋转后的取景平面尺寸。
            // 角度为 0 且没转 90° 时两者相等，所有老逻辑照旧。
            sw: W, sh: H,
            angle: 0, anglePrev: null,
            box: { x: 0, y: 0, w: W, h: H },
            ratio: 0, ratioKey: 'free', customText: '',
            // 最小框边长：照片本身比 8px 还小时不能让下限比图还大
            minSide: Math.max(1, Math.min(CROP_MIN_SRC, W, H)),
            useOrig: false,
            // 弹层里转了几次 90°：只作用于这次裁切。RAW 要把这个次数一起算进显影参数，
            // 非 RAW 则直接烘进像素，不写回 im.rotate。
            turns: 0,
            drag: null, hover: null, viewW: 0, viewH: 0, fit: 1, ox: 0, oy: 0, dpr: 1
        };
        d.overlay.style.display = 'flex';
        if (d.ratioInp) { d.ratioInp.value = ''; d.ratioInp.classList.remove('is-bad', 'is-on'); }
        // RAW 的裁切是归一化显影参数（只认 90° 整数次），角度拉直没法无损记录，
        // 与其让用户拉完发现"应用不了"，不如一开始就说明白。
        if (d.angle) {
            const raw = !!im.raw;
            d.angle.disabled = raw;
            d.angle.title = raw
                ? 'RAW 的裁切是显影参数，只支持 90° 旋转；角度拉直请先导出为 JPEG 再处理'
                : '拖动拉直：把倾斜的地平线转正，也可以直接拖四角外侧的圆形手柄（-45°~45°，双击归零）';
            d.angle.value = '0';
        }
        // RAW 上四角旋转手柄是故意不画的，把工具条上的「角度」也写明原因，
        // 免得用户以为手柄没加载出来（这确实是「看不到手柄」的一种正常情况）。
        const angleLabel = document.querySelector('.crop-angle-label');
        if (angleLabel) angleLabel.textContent = im.raw ? '角度（RAW 不可用）' : '角度';
        this.setStatus(im.raw
            ? '裁切：RAW 只支持 90° 旋转，角度拉直请先导出为 JPEG'
            : '裁切：拖四角的绿色圆点旋转，拖白方块缩放，双击角度归零');
        this.syncCropAngle();
        this.syncCropChips();
        this.syncCropSize();
        this.syncCropOriginalBtn();
        // display:none → flex 之后读一次尺寸就会强制布局，所以这里同步量一次：
        // 只靠 rAF 的话，窗口被遮挡/后台时那一帧可能推迟，用户先看到一张没缩放的大图
        // （四角的旋转手柄还会画到画布外、点都点不到）。rAF 那次留着做第二遍校正 + 聚焦。
        this.layoutCrop();
        requestAnimationFrame(() => {
            if (!this._crop || !this._crop.open) return;
            this.layoutCrop();
            if (d.apply && d.apply.focus) { try { d.apply.focus({ preventScroll: true }); } catch (_) {} }
        });
        this._cropKey = (e) => this.onCropKey(e);
        document.addEventListener('keydown', this._cropKey, true);
        return true;
    },

    closeCrop(silent) {
        const d = this._cropDom;
        if (this._cropKey) {
            document.removeEventListener('keydown', this._cropKey, true);
            this._cropKey = null;
        }
        if (this._cropRaf) { cancelAnimationFrame(this._cropRaf); this._cropRaf = 0; }
        if (d && d.overlay) d.overlay.style.display = 'none';
        const wasOpen = !!(this._crop && this._crop.open);
        this._crop = { open: false };
        if (wasOpen && !silent) {
            const btn = document.getElementById('btnCrop');
            if (btn && btn.focus) { try { btn.focus({ preventScroll: true }); } catch (_) {} }
        }
        return wasOpen;
    },

    /* ══ 布局与绘制 ══ */
    layoutCrop() {
        const st = this._crop, d = this._cropDom;
        if (!st || !st.open || !d || !d.stage) return;
        // 取景平面 = 底图按当前角度（90° 倍数 + 拉直角）旋转后的包围盒。
        // 角度一变平面就变大，这里统一刷新，省得每个入口各算一遍。
        this.cropUpdatePlane();
        const rect = d.stage.getBoundingClientRect();
        const vw = Math.max(1, Math.round(rect.width));
        const vh = Math.max(1, Math.round(rect.height));
        const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const cv = d.canvas;
        if (cv.width !== Math.round(vw * dpr) || cv.height !== Math.round(vh * dpr)) {
            cv.width = Math.round(vw * dpr);
            cv.height = Math.round(vh * dpr);
        }
        cv.style.width = vw + 'px';
        cv.style.height = vh + 'px';
        st.viewW = vw; st.viewH = vh; st.dpr = dpr;
        // 图片等比放进裁切区（留出 38px 呼吸），小图允许放大——否则 300px 的小图在
        // 1000px 的弹层里只有指甲盖大，根本抠不准框。
        // 38 不是随手写的：四角旋转手柄沿 45° 外移最多 30×0.707≈21px、半径 11px，
        // 留 38px 才能保证正方形照片上那四个圆也不被画布边缘裁掉半个（最早 20px 时
        // 上下两个手柄正好画在画布外，点都点不到）。
        const pad = 38;
        let fit = Math.min((vw - pad * 2) / st.W, (vh - pad * 2) / st.H);
        if (!isFinite(fit) || fit <= 0) fit = 1;
        st.fit = Math.min(fit, 8);
        st.ox = (vw - st.W * st.fit) / 2;
        st.oy = (vh - st.H * st.fit) / 2;
        // 旋转后画面四角是空的：框越界就收回来，免得预览/导出出现透明角
        if (this.cropFitBoxToContent()) this.syncCropSize();
        this.drawCrop();
    },

    // 源像素 → 画布 CSS 像素（绘制、命中、指针换算共用一套，避免三处各算一遍）
    cropRectOnScreen(box) {
        const st = this._crop;
        const b = box || st.box;
        return {
            x: st.ox + b.x * st.fit,
            y: st.oy + b.y * st.fit,
            w: b.w * st.fit,
            h: b.h * st.fit
        };
    },

    // 四个角的旋转手柄：放在角的外侧，和角上那 4 个缩放手柄错开命中区
    // （重叠的话小框永远拖不到缩放）。偏移量跟着框的大小走：小框不至于把
    // 手柄甩到很远，大框又不会贴着角看不清。
    // RAW 的裁切是归一化显影参数、只认 90°，细角度存不进去（见 openCrop），
    // 所以这类照片干脆不画旋转手柄——不能让用户拖完一圈、点应用才被拒。
    cropRotateHandles() {
        const st = this._crop, d = this._cropDom;
        if (!st || !st.open || !st.box) return [];
        if (d && d.angle && d.angle.disabled) return [];
        const r = this.cropRectOnScreen();
        if (!(r.w > 0) || !(r.h > 0)) return [];
        // 沿屏幕 45° 斜向外放：和框的长宽比无关（长短边不一时手柄不会忽远忽近），
        // 再用画布余量夹一下——贴边的框也不会把手柄画到画布外、被裁掉一半。
        const off = Math.max(14, Math.min(30, Math.min(r.w, r.h) * 0.22 + 11)) * Math.SQRT1_2;
        const roomX = Math.min(r.x, st.viewW - (r.x + r.w));
        const roomY = Math.min(r.y, st.viewH - (r.y + r.h));
        const keep = 13;       // 手柄半径 11 + 2px 余量：贴着画布边也别被切掉
        const dx = Math.max(0, Math.min(off, roomX - keep));
        const dy = Math.max(0, Math.min(off, roomY - keep));
        return [
            ['nw', r.x, r.y, -1, -1], ['ne', r.x + r.w, r.y, 1, -1],
            ['se', r.x + r.w, r.y + r.h, 1, 1], ['sw', r.x, r.y + r.h, -1, 1]
        ].map(([key, x, y, sx, sy]) => ({
            key, x: x + sx * dx, y: y + sy * dy, r: 11
        }));
    },

    drawCrop() {
        const st = this._crop, d = this._cropDom;
        if (!st || !st.open || !d) return;
        const ctx = d.canvas.getContext('2d');
        const W = st.viewW, H = st.viewH;
        if (!W || !H) return;
        ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0D1211';
        ctx.fillRect(0, 0, W, H);
        // 底图：先整张画出来，再由遮罩把框外压暗（比"只画框内"更接近取景器手感）
        ctx.imageSmoothingQuality = 'high';
        const rad = this.cropAngleRad();
        if (rad) {
            // 绕取景平面中心转：平面尺寸本来就是旋转后的包围盒，转完正好铺满
            ctx.save();
            ctx.translate(st.ox + (st.W * st.fit) / 2, st.oy + (st.H * st.fit) / 2);
            ctx.rotate(rad);
            const dw = st.sw * st.fit, dh = st.sh * st.fit;
            ctx.drawImage(st.src, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();
        } else {
            ctx.drawImage(st.src, st.ox, st.oy, st.W * st.fit, st.H * st.fit);
        }

        const r = this.cropRectOnScreen();
        const bx = r.x, by = r.y, bw = r.w, bh = r.h;

        // 遮罩：四块矩形，避开裁剪态（见文件头注释）
        ctx.fillStyle = 'rgba(0,0,0,.58)';
        ctx.fillRect(0, 0, W, by);
        ctx.fillRect(0, by, bx, bh);
        ctx.fillRect(bx + bw, by, W - (bx + bw), bh);
        ctx.fillRect(0, by + bh, W, H - (by + bh));

        // 三分线：构图用的最轻提示，别抢框的视觉
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx, by, bw, bh);
        ctx.clip();
        ctx.strokeStyle = 'rgba(255,255,255,.22)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i <= 2; i++) {
            const gx = Math.round(bx + (bw * i) / 3) + .5;
            const gy = Math.round(by + (bh * i) / 3) + .5;
            ctx.moveTo(gx, by); ctx.lineTo(gx, by + bh);
            ctx.moveTo(bx, gy); ctx.lineTo(bx + bw, gy);
        }
        ctx.stroke();
        ctx.restore();

        // 框线 + 四个 L 角标（we-cropper 的 setBoundStyle 同款思路）
        ctx.strokeStyle = 'rgba(255,255,255,.62)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(bx) + .5, Math.round(by) + .5, Math.round(bw), Math.round(bh));
        const arm = Math.min(18, Math.max(8, Math.min(bw, bh) * 0.22));
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        // 左上
        ctx.moveTo(bx, by + arm); ctx.lineTo(bx, by); ctx.lineTo(bx + arm, by);
        // 右上
        ctx.moveTo(bx + bw - arm, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + arm);
        // 右下
        ctx.moveTo(bx + bw, by + bh - arm); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw - arm, by + bh);
        // 左下
        ctx.moveTo(bx + arm, by + bh); ctx.lineTo(bx, by + bh); ctx.lineTo(bx, by + bh - arm);
        ctx.stroke();

        // 8 个手柄：白方块 + 深描边，压在照片亮部也看得见
        const hs = 9;
        const pts = [
            [bx, by], [bx + bw / 2, by], [bx + bw, by],
            [bx + bw, by + bh / 2], [bx + bw, by + bh],
            [bx + bw / 2, by + bh], [bx, by + bh], [bx, by + bh / 2]
        ];
        for (const p of pts) {
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = 'rgba(0,0,0,.55)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.rect(p[0] - hs / 2, p[1] - hs / 2, hs, hs);
            ctx.fill();
            ctx.stroke();
        }

        // 四角旋转手柄：主色实心圆 + 深色顺时针箭头，再加一条从角连过去的细虚线。
        // 第一版是 17px 的深色圆 + 白细环，压在深色遮罩上太隐蔽，用户反馈「没看到」；
        // 现在用主题主色填满并放大到 22px，一眼就能把「这四个圆」和「裁切框的角」认成一组。
        if (!(d.angle && d.angle.disabled)) {
            if (!st.accent) {
                const cs = getComputedStyle(document.documentElement);
                st.accent = (cs.getPropertyValue('--primary') || '').trim() || '#3DD9B0';
            }
            const box = this.cropRectOnScreen();
            const corners = {
                nw: [box.x, box.y], ne: [box.x + box.w, box.y],
                se: [box.x + box.w, box.y + box.h], sw: [box.x, box.y + box.h]
            };
            ctx.save();
            ctx.lineCap = 'round';
            for (const h of this.cropRotateHandles()) {
                const hot = st.hover === 'rot-' + h.key;
                const R = h.r + (hot ? 1 : 0);
                // 角 → 手柄的引线：让人一眼看出这是「这个角」的手柄，不是漂浮的按钮
                const c = corners[h.key];
                const vx = h.x - c[0], vy = h.y - c[1];
                const len = Math.hypot(vx, vy) || 1;
                const ux = vx / len, uy = vy / len;
                ctx.setLineDash([2, 3]);
                ctx.beginPath();
                ctx.moveTo(c[0] + ux * 5, c[1] + uy * 5);
                ctx.lineTo(h.x - ux * (R + 2), h.y - uy * (R + 2));
                ctx.strokeStyle = hot ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.55)';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.setLineDash([]);
                // 圆：主色实心 + 深色描边，落在亮照片或暗遮罩上都跳得出来
                ctx.beginPath();
                ctx.arc(h.x, h.y, R, 0, Math.PI * 2);
                ctx.fillStyle = hot ? '#fff' : st.accent;
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = 'rgba(8,14,12,.75)';
                ctx.stroke();
                // 弧留一个缺口，末端补两笔当箭头
                const rr = R - 4.4;
                const a1 = Math.PI * 0.55;
                ctx.beginPath();
                ctx.arc(h.x, h.y, rr, -Math.PI * 0.62, a1);
                ctx.strokeStyle = '#10201B';
                ctx.lineWidth = 1.7;
                ctx.stroke();
                const ex = h.x + Math.cos(a1) * rr, ey = h.y + Math.sin(a1) * rr;
                const tx = -Math.sin(a1), ty = Math.cos(a1);
                const nx = Math.cos(a1), ny = Math.sin(a1);
                ctx.beginPath();
                ctx.moveTo(ex - tx * 4 - nx * 2.6, ey - ty * 4 - ny * 2.6);
                ctx.lineTo(ex, ey);
                ctx.lineTo(ex - tx * 4 + nx * 2.6, ey - ty * 4 + ny * 2.6);
                ctx.stroke();
            }
            ctx.restore();
        }
    },

    /* ══ 角度（拉直）几何 ══ */
    // 总旋转角 = 90° 整数次 + 拉直细角度。统一成一个弧度值，
    // 绘制、命中、应用三处都走它，避免某个环节漏掉 turns。
    cropAngleRad() {
        const st = this._crop;
        if (!st) return 0;
        const deg = (Number(st.turns) || 0) * 90 + (Number(st.angle) || 0);
        return (deg * Math.PI) / 180;
    },

    // 旋转后的包围盒（= 取景平面尺寸）。角度 0 时原样返回底图尺寸，
    // 所以老行为的每个数字都不会因为引入这个函数而漂移。
    cropPlaneSize(rad) {
        const st = this._crop;
        const w = (Number(st && st.sw) || 0) || (Number(st && st.W) || 0) || 1;
        const h = (Number(st && st.sh) || 0) || (Number(st && st.H) || 0) || 1;
        const c = Math.abs(Math.cos(rad || 0));
        const s = Math.abs(Math.sin(rad || 0));
        return { W: Math.max(1, w * c + h * s), H: Math.max(1, w * s + h * c) };
    },

    // 把取景平面尺寸刷新到当前角度。所有会改角度的地方都先调它再动框。
    cropUpdatePlane() {
        const st = this._crop;
        if (!st || !st.sw || !st.sh) return;
        const pl = this.cropPlaneSize(this.cropAngleRad());
        st.W = pl.W;
        st.H = pl.H;
    },

    // 取景平面坐标 → 底图坐标（逆变换）。应用裁切时按这个取向，
    // 预览时用它判断框有没有伸到旋转后的空白角里。
    cropPlaneToSource(x, y, rad) {
        const st = this._crop;
        const th = rad == null ? this.cropAngleRad() : rad;
        const cos = Math.cos(th), sin = Math.sin(th);
        const dx = x - st.W / 2, dy = y - st.H / 2;
        return {
            x: dx * cos + dy * sin + st.sw / 2,
            y: -dx * sin + dy * cos + st.sh / 2
        };
    },

    // 框是否完全落在旋转后的画面里。矩形是凸的、画面也是凸的，
    // 所以只要四角都在里面，整块就在里面。
    cropBoxInContent(box, rad) {
        const st = this._crop;
        if (!st) return false;
        const th = rad == null ? this.cropAngleRad() : rad;
        if (!th) return true;
        const pad = 0.5;
        const pts = [
            [box.x, box.y], [box.x + box.w, box.y],
            [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]
        ];
        for (const p of pts) {
            const s = this.cropPlaneToSource(p[0], p[1], th);
            if (s.x < -pad || s.y < -pad || s.x > st.sw + pad || s.y > st.sh + pad) return false;
        }
        return true;
    },

    // 框越界（角度变大 / 拖到角上）就绕中心等比收回来。
    // 用二分找最大可用缩放，不写闭式解：任何比例、任何角度都不用重新推导公式。
    cropFitBoxToContent() {
        const st = this._crop;
        if (!st || !st.open) return false;
        const w0 = st.box.w, h0 = st.box.h;
        if (!(w0 > 0) || !(h0 > 0)) return false;
        let cx = st.box.x + w0 / 2, cy = st.box.y + h0 / 2;
        cx = Math.max(0, Math.min(st.W, cx));
        cy = Math.max(0, Math.min(st.H, cy));
        const fits = (k) => {
            const w = w0 * k, h = h0 * k;
            const x = cx - w / 2, y = cy - h / 2;
            if (x < -0.01 || y < -0.01 || x + w > st.W + 0.01 || y + h > st.H + 0.01) return false;
            return this.cropBoxInContent({ x, y, w, h });
        };
        if (fits(1)) return false;
        // 极端情况（框贴在空白角上）：中心挪到画面正中再收
        if (!fits(0.001)) {
            cx = st.W / 2; cy = st.H / 2;
            if (!fits(0.001)) return false;
        }
        let lo = 0.001, hi = 1;
        for (let i = 0; i < 26; i++) {
            const mid = (lo + hi) / 2;
            if (fits(mid)) lo = mid; else hi = mid;
        }
        st.box = { x: cx - (w0 * lo) / 2, y: cy - (h0 * lo) / 2, w: w0 * lo, h: h0 * lo };
        return true;
    },

    setCropAngle(deg) {
        const st = this._crop, d = this._cropDom;
        if (!st || !st.open) return false;
        if (d && d.angle && d.angle.disabled) return false;
        let v = Number(deg);
        if (!isFinite(v)) v = 0;
        v = Math.round(Math.max(-45, Math.min(45, v)) * 10) / 10;
        if (v === (Number(st.angle) || 0)) { this.syncCropAngle(); return false; }
        st.angle = v;
        // 角度回调时，把上次为了腾地方缩掉的框还回去：调回 0 就恢复整张，
        // 而不是"拉直一次，画面永久小一圈"。用户中途拖过框就不还（否则会把他
        // 刚拖好的框放大），所以先比对一下框还是不是上次留下的那个。
        const prev = { x: st.box.x, y: st.box.y, w: st.box.w, h: st.box.h };
        const keep = st.anglePrev;
        const same = keep && ['x', 'y', 'w', 'h'].every((k) => Math.abs(prev[k] - keep.box[k]) < 0.6);
        if (same) {
            const cx = prev.x + prev.w / 2, cy = prev.y + prev.h / 2;
            st.box = { x: cx - keep.w0 / 2, y: cy - keep.h0 / 2, w: keep.w0, h: keep.h0 };
        }
        // 平面随角度变大，中心也跟着挪。框的坐标是平面坐标，不补偿的话
        // 整张框会相对照片偏掉（5° 时中心偏 24px，裁出来就是"取景器看着居中、
        // 结果偏了半格"）。按中心位移整体搬一下，框住的还是原来那块。
        const oldW = st.W, oldH = st.H;
        this.cropUpdatePlane();
        st.box.x += (st.W - oldW) / 2;
        st.box.y += (st.H - oldH) / 2;
        const preFit = { w: st.box.w, h: st.box.h };
        // 平面尺寸变了：重排取景（内部会把框收回画面、必要时刷新尺寸标签）
        this.layoutCrop();
        st.anglePrev = { box: { ...st.box }, w0: preFit.w, h0: preFit.h };
        this.syncCropAngle();
        this.drawCrop();
        return true;
    },

    syncCropAngle() {
        const d = this._cropDom, st = this._crop;
        if (!d || !d.angle || !st) return;
        const v = Number(st.angle) || 0;
        if (Number(d.angle.value) !== v) d.angle.value = String(v);
        if (d.angleVal) {
            d.angleVal.textContent = (v > 0 ? '+' : '') + (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') + '°';
        }
    },

    /* ══ 命中与拖拽 ══ */
    // 画布 CSS 坐标 → 源像素坐标（夹在图片范围内：框永远不许跑到照片外面）
    cropPointToSource(p) {
        const st = this._crop;
        const x = (p.x - st.ox) / (st.fit || 1);
        const y = (p.y - st.oy) / (st.fit || 1);
        return {
            x: Math.max(0, Math.min(st.W, x)),
            y: Math.max(0, Math.min(st.H, y))
        };
    },

    cropEventPoint(e) {
        const rect = this._cropDom.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },

    // 命中顺序：旋转手柄 > 缩放手柄 > 框内 > 框外（框外算"重新框选"，和 PS 一致）
    cropHitTest(p) {
        const st = this._crop;
        if (!st || !st.open) return null;
        // 旋转手柄优先：它在角的外侧，正常不会和缩放手柄重叠；
        // 框极小时两者会挤在一起，这时以旋转为准（否则小框永远转不动）
        for (const h of this.cropRotateHandles()) {
            if (Math.hypot(p.x - h.x, p.y - h.y) <= h.r + 3.5) return 'rot-' + h.key;
        }
        const r = this.cropRectOnScreen();
        const hs = 10;
        const near = (x, y) => Math.abs(p.x - x) <= hs && Math.abs(p.y - y) <= hs;
        if (near(r.x, r.y)) return 'nw';
        if (near(r.x + r.w, r.y)) return 'ne';
        if (near(r.x, r.y + r.h)) return 'sw';
        if (near(r.x + r.w, r.y + r.h)) return 'se';
        if (near(r.x + r.w / 2, r.y)) return 'n';
        if (near(r.x + r.w / 2, r.y + r.h)) return 's';
        if (near(r.x, r.y + r.h / 2)) return 'w';
        if (near(r.x + r.w, r.y + r.h / 2)) return 'e';
        if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) return 'move';
        return null;
    },

    cropCursor(hit) {
        if (!hit) return 'crosshair';
        if (hit === 'move') return 'move';
        if (hit.indexOf('rot-') === 0) return 'grab';
        if (hit === 'nw' || hit === 'se') return 'nwse-resize';
        if (hit === 'ne' || hit === 'sw') return 'nesw-resize';
        if (hit === 'n' || hit === 's') return 'ns-resize';
        return 'ew-resize';
    },

    _cropDown(e) {
        const st = this._crop;
        if (!st || !st.open || e.button !== 0) return;
        e.preventDefault();
        const p = this.cropEventPoint(e);
        const hit = this.cropHitTest(p);
        const src = this.cropPointToSource(p);
        if (hit) {
            if (hit.indexOf('rot-') === 0) {
                // 绕框中心转：记下按下的角度基准，move 时只算增量，
                // 中途框被收回也不会让角度跳一下
                const r = this.cropRectOnScreen();
                const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
                st.drag = {
                    mode: 'rotate', center,
                    a0: Math.atan2(p.y - center.y, p.x - center.x),
                    angle0: Number(st.angle) || 0
                };
                if (this._cropDom && this._cropDom.canvas) this._cropDom.canvas.style.cursor = 'grabbing';
                return;
            }
            st.drag = { mode: hit, start: src, box0: { x: st.box.x, y: st.box.y, w: st.box.w, h: st.box.h } };
            return;
        }
        // 框外按下 = 从这里重新框选（起始为 0 尺寸，move 时再撑开）
        st.drag = { mode: 'new', start: src, box0: { x: src.x, y: src.y, w: 0, h: 0 } };
        st.box = { x: src.x, y: src.y, w: 0, h: 0 };
        this.syncCropSize();
        this.drawCrop();
    },

    _cropMove(e) {
        const st = this._crop;
        if (!st || !st.open) return;
        const p = this.cropEventPoint(e);
        if (!st.drag) {
            const hit = this.cropHitTest(p);
            if (this._cropDom && this._cropDom.canvas) {
                this._cropDom.canvas.style.cursor = this.cropCursor(hit);
            }
            // 悬停在高亮手柄上时反色，否则用户看不出那是能拖的东西
            const hot = hit && hit.indexOf('rot-') === 0 ? hit : null;
            if (hot !== (st.hover || null)) { st.hover = hot; this.drawCrop(); }
            return;
        }
        const src = this.cropPointToSource(p);
        const mode = st.drag.mode;
        if (mode === 'rotate') {
            // 指针相对框中心转过的角度就是旋转量：顺时针拖 → 画面同向转（跟手）。
            // 夹到 ±45°、重算取景平面、把框收回画面全交给 setCropAngle，
            // 和工具条滑块走同一条路，两个入口永远不会算出两个结果。
            const a = Math.atan2(p.y - st.drag.center.y, p.x - st.drag.center.x);
            let deg = ((a - st.drag.a0) * 180) / Math.PI;
            while (deg > 180) deg -= 360;
            while (deg < -180) deg += 360;
            this.setCropAngle(st.drag.angle0 + deg);
            return;
        }
        if (mode === 'move') {
            const dx = src.x - st.drag.start.x;
            const dy = src.y - st.drag.start.y;
            const b0 = st.drag.box0;
            st.box.x = Math.max(0, Math.min(st.W - b0.w, b0.x + dx));
            st.box.y = Math.max(0, Math.min(st.H - b0.h, b0.y + dy));
        } else if (mode === 'new') {
            st.box = this.cropBoxFromDrag(st.drag.start, src);
        } else {
            st.box = this.cropBoxFromResize(mode, src, st.drag.box0);
        }
        this.syncCropSize();
        this.drawCrop();
    },

    _cropUp(e) {
        const st = this._crop;
        if (!st || !st.open || !st.drag) return;
        const minS = st.minSide || CROP_MIN_SRC;
        // 点一下没拖动（框外单击）会把框收成 0 尺寸 —— 按最小尺寸兜一下，别留一个点。
        // 旋转不改框的尺寸，这里必须跳过：否则角度一大、框被收回画面后
        // 会被误判成"小了"，一键弹回拖拽前的整张框。
        if (st.drag.mode !== 'rotate' && (st.box.w < minS || st.box.h < minS)) {
            st.box = st.drag.box0.w >= minS ? st.drag.box0 : this.cropBoxFromDrag(st.drag.start, {
                x: st.drag.start.x + minS, y: st.drag.start.y + minS
            });
        }
        st.drag = null;
        st.hover = null;
        this.cropFitBoxToContent();
        this.syncCropSize();
        this.drawCrop();
        // 松手后手柄可能已经随框缩走了，光标按当前位置重算，别留着"抓取中"
        if (e && e.clientX != null && this._cropDom && this._cropDom.canvas) {
            this._cropDom.canvas.style.cursor = this.cropCursor(this.cropHitTest(this.cropEventPoint(e)));
        }
    },

    // 框外拖拽：从起点到当前点归一化；锁比例时按较长边补成目标比例，
    // 补出来的部分顶出图片就整体缩回去（左上角不动，视觉上跟手）
    cropBoxFromDrag(a, b) {
        const st = this._crop;
        const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
        let w = Math.max(1, Math.abs(b.x - a.x));
        let h = Math.max(1, Math.abs(b.y - a.y));
        const r = st.ratio;
        if (r > 0) {
            if (w / h > r) h = w / r; else w = h * r;
            const k = Math.min(1, (st.W - x1) / w, (st.H - y1) / h);
            w *= k; h *= k;
        }
        return {
            x: Math.max(0, Math.min(x1, st.W - 1)),
            y: Math.max(0, Math.min(y1, st.H - 1)),
            w: Math.max(1, Math.min(w, st.W - x1)),
            h: Math.max(1, Math.min(h, st.H - y1))
        };
    },

    // 手柄缩放。自由比例：四个边各自夹紧、互不影响；锁定比例：以对边/对角为锚点，
    // 由拖拽方向的一条边反算另一条边，锚点不动（这样按住角拉时框不会"漂"）
    cropBoxFromResize(mode, p, box0) {
        const st = this._crop;
        const r = st.ratio;
        const minS = st.minSide || CROP_MIN_SRC;
        const hasW = mode.indexOf('w') >= 0, hasE = mode.indexOf('e') >= 0;
        const hasN = mode.indexOf('n') >= 0, hasS = mode.indexOf('s') >= 0;

        if (!(r > 0)) {
            let x1 = box0.x, y1 = box0.y, x2 = box0.x + box0.w, y2 = box0.y + box0.h;
            if (hasW) x1 = Math.max(0, Math.min(x2 - minS, p.x));
            if (hasE) x2 = Math.min(st.W, Math.max(x1 + minS, p.x));
            if (hasN) y1 = Math.max(0, Math.min(y2 - minS, p.y));
            if (hasS) y2 = Math.min(st.H, Math.max(y1 + minS, p.y));
            return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
        }

        const dirX = hasE ? 1 : (hasW ? -1 : 0);
        const dirY = hasS ? 1 : (hasN ? -1 : 0);
        // 锚点：有方向的轴用对边，没方向的轴用中线（左右手柄拉宽时上下对称扩张）
        const ax = dirX ? (dirX > 0 ? box0.x : box0.x + box0.w) : box0.x + box0.w / 2;
        const ay = dirY ? (dirY > 0 ? box0.y : box0.y + box0.h) : box0.y + box0.h / 2;
        let w = dirX ? Math.abs(p.x - ax) : Math.abs(p.y - ay) * r;
        // 可用空间：有方向的轴受锚点到边界限制；没方向的轴两侧都要放得下
        const spaceX = dirX ? (dirX > 0 ? st.W - ax : ax) : 2 * Math.min(ax, st.W - ax);
        const spaceY = dirY ? (dirY > 0 ? st.H - ay : ay) : 2 * Math.min(ay, st.H - ay);
        const maxW = Math.max(1, Math.min(spaceX, spaceY * r));   // 该比例下放得下的最大宽
        w = Math.max(Math.min(minS, maxW), Math.min(maxW, w));     // 下限不能超过上限
        const h = w / r;
        return {
            x: dirX ? (dirX > 0 ? ax : ax - w) : ax - w / 2,
            y: dirY ? (dirY > 0 ? ay : ay - h) : ay - h / 2,
            w, h
        };
    },

    /* ══ 比例 / 旋转 / 还原 ══ */
    // data-r：free / orig / 'w:h'。orig 取当前工作图的宽高比
    cropRatioValue(key) {
        const st = this._crop;
        if (!st || !st.open) return 0;
        if (!key || key === 'free') return 0;
        if (key === 'orig') return st.W / st.H;
        const m = String(key).split(':');
        const w = Number(m[0]), h = Number(m[1]);
        return (w > 0 && h > 0) ? w / h : 0;
    },

    setCropRatio(key) {
        const st = this._crop;
        if (!st || !st.open) return;
        // 点预设比例 = 放弃自定义输入框里的内容，否则"输入框还亮着、框却是 1:1"会自相矛盾
        if (this._cropDom && this._cropDom.ratioInp) this._cropDom.ratioInp.value = '';
        st.customText = '';
        this.applyCropRatioValue(this.cropRatioValue(key), key || 'free');
    },

    // 把「比例 = 宽/高」落到框上：切比例时框重置成该比例下能放的最大框并居中，
    // 这样 1:1 / 16:9 切换一眼能看出差别，而不是在原框上硬掰出一个歪比例。
    // 极端比例（100:1 之类）按"最短边不小于 minSide"夹一下，免得框被压成一条线。
    applyCropRatioValue(r, key) {
        const st = this._crop;
        if (!st || !st.open) return;
        const minS = st.minSide || CROP_MIN_SRC;
        let ratio = Number(r) > 0 ? Number(r) : 0;
        if (ratio > 0) {
            const maxR = st.W / minS;
            const minR = minS / st.H;
            ratio = Math.min(maxR, Math.max(minR, ratio));
        }
        st.ratio = ratio;
        st.ratioKey = key || 'free';
        if (ratio > 0) {
            const w = st.W / st.H > ratio ? st.H * ratio : st.W;
            const h = w / ratio;
            st.box = { x: (st.W - w) / 2, y: (st.H - h) / 2, w, h };
        }
        // 有拉直角时，最大框会顶到旋转后的空白角，收回来
        this.cropFitBoxToContent();
        this.syncCropChips();
        this.syncCropSize();
        this.drawCrop();
    },

    // 解析用户输入：5:7 / 16：9（全角）/ 16/9 / 2.35 / 1.5x2 都收
    parseCropRatio(text) {
        let s = String(text == null ? '' : text).trim();
        if (!s) return 0;
        s = s.replace(/：/g, ':').replace(/[×xX*]/g, ':').replace(/／/g, '/').replace(/\s+/g, '');
        const m = s.split(/[:/]/);
        if (m.length >= 2) {
            const w = Number(m[0]), h = Number(m[1]);
            if (w > 0 && h > 0 && isFinite(w) && isFinite(h)) return w / h;
            return 0;
        }
        const v = Number(s);
        return (v > 0 && isFinite(v)) ? v : 0;
    },

    // 输入框里的比例：回车或失焦生效。值没变就不重算（否则点「应用」时的 blur
    // 会把用户刚拖好的框又重置成最大框）
    applyCustomCropRatio() {
        const st = this._crop, d = this._cropDom;
        if (!st || !st.open || !d || !d.ratioInp) return false;
        const raw = d.ratioInp.value.trim();
        if (raw === (st.customText || '')) return false;
        const r = this.parseCropRatio(raw);
        if (!(r > 0)) {
            d.ratioInp.classList.add('is-bad');
            return false;
        }
        d.ratioInp.classList.remove('is-bad');
        st.customText = raw;
        this.applyCropRatioValue(r, 'custom');
        return true;
    },

    syncCropChips() {
        const d = this._cropDom;
        const st = this._crop;
        if (!d || !d.ratios || !st) return;
        for (const chip of d.ratios.querySelectorAll('[' + 'data-r]')) {
            const on = chip.dataset.r === (st.ratioKey || 'free');
            chip.classList.toggle('is-on', on);
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        if (d.ratioInp) {
            const custom = st.ratioKey === 'custom';
            d.ratioInp.classList.toggle('is-on', custom);
            if (!custom) d.ratioInp.classList.remove('is-bad');
        }
    },

    syncCropSize() {
        const d = this._cropDom, st = this._crop;
        if (!d || !d.size || !st || !st.open) return;
        const w = Math.max(1, Math.round(st.box.w));
        const h = Math.max(1, Math.round(st.box.h));
        // 分母用底图像素而不是取景平面：拉直后平面会比照片大一圈，
        // 拿它当分母会让"整张裁"显示成 60%，看着像平白丢了一小半。
        const base = (st.sw * st.sh) || (st.W * st.H) || 1;
        const pct = Math.round((w * h * 100) / base);
        d.size.textContent = w + ' × ' + h + ' px · ' + pct + '%';
    },

    // 旋转 90°：只记次数，不再把像素烘进一张新画布。
    // 以前这里是「转一次画一次」，好处是应用时直接按坐标取；代价是每转一次多一份
    // 位图拷贝，而且和拉直角叠加时会连转两次。现在绘制/应用都按 turns+angle 的
    // 总角度算，预览和应用走同一套几何，90° 和 0.5° 没有区别。
    rotateCropImage() {
        const st = this._crop;
        if (!st || !st.open) return;
        st.turns = ((Number(st.turns) || 0) + 1) % 4;
        // 先把平面换成新角度下的尺寸，再把框设成整张 —— 顺序反了会拿旧尺寸的框
        // 去套新平面，被当成"越界"白缩一圈（400×300 转完只剩 200×150）。
        this.cropUpdatePlane();
        st.box = { x: 0, y: 0, w: st.W, h: st.H };
        this.layoutCrop();
        if (st.ratio > 0) this.applyCropRatioValue(st.ratio, st.ratioKey);
        this.cropFitBoxToContent();
        this.syncCropSize();
        this.syncCropAngle();
        this.drawCrop();
    },

    resetCrop() {
        const st = this._crop, im = this.image;
        if (!st || !st.open || !im || !im.el) return;
        st.src = im.el;
        st.sw = im.el.naturalWidth || im.w || st.sw;
        st.sh = im.el.naturalHeight || im.h || st.sh;
        st.W = st.sw;
        st.H = st.sh;
        st.angle = 0;
        st.anglePrev = null;
        st.box = { x: 0, y: 0, w: st.W, h: st.H };
        st.ratio = 0;
        st.ratioKey = 'free';
        st.customText = '';
        st.useOrig = false;
        st.turns = 0;
        if (this._cropDom && this._cropDom.ratioInp) {
            this._cropDom.ratioInp.value = '';
            this._cropDom.ratioInp.classList.remove('is-bad');
        }
        this.syncCropChips();
        this.syncCropAngle();
        this.layoutCrop();
        this.syncCropSize();
    },

    /* ══ 原图备份 / 还原 ══ */
    // 第一次动位图（裁切或旋转）前把原始 Image 留一份。只留引用、不复制像素：
    // 解码后的位图本来就在内存里，多留一个引用几乎不增加开销，但能一键回到原图。
    // 只保留"最初那张"：连裁两次之后还原，回的仍然是最早的原图。
    savePhotoOrigin(im) {
        const t = im || this.image;
        if (!t || !t.el || t.orig) return false;
        // 几何操作日志以这张原图为重放起点；草稿恢复时已经带 ops，别清空。
        if (!t.geoOps) t.geoOps = [];
        t.orig = {
            el: t.el,
            w: t.el.naturalWidth || t.w || 0,
            h: t.el.naturalHeight || t.h || 0,
            // RAW 的还原不能只换回旧 el：裁切/旋转是显影参数，
            // 必须把当时的视图一起记住，重解时才不会把旋转/裁切丢掉。
            raw: t.raw ? {
                crop: t.raw.crop ? Object.assign({}, t.raw.crop) : null,
                rotate: ((Number(t.rotate) || 0) % 4 + 4) % 4
            } : null
        };
        return true;
    },

    // 恢复原始位图 / RAW 视图：工具栏「还原原图」和「重置全部」共用。
    // opts.skipGradeRebuild：紧接着还会重置调色，不必先全尺寸烘一遍旧参数。
    // opts.keepOrigin：重置全部要留着原图引用，否则 Ctrl+Z 无法重放裁切/旋转。
    // 返回是否真的还原了
    restoreOriginalPhoto(im, opts) {
        const t = im || this.image;
        if (!t || !t.orig || !t.orig.el) return false;
        // RAW：原图 = 最初的显影视图（裁切框 + 旋转次数），不是某一张旧位图。
        // 直接换回代理像素会把全尺寸和后续重解一起毁掉。
        if (t.raw && this.rawApplyUndo) {
            const v = t.orig.raw || { crop: null, rotate: 0 };
            if (!opts || !opts.keepOrigin) delete t.orig;
            t.thumb = null;
            t._thumbEl = null;
            t._tqAt = 0;
            if (this.buildThumbnails) this.buildThumbnails();
            this.rawApplyUndo(t, {
                params: this.rawParamsOf ? this.rawParamsOf(t) : Object.assign({}, t.raw.params),
                crop: v.crop,
                rotate: v.rotate
            });
            if (this.syncCropOriginalBtn) this.syncCropOriginalBtn();
            if (!opts || !opts.silent) this.setStatus('已还原为原图');
            return true;
        }
        t.el = t.orig.el;
        t.w = t.orig.w;
        t.h = t.orig.h;
        t.geoOps = [];           // 回到原图 = 几何操作日志清空，草稿/撤销都得同步
        t.rotate = 0;
        if (!opts || !opts.keepOrigin) delete t.orig;
        t.thumb = null;
        t._thumbEl = null;
        t._tqAt = 0;
        if (this.scheduleDraft) this.scheduleDraft();
        // 底图换了：调色缓存作废，参数保留 —— 渲染时在新底图上重放。
        // 不清的话 photoSrcOf 会优先返回旧烘焙画布（还是裁切前那张），
        // 用户看到的是「点了还原原图，画面纹丝不动」，导出的也是裁切图。
        if (this.invalidateGrade) this.invalidateGrade(t);
        if (this.rebuildGrade && !(opts && opts.skipGradeRebuild)) this.rebuildGrade('full');
        if (this.invalidateStyleCaches) this.invalidateStyleCaches();
        if (this.queueThumb) this.queueThumb(t);
        if (this.buildThumbnails) this.buildThumbnails();
        this.scheduleRender(true);
        this.syncCropOriginalBtn();
        if (!opts || !opts.silent) this.setStatus('已还原为原图');
        return true;
    },

    // 裁切弹层里的「还原原图」：不立刻落盘，只把工作底图换成原图，
    // 用户可以按原图重新框一次；直接点应用则等于撤销之前的裁切。
    restoreCropSource() {
        const st = this._crop, im = this.image;
        if (!st || !st.open || !im || !im.orig) return false;
        st.src = im.orig.el;
        st.sw = im.orig.w || im.orig.el.naturalWidth || st.sw;
        st.sh = im.orig.h || im.orig.el.naturalHeight || st.sh;
        st.W = st.sw;
        st.H = st.sh;
        st.angle = 0;
        st.anglePrev = null;
        st.minSide = Math.max(1, Math.min(CROP_MIN_SRC, st.W, st.H));
        st.box = { x: 0, y: 0, w: st.W, h: st.H };
        st.ratio = 0;
        st.ratioKey = 'free';
        st.customText = '';
        st.useOrig = true;
        st.turns = 0;
        if (this._cropDom && this._cropDom.ratioInp) {
            this._cropDom.ratioInp.value = '';
            this._cropDom.ratioInp.classList.remove('is-bad');
        }
        this.syncCropChips();
        this.syncCropAngle();
        this.layoutCrop();
        this.syncCropSize();
        this.setStatus('已切回原图，按原图重新框选后点应用；直接应用则撤销之前的裁切');
        return true;
    },

    // 「还原原图」有两处：右侧栏照片组（常驻入口）、裁切弹层（框内入口）。
    // 统一在这里按"当前照片有没有原始备份"决定显隐，避免两处各写一套判断。
    syncCropOriginalBtn() {
        const has = !!(this.image && this.image.orig);
        const d = this._cropDom;
        if (d && d.restoreOrig) d.restoreOrig.hidden = !has;
        const side = document.getElementById('btnRestoreOriginal');
        if (side) side.hidden = !has;
    },

    onCropKey(e) {
        const st = this._crop;
        if (!st || !st.open) return;
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            // 焦点在自定义比例输入框里：打字/退格归它，只有 Esc 仍然整体关闭
            if (e.key === 'Escape') { e.preventDefault(); this.closeCrop(); }
            return;
        }
        // 其余情况键盘全归我管：拦在捕获阶段，别让画布的 Delete/Esc 抢走
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); this.closeCrop(); return; }
        if (e.key === 'Enter') { e.preventDefault(); this.applyCrop(); return; }
        const step = e.shiftKey ? 10 : 1;
        let dx = 0, dy = 0;
        if (e.key === 'ArrowLeft') dx = -step;
        else if (e.key === 'ArrowRight') dx = step;
        else if (e.key === 'ArrowUp') dy = -step;
        else if (e.key === 'ArrowDown') dy = step;
        else return;
        e.preventDefault();
        const b = st.box;
        b.x = Math.max(0, Math.min(st.W - b.w, b.x + dx));
        b.y = Math.max(0, Math.min(st.H - b.h, b.y + dy));
        this.syncCropSize();
        this.drawCrop();
    },

    /* ══ 应用 ══ */
    async applyCrop() {
        const st = this._crop, im = this.image;
        if (!st || !st.open || !im) return false;
        // 拖到旋转后的空白角上再点应用会导出透明块：先收框，按收好的框裁
        this.cropFitBoxToContent();
        const x = Math.max(0, Math.round(st.box.x));
        const y = Math.max(0, Math.round(st.box.y));
        const w = Math.max(1, Math.min(st.W - x, Math.round(st.box.w)));
        const h = Math.max(1, Math.min(st.H - y, Math.round(st.box.h)));
        // 平面尺寸带小数（旋转后是包围盒），比整型尺寸时留一点容差
        const fullBox = x === 0 && y === 0
            && Math.abs(w - st.W) < 0.01 && Math.abs(h - st.H) < 0.01;
        const angled = !!(Number(st.angle) || 0) || !!(Number(st.turns) || 0);
        // 点了「还原原图」又没重新框、也没旋转：直接换回原图，别绕一圈重新编码
        if (st.useOrig && fullBox && !angled) {
            const ok = this.restoreOriginalPhoto(im, { silent: true });
            this.closeCrop(true);
            this.setStatus(ok ? '已还原为原图' : '没有改动，照片未做处理');
            return ok;
        }
        // 没动过框也没旋转：不重编码，避免"点一下应用，画质掉一层"
        const untouched = st.src === im.el && fullBox && !angled;
        if (untouched) {
            this.closeCrop(true);
            this.setStatus('没有改动，照片未做处理');
            return false;
        }
        // 换掉位图之前先留一份原图 + 压一次撤销快照（几何编辑可撤销，见 __geo）
        this.savePhotoOrigin(im);
        if (this.pushUndo) this.pushUndo();
        // RAW 不烘像素：把框记成归一化显影参数，再让主进程按原图重解。
        // 这样后面拖任何显影滑块都不会把裁切冲掉，导出也还是全尺寸。
        if (im.raw && this.rawRecordCrop) {
            if (Number(st.angle)) {
                this.setStatus('RAW 的裁切只支持 90° 旋转，角度拉直请先导出为 JPEG');
                return false;
            }
            const ok = await this.rawRecordCrop(im, st, { x, y, w, h });
            this.closeCrop(true);
            this.setStatus(ok ? '已更新 RAW 裁切，正在按新构图显影' : '裁切已记录，但显影失败，请稍后重试');
            this.syncCropOriginalBtn();
            return ok;
        }
        const rad = this.cropAngleRad();
        // 裁切也走共享几何函数：把这次的全部数值记成一条操作，撤销和草稿恢复
        // 都能从原图按序重放出同一张位图，不必再碰渲染/导出/拼图那五条消费链。
        const geoOp = {
            t: 'c', x, y, w, h, rad,
            sw: st.sw, sh: st.sh, W: st.W, H: st.H,
            reset: !!st.useOrig
        };
        const c = window.qfsGeoCrop
            ? window.qfsGeoCrop(st.src, geoOp, im.orig && im.orig.el)
            : null;
        if (!c) { this.setStatus('裁切失败：无法生成画布'); return false; }
        // 裁切同样是纯几何操作：画布直接当图源，不再 PNG 编码再重载。
        // 24MP 上那一次 toBlob 要 470ms 左右，而裁切本身是个位图拷贝。
        // alpha 也天然保留（以前用 JPEG 才会把透明区烘成黑块）。
        const out = window.qfsCanvasSource ? window.qfsCanvasSource(c) : await window.qfsCanvasImage(c);
        if (!out) { this.setStatus('裁切失败：无法生成图片'); return false; }

        im.el = out;                 // 渲染/导出/拼图都直接取 im.el，换掉即全面生效
        im.w = w;
        im.h = h;
        if (!im.geoOps) im.geoOps = [];
        im.geoOps.push(geoOp);
        // 缩略图必须重做：不清掉 thumb 的话 queueThumb 会认为"350ms 内刚做过"直接跳过
        im.thumb = null;
        im._thumbEl = null;
        im._tqAt = 0;
        this.closeCrop(true);
        if (this.invalidateStyleCaches) this.invalidateStyleCaches();
        // 位图已换，调色缓存失效；参数保留，立刻在新底图上重放（与"还原原图"一致）
        if (this.invalidateGrade) this.invalidateGrade(im);
        if (this.rebuildGrade) this.rebuildGrade('full');
        if (this.queueThumb) this.queueThumb(im);
        if (this.buildThumbnails) this.buildThumbnails();
        this.scheduleRender(true);
        if (this.scheduleDraft) this.scheduleDraft();
        this.setStatus('已裁切为 ' + w + ' × ' + h + '，导出与拼图都用这张');
        this.syncCropOriginalBtn();
        return true;
    }
});

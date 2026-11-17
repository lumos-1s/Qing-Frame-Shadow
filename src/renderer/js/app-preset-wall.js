// 预设墙启动主页：87 个预设的成片画廊（启动默认显示），点击卡片应用该预设并进入编辑模式。
// 编辑模式无左侧预设树（body.editing 隐藏 #sidebar）；工具栏「预设墙」按钮 / 工作台跳过入口可返回。
// 数据由 tools/gen-preset-wall.js 生成（assets/preset-wall/preset-wall-data.js + covers/）。
// 布局：Bravais 式无限磁贴墙 —— 单块周期网格（9 列 × 10 行 = 90 格，87 张预设循环填充），
// 拖动偏移在 [-周期宽,0]×[-周期高,0] 内取模回绕，墙"没有尽头"；视口中心附近卡片最大最亮。
const _pwWrap = (v, span) => {
    // 把 v 约束/回绕到 [-span, 0]：0 → 0（初始位置不动），超出回绕（墙无尽头）
    if (!span || span <= 0) return 0;
    const m = ((v % span) + span) % span; // 0..span-1
    return m === 0 ? 0 : m - span;
};
// 手感参数照抄 folia-major 的 src/components/wall/wallPanMotion.ts（同值，不另调）：
// - 拖动阈值 7px 才进入拖动，且**超过阈值才 setPointerCapture**（Folia 的 useWallPointerPan 同序）；
//   按下即 capture 会把 click 的 target 改写成容器，是"点一下就跳走"那批 bug 的根源。
// - 松手惯性：framer「inertia」，v*power 就是这一甩的行程，τ 决定尾巴多长。
// - 滚轮：鼠标滚轮按格累加后逐帧追（τ=80ms），触控板增量直接跟手。
// 卡片尺寸系数：1 = 原来的 340px 档（一屏约 3×3）。默认 0.85（一屏约 5 列）。
// 用户在首页顶部可以自己拖（0.55~1.3），选择存在 localStorage，下次开墙照用。
// 上限别再往上加：卡片大到周期块盖不住视口时，wallWrapSpan 虽然会兜住，但会失去无限感。
const WALL_CARD_SCALE_DEFAULT = 0.85;
const WALL_CARD_SCALE_MIN = 0.55;
const WALL_CARD_SCALE_MAX = 1.3;
// 聚焦缩放的更新节奏：中心格每帧；外圈 8 格按“边/角”分两帧更新，相当于每帧只动 5–7 张卡。
// 外圈单张卡仍有 82Hz，165Hz 屏上肉眼仍是连续缩放，但逐帧 scale 写入少一半。
// 保留开关便于回归对比：false = 原来的 9 格全部每帧。
const WALL_FOCUS_STAGGER = true;
// 浏览方式：'infinite' = 现在的周期磁贴墙（拖不到头，像永远看不完）；
// 'finite' = 同一批预设只铺一份、偏移夹在首尾之间（拖到头就停，右侧有进度条）。
// 用户可在墙头切换，选择写 localStorage —— 抱怨"不知道划没划过"的人下次开机还是有限墙。
const WALL_MODE_KEY = 'qfs_wall_mode';
const WALL_CARD_SCALE_KEY = 'qfs_wall_card_scale';
const _pwPanCfg = {
    dragThresholdPx: 7,
    // 点选容差：按下到抬起位移不超过它、且时间够短，就算一次点击（哪怕中途已经越过拖动阈值）。
    // 没有这条，手抖 8px 就会变成"拖动"并吞掉 click，用户看到的就是"点模板没反应"。
    clickSlopPx: 12,
    clickSlopMs: 450,
    inertia: { minSpeed: 40, maxSpeed: 4000, power: 0.3, timeConstantMs: 280, restDeltaPx: 0.5, staleReleaseMs: 80 },
    wheel: {
        timeConstantMs: 80, restDistancePx: 0.5, maxFrameMs: 50,
        lineHeightPx: 16, minNotchPx: 50, gestureGapMs: 120
    }
};
window.App = Object.assign(window.App || {}, {
    // 「本图预览」：用当前照片把每个预设离屏渲成缩略图。缓存按「当前图源 + 调色 + EXIF」失效，
    // 切换无限/有限墙时只重贴缓存，不重新跑 88 次引擎。
    _wallPhotoMode: false,
    _wallPhotoRunning: false,
    _wallPhotoToken: 0,
    _wallPhotoDone: 0,
    _wallPhotoTotal: 0,
    _wallPhotoCache: null,
    _wallPhotoElIds: null,
    _wallPhotoElSeq: 0,

    initPresetWall() {
        if (this._wallBound) return;
        this._wallBound = true;

        const $ = (id) => document.getElementById(id);
        const el = this._wallDom = {
            overlay: $('presetWall'),
            grid: $('presetWallGrid'),
            wall: null,   // wrapper：整墙 transform 平移
            block: null,  // 周期网格块（90 格）
            skip: $('pwSkip'),
            photo: $('pwPhoto'),
            mode: $('pwMode'),
            rail: $('pwRail'),
            back: $('btnBackWall'),
            backGroup: $('grpBack')
        };
        if (!el.overlay) return;

        if (el.skip) el.skip.addEventListener('click', () => this.closePresetWall(true));
        // 本图预览：用当前照片实时渲染整墙缩略图；没有照片时按钮隐藏。
        if (el.photo) el.photo.addEventListener('click', () => this.toggleWallPhotoMode());
        // 换封面：一键进入"封面编辑模式"——所有卡片的「换封面」按钮直接摆出来，
        // 点任意卡片选图即可，不用记文件名，也不用靠悬停去猜入口。
        // 想批量替换整个文件夹的仍走右键菜单里的「打开封面文件夹」。
        const coversBtn = $('pwCovers');
        if (coversBtn) coversBtn.addEventListener('click', () => this.toggleWallCoverMode());
        // 编辑页的「边框墙」按钮：**始终从封面进入**。
        // 之前这里默认开「本图预览」，用户带着照片回墙时会看到满墙都是自己那张照片的缩略图，
        // 第一反应是「我的预设墙图片被换了」——封面才是墙的身份，想看效果请点墙头「本图预览」。
        if (el.back) el.back.addEventListener('click', () => this.openPresetWall(false));
        // 无限 / 有限 切换：一个委托监听，按钮状态由 syncWallModeUI 统一回写
        if (el.mode) {
            el.mode.addEventListener('click', (e) => {
                const btn = (e.target instanceof Element) ? e.target.closest('[data-wall-mode]') : null;
                if (!btn) return;
                this.setWallMode(btn.dataset.wallMode);
            });
        }
        this.bindWallZoom();
        // 165Hz 屏才启用“外圈隔帧”；60Hz 屏每帧都更新，否则外圈只有 30Hz，会看出阶梯。
        // 用 3 个 rAF 间隔取中位数，窗口被节流/高负载时测出大间隔就退回全量更新。
        this._wallHighRefresh = false;
        let hzLast = 0;
        const hzSamples = [];
        const measureHz = (t) => {
            if (hzLast) {
                hzSamples.push(t - hzLast);
                if (hzSamples.length >= 3) {
                    const sorted = hzSamples.slice().sort((a, b) => a - b);
                    this._wallHighRefresh = sorted[1] > 0 && sorted[1] < 11;
                    return;
                }
            }
            hzLast = t;
            requestAnimationFrame(measureHz);
        };
        requestAnimationFrame(measureHz);
        // 键盘：方向键移动选中（上下左右，周期内循环）、Enter / 空格触发卡片
        el.grid.addEventListener('keydown', (e) => {
            const dir = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
            if (dir) { e.preventDefault(); this.moveWallSelection(dir[0], dir[1]); return; }
            // C：给当前焦点卡片换封面（鼠标走卡片右上角按钮，键盘走这里）
            if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const t = e.target instanceof Element ? e.target.closest('.pw-tile') : null;
                if (!t) return;
                e.preventDefault();
                this.pickWallCoverFor(t);
                return;
            }
            // Esc：退出封面编辑模式
            if (e.key === 'Escape' && this._coverMode) { e.preventDefault(); this.toggleWallCoverMode(false); return; }
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const tile = e.target.closest('.pw-tile');
            if (!tile) return;
            e.preventDefault();
            this.enterEditorFromWall(tile.dataset.idx);
        });
        // Tab / 程序化聚焦卡片时，旧内核可能把 grid 滚到卡片位置；只在聚焦事件上清一次。
        // 平移热路径里不再每帧读 scrollLeft/scrollTop（那会强制同步布局）。
        el.grid.addEventListener('focusin', () => {
            requestAnimationFrame(() => this.resetWallScroll());
        });
        // Bravais 式无限磁贴墙：周期块平铺 + 拖动取模回绕（无边界），视口中心卡片最显眼
        this._wallPan = { x: 0, y: 0 };   // 未回绕的平移累计（惯性/滚轮都往这里积分）
        this._wallOffsetX = 0;
        this._wallOffsetY = 0;
        this._wallBounds = null;
        this._wallSel = { r: 0, c: 0 };
        this._wallFocusTiles = new Set(); // 上一帧处于"中心聚焦"动态态的卡片（用于复位）
        this._wallMotion = 0;              // 惯性/滚轮的 rAF 句柄
        this._wallWheelPending = null;     // 滚轮还没走完的位移
        this._wallWheelFrame = 0;
        this._wallWheelGesture = { lastTime: -Infinity, source: null };
        this._wallSwallowClick = false;    // 点击已在 pointerup 处理过，随后补发的 click 要吞掉
        // 系统「减少动态效果」：惯性、3D 倾斜、入场淡入统统关掉，交互退化为直接定位。
        // 监听切换：用户中途改系统设置也立刻生效（顺手清掉正在倾斜的那张卡）。
        this._wallReduceMq = (window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null);
        this._wallReduceHandler = () => {
            if (!this.wallReducedMotion()) return;
            const t = this._wallTilt;
            if (t && t.card) { t.card.removeAttribute('data-tilting'); t.card = null; }
            if (t) { t.rx = 0; t.ry = 0; }
            this.focusWall(true);
        };
        if (this._wallReduceMq && this._wallReduceMq.addEventListener) {
            this._wallReduceMq.addEventListener('change', this._wallReduceHandler);
        }
        this._wallDrag = {
            id: null, startX: 0, startY: 0, panX: 0, panY: 0,
            lastX: 0, lastY: 0, lastT: 0, downT: 0, vx: 0, vy: 0, dragging: false
        };
        el.grid.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (e.isPrimary === false && e.pointerType) return; // 多指/次级指针交给主指针
            this.resetWallScroll();
            this.stopWallMotion();
            // 拖动期间不要让鼠标下那张卡继续保持 3D 倾斜：它会在每帧 scale 更新时
            // 带着 perspective 重新栅格化，是拖动帧耗时的一个大头。
            tiltRest();
            this._wallSwallowClick = false;
            const d = this._wallDrag;
            d.id = e.pointerId;
            d.startX = e.clientX; d.startY = e.clientY;
            d.panX = this._wallPan.x; d.panY = this._wallPan.y;
            d.lastX = e.clientX; d.lastY = e.clientY; d.lastT = e.timeStamp;
            d.downT = e.timeStamp;
            d.vx = 0; d.vy = 0; d.dragging = false;
            // 这里**不** setPointerCapture：按下时 capture 会把 pointerup/click 的 target
            // 重定向到容器，点击卡片就再也拿不到 .pw-tile。Folia 也是过了阈值才捕获。
        });
        // 卡片是 tabIndex=0 的可聚焦元素。不拦 mousedown 的默认动作，浏览器会在聚焦时
        // 把最近的滚动容器滚到该卡片——`.pw-grid` 虽然 overflow:hidden / clip，旧内核下它
        // 仍是可编程滚动容器，于是整墙视觉上瞬间"跳"到那张卡，而偏移量一动没动。
        // 只拦 mousedown 的默认聚焦：不影响 click，也不影响拖动。
        el.grid.addEventListener('mousedown', (e) => {
            // 只拦左键（避免聚焦时整墙跳位）。右键必须放行：preventDefault 会把
            // 随后的 contextmenu 一起吃掉，右键菜单就永远弹不出来。
            if (e.button !== 0) return;
            if (e.target instanceof Element && e.target.closest('.pw-tile')) e.preventDefault();
        });
        const endDrag = (e) => {
            const d = this._wallDrag;
            if (d.id === null || d.id !== e.pointerId) return;
            d.id = null;
            el.grid.classList.remove('pw-dragging');
            try { if (el.grid.hasPointerCapture(e.pointerId)) el.grid.releasePointerCapture(e.pointerId); } catch (_) {}
            if (e.type !== 'pointerup') { this._wallSwallowClick = false; this.focusWall('stale'); return; }
            const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
            const quick = e.timeStamp - d.downT <= _pwPanCfg.clickSlopMs;
            // 点选：位移在容差内且够快 → 当点击处理（并把这几像素的平移抹掉）。
            // 判定放在 pointerup 而不是 click 上，因为越过拖动阈值后浏览器补发的 click
            // 的 target 会被 pointer capture 改写成容器，拿不到卡片。
            if (dist <= _pwPanCfg.clickSlopPx && quick) {
                this.stopWallMotion();
                if (d.dragging) this.panWallTo(d.panX, d.panY);
                this._wallSwallowClick = true;
                const hit = document.elementFromPoint(e.clientX, e.clientY);
                const tile = (hit && hit.closest) ? hit.closest('.pw-tile') : null;
                if (tile) {
                    // 卡片右上角的「换封面」按钮命中就换封面；封面模式下整张卡都算入口
                    if (hit.closest('.pw-tile-coverbtn') || this._coverMode) this.pickWallCoverFor(tile);
                    else this.enterEditorFromWall(tile.dataset.idx);
                }
                return;
            }
            this._wallSwallowClick = false;
            if (!d.dragging) return;
            // 松手前已经停住（超过 staleReleaseMs 没再采样）就不滑行，免得"静止松手蹭出去一段"
            if (e.timeStamp - d.lastT > _pwPanCfg.inertia.staleReleaseMs) { this.focusWall('stale'); return; }
            this.coastWall(d.vx, d.vy);
            // 外圈隔帧可能把最后几格留在上一档；这里补一次没轮到的半圈。起了惯性也只是多跑一遍。
            this.focusWall('stale');
        };
        el.grid.addEventListener('pointerup', endDrag);
        el.grid.addEventListener('pointercancel', endDrag);
        // 指针在墙外抬起（没越过阈值所以没有 capture）时 grid 收不到 up，手势状态会卡住，
        // 之后滚轮和新的拖动全被挡。窗口兜底一次；重复调用由 d.id 判空挡住。
        const endOutside = (e) => { if (this._wallDrag.id !== null) endDrag(e); };
        window.addEventListener('pointerup', endOutside);
        window.addEventListener('pointercancel', endOutside);
        window.addEventListener('blur', () => this.stopWallMotion());
        // 右键卡片：更换封面 / 恢复默认 / 打开封面文件夹。
        // 不做原生菜单（主进程要额外一套），HTML 菜单够用，且和拼图槽位那套样式一致。
        el.grid.addEventListener('contextmenu', (e) => {
            const tile = e.target instanceof Element ? e.target.closest('.pw-tile') : null;
            if (!tile) return;
            e.preventDefault();
            this.openWallCoverMenu(tile, e.clientX, e.clientY);
        });
        // 把图片从资源管理器拖到某张卡上 = 换这张的封面。
        // 预设墙没有别的拖放行为（导入照片的拖放只绑在编辑区画布上），不会打架。
        let dropTile = null;
        const clearDrop = () => {
            if (dropTile) { dropTile.classList.remove('pw-drop-target'); dropTile = null; }
        };
        el.grid.addEventListener('dragover', (e) => {
            const tile = e.target instanceof Element ? e.target.closest('.pw-tile') : null;
            if (!tile) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            if (dropTile !== tile) { clearDrop(); dropTile = tile; tile.classList.add('pw-drop-target'); }
        });
        el.grid.addEventListener('dragleave', (e) => {
            const tile = e.target instanceof Element ? e.target.closest('.pw-tile') : null;
            if (!tile || tile !== dropTile) return;
            const to = e.relatedTarget;
            if (to instanceof Node && tile.contains(to)) return;   // 在卡片内部移动，不算离开
            clearDrop();
        });
        el.grid.addEventListener('drop', (e) => {
            const tile = e.target instanceof Element ? e.target.closest('.pw-tile') : null;
            if (!tile) return;
            e.preventDefault();
            clearDrop();
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
            if (!files.length) return;
            const p = (window.qingframe && typeof window.qingframe.getPathForFile === 'function')
                ? window.qingframe.getPathForFile(files[0]) : null;
            if (!p) { this.setStatus('读不出这张图的路径，换用卡片右上角的「换封面」试试'); return; }
            this.pickWallCoverFor(tile, p);
        });

        // folia 式卡片倾斜：指针下的卡片朝指针方向 3D 倾斜，封面高光跟随指针
        // （机制同 folia exploreTilt；旋转角度并入 focusWall 的 transform，高光变量写 CSS）
        this._wallTilt = { raf: 0, card: null, x: 0, y: 0, rx: 0, ry: 0, lastPaint: 0, box: null };
        const within = (v) => Math.min(1, Math.max(-1, v));
        const tiltRest = () => {
            const t = this._wallTilt;
            if (!t.card) return; // 没有倾斜卡时不要白跑一次 focusWall
            const card = t.card;
            card.removeAttribute('data-tilting');
            t.card = null;
            t.rx = 0; t.ry = 0;
            t.box = null;
            t.lastPaint = 0;
            // 外圈卡不在 focusWall 的活动集里，直接恢复它的 2D scale，别让它留在 3D 姿态。
            const s = card.__s || 0.72;
            card.style.transform = 'scale(' + s.toFixed(3) + ')';
            card.__tf = card.style.transform;
        };
        const tiltLean = () => {
            const t = this._wallTilt;
            t.raf = 0;
            const card = t.card;
            if (!card || !card.isConnected) return;
            // 倾斜是装饰：60Hz 就够。165Hz 每帧重栅格 560px 封面会偶发 40ms+ 尖峰。
            const now = performance.now();
            if (now - (t.lastPaint || 0) < 15) { t.raf = requestAnimationFrame(tiltLean); return; }
            t.lastPaint = now;
            // 几何只在开始倾斜时量一次；每帧 getBoundingClientRect/offsetWidth 会强制布局。
            let box = t.box;
            if (!box) {
                const r = card.getBoundingClientRect();
                box = t.box = {
                    cx: r.left + r.width / 2, cy: r.top + r.height / 2,
                    hw: card.offsetWidth / 2 || 1, hh: card.offsetHeight / 2 || 1
                };
            }
            const ax = within((t.x - box.cx) / box.hw);
            const ay = within((t.y - box.cy) / box.hh);
            const deg = 8;
            t.rx = -ay * deg;
            t.ry = ax * deg;
            card.style.setProperty('--pw-hx', (((ax + 1) / 2) * 100).toFixed(2) + '%');
            card.style.setProperty('--pw-hy', (((ay + 1) / 2) * 100).toFixed(2) + '%');
            // 只写这一张卡的 transform，不再跑整遍 focusWall（其余卡的值都没变）。
            const s = card.__s || 1;
            card.style.transform = 'perspective(760px) scale(' + s.toFixed(3) + ') rotateX(' + t.rx.toFixed(2) + 'deg) rotateY(' + t.ry.toFixed(2) + 'deg)';
            card.__tf = card.style.transform;
        };
        // 合并处理：按住拖动 → 整墙平移（取模回绕）；未按住 → 卡片倾斜
        el.grid.addEventListener('pointermove', (e) => {
            const d = this._wallDrag;
            const b = this._wallBounds;
            if (d.id !== null && d.id === e.pointerId && b) {
                const dx = e.clientX - d.startX;
                const dy = e.clientY - d.startY;
                // 7px 阈值：手指/鼠标的微抖不算拖动，否则点击会被自己的抖动判成拖拽
                if (!d.dragging && Math.hypot(dx, dy) > _pwPanCfg.dragThresholdPx) {
                    d.dragging = true;
                    el.grid.classList.add('pw-dragging');
                    try { el.grid.setPointerCapture(e.pointerId); } catch (_) {}
                }
                // 采样松手速度（px/s）：惯性靠它，停住再松手由 staleReleaseMs 判掉
                const dt = e.timeStamp - d.lastT;
                if (dt > 0) {
                    d.vx = (e.clientX - d.lastX) / dt * 1000;
                    d.vy = (e.clientY - d.lastY) / dt * 1000;
                }
                d.lastX = e.clientX; d.lastY = e.clientY; d.lastT = e.timeStamp;
                if (d.dragging) {
                    this.panWallTo(d.panX + dx, d.panY + dy);
                    return;
                }
            }
            // 降级动效时不倾斜：3D 旋转是纯装饰，对前庭敏感的人是负担
            if (this.wallReducedMotion()) {
                if (this._wallTilt.card) tiltRest();
                return;
            }
            const t = this._wallTilt;
            const card = (e.target instanceof Element) ? e.target.closest('.pw-tile') : null;
            if (card !== t.card) {
                tiltRest();
                t.card = card;
                t.box = null;
                t.lastPaint = 0;
                if (card) card.setAttribute('data-tilting', '');
            }
            if (!card) return;
            t.x = e.clientX;
            t.y = e.clientY;
            if (!t.raf) t.raf = requestAnimationFrame(tiltLean);
        });
        el.grid.addEventListener('pointerleave', () => { tiltRest(); });
        // 点击：真正的手势已经在 pointerup 里判定并处理（那里才拿得到卡片），
        // 这里只负责两件事——吞掉补发的重复 click，以及处理没有 pointer 序列的合成 click。
        el.grid.addEventListener('click', (e) => {
            if (this._wallSwallowClick) {
                this._wallSwallowClick = false;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const tile = (e.target instanceof Element) ? e.target.closest('.pw-tile') : null;
            if (!tile) return;
            this.enterEditorFromWall(tile.dataset.idx);
        }, true);
        // 滚轮：Folia 的墙是可以用滚轮走的。鼠标滚轮按格累加后逐帧追（τ=80ms），
        // 触控板/高分辨率滚轮增量小、自带惯性，直接跟手，否则再平滑一次会发飘。
        el.grid.addEventListener('wheel', (e) => {
            // Ctrl / Cmd + 滚轮 = 缩放卡片（触控板 pinch 在 Chromium 里也是这个组合键）。
            // 必须 preventDefault，否则 Electron 会去做页面级缩放，整块 UI 跟着变大。
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                if (this._wallDrag.id !== null) return;
                let dy = e.deltaY;
                if (e.deltaMode === 1) dy *= 16;        // 按行 → px
                else if (e.deltaMode === 2) dy *= 120;  // 按页 → 约一格
                if (!isFinite(dy) || dy === 0) return;
                // 乘法步进：每 100px 约 ±10%；小增量（pinch）连续自然，且不会越界。
                const cur = (this._wallZoomTarget != null) ? this._wallZoomTarget : this.wallCardScale();
                this._wallZoomTarget = Math.min(WALL_CARD_SCALE_MAX, Math.max(WALL_CARD_SCALE_MIN,
                    cur * Math.exp(-dy * 0.001)));
                if (!this._wallWheelZoomRaf) {
                    this._wallWheelZoomRaf = requestAnimationFrame(() => {
                        this._wallWheelZoomRaf = 0;
                        const v = this._wallZoomTarget;
                        this._wallZoomTarget = null;
                        if (v == null) return;
                        this.setWallCardScale(v);
                        this.syncWallZoomUI();
                        if (this.setStatus) this.setStatus('卡片大小 ' + Math.round(v * 100) + '%');
                    });
                }
                return;
            }
            e.preventDefault();
            if (this._wallDrag.id !== null) return;
            tiltRest(); // 滚轮平移时同样撤掉 3D 倾斜卡，避免它跟着每帧重栅格
            const { dx, dy } = this.wallWheelDelta(e);
            if (this.wallReducedMotion()) {
                this.stopWallMotion();
                this.panWallTo(this._wallPan.x - dx, this._wallPan.y - dy);
                return;
            }
            if (this.wallWheelSource(e) === 'trackpad') {
                this.stopWallMotion();
                this.panWallTo(this._wallPan.x - dx, this._wallPan.y - dy);
                return;
            }
            // 只掐惯性，不清 pending：正在平滑的那段滚轮位移要接着累加，否则连滚会一顿一顿
            if (this._wallMotion) { cancelAnimationFrame(this._wallMotion); this._wallMotion = 0; }
            const pending = this._wallWheelPending || { x: 0, y: 0 };
            this._wallWheelPending = { x: pending.x - dx, y: pending.y - dy };
            this.smoothWallWheel();
        }, { passive: false });

        // 窗口变化时重排磁贴墙（周期尺寸 / 卡片尺寸 / 焦点状态自适应）
        this._wallResize = () => this.layoutWallTiles();
        window.addEventListener('resize', this._wallResize);
        // 用户去资源管理器丢完封面再回来：窗口拿到焦点就重新扫一遍封面目录
        this._wallFocusRefresh = () => { if (this._wallActive) this.refreshWallCovers(); };
        window.addEventListener('focus', this._wallFocusRefresh);

        this.renderPresetWall();
        // 开关状态按上次的选择回填（默认无限），进度条按模式显隐
        this.syncWallModeUI();
    },

    // 用户是否用过「换封面」（用过才值得每次开墙扫一遍目录）
    wallCoversEnabled() {
        try { return localStorage.getItem('qfs_wall_covers_on') === '1'; } catch (_) { return false; }
    },

    // 卡片大小（0.55~1.3，1 = 最早那版 340px 档）。首页顶部有滑块让用户自己拖，
    // 选完存 localStorage，下次开墙照用。缓存到 _wallCardScale，别每帧读 localStorage。
    wallCardScale() {
        if (typeof this._wallCardScale === 'number' && isFinite(this._wallCardScale)) return this._wallCardScale;
        let v = NaN;
        try { v = parseFloat(localStorage.getItem(WALL_CARD_SCALE_KEY)); } catch (_) { /* 隐私模式：按默认 */ }
        if (!isFinite(v)) v = WALL_CARD_SCALE_DEFAULT;
        this._wallCardScale = Math.min(WALL_CARD_SCALE_MAX, Math.max(WALL_CARD_SCALE_MIN, v));
        return this._wallCardScale;
    },

    setWallCardScale(v) {
        const s = Math.min(WALL_CARD_SCALE_MAX, Math.max(WALL_CARD_SCALE_MIN, Math.round(v * 100) / 100));
        const grid = this._wallDom && this._wallDom.grid;
        // 缩放前先记住视口中心是哪张卡
        const anchor = (grid && this._wallActive) ? this.wallCenterCell() : null;
        this._wallCardScale = s;
        try { localStorage.setItem(WALL_CARD_SCALE_KEY, String(s)); } catch (_) { /* 存不了也照样生效 */ }
        // 只改尺寸不用重建卡片节点：layoutWallTiles 会重写宽高和周期块偏移。
        if (!grid) return s;
        this.layoutWallTiles();
        // 再把刚才那张卡摆回视口中心：不这么做的话，缩放锚点是墙的坐标原点，
        // 每次拖动滑块画面都往右下角飘，越大的卡片飘得越远。
        if (anchor) this.centerWallOn(anchor.r, anchor.c, 'keep');
        return s;
    },

    // 当前浏览方式：'infinite' | 'finite'。缓存到 _wallMode，避免每帧读 localStorage。
    // 默认无限（老行为不变）；用户切过一次之后按他选的来，重启也记得。
    wallMode() {
        if (this._wallMode === 'finite' || this._wallMode === 'infinite') return this._wallMode;
        let v = '';
        try { v = localStorage.getItem(WALL_MODE_KEY) || ''; } catch (_) { /* 隐私模式：按默认 */ }
        this._wallMode = v === 'finite' ? 'finite' : 'infinite';
        return this._wallMode;
    },

    // 切换浏览方式：重排整墙（有限墙的格子数、份数都不一样），并把位移/选中复位。
    // 有限墙是有"第一屏"的，切过去停在墙中间就等于又让人找不着北。
    setWallMode(mode) {
        const next = mode === 'finite' ? 'finite' : 'infinite';
        const changed = next !== this.wallMode();
        this._wallMode = next;
        try { localStorage.setItem(WALL_MODE_KEY, next); } catch (_) { /* 存不了也照样生效 */ }
        this.syncWallModeUI();
        if (!changed) return false;
        this.stopWallMotion();
        const el = this._wallDom;
        if (el && el.grid) for (const t of el.grid.querySelectorAll('.pw-tile.selected')) t.classList.remove('selected');
        this._wallPan = { x: 0, y: 0 };
        this._wallOffsetX = 0;
        this._wallOffsetY = 0;
        this._wallSel = { r: 0, c: 0 };
        this._wallBounds = null;      // 让 renderPresetWall 按新模式重算几何
        this.renderPresetWall();
        return true;
    },

    // 开关状态 / 进度条显隐回写（初始化、切换、开墙时都走这里，避免两处各写一套）
    syncWallModeUI() {
        const mode = this.wallMode();
        const box = (this._wallDom && this._wallDom.mode) || document.getElementById('pwMode');
        if (box) {
            for (const btn of box.querySelectorAll('[data-wall-mode]')) {
                const on = btn.dataset.wallMode === mode;
                btn.classList.toggle('is-on', on);
                btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
        }
        const rail = (this._wallDom && this._wallDom.rail) || document.getElementById('pwRail');
        if (rail) rail.hidden = mode !== 'finite';
        this.updateWallRail();
        this.syncWallZoomUI();
        return mode;
    },

    // 卡片大小滑块：拖动 → 整墙按新尺寸重排。input 事件在快拖时一帧能来好几个，
    // 每个都去重排 360 张卡会掉帧，所以用 rAF 合并成「一帧最多排一次」。
    syncWallZoomUI() {
        const range = document.getElementById('pwZoomRange');
        if (!range) return;
        const pct = Math.round(this.wallCardScale() * 100);
        range.value = String(pct);
        const label = '卡片大小 ' + pct + '%';
        range.title = label;
        range.setAttribute('aria-valuetext', pct + '%');
        const box = document.getElementById('pwZoom');
        if (box) box.title = label + '（拖动调节，或在墙上按住 Ctrl / ⌘ 滚轮）';
    },

    bindWallZoom() {
        const range = document.getElementById('pwZoomRange');
        if (!range || range.dataset.bound === '1') return;
        range.dataset.bound = '1';
        this.syncWallZoomUI();
        range.addEventListener('input', () => {
            const pct = parseInt(range.value, 10);
            if (!isFinite(pct)) return;
            if (this._wallZoomRaf) return;
            this._wallZoomRaf = requestAnimationFrame(() => {
                this._wallZoomRaf = 0;
                this.setWallCardScale(pct / 100);
                this.syncWallZoomUI();
                if (typeof this.setStatus === 'function') this.setStatus('卡片大小 ' + pct + '%');
            });
        });
        // 键盘也能调（方向键 / PageUp·Down）：range 原生支持，只是要同步状态栏
        range.addEventListener('change', () => {
            if (typeof this.setStatus === 'function') this.setStatus('卡片大小 ' + range.value + '%');
        });
    },

    // 墙的几何：两种模式共用同一张 9×10 网格、同一套卡片尺寸 —— 切模式时墙不该"换个版面"，
    // 只该"有没有尽头"不同。无限墙把这张网格铺 2×2 份用于回绕；有限墙只铺 1 份、四边夹住。
    // （曾经让有限墙按视口算列数"刚好塞满"，结果横向没有可滑的余量、拖左右完全不动，
    //   同一块画布换个模式就少一个方向，用户第一反应就是"坏了"。）
    wallGeom(vw) {
        const pad = 28, gap = 24;
        const mode = this.wallMode();
        const base = Math.max(240, Math.min(340, Math.floor((vw - pad * 2 - gap * 2) / 4)));
        const tw = Math.round(base * this.wallCardScale());
        // 卡片 = 封面（按素材最宽比例 1.407 完整显示）+ 底部一条名称。
        // 图片区高度由 tw 推出来，所以 contain 之后四边几乎不留黑边；
        // 名称单独占一条，不会压住封面（封面是「照片+边框」的合成图，压上去就挡内容）。
        const th = Math.round(tw / 1.407) + 36;
        const data = window.PRESET_WALL;
        const n = (data && Array.isArray(data.items) && data.items.length) || 87;
        const P = 9;
        // 行数跟着预设数量长：固定 10 行时第 91 款预设永远挤不进 9×10 的格位，
        // 墙上就少一款（无限墙取模、有限墙直接跳过），用户以为预设没装上。
        const Q = Math.max(1, Math.ceil(n / P));
        return {
            mode, pad, gap, tw, th, P, Q, n,
            BW: pad * 2 + P * tw + (P - 1) * gap,
            BH: pad * 2 + Q * th + (Q - 1) * gap
        };
    },

    // 有限墙的位移夹取：内容比视口小就居中，比视口大就夹在 [视口-内容, 0]。
    // 无限墙不走这里（它取模回绕，根本没有边界）。
    clampWallPan(x, y) {
        const b = this._wallBounds;
        if (!b) return { x, y };
        const vw = this._wallViewW || 0, vh = this._wallViewH || 0;
        const one = (v, content, view) => {
            if (content <= view) return Math.round((view - content) / 2);
            return Math.max(view - content, Math.min(0, v));
        };
        return { x: one(x, b.BW, vw), y: one(y, b.BH, vh) };
    },

    // 进度条：滑块高度 = 视口/内容，位置 = 已滑过的比例。拖到顶/底时滑块贴边，
    // 用户一眼就能看出"到头了"还是"还有一半"。
    updateWallRail() {
        const rail = (this._wallDom && this._wallDom.rail) || document.getElementById('pwRail');
        if (!rail) return;
        const b = this._wallBounds;
        const grid = this._wallDom && this._wallDom.grid;
        if (!b || !grid || this.wallMode() !== 'finite') { rail.hidden = true; return; }
        rail.hidden = false;
        const bar = rail.firstElementChild;
        if (!bar) return;
        const vh = this._wallViewH || grid.clientHeight || 1;
        const scrollable = Math.max(0, b.BH - vh);
        const thumb = Math.max(6, Math.min(100, (vh / b.BH) * 100));
        const ratio = scrollable > 1 ? (-this._wallOffsetY) / scrollable : 0;
        bar.style.height = thumb.toFixed(2) + '%';
        bar.style.top = (Math.max(0, Math.min(1, ratio)) * (100 - thumb)).toFixed(2) + '%';
    },

    // 是否降级动效：系统「减少动态效果」开启时返回 true。
    // _wallReduceOverride 是给自动化用例的开关（可绕过系统设置直接断言降级行为）。
    wallReducedMotion() {
        if (this._wallReduceOverride !== null && this._wallReduceOverride !== undefined) {
            return !!this._wallReduceOverride;
        }
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    },

    // 旧内核把 overflow:clip 当 hidden，聚焦卡片时 scrollIntoView 会在 grid 上留下滚动偏移。
    // 不能在平移热路径里每帧读 scrollLeft/scrollTop：刚写过 transform 再读滚动量会强制同步布局，
    // 实测 applyWallTransform 会因此从 0.05ms 涨到 0.9ms/帧。只在可能产生偏移的事件上清一次。
    resetWallScroll() {
        const grid = this._wallDom && this._wallDom.grid;
        if (!grid) return;
        if (grid.scrollLeft || grid.scrollTop) { grid.scrollLeft = 0; grid.scrollTop = 0; }
    },

    // 应用整墙平移（wrapper transform）
    applyWallTransform() {
        const el = this._wallDom;
        const wall = el && el.wall;
        if (!wall) return;
        // 位移对齐到整设备像素（同 Folia 的 formatWorldTransform）：小数像素会让 Chromium
        // 每帧重栅格化整面墙，平移时会看到细密的抖动。
        const dpr = window.devicePixelRatio || 1;
        const snap = (v) => Math.round((v || 0) * dpr) / dpr;
        // 用 2D translate 而不是 translate3d：3D 变换会强制把整面墙提成一个合成层，
        // 3128×4272 在 DPR=2 下约 440MB 纹理，软件渲染每帧 blit 这个量级就是几十毫秒。
        // 2D 平移不建层，Chromium 只重绘视口内那十几张卡。
        wall.style.transform = 'translate(' + snap(this._wallOffsetX) + 'px, ' + snap(this._wallOffsetY) + 'px)';
        // 有限墙的进度条跟着位移走：写两个百分比，跟 buildWallTransform 同一次样式变更里完成
        if (this.wallMode() === 'finite') this.updateWallRail();
    },

    // 回绕跨度 = 一个完整周期 BW/BH。之所以能取满一个周期：墙渲染了 2×2 份相同的块，
    // 偏移落在 (-BW,0] 时总有某一份盖住视口 —— 于是回绕点两侧的画面完全一致（同一批格子同一批图），
    // 拖动时不会出现"跳到别处/像刷新"。之前用 BW-vw 是把块推出视口换来的，代价就是每次拖动都肉眼可见地换一遍内容。
    wallWrapSpan() {
        const b = this._wallBounds;
        if (!b) return { w: 1, h: 1 };
        return { w: Math.max(1, b.BW), h: Math.max(1, b.BH) };
    },

    // 平移到未回绕坐标 (x, y)：无限墙累加器保留原值、可见偏移取模回绕 —— 惯性和滚轮都走这里，
    // 这样两者叠加时不会因为回绕跳变而断掉速度。
    // 有限墙没有回绕：直接夹在首尾之间，连累加器一起夹 —— 否则松手惯性会在墙外继续"积攒"位移，
    // 往反方向拖时先要空走一段才动，手感像卡住。
    panWallTo(x, y) {
        const b = this._wallBounds;
        if (!b) return;
        if (this.wallMode() === 'finite') {
            const c = this.clampWallPan(x, y);
            this._wallPan = { x: c.x, y: c.y };
            this._wallOffsetX = c.x;
            this._wallOffsetY = c.y;
        } else {
            const span = this.wallWrapSpan();
            this._wallPan = { x, y };
            this._wallOffsetX = _pwWrap(x, span.w);
            this._wallOffsetY = _pwWrap(y, span.h);
        }
        // 倾斜卡片的几何缓存跟着墙一起失效；下一帧只重量一次。
        if (this._wallTilt) { this._wallTilt.box = null; this._wallTilt.lastPaint = 0; }
        this.applyWallTransform();
        this.focusWall();
    },

    // 停掉惯性 / 滚轮补间：按下、键盘、开关墙都要先停，否则会和新的输入抢相机
    stopWallMotion() {
        if (this._wallMotion) { cancelAnimationFrame(this._wallMotion); this._wallMotion = 0; }
        if (this._wallWheelFrame) { cancelAnimationFrame(this._wallWheelFrame); this._wallWheelFrame = 0; }
        this._wallWheelPending = null;
        const grid = this._wallDom && this._wallDom.grid;
        if (grid) grid.classList.remove('pw-moving');
    },

    // 松手惯性：v*power 是这一甩的总行程，指数衰减（τ=timeConstantMs）走完收敛到 restDeltaPx。
    coastWall(vx, vy) {
        if (this.wallReducedMotion()) return;   // 降级：松手即停，不滑行
        const cfg = _pwPanCfg.inertia;
        const speed = Math.hypot(vx, vy);
        if (!(speed >= cfg.minSpeed)) return;
        const clamped = Math.min(speed, cfg.maxSpeed);
        const ux = vx / speed, uy = vy / speed;
        const distance = clamped * cfg.power;
        const from = { x: this._wallPan.x, y: this._wallPan.y };
        const t0 = performance.now();
        const grid = this._wallDom && this._wallDom.grid;
        // 滑行期间关掉卡片过渡：每帧写 transform 时过渡会再拖出 180ms 尾巴
        if (grid) grid.classList.add('pw-moving');
        let moved = 0;
        const step = (now) => {
            const remain = distance * Math.exp(-(now - t0) / cfg.timeConstantMs);
            moved = distance - remain;
            this.panWallTo(from.x + ux * moved, from.y + uy * moved);
            if (distance - moved > cfg.restDeltaPx) {
                this._wallMotion = requestAnimationFrame(step);
            } else {
                this._wallMotion = 0;
                if (grid) grid.classList.remove('pw-moving');
                this.focusWall('stale'); // 停稳后补齐隔帧跳过的外圈，静态画面没有一档误差
            }
        };
        this._wallMotion = requestAnimationFrame(step);
    },

    // 滚轮来源判别（同 Folia 的 createWallWheelClassifier）：一次手势里出现过触控板特征，
    // 整次手势都按触控板算——否则快速一划会在惯性峰值被误判成鼠标滚轮。
    wallWheelSource(e) {
        const cfg = _pwPanCfg.wheel;
        const g = this._wallWheelGesture || (this._wallWheelGesture = { lastTime: -Infinity, source: null });
        const sameGesture = e.timeStamp - g.lastTime <= cfg.gestureGapMs;
        g.lastTime = e.timeStamp;
        if (!sameGesture) g.source = null;
        const axis = Math.max(Math.abs(e.deltaX), Math.abs(e.deltaY));
        const trackpad = e.deltaMode === 0 && ((e.deltaX !== 0 && e.deltaY !== 0) || axis < cfg.minNotchPx);
        if (trackpad) g.source = 'trackpad';
        else if (!g.source) g.source = 'wheel';
        return g.source;
    },

    // 滚轮增量换算成像素（按行/按页的模式补齐单位）
    wallWheelDelta(e) {
        const grid = this._wallDom && this._wallDom.grid;
        const k = e.deltaMode === 1 ? _pwPanCfg.wheel.lineHeightPx
            : e.deltaMode === 2 ? (grid ? grid.clientHeight : 800)
                : 1;
        return { dx: e.deltaX * k, dy: e.deltaY * k };
    },

    // 鼠标滚轮平滑：把还没走完的位移每帧追一段（指数逼近，τ=80ms），连续滚动是叠加不是覆盖。
    smoothWallWheel() {
        const cfg = _pwPanCfg.wheel;
        if (this._wallWheelFrame) return;
        const grid = this._wallDom && this._wallDom.grid;
        if (grid) grid.classList.add('pw-moving');
        let last = performance.now();
        const step = (now) => {
            this._wallWheelFrame = 0;
            const pending = this._wallWheelPending;
            if (!pending) { if (grid) grid.classList.remove('pw-moving'); return; }
            const dt = Math.min(cfg.maxFrameMs, Math.max(0, now - last));
            last = now;
            const k = 1 - Math.exp(-dt / cfg.timeConstantMs);
            const mx = pending.x * k, my = pending.y * k;
            pending.x -= mx; pending.y -= my;
            this.panWallTo(this._wallPan.x + mx, this._wallPan.y + my);
            if (Math.abs(pending.x) > cfg.restDistancePx || Math.abs(pending.y) > cfg.restDistancePx) {
                this._wallWheelFrame = requestAnimationFrame(step);
            } else {
                this.panWallTo(this._wallPan.x + pending.x, this._wallPan.y + pending.y);
                this._wallWheelPending = null;
                if (grid) grid.classList.remove('pw-moving');
                this.focusWall('stale'); // 滚轮停住后同样补齐外圈
            }
        };
        this._wallWheelFrame = requestAnimationFrame(step);
    },

    // Bravais 式周期布局：单块 9 列 × 10 行 = 90 格（87 张预设循环填充），整墙铺 2×2 份相同块，
    // 块宽高 BW/BH 均大于视口，偏移在 [-BW,0]×[-BH,0] 内取模回绕 → 无缝无限。
    // 有限墙则只有 1 份、网格不变，位移四边夹住（左右照样能拖，只是拖到头就停）。
    layoutWallTiles() {
        const el = this._wallDom;
        const grid = el && el.grid;
        const blocks = (el && el.blocks) || [];
        if (!grid || !blocks.length) return;
        this.resetWallScroll();
        if (this._wallTilt) { this._wallTilt.box = null; this._wallTilt.lastPaint = 0; }
        const vw = grid.clientWidth;
        if (vw <= 0) return;
        const b = this.wallGeom(vw);
        // 换模式要重建：无限 4 份拷贝、有限 1 份，节点数不一样（尺寸变了不用重建，下面会重写宽度）。
        // 用"渲染时记下的模式+行列数"比对，而不是数节点：重建后 layoutWallTiles 会再进来一次，
        // 这时 key 已经一致，不会无限递归。
        if (el.renderedKey !== b.mode + ':' + b.P + 'x' + b.Q) {
            this.renderPresetWall();
            return;
        }
        const { P, Q } = b;
        this._wallBounds = b;
        // 视口尺寸缓存：focusWall 每帧都要用，但 clientWidth/clientHeight 是布局读取；
        // 拖动时 pointermove 可能一帧触发多次，读一次就够，别让每帧都去问布局。
        this._wallViewW = vw;
        this._wallViewH = grid.clientHeight;
        blocks.forEach((block, i) => {
            block.style.width = b.BW + 'px';
            block.style.height = b.BH + 'px';
            block.style.gridTemplateColumns = 'repeat(' + P + ', ' + b.tw + 'px)';
            block.style.gridTemplateRows = 'repeat(' + Q + ', ' + b.th + 'px)';
            // 2×2：左上角一份在 (0,0)，右/下各偏移一个周期（多出来的两份专门用来填回绕边界）
            block.style.transform = 'translate(' + ((i % 2) * b.BW) + 'px, ' + (Math.floor(i / 2) * b.BH) + 'px)';
            const tiles = Array.from(block.querySelectorAll('.pw-tile'));
            for (const t of tiles) {
                t.style.width = b.tw + 'px';
                // 封面高度交给 CSS（撑满卡片）。老版本这里按整卡高设了内联 height，
                // 图片把卡片撑满、名称和标签被 overflow 裁掉——这里顺手清掉历史内联值。
                const img = t.querySelector('.pw-tile-cover img');
                if (img && img.style.height) img.style.height = '';
            }
        });
        // 偏移保持当前值（可为任意等价周期位置），拖动时由 pointermove 取模回绕
        this.applyWallTransform();
        this.focusWall(true);
    },

    // 中心聚焦：距离视口中心越近的卡片越大越亮（最中间的图片最显眼），
    // 越往四周越小越暗；倾斜角度（--pw tilt 状态）并入同一 transform。
    // force=true 时忽略外圈隔帧策略，用于布局/开墙/键盘跳转这种非连续动画；
    // force='stale' 只补上次隔帧没轮到的那半圈，用于运动停稳后的收尾（比全量省一半写入）。
    focusWall(force) {
        const settle = force === 'stale';
        const el = this._wallDom;
        const grid = el && el.grid;
        const block = el && el.block;
        if (!grid || !block) return;
        const b = this._wallBounds;
        if (!b) return;
        // 每个格子有 4 个节点（2×2 份拷贝），cells[key] 是节点数组
        const cells = (el && el.cells) || {};
        if (!el.cellsReady) return;
        if (settle && !this._wallFocusStaggered) return; // 上一次已经是全量，没有遗留
        // 视口尺寸用 layoutWallTiles 缓存的；这里不再读取 clientWidth/clientHeight，
        // 否则 pointermove 每次进来都可能强制一次布局。
        const vw = this._wallViewW || (this._wallViewW = grid.clientWidth);
        const vh = this._wallViewH || (this._wallViewH = grid.clientHeight);
        const cx = vw / 2, cy = vh / 2;
        const ox = this._wallOffsetX || 0, oy = this._wallOffsetY || 0;
        const cxw = cx - ox, cyw = cy - oy; // 视口中心在块坐标系中的位置（块坐标 p 的屏幕位置 = p + offset）
        const maxScale = 1.25, minScale = 0.72;
        const distNorm = Math.max(180, Math.min(b.tw, b.th) * 1.7);
        const tilt = this._wallTilt;
        const wrap = (v, n) => ((v % n) + n) % n;
        const finite = this.wallMode() === 'finite';
        const canStagger = WALL_FOCUS_STAGGER && !!this._wallHighRefresh;
        // 外圈隔帧的相位：同一帧里 pointermove 可能多次调用 focusWall，用时间门限保证一帧只翻一次。
        const tickNow = performance.now();
        if (canStagger && !force && tickNow - (this._wallFocusTickAt || 0) >= 5) {
            this._wallFocusTick = (this._wallFocusTick || 0) ^ 1;
            this._wallFocusTickAt = tickNow;
        }
        const focusTick = this._wallFocusTick || 0;
        const lastTick = this._wallFocusLastTick || 0;
        // 中心格：列（X 方向）用 tw，行（Y 方向）用 th。这里原来把两者算反了——
        // X 推出列号却当成行号用，等到 _wallOffset 被规整到 [-BW,0] 之后，3×3 动态区
        // 就整体漂到别处，中心那张卡再也拿不到 1.25（test-preset-wall 的"最中间的图片最显眼"会红）。
        const cc = Math.round((cxw - b.pad - b.tw / 2) / (b.tw + b.gap));
        const rc = Math.round((cyw - b.pad - b.th / 2) / (b.th + b.gap));
        const active = new Set();
        // 只更新视口附近的拷贝：2×2 份拷贝里，同一格通常只有 1 份在屏幕上。
        // 之前每帧把 4 份都写一遍（9 格 × 4 = 36 个节点），在 165Hz / DPR2 下光样式写入
        // 就要 6ms 以上；实际看得见的只有一份，离屏拷贝等进入视口前再写完全来得及。
        // margin 至少留一张卡，快速甩动时也不会等到贴边才补值。
        const margin = Math.max(b.tw, b.th);
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const r = wrap(rc + dr, b.Q);
                const c = wrap(cc + dc, b.P);
                const list = cells[r + '_' + c];
                if (!list || !list.length) continue;
                const ring = Math.abs(dr) + Math.abs(dc);
                const phase = ring === 2 ? 1 : 0;
                const skipCell = settle
                    ? (ring === 0 || phase !== (1 - lastTick))
                    : (!force && canStagger && ring > 0 && phase !== focusTick);
                // 格中心在块坐标系中的位置 → 到视口中心的"最近周期副本"距离
                const wx = b.pad + c * (b.tw + b.gap) + b.tw / 2 + ox;
                const wy = b.pad + r * (b.th + b.gap) + b.th / 2 + oy;
                const dx = wx - cx;
                const dy = wy - cy;
                // 无限墙：取"最近的那份周期拷贝"的距离（否则中心的卡永远算很远）；
                // 有限墙只有一份，直接用真实距离，墙边那张卡就该是小的。
                const ddx = finite ? dx : dx - Math.round(dx / b.BW) * b.BW;
                const ddy = finite ? dy : dy - Math.round(dy / b.BH) * b.BH;
                const dist = Math.hypot(ddx, ddy);
                const u = Math.min(1, dist / distNorm);
                const s = maxScale - u * (maxScale - minScale);
                const o = 1 - u * 0.65;
                const os = o.toFixed(3);
                const z = String(Math.max(1, Math.round(100 - u * 95)));
                // 同一格在 4 份拷贝里共用同一套值（倾斜只作用于指针下那一张）。
                // 字符串每格只拼一次，不再给 4 份拷贝各拼一次。
                // 非倾斜卡用纯 2D scale：perspective + 0 度旋转视觉完全一样，但 3D 渲染上下文
                // 会在 opacity 同时变化时把卡片推上更重的合成路径。倾斜卡在下面单独用 3D。
                const baseTf = 'scale(' + s.toFixed(3) + ')';
                for (const tile of list) {
                    const copy = Number(tile.parentElement && tile.parentElement.dataset.copy) || 0;
                    const tx = b.pad + c * (b.tw + b.gap) + (copy % 2) * b.BW + ox;
                    const ty = b.pad + r * (b.th + b.gap) + Math.floor(copy / 2) * b.BH + oy;
                    if (tx > vw + margin || tx + b.tw < -margin || ty > vh + margin || ty + b.th < -margin) continue;
                    active.add(tile);
                    const isTilting = (tilt && tilt.card === tile);
                    if (skipCell && !isTilting) continue;
                    const tf = isTilting
                        ? 'perspective(760px) scale(' + s.toFixed(3) + ') rotateX(' + tilt.rx.toFixed(2) + 'deg) rotateY(' + tilt.ry.toFixed(2) + 'deg)'
                        : baseTf;
                    // 值没变就不写：平移时 scale 每帧都在变，但 opacity/zIndex 是按舍入档走的，
                    // 一小段时间内完全一致。跳过重复写入能省掉大量样式失效与重排。
                    if (tile.__tf !== tf) { tile.style.transform = tf; tile.__tf = tf; }
                    tile.__s = s;
                    const inner = tile.__inner || (tile.__inner = tile.firstElementChild);
                    if (inner && tile.__op !== os) { inner.style.opacity = os; tile.__op = os; }
                    if (tile.__z !== z) { tile.style.zIndex = z; tile.__z = z; }
                }
            }
        }
        // 复位离开动态区的卡片 → 静态态；倾斜卡若不在中心区则单独保持倾斜
        const prev = this._wallFocusTiles;
        for (const t of prev) {
            if (active.has(t)) continue;
            const isTilting = (tilt && tilt.card === t);
            // 离开动态区就撤层，避免层数越攒越多（层只给真正在动的可见卡）
            t.style.willChange = 'auto';
            if (isTilting) {
                t.style.transform = 'perspective(760px) scale(0.72) rotateX(' + tilt.rx.toFixed(2) + 'deg) rotateY(' + tilt.ry.toFixed(2) + 'deg)';
                t.__tf = t.style.transform;
            } else {
                t.style.transform = 'scale(0.72)';
                t.__tf = 'scale(0.72)';
            }
            t.__s = 0.72;
            const inner = t.__inner || (t.__inner = t.firstElementChild);
            if (inner) { inner.style.opacity = '0.5'; t.__op = '0.5'; }
            t.style.zIndex = '1'; t.__z = '1';
        }
        for (const t of active) {
            if (!prev.has(t)) t.style.willChange = 'transform, opacity';
        }
        this._wallFocusTiles = active;
        if (settle) {
            this._wallFocusStaggered = false;
        } else {
            this._wallFocusLastTick = focusTick;
            this._wallFocusStaggered = !force && canStagger;
        }
    },

    // ── 卡片级换封面 ──
    // 封面编辑模式：顶部「换封面」一键进入，所有卡片右上角的按钮常显，
    // 模式内点卡片任意位置都算「换这张的封面」（点击区更大，不用瞄准小按钮）。
    // 再点一次（此时按钮是「完成」）或按 Esc 退出。
    toggleWallCoverMode(on) {
        const el = this._wallDom;
        if (!el || !el.grid) return;
        const next = typeof on === 'boolean' ? on : !this._coverMode;
        // 两个模式互斥：本图预览的卡片显示的是当前照片，换封面会看不到效果。
        if (next && this._wallPhotoMode) this.toggleWallPhotoMode(false);
        this._coverMode = next;
        el.grid.classList.toggle('pw-cover-mode', next);
        const btn = document.getElementById('pwCovers');
        if (btn) {
            btn.textContent = next ? '完成' : '换封面';
            btn.setAttribute('aria-pressed', next ? 'true' : 'false');
            btn.title = next
                ? '退出封面编辑'
                : '给预设换封面：点这里，再点任意卡片选图（也可以直接把鼠标移到卡片上点「换封面」）';
        }
        // 进模式时强制扫一次：按钮描金依赖"这预设有没有自定义封面"，用户可能刚在文件管理器里放过图
        if (next) this.refreshWallCovers(true);
        if (!next && typeof this.closeCtx === 'function') this.closeCtx();
    },

    // 从卡片取预设名：卡片只带 index，名字从 PRESET_WALL.items 查，
    // 这样 4 份拷贝指向同一预设时行为一致（也避免被 ellipsis 显示的文本骗到）。
    wallTileName(tile) {
        const idx = String((tile && tile.dataset ? tile.dataset.idx : '') || '');
        const data = window.PRESET_WALL;
        if (!idx || !data || !Array.isArray(data.items)) return '';
        // dataset.idx 存的是 item.i 而不是数组下标；当前两者恰好一致，但别依赖生成器的这个巧合
        const item = data.items.find((it) => it && String(it.i) === idx);
        return item && item.name ? String(item.name) : '';
    },

    // 右键/按钮共用的菜单：更换、恢复默认（仅当有自定义封面）、打开文件夹
    openWallCoverMenu(tile, x, y) {
        const name = this.wallTileName(tile);
        if (!name || typeof this.openCtx !== 'function') return;
        if (this._wallPhotoMode) {
            this.setStatus('「本图预览」中不换封面，先点顶部「看封面」切回封面模式');
            return;
        }
        const has = !!(this._wallCovers && this._wallCovers[name]);
        this.openCtx(x, y, [
            ['更换封面…', () => this.pickWallCoverFor(tile)],
            has ? ['恢复默认封面', () => this.clearWallCoverFor(tile)] : null,
            null,
            ['打开封面文件夹', () => this.openWallCoversFolder(false)]
        ]);
        // 菜单挂在 body 上，点空白处或按 Esc 该关掉——否则它会一直浮在墙上挡住卡片
        const off = () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
        const onDown = (ev) => {
            if (!this._ctx) { off(); return; }
            if (ev.target instanceof Node && this._ctx.contains(ev.target)) return;
            this.closeCtx(); off();
        };
        const onKey = (ev) => {
            if (ev.key !== 'Escape') return;
            this.closeCtx(); off();
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
    },

    // 选图 → 主进程按预设名落到 userData/wall-covers → 立刻刷新墙上的 4 份拷贝。
    // filePath 只给测试/未来拖放用；UI 里不传，由主进程弹选图框。
    async pickWallCoverFor(tile, filePath) {
        const name = this.wallTileName(tile);
        if (!name) return;
        const q = window.qingframe || {};
        if (typeof q.pickWallCover !== 'function') {
            this.setStatus('换封面需要完全退出并重启应用（主进程还是旧版本）');
            return;
        }
        let r = null;
        try { r = await q.pickWallCover(name, filePath); }
        catch (e) { r = { ok: false, message: (e && e.message) || '调用失败' }; }
        if (r && r.canceled) return;   // 用户自己取消，不打扰
        if (!r || !r.ok) {
            this.setStatus('换封面失败：' + ((r && r.message) || '未知原因'));
            return;
        }
        // 记住"用过换封面"，下次开墙才会自动扫描自定义封面
        try { localStorage.setItem('qfs_wall_covers_on', '1'); } catch (_) { /* 忽略 */ }
        this._wallCovers = Object.assign({}, this._wallCovers, { [name]: r.path });
        await this.refreshWallCovers(true);
        this.setStatus('已更换「' + name + '」的封面 · 右键卡片可恢复默认');
    },

    async clearWallCoverFor(tile) {
        const name = this.wallTileName(tile);
        if (!name) return;
        const q = window.qingframe || {};
        if (typeof q.clearWallCover !== 'function') {
            this.setStatus('恢复默认封面需要完全退出并重启应用（主进程还是旧版本）');
            return;
        }
        let r = null;
        try { r = await q.clearWallCover(name); }
        catch (e) { r = { ok: false, message: (e && e.message) || '调用失败' }; }
        if (!r || !r.ok) {
            this.setStatus('恢复默认封面失败：' + ((r && r.message) || '未知原因'));
            return;
        }
        await this.refreshWallCovers(true);
        this.setStatus(r.removed ? ('已恢复「' + name + '」的默认封面') : ('「' + name + '」用的本来就是默认封面'));
    },

    // 批量用法（也兼容旧版主进程）：打开封面文件夹让用户自己放图
    async openWallCoversFolder(showHint) {
        const q = window.qingframe || {};
        const toast = window.__showErrToast;
        const say = (msg, bad) => {
            if (typeof this.setStatus === 'function') this.setStatus(msg);
            if (typeof toast === 'function') toast(msg, !!bad);
        };
        // 主进程可能是旧代码（只重载了渲染进程）：preload 有这个方法、主进程却没注册 handler，
        // 直接 invoke 会抛 "No handler registered"，以前会糊一个红色异常给用户。
        if (typeof q.openWallCoversDir !== 'function') {
            say('换封面需要完全退出并重新启动应用（主进程还是旧版本）', true);
            return;
        }
        let r = null;
        try {
            r = await q.openWallCoversDir();
        } catch (e) {
            // 优雅降级：老主进程没有这个 IPC → 退回打开数据目录，并说清下一步
            if (typeof q.openDataDir === 'function') { try { await q.openDataDir(); } catch (_) { /* 忽略 */ } }
            say('主进程还是旧版本：已打开数据目录，在里面新建 wall-covers 文件夹放封面；完全重启应用后「换封面」可一键直达', false);
            return;
        }
        if (r && r.ok) {
            try { localStorage.setItem('qfs_wall_covers_on', '1'); } catch (_) { /* 忽略 */ }
            if (showHint) say('已打开封面文件夹（批量替换用）；只想换一张的话，把鼠标移到卡片上点右上角「换封面」，不用改文件名', false);
        } else if (r && r.message) {
            say('打不开封面目录：' + r.message, true);
        }
    },

    // 用户自备封面：userData/wall-covers/<预设名>.webp|jpg|png
    // 每次开墙扫一次（只是 readdir + 360 次 src 比对），删掉文件就自动回落内置封面。
    // force=true 时无视「用户用过换封面」的标记（用例用）。
    // 默认不扫：没点过「换封面」的人根本没自定义封面，这次 IPC 纯属浪费，
    // 还会在没注册该 handler 的老测试桩里刷一屏 "No handler registered"。
    async refreshWallCovers(force) {
        const el = this._wallDom;
        if (!el || !el.grid) return 0;
        if (!force && !this.wallCoversEnabled()) return 0;
        if (!window.qingframe || typeof window.qingframe.listWallCovers !== 'function') return 0;
        let covers = {};
        try { covers = await window.qingframe.listWallCovers() || {}; } catch (_) { return 0; }
        covers = this.normalizeWallCovers(covers);
        this._wallCovers = covers;   // 供右键菜单判断"能否恢复默认"
        let applied = 0;
        for (const tile of el.grid.querySelectorAll('.pw-tile')) {
            const img = tile.querySelector('.pw-tile-cover img');
            if (!img) continue;
            const nameEl = tile.querySelector('.pw-tile-name');
            const name = nameEl ? nameEl.textContent : '';
            const custom = covers[name];
            // 有自定义封面时给卡片打标：右上角按钮换成金色，一眼看出哪些是自己换过的
            if (custom) tile.dataset.customCover = '1';
            else delete tile.dataset.customCover;
            const want = custom && typeof this.coverUrl === 'function' ? this.coverUrl(custom) : (tile.dataset.cover || '');
            if (this._wallPhotoMode) continue;   // 本图预览期间不能把成品缩略图换回封面
            if (!want || img.getAttribute('src') === want) continue;
            img.src = want;
            if (custom) applied++;
        }
        return applied;
    },

    // ── 当前照片预览 ──
    // 当前图的「内容指纹」：同一张图换了调色/裁切/EXIF 都要重渲，否则用户看到的是旧照片。
    // el 用 WeakMap 发稳定 id，调色改的是 grade 对象、裁切会换 el，两类变化都能捕获。
    wallPhotoKey(im) {
        if (!im || !im.el) return '';
        if (!this._wallPhotoElIds) this._wallPhotoElIds = new WeakMap();
        let id = this._wallPhotoElIds.get(im.el);
        if (!id) {
            id = ++this._wallPhotoElSeq;
            this._wallPhotoElIds.set(im.el, id);
        }
        let grade = '', exif = '';
        try { grade = JSON.stringify(im.grade || null); } catch (_) { grade = ''; }
        try { exif = JSON.stringify(im.exif || null); } catch (_) { exif = ''; }
        const src = String(im.el.src || '');
        return [id, grade, exif, im.el.naturalWidth || 0, im.el.naturalHeight || 0,
            src.length, src.slice(0, 80), src.slice(-80)].join('|');
    },

    // 用当前照片把单个预设离屏渲成缩略图。
    // 这里临时借用主编辑器的 DOM/模板/图片状态，和 app-templates.js 的缩略图逻辑同源：
    // 渲染会写 _photoRect / _canvasBaseW/H / _canvasScale，结束后必须逐项还原，
    // 否则墙关掉后蒙版叠加层和撤销栈会按缩略图那次渲染的几何跑位。
    _renderWallPhotoThumb(preset, im) {
        if (!window.__render || !preset || !im || !im.el) return '';
        if (!im.el.complete || !im.el.naturalWidth) return '';
        const prev = {
            canvas: this.dom.canvas,
            displayMax: this.displayMax,
            uiDprOverride: this.uiDprOverride,
            exportScale: this.exportScale,
            image: this.image,
            template: this.template,
            selectedEls: this.selectedEls,
            photoRect: this._photoRect,
            baseW: this._canvasBaseW, baseH: this._canvasBaseH, scale: this._canvasScale,
            activePuzzleSlot: this._activePuzzleSlot,
            previewUseOriginal: this._previewUseOriginal,
            maskPreviewOriginal: this._maskPreviewOriginal
        };
        const cv = document.createElement('canvas');
        cv.width = 1; cv.height = 1;
        cv.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;pointer-events:none;';
        try {
            this.dom.canvas = cv;
            // 和预设墙封面同为 560px 档；uiDprOverride=1 让输出像素不随 DPR 翻倍。
            this.displayMax = 560;
            this.uiDprOverride = 1;
            if (this.exportScale !== undefined) delete this.exportScale;
            this.image = im;
            this.template = JSON.parse(JSON.stringify(preset));
            // 挡住 renderToCanvas 末尾的 fitZoom 分支：缩略图尺寸变化不是主画布尺寸变化。
            this.selectedEls = [{ kind: 'wall-preview', obj: {} }];
            this._activePuzzleSlot = null;
            this._previewUseOriginal = false;
            this._maskPreviewOriginal = false;
            if (this.template.puzzle && this.template.puzzle.enabled && window.__renderPuzzle) {
                window.__renderPuzzle(this, false, true);
            } else {
                window.__render(this, false);
            }
            let src = '';
            try { src = cv.toDataURL('image/webp', 0.82); } catch (_) { src = ''; }
            if (!src || src.indexOf('data:image/webp') !== 0) {
                try { src = cv.toDataURL('image/jpeg', 0.85); } catch (_) { src = ''; }
            }
            return src;
        } catch (_) {
            return '';
        } finally {
            this.image = prev.image;
            this.template = prev.template;
            this.selectedEls = prev.selectedEls;
            this.dom.canvas = prev.canvas;
            if (prev.displayMax === undefined) delete this.displayMax; else this.displayMax = prev.displayMax;
            if (prev.uiDprOverride === undefined) delete this.uiDprOverride; else this.uiDprOverride = prev.uiDprOverride;
            if (prev.exportScale === undefined) delete this.exportScale; else this.exportScale = prev.exportScale;
            this._photoRect = prev.photoRect;
            if (prev.baseW === undefined) delete this._canvasBaseW; else this._canvasBaseW = prev.baseW;
            if (prev.baseH === undefined) delete this._canvasBaseH; else this._canvasBaseH = prev.baseH;
            if (prev.scale === undefined) delete this._canvasScale; else this._canvasScale = prev.scale;
            if (prev.activePuzzleSlot === undefined) delete this._activePuzzleSlot; else this._activePuzzleSlot = prev.activePuzzleSlot;
            if (prev.previewUseOriginal === undefined) delete this._previewUseOriginal; else this._previewUseOriginal = prev.previewUseOriginal;
            if (prev.maskPreviewOriginal === undefined) delete this._maskPreviewOriginal; else this._maskPreviewOriginal = prev.maskPreviewOriginal;
        }
    },

    // 把一张已经渲染好的预览贴到所有同 idx 的卡片上（无限墙有 4 份拷贝）。
    applyWallPhotoCover(idx, src) {
        const grid = this._wallDom && this._wallDom.grid;
        if (!grid || !src) return 0;
        const id = String(idx);
        let n = 0;
        for (const tile of grid.querySelectorAll('.pw-tile')) {
            if (tile.dataset.idx !== id) continue;
            const img = tile.querySelector('.pw-tile-cover img');
            if (!img) continue;
            if (img.getAttribute('src') !== src) img.src = src;
            tile.dataset.photoPreview = '1';
            n++;
        }
        return n;
    },

    // 切换/重建墙后把缓存里的预览全部贴回来。不要在切模式时重跑引擎。
    applyWallPhotoCovers() {
        const cache = this._wallPhotoCache;
        const grid = this._wallDom && this._wallDom.grid;
        if (!this._wallPhotoMode || !cache || !grid) return;
        for (const tile of grid.querySelectorAll('.pw-tile')) {
            const src = cache.thumbs.get(String(tile.dataset.idx));
            if (!src) continue;
            const img = tile.querySelector('.pw-tile-cover img');
            if (img && img.getAttribute('src') !== src) img.src = src;
            tile.dataset.photoPreview = '1';
        }
    },

    // 从本图预览切回封面：先把缓存里的自定义封面贴回，refreshWallCovers 再异步扫盘补差异。
    restoreWallCovers() {
        const grid = this._wallDom && this._wallDom.grid;
        if (!grid) return;
        for (const tile of grid.querySelectorAll('.pw-tile')) {
            const img = tile.querySelector('.pw-tile-cover img');
            if (!img) continue;
            const name = this.wallTileName(tile);
            const custom = name && this._wallCovers && this._wallCovers[name];
            const want = (custom && typeof this.coverUrl === 'function')
                ? this.coverUrl(custom)
                : (tile.dataset.cover || '');
            if (want && img.getAttribute('src') !== want) img.src = want;
            delete tile.dataset.photoPreview;
        }
    },

    // 按钮状态：有照片才显示；开着时文案变成「看封面」，让用户知道再点是切回去。
    syncWallPhotoUI() {
        const el = this._wallDom;
        const grid = el && el.grid;
        const btn = (el && el.photo) || document.getElementById('pwPhoto');
        const has = !!(this.image && this.image.el);
        if (!has && this._wallPhotoMode) {
            this._wallPhotoMode = false;
            this._wallPhotoToken++;
            this._wallPhotoRunning = false;
            if (grid) grid.classList.remove('pw-photo-mode');
            this.restoreWallCovers();
        }
        const on = !!this._wallPhotoMode && has;
        if (grid) grid.classList.toggle('pw-photo-mode', on);
        if (!btn) return on;
        btn.hidden = !has;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.textContent = on ? '看封面' : '本图预览';
        btn.title = on
            ? '正在用当前照片预览；点击切回预设封面'
            : '用当前照片实时预览所有预设（点击卡片套用）';
        return on;
    },

    // 开/关本图预览。on 省略时按当前状态取反；refresh=false 用于关墙时静默还原。
    toggleWallPhotoMode(on, opts) {
        const el = this._wallDom;
        const grid = el && el.grid;
        if (!el || !grid) return false;
        const next = typeof on === 'boolean' ? on : !this._wallPhotoMode;
        const has = !!(this.image && this.image.el);
        if (next && !has) {
            if (typeof this.setStatus === 'function') this.setStatus('先导入照片，才能用当前照片预览');
            return false;
        }
        if (next && this._coverMode) this.toggleWallCoverMode(false);
        if (next === this._wallPhotoMode) {
            this.syncWallPhotoUI();
            return next;
        }
        this._wallPhotoMode = next;
        this._wallPhotoToken++;
        this._wallPhotoRunning = false;
        if (next) {
            this.syncWallPhotoUI();
            this.syncWallModeUI();
            this.renderWallPhotoPreviews();
        } else {
            this._wallPhotoDone = 0;
            this.restoreWallCovers();
            this.syncWallPhotoUI();
            this.syncWallModeUI();
            if (!opts || opts.refresh !== false) this.refreshWallCovers(true);
        }
        return next;
    },

    // 后台批量渲染：每张之间让出一帧，渲染过程中用户仍然能拖动、点击卡片。
    // 已经缓存过的预设不重新跑；切换无限/有限墙只会重贴缓存。
    async renderWallPhotoPreviews() {
        const el = this._wallDom;
        const grid = el && el.grid;
        if (!grid || !this._wallPhotoMode || !this._wallActive) return;
        const im = this.image;
        if (!im || !im.el) { this.toggleWallPhotoMode(false, { refresh: false }); return; }
        if (!(this.presets || []).length && this._presetsReady) {
            try { await this._presetsReady; } catch (_) { /* 加载失败就按缺预设处理 */ }
        }
        if (!this._wallPhotoMode || !this._wallActive) return;
        const data = (typeof window.PRESET_WALL === 'object' && window.PRESET_WALL && Array.isArray(window.PRESET_WALL.items))
            ? window.PRESET_WALL.items : [];
        if (!data.length) return;
        const key = this.wallPhotoKey(im);
        if (!this._wallPhotoCache || this._wallPhotoCache.key !== key) {
            this._wallPhotoCache = { key, thumbs: new Map() };
        }
        const cache = this._wallPhotoCache;
        this.applyWallPhotoCovers();
        const pending = data.filter((item) => !cache.thumbs.has(String(item && item.i)));
        this._wallPhotoTotal = data.length;
        this._wallPhotoDone = data.length - pending.length;
        this._wallPhotoRunning = pending.length > 0;
        this.updateWallPhotoProgress();
        if (!pending.length) {
            this._wallPhotoRunning = false;
            this.updateWallPhotoProgress();
            return;
        }
        const token = ++this._wallPhotoToken;
        const presetKey = (s) => String(s || '').replace(/\.json$/i, '').trim();
        const presets = this.presets || [];
        for (const item of pending) {
            if (token !== this._wallPhotoToken || !this._wallPhotoMode || !this._wallActive) return;
            if (this.wallPhotoKey(this.image) !== key) break;
            const id = String(item && item.i);
            const preset = presets.find((p) => presetKey(p._fileName) === presetKey(item && item.preset));
            if (preset) {
                const src = this._renderWallPhotoThumb(preset, im);
                if (src) {
                    cache.thumbs.set(id, src);
                    this.applyWallPhotoCover(id, src);
                }
            }
            this._wallPhotoDone++;
            this.updateWallPhotoProgress();
            // 0ms 定时器让出主线程：88 次完整渲染连在一起会把墙冻住。
            await new Promise((r) => setTimeout(r, 0));
        }
        if (token !== this._wallPhotoToken) return;
        // 渲染期间用户切了图：当前缓存已经不对，立即按新图重开一轮。
        if (this.wallPhotoKey(this.image) !== key) {
            this._wallPhotoRunning = false;
            this.renderWallPhotoPreviews();
            return;
        }
        this._wallPhotoDone = data.length;
        this._wallPhotoRunning = false;
        this.updateWallPhotoProgress();
    },

    // 副标题里的进度只刷新文字，不重算墙布局。
    updateWallPhotoProgress() {
        const el = this._wallDom;
        if (!el) return;
        if (el.grid) el.grid.setAttribute('aria-busy', this._wallPhotoRunning ? 'true' : 'false');
    },

    // 渲染墙：无限墙 = 9×10 的周期块铺 2×2 份（87 张预设循环填充，槽位 i 映射 preset i % 87）；
    // 有限墙 = 只铺 1 份，槽位 i 就是 preset i，多出来的格子直接不建 —— 每张预设只出现一次。
    renderPresetWall() {
        const el = this._wallDom;
        if (!el || !el.grid) return;
        const data = (typeof window.PRESET_WALL === 'object' && window.PRESET_WALL && Array.isArray(window.PRESET_WALL.items))
            ? window.PRESET_WALL
            : null;
        if (!data || !data.items.length) {
            return;
        }
        const wall = document.createElement('div');
        wall.className = 'pw-wall';
        // 几何按当前视口现算：初始化时墙可能还没显示（clientWidth=0），退到 1400 估一个，
        // 真正打开时 layoutWallTiles 会发现 key 对不上并重建一次。
        const vw = el.grid.clientWidth || 0;
        const b = this.wallGeom(vw > 0 ? vw : 1400);
        const finite = b.mode === 'finite';
        const copies = finite ? 1 : 4;
        const cells = {};
        const blocks = [];
        const n = data.items.length;
        const makeTile = (r, c, copy, item) => {
            const tile = document.createElement('div');
            tile.className = 'pw-tile';
            tile.dataset.cell = r + '_' + c;
            tile.dataset.idx = String(item.i);
            tile.dataset.cover = item.cover;   // 内置封面，自定义封面撤掉时回落到它
            // 只有第 0 份拷贝参与键盘与无障碍：2×2 份拷贝若都 tabIndex=0，
            // Tab 键要按 360 次才能穿过墙，读屏也会把同一张卡播报四遍。
            // 另外三份是纯视觉填充，焦点/读屏都跳过。
            if (copy === 0) {
                tile.tabIndex = 0;
                tile.setAttribute('role', 'button');
                tile.setAttribute('aria-label', item.name + '，' + item.tag + '，进入编辑');
            } else {
                tile.tabIndex = -1;
                tile.setAttribute('aria-hidden', 'true');
            }
            const cover = document.createElement('div');
            cover.className = 'pw-tile-cover';
            const img = document.createElement('img');
            img.src = item.cover;
            img.alt = '';
            img.draggable = false;
            // 异步解码：90 张封面同步解码会卡住第一次绘制（打开墙时那一下顿）
            img.decoding = 'async';
            cover.appendChild(img);
            // 内容包一层：聚焦时 opacity 写在 inner 上，tile 只负责 transform/z-index。
            // 同一元素同时逐帧改 transform + opacity 会让 Chromium 每帧重绘卡片的
            // 560px 封面（165Hz/DPR2 下直接掉一帧）；拆成两层后合成器可以分开处理。
            const inner = document.createElement('div');
            inner.className = 'pw-tile-inner';
            inner.appendChild(cover);
            // 名称放在封面**下方**的一条里：封面是「照片+边框」的合成图，
            // 压在图上会挡掉边框和主体；单独一条既不遮图，也不用渐变把画面压暗。
            const caption = document.createElement('div');
            caption.className = 'pw-tile-caption';
            const name = document.createElement('div');
            name.className = 'pw-tile-name';
            name.textContent = item.name;
            // 卡片窄，长预设名会省略号截断——给个原生 tooltip 让用户能看到全名
            name.title = item.name;
            caption.appendChild(name);
            const tag = document.createElement('div');
            tag.className = 'pw-tile-tag';
            tag.textContent = item.tag;
            caption.appendChild(tag);
            inner.appendChild(caption);
            // 换封面：悬停/聚焦时右上角显形，点了直接弹选图并按预设名自动落盘。
            // tabIndex=-1：tile 本身已是 tab 焦点，360 张卡再各加一个焦点会让人按 Tab 按到崩；
            // 键盘用户用卡片上的 C 键（见 grid 的 keydown）。
            const coverBtn = document.createElement('button');
            coverBtn.type = 'button';
            coverBtn.className = 'pw-tile-coverbtn';
            coverBtn.tabIndex = -1;
            coverBtn.textContent = '换封面';
            coverBtn.title = '给「' + item.name + '」换一张封面图（不用手动改名），或者直接将图片拖到想要换的封面上即可';
            inner.appendChild(coverBtn);
            tile.appendChild(inner);
            tile.__inner = inner;
            return tile;
        };
        // 2×2 份相同的块：多出来的三份专门填回绕边界的空白。四份的同一格共用同一张预设，
        // 所以偏移跨过一整周期回绕时，屏幕上的画面逐像素一致 —— 不会"跳一下像刷新"。
        // 有限墙只铺 1 份（copies=1），没有边界填充的需求，也不该有重复卡片。
        for (let copy = 0; copy < copies; copy++) {
            const block = document.createElement('div');
            block.className = 'pw-block';
            block.dataset.copy = String(copy);
            const frag = document.createDocumentFragment();
            for (let r = 0; r < b.Q; r++) {
                for (let c = 0; c < b.P; c++) {
                    const slot = r * b.P + c;
                    // 有限墙：槽位就是预设下标，越过最后一个预设的格子留空，不循环
                    if (finite && slot >= n) continue;
                    const item = data.items[finite ? slot : slot % n];
                    const tile = makeTile(r, c, copy, item);
                    // 初始静态态（远离中心时的小卡状态）；opacity 在内容层上
                    tile.style.transform = 'scale(0.72)';
                    tile.__s = 0.72;
                    const inner = tile.__inner;
                    if (inner) inner.style.opacity = '0.5';
                    tile.style.zIndex = '1';
                    const key = r + '_' + c;
                    (cells[key] || (cells[key] = [])).push(tile);
                    frag.appendChild(tile);
                }
            }
            block.replaceChildren(frag);
            blocks.push(block);
            wall.appendChild(block);
        }
        el.grid.replaceChildren(wall);
        el.wall = wall;
        el.blocks = blocks;
        el.cells = cells;
        el.cellsReady = true;
        el.block = blocks[0]; // 兼容仍按单块取用的地方（选择态、测试）
        // 记下这一版是按什么模式/行列数渲染的：layoutWallTiles 靠它判断要不要重建
        el.renderedKey = b.mode + ':' + b.P + 'x' + b.Q;
        this._wallBounds = b;
        this.layoutWallTiles();
        // 墙整体淡入（卡片自身不做动画，transform 由 JS 接管）；降级动效时直接出现
        if (!this.wallReducedMotion()) wall.style.animation = 'pwWallIn .55s ease-out both';
        // 重建后每个 tile 的 img 又回到内置封面：把用户自备的封面重新贴回来，
        // 否则「无限/有限」切一下，换过的封面就变回原样（要等下次开墙才回来）。
        this.refreshWallCovers();
        // 本图预览模式下重建（无限/有限切换）不要回封面：先贴缓存，没渲染完的继续跑。
        if (this._wallPhotoMode) {
            this.applyWallPhotoCovers();
            if (!this._wallPhotoRunning) this.renderWallPhotoPreviews();
        }
    },

    // 方向键在磁贴墙中移动选中卡片：上下左右 ±1（周期内循环），选中卡片自动滚到视口中心
    moveWallSelection(dr, dc) {
        const el = this._wallDom;
        const grid = el && el.grid;
        const block = el && el.block;
        if (!grid || !block) return;
        const b = this._wallBounds;
        if (!b) return;
        // 键盘接管前先停掉惯性和滚轮补间，不然刚按方向键就被上一甩拽回去
        this.stopWallMotion();
        // 键盘平移时也撤掉鼠标悬停留下的 3D 倾斜卡
        const t = this._wallTilt;
        if (t && t.card) {
            t.card.removeAttribute('data-tilting');
            t.card = null; t.rx = 0; t.ry = 0;
        }
        const sel = this._wallSel;
        if (this.wallMode() === 'finite') {
            // 有限墙：走到头就停住（不绕回另一端），最后一行没铺满的格子也不许选
            const prev = { r: sel.r, c: sel.c };
            sel.r = Math.min(b.Q - 1, Math.max(0, sel.r + dr));
            sel.c = Math.min(b.P - 1, Math.max(0, sel.c + dc));
            if (sel.r * b.P + sel.c >= b.n) { sel.r = prev.r; sel.c = prev.c; return; }
        } else {
            sel.r = ((sel.r + dr) % b.Q + b.Q) % b.Q;
            sel.c = ((sel.c + dc) % b.P + b.P) % b.P;
        }
        for (const t of grid.querySelectorAll('.pw-tile.selected')) t.classList.remove('selected');
        this.centerWallOn(sel.r, sel.c);
    },

    // 把某一格移到视口中心（方向键与「回墙定位当前预设」共用）。
    // select=false 时只居中不加选中框：首次启动没有任何选中项，不该凭空亮一张卡。
    centerWallOn(r, c, select) {
        const el = this._wallDom;
        const grid = el && el.grid;
        const b = this._wallBounds;
        if (!grid || !b) return;
        const wx = b.pad + c * (b.tw + b.gap) + b.tw / 2;
        const wy = b.pad + r * (b.th + b.gap) + b.th / 2;
        const cx = grid.clientWidth / 2, cy = grid.clientHeight / 2;
        const targetX = cx - wx, targetY = cy - wy;
        if (this.wallMode() === 'finite') {
            // 有限墙：想要居中，但到了墙边就贴边停 —— 不能像无限墙那样绕到另一头
            const c = this.clampWallPan(targetX, targetY);
            this._wallPan = { x: c.x, y: c.y };
            this._wallOffsetX = c.x;
            this._wallOffsetY = c.y;
        } else {
            const span = this.wallWrapSpan();
            this._wallPan = { x: targetX, y: targetY };
            this._wallOffsetX = _pwWrap(targetX, span.w);
            this._wallOffsetY = _pwWrap(targetY, span.h);
        }
        // select==='keep'：只挪位置，不动选中态（缩放卡片大小时用——那不是用户换选中，
        // 把当前选中的卡片给人取消掉会很突然）
        if (select !== 'keep') {
            for (const t of grid.querySelectorAll('.pw-tile.selected')) t.classList.remove('selected');
            const targets = (el.cells || {})[r + '_' + c] || [];
            if (select !== false) {
                for (const t of targets) t.classList.add('selected');
                if (targets.length) {
                    try { targets[0].focus({ preventScroll: true }); } catch (_) {}
                }
            }
        }
        this.applyWallTransform();
        this.focusWall(true);
    },

    // 视口中心那张卡落在哪个格子上。缩放前后拿它当锚点，画面才像「以中间那张为中心」
    // 放大；否则缩放的锚点是墙的坐标原点，卡片越大漂得越明显，看着像放大后跑偏了。
    wallCenterCell() {
        const el = this._wallDom, b = this._wallBounds;
        if (!el || !el.grid || !b) return null;
        const cx = el.grid.clientWidth / 2, cy = el.grid.clientHeight / 2;
        // _wallPan 是未回绕的位移累计，用它反算墙坐标（offset 是取过模的，反算会差一个周期）
        const wx = cx - (this._wallPan ? this._wallPan.x : 0);
        const wy = cy - (this._wallPan ? this._wallPan.y : 0);
        const c = Math.round((wx - b.pad - b.tw / 2) / (b.tw + b.gap));
        const r = Math.round((wy - b.pad - b.th / 2) / (b.th + b.gap));
        return { r: ((r % b.Q) + b.Q) % b.Q, c: ((c % b.P) + b.P) % b.P };
    },

    // 回墙时把选中框落到「当前模板用的那个预设」上：用户不用再满墙找刚才选的是哪张
    selectWallPreset(name) {
        const el = this._wallDom;
        const b = this._wallBounds;
        const data = window.PRESET_WALL;
        if (!el || !el.cells || !b || !data || !Array.isArray(data.items)) return false;
        const key = (s) => String(s || '').replace(/\.json$/i, '').trim();
        const want = key(name);
        if (!want) return false;
        const n = data.items.length;
        const idx = data.items.findIndex((it) => key(it.name) === want || key(it.preset) === want);
        if (idx < 0) return false;
        // 90 格按 slot % n 取预设，找第一个正好显示它的槽位
        // 有限墙里槽位就是预设下标，直接落过去
        let slot = -1;
        if (this.wallMode() === 'finite') {
            slot = idx < b.P * b.Q ? idx : -1;
        } else {
            for (let s = 0; s < b.P * b.Q; s++) { if (s % n === idx) { slot = s; break; } }
        }
        if (slot < 0) return false;
        this._wallSel = { r: Math.floor(slot / b.P), c: slot % b.P };
        this.centerWallOn(this._wallSel.r, this._wallSel.c);
        return true;
    },

    // 打开预设墙（启动默认显示；工具栏「边框墙」按钮返回时调用）
    // photoMode=true：直接用当前照片渲染整墙；不传则沿用当前模式（启动时默认封面墙）。
    openPresetWall(photoMode) {
        const el = this._wallDom;
        if (!el || !el.overlay) return;
        // 若正处在沉浸展示中，先退出，避免两个全屏层叠在一起
        if (this._immersionOpen && typeof this.closeImmersive === 'function') this.closeImmersive();
        const hasImage = !!(this.image && this.image.el);
        if (typeof photoMode === 'boolean') {
            if (!photoMode) {
                if (this._wallPhotoMode) this.toggleWallPhotoMode(false, { refresh: false });
            } else {
                this._wallPhotoMode = !!hasImage;
            }
        }
        if (!hasImage) this._wallPhotoMode = false;
        this._wallActive = true;
        el.overlay.hidden = false;
        document.body.classList.add('wall-open');
        document.body.classList.remove('editing');
        if (el.back) el.back.style.display = '';
        if (el.backGroup) el.backGroup.style.display = '';
        // 回到墙时从头浏览：偏移归零 + 重新布局焦点
        this.stopWallMotion();
        this._wallPan = { x: 0, y: 0 };
        this._wallOffsetX = 0;
        this._wallOffsetY = 0;
        this.syncWallModeUI();
        this.syncWallPhotoUI();
        this.applyWallTransform();
        this.layoutWallTiles();
        // 回墙先把选中框落到「当前图正在用的预设」上：找回来不用满墙翻。
        // 没选过预设（默认模板）就把视口中心对齐到最近一格 —— 否则偏移为 0 时中心正好落在
        // 格间隙上，首屏那张卡只有 1.05，看起来"中心放大没生效"。
        const current = (this.template && this.template.templateName) || '';
        if (!current || !this.selectWallPreset(current)) {
            const b = this._wallBounds;
            if (b && el.grid && b.mode === 'finite') {
                // 有限墙是有第一屏的：从头开始，别一开就落在墙中间（那正是"不知道划过没有"）
                this.panWallTo(0, 0);
            } else if (b && el.grid) {
                const cc = Math.round((el.grid.clientWidth / 2 - b.pad - b.tw / 2) / (b.tw + b.gap));
                const rc = Math.round((el.grid.clientHeight / 2 - b.pad - b.th / 2) / (b.th + b.gap));
                this.centerWallOn(((rc % b.Q) + b.Q) % b.Q, ((cc % b.P) + b.P) % b.P, false);
            }
            try { el.grid.focus({ preventScroll: true }); } catch (_) {}
        }
        // 每次开墙扫一次自定义封面（用户可能在别的窗口刚放好图）
        this.refreshWallCovers();
        if (this._wallPhotoMode) {
            this.applyWallPhotoCovers();
            this.renderWallPhotoPreviews();
        }
    },

    // 关闭预设墙进入编辑工作台
    // workbench=true 表示「跳过」：不应用任何预设，直接进空工作台
    closePresetWall(workbench) {
        const el = this._wallDom;
        if (!el || !el.overlay) return;
        this._wallActive = false;
        // 关墙即取消后台渲染，别让缩略图在用户开始编辑后继续借主状态。
        this._wallPhotoToken++;
        this._wallPhotoRunning = false;
        if (this._wallPhotoMode) this.toggleWallPhotoMode(false, { refresh: false });
        // 下次开墙不该还停在"封面编辑模式"：按钮文案与副标题都要复原
        if (this._coverMode) this.toggleWallCoverMode(false);
        el.overlay.hidden = true;
        // 关墙时惯性可能还在跑，留着会在下次打开时突然自己滑一下
        this.stopWallMotion();
        document.body.classList.remove('wall-open');
        document.body.classList.add('editing');
        const selTiles = el.grid ? el.grid.querySelectorAll('.pw-tile.selected') : [];
        for (const t of selTiles) t.classList.remove('selected');
        if (el.back) el.back.style.display = '';
        if (el.backGroup) el.backGroup.style.display = '';
        const btnOpen = document.getElementById('btnOpen');
        const focusTarget = (btnOpen && btnOpen.offsetParent) ? btnOpen : this.dom && this.dom.canvas;
        if (focusTarget && typeof focusTarget.focus === 'function') {
            try { focusTarget.focus({ preventScroll: true }); } catch (_) {}
        }
        if (workbench) this.setStatus('已进入工作台，从左侧工具栏导入照片开始');
    },

    // 点击预设卡片：应用该预设并进入编辑模式
    async enterEditorFromWall(idx) {
        const data = (typeof window.PRESET_WALL === 'object' && window.PRESET_WALL && window.PRESET_WALL.items)
            ? window.PRESET_WALL.items
            : [];
        const item = data.find((x) => String(x.i) === String(idx));
        if (!item) return;
        // 墙数据里的 preset 是"参数横条.json"，而主进程 list-presets / load-all-presets 返回的
        // name 是**不带扩展名**的"参数横条"，App.presets[]._fileName 跟着这个名字走。
        // 之前用 === 硬比，永远不命中 → 点卡片静默 return，界面上就是"没反应"。
        const key = (s) => String(s || '').replace(/\.json$/i, '').trim();
        // 启动头一秒 preset 还在加载：此时点卡片会"点了没反应"。等它就绪再继续。
        if (!(this.presets || []).length && this._presetsReady) {
            try { await this._presetsReady; } catch (_) { /* 加载失败走下面的提示 */ }
        }
        const preset = (this.presets || []).find((p) => key(p._fileName) === key(item.preset));
        if (!preset) {
            // 静默失败最坑：状态栏在墙底下，用户只会看到"点了没反应"。用全局 toast 直接说到脸上。
            const msg = '预设加载失败：' + item.name;
            if (typeof window.__showErrToast === 'function') window.__showErrToast(msg, true);
            if (typeof this.setStatus === 'function') this.setStatus(msg);
            return;
        }
        // 统一入口：有照片就立刻套到当前图（撤销栈 + 保留用户元素），没照片就记为待应用，
        // 等导入时由 importPicked 复制给每张新图。墙和侧栏共用同一条逻辑。
        if (typeof this.applyPresetToCurrent === 'function') this.applyPresetToCurrent(preset);
        else this.template = JSON.parse(JSON.stringify(preset));
        this.closePresetWall(false);
        const hasPhoto = !!(this.images && this.images.length);
        if (typeof this.setStatus === 'function') {
            this.setStatus(hasPhoto
                ? '已套用边框：' + item.name
                : '已选择边框：' + item.name + '，导入照片开始编辑');
        }
        if (typeof this.updateEmptyState === 'function') this.updateEmptyState();
    }
});

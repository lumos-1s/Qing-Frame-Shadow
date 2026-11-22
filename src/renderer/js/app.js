// 清框影 App 控制器 —— 依据 Java 版 MainController 交互逻辑重写
// 核心:onSettingChanged(高频防抖)/onSettingCommit(提交压栈)/scheduleRender(防抖渲染)/refreshUI(回显)
// 撤销/重做栈 + 每图独立模板(imageTemplates) + 画布元素(logo/贴纸/文字)管理

// 旋转把手专用光标。画布默认就是 grab，若旋转热区也用 grab，用户完全看不出
// 光标发生了变化；这里给一个带环形箭头的自定义光标（失败时回退 grab）。
const ROTATE_CURSOR_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>"
    + "<circle cx='12' cy='12' r='10' fill='#0b1411' fill-opacity='.82'/>"
    + "<path d='M19 12a7 7 0 1 1-2.05-4.95' fill='none' stroke='#00e5a0' stroke-width='2' stroke-linecap='round'/>"
    + "<path d='M19 5v5h-5' fill='none' stroke='#00e5a0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>"
    + "</svg>";
const ROTATE_CURSOR = 'url("data:image/svg+xml,' + encodeURIComponent(ROTATE_CURSOR_SVG) + '") 12 12, grab';
// 浏览器可能把内联 cursor 规范化，不能拿完整字符串做等值判断；
// 认 data:image/svg+xml 前缀即可可靠区分「旋转专用光标」。
const isRotateCursor = (c) => String(c).indexOf('data:image/svg+xml') >= 0;

// 样式私有参数的声明与绑定已收进 style-params.js / app-style-params.js，
// 这里不再维护「字段名 → 滑块 → 标签 → 默认值」的手写数组。
// 只对这两个风格露出进阶说明文字（它们共用 styleBlurCommon，别的风格读不到这些字段）。
const BLUR_ADV_STYLES = ['BLUR_CLASSIC', 'BLUR_DATE'];

window.App = {
    image: null,          // 当前图片 {el, name, w, h, exif, customSettings}
    images: [],
    selectedIdx: [],
    batchSel: [],         // 胶片条勾选的照片索引(批量放图数据源)
    currentIdx: 0,
    template: null,       // 当前模板 JSON
    imageTemplates: new Map(), // 每图独立模板(深拷贝快照)
    presets: [],
    zoom: 1,
    panX: 0, panY: 0,
    _pan: null,
    renderToken: 0,        // 帧计数(诊断用:观察实际合成次数)
    _renderRaf: 0,        // 已排队的帧回调句柄(0=未排)
    _renderDirty: false,  // 队列里有待处理的渲染请求
    _renderUrgent: false, // 本轮需跳过的手势降频(滑块拖动中降频,提交/导出时清零)
    _renderSkip: 0,       // 剩余跳帧数:>0 表示本帧只让位、不合成
    _renderFlushResolvers: [], // flushRender 等待者(该帧真正画完后统一兑现)
    _comparePending: false,  // 本帧是否为「对比原图」旁路帧(见 setCompare)
    undoStack: [],
    redoStack: [],
    // 撤销/重做按图片分开存：切图时交换当前栈，回来还能继续撤。
    // WeakMap 以图片对象为键，删除图片后历史随之释放，不需要手动清理。
    historyByImage: new WeakMap(),
    _gesture: false,
    isUpdating: false,
    draggingCompare: false,
    logos: [],
    logoImgCache: {},
    textures: [],
    curatedFonts: ['Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'FangSong', 'Arial', 'Arial Black', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Segoe UI', 'PingFang SC',
        // 中文艺术字/印章体
        '华文彩云', '华文琥珀', '华文行楷', '华文新魏', '幼圆', '隶书', '方正舒体', '方正姚体', '方正报宋', '汉仪雪峰体', '汉仪旗黑',
        // 西文艺术字
        'Segoe Script', 'Brush Script MT', 'Comic Sans MS', 'Impact', 'Papyrus', 'Ravie', 'Gigi', 'Chiller', 'Edwardian Script ITC', 'Monotype Corsiva', 'Snap ITC', 'Lucida Handwriting', 'Trebuchet MS', 'Copperplate Gothic Bold', 'Book Antiqua', 'Informal Roman', 'Bodoni MT'],
    _lastTplName: '',
    _firstRenderDone: false,
    // 用户没填个性签名时的默认文案。票根/电影票等「签名行默认关」的风格例外,
    // 见 StyleCaps.sigRowDefaultOff()。
    DEFAULT_SIGNATURE: '清框影',
    selectedEls: [],      // 画布元素选中集(引用自模板数组)
    _elClip: null,        // 复制的元素快照 {kind, el}
    _puzzleSlot: '',         // 拼图当前选中项('s0'..槽位 / 'v0'/'h0'..间隙);空 = 未选中
    _editingGap: null,       // 正在编辑的字幕门牌号('H0'/'V1'/'S2'),无则收起编辑器
    _activePuzzleSlot: null, // 画布选中槽位(蓝框 + 滚轮/拖拽/单图滑块);null = 控制整个拼图
    _puzzlePick: null,       // 拖拽抓取预览 {mode:'target'|'float',...}
    _puzzleDropTarget: null, // 拖拽互换预备目标格
    _skipPuzzleCapture: false,
    _bgBlurDefault: null,    // 背景模糊默认记忆:null=跟随预设, 1=默认开, 0=默认关
    _presetsLoaded: false,   // loadPresets 完成(含失败)后置 true，迟到恢复要在它之后跑
    _lastStateApplied: false,// qfs_last_state 只恢复一次，避免 loadPresets 重入时覆盖用户选择

    restoreLastState() {
        // 测试默认不继承开发机上残留的 qfs_last_state；需要验证恢复的用例
        // 通过 preload-measure 的 --qf-allow-last-state 显式打开。
        if (window.__qfTest && !window.__qfAllowLastState) return;
        if (this._lastStateApplied) return;
        // loadPresets 是异步的，init 里调用本方法时 this.presets 还是 []，
        // 按名字永远找不到；等 loadPresets 末尾置 true 后再调用。
        if (!this._presetsLoaded) return;
        try {
            const raw = localStorage.getItem('qfs_last_state');
            if (!raw) return;
            const s = JSON.parse(raw);
            if (!s || typeof s !== 'object') return;
            // 已经有照片（手动导入 / 恢复草稿）时以当前会话为准，别拿上次状态盖掉。
            if (this.images && this.images.length) return;
            // 「联名水印」旧版默认对齐是左下(0)，与联名水印官方版式(底部居中)不符。
            // 老草稿没有 xmAlignV 标记时迁移一次为居中；用户之后手动选左下会带标记保存，正常记住。
            if (s.xmLeica && typeof s.xmLeica === 'object' && Number(s.xmAlignV) < 2) s.xmLeica.align = 1;
            // 找到对应预设并选中
            if (s.presetName && Array.isArray(this.presets)) {
                // 去品牌化改名：旧草稿里还写着旧名字，映射到新预设，避免恢复时丢掉选中态
                const PRESET_RENAMED = { '小米徕卡水印': '联名水印' };
                const wanted = PRESET_RENAMED[s.presetName] || s.presetName;
                // 预设 JSON 的字段叫 templateName；这个查询曾按 x.name 找，
                // 91 个预设里一个都匹配不到，所以即使 saved presetName 正常也永远走兜底。
                const p = this.presets.find(x => x && (x.templateName === wanted || x._fileName === wanted));
                if (p) {
                    this.selectPreset(p);
                    this._lastStateApplied = true;
                    // 预设只提供外观基线:上次改过的苹果信息卡(文本/颜色/字号/显隐)优先恢复
                    if (s.appleCard && typeof s.appleCard === 'object' && this.template) {
                        this.template.appleCard = s.appleCard;
                        this.refreshUI();
                        this.scheduleRender();
                    }
                    // 联名水印同理
                    if (s.xmLeica && typeof s.xmLeica === 'object' && this.template) {
                        this.template.xmLeica = s.xmLeica;
                        this.refreshUI();
                        this.scheduleRender();
                    }
                    return;
                }
            }
            // 没找到预设就只恢复关键字段（预设改名/被删时的兜底）。
            // 启动时 this.template 还没被创建；不先建模板，下面所有赋值都会静默跳过
            // —— 这正是旧版「自动恢复」在启动阶段完全失效的原因。
            if (!this.template) this.template = this.defaultTemplate();
            if (s.photoFrameStyle) this.template.photoFrameStyle = s.photoFrameStyle;
            // 圆角分别存在 cornerConfig（全局圆角）和顶层 borderRadius（图层边框）里，
            // 旧版只存不取，重启后圆角白改。
            if (s.cornerRadiusAll) {
                const cc = this.template.cornerConfig || (this.template.cornerConfig = {});
                cc.cornerRadiusAll = s.cornerRadiusAll;
            }
            if (s.borderRadius) this.template.borderRadius = s.borderRadius;
            if (s.userSignature) this.template.userSignature = s.userSignature;
            if (s.signFont) this.template.signFont = s.signFont;
            if (s.signColor) this.template.signColor = s.signColor;
            if (s.signIncludeModel != null) this.template.signIncludeModel = s.signIncludeModel;
            if (s.creditMode != null) this.template.creditMode = s.creditMode;
            if (s.avatarScale) this.template.avatarScale = s.avatarScale;
            if (s.signSize) this.template.signSize = s.signSize;
            if (s.avatarShow !== undefined) this.template.avatarShow = s.avatarShow;
            if (s.signBgBlur != null) this.template.signBgBlur = s.signBgBlur;
            if (s.paramColor) this.template.paramColor = s.paramColor;
            if (s.paramFontSize) this.template.paramFontSize = s.paramFontSize;
            if (s.brandSize) this.template.brandSize = s.brandSize;
            if (s.brandLogo != null) this.template.brandLogo = s.brandLogo;
            if (s.paramScale) this.template.paramScale = s.paramScale;
            if (s.liquidGlassSize) this.template.liquidGlassSize = s.liquidGlassSize;
            if (s.liquidGlassDate != null) this.template.liquidGlassDate = s.liquidGlassDate;
            if (typeof s.polaroidCaption === 'string') this.template.polaroidCaption = s.polaroidCaption;
            if (typeof s.hassyCaption === 'string') this.template.hassyCaption = s.hassyCaption;
            if (s.appleCard && typeof s.appleCard === 'object') this.template.appleCard = s.appleCard;
            if (s.xmLeica && typeof s.xmLeica === 'object') this.template.xmLeica = s.xmLeica;
            // 用户显式记忆过「背景模糊默认开/关」时，它优先于旧草稿里的单次值。
            if (typeof this.applyBgBlurDefault === 'function') this.applyBgBlurDefault(this.template);
            this._lastStateApplied = true;
            this.refreshUI();
            this.scheduleRender();
        } catch (_) {}
    },

    // ── 背景模糊「默认」记忆 ──
    // chkBgBlur 只改当前模板的 signBgBlur；切预设/重启时会被预设自带值覆盖。
    // 这里额外记一个全局偏好：null=跟随预设（保持旧行为/视觉基线），1/0=用户显式指定。
    // 存 localStorage 而不是主进程 prefs：save-prefs 是整对象替换，加字段容易误删导出偏好。
    readBgBlurDefault() {
        try {
            const v = localStorage.getItem('qfs_bg_blur_default');
            return v === '1' ? 1 : v === '0' ? 0 : null;
        } catch (_) { return null; }
    },

    saveBgBlurDefault(v) {
        this._bgBlurDefault = v ? 1 : 0;
        try { localStorage.setItem('qfs_bg_blur_default', this._bgBlurDefault ? '1' : '0'); } catch (_) {}
        this.refreshBgBlurDefaultUI();
    },

    // 只对面板里真的露出「背景模糊」开关的风格生效；
    // 卡片/模糊系风格的模糊是预设结构的一部分，不能被这个开关误改。
    bgBlurToggleSupported(style) {
        const caps = window.StyleCaps;
        if (!caps || typeof caps.visibleRows !== 'function') return false;
        return !!caps.visibleRows(style || '').rowBgBlur;
    },

    applyBgBlurDefault(tpl) {
        if (!tpl || this._bgBlurDefault == null) return;
        if (!this.bgBlurToggleSupported(tpl.photoFrameStyle)) return;
        tpl.signBgBlur = this._bgBlurDefault ? 1 : 0;
    },

    refreshBgBlurDefaultUI() {
        const btn = document.getElementById('btnBgBlurDefault');
        if (!btn) return;
        const v = this._bgBlurDefault;
        btn.textContent = v == null ? '默认跟随' : (v ? '默认开' : '默认关');
        btn.setAttribute('aria-pressed', v === 1 ? 'true' : 'false');
        btn.title = v == null
            ? '未设置：跟随各预设自带的背景模糊开关。点击记住为“默认开启”'
            : (v ? '已记住：支持背景模糊的预设默认开启。点击改为“默认关闭”' : '已记住：支持背景模糊的预设默认关闭。点击改为“默认开启”');
    },

    // macOS 显示 ⌘,Windows/Linux 显示 Ctrl
    modKeyLabel() {
        return (window.qingframe && window.qingframe.isMac) ? '⌘' : 'Ctrl';
    },

    // 静态 HTML 里的 title/kbd 是按 Windows 写的;macOS 启动后统一替换显示。
    // 动态 title 在设置处自己用 modKeyLabel(),这里只处理首屏已有节点。
    adaptMacLabels() {
        if (!(window.qingframe && window.qingframe.isMac)) return;
        document.querySelectorAll('[title]').forEach(el => {
            if (el.title && el.title.includes('Ctrl')) el.title = el.title.replace(/Ctrl/g, '⌘');
        });
        document.querySelectorAll('kbd').forEach(el => {
            if (el.textContent.trim() === 'Ctrl') el.textContent = '⌘';
        });
    },

    init() {
        this.initSplash();
        this.cacheDom();
        this._bgBlurDefault = this.readBgBlurDefault();
        this.bind();
        if (this.initImmersive) this.initImmersive();
        if (this.initPresetWall) this.initPresetWall();
        if (this.initCrop) this.initCrop();
        if (this.initGrade) this.initGrade();
        if (this.initGradePresets) this.initGradePresets();
        if (this.initRawPanel) this.initRawPanel();
        this.loadPrefs();
        // 状态恢复要等预设加载完：预设名要能查到、模板也要有默认值可落。
        // 具体触发点在 loadPresets 末尾（restoreLastState 自身也有就绪守卫）。
        this._presetsReady = this.loadPresets();   // 墙/侧栏点击要等它就绪，否则头一秒点卡片会点空
        this.loadLogos();
        this.loadTextures();
        this.populateFonts();
        this.setupShortcuts();
        this.setupPanelInteractions();
        this.initPanelCollapse();
        // 参数栏密度 / 低频组折叠 / 页签收纳 / 状态收敛
        if (window.QfsPanelDensity) window.QfsPanelDensity.init(this);
        // 工具栏按钮tooltip
        const mod = this.modKeyLabel();
        const tips = {
            btnUndo: `撤销 (${mod}+Z)`, btnRedo: `重做 (${mod}+Y)`,
            btnReset: '重置', btnRandom: '随机预设',
            btnFit: '适应窗口', btnOpen: '导入照片',
        };
        Object.entries(tips).forEach(([id, tip]) => {
            const el = document.getElementById(id);
            if (el) el.title = tip;
        });
        this.adaptMacLabels();
        document.querySelectorAll('.pg-title.collapsible').forEach(t => {
            if (t._bound) return;
            t._bound = true;
            t.addEventListener('click', () => {
                const g = t.parentElement;
                if (!g) return;
                g.classList.toggle('collapsed');
                if (window.QfsPanelDensity) window.QfsPanelDensity.onFoldChange(g);
                // 曲线画布折叠时布局尺寸为 0，期间的重绘会按兜底尺寸建 backing store，
                // 展开后必须按真实尺寸重画一次，否则糊成一片。
                if (!g.classList.contains('collapsed')
                    && g.querySelector('#curveCanvas') && typeof this.drawCurve === 'function') {
                    this.drawCurve();
                }
            });
        });
        const tplSearch = document.getElementById('tfTemplateSearch');
        if (tplSearch) {
            tplSearch.addEventListener('input', () => this._applyTplFilter());
            tplSearch.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape' || !tplSearch.value) return;
                e.preventDefault();
                e.stopPropagation();
                tplSearch.value = '';
                this._applyTplFilter();
            });
        }
        const tplClear = document.getElementById('btnClearTplSearch');
        if (tplClear) {
            tplClear.addEventListener('click', () => {
                if (tplSearch) {
                    tplSearch.value = '';
                    tplSearch.focus();
                }
                this._applyTplFilter();
            });
        }
        const tplRefresh = document.getElementById('btnRefreshTemplates');
        if (tplRefresh) {
            tplRefresh.addEventListener('click', (e) => {
                // 标题本身负责折叠,刷新按钮不能顺带把整组收起。
                e.stopPropagation();
                this.refreshTemplates();
            });
        }
        this.updateHistoryButtons();
        this.initLogin();
        this.initDraft();
        // 首帧预设:启动页撤掉、恢复草稿跑完后,在空闲回调里选中第一个预设。
        // 用模板引用判断「没人碰过」:restoreLastState 恢复草稿 / 用户手动点预设都会
        // 替换 this.template,此时引用不再等于启动时的引用,选择被安全跳过。
        const bootTpl = this.template;
        const pickFirst = () => {
            if (this.presets && this.presets.length && this.template === bootTpl
                && !this._wallActive && !this._lastStateApplied) this.selectPreset(this.presets[0]);
            this.updateEmptyState();
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(pickFirst, { timeout: 1500 });
        else setTimeout(pickFirst, 1000);
        // 新手引导:比首帧预设选择更晚触发,界面就绪后弹出,不抢首帧
        const showIntro = () => this.showIntroIfNeeded();
        if (typeof requestIdleCallback === 'function') requestIdleCallback(showIntro, { timeout: 4000 });
        else setTimeout(showIntro, 3000);
        // 启动默认进预设墙主页(画廊选风格);「跳过/进入工作台」或点卡片后进入编辑。
        // window.__qfTest 由 tools/preload-measure.js 注入：GUI 用例在墙出现之前就写好了，
        // 墙的 fixed 覆盖层会把 sendInputEvent 的真实鼠标事件全挡住，测试里不自动打开。
        if (!window.__qfTest && this.openPresetWall) this.openPresetWall();
    },

    // 恢复上次的界面偏好(导出质量 / 拍摄信息开关)
    async loadPrefs() {
        try {
            const p = await window.qingframe.getPrefs();
            if (p && p.exportQuality && this.dom.slExportQuality) {
                this.dom.slExportQuality.value = p.exportQuality;
            }
            if (p && p.exportFormat && this.dom.selFormat) {
                this.dom.selFormat.value = p.exportFormat;
            }
            if (p && p.exportColorSpace && this.dom.selColorSpace) {
                const v = String(p.exportColorSpace);
                if (Array.from(this.dom.selColorSpace.options).some(o => o.value === v)) {
                    this.dom.selColorSpace.value = v;
                }
            }
            // 尺寸也要跨会话记忆：以前只有质量/格式/EXIF/GPS 四项存了，
            // 习惯导 2048px 的人重开后整批又变回 6000px 原图。
            // 只接受下拉里真实存在的值，避免旧 prefs 里的脏值把 select 变成空选。
            if (p && p.exportSize != null && this.dom.selExportSize) {
                const v = String(p.exportSize);
                if (Array.from(this.dom.selExportSize.options).some(o => o.value === v)) {
                    this.dom.selExportSize.value = v;
                }
            }
            if (p && typeof p.keepExif === 'boolean' && this.dom.chkKeepExif) this.dom.chkKeepExif.checked = p.keepExif;
            if (p && typeof p.keepGps === 'boolean' && this.dom.chkKeepGps) this.dom.chkKeepGps.checked = p.keepGps;
            if (this.dom.chkKeepGps) this.dom.chkKeepGps.disabled = !(this.dom.chkKeepExif && this.dom.chkKeepExif.checked);
            if (p && typeof p.fontScale === 'number' && p.fontScale > 0) this.applyFontScale(p.fontScale);
            if (p && (p.theme === 'dark' || p.theme === 'light')) this.applyTheme(p.theme);
            // 密度与折叠状态也来自 prefs；GUI 用例的 get-prefs 返回 {}，于是按默认值落地
            if (window.QfsPanelDensity) window.QfsPanelDensity.setPrefs(p);
            this.applyPreviewQuality(!!(p && p.previewQuality === 'full'));
            // 更新内容:「已读版本」用来决定按钮上的小红点,读过的版本不再提醒
            this._changelogSeen = (p && typeof p.changelogSeen === 'string') ? p.changelogSeen : '';
            this.syncChangelogDot();
            // 自动检查更新的频率:startup(默认) / daily / off。认不出的值回落到 startup
            const ac = this.$('selAutoCheck');
            if (ac) ac.value = ['startup', 'daily', 'off'].indexOf(p && p.autoCheck) >= 0 ? p.autoCheck : 'startup';
        } catch (_) {}
    },

    // 界面缩放:把系数写到 documentElement 的 --font-scale,字号阶梯(--fs-*)与间距刻度(--sp-*)
    // 都乘它(见 style.css),于是字号、内边距、行高一起缩放。同步更新设置里的滑块与百分比。
    applyFontScale(scale) {
        const s = (typeof scale === 'number' && isFinite(scale) && scale > 0) ? scale : 1;
        document.documentElement.style.setProperty('--font-scale', String(s));
        const d = this.dom || {};
        if (d.slFontScale) d.slFontScale.value = String(s);
        if (d.lblFontScale) d.lblFontScale.textContent = Math.round(s * 100) + '%';
        // 字号变化会改变顶栏实际内容宽度；测量放到下一帧，避免拿到旧布局。
        this._scheduleToolbarOverflow();
    },

    // 顶栏宽度只看「内容是否溢出」，不按视口断点猜。140% 界面缩放下按钮字变宽时，
    // 自动退成图标模式，保证主题 / 设置 / 账户永远留在屏幕内。
    syncToolbarOverflow() {
        const tb = this.dom && this.dom.toolbar;
        if (!tb) return;
        tb.classList.remove('toolbar-tight');
        if (tb.scrollWidth > tb.clientWidth + 1) tb.classList.add('toolbar-tight');
    },

    // resize / 字号 / 面板宽度变化都可能在同一帧里连发，合并成一次测量。
    _scheduleToolbarOverflow() {
        if (this._toolbarOverflowRaf) return;
        this._toolbarOverflowRaf = requestAnimationFrame(() => {
            this._toolbarOverflowRaf = 0;
            this.syncToolbarOverflow();
        });
    },

    _saveFontScale() {
        const d = this.dom || {};
        const s = d.slFontScale ? parseFloat(d.slFontScale.value) : 1;
        if (!window.qingframe || !window.qingframe.savePrefs) return;
        window.qingframe.savePrefs({ fontScale: s }).catch(() => {});
    },

    // 预览画质:「标准」= 成品长边降到 1800px(默认,流畅);「原图 1:1」= 按照片原始分辨率渲染。
    // setupCanvas 里 ui = min(1, displayMax / 长边):删掉 displayMax 就回落默认 1800;
    // 设成很大的值则 ui=1 不再缩小。但后备缓冲 = 逻辑尺寸 × devicePixelRatio,高分屏上还要再翻一倍,
    // 所以按 DPR 反推一个安全上限,把缓冲长边压在约 12000px 内 —— 否则超大图会让画布创建失败或吃掉大量内存。
    _previewMaxFull() {
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        return Math.max(1800, Math.floor(12000 / Math.max(1, dpr)));
    },

    applyPreviewQuality(full) {
        this._previewFull = !!full;
        if (full) this.displayMax = this._previewMaxFull();
        else delete this.displayMax; // 回到 setupCanvas 的默认 1800
        const seg = this.dom && this.dom.segPreview;
        if (seg) {
            seg.querySelectorAll('[data-preview]').forEach((b) => {
                const on = (b.dataset.preview === 'full') === this._previewFull;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
        }
        // 没图时不触发渲染:启动恢复阶段还没载入照片,后续正常渲染自然会用到新的 displayMax。
        if (this.image && typeof this.scheduleRender === 'function') this.scheduleRender(true);
    },

    _savePreviewQuality() {
        if (!window.qingframe || !window.qingframe.savePrefs) return;
        window.qingframe.savePrefs({ previewQuality: this._previewFull ? 'full' : 'standard' }).catch(() => {});
    },

    // 导出偏好三项一起存。主进程现在会合并 prefs,但全量提交仍能兼容旧版主进程
    // (旧版是整对象替换,分开发会互相抹掉)。
    _saveExportPrefs() {
        const d = this.dom || {};
        if (!window.qingframe || !window.qingframe.savePrefs) return;
        // 异步调用,静默忽略失败(旧主进程无该 handler 时不报未处理错误)
        window.qingframe.savePrefs({
            exportQuality: d.slExportQuality ? d.slExportQuality.value : undefined,
            exportFormat: d.selFormat ? d.selFormat.value : undefined,
            exportSize: d.selExportSize ? d.selExportSize.value : undefined,
            exportColorSpace: d.selColorSpace ? d.selColorSpace.value : undefined,
            keepExif: !!(d.chkKeepExif && d.chkKeepExif.checked),
            keepGps: !!(d.chkKeepGps && d.chkKeepGps.checked)
        }).catch(() => {});
    },

    /* ── 侧栏收起 / 展开 / 拖动宽度 ──
       小屏(1000px 最小窗)下左右栏固定吃掉 544px,画布只剩四百多。
       这里把两栏做成可收起并记住状态/宽度:按钮在栏头,收起后画布边缘留一条窄轨可展开,
       拖栏边可调宽度,双击栏边恢复默认。 */
    initPanelCollapse() {
        const body = document.body;
        const side = this.dom.sidebar;
        const insp = this.dom.inspector;
        if (!side || !insp) return;
        const K_SIDE = 'qfs_sidebar_collapsed';
        const K_INSP = 'qfs_inspector_collapsed';
        const K_SIDE_W = 'qfs_sidebar_width';
        const K_INSP_W = 'qfs_inspector_width';
        const num = (k, d) => { const v = parseInt(localStorage.getItem(k) || '', 10); return isFinite(v) ? v : d; };
        side.style.width = Math.max(180, Math.min(360, num(K_SIDE_W, 236))) + 'px';
        insp.style.width = Math.max(260, Math.min(440, num(K_INSP_W, 308))) + 'px';
        const fit = () => { if (this._followFit && this.image) setTimeout(() => this.fitZoom(), 40); };
        const sync = () => {
            const sc = localStorage.getItem(K_SIDE) === '1';
            const ic = localStorage.getItem(K_INSP) === '1';
            body.classList.toggle('sidebar-collapsed', sc);
            body.classList.toggle('inspector-collapsed', ic);
            if (this.dom.sidebarRail) this.dom.sidebarRail.hidden = !sc;
            if (this.dom.inspectorRail) this.dom.inspectorRail.hidden = !ic;
            this._scheduleToolbarOverflow();
            fit();
        };
        const toggle = (key) => { localStorage.setItem(key, localStorage.getItem(key) === '1' ? '0' : '1'); sync(); };
        ['btnSidebarCollapse', 'btnSidebarRail'].forEach(id => {
            const el = this.$(id);
            if (el) el.addEventListener('click', () => toggle(K_SIDE));
        });
        ['btnInspectorCollapse', 'btnInspectorRail'].forEach(id => {
            const el = this.$(id);
            if (el) el.addEventListener('click', () => toggle(K_INSP));
        });
        // 拖动调宽:方向由栏在画布哪一侧决定。双击恢复默认宽度。
        const bindResize = (el, target, key, min, max, defW, dir) => {
            if (!el) return;
            el.addEventListener('dblclick', () => {
                target.style.width = defW + 'px';
                localStorage.removeItem(key);
                fit();
            });
            el.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = target.getBoundingClientRect().width;
                el.setPointerCapture(e.pointerId);
                el.classList.add('dragging');
                const move = (ev) => {
                    const w = Math.max(min, Math.min(max, startW + dir * (ev.clientX - startX)));
                    target.style.width = Math.round(w) + 'px';
                };
                const up = () => {
                    try { el.releasePointerCapture(e.pointerId); } catch (_) { /* 已释放 */ }
                    el.classList.remove('dragging');
                    el.removeEventListener('pointermove', move);
                    el.removeEventListener('pointerup', up);
                    el.removeEventListener('pointercancel', up);
                    localStorage.setItem(key, String(Math.round(target.getBoundingClientRect().width)));
                    fit();
                };
                el.addEventListener('pointermove', move);
                el.addEventListener('pointerup', up);
                el.addEventListener('pointercancel', up);
            });
        };
        bindResize(this.$('sidebarResizer'), side, K_SIDE_W, 180, 360, 236, 1);
        bindResize(this.$('inspectorResizer'), insp, K_INSP_W, 260, 440, 308, -1);
        // Ctrl+[ / Ctrl+] 收起展开(Mac 为 ⌘)。Tab 键留给焦点导航,不抢。
        document.addEventListener('keydown', (e) => {
            if (this._immersionOpen || e.repeat) return;
            const mod = (window.qingframe && window.qingframe.isMac) ? e.metaKey : e.ctrlKey;
            if (!mod || e.altKey || e.shiftKey) return;
            // 输入框里 Ctrl+[ / Ctrl+] 交给控件自己处理,不能被当成面板开关；
            // range 滑块不算打字(与 setupShortcuts 的口径一致)。
            const el = document.activeElement;
            const tag = (el && el.tagName) || '';
            const typing = !!el && (el.isContentEditable ||
                ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && !(tag === 'INPUT' && el.type === 'range')));
            if (typing) return;
            if (e.key === '[') { e.preventDefault(); toggle(K_SIDE); }
            else if (e.key === ']') { e.preventDefault(); toggle(K_INSP); }
        });
        // 窄窗口优先收左侧素材栏（<1200），把画面让给照片；用户手动展开/收起后尊重用户选择。
        let autoSide = false;
        const applyResponsive = () => {
            const narrow = window.innerWidth < 1200;
            const manual = localStorage.getItem(K_SIDE);
            if (narrow && manual === null) {
                autoSide = true;
                body.classList.add('sidebar-collapsed');
                if (this.dom.sidebarRail) this.dom.sidebarRail.hidden = false;
                fit();
            } else if (!narrow && autoSide) {
                autoSide = false;
                const collapse = localStorage.getItem(K_SIDE) === '1';
                body.classList.toggle('sidebar-collapsed', collapse);
                if (this.dom.sidebarRail) this.dom.sidebarRail.hidden = !collapse;
                fit();
            }
        };
        let resizeT = 0;
        window.addEventListener('resize', () => {
            // 先量一次顶栏：等 120ms 去抖结束再量，用户会看到按钮被裁一下。
            this._scheduleToolbarOverflow();
            clearTimeout(resizeT);
            resizeT = setTimeout(() => {
                applyResponsive();
                this.syncToolbarOverflow();
            }, 120);
        });
        sync();
        applyResponsive();
        this._scheduleToolbarOverflow();
    },

    cacheDom() {
        const $ = id => document.getElementById(id);
        this.dom = {
            btnOpen: $('btnOpen'), btnOpenFolder: $('btnOpenFolder'), btnSave: $('btnSave'), btnCopy: $('btnCopy'), selFormat: $('selFormat'), selExportSize: $('selExportSize'), selColorSpace: $('selColorSpace'),
            slExportQuality: $('slExportQuality'), exportSizeNote: $('exportSizeNote'),
            chkKeepExif: $('chkKeepExif'), chkKeepGps: $('chkKeepGps'),
            btnExportSettings: $('btnExportSettings'), exportPop: $('exportPop'),
            btnEpPickDir: $('btnEpPickDir'), btnEpClearDir: $('btnEpClearDir'), epExportDirPath: $('epExportDirPath'),
            btnSyncSel: $('btnSyncSel'), btnUndo: $('btnUndo'), btnRedo: $('btnRedo'),
            btnReset: $('btnReset'), btnRandom: $('btnRandom'), btnFit: $('btnFit'),
            zoomInput: $('zoomInput'), zoomRange: $('zoomRange'), btnTheme: $('btnTheme'),
            toolbar: $('toolbar'), btnImportMore: $('btnImportMore'), importPop: $('importPop'),
            btnToolbarMore: $('btnToolbarMore'), toolbarMoreMenu: $('toolbarMoreMenu'),
            segTheme: $('segTheme'), segPreview: $('segPreview'),
            btnSettingsResetAll: $('btnSettingsResetAll'), updateMirrorCustom: $('updateMirrorCustom'),
            presetTree: $('presetTree'), presetSearch: $('presetSearch'),
            canvas: $('previewCanvas'), canvasPane: $('canvasPane'), placeholder: $('placeholder'), inspector: $('inspector'),
            stage: document.querySelector('.stage'),
            thumbStrip: $('thumbStrip'), dropOverlay: $('dropOverlay'),
            sidebar: $('sidebar'), inspectorRail: $('btnInspectorRail'), sidebarRail: $('btnSidebarRail'),
            importProgress: $('importProgress'), importProgressFill: $('importProgressFill'), importProgressText: $('importProgressText'),
            tabs: $('inspTabs'), panels: Array.from(document.querySelectorAll('.tab-panel')),
            stRes: $('stRes'), stInfo: $('stInfo'), stCanvas: $('stCanvas'),
            btnCompare: $('btnCompare'),
            loginModal: $('loginModal'),
            loginModalClose: $('loginModalClose'),
            loginUsername: $('loginUsername'),
            loginNickname: $('loginNickname'),
            loginSubmit: $('loginSubmit'),
            loginLogout: $('loginLogout'),
            loginFormView: $('loginFormView'),
            loginProfileView: $('loginProfileView'),
            loginAvatar: $('loginAvatar'),
            loginDisplayName: $('loginDisplayName'),
            loginUsernameDisplay: $('loginUsernameDisplay'),
            slFontScale: $('slFontScale'), lblFontScale: $('lblFontScale'), btnFontScaleReset: $('btnFontScaleReset'),
        };
    },

    $(id) { return document.getElementById(id); },

    /* 顶栏两个弹出菜单：导入方式 / 更多编辑操作。同一时间只开一个。 */
    _bindToolbarMenus() {
        const closeAll = () => {
            for (const [btn, pop] of [[this.dom.btnImportMore, this.dom.importPop],
                [this.dom.btnToolbarMore, this.dom.toolbarMoreMenu]]) {
                if (pop) pop.hidden = true;
                if (btn) btn.setAttribute('aria-expanded', 'false');
            }
        };
        const wire = (btn, pop) => {
            if (!btn || !pop) return;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const wantOpen = pop.hidden;
                closeAll();
                pop.hidden = !wantOpen;
                btn.setAttribute('aria-expanded', wantOpen ? 'true' : 'false');
            });
            pop.addEventListener('click', (e) => { if (e.target.closest('button')) closeAll(); });
        };
        wire(this.dom.btnImportMore, this.dom.importPop);
        wire(this.dom.btnToolbarMore, this.dom.toolbarMoreMenu);
        document.addEventListener('click', (e) => { if (!e.target.closest('.tool-split')) closeAll(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
    },

    bind() {
        const d = this.dom;
        this._bindToolbarMenus();
        d.btnOpen.addEventListener('click', () => this.openImages());
        const pick = this.$('btnPickPhoto');
        if (pick) pick.addEventListener('click', () => this.openImages());
        const pickFolder = this.$('btnPickFolder');
        if (pickFolder) pickFolder.addEventListener('click', () => this.openImageFolder());
        const pickSample = this.$('btnSamplePhoto');
        if (pickSample) pickSample.addEventListener('click', () => this.loadSamplePhoto());
        if (d.btnOpenFolder) d.btnOpenFolder.addEventListener('click', () => this.openImageFolder());
        d.btnSave.addEventListener('click', () => this.doExport());
        if (d.btnCopy) d.btnCopy.addEventListener('click', () => this.copyImage());
        if (d.btnExportSettings && d.exportPop) {
            d.btnExportSettings.addEventListener('click', (e) => {
                e.stopPropagation();
                const open = d.exportPop.style.display !== 'block';
                d.exportPop.style.display = open ? 'block' : 'none';
                // 提示只在弹窗可见时才有意义。挂在这里而不是每处照片/样式载入点,
                // 是因为导入、切图、恢复草稿、导入模板的赋值点分散在 6+ 处,逐个挂必漏;
                // 而弹窗打开这一个时机就能保证「看到提示时它一定是对的」。
                if (open) { this.updateExportSizeNote(); this.refreshExportDirRow(); }
            });
            document.addEventListener('click', (ev) => {
                // 用 contains 而不是 !==:箭头按钮里现在有 SVG,点的 target 是 <path> 不是按钮本身
                if (d.exportPop.style.display === 'block' && !d.btnExportSettings.contains(ev.target) && !d.exportPop.contains(ev.target)) {
                    d.exportPop.style.display = 'none';
                }
            });
        }
        if (d.slExportQuality) d.slExportQuality.addEventListener('change', () => this._saveExportPrefs());
        // 格式也记进偏好：以前每次启动都回到默认 JPG，常用 PNG 的人每次都要重选
        if (d.selFormat) d.selFormat.addEventListener('change', () => this._saveExportPrefs());
        if (d.selColorSpace) d.selColorSpace.addEventListener('change', () => this._saveExportPrefs());
        // 导出弹层里的「保存到」：更改/改回询问直接复用设置里的同一套取目录逻辑，
        // 只是改完额外刷新弹层这一行（设置弹窗那行由 choose*/clear* 内部顺带刷新）。
        if (d.btnEpPickDir) d.btnEpPickDir.addEventListener('click', async () => {
            await this.chooseDefaultExportDir();
            await this.refreshExportDirRow();
        });
        if (d.btnEpClearDir) d.btnEpClearDir.addEventListener('click', async () => {
            await this.clearDefaultExportDir();
            await this.refreshExportDirRow();
        });
        if (d.chkKeepExif) {
            d.chkKeepExif.addEventListener('change', () => {
                // 总开关关掉时 GPS 选项失去意义,置灰但保留状态(重新打开总开关时恢复)
                if (d.chkKeepGps) d.chkKeepGps.disabled = !d.chkKeepExif.checked;
                this._saveExportPrefs();
            });
        }
        if (d.chkKeepGps) d.chkKeepGps.addEventListener('change', () => this._saveExportPrefs());
        // 尺寸提示依赖「所选档位 × 当前照片 × 当前相框样式」,三者任一变化都要重算
        if (d.selExportSize) d.selExportSize.addEventListener('change', () => {
            this.updateExportSizeNote();
            this._saveExportPrefs();
        });
        d.btnSyncSel.addEventListener('click', () => this.syncToSelected());
        d.btnUndo.addEventListener('click', () => this.undo());
        d.btnRedo.addEventListener('click', () => this.redo());
        d.btnReset.addEventListener('click', () => this.resetParams());
        d.btnRandom.addEventListener('click', () => this.randomBorder());
        d.btnFit.addEventListener('click', () => this.fitZoom());
        // 窗口尺寸变化:视图停在「适应」时自动重算缩放。
        // 否则窄窗会把画布裁掉(画布区 overflow:hidden,没有滚动条),宽窗又只占中间一小块。
        // 手动缩放/平移会退出跟随(setZoom / 画布平移处置 false),不打扰用户已经调好的视角。
        if (typeof ResizeObserver === 'function' && d.stage) {
            const ro = new ResizeObserver(() => {
                clearTimeout(this._fitResizeT);
                this._fitResizeT = setTimeout(() => {
                    if (this._immersionOpen || !this._followFit || !this.image || this.uiDprOverride === 1) return;
                    this.fitZoom();
                }, 140);
            });
            ro.observe(d.stage);
            this._fitResizeRO = ro;
        }
        d.btnTheme.addEventListener('click', () => this.toggleTheme());
        d.zoomRange.addEventListener('input', e => this.setZoom(parseInt(e.target.value, 10) / 100));
        d.zoomInput.addEventListener('change', e => {
            const v = parseFloat(String(e.target.value).replace('%', ''));
            if (!isNaN(v)) this.setZoom(Math.min(3, Math.max(0.1, v / 100)));
        });
        d.presetSearch.addEventListener('input', () => this.filterTree(d.presetSearch.value.trim()));
        const borderBackWall = this.$('btnBorderBackWall');
        if (borderBackWall) {
            borderBackWall.addEventListener('click', () => {
                if (typeof this.openPresetWall === 'function') {
                    this.openPresetWall(!!(this.image && this.image.el));
                }
            });
        }
        d.tabs.addEventListener('click', e => {
            // 只认带 data-tab 的页签:工具栏分隔符后的收起按钮也带 .tab 样式,
            // 若把它当成页签会 switchTab(undefined),六个面板会一起被隐藏。
            const btn = e.target.closest('.tab[data-tab]');
            if (btn) this.switchTab(btn.dataset.tab);
        });
        const myTemplates = this.$('btnMyTemplates');
        if (myTemplates) myTemplates.addEventListener('click', () => this.switchTab('template'));
        // 对比原图:Pointer 统一鼠标/触屏;另支持 空格 按住短按。
        // (不用 Alt:窗口是 autoHideMenuBar,Windows 上 Alt 会唤出菜单栏并抢走按键)
        d.btnCompare.addEventListener('pointerdown', e => { e.preventDefault(); this.setCompare(true); });
        d.btnCompare.addEventListener('pointerup', () => this.setCompare(false));
        d.btnCompare.addEventListener('pointercancel', () => this.setCompare(false));
        d.btnCompare.addEventListener('pointerleave', () => this.setCompare(false));
        document.addEventListener('keydown', e => {
            if (this._immersionOpen) return;
            if (e.code !== 'Space' || e.ctrlKey || e.altKey || e.metaKey) return;
            const el = document.activeElement;
            const tag = (el && el.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
            e.preventDefault();
            this.setCompare(true);
        });
        document.addEventListener('keyup', e => { if (e.code === 'Space') this.setCompare(false); });
        window.addEventListener('blur', () => { if (this.draggingCompare) this.setCompare(false); });
        const btnCancel = document.getElementById('btnExportCancel');
        if (btnCancel) btnCancel.addEventListener('click', () => { this._exportAbort = true; });
        const btnExportOpen = document.getElementById('btnExportOpen');
        if (btnExportOpen) btnExportOpen.addEventListener('click', () => this._openExportDest());
        const btnExportRetry = document.getElementById('btnExportRetry');
        if (btnExportRetry) btnExportRetry.addEventListener('click', () => this._retryFailedExport());
        this.updateTopBar();
        // 顶栏不再放账号入口：昵称/头像只服务「签名 / 头像」参数，
        // 入口跟着那组参数走，工作台里不再出现一个像账号系统的头像环。
        const btnUserProfile = document.getElementById('btnEditUserProfile');
        if (btnUserProfile) btnUserProfile.addEventListener('click', () => this.openLoginModal());
        d.loginModalClose.addEventListener('click', () => this.closeLoginModal());
        d.loginModal.addEventListener('mousedown', e => { if (e.target === d.loginModal) this.closeLoginModal(); });
        d.loginSubmit.addEventListener('click', () => this.doLogin());
        d.loginLogout.addEventListener('click', () => this.doLogout());
        d.loginUsername.addEventListener('keydown', e => { if (e.key === 'Enter') this.doLogin(); });
        d.loginNickname.addEventListener('keydown', e => { if (e.key === 'Enter') this.doLogin(); });
        this.loadUserAvatar();
        this.setupDragDrop();
        // 签名输入
        const inpSig = document.getElementById('inpSignature');
        if (inpSig) inpSig.addEventListener('input', () => { this.template.userSignature = inpSig.value; this.onSettingChanged(); });
        // 拍立得底部文字输入
        const inpPC = document.getElementById('inpPolaroidCaption');
        if (inpPC) inpPC.addEventListener('input', () => { this.template.polaroidCaption = inpPC.value; this.onSettingChanged(); });
        const inpHC = document.getElementById('inpHassyCaption');
        if (inpHC) inpHC.addEventListener('input', () => { this.template.hassyCaption = inpHC.value; this.onSettingChanged(); });
        // 苹果信息卡:日期 / 颜色(即时写入模板并重绘;复选框走通用 chks + syncModelFromUI)。
        // 品牌/型号/参数不在这里另开输入 —— 它们统一由下方「相机参数(自动识别)」驱动。
        [['tfAppleDate', 'dateText']].forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => {
                const ac = this.template.appleCard || (this.template.appleCard = {});
                ac[key] = el.value;
                this.onSettingChanged();
            });
        });
        [['cpAppleText', 'textColor'], ['cpAppleSub', 'subColor'], ['cpAppleLine', 'lineColor'],
         ['cpAppleBarBg', 'barBg']].forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => {
                const ac = this.template.appleCard || (this.template.appleCard = {});
                ac[key] = el.value;
                this.onSettingChanged();
            });
        });
        const cbAF = document.getElementById('cbAppleFont');
        if (cbAF) cbAF.addEventListener('change', () => {
            const ac = this.template.appleCard || (this.template.appleCard = {});
            ac.fontFamily = cbAF.value;
            this.onSettingChanged();
        });
        // 联名水印:文本/颜色/对齐(即时写入模板并重绘;滑块走通用 slXm* 分支)
        [['tfXmBrand', 'brandText'], ['tfXmLine1', 'line1'], ['tfXmLine2', 'line2'], ['tfXmPartner', 'partnerBrand']].forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => {
                const xc = this.template.xmLeica || (this.template.xmLeica = {});
                xc[key] = el.value;
                this.onSettingChanged();
            });
        });
        [['cpXmText', 'textColor'], ['cpXmSub', 'subColor'], ['cpXmDiv', 'divColor']].forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => {
                const xc = this.template.xmLeica || (this.template.xmLeica = {});
                xc[key] = el.value;
                this.onSettingChanged();
            });
        });
        const cbXmAlign = document.getElementById('cbXmAlign');
        if (cbXmAlign) cbXmAlign.addEventListener('change', () => {
            const xc = this.template.xmLeica || (this.template.xmLeica = {});
            xc.align = Number(cbXmAlign.value) || 0;
            this.onSettingChanged();
        });
        // 联名水印的「显示」开关必须单独接:它们不经过通用 checkbox 通道
        [['chkXmShowDiv', 'showDiv'], ['chkXmShowScrim', 'showScrim']].forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => {
                const xc = this.template.xmLeica || (this.template.xmLeica = {});
                xc[key] = el.checked ? 1 : 0;
                this.onSettingChanged();
            });
        });
        const slXmBT = document.getElementById('slXmBrandTrack');
        if (slXmBT) slXmBT.addEventListener('input', () => {
            const xc = this.template.xmLeica || (this.template.xmLeica = {});
            xc.brandTracking = Number(slXmBT.value) / 100;
            this.updateLabel('lblXmBrandTrack', slXmBT.value + '%');
            this.onSettingChanged();
        });
        const cbXmLW = document.getElementById('cbXmLineWeight');
        if (cbXmLW) cbXmLW.addEventListener('change', () => {
            const xc = this.template.xmLeica || (this.template.xmLeica = {});
            xc.lineWeight = Number(cbXmLW.value) || 600;
            this.onSettingChanged();
        });
        const cpXmL = document.getElementById('cpXmLogo');
        if (cpXmL) cpXmL.addEventListener('input', () => {
            const xc = this.template.xmLeica || (this.template.xmLeica = {});
            xc.logoColor = cpXmL.value;
            xc.logoRaw = 0;
            const raw = document.getElementById('chkXmLogoRaw');
            if (raw) raw.checked = false;
            this.onSettingChanged();
        });
        const chkLR = document.getElementById('chkXmLogoRaw');
        if (chkLR) chkLR.addEventListener('change', () => {
            const xc = this.template.xmLeica || (this.template.xmLeica = {});
            xc.logoRaw = chkLR.checked ? 1 : 0;
            this.onSettingChanged();
        });
        const cbXmFont = document.getElementById('cbXmFont');
        if (cbXmFont) cbXmFont.addEventListener('change', () => {
            const xc = this.template.xmLeica || (this.template.xmLeica = {});
            xc.fontFamily = cbXmFont.value;
            this.onSettingChanged();
        });
        const cbF = document.getElementById('cbSignFont');
        if (cbF) cbF.addEventListener('change', () => { this.template.signFont = cbF.value; this.onSettingChanged(); });
        const cbC = document.getElementById('cbSignColor');
        if (cbC) cbC.addEventListener('change', () => { this.template.signColor = cbC.value; this.onSettingChanged(); });
        const chkSM = document.getElementById('chkSignModel');
        if (chkSM) chkSM.addEventListener('change', () => { this.template.signIncludeModel = chkSM.checked ? 1 : 0; this.onSettingChanged(); });
        const cbCM = document.getElementById('cbCreditMode');
        if (cbCM) cbCM.addEventListener('change', () => { this.template.creditMode = Number(cbCM.value) || 0; this.onSettingChanged(); });
        const chkBL = document.getElementById('chkBrandLogo');
        if (chkBL) chkBL.addEventListener('change', () => { this.template.brandLogo = Number(chkBL.value) || 0; this.onSettingChanged(); });
        const chkAS = document.getElementById('chkAvatarShow');
        if (chkAS) chkAS.addEventListener('change', () => {
            this.template.avatarShow = chkAS.checked ? 1 : 0;
            this.onSettingChanged();
        });
        const rgAS = document.getElementById('rgAvatarScale');
        if (rgAS) rgAS.addEventListener('input', () => {
            this.template.avatarScale = Number(rgAS.value) / 100;
            this.updateLabel('valAvatarScale', rgAS.value + '%');
            this.onSettingChanged();
        });
        const rgSS = document.getElementById('rgSignSize');
        if (rgSS) rgSS.addEventListener('input', () => {
            this.template.signSize = Number(rgSS.value) / 100;
            this.updateLabel('valSignSize', rgSS.value + '%');
            this.onSettingChanged();
        });
        const chkBB = document.getElementById('chkBgBlur');
        if (chkBB) chkBB.addEventListener('change', () => {
            this.template.signBgBlur = chkBB.checked ? 1 : 0;
            const rowBI = document.getElementById('rowBgBlurInt');
            if (rowBI) rowBI.style.display = chkBB.checked ? '' : 'none';
            this.syncEmptyGroups();
            this.onSettingChanged();
        });
        const btnBBD = document.getElementById('btnBgBlurDefault');
        if (btnBBD) btnBBD.addEventListener('click', () => {
            // null(跟随) → 默认开；已显式记忆时在开/关之间切换。
            const next = this._bgBlurDefault === 1 ? 0 : 1;
            this.saveBgBlurDefault(next);
            // 立即套到当前预设，而不是只等下一次切预设。
            if (this.template && this.bgBlurToggleSupported(this.template.photoFrameStyle)) {
                this.template.signBgBlur = next;
                if (chkBB) chkBB.checked = !!next;
                const rowBI = document.getElementById('rowBgBlurInt');
                if (rowBI) rowBI.style.display = next ? '' : 'none';
                this.syncEmptyGroups();
                this.onSettingChanged();
            }
        });
        const slBI = document.getElementById('slBgBlurInt');
        if (slBI) {
            this.updateLabel('lblBgBlurInt', slBI.value + '%');
            slBI.addEventListener('input', () => {
                this.template.blurIntensity = Number(slBI.value);
                this.updateLabel('lblBgBlurInt', slBI.value + '%');
                this.onSettingChanged();
            });
        }
        // 样式私有参数（含背景模糊六项）统一由声明表驱动：按当前样式生成行、绑事件。
        // 只有用户真的拖过才把字段写进模板，旧预设 / 工程文件渲染逐像素不变。
        if (window.QfsStyleParamsUI) window.QfsStyleParamsUI.bind(this);
        const btnBlurReset = document.getElementById('btnBlurReset');
        if (btnBlurReset) btnBlurReset.addEventListener('click', () => this.resetBlurAdvanced());
        const btnGotoBlurText = document.getElementById('btnGotoBlurText');
        if (btnGotoBlurText) btnGotoBlurText.addEventListener('click', () => this.gotoBlurTextGroup());

        const cbPC = document.getElementById('cbParamColor');
        if (cbPC) cbPC.addEventListener('change', () => {
            this.template.paramColor = cbPC.value;
            this.onSettingChanged();
        });
        // 头像上传走 app-view.js 的 bindAvatarUpload()（昵称与头像弹窗里的「选择图片」）。
        this.bindAvatarUpload();
        this.bindInteractive();
    },

    updateTopBar() {
        // 兼容旧调用点：账号入口已从顶栏移走，用户资料的显示位置是
        // 「签名 / 头像」参数组里的按钮，统一由 refreshLoginStatus 回写。
        this.refreshLoginStatus();
    },
    // 「签名/头像行」默认关的风格(票根/电影票):预设里的空签名就是「本预设不带签名」,
    // 不能被默认签名重新带出来。这张名单只从 style-caps 取,避免引擎/预设两处各维护一份。
    signatureDefaultOff(tpl) {
        const style = tpl && tpl.photoFrameStyle;
        return !!(window.StyleCaps && window.StyleCaps.sigRowDefaultOff && window.StyleCaps.sigRowDefaultOff(style));
    },
    // 用户没输入签名时,非票券风格统一显示「清框影」。只填空值,不覆盖用户已输入的内容。
    fillDefaultSignature(tpl) {
        if (!tpl || this.signatureDefaultOff(tpl)) return tpl;
        if (!tpl.userSignature) tpl.userSignature = this.DEFAULT_SIGNATURE;
        return tpl;
    },
    loadUserAvatar() {
        this.updateTopBar();
        // 启动时模板可能还没建好;这里只负责已有的空签名,预设应用路径见 applyPreset。
        this.fillDefaultSignature(this.template);
        const saved = localStorage.getItem('qfs_user_avatar');
        if (saved) {
            const img = window.qfsImage();
            img.onload = () => { window.__qfsAvatarImg = img; this.onSettingChanged(); };
            img.src = saved;
        }
    },
    openAvatarCrop(dataUrl) {
        const modal = document.getElementById('avatarCropModal');
        const img = document.getElementById('cropImg');
        const stage = document.getElementById('avatarCropStage');
        if (!modal || !img || !stage) { this.saveUserAvatar(dataUrl); return; }
        const range = document.getElementById('cropZoom');
        const rangeVal = document.getElementById('cropZoomVal');
        modal.style.display = 'flex';
        stage.classList.remove('dragging');
        // 裁剪状态:scale = 每个原图像素占多少 CSS px;x/y = 图片左上角在裁剪框里的位置
        const st = this._crop = { iw: 0, ih: 0, w: 0, scale: 1, min: 1, max: 4, x: 0, y: 0 };
        const pct = () => Math.round(st.scale / st.min * 100);
        // 图片必须始终铺满裁剪框:位置夹在 [w - 图片尺寸, 0],拖不到空白处
        const clamp = () => {
            st.x = Math.min(0, Math.max(st.w - st.iw * st.scale, st.x));
            st.y = Math.min(0, Math.max(st.w - st.ih * st.scale, st.y));
        };
        const paint = () => {
            clamp();
            img.style.width = st.iw * st.scale + 'px';
            img.style.height = st.ih * st.scale + 'px';
            img.style.left = st.x + 'px';
            img.style.top = st.y + 'px';
            const p = pct();
            if (range) range.value = String(Math.max(100, Math.min(400, p)));
            if (rangeVal) rangeVal.textContent = p + '%';
        };
        const center = () => {
            st.x = (st.w - st.iw * st.scale) / 2;
            st.y = (st.w - st.ih * st.scale) / 2;
            paint();
        };
        // 以裁剪框内某点(默认圆心)为锚缩放;滚轮时锚在指针处
        const zoomTo = (next, ax, ay) => {
            const s2 = Math.max(st.min, Math.min(st.max, next));
            if (ax == null) { ax = st.w / 2; ay = st.w / 2; }
            const k = s2 / st.scale;
            st.x = ax - (ax - st.x) * k;
            st.y = ay - (ay - st.y) * k;
            st.scale = s2;
            paint();
        };
        const setup = () => {
            st.iw = img.naturalWidth || 300;
            st.ih = img.naturalHeight || 300;
            st.w = stage.clientWidth || 300;
            st.min = Math.max(st.w / st.iw, st.w / st.ih);   // cover:短边刚好铺满
            st.max = st.min * 4;
            st.scale = st.min;
            center();
        };
        img.onload = setup;
        img.src = dataUrl;
        if (img.complete && img.naturalWidth) setup();
        // 拖动(pointer 事件 + 捕获,拖出裁剪框也不丢)
        let drag = null;
        stage.onpointerdown = (e) => {
            if (e.button !== 0) return;
            drag = { x: e.clientX, y: e.clientY, ox: st.x, oy: st.y };
            stage.classList.add('dragging');
            try { stage.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件没有活动指针 */ }
            e.preventDefault();
        };
        stage.onpointermove = (e) => {
            if (!drag) return;
            st.x = drag.ox + (e.clientX - drag.x);
            st.y = drag.oy + (e.clientY - drag.y);
            paint();
        };
        const endDrag = (e) => {
            if (!drag) return;
            drag = null;
            stage.classList.remove('dragging');
            try { if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        stage.onpointerup = endDrag;
        stage.onpointercancel = endDrag;
        stage.ondblclick = () => { st.scale = st.min; center(); };
        stage.onwheel = (e) => {
            e.preventDefault();
            const r = stage.getBoundingClientRect();
            zoomTo(st.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - r.left, e.clientY - r.top);
        };
        if (range) range.oninput = () => { zoomTo(st.min * (Number(range.value) || 100) / 100); };
        const reset = () => { st.scale = st.min; center(); };
        const resetBtn = document.getElementById('cropReset');
        if (resetBtn) resetBtn.onclick = reset;
        const close = () => { modal.style.display = 'none'; };
        document.getElementById('cropCancel').onclick = close;
        const closeX = document.getElementById('cropCancelX');
        if (closeX) closeX.onclick = close;
        // 确认:直接按当前视口从原图取样,避免先按显示尺寸重采样再二次压缩
        document.getElementById('cropOk').onclick = () => {
            if (!st.iw || !img.naturalWidth || !st.scale) return;
            const c = document.createElement('canvas');
            c.width = 200; c.height = 200;
            const sw = st.w / st.scale;
            c.getContext('2d').drawImage(img, -st.x / st.scale, -st.y / st.scale, sw, sw, 0, 0, 200, 200);
            modal.style.display = 'none';
            this.saveUserAvatar(c.toDataURL('image/jpeg', 0.9));
        };
    },
    saveUserAvatar(dataUrl) {
        // 裁剪结果已是 200×200 JPEG 时直接存,避免二次解码 + 二次压缩;
        // 其他来源(外部调用)仍按 cover 压到 200×200
        const img = window.qfsImage();
        img.onload = () => {
            const size = 200;
            let compressed = dataUrl;
            const reuse = img.width === size && img.height === size && /^data:image\/jpeg/i.test(dataUrl);
            if (!reuse) {
                const c = document.createElement('canvas');
                c.width = size; c.height = size;
                const ctx = c.getContext('2d');
                // cover裁剪
                const s = Math.max(size / img.width, size / img.height);
                const dw = img.width * s, dh = img.height * s;
                ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
                compressed = c.toDataURL('image/jpeg', 0.85);
            }
            try {
                localStorage.setItem('qfs_user_avatar', compressed);
            } catch(e) { console.warn('头像存储失败:', e); }
            window.__qfsAvatarImg = img;
            this.onSettingChanged();
            const pv = document.getElementById('loginAvatarPreview');
            if (pv) { pv.style.background = 'url(' + compressed + ') center/cover'; pv.textContent = ''; }
            const la = document.getElementById('loginAvatar');
            if (la) { la.style.background = 'url(' + compressed + ') center/cover'; }
            this.updateTopBar();
        };
        img.src = dataUrl;
    },
    bindAvatarUpload() {
        const pick = document.getElementById('btnPickAvatar'), file1 = document.getElementById('fileLoginAvatar');
        const change = document.getElementById('btnChangeAvatar'), file2 = document.getElementById('fileChangeAvatar');
        const readFile = (f) => {
            if (!f) return;
            const reader = new FileReader();
            reader.onload = (ev) => this.openAvatarCrop(ev.target.result);
            reader.readAsDataURL(f);
        };
        // 选完清空 value:同一张图再选一次也会触发 change(否则第二次没反应)
        const bind = (btn, file) => {
            if (!btn || !file) return;
            btn.addEventListener('click', () => file.click());
            file.addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; readFile(f); });
        };
        bind(pick, file1);
        bind(change, file2);
        // Esc 关闭裁切弹窗(全局只绑一次)
        document.addEventListener('keydown', (e) => {
            const m = document.getElementById('avatarCropModal');
            if (e.key === 'Escape' && m && m.style.display !== 'none') m.style.display = 'none';
        });
    },

    /* ══ 画布元素 / 缩放平移交互 ══ */
    bindInteractive() {
        const pane = this.dom.canvasPane, stage = this.dom.stage, canvas = this.dom.canvas;
        const hscrollWheel = (el) => {
            if (!el) return;
            el.addEventListener('wheel', e => {
                if (el.scrollWidth <= el.clientWidth) return;
                e.preventDefault();
                e.stopPropagation();
                el.scrollLeft += (e.deltaY || e.deltaX);
            }, { passive: false });
        };
        hscrollWheel(this.dom.thumbStrip);
        // 胶片条空闲淡出:它悬浮在画布底部正中,常显正好压住相框下边(参数文字/品牌行)。
        // 指针在条上时保持不透明,离开 2.2s 后淡到 45%(仍可点,只是让出画面)。
        const strip = this.dom.thumbStrip;
        if (strip) {
            const wake = () => { clearTimeout(this._stripIdleT); strip.classList.remove('strip-idle'); };
            const sleep = () => {
                clearTimeout(this._stripIdleT);
                this._stripIdleT = setTimeout(() => strip.classList.add('strip-idle'), 2200);
            };
            strip.addEventListener('pointerenter', wake);
            strip.addEventListener('pointerdown', wake);
            strip.addEventListener('pointerleave', sleep);
            sleep();
        }
        // 三个图标池(内置标记/品牌Logo/自定义图标)已改为网格+垂直滚动,
        // 滚轮原生垂直滑动;不能再劫持成水平滚动,否则会阻止原生滚动。
        // hscrollWheel(this.$('brandIconBox'));
        // hscrollWheel(this.$('customIconBox'));
        pane.addEventListener('wheel', e => {
            const pk = this.tplPuzzle();
            if (pk) {
                // 拼图模式:只有画布上"选中"了格子,滚轮才缩放该格图片(不再看鼠标悬停在哪一格)。
                // 未选中(刚进入拼图 / 点过图片以外)时滚轮缩放整个拼图视图,不依赖主图 this.image
                if (this._activePuzzleSlot != null) { e.preventDefault(); this.puzzleWheelSlot(this._activePuzzleSlot, e.deltaY < 0 ? 1.1 : 1 / 1.1); return; }
                if (this.image && stage.classList.contains('has-img')) { e.preventDefault(); this.zoomAt(e, stage, e.deltaY < 0 ? 1.1 : 1 / 1.1); }
                return;
            }
            if (!this.image || !stage.classList.contains('has-img')) return;
            e.preventDefault();
            const sel = this.selectedEls[0];
            if (sel && sel.kind) {
                // 元素操作:Ctrl+滚轮 旋转,普通滚轮 缩放
                const rot = e.metaKey || e.ctrlKey || e.shiftKey;
                this.nudgeElement(sel, rot ? 'rot' : 'scale', e.deltaY < 0 ? 1 : -1);
                return;
            }
            this.zoomAt(e, stage, e.deltaY < 0 ? 1.1 : 1 / 1.1);
        }, { passive: false });
        canvas.addEventListener('mousedown', e => {
            const pk = this.tplPuzzle();
            if ((!this.image && !pk) || e.button !== 0) return;
            this._hideRotateHint();
            // 画布按下时主动把焦点从右侧输入框收回。下面命中元素会 preventDefault()，
            // 浏览器因此不会自动移动焦点；如果停在文本输入框里，Esc/Delete 会被
            // setupShortcuts 当成「正在输入」直接 return —— 表现就是「点了画布元素，
            // 却怎么都取消不掉」。这里 blur 也会顺带提交输入框的当前值。
            const ae = document.activeElement;
            if (ae && ae !== document.body
                && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)
                && typeof ae.blur === 'function') ae.blur();
            // 文字放置模式：单击只用于「定位」，不选中/不拖动/不平移；
            // 真正落字在 dblclick 里，双击位置才是用户要放字的位置。
            // 这一支必须先于拼图/元素命中，否则点在有元素的位置会被当成选中。
            if (this._textPlaceMode) {
                e.preventDefault();
                return;
            }
            if (pk) {
                const hp = this.puzzleHitTest(e);
                if (hp) {
                    e.preventDefault();
                    this.selectedEls = [];
                    this.refreshElList();
                    // 拖拽分隔线调轴位;分隔线属于"图片以外",先把格子选中清掉(静默,避免调间距时刷提示)
                    if (hp.type === 'axis') {
                        this.clearActivePuzzleSlot(true);
                        // 记录按下点相对分隔线的偏移,拖动时线不会跳到指针中心
                        const pp = this.puzzlePx(e);
                        const raw = hp.dim === 'v' ? pp.x / canvas.width : pp.y / canvas.height;
                        this._dragPz = { type: 'axis', dim: hp.dim, idx: hp.idx, sx: e.screenX, sy: e.screenY, moved: false, grabOff: raw - hp.pos };
                        this._setPuzzleAxisHover(hp);
                        canvas.style.cursor = (hp.dim === 'v') ? 'col-resize' : 'row-resize';
                        return;
                    }
                    // 只有"已选中"的格图才能被移动:第一次点击仅选中(并清掉旧拖动态),
                    // 已经选中时按下才进入该格图片的移动
                    if (this._activePuzzleSlot !== hp.slot) {
                        this.setActivePuzzleSlot(hp.slot);
                        this._puzzlePick = null;
                        return;
                    }
                    this._dragPz = { type: 'slot', slot: hp.slot, sx: e.screenX, sy: e.screenY, x0: hp.x, y0: hp.y, moved: false, swap: null };
                    this.setActivePuzzleSlot(hp.slot);
                    this._dragPzInitOff = {};
                    this.ensurePuzzleSlotsCount(pk);
                    for (let si = 0; si < this.puzzleSlotCount(pk.layout || 'single'); si++) {
                        this._dragPzInitOff[si] = { x: pk.slots[si].offsetX || 0, y: pk.slots[si].offsetY || 0 };
                    }
                    this._puzzlePick = null;
                    canvas.style.cursor = 'move';
                    return;
                }
                // 背景板/格间空隙 = 图片以外:取消格子选中(蓝框消失),之后的滚轮/拖拽控制整个拼图
                this.clearActivePuzzleSlot();
            }
            const pt = this.screenToCanvas(e);
            // 四角缩放手柄和旋转把手都画在框边/框外，必须先于元素命中判断。
            // 缩放优先：文字很小时两个把手可能挨得很近，角手柄才是用户更常抓的。
            const rh = this.hitResizeHandle(pt);
            if (rh) {
                const rs = this.beginResize(pt);
                if (rs) {
                    e.preventDefault();
                    this._dragEl = null;
                    canvas.style.cursor = rh.cursor;
                    return;
                }
            }
            // 旋转把手画在框**外**的空处，必须先于元素命中判断，否则永远点不到
            if (this.hitRotateHandle(pt)) {
                const r = this.beginRotate(pt);
                if (r) {
                    e.preventDefault();
                    this._dragEl = null;
                    canvas.style.cursor = 'grabbing';
                    return;
                }
            }
            const el = this.pickElement(pt);
            if (el) {
                e.preventDefault();
                const changed = !this.hasEl(this.selectedEls, el);
                this.selectedEls = changed ? [el] : this.selectedEls;
                // 选中即定位：右侧翻到能改它的页签并滚到对应分组（只在新选中时翻，避免拖动中来回跳）
                if (changed && this.revealElementPanel) this.revealElementPanel(el.kind);
                // cw0/ch0 记下按下时的画布像素口径：x0/y0 就是这套单位下的中心点。
                // 拖动期间画布尺寸若变化（切预览质量 / 窗口缩放），位移要按比例换算回这套口径，
                // 否则 AI 图层会把「大画布像素」当成「小画布像素」直接飞出画面。
                this._dragEl = { kind: el.kind, ref: el.obj, sx: e.screenX, sy: e.screenY, x: el.x0, y: el.y0,
                    cw0: canvas.width, ch0: canvas.height, moved: false,
                    orig: this.snapshotElementGeometry(el.obj) };
                // 拖动期间**不要**动 displayMax。它同时决定后备像素和 CSS 显示尺寸，
                // 一改就是「按下瞬间整幅画面缩小」，且 x0 的口径跟着失效、元素会瞬移。
                // 流畅度靠两件事：renderPreview 的「静态背景 + 单元素重绘」快通道，
                // 以及下面这个只压后备像素、不动显示尺寸的 _backingCap。
                if (el.kind === 'aiLayer' && canvas.width > 4000) {
                    this._backingCap = 2600;
                    this._dropDragBase();
                }
                // 整帧渲染时排除被拖元素,使其余内容可作为静态背景缓存(见 renderPreview)
                this._skipUserEl = el.obj;
                this._dropDragBase();
                this._logoSnapV = null; this._logoSnapH = null;
                this._logoSnapEdgeV = null; this._logoSnapEdgeH = null;
                this.refreshElList();
                canvas.style.cursor = 'pointer';
                this.requestRender();
                return;
            }
            this.selectedEls = [];
            this.refreshElList();
            // 手动平移也退出跟随:否则窗口一变,视图会跳回居中、丢掉用户拖出来的视角
            this._followFit = false;
            this._pan = { sx: e.screenX, sy: e.screenY, px: this.panX, py: this.panY };
            canvas.style.cursor = 'grabbing';
        });
        // 双击文字 = 改内容（PS 的文字工具就是这条路；不用先去面板里找输入框）
        // 双击空白 = 什么都不建；必须先点右侧「文字」→「添加文字」进入添加模式，
        // 再双击画布才落字（位置就是双击点），避免浏览时误触新建文字。
        canvas.addEventListener('dblclick', e => {
            if (!this.image || this._textEditor) return;
            if (this.tplPuzzle()) return;   // 拼图双击是「打开该格图片」
            const pt = this.screenToCanvas(e);
            if (this._textPlaceMode) {
                e.preventDefault();
                const k = this.textSpaceScale();
                this.createTextAt(pt.x / k, pt.y / k);
                return;
            }
            const el = this.pickElement(pt);
            if (el) {
                if (el.kind === 'text') {
                    e.preventDefault();
                    this.editTextContent(el.obj);
                } else if (el.kind === 'aiLayer' && el.obj && el.obj.type === 'text') {
                    e.preventDefault();
                    // 把整个选中对象传进去（含 kind/index），编辑器才知道这是 AI 图层文字
                    this.editTextContent(el);
                }
                return;
            }
            e.preventDefault();
            this.setStatus('先点右侧「文字」→「添加文字」，再在画布上双击放置');
        });
        // 悬停分隔线:换成 row/col-resize 光标 + 画布高亮线,让"可拖动"看得见
        canvas.addEventListener('mousemove', e => {
            if (this._dragPz || this._dragEl || this._pan || this._resizeEl || this._rotEl) return;
            if (this._textPlaceMode) {
                this._hideRotateHint();
                if (canvas.style.cursor !== 'text') canvas.style.cursor = 'text';
                return;
            }
            const pt = this.screenToCanvas(e);
            const rh = this.hitResizeHandle(pt);
            if (rh) {
                this._hideRotateHint();
                if (canvas.style.cursor !== rh.cursor) canvas.style.cursor = rh.cursor;
                this._setPuzzleAxisHover(null);
                return;
            }
            const rotH = this.hitRotateHandle(pt);
            if (rotH) {
                this._showRotateHint(rotH);
                if (!isRotateCursor(canvas.style.cursor)) canvas.style.cursor = ROTATE_CURSOR;
                this._setPuzzleAxisHover(null);
                return;
            }
            this._hideRotateHint();
            if (isRotateCursor(canvas.style.cursor) || canvas.style.cursor === 'grab'
                || canvas.style.cursor === 'nwse-resize' || canvas.style.cursor === 'nesw-resize') canvas.style.cursor = '';
            const pk = this.tplPuzzle();
            if (!pk) return;
            const p = this.puzzlePx(e);
            const ax = this.puzzleAxisAtPx(p.x, p.y);
            if (ax) {
                this._setPuzzleAxisHover(ax);
                const cur = ax.dim === 'v' ? 'col-resize' : 'row-resize';
                if (canvas.style.cursor !== cur) canvas.style.cursor = cur;
            } else {
                if (canvas.style.cursor === 'col-resize' || canvas.style.cursor === 'row-resize') canvas.style.cursor = '';
                this._setPuzzleAxisHover(null);
            }
        });
        canvas.addEventListener('mouseleave', () => {
            if (this._dragPz) return;
            this._hideRotateHint();
            if (canvas.style.cursor === 'col-resize' || canvas.style.cursor === 'row-resize'
                || isRotateCursor(canvas.style.cursor)) canvas.style.cursor = '';
            this._setPuzzleAxisHover(null);
        });
        // 拼图选中是"图片以外一律取消":点舞台灰底/工具栏/左侧预设/胶片条/其他面板都清掉蓝框。
        // 例外:画布本身(由上面的格子命中逻辑决定)、拼图面板(选择下拉/单图滑块/字幕编辑器要用当前选中)
        // 和沉浸展示入口(只是观看,不应清掉拼图格选中)。
        document.addEventListener('mousedown', e => {
            if (this._immersionOpen) return;
            if (this._activePuzzleSlot == null || e.button !== 0) return;
            const t = e.target;
            // 拼图模式下的「选中格」操作入口都算画布内交互：浮层按钮、照片库、
            // 胶片条、退出按钮。以前它们被这条规则当成"画布以外"先清掉选中格，
            // 于是按钮 click 时 _activePuzzleSlot 已是 null，表现为点了没反应。
            if (t && t.closest && t.closest('#previewCanvas, #panel-puzzle, #btnImmersive, '
                + '#puzzleSlotBar, #btnPuzzleExit, #thumbStrip, #sidePhotoBody')) return;
            this.clearActivePuzzleSlot();
        }, true);
        window.addEventListener('mousemove', e => {
            // 按住 Alt 临时关掉 AI 图层吸附（松手再恢复），方便做像素级微调
            this._aiSnapOff = !!e.altKey;
            if (this._resizeEl) {
                this.applyResize(this.screenToCanvas(e));
                return;
            }
            if (this._rotEl) {
                this.applyRotate(this.screenToCanvas(e), e.shiftKey);
                return;
            }
            if (this._dragPz) {
                const pk = this.tplPuzzle();
                if (pk) {
                    const dx = e.screenX - this._dragPz.sx, dy = e.screenY - this._dragPz.sy;
                    if (!this._dragPz.moved && this._dragPz.type === 'slot' && Math.abs(dx) + Math.abs(dy) > 4) { this._dragPz.moved = true; this.pushUndo(); }
                    if (this._dragPz.type === 'axis' && Math.abs(dx) + Math.abs(dy) > 1 && !this._dragPz.moved) { this._dragPz.moved = true; this.pushUndo(); }
                    this.puzzleDragMove(pk, this._dragPz, e);
                    this.scheduleRender();
                }
                return;
            }
            if (this._dragEl) {
                const dx = e.screenX - this._dragEl.sx, dy = e.screenY - this._dragEl.sy;
                if (Math.abs(dx) + Math.abs(dy) > 2) {
                    if (!this._dragEl.moved) {
                        this._dragEl.moved = true;
                        this.pushGestureUndo(this._dragEl);
                        // 锚定文字（预设里那些贴底/贴顶的字）本来没有坐标可改。
                        // 真正开始拖的一刻才解锁：单纯点一下只是选中，模板不被改动。
                        // 解锁取的是当前几何框中心，所以这一帧画面不动。
                        if (this._dragEl.kind === 'text') this.promoteTextToFree(this._dragEl.ref);
                    }
                    const rect = canvas.getBoundingClientRect();
                    const kx = canvas.width / rect.width, ky = canvas.height / rect.height;
                    // AI 图层的 x0/y0 是「按下时的画布像素」口径（见 pickElement 的 layerCenter）。
                    // 若拖动中画布尺寸变了（切预览质量、窗口缩放），先按比例换算到当前口径，
                    // 否则 setLayerCenter 会拿旧口径的像素除以新宽度，元素一下飞到画外。
                    let bx = this._dragEl.x, by = this._dragEl.y;
                    if (this._dragEl.kind === 'aiLayer') {
                        if (this._dragEl.cw0 > 1 && canvas.width > 1 && this._dragEl.cw0 !== canvas.width) bx *= canvas.width / this._dragEl.cw0;
                        if (this._dragEl.ch0 > 1 && canvas.height > 1 && this._dragEl.ch0 !== canvas.height) by *= canvas.height / this._dragEl.ch0;
                    }
                    this.moveElement(this._dragEl, bx + dx * kx, by + dy * ky);
                }
                return;
            }
            if (!this._pan) return;
            this.panX = this._pan.px + (e.screenX - this._pan.sx);
            this.panY = this._pan.py + (e.screenY - this._pan.sy);
            this.applyZoomStyle();
        });
        window.addEventListener('mouseup', () => {
            if (this._resizeEl) {
                const r = this._resizeEl;
                this._resizeEl = null;
                this._skipAiLayer = null;
                this._aiGuides = null; this._aiSnap = null;
                this._skipUserEl = null;
                this._dropDragBase();
                this._hideRotateHint();
                canvas.style.cursor = '';
                if (r.moved) {
                    this.commitNoPush();
                    if (r.isAi) {
                        this.setStatus('AI 图层已缩放（拖角可继续）');
                        if (this._syncAiLayerEdit) this._syncAiLayerEdit();
                    } else {
                        this.setStatus('字号 ' + Math.round(r.ref.fontSize || 0) + 'px（拖角可继续等比缩放）');
                    }
                }
                this.scheduleRender();
                return;
            }
            if (this._rotEl) {
                const r = this._rotEl;
                this._rotEl = null;
                this._skipUserEl = null;
                this._dropDragBase();
                this._hideRotateHint();
                canvas.style.cursor = '';
                if (r.moved) {
                    this.saveCurrentTemplate();
                    this.setStatus('已旋转 ' + Math.round(r.ref.rotation || 0) + '°（按住 Shift 按 15° 吸附）');
                }
                this.scheduleRender();
                return;
            }
            if (this._dragPz) {
                const d = this._dragPz;
                const pk = this.tplPuzzle();
                const moved = d.moved;
                // "放下即互换":松开时指针仍在目标格 → 执行互换
                if (pk && d.type === 'slot' && d.swap != null && d.swap !== d.slot) {
                    if (!moved) this.pushUndo();
                    this.swapSlotImages(pk, d.slot, d.swap);
                    if (this._dragPzInitOff) {
                        [d.slot, d.swap].forEach(i => {
                            if (this._dragPzInitOff[i]) {
                                const so = pk.slots[i] || (pk.slots[i] = {});
                                so.offsetX = this._dragPzInitOff[i].x;
                                so.offsetY = this._dragPzInitOff[i].y;
                            }
                        });
                    }
                    if (!moved) this.saveCurrentTemplate();
                }
                this._puzzlePick = null;
                this._dragPzInitOff = null;
                this._dragPz = null;
                if (moved) {
                    const pkNow = this.tplPuzzle();
                    // 记录拖动最终偏移(commit 会从滑块回写旧值,可能清成 0)
                    let saveOff = null, saveIdx = -1;
                    if (pkNow && d.type === 'slot' && typeof this._puzzleSlot === 'string' && this._puzzleSlot.charAt(0) === 's') {
                        const ai = parseInt(this._puzzleSlot.substring(1), 10);
                        if (!isNaN(ai) && pkNow.slots[ai]) { saveIdx = ai; saveOff = { x: pkNow.slots[ai].offsetX, y: pkNow.slots[ai].offsetY }; }
                    }
                    this.commitNoPush();
                    // 恢复拖动结果,避免模型被旧滑块值覆盖;随后滑块/UI 以模型为准刷新
                    if (saveOff) {
                        pkNow.slots[saveIdx].offsetX = saveOff.x;
                        pkNow.slots[saveIdx].offsetY = saveOff.y;
                        this.setSlotOffsetSliders(pkNow.slots[saveIdx]);
                    }
                    this.refreshPuzzleUI();
                    this.saveCurrentTemplate();
                }
                canvas.style.cursor = '';
                this._setPuzzleAxisHover(null);
            }
            if (this._dragEl) {
                const moved = this._dragEl.moved;
                const aiLayer = this._dragEl.kind === 'aiLayer';
                this._dragEl = null;
                // 从画布内拖到画布外再松手时，浏览器会在 stage 上补一个 click；
                // 那不是「点空白退出编辑」，别让刚放下的元素立刻失去选中。
                // 下一次真正的 mousedown 会把这枚标记清掉。
                if (moved) {
                    this._suppressClickClear = true;
                    // 如果浏览器没有补发 click，这个标记不能活到下一次真实点击。
                    clearTimeout(this._suppressClickTimer);
                    this._suppressClickTimer = setTimeout(() => { this._suppressClickClear = false; }, 350);
                }
                this._skipAiLayer = null;
                this._backingCap = 0;   // 松手恢复全分辨率（下面的 scheduleRender 会按新尺寸重绘）
                this._aiGuides = null; this._aiSnap = null; this._aiSnapOff = false;
                this._skipUserEl = null;
                this._dropDragBase();
                this._logoSnapV = null; this._logoSnapH = null;
                this._logoSnapEdgeV = null; this._logoSnapEdgeH = null;
                this._logoSnapPhotoV = null; this._logoSnapPhotoH = null;
                // 选中/松手时必须补一帧全量重绘:上面已清掉 _skipUserEl(它被引擎
                // _filterUserEls 用来在拖拽优化时把该元素从静态背景里排除),若不重绘,
                // 按下瞬间那帧(已排除该 logo)会一直停留在屏幕上 —— 表现就是「点一下
                // logo,选中框出来了,但 logo 变成空白,得再动一下鼠标才回来」。
                // 真实拖动时最后一帧已把它画在 ghost 上所以不明显,纯点击(未拖动)必现。
                this.scheduleRender();
                if (moved) {
                    this.commitNoPush();
                    if (aiLayer && this._syncAiLayerEdit) this._syncAiLayerEdit();
                }
            }
            if (this._pan) { this._pan = null; canvas.style.cursor = ''; }
        });
        // 鼠标移出窗口/窗口失焦时,强制清理所有拖动态(防止卡住)
        const cancelDrags = () => {
            if (canvas.style.cursor === 'col-resize' || canvas.style.cursor === 'row-resize') canvas.style.cursor = '';
            this._setPuzzleAxisHover(null);
            if (this._dragPz) {
                this._puzzlePick = null;
                this._dragPzInitOff = null;
                this._dragPz = null;
                canvas.style.cursor = '';
            }
            if (this._dragEl) { this._dragEl = null; this._skipAiLayer = null; this._backingCap = 0; this._aiGuides = null; this._aiSnap = null; this._skipUserEl = null; this._dropDragBase(); this._logoSnapV = null; this._logoSnapH = null; this._logoSnapEdgeV = null; this._logoSnapEdgeH = null; this._logoSnapPhotoV = null; this._logoSnapPhotoH = null; }
            if (this._resizeEl) { this._resizeEl = null; this._skipUserEl = null; this._dropDragBase(); canvas.style.cursor = ''; }
            if (this._rotEl) { this._rotEl = null; this._skipUserEl = null; this._dropDragBase(); canvas.style.cursor = ''; }
            this._hideRotateHint();
            if (isRotateCursor(canvas.style.cursor)) canvas.style.cursor = '';
            if (this._pan) { this._pan = null; canvas.style.cursor = ''; }
        };
        window.addEventListener('blur', cancelDrags);
        // 拖拽中断只在「指针真正离开整个 stage」时才发生,不再监听 canvas 的 mouseleave。
        //
        // 旧实现(canvas 的 mouseleave → cancelDrags)是错的:canvas 只是 stage 里被缩放居中的一小块,
        // 鼠标从 canvas 挪到 stage 的空白处就会触发 mouseleave,把正在拖的 _dragEl 清掉。
        // 实测:2000×1600 的画布在 zoom=0.415 下只显示 415×332,贴右缘的 logo 往右拖 3px 就出界,
        // 表现为「按下能选中、一动就弹回原位,完全拖不动」。
        //
        // 为什么挪到 stage 的 mouseleave 才对:用户拖到画布外再拖回来是正常操作(把 logo 拖到边缘),
        // 只有指针彻底离开预览区(乃至离开窗口)才需要防卡住清理。stage 覆盖整个画布可视区域,
        // 它的 mouseleave 才等价于「用户不再在操作画布」。
        // stage 已在 bindInteractive 开头声明(与 canvas 同作用域),此处直接复用
        if (stage) stage.addEventListener('mouseleave', cancelDrags);
        else canvas.addEventListener('mouseleave', cancelDrags);
        canvas.addEventListener('dblclick', e => {
            const pk = this.tplPuzzle();
            if (!pk) return;
            // 双击分隔线:恢复这条线到布局默认比例(分隔线不可选中,不会和双击换图冲突)
            const pp = this.puzzlePx(e);
            const ax = this.puzzleAxisAtPx(pp.x, pp.y);
            if (ax) {
                e.preventDefault();
                this.resetPuzzleAxis(ax.dim, ax.idx);
                return;
            }
            const si = this.puzzleSlotAt(e);
            if (si == null) return;
            e.preventDefault();
            this.setActivePuzzleSlot(si);
            this.openSlotImage(si);
        });
        // 桌面右键菜单:拼图格子 / 画布空白处
        canvas.addEventListener('contextmenu', e => {
            const mod = this.modKeyLabel();
            const pk = this.tplPuzzle();
            if (pk) {
                const hp = this.puzzleHitTest(e);
                if (hp && hp.type === 'axis') {
                    e.preventDefault();
                    this.openCtx(e.clientX, e.clientY, [
                        ['恢复这条分隔线', () => this.resetPuzzleAxis(hp.dim, hp.idx)],
                        ['恢复全部默认比例', () => this.resetPuzzleAxes()],
                    ]);
                    return;
                }
                if (hp && hp.type === 'slot') {
                    e.preventDefault();
                    this.setActivePuzzleSlot(hp.slot);
                    this.openCtx(e.clientX, e.clientY, [
                        ['替换照片(打开图片)', () => this.openSlotImage(hp.slot)],
                        ['在此位置插入照片', () => this.insertImageFromPick(hp.slot)],
                        ['旋转 90°', () => this.rotatePuzzleSlot(hp.slot)],
                        ['重置本格', () => this.resetPuzzleSlot(hp.slot)],
                        ['清空该格', () => this.clearSlotImage(hp.slot)],
                    ]);
                    return;
                }
            }
            e.preventDefault();
            const canRestore = !!(this.image && this.image.orig && this.restoreOriginalPhoto);
            const items = [
                ['适应窗口', () => this.fitZoom && this.fitZoom()],
                ['1:1 实际大小', () => this.zoomActual && this.zoomActual()],
                ['对比原图 (空格按住)', () => this.toggleCompare && this.toggleCompare()],
                ['裁切照片…', () => this.openCrop()],
                ['旋转 90°', () => this.rotateCurrentPhoto()],
            ];
            // 裁/转过才出现：没动过位图时这一项点了也没意义
            if (canRestore) items.push(['还原原图（撤销裁切 / 旋转）', () => this.restoreOriginalPhoto()]);
            items.push(
                ['—', null],
                [`撤销 (${mod}+Z)`, () => this.undo()],
                [`重做 (${mod}+Y)`, () => this.redo()],
                ['—', null],
                [`复制图片 (${mod}+Shift+C)`, () => this.copyImage && this.copyImage()],
                [`粘贴剪贴板图片 (${mod}+Shift+V)`, () => this.pasteImageFromClipboard()],
                ['导出图片', () => this.doExport && this.doExport()]
            );
            this.openCtx(e.clientX, e.clientY, items);
        });
        document.addEventListener('mousedown', e => {
            if (this._ctx && !this._ctx.contains(e.target)) this.closeCtx();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') this.closeCtx();
            if (e.key !== 'Escape') return;
            // 文字工具：Esc 先退编辑，再退「点哪放哪」，最后取消正在进行的拖动/缩放/旋转
            if (this._textEditor) { this.cancelTextEditor(); return; }
            if (this._textPlaceMode) { this.cancelAddText(); return; }
            if (this.cancelElementGesture) this.cancelElementGesture();
        });
        document.addEventListener('mousedown', () => {
            clearTimeout(this._suppressClickTimer);
            this._suppressClickClear = false;
        });
        document.addEventListener('click', e => {
            const t = e.target;
            if (!t || t === canvas || typeof t.closest !== 'function') return;
            if (this._suppressClickClear) {
                this._suppressClickClear = false;
                clearTimeout(this._suppressClickTimer);
                return;
            }
            if (t.closest('#inspector') || t.closest('.tabs')) return;
            // 按钮/输入控件自己的点击逻辑可能刚把某个元素选中（例如 AI 面板的
            // 「在画布上编辑」），不能在冒泡到 document 时又把它清掉。
            if (t.closest('button, a, input, select, textarea, label, [role="button"]')) return;
            // 点画布外（预览留白、顶栏、侧栏空白等）= 结束这次画布编辑。
            // 以前这里只有一行注释没有实现，用户点到没元素的留白后选择框还挂着。
            if (this.selectedEls.length) this.clearElementSelection({ silent: true });
        });
    },

    /* ══ screenToCanvas(e) { … → app-elements.js ══ */

    /* ══ 默认模板 ══ */
    defaultTemplate() {
        return {
            templateName: '', templateTag: '', photoFrameStyle: '', canvasRatio: 'original', canvasSync: 0,
            baseMargin: {
                marginLock: 1, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
                imgScale: 1, imgOffsetX: 0, imgOffsetY: 0,
                refTop: 0, refBottom: 0, refLeft: 0, refRight: 0, globalMargin: 1,
            },
            exportDpi: 300,
            layerList: [{
                visible: 1, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
                fillConfig: {
                    fillType: 'transparent', fillHex: 'eeeeee', fillOpacity: 100,
                    gradientType: 'linear', gradientAngle: 45,
                    gradientStops: [{ position: 0, color: 'eeeeee' }, { position: 1, color: 'bbbbbb' }],
                    gradientOpacity: 100,
                    textureSrc: '', textureScale: 1, textureOffsetX: 0, textureOffsetY: 0,
                    textureOpacity: 100, textureBlend: 'normal',
                },
                strokeConfig: {
                    strokeWidth: 0, strokePos: 'inside', strokeColorHex: '000000', strokeOpacity: 100,
                    strokeDashArray: [], strokeDashOffset: 0,
                },
                cornerConfig: {
                    cornerLock: 0, cornerRadiusAll: 0, cornerRadiusTL: 0, cornerRadiusTR: 0,
                    cornerRadiusBL: 0, cornerRadiusBR: 0,
                },
                shadowGlowConfig: {
                    shadowEnable: 0, shadowOffsetX: 0, shadowOffsetY: 8, shadowBlur: 20,
                    shadowColorHex: '000000', shadowOpacity: 35,
                    // glowSpread / glowType 已删除：Canvas 2D 的 shadowBlur 没有 spread 概念，
                    // 也没有内/外发光之分，这两个字段既无 UI 也无渲染读取，属死字段。
                    glowEnable: 0, glowColorHex: 'ffffff', glowBlur: 30, glowOpacity: 60,
                },
            }],
            cornerConfig: {
                cornerLock: 0, cornerRadiusAll: 0, cornerRadiusTL: 0, cornerRadiusTR: 0,
                // shapeType / customShapeSvg 已删除：引擎只认四个 cornerRadius*，
                // 形状类型与自定义 SVG 从未被读取，也无 UI，属死字段。
                cornerRadiusBL: 0, cornerRadiusBR: 0,
            },
            filmTearConfig: {
                // tearEnable / tearStrength / tearDensity 已删除：撕边从未实现
                // （engine 的 applyShapeMask 只读 filmPerforationEnable），两个滑块
                // 拖动画面零变化。齿孔是真实现，保留（预设驱动，无 UI）。
                filmPerforationEnable: 0, filmPerforationType: 'square', filmPerforationSize: 20, filmPerforationSpacing: 20,
                // dustScratch* / yellowing* 已删除：做旧（灰尘划痕 / 泛黄）没有实现，
                // 引擎从未读取这四个字段，也无 UI，属死字段。
            },
            lightEffect: {
                vignetteEnable: 0, vignetteStrength: 0, vignetteFeather: 50,
                lightLeakEnable: 0, lightLeakType: 'warm', lightLeakOpacity: 0, lightLeakAngle: 225,
                filmGrainEnable: 0, filmGrainIntensity: 0,
            },
            decorConfig: {
                exifAutoText: 0, textLines: [], stickers: [],
                cornerDecorEnable: 0, cornerDecorType: 'line', cornerDecorSize: 30,
            },
            logoElements: [],
            // 苹果信息卡的全部可自定义项(其余风格不读;空串 = 自动)
            appleCard: {
                dateText: '',
                showBrand: 1, showModel: 1, showParams: 1, showDate: 1,
                showLogo: 1, showLine: 1,
                modelScale: 1, paramScale: 1, dateScale: 1, logoScale: 1,
                logoOpacity: 60, lineScale: 1, fontFamily: 'Trebuchet MS',
                textColor: '#1d1d1f', subColor: '#86868b', lineColor: '#d2d2d7',
                barBg: '#ffffff',
            },
            // 联名水印的全部可自定义项(空串 = 自动;Logo/品牌显示与参数字号走通用控件)
            xmLeica: {
                brandText: '', line1: '', line2: 'CLASSIC · 影像定制', partnerBrand: '',
                showDiv: 1, showScrim: 1, align: 1,
                brandScale: 1, brandTracking: 0.16, lineWeight: 600,
                lineScale: 1, logoScale: 1, logoOpacity: 100, logoColor: '#ffffff', logoRaw: 1,
                padScale: 1, scrim: 45,
                fontFamily: 'Courier New',
                textColor: '#ffffff', subColor: '#d9d9d9', divColor: '#ffffff',
            },
            paramFontSize: 33, paramType: 0, paramPosition: 'CENTER',
            userSignature: this.DEFAULT_SIGNATURE,
            puzzle: {
                enabled: 0, layout: 'single', layoutType: 0, gap: 6, slotFill: 'cover', bgMode: 0,
                canvasRatio: 'auto', borderColor: 'ffffff', offsetX: 0, offsetY: 0, zoom: 100,
                slots: {}, axisVals: {}, captions: {}, gapCaptions: {},
            },
        };
    },


    syncModelFromUI() {
        if (this.isUpdating || !this.template || !this.image) return;
        const $ = this.$;
        const m = this.template.baseMargin || (this.template.baseMargin = {});
        const layer = this.currentLayer() || {};
        const fill = layer.fillConfig || (layer.fillConfig = {});
        const stroke = layer.strokeConfig || (layer.strokeConfig = {});
        const sg = layer.shadowGlowConfig || (layer.shadowGlowConfig = {});
        const cc = this.template.cornerConfig || (this.template.cornerConfig = {});
        const le = this.template.lightEffect || (this.template.lightEffect = {});
        const decor = this.template.decorConfig || (this.template.decorConfig = {});

        this.template.canvasRatio = $('cbCanvasRatio') ? $('cbCanvasRatio').value : 'original';
        this.template.canvasSync = $('cbCanvasSync') ? ($('cbCanvasSync').checked ? 1 : 0) : (this.template.canvasSync || 0);
        this.template.liquidGlassDate = $('chkGlassDate') ? ($('chkGlassDate').checked ? 1 : 0) : (this.template.liquidGlassDate !== 0 ? 1 : 0);
        const gm = $('slGlobalMargin') ? parseInt($('slGlobalMargin').value, 10) / 100 : 1;
        m.globalMargin = gm;
        this.applyGlobalMargin(gm, false);

        m.imgScale = $('slImgScale') ? parseInt($('slImgScale').value, 10) / 100 : (m.imgScale || 1);
        m.imgOffsetX = num($('tfImgOffsetX'), m.imgOffsetX);
        m.imgOffsetY = num($('tfImgOffsetY'), m.imgOffsetY);

        if ($('cbCornerLock')) cc.cornerLock = $('cbCornerLock').checked ? 1 : 0;
        const r = $('slCornerRadius') ? parseInt($('slCornerRadius').value, 10) : (cc.cornerRadiusAll || 0);
        cc.cornerRadiusAll = r;
        cc.cornerRadiusTL = num($('slCornerTL'), r);
        cc.cornerRadiusTR = num($('slCornerTR'), r);
        cc.cornerRadiusBL = num($('slCornerBL'), r);
        cc.cornerRadiusBR = num($('slCornerBR'), r);

        this.template.paramPosition = $('cbParamPosition') ? $('cbParamPosition').value : 'CENTER';
        this.template.paramFontSize = $('slParamFontSize') ? parseInt($('slParamFontSize').value, 10) : 33;
        this.template.userSignature = $('inpSignature') ? $('inpSignature').value : '';
        this.template.polaroidCaption = $('inpPolaroidCaption') ? $('inpPolaroidCaption').value : '';
        this.template.hassyCaption = $('inpHassyCaption') ? $('inpHassyCaption').value : '';
        // 苹果信息卡:只在当前风格确实是 CARD_APPLE 时回读 DOM,避免用隐藏行的旧值污染别的模板。
        if (String(this.template.photoFrameStyle || '').toUpperCase() === 'CARD_APPLE') {
            const ac = this.template.appleCard || (this.template.appleCard = {});
            const rdStr = (id, key) => { const el = $(id); if (el) ac[key] = el.value; };
            rdStr('tfAppleDate', 'dateText');
            rdStr('cbAppleFont', 'fontFamily');
            const rdChk = (id, key) => { const el = $(id); if (el) ac[key] = el.checked ? 1 : 0; };
            rdChk('chkAppleShowBrand', 'showBrand');
            rdChk('chkAppleShowModel', 'showModel');
            rdChk('chkAppleShowParams', 'showParams');
            rdChk('chkAppleShowDate', 'showDate');
            rdChk('chkAppleShowLogo', 'showLogo');
            rdChk('chkAppleShowLine', 'showLine');
            const rdNum = (id, key, div) => { const el = $(id); if (el) ac[key] = Number(el.value) / (div || 1); };
            rdNum('slAppleModelSize', 'modelScale', 100);
            rdNum('slAppleParamSize', 'paramScale', 100);
            rdNum('slAppleDateSize', 'dateScale', 100);
            rdNum('slAppleLogoSize', 'logoScale', 100);
            rdNum('slAppleLogoOpacity', 'logoOpacity', 1);
            rdNum('slAppleLineWidth', 'lineScale', 100);
            const rdCol = (id, key) => { const el = $(id); if (el && el.value) ac[key] = el.value; };
            rdCol('cpAppleText', 'textColor');
            rdCol('cpAppleSub', 'subColor');
            rdCol('cpAppleLine', 'lineColor');
            rdCol('cpAppleBarBg', 'barBg');
        }
        // 联名水印:只在当前风格确实是 XIAOMI_LEICA 时回读 DOM,避免隐藏行旧值污染别的模板
        if (String(this.template.photoFrameStyle || '').toUpperCase() === 'XIAOMI_LEICA') {
            const xc = this.template.xmLeica || (this.template.xmLeica = {});
            const xrStr = (id, key) => { const el = $(id); if (el) xc[key] = el.value; };
            xrStr('tfXmBrand', 'brandText');
            xrStr('tfXmLine1', 'line1');
            xrStr('tfXmLine2', 'line2');
            xrStr('tfXmPartner', 'partnerBrand');
            const xrChk = (id, key) => { const el = $(id); if (el) xc[key] = el.checked ? 1 : 0; };
            xrChk('chkXmShowDiv', 'showDiv');
            xrChk('chkXmShowScrim', 'showScrim');
            if ($('cbXmAlign')) xc.align = Number($('cbXmAlign').value) || 0;
            if ($('cbXmFont') && $('cbXmFont').value) xc.fontFamily = $('cbXmFont').value;
            const xrBT = $('slXmBrandTrack');
            if (xrBT) xc.brandTracking = Number(xrBT.value) / 100;
            if ($('cbXmLineWeight')) xc.lineWeight = Number($('cbXmLineWeight').value) || 600;
            if ($('cpXmLogo') && $('cpXmLogo').value) xc.logoColor = $('cpXmLogo').value;
            if ($('chkXmLogoRaw')) xc.logoRaw = $('chkXmLogoRaw').checked ? 1 : 0;
            const xrNum = (id, key, div) => { const el = $(id); if (el) xc[key] = Number(el.value) / (div || 1); };
            xrNum('slXmBrandSize', 'brandScale', 100);
            xrNum('slXmLineSize', 'lineScale', 100);
            xrNum('slXmLogoSize', 'logoScale', 100);
            xrNum('slXmLogoOpacity', 'logoOpacity', 1);
            xrNum('slXmPad', 'padScale', 100);
            xrNum('slXmScrim', 'scrim', 1);
            const xrCol = (id, key) => { const el = $(id); if (el && el.value) xc[key] = el.value; };
            xrCol('cpXmText', 'textColor');
            xrCol('cpXmSub', 'subColor');
            xrCol('cpXmDiv', 'divColor');
        }
        this.template.paramType = $('cbParamType') ? parseInt($('cbParamType').value, 10) : 0;
        this.syncManualExif();

        if ($('cbLayerVisible')) layer.visible = $('cbLayerVisible').checked ? 1 : 0;

        fill.fillType = $('cbFillType') ? $('cbFillType').value : 'solid';
        fill.fillHex = $('cpFillColor') ? $('cpFillColor').value.replace('#', '') : 'eeeeee';
        fill.fillOpacity = $('slFillOpacity') ? parseInt($('slFillOpacity').value, 10) : 100;
        fill.gradientType = $('cbGradientType') ? $('cbGradientType').value : 'linear';
        fill.gradientAngle = $('slGradientAngle') ? parseInt($('slGradientAngle').value, 10) : 45;
        fill.textureSrc = fill.textureSrc || '';
        fill.textureScale = $('slTextureScale') ? parseInt($('slTextureScale').value, 10) / 100 : 1;
        fill.textureBlend = $('cbTextureBlend') ? $('cbTextureBlend').value : 'normal';

        stroke.strokeWidth = $('slStrokeWidth') ? parseInt($('slStrokeWidth').value, 10) : 0;
        stroke.strokePos = $('cbStrokePos') ? $('cbStrokePos').value : 'inside';
        stroke.strokeColorHex = $('cpStrokeColor') ? $('cpStrokeColor').value.replace('#', '') : '000000';
        stroke.strokeOpacity = $('slStrokeOpacity') ? parseInt($('slStrokeOpacity').value, 10) : 100;
        stroke.strokeDashArray = $('tfStrokeDash') ? dashToArray($('tfStrokeDash').value) : [];

        const lcc = layer.cornerConfig || (layer.cornerConfig = {});
        if ($('cbLayerCornerLock')) lcc.cornerLock = $('cbLayerCornerLock').checked ? 1 : 0;
        const lr = $('slLayerCornerRadius') ? parseInt($('slLayerCornerRadius').value, 10) : (lcc.cornerRadiusAll || 0);
        lcc.cornerRadiusAll = lr;
        lcc.cornerRadiusTL = num($('slLayerCornerTL'), lr);
        lcc.cornerRadiusTR = num($('slLayerCornerTR'), lr);
        lcc.cornerRadiusBL = num($('slLayerCornerBL'), lr);
        lcc.cornerRadiusBR = num($('slLayerCornerBR'), lr);

        // 投影/发光改为「滑块常开型」：没有独立开关，透明度 0 即关闭。
        // enable 标志照旧要写（引擎只认它）：老预设里存着 enable:0 + 透明度:35
        // 这种从未生效过的默认值，只看透明度会把整库预设的阴影全打开。
        sg.shadowOffsetX = $('slShadowX') ? parseInt($('slShadowX').value, 10) : 0;
        sg.shadowOffsetY = $('slShadowY') ? parseInt($('slShadowY').value, 10) : 8;
        sg.shadowBlur = $('slShadowBlur') ? parseInt($('slShadowBlur').value, 10) : 20;
        sg.shadowColorHex = $('cpShadowColor') ? $('cpShadowColor').value.replace('#', '') : '000000';
        const shOp = $('slShadowOpacity') ? parseInt($('slShadowOpacity').value, 10) : 35;
        sg.shadowOpacity = shOp;
        sg.shadowEnable = shOp > 0 ? 1 : 0;
        sg.glowColorHex = $('cpGlowColor') ? $('cpGlowColor').value.replace('#', '') : 'ffffff';
        sg.glowBlur = $('slGlowBlur') ? parseInt($('slGlowBlur').value, 10) : 30;
        const glOp = $('slGlowOpacity') ? parseInt($('slGlowOpacity').value, 10) : 60;
        sg.glowOpacity = glOp;
        sg.glowEnable = glOp > 0 ? 1 : 0;


        // 暗角/漏光/颗粒统一为「滑块常开型」:没有独立开关,强度 0 即关闭。
        // enable 标志仍然要写(引擎只认它):老预设里大量存在
        // enable:0 + 强度:35(模板默认值,从未生效),只看强度会把整库预设的暗角全打开。
        // 晕影改成双向：负值压暗四角、正值提亮四角，所以开关按绝对值判断 ——
        // 不能再写 vgv > 0，否则 -33 会被当成「关闭」，画面一点变化都没有。
        const vgv = $('slVignetteStrength') ? parseInt($('slVignetteStrength').value, 10) : 0;
        le.vignetteStrength = vgv;
        le.vignetteEnable = Math.abs(vgv) > 0 ? 1 : 0;
        // 新版符号约定标记：负值压暗 / 正值提亮。归一化时看到它就不再对老数据做翻转。
        le.vignetteSignV2 = 2;
        le.vignetteFeather = $('slVignetteFeather') ? parseInt($('slVignetteFeather').value, 10) : 50;
        const lkv = $('slLeakOpacity') ? parseInt($('slLeakOpacity').value, 10) : 0;
        le.lightLeakEnable = lkv > 0 ? 1 : 0;
        le.lightLeakType = $('cbLeakType') ? $('cbLeakType').value : 'warm';
        le.lightLeakOpacity = lkv;
        le.lightLeakAngle = $('slLeakAngle') ? parseInt($('slLeakAngle').value, 10) : 225;
        // 颗粒只有一个滑块,没有独立开关:强度 0 即"关闭"。
        // 这样面板少一行,而且不会出现"开关开着但强度是 0,看着像坏了"的组合。
        // filmGrainEnable 仍然写进模型 —— 8 个老预设(NOMO复古相机/胶片相机/黑金胶片/
        // 怀旧相机/富士写真胶片/拍立得滤镜/拍立得相纸/轻胶片电影感)早就带着
        // filmGrainEnable:1 + filmGrainIntensity:6~18,只是引擎从来没读过(见 engine.js
        // applyFilmGrain 上方注释)。引擎认这个 flag,所以从预设载入时必须保留它。
        const fgv = $('slFilmGrain') ? parseInt($('slFilmGrain').value, 10) : 0;
        le.filmGrainIntensity = fgv;
        le.filmGrainEnable = fgv > 0 ? 1 : 0;

        if ($('cbExifText')) decor.exifAutoText = $('cbExifText').checked ? 1 : 0;
        if ($('cbFocalEq')) this.template.focalEq = $('cbFocalEq').checked ? 1 : 0;
        this.updateFocalEqHint();
        this.updateExifTextHint();
        // 四角装饰（cornerDecor）不再提供 UI：只有「杂志大刊头」等预设自带该效果，
        // 这里绝不回写 enable，否则任何一次参数改动都会把所有预设的角饰打开。

        this.syncPuzzleFromUI();
        // 晕影 / 颗粒已并入「效果」段：拖动它们也要点亮该段的「已改」标记，
        // 否则「效果」右侧的复位按钮不会出现（它只在 is-dirty 时常驻）。
        if (this.syncGradeSections && this.gradeOf && this.image) {
            this.syncGradeSections(this.gradeOf(this.image));
        }
    },

    syncManualExif() {
        const $ = this.$;
        const efs = ['tfExifBrand', 'tfExifModel', 'tfExifFocal', 'tfExifAperture', 'tfExifIso', 'tfExifShutter'];
        const v = ['brand', 'model', 'focal', 'aperture', 'iso', 'shutter'].map((k, i) => {
            const inp = $(efs[i]);
            return [k, inp ? String(inp.value).trim() : ''];
        });
        const manual = {};
        v.forEach(([k, val]) => { if (val) manual[k] = val; });
        this.template.manualExif = Object.keys(manual).length ? manual : null;
        this.updateExifLine();
    },

    updateExifLine() {
        const $ = this.$;
        const m = this.template && this.template.manualExif;
        const el = $('exifLine'), txt = $('exifLineText');
        if (el && txt) {
            if (m && (m.brand || m.model || m.focal || m.aperture || m.iso || m.shutter)) {
                // 等效焦距开着时,预览行与成片水印保持同一口径:
                // 直接用换算值替换实际焦距(35mm → 53mm),只认 EXIF 0xA405,不按机型猜画幅。
                let focal = m.focal || '';
                if ((this.template.focalEq || 0) === 1 && focal && window.FocalEq) {
                    const auto = (this.image && this.image.exif) || {};
                    const eq = window.FocalEq.equivalentFor(focal, auto.focal, auto.focal35);
                    focal = window.FocalEq.format(focal, eq);
                }
                const parts = [m.brand && m.model ? `${m.brand} ${m.model}` : (m.brand || m.model), focal, m.aperture, m.iso, m.shutter].filter(Boolean);
                txt.textContent = parts.join(' · ');
                el.style.display = '';
            } else { el.style.display = 'none'; }
        }
        this.updateExifTextHint();
    },

    // 等效焦距状态提示:勾选前就告诉用户“会不会变/变成多少”,
    // 避免“勾了没反应”被误认为功能坏了。
    updateFocalEqHint() {
        const el = this.$('focalEqHint');
        if (!el) return;
        const t = this.template;
        if (!this.image || !t) { el.textContent = '导入照片后显示换算结果'; return; }
        const auto = (this.image.exif && typeof this.image.exif === 'object') ? this.image.exif : {};
        const manual = (t.manualExif && typeof t.manualExif === 'object') ? t.manualExif : {};
        const actual = (manual.focal || '').trim() || auto.focal || '';
        const f35 = Number(auto.focal35) || 0;
        if (!(f35 > 0)) {
            el.textContent = '当前照片未写入 35mm 等效焦距（EXIF 0xA405），勾选后保持实际焦距';
            return;
        }
        if (!actual || !window.FocalEq) {
            el.textContent = '当前照片缺少实际焦距，无法换算';
            return;
        }
        const eq = window.FocalEq.equivalentFor(actual, auto.focal, f35);
        if (!(eq > 0)) {
            el.textContent = '当前照片缺少实际焦距，无法换算';
            return;
        }
        const actualMm = window.FocalEq.parseMm(actual);
        const actualText = actualMm ? actualMm + 'mm' : actual;
        if (actualMm && Math.abs(actualMm - eq) < 0.5) {
            el.textContent = '当前照片为全画幅（等效值=实际值）：' + actualText + '，勾选后不变';
            return;
        }
        const converted = window.FocalEq.format(actual, eq);
        el.textContent = ((t.focalEq || 0) === 1 ? '已启用：' : '勾选后：') + actualText + ' → ' + converted;
    },

    // EXIF 参数条状态提示。
    // 这一行只在「通用图层 / 卡片」边框下显示（相框风格由 engine-styles 自己画参数条，
    // 勾了也没反应，见 updatePersonalVisibility 里的显隐）；engine.js 的 drawDecoration
    // 在底部有文字时是原地换字，没有文字时才画条，提示得跟着这个行为说。
    updateExifTextHint() {
        const el = this.$('exifTextHint');
        if (!el) return;
        const t = this.template;
        if (!t) { el.textContent = ''; return; }
        const decor = t.decorConfig || {};
        const lines = decor.textLines || [];
        const anchor = lines.find(l => l && l.text && String(l.text).trim() && (l.align === 'bottom' || l.align === 'exif'));
        const auto = (this.image && this.image.exif && typeof this.image.exif === 'object') ? this.image.exif : {};
        const manual = (t.manualExif && typeof t.manualExif === 'object') ? t.manualExif : {};
        const hasExif = [
            ['brand', 'make'], ['model', 'model'], ['focal', 'focal'],
            ['aperture', 'aperture'], ['iso', 'iso'], ['shutter', 'shutter'],
        ].some(([mk, ak]) => {
            const mv = manual[mk] != null ? String(manual[mk]).trim() : '';
            const av = auto[ak] != null ? String(auto[ak]).trim() : '';
            return !!(mv || av);
        });
        const on = (decor.exifAutoText || 0) === 1;
        if (anchor) {
            let txt = String(anchor.text).trim();
            if (txt.length > 18) txt = txt.slice(0, 18) + '…';
            el.textContent = on
                ? '已启用：底部“' + txt + '”已换成相机参数（字号沿用）'
                : '勾选后：底部“' + txt + '”会换成照片的相机参数';
            return;
        }
        if (!hasExif) {
            el.textContent = '当前照片没有 EXIF 参数，勾选后也不会显示';
            return;
        }
        el.textContent = on
            ? '已启用：照片下方留白显示 EXIF 参数条'
            : '勾选后：在照片下方留白显示 EXIF 参数条';
    },

    // 全局边距:按参考值等比缩放四边
    applyGlobalMargin(scale, setSlider) {
        const m = this.template.baseMargin || {};
        if (m.refTop == null) { m.refTop = m.marginTop != null ? m.marginTop : 80; m.refBottom = m.marginBottom != null ? m.marginBottom : 120; m.refLeft = m.marginLeft != null ? m.marginLeft : 80; m.refRight = m.marginRight != null ? m.marginRight : 80; }
        m.marginTop = Math.round((m.refTop || 0) * scale);
        m.marginBottom = Math.round((m.refBottom || 0) * scale);
        m.marginLeft = Math.round((m.refLeft || 0) * scale);
        m.marginRight = Math.round((m.refRight || 0) * scale);
        m.globalMargin = scale;
        const $ = this.$;
        if (setSlider && $('slGlobalMargin')) $('slGlobalMargin').value = Math.round(scale * 100);
        if (this.image) this.refreshMarginFields();
        this.updateLabel('lblGlobalMargin', Math.round(scale * 100) + '%');
    },

    refreshMarginFields() {
        const $ = this.$;
        const m = this.template.baseMargin || {};
        if ($('slGlobalMargin')) { const g = m.globalMargin != null ? m.globalMargin : 1; $('slGlobalMargin').value = Math.round(g * 100); this.updateLabel('lblGlobalMargin', Math.round(g * 100) + '%'); }
    },

    // 面板行显隐:判定全部来自 style-caps.js(能力表)。
    // 五个数值滑块(参数字号/圆角/边距大小/图片缩放/背景模糊程度)按**实测**能力显示 ——
    // 即"该风格在引擎里真的读这个参数"才露出来,不再给用户拖了没反应的滑块。
    // 实测数据由 npm run gen:caps 从视觉回归基线生成,本函数不做任何名单判断。
    updatePersonalVisibility() {
        if (!this.template) return;
        const rows = window.StyleCaps.visibleRows(this.template.photoFrameStyle || '');
        const blurOn = !!(document.getElementById('chkBgBlur') || {}).checked;
        for (const id in rows) {
            const el = document.getElementById(id);
            if (!el) continue;
            // 背景模糊程度是条件行：能力表是在 signBgBlur=0 的基线下实测的，
            // 支持背景模糊开关的风格会被测成 bi=false。用户把模糊打开后，引擎确实会读
            // blurIntensity，所以这里按开关状态补展开，避免“开了模糊却调不了程度”。
            const show = (id === 'rowBgBlurInt' && blurOn && rows.rowBgBlur) ? true : rows[id];
            el.style.display = show ? '' : 'none';
        }
        // 「EXIF 参数条」只对通用图层/卡片边框有效：相框风格由 engine-styles 自己画参数条，
        // 这一项勾了也不会变。按当前风格显隐，别让用户对着一个没反应的开关猜。
        const exifRow = document.getElementById('rowExifText');
        if (exifRow) {
            const pf = String(this.template.photoFrameStyle || '').toUpperCase();
            exifRow.style.display = (pf && pf !== 'NONE') ? 'none' : '';
        }
        // 进阶说明文字 / 复位 / 指路入口按风格显隐（这些不是参数行，不进声明表）。
        const advStyle = String(this.template.photoFrameStyle || '').toUpperCase();
        const advOn = BLUR_ADV_STYLES.indexOf(advStyle) !== -1;
        for (const id of ['btnBlurReset', 'hintBlurAdvanced', 'hintBlurTextWhere']) {
            const el = document.getElementById(id);
            if (el) el.style.display = advOn ? '' : 'none';
        }
        // 参数行与样式参数组统一由声明表管显隐：当前样式没声明的一律收起，
        // 单行模式下行距/品牌间距也自动收起。
        if (window.QfsStyleParamsUI) window.QfsStyleParamsUI.updateVisibility(this);
        this.syncEmptyGroups();
    },

    // 一键回到预设默认：把这些字段从模板里删掉，而不是写成 40/100/100/0/100/100。
    // 删掉后引擎走原硬编码分支，渲染与「从未调过」完全一致，工程文件也更干净。
    resetBlurAdvanced() {
        // 统一走声明表复位（delete 字段，而不是写回默认值）。
        if (window.QfsStyleParamsUI) window.QfsStyleParamsUI.reset(this);
    },

    // 文字栏里的「去调」入口：那三根滑块在画布栏，这里负责把人送过去。
    // 只切页签不够 —— 参数栏是长列表，切过去仍停在原来的滚动位置，所以还要滚到组 + 闪一下，
    // 否则用户到了画布页签还是看不到目标，等于没跳。
    gotoBlurTextGroup() {
        this.switchTab('canvas');
        const grp = document.getElementById('grpBlurText');
        if (!grp) return;
        grp.classList.remove('collapsed');
        if (typeof grp.scrollIntoView === 'function') {
            grp.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        grp.classList.remove('grp-flash');
        void grp.offsetWidth; // 读一次布局，让动画能被重新触发
        grp.classList.add('grp-flash');
        setTimeout(() => grp.classList.remove('grp-flash'), 1200);
    },

    // 行全被能力表隐藏时,把整组一起收起 —— 否则右侧只剩一个光标题的空卡片。
    // 实测出现率:「品牌行」73/85、「背景模糊」71/85、「签名/头像」66/85、「照片」39/85、「参数文字」32/85,
    // 用户看到的就是"面板像没加载完"。
    // 只收起"我们自己收起的"组:组可能由别的逻辑管着(.ctl-grp-light 按模式、#vbCaptionEditor 按状态),
    // 所以用 data 标记记账 —— 不碰它们,也就不存在误恢复。
    // 判可见用 computedStyle 而不是 offsetParent:面板本身隐藏时,行/组的 display 仍是各自的值。
    syncEmptyGroups() {
        const groups = document.querySelectorAll('.insp-body .param-group');
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const shown = (el) => window.getComputedStyle(el).display !== 'none';
            let content = false;
            const rows = g.querySelectorAll('.param-row');
            for (let k = 0; k < rows.length && !content; k++) if (shown(rows[k])) content = true;
            // 行之外的内容(按钮行/提示框/模板列表…)可见时,组也得留着
            for (let k = 0; k < g.children.length && !content; k++) {
                const el = g.children[k];
                if (el.classList.contains('pg-title') || el.classList.contains('param-row')) continue;
                if (shown(el)) content = true;
            }
            // 用户（或默认折叠）收起的组：行本来就是 display:none，别把它误判成
            // 「整组没有可见内容」再把标题一起藏掉。
            if (g.classList.contains('collapsed')) {
                if (g.dataset.emptyCollapsed === '1') { g.style.display = ''; delete g.dataset.emptyCollapsed; }
                continue;
            }
            const collapsed = g.dataset.emptyCollapsed === '1';
            if (content) {
                if (collapsed) { g.style.display = ''; delete g.dataset.emptyCollapsed; }
            } else if (!collapsed && g.style.display !== 'none') {
                g.style.display = 'none';
                g.dataset.emptyCollapsed = '1';
            }
        }
    },

    // 回显:模板 -> 控件
    refreshUI() {
        this.refreshPhotoMeta();
        if (!this.template) return;
        this.isUpdating = true;
        try {
            const $ = this.$;
            const m = this.template.baseMargin || {};
            const layer = this.currentLayer() || {};
            const fill = layer.fillConfig || {};
            const stroke = layer.strokeConfig || {};
            const sg = layer.shadowGlowConfig || {};
            const cc = this.template.cornerConfig || {};
            const decor = this.template.decorConfig || {};

            if ($('cbCanvasRatio')) $('cbCanvasRatio').value = this.template.canvasRatio || 'original';
            if ($('cbCanvasSync')) $('cbCanvasSync').checked = (this.template.canvasSync || 0) === 1;
            this.refreshMarginFields();
            if ($('slImgScale')) $('slImgScale').value = Math.round((m.imgScale || 1) * 100);
            this.updateLabel('lblImgScale', Math.round((m.imgScale || 1) * 100) + '%');
            if ($('tfImgOffsetX')) $('tfImgOffsetX').value = m.imgOffsetX || 0;
            if ($('tfImgOffsetY')) $('tfImgOffsetY').value = m.imgOffsetY || 0;

            if ($('cbCornerLock')) $('cbCornerLock').checked = (cc.cornerLock || 0) === 1;
            const r = cc.cornerRadiusAll != null ? cc.cornerRadiusAll : 0;
            if ($('slCornerRadius')) $('slCornerRadius').value = r;
            this.updateLabel('lblCornerRadius', r);
            const br = this.template.borderRadius || 0;
            if ($('slBorderRadius')) $('slBorderRadius').value = br;
            this.updateLabel('lblBorderRadius', br);
            if ($('slCornerTL')) $('slCornerTL').value = cc.cornerRadiusTL || 0;
            if ($('slCornerTR')) $('slCornerTR').value = cc.cornerRadiusTR || 0;
            if ($('slCornerBL')) $('slCornerBL').value = cc.cornerRadiusBL || 0;
            if ($('slCornerBR')) $('slCornerBR').value = cc.cornerRadiusBR || 0;
            this.updateLabel('lblCornerTL', cc.cornerRadiusTL || 0); this.updateLabel('lblCornerTR', cc.cornerRadiusTR || 0);
            this.updateLabel('lblCornerBL', cc.cornerRadiusBL || 0); this.updateLabel('lblCornerBR', cc.cornerRadiusBR || 0);

            if ($('cbParamPosition')) $('cbParamPosition').value = this.template.paramPosition || 'CENTER';
            if ($('slParamFontSize')) $('slParamFontSize').value = this.template.paramFontSize != null ? this.template.paramFontSize : 33;
            if ($('slBrandSize')) {
                const bs = Math.round((this.template.brandSize != null ? this.template.brandSize : 1) * 100);
                $('slBrandSize').value = bs;
                this.updateLabel('lblBrandSize', bs + '%');
            }
            if ($('slParamScale')) {
                const psc = Math.round((this.template.paramScale != null ? this.template.paramScale : 1) * 100);
                $('slParamScale').value = psc;
                this.updateLabel('lblParamScale', psc + '%');
            }
            if ($('slGlassSize')) {
                const gsz = Math.round((this.template.liquidGlassSize != null ? this.template.liquidGlassSize : 1) * 100);
                $('slGlassSize').value = gsz;
                this.updateLabel('lblGlassSize', gsz + '%');
            }
            if ($('chkGlassDate')) $('chkGlassDate').checked = this.template.liquidGlassDate !== 0;
            if ($('inpSignature')) $('inpSignature').value = this.template.userSignature || '';
            if ($('inpPolaroidCaption')) $('inpPolaroidCaption').value = this.template.polaroidCaption || '';
            if ($('inpHassyCaption')) $('inpHassyCaption').value = this.template.hassyCaption || '';
            // 苹果信息卡回填(缺省值 = 引擎默认值)
            {
                const ac = this.template.appleCard || {};
                const wrStr = (id, key) => { if ($(id)) $(id).value = ac[key] || ''; };
                wrStr('tfAppleDate', 'dateText');
                if ($('cbAppleFont')) $('cbAppleFont').value = ac.fontFamily || 'Trebuchet MS';
                const wrChk = (id, key) => { if ($(id)) $(id).checked = ac[key] == null ? true : !!Number(ac[key]); };
                wrChk('chkAppleShowBrand', 'showBrand');
                wrChk('chkAppleShowModel', 'showModel');
                wrChk('chkAppleShowParams', 'showParams');
                wrChk('chkAppleShowDate', 'showDate');
                wrChk('chkAppleShowLogo', 'showLogo');
                wrChk('chkAppleShowLine', 'showLine');
                const wrNum = (id, key, mul, lbl, def) => {
                    if (!$(id)) return;
                    const v = Math.round((ac[key] != null ? Number(ac[key]) : def) * mul);
                    $(id).value = v;
                    this.updateLabel(lbl, v + '%');
                };
                wrNum('slAppleModelSize', 'modelScale', 100, 'lblAppleModelSize', 1);
                wrNum('slAppleParamSize', 'paramScale', 100, 'lblAppleParamSize', 1);
                wrNum('slAppleDateSize', 'dateScale', 100, 'lblAppleDateSize', 1);
                wrNum('slAppleLogoSize', 'logoScale', 100, 'lblAppleLogoSize', 1);
                wrNum('slAppleLogoOpacity', 'logoOpacity', 1, 'lblAppleLogoOpacity', 60);
                wrNum('slAppleLineWidth', 'lineScale', 100, 'lblAppleLineWidth', 1);
                const wrCol = (id, key, def) => { if ($(id)) $(id).value = ac[key] || def; };
                wrCol('cpAppleText', 'textColor', '#1d1d1f');
                wrCol('cpAppleSub', 'subColor', '#86868b');
                wrCol('cpAppleLine', 'lineColor', '#d2d2d7');
                wrCol('cpAppleBarBg', 'barBg', '#ffffff');
            }
            // 联名水印回填(缺省值 = 引擎默认值)
            {
                const xc = this.template.xmLeica || {};
                const xwStr = (id, key) => { if ($(id)) $(id).value = xc[key] || ''; };
                xwStr('tfXmBrand', 'brandText');
                xwStr('tfXmLine1', 'line1');
                xwStr('tfXmLine2', 'line2');
                xwStr('tfXmPartner', 'partnerBrand');
                const xwChk = (id, key, def) => { if ($(id)) $(id).checked = xc[key] == null ? def : !!Number(xc[key]); };
                xwChk('chkXmShowDiv', 'showDiv', true);
                xwChk('chkXmShowScrim', 'showScrim', true);
                if ($('cbXmAlign')) $('cbXmAlign').value = String(xc.align != null ? xc.align : 1);
                if ($('cbXmFont')) $('cbXmFont').value = xc.fontFamily || 'Courier New';
                if ($('slXmBrandTrack')) {
                    const bt = Math.round((xc.brandTracking != null ? xc.brandTracking : 0.16) * 100);
                    $('slXmBrandTrack').value = bt;
                    this.updateLabel('lblXmBrandTrack', bt + '%');
                }
                if ($('cbXmLineWeight')) $('cbXmLineWeight').value = String(xc.lineWeight || 600);
                if ($('cpXmLogo')) $('cpXmLogo').value = xc.logoColor || '#ffffff';
                if ($('chkXmLogoRaw')) $('chkXmLogoRaw').checked = xc.logoRaw == null ? true : !!Number(xc.logoRaw);
                const xwNum = (id, key, mul, lbl, def) => {
                    if (!$(id)) return;
                    const v = Math.round((xc[key] != null ? Number(xc[key]) : def) * mul);
                    $(id).value = v;
                    this.updateLabel(lbl, v + '%');
                };
                xwNum('slXmBrandSize', 'brandScale', 100, 'lblXmBrandSize', 1);
                xwNum('slXmLineSize', 'lineScale', 100, 'lblXmLineSize', 1);
                xwNum('slXmLogoSize', 'logoScale', 100, 'lblXmLogoSize', 1);
                xwNum('slXmLogoOpacity', 'logoOpacity', 1, 'lblXmLogoOpacity', 100);
                xwNum('slXmPad', 'padScale', 100, 'lblXmPad', 1);
                xwNum('slXmScrim', 'scrim', 1, 'lblXmScrim', 45);
                const xwCol = (id, key, def) => { if ($(id)) $(id).value = xc[key] || def; };
                xwCol('cpXmText', 'textColor', '#ffffff');
                xwCol('cpXmSub', 'subColor', '#d9d9d9');
                xwCol('cpXmDiv', 'divColor', '#ffffff');
            }
            if ($('cbSignFont')) $('cbSignFont').value = this.template.signFont || 'Courier New';
            if ($('cbSignColor')) $('cbSignColor').value = this.template.signColor || '#555';
            if ($('chkSignModel')) $('chkSignModel').checked = !!(this.template.signIncludeModel);
            if ($('cbCreditMode')) $('cbCreditMode').value = String(this.template.creditMode || 0);
            if ($('chkBrandLogo')) $('chkBrandLogo').value = String(this.template.brandLogo || 0);
            if ($('chkAvatarShow')) $('chkAvatarShow').checked = this.template.avatarShow !== 0;
            if ($('rgAvatarScale')) { const v = Math.round((this.template.avatarScale || 0.85) * 100); $('rgAvatarScale').value = v; this.updateLabel('valAvatarScale', v + '%'); }
            if ($('rgSignSize')) { const v2 = Math.round((this.template.signSize || 1) * 100); $('rgSignSize').value = v2; this.updateLabel('valSignSize', v2 + '%'); }
            if ($('chkBgBlur')) $('chkBgBlur').checked = !!this.template.signBgBlur;
            const biV = this.template.blurIntensity != null ? this.template.blurIntensity : 50;
            if ($('slBgBlurInt')) $('slBgBlurInt').value = biV;
            this.updateLabel('lblBgBlurInt', biV + '%');
            // 样式私有参数回显：模板里有就显示用户值，没有就显示声明表里的默认值。
            if (window.QfsStyleParamsUI) window.QfsStyleParamsUI.refresh(this);
            const rowBI2 = document.getElementById('rowBgBlurInt');
            if (rowBI2) rowBI2.style.display = $('chkBgBlur') && $('chkBgBlur').checked ? '' : 'none';
            if ($('cbParamColor')) $('cbParamColor').value = this.template.paramColor || 'auto';
            this.updatePersonalVisibility();
            this.refreshBgBlurDefaultUI();
            if (this.template.userAvatar) {
                const img = window.qfsImage();
                img.onload = () => { this.avatarImg = img; window.__qfsAvatarImg = img; this.renderPreview(); };
                img.src = this.template.userAvatar;
            }
            this.updateParamFontLabel();
            if ($('cbParamType')) $('cbParamType').value = String(this.template.paramType != null ? this.template.paramType : 0);

            // EXIF 输入框回填:手动(manualExif)优先,自动识别(image.exif)兜底
            const manExif = (this.template.manualExif && typeof this.template.manualExif === 'object') ? this.template.manualExif : {};
            const autoExif = this.camLibMatchExif((this.image && this.image.exif) || {});
            const exifMap = [
                ['tfExifBrand', 'brand', 'make'], ['tfExifModel', 'model', 'model'],
                ['tfExifFocal', 'focal', 'focal'], ['tfExifAperture', 'aperture', 'aperture'],
                ['tfExifIso', 'iso', 'iso'], ['tfExifShutter', 'shutter', 'shutter'],
            ];
            exifMap.forEach(([id, mk, ek]) => {
                const el = $(id);
                if (el) el.value = (manExif[mk] || '').trim() || (autoExif[ek] || '');
            });
            if ($('cbFillType')) $('cbFillType').value = fill.fillType || 'solid';
            if ($('cpFillColor')) $('cpFillColor').value = '#' + (fill.fillHex || 'eeeeee');
            if ($('slFillOpacity')) $('slFillOpacity').value = fill.fillOpacity != null ? fill.fillOpacity : 100;
            this.updateLabel('lblFillOpacity', (fill.fillOpacity != null ? fill.fillOpacity : 100) + '%');
            if ($('cbGradientType')) $('cbGradientType').value = fill.gradientType || 'linear';
            if ($('slGradientAngle')) $('slGradientAngle').value = fill.gradientAngle || 45;
            this.updateLabel('lblGradientAngle', fill.gradientAngle || 45);
            if ($('slTextureScale')) $('slTextureScale').value = Math.round((fill.textureScale || 1) * 100);
            this.updateLabel('lblTextureScale', Math.round((fill.textureScale || 1) * 100) + '%');
            if ($('cbTextureBlend')) $('cbTextureBlend').value = fill.textureBlend || 'normal';

            if ($('slStrokeWidth')) $('slStrokeWidth').value = stroke.strokeWidth || 0;
            this.updateLabel('lblStrokeWidth', stroke.strokeWidth || 0);
            if ($('cbStrokePos')) $('cbStrokePos').value = stroke.strokePos || 'inside';
            if ($('cpStrokeColor')) $('cpStrokeColor').value = '#' + (stroke.strokeColorHex || '000000');
            if ($('slStrokeOpacity')) $('slStrokeOpacity').value = stroke.strokeOpacity != null ? stroke.strokeOpacity : 100;
            this.updateLabel('lblStrokeOpacity', (stroke.strokeOpacity != null ? stroke.strokeOpacity : 100) + '%');
            if ($('tfStrokeDash')) $('tfStrokeDash').value = (stroke.strokeDashArray || []).join(',');

            const lcc = layer.cornerConfig || {};
            if ($('cbLayerCornerLock')) $('cbLayerCornerLock').checked = (lcc.cornerLock || 0) === 1;
            const lr = lcc.cornerRadiusAll != null ? lcc.cornerRadiusAll : 0;
            if ($('slLayerCornerRadius')) $('slLayerCornerRadius').value = lr;
            if ($('slLayerCornerTL')) $('slLayerCornerTL').value = lcc.cornerRadiusTL || 0;
            if ($('slLayerCornerTR')) $('slLayerCornerTR').value = lcc.cornerRadiusTR || 0;
            if ($('slLayerCornerBL')) $('slLayerCornerBL').value = lcc.cornerRadiusBL || 0;
            if ($('slLayerCornerBR')) $('slLayerCornerBR').value = lcc.cornerRadiusBR || 0;
            this.updateLabel('lblLayerCornerTL', lcc.cornerRadiusTL || 0); this.updateLabel('lblLayerCornerTR', lcc.cornerRadiusTR || 0);
            this.updateLabel('lblLayerCornerBL', lcc.cornerRadiusBL || 0); this.updateLabel('lblLayerCornerBR', lcc.cornerRadiusBR || 0);
            this.updateLabel('lblLayerCornerRadius', lr);

            // 常开滑块：显示值以 enable 为准（老预设普遍是 enable:0 + 透明度:35）
            const shOn = (sg.shadowEnable || 0) === 1;
            if ($('slShadowOpacity')) $('slShadowOpacity').value = shOn ? (sg.shadowOpacity != null ? sg.shadowOpacity : 35) : 0;
            this.updateLabel('lblShadowOpacity', (shOn ? (sg.shadowOpacity != null ? sg.shadowOpacity : 35) : 0) + '%');
            this.syncShadowL();

            const glOn = (sg.glowEnable || 0) === 1;
            if ($('slGlowOpacity')) $('slGlowOpacity').value = glOn ? (sg.glowOpacity != null ? sg.glowOpacity : 60) : 0;
            this.updateLabel('lblGlowOpacity', (glOn ? (sg.glowOpacity != null ? sg.glowOpacity : 60) : 0) + '%');


            const le = this.template.lightEffect || {};
            // 常开滑块:显示值以 enable 为准。老预设普遍存着 enable:0 + 强度:35,
            // 直接显示强度会让滑块停在 35 却画面上什么都没有(和颗粒当年同一个坑)。
            const vgOn = le.vignetteEnable === 1;
            const vgVal = vgOn ? (le.vignetteStrength || 0) : 0;
            if ($('slVignetteStrength')) $('slVignetteStrength').value = vgVal;
            if ($('slVignetteFeather')) $('slVignetteFeather').value = le.vignetteFeather != null ? le.vignetteFeather : 50;
            // 「效果」段六行统一成纯数字（与 Camera Raw 一致，也和上面的纹理/清晰度/去薄雾
            // 在同一列对齐）：负值自带 -，正值不再补 +、也不挂 %，否则零值是「0」而拖出
            // 数值又变成「+18%」，同一列的单位会跳来跳去。
            this.updateLabel('lblVignetteStrength', String(vgVal));
            this.updateLabel('lblVignetteFeather', le.vignetteFeather != null ? le.vignetteFeather : 50);
            const lkOn = le.lightLeakEnable === 1;
            const lkVal = lkOn ? (le.lightLeakOpacity || 0) : 0;
            if ($('cbLeakType')) $('cbLeakType').value = le.lightLeakType || 'warm';
            if ($('slLeakOpacity')) $('slLeakOpacity').value = lkVal;
            if ($('slLeakAngle')) $('slLeakAngle').value = le.lightLeakAngle != null ? le.lightLeakAngle : 225;
            this.updateLabel('lblLeakOpacity', lkVal + '%');
            this.updateLabel('lblLeakAngle', (le.lightLeakAngle != null ? le.lightLeakAngle : 225) + '°');
            // 颗粒:以 enable 为准显示,而不是直接显示 intensity。
            // 绝大多数预设存的是 filmGrainEnable:0 + filmGrainIntensity:10(那个 10 是
            // 没人读过的历史遗留值)。若直接显示 intensity,滑块会显示 10% 而画面上
            // 一点颗粒都没有 —— 用户会以为控件坏了。
            const fgOn = le.filmGrainEnable === 1;
            const fgVal = fgOn ? (le.filmGrainIntensity || 0) : 0;
            if ($('slFilmGrain')) $('slFilmGrain').value = fgVal;
            this.updateLabel('lblFilmGrain', String(fgVal));

            if ($('cbExifText')) $('cbExifText').checked = (decor.exifAutoText || 0) === 1;
            if ($('cbFocalEq')) $('cbFocalEq').checked = (this.template.focalEq || 0) === 1;
            this.updateFocalEqHint();
            this.updateExifTextHint();

            this.refreshElList();
            this.refreshTemplateFields();
            this.refreshPuzzleUI();
            this.updateHistoryButtons();
            this.applyModeControls();
        } finally {
            this.isUpdating = false;
        }
    },

    // 面板联动:图层组只服务默认模板样式(相框/卡片管线不画图层);光效在三条管线里都生效,不再隐藏
    applyModeControls() {
        const t = this.template;
        if (!t) return;
        const pf = String(t.photoFrameStyle || '').toUpperCase();
        const frame = !!(pf && pf !== 'NONE');
        const card = !frame && (t.baseMargin || {}).bgBlurEnable === 1;
        const showLayers = !frame && !card;
        const q = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));
        q('.ctl-grp-layers').forEach(el => { el.style.display = showLayers ? '' : 'none'; });
        // 预设自带边框时，5 个图层组全部不适用。整页留空会让人以为面板坏了，
        // 这里只说明原因和下一步（去风格墙换个图层边框预设），不在左侧素材库加筛选。
        const bps = document.getElementById('borderPresetState');
        if (bps) {
            bps.hidden = showLayers;
            bps.dataset.kind = frame ? 'frame' : (card ? 'card' : 'layer');
            if (!showLayers) {
                const name = t.templateName || '当前预设';
                const title = document.getElementById('borderPresetTitle');
                const text = document.getElementById('borderPresetText');
                if (title) {
                    title.textContent = frame
                        ? `「${name}」的边框由预设绘制`
                        : `「${name}」是卡片 / 模糊底样式`;
                }
                if (text) {
                    text.textContent = frame
                        ? '填充、描边、圆角、阴影都写在预设里，不能在这里单独微调。换用「圆角卡片」「极简细线」这类图层边框预设，就能逐项调整。'
                        : '边框与背景模糊由预设和「画布与照片」里的参数控制，这里没有可单独调节的图层。换用图层边框预设即可逐项调整。';
                }
                const n = Array.isArray(this.presets) && typeof this.isEditablePreset === 'function'
                    ? this.presets.filter(p => this.isEditablePreset(p)).length : 0;
                const count = document.getElementById('borderEditableCount');
                if (count) count.textContent = String(n);
                const total = document.getElementById('borderPresetTotal');
                if (total) total.textContent = String(Array.isArray(this.presets) ? this.presets.length : 0);
            }
        }
        // 「晕影 / 羽化 / 颗粒 / 漏光」不再按管线隐藏：engine-styles 的相框分支已经补上
        // applyGlobalLight（叠在成片之上、文字/Logo 之下），这几档在所有管线里都真的生效，
        // 藏起来只会让人以为没有这个功能。图层组仍然只服务默认模板管线，保持隐藏。
        // 「照片同步画幅」只有默认图层管线（engine.js 的 drawOriginImage）读 canvasSync。
        // 相框风格自己排版照片、卡片/模糊底走 renderCardStyle，两条管线都不看这个字段：
        // 露出来只会是“勾了没反应”。这里按当前实际渲染管线隐藏，切回默认模板时自动恢复。
        const syncRow = document.getElementById('rowCanvasSync');
        if (syncRow) syncRow.style.display = (frame || card) ? 'none' : '';
        // 齿孔掩膜只在默认图层管线读 filmTearConfig;相框样式 / 卡片(模糊底)渲染不走该管线(整组隐藏)
        // 当前样式条:把"现在走哪条渲染管线"显性化,解释为何部分控件消失
        const ms = document.getElementById('modeStatus');
        if (ms) {
            const frameName = String(t.photoFrameStyle || '').toUpperCase();
            const isFrame = !!(frameName && frameName !== 'NONE');
            const isCard = !isFrame && (t.baseMargin || {}).bgBlurEnable === 1;
            let kind, name;
            if (isFrame) {
                kind = '相框样式';
                const preset = this.presets.find(p => String(p.photoFrameStyle || '').toUpperCase() === frameName);
                name = preset ? (preset.templateName || frameName) : frameName;
            } else if (isCard) {
                kind = '卡片 / 模糊底';
                name = t.templateName || '';
            } else {
                kind = '图层边框';
                name = t.templateName || '';
            }
            // 顶部横幅不再常驻：同样的信息收进底部状态栏的一格，
            // 每个页签都省下一行。ms 仍留在 DOM 里，兼容老代码与旧草稿检查。
            // 状态栏只写预设名：'相框样式 / 卡片 / 图层边框' 是内部管线词，
            // 用户看不出区别，写进去只会让状态栏像调试输出。
            if (window.QfsPanelDensity) window.QfsPanelDensity.setStyleLabel(name || kind);
            ms.style.display = 'none';
            ms.textContent = '当前样式：' + kind + (name ? ' · ' + name : '');
        }
    },

    syncShadowL() {
        const $ = this.$;
        const layer = this.currentLayer() || {};
        const sg = layer.shadowGlowConfig || {};
        const map = [
            ['slShadowX', 'slShadowXL', 'lblShadowX', 'lblShadowXL', 'shadowOffsetX'],
            ['slShadowY', 'slShadowYL', 'lblShadowY', 'lblShadowYL', 'shadowOffsetY'],
            ['slShadowBlur', 'slShadowBlurL', 'lblShadowBlur', 'lblShadowBlurL', 'shadowBlur'],
        ];
        map.forEach(([a, b, la, lb, key]) => {
            const v = sg[key] != null ? sg[key] : 0;
            if ($(a)) $(a).value = v;
            if ($(b)) $(b).value = v;
            this.updateLabel(la, v);
            this.updateLabel(lb, v);
        });
        const c = sg.shadowColorHex || '000000', o = sg.shadowOpacity != null ? sg.shadowOpacity : 35;
        if ($('cpShadowColor')) $('cpShadowColor').value = '#' + c;
        if ($('cpShadowColorL')) $('cpShadowColorL').value = '#' + c;
        this.updateLabel('lblShadowOpacity', o + '%');
        this.updateLabel('lblShadowOpacityL', o + '%');
        const g = sg.glowBlur || 30, go = sg.glowOpacity != null ? sg.glowOpacity : 60;
        if ($('slGlowBlur')) $('slGlowBlur').value = g; if ($('slGlowBlurL')) $('slGlowBlurL').value = g;
        if ($('slGlowOpacity')) $('slGlowOpacity').value = go; if ($('slGlowOpacityL')) $('slGlowOpacityL').value = go;
        this.updateLabel('lblGlowBlur', g); this.updateLabel('lblGlowBlurL', g);
        this.updateLabel('lblGlowOpacity', go + '%'); this.updateLabel('lblGlowOpacityL', go + '%');
        if ($('cpGlowColor')) $('cpGlowColor').value = '#' + (sg.glowColorHex || 'ffffff');
        if ($('cpGlowColorL')) $('cpGlowColorL').value = '#' + (sg.glowColorHex || 'ffffff');
    },

    updateLabel(id, text) {
        const el = this.$(id);
        if (el) {
            // 高频路径(每帧的滑块/边距/EXIF 标签)会反复进来,值没变就不碰 DOM:
            // 同值写 textContent 虽不触发重排,但每次都要走字符串化与样式失效检查,累起来不划算。
            const s = String(text);
            if (el.textContent !== s) el.textContent = s;
        }
        // 数值输入框跟随标签:标签仍是唯一数据源(测试/读屏读它),数字框只是它的可编辑投影。
        // 标签 id 与滑块 id 不总同名(lblParamFontSize ↔ slParamFontSize、
        // valSignSize ↔ rgSignSize),所以先按前缀反推一次,找不到再按同名处理。
        if (this._rangeUi) {
            if (this._rangeUi[id]) this._syncRangeNumber(id);
            else if (id.indexOf('lbl') === 0 && this._rangeUi['sl' + id.slice(3)]) this._syncRangeNumber('sl' + id.slice(3));
            else if (id.indexOf('val') === 0 && this._rangeUi['rg' + id.slice(3)]) this._syncRangeNumber('rg' + id.slice(3));
        }
    },

    // 字号标签只报「档位」,不报像素。
    // 档位会按照片宽度缩放(autoExifSize = 档位 × clamp(iw/1200, 0.5, 8)),同一档位在
    // 1200px 与 4000px 宽的照片上能差 3 倍以上。所以这里若折算成 px,标签就是个会跳的
    // 假数字 —— 用户拖到 100 看到"333px",换张图又变 213px,正是"字号不跟随"的观感来源。
    // 自适应本身就是按图宽算的,报一个具体 px 只会让人误以为它是定值,故只报"自适应"。
    updateParamFontLabel() {
        const v = this.template.paramFontSize != null ? this.template.paramFontSize : 33;
        if (v <= 0) {
            this.updateLabel('lblParamFontSize', '自适应');
            this.updateLabel('lblParamFontNote', '');
        } else {
            this.updateLabel('lblParamFontSize', String(v));
            this.updateLabel('lblParamFontNote', '按图宽自适应');
        }
    },

    currentLayer() {
        if (!this.template || !this.template.layerList || !this.template.layerList.length) {
            if (this.template) this.template.layerList = [this.defaultTemplate().layerList[0]];
            return this.template.layerList[0];
        }
        const idx = clampNum(this.selectedLayer || 0, 0, this.template.layerList.length - 1);
        return this.template.layerList[idx];
    },

    /* ══ 渲染调度 / 帧合成 → app-render.js ══ */


    saveCurrentTemplate() {
        if (!this.image) return;
        // 悬停预览期间 this.template 是借来的：任何自动保存/参数提交都不能把它落成这张图的模板。
        if (this._presetHover) return;
        // 单一存取口(见 app-state.js):Map 与 customSettings 恒为同一对象。
        // 写入的是 cloneTemplate 快照,this.template 本体引用不变,selectedEls 不受影响
        this.setTpl(this.image, this.cloneTemplate());
        this.queueThumb(this.image);
        if (typeof this.scheduleDraft === 'function') this.scheduleDraft();
    },

    /* ══ 图片选择 / 每图模板 ══ */
    afterImageSelect() {
        if (!this.image) return;
        this.dom.placeholder.style.display = 'none';
        this.dom.canvas.style.display = 'block';
        this.updateEmptyState();
        const btn = document.getElementById('btnRestoreDraft');
        if (btn) btn.style.display = 'none';
        const saved = this.getTpl(this.image);
        if (saved) this.template = saved;
        else this.normalizeTemplate();
        this.selectedEls = [];
        // 切照片后 AI 面板的画廊预览与「微调基准」都按新照片重建，
        // 不然下一次微调会把上一张照片的图层写回当前照片。
        if (this._onAiPhotoChanged) this._onAiPhotoChanged();
        this.updateStatusBar();
        // 直方图已提到页签之上常驻：每次切图都补一次（无图时模块自己跳过；
        // 调色尚未烘好时先取原图，烘好后再由 grade 模块刷新一次）。
        if (window.QfsHistogram && this.image) window.QfsHistogram.refresh(this.image);
        // 溢出警示跟着换图重扫（开着的状态下切图不应该继续显示上一张的红蓝块）
        if (window.QfsClip) window.QfsClip.refresh(this.image);
        this.refreshUI();
        this.autoFit = true;
        this.scheduleRender(true);
        // 每张照片的原图备份是独立的：切图后「还原原图」的显隐要跟着换
        if (this.syncCropOriginalBtn) this.syncCropOriginalBtn();
        // 调色参数挂在每张照片上，切图后滑块要回显这张的参数（不是上一张的）
        if (this.syncGradeUI) this.syncGradeUI();
    },

    selectImage(idx) {
        // 离开带拼图的照片时记下旧图:拼图只保存在旧图自己的预设里,切走会在状态栏提示去向
        const prevIm = this.image;
        const prevHadPuzzle = !!(prevIm && this.images[idx] !== prevIm && this.tplPuzzle && this.tplPuzzle());
        this.selectedIdx = [idx];
        // 普通单击/切换 = 单选:连批量勾选也一并取消,只保留当前这张
        this.batchSel = [idx];
        this.currentIdx = idx;
        // 撤销历史跟着图片走:先把上一张的栈存起来，再换回目标图自己的栈。
        // 不换的话，切图后 Ctrl+Z 会把上一张的模板/调色写到当前图（见 app-state undo）。
        if (typeof this._swapHistory === 'function') this._swapHistory(this.images[idx]);
        this.image = this.images[idx];
        // 换图即使宽高恰好相同也要重新适配(苹果信息卡的高度豁免只针对"调参数")
        this._forceFitNext = true;
        // 切图时退出蒙版「原图预览」：预览属于上一张照片的编辑上下文，
        // 不清的话新图会一直显示未调色源，而蒙版面板已经不在了（看起来就是调色丢了）
        if (this._maskPreviewOriginal) {
            this._maskPreviewOriginal = false;
            if (this._syncMaskOrigHint) this._syncMaskOrigHint();
        }
        // 有独立预设的图恢复其自身模板;没有独立预设的以默认(原图)开始,画布显示原图
        const saved = this.getTpl(this.image);
        this.template = saved ? JSON.parse(JSON.stringify(saved)) : this.defaultTemplate();
        this.invalidateStyleCaches();
        this.buildThumbnails();
        this.afterImageSelect();
        // 切回某张照片时,它的调色烘焙画布可能已被 LRU 淘汰(去编辑别的图 / 批量应用后切回),
        // 此时 photoSrcOf 会回退到原图,调色像"没了"。只要参数还在就立刻在新底图上重放。
        const g = this.image && this.image._grade;
        if (g && !g.neutral && !g.canvas && (!g.low || !g.lowKey)) this.rebuildGrade('full');
        // RAW 导入/恢复草稿时先给 1600px 代理；切到这张图后自动补全尺寸，
        // 否则它会一直停在代理，直到用户再碰一次滑块或导出。
        if (this.image && this.image.raw && !this.image.raw.full && this._rawQueueFull) {
            this._rawQueueFull(900);
        }
        // 调色预设的缩略图/“使用中”都按当前照片计算，切图后重算。
        if (this.onGradePresetImageChange) this.onGradePresetImageChange();
        if (prevHadPuzzle && !(this.tplPuzzle && this.tplPuzzle())) {
            this.setStatus('拼图保存在「' + (prevIm.name || '上一张') + '」上（点胶片条切回该照片可继续编辑）');
        }
    },

    // 主照片旋转 90°(顺时针):重新生成位图替换 image.el,渲染/导出/缩略图同步生效
    async rotateCurrentPhoto() {
        const im = this.image;
        if (!im || !im.el) { this.setStatus('请先导入照片'); return; }
        // RAW 的旋转是显影参数：只改 rotate 次数再让主进程重解，不能把当前代理烘进像素，
        // 否则换一次显影参数就会把旋转丢掉，而且旋转后的裁切框也无法还原。
        if (im.raw && this._rawReload) {
            if (this.savePhotoOrigin) this.savePhotoOrigin(im);
            im.rotate = ((im.rotate || 0) + 1) % 4;
            im.thumb = null;
            im._thumbEl = null;
            im._tqAt = 0;
            if (this.invalidateStyleCaches) this.invalidateStyleCaches();
            if (this._rawDom && this._rawDom.state) this._rawDom.state.textContent = '显影中…';
            const edge = im.raw.full ? 0 : this.RAW_PROXY_EDGE;
            const ok = await this._rawReload(im, edge);
            if (!ok) { this.setStatus('旋转失败'); return; }
            if (this.syncCropOriginalBtn) this.syncCropOriginalBtn();
            this.setStatus('照片已旋转 90°(再次右键可继续旋转)');
            return;
        }
        const img = im.el;
        const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
        if (!W || !H) return;
        // 连转两次时 im.el 已经是 canvas（上调旋转的产物），它本来就是解码好的位图，
        // 没有 decode 可等；只有 Image 源才需要等这一下 —— 否则 decoding='async'
        // 的图还没解完就 drawImage，会得到一张全透明空画布。
        const srcIsCanvas = typeof img.getContext === 'function';
        if (!srcIsCanvas && typeof img.decode === 'function') {
            try { await img.decode(); } catch (_) { /* 解码失败走下面的结果校验 */ }
        }
        // 绘制走 qfsGeoRotate 这个共享函数：撤销 / 草稿恢复要靠同一套数学重放，
        // 两处各写一遍迟早会画出不一样的结果。
        const canvas = window.qfsGeoRotate ? window.qfsGeoRotate(img, { willReadFrequently: true }) : null;
        if (!canvas) { this.setStatus('旋转失败：无法生成画布'); return; }
        // 只测**结果**画布。以前源图和结果各测两次（透明率 + 黑率），
        // 而每次 drawImage(整图 → 32×32) 都得先把整张画布落定，24MP 上就是
        // 140~200ms 一笔 —— 光检测就吃掉半秒。现在只在结果上测一次，源图留到
        // 结果可疑时再诊断（冷路径），正常旋转只碰一次落定。
        const st = window.qfsAlphaStats ? window.qfsAlphaStats(canvas) : null;
        // 源图明明有内容、结果却全空 = 这次根本没画上。绝不把空图换进 im.el：
        // 保留原图并明确提示，比静默显示一张黑照片好得多。
        if (st && st.opaque < 0.02) {
            const before = window.qfsOpaqueRatio ? window.qfsOpaqueRatio(img) : null;
            if (before != null && before > 0.5) {
                this.setStatus('旋转失败：照片还没读取完，已保留原图，请再试一次');
                return;
            }
        }
        // 兜底：源图正常却烘出整片纯黑（解码 / 驱动 / 显存等任何上游异常），
        // 同样拒绝替换，把「静默黑屏」变成一条能看懂的提示。
        if (st && st.black > 0.95) {
            const beforeBlack = window.qfsBlackRatio ? window.qfsBlackRatio(img) : null;
            if (beforeBlack != null && beforeBlack < 0.5) {
                this.setStatus('旋转失败：结果画面异常（全黑），已保留原图，请重试');
                return;
            }
        }
        // 纯几何操作，画布直接当图源：不再 toBlob('image/png') 再重载（24MP 上
        // 编码 471ms + 解码 25ms，转本身只要 13ms）。透明区也因此天然保留 ——
        // 以前用 JPEG 就是因为这一步，现在连编码都不需要了。
        const out = window.qfsCanvasSource ? window.qfsCanvasSource(canvas) : await window.qfsCanvasImage(canvas);
        if (!out) { this.setStatus('旋转失败'); return; }
        // 先留原图 + 压一次撤销快照，几何编辑从此可撤销、可重放（参见 app-state.js 的 __geo）
        if (this.savePhotoOrigin) this.savePhotoOrigin(im);
        if (this.pushUndo) this.pushUndo();
        im.el = out;
        im.w = canvas.width;
        im.h = canvas.height;
        im.rotate = ((im.rotate || 0) + 1) % 4;
        // 几何操作日志：只记一个数字，重放时从 im.orig.el 按序执行即可得到同一张位图
        if (!im.geoOps) im.geoOps = [];
        im.geoOps.push({ t: 'r' });
        // 底图换了：旧缩略图必须作废，否则胶片条还是旋转前那张（与画布不一致）
        im.thumb = null;
        im._thumbEl = null;
        im._tqAt = 0;
        if (this.invalidateStyleCaches) this.invalidateStyleCaches();
        // 底图换了：调色缓存作废，参数保留 —— 立刻在新底图上重放（与"还原原图"一致）
        if (this.invalidateGrade) this.invalidateGrade(im);
        if (this.rebuildGrade) this.rebuildGrade('full');
        if (this.buildThumbnails) this.buildThumbnails();
        // thumb 已清空：立刻重排一张旋转后的装框缩略图（buildThumbnails 先用原图占位）
        if (this.queueThumb) this.queueThumb(im);
        this.scheduleRender(true);
        if (this.scheduleDraft) this.scheduleDraft();
        if (this.syncCropOriginalBtn) this.syncCropOriginalBtn();
        this.setStatus('照片已旋转 90°(再次右键可继续旋转，Ctrl+Z 可撤销)');
    },

    /* ══ 照片导入(拖拽/文件夹/多选共用) ══ */
    // 拖放只负责拿路径,递归收集与 EXIF 解析都放主进程(文件夹也走同一条路)
    async importPaths(paths) {
        if (!paths || !paths.length) return;
        const res = await window.qingframe.collectImages(paths);
        if (!res || !res.items || !res.items.length) {
            this.setStatus('没有找到可导入的图片');
            return;
        }
        await this.importPicked(res.items, res.skipped);
    },

    // 统一导入入口:items 为 [{name,path,size,exif}],按 3 并发加载,顺序保持不变
    async importPicked(items, skipped) {
        if (!items || !items.length) { this.setStatus('没有找到可导入的图片'); return; }
        const total = items.length;
        this.showImportProgress(total);
        const results = new Array(total).fill(null);
        let done = 0;
        let next = 0;
        const tick = (name) => { done++; this.setImportProgress(done, total, name); };
        const worker = async () => {
            for (;;) {
                const i = next++;
                if (i >= total) return;
                try { results[i] = await this.imageFromPick(items[i]); }
                catch (e) { results[i] = null; }
                tick(items[i].name);
            }
        };
        try {
            // 3 并发:几十张 24MP 大图同时解码会把内存顶爆;顺序由 results 下标保证
            await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
            let loaded = 0;
            for (const im of results) {
                if (!im) continue;
                this.images.push(im);
                loaded++;
            }
            if (!loaded) { this.setStatus('图片加载失败'); return; }
            // 非 sRGB 原片（相机里的 Adobe RGB / ProPhoto）在浏览器里会先被转成 sRGB，
            // 而 PS 若按嵌入配置文件工作，两边从第一步就不同 —— 必须让用户知道，
            // 否则会把色彩空间差异当成"调色不准"来回查。
            const wideIcc = results.filter((im) => im && im.exif && im.exif.icc
                && !/sRGB|IEC\s*61966/i.test(im.exif.icc));
            const iccNote = wideIcc.length
                ? `；其中 ${wideIcc.length} 张原片是「${wideIcc[0].exif.icc}」，已转 sRGB 处理（与 PS 按该配置文件工作会有差异）`
                : '';
            // 用户自己的照片已成功载入：示例图完成引导使命，自动退出胶片条
            const firstNew = this.images[this.images.length - loaded];
            if (firstNew && typeof this.removeSampleImages === 'function') {
                this.removeSampleImages(firstNew);
            }
            if (typeof this.scheduleDraft === 'function') this.scheduleDraft();
            const pk = this.tplPuzzle && this.tplPuzzle();
            if (pk && this.image) {
                // 拼图进行中导入:保留当前主图与拼图模板,新图先只进胶片条
                this.buildThumbnails();
                this.saveCurrentTemplate();
                this.scheduleRender(true);
                this.setStatus(`已导入 ${loaded} 张图片，拼图保持在「${this.image.name || '当前照片'}」上（可点「重拼」把新图填进格子）${iccNote}`);
            } else {
                // 墙/侧栏已经选好风格时，新导入的照片必须继承它（每张一份独立副本）。
                // 以 this.template 为准：墙（applyPresetToCurrent）和侧栏（selectPreset）都会写它，
                // pendingPreset 只是"还没照片"的标记，不能当唯一来源，否则侧栏换过风格后会继承到旧的。
                const base = this.template;
                const carry = (base && base.templateName) ? JSON.parse(JSON.stringify(base)) : null;
                const start = this.images.length - loaded;
                if (carry) {
                    for (let i = start; i < this.images.length; i++) {
                        const im = this.images[i];
                        if (typeof this.getTpl === 'function' && typeof this.setTpl === 'function' && !this.getTpl(im)) {
                            this.setTpl(im, JSON.parse(JSON.stringify(carry)));
                        }
                    }
                    this.pendingPreset = null;   // 已经转正到具体照片上
                } else {
                    this.template = this.defaultTemplate();
                    this.normalizeTemplate();
                }
                this.buildThumbnails();
                this.selectImage(start);
                // 内存提醒：每张照片的原图位图常驻（实测 24MP 约 70MB/张），
                // 同时开几十张就会把机器压到换页，表现为「切回来卡住不动」。
                // 这里只在明显过量时说一句，不阻止导入。
                const mp = (this.images || []).reduce((a, im) => a + ((im && im.w && im.h) ? im.w * im.h : 0), 0);
                const estGB = mp * 4 * 1.45 / 1073741824;
                const memWarn = estGB >= 1.5
                    ? `｜注意：当前 ${this.images.length} 张共约 ${estGB.toFixed(1)}GB 内存，建议处理完一批先删掉再导下一批`
                    : '';
                // RAW 的显影是自动的，但入口/状态在「调色」页签顶部，不主动切页签
                // （有人只想加个边框），得说一句在哪里能看见，否则会以为导入后就只能这样了。
                const rawCount = results.filter((im) => im && im.raw).length;
                const rawNote = rawCount ? `｜${rawCount} 张 RAW 会自动显影，状态见「调色」页签顶部` : '';
                this.setStatus(`已导入 ${loaded} 张图片${carry ? '，沿用「' + carry.templateName + '」' : ''}${skipped ? '，跳过 ' + skipped + ' 个不支持的文件' : ''}${iccNote}${rawNote}${memWarn}`);
            }
        } finally {
            this.finishImportProgress();
        }
    },

    // 导入进度条:total>0 显示;set 更新百分比/文案;finish 置满后淡出。
    // verb 让「继续上次会话」复用同一组件(默认是"正在导入",恢复时传"正在恢复")。
    showImportProgress(total, verb) {
        const prog = this.dom.importProgress;
        if (!prog) return;
        this._importTotal = total;
        this._importDone = 0;
        this._importVerb = verb || '正在导入';
        prog.style.display = 'flex';
        this.setImportProgress(0, total, null);
    },
    setImportProgress(done, total, name) {
        const prog = this.dom.importProgress;
        if (!prog) return;
        const pct = Math.max(0, Math.min(100, Math.round(done / Math.max(1, total || 1) * 100)));
        if (this.dom.importProgressFill) this.dom.importProgressFill.style.width = pct + '%';
        if (this.dom.importProgressText) {
            this.dom.importProgressText.textContent = `${this._importVerb || '正在导入'} ${done}/${total}${name ? ' · ' + name : ''}`;
        }
    },
    finishImportProgress(doneText) {
        const prog = this.dom.importProgress;
        if (!prog) return;
        if (this.dom.importProgressFill) this.dom.importProgressFill.style.width = '100%';
        if (this.dom.importProgressText) this.dom.importProgressText.textContent = doneText || '导入完成';
        setTimeout(() => { prog.style.display = 'none'; }, 420);
    },

    async applyOrientation(img, orientation) {
        if (!orientation || orientation === 1 || orientation === 0) return null;
        orientation = orientation | 0;
        const W = img.naturalWidth, H = img.naturalHeight;
        if (!W || !H) return null;
        // 导入时图片刚 onload，可能还设着 decoding='async'；等真正解码完再画，
        // 否则方向校正会产出一张空画布（旧 JPEG 编码后就是全黑照片）。
        if (typeof img.decode === 'function') {
            try { await img.decode(); } catch (_) { /* 交给下面的结果校验 */ }
        }
        // 源图的透明率/黑率不在这里量：那要对 Image 做整图缩放采样（~140ms/次），
        // 批量导入几十张就是好几秒。留到结果可疑时再回头诊断。
        // 旋转类(3/6/8,含镜像的 5/7)需要交换宽高;纯翻转(2/4)保持宽高
        const swapsWH = (orientation === 6 || orientation === 8 || orientation === 5 || orientation === 7);
        const canvas = document.createElement('canvas');
        canvas.width = swapsWH ? H : W;
        canvas.height = swapsWH ? W : H;
        // 同主旋转：这张画布要被条带采样读像素，标 CPU 后端避免整张同步读回
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.translate(canvas.width / 2, canvas.height / 2);
        switch (orientation) {
            case 2: ctx.scale(-1, 1); break;                  // 水平翻转
            case 3: ctx.rotate(Math.PI); break;               // 180°
            case 4: ctx.scale(1, -1); break;                  // 垂直翻转
            case 5: ctx.rotate(Math.PI / 2); ctx.scale(1, -1); break; // 转置+镜像
            case 6: ctx.rotate(Math.PI / 2); break;           // 90°
            case 7: ctx.rotate(-Math.PI / 2); ctx.scale(1, -1); break; // 横转+镜像
            case 8: ctx.rotate(-Math.PI / 2); break;          // 270°
            default: return null;
        }
        ctx.drawImage(img, -W / 2, -H / 2);
        // 与主流转同口径：只测结果画布，异常时才回头诊断源图（冷路径）。
        const st = window.qfsAlphaStats ? window.qfsAlphaStats(canvas) : null;
        // 源图有内容、结果却全空 = 这次没画上 → 放弃校正，回退原图
        if (st && st.opaque < 0.02) {
            const before = window.qfsOpaqueRatio ? window.qfsOpaqueRatio(img) : null;
            if (before != null && before > 0.5) return null;
        }
        // 源图正常、结果整片纯黑 = 上游异常 → 同样回退原图
        if (st && st.black > 0.95) {
            const beforeBlack = window.qfsBlackRatio ? window.qfsBlackRatio(img) : null;
            if (beforeBlack != null && beforeBlack < 0.5) return null;
        }
        // 纯几何操作，画布直接当图源；透明区天然保留，不再走一次 PNG 编解码。
        const out = window.qfsCanvasSource ? window.qfsCanvasSource(canvas) : await window.qfsCanvasImage(canvas);
        if (!out) return null;
        return { el: out, w: canvas.width, h: canvas.height };
    },

    // 本地照片引用 URL(经 qflocal: 协议由主进程直接流式读取,不产生 base64 副本)
    photoUrl(filePath) { return 'qflocal://img?p=' + encodeURIComponent(filePath); },

    // 自定义封面专用 URL:浏览器按 URL 缓存图片,同名封面文件被替换后只改文件
    // 不改 URL 会继续显示旧图。版本号取自文件 mtime(由 list-wall-covers 带回),
    // 所以「文件没变」时 URL 稳定,不会每次开墙/聚焦都把封面重新解码一遍;
    // 文件被替换时 mtime 变了,URL 跟着变,自然绕开旧缓存。
    // _coverVersion 是旧主进程(只给路径、给不出 mtime)的兜底:那时只能靠时间戳。
    coverUrl(filePath) {
        const u = this.photoUrl(filePath);
        const v = (this._coverVer && this._coverVer[filePath]) || this._coverVersion || 0;
        return v ? u + '&v=' + v : u;
    },

    // 把 list-wall-covers 的返回整理成「名字 → 路径」,并把 mtime 摘成按路径记的版本号。
    // 新主进程给 {名字:{path,mtime}},旧主进程只给路径字符串——两种都要能跑。
    normalizeWallCovers(covers) {
        const ver = {};
        let legacy = false;
        for (const k of Object.keys(covers || {})) {
            const v = covers[k];
            if (v && typeof v === 'object' && typeof v.path === 'string') {
                ver[v.path] = v.mtime || 0;
                covers[k] = v.path;
            } else if (typeof v === 'string') {
                legacy = true;
            }
        }
        this._coverVer = ver;
        // 旧主进程拿不到 mtime,退回时间戳版本号:宁可多解码一次,也不能显示旧图
        if (legacy) this._coverVersion = Math.max(Date.now(), (this._coverVersion || 0) + 1);
        return covers;
    },

    // 把系统选择框返回的单个文件构造成胶片条照片对象(不插入)
    async imageFromPick(res) {
        if (!res) return null;
        if (res.error) { this.setStatus(res.error); return null; }
        if (!res.path) { this.setStatus('图片加载失败：缺少文件路径'); return null; }
        const img = window.qfsImage();
        // RAW 不能直接给 Chromium：先按半尺寸代理显影（长边 1600，约 0.5s），
        // 导入能立刻看到画面；停手后再自动升到全尺寸。
        const rawInfo = res.raw && this.rawSrc
            ? {
                params: Object.assign({}, this.RAW_DEFAULTS),
                crop: null,
                edge: this.RAW_PROXY_EDGE,
                full: false,
                seq: 0
            }
            : null;
        const src = rawInfo
            ? this.rawSrc(res.path, rawInfo.params, rawInfo.edge, rawInfo)
            : this.photoUrl(res.path);
        await new Promise(r => { img.onload = r; img.onerror = r; img.src = src; });
        if (!img.naturalWidth) return null;
        const exif = res.exif || {};
        const oriented = await this.applyOrientation(img, exif.orientation);
        const useEl = oriented ? oriented.el : img;
        const w = oriented ? oriented.w : img.naturalWidth;
        const h = oriented ? oriented.h : img.naturalHeight;
        const im = { el: useEl, name: res.name, path: res.path, w, h, exif, customSettings: null,
            raw: rawInfo,
            _grade: { neutral: true, canvas: null, low: null, lowKey: '', fullKey: '' } };
        this.queueThumb(im);
        return im;
    },

    // 用户导入自己的照片后，示例图必须退出胶片条：它只是空态引导，不是用户素材。
    // 不走 removeImages：那边会立刻选中相邻图并写“已移除”状态，而导入流程随后
    // 还要选中新图；这里只清理数据，选中交给调用方。
    // replacement：示例图若正在拼图里，把槽位引用交给这张新图，避免拼图突然变空。
    removeSampleImages(replacement) {
        if (!this.images || !this.images.length) return 0;
        const sampleIdxs = [];
        this.images.forEach((im, i) => { if (im && im.sample) sampleIdxs.push(i); });
        if (!sampleIdxs.length) return 0;
        const kill = new Set(sampleIdxs);
        const removed = sampleIdxs.map(i => this.images[i]);
        const cur = this.image;
        const curWasSample = !!(cur && cur.sample);
        const replacementIdx0 = replacement ? this.images.indexOf(replacement) : -1;
        const replacementIdx = replacementIdx0 >= 0
            ? replacementIdx0 - sampleIdxs.filter(i => i < replacementIdx0).length
            : -1;
        // 示例图当前模板先留一份：如果它正显示墙里选的风格，新图要继续用
        const sampleTpl = curWasSample && this.template
            ? JSON.parse(JSON.stringify(this.template))
            : null;
        const pk = this.template && this.template.puzzle;
        if (pk && pk.slots) {
            for (const k in pk.slots) {
                const sc = pk.slots[k];
                if (!sc || sc.imageIndex == null) continue;
                if (kill.has(sc.imageIndex)) {
                    if (replacementIdx >= 0) {
                        sc.imageIndex = replacementIdx;
                        sc.imagePath = undefined;
                    } else {
                        sc.imageIndex = undefined;
                        sc.imagePath = undefined;
                    }
                } else {
                    sc.imageIndex -= sampleIdxs.filter(j => j < sc.imageIndex).length;
                }
            }
        }
        // 降序 splice，避免前面的删除让后面的索引漂移
        for (let k = sampleIdxs.length - 1; k >= 0; k--) this.images.splice(sampleIdxs[k], 1);
        removed.forEach(im => { if (typeof this.clearTpl === 'function') this.clearTpl(im); });
        if (replacement && sampleTpl && typeof this.setTpl === 'function') {
            this.setTpl(replacement, sampleTpl);
            this.pendingPreset = null;
        }
        this.batchSel = [];
        this.selectedIdx = [];
        if (curWasSample) {
            this.image = null;
            this.currentIdx = 0;
            this.selectedEls = [];
            if (typeof this._resetHistory === 'function') this._resetHistory();
        } else if (cur) {
            this.currentIdx = this.images.indexOf(cur);
        }
        if (typeof this.scheduleDraft === 'function') this.scheduleDraft();
        return removed.length;
    },

    // 把系统选择框返回的单个文件载入胶片条,返回其索引
    async appendImageFromPick(res) {
        const im = await this.imageFromPick(res);
        if (!im) return -1;
        this.images.push(im);
        // 自己的照片进来了，示例图不再保留；示例图的拼图槽位转给这张新图
        if (typeof this.removeSampleImages === 'function') this.removeSampleImages(im);
        return this.images.indexOf(im);
    },

    // 在胶片条指定位置插入新照片(打开系统选择框)。修改列表后只重新计算布局几何,
    // 保留已有格子图片与编辑状态(不自动重拼;需要完整复原请点「重拼(按序填满)」)
    async insertImageFromPick(k) {
        const res = await window.qingframe.openImage();
        if (!res) return;
        const im = await this.imageFromPick(res);
        if (!im) { this.setStatus('图片加载失败，未插入'); return; }
        const pos = Math.max(0, Math.min(k, this.images.length));
        this.images.splice(pos, 0, im);
        // 插入照片会右移列表索引:平移槽位/勾选/选中引用,保持已有格子内容与编辑状态对应正确
        const pik = this.template && this.template.puzzle;
        if (pik && pik.slots) {
            for (const si in pik.slots) {
                const sc = pik.slots[si];
                if (sc && sc.imageIndex != null && sc.imageIndex >= pos) sc.imageIndex++;
            }
        }
        this.batchSel = this.batchSel.map(x => (x >= pos ? x + 1 : x));
        this.selectedIdx = this.selectedIdx.map(x => (x >= pos ? x + 1 : x));
        // 插入自己的照片后示例图也必须退出；示例图占用的拼图格子转给新图
        if (typeof this.removeSampleImages === 'function') this.removeSampleImages(im);
        const newPos = this.images.indexOf(im);
        if (!this.image && newPos >= 0) {
            this.image = im;
            this.currentIdx = newPos;
        }
        this.buildThumbnails();
        const pk = this.tplPuzzle();
        if (pk) {
            this.ensurePuzzleSlotsCount(pk);
            this.saveCurrentTemplate();
            this.refreshPuzzleUI();
            this.scheduleRender(true);
            this.setStatus('已插入「' + res.name + '」，保留现有拼图编辑结果');
        } else {
            this.selectImage(newPos);
        }
    },

    // 从胶片条移除某张照片:槽位 imageIndex 引用平移,不再自动重拼,
    // 只重算布局几何并保留剩余格子图片与编辑状态(需要复原请点「重拼」)
    // 单张删除即"只删一张"的批量删除,统一走 removeImages(逻辑只有一份)
    removeImage(i) {
        this.removeImages([i]);
    },

    // 批量移除照片(Ctrl+A 全选后右键删除 / 单张删除共用)。
    // 与旧 removeImage 的差别:
    //  - 一次处理一批索引,必须降序 splice,否则前面的删除会让后面的索引漂移;
    //  - 允许删到 0 张:删光是合法状态(启动时本来就没有照片),回到空状态而不是报
    //    「至少保留一张照片」——那正是"全选删除没反应"的第二个原因。
    removeImages(indices) {
        if (!this.images || !this.images.length) return;
        // 去重 + 只保留合法索引
        const list = Array.from(new Set((indices || []).filter(i => Number.isInteger(i) && i >= 0 && i < this.images.length)))
            .sort((a, b) => a - b);
        if (!list.length) return;
        const kill = new Set(list);
        const removed = list.map(i => this.images[i]);
        // 拼图槽位引用平移:指向被删图的槽位清空,位于其后的整体左移(按批一次算完)
        const pk = this.template && this.template.puzzle;
        if (pk && pk.slots) {
            for (const k in pk.slots) {
                const sc = pk.slots[k];
                if (!sc || sc.imageIndex == null) continue;
                if (kill.has(sc.imageIndex)) { sc.imageIndex = undefined; sc.imagePath = undefined; }
                else sc.imageIndex -= list.filter(j => j < sc.imageIndex).length;
            }
        }
        // 记住当前主图对象:删完索引会变,不能靠索引判断它是否被删
        const cur = this.image;
        for (let k = list.length - 1; k >= 0; k--) this.images.splice(list[k], 1);
        // 顺带清掉被删照片的每图模板(单一存取口),别让 Map 一直持有整张图的模板快照
        removed.forEach(im => this.clearTpl(im));
        if (typeof this.scheduleDraft === 'function') this.scheduleDraft();
        this.batchSel = [];
        this.selectedIdx = [];
        this.buildThumbnails();
        // ══ 全部删完:回到空状态(与启动时无照片一致)══
        if (!this.images.length) {
            this.image = null;
            this.template = null;
            this.selectedEls = [];
            this.currentIdx = 0;
            if (typeof this._resetHistory === 'function') this._resetHistory();
            this.updateEmptyState();
            if (this.dom.stRes) this.dom.stRes.textContent = '';
            if (this.dom.stInfo) this.dom.stInfo.textContent = '';
            this.updateHistoryButtons();
            // 若草稿里还有上次会话,顺手把「继续上次会话」按钮亮出来 —— 删光后这是唯一的找回入口
            if (typeof this.checkDraftRestore === 'function') this.checkDraftRestore();
            this.setStatus('已删除全部 ' + removed.length + ' 张照片');
            return;
        }
        const curIdx = cur ? this.images.indexOf(cur) : -1;
        if (curIdx < 0) {
            // 当前主图被删掉了 → 就近选一张(selectImage 会重建模板/缩略图)
            this.selectImage(Math.min(this.currentIdx, this.images.length - 1));
        } else {
            this.currentIdx = curIdx;
            this.refreshUI();
            this.scheduleRender(true);
        }
        if (this.tplPuzzle()) {
            const pk2 = this.tplPuzzle();
            this.ensurePuzzleSlotsCount(pk2);
            this.saveCurrentTemplate();
            this.refreshPuzzleUI();
            this.scheduleRender(true);
            this.setStatus(removed.length > 1 ? '已删除 ' + removed.length + ' 张照片,保留剩余格子编辑结果' : '已移除「' + removed[0].name + '」,保留剩余格子编辑结果');
            return;
        }
        this.setStatus(removed.length > 1 ? '已删除 ' + removed.length + ' 张照片' : '已移除「' + removed[0].name + '」');
    },

    // 批量删除前确认(单张删除沿用旧行为,不弹窗)
    confirmRemoveImages(idxs) {
        const list = (idxs || []).filter(i => Number.isInteger(i) && i >= 0 && i < this.images.length);
        if (!list.length) return;
        if (list.length > 1 && !window.confirm('确定删除选中的 ' + list.length + ' 张照片吗?')) return;
        this.removeImages(list);
    },

    // 打开图片加入胶片条并设为当前图
    async openImage() {
        const res = await window.qingframe.openImage();
        if (!res) return;
        const idx = await this.appendImageFromPick(res);
        if (idx < 0) { this.setStatus('图片加载失败'); return; }
        this.buildThumbnails();
        this.selectImage(idx);
    },

    // 多选导入:第一张成为当前主图,其余按所选顺序追加进胶片条
    async openImages() {
        const res = await window.qingframe.openImages();
        if (!res || !res.length) return;
        await this.importPicked(res, 0);
    },

    // 文件夹导入:主进程递归收集(含子文件夹),HEIC 也在这一步进入
    async openImageFolder() {
        const res = await window.qingframe.openImageFolder();
        if (!res) return;
        if (!res.items || !res.items.length) {
            this.setStatus('该文件夹里没有支持的图片');
            return;
        }
        await this.importPicked(res.items, res.skipped);
    },

    // 示例照片:不打包进用户数据,从应用内置资源读取。
    // 目的不是代替导入,而是让从预设墙进来的人先看到"成品长什么样",再决定要不要用自己的照片。
    async loadSamplePhoto() {
        // 示例图只是空态引导：用户已经有自己的照片后，不再补回示例图。
        // 兼容旧状态里示例图仍和自己的照片并存的情况，顺手清掉。
        const own = (this.images || []).find(im => im && !im.sample);
        if (own) {
            this.image = own;
            this.currentIdx = this.images.indexOf(own);
            if (typeof this.removeSampleImages === 'function') this.removeSampleImages(own);
            this.buildThumbnails();
            const idx = this.images.indexOf(own);
            if (idx >= 0) this.selectImage(idx);
            this.setStatus('已有自己的照片，示例图已隐藏');
            return;
        }
        const existing = (this.images || []).findIndex(im => im && im.sample);
        if (existing >= 0) {
            this.selectImage(existing);
            this.setStatus('已切到示例照片；导入自己的照片后可以随时删掉它');
            return;
        }
        const img = window.qfsImage();
        img.decoding = 'async';
        await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; img.src = 'assets/samples/sample-photo.webp'; });
        if (!img.naturalWidth) { this.setStatus('示例照片加载失败，请直接导入自己的照片'); return; }
        const im = {
            el: img,
            name: '示例照片',
            path: null,
            sample: true,
            w: img.naturalWidth,
            h: img.naturalHeight,
            exif: {},
            customSettings: null,
        };
        this.images.push(im);
        this.queueThumb(im);
        // 示例图不经过 importPicked，但同样要继承墙/侧栏已经选好的风格。
        // 否则 selectImage 发现示例图没有历史模板，会回退到 defaultTemplate()，
        // 表现就是“墙里选了预设，点示例图后却变回原图”。
        const base = this.template;
        const carry = (base && base.templateName) ? JSON.parse(JSON.stringify(base)) : null;
        if (carry && typeof this.setTpl === 'function') {
            this.setTpl(im, carry);
            this.pendingPreset = null;
        }
        this.buildThumbnails();
        this.selectImage(this.images.length - 1);
        this.setStatus(carry
            ? `已载入示例照片，沿用「${carry.templateName}」；点工具栏左侧「导入照片」换成自己的`
            : '已载入示例照片；点工具栏左侧「导入照片」换成自己的');
    },

    // 系统剪贴板图片(截图/网页复制)导入
    async pasteImageFromClipboard() {
        const res = await window.qingframe.readClipboardImage();
        if (!res) { this.setStatus('剪贴板里没有图片'); return; }
        await this.importPicked([res], 0);
    },

    // 双击格子:系统文件选择框替换该格照片(自动加入胶片条并合成刷新)
    async openSlotImage(slotIdx) {
        const res = await window.qingframe.openImage();
        if (!res) return;
        const idx = await this.appendImageFromPick(res);
        if (idx < 0) { this.setStatus('图片加载失败，未替换'); return; }
        const pk = this.tplPuzzle();
        if (!pk) { this.buildThumbnails(); this.selectImage(idx); return; }
        // 示例图若刚被移除，当前图会为空；拼图编辑要落到这张新图上
        if (!this.image && this.images[idx]) {
            this.image = this.images[idx];
            this.currentIdx = idx;
        }
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        const sc = pk.slots[slotIdx] || (pk.slots[slotIdx] = {});
        sc.imageIndex = idx;
        sc.imagePath = undefined;
        this.saveCurrentTemplate();
        this.buildThumbnails();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        this.setStatus(`槽位 ${slotIdx + 1} 已替换为「${res.name}」`);
    },

    // 指定槽位当前照片的文件名
    slotImageName(i) {
        const pk = this.template && this.template.puzzle;
        if (!pk || !pk.slots || !pk.slots[i]) return null;
        const sc = pk.slots[i];
        let idx = sc.imageIndex;
        if (idx == null && sc.imagePath != null) idx = this.images.findIndex(x => x.name === sc.imagePath);
        return (idx != null && idx >= 0 && this.images[idx]) ? this.images[idx].name : null;
    },

    /* ── 缩略图:异步原图占位 + 后台队列渲染"带边框成品预览" ── */
    // 入队生成该图的装框缩略图(先保持原图占位,不卡界面);已有缩略图时防抖 350ms 避免连续编辑反复重渲染
    queueThumb(im) {
        if (!im) return;
        if (im.thumb != null && Date.now() - (im._tqAt || 0) < 350) return;
        im._tqAt = Date.now();
        if (!this._thumbQueue) this._thumbQueue = [];
        if (this._thumbQueue.indexOf(im) >= 0) return;
        this._thumbQueue.push(im);
        this.startThumbTick();
    },

    startThumbTick() {
        if (this._thumbBusy) return;
        this._thumbBusy = true;
        setTimeout(() => {
            const im = (this._thumbQueue || []).shift();
            this._thumbBusy = false;
            if (!im) return;
            this.renderFramedThumb(im);
            if ((this._thumbQueue || []).length) setTimeout(() => this.startThumbTick(), 16);
        }, 16);
    },

    // 用该图自己的模板(没有则用当前模板快照)在 200px 离屏画布渲染装框成品,替换占位
    // 注意:无独立模板的图只显示边框效果,不继承当前图的 logo/贴纸/自由文字——
    // 这些元素是各图独立记忆的(见 app-sync.js 的同步语义注释),缩略图与主画布口径保持一致。
    renderFramedThumb(im) {
        if (!window.__render || !im) return;
        const prevCanvas = this.dom.canvas;
        const prevMax = this.displayMax;
        const prevImg = this.image;
        const prevTpl = this.template;
        // 渲染管线还会往 app 上写「这一帧的几何」:照片矩形 _photoRect 与基准尺寸
        // _canvasBaseW/H / _canvasScale。蒙版叠加层全靠 _photoRect 把指针换算成照片内坐标，
        // 而缩略图渲染用的是**另一张图的模板**、且 displayMax=200 —— 它写进去的矩形属于
        // 那次渲染，不是当前画面。漏还原就会:调色/羽化滑块一停手(260ms 后重渲缩略图)，
        // 绿蒙版突然跳到画布别处，直到下一次整帧渲染才回来。
        const prevPhotoRect = this._photoRect;
        const prevBaseW = this._canvasBaseW, prevBaseH = this._canvasBaseH;
        const prevScale = this._canvasScale;
        const cv = document.createElement('canvas');
        cv.width = 1; cv.height = 1;
        cv.style.position = 'absolute'; cv.style.visibility = 'hidden';
        // 记下这次渲染用的是哪张位图：buildThumbnails 会核对，防止旧缩略图串到新底图上
        const srcEl = im.el;
        try {
            this.dom.canvas = cv;
            this.displayMax = 200;
            this.image = im;
            const saved = this.getTpl(im);
            this.template = saved ? JSON.parse(JSON.stringify(saved)) : (prevTpl ? JSON.parse(JSON.stringify(prevTpl)) : null);
            if (!this.template) return;
            // 无独立模板的图:剔除水印元素,避免当前图的 logo/贴纸/文字串到其它图缩略图上
            if (!saved) {
                delete this.template.logoElements;
                if (this.template.decorConfig) {
                    delete this.template.decorConfig.stickers;
                    delete this.template.decorConfig.textLines;
                }
            }
            window.__render(this, false);
            im.thumb = cv.toDataURL('image/jpeg', 0.8);
            im._thumbEl = srcEl;
            // 直接按图对象取缩略图节点:原来每次都 querySelectorAll('img.thumb') 扫全条再逐个比对
            // dataset.idx,导入 50 张时是 O(n²)(2500 次节点访问 + 属性读)。
            // 映射缺失时(例如缩略图条还没建)回退到原来的扫描,行为不变。
            const fresh = im._thumbEl === im.el;
            const hit = this._thumbEls && this._thumbEls.get(im);
            if (hit && hit.isConnected) {
                if (fresh && hit.src !== im.thumb) hit.src = im.thumb;
            } else {
                const strip = this.dom.thumbStrip ? this.dom.thumbStrip.querySelectorAll('img.thumb') : [];
                strip.forEach(t => {
                    const ti = t.dataset.idx != null ? parseInt(t.dataset.idx, 10) : -1;
                    if (fresh && ti >= 0 && this.images[ti] === im && t.src !== im.thumb) t.src = im.thumb;
                });
            }
        } catch (_) { /* 装框缩略图失败:保留原图占位 */ }
        finally {
            this.image = prevImg;
            this.template = prevTpl;
            if (this.dom.canvas === cv) this.dom.canvas = prevCanvas;
            if (prevMax === undefined) delete this.displayMax;
            else this.displayMax = prevMax;
            // 缩略图那一帧写的几何必须一起还原，否则蒙版叠加层会按缩略图的照片矩形定位
            this._photoRect = prevPhotoRect;
            if (prevBaseW === undefined) delete this._canvasBaseW; else this._canvasBaseW = prevBaseW;
            if (prevBaseH === undefined) delete this._canvasBaseH; else this._canvasBaseH = prevBaseH;
            if (prevScale === undefined) delete this._canvasScale; else this._canvasScale = prevScale;
            // 还原后若当前图已不是选中图（临时渲染期间用户切了图），纠正并补一帧，
            // 否则画布会停在旧图、缩略图却高亮新图。
            if (this._reconcileCurrentImage && this._reconcileCurrentImage()) this.scheduleRender(true);
        }
    },

    buildThumbnails() {
        const strip = this.dom.thumbStrip;
        strip.innerHTML = '';
        // 图对象 → 缩略图节点 的映射,供 renderFramedThumb 直接定位(见那里的注释)
        const elMap = new Map();
        const usedMap = this.puzzleUsedImageMap ? this.puzzleUsedImageMap() : new Map();
        this.images.forEach((im, i) => {
            const wrap = document.createElement('div');
            wrap.className = 'thumb-item';
            wrap.draggable = false;
            const t = document.createElement('img');
            const isSel = this.batchSel.includes(i);
            // 同步源 = 当前编辑中的照片(app-sync.js 同步语义):批量为多张时在源图上标注「源」
            const isSrc = this.batchSel.length > 1 && this.image === im;
            const cls = ['thumb'];
            if (isSel) cls.push('active');
            if (isSrc) cls.push('src');
            if (this.image && this.images.indexOf(this.image) === i) cls.push('main');
            t.className = cls.join(' ');
            t.draggable = false;
            // 缩略图必须由**当前位图**渲染：renderFramedThumb 会在 im._thumbEl 记下源 el。
            // 对不上（旧版本缓存 / 串图 / 换过底图）就丢掉，先用原图占位并重排 ——
            // 否则胶片条会显示一张和画布完全不同的照片，看起来像切错图。
            const fresh = !!(im.thumb && im._thumbEl === im.el);
            if (im.thumb && !fresh) {
                im.thumb = null;
                im._thumbEl = null;
                im._tqAt = 0;
                if (typeof this.queueThumb === 'function') this.queueThumb(im);
            }
            // 同值不重赋:赋 src 会让浏览器重新解码同一张图
            // 旋转/裁切后 im.el 可能是 canvas（纯几何操作不再编码往返），它没有 src。
            // 这里必须给空串：直接赋 undefined 会被转成字符串 "undefined"，浏览器
            // 拿它当相对路径去请求，缩略图位就变成一个碎图标。空串不触发加载，
            // 下一帧 queueThumb 补上真图。
            const wantSrc = fresh ? im.thumb : (im.el.src || '');
            if (t.src !== wantSrc) t.src = wantSrc;
            t.dataset.idx = i;
            elMap.set(im, t);
            t.title = im.name;
            t.addEventListener('click', e => {
                // 单击 = 选中并切换为当前主图(恢复该图自己的边框模板);Ctrl/Shift+单击 = 追加/取消多选
                if (e.shiftKey || e.ctrlKey || e.metaKey) { e.stopPropagation(); this.toggleSelect(i); return; }
                // 拼图模式：单击照片 = 放入当前选中格；直接切主图会把拼图整个切走
                if (this.tplPuzzle && this.tplPuzzle() && this.assignPuzzlePhotoFromStrip) {
                    this.assignPuzzlePhotoFromStrip(i);
                    return;
                }
                this.selectImage(i);
            });
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'thumb-check';
            cb.title = '勾选用于批量放图';
            cb.checked = isSel;
            cb.addEventListener('click', e => { e.stopPropagation(); this.toggleBatch(i, cb); });
            // 桌面右键菜单：三种同步 + 删除。目标沿用旧口径——右键落在「已勾选且
            // 勾了多张」的缩略图上就对整批操作，否则只对右键的这一张操作。
            // 三条同步分别是：只调色 / 边框+调色 / 只边框，中间用分隔线和删除隔开。
            const ctxI = i;
            wrap.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
                const many = this.batchSel.length > 1 && this.batchSel.includes(ctxI);
                const targets = many ? this.batchSel.slice() : [ctxI];
                // 同步源 = 当前编辑图，不计入目标数（与 app-sync.js 的目标集口径一致）
                const syncN = many ? targets.filter(k => k !== this.currentIdx).length : 1;
                const tail = many ? `（${syncN} 张）` : '';
                this.openCtx(e.clientX, e.clientY, [
                    [`同步调色参数${tail}`, () => this.applyGradeToTargets(targets),
                        '只把当前照片的调色参数（曲线 / 混色器 / 蒙版等）复制给目标，边框不动'],
                    [`同步边框 + 调色${tail}`, () => this.syncSettingsToTargets(targets),
                        '边框和调色参数一起复制；目标自己的贴纸、自由文字、拼图仍保留'],
                    [many ? `同步边框（${syncN} 张）` : '同步边框',
                        () => many ? this.applyBorderToSelected() : this.syncBorderTo(ctxI),
                        '只复制边框与参数条，调色参数不动'],
                    ['—', null],
                    [many ? `删除选中 ${targets.length} 张` : '删除',
                        () => many ? this.confirmRemoveImages(targets) : this.removeImage(ctxI)],
                ]);
            });
            wrap.appendChild(t);
            wrap.appendChild(cb);
            if (isSrc) {
                const tag = document.createElement('span');
                tag.className = 'thumb-src';
                tag.textContent = '源';
                tag.title = '同步源：当前编辑中的照片（同步时以它的边框为准）';
                wrap.appendChild(tag);
            }
            const usedSlots = usedMap.get(i) || [];
            if (usedSlots.length) {
                const used = document.createElement('span');
                used.className = 'thumb-used';
                used.textContent = usedSlots.length > 1 ? '×' + usedSlots.length : String(usedSlots[0]);
                used.title = `已放入拼图第 ${usedSlots.join('、')} 格`;
                wrap.appendChild(used);
            }
            strip.appendChild(wrap);
        });
        this._thumbEls = elMap;
        strip.style.display = this.images.length > 1 ? 'flex' : 'none';
        // 多选不再弹浮动操作条（它压在照片下沿）：批量同步走顶栏「同步到选中」/Ctrl+D，
        // 批量删除走右键菜单或 Delete，取消多选直接单击任一缩略图或再按一次 Ctrl+A。
        if (typeof this.updateExportEntry === 'function') this.updateExportEntry();
        if (typeof this.updateImmersiveEntry === 'function') this.updateImmersiveEntry();
        // 左侧照片库与胶片条共用同一份缩略图数据，勾选/入格后同步刷新
        if (this._sideMode === 'photo' && typeof this.renderPhotoLibrary === 'function') this.renderPhotoLibrary();
    },

    // 勾选切换(checkbox;与 Ctrl/Shift 多选同一份 batchSel,按勾选顺序排队)
    toggleBatch(i, cb) {
        const k = this.batchSel.indexOf(i);
        if (k >= 0) this.batchSel.splice(k, 1);
        else this.batchSel.push(i);
        if (cb) cb.checked = this.batchSel.includes(i);
        this.selectedIdx = this.batchSel.slice();
        this.buildThumbnails();
        this.setStatus(this.batchSel.length ? `已勾选 ${this.batchSel.length} 张照片，点布局按勾选顺序放入` : '已取消批量勾选');
    },

    toggleSelect(i) {
        const k = this.batchSel.indexOf(i);
        if (k >= 0) this.batchSel.splice(k, 1);
        else this.batchSel.push(i);
        this.selectedIdx = this.batchSel.slice();
        this.buildThumbnails();
        this.setStatus(this.batchSel.length ? `已框选 ${this.batchSel.length} 张照片，点布局按勾选顺序放入` : '已取消框选');
    },

    /* ══ 字体下拉填充(装饰文字/拼图字幕共用 curatedFonts) ══ */
    populateFonts() {
        ['cbCapFont1', 'cbCapFont2', 'cbElTextFont'].forEach(id => {
            const sel = this.$(id);
            if (!sel) return;
            sel.innerHTML = '';
            this.curatedFonts.forEach((f, i) => {
                const o = document.createElement('option');
                o.value = f;
                o.textContent = f;
                if (i === 0) o.selected = true;
                sel.appendChild(o);
            });
        });
    },

    /* ══ 静态控件绑定 ══ */
    setupPanelInteractions() {
        const $ = this.$;

        // 通用:range 拖拽时即时同步,change/pointerup 提交;select/checkbox 变更即提交
        this.bindRanges([
            'slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius',
            'slParamFontSize', 'slBrandSize', 'slParamScale', 'slGlassSize', 'slFillOpacity', 'slGradientAngle', 'slTextureScale', 'slStrokeWidth', 'slStrokeOpacity',
            'slShadowX', 'slShadowY', 'slShadowBlur', 'slShadowOpacity', 'slGlowBlur', 'slGlowOpacity',
            'slVignetteStrength', 'slVignetteFeather', 'slLeakOpacity', 'slLeakAngle', 'slFilmGrain',
            'slActiveIconOpacity', 'slElementRotation', 'slPuzzleGap', 'slPuzzleCorner',
            'slCapSize1', 'slCapSize2', 'slCapSpacing', 'slSlotOffsetX', 'slSlotOffsetY', 'slSlotZoom',
            'slAppleModelSize', 'slAppleParamSize', 'slAppleDateSize',
            'slAppleLogoSize', 'slAppleLogoOpacity', 'slAppleLineWidth',
            'slXmBrandSize', 'slXmLineSize', 'slXmLogoSize', 'slXmLogoOpacity', 'slXmPad', 'slXmScrim',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius',
        ]);
        const onEdit = ['slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius', 'slParamFontSize', 'slBrandSize', 'slParamScale', 'slGlassSize',
            'slAppleModelSize', 'slAppleParamSize', 'slAppleDateSize',
            'slAppleLogoSize', 'slAppleLogoOpacity', 'slAppleLineWidth',
            'slXmBrandSize', 'slXmLineSize', 'slXmLogoSize', 'slXmLogoOpacity', 'slXmPad', 'slXmScrim',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius'];
        (onEdit).forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('input', () => this.onSliderCustom(id, parseInt(el.value, 10)));
        });
        // 滑块行增强:数值可精确输入、标签/数值双击单行复位(不改变滑块原有手感与提交路径)
        this.enhanceRangeRows();

        // 参数字号:双击滑块回到默认档位(= 刚加完边框那一刻软件给的字号)。
        // 默认档在滑块中段(33/160),想回去得一路拖,太精细;双击给一条直达路径。
        // 走的是与拖动完全相同的 onSliderCustom 通路,标签刷新、重绘、撤销栈都不会分叉。
        // 只给这一个滑块加:其余 range 滑块(边距大小/图片缩放/参数缩放/品牌大小/背景模糊程度)
        // 全是 min>=10 的百分比区间,引擎侧没有"默认"档位,没有可回退的目标。
        //
        // 注意:目标不是档位 0。0 是 autoPf = clamp(round(min(iw,ih)/45), 20, 64)
        // (engine-styles.js buildState),与默认档是两条不同公式:小图上 0 档偏小约 1.7 倍,
        // 大图上因撞 64 档上限反而偏大 1.9 倍。所以双击回的是 defaultTemplate() 的那个值。
        const slPF = $('slParamFontSize');
        if (slPF) {
            slPF.title = '双击回到默认字号';
            slPF.addEventListener('dblclick', () => {
                const def = Number(this.defaultTemplate().paramFontSize) || 33;
                if (parseInt(slPF.value, 10) === def) return;  // 已在默认档,不做无谓重绘
                slPF.value = String(def);
                this.onSliderCustom('slParamFontSize', def);
            });
        }

        // 复选框 -> onSettingCommit
        const chks = ['cbCornerLock', 'cbCapBgBar', 'cbLayerCornerLock', 'cbExifText', 'cbFocalEq', 'cbCanvasSync', 'chkGlassDate',
            'chkAppleShowBrand', 'chkAppleShowModel', 'chkAppleShowParams', 'chkAppleShowDate',
            'chkAppleShowLogo', 'chkAppleShowLine'];
        chks.forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('change', () => this.onSettingCommit());
        });
        // 光照页签复制的阴影/发光已移除,统一收敛到「边框」页签

        // select 变更 -> commit
        const sels = ['cbCanvasRatio', 'cbParamPosition', 'cbParamType', 'cbFillType', 'cbGradientType', 'cbTextureBlend',
            'cbStrokePos', 'cbLeakType', 'cbPuzzleBg', 'cbPuzzleCanvas',
            'cbSlotFill', 'cbCapFont1', 'cbCapFont2'];
        sels.forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('change', () => this.onSelectCustom(id));
        });
        // 参数类型切到「仅参数 / 日期」时，底部文字只剩一行：
        // 行间距 / 品牌间距要立刻收起，不能等下一次 refreshUI 才更新。
        if ($('cbParamType')) {
            $('cbParamType').addEventListener('change', () => this.updatePersonalVisibility());
        }

        // 数字/文本输入:input 即时同步(防抖),change 提交
        const nums = ['tfImgOffsetX', 'tfImgOffsetY'];
        nums.forEach(id => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('focus', () => this.beginGesture());
            el.addEventListener('blur', () => this.endGesture());
            el.addEventListener('input', () => this.onSettingChanged());
            el.addEventListener('change', () => this.onSettingCommit());
        });
        const texts = ['tfExifBrand', 'tfExifModel', 'tfExifFocal', 'tfExifAperture', 'tfExifIso', 'tfExifShutter',
            'tfStrokeDash', 'tfTemplateName', 'tfTemplateTag', 'tfCapLine1', 'tfCapLine2'];
        texts.forEach(id => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('focus', () => this.beginGesture());
            el.addEventListener('blur', () => this.endGesture());
            el.addEventListener('input', () => this.onTextCustom(id));
            el.addEventListener('change', () => this.onSettingCommit());
        });

        // 颜色选择器:input 即时预览,change 关闭取色器后提交压栈(与滑块同一套通路)。
        // 拼图的两个色要先补一次 syncPuzzleFromUI:字幕颜色挂在"当前编辑槽位"的模型上
        // (captureCaptionToModel 只在滑块/提交通路里被调),少了这步就是"取色后画面不动,
        // 动一下别的控件才补上";cpPuzzleBorder 同样要从 pk 模型读回。
        // 不含 cpT2iColor —— 它只在「文字转图片」按钮按下时读一次,不属于画布状态。
        const colors = ['cpFillColor', 'cpStrokeColor', 'cpShadowColor', 'cpGlowColor', 'cpCapColor', 'cpPuzzleBorder'];
        colors.forEach(id => {
            const el = $(id);
            if (!el) return;
            const sync = () => { if (id === 'cpCapColor' || id === 'cpPuzzleBorder') this.syncPuzzleFromUI(); };
            el.addEventListener('input', () => { sync(); this.onSettingChanged(); });
            el.addEventListener('change', () => { sync(); this.onSettingCommit(); });
        });

        // 图层按钮
        const bindBtn = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => fn()); };
        bindBtn('btnBuiltinTexture', () => this.pickBuiltinTexture());
        bindBtn('btnSelectTexture', () => this.pickTexture());
        bindBtn('btnAddCustomIcon', () => this.addCustomIcon());
        bindBtn('btnImportLogoPack', () => this.importLogoPack());
        bindBtn('btnTextToImage', () => this.textToImage());
        const t2iInp = $('tfTextToImage');
        if (t2iInp) t2iInp.addEventListener('input', () => {
            const show = String(t2iInp.value).trim().length > 0;
            ['rowT2iStyle', 'rowT2iColor', 'rowT2iEffect'].forEach(id => { const el = $(id); if (el) el.style.display = show ? '' : 'none'; });
        });
        bindBtn('btnCopySelectedElement', () => this.copyElement());
        bindBtn('btnPasteClipboardElement', () => this.pasteElement());
        bindBtn('btnDeleteActiveIcon', () => this.deleteElement());
        bindBtn('btnClearAllIcons', () => this.clearElements());
        bindBtn('btnSaveTemplate', () => this.saveTemplate());
        bindBtn('btnExportTemplate', () => this.exportTemplate());
        bindBtn('btnImportTemplate', () => this.importTemplate());
        bindBtn('btnExportConfig', () => this.exportConfig());
        bindBtn('btnImportConfig', () => this.importConfig());
        bindBtn('btnCopyShareCode', () => this.copyShareCode());
        bindBtn('btnImportShareCode', () => this.importShareCode());
        bindBtn('btnCamLibSave', () => this.saveCurrentCamLib());
        bindBtn('btnCamLibRename', () => this.renameCamLibEntry());
        bindBtn('btnCamLibDel', () => this.deleteCamLibEntry());
        const camSel = $('cbCamLib');
        if (camSel) camSel.addEventListener('change', () => { if (camSel.value) this.applyCamLibEntry(camSel.value); else this.refreshCamLibSelect(); });
        // 「快速预设」分组已移除（按钮 btnQuickFilm / btnAutoColorBorder），
        // 对应实现 applyQuickPreset() / autoColorBorder() 仍保留，可挂到别处入口。
        bindBtn('btnEditGapCaption', () => this.addEditGapCaption());
        bindBtn('btnDeleteGapCaption', () => this.deleteCaption());
bindBtn('btnResetAllSlots', () => this.resetAllSlots());
bindBtn('btnResetPuzzleAxes', () => this.resetPuzzleAxes());
                bindBtn('btnPuzzleClearSlots', () => this.clearPuzzleSlots());
        // 退出/导出统一走全局入口：画布左上角「退出拼图」+ 顶栏主按钮（拼图页签下自动变「导出拼图」）
        bindBtn('btnGridPreview', () => this.renderGridPreview());
        bindBtn('btnGridExport', () => this.exportGridCrop());
        bindBtn('btnGridPreviewExport', () => this.exportGridCrop());
        bindBtn('btnGridPreviewCancel', () => this.hideGridPreview());
        bindBtn('gridPreviewClose', () => this.hideGridPreview());
        bindBtn('btnGridZoomBack', () => {
            const zoom = document.getElementById('gridPreviewZoom');
            if (zoom) zoom.style.display = 'none';
            const hint = document.getElementById('gridPreviewHint');
            if (hint) hint.style.display = '';
            const box = document.getElementById('gridPreviewGrid');
            if (box) box.style.display = '';
        });
        // 切图设置记忆
        if (typeof this.loadGridPrefs === 'function') this.loadGridPrefs();
        const gridSizeEl = document.getElementById('selGridSize');
        if (gridSizeEl) gridSizeEl.addEventListener('change', () => {
            if (typeof this.invalidateGridCache === 'function') this.invalidateGridCache();
            if (typeof this.syncGridCustomUI === 'function') this.syncGridCustomUI();
            if (typeof this.saveGridPrefs === 'function') this.saveGridPrefs();
        });
        const gridRenderEl = document.getElementById('selGridRender');
        if (gridRenderEl) gridRenderEl.addEventListener('change', () => {
            if (typeof this.invalidateGridCache === 'function') this.invalidateGridCache();
            if (typeof this.saveGridPrefs === 'function') this.saveGridPrefs();
        });
        ['inpGridCols', 'inpGridRows'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', () => {
                if (typeof this.invalidateGridCache === 'function') this.invalidateGridCache();
                if (typeof this.updateGridRatioHint === 'function') this.updateGridRatioHint();
            });
            el.addEventListener('change', () => {
                if (typeof this.invalidateGridCache === 'function') this.invalidateGridCache();
                if (typeof this.normalizeGridInputs === 'function') this.normalizeGridInputs();
                if (typeof this.saveGridPrefs === 'function') this.saveGridPrefs();
            });
        });
        const padEl = document.getElementById('slGridPad');
        if (padEl) padEl.addEventListener('input', () => {
            const lbl = document.getElementById('lblGridPad');
            if (lbl) lbl.textContent = padEl.value;
            if (typeof this.invalidateGridCache === 'function') this.invalidateGridCache();
            if (typeof this.saveGridPrefs === 'function') this.saveGridPrefs();
        });
        const subEl = document.getElementById('cbGridSubdir');
        if (subEl) subEl.addEventListener('change', () => { if (typeof this.saveGridPrefs === 'function') this.saveGridPrefs(); });
        // 预览单块放大
        const gbox = document.getElementById('gridPreviewGrid');
        if (gbox) gbox.addEventListener('click', (e) => {
            const cell = e.target.closest('.grid-preview-cell');
            if (!cell || !cell._cv) return;
            const img = document.getElementById('gridPreviewZoomImg');
            img.src = cell._cv.toDataURL('image/jpeg', 0.92);
            const cap = document.getElementById('gridPreviewZoomCap');
            if (cap) cap.textContent = '第 ' + cell._idx + ' 块 · ' + cell._cv.width + '×' + cell._cv.height + 'px';
            const zoom = document.getElementById('gridPreviewZoom');
            if (zoom) zoom.style.display = 'block';
            const hint = document.getElementById('gridPreviewHint');
            if (hint) hint.style.display = 'none';
            gbox.style.display = 'none';
        });
        bindBtn('btnSettings', () => this.openSettings());
        bindBtn('btnFramePanel', () => {
            if (window.QfsFramePanel) { window.QfsFramePanel.init(this); window.QfsFramePanel.open(); }
        });
        bindBtn('btnZineOpen', () => {
            if (window.QfsZinePanel) { window.QfsZinePanel.init(); window.QfsZinePanel.show(); }
        });
        bindBtn('tabFrameStudio', () => {
            if (window.QfsZinePanel) { window.QfsZinePanel.init(); window.QfsZinePanel.backToFrame(); }
        });
        bindBtn('settingsClose', () => this.closeSettings());
        const settingsTabs = Array.from(document.querySelectorAll('#settingsModal .settings-tab'));
        settingsTabs.forEach((b) => {
            b.addEventListener('click', () => this.switchSettingsTab(b.dataset.settingsTab));
            b.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const i = settingsTabs.indexOf(b);
                const next = settingsTabs[(i + (e.key === 'ArrowRight' ? 1 : settingsTabs.length - 1)) % settingsTabs.length];
                next.focus();
                this.switchSettingsTab(next.dataset.settingsTab);
            });
        });
        const slFontScale = $('slFontScale'), btnFontScaleReset = $('btnFontScaleReset');
        if (slFontScale) {
            slFontScale.addEventListener('input', () => this.applyFontScale(parseFloat(slFontScale.value)));
            slFontScale.addEventListener('change', () => this._saveFontScale());
        }
        if (btnFontScaleReset) btnFontScaleReset.addEventListener('click', () => { this.applyFontScale(1); this._saveFontScale(); });
        const segTheme = $('segTheme');
        if (segTheme) segTheme.addEventListener('click', (e) => {
            const b = e.target.closest('[data-theme]');
            if (!b) return;
            const theme = b.dataset.theme === 'light' ? 'light' : 'dark';
            this.applyTheme(theme);
            if (window.qingframe && window.qingframe.savePrefs) {
                window.qingframe.savePrefs({ theme }).catch(() => {});
            }
        });
        const segPreview = $('segPreview');
        if (segPreview) segPreview.addEventListener('click', (e) => {
            const b = e.target.closest('[data-preview]');
            if (!b) return;
            this.applyPreviewQuality(b.dataset.preview === 'full');
            this._savePreviewQuality();
        });
        bindBtn('btnSettingsResetAll', () => this.resetAllSettings());
        bindBtn('btnPickExportDir', () => this.chooseDefaultExportDir());
        bindBtn('btnClearExportDir', () => this.clearDefaultExportDir());
        bindBtn('btnAboutCheck', () => this.checkUpdatesFromAbout());
        bindBtn('btnSaveUpdateMirror', () => this.saveUpdateMirror());
        // 更新下载源：下拉与输入框双向联动（见 app-export.js onMirrorSelectChange / onMirrorInput）
        const selUpdateMirror = $('selUpdateMirror');
        if (selUpdateMirror) selUpdateMirror.addEventListener('change', () => this.onMirrorSelectChange());
        const tfUpdateMirror = $('tfUpdateMirror');
        if (tfUpdateMirror) tfUpdateMirror.addEventListener('input', () => this.onMirrorInput());
        // 自动检查更新:选中即保存(与镜像下拉同一套手感),主进程启动时读这个字段决定查不查
        const selAutoCheck = $('selAutoCheck');
        if (selAutoCheck) selAutoCheck.addEventListener('change', () => {
            const v = ['startup', 'daily', 'off'].indexOf(selAutoCheck.value) >= 0 ? selAutoCheck.value : 'startup';
            if (window.qingframe && window.qingframe.savePrefs) {
                window.qingframe.savePrefs({ autoCheck: v }).catch(() => {});
            }
        });
        bindBtn('btnAboutIntro', () => this.showIntroAgain());
        bindBtn('aboutUpdateAction', () => this.aboutUpdateActionClick());
        const repo = 'https://github.com/lumos-1s/Qing-Fram-Shadow';
        const aboutLinks = {
            btnAboutHome: repo,
            btnAboutIssues: repo + '/issues',
            btnAboutReleases: repo + '/releases',
            btnAboutThirdParty: repo + '/blob/main/THIRD-PARTY-ASSETS.md',
            btnAboutLicense: repo + '/blob/main/LICENSE',
            btnAboutPrivacy: repo + '/blob/main/PRIVACY.md',
        };
        Object.entries(aboutLinks).forEach(([id, url]) => bindBtn(id, () => this.openExternal(url)));
        bindBtn('btnAboutChangelog', () => this.openChangelog());
        bindBtn('btnChangelogClose', () => this.closeChangelog());
        bindBtn('btnChangelogDone', () => this.closeChangelog());
        bindBtn('btnChangelogReleases', () => this.openExternal(repo + '/releases'));
        const changelogModal = $('changelogModal');
        if (changelogModal) changelogModal.addEventListener('click', (e) => { if (e.target === changelogModal) this.closeChangelog(); });
        const settingsModal = $('settingsModal');
        if (settingsModal) settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) this.closeSettings(); });
        // 设置弹窗的键盘闭环:Esc 关闭,Tab 在弹窗内循环(关闭后焦点回到触发按钮)。
        // 关于已并入设置,不再有独立的关于弹窗需要判定。
        document.addEventListener('keydown', (e) => {
            // 更新内容是叠在设置之上的一层:Esc/Tab 先归它,关掉后按键才回到设置弹窗
            const cl = $('changelogModal');
            if (cl && cl.style.display !== 'none') {
                if (e.key === 'Escape') { e.preventDefault(); this.closeChangelog(); return; }
                if (e.key === 'Tab') this.trapFocus(cl, e);
                return;
            }
            const sm = $('settingsModal');
            if (!sm || sm.style.display === 'none') return;
            if (e.key === 'Escape') {
                e.preventDefault();
                this.closeSettings();
                return;
            }
            if (e.key === 'Tab') this.trapFocus(sm, e);
        });
        bindBtn('btnIntroDone', () => this.closeIntro());
        const introModal = $('introModal');
        if (introModal) introModal.addEventListener('click', (e) => { if (e.target === introModal) this.closeIntro(); });
        bindBtn('btnUpdateAction', () => this.updateAction());
        bindBtn('btnUpdateSlow', () => this.openAboutMirror());
        bindBtn('btnUpdateClose', () => this.hideUpdateBanner());
        this.initUpdater();
        this.initDiag();
        bindBtn('btnPuzzleAddImg', () => this.openImage());
        bindBtn('btnPuzzleRepuzzle', () => this.rePuzzleFill());
        bindBtn('btnPuzzleFillEmpty', () => this.fillEmptyPuzzleSlots());
        bindBtn('btnPuzzleExit', () => this.disablePuzzle());
        bindBtn('btnPhotoLibAdd', () => this.openImage());
        bindBtn('psbReplace', () => { if (this._activePuzzleSlot != null) this.openSlotImage(this._activePuzzleSlot); });
        bindBtn('psbRotate', () => { if (this._activePuzzleSlot != null) this.rotatePuzzleSlot(this._activePuzzleSlot); });
        bindBtn('psbReset', () => { if (this._activePuzzleSlot != null) this.resetPuzzleSlot(this._activePuzzleSlot); });
        bindBtn('psbClear', () => { if (this._activePuzzleSlot != null) this.clearSlotImage(this._activePuzzleSlot); });

        // 元素管理
        if ($('slActiveIconOpacity')) $('slActiveIconOpacity').addEventListener('input', () => {
            const v = parseInt($('slActiveIconOpacity').value, 10);
            this.updateLabel('lblActiveIconOpacity', v + '%');
            if ($('inpElOpacity')) $('inpElOpacity').value = v;
            this.applyToSelectedEls(el => { el.opacity = v; });
            this.batchElOps();
        });
        // ── 文字工具：新建 / 内容 / 字体 / 字号 / 颜色 ──
        // 「添加文字」只保留在右侧「文字」页签：点它进入添加模式，再双击画布落字。
        bindBtn('btnAddFreeText', () => this.addFreeText());
        {
            const tf = $('tfElText');
            const applyText = () => {
                const sel = this.selectedEls[0];
                if (!sel || sel.kind !== 'text') return;
                const v = tf.value;
                if (!String(v).trim()) return;   // 空内容不接受，等 change 时回显原值
                this.applyToSelectedEls((el, kind) => { if (kind === 'text') el.text = v; });
                this.refreshElList();
                this.scheduleRender();
            };
            if (tf) {
                tf.addEventListener('input', applyText);
                tf.addEventListener('change', () => {
                    const sel = this.selectedEls[0];
                    if (!sel || sel.kind !== 'text') return;
                    if (!String(tf.value).trim()) { this.syncTextRows(sel); return; }
                    applyText();
                    this.batchElOps();
                });
            }
        }
        if ($('cbElTextFont')) $('cbElTextFont').addEventListener('change', () => {
            const v = $('cbElTextFont').value;
            this.applyToSelectedEls((el, kind) => { if (kind === 'text') el.fontFamily = v; });
            this.batchElOps();
        });
        if ($('cbElTextWeight')) $('cbElTextWeight').addEventListener('change', () => {
            const v = Math.max(100, Math.min(900, parseInt($('cbElTextWeight').value, 10) || 400));
            this.applyToSelectedEls((el, kind) => { if (kind === 'text') el.fontWeight = v; });
            this.batchElOps();
        });
        if ($('cpElTextColor')) $('cpElTextColor').addEventListener('input', () => {
            const v = $('cpElTextColor').value;
            this.applyToSelectedEls((el, kind) => { if (kind === 'text') el.colorHex = v; });
            this.scheduleRender();
        });
        if ($('cpElTextColor')) $('cpElTextColor').addEventListener('change', () => this.batchElOps());
        {
            const applySize = (v) => {
                const n = Math.max(6, Math.min(600, Math.round(Number(v) || 0)));
                this.applyToSelectedEls((el, kind) => { if (kind === 'text') el.fontSize = n; });
                if ($('slElTextSize')) $('slElTextSize').value = Math.max(8, Math.min(400, n));
                if ($('inpElTextSize')) $('inpElTextSize').value = n;
                this.updateLabel('lblElTextSize', n + 'px');
                this.scheduleRender();
            };
            if ($('slElTextSize')) $('slElTextSize').addEventListener('input', () => applySize($('slElTextSize').value));
            if ($('inpElTextSize')) $('inpElTextSize').addEventListener('change', () => applySize($('inpElTextSize').value));
            ['slElTextSize', 'inpElTextSize'].forEach(id => {
                if ($(id)) $(id).addEventListener('change', () => this.saveCurrentTemplate());
            });
        }

        // 文字方向：只有选中文字时这两行才露出（见 app-elements.syncTextRows）
        if ($('cbElTextDir')) $('cbElTextDir').addEventListener('change', () => {
            const v = $('cbElTextDir').value;
            this.applyToSelectedEls((el, kind) => {
                if (kind !== 'text') return;
                // 'h' 是默认值，直接删字段，保持模板干净（预设文件里也不必写它）
                if (v === 'h') delete el.direction; else el.direction = v;
            });
            this.batchElOps();
        });
        if ($('slElTextSpacing')) $('slElTextSpacing').addEventListener('input', () => {
            const v = parseInt($('slElTextSpacing').value, 10) || 0;
            this.updateLabel('lblElTextSpacing', v + 'px');
            this.applyToSelectedEls((el, kind) => { if (kind === 'text') el.letterSpacing = v; });
            this.batchElOps();
        });

        // ── 描边 / 阴影（PS 里最常用的两种“字压不住底”的解法）──
        if ($('chkElTextStroke')) $('chkElTextStroke').addEventListener('change', () => {
            const on = $('chkElTextStroke').checked ? 1 : 0;
            this.applyToSelectedEls((el, kind) => {
                if (kind !== 'text') return;
                el.strokeEnable = on;
                if (on) {
                    if (!(Number(el.strokeWidth) > 0)) el.strokeWidth = Math.max(2, Math.round((Number(el.fontSize) || 18) * 0.08));
                    if (!el.strokeColorHex) el.strokeColorHex = '#000000';
                    if (el.strokeOpacity == null) el.strokeOpacity = 100;
                }
            });
            const sel = this.selectedEls[0];
            if (sel) this.syncTextRows(sel);
            this.batchElOps();
        });
        if ($('slElTextStrokeWidth')) $('slElTextStrokeWidth').addEventListener('input', () => {
            const v = Math.max(1, Math.min(40, parseInt($('slElTextStrokeWidth').value, 10) || 1));
            this.updateLabel('lblElTextStrokeWidth', v + 'px');
            this.applyToSelectedEls((el, kind) => {
                if (kind !== 'text') return;
                el.strokeEnable = 1;
                el.strokeWidth = v;
            });
            const chk = $('chkElTextStroke');
            if (chk) chk.checked = true;
            this.scheduleRender();
        });
        if ($('slElTextStrokeWidth')) $('slElTextStrokeWidth').addEventListener('change', () => {
            const sel = this.selectedEls[0];
            if (sel) this.syncTextRows(sel);
            this.batchElOps();
        });
        if ($('cpElTextStroke')) $('cpElTextStroke').addEventListener('input', () => {
            const v = $('cpElTextStroke').value;
            this.applyToSelectedEls((el, kind) => {
                if (kind !== 'text') return;
                el.strokeEnable = 1;
                el.strokeColorHex = v;
            });
            const chk = $('chkElTextStroke');
            if (chk) chk.checked = true;
            this.scheduleRender();
        });
        if ($('cpElTextStroke')) $('cpElTextStroke').addEventListener('change', () => this.batchElOps());

        if ($('chkElTextShadow')) $('chkElTextShadow').addEventListener('change', () => {
            const on = $('chkElTextShadow').checked ? 1 : 0;
            this.applyToSelectedEls((el, kind) => {
                if (kind !== 'text') return;
                el.enableShadow = on;
                if (on) {
                    // 老预设只有开关、没有参数：勾选时补齐一套能看见的默认阴影
                    if (el.shadowBlur == null) el.shadowBlur = Math.max(2, Math.round((Number(el.fontSize) || 18) * 0.18));
                    if (el.shadowOffsetX == null) el.shadowOffsetX = 0;
                    if (el.shadowOffsetY == null) el.shadowOffsetY = Math.max(1, Math.round((Number(el.fontSize) || 18) * 0.05));
                    if (!el.shadowColorHex) el.shadowColorHex = '#000000';
                    if (el.shadowOpacity == null) el.shadowOpacity = 45;
                }
            });
            const sel = this.selectedEls[0];
            if (sel) this.syncTextRows(sel);
            this.batchElOps();
        });
        if ($('slElTextShadowBlur')) $('slElTextShadowBlur').addEventListener('input', () => {
            const v = Math.max(0, Math.min(60, parseInt($('slElTextShadowBlur').value, 10) || 0));
            this.updateLabel('lblElTextShadowBlur', v + 'px');
            this.applyToSelectedEls((el, kind) => {
                if (kind !== 'text') return;
                el.enableShadow = 1;
                el.shadowBlur = v;
                if (el.shadowOffsetX == null) el.shadowOffsetX = 0;
                if (el.shadowOffsetY == null) el.shadowOffsetY = Math.max(1, Math.round((Number(el.fontSize) || 18) * 0.05));
            });
            const sel = this.selectedEls[0];
            if (sel && sel.kind === 'text') this.syncTextRows(sel);
            this.scheduleRender();
        });
        if ($('slElTextShadowBlur')) $('slElTextShadowBlur').addEventListener('change', () => {
            const sel = this.selectedEls[0];
            if (sel) this.syncTextRows(sel);
            this.batchElOps();
        });
        if ($('cpElTextShadow')) $('cpElTextShadow').addEventListener('input', () => {
            const v = $('cpElTextShadow').value;
            this.applyToSelectedEls((el, kind) => {
                if (kind !== 'text') return;
                el.enableShadow = 1;
                el.shadowColorHex = v;
                if (el.shadowBlur == null) el.shadowBlur = 8;
                if (el.shadowOffsetX == null) el.shadowOffsetX = 0;
                if (el.shadowOffsetY == null) el.shadowOffsetY = 2;
            });
            const sel = this.selectedEls[0];
            if (sel && sel.kind === 'text') this.syncTextRows(sel);
            this.scheduleRender();
        });
        if ($('cpElTextShadow')) $('cpElTextShadow').addEventListener('change', () => this.batchElOps());
        const bindShadowOffset = () => {
            const x = parseFloat(($('inpElTextShadowX') || {}).value);
            const y = parseFloat(($('inpElTextShadowY') || {}).value);
            this.applyToSelectedEls((el, kind) => {
                if (kind !== 'text') return;
                el.enableShadow = 1;
                el.shadowOffsetX = Number.isFinite(x) ? x : 0;
                el.shadowOffsetY = Number.isFinite(y) ? y : 0;
                if (el.shadowBlur == null) el.shadowBlur = 8;
            });
            const sel = this.selectedEls[0];
            if (sel && sel.kind === 'text') this.syncTextRows(sel);
            this.batchElOps();
        };
        if ($('inpElTextShadowX')) $('inpElTextShadowX').addEventListener('change', bindShadowOffset);
        if ($('inpElTextShadowY')) $('inpElTextShadowY').addEventListener('change', bindShadowOffset);
        if ($('slElementRotation')) $('slElementRotation').addEventListener('input', () => {
            const v = parseInt($('slElementRotation').value, 10);
            this.updateLabel('lblElementRotation', v + '°');
            if ($('inpElRotation')) $('inpElRotation').value = v;
            this.applyToSelectedEls(el => { el.rotation = v; });
            this.batchElOps();
        });
        if ($('slElementSize')) $('slElementSize').addEventListener('input', () => {
            // 平方映射:滑块 0~1000 → 尺寸 16~当前上限(L 为滑块长度,平方项在低端更精细)。
            // Logo 的上限随画布/纵横比变化，非 Logo 仍是原来的 10000。
            const pos = clampNum(parseInt($('slElementSize').value, 10) || 0, 0, 1000);
            const maxSize = this.selectedElementSizeMax();
            const k = pos / 1000;
            const v = Math.round(16 + (Math.max(16, maxSize) - 16) * k * k);
            this.updateLabel('lblElementSize', v);
            if ($('inpElSize')) $('inpElSize').value = v;
            this.applyToSelectedEls((el, kind) => {
                if (kind === 'logo') el.size = clampNum(v, 8, this.logoMaxSize(el));
                else if (kind === 'sticker') el.scale = clampNum(v / 60, 0.02, 3);
            });
            this.batchElOps();
        });
        // 精确数值输入(借鉴 Compositor):输入框 change → 复用滑块通路,不另起渲染分支
        const bindNum = (id, fn) => { const el = $(id); if (el) el.addEventListener('change', fn); };
        bindNum('inpElX', () => {
            const v = parseFloat($('inpElX').value);
            if (isNaN(v) || !this.selectedEls.length) { this.syncElInputs(); return; }
            this.setElementCenter(this.selectedEls[0], v, this._elCenterY(this.selectedEls[0]));
            this.syncElInputs(); this.batchElOps();
        });
        bindNum('inpElY', () => {
            const v = parseFloat($('inpElY').value);
            if (isNaN(v) || !this.selectedEls.length) { this.syncElInputs(); return; }
            this.setElementCenter(this.selectedEls[0], this._elCenterX(this.selectedEls[0]), v);
            this.syncElInputs(); this.batchElOps();
        });
        bindNum('inpElOpacity', () => {
            const v = parseFloat($('inpElOpacity').value);
            if (isNaN(v)) return;
            const sl = $('slActiveIconOpacity');
            if (sl) { sl.value = Math.max(0, Math.min(100, v)); sl.dispatchEvent(new Event('input')); }
        });
        bindNum('inpElSize', () => {
            const v = parseFloat($('inpElSize').value);
            if (isNaN(v)) return;
            const maxSize = this.selectedElementSizeMax();
            const c = Math.max(16, Math.min(Math.max(16, maxSize), v));
            const sl = $('slElementSize');
            if (sl) {
                const span = Math.max(1, maxSize - 16);
                sl.value = Math.round(1000 * Math.sqrt(clampNum((c - 16) / span, 0, 1)));
                sl.dispatchEvent(new Event('input'));
            }
        });
        bindNum('inpElRotation', () => {
            const v = parseFloat($('inpElRotation').value);
            if (isNaN(v)) return;
            const r = ((v % 360) + 360) % 360;
            const sl = $('slElementRotation');
            if (sl) { sl.value = r; sl.dispatchEvent(new Event('input')); }
        });

        // 拼图布局 / 风格
        this.buildPuzzleLayoutBtns();
        this.buildPuzzleStyleBtns();

        // 槽位下拉:切换前先把当前编辑的字幕写入旧槽位,再加载新槽位
        if ($('cbPuzzleGapPick')) $('cbPuzzleGapPick').addEventListener('change', () => this.onPuzzleSlotChange());

        // 每个页签滚轮加速 x4(防冒泡影响画布)
        this.dom.panels.forEach(p => {
            p.addEventListener('wheel', e => {
                if (e.target && e.target.classList && e.target.classList.contains('ctl-rng')) return;
                const d = e.deltaY;
                if (p.scrollHeight > p.clientHeight) { p.scrollTop += d * 3; e.preventDefault(); }
            }, { passive: false });
        });
    },

    /* ── 滑块行的精确输入 / 单行复位 ──
       滑块仍然负责"手感"(拖动、实时预览),这里的数字框只负责"精确值"。
       不复制提交逻辑:数字框把值写回 range 并派发 input,后续完全走原来的
       bindRanges → onSliderLive/onSliderCustom → onSettingChanged 通路,
       所以撤销栈、标签刷新、画布重绘不会出现第二套实现。 */
    enhanceRangeRows() {
        if (!this._rangeUi) this._rangeUi = {};
        document.querySelectorAll('.tab-panel .param-row').forEach(row => {
            const rng = row.querySelector('input[type=range]');
            const val = row.querySelector('.pval');
            if (!rng || !val || !rng.id) return;
            if (row.querySelector('.pval-num') || row.querySelector('input[type=number]')) return;
            const num = document.createElement('input');
            num.type = 'number';
            num.className = 'pval-num';
            num.min = rng.min;
            num.max = rng.max;
            num.step = rng.step || '1';
            num.title = '可直接输入精确值；双击复位';
            num.setAttribute('aria-label', (row.querySelector('label') ? row.querySelector('label').textContent : rng.id));
            const unit = document.createElement('span');
            unit.className = 'pval-unit';
            val.classList.add('pval-sr');
            row.insertBefore(num, val);
            row.insertBefore(unit, val);
            const id = rng.id;
            this._rangeUi[id] = { rng, num, unit, val };
            // Shift + 拖动 = 微调:原生 range 的灵敏度由控件宽度决定,一像素跨好几个档位,
            // 这里按住 Shift 时改为「相对起点、十分之一灵敏度」的拖动,仍写回同一个 range,
            // 因此 input 事件、撤销栈、标签刷新全部沿用原路径。
            rng.title = (rng.title ? rng.title + '；' : '') + '按住 Shift 拖动可微调；双击复位';
            rng.addEventListener('pointerdown', (e) => {
                if (!e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                const min = Number(rng.min) || 0;
                const max = Number(rng.max) || 100;
                const step = Number(rng.step) || 1;
                const rect = rng.getBoundingClientRect();
                const startX = e.clientX;
                const startVal = Number(rng.value) || 0;
                const perPx = ((max - min) / Math.max(60, rect.width)) * 0.1;
                const move = (ev) => {
                    let v = startVal + (ev.clientX - startX) * perPx;
                    v = Math.round(v / step) * step;
                    v = Math.max(min, Math.min(max, v));
                    if (String(rng.value) !== String(v)) {
                        rng.value = String(v);
                        rng.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                };
                const up = () => {
                    rng.classList.remove('fine-tuning');
                    rng.removeEventListener('pointermove', move);
                    rng.removeEventListener('pointerup', up);
                    rng.removeEventListener('pointercancel', up);
                };
                rng.classList.add('fine-tuning');
                try { rng.setPointerCapture(e.pointerId); } catch (_) { /* 浏览器不支持时退回普通拖动 */ }
                rng.focus({ preventScroll: true });
                rng.addEventListener('pointermove', move);
                rng.addEventListener('pointerup', up);
                rng.addEventListener('pointercancel', up);
            });
            // 一次输入的编辑状态。焦点只记录起点，不压撤销栈：只点进输入框又离开
            // 不应产生一条“什么都没改”的撤销记录。第一条真实输入才 beginGesture()。
            const edit = { dirty: false, gesturing: false, startVal: Number(rng.value) || 0 };
            this._rangeUi[id].edit = edit;
            const apply = (commit) => {
                const raw = String(num.value || '').trim();
                if (raw === '' || !isFinite(Number(raw))) {
                    // 清空/非法值在失焦或回车时恢复成滑块当前值；此时输入框可能仍是
                    // activeElement，必须 force，否则会留下一段空白或非法文本。
                    if (commit) this._syncRangeNumber(id, true);
                    return;
                }
                let v = Number(raw);
                const step = Number(rng.step) || 1;
                if (step >= 1) v = Math.round(v);
                v = Math.min(Number(rng.max), Math.max(Number(rng.min), v));
                if (String(rng.value) !== String(v)) {
                    rng.value = String(v);
                    rng.dispatchEvent(new Event('input', { bubbles: true }));
                }
                // range 会按 min/step 吸附(如 step=5 时输入 57 → 实际 55)。提交后必须
                // 回读控件真实值，否则数字框会显示 57 而标签/画布已经是 55。
                const actual = Number(rng.value);
                if (isFinite(actual)) v = actual;
                if (commit) num.value = String(v);
            };
            const finish = () => {
                apply(true);
                if (edit.gesturing) {
                    edit.gesturing = false;
                    this.endGesture();
                    this.commitNoPush();
                }
                edit.dirty = false;
                edit.startVal = Number(rng.value) || 0;
            };
            num.addEventListener('focus', () => {
                edit.dirty = false;
                edit.startVal = Number(rng.value) || 0;
            });
            num.addEventListener('input', () => {
                if (String(num.value || '').trim() === '') return;
                if (!edit.dirty) {
                    edit.dirty = true;
                    edit.startVal = Number(rng.value) || 0;
                    if (!this._gesture && this.template && this.image) {
                        this.beginGesture();
                        edit.gesturing = !!this._gesture;
                    }
                }
                apply(false);
            });
            num.addEventListener('change', finish);
            num.addEventListener('blur', finish);
            num.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); finish(); num.blur(); }
                else if (e.key === 'Escape') {
                    e.preventDefault();
                    if (edit.dirty) {
                        // 取消本次输入：先回写起点并走原 input 通路撤销实时预览，再丢弃
                        // 第一条输入压入的手势快照，避免留下一条点击后毫无变化的撤销记录。
                        const start = edit.startVal;
                        if (isFinite(start) && String(rng.value) !== String(start)) {
                            rng.value = String(start);
                            rng.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        this._syncRangeNumber(id, true);
                        if (edit.gesturing) {
                            edit.gesturing = false;
                            this.cancelGesture();
                        }
                        edit.dirty = false;
                        this.setStatus('已取消输入');
                    } else {
                        this._syncRangeNumber(id, true);
                    }
                    num.blur();
                }
            });
            num.addEventListener('dblclick', (e) => { e.preventDefault(); this._resetRangeRow(rng); });
            // 双击滑轨本身也复位:数字框很窄,而"拖过头了想回默认"最直接的动作就是双击滑轨。
            // 与双击参数名/数字框共用 _resetRangeRow,撤销栈与状态提示都是同一套。
            rng.addEventListener('dblclick', (e) => { e.preventDefault(); this._resetRangeRow(rng); });
            const label = row.querySelector('label');
            if (label) {
                label.title = '双击复位到默认值';
                label.addEventListener('dblclick', () => this._resetRangeRow(rng));
            }
            this._syncRangeNumber(id);
        });
        // refreshUI 通常在 setupPanelInteractions 之后才跑:再对一次,避免初始标签为空时数字框藏起来。
        requestAnimationFrame(() => Object.keys(this._rangeUi).forEach(id => this._syncRangeNumber(id)));
    },

    // 标签是唯一数据源;数字框只在标签是纯数值(允许带单位)时出现。
    // 「自适应」这类文字没有数值可输,退回原来的标签展示。
    _syncRangeNumber(id, force) {
        const ui = this._rangeUi && this._rangeUi[id];
        if (!ui) return;
        const text = String(ui.val.textContent || '');
        const m = text.match(/-?\d+(?:\.\d+)?/);
        const hidden = !m || /自适应|自动/.test(text);
        ui.num.hidden = hidden;
        ui.unit.hidden = hidden;
        ui.val.classList.toggle('pval-sr', !hidden);
        if (hidden) return;
        const unitText = text.replace(m[0], '')
            // 正数标签是「+18」：数字框只认「18」，剩下的「+」不能当成单位塞到右边，
            // 否则每一档正数后面都会多出一个孤零零的加号。
            .replace(/^[+\-−]\s*/, '')
            .trim();
        if (ui.unit.textContent !== unitText) ui.unit.textContent = unitText;
        if ((force || document.activeElement !== ui.num) && ui.num.value !== m[0]) ui.num.value = m[0];
    },

    _resetRangeRow(rng) {
        if (!rng || !this.template || !this.image) return;
        const id = rng.id;
        // 默认档优先取 defaultTemplate():参数字号的中性值是 33,不是 HTML 上的 100。
        let def = rng.dataset.reset != null ? Number(rng.dataset.reset) : Number(rng.defaultValue);
        if (id === 'slParamFontSize') def = Number(this.defaultTemplate().paramFontSize) || 33;
        if (!isFinite(def)) return;
        const ui = this._rangeUi && this._rangeUi[id];
        const edit = ui && ui.edit;
        const label = rng.closest('.param-row') && rng.closest('.param-row').querySelector('label');
        if (Number(rng.value) === def) {
            // 已经在默认档：只把聚焦中的数字框同步回来，不再压一条无变化的撤销记录。
            this._syncRangeNumber(id, true);
            if (edit) {
                if (edit.gesturing) {
                    edit.gesturing = false;
                    this.cancelGesture();
                }
                edit.dirty = false;
                edit.startVal = def;
            }
            this.setStatus('「' + (label ? label.textContent.trim() : id) + '」已是默认值');
            return;
        }
        // 双击数字框时如果刚输入过，先把这次输入作为独立一步提交；复位再单独压栈，
        // 这样撤销复位能回到刚才输入的值，而不是一路退回输入前。
        if (edit && edit.gesturing) {
            edit.gesturing = false;
            edit.dirty = false;
            this.endGesture();
            this.commitNoPush();
        }
        this.beginGesture();
        rng.value = String(def);
        rng.dispatchEvent(new Event('input', { bubbles: true }));
        // 双击数字框时它仍是 activeElement，普通同步会跳过；复位必须强制回写。
        this._syncRangeNumber(id, true);
        if (edit) {
            edit.dirty = false;
            edit.gesturing = false;
            edit.startVal = def;
        }
        this.endGesture();
        this.commitNoPush();
        this.setStatus('已复位「' + (label ? label.textContent.trim() : id) + '」');
    },

    onSliderCustom(id, v) {
        switch (id) {
            case 'slGlobalMargin': this.applyGlobalMargin(v / 100, false); this.onSettingChanged(); break;
            case 'slImgScale': this.updateLabel('lblImgScale', v + '%'); this.onSettingChanged(); break;
            case 'slCornerTL': case 'slCornerTR': case 'slCornerBL': case 'slCornerBR': {
                const cc = this.template.cornerConfig || {};
                const key = 'slCornerTL' === id ? 'cornerRadiusTL' : 'slCornerTR' === id ? 'cornerRadiusTR' : 'slCornerBL' === id ? 'cornerRadiusBL' : 'cornerRadiusBR';
                cc[key] = v;
                this.updateLabel('lbl' + id.slice(2), v);
                if ((this.template.cornerConfig.cornerLock || 0) === 1) {
                    cc.cornerRadiusTL = v; cc.cornerRadiusTR = v; cc.cornerRadiusBL = v; cc.cornerRadiusBR = v;
                    ['slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                }
                cc.cornerRadiusAll = v;
                if (this.$('slCornerRadius')) this.$('slCornerRadius').value = v;
                this.updateLabel('lblCornerRadius', v);
                this.onSettingChanged();
                break;
            }
            case 'slCornerRadius': {
                const cc = this.template.cornerConfig || {};
                cc.cornerRadiusAll = v;
                cc.cornerRadiusTL = v; cc.cornerRadiusTR = v; cc.cornerRadiusBL = v; cc.cornerRadiusBR = v;
                ['slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                this.updateLabel('lblCornerRadius', v);
                if (this.$('lblCornerTL')) this.$('lblCornerTL').textContent = v;
                if (this.$('lblCornerTR')) this.$('lblCornerTR').textContent = v;
                if (this.$('lblCornerBL')) this.$('lblCornerBL').textContent = v;
                if (this.$('lblCornerBR')) this.$('lblCornerBR').textContent = v;
                this.onSettingChanged();
                break;
            }
            case 'slParamFontSize': {
                this.template.paramFontSize = v;
                this.updateParamFontLabel();
                this.onSettingChanged();
                break;
            }
            case 'slBrandSize': {
                this.template.brandSize = v / 100;
                this.updateLabel('lblBrandSize', v + '%');
                this.onSettingChanged();
                break;
            }
            case 'slParamScale': {
                this.template.paramScale = v / 100;
                this.updateLabel('lblParamScale', v + '%');
                this.onSettingChanged();
                break;
            }
            case 'slGlassSize': {
                this.template.liquidGlassSize = v / 100;
                this.updateLabel('lblGlassSize', v + '%');
                this.onSettingChanged();
                break;
            }
            case 'slAppleModelSize': case 'slAppleParamSize':
            case 'slAppleDateSize': case 'slAppleLogoSize': case 'slAppleLogoOpacity': case 'slAppleLineWidth': {
                const ac = this.template.appleCard || (this.template.appleCard = {});
                if (id === 'slAppleModelSize') ac.modelScale = v / 100;
                else if (id === 'slAppleParamSize') ac.paramScale = v / 100;
                else if (id === 'slAppleDateSize') ac.dateScale = v / 100;
                else if (id === 'slAppleLogoSize') ac.logoScale = v / 100;
                else if (id === 'slAppleLogoOpacity') ac.logoOpacity = v;
                else ac.lineScale = v / 100;
                this.updateLabel('lbl' + id.slice(2), v + '%');
                this.onSettingChanged();
                break;
            }
            case 'slXmBrandSize': case 'slXmLineSize': case 'slXmLogoSize':
            case 'slXmLogoOpacity': case 'slXmPad': case 'slXmScrim': {
                const xc = this.template.xmLeica || (this.template.xmLeica = {});
                if (id === 'slXmBrandSize') xc.brandScale = v / 100;
                else if (id === 'slXmLineSize') xc.lineScale = v / 100;
                else if (id === 'slXmLogoSize') xc.logoScale = v / 100;
                else if (id === 'slXmLogoOpacity') xc.logoOpacity = v;
                else if (id === 'slXmPad') xc.padScale = v / 100;
                else xc.scrim = v;
                this.updateLabel('lbl' + id.slice(2), v + '%');
                this.onSettingChanged();
                break;
            }
            case 'slLayerCornerTL': case 'slLayerCornerTR': case 'slLayerCornerBL': case 'slLayerCornerBR': {
                const layer = this.currentLayer ? this.currentLayer() : null;
                if (!layer) break;
                const lcc = layer.cornerConfig || (layer.cornerConfig = {});
                const key = 'slLayerCornerTL' === id ? 'cornerRadiusTL' : 'slLayerCornerTR' === id ? 'cornerRadiusTR' : 'slLayerCornerBL' === id ? 'cornerRadiusBL' : 'cornerRadiusBR';
                lcc[key] = v;
                const lbl = 'lbl' + id.slice(2);
                this.updateLabel(lbl, v);
                this.updateLabel('lblLayerCornerRadius', v);
                if ((lcc.cornerLock || 0) === 1) {
                    lcc.cornerRadiusTL = v; lcc.cornerRadiusTR = v; lcc.cornerRadiusBL = v; lcc.cornerRadiusBR = v;
                    ['slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                }
                lcc.cornerRadiusAll = v;
                if (this.$('slLayerCornerRadius')) this.$('slLayerCornerRadius').value = v;
                this.updateLabel('lblLayerCornerRadius', v);
                this.onSettingChanged();
                break;
            }
            case 'slLayerCornerRadius': {
                const layer = this.currentLayer ? this.currentLayer() : null;
                if (!layer) break;
                const lcc = layer.cornerConfig || (layer.cornerConfig = {});
                lcc.cornerRadiusAll = v;
                lcc.cornerRadiusTL = v; lcc.cornerRadiusTR = v; lcc.cornerRadiusBL = v; lcc.cornerRadiusBR = v;
                ['slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                this.updateLabel('lblLayerCornerRadius', v);
                this.updateLabel('lblLayerCornerTL', v); this.updateLabel('lblLayerCornerTR', v);
                this.updateLabel('lblLayerCornerBL', v); this.updateLabel('lblLayerCornerBR', v);
                this.updateLabel('lblLayerCornerRadius', v);
                this.onSettingChanged();
                break;
            }
            default: break;
        }
    },

    onSelectCustom() {
        this.onSettingCommit();
    },

    onTextCustom() {
        this.onSettingChanged();
    },

    bindRanges(ids) {
        const $ = this.$;
        ids.forEach(id => {
            const el = $(id);
            if (!el) return;
            let v = parseInt(el.value, 10);
            el.addEventListener('pointerdown', () => this.beginGesture());
            el.addEventListener('input', () => {
                v = parseInt(el.value, 10);
                this.sliderLiveLabel(id, v);
                this.onSliderLive(id, v);
            });
            el.addEventListener('pointerup', () => {
                this.endGesture();
                this.commitNoPush();
            });
        });
    },

    sliderLiveLabel(id, v) {
        const map = {
            slFillOpacity: ['lblFillOpacity', v + '%'], slGradientAngle: ['lblGradientAngle', v], slTextureScale: ['lblTextureScale', v + '%'],
            slStrokeWidth: ['lblStrokeWidth', v], slStrokeOpacity: ['lblStrokeOpacity', v + '%'],
            slShadowBlur: ['lblShadowBlur', v], slShadowOpacity: ['lblShadowOpacity', v + '%'],
            slGlowBlur: ['lblGlowBlur', v], slGlowOpacity: ['lblGlowOpacity', v + '%'],

            // 「效果」段用纯数字：晕影拖动时负值自带 -，颗粒同样不挂 %
            slVignetteStrength: ['lblVignetteStrength', v], slVignetteFeather: ['lblVignetteFeather', v],
            slBrandSize: ['lblBrandSize', v + '%'], slParamScale: ['lblParamScale', v + '%'],
            slGlassSize: ['lblGlassSize', v + '%'],
            slAppleModelSize: ['lblAppleModelSize', v + '%'],
            slAppleParamSize: ['lblAppleParamSize', v + '%'], slAppleDateSize: ['lblAppleDateSize', v + '%'],
            slAppleLogoSize: ['lblAppleLogoSize', v + '%'], slAppleLogoOpacity: ['lblAppleLogoOpacity', v + '%'],
            slAppleLineWidth: ['lblAppleLineWidth', v + '%'],
            slLeakOpacity: ['lblLeakOpacity', v + '%'], slLeakAngle: ['lblLeakAngle', v + '°'],
            slFilmGrain: ['lblFilmGrain', v],
            slPuzzleGap: ['lblPuzzleGap', v], slPuzzleCorner: ['lblPuzzleCorner', v + '%'], slCapSize1: ['lblCapSize1', v], slCapSize2: ['lblCapSize2', v],
            slCapSpacing: ['lblCapSpacing', v + '%'], slSlotOffsetX: ['lblSlotOffsetX', v], slSlotOffsetY: ['lblSlotOffsetY', v],
            slSlotZoom: ['lblSlotZoom', v + '%'],
        };
        const entry = map[id];
        if (entry) this.updateLabel(entry[0], entry[1]);
    },

    onSliderLive(id) {
        if (['slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius', 'slParamFontSize', 'slBrandSize', 'slParamScale', 'slGlassSize',
            'slAppleModelSize', 'slAppleParamSize', 'slAppleDateSize', 'slAppleLogoSize', 'slAppleLogoOpacity', 'slAppleLineWidth',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius'].includes(id)) return; // 由 onSliderCustom 处理
        if (id === 'slPuzzleGap' || id === 'slPuzzleCorner' || id === 'slCapSize1' || id === 'slCapSize2' || id === 'slCapSpacing' || id === 'slSlotOffsetX' || id === 'slSlotOffsetY' || id === 'slSlotZoom') {
            this.syncPuzzleFromUI(); this.onSettingChanged(); return;
        }
        this.onSettingChanged();
    },

    /* ══ 纹理 ══ */
    async pickBuiltinTexture() {
        const builtin = ['denim', 'frost', 'grain', 'kraft', 'leather', 'linen', 'metal', 'paper', 'watercolor', 'wood'];
        const opts = builtin.map(n => `${n} 内置`).join('\n');
        const choice = await this.promptText('选择内置纹理:\n' + opts + '\n(输入名称,留空取消)', 'denim');
        if (!choice) return;
        const name = choice.trim().split(' ')[0];
        this.setLayerTexture(name);
    },

    async pickTexture() {
        if (!this.textures.length) { this.setStatus('纹理库未加载'); return; }
        const opts = this.textures.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
        const choice = await this.promptText('选择纹理(输入序号或名称,留空取消):\n' + opts, '1');
        if (!choice) return;
        const idx = parseInt(choice, 10) - 1;
        const t = this.textures[idx];
        if (!t) { this.setStatus('未找到该纹理'); return; }
        this.setLayerTexture(t.name);
    },

    setLayerTexture(name) {
        this.onSettingCommit();
        const layer = this.currentLayer();
        layer.fillConfig.fillType = 'texture';
        layer.fillConfig.textureSrc = name;
        if (this.$('cbFillType')) this.$('cbFillType').value = 'texture';
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus(`已应用纹理 ${name}`);
    },

    _brandRank(n) {
        const ranking = {"APPLE":100,"SAMSUNG":95,"XIAOMI":90,"VIVO":80,"OPPO":78,"HONOR":72,"HUAWEI":70,"GOOGLE":65,"ONEPLUS":62,"REALME":58,"MOTOROLA":55,"LENOVO":50,"ASUS":48,"NOTHING":45,"NUBIA":42,"REDMI":88,"REDMAGIC":38,"IQOO":52,"TECNO":38,"INFINIX":35,"ITEL":33,"DOOGEE":25,"ULEFONE":22,"BLACKSHARK":30,"VERTU":20,"NOKIA":48,"LG":45,"HTC":40,"MEIZU":35,"CANON":98,"SONY":92,"FUJIFILM":85,"NIKON":80,"PANASONIC":60,"RICOH":45,"OLYMPUS":42,"PENTAX":38,"SIGMA":40,"LEICA":55,"HASSELBLAD":48,"POLAROID":50,"GOPRO":52,"DJI":58,"INSTA360":50,"RED":35,"CONTAX":25,"ALPA":15,"LINHOF":12,"MAMIYA":18,"ROLLEI":20,"PHASEONE":25,"HORSEMAN":10,"TOYO":8,"VOIGTLÄNDER":15,"SEAGULL":20,"TAMRON":30,"AGFA":18,"KODAK":45,"LUMIX":40,"LOMO":30,"BLACKMAGIC":42,"ZEISS":50,"CASIO":25,"CAT":5,"SONYALPHA":52,"OSMO":56};
        // 变体名(如 Apple_Black / Meizu-White / SONY_White)去掉后缀后按品牌热度排名
        const base = (n||'').replace(/\.png$/i,'').replace(/_(WHITE|BLACK|COLOR)$/i,'').replace(/-(WHITE|BLACK)$/i,'').toUpperCase();
        return ranking[base] ?? 5;
    },
    /* ══ Logo 页签 ══ */
    renderLogoPools() {
        const $ = this.$;
        // 三个池子:内置标记(随包自绘,开箱即有)/ 品牌 Logo(用户导入)/ 自定义图标
        const pools = ['markIconBox', 'brandIconBox', 'customIconBox'];
        const cats = { markIconBox: [], brandIconBox: [], customIconBox: [] };
        cats.markIconBox = this.marks || [];
        this.logos.forEach(l => {
            // 自定义图标归到自定义图标池
            if (l.custom) { cats.customIconBox.push(l); return; }
            // 其余品牌logo归到品牌Logo池,按市场热度排序
            cats.brandIconBox.push(l);
        });
        cats.brandIconBox.sort((a,b) => this._brandRank(b.name) - this._brandRank(a.name));
        // 图标池内容没变、DOM 也还在 → 直接返回。
        // 本方法每次切到「Logo」页签都会被调(app-view.js:51),而重建要造上百个 div + img,
        // 给 img 赋 src 还会触发一次解码。三个池子的来源只在启动加载与导入/删除/重命名时才变,
        // 那几处都会改到签名(数量/名称/体积),所以这里跳过不会漏更新。
        const sigOf = (arr) => arr.length + '|' + arr.map(l => (l.name || '') + ':' + (l.dataUrl ? l.dataUrl.length : 0)).join('\u0000');
        const poolSig = sigOf(cats.markIconBox) + '#' + sigOf(this.logos);
        const markBox = $('markIconBox'), brandBox = $('brandIconBox'), customBox = $('customIconBox');
        const poolDomIntact = markBox && brandBox && customBox
            && markBox.children.length === cats.markIconBox.length
            && brandBox.children.length === cats.brandIconBox.length
            && customBox.children.length === cats.customIconBox.length;
        if (this._logoPoolSig === poolSig && poolDomIntact) return;
        this._logoPoolSig = poolSig;
        // 发行版不再内置品牌 Logo 包,新用户进这个页签会看到"整组被隐藏、只剩一个按钮"。
        // 空池时给出引导,说明可以自己导入、以及文件名按品牌命名可自动匹配。
        const hint = $('logoPoolHint');
        if (hint) hint.style.display = this.logos.length ? 'none' : '';
        pools.forEach((boxId) => {
            const box = $(boxId);
            if (!box) return;
            box.innerHTML = '';
            const list = cats[boxId];
            if (!list.length) {
                // 内置标记是随包分发的:它空了就说明打包漏了 / 主进程是旧的 / 目录读不到 ——
                // 不能像另外两个池子那样整组藏起来,否则界面看起来和"根本没有这个功能"一模一样,
                // 排查时完全看不出是哪一层的问题(这次就踩了)。给一格明确的"缺失"。
                if (boxId === 'markIconBox') {
                    const title = box.previousElementSibling;
                    if (title) title.style.display = '';
                    box.style.display = '';
                    const cell = document.createElement('div');
                    cell.className = 'icon-cell empty';
                    cell.textContent = '内置标记缺失';
                    cell.title = 'shared/marks 读不到。若刚改过 src/main 或 preload,请完全退出应用后重启。';
                    box.appendChild(cell);
                    // 把原因写到标题后面:截图/一眼就能看出是"preload 未提供"、"调用失败"
                    // 还是"主进程返回空" —— 这三种要修的地方完全不同。
                    const cntEl = this.$('markCnt');
                    if (cntEl) cntEl.textContent = this._marksDiag ? '(' + this._marksDiag + ')' : '';
                    return;
                }
                // 空池隐藏整个组
                const title = box.previousElementSibling;
                if (title) title.style.display = 'none';
                box.style.display = 'none';
                return;
            }
            // 有数据则显示
            const title = box.previousElementSibling;
            if (title) title.style.display = '';
            box.style.display = '';
            list.forEach(l => {
                const c = document.createElement('div');
                c.className = 'icon-cell';
                c.title = l.custom ? (l.name + '(点×删除)') : l.name;
                const img = document.createElement('img');
                // 关键:图标本身是 <img>,浏览器默认可拖拽。若不关掉,按下拖动时浏览器会发起
                // 原生图片拖放,从而吞掉我们挂在 window 上的 mousemove/mouseup —— 自研拖拽的
                // onUp 拿不到「已拖动」状态,addLogoElement 永不触发,表现为「拖了但画布上没出现」。
                // 该现象只在部分浏览器/拖拽时机下发生,所以是间歇性的。
                img.draggable = false;
                img.addEventListener('dragstart', (e) => e.preventDefault());
                img.src = l.dataUrl;
                c.appendChild(img);
                // 池子图标:拖拽放置。单击(未拖动)不添加,避免误触;拖到画布松手才放到该位置。
                c.addEventListener('mousedown', (ev) => {
                    if (ev.button !== 0) return;
                    ev.preventDefault();
                    const sx = ev.screenX, sy = ev.screenY;
                    let dragging = false;
                    const ghost = document.createElement('img');
                    ghost.src = l.dataUrl;
                    ghost.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;opacity:0.85;width:56px;height:56px;object-fit:contain;left:0;top:0;';
                    const onMove = (me) => {
                        if (!dragging && Math.abs(me.screenX - sx) + Math.abs(me.screenY - sy) > 5) {
                            dragging = true;
                            document.body.appendChild(ghost);
                        }
                        if (dragging) { ghost.style.left = (me.clientX - 28) + 'px'; ghost.style.top = (me.clientY - 28) + 'px'; }
                    };
                    const onUp = (ue) => {
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                        if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
                        if (!dragging) return; // 单击不添加
                        const canvas = this.dom.canvas;
                        if (!canvas || !canvas.width) { this.setStatus('画布不可用,已取消放置'); return; }
                        const rect = canvas.getBoundingClientRect();
                        const inCanvas = ue.clientX >= rect.left && ue.clientX <= rect.right && ue.clientY >= rect.top && ue.clientY <= rect.bottom;
                        if (!inCanvas) { this.setStatus('已取消放置(拖到画布外)'); return; }
                        const pt = this.screenToCanvas(ue);
                        this.addLogoElement(l, pt.x, pt.y).catch(() => {});
                        this.setStatus('已放置「' + l.name + '」');
                    };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                });
                // 自定义图标右上角加×删除按钮
                // 自定义图标双击可重命名
                if (l.custom) {
                    c.addEventListener('dblclick', async (ev) => {
                        ev.stopPropagation();
                        const nn = await this.promptText('重命名自定义图标', l.name);
                        if (!nn || !nn.trim() || nn.trim() === l.name) return;
                        l.name = nn.trim();
                        try {
                            let saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
                            saved.forEach(s => { if (s.dataUrl === l.dataUrl) s.name = l.name; });
                            localStorage.setItem('qfs_custom_icons', JSON.stringify(saved));
                        } catch(e) {}
                        // 初始库条目同步改名,否则重启还原。写盘失败必须说出来 ——
                        // 界面上已经叫新名字了,不报的话重启就悄悄变回去。
                        let renameOk = true;
                        try {
                            if (window.qingframe && typeof window.qingframe.renameCustomIcon === 'function') {
                                const rr = await window.qingframe.renameCustomIcon(l.dataUrl, l.name) || {};
                                renameOk = rr.ok !== false;
                            }
                        } catch(e) { renameOk = false; }
                        this.renderLogoPools();
                        this.setStatus(renameOk ? '已重命名' : '已改名,但未能写盘(重启后会还原)');
                    });
                }
                if (l.custom) {
                    const del = document.createElement('span');
                    del.textContent = '×';
                    del.style.cssText = 'position:absolute;top:2px;right:4px;font-size:14px;line-height:1;color:#ea6668;cursor:pointer;font-weight:bold;';
                    del.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (confirm('删除自定义图标「' + l.name + '」?')) {
                            const r = await this.deleteCustomIcon(l);
                            // 写盘失败时不要把它从列表里抹掉 —— 那样等于骗用户,
                            // 重启后图标原样回来,看起来就是"删不掉"。
                            if (r && r.ok === false) {
                                this.setStatus('删除失败(未能写盘):' + (r.error || '未知原因'));
                                return;
                            }
                            this.logos = this.logos.filter(x => x !== l);
                            this.renderLogoPools();
                            this.setStatus('已删除');
                        }
                    });
                    c.style.position = 'relative';
                    c.appendChild(del);
                }
                box.appendChild(c);
            });
            const cnt = this.$({ markIconBox: 'markCnt', brandIconBox: 'brandCnt', customIconBox: 'customIconCnt' }[boxId]);
            if (cnt) cnt.textContent = `(${list.length})`;
        });
    },

    // 关于页/新手引导的数量统一从运行时数据生成,避免写死数字后腐烂。
    updateStatsText() {
        const presetCount = Array.isArray(this.presets) ? this.presets.length : 0;
        const caps = window.StyleCaps;
        const styleCount = (caps && caps.MEASURED) ? Object.keys(caps.MEASURED).length : 0;
        if (!presetCount || !styleCount) return;
        const text = presetCount + ' 款边框、' + styleCount + ' 种风格';
        const about = this.$('aboutStatsText');
        if (about) about.textContent = text;
        const intro = this.$('introStatsText');
        if (intro) intro.textContent = text;
    },

    // 填充「关于」区(现已并入设置弹窗最底部):版本 / 系统 / 数据目录,并复位诊断与更新状态。
    // 只填数据、不弹窗 —— 打开设置时由 openSettings 调用。
    async refreshAboutInfo() {
        const api = window.qingframe;
        let info = {};
        try { if (api && api.getAppInfo) info = (await api.getAppInfo()) || {}; } catch (e) {}
        this._aboutInfo = info;
        const platform = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[info.platform] || info.platform || '未知系统';
        const arch = { x64: 'x64', arm64: 'ARM64', ia32: 'x86' }[info.arch] || info.arch || '';
        const packageType = !info.packaged ? '开发模式' : (info.portable ? '便携版' : '安装版');
        const osRelease = info.osRelease || '';
        const setText = (id, text) => { const n = this.$(id); if (n) n.textContent = text; };
        setText('aboutInfo', ['版本 ' + (info.version || '?'), platform + (arch ? ' ' + arch : ''), packageType].join(' · '));
        setText('aboutRuntimeVersion', 'v' + (info.version || '?'));
        setText('aboutPackageType', packageType);
        setText('aboutRuntimeElectron', 'Electron ' + (info.electron || '?') + ' · Chrome ' + (info.chrome || '?') + ' · Node ' + (info.node || '?'));
        setText('aboutRuntimePlatform', platform + (arch ? ' ' + arch : '') + (osRelease ? ' · ' + osRelease : ''));
        setText('aboutDataDir', info.userData || '-');
        this.updateStatsText();
        this._setAboutDiagStatus('');
        this.syncAboutUpdateState();
        // 版本号是异步拿到的:拿到后才能判断「更新内容」该不该亮未读红点
        this.syncChangelogDot();
    },
    // 从更新横幅「下载慢？」直接跳到下载源设置:打开设置弹窗并把光标放进输入框,
    // 省得用户自己去设置里找(输入框在设置「更新」区)。
    async openAboutMirror() {
        await this.openSettings({ tab: 'update', focus: 'tfUpdateMirror', select: true, revealMirror: true });
    },
    // 把 Tab 焦点限制在弹窗内;关闭后由 closeSettings 把焦点还给触发按钮。
    trapFocus(container, e) {
        const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
        const items = Array.from(container.querySelectorAll(selector)).filter(el => {
            if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            return el.getClientRects().length > 0;
        });
        if (!items.length) {
            e.preventDefault();
            const card = container.querySelector('.about-card, .settings-card');
            if (card) card.focus();
            return;
        }
        const first = items[0], last = items[items.length - 1];
        if (!container.contains(document.activeElement)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
            return;
        }
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },
    async openExternal(url) {
        const api = window.qingframe;
        if (!api || !api.openExternal) { this.setStatus('当前无法打开链接'); return { ok: false, message: '当前无法打开链接' }; }
        const r = await api.openExternal(url).catch((e) => ({ ok: false, message: (e && e.message) || '打开链接失败' }));
        if (!r || !r.ok) this.setStatus('打开链接失败：' + ((r && r.message) || '未知原因'));
        return r || { ok: false, message: '打开链接失败' };
    },

    /* ══ 设置（常规 / 更新 / 关于） ══ */
    // 设置页签：记住上次停留位置；从「下载慢？」进来时强制切到更新页。
    settingsTab() {
        const valid = ['general', 'update', 'about'];
        let t = '';
        try { t = localStorage.getItem('qfs_settings_tab') || ''; } catch (_) { /* 忽略 */ }
        return valid.indexOf(t) >= 0 ? t : 'general';
    },

    switchSettingsTab(name, opts) {
        const tab = ['general', 'update', 'about'].indexOf(name) >= 0 ? name : 'general';
        const root = this.$('settingsModal');
        if (!root) return tab;
        root.querySelectorAll('.settings-tab').forEach((b) => {
            const on = b.dataset.settingsTab === tab;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        root.querySelectorAll('[data-settings-panel]').forEach((p) => {
            const on = p.dataset.settingsPanel === tab;
            p.classList.toggle('active', on);
            p.hidden = !on;
        });
        if (!opts || opts.persist !== false) {
            try { localStorage.setItem('qfs_settings_tab', tab); } catch (_) { /* 忽略 */ }
        }
        if (!opts || opts.resetScroll !== false) {
            const body = root.querySelector('.settings-body');
            if (body) body.scrollTop = 0;
        }
        return tab;
    },

    // 恢复默认设置：只动偏好，不碰照片、模板和用户保存的预设。
    async resetAllSettings() {
        const ask = (typeof window.confirm === 'function')
            ? window.confirm('恢复默认设置？\n\n界面缩放、主题、预览画质、参数栏密度、自动检查更新和默认导出位置都会回到初始值。照片、模板与已保存预设不受影响。')
            : true;
        if (!ask) return false;
        this.applyFontScale(1);
        this._saveFontScale();
        this.applyTheme('dark');
        this.applyPreviewQuality(false);
        if (window.QfsPanelDensity) window.QfsPanelDensity.setPrefs({ panelDensity: 'auto' });
        const api = window.qingframe;
        if (api && api.savePrefs) {
            api.savePrefs({ theme: 'dark', previewQuality: 'standard', panelDensity: 'auto', autoCheck: 'startup' }).catch(() => {});
        }
        const ac = this.$('selAutoCheck');
        if (ac) ac.value = 'startup';
        await this.clearDefaultExportDir();
        this.switchSettingsTab('general');
        this.setStatus('已恢复默认设置');
        return true;
    },

    async openSettings(opts) {
        this._settingsReturnFocus = document.activeElement;
        const tab = (opts && opts.tab) || this.settingsTab();
        this.switchSettingsTab(tab, { persist: false, resetScroll: false });
        await this.refreshSettingsExportDir();
        // 关于区已并入设置,打开设置时顺带把版本/系统信息填上
        await this.refreshAboutInfo();
        await this.syncUpdateMirrorField();
        // 「下载慢？」进来时强制定位到自定义输入框；放在读 prefs 之后，避免被空值重新收起。
        if (opts && opts.revealMirror) {
            const sel = this.$('selUpdateMirror');
            if (sel) sel.value = '__custom__';
            if (this._syncMirrorCustomVisible) this._syncMirrorCustomVisible();
        }
        const m = this.$('settingsModal');
        if (m) m.style.display = 'flex';
        const focusId = (opts && opts.focus) || 'settingsClose';
        setTimeout(() => {
            const el = this.$(focusId);
            if (!el) return;
            if (opts && opts.focus) { try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ } }
            el.focus({ preventScroll: !!(opts && opts.focus) });
            if (opts && opts.select && el.select) el.select();
        }, 0);
    },

    closeSettings() {
        // 「更新内容」是叠在设置之上的一层:关设置时一并收掉,不然会留一层点不动的遮罩
        const cl = this.$('changelogModal');
        if (cl && cl.style.display !== 'none') { cl.style.display = 'none'; return; }
        const m = this.$('settingsModal');
        if (m) m.style.display = 'none';
        const back = this._settingsReturnFocus;
        this._settingsReturnFocus = null;
        // 返回焦点可能是一个已被隐藏的按钮(如从横幅入口进来),它不可见就不能还回去
        const visible = !!(back && back !== document.body && document.contains(back) && back.getClientRects().length);
        const target = visible ? back : this.$('btnSettings');
        if (target && typeof target.focus === 'function') setTimeout(() => target.focus({ preventScroll: true }), 0);
    },

    // 回显「默认导出位置」。不缓存：刚选完目录/刚清空都要立刻反映到面板上。
    async refreshSettingsExportDir() {
        const api = window.qingframe;
        let dir = '';
        try {
            const p = (api && api.getPrefs) ? await api.getPrefs() : null;
            dir = (p && typeof p.defaultExportDir === 'string') ? p.defaultExportDir : '';
        } catch (_) { dir = ''; }
        this._defaultExportDir = dir;
        const pathEl = this.$('setExportDirPath');
        if (pathEl) {
            pathEl.textContent = dir || '每次询问';
            pathEl.classList.toggle('muted', !dir);
            pathEl.title = dir || '导出时弹出系统保存框，并记住上次选择的文件夹';
        }
        const clearBtn = this.$('btnClearExportDir');
        if (clearBtn) clearBtn.disabled = !dir;
    },

    // 选一个固定文件夹当默认导出位置。存进 prefs 后，主进程 pick-export-location 就不再弹框。
    async chooseDefaultExportDir() {
        const api = window.qingframe;
        if (!api || !api.pickDefaultExportDir) {
            // 主进程还是旧版：常见于只刷新了页面(或旧进程没退干净)而没重启应用
            this.setStatus('设置失败：请完全退出应用再重新启动（主进程未载入新接口）');
            return;
        }
        let r = null;
        try { r = await api.pickDefaultExportDir(); }
        catch (e) { r = { ok: false, error: (e && e.message) || '' }; }
        // 用户自己取消选择框：什么都不用说
        if (r && r.canceled) return;
        if (!r || !r.ok) {
            const why = (r && r.error) ? String(r.error) : '';
            // Electron 原始报错是 "No handler registered for ..."，对用户没有意义，翻译成可操作的话
            const hint = /No handler|not a function|is not a function/i.test(why)
                ? '主进程没有响应，请完全退出应用再重新启动'
                : (why || '未知原因');
            this.setStatus('设置默认导出位置失败：' + hint);
            return;
        }
        await this.refreshSettingsExportDir();
        this.setStatus('默认导出位置：' + r.dir);
    },

    // 清空＝回到「每次导出都问」。空串在主线程序列化后仍是 ''，validDir('') 为 false。
    async clearDefaultExportDir() {
        const api = window.qingframe;
        if (!api || !api.savePrefs) return;
        const r = await api.savePrefs({ defaultExportDir: '' }).catch(() => null);
        if (!r || r.ok === false) { this.setStatus('取消失败，请重试'); return; }
        await this.refreshSettingsExportDir();
        this.setStatus('导出时将询问保存位置');
    },

    // 刷新导出弹层里的「保存到」行：显示当前默认导出位置，或「每次询问」。
    // 与 refreshSettingsExportDir 同源（都读 defaultExportDir），但写的是弹层这一行而不是设置弹窗。
    async refreshExportDirRow() {
        const api = window.qingframe;
        let dir = '';
        try {
            const p = (api && api.getPrefs) ? await api.getPrefs() : null;
            dir = (p && typeof p.defaultExportDir === 'string') ? p.defaultExportDir : '';
        } catch (_) { dir = ''; }
        const pathEl = this.$('epExportDirPath');
        if (pathEl) {
            pathEl.textContent = dir || '每次询问';
            pathEl.classList.toggle('muted', !dir);
            pathEl.title = dir || '导出时弹出系统保存框，并记住上次选择的文件夹';
        }
        const clearBtn = this.$('btnEpClearDir');
        if (clearBtn) clearBtn.disabled = !dir;
    },

    // 新手引导:首次启动展示 3 步上手,点"开始使用"后记 localStorage,不再弹出
    showIntroIfNeeded() {
        try { if (localStorage.getItem('qfs_intro_done') === '1') return; } catch (e) {}
        this.updateStatsText();
        const m = this.$('introModal');
        if (m) m.style.display = 'flex';
    },
    closeIntro() {
        const m = this.$('introModal');
        if (m) m.style.display = 'none';
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (e) {}
    },
    // 从"关于"重新查看新手引导:先清标记再弹出,下次重启仍按首次逻辑判断
    showIntroAgain() {
        try { localStorage.removeItem('qfs_intro_done'); } catch (e) {}
        this.updateStatsText();
        const m = this.$('introModal');
        if (m) m.style.display = 'flex';
    },

    /* ── 更新内容(设置 → 关于 →「更新内容」)──
       说明离线内置在 js/changelog.js(window.QF_CHANGELOG),不联网、不读本地文件,
       所以离线可用、也不会因为说明写错把界面搞崩。运行版本在表里就展开那一条;
       不在(说明表还没补)就展开最新一条并在标题里说清楚。 */
    changelogData() {
        const list = Array.isArray(window.QF_CHANGELOG) ? window.QF_CHANGELOG : [];
        return list.filter((e) => e && e.version && Array.isArray(e.groups));
    },
    syncChangelogDot() {
        const dot = this.$('aboutChangelogDot');
        const btn = this.$('btnAboutChangelog');
        const cur = (this._aboutInfo && this._aboutInfo.version) || '';
        const latest = (this.changelogData()[0] || {}).version || '';
        // 只有「运行版本就是表里最新那条、且还没读过」才亮红点:
        // 运行的是旧版本时不拿未来版本的说明去打扰用户。
        const unread = !!cur && cur === latest && this._changelogSeen !== latest;
        if (dot) dot.hidden = !unread;
        if (btn) btn.classList.toggle('unread', unread);
    },
    renderChangelog() {
        const head = this.$('changelogHead');
        const list = this.$('changelogList');
        if (!head || !list) return;
        const data = this.changelogData();
        const cur = (this._aboutInfo && this._aboutInfo.version) || '';
        head.textContent = '';
        list.textContent = '';
        if (!data.length) {
            head.textContent = cur ? '当前版本 v' + cur : '更新内容';
            const empty = document.createElement('div');
            empty.className = 'changelog-empty';
            empty.textContent = '当前版本还没有内置的更新说明，完整发布记录见项目主页 → Releases。';
            list.appendChild(empty);
            return;
        }
        const hit = data.find((e) => e.version === cur);
        head.textContent = hit
            ? '当前版本 v' + cur + (hit.date ? '（' + hit.date + '）' : '') + ' · 本次更新内容'
            : '当前版本 v' + cur + ' · 这次的说明还没收录，下面是最近一次更新（v' + data[0].version + '）';
        data.forEach((entry, i) => {
            const det = document.createElement('details');
            det.className = 'changelog-entry';
            det.open = hit ? entry.version === cur : i === 0;
            const sum = document.createElement('summary');
            const v = document.createElement('b');
            v.textContent = 'v' + entry.version;
            sum.appendChild(v);
            if (entry.date) {
                const d = document.createElement('span');
                d.className = 'changelog-date';
                d.textContent = entry.date;
                sum.appendChild(d);
            }
            if (entry.version === cur) {
                const t = document.createElement('span');
                t.className = 'changelog-tag';
                t.textContent = '当前版本';
                sum.appendChild(t);
            }
            det.appendChild(sum);
            (entry.groups || []).forEach((g) => {
                if (!g || !g.title) return;
                const sec = document.createElement('div');
                sec.className = 'changelog-group';
                const title = document.createElement('div');
                title.className = 'changelog-group-title';
                title.textContent = g.title;
                sec.appendChild(title);
                const ul = document.createElement('ul');
                ul.className = 'changelog-items';
                (g.items || []).forEach((text) => {
                    if (!text) return;
                    const li = document.createElement('li');
                    li.textContent = text;   // 纯文本,不吃 HTML
                    ul.appendChild(li);
                });
                sec.appendChild(ul);
                det.appendChild(sec);
            });
            list.appendChild(det);
        });
    },
    openChangelog() {
        this.renderChangelog();
        const m = this.$('changelogModal');
        if (m) m.style.display = 'flex';
        this.markChangelogSeen();
        setTimeout(() => { const b = this.$('btnChangelogDone'); if (b) b.focus({ preventScroll: true }); }, 0);
    },
    closeChangelog() {
        const m = this.$('changelogModal');
        if (m) m.style.display = 'none';
        // 焦点还给打开它的按钮;若设置弹窗已关(从别处进来),退回顶栏设置按钮
        const back = this.$('btnAboutChangelog');
        const alive = back && document.contains(back) && back.getClientRects().length;
        const target = alive ? back : this.$('btnSettings');
        if (target) setTimeout(() => target.focus({ preventScroll: true }), 0);
    },
    // 看过就记版本号,按钮上的小红点不再出现(存进 prefs,主进程按字段合并保存)
    markChangelogSeen() {
        const cur = (this._aboutInfo && this._aboutInfo.version) || (this.changelogData()[0] || {}).version || '';
        if (!cur || this._changelogSeen === cur) { this.syncChangelogDot(); return; }
        this._changelogSeen = cur;
        this.syncChangelogDot();
        if (window.qingframe && window.qingframe.savePrefs) {
            window.qingframe.savePrefs({ changelogSeen: cur }).catch(() => {});
        }
    },

    // 「画布」页顶部的照片信息。宽高用当前载入尺寸（RAW 代理/裁切后也跟着变），
    // 比例用最大公约数化简；无图时给一句中性占位，不再留一大块空白。
    refreshPhotoMeta() {
        const el = this.$('photoMetaText');
        if (!el) return;
        const im = this.image;
        if (!im) { el.textContent = '未导入照片'; return; }
        const w = Math.max(0, Math.round(im.w || (im.el && im.el.naturalWidth) || 0));
        const h = Math.max(0, Math.round(im.h || (im.el && im.el.naturalHeight) || 0));
        let ratio = '';
        if (w > 0 && h > 0) {
            const gcd = (a, b) => (b ? gcd(b, a % b) : a);
            const g = gcd(w, h) || 1;
            ratio = (w / g) + ':' + (h / g);
            // 化简后数字过大时改显示两位小数，避免 5472:3648 这种读不出比例的行
            if (w / g > 40 || h / g > 40) ratio = (w / h).toFixed(2) + ':1';
        }
        const raw = im.raw ? (im.raw.error ? ' · RAW 显影失败'
            : (im.raw.fullPending ? ' · RAW 显影中' : (im.raw.full ? ' · RAW 全尺寸' : ' · RAW 代理'))) : '';
        el.textContent = (w && h ? `${w} × ${h} px` : '尺寸未知') + (ratio ? ` · ${ratio}` : '') + raw;
    },

    // 空状态: 没有照片时右侧面板置灰并显示中央提示; 导入照片后恢复
    // 注意: "继续上次会话"按钮的显隐由 checkDraftRestore 负责,这里不碰它
    updateEmptyState() {
        const empty = !this.images || this.images.length === 0;
        this.refreshPhotoMeta();
        const ins = this.dom.inspector;
        if (ins) ins.classList.toggle('no-image', empty);
        if (this.dom.placeholder) this.dom.placeholder.style.display = empty ? 'flex' : 'none';
        if (this.dom.canvas) this.dom.canvas.style.display = empty ? 'none' : 'block';
        // 样式条同时收起:无照片时它还写着上一张图的样式,空态下是假信息(有图后由 applyModeControls 重写)
        const ms = document.getElementById('modeStatus');
        if (ms && empty) ms.style.display = 'none';
        // 无照片时这几个顶栏动作会静默 return，点了像按钮坏了一样。
        // 置灰由这里统一管：导入 / 删除 / 换图都会经过 updateEmptyState，自动恢复。
        // 导出/复制在无照片时点了只会弹「请先导入照片」，空态下直接置灰，
        // 免得首屏那排亮绿色按钮看起来像能用。
        for (const id of ['btnReset', 'btnRandom', 'btnSyncSel', 'btnSave', 'btnExportSettings', 'btnCopy']) {
            const b = document.getElementById(id);
            if (b) b.disabled = empty;
        }
    },

    /* ══ armLogoPlacement(logo) { … → app-elements.js ══ */

    /* ══ 缩放 / 状态栏 / 主题 / 用户资料 → app-view.js ══ */

};

/* 工具 */
function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function num(el, def) {
    if (!el) return def == null ? 0 : def;
    const v = parseFloat(el.value);
    return isNaN(v) ? (def == null ? 0 : def) : v;
}
function dashToArray(v) {
    if (!v) return [];
    const arr = String(v).split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x) && x > 0);
    return arr;
}

document.addEventListener('DOMContentLoaded', () => App.init());
// ═══ 自定义标题栏:窗口控制按钮(仅 Windows 显示;mac 走系统红绿灯) ═══
(function initTitleBar() {
    const qf = window.qingframe;
    if (!qf || !qf.platform) return;
    document.body.classList.add('platform-' + qf.platform);
    const wc = qf.winControls;
    if (!wc || qf.platform === 'darwin') return;
    const min = document.getElementById('tbMin');
    const max = document.getElementById('tbMax');
    const close = document.getElementById('tbClose');
    const full = document.getElementById('tbFull');
    if (min) min.addEventListener('click', () => wc.minimize());
    if (close) close.addEventListener('click', () => wc.close());
    if (full && wc.toggleFullScreen) {
        full.addEventListener('click', () => wc.toggleFullScreen());
        if (wc.onFullScreenChange) wc.onFullScreenChange((v) => full.classList.toggle('is-full', !!v));
    }
    if (max) {
        max.addEventListener('click', () => wc.toggleMaximize());
        if (wc.onMaximizedChange) wc.onMaximizedChange((v) => max.classList.toggle('is-max', !!v));
    }
    // 首页（预设墙）盖住了整条标题栏，那边也有一组同样的按钮：
    // 全屏 / 最大化 / 退出，行为与标题栏一致，图标状态同步。
    const pwFull = document.getElementById('pwFull');
    const pwMin = document.getElementById('pwMin');
    const pwMax = document.getElementById('pwMax');
    const pwExit = document.getElementById('pwExit');
    if (pwFull && wc.toggleFullScreen) {
        pwFull.addEventListener('click', () => wc.toggleFullScreen());
        if (wc.onFullScreenChange) wc.onFullScreenChange((v) => pwFull.classList.toggle('is-full', !!v));
    }
    if (pwMin) pwMin.addEventListener('click', () => wc.minimize());
    if (pwMax) {
        pwMax.addEventListener('click', () => wc.toggleMaximize());
        if (wc.onMaximizedChange) wc.onMaximizedChange((v) => pwMax.classList.toggle('is-max', !!v));
    }
    if (pwExit) pwExit.addEventListener('click', () => wc.close());

    // 键盘出入口：全屏后标题栏按钮还在，但很多人第一反应是按 Esc/F11。
    // F11 是约定俗成的全屏键；Esc 只在确认全屏中、且没有菜单/弹窗抢键时才退，
    // 否则会把「关右键菜单」和「退全屏」搅在一起。
    let isFs = false;
    if (wc.onFullScreenChange) wc.onFullScreenChange((v) => { isFs = !!v; });
    document.addEventListener('keydown', (e) => {
        if (!wc.toggleFullScreen) return;
        if (e.key === 'F11') { e.preventDefault(); wc.toggleFullScreen(); return; }
        if (e.key === 'Escape' && isFs) {
            if (document.querySelector('.ctx-menu')) return;   // 菜单自己会关，别抢
            e.preventDefault();
            wc.toggleFullScreen();
        }
    }, true);
})();

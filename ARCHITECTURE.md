# 清框影 · QINGFRAME —— 架构与流程说明

> 审计方式：全量静态阅读（主/渲染进程 + 工具链 + 测试 + 预设 schema），并实跑纯 Node 工具。
> 未启动 GUI、未修改任何文件。行号引用以审计时工作区为准。

---

## 0. 项目定位与血统

- **Electron 45 + 原生 HTML/CSS/JS + Canvas 2D**，本地优先的照片加框工具，代码 MIT（`shared/brandlogos`、`shared/textures` 除外）。
- **它是 JavaFX 桌面版的 Web 重写**：`engine.js:1` 自述「JavaFX BorderEngine 逐行移植」，`index.html:153` 注释「对齐 Java FXML 命名」，函数名 `computeCanvasSize` / `getShadowSpace` / `parseColor` 都保留原版语义，`styleNoise/javaRandom` 是 Java LCG 的复刻（`engine-styles.js:853`）。桌面上还存在同名 Java 版与压测目录。

## 1. 进程与文件布局

| 层 | 文件 | 职责 |
|---|---|---|
| 主进程 | `src/main/index.js`(589) | 单实例锁、窗口、`qflocal://` 协议、~30 个 `ipcMain.handle`、自动更新 |
| | `src/main/state.js`(46) | `userData/state.json` 读写、`freeFilePath` 的 `_1/_2` 递增命名 |
| 桥 | `src/main/preload.js`(51) | `contextBridge` 暴露 `window.qingframe` 26 个方法，与 handle 一一对应 |
| 渲染 | `src/renderer/index.html`(919) | UI 骨架 + **按顺序 `<script>` 加载 17 个文件**（901-917） |
| | `js/engine.js`(1602) | 通用渲染：图层管线、卡片管线、拼图管线 |
| | `js/engine-styles.js`(4526) | IIFE，**76 个相框风格** + 分发表 |
| | `js/app*.js`(10 个) | 全部 `Object.assign` 混入同一个 `window.App` 单例 |
| 数据 | `shared/presets/`(80 个 JSON) | 内置模板 |
| | `shared/textures/`(10 PNG) | 纹理，仅图层管线消费 |
| | `shared/brandlogos/`(106 文件) | 本机素材，**不入库、不进包** |

**安全姿态**：`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、CSP 写死在 `index.html:5`（`script-src 'self'`，图片允许 `qflocal:`）。自动更新默认直连 GitHub，不自动改道任何第三方镜像（清单与二进制必须同源）。用户可在「关于 → 更新下载源」自行填镜像：**清单与 sha512 始终取自 GitHub**，只有安装包下载地址被替换（`src/main/update-mirror.js`），下完仍按 GitHub 的 sha512 校验，不匹配即丢弃并回退直连。

**照片不走 IPC**：主进程注册 `qflocal://`，渲染侧用 `qflocal://img?p=<绝对路径>` 直读磁盘，避免 base64 过桥；协议只服务**图片扩展名且被主进程登记过**的路径（文件选择/拖放/剪贴板/封面目录/`read-exif`），并开启 `corsEnabled`。只有**模板/工程文件**与**导出写盘**才走 IPC；导出写盘只认 `pick-export-location` 发出的令牌，渲染层不能直接指定路径。

## 2. 渲染架构（核心）

### 2.1 四条管线，一个分流点

`engine.js:94 _renderToCanvasInner` 按模板字段分流：

1. `photoFrameStyle` 非 `NONE` → `EngineStyles.renderPhotoFrame`（`engine-styles.js:2827`，76 风格）。
2. `photoFrameStyle==='NONE'` → 原图直出（唯一真正读 `app.exportScale`、能上采样的路径）。
3. `baseMargin.bgBlurEnable===1` → `renderCardStyle`（`engine.js:932`）。
4. 其余 → `renderTemplateStyle`（`engine.js:192`，通用图层模板）。
5. 拼图页签独立：`renderPuzzle`（`engine.js:1320`）。

预设到管线的分类由 `tools/validate-presets.js:78 classify()` 判定：80 个预设 = **47 风格 + 2 卡片 + 31 图层**。

### 2.2 坐标系（最容易被踩的地方）

`setupCanvas`（`engine.js:129`）：

- `scale = uiScale * dpr`；`uiScale` 平时是 `min(1, displayMax/长边)`，导出时若 `exportScale>0` 则等于 `exportScale/长边`。
- 后备缓冲按 `scale` 放大，同时把**逻辑尺寸**写进 `canvas._logW/_logH` —— 全工程所有元素几何都以「基准画布」口径计算，不是最终画布。
- 导出时 `app.uiDprOverride=1`（`app-export.js:80`）保证输出分辨率不被 DPR 污染。
- 拖动/手势期 `displayMax` 被降到 900（`app-state.js:55`）做即时低清渲染，松手恢复。

### 2.3 相框样式管线

`engine-styles.js:3754` 的 `const draw = {...}[styleName]` 是**唯一分发表（76 键）**，签名两类：

- `f(img,size,g,iw,ih[,S])` —— 老几何风格
- `f(img,size,g,iw,ih,S,cwO,chO)` —— 带留白/全出血风格，自行把内容块居中

流程：`buildState`(S：exif/cam/paramFs/globalMargin/sign*/avatar*/brand*) → `styleDims`(76 分支定画布) → 分发表取 draw → 全出血模糊风格按 `effectiveCanvasRatio` 扩画布（`BLUR_FULLBLEED` 名单 3811）→ 临时 canvas 上**劫持 `g.drawImage`** 给照片套 `cornerConfig` 圆角（3836-3856）→ `expandToRatio` 补比例（2788）→ 以 `finalScale = min(1, displayMax/长边)` 贴回可见 canvas（3875）→ `drawUserElements` 画 logo/贴纸/自由文字。异常时 `catch` 回退纯原图（3890）。

未注册的风格名落到占位分支，渲染中性底 + 风格名（`stylePlaceholder:2289`）。

### 2.4 图层模板管线

`computeCanvasSize:60`（图 + 四边 margin + 侧投影预留 `getShadowSpace:31`，再按比例只扩不裁）→ `setupCanvas` → 白底 → **倒序**遍历 `layerList`：`drawLayerShadowGlow:295` + `drawSingleLayer:275`（填充 `applyFill:333` = solid/gradient/texture，描边 `applyStroke:427` 支持 inside/center/outside 与 dash）→ `drawOriginImage:485`（imgScale/imgOffset，投影三态：均匀 / 立体双层 / 默认小阴影）→ `applyShapeMask:591` + `drawFilmPerforations:600`（撕纸、齿孔）→ `applyGlobalLight:698`（暗角 multiply、漏光 screen 暖/冷/品红、光束）→ `applyFilmGrain:673`（overlay，固定盐 `GRAIN_SALT=20240816`）→ `punchRoundedCorners:472` 镂空 → 装饰/文字/EXIF 条/Logo。

照片圆角刻意用「同分辨率临时画布 + `destination-out` evenodd 镂空 + 1:1 贴回」而非裁剪态 drawImage，规避 Chromium 摩尔纹（571-584）。

### 2.5 纹理与"程序化冒充"

- 真纹理只有图层管线用：`shared/textures/*.png` → `list-textures` → `app.textures` → `setTextureFill:403`（`createPattern('repeat')` + `DOMMatrix` 缩放偏移 + multiply/screen/overlay）。
- `engine-styles.js` 里的水彩/油画/蓝晒/报纸等**完全不读磁盘纹理**，靠 `javaRandom` 噪点、`fastBlurCanvas`/`gaussianFilter`、16 桶主色直方图（`extractDominant:64`）现场合成。
- 缓存：`TEXTURE_CACHE:363`、`GRAIN_TILE_CACHE:639`、风格侧 `_smallCache/_edgeCache/_bottomCache/_multiCache`（195-200），切图时 `clearStyleCaches:207`（由 `app-render.js:58` 调用）。

## 3. 状态与数据流

### 3.1 单例 + 混入切片

`window.App`（`app.js:4-45`）是唯一耦合面，由 10 个文件 `Object.assign` 拼装，无模块系统、无打包器，跨文件符号由 `<script>` 顺序与 ESLint 白名单兜底（`renderer` 的 `no-undef` 被关掉）。

关键字段：`images[]`、`image`（当前图，同时是 `imageTemplates` 的 Map 键）、`currentIdx`、`selectedIdx`、`template`（当前编辑模板）、`imageTemplates: Map<图, 深拷贝快照>`、`undoStack/redoStack`、`_renderDirty/_renderSkip/_renderRaf/_renderFlushResolvers`。

### 3.2 双向镜像

- `syncModelFromUI()`（`app.js:730`，UI→模型）与 `refreshUI()`（`app.js:894`，模型→UI，`isUpdating` 守卫）是两份**手工维护的巨型字段表**。
- 两条写入路径：
  - `onSettingChanged()`（`app-state.js:5`）= 高频（拖滑块）：同步 + 每图记忆 + 防抖渲染 + 800ms 落 localStorage，**不压撤销栈**。
  - `onSettingCommit()`（`app-state.js:44`）= 离散（勾选/切换/按钮）：`pushUndo` + 立即渲染。
- 手势：`beginGesture`（50，滑块 pointerdown / 输入框 focus）压一次快照并把 `displayMax` 降到 900；`endGesture`（61）恢复全分辨率重渲。撤销栈上限 50，快照是整模板深拷贝。

### 3.3 渲染调度（性能设计的核心）

`app-render.js:7 scheduleRender`：**单个 rAF 句柄 + 脏标记**，任意次调用合并为「下一帧渲一次」；手势期 `_renderSkip=2` 直接**跳帧**降频（而不是用 setTimeout 尾随防抖，注释里明确记录了旧实现 120ms 拖尾）。

`flushRender:41` 走同一队列并等真帧结束，供导出/读像素使用（避免与普通帧并行排两帧读到半成品）。

拖动元素时的优化（`:82-159`）：首帧把「不含被拖元素」的整帧缓存为背景位图，之后每帧只 blit 背景 + 重画被拖元素 + 选择框，把 52~143ms/帧 降为一次位图拷贝；缓存键 = 画布尺寸 / 模板引用 / 图源。

### 3.4 关键流程

**导入**：`open-images`（主进程顺带解析 EXIF）→ `addImageFiles:1214`（`Promise.allSettled` 并发）→ `loadFile`（ObjectURL + buffer）→ `applyOrientation:1291`（处理 8 种 orientation，重编码 JPEG 0.95）→ 缩略图队列 `queueThumb:1483`（350ms 去抖 + 16ms 串行 tick，`renderFramedThumb:1506` 用该图自己的模板渲 200px 成品缩略图）。

**每图独立模板**：`saveCurrentTemplate:1167` 是唯一写入点，把 `cloneTemplate()` 深拷贝同时塞进 `imageTemplates` Map 与 `im.customSettings`；切图时优先恢复该图快照，未设过的图用 `defaultTemplate()`。

**导出**（`app-export.js:4`）：① 先在画布外算文件名（`<原名>_边框|_拼图`，`dedupeExportNames:181` 同名加 `_1/_2`）→ ② `pick-export-location`（多文件选目录 / 单文件选文件并补扩展名）→ ③ 逐张：`uiDprOverride=1` + `flushRender` → 按 UI 尺寸渲一次取基准宽 → 置 `displayMax=目标长边`、`exportScale` → 再渲 → `k=afterW/beforeW`，非拼图时 `scaleElPix:54` 等比放大 logo.size / 锚点 offset / 贴纸 / 自由文字（**rel 比例位置不缩放**）→ 再渲 → `toDataURL`；JPEG 先白底合成 → 目录模式逐张写盘并立刻释放 base64（内存友好）。空模板陷阱有 `confirm` 兜底（28-33）。

**模板 / 工程**：模板落 `userData/templates/<名>.json`（名做非法字符替换）；`.qfs` 是 **v2 自包含单文件**（`app-qfs.js:17`：模板 + 每图 customSettings + 照片以 JPEG 0.92 base64 内嵌），导入时按 `data.images` 自动区分工程与旧裸模板。模板库缩略图用合成的 1000×1250 示例图、`displayMax=96` 现场渲染成 dataURL，**只用内存、每次刷新全量重算**。

**草稿**（`app-draft.js`）：1.5s 去抖 + 30s 定时 + `pagehide`/`visibilitychange` 写 localStorage；启动**只提示不自动恢复**（`btnRestoreDraft`）；`errguard.js` 捕获未处理异常时立即落盘。

**拼图**（`app-puzzle.js`）：12 种布局、`axisVals`、`slots{i:{imageIndex,zoom,offsetX,offsetY,rotate,fillMode}}`、格字幕与间隙字幕、轴线拖动与整格 swap；导出恒 **4000px PNG**，不读导出尺寸档。

**调色**（`app-grade.js` + `app-curve.js` + `app-mix.js`，第一行页签「调色」，与画布/文字/边框同族）：9 档滑块（曝/对/饱/色温/色调/高光/阴影/白色/黑色，±100，0 为不变）+ **曲线编辑器**（RGB/R/G/B 四条，单调三次插值 Fritsch–Carlson 防过冲）都挂在 `im.grade` 上、随草稿持久化，属**记录值**而非破坏性编辑。渲染链零改动：`photoSrcOf(im) = im._grade.canvas || im._grade.low || im.el`，只把取源换成烘焙画布。烘焙用原生 `ctx.filter`（`brightness/contrast/saturate/hue-rotate` + `url(#qfsGradeLut)` 的 `feComponentTransfer` 256 项 LUT，必须 `sRGB`），不逐像素、不上 WebGL —— 实测 2400×1600 一次全滤镜约 25ms，逐像素 JS 同尺寸 300ms+。曲线不单独走像素：在 `buildTables` 里串联在色温/高光/阴影的表输出之后（与 PS 复合顺序一致），开曲线不增加烘焙成本。数据只存控制点（`curve:{rgb:[…],r:[…]}`），应用到全部时**深拷贝**。两级缓存：拖动中 1600px 降采样、松手后原尺寸（`ensureFullGrade`），LRU 4 张；中性时不烘焙、不占内存；烘焙画布的 `naturalWidth/Height` 恒等于原图（自适应 EXIF 字号按它算，报像素尺寸会让文字随拖动跳变）。高光/阴影用**平滑窗**（`smoothstep`）：高光只吃 0.45 以上、阴影只吃 0.55 以下，中灰 128 在 ±100 时位移 ≤4 级 （旧版用钟形 `v(1-v)²`，翼太宽 —— −100 把 128 压到 37、+100 抬到 218，导入 XMP 预设后整张「大相径庭」）；白色/黑色是端点操作（白点内移 `v/(1-w·0.25)`、黑点抬升 `v(1-b·0.22)+b·0.22` 或压死 `(v+b·0.22)/(1+b·0.22)`），分别按 `v³`/`(1-v)³` 加权只吃端点，故意允许端点溢出（曲线也可以突破锚点）。曝光按 **EV** 存（±5），在线性光空间乘 `2^EV` 再编码回 sRGB：sRGB 128 +1EV = 175，与 LR 一致。

**调色页签的顶栏**（`app-histogram.js`）：页签打开时先画一块 RGB 直方图与一行 EXIF 参数条，位置对齐 Camera Raw 的面板顶部。直方图取 `im._grade.canvas || im._grade.low || im.el`，也就是**调色之后**的预览，所以拖滑块时形状跟着变；参数归零（`_grade.neutral`）时必须回退到原图，否则会画出上一次烘焙的旧形状。统计方式是先降采样到长边 180px（约 2 万像素），RGB 与 BT.601 亮度各 256 桶，按 3 桶平滑后以 0.55 次幂归一化绘制（两端桶夹到相邻桶高度，避免整片纯黑/纯白把图挤扁）；120ms 节流，页签不可见（宽度 0）时跳过。参数条读 `im.exif`，缺项自动省略。

页签内的滑块按 Camera Raw 分成 **亮 / 颜色 / 效果** 三段（`.pg-sub`）：原来 11 档一字排开，白平衡混在曝光与饱和之间，用户找不到；分段后每段可单独收起、单独复位。效果段接管原属「细节」的纹理/清晰度/去薄雾，`#grpDet` 只剩锐化四档。段内每一行是两行网格（标签+数值 / 整宽轨道），只作用于 `#panel-grade`，其余页签仍是原来的三栏卡片行。段复位的键位表在 `resetGradeSection()`，走同一条 `setGrade`，撤销、蒙版路由与草稿保存都自动跟随。

**参数栏减负**（`app-panel-density.js`）：页签收成一行（主 5 个 + `#tabMoreMenu` 内的样式/拼图/切图，
菜单仍挂在 `#inspTabs` 里，所以 `switchTab` 的 `.tab[data-tab]` 查询与 `app-export.js` 的 `.tab.active` 都不用改）；
`#modeStatus` 不再常驻，样式名写进状态栏 `#stStyle`，RAW 阶段写进直方图卡 `#gradeRawTag`。
`--density` 挂在 `#inspector` 上，只乘 `.param-group` / `.pg-title` / `.param-row` / `.pg-sub-head` 的纵向间距，
字号仍归 `--font-scale`；自动档按 `onTab(name)` 给调色页加 `.density-compact`。
六组低频档位默认折叠，状态存 `prefs.panelFolds`（`main/state.js` 的 prefs 是字段级合并，不会冲掉主题/缩放；
GUI 用例的 `get-prefs` 返回 `{}`，测试里点折叠不会污染下次运行）。
两个配套修正：`syncEmptyGroups()` 必须跳过 `.collapsed` 组（否则行全被折叠规则设为 `display:none`，
会被误判成「整个组空了」连标题一起藏掉）；带出蒙版时 `syncMasks()` 自动展开蒙版组，
但用户显式收起过（`panelFolds.grpMask === true`）就不抢决定。
默认折叠不碰显隐审计的取样行——蒙版那 8 个 `row*` 在冻结基线里 95 个风格本来就全是隐藏。

**左栏边框树收拢**：`app-templates.js` 的 `buildTree()` 原来每次都把「最近使用」和
`defOpen` 两组一起展开，且只持久化分组顺序（`qfs_group_order`），一屏 20+ 行。
现在展开态存 `localStorage.qfs_preset_groups`，默认只开 `defOpen`；
「最近使用」默认收起且截到 4 条，搜索（`f` 非空）时强制全展开，别把结果藏在折叠里。
> 顶栏曾试过把六个低频按钮收进「⋯ 更多」并去掉 `.toolbar-group` 的 pill 底色，
> 用户看过截图后选择恢复原样；那部分已撤回，`#toolbar` 仍是 13 个常驻入口 + 圆角 pill。
> `tools/test-top-density.js` 里保留了「顶栏维持原状」的断言，避免以后再被顺手改掉。

**参考 LR / ACR 补的六个细节**：`app-histogram.js` 的 `collect()` 把剪切口径从「三通道同时
纯黑/纯白」改成「任一通道到端点」，同时保留 `loAll/hiAll` 细分；画波形时 `capEnds()` 仍把
首尾桶夹到相邻高度（否则整片纯黑会把图挤扁），丢掉的信息由 `.histo-clip` 两枚 DOM 角标补回：
超 0.2% 点亮、悬停给百分比、点击置 `showClip` 在直方图 canvas 两端画强调竖条（不碰照片渲染）。
`#titlebarFile` 绝对居中且 `pointer-events:none`，所以 `-webkit-app-region:drag` 的命中区不变；
由 `updateStatusBar()` 写入「文件名 · 第几张」，切图的 `←/→` 早已有，这里只补可见性。
零点标记由 `initGradePanel()` 按 `defaultValue` 算 `--zero` 写在行上，CSS `::after` 画三角；
`.rng-vib/.rng-sat` 与 `.rng-temp/.rng-tint` 共用 `var(--rng-bg)` 渐变轨道。
工具与参数分层：新建 / 管理蒙版的入口都放在 `#grpMask` 折叠组（渐变 / 椭圆 / 画笔 / 亮度 / 颜色），
直方图卡上不再放「+ 蒙版」；`syncMasks()` 在带蒙版时自动展开该组，参数列表仍在 `#grpMask`，不复制第二套滑块；
底部 `#stStyle` 是 `role=button` 的 span，点击走 `setSideMode('border') + buildTree('')`。
`app-sync.js` 的 `copySettings/pasteSettings` 只存内存、不写系统剪贴板也不落草稿，
目标取 `selectedIdx`（排除当前张），与 `applyGradeToAll`（调色给全部）和
`syncToSelected`（边框给多选）三条语义互斥，见文件内注释表。

**与 Lightroom 的数值对照**（`app-xmp.js` 导入 `.xmp` 用同一套口径）：

| 项 | 对齐程度 | 说明 |
| --- | --- | --- |
| 曝光 Exposure2012 | **一致** | 按 EV 存，线性光 ×2^EV；+1 EV 让中灰 128→175 |
| 高光 / 阴影 | **一致（窗形）** | 只吃两端，中灰位移 ≤4 级 |
| 白色 / 黑色 | 接近 | 端点操作，三次方加权 |
| 对比度 | 接近 | LR 是 S 曲线，这里是 `contrast()` 线性斜率 |
| 色温 Temperature | 近似 | 绝对 K 以 **4900K** 为基准按 mired 差换算（按 PS 的 JPEG 相对刻度反推：4769K → −4，与 Camera Raw 显示一致；5500K 会算成 −21，整张偏冷偏绿）；LR 是相对 as-shot 的真白平衡，换原片会偏（`WhiteBalance=As Shot/Auto` 时直接跳过） |
| 色调 Tint | 近似 | 绿–品红轴通道增益，方向与 LR 一致 |
| 饱和度 / 自然饱和度 | 一致 / 近似 | vibrance 由 `QfsColor` 按 HSV 的 s 加权（真 vibrance），仅 GL 路径 |
| HSL / 校准 / 颜色分级 | 一致（结构） | 8 色带×3、6 值、三区+混合+平衡；色带边界权重无法与 LR 逐像素相同 |
| 曲线 | 一致 | 点曲线 + 参数曲线（4 区 + 3 分界）串联，复合顺序与 LR 相同 |
| 清晰度 / 纹理 / 去雾 | 近似 | USM 半径、去雾模型都与 LR 不同 |
| 相机配置文件 / ProcessVersion | **做不到** | Adobe 私有管线，同一份 XMP 在不同机身结果本就不同 |
| 锐化 / 降噪 / 镜头校正 / 裁剪后暗角 | 未映射 | 进 skipped，导入时显示给用户 |

**画质与色彩空间**（用户最常怀疑的两处，结论都写清在这里）：

- **预览是降采样的，导出不是**。`engine.js` 的 `displayMax` 默认 1800：画布长边超过 1800 时，`uiScale = 1800 / 长边`，预览 backing 只有 `1800×dpr`。但**烘焙与导出走原图**：`bake()` 用 `im.el` 原始像素，实测 5905×3937 的原片烘焙出来仍是 5905×3937。所以「看不到全部画质」只在预览成立，导出是全尺寸、无损的（导出前 `ensureFullGrade` 会补全分辨率）。
- **非 sRGB 原片会被浏览器先转成 sRGB**。相机可选 Adobe RGB，JPEG 里带 ICC；Chromium 加载 `<img>` 时按 ICC 转到 sRGB 再交给 canvas（实测同一坐标 B 通道差 4–16 级），而 PS 若按嵌入配置文件工作是在 Adobe RGB 里调色、显示时才转显示器 —— 调色发生的空间不同，高饱和区域的余量也不同。`src/main/exif-read.js` 的 `readIccName()` 会读出 profile 描述，导入时在状态栏提示（「其中 N 张原片是 Adobe RGB (1998)，已转 sRGB 处理」）。
  注意：**单纯把 Adobe RGB 当 sRGB 直读（跳过转换）是错的** —— 预览会假性过饱和，导出文件在别的设备上也是过饱和。

**黑白混色器**（`app-color-grade.js` 的后置 pass）：`im.grade.bw = { on, r,o,y,g,a,b,p,m }`，8 个色相带各自决定「这个颜色转灰后有多亮」，对应 LR 的 `ConvertToGrayscale` + `GrayMixer*`（以前整组进 skipped，导进来等于没生效）。色带中心复用混色器那套；灰/近灰用 `smoothstep(0,0.08,S)` 挡掉，否则灰底会被某个带带走。亮度按 `luma × (1 + k×1.4)`：系数 1.4 是照 PS 的量级定的 —— 太小（0.55）时纯红拉满只从 43 到 60，等于「有滑块但看不出变化」。GL 不可用时 `pass2d` 有同一套逐像素实现。

**蒙版**（`app-mask.js`）：`im.grade.masks[]`，每项 = 形状（归一化照片坐标）+ 羽化/浓度/反相 + 一套 9 档参数。烘焙顺序是「全局参数烘一层 → 逐个蒙版用它的参数在上一层结果上再烘一层 → 按蒙版 alpha 合成」（`destination-in` 遮罩 + 叠加），所以蒙版参数天然叠在全局之上，与 PS 调整图层的堆叠语义一致。蒙版权重必须落在 **alpha** 通道（早期用黑/白填充，alpha 恒为 1，整张图都被当成蒙版内）。画笔按描边 + 羽化模糊；亮度范围按亮度阈值在 320px 低分辨率上算再放大（软过渡，成本可控），**取样源恒为原图 `im.el`**：若拿已调色的图层当源，压暗后原本不达标的像素会落进亮度区间，选区自己长大，用户看到的就是「调完色再点回蒙版范围变了」（实测 alpha 203/17 → 127/43）。降采样那档按「前缀链」缓存：改第 N 个蒙版只重烘它一层，前面直接复用；全尺寸不缓存，避免几十 MB 常驻。编辑期拖形状只重画叠加层、松手才烘一次，保证 60fps 跟手；叠加层用引擎记在 `app._photoRect` 的照片矩形换算坐标，卡片/相框管线拿不到矩形时提示「无法在画布上编辑」。叠加层的**几何只有两个真相**：`app._photoRect`（基准坐标）与叠加层自身像素尺寸 —— `syncOverlayGeometry` 直接读 canvas 的 `getBoundingClientRect()` 写 left/top/width/height（不再复制 canvas 的 style.width/transform），绘制比例恒为 `ov.width / baseW`，缩放/平移/窗口变化都不会产生第二套口径。线性/椭圆用矢量渐变绘制、画笔/亮度走低分辨率光栅；叠层只表示**范围**，不乘浓度（否则调低浓度或压暗照片后，半透明绿在暗背景上看不见，用户会以为蒙版缩小了）。选中蒙版时 9 档滑块路由到该蒙版（`MASK_ROUTE_KEYS`），曲线/校准/混色器仍写全局。

**扩展档位**（对齐 LR）：**细节** = 清晰度/纹理用 `feGaussianBlur`+`feComposite(arithmetic)` 的 USM 串进同一条滤镜链（模糊半径按烘焙分辨率缩放：纹理 ~long/250、清晰度 ~long/40，拖动降采样时半径同步变小），负档反向柔化；去除薄雾为简化版 = LUT 黑场（正档压黑点/负档抬黑）+ `contrast()/saturate()` 复合。**校准** = `feColorMatrix` 3×3 通道混合矩阵：色相 = 原色轴**绕灰轴 (1,1,1)/√3 做 Rodrigues 旋转**（±45°），饱和 = 轴向灰矢量(1/3,1/3,1/3)收放。两步都不能省：
- 三个轴各转各的角度时，Rodrigues **单列**旋转不保行和（RedHue+49/GreenHue+46 实测 0.746/1.221/1.033），必须先把轴向量按行归一化，否则灰 (0.5,0.5,0.5) 变成 (0.33,0.5,0.5)，整张偏青绿；
- 混合饱和度后行和会被拉偏，再把 Σd 均摊回三列（量级很小，不伤饱和度）；
- 只做「各列增量代数和为 0」是不够的（旧版），行和 1.31/1.35 会让灰 128 变成 (123,166,172)。
顺序也不能反：先混合再按比例归一化，会把 RedSat −100 已收成灰的分量放大回去（纯红只到 255,64,64）。绕灰轴旋转同时保住「灰不变」和「色度不被压缩」—— 早期换成单纯行归一化时，色度被压掉约 24%，导入预设后整张发灰、黄叶变柠檬色。**混色器**（`app-mix.js`，8 色相带 × 色相/饱和/明亮度，**HSL 空间**：LR 的「明亮度」是 L 不是 V —— 用 HSV 的 V 会让高饱和色提不动（纯红 V=1 再加也是 1），实测同一组参数两者最大单通道差 32 级；色带中心与 LR 一致：0/30/60/120/180/240/285/320）是唯一走 WebGL 的档位：按色相选区是三维操作，逐通道 LUT 与 SVG 掩膜（8 带×十几原语，烘焙慢一个量级）都不可行；实现为烘焙**前置级** `原图 → GL 单 pass(RGB↔HSV + smoothstep 带权重、跨带取加权平均) → ctx.filter 其余全部`，色相满档 ±40°；HSL 明亮度用**非对称**增量（提亮时按 `1−0.55·V` 抑制亮端，否则 V≈0.9 的黄叶会被推到 248 直接过曝；压暗时不抑制，否则纯红 V=1 压不下去）；GL 不可用/上下文丢失时 `pass()` 返回 null 自动退回原图，混色器整组标记 `.mix-na` 降级，其余功能不受影响。`isNeutral/signature` 计入全部扩展档；`mix` 是两层嵌套结构，应用到全部时深拷贝。

页签归属：调色是**单张照片**的参数面板，与「画布/文字/边框/Logo/模板」同族，故挂在第一行；工具行只保留「拼图/切图」（多图合成与输出，会切走画布状态并走独立导出路径）。原「光影」页签的光效作为「氛围」并入调色面板 —— 它们与调色同作用域（都写在当前照片的 `im.customSettings` 模板快照里）；但渲染语义不同：调色只改照片像素，氛围叠加在整张成片（含白边/边框）之上。与 Camera Raw 的「效果」对齐后，**晕影 / 颗粒已并入 `#grpGrade .pg-sub[data-sub="fx"]`**（纹理 → 清晰度 → 去薄雾 → 晕影 → 颗粒一条线），只剩**漏光**还是独立的 `.ctl-grp-light` 组。光效在**三条渲染管线**里都生效：默认图层与卡片（`renderCardStyle`）本来就走 `applyGlobalLight`；相框样式以前完全不调它，这两组对相框预设其实是**死控件**，面板只好把 `.ctl-grp-light` 整组藏起来 —— 现在 `engine-styles.js` 在合成完 `out` 之后、`drawUserElements` 之前补了一次 `applyGlobalLight`（与默认管线同序：成片 → 光效 → 文字/Logo），所以光效行**不再按管线隐藏**，90 个预设里只有「波普漫画风」（POP_COMIC，颗粒 10）受影响，其余都 `enable:0`。晕影是**双向**的（`-100..100`，负值压暗 / 正值提亮，对齐 LR/ACR）：老数据「正值 = 压暗」由 `coerceTemplate` 的一次性迁移（`vignetteSignV2` 标记）翻成负值，内置 6 个启用晕影的预设观感不变；`vignetteFeather` 过去只存不用（死滑块），现已接进引擎，50 = 旧几何、不改变默认观感。氛围滑块仍是**常开**（无独立开关，强度 0 即关）：`syncModelFromUI` 由滑块值反推 `vignetteEnable/lightLeakEnable/filmGrainEnable`，`refreshUI` 回显时反过来以 enable 为准 —— 预设有 84 个存着 `enable:0 + 强度:35` 的模板默认值，只看强度会让整库预设凭空长出暗角。

**剪贴快捷键**（`app-view.js:56`）：Ctrl+O/Z/Y/A/C/V/E/D/0、Ctrl+Shift+S、Delete/Backspace（先判拼图字幕再判元素）、方向键微移选中元素（Shift=10px；无选中时 ←/→ 切图），输入框聚焦时屏蔽。

## 4. 工程化与质量门

- `npm run check` = ESLint（只覆盖 `src`）+ `validate-presets`（80 预设结构 + 风格白名单）+ `check:caps` + `check:marks`（28 SVG 严格比对）+ `test:mainio` + `test:icons` + `test:engine`。**实跑通过（exit 0）**。
- **`style-caps.js` 能力表**是「面板显隐 ↔ 引擎是否真读该参数」的唯一事实来源：`DIMS`（5 个数值维度：pf/cr/gm/isc/bi）用两个极值探针渲染，判据是**单格最大差 ≥2 且变化格数 ≥2**（`gen-style-caps.js:28-58`，注释记录了"全图均差"曾误判 9 个风格的返工）。生成区由基线实测得出（76 键），`npm run gen:caps` 重写、`--check` 过期退出 1。
- `npm test` = check + 24 个 Electron 用例（经 `run-electron.js` 统一补 GPU 开关，含 panel、panel:audit、visual），`&&` 串联，单点失败即断。**2026-10-08 起整链 33 阶段实跑 EXIT=0（历史首次）**。
- **视觉回归**：`tests/visual/baseline.json` 20.7 MB / **924 键**（76 `__base` + 76×10 参数极值 + 4×22 品牌组合），每键存 32 格分块平均指纹 `{fp:{CW,CH,data}}` 与布局锚点 `m`；容差 `FP_TOL=2.0` / `POS_TOL=2px`。
- 测试三套模板：**A 纯 harness**（`design/regress.html` 只加载引擎，注入 `mulberry32` 固定随机，`__QR.run` 批量渲）；**B/C 真实 app**（注册 `qflocal` 协议 + 打桩 ~25 个 IPC + 注入 preload + 轮询等 `window.App` 就绪）。
- `npm run release` = `app:dir` → `verify-dist`（未压缩目录 asar）→ 打安装包 → `verify-dist --installers`（即 `verify:pkg`：Setup.exe 体积 + sha512 对照 `latest.yml`）；`verify-dist` 退 **0 干净 / 1 泄漏 / 2 无法判定**，并检查产物新鲜度。

> 环境提示：本会话 `ELECTRON_RUN_AS_NODE=1` 被置位，`require('electron')` 退化为路径字符串，任何 Electron 测试脚本第一行就崩（不是测试失败）。要跑 GUI 用例需先 `$env:ELECTRON_RUN_AS_NODE=$null`。

## 5. 发现的问题（按严重度）

1. **【已解决】9 个 Electron 用例恒绿**：`app.quit()`/`process.exit()` 之后再设 `process.exitCode` 会被忽略，断言失败也返回 0。已全部改为 `finish()` → `app.exit()`（OPTIMIZATIONS #17），24 个 GUI 用例退出码可信；`npm test` 整链 33 阶段实跑 EXIT=0。
2. **【已解决】release 链是破的**：旧 `dist/` 陈旧且含 106 个 brandlogos、`verify-dist` 实跑 exit 1，预设数还硬编码成 70（会把数量异常推到 exit 2「无法判定」）。现已清空重建（0.1.7 安装包 75.0 MB）、预设/纹理数改为从 `shared/` 实测（OPTIMIZATIONS #18），并新增 `verify:pkg`（`--installers`）对安装包做体积 + sha512 ↔ `latest.yml` 核验，正/负向均验证通过。
3. **【已解决】相框样式路径不读 `exportScale`**：原先 `finalScale=min(1, displayMax/长边)` 封顶，只有 NONE 原图路径能上采样 → 「相框样式 + 4096/8192」拿不到目标尺寸。现在 `engine-styles.js` 在 `app.exportScale` 存在时按目标长边缩放（预览仍只缩不放），`test:fidelity` 已实测 2048 目标下相框输出 2048×1769。
4. **【中】离屏渲染共享单例、不可重入**：缩略图队列、模板库缩略图、导出三条路径都靠「临时改写 `dom.canvas/image/template`」再 `finally` 还原；`queueThumb` 与 `_renderTplThumbs` 并发会互相踩踏（导出因此必须深拷贝模板 + 逐张 flush）。
5. **【中】依赖与可移植性**：`@electron/asar` 未列入 `package.json`（靠 electron-builder 传递依赖）；`measure-drag.js`/`stress.js` 默认目录写死作者机器绝对路径，CI 不可用。
6. **【中】8192 导出内存**：`out` + 可见 canvas + `toDataURL` 三份大缓冲并存（8192² RGBA ≈ 268 MB/张），`getImageData` 调用点还会打断 GPU 加速。九宫格批量已改为「逐张渲染 → 立即写盘」，不再把整批 base64 攒在内存；单张 8192 仍是峰值。
7. **【低】一致性债务**：`syncModelFromUI`/`refreshUI` 两份手工镜像无漏字段保护；`applyGlobalMargin:860` 每次同步从 `refTop` 重算四边、会冲掉单边 margin；undo 栈与 `imageTemplates` 两套历史不联动。草稿里的大 `data:` 图片已外置到 `userData/draft-assets`（草稿只存 `qfasset:` 引用）；头像/自定义图标仍在 localStorage，超配额仍可能静默丢弃。`tools/`、`tests/` 不受 lint 保护。
8. **【低】仓库不干净**：`dist/`（.gitignore 已忽略但仍在盘上）与根目录若干本地日志（`s_err.log`/`debug.log`/`dist-build.log`/`start.log`，均已忽略）混放；原先混入的 `custom-icons.json` 与 `.docx` 已不存在。

## 6. 关键文件速查

| 想改什么 | 去哪里 |
|---|---|
| 新增/改相框风格 | `engine-styles.js` 分发表（3754）+ 风格函数 + `styleDims` 分支 + `style-caps.js` 能力表 |
| 参数语义 / 图层 / 光影 | `engine.js`（60/192/275/427/673/698） |
| 面板控件与状态同步 | `app.js:730 syncModelFromUI`、`:894 refreshUI`、`:1673 setupPanelInteractions` |
| 撤销 / 手势 / 自动保存 | `app-state.js` |
| 渲染调度 / 性能 | `app-render.js` |
| 导出 | `app-export.js` + 主进程 `pick-export-location`/`write-export-files` |
| 模板库 / 预设应用 | `app-templates.js`（`applyPreset:469` 保留用户元素） |
| 工程文件 | `app-qfs.js` + `index.js:226` |
| 预设数据 | `shared/presets/*.json`（须过 `validate-presets`） |
| 发布校验 | `tools/verify-dist.js`（`verify:pkg` = `--installers`，核对安装包 size/sha512 ↔ `latest.yml`） |

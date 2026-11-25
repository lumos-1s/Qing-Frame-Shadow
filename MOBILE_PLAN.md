# 清框影 · 手机版技术方案

> 目标：把现有桌面照片编辑器做成 Android + iOS 都能用的手机 App。
> 范围：第一版必须包含「导入照片 → 套风格 → 存相册」闭环，以及拼图、调色 + 直方图、切图。
> 原则：**引擎复用、UI 重做、本地处理不上传**。AI 破框 / 拾景纸刊 / RAW 全尺寸显影 / 桌面模板文件系统不进第一版。

---

## 一、结论与路线

### 结论

**不需要重写核心。** 现有的渲染引擎、调色算法、拼图/切图逻辑都是纯 JavaScript + Canvas 2D，可以直接搬到手机 WebView 里跑。真正的工作量集中在：

1. 桌面三栏 UI 改成手机单栏 UI；
2. 用移动端插件替掉 `window.qingframe` 的文件/相册 IPC；
3. 大图在手机上的内存与性能控制。

### 推荐路线：Capacitor + 共享 Web 引擎

| 路线 | 说明 | 取舍 |
|---|---|---|
| 纯 PWA | 手机浏览器直接打开，文件走 `<input type=file>`，导出走下载 | 最快，但 iOS「存到相册」体验差，无法上架 |
| **Capacitor（推荐）** | 同一份 Web 代码 + 原生壳，插件接相册/文件/分享 | 双端一套代码，可上架；需要原生构建环境 |
| React Native / Flutter 重写 | 全部原生重写 | 引擎全部重来，成本最高，不推荐 |

**开发方式**：先用浏览器跑手机尺寸页面做日常开发，再用 Capacitor 打包 Android / iOS。两条路共用同一份 `mobile/www`，不是两套代码。

---

## 二、现状复用矩阵

| 模块 | 桌面位置 | 手机版处理 | 工作量 |
|---|---|---|---|
| 渲染引擎 | `src/renderer/js/engine.js`、`engine-styles.js` | **直接复用** | 无 |
| 预设数据 | `shared/presets/*.json`、`presets.js`、`style-caps.js` | **直接复用**，随包内置 | 小 |
| 调色算法 | `app-grade.js`、`app-acr.js`、`app-histogram.js`、`app-clip.js` 等 | **直接复用**，UI 重排 | 小 |
| 拼图逻辑 | `app-puzzle.js` | **直接复用**，交互改触控 | 中 |
| 切图逻辑 | `app-export.js` 的 grid 部分 | **复用切片算法**，导出改分享 | 中 |
| EXIF 读取 | `exif.js`（渲染层已有） | **直接复用** | 无 |
| 色彩空间 | `shared/color-space.js` | **直接复用** | 无 |
| 草稿 / 状态 | `app-draft.js`、`app-state.js` | localStorage → IndexedDB / 沙盒文件 | 中 |
| 文件读写 / 导出 | `window.qingframe` 约 88 处调用 | 用 Capacitor 插件适配约 20 个 MVP 方法 | **大** |
| 主进程 | `src/main/*` | 不进手机版，能力由插件替代 | 大 |
| RAW 解码 | `raw.js` + `libraw-wasm` 主进程线程 | **第一版不做**，导入 RAW 给提示 | 延后 |
| HEIC | `heic-convert` 主进程 | iOS 系统解码优先，失败再 WASM 兜底 | 中 |
| 桌面 UI / CSS | `index.html`、`style.css` | **不复用**，重做手机 UI | **大** |
| AI / 纸刊 | `app-frame-*`、`app-zine-*`、`app-ai-*` | 不进第一版（桌面当前也未发布） | 不做 |

---

## 三、目标目录结构

```text
web-app/
├─ src/                       # 桌面版，原样保留
├─ mobile/
│  ├─ www/
│  │  ├─ engine/              # 构建时从 src/renderer/js 自动同步，禁止手改
│  │  ├─ presets/             # 从 shared/presets 同步
│  │  ├─ ui/                  # 手机专用 UI 与样式
│  │  └─ index.html
│  ├─ src/
│  │  ├─ native.ts            # Capacitor 插件封装：window.qfsNative
│  │  └─ adapters/            # 对齐桌面 window.qingframe 的子集
│  ├─ android/
│  ├─ ios/
│  └─ capacitor.config.ts
└─ tools/
   └─ sync-mobile-engine.js   # 单一真源：同步引擎/预设到 mobile/www
```

**关键约束**：引擎文件只有一份真源（桌面 `src/renderer/js`）。手机版不允许 fork 引擎，否则两边算法会漂移。通过 `sync-mobile-engine.js` 在构建时复制，并在 CI 里校验「同步后无差异」。

---

## 四、原生能力适配

### 4.1 需要替换的 IPC（MVP 子集）

桌面渲染层共约 88 处 `window.qingframe.*` 调用。手机第一版只需实现下面这组，其余用无操作桩或降级：

| 桌面 API | 手机实现 | 用途 |
|---|---|---|
| `openImages` / `collectImages` / `getPathForFile` | Capacitor Photos Picker / 文件选择器 | 导入照片 |
| `readExif` | 渲染层 `exif.js` 直接读 ArrayBuffer | 拍摄参数 |
| `saveImage` / `writeExportFiles` | Filesystem 写临时文件 → Share 或系统相册插件 | 导出到相册 |
| `getPrefs` / `savePrefs` | Capacitor Preferences / localStorage | 偏好 |
| `listTemplates` / `loadTemplate` / `saveTemplate` | Filesystem（App 沙盒 `templates/`） | 我的样式 |
| `listLogos` / `listTextures` | 随包资源 + 沙盒用户目录 | Logo / 纹理池 |
| `externalizeDraft` / `hydrateDraft` | Filesystem + IndexedDB | 草稿大图外置 |
| `isMac` / `platform` / `getAppInfo` | Capacitor Device / 常量 | 文案与快捷键 |
| `onExportProgress` | 进程内事件总线 | 批量切图进度 |

> 注意：桌面端「导出到自选文件夹」在手机上没有对应概念。统一改成「保存到相册」+「系统分享」，不再暴露路径。

### 4.2 平台差异

| 项 | Android | iOS |
|---|---|---|
| 选图 | Photo Picker / SAF，权限较宽松 | PHPicker，拿到的是临时 URL，需立刻复制进沙盒 |
| 存相册 | MediaStore 写入或系统分享 | 需 `NSPhotoLibraryAddUsageDescription`，用相册插件或分享表单兜底 |
| 大图内存 | 限制预览长边 2000px，导出分片 | 更严：预览 1600px，导出用 Worker + 分块 |
| 后台 / 线程 | Web Worker 可用 | WebView 的 Worker 可用但内存受限 |
| 分发 | APK / Play 商店 | TestFlight / App Store，需开发者账号 |

---

## 五、手机 UI 设计

### 5.1 信息架构

底部 4 个常驻标签：

```text
[风格] [拼图] [调色] [切图]     右上：设置 / 我的样式
```

- **风格**：顶部照片预览（约 55% 高度）→ 下方横向风格卡列表 → 底部「应用 / 导出」。
- **拼图**：布局选择横滑 → 格子画布 → 底部相册抽屉；选中格子弹底部动作条（换图 / 旋转 / 复位 / 清空）。
- **调色**：直方图固定在参数区顶部 → LR 式可折叠分组 → 「溢出」按钮替代桌面 `J` 键 → 「自动」按钮。
- **切图**：九宫格预览全宽 → 每块勾选框放大到 28px → 「导出选中块」走系统分享。

### 5.2 交互约束

- 触控目标 ≥ 44×44px；滑块轨道高度 ≥ 32px；正文 ≥ 14px。
- 桌面快捷键全部改成可见按钮：`J` → 「溢出」，`Ctrl+D` → 「同步」，`Ctrl+Z/Y` → 屏幕按钮或摇一摇撤销。
- 预设墙的无限滚动 / Ctrl+滚轮缩放改成普通网格 + 分类筛选，不做惯性动画。
- 所有弹窗改成底部抽屉（bottom sheet），不用桌面居中 modal。
- 导入后先压缩预览，不把原图完整解码进 DOM 树。

---

## 六、数据与导出

- **预设**：91 个风格 JSON 与封面随包内置，不联网。
- **用户数据**：模板、Logo、偏好、草稿全部在 App 沙盒；无账号、无遥测、无上传。
- **导出**：JPEG / PNG / WebP，质量与长边档位沿用桌面逻辑；EXIF 写入第一版先关闭（iOS 限制多），第二版再补。
- **拼图/切图导出**：多张结果先生成到临时目录，再调系统分享面板；不假装「保存到文件夹」。

---

## 七、阶段拆解（单人估算）

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 骨架 | Capacitor 工程、引擎同步脚本、浏览器预览壳 | 3–5 天 |
| P1 原生适配 | 约 20 个 IPC 插件适配、导入/导出闭环 | 1–2 周 |
| P2 风格页 | 手机 UI、风格列表、预览、存相册 | 1.5 周 |
| P3 拼图 | 布局横滑、底部相册抽屉、格子动作条 | 1 周 |
| P4 调色 | 直方图、滑块分组、溢出按钮、自动调色 | 1–2 周 |
| P5 切图 | 九宫格预览、勾选导出、系统分享 | 1 周 |
| P6 双端打磨 | iOS 权限、Android 存储、性能、回归测试 | 1–2 周 |

**合计约 7–9 周**。如果第一版只做「风格 + 调色」，可压到 4–5 周；拼图和切图可以放到 1.1 版。

---

## 八、主要风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 大图内存爆掉（24MP × 多图） | App 闪退 | 预览限制 1600–2000px；导出分块；同时只保留 1 张全尺寸 |
| iOS 存相册权限 / 临时 URL 失效 | 导出失败 | 选图后立即复制进沙盒；相册权限与系统分享双通道 |
| 桌面/手机引擎分叉 | 两边效果不一致 | 引擎单一真源 + CI 同步校验 |
| 88 处 IPC 漏改 | 功能静默失效 | 建立适配层清单，未实现方法统一打日志并降级，不静默返回空 |
| 审核周期 / 开发者账号 | 上线延期 | 先 TestFlight / 内测分发，不把上架时间绑死在 MVP |
| RAW 不支持被用户抱怨 | 差评 | 导入 RAW 时明确提示「手机版暂不支持 RAW，请用桌面版」 |

---

## 九、验收标准（第一版）

1. Android + iOS 都能：导入照片 → 选风格 → 导出到相册 / 系统分享，全链路不联网。
2. 拼图：4 格布局可换图、旋转、复位、清空，导出成品图。
3. 调色：滑块可改参数，直方图实时刷新，「溢出」按钮能标出过曝/压黑。
4. 切图：九宫格预览、勾选块、逐块分享。
5. 预览长边控制在 2000px 内，连续切换 20 张照片不闪退。
6. 引擎文件与桌面 `src/renderer/js` 对比无差异。

---

## 十、待你拍板的决策

1. **是否接受「第一版不支持 RAW」**（强烈建议接受，否则工期翻倍）。
2. **是否第一版就上架**，还是先 TestFlight / 内测分发跑 2 周。
3. **手机 App 是否保留 AI / 纸刊入口**：建议隐藏，等桌面端正式发布后再决定。
4. **「我的样式」是否第一版就要云同步**：建议不要，本地沙盒即可，保住「不上传」卖点。

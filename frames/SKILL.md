---
name: qfs-frame
description: 为「清框影」设计照片边框。当你需要生成、修改、调整一个边框样式时读它——它讲清边框描述文件的格式、可用风格、设计原则，以及如何自检和预览。
---

# 清框影 · 边框设计

一个「边框」是一份**完整的预设 JSON**，清框影能直接加载它，你也能直接编辑它。
文件放在 `frames/` 下，如 `frames/my-frame.json`。你改的就是真预设，没有第二套格式。

## 硬规则（先读）

1. **本地优先**：原图永远不上传。预览需要看图时用 `--image <本地路径>`，只读本机文件，不联网。默认用内置合成图，完全不碰用户照片。
2. **只改 frame 文件**：不要改引擎源码（`engine.js` / `engine-styles.js`）或内置预设（`shared/presets/`）。你的产物就是 `frames/*.json`。
3. **改完必须自检**：`check` 体检 + `preview` 看效果，两关都过再交付。
4. **不写不认识的参数**：字段与取值范围以本文件和 `style-params.js` 声明表为准。

## 工作流

```sh
# 1) 从一个内置风格拷一份底稿出来（按风格名或预设名）
node tools/run-electron.js tools/qfs-frame.js init 圆角卡片 -o frames/my-frame.json

# 2) 编辑 frames/my-frame.json（见下方字段说明）

# 3) 体检：结构 / 风格名 / 参数范围 / 默认值，毫秒级
node tools/qfs-frame.js check frames/my-frame.json

# 4) 预览：用真实引擎套到合成图或用户图，输出 PNG
node tools/run-electron.js tools/qfs-frame.js preview frames/my-frame.json -o frames/my-frame.png
node tools/run-electron.js tools/qfs-frame.js preview frames/my-frame.json --image /本地/照片.jpg -o frames/my-frame.png
```

`init` / `preview` 需要 Electron（`run-electron.js` 包装），`check` 是纯 Node 直接跑。

## 边框文件里你能改的字段

一份预设 JSON 的骨架（值仅示例）：

```json
{
  "templateName": "我的边框",
  "photoFrameStyle": "CARD_3D",
  "baseMargin": {
    "marginTop": 80, "marginBottom": 120, "marginLeft": 80, "marginRight": 80,
    "imgScale": 0.92, "imgOffsetX": 0, "imgOffsetY": 0,
    "bgBlurEnable": 0, "bgBlurRadius": 30
  },
  "cornerConfig": { "cornerRadiusAll": 18 },
  "layerList": [ { "fillConfig": {...}, "strokeConfig": {...}, "shadowGlowConfig": {...} } ],
  "styleParams": { "CARD_3D": { "padX": 18, "thick": 2.5 } },
  "userSignature": "留白 · 2026",
  "manualExif": { "brand": "CANON", "model": "EOS R5", "focal": "50mm", "aperture": "f/2.8", "iso": "ISO 400", "shutter": "1/125" }
}
```

- **`templateName`**：你的边框叫什么。
- **`photoFrameStyle`**：走哪套绘制引擎，取值必须是下面的风格名之一，留空则走传统「图层边框」管线（`baseMargin`/`layerList` 决定样子）。
- **`baseMargin`**：四周留白（px）、图片缩放（`imgScale`，1=原尺寸）、偏移、背景模糊开关与半径。
- **`cornerConfig`**：圆角，`cornerRadiusAll` 或四角 `cornerRadiusTL/TR/BL/BR`。
- **`layerList`**：图层边框的底/描边/阴影。每项含 `fillConfig`、`strokeConfig`、`shadowGlowConfig`。
- **`styleParams`**：风格私有参数，按风格名分命名空间；字段是百分数整数，引擎自动除以 100。范围见 `style-params.js` 的 `TABLE`（`check` 会校验，越界会报错）。
- **`userSignature` / `manualExif`**：签名文字与相机参数；很多风格会把它画到画面上。

## 可用风格（96 种，`photoFrameStyle` 取值）

基础与卡片：
SIMPLE, SIMPLE_FILM, WHITE_PLAIN, ROUNDED, GALLERY_MAT, DROP_SHADOW, FOLD_CORNER, TEARED_PAPER, TORN_JOURNAL,
CARD_3D, CARD_SIMPLE, CARD_APPLE, CARD_LEICA, CARD_IMMERSION, CARD_LOGO_PARAM, CARD_PURE_LOGO,

胶片与相机：
FILM_STRIP, FILM_TEAR, VHS_TAPE, DOUBLE_EXPOSURE, BURNED_EDGE, CYANOTYPE, PRISMATIC, LIQUID_GLASS,
CAMERA_PLATE, PARAM_CREDIT, PHOTO_CREDIT, PARAM_STRIP, PARAM_BOTTOM_LEFT, PARAM_BOTTOM_SINGLE, PARAM_TOP_LEFT,
OVERLAY_PARAM_LEFT, OVERLAY_PARAM_RIGHT, OVERLAY_PARAM_BOTTOM, OVERLAY_LOGO_BOTTOM, WM_CLASSIC, WM_SINGLE,
WM_BRAND_LOGO, WM_AI, FUJI_WHITE, FUJI_WM, FUJI_WM_BRAND, HASSELBLAD, XIAOMI_IMP, XIAOMI_LEICA, DARK_BRAND_ONLY,

签名/背景模糊：
SIGNATURE, SIGN_PARAM, SIGN_BLUR, SIG_BLUR, AVATAR_MEMO, AV_BLUR, BLUR_CLASSIC, BLUR_DATE,
AV_OVERLAY, AV_OVERLAY_BC, AV_OVERLAY_BC2, AV_OVERLAY_BR, AV_OVERLAY_TR,

邮票/票根：
STAMP_POSTAGE, STAMP_KRAFT, STAMP_BLUEPRINT, STAMP_REDSEAL, STAMP_GOLD, TICKET_STAMP, TICKET_VINTAGE,
TICKET_SCRAP, TICKET_CONCERT, MOVIE_TICKET, BOARDING_PASS, WAX_SEAL,

艺术/氛围：
ALBUM_CORNER, ART_CARD, COLOR_CLASSIC, COLOR_PALETTE, COLOR_REFINED, COMIC_PANEL, POP_COMIC, CYBER_GLITCH,
INK_WASH, MAGAZINE_COVER, MAGAZINE_HEADER, MAGAZINE_MASTHEAD, NEON_GLOW, NEWSPAPER, OIL_BRUSH, PINBOARD_TAPE,
POLAROID, POLAROID_HAND, PRESSED_FLOWER, VINTAGE, WATERCOLOR_BLEED, IMP_CLASSIC, IMP_FROSTED, DOUBLE_LINE, GRADIENT

> 完整且最新的列表永远以 `src/renderer/js/style-caps.js` 的 `MEASURED` 为准；`check` 会校验。

## 设计原则（暗房质感，别做成网页仪表盘）

- **克制**：发丝线分隔、小圆角（控件 3–4px、卡片 8px）、等宽数字、暖灰/墨绿/金色配色。不要渐变发光、大圆角、玻璃拟态、emoji 图标。
- **主次分明**：一种绿色强调主操作；金色只用于品牌/选中/装饰线，不滥用。
- **留白**：边距宁大勿小，让照片呼吸；信息带贴底、不压主体。
- **文字**：签名能短则短；相机参数一行排开，用 `·` 或空格分隔，别堆成段落。

## 自检与交付

每次交付前跑：
```sh
node tools/qfs-frame.js check frames/my-frame.json          # 必须「✓ 通过」
node tools/run-electron.js tools/qfs-frame.js preview frames/my-frame.json -o frames/my-frame.png
```
- `check` 若报「风格不在已知表」→ 换一个上面的风格名。
- `check` 若报「参数越界」→ 按提示的 `[min,max]` 调整。
- `preview` 若打印「渲染警告/错误」→ 多半是风格画不出来，换底子或简化图层。
- 看一眼 PNG：文字有没有出框、留白是否匀、颜色是否协调；不满意就回到第 2 步改。

改完告诉我文件路径和预览图，说清楚你调了什么、为什么。

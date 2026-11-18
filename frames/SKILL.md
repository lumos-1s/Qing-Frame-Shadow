---
name: qfs-frame
description: 为「清框影」设计照片边框。当你需要生成、修改、调整一个边框样式时读它——它讲清「图层边框」JSON 的格式、图层顺序、照片槽位与文字约束。
---

# 清框影 · 图层边框设计

一个「边框」是一份 **图层 JSON**：`{ "templateName": "名字", "layers": [ ... ] }`。
清框影直接把它当模板套到用户照片上——照片、调色、裁切、撤销都不会被破坏。
文件放在 `frames/` 下，如 `frames/a1.json`。

**不要改引擎源码，也不要改内置预设。你的产物只有 `frames/*.json`。**

## 硬规则（先读）

1. **必须有且只有一个 `photo` 图层**：它就是照片的位置和大小，画布比例由它决定。
2. **顺序就是层级**：`photo` 之前的图层在照片下面（底色 / 卡纸 / 背景），`photo` 之后的图层在照片上面（文字 / 线条 / 装饰）。
3. **坐标是 0..1 的比例**，相对画布宽高；不要写像素。
4. **文字必须带 `maxW` 和 `maxLines`**，`size` 不超过 `0.06`（相对画布高），否则会被引擎强制缩字/截断。
5. **写完必须跑 `qfs-frame check`**：0 错误才算完成；再用 `preview` 出图看一眼。体检口径与引擎同源，会抓多/缺 `photo`、未知图元、错名字段（`width`/`fontSize` 这种会被静默忽略）、文字缺 `maxW`/`maxLines`、`size` 超限、越界、大面积盖照片。

## 命令

在仓库根目录：

```sh
node tools/qfs-frame.js                      # 打印本手册
node tools/qfs-frame.js init --blank "名字" -o frames/a1.json   # 起一份能过体检的图层骨架
node tools/qfs-frame.js check frames/a1.json # 体检；也可 check frames 整批
node tools/qfs-frame.js preview frames/a1.json                  # 出 frames/a1.preview.png
node tools/qfs-frame.js preview frames --image photo.jpg -o .tmp/previews  # 真实照片 + 整批
```

`preview` 内部会自动转交 Electron，直接 `node` 调用即可；不给 `--image` 时用内置合成底图。

## 图元格式

```json
{ "type": "photo", "x": 0.08, "y": 0.08, "w": 0.84, "h": 0.70, "radius": 0.01, "fit": "cover" }
{ "type": "rect", "x": 0.05, "y": 0.05, "w": 0.90, "h": 0.90, "radius": 0.02,
  "fill": "#ffffff", "fillOpacity": 0.9, "stroke": "#dcba79", "strokeWidth": 2 }
{ "type": "circle", "cx": 0.5, "cy": 0.2, "r": 0.08, "fill": "#129e78" }
{ "type": "line", "x1": 0.1, "y1": 0.5, "x2": 0.9, "y2": 0.5, "color": "#dcba79", "width": 2, "dash": [4, 4] }
{ "type": "text", "x": 0.5, "y": 0.92, "text": "QINGFRAME", "size": 0.03, "color": "#f2e4c4",
  "align": "center", "weight": 600, "letterSpacing": 0.1, "maxW": 0.8, "maxLines": 1 }
```

- `radius`：小于 1 按短边比例，大于等于 1 按像素；不写就是直角。
- `fillOpacity` / `opacity`：0..1；`shadow: {color, blur, offsetX, offsetY, opacity}` 可选。
- 颜色支持 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`。
- `fit`：`cover`（默认，裁切铺满）或 `contain`（完整放进槽位）。
- `line` 的 `dash` 是像素单位。

## 文字约束

- `size`：相对画布高，建议 0.02–0.05；引擎硬夹到 6px–20% 画布高。
- `maxW`：这一行最宽能占画布的比例，建议 0.6–0.9。
- `maxLines`：最多几行；超出会缩字号、再截断成 `…`。
- `align`：`left` / `center` / `right`；`x` 是对齐锚点。
- `letterSpacing`：相对字号的比例（>1 视为像素）。

## 构图原则（暗房质感，别做成网页仪表盘）

- **留白**：photo 槽位不要贴着画布边，四周至少留 4%–10%；底部信息带可以多留。
- **克制**：发丝线、小圆角、暖灰/墨绿/金色；不要渐变发光、玻璃拟态、emoji 图标。
- **主次**：照片是主体，装饰只做画框和签名；不要把大面积色块盖在照片上。
- **文字**：一行能说完就别两行；日期 / 相机参数用 `·` 或空格分隔。
- **四款要明显不同**：配色、留白比例、装饰语言至少两项不同，不要只改一行文字。

## 交付

在 `frames/` 下写 `a1.json` / `a2.json` / `a3.json` / `a4.json`，每份一个完整对象：

```json
{
  "templateName": "暖色胶片",
  "layers": [
    { "type": "rect", "x": 0.04, "y": 0.04, "w": 0.92, "h": 0.92, "fill": "#f6efe0" },
    { "type": "photo", "x": 0.08, "y": 0.08, "w": 0.84, "h": 0.70 },
    { "type": "line", "x1": 0.12, "y1": 0.84, "x2": 0.88, "y2": 0.84, "color": "#b9945f", "width": 1 },
    { "type": "text", "x": 0.5, "y": 0.90, "text": "2026 · 杭州", "size": 0.028,
      "color": "#6b5636", "align": "center", "maxW": 0.78, "maxLines": 1 }
  ]
}
```

交付前：`check` 全部 0 错误，`preview` 的图自己看过一遍。回复只写「完成」+ 文件路径 + 一句设计说明，不要输出 JSON 正文。

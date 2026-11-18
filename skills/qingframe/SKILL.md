---
name: qingframe
description: 为「清框影」设计、生成、修改照片边框。当用户想要一个新边框、调整现有边框样式、换风格、改留白/圆角/签名/配色，或问怎么用 AI 做边框时，读这份说明并按它的工作流做。
---

# 清框影 · 边框设计

清框影是一个本地照片加框工具。一个「边框」是一份 **图层 JSON**：
`{ "templateName": "名字", "layers": [ ... ] }`。App 直接把它当模板套到用户照片上，照片、调色、裁切、撤销都不会被破坏。

## 先读手册

在清框影仓库根目录运行：

```sh
node tools/qfs-frame.js
```

它会打印完整手册（图元格式、图层顺序、照片槽位、文字约束、构图原则）。手册的唯一来源是 `frames/SKILL.md`，不会过时。

## 工作流：写 → 体检 → 看图 → 再改

每一步都有命令可验，不要写完就交。

```sh
# 1) 起稿：拿到一份「出生就能过体检」的图层骨架
node tools/qfs-frame.js init --blank "暖灰胶片" -o frames/a1.json

# 2) 改 layers（配色 / 留白 / 圆角 / 文字），photo 有且只有一个

# 3) 体检：0 错误才算过；以 ! 开头的是提醒，逐条判断
node tools/qfs-frame.js check frames/a1.json
#    一次检查整批：node tools/qfs-frame.js check frames

# 4) 出图：写成 frames/a1.preview.png，用眼睛看
node tools/qfs-frame.js preview frames/a1.json
#    有真实照片时：--image /path/to/photo.jpg
#    要看四款对比：node tools/qfs-frame.js preview frames -o .tmp/previews

# 5) 对着图改留白/字号/颜色，回到 3，直到 check 干净、图也顺眼
```

`check` 的判定口径与 App 渲染同源（复用引擎的图层规范化），会抓：
多个/缺失 `photo`、未知图层类型、错名字段（`width`/`fontSize` 这类会被引擎静默忽略）、
文字缺 `maxW`/`maxLines`、`size` 超上限、超出画布、不透明块盖住照片。

`preview` 直接 `node` 调即可（内部自动转交 Electron）；没给 `--image` 时用内置合成底图。

## 硬规则

- **本地优先**：原图永不上传，不联网。
- **只改 `frames/*.json`**：不要改引擎源码（`engine.js` / `engine-styles.js`）或内置预设（`shared/presets/`）。
- **暗房质感**：发丝线、小圆角、暖灰/墨绿/金、克制留白；不用渐变发光、玻璃拟态、emoji 图标。
- **不遮照片**：照片是主体，装饰只做画框和签名，不要把大面积色块盖在照片上。
- **四款要明显不同**：配色、留白比例、装饰语言至少两项不同，不要只改一行文字。
- **交付**：告诉用户文件路径 + 一句设计说明；不要贴 JSON 正文。

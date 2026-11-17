---
name: qingframe
description: 为「清框影」设计、生成、修改照片边框。当用户想要一个新边框、调整现有边框样式、换风格、改留白/圆角/签名/配色，或问怎么用 AI 做边框时，读这份说明并按它的工作流做。
---

# 清框影 · 边框设计

清框影是一个本地照片加框工具。一个「边框」就是一份**完整的预设 JSON**，App 能直接加载、你能直接编辑，没有第二套格式。

## 先读手册

在清框影仓库根目录运行下面的命令，它会打印**完整手册**（字段格式、96 种风格、设计原则、工作流、硬规则）。动手前完整读一遍：

```sh
node tools/qfs-frame.js
```

> 手册的唯一来源是 `frames/SKILL.md`，上面的命令直接打印它，不会过时。

## 工作流（摘要，细节见手册）

```sh
# 1) 从内置风格拷一份底稿到 frames/
node tools/run-electron.js tools/qfs-frame.js init 圆角卡片 -o frames/my-frame.json

# 2) 编辑 frames/my-frame.json

# 3) 体检：结构 / 风格名 / 参数范围 / 默认值
node tools/qfs-frame.js check frames/my-frame.json

# 4) 预览：真实引擎渲染，可用 --image 指定本地照片
node tools/run-electron.js tools/qfs-frame.js preview frames/my-frame.json -o frames/my-frame.png
```

改完必须 `check` 通过、`preview` 看过效果，再告诉用户文件路径与预览图。

## 硬规则

- **本地优先**：原图永不上传；`--image` 只读本地文件、不联网。默认用内置合成图。
- **只改 `frames/*.json`**：不要改引擎源码（`engine.js` / `engine-styles.js`）或内置预设（`shared/presets/`）。
- **暗房质感**：发丝线、小圆角、暖灰/墨绿/金、克制留白；不用渐变发光、玻璃拟态、emoji 图标。
- **自检后交付**：两关（check + preview）都过再说完成。

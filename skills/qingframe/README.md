# 把「清框影边框设计」装给 coding agent

这个 skill 教 agent 怎么用 AI 工作流设计清框影的边框（init → 编辑 → check → preview）。
它是标准的 **Agent Skill** 格式（SKILL.md + YAML frontmatter），兼容 `npx skills add`。

## 方式一：在清框影仓库里直接用（现在就能用）

如果 agent 的工作目录就是本仓库，它会直接读到 `skills/qingframe/SKILL.md`；
或者你直接把那份文件的内容交给 agent。它要用的 CLI 就在本仓库：

```
tools/qfs-frame.js             ← init / check / preview 三个子命令
frames/SKILL.md                ← 完整手册（CLI 不带参数时打印的就是它）
```

`init --blank` 出图层骨架，`check` 按引擎口径验图层 JSON（0 错误才算过），
`preview` 用真实引擎出 PNG（直接 `node` 调用即可，内部自动转交 Electron）。

最简单：让 agent 在仓库根运行 `node tools/qfs-frame.js`，它会打印完整手册并照着做。

## 方式二：用 npx skills 安装（发布后）

仓库公开到 GitHub 后（例如 `https://github.com/<你>/Qing-Frame-Shadow`），agent 可装：

```sh
npx skills add <你>/Qing-Frame-Shadow
```

它会扫描仓库根的 `skills/*/SKILL.md`，把 `qingframe` 这个 skill 装进 agent。
`npx skills add <本地路径>` 也支持从本地目录安装。

> 注意：skill 安装后，agent 仍需要能访问 `tools/qfs-frame.js` 与 `frames/`（即清框影仓库）
> 才能执行 CLI。所以目前它面向「在清框影仓库内工作的 agent」；未来若要让任意项目里的 agent
> 用，需要把 CLI 作为 npm 包发布（`npx qfs-frame`），届时入口 skill 改成调用包名即可。

## 这个 skill 做什么 / 不做什么

- 做：设计边框 JSON、校验参数、用真实引擎渲染预览、按暗房原则给建议。
- 不做：上传原图、改引擎源码、碰用户其它照片。全程本地。

# 第三方素材声明 · Third-Party Assets Notice

本文件说明「清框影 / QINGFRAME」仓库中**哪些内容适用 MIT 许可、哪些不适用**。

This file explains which parts of the Qingframe / QINGFRAME repository are covered by
the MIT License and which are not.

---

## 1. 代码适用 MIT

`src/` 下的全部源代码，以及仓库根目录的 `LICENSE`（MIT License,
Copyright (c) 2026 lumos-1s），适用 MIT 许可。

## 2. 品牌 Logo 图形不适用 MIT

第三方品牌 Logo **不存放在本仓库内**。软件运行时只从用户数据目录读取：

```
%APPDATA%\qingframe-web\brandlogos      (Windows)
~/Library/Application Support/qingframe-web/brandlogos   (macOS)
```

该目录由用户自行导入（「Logo → 导入 Logo 素材包」），全新克隆或全新安装时为空，
软件照常运行，只是「品牌 Logo」选择组为空、「按品牌自动配 Logo」不生效。

工程目录下可选的 `shared/brandlogos/` 仅作本地开发占位，已被 `.gitignore` 忽略，
并被 `package.json` 的 `build.files` 中 `!shared/brandlogos/**` 排除出发行版；
`tools/verify-dist.js` 会在打包链路里扫描 app.asar，发现任何 Logo 即中止发布。

这些图形涉及的**商标权与美术作品著作权归各自权利人所有**
（Canon、Nikon、SONY、FUJIFILM、Leica、Hasselblad、RED、Apple、Samsung、Xiaomi 等）。

- 这些图形**仅用于在成品照片上标识该照片的拍摄设备**（依据照片 EXIF 中的品牌信息），
  属于对商标的指示性使用；
- 本软件为个人独立开发，**与上述任何品牌均无授权、合作、赞助或隶属关系**；
- 本软件**不代表**任何品牌方，也未获得任何品牌方的认可或授权；
- 若你要对外分发含品牌 Logo 的版本，请自行取得相应权利人的许可。

## 3. 纹理素材

`shared/textures/` 目录中的纹理素材**同样不在 MIT 许可范围内**，其权利归各自权利人
所有。该目录当前随发行版一起分发；如你计划公开发布本软件，建议一并核实这些素材的
来源与授权条款，或替换为可自由使用的素材。

## 4. 内置模板

`shared/presets/` 目录中的 90 个模板为本项目原创的 JSON 参数描述，适用 MIT 许可。
（模板中不内嵌任何第三方图形。）

---

## 3. ACR 实测查找表（`shared/acr/cr-tables.bin`）— MIT

`shared/acr/cr-tables.bin` 是 Photoshop「Camera Raw 滤镜」在各滑块各档位下
对 17³ 色格的实测输出表（763 张，zlib 重压缩）。原始数据来自开源项目
**Compositor**（https://github.com/robbietilton/Compositor ，Wonder Assembly LLC），
依 **MIT License** 发布；本仓库仅做格式转换（LZMA → zlib）与运行时解码
（`src/renderer/js/app-acr.js`），用于让调色管线与 Photoshop 的实测行为对齐。

依 MIT 许可要求，分发本软件时需保留上述出处与许可声明（见仓库根目录 `LICENSE`）。

---

## 5. RAW 解码：LibRaw / libraw-wasm — LGPL-2.1 / CDDL，不影响本仓库 MIT

`libraw-wasm`（ISC License）把 [LibRaw](https://www.libraw.org/) 编译成 WebAssembly，
由主进程在独立线程里调用，用于解码相机 RAW。LibRaw 本身是 **LGPL-2.1 / CDDL 1.0 双许可**。

- 本项目**不修改** LibRaw 源码，只把它当作独立的 WASM 模块加载、按公开 API 调用；
- 它作为独立依赖随安装包分发，源码可从 <https://www.libraw.org/download> 或
  <https://github.com/LibRaw/LibRaw> 获取；
- 该模块与主程序之间只有「传文件路径、参数，取回像素」这一层数据接口，
  替换或重新编译 `node_modules/libraw-wasm/dist/libraw.wasm` 不需要改动应用其余部分。

因此 `src/` 下的代码仍整体适用 MIT；LibRaw 部分遵循其自身许可。

## English Summary

- **Code** (`src/`, MIT License): free to use under the terms of `LICENSE`.
- **Brand logos**: trademarks and artwork belong to their respective owners.
  **No brand logo ships with this repository or the installers.** At runtime the app
  reads `brandlogos/` inside the user-data directory only, populated by the user via
  「Import logo pack」. `shared/brandlogos/` in the project tree is optional, git-ignored,
  and excluded from builds via `build.files` (`!shared/brandlogos/**`); `tools/verify-dist.js`
  scans the packaged app.asar and aborts the release if any logo is found. Marks are
  rendered solely to indicate the camera that took a photo, based on its EXIF metadata.
  This software is an independent personal project and is **not affiliated with,
  authorized by, sponsored by, or endorsed by** any of the brands referenced.
- **`shared/textures/`**: not covered by the MIT License; rights belong to their
  respective owners. Verify the source and licensing of these assets before public
  distribution.
- **`shared/presets/`**: original parameter descriptions by this project, MIT licensed.
- **RAW decoding**: `libraw-wasm` (ISC) wraps [LibRaw](https://www.libraw.org/)
  (LGPL-2.1 / CDDL 1.0). It is loaded as an unmodified, separate WASM module;
  the MIT license of this repository's own source is unaffected.
- **`shared/acr/cr-tables.bin`**: measured Camera Raw color tables from the
  [Compositor](https://github.com/robbietilton/Compositor) project (MIT License,
  Copyright (c) 2026 Wonder Assembly LLC), repacked from LZMA to zlib. Used to align
  the grading pipeline with Photoshop's measured Camera Raw Filter behavior.

---

*本文件仅为素材归属说明，不构成法律意见。如需商用或公开分发，请咨询专业知识产权律师。*

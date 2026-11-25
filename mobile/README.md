# 清框影 · 手机版工程

> 状态：**P0 骨架已完成**。Capacitor 8 + Android / iOS 原生壳已生成，Web 引擎从桌面端单向同步；四个底部页签可切换，Canvas 可用。

## 目录

```text
mobile/
├─ www/                   # 手机 Web 页面（Capacitor webDir）
│  ├─ js/                 # 由 tools/sync-mobile-engine.js 同步，禁止手改
│  ├─ presets/            # 由同步脚本复制的 91 个预设 JSON
│  ├─ css/mobile.css      # 手机专用样式
│  └─ index.html
├─ android/               # Capacitor Android 工程（生成物已按 Capacitor 规则忽略）
├─ ios/                   # Capacitor iOS 工程
├─ capacitor.config.json
└─ package.json
```

## 常用命令（在项目根目录执行）

```bash
npm run mobile:sync     # 把桌面引擎/预设同步到 mobile/www
npm run mobile:check    # 校验同步无差异（check:chain 会自动跑）
npm run mobile:serve    # 浏览器预览手机页面 http://localhost:4173
npm run test:mobile     # P0~P5 冒烟测试（需先启动 mobile:serve，RAW 桥走 ES module）
npm --prefix mobile run cap:sync    # 同步 Web 资产到原生工程
```

原生打包：

```bash
npm --prefix mobile run cap:android   # 首次添加 Android 工程（已完成）
npm --prefix mobile run cap:ios       # 首次添加 iOS 工程（已完成）
cd mobile && npx cap open android     # 需要 Android Studio
cd mobile && npx cap open ios         # 需要 macOS + Xcode
```

## 规则

1. `mobile/www/js/` 里的引擎文件**只能由同步脚本生成**，不要直接改；要改算法请改 `src/renderer/js/`，再跑 `npm run mobile:sync`。
2. 手机 UI 只写在 `mobile/www/css/mobile.css` 和 `mobile/www/js/mobile.js`，与桌面 `style.css` 分叉。
3. 第一版不引入 AI / 纸刊 / 样式云同步；RAW 支持见根目录 `MOBILE_PLAN.md` 第 4.3 节。

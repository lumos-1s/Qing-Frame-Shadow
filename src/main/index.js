const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, nativeImage, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const zlib = require('zlib');
const { createStateStore } = require('./state');
const { safeLeafName, safeExportName, autoExportTarget, EXPORT_EXTS } = require('./export-path');
const { normalizeMirror, mirrorUrlFor, downloadVerified, releaseAssetUrl } = require('./update-mirror');
const { normalizeAutoCheck, shouldAutoCheck } = require('./update-policy');
const { importLogoPack } = require('./logo-pack');
const gradePresetStore = require('./grade-preset-store');

// 仓库改名后统一从这里取,避免菜单 / 更新源 / 下载兜底 / 外链白名单各写一份。
const REPO_URL = 'https://github.com/lumos-1s/Qing-Fram-Shadow';
const REPO_PATH = '/lumos-1s/Qing-Fram-Shadow';

// 打包版与开发版数据隔离:发布版用独立 userData,首次启动头像/用户名等默认全空,
// 也不会读到开发机(含开发者自己)已保存的旧登录数据。
if (app.isPackaged) {
    app.setPath('userData', path.join(app.getPath('appData'), 'qingframe-web-release'));
}

// EXIF 解析:独立模块(src/main/exif-read.js)。只读文件头部而不整读照片,
// 拆出来是为了能用纯 node 直接验证"头部解析 == 整文件解析"。
const { readExif, readIccName } = require('./exif-read');
// EXIF 写回:导出 JPEG 时把原图 EXIF 移植进成品(默认剥 GPS),任何失败静默回退。
const exifWrite = require('./exif-write');
// HEIC/HEIF 解码:Chromium 不支持 HEIC,主进程转 JPEG 后经 qflocal:// 交给渲染进程。
const { isHeic, heicFileToJpeg, HEIC_EXTS } = require('./heic');
// HEIC 的 EXIF 走 exifr(自定义 exif-read 只认 JPEG);输出与 exifSummary 同字段。
const { readHeicExif } = require('./heic-exif');
// RAW 解码/显影:libraw-wasm 跑在常驻 worker 线程里,主进程只负责调度与落缓存。
const { isRaw, RAW_EXTS, develop: developRaw, setCacheRoot: setRawCacheRoot, dispose: disposeRaw } = require('./raw');
const { readRawExif } = require('./raw-exif');
const { imageSize } = require('./image-size');
const { ensureBuffer: ensurePngSrgb } = require('../shared/png-srgb');

// 照片导入支持的扩展名(HEIC 由主进程解码,对渲染进程透明)
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp']
    .concat(HEIC_EXTS.map(e => e.slice(1)))
    .concat(RAW_EXTS);
const IMAGE_FILTERS = [
    { name: '图片与 RAW', extensions: IMAGE_EXTS },
    { name: 'RAW', extensions: RAW_EXTS }
];
// 单张图上限:文件 512MB / 像素 200MP。超过后在导入阶段就拒绝,
// 避免浏览器解码时直接 OOM(8192 导出本身已经要 3 份大缓冲)。
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 200 * 1000 * 1000;
const imageRejectReason = (filePath, size) => {
    if (size > MAX_IMAGE_BYTES) return '文件超过 512MB';
    const dim = imageSize(filePath);
    if (dim && dim.width * dim.height > MAX_IMAGE_PIXELS) return '像素超过 2 亿';
    return '';
};
const SERVABLE_IMAGE_EXT = new Set(IMAGE_EXTS.map(e => '.' + e.toLowerCase()));

// 渲染进程通过 qflocal:// 协议在磁盘上直接读取照片(不经过 base64 过 IPC,节省内存)。
// 协议只服务"主进程见过的图片文件":路径来自文件选择框/拖放/剪贴板/封面目录,
// 或 read-exif 校验过的图片;任何非图片扩展名一律拒绝。corsEnabled 防止旧版
// Chromium 把自定义协议当成可跨域读取的 file:// 代理。
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

// 允许被 qflocal 读取的图片(realpath 小写)。XSS 即使能构造 qflocal URL,
// 也只能读到用户本次确实导入过/校验过的图片,不能顺手读 .ssh、.env 等文件。
const servedImagePaths = new Set();
const imageKey = (p) => process.platform === 'win32' ? String(p).toLowerCase() : String(p);
const allowImagePath = (p) => {
    if (!p) return null;
    const ext = path.extname(String(p)).toLowerCase();
    if (!SERVABLE_IMAGE_EXT.has(ext)) return null;
    try {
        const real = fs.realpathSync.native(p);
        const st = fs.statSync(real);
        if (!st.isFile()) return null;
        servedImagePaths.add(imageKey(real));
        return real;
    } catch (e) { return null; }
};

// 文件名清洗 / 单图落点判定在 ./export-path.js（纯函数，可离线单测）
// 导出位置令牌:只有经过系统保存框确认过的路径才能被 write-export-files 使用。
// 渲染层即使被注入,也不能直接传一个任意路径让主进程写文件。
const approvedExportLocations = new Map();
function approveExportLocation(loc) {
    const token = crypto.randomUUID();
    approvedExportLocations.set(token, loc);
    if (approvedExportLocations.size > 100) {
        const oldest = approvedExportLocations.keys().next().value;
        approvedExportLocations.delete(oldest);
    }
    return Object.assign({ token }, loc);
}
// 只接受应用主框架发来的 IPC。preload 默认只注入主框架,这里再挡一层:
// 即使将来打开 nodeIntegrationInSubFrames 或嵌入 iframe,子框架也调不到写盘接口。
const isTrustedFrame = (event) => {
    try {
        const frame = event && event.senderFrame;
        if (!frame || frame.parent) return false;
        return String(frame.url || '').startsWith('file://');
    } catch (e) { return false; }
};
const BLOCKED = { ok: false, error: '不允许的调用来源' };

// 所有 IPC 注册统一走这两个包装器：来源校验只写一处，新增 handler 不可能再忘。
// 之前逐个 handler 手写 isTrustedFrame，漏了约 40 个；现在注册点即校验点。
// 注意：包装器内部才可以直接用 ipcMain.handle / ipcMain.on，业务代码一律用 handleIpc / onIpc。
const handleIpc = (channel, fn) => {
    ipcMain.handle(channel, (e, ...args) => {
        if (!isTrustedFrame(e)) return BLOCKED;
        return fn(e, ...args);
    });
};
const onIpc = (channel, fn) => {
    ipcMain.on(channel, (e, ...args) => {
        if (!isTrustedFrame(e)) return;
        fn(e, ...args);
    });
};

function resolveInside(root, candidate) {
    const base = path.resolve(root);
    const dest = path.resolve(base, String(candidate || ''));
    const rel = path.relative(base, dest);
    if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return null;
    return dest;
}
// 子目录按段清洗,不允许 ..、绝对路径、盘符;空段直接丢弃。
function safeSubdir(root, subdir) {
    const parts = String(subdir || '').split(/[\\/]+/).filter(Boolean);
    const clean = [];
    for (const part of parts) {
        const seg = safeLeafName(part, '');
        if (!seg || seg === '.' || seg === '..') continue;
        clean.push(seg);
    }
    if (!clean.length) return path.resolve(root);
    return resolveInside(root, clean.join(path.sep)) || path.resolve(root);
}

// 照片 EXIF 统一入口:JPEG 走轻量头部解析,HEIC 走 exifr;HEIC 读不到时返回空结果。
async function readPhotoExif(filePath) {
    // RAW 是 TIFF 结构,自定义 exif-read 只认 JPEG 段,这里换成 exifr。
    if (isRaw(filePath)) return readRawExif(filePath);
    if (isHeic(filePath)) {
        const exif = await readHeicExif(filePath);
        if (exif && Object.keys(exif).length) return exif;
        return {};
    }
    // readExif 是 async：以前少了 await，icc 会挂到 Promise 对象上，async 返回时解包丢失，
    // 于是「非 sRGB 原片」提示永远不出现。这里必须等真正的 exif 对象。
    const exif = (await readExif(filePath)) || {};
    // Chromium 解码 JPEG 时已经按 EXIF Orientation 转过像素：naturalWidth / drawImage /
    // <img> 拿到的都是正方向。这里若再报原始值，渲染层的 applyOrientation() 会转第二次，
    // 竖拍照片（Orientation 6/8）导入后就横躺（已用真实 Electron 复现）。统一报告 1 =
    // 像素已正方向；方向校正的唯一负责方是解码器。RAW / HEIC 在上面已经因为各自原因
    // 归一为 1，与此保持一致。
    exif.orientation = 1;
    // 顺带带上 ICC 描述：非 sRGB 的原片（例如相机的 Adobe RGB）浏览器会先转成 sRGB，
    // 与 PS 按嵌入配置文件工作的结果从第一步就不同 —— 导入时要能提示用户。
    try {
        const icc = await readIccName(filePath);
        if (icc) exif.icc = icc;
    } catch (_) { /* 读不到就算了 */ }
    return exif;
}

if (!app.requestSingleInstanceLock()) {
    // 静默退出会把"我明明重启了却还是旧代码"变成一个查不出来的谜:
    // 单实例锁会让新进程直接自杀、只把旧窗口聚焦到前台 —— 而旧的**主进程**代码换不掉。
    // 踩过:改了 src/main 后 `npm start`,窗口照常出现,于是以为重启成功,实际跑的还是旧进程。
    // 这一行是纯 ASCII 标记,别改:start.bat 靠它判断"到底有没有启动"。
    // 下面所有提示都用 ASCII:控制台代码页是 GBK 时,UTF-8 中文会变成乱码,而这段正是
    // "为什么没启动"的唯一线索。走 stdout 而不是 stderr:PowerShell 会把 stderr 包成
    // NativeCommandError,整段信息被拆成红色报错,反而更难读。
    console.log('[qingframe] single-instance lock refused this launch.');
    console.log('[qingframe] another instance is already running; this launch exits with code 1.');
    console.log('[qingframe] to load src/main changes, quit the running app first:');
    console.log('[qingframe]   Task Manager -> end every Electron / Qingframe process, then run npm start again.');
    // 以前用 app.quit():退出码恒为 0,脚本会把"没启动"当成"正常关闭"。这里必须非 0。
    app.exit(1);
} else {
    const PRESETS_DIR = path.join(__dirname, '..', '..', 'shared', 'presets');
    const LOGOS_DIR = path.join(__dirname, '..', '..', 'shared', 'brandlogos');
    // 用户自己导入的品牌 Logo（Eagle 素材包等）。必须落在 userData：
    // 打包后 shared/ 在 app.asar 里是只读的，写进去既失败也不该改安装目录。
    const USER_LOGOS_DIR = path.join(app.getPath('userData'), 'brandlogos');
    const TEXTURES_DIR = path.join(__dirname, '..', '..', 'shared', 'textures');
    const MARKS_DIR = path.join(__dirname, '..', '..', 'shared', 'marks');
    // ACR 实测查找表（Camera Raw 滤镜 763 张 17³ 色格表，zlib 压缩；来源 Compositor，MIT）
    const ACR_TABLES_PATH = path.join(__dirname, '..', '..', 'shared', 'acr', 'cr-tables.bin');
    // 阴影的空间自适应系数（同上来源；PS 渲染上拟合，CRS2 格式，25KB 不压缩）
    const ACR_SHADOWS_PATH = path.join(__dirname, '..', '..', 'shared', 'acr', 'cr-shadows.bin');
    const TEMPLATES_DIR = path.join(app.getPath('userData'), 'templates');
    // AI 边框工作流：agent 与协作面板共享的作品目录（放 userData，打包后可读写，
    // 不像 shared/ 进 asar 只读）。qfs-frame.js 的 -o 也可以指向这里。
    const FRAMES_DIR = path.join(app.getPath('userData'), 'frames');
    // 调色预设与整帧样式模板分库存：预设只含全局调色参数，几 KB，方便频繁读写与分享。
    const GRADE_PRESETS_DIR = path.join(app.getPath('userData'), 'grade-presets');
    const { loadState, saveState, validDir, freeFilePath } = createStateStore(path.join(app.getPath('userData'), 'state.json'));

// ── 自定义标题栏:窗口控制(最小化/最大化切换/关闭)与最大化状态推送 ──
onIpc('win-minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
onIpc('win-toggle-max', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; if (w.isMaximized()) w.unmaximize(); else w.maximize(); });
onIpc('win-toggle-fullscreen', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    w.setFullScreen(!w.isFullScreen());
});
onIpc('win-close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
const wireTitleBar = (win) => {
    const pushMax = () => { if (!win.isDestroyed()) win.webContents.send('win-maximized', win.isMaximized()); };
    win.on('maximize', pushMax);
    win.on('unmaximize', pushMax);
    // 全屏状态也要回推：首页那颗按钮的图标要跟着在「进入/退出全屏」之间切
    const pushFs = () => { if (!win.isDestroyed()) win.webContents.send('win-fullscreen', win.isFullScreen()); };
    win.on('enter-full-screen', pushFs);
    win.on('leave-full-screen', pushFs);
};

const createWindow = () => {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 640,
        title: '清框影 · 照片加框',
        backgroundColor: '#181B1A',
        icon: path.join(__dirname, 'icon.png'),
        show: false,
        autoHideMenuBar: true,
        // 自定义标题栏:Windows 全自绘(frame:false);mac 隐藏原生标题栏但保留红绿灯
        frame: process.platform === 'win32' ? false : true,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // preload 只用 contextBridge/ipcRenderer/webUtils,不需要 Node 全权限。
            // 开沙箱后即使渲染层被注入,也拿不到 fs/child_process 这类底层能力。
            sandbox: true,
            // 关掉后台节流：默认值下窗口最小化/被遮挡时，Chromium 把定时器压到 1s
            // 一次、rAF 直接停，攒下的任务在恢复瞬间一起跑，表现为"放后台久了回来就卡死"。
            // 本应用空闲时没有常驻动画（预设墙的惯性滚动是一次性的、帧率测量只跑 3 帧），
            // 关掉节流的代价只有后台仍保持正常调度。
            backgroundThrottling: false
        }
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    // 拖文件到窗口任意位置(包括侧栏、参数栏、标题栏)时，没人处理的落点会让 Chromium
    // 默认导航到那个 file:// URL——整个界面被一张图替换，返回还得重启软件。
    // 渲染层已经把整窗拖放接下来了，这里再兜一层：任何导航一律拒绝，外链交系统浏览器。
    win.webContents.on('will-navigate', (e, url) => {
        e.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
    });
    wireTitleBar(win);
    win.once('ready-to-show', () => win.show());
    return win;
};

// macOS 的菜单栏是全局的,不能像 Windows 那样 autoHideMenuBar 了事。
// 快捷键默认交给渲染进程(Cmd+Z/C/V/A 等要操作画布元素),因此菜单项用
// registerAccelerator:false:菜单里仍显示快捷键,但不抢键盘事件。
const setupMacMenu = () => {
    if (process.platform !== 'darwin') return;
    const devItems = app.isPackaged ? [] : [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' }
    ];
    const template = [
        {
            label: '清框影',
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: '文件',
            submenu: [
                { role: 'close' }
            ]
        },
        {
            label: '编辑',
            submenu: [
                { role: 'undo', registerAccelerator: false },
                { role: 'redo', registerAccelerator: false },
                { type: 'separator' },
                { role: 'cut', registerAccelerator: false },
                { role: 'copy', registerAccelerator: false },
                { role: 'paste', registerAccelerator: false },
                { role: 'selectAll', registerAccelerator: false }
            ]
        },
        {
            label: '显示',
            submenu: [
                ...devItems,
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: '窗口',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { type: 'separator' },
                { role: 'front' }
            ]
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '项目主页',
                    click: () => shell.openExternal(REPO_URL)
                }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    app.setAboutPanelOptions({
        applicationName: '清框影',
        applicationVersion: app.getVersion(),
        copyright: 'Copyright © 2026 清框影'
    });
};

app.whenReady().then(() => {
    setupMacMenu();
    protocol.handle('qflocal', async (request) => {
        // 页面是 file://、图片是 qflocal://，两者不同源。渲染端给 <img> 设了
        // crossOrigin='anonymous'（见 renderer/js/qfs-img.js），请求因此走 CORS 模式，
        // 这里必须回 Access-Control-Allow-Origin，否则图片加载失败；
        // 而如果不设 crossOrigin，画布会被污染，getImageData/toBlob 全部 SecurityError
        // （调色、裁切、导出全崩）。两处必须成对存在。
        const CORS = {
            'access-control-allow-origin': '*',
            'cross-origin-resource-policy': 'cross-origin',
            'x-content-type-options': 'nosniff'
        };
        try {
            const u = new URL(request.url);
            const filePath = u.searchParams.get('p');
            if (!filePath) return new Response('Not Found', { status: 404, headers: CORS });
            let real;
            try { real = fs.realpathSync.native(filePath); } catch (e) { return new Response('Not Found', { status: 404, headers: CORS }); }
            const ext = path.extname(real).toLowerCase();
            if (!SERVABLE_IMAGE_EXT.has(ext)) return new Response('Forbidden', { status: 403, headers: CORS });
            // 只服务主进程登记过的图片:文件选择、拖放、剪贴板、封面目录、read-exif。
            if (!servedImagePaths.has(imageKey(real))) return new Response('Forbidden', { status: 403, headers: CORS });
            // RAW:Chromium 完全无法解码,由主进程显影成 JPEG。
            // 参数随 URL 走(&raw=<json>&q=<长边>):同一个文件不同显影参数是不同的 URL,
            // 渲染层换参数只要换 URL 就能拿到新像素,不需要额外的失效通知。
            if (isRaw(real)) {
                let params = {};
                const rawParam = u.searchParams.get('raw');
                if (rawParam) {
                    try { params = JSON.parse(rawParam); } catch (e) { params = {}; }
                }
                const edge = Math.max(0, Number(u.searchParams.get('q')) || 0);
                let crop = null;
                const cropParam = u.searchParams.get('crop');
                if (cropParam) {
                    try { crop = JSON.parse(cropParam); } catch (e) { crop = null; }
                }
                const rotate = Math.max(0, Math.min(3, Math.round(Number(u.searchParams.get('rot')) || 0)));
                try {
                    const out = await developRaw(real, {
                        params, maxEdge: edge, halfSize: edge > 0, crop, rotate
                    });
                    return new Response(out.jpg, {
                        headers: {
                            ...CORS,
                            'content-type': 'image/jpeg',
                            'cache-control': 'no-store',
                            'x-qf-raw-cached': out.cached ? '1' : '0'
                        }
                    });
                } catch (e) {
                    console.warn('[raw] 显影失败:', e && e.message);
                    return new Response('RAW develop failed: ' + (e && e.message), { status: 415, headers: CORS });
                }
            }
            // HEIC/HEIF:Chromium 无法解码,先转成 JPEG 再返回;其他格式保持零拷贝流式读取。
            if (isHeic(real)) {
                try {
                    const jpg = await heicFileToJpeg(real);
                    return new Response(jpg, {
                        headers: { ...CORS, 'content-type': 'image/jpeg' }
                    });
                } catch (e) {
                    console.warn('[heic] 解码失败:', e && e.message);
                    return new Response('HEIC decode failed', { status: 415, headers: CORS });
                }
            }
            const res = await net.fetch(pathToFileURL(real).href);
            const headers = new Headers(res.headers);
            for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
            return new Response(res.body, { status: res.status, headers });
        } catch (e) {
            return new Response('Not Found', { status: 404 });
        }
    });
    cleanupPasteDir();
    cleanupQfsTmpRoot();
    // RAW 显影缓存放在 userData 下:卸载/升级不影响,也不占安装目录。
    try { setRawCacheRoot(path.join(app.getPath('userData'), 'raw-cache')); } catch (e) { /* 极端情况下不缓存 */ }
    createWindow();

    // ── 自动更新:仅打包后(app.isPackaged)生效;启动静默检查,事件经 webContents 推给渲染进程做 UI ──
    //    updater 为 null 时(check-for-updates 等 IPC)一律返回"开发模式",避免 dev 下调用报错。
    //
    //    安全约束:更新清单(latest.yml)与安装包必须来自同一个受 TLS 保护的源。
    //    旧版把所有 github.com 请求(含 latest.yml)改写到 ghproxy 等第三方镜像,
    //    镜像同时提供清单与二进制 → 清单里的 sha512 校验形同虚设;在产物未签名的情况下,
    //    等于把"任意代码执行"的权限交给镜像运营者。因此这里不再走任何镜像;
    //    国内网络请使用系统代理,或到 GitHub Releases 手动下载。
    const CHECK_TIMEOUT_MS = 20000;
    const withTimeout = (promise, ms, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s），GitHub 连接缓慢或不可达，请稍后重试或使用系统代理`)),
            ms
        ))
    ]);
    // 原始 feed 报错(JSON 解析栈)对用户不可读,推给 UI 时换成一句网络提示;日志仍保留原文
    const friendlyUpdaterError = (msg) => {
        const m = String(msg || '');
        if (m.includes('Cannot parse releases feed') || m.includes('Unable to find latest version') || m.includes('ERR_UPDATER_INVALID_RELEASE_FEED')) {
            return '无法连接 GitHub 更新源。请检查系统代理后重试，或到 GitHub Releases 手动下载新版';
        }
        return m || '网络异常';
    };
    // 差量留种:把刚下载的安装包复制为缓存 installer.exe(体积相同则跳过,避免每次下载都复制 75MB)
    const seedCachedInstaller = () => {
        try {
            const helper = updater && updater.downloadedUpdateHelper;
            const src = helper && helper.file;
            const cacheDir = helper && helper.cacheDir;
            if (!src || !cacheDir || !fs.existsSync(src)) return;
            const dest = path.join(cacheDir, 'installer.exe');
            if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) return;
            fs.copyFileSync(src, dest);
            console.log('[updater] 已留种缓存 installer.exe,下次更新可走差量:', dest);
        } catch (e) {
            console.warn('[updater] 差量留种失败(忽略):', e && e.message);
        }
    };
    let updater = null;
    // 清单来自 GitHub（含 sha512）；镜像只替换下载地址。两者都要留到最后才用。
    let lastUpdateInfo = null;
    let mirrorInstallerPath = '';
    if (app.isPackaged) {
        // portable 单文件版/未打包开发版不生成 app-update.yml,electron-updater 读取时会抛
        // ENOENT 导致启动后弹"检查更新失败";没有该文件就直接跳过自动更新。
        const updateYml = path.join(process.resourcesPath, 'app-update.yml');
        if (!fs.existsSync(updateYml)) {
            console.warn('[updater] 未发现 app-update.yml(便携版/开发版),自动更新已跳过');
        } else {
        try {
            const { autoUpdater } = require('electron-updater');
            updater = autoUpdater;
            autoUpdater.autoDownload = false; // 发现新版后由用户点按钮再下载
            const pushUpdater = (type, payload) => {
                const w = BrowserWindow.getAllWindows()[0];
                if (w && !w.isDestroyed()) w.webContents.send('updater:event', Object.assign({ type }, payload || {}));
            };
            autoUpdater.on('update-available', (info) => {
                lastUpdateInfo = info || null;
                mirrorInstallerPath = '';
                pushUpdater('available', { version: info && info.version, releaseNotes: info && (info.releaseNotes || info.releaseNotesString) });
            });
            autoUpdater.on('update-not-available', () => pushUpdater('not-available'));
            autoUpdater.on('download-progress', (p) => pushUpdater('progress', { percent: p && p.percent, speed: p && p.bytesPerSecond }));
            autoUpdater.on('update-downloaded', () => pushUpdater('downloaded'));
            autoUpdater.on('error', (err) => { console.warn('[updater]', err && err.message); pushUpdater('error', { message: friendlyUpdaterError(err && err.message) }); });
            // 启动后延迟静默检查,避免拖慢首屏;国内网络慢,加超时兜底(失败静默,不打扰首屏)
            // 「自动检查更新」设置:off=从不自动查(仍可手动点),daily=一天最多一次,startup=每次启动
            const prefs0 = loadState().prefs || {};
            if (!shouldAutoCheck(prefs0, Date.now())) {
                console.log('[updater] 按设置跳过本次启动检查:', normalizeAutoCheck(prefs0.autoCheck));
            } else {
                setTimeout(() => {
                    withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS, '检查更新')
                        .then(() => saveState({ prefs: { updateCheckedAt: Date.now() } }))
                        .catch(() => {});
                }, 3000);
            }
        } catch (e) {
            console.warn('[updater] 初始化失败:', e && e.message);
        }
        }
    }
    handleIpc('check-for-updates', async () => {
        if (!updater) return { ok: false, message: '当前版本不支持在线自动更新,请到 GitHub Releases 下载新版' };
        try {
            await withTimeout(updater.checkForUpdates(), CHECK_TIMEOUT_MS, '检查更新');
            // 手动查过也算「今天查过了」：daily 档下重启不会再查一次
            try { saveState({ prefs: { updateCheckedAt: Date.now() } }); } catch (_) { /* ignore */ }
            return { ok: true };
        } catch (e) {
            const msg = friendlyUpdaterError(e && e.message);
            // 手动点"检查更新"时,超时/失败也要让更新横幅可见并带"重试"按钮
            try {
                const w = BrowserWindow.getAllWindows()[0];
                if (w && !w.isDestroyed()) w.webContents.send('updater:event', { type: 'error', message: msg });
            } catch (_) { /* ignore */ }
            return { ok: false, message: msg };
        }
    });
    let updateDownloadInFlight = false; // 防连点:测速+下载+自动重试全程只允许一个在飞

    // 走镜像下载：地址换成镜像，校验仍用 GitHub 清单里的 sha512。
    // 任何一步失败都抛错，由调用方回退到 electron-updater 的默认通道（GitHub 直连）。
    const downloadViaMirror = async (mirror) => {
        const info = lastUpdateInfo;
        const file = info && Array.isArray(info.files) ? info.files[0] : null;
        if (!info || !file || !file.sha512) throw new Error('清单里没有可用的校验值，已回退 GitHub 直连');
        const fileName = path.basename(String(file.url || info.path || '')) || ('Qingframe-Setup-' + info.version + '.exe');
        const original = releaseAssetUrl({ owner: 'lumos-1s', repo: 'Qing-Fram-Shadow', version: info.version, file: fileName });
        const url = mirrorUrlFor(original, mirror);
        const dest = path.join(app.getPath('userData'), 'update-cache', fileName);
        const w = BrowserWindow.getAllWindows()[0];
        const push = (type, payload) => { if (w && !w.isDestroyed()) w.webContents.send('updater:event', Object.assign({ type }, payload || {})); };
        console.log('[updater] 镜像下载:', url);
        await downloadVerified({
            url, sha512: file.sha512, dest, total: file.size,
            onProgress: (p) => push('progress', { percent: p.percent, speed: p.bytesPerSecond })
        });
        mirrorInstallerPath = dest;
        console.log('[updater] 镜像下载完成并通过校验:', dest);
    };

    handleIpc('start-update-download', async () => {
        if (!updater) return { ok: false, message: '当前版本不支持在线自动更新,请到 GitHub Releases 下载新版' };
        if (updateDownloadInFlight) return { ok: false, message: '更新下载已在进行中' };
        updateDownloadInFlight = true;
        try {
            // 先让横幅进入"下载中"状态
            try {
                const w = BrowserWindow.getAllWindows()[0];
                if (w && !w.isDestroyed()) w.webContents.send('updater:event', { type: 'progress', percent: 0, speed: 0 });
            } catch (_) { /* ignore */ }
            const mirror = normalizeMirror((loadState().prefs || {}).updateMirror);
            if (mirror.ok && mirror.value) {
                try {
                    await downloadViaMirror(mirror.value);
                    return { ok: true, viaMirror: true };
                } catch (e) {
                    // 镜像不可用不该让用户卡死：退回 GitHub 直连（慢，但能装）
                    console.warn('[updater] 镜像下载失败，回退直连:', e && e.message);
                    try {
                        const w = BrowserWindow.getAllWindows()[0];
                        if (w && !w.isDestroyed()) w.webContents.send('updater:event', { type: 'progress', percent: 0, speed: 0, note: '镜像不可用，已回退 GitHub 直连' });
                    } catch (_) { /* ignore */ }
                }
            }
            await updater.downloadUpdate();
            seedCachedInstaller();
            return { ok: true };
        } finally {
            updateDownloadInFlight = false;
        }
    });
    handleIpc('quit-and-install', () => {
        // 镜像通道下载的安装包不经 electron-updater，自己静默装（/S）再退出
        if (mirrorInstallerPath && fs.existsSync(mirrorInstallerPath)) {
            try {
                const { spawn } = require('child_process');
                spawn(mirrorInstallerPath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
                setTimeout(() => app.quit(), 200);
                return { ok: true, viaMirror: true };
            } catch (e) { console.warn('[updater] 静默安装失败，改用内置安装器:', e && e.message); }
        }
        if (updater) { try { updater.quitAndInstall(); } catch (e) { console.warn('[updater] quitAndInstall:', e && e.message); } }
        return { ok: true };
    });

    // 更新下载源（空 = GitHub 直连）。只允许 http(s)，http 仅限本机，其余一律拒绝。
    handleIpc('set-update-mirror', (_e, raw) => {
        const r = normalizeMirror(raw);
        if (!r.ok) return { ok: false, error: r.error, mirror: '' };
        saveState({ prefs: { updateMirror: r.value } });
        return { ok: true, mirror: r.value };
    });

});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

handleIpc('load-acr-tables', () => {
    try {
        const raw = fs.readFileSync(ACR_TABLES_PATH);
        if (raw.length < 10 || raw.slice(0, 4).toString('ascii') !== 'CRT4') return null;
        const planes = zlib.inflateSync(raw.slice(10));
        return {
            size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
            data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength)
        };
    } catch (_) { return null; }
});
handleIpc('load-acr-shadows', () => {
    try {
        const raw = fs.readFileSync(ACR_SHADOWS_PATH);
        if (raw.length < 34 || raw.slice(0, 4).toString('ascii') !== 'CRS2') return null;
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    } catch (_) { return null; }
});
handleIpc('list-presets', () => {
    try {
        if (!fs.existsSync(PRESETS_DIR)) return [];
        return fs.readdirSync(PRESETS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''));
    } catch (e) { return []; }
});

// ── 诊断日志:应用信息 + 渲染层操作日志导出(报 bug 时一键提供,同 yt-dlp --verbose 思路) ──
handleIpc('get-app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    // electron-builder 的 portable 目标会注入这两个变量;安装版/开发版没有
    portable: !!(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE),
    osRelease: os.release(),
    userData: app.getPath('userData'),
    appPath: app.getAppPath()
}));

// 关于页只允许打开本项目 GitHub 链接,避免渲染进程拿到任意 openExternal 能力。
// 路径必须正好是仓库主页或以 / 结尾,防止 "Qing-Fram-Shadow-xxx" 一类前缀误匹配。
handleIpc('open-external', async (_e, url) => {
    try {
        const u = new URL(String(url));
        const pathOk = u.pathname === REPO_PATH || u.pathname.startsWith(REPO_PATH + '/');
        if (u.protocol !== 'https:' || u.hostname !== 'github.com' || !pathOk) {
            return { ok: false, message: '不允许的链接' };
        }
        await shell.openExternal(u.toString());
        return { ok: true };
    } catch (e) { return { ok: false, message: e && e.message }; }
});

handleIpc('open-data-dir', async () => {
    try {
        const p = app.getPath('userData');
        const err = await shell.openPath(p);
        return err ? { ok: false, message: err } : { ok: true, path: p };
    } catch (e) { return { ok: false, message: e && e.message }; }
});

// ── 预设墙封面：允许用户自备图片覆盖内置封面 ──
// 约定：userData/wall-covers/<预设名>.webp|jpg|jpeg|png，文件名与预设名一致（如「圆角卡片.webp」）。
// 只读文件名映射，不复制、不改内置资源；删掉文件即恢复原封面。
const wallCoversDir = () => path.join(app.getPath('userData'), 'wall-covers');
handleIpc('list-wall-covers', async () => {
    try {
        const dir = wallCoversDir();
        const names = await fs.promises.readdir(dir);
        const out = {};
        for (const n of names) {
            const ext = path.extname(n).toLowerCase();
            if (!['.webp', '.jpg', '.jpeg', '.png'].includes(ext)) continue;
            const cover = path.join(dir, n);
            allowImagePath(cover);
            // 带上 mtime 当版本号：渲染端只在文件真的变了时才换 <img src> 的 URL。
            // 之前用的是「每次扫描取当前时间戳」，于是每次开墙 / 窗口聚焦 / 切换无限·有限
            // 都会让所有自定义封面换 URL → 重新读盘 + 重新解码，卡片肉眼可见地闪一下。
            let mtime = 0;
            try { mtime = Math.round((await fs.promises.stat(cover)).mtimeMs) || 0; } catch (_) { mtime = 0; }
            out[path.basename(n, ext)] = { path: cover, mtime };
        }
        return out;
    } catch (e) {
        return {};   // 目录不存在 = 没有自定义封面
    }
});
handleIpc('open-wall-covers-dir', async () => {
    try {
        const dir = wallCoversDir();
        await fs.promises.mkdir(dir, { recursive: true });
        const err = await shell.openPath(dir);
        return err ? { ok: false, message: err, path: dir } : { ok: true, path: dir };
    } catch (e) { return { ok: false, message: e && e.message }; }
});

// 点卡片换封面：弹选图 → 自动按预设名落盘。
// 老流程要用户自己在文件夹里新建「预设名.jpg」，中文名 + 括号 + 空格，几乎没人能一次对上；
// 现在文件名由预设名直接给出，用户只需要选图。
const WALL_COVER_EXT = ['.webp', '.jpg', '.jpeg', '.png'];
const WALL_COVER_MAX_BYTES = 40 * 1024 * 1024;
// 只挡路径分隔符与控制字符，中文/空格/括号原样保留 —— 这个名字要和 list-wall-covers 的键一致。
// 用 \p{Cc}（控制字符类）而不是 \x00-\x1f 字面量：后者会触发 no-control-regex。
const wallCoverBase = (name) => String(name || '').replace(/[\\/:*?"<>|\p{Cc}]/gu, '').trim().slice(0, 80);

// 删掉一张封面文件。封面可能正被渲染进程显示（Chromium 还攥着句柄），
// unlink 会 EPERM；这时退一步改成「改名藏起来」——list-wall-covers 只认图片扩展名，
// 改名后这张图在应用里就等于没了，不耽误用户「恢复默认」。
const removeWallCoverFile = async (full) => {
    try { await fs.promises.unlink(full); return true; }
    catch (_) {
        if (full.endsWith('.off')) return false;   // 已经是藏起来的残骸，别再叠后缀
        try { await fs.promises.rename(full, full + '.off'); return true; } catch (_) { return false; }
    }
};

handleIpc('pick-wall-cover', async (e, name, filePath) => {
    if (!isTrustedFrame(e)) return BLOCKED;
    const base = wallCoverBase(name);
    if (!base) return { ok: false, message: '预设名无效' };
    try {
        let src = filePath ? String(filePath) : '';
        if (!src) {
            const win = BrowserWindow.fromWebContents(e.sender);
            const { canceled, filePaths } = await dialog.showOpenDialog(win, {
                title: '给「' + base + '」选一张封面',
                filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
                properties: ['openFile']
            });
            if (canceled || !filePaths.length) return { ok: false, canceled: true };
            src = filePaths[0];
        }
        const st = await fs.promises.stat(src);
        if (!st.isFile()) return { ok: false, message: '不是文件' };
        if (st.size > WALL_COVER_MAX_BYTES) return { ok: false, message: '图片超过 40MB，换一张小点的' };
        // 扩展名可以骗人：真能解码才算图片，否则墙上一格永远空白
        if (nativeImage.createFromPath(src).isEmpty()) return { ok: false, message: '这张图读不出来，换一张试试' };
        const ext = path.extname(src).toLowerCase();
        const dir = wallCoversDir();
        await fs.promises.mkdir(dir, { recursive: true });
        // 先删同名旧封面（含改名藏起来的 .off 残留）：一个预设只留一张，
        // 否则两张都叫「圆角卡片」，list-wall-covers 的键会互相覆盖，用户看到哪张全凭 readdir 顺序。
        // 用 startsWith(base + '.') 而不是比对 basename：「圆角卡片」不会误伤「圆角卡片（浅）」。
        const olds = await fs.promises.readdir(dir).catch(() => []);
        for (const n of olds) {
            if (!n.startsWith(base + '.')) continue;
            await removeWallCoverFile(path.join(dir, n));
        }
        const dest = path.join(dir, base + ext);
        await fs.promises.copyFile(src, dest);
        allowImagePath(dest);
        return { ok: true, path: dest, name: base };
    } catch (err) { return { ok: false, message: err && err.message }; }
});

handleIpc('clear-wall-cover', async (e, name) => {
    if (!isTrustedFrame(e)) return BLOCKED;
    const base = wallCoverBase(name);
    if (!base) return { ok: false, message: '预设名无效' };
    try {
        const dir = wallCoversDir();
        let removed = 0;
        const names = await fs.promises.readdir(dir).catch(() => []);
        for (const n of names) {
            // 先只认图片；`.off` 是改名藏起来的旧封面，也一并清掉
            const oe = path.extname(n).toLowerCase();
            const isPic = WALL_COVER_EXT.includes(oe);
            const isHidden = n.endsWith('.off');
            if (!isPic && !isHidden) continue;
            if (!n.startsWith(base + '.')) continue;
            if (await removeWallCoverFile(path.join(dir, n))) { if (isPic) removed++; }
        }
        return { ok: true, removed };
    } catch (err) { return { ok: false, message: err && err.message }; }
});
// 导出完成后在资源管理器中显示文件/目录(不再只显示一串路径文本)
handleIpc('show-item-in-folder', (_e, p) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        if (!p) return { ok: false };
        const stat = fs.statSync(p);
        if (stat.isDirectory()) { shell.openPath(p); return { ok: true, opened: 'dir' }; }
        shell.showItemInFolder(p);
        return { ok: true, opened: 'file' };
    } catch (e) { return { ok: false, message: e && e.message }; }
});

// 复制文本到剪贴板:关于页诊断信息优先走这里,避免 file:// 下 navigator.clipboard
// 权限差异导致复制失败。限制 2MB,防止误传超大内容卡住主进程。
handleIpc('copy-text', (_e, text) => {
    try {
        const s = String(text || '');
        if (s.length > 2 * 1024 * 1024) return { ok: false, message: '文本过大' };
        clipboard.writeText(s);
        return { ok: true };
    } catch (e) { return { ok: false, message: e && e.message }; }
});

// 复制当前画布到系统剪贴板。只接受 data URL:渲染进程不能直接 require electron,
// 由预加载脚本的 copyImage 通道接入。返回实际像素尺寸,供界面提示用。
handleIpc('copy-image', (_e, dataUrl) => {
    try {
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
            return { ok: false, message: '图片数据无效' };
        }
        const img = nativeImage.createFromDataURL(dataUrl);
        if (img.isEmpty()) return { ok: false, message: '图片解码失败' };
        clipboard.writeImage(img);
        const size = img.getSize();
        return { ok: true, width: size.width, height: size.height };
    } catch (e) { return { ok: false, message: e && e.message }; }
});

handleIpc('save-diagnostics', async (_e, text) => {
    try {
        const r = await dialog.showSaveDialog({
            title: '保存诊断日志',
            defaultPath: path.join(app.getPath('documents'), '清框影诊断日志.txt'),
            filters: [{ name: '文本文件', extensions: ['txt'] }]
        });
        if (r.canceled || !r.filePath) return { ok: false, canceled: true };
        fs.writeFileSync(r.filePath, String(text || ''), 'utf-8');
        return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, message: e && e.message }; }
});

handleIpc('load-preset', (_e, name) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        // 预设名来自渲染层：只允许作为单个文件名使用，不能让 ../ 读到目录外。
        const safe = safeLeafName(name, '');
        if (!safe) return null;
        const p = resolveInside(PRESETS_DIR, safe + '.json');
        if (!p || !fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { return null; }
});

// ── AI 边框协作：agent 与面板共享 userData/frames/*.json ──
// 放 userData 而非 shared/：后者进 asar 只读，agent 写不进去。
const fsEnsureDir = (d) => { try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* 忽略：建不出时后续读写会报错 */ } return d; };
const framePath = (name) => {
    const safe = safeLeafName(name, '');
    return safe ? resolveInside(FRAMES_DIR, safe.endsWith('.json') ? safe : safe + '.json') : null;
};
handleIpc('frames:list', () => {
    try {
        fsEnsureDir(FRAMES_DIR);
        return fs.readdirSync(FRAMES_DIR).filter((f) => f.toLowerCase().endsWith('.json')).sort();
    } catch (_) { return []; }
});
handleIpc('frames:read', (_e, name) => {
    try {
        const p = framePath(name);
        if (!p || !fs.existsSync(p)) return null;
        return { name: path.basename(p), text: fs.readFileSync(p, 'utf8') };
    } catch (_) { return null; }
});
handleIpc('frames:save', (_e, name, text) => {
    try {
        const p = framePath(name);
        if (!p) return { ok: false, message: '文件名不合法' };
        JSON.parse(String(text || '')); // 存前校验，坏 JSON 不落盘
        fsEnsureDir(FRAMES_DIR);
        fs.writeFileSync(p, String(text || ''), 'utf8');
        return { ok: true, name: path.basename(p) };
    } catch (e) { return { ok: false, message: e && e.message }; }
});
handleIpc('frames:dir', () => ({ path: FRAMES_DIR }));
handleIpc('frames:openDir', () => { try { fsEnsureDir(FRAMES_DIR); shell.openPath(FRAMES_DIR); return { ok: true }; } catch (e) { return { ok: false, message: e.message }; } });
// 目录变化推送：外部 agent 改文件 → 面板提示重载。fs.watch 结果去重（写一次会来多个事件）。
let framesWatcher = null;
handleIpc('frames:watch', () => {
    try {
        fsEnsureDir(FRAMES_DIR);
        if (!framesWatcher) {
            framesWatcher = fs.watch(FRAMES_DIR, (event, filename) => {
                for (const win of BrowserWindow.getAllWindows()) {
                    if (!win.isDestroyed()) win.webContents.send('frames-changed', { event, name: String(filename || '') });
                }
            });
        }
        return { ok: true, path: FRAMES_DIR };
    } catch (err) { return { ok: false, message: err && err.message }; }
});

// 启动时要读全部预设:原来 list-presets + 逐个 load-preset = 78 次 IPC 往返,每次都在主进程
// 做一次 existsSync + readFileSync 且串行。合并成一次往返,盘上并发读。
handleIpc('load-all-presets', async () => {
    try {
        if (!fs.existsSync(PRESETS_DIR)) return [];
        const names = fs.readdirSync(PRESETS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''));
        const list = await Promise.all(names.map(async (name) => {
            try {
                const txt = await fs.promises.readFile(path.join(PRESETS_DIR, name + '.json'), 'utf-8');
                return { name, data: JSON.parse(txt) };
            } catch (e) { return null; }
        }));
        return list.filter(Boolean);
    } catch (e) { return []; }
});

// 扩展名 → MIME(src/main/image-mime.js,独立成模块便于纯 node 验证)
const { imageMimeOf } = require('./image-mime');
const readImagesAsDataUrls = (dir, exts) => {
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => exts.some(ext => f.toLowerCase().endsWith(ext)))
            .map(f => {
                const full = path.join(dir, f);
                const buf = fs.readFileSync(full);
                return { name: f.replace(/\.\w+$/, ''), dataUrl: `data:${imageMimeOf(f)};base64,${buf.toString('base64')}` };
            });
    } catch (e) { return []; }
};

// 静态资源进程内缓存:品牌logo/纹理/标记都是只读资源,每次启动重复读盘+base64 是启动慢的主因之一。
// 失效策略:按目录内每个文件的 mtime 做摘要,任何文件增删/修改都会触发重建(代价只是几十次 stat)。
const _staticCache = new Map();
const cachedImages = (key, dir, exts) => {
    let sig = '';
    try {
        sig = fs.readdirSync(dir)
            .map(f => f + ':' + fs.statSync(path.join(dir, f)).mtimeMs)
            .sort().join('|');
    } catch (_) { sig = 'missing'; }
    const c = _staticCache.get(key);
    if (c && c.sig === sig) return c.data;
    const data = readImagesAsDataUrls(dir, exts);
    _staticCache.set(key, { sig, data });
    return data;
};
const LOGO_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
handleIpc('list-logos', () => {
    // 内置目录通常为空(第三方 Logo 不进仓库/安装包):目录缺失也不能让整个 IPC 抛错,
    // 否则渲染进程的 Logo 选择组会整块失效。
    let builtin = [];
    try { builtin = cachedImages('logos', LOGOS_DIR, LOGO_EXTS); } catch (_) { builtin = []; }
    let user = [];
    try { user = cachedImages('logos-user', USER_LOGOS_DIR, LOGO_EXTS); } catch (_) { user = []; }
    if (!user.length) return builtin;
    // 用户目录优先：同名（不含扩展名）时用用户导入的那张。
    // 导入的 Logo 不标 custom —— 品牌池与 EXIF 品牌匹配都按内置素材那套规则走。
    const byName = new Map();
    for (const l of builtin) byName.set(String(l.name || '').toLowerCase(), l);
    for (const l of user) byName.set(String(l.name || '').toLowerCase(), l);
    return Array.from(byName.values());
});

// 导入 Eagle 素材包（.eaglepack / .zip）：解出里面的位图写到 userData/brandlogos，
// 文件名直接用素材名（Canon_White.png / Xiaomi.png），品牌匹配靠文件名，无需额外品牌表。
handleIpc('import-logo-pack', async (e, filePath) => {
    if (!isTrustedFrame(e)) return BLOCKED;
    let target = filePath;
    if (!target) {
        const win = BrowserWindow.fromWebContents(e.sender);
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
            title: '导入 Logo 素材包',
            filters: [{ name: 'Eagle 素材包', extensions: ['eaglepack', 'zip'] }],
            properties: ['openFile']
        });
        if (canceled || !filePaths.length) return { ok: false, canceled: true };
        target = filePaths[0];
    }
    const r = importLogoPack(target, USER_LOGOS_DIR, LOGOS_DIR);
    try { _staticCache.delete('logos-user'); } catch (_) { /* 忽略 */ }
    return r;
});

handleIpc('open-logo-dir', async () => {
    try { fs.mkdirSync(USER_LOGOS_DIR, { recursive: true }); } catch (_) { /* 忽略 */ }
    const err = await shell.openPath(USER_LOGOS_DIR);
    return err ? { ok: false, error: err } : { ok: true };
});

// 内置自定义图标库。种子 shared/custom-icons.json 只读,实际读写走 userData 下的副本 ——
// 打包后种子在 app.asar 里是只读的,就地改必然失败(见 custom-icons.js 顶部注释)。
const { createCustomIconStore } = require('./custom-icons');
const customIcons = createCustomIconStore(
    path.join(app.getPath('userData'), 'custom-icons.json'),
    path.join(__dirname, '..', '..', 'shared', 'custom-icons.json')
);

handleIpc('list-custom-icons', () => customIcons.list());

// 删除/重命名自定义图标:同步写盘,否则初始库图标重启后复活
handleIpc('delete-custom-icon', (_e, dataUrl) => customIcons.remove(dataUrl));
handleIpc('rename-custom-icon', (_e, dataUrl, name) => customIcons.rename(dataUrl, name));

handleIpc('list-textures', () => cachedImages('textures', TEXTURES_DIR, ['.png', '.jpg', '.jpeg']));

// 内置原创标记(shared/marks,随包分发)。全部是项目自绘的几何/排版图形,
// 不含任何第三方品牌素材 —— 品牌 logo 因商标/著作权原因不随发行版分发,见 OPTIMIZATIONS.md。
handleIpc('list-marks', () => cachedImages('marks', MARKS_DIR, ['.svg', '.png']));

const ensureTemplatesDir = () => {
    if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    return TEMPLATES_DIR;
};

handleIpc('save-template', (_e, { name, data }) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        if (!name) return { ok: false, error: '模板名称为空' };
        if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '模板内容无效' };
        ensureTemplatesDir();
        const safe = safeLeafName(name, '');
        if (!safe) return { ok: false, error: '模板名称不合法' };
        const json = JSON.stringify(data, null, 2);
        if (!json) return { ok: false, error: '模板内容无法序列化' };
        if (json.length > 32 * 1024 * 1024) return { ok: false, error: '模板超过 32MB，已拒绝保存' };
        fs.writeFileSync(path.join(TEMPLATES_DIR, safe + '.json'), json, 'utf-8');
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

handleIpc('list-templates', () => {
    try {
        ensureTemplatesDir();
        return fs.readdirSync(TEMPLATES_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''));
    } catch (e) { return []; }
});

handleIpc('load-template', (_e, name) => {
    try {
        const safe = safeLeafName(name, '');
        if (!safe) return null;
        const p = resolveInside(TEMPLATES_DIR, safe + '.json');
        if (!p || !fs.existsSync(p)) return null;
        if (fs.statSync(p).size > 32 * 1024 * 1024) return null;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { return null; }
});

handleIpc('delete-template', (_e, name) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        const safe = safeLeafName(name, '');
        if (!safe) return { ok: false, error: '模板名称不合法' };
        const p = resolveInside(TEMPLATES_DIR, safe + '.json');
        if (!p) return { ok: false, error: '模板名称不合法' };
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

handleIpc('rename-template', (_e, { oldName, newName }) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        if (!oldName || !newName) return { ok: false, error: '模板名称为空' };
        const fromName = safeLeafName(oldName, '');
        const toName = safeLeafName(newName, '');
        if (!fromName || !toName) return { ok: false, error: '模板名称不合法' };
        const from = path.join(TEMPLATES_DIR, fromName + '.json');
        const to = path.join(TEMPLATES_DIR, toName + '.json');
        if (!fs.existsSync(from)) return { ok: false, error: '源模板不存在' };
        if (fs.existsSync(to)) return { ok: false, error: '已存在同名模板' };
        fs.renameSync(from, to);
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

// ── 调色预设：userData/grade-presets/*.xmp，与整帧样式模板分库 ──
// 预设本身就是 Lightroom / Camera Raw 的 XMP 文件，目录里的文件可以直接分享。
handleIpc('save-grade-preset', (_e, { name, xml }) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    return gradePresetStore.save(GRADE_PRESETS_DIR, name, xml);
});

handleIpc('list-grade-presets', () => gradePresetStore.list(GRADE_PRESETS_DIR));

handleIpc('load-grade-preset', (_e, { name, ext }) =>
    gradePresetStore.load(GRADE_PRESETS_DIR, name, ext));

handleIpc('delete-grade-preset', (_e, { name, ext }) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    return gradePresetStore.remove(GRADE_PRESETS_DIR, name, ext);
});

handleIpc('rename-grade-preset', (_e, { oldName, newName }) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    return gradePresetStore.rename(GRADE_PRESETS_DIR, oldName, newName);
});

handleIpc('open-grade-presets-dir', async () => {
    try {
        fs.mkdirSync(GRADE_PRESETS_DIR, { recursive: true });
        const err = await shell.openPath(GRADE_PRESETS_DIR);
        return err ? { ok: false, message: err } : { ok: true, path: GRADE_PRESETS_DIR };
    } catch (e) { return { ok: false, message: e && e.message }; }
});

// 保存当前调色：先让用户选位置；默认永远打开预设库目录，最省一步。
handleIpc('pick-grade-preset-save-path', async (_e, suggestedName) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        fs.mkdirSync(GRADE_PRESETS_DIR, { recursive: true });
        const base = safeLeafName(suggestedName || '我的调色', '我的调色');
        const { canceled, filePath } = await dialog.showSaveDialog({
            title: '保存调色预设',
            defaultPath: path.join(GRADE_PRESETS_DIR, base + '.xmp'),
            filters: [{ name: 'Lightroom 调色预设', extensions: ['xmp'] }]
        });
        if (canceled || !filePath) return { canceled: true };
        // 强制 .xmp 后缀：Lightroom 只认这个扩展名。
        const outPath = path.extname(filePath).toLowerCase() === '.xmp'
            ? filePath
            : path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + '.xmp');
        const inLibrary = path.resolve(path.dirname(outPath)).toLowerCase()
            === path.resolve(GRADE_PRESETS_DIR).toLowerCase();
        return {
            ok: true,
            path: outPath,
            name: path.basename(outPath, path.extname(outPath)),
            inLibrary
        };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});

// 写入用户选的位置；如果不在预设库里，再自动在库里放一份。
handleIpc('save-grade-preset-xmp', (_e, { path: filePath, xml }) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: '保存路径为空' };
    try {
        fs.mkdirSync(GRADE_PRESETS_DIR, { recursive: true });
        const checked = gradePresetStore.save(path.dirname(filePath),
            path.basename(filePath, path.extname(filePath)), xml);
        if (!checked || checked.ok === false) return checked || { ok: false, error: '写入失败' };
        const libDir = path.resolve(GRADE_PRESETS_DIR).toLowerCase();
        const outDir = path.resolve(path.dirname(filePath)).toLowerCase();
        let libraryName = path.basename(filePath, path.extname(filePath));
        let libraryPath = filePath;
        if (outDir !== libDir) {
            libraryName = gradePresetStore.uniqueName(GRADE_PRESETS_DIR, libraryName);
            libraryPath = path.join(GRADE_PRESETS_DIR, libraryName + '.xmp');
            const copied = gradePresetStore.save(GRADE_PRESETS_DIR, libraryName, xml);
            if (!copied || copied.ok === false) return copied || { ok: false, error: '收录到预设库失败' };
        }
        saveState({ lastExportDir: path.dirname(filePath) });
        return { ok: true, path: filePath, libraryName, libraryPath };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});

// 导出已有预设到用户选的位置：只写文件，不再往库里收录一份。
handleIpc('export-grade-preset-xmp', (_e, { path: filePath, xml }) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: '保存路径为空' };
    try {
        const r = gradePresetStore.save(path.dirname(filePath),
            path.basename(filePath, path.extname(filePath)), xml);
        if (!r || r.ok === false) return r || { ok: false, error: '写入失败' };
        saveState({ lastExportDir: path.dirname(filePath) });
        return { ok: true, path: filePath };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});

// 批量导入：一个按钮选多个 .xmp，主进程只负责读文本，解析交给渲染进程。
handleIpc('pick-grade-xmp-files', async (_e) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        const st = loadState();
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: '导入调色预设（可多选）',
            defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Lightroom 调色预设', extensions: ['xmp'] }]
        });
        if (canceled || !filePaths || !filePaths.length) return { canceled: true };
        const files = [];
        const skipped = [];
        for (const p of filePaths) {
            try {
                const stat = fs.statSync(p);
                if (stat.size > gradePresetStore.MAX_BYTES) {
                    skipped.push(path.basename(p) + '（超过 4MB）');
                    continue;
                }
                files.push({
                    name: path.basename(p, path.extname(p)),
                    path: p,
                    xml: fs.readFileSync(p, 'utf-8')
                });
            } catch (e) {
                skipped.push(path.basename(p) + '（读取失败）');
            }
        }
        if (files.length) saveState({ lastOpenDir: path.dirname(files[0].path) });
        return { ok: true, files, skipped };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});

// ── 草稿附件:把模板里的大 data: 图片搬到 userData/draft-assets,草稿只存引用 ──
// localStorage 只有几 MB,旧实现超过 64KB 的 data: 串直接清空、整份超 8MB 就跳过保存,
// 导致头像/自定义图标/带图模板在崩溃恢复后静默消失。搬到磁盘后草稿保持小体积,
// 图片也不再被截断。
const DRAFT_ASSET_RE = /^qfasset:([a-f0-9]{64})\.([a-z0-9]+)$/i;
const DRAFT_DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;
const DRAFT_ASSET_MAX_BYTES = 64 * 1024 * 1024;
const DRAFT_ASSET_TOTAL_BYTES = 512 * 1024 * 1024;
const DRAFT_ASSET_MAX_COUNT = 500;
const draftAssetsDir = () => path.join(app.getPath('userData'), 'draft-assets');
const assetExt = (mime) => {
    const m = String(mime || '').toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('png')) return 'png';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('bmp')) return 'bmp';
    if (m.includes('svg')) return 'svg';
    return 'bin';
};
const assetMime = (ext) => ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml'
})[String(ext || '').toLowerCase()] || 'application/octet-stream';
const walkDraftStrings = (node, fn, depth) => {
    if (depth > 32 || node == null) return node;
    if (typeof node === 'string') return fn(node);
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) node[i] = walkDraftStrings(node[i], fn, depth + 1);
        return node;
    }
    if (typeof node === 'object') {
        for (const k of Object.keys(node)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            node[k] = walkDraftStrings(node[k], fn, depth + 1);
        }
    }
    return node;
};
const externalizeDraftAssets = (draft) => {
    const dir = draftAssetsDir();
    fs.mkdirSync(dir, { recursive: true });
    const keep = new Set();
    let count = 0, bytes = 0, dropped = 0;
    walkDraftStrings(draft, (s) => {
        if (s.length < 4096) return s;
        const m = s.match(DRAFT_DATA_URL_RE);
        if (!m) return s;
        // 先按 base64 字符串长度挡一次,避免为超大串先分配几十 MB 再判断。
        if (m[2].length > Math.ceil(DRAFT_ASSET_MAX_BYTES * 4 / 3) + 4) {
            dropped++;
            return '';
        }
        const raw = Buffer.from(m[2], 'base64');
        if (raw.length > DRAFT_ASSET_MAX_BYTES || count >= DRAFT_ASSET_MAX_COUNT || bytes + raw.length > DRAFT_ASSET_TOTAL_BYTES) {
            dropped++;
            return '';
        }
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const ext = assetExt(m[1]);
        const name = `${hash}.${ext}`;
        const file = path.join(dir, name);
        try {
            if (!fs.existsSync(file)) fs.writeFileSync(file, raw);
            keep.add(name);
            count++;
            bytes += raw.length;
            return `qfasset:${name}`;
        } catch (e) {
            dropped++;
            return '';
        }
    }, 0);
    // 只清理 7 天前的孤儿附件,避免和"正在写的上一版草稿"抢文件。
    try {
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        for (const n of fs.readdirSync(dir)) {
            if (keep.has(n)) continue;
            const fp = path.join(dir, n);
            try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore */ }
    return { count, bytes, dropped };
};
const hydrateDraftAssets = (draft) => {
    const dir = draftAssetsDir();
    let missing = 0, restored = 0;
    walkDraftStrings(draft, (s) => {
        const m = s.match(DRAFT_ASSET_RE);
        if (!m) return s;
        const file = resolveInside(dir, m[1] + '.' + m[2]);
        if (!file) { missing++; return ''; }
        try {
            if (fs.statSync(file).size > DRAFT_ASSET_MAX_BYTES) { missing++; return ''; }
            const buf = fs.readFileSync(file);
            restored++;
            return `data:${assetMime(m[2])};base64,${buf.toString('base64')}`;
        } catch (e) { missing++; return ''; }
    }, 0);
    return { missing, restored };
};
handleIpc('draft-externalize', (_e, draft) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        if (!draft || typeof draft !== 'object') return { ok: false, error: '草稿格式无效' };
        const stats = externalizeDraftAssets(draft);
        const json = JSON.stringify(draft);
        if (json.length > 16 * 1024 * 1024) return { ok: false, error: '草稿仍然过大，已跳过本次保存' };
        return { ok: true, draft, json, stats };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
handleIpc('draft-hydrate', (_e, draft) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        if (!draft || typeof draft !== 'object') return { ok: false, error: '草稿格式无效' };
        const stats = hydrateDraftAssets(draft);
        return { ok: true, draft, stats };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
handleIpc('draft-clear-assets', (_e) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        const dir = draftAssetsDir();
        if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) {
            try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* ignore */ }
        }
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

handleIpc('export-template', async (_e, { name, data }) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    const st = loadState();
    const baseName = safeLeafName(name || 'template', 'template') + '.json';
    const def = validDir(st.lastExportDir) ? path.join(st.lastExportDir, baseName) : baseName;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出模板',
        defaultPath: def,
        filters: [{ name: 'JSON 模板', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
        const json = JSON.stringify(data, null, 2);
        if (!json) return { ok: false, error: '模板内容无法序列化' };
        if (json.length > 32 * 1024 * 1024) return { ok: false, error: '模板超过 32MB，已拒绝导出' };
        fs.writeFileSync(filePath, json, 'utf-8');
        saveState({ lastExportDir: path.dirname(filePath) });
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

handleIpc('import-template', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '导入模板',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: 'JSON 模板', extensions: ['json'] }],
        properties: ['openFile']
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    try {
        if (fs.statSync(filePaths[0]).size > 32 * 1024 * 1024) return { ok: false, error: '模板超过 32MB' };
        const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
        saveState({ lastOpenDir: path.dirname(filePaths[0]) });
        return { ok: true, name: path.basename(filePaths[0], '.json'), data };
    } catch (e) { return { ok: false, error: '模板格式错误：' + e.message }; }
});

// ── .qfs 工程文件:自包含单文件(模板 + 源照片 + 每图模板,照片以 base64 内嵌) ──
// ── .qfs 流式导出:逐张写临时文件,最后拼成一个 JSON,避免所有照片 base64 同时驻留 ──
// 旧实现把所有照片 toDataURL 进一个数组,再 JSON.stringify 整体过 IPC:20 张 24MP
// 就是几百 MB 的字符串峰值,主线程冻结甚至 OOM。现在渲染层一次只编码一张,
// 主进程把 base64 落到临时文件,finish 时按块拼装。
const qfsExports = new Map();
const qfsTmpRoot = () => path.join(app.getPath('userData'), 'qfs-tmp');
const cleanupQfsSession = (id) => {
    const s = qfsExports.get(id);
    qfsExports.delete(id);
    if (!s) return;
    try { fs.rmSync(s.tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
};
const cleanupQfsTmpRoot = () => {
    try { fs.rmSync(qfsTmpRoot(), { recursive: true, force: true }); } catch (e) { /* ignore */ }
};

// 导入 Lightroom / Camera Raw 的 XMP 调色预设:只读文本回渲染层,解析与映射在渲染端做
handleIpc('import-xmp', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '导入 Lightroom 调色预设 (.xmp)',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: 'Lightroom 预设 / XMP', extensions: ['xmp'] }],
        properties: ['openFile']
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    try {
        if (fs.statSync(filePaths[0]).size > 8 * 1024 * 1024) return { ok: false, error: 'XMP 超过 8MB' };
        const text = fs.readFileSync(filePaths[0], 'utf-8');
        saveState({ lastOpenDir: path.dirname(filePaths[0]) });
        return { ok: true, name: path.basename(filePaths[0], '.xmp'), text };
    } catch (e) { return { ok: false, error: 'XMP 读取失败：' + e.message }; }
});

handleIpc('qfs-begin-export', async (_e, meta) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    try {
        if (!meta || typeof meta !== 'object') return { ok: false, error: '工程数据无效' };
        const st = loadState();
        const rawName = String(meta.name || '未命名工程');
        const baseName = safeLeafName(rawName, '未命名工程') + '.qfs';
        const def = validDir(st.lastExportDir) ? path.join(st.lastExportDir, baseName) : baseName;
        const { canceled, filePath } = await dialog.showSaveDialog({
            title: '导出工程 (.qfs)',
            defaultPath: def,
            filters: [
                { name: '清框影工程 (*.qfs)', extensions: ['qfs'] },
                { name: 'JSON', extensions: ['json'] }
            ]
        });
        if (canceled || !filePath) return { canceled: true };
        const header = {
            v: 2,
            kind: 'qfs',
            app: 'qingframe-web',
            name: rawName,
            createdAt: new Date().toISOString(),
            session: (meta.session && typeof meta.session === 'object') ? meta.session : {},
            template: (meta.template && typeof meta.template === 'object') ? meta.template : null
        };
        if (JSON.stringify(header).length > 16 * 1024 * 1024) return { ok: false, error: '工程模板超过 16MB' };
        const id = crypto.randomUUID();
        const tmpDir = path.join(qfsTmpRoot(), id);
        fs.mkdirSync(tmpDir, { recursive: true });
        qfsExports.set(id, { filePath, tmpDir, header, entries: [] });
        saveState({ lastExportDir: path.dirname(filePath) });
        return { ok: true, id };
    } catch (e) { return { ok: false, error: String(e) }; }
});
handleIpc('qfs-add-image', async (_e, payload) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    const id = payload && payload.id;
    const s = id && qfsExports.get(id);
    if (!s) return { ok: false, error: '导出会话已失效' };
    try {
        const entry = payload.entry && typeof payload.entry === 'object' ? Object.assign({}, payload.entry) : {};
        delete entry.data;
        let data = String(payload.data || '');
        const comma = data.indexOf(',');
        if (data.startsWith('data:') && comma > 0) data = data.slice(comma + 1);
        if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return { ok: false, error: '照片数据不是有效的 base64' };
        if (data.length > 96 * 1024 * 1024) return { ok: false, error: '单张照片数据超过 96MB' };
        if (JSON.stringify(entry).length > 16 * 1024 * 1024) return { ok: false, error: '单张照片模板超过 16MB' };
        if (s.entries.length >= 200) return { ok: false, error: '工程里的照片超过 200 张' };
        s.totalBytes = (s.totalBytes || 0) + data.length;
        if (s.totalBytes > 240 * 1024 * 1024) {
            s.totalBytes -= data.length;
            return { ok: false, error: '工程总大小超过 256MB，请分批导出' };
        }
        const file = path.join(s.tmpDir, `${s.entries.length}.b64`);
        await fs.promises.writeFile(file, data, 'utf-8');
        s.entries.push({ entry, file });
        return { ok: true, count: s.entries.length };
    } catch (e) { return { ok: false, error: String(e) }; }
});
handleIpc('qfs-finish-export', async (_e, id) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    const s = id && qfsExports.get(id);
    if (!s) return { ok: false, error: '导出会话已失效' };
    const out = fs.createWriteStream(s.filePath, { encoding: 'utf-8' });
    const write = (chunk) => new Promise((resolve, reject) => {
        const onError = (e) => { out.off('drain', onDrain); reject(e); };
        const onDrain = () => { out.off('error', onError); resolve(); };
        out.once('error', onError);
        if (!out.write(chunk)) out.once('drain', onDrain);
        else { out.off('error', onError); resolve(); }
    });
    try {
        const head = JSON.stringify(s.header);
        await write(head.slice(0, -1) + ',"images":[');
        for (let i = 0; i < s.entries.length; i++) {
            const e = s.entries[i];
            const meta = JSON.stringify(e.entry);
            await write((i ? ',' : '') + meta.slice(0, -1) + ',"data":"');
            const b64 = await fs.promises.readFile(e.file, 'utf-8');
            await write(b64);
            await write('"}');
        }
        await write(']}');
        await new Promise((resolve, reject) => {
            out.end(() => resolve());
            out.once('error', reject);
        });
        cleanupQfsSession(id);
        return { ok: true, name: s.header.name };
    } catch (e) {
        try { out.destroy(); } catch (_) { /* ignore */ }
        try { fs.unlinkSync(s.filePath); } catch (_) { /* ignore */ }
        cleanupQfsSession(id);
        return { ok: false, error: String(e) };
    }
});
handleIpc('qfs-cancel-export', (_e, id) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    if (id) cleanupQfsSession(id);
    return { ok: true };
});
app.on('will-quit', cleanupQfsTmpRoot);
app.on('will-quit', () => { try { disposeRaw(); } catch (e) { /* 退出阶段忽略 */ } });

handleIpc('export-qfs', async (_e, data) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    const st = loadState();
    const baseName = safeLeafName(data && data.name ? String(data.name) : '未命名工程', '未命名工程') + '.qfs';
    const def = validDir(st.lastExportDir) ? path.join(st.lastExportDir, baseName) : baseName;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出工程 (.qfs)',
        defaultPath: def,
        filters: [
            { name: '清框影工程 (*.qfs)', extensions: ['qfs'] },
            { name: 'JSON', extensions: ['json'] }
        ]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
        const json = JSON.stringify(data, null, 2);
        if (!json) return { ok: false, error: '工程内容无法序列化' };
        if (json.length > 256 * 1024 * 1024) return { ok: false, error: '工程超过 256MB，请改用流式导出' };
        fs.writeFileSync(filePath, json, 'utf-8');
        saveState({ lastExportDir: path.dirname(filePath) });
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

handleIpc('open-qfs', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '打开工程 (.qfs)',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [
            { name: '清框影工程 (*.qfs)', extensions: ['qfs'] },
            { name: 'JSON', extensions: ['json'] }
        ],
        properties: ['openFile']
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    try {
        const st = fs.statSync(filePaths[0]);
        if (st.size > 256 * 1024 * 1024) return { ok: false, error: '工程文件超过 256MB，暂不支持导入' };
        const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
        saveState({ lastOpenDir: path.dirname(filePaths[0]) });
        return { ok: true, name: path.basename(filePaths[0], path.extname(filePaths[0])), data };
    } catch (e) { return { ok: false, error: '工程文件格式错误：' + e.message }; }
});

handleIpc('get-user', () => {
    const st = loadState();
    return st.user || null;
});

handleIpc('save-user', (_e, user) => {
    saveState({ user });
    return { ok: true };
});

handleIpc('logout-user', () => {
    saveState({ user: null });
    return { ok: true };
});

// 界面偏好(导出质量等),与用户资料分开存
handleIpc('get-prefs', () => {
    const st = loadState();
    return st.prefs || {};
});

handleIpc('save-prefs', (_e, prefs) => {
    if (prefs && typeof prefs === 'object' && !Array.isArray(prefs)) saveState({ prefs });
    return { ok: true };
});

// ── 照片收集:文件/文件夹拖放与「导入文件夹」共用 ──
// 递归深度与数量都设上限,避免误拖整个磁盘或 node_modules 时卡死。
const IMAGE_EXT_SET = new Set(IMAGE_EXTS);
const collectImageFiles = async (inputPaths, limit) => {
    const out = [];
    const seen = new Set();
    let skipped = 0;
    const max = limit || 1000;
    const walk = async (p, depth) => {
        if (out.length >= max || depth > 8) return;
        let st;
        try { st = await fs.promises.stat(p); } catch (e) { skipped++; return; }
        if (st.isDirectory()) {
            let entries = [];
            try { entries = await fs.promises.readdir(p, { withFileTypes: true }); } catch (e) { skipped++; return; }
            entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
            for (const ent of entries) {
                if (out.length >= max) break;
                if (ent.name.startsWith('.')) continue;
                await walk(path.join(p, ent.name), depth + 1);
            }
            return;
        }
        if (!st.isFile()) { skipped++; return; }
        const ext = path.extname(p).slice(1).toLowerCase();
        if (!IMAGE_EXT_SET.has(ext)) { skipped++; return; }
        if (imageRejectReason(p, st.size)) { skipped++; return; }
        // 拖放 / 导入文件夹都走这里:收集成功即登记 qflocal 白名单。
        // 之前只在 collect-images 外层登记,导入文件夹路径会全部 403。
        allowImagePath(p);
        const real = path.resolve(p);
        if (seen.has(real)) return;
        seen.add(real);
        out.push({ name: path.basename(p), path: real, size: st.size, raw: isRaw(p) });
    };
    for (const p of inputPaths) await walk(String(p || ''), 0);
    return { items: out, skipped };
};

// EXIF 头部解析很便宜,但仍限制 6 并发,批量导入几百张时不让主进程排队太久。
const attachExif = async (items) => {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = Object.assign({}, items[i], { exif: await readPhotoExif(items[i].path) });
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
    return out;
};

// 粘贴图片落在 userData/paste:草稿恢复仍能找到文件;启动时清掉 7 天前的旧文件。
const pasteDir = () => path.join(app.getPath('userData'), 'paste');
const cleanupPasteDir = async () => {
    const dir = pasteDir();
    try {
        const names = await fs.promises.readdir(dir);
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        for (const n of names) {
            const fp = path.join(dir, n);
            const st = await fs.promises.stat(fp).catch(() => null);
            if (st && st.mtimeMs < cutoff) await fs.promises.unlink(fp).catch(() => {});
        }
    } catch (e) { /* 目录不存在时忽略 */ }
};

handleIpc('open-image', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择照片',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: IMAGE_FILTERS,
        properties: ['openFile']
    });
    if (canceled || filePaths.length === 0) return null;
    saveState({ lastOpenDir: path.dirname(filePaths[0]) });
    const fp = filePaths[0];
    const size = fs.statSync(fp).size;
    const reason = imageRejectReason(fp, size);
    if (reason) return { error: `图片过大（${reason}），已跳过` };
    allowImagePath(fp);
    return { name: path.basename(fp), path: fp, size, raw: isRaw(fp), exif: await readPhotoExif(fp) };
});

handleIpc('open-images', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择照片（可多选，第一张会成为当前主图）',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: IMAGE_FILTERS,
        properties: ['openFile', 'multiSelections']
    });
    if (canceled || !filePaths.length) return null;
    saveState({ lastOpenDir: path.dirname(filePaths[0]) });
    // 并发解析 EXIF:头部读取后单张约 1ms,但串行 await 会线性累加(Promise.all 保序)
    const items = (await Promise.all(filePaths.map(async (fp) => {
        const size = fs.statSync(fp).size;
        if (imageRejectReason(fp, size)) return null;
        allowImagePath(fp);
        return { name: path.basename(fp), path: fp, size, raw: isRaw(fp), exif: await readPhotoExif(fp) };
    }))).filter(Boolean);
    return items.length ? items : null;
});

// 拖放:渲染进程只拿得到 File 对象,这里把路径交给主进程统一递归收集(含文件夹)
handleIpc('collect-images', async (_e, paths) => {
    if (!Array.isArray(paths) || !paths.length) return { items: [], skipped: 0 };
    const r = await collectImageFiles(paths);
    return { items: await attachExif(r.items), skipped: r.skipped };
});

handleIpc('open-image-folder', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择照片文件夹（含子文件夹）',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        properties: ['openDirectory']
    });
    if (canceled || !filePaths.length) return null;
    saveState({ lastOpenDir: filePaths[0] });
    const r = await collectImageFiles([filePaths[0]]);
    return { items: await attachExif(r.items), skipped: r.skipped };
});

// 从系统剪贴板读图片(截图/网页复制):落盘为 PNG,后续与普通导入完全一致
handleIpc('read-clipboard-image', async () => {
    try {
        const img = clipboard.readImage();
        if (!img || img.isEmpty()) return null;
        const dir = pasteDir();
        await fs.promises.mkdir(dir, { recursive: true });
        const fp = path.join(dir, `paste-${Date.now()}.png`);
        await fs.promises.writeFile(fp, img.toPNG());
        allowImagePath(fp);
        const size = img.getSize();
        return {
            name: path.basename(fp), path: fp, size: fs.statSync(fp).size,
            width: size.width, height: size.height, exif: {}
        };
    } catch (e) {
        console.warn('[clipboard] 读取图片失败:', e && e.message);
        return null;
    }
});

handleIpc('read-exif', (_e, filePath) => {
    // 与其他敏感处理器对齐：只允许主框架调用，避免被（理论上不存在的）子框架借 EXIF 读取
    // 任意图片元数据（含可能携带的 GPS）。主窗口本身即受信帧，不会误伤正常读取。
    if (!isTrustedFrame(_e)) return {};
    const p = String(filePath || '');
    // 草稿恢复时先读 EXIF 再交给 <img>:这里顺带把路径登记进 qflocal 白名单。
    // 非图片扩展名/超大图直接拒绝,避免 read-exif 变成任意文件探测或解码炸弹入口。
    if (!SERVABLE_IMAGE_EXT.has(path.extname(p).toLowerCase())) return {};
    try {
        const size = fs.statSync(p).size;
        if (imageRejectReason(p, size)) return {};
    } catch (e) { return {}; }
    if (!allowImagePath(p)) return {};
    return readPhotoExif(p);
});

// 贴纸 / 自定义图标:体积小且须内嵌进模板(导出/导入不丢),仍走 base64 dataUrl
handleIpc('open-sticker-image', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择贴纸 / 图标图片',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
        properties: ['openFile']
    });
    if (canceled || filePaths.length === 0) return null;
    saveState({ lastOpenDir: path.dirname(filePaths[0]) });
    const fp = filePaths[0];
    const size = fs.statSync(fp).size;
    if (size > 64 * 1024 * 1024) return { error: '贴纸图片超过 64MB，已跳过' };
    const dim = imageSize(fp);
    if (dim && dim.width * dim.height > MAX_IMAGE_PIXELS) return { error: '贴纸图片像素超过 2 亿，已跳过' };
    return { name: path.basename(fp), data: fs.readFileSync(fp).toString('base64') };
});

handleIpc('save-image-base64', async (_e, { data, filename }) => {
    if (!isTrustedFrame(_e)) return false;
    const st = loadState();
    const dir = validDir(st.lastExportDir) ? st.lastExportDir : null;
    // 目标目录已有同名文件时自动加号,再次导出数字继续递增
    const safeName = safeExportName(filename, 'photo.png');
    const def = dir ? freeFilePath(dir, safeName) : safeName;
    // 默认过滤器跟随目标文件名扩展名:此前 PNG 恒排第一,导 JPG/WebP 时保存框先显示「PNG 图片」,
    // 一路回车就会拿到扩展名与内容不一致的文件。
    const ext = String(path.extname(safeName) || '.png').slice(1).toLowerCase();
    const allFilters = [
        { name: 'PNG 图片', extensions: ['png'] },
        { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
        { name: 'WebP 图片', extensions: ['webp'] }
    ];
    const matchFilter = allFilters.find(f => f.extensions.indexOf(ext) >= 0);
    const filters = matchFilter ? [matchFilter].concat(allFilters.filter(f => f !== matchFilter)) : allFilters;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出图片',
        defaultPath: def,
        filters: filters
    });
    if (canceled || !filePath) return false;
    if (!EXPORT_EXTS.has(path.extname(filePath).toLowerCase())) return false;
    fs.writeFileSync(filePath, ensurePngSrgb(Buffer.from(data, 'base64')));
    saveState({ lastExportDir: path.dirname(filePath) });
    return true;
});

handleIpc('save-images-batch', async (_e, files) => {
    if (!isTrustedFrame(_e)) return BLOCKED;
    // files: [{ data, filename }]
    if (!Array.isArray(files) || !files.length || files.length > 1000) return { canceled: true, error: '文件数量不合法' };
    let dir = null;
    const st = loadState();
    try {
        const res = await dialog.showOpenDialog({
            title: '选择导出目录',
            defaultPath: validDir(st.lastExportDir) ? st.lastExportDir : undefined,
            properties: ['openDirectory', 'createDirectory']
        });
        if (res.canceled || !res.filePaths.length) return { canceled: true };
        dir = res.filePaths[0];
    } catch (e) { return { canceled: true, error: String(e) }; }
    saveState({ lastExportDir: dir });
    let ok = 0, fail = 0;
    const written = new Set();
    try {
        for (const f of files) {
            if (!f || !f.data) { fail++; continue; }
            try {
                // 目录里已有同名文件(含本次已写入)时自动加号。
                // filename 来自渲染层,先收成单段安全文件名,避免 ..\ 写出所选目录。
                const safeName = safeExportName(f.filename, 'photo.png');
                const dest = resolveInside(dir, freeFilePath(dir, safeName, written));
                if (!dest) { fail++; continue; }
                fs.writeFileSync(dest, ensurePngSrgb(Buffer.from(f.data, 'base64')));
                written.add(path.basename(dest));
                ok++;
            } catch (e) { fail++; }
            // 必须用 handler 的形参(_e);这里原来写的是不存在的 `event`,
            // 一进循环就抛 ReferenceError 并被外层 catch 吞掉 → 只写完第 1 个文件。
            _e.sender.send('export-progress', { done: ok + fail, total: files.length });
        }
    } catch (e) { return { ok, fail, error: String(e) }; }
    return { ok, fail, dir };
});

// 先选好保存位置再导出:多文件选目录,单文件选文件(带默认文件名)
// 用户在「设置 → 默认导出位置」里指定过文件夹时直接落进去、不再弹框（ask=true 可临时改为询问）。
handleIpc('pick-export-location', async (_e, payload) => {
    const { count, hintName, ask } = payload || {};
    const st = loadState();
    const prefDir = (st.prefs && validDir(st.prefs.defaultExportDir)) ? st.prefs.defaultExportDir : null;
    if (prefDir && !ask) {
        const auto = autoExportTarget(prefDir, count, hintName, { validDir, freeFilePath });
        if (auto) {
            // lastExportDir 也同步一下：用户之后清掉默认位置，保存框仍从这里开始
            saveState({ lastExportDir: prefDir });
            return approveExportLocation(auto);
        }
    }
    const dir0 = validDir(st.lastExportDir) ? st.lastExportDir : undefined;
    if (count > 1) {
        const res = await dialog.showOpenDialog({
            title: '选择导出目录',
            defaultPath: dir0,
            properties: ['openDirectory', 'createDirectory']
        });
        if (res.canceled || !res.filePaths.length) return { canceled: true };
        const dir = res.filePaths[0];
        saveState({ lastExportDir: dir });
        return approveExportLocation({ mode: 'dir', dir });
    }
    const hint = safeExportName(hintName || 'photo.jpg', 'photo.jpg');
    const def = dir0 ? freeFilePath(dir0, hint) : hint;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出图片',
        defaultPath: def,
        filters: [
            { name: 'PNG 图片', extensions: ['png'] },
            { name: 'JPEG 图片', extensions: ['jpg'] },
            { name: 'WebP 图片', extensions: ['webp'] }
        ]
    });
    if (canceled || !filePath) return { canceled: true };
    // 用户手敲文件名没带扩展名时,按默认导出格式补全,避免写出无法打开的无后缀文件
    let fp = filePath;
    if (!/\.[a-zA-Z0-9]{1,5}$/.test(fp)) {
        // 用清洗后的 hint：未传 hintName 时 raw 值可能是 undefined，.match 会抛错
        const ext0 = (hint.match(/\.[^.]+$/) || ['.png'])[0];
        fp += ext0;
    }
    saveState({ lastExportDir: path.dirname(fp) });
    return approveExportLocation({ mode: 'file', filePath: fp });
});

// 「设置 → 默认导出位置」：选一个固定文件夹存进 prefs。
// 存的是用户亲自在系统框里选的目录，所以之后 autoExportTarget 直接复用是安全的。
handleIpc('pick-default-export-dir', async (event) => {
    if (!isTrustedFrame(event)) return BLOCKED;
    const st = loadState();
    const cur = (st.prefs && validDir(st.prefs.defaultExportDir)) ? st.prefs.defaultExportDir : undefined;
    const opts = {
        title: '选择默认导出文件夹',
        defaultPath: cur,
        properties: ['openDirectory', 'createDirectory']
    };
    // 挂到父窗口上做成模态：无父窗口的对话框在 Windows 上可能被主窗口盖住，
    // 用户看到的就是「点了没反应」（其实框已经开了，只是藏在后面）。
    const parent = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
    const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const dir = res.filePaths[0];
    saveState({ prefs: { defaultExportDir: dir } });
    return { ok: true, dir };
});

// 把已渲染好的导出数据写入选好的位置。
// 条目带 originalPath 时,经 exif-write 把原图 EXIF 移植进 JPEG 字节(失败静默回退为原字节)。
handleIpc('write-export-files', async (event, payload) => {
    if (!isTrustedFrame(event)) return BLOCKED;
    const files = payload && payload.files;
    if (!Array.isArray(files) || !files.length) return { ok: 0, fail: files ? files.length : 0 };
    if (files.length > 1000) return { ok: 0, fail: files.length, error: '文件数量超过上限' };
    // location 只认 pick-export-location 发出去的令牌,渲染层传来的 dir/filePath 不可信。
    const token = payload && payload.location && payload.location.token;
    const location = token && approvedExportLocations.get(token);
    if (!location) return { ok: 0, fail: files.length, error: '导出位置未授权,请重新选择导出目录' };
    if (location.mode === 'file') {
        if (!EXPORT_EXTS.has(path.extname(location.filePath).toLowerCase())) {
            return { ok: 0, fail: 1, error: '不支持的导出格式' };
        }
        try {
            fs.writeFileSync(location.filePath, ensurePngSrgb(await exifWrite.applyExifToExportItem(files[0])));
            event.sender.send('export-progress', { done: 1, total: 1 });
            return { ok: 1, fail: 0 };
        } catch (e) {
            const reason = String((e && e.message) || e);
            return { ok: 0, fail: 1, error: reason,
                failures: [{ name: path.basename(location.filePath), reason }] };
        }
    }
    if (location.mode !== 'dir') return { ok: 0, fail: files.length, error: '导出位置无效' };
    try {
        const st = fs.statSync(location.dir);
        if (!st.isDirectory()) return { ok: 0, fail: files.length, error: '导出目录无效' };
    } catch (e) { return { ok: 0, fail: files.length, error: '导出目录不存在' }; }
    let ok = 0;
    // 逐文件记下失败项：以前只在 catch 里 fail++，界面只知道「失败 3」，
    // 不知道是哪 3 张、为什么失败，更没法只重试这 3 张。
    const failures = [];
    const failItem = (f, reason) => {
        failures.push({
            name: String((f && (f.filename || f.stem)) || '未命名'),
            reason: String(reason || '写入失败')
        });
    };
    const written = new Set();
    try {
        for (const f of files) {
            // 空 data/bytes 也算一格并上报,否则 done 会卡在倒数一格不动
            if (!f || (!f.data && !f.bytes)) { failItem(f, '没有图像数据（渲染失败）'); }
            else {
                try {
                    const destDir = safeSubdir(location.dir, f.subdir);
                    if (destDir !== path.resolve(location.dir)) fs.mkdirSync(destDir, { recursive: true });
                    const fallback = (f.stem ? String(f.stem) : 'photo') + '.' + (f.ext || 'png');
                    const safeName = safeExportName(f.filename || fallback, 'photo.png');
                    const dest = resolveInside(destDir, freeFilePath(destDir, safeName, written));
                    if (!dest) { failItem({ filename: safeName }, '文件名无效'); }
                    else {
                        fs.writeFileSync(dest, ensurePngSrgb(await exifWrite.applyExifToExportItem(f)));
                        written.add(path.basename(dest));
                        ok++;
                    }
                } catch (e) { failItem(f, (e && e.message) || e); }
            }
            // 目录分支原来不发这个事件,渲染层 onExportProgress 永远收不到 →
            // 九宫格批量导出的进度条永远停在 2% / 「写盘 0/N」。逐张上报。
            event.sender.send('export-progress', { done: ok + failures.length, total: files.length });
        }
    } catch (e) { return { ok, fail: failures.length, error: String(e), failures }; }
    return { ok, fail: failures.length, failures };
});

    // 重复启动时把已有窗口拉到前台。只调 focus() 在 Windows 上不够:窗口被别的程序
    // 盖住时,前台锁会让 focus() 只闪一下任务栏,用户看到的就是"启动了但什么都没出现"。
    // 置顶再取消是能稳定抢到前台的顺序;flashFrame 兜底提示任务栏。
    const focusMainWindow = () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) { createWindow(); return; }
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.moveTop();
        if (process.platform === 'win32') {
            win.setAlwaysOnTop(true);
            win.focus();
            win.setAlwaysOnTop(false);
            win.flashFrame(true);
            setTimeout(() => { if (win && !win.isDestroyed()) win.flashFrame(false); }, 1500);
        } else {
            win.focus();
        }
    };
    app.on('second-instance', focusMainWindow);
    app.on('activate', focusMainWindow);
}

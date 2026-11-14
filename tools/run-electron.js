// 统一给 Electron 测试补上必需的命令行开关。
//
// 之前 package.json 里所有用例都是裸 `electron tools/xxx.js`,在这台机器上第一个用例
// (test:brand)就直接死在启动阶段:
//   ERROR:gpu_process_host.cc GPU process launch failed: error_code=18
//   FATAL:gpu_data_manager_impl_private.cc(449)] GPU process isn't usable. Goodbye.
// 于是 `npm test` 整条 && 链在第 8 个脚本就断了 —— 也就是说这个"能跑全量测试"的命令
// 从来没被真正跑通过,后面的用例是否有效根本没被验证过。
//
// 开关放在脚本路径**之前**,确保由 Electron 自己解析(放后面依赖 Chromium 兜底解析 argv)。
// 开关只影响测试进程,不碰 npm start / 打包后的应用。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SWITCHES = [
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-software-rasterizer',
    '--no-sandbox'
];

// 允许整组替换开关：不同环境对 GPU 的耐受度差很多（本机 --disable-gpu 会 segfault，
// 换成 --use-gl=swiftshader 才起得来；CI 上又是另一套）。示例：
//   QF_ELECTRON_FLAGS="--use-gl=swiftshader --no-sandbox" npm run test:wall
const envFlags = (process.env.QF_ELECTRON_FLAGS || '').trim();
const switches = envFlags ? envFlags.split(/\s+/).filter(Boolean) : SWITCHES;

// 允许换二进制：本机 node_modules/electron 那份起不来（start.bat 里记过：
// 项目目录被下过 Deny ACE，electron.exe 拿不到文件权限），但外面有一份同样版本的副本。
// CI 上不需要设，npm ci 装出来的就是好的。
const envBin = (process.env.QF_ELECTRON_BIN || '').trim();
const electron = envBin || require('electron');

const args = process.argv.slice(2);
if (!args.length) {
    console.error('用法: node tools/run-electron.js <script.js> [额外参数...]');
    process.exit(2);
}

// 某些 IDE / 集成终端会常驻注入 ELECTRON_RUN_AS_NODE=1（让 Electron 当纯 Node 用）。
// 一旦带进测试进程，electron.exe 会拒绝所有 Chromium 开关，打印
//   "bad option: --disable-gpu" 然后以 0 退出 —— 整组用例「假绿」，一个都没真跑。
// 测试 runner 必须显式清掉它；只影响子进程，不改调用方的环境。
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

// 部分 Windows 环境给系统 Temp 下过 Deny ACE：Electron 主进程 fs.mkdtempSync 会
// EPERM，且崩在 "App threw an error during load" 后不退出，把整条测试链挂死
// （纯 node CLI 层反而没事，所以极易误判成产品 bug）。
// 统一把子进程的临时目录挪到项目内可写位置；建不出来就保持系统默认，不强行改。
try {
    const tmpDir = path.join(__dirname, '..', '.tmp', 'electron');
    fs.mkdirSync(tmpDir, { recursive: true });
    childEnv.TEMP = tmpDir;
    childEnv.TMP = tmpDir;
    childEnv.TMPDIR = tmpDir;
} catch (_) { /* 退回系统默认 */ }

const child = spawn(electron, [...switches, ...args], {
    stdio: 'inherit', windowsHide: true, env: childEnv
});
child.on('close', (code, signal) => {
    // 被信号打断时也必须以非 0 退出,否则 npm 的 && 链会把"崩了"当成"通过"。
    process.exit(code === null ? (signal ? 1 : 1) : code);
});
child.on('error', (err) => {
    console.error('启动 Electron 失败:', err && err.message);
    process.exit(1);
});
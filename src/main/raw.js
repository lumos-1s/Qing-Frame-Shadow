'use strict';

// RAW 解码与显影（主进程侧）。
//
// 分工：
//   · 本文件负责调度、磁盘缓存、把像素交给 Electron 编成 JPEG；
//   · 真正的解码在一条常驻 worker 线程里（libraw-wasm），主进程不会被 2 秒的解码卡住；
//   · 色调映射在 raw-tonemap.js，纯函数，可在纯 node 下单独验证。
//
// 缓存键包含「文件 mtime + 参数」，所以同一张图反复拖滑块只要参数回过一次就直接命中；
// 换机身/换镜头不影响，换文件内容（mtime 变）自然失效。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const tonemap = require('./raw-tonemap');

// 常见 RAW 扩展名。不求全（Phase One 的 IIQ、适马的 X3F 都在，但老 Kodak 之类没列），
// 目标是覆盖主流机身：索尼/佳能/尼康/富士/松下/奥林巴斯/宾得/徕卡/大疆。
const RAW_EXTS = [
    'arw', 'sr2', 'srf',              // Sony
    'cr2', 'cr3', 'crw',              // Canon
    'nef', 'nrw',                     // Nikon
    'raf',                            // Fujifilm
    'rw2', 'rwl',                     // Panasonic / Leica
    'orf',                            // Olympus
    'pef', 'dng',                     // Pentax / 通用
    'srw',                            // Samsung
    'x3f',                            // Sigma
    '3fr', 'fff',                     // Hasselblad
    'iiq',                            // Phase One
    'mos', 'mrw', 'raw', 'k25', 'kdc', 'mef', 'arq', 'erf', 'dcr'
];
const RAW_EXT_SET = new Set(RAW_EXTS.map((e) => '.' + e));

const isRaw = (p) => RAW_EXT_SET.has(path.extname(String(p || '')).toLowerCase());

// 解码库位置。开发时在 node_modules；打包后 wasm 与 worker 必须落在 asar 之外，
// 否则 ESM import 与 fs 读 wasm 在部分版本上会失败（见 package.json 的 asarUnpack）。
function librawDist() {
    const candidates = [
        // 打包后优先用 asar 外的那份：worker 线程不走主进程的 asar 补丁，
        // 直接 import app.asar 里的 ESM/wasm 会失败（见 package.json asarUnpack）。
        path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'libraw-wasm', 'dist'),
        path.join(__dirname, '..', '..', 'node_modules', 'libraw-wasm', 'dist'),
        path.join(process.resourcesPath || '', 'app.asar', 'node_modules', 'libraw-wasm', 'dist')
    ];
    for (const dir of candidates) {
        try {
            if (fs.existsSync(path.join(dir, 'libraw.wasm'))) return dir;
        } catch (e) { /* 继续找下一个 */ }
    }
    return candidates[0];
}

// worker 里 require 的色调映射模块也要放在 asar 外：worker_threads 里没有
// Electron 的 asar fs 补丁，app.asar/src/main/raw-tonemap.js 在打包后读不到。
function tonemapPath() {
    const unpacked = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'src', 'main', 'raw-tonemap.js');
    try {
        if (fs.existsSync(unpacked)) return unpacked;
    } catch (e) { /* 开发环境继续用源码路径 */ }
    return path.join(__dirname, 'raw-tonemap.js');
}

// worker 用 eval 字符串启动：避免 asar 里的 .js 能不能被 worker_threads 加载这种环境问题。
// 线程里只做三件事：载入 wasm、解码、缩放 + 套表，然后把 BGRA 整块传回来（零拷贝转移）。

// LibRaw 的 -H 档位：0 = 把过曝通道直接裁掉，1..9 = 尝试用相邻通道补回。
//
// 试过 2，最后关掉，原因是实测数据不支持（不是没抄）：
//   · -H 2 会让 LibRaw 重新分配量程，整张图被压到约 0.57 倍，99.7% 分位从 182 掉到 104，
//     autoGain 要 6.5 才补得回来，而它被 [0.5,3] 夹住 → 全图暗 0.8 档，这是回归不是改进；
//   · 把增益手动补到 6.5 让亮度追平后，顶部 2% 的级数是 60，而 -H 0 是 59——高光并没有
//     "活过来"。
// 原因在我们自己的管线里：autoGain 把 99.7% 分位归一到 0.9 线性，高光肩又从固定 knee 起压，
// 恢复出来的那点余量正好被这两步重新归一化掉。想让 -H 有意义，得先改成"按实际数据范围
// 决定肩位"，那是另一件事。
const HIGHLIGHT_MODE = 0;

// 解码口径版本：动 outputBps / highlight 这类「看不见但会改变像素」的开关时必须 +1，
// 否则磁盘里按旧口径解出来的 JPEG 会按同一个键命中，用户看到的还是改之前的画面。
const DECODE_VERSION = 3;
const WORKER_SRC = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const tm = require(workerData.tonemapPath);

let modPromise = null;
function getModule() {
    if (!modPromise) {
        modPromise = (async () => {
            const { pathToFileURL } = require('url');
            const { default: factory } = await import(pathToFileURL(workerData.dist + '/libraw.js').href);
            return factory({ wasmBinary: fs.readFileSync(workerData.dist + '/libraw.wasm') });
        })();
    }
    return modPromise;
}

// 串行执行：LibRaw 单实例解码本来就吃内存，并发只会让峰值翻倍还互相拖慢。
let tail = Promise.resolve();
function run(job) {
    const next = tail.then(() => handle(job), () => handle(job));
    tail = next.then(() => {}, () => {});
    return next;
}

async function handle(job) {
    const t0 = Date.now();
    let raw = null;
    try {
        const mod = await getModule();
        const buf = fs.readFileSync(job.file);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        raw = new mod.LibRaw();
        await raw.open(ab, {
            useCameraWb: true,
            noAutoBright: true,
            // 位深由上游决定：全尺寸走 16、代理图走 8。
            // 代理只在拖动滑块时看效果，8 位够用、解码还快一截；
            // 全尺寸要经过曝光和高光肩再量化，8 位在那个环节已经只剩 256 级可拉。
            outputBps: job.bits === 16 ? 16 : 8,
            userQual: job.quality || 3,
            halfSize: !!job.halfSize,
            // -H：0 = 把过曝通道直接裁掉，1..9 = 用相邻通道把炸掉的那一两个补回来。
            // 过曝通常只先炸一个通道，另两个还有数据，0 等于把这份数据扔了。
            highlight: job.highlight == null ? 2 : job.highlight,
            // -1 = 按相机里的翻转标记输出。输出已经是正的，渲染层不能再按 EXIF Orientation 转一次。
            userFlip: -1
        });
        let meta = {};
        try { meta = (await raw.metadata()) || {}; } catch (e) { meta = {}; }
        const img = await raw.imageData();
        const sw = img.width;
        const sh = img.height;
        const ch = img.colors || 3;
        const total = sw * sh;
        const src = img.data;
        // 以实际拿到的类型为准：库有可能按别的位深打包，按要求的位深盲信会读出半张黑图。
        const wide = src instanceof Uint16Array;

        // 自动基线按原图算：裁切一块暗角不应该让整张照片的曝光跟着变。
        // 缩放后再算会受插值影响偏亮，所以也在缩放前。
        const gain = (wide ? tm.autoGain16(src, ch, total) : tm.autoGain(src, ch, total))
            * (Number(job.gainScale) || 1);
        // 裁切/旋转在缩放前做：代理图先从原图裁出目标区域再缩到 1600，
        // 不会先整图缩小再裁一次。裁切框是归一化坐标，代理/全尺寸共用。
        const view = tm.cropRotate(src, sw, sh, ch, job.crop, job.rotate);
        const vw = view.width;
        const vh = view.height;
        const vch = view.colors;
        let dw = vw;
        let dh = vh;
        if (job.maxEdge > 0) {
            const long = Math.max(vw, vh);
            if (long > job.maxEdge) {
                const k = job.maxEdge / long;
                dw = Math.max(1, Math.round(vw * k));
                dh = Math.max(1, Math.round(vh * k));
            }
        }
        const lut = wide ? tm.buildLut16(job.params, gain) : tm.buildLut(job.params, gain);
        let pixels;
        let colors;
        if (dw !== vw || dh !== vh) {
            pixels = tm.resizeBox(view.data, vw, vh, dw, dh, vch);
            colors = 4;
        } else {
            pixels = view.data;
            colors = vch;
        }
        const bgra = wide
            ? tm.toBgra16(pixels, colors, dw, dh, lut)
            : tm.toBgra(pixels, colors, dw, dh, lut);
        parentPort.postMessage({
            id: job.id,
            ok: true,
            // 线程自己的常驻内存：主进程据此决定什么时候把线程整体换掉。
            // wasm 堆只涨不缩，连续解几张全尺寸后线程会吃满 2GB 然后解码失败，
            // 表现就是「导出只有 1600px」。回收线程是唯一能真正把内存还给系统的办法。
            mem: process.memoryUsage().rss,
            width: dw,
            height: dh,
            bits: wide ? 16 : 8,
            gain: gain,
            ms: Date.now() - t0,
            meta: {
                make: meta.make || meta.camera_make || '',
                model: meta.model || meta.camera_model || '',
                iso: meta.iso_speed || meta.ISO || 0,
                lens: meta.lens || meta.LensModel || '',
                shutter: meta.shutter || meta.exposure_time || 0,
                aperture: meta.aperture || meta.f_number || 0,
                focal: meta.focal_len || meta.focal_length || 0,
                timestamp: meta.timestamp ? String(meta.timestamp) : ''
            },
            bgra
        }, [bgra.buffer]);
    } catch (e) {
        // e 不一定是个 Error：wasm 层 OOM 时抛出来的是带 message 字段的普通对象，
        // 旧写法 String(e.message) 会把它压成 "[object Object]"，日志里什么都看不出来。
        const msg = (e && typeof e.message === 'string') ? e.message
            : (e && e.message ? JSON.stringify(e.message) : String(e));
        parentPort.postMessage({
            id: job.id,
            ok: false,
            mem: process.memoryUsage().rss,
            error: ((e && e.name) ? e.name + ': ' : '') + msg
        });
    } finally {
        try { if (raw && raw.dispose) raw.dispose(); } catch (e) { /* 忽略 */ }
    }
}

parentPort.on('message', (job) => { if (job && job.id != null) run(job); });
`;

let worker = null;
let seq = 0;
const pending = new Map();
// 线程最后一次自报的常驻内存，以及换线程以来解过几张全尺寸。
// libraw 的 wasm 堆只涨不缩：每解一张 24MP 全尺寸大约留下 200MB，十几张后线程会
// 顶到 2GB 上限，之后再解就直接失败 —— 用户看到的是「导出只有 1600px」。
let workerRss = 0;
let fullJobs = 0;
let recycles = 0;
let recycleTimer = null;
const WORKER_RSS_LIMIT = 900 * 1024 * 1024;    // 超过这个：等手头空了就换线程
const WORKER_RSS_HARD = 1300 * 1024 * 1024;    // 再高就立刻换，别等下一次解码撞上限
const FULL_JOBS_PER_WORKER = 2;                // 或者解满两张全尺寸就换线程

// 换线程要重新加载 wasm（~1.4s）。刚解完全尺寸时用户很可能马上又拖滑块，
// 所以先等 1.2 秒；期间有新的解码请求就把回收取消，等下一个空档再说。
function scheduleRecycle() {
    if (recycleTimer) return;
    recycleTimer = setTimeout(() => {
        recycleTimer = null;
        if (!pending.size) recycleWorker();
    }, 1200);
    if (typeof recycleTimer.unref === 'function') recycleTimer.unref();
}

function cancelRecycle() {
    if (!recycleTimer) return;
    clearTimeout(recycleTimer);
    recycleTimer = null;
}

function failAll(err) {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
}

// 把线程整个结束掉，wasm 堆才会真正还给系统。下一次 request 会重新建一个，
// 代价只有一次模块加载（1 秒上下），比「解不出来」好得多。
function recycleWorker() {
    const w = worker;
    worker = null;
    workerRss = 0;
    fullJobs = 0;
    cancelRecycle();
    if (!w) return;
    recycles++;
    try { w.terminate(); } catch (e) { /* 忽略 */ }
}

// 只在没有排队任务时换线程：终止会把排队中的请求一起带走。
function maybeRecycleWorker(full) {
    if (pending.size) return;
    if (full) fullJobs++;
    if (workerRss > WORKER_RSS_HARD) { recycleWorker(); return; }
    if (workerRss > WORKER_RSS_LIMIT || fullJobs >= FULL_JOBS_PER_WORKER) scheduleRecycle();
}

function ensureWorker() {
    if (worker) return worker;
    const w = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { dist: librawDist(), tonemapPath: tonemapPath() },
        resourceLimits: { maxOldGenerationSizeMb: 2048 }
    });
    const gone = (err) => {
        // 主动回收（terminate）也会触发 error/exit：这时 worker 已经指向新线程，
        // 不能再把新线程排队中的请求一起拒掉。
        if (worker !== w) return;
        worker = null;
        workerRss = 0;
        fullJobs = 0;
        failAll(err);
    };
    w.on('message', (m) => {
        if (m && m.mem) workerRss = m.mem;
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m);
        else p.reject(new Error(m.error || 'RAW 解码失败'));
    });
    w.on('error', (e) => gone(e instanceof Error ? e : new Error(String(e))));
    w.on('exit', () => gone(new Error('RAW 解码线程已退出')));
    // 线程不该拖住应用退出；有任务时 request 会自己保活。
    if (typeof w.unref === 'function') w.unref();
    worker = w;
    return w;
}

function decode(job) {
    // 有新的解码请求：先把排队中的「换线程」取消，别在用户拖滑块时重建 wasm。
    cancelRecycle();
    // 但要先看一眼线程的账：上一张已经把内存吃到限额，就先换线程再解，
    // 否则这一张很可能正好是压垮它的那张（wasm 堆 2GB 就报 [object Object]）。
    if (worker && !pending.size && (workerRss > WORKER_RSS_LIMIT || fullJobs >= FULL_JOBS_PER_WORKER)) {
        recycleWorker();
    }
    const w = ensureWorker();
    return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, highlight: HIGHLIGHT_MODE, ...job });
    });
}

// ── 磁盘缓存 ────────────────────────────────────────────────────────────────
// 只缓存"解码结果"，不缓存用户照片编辑：参数变了就是另一个键，天然不会串味。
let cacheRoot = '';
function setCacheRoot(dir) { cacheRoot = dir; }
function cacheDir() {
    if (!cacheRoot) throw new Error('RAW 缓存目录未初始化');
    return cacheRoot;
}

function cacheKey(file, stat, params, maxEdge, view, bits, highlight, gainScale) {
    const h = crypto.createHash('sha1');
    h.update('v' + DECODE_VERSION);           // 解码口径（位深策略 / highlight 档）变了就整体作废
    h.update(String(file));
    h.update('|' + stat.size + '|' + Math.round(stat.mtimeMs));
    h.update('|' + JSON.stringify(params) + '|' + maxEdge + '|' + (bits || 0)
        + '|h' + (highlight || 0) + '|g' + (gainScale || 1));
    // 裁切/旋转也是显影参数的一部分：同一组滑块、不同裁切框必须分开缓存。
    h.update('|' + JSON.stringify(view || null));
    return h.digest('hex');
}

function readCache(key) {
    const jpg = path.join(cacheDir(), key + '.jpg');
    const side = path.join(cacheDir(), key + '.json');
    try {
        const buf = fs.readFileSync(jpg);
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(side, 'utf8')); } catch (e) { /* 没 sidecar 也能用 */ }
        // 命中时把访问时间推一下，LRU 清理按 mtime 排队。
        const now = new Date();
        try { fs.utimesSync(jpg, now, now); } catch (e) { /* 只读盘就算了 */ }
        return { buf, meta, cached: true };
    } catch (e) {
        return null;
    }
}

function writeCache(key, buf, meta) {
    const dir = cacheDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 已存在 */ }
    const jpg = path.join(dir, key + '.jpg');
    const side = path.join(dir, key + '.json');
    // 先写临时名再 rename：解码过程中退出应用，也不会留下半张 JPEG 被当成缓存。
    try {
        const tmp = jpg + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, jpg);
        fs.writeFileSync(side, JSON.stringify(meta || {}));
    } catch (e) { /* 写不进缓存不影响这次显示 */ }
}

let pruneTimer = 0;
function pruneCache(limitBytes) {
    if (pruneTimer) return;
    pruneTimer = setTimeout(() => {
        pruneTimer = 0;
        try {
            const dir = cacheDir();
            const names = fs.readdirSync(dir).filter((n) => n.endsWith('.jpg'));
            if (names.length <= 24) return;
            const files = names.map((n) => {
                const fp = path.join(dir, n);
                const st = fs.statSync(fp);
                return { fp, size: st.size, mtime: st.mtimeMs, side: fp.replace(/\.jpg$/, '.json') };
            }).sort((a, b) => a.mtime - b.mtime);
            let total = files.reduce((s, f) => s + f.size, 0);
            const cap = limitBytes || 900 * 1024 * 1024;
            let i = 0;
            while (total > cap && i < files.length - 8) {
                const f = files[i++];
                total -= f.size;
                try { fs.unlinkSync(f.fp); } catch (e) { /* 正在读就算了 */ }
                try { fs.unlinkSync(f.side); } catch (e) { /* 同上 */ }
            }
        } catch (e) { /* 清理失败不影响主流程 */ }
    }, 4000);
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
}

// ── 对外接口 ────────────────────────────────────────────────────────────────

let encoder = null;
function jpegEncoder() {
    if (!encoder) encoder = require('electron').nativeImage;
    return encoder;
}

/**
 * 显影一张 RAW，返回 JPEG Buffer。
 * @param {string} file   RAW 文件路径
 * @param {object} opts   { params, maxEdge, quality, halfSize, cache }
 */
async function develop(file, opts) {
    const o = opts || {};
    const params = tonemap.normalize(o.params);
    // view 也要经过同一套裁剪：URL、草稿、旧版本都可能塞进越界值。
    const view = tonemap.normalizeView(o.crop, o.rotate);
    const maxEdge = Math.max(0, Number(o.maxEdge) || 0);
    // 位深策略：全尺寸（导出 / 停手后补齐）走 16 位，代理图走 8 位。
    // 16 位真正的作用不是"更好看"，是拖高光/曝光时脚下的台阶从 256 级变成 65536 级。
    const bits = o.bits === 8 || o.bits === 16 ? o.bits : (maxEdge === 0 ? 16 : 8);
    // -H 档位也允许外部指定：测试要拿 0 和 2 做对照，否则没法证明这一档真的改了东西。
    const highlight = o.highlight == null || !Number.isFinite(Number(o.highlight))
        ? HIGHLIGHT_MODE
        : Math.max(0, Math.min(9, Math.round(Number(o.highlight))));
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) throw new Error('文件不存在：' + path.basename(file));

    const gainScale = Number(o.gainScale) || 1;
    const key = cacheKey(file, stat, params, maxEdge, view, bits, highlight, gainScale);
    if (o.cache !== false) {
        const hit = readCache(key);
        if (hit) return { jpg: hit.buf, meta: hit.meta, cached: true, width: hit.meta.width, height: hit.meta.height };
    }

    const job = {
        file,
        params,
        maxEdge,
        bits,
        highlight,
        // 对照实验用：自动基线再乘一个倍数。改 -H 档位会让 LibRaw 重新分配量程，
        // 亮度整体位移，要判断"高光是真活了还是只是变暗"，必须先把亮度追平再比。
        gainScale: Number(o.gainScale) || 1,
        quality: o.quality || 3,
        halfSize: !!o.halfSize,
        crop: view.crop,
        rotate: view.rotate
    };
    let res;
    try {
        res = await decode(job);
    } catch (e) {
        // 解码失败多半是线程被 wasm 堆顶死了。线程已经不健康，换掉后用同一份参数
        // 再试一次：这一层是兜底，渲染层的重试只在「导出前补齐」那条路上生效。
        const heavy = workerRss > 200 * 1024 * 1024 || fullJobs > 0;
        recycleWorker();
        if (!heavy) throw e;
        res = await decode(job);
    }

    const img = jpegEncoder().createFromBitmap(Buffer.from(res.bgra.buffer, res.bgra.byteOffset, res.bgra.byteLength), {
        width: res.width,
        height: res.height
    });
    // 16 位解出来的渐变，靠 8 位 JPEG 落盘时最怕的就是量化把台阶又装回去。
    // q95 比 q93 多约 12% 体积，换来天空不再出现横条——全尺寸缓存是按参数键存的，
    // 不会每次加载都重编码，这点体积值得。
    const jpg = img.toJPEG(maxEdge && maxEdge <= 2048 ? 90 : 95);
    const meta = {
        width: res.width,
        height: res.height,
        bits: res.bits || bits,
        gain: Number(res.gain.toFixed(3)),
        camera: [res.meta.make, res.meta.model].filter(Boolean).join(' ').trim()
    };
    if (o.cache !== false) {
        writeCache(key, jpg, meta);
        pruneCache(o.cacheLimit);
    }
    maybeRecycleWorker(maxEdge === 0);
    return { jpg, meta, cached: false, width: res.width, height: res.height, ms: res.ms };
}

function dispose() {
    const w = worker;
    worker = null;
    workerRss = 0;
    fullJobs = 0;
    cancelRecycle();
    if (w) {
        try { w.terminate(); } catch (e) { /* 忽略 */ }
    }
    failAll(new Error('RAW 解码线程已停止'));
}

// 给用例看的解码线程状态：验证「连续解多张不会把线程吃死」。
function stats() {
    return { running: !!worker, rss: workerRss, fullJobs, recycles, pending: pending.size };
}

module.exports = {
    RAW_EXTS,
    RAW_EXT_SET,
    isRaw,
    develop,
    dispose,
    stats,
    setCacheRoot,
    cacheDir,
    _cacheKey: cacheKey
};

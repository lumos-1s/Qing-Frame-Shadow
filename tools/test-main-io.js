// 主进程 IO 不变量回归测试(纯 node,不需要 Electron)
//   node tools/test-main-io.js
//
// 覆盖不依赖 Electron 的主进程不变量:
//   ① src/main/exif-read.js  — 只读文件头部解析 EXIF,结果必须与"整读 + parseExif"逐字段一致
//   ② src/main/state.js      — freeFilePath 用一次 readdirSync 取代逐个 existsSync,选名必须一致
//   ⑦ shared/marks           — 内置标记的尺寸与安全约束
//   ⑧ src/main/index.js      — IPC 注册必须统一经过 handleIpc/onIpc(静态检查)
//
// 为什么单独一个文件:这些逻辑都在主进程,Electron 的那批用例(走真实 renderer)覆盖不到;
// 而它们又都是纯 node 可测的,放进来就能进 npm run check,不依赖 GUI。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const exifUtil = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'exif.js'));
const { readExif, exifSegmentState, EXIF_HEAD_BYTES } = require(path.join(__dirname, '..', 'src', 'main', 'exif-read.js'));
const { createStateStore, writeFileAtomic } = require(path.join(__dirname, '..', 'src', 'main', 'state.js'));

let fails = 0;
function ok(cond, label, extra) {
    if (cond) { console.log('  OK   ' + label); return; }
    fails++;
    console.log('  FAIL ' + label + (extra ? '   ' + extra : ''));
}

/* ─────────── 合成 JPEG(带真实 EXIF APP1 段) ─────────── */
function buildExifApp1(make, model, orientation) {
    const enc = (s) => Buffer.from(s + '\0', 'latin1');
    const makeB = enc(make), modelB = enc(model);
    const nEntries = 3;
    const dataStart = 8 + (2 + nEntries * 12 + 4);
    const makeOff = dataStart;
    const modelOff = makeOff + makeB.length;
    const tiff = Buffer.alloc(dataStart + makeB.length + modelB.length);
    tiff.write('II', 0, 'latin1');          // 小端
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);               // IFD0 偏移
    let p = 8;
    tiff.writeUInt16LE(nEntries, p); p += 2;
    const entry = (tag, type, count, value) => {
        tiff.writeUInt16LE(tag, p);
        tiff.writeUInt16LE(type, p + 2);
        tiff.writeUInt32LE(count, p + 4);
        if (type === 3) { tiff.writeUInt16LE(value, p + 8); tiff.writeUInt16LE(0, p + 10); }
        else tiff.writeUInt32LE(value, p + 8);
        p += 12;
    };
    entry(0x010F, 2, makeB.length, makeOff);     // Make  (ascii)
    entry(0x0110, 2, modelB.length, modelOff);   // Model (ascii)
    entry(0x0112, 3, 1, orientation);            // Orientation (short, 内联)
    tiff.writeUInt32LE(0, p);                    // 无下一个 IFD
    makeB.copy(tiff, makeOff);
    modelB.copy(tiff, modelOff);

    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const seg = Buffer.alloc(4 + payload.length);
    seg.writeUInt16BE(0xFFE1, 0);
    seg.writeUInt16BE(payload.length + 2, 2);    // 段长 = 载荷 + 自身 2 字节
    payload.copy(seg, 4);
    return seg;
}

// 造一个长度可控的 APP2 填充段(marker + 长度 + 载荷)
function fillerSeg(total) {
    const payload = total - 4;
    const b = Buffer.alloc(total);
    b.writeUInt16BE(0xFFE2, 0);
    b.writeUInt16BE(payload + 2, 2);
    return b;
}

// 让 APP1 恰好从 startOffset 开始
function padTo(startOffset) {
    let need = startOffset - 2;                   // 已经写了 SOI 的 2 字节
    const parts = [];
    while (need > 0) {
        const total = Math.min(need, 2 + 2 + 65533);   // 单段上限:payload 65533
        parts.push(fillerSeg(total));
        need -= total;
    }
    return Buffer.concat(parts);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-io-test-'));
function writeTmp(name, buf) { const p = path.join(tmpDir, name); fs.writeFileSync(p, buf); return p; }

// 改动前的实现:整读 + parseExif
async function oldReadExif(p) {
    const buf = await fs.promises.readFile(p);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return exifUtil.exifSummary(exifUtil.parseExif(ab)) || {};
}

(async () => {
    console.log('主进程 IO 不变量(纯 node)');
    console.log('─'.repeat(72));

    const MAKE = 'Canon', MODEL = 'Canon EOS R5', ORIENT = 6;
    const expected = { make: MAKE, model: MODEL, orientation: ORIENT };
    const app1 = buildExifApp1(MAKE, MODEL, ORIENT);

    /* ① 小 JPEG(<头部窗口):走整读分支,结果正确 */
    const small = writeTmp('small.jpg', Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, Buffer.from([0xFF, 0xD9])]));
    const r1 = await readExif(small);
    ok(JSON.stringify(r1) === JSON.stringify(expected), '① 小 JPEG:结果正确', JSON.stringify(r1));

    /* ② 大 JPEG(>头部窗口)+ APP1 在窗口内:走头部快路径 */
    const bigHead = writeTmp('big-head.jpg', Buffer.concat([
        Buffer.from([0xFF, 0xD8]), app1, Buffer.alloc(EXIF_HEAD_BYTES * 2, 0x20)
    ]));
    const headBuf = Buffer.alloc(EXIF_HEAD_BYTES);
    const fd = fs.openSync(bigHead, 'r');
    fs.readSync(fd, headBuf, 0, EXIF_HEAD_BYTES, 0);
    fs.closeSync(fd);
    ok(exifSegmentState(headBuf) === 'full', '② 大 JPEG:段完整落在头部窗口内(判定 full)');
    const r2 = await readExif(bigHead);
    ok(JSON.stringify(r2) === JSON.stringify(expected), '② 大 JPEG:头部解析结果正确', JSON.stringify(r2));

    /* ③ 大 JPEG + APP1 跨窗口边界:判定必须是 beyond,并回退整读拿到同样结果 */
    const straddleStart = EXIF_HEAD_BYTES - 2048;          // 段起点在窗口内、段尾在窗口外
    const longApp1 = buildExifApp1(MAKE, 'X'.repeat(4096), ORIENT);
    const bigBeyond = writeTmp('big-beyond.jpg', Buffer.concat([
        Buffer.from([0xFF, 0xD8]), padTo(straddleStart), longApp1, Buffer.alloc(EXIF_HEAD_BYTES * 2, 0x20)
    ]));
    const headBuf2 = Buffer.alloc(EXIF_HEAD_BYTES);
    const fd2 = fs.openSync(bigBeyond, 'r');
    fs.readSync(fd2, headBuf2, 0, EXIF_HEAD_BYTES, 0);
    fs.closeSync(fd2);
    ok(exifSegmentState(headBuf2) === 'beyond', '③ 跨边界:判定为 beyond(必须回退整读)', 'got=' + exifSegmentState(headBuf2));
    const r3 = await readExif(bigBeyond);
    const oldR3 = await oldReadExif(bigBeyond);
    ok(JSON.stringify(r3) === JSON.stringify(oldR3) && r3.make === MAKE,
        '③ 跨边界:回退后结果与整读一致', JSON.stringify(r3));

    /* ④ 大 PNG(非 JPEG):判定 absent,不应为了必然为空的结果去整读 */
    const png = writeTmp('big.png', Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(EXIF_HEAD_BYTES * 2, 0x11)
    ]));
    const headBuf3 = Buffer.alloc(EXIF_HEAD_BYTES);
    const fd3 = fs.openSync(png, 'r');
    fs.readSync(fd3, headBuf3, 0, EXIF_HEAD_BYTES, 0);
    fs.closeSync(fd3);
    ok(exifSegmentState(headBuf3) === 'absent', '④ 大 PNG:判定为 absent');
    const r4 = await readExif(png);
    ok(JSON.stringify(r4) === '{}', '④ 大 PNG:返回空 EXIF(与整读一致)', JSON.stringify(r4));

    /* ④b 大 JPEG 但头部已扫到 SOS：确定无 EXIF，不必整读 */
    const bigNoExif = writeTmp('big-noexif.jpg', Buffer.concat([
        Buffer.from([0xFF, 0xD8]), fillerSeg(64), Buffer.from([0xFF, 0xDA, 0x00, 0x08]),
        Buffer.alloc(EXIF_HEAD_BYTES * 2, 0x33)
    ]));
    const headBufNo = Buffer.alloc(EXIF_HEAD_BYTES);
    const fdNo = fs.openSync(bigNoExif, 'r');
    fs.readSync(fdNo, headBufNo, 0, EXIF_HEAD_BYTES, 0);
    fs.closeSync(fdNo);
    ok(exifSegmentState(headBufNo) === 'no-exif', '④b 无 EXIF 的大 JPEG:扫到 SOS 即确定 absent',
        'got=' + exifSegmentState(headBufNo));
    const rNo = await readExif(bigNoExif);
    ok(JSON.stringify(rNo) === '{}', '④b 无 EXIF 的大 JPEG:无需整读也返回空', JSON.stringify(rNo));

    /* ⑤ 仓库内真实图片:不应抛错 */
    const texDir = path.join(__dirname, '..', 'shared', 'textures');
    if (fs.existsSync(texDir)) {
        const pics = fs.readdirSync(texDir).filter(f => /\.(png|jpe?g)$/i.test(f)).slice(0, 5);
        let same = true, detail = '';
        for (const f of pics) {
            const p = path.join(texDir, f);
            const a = await readExif(p), b = await oldReadExif(p);
            if (JSON.stringify(a) !== JSON.stringify(b)) { same = false; detail = f; }
        }
        ok(same, '⑤ 真实图片(' + pics.length + ' 张):头部解析与整读一致', detail);
    }

    /* ⑥ freeFilePath:改动前后逐例等价 */
    const { freeFilePath } = createStateStore(path.join(tmpDir, 'state.json'));
    const OLD_freeFilePath = (dir, filename, used) => {
        const ext = path.extname(filename);
        const stem = filename.slice(0, filename.length - ext.length);
        const taken = (p) => {
            if (used && used.has(path.basename(p))) return true;
            try { return fs.existsSync(p); } catch (e) { return true; }
        };
        let i = 0, cand = path.join(dir, filename);
        while (taken(cand)) { i++; cand = path.join(dir, `${stem}_${i}${ext}`); }
        return cand;
    };
    const d = path.join(tmpDir, 'out');
    fs.mkdirSync(d, { recursive: true });
    ['photo.jpg', 'photo_1.jpg', 'PHOTO2.JPG'].forEach(n => fs.writeFileSync(path.join(d, n), 'x'));
    const cases = [
        ['photo.jpg', null, 'photo_2.jpg'],
        ['photo2.jpg', null, 'photo2_1.jpg'],                    // Windows 大小写不敏感:PHOTO2.JPG 已存在
        ['fresh.png', null, 'fresh.png'],
        ['photo.jpg', new Set(['photo_2.jpg']), 'photo_3.jpg'],   // used 集合参与判重
    ];
    for (const [name, used, want] of cases) {
        const a = path.basename(OLD_freeFilePath(d, name, used));
        const b = path.basename(freeFilePath(d, name, used));
        ok(a === b && b === want, `⑥ freeFilePath ${name}${used ? ' +used' : ''}`, `旧=${a} 新=${b} 期望=${want}`);
    }
    const missing = path.join(tmpDir, 'nope');
    ok(OLD_freeFilePath(missing, 'a.jpg') === freeFilePath(missing, 'a.jpg'),
        '⑥ freeFilePath 目录不存在时回退一致');

    /* ⑦ 内置标记(shared/marks):随包分发的自绘标记,必须结构安全、尺寸明确 */
    {
        const { imageMimeOf } = require(path.join(__dirname, '..', 'src', 'main', 'image-mime.js'));
        ok(imageMimeOf('a.svg') === 'image/svg+xml' && imageMimeOf('A.SVG') === 'image/svg+xml',
            '⑦ 扩展名→MIME:.svg(大小写不敏感)');
        ok(imageMimeOf('a.png') === 'image/png' && imageMimeOf('a.jpg') === 'image/jpeg' && imageMimeOf('a.jpeg') === 'image/jpeg',
            '⑦ 扩展名→MIME:.png/.jpg/.jpeg 保持原行为');
        ok(imageMimeOf('noext') === 'image/jpeg', '⑦ 无扩展名回退为 image/jpeg(与改动前一致)');

        const marksDir = path.join(__dirname, '..', 'shared', 'marks');
        const files = fs.existsSync(marksDir) ? fs.readdirSync(marksDir).filter(f => f.endsWith('.svg')) : [];
        ok(files.length >= 8, '⑦ shared/marks 至少有 8 个标记文件', '实际=' + files.length);

        const BRANDS = ['canon', 'sony', 'nikon', 'fuji', 'leica', 'apple', 'samsung', 'dji', 'gopro',
            'xiaomi', 'huawei', 'oppo', 'vivo', 'nikon', 'panasonic', 'pentax', 'hasselblad', 'zeiss'];
        let bad = '';
        for (const f of files) {
            const src = fs.readFileSync(path.join(marksDir, f), 'utf-8');
            // 显式 width/height:SVG 放进 <img> 或 drawImage 时必须靠它给出固有尺寸,否则会是 0
            if (!/^<svg[^>]*\bwidth="\d+"[^>]*\bheight="\d+"[^>]*viewBox=/.test(src)) {
                bad = f + ': 缺少显式 width/height/viewBox'; break;
            }
            // 池子里的图标会直接进 <img src>,不能让 SVG 带脚本或外部引用
            if (/<script|onload=|<image|xlink:href|href\s*=\s*["']https?:/i.test(src)) {
                bad = f + ': 含脚本或外部引用'; break;
            }
            if (BRANDS.some(b => f.toLowerCase().includes(b))) { bad = f + ': 文件名撞到第三方品牌名'; break; }
        }
        ok(!bad, '⑦ 每个标记:尺寸明确、无脚本/外链、文件名不撞品牌', bad);

        const shapes = [...new Set(files.map(f => f.replace(/_(White|Black)\.svg$/i, '')))];
        let pairBad = '';
        for (const n of shapes) {
            if (!files.includes(n + '_White.svg') || !files.includes(n + '_Black.svg')) pairBad = n;
        }
        ok(!pairBad && shapes.length >= 8, `⑦ ${shapes.length} 种造型各有 White/Black 两版(深/浅照片都能用)`, pairBad);
    }

    /* ⑧ IPC 注册:必须统一经过 handleIpc/onIpc,直接写 ipcMain.handle/on 会漏掉来源校验 */
    {
        const mainDir = path.join(__dirname, '..', 'src', 'main');
        const raw = [];
        for (const f of fs.readdirSync(mainDir).filter(x => x.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(mainDir, f), 'utf-8');
            const n = (src.match(/ipcMain\.(handle|on)\(/g) || []).length;
            if (n) raw.push(`${f}:${n}`);
        }
        // 唯一允许出现的地方是 index.js 里的两个包装器定义(handle + on 各一处)
        ok(raw.length === 1 && raw[0] === 'index.js:2',
            '⑧ IPC 注册只经过统一包装器（raw ipcMain.handle/on 仅包装器内 2 处）', raw.join(', '));
    }

    /* ⑨ 原子写：覆盖已有文件后内容正确，且不留下临时文件 */
    {
        const target = path.join(tmpDir, 'atomic.json');
        fs.writeFileSync(target, 'old');
        writeFileAtomic(target, '{"new":1}', 'utf-8');
        const leftovers = fs.readdirSync(tmpDir).filter(n => n.includes('atomic.json.tmp'));
        ok(fs.readFileSync(target, 'utf-8') === '{"new":1}' && leftovers.length === 0,
            '⑨ 原子写覆盖目标且清理临时文件', JSON.stringify(leftovers));
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('─'.repeat(72));
    console.log(fails ? `✖ ${fails} 项未通过` : '✓ 全部通过');
    process.exit(fails ? 1 : 0);
})().catch(e => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    console.error(e);
    process.exit(1);
});

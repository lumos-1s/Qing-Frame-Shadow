// EXIF 读取:只读文件头部,不整读照片(主进程用,独立于 electron 便于用纯 node 验证)
//
// 为什么能只读头部:解析器(../renderer/js/exif.js)只认 JPEG 的段结构(FF xx + 2 字节长度),
// 而**单个 JPEG 段的长度上限是 65535 字节**,所以 EXIF 的 APP1 段必然落在文件很靠前的位置。
// 原来 fs.readFile 把整张照片读进内存只为解析这几十 KB:批量导入 20 张 40MB 照片 = 白白搬运 800MB。
//
// 正确性策略(结果必须与整读逐字段一致):
//   1. 文件 ≤ 头部窗口        → 直接整读(没有收益差,也无需判断)
//   2. 窗口内找到完整 APP1/Exif → 用窗口解析
//   3. 找到了但段尾超出窗口 / 是 JPEG 却没找到 → 回退整读
//   4. 非 JPEG 容器           → 只解析窗口
//      (PNG/WebP 的 eXIf chunk 本解析器读不到,整读也只会得到 {}
//       —— 不为了一个必然为空的结果去搬整个文件)
'use strict';

const fs = require('fs');
const path = require('path');
const exifUtil = require(path.join(__dirname, '..', 'renderer', 'js', 'exif.js'));

const EXIF_HEAD_BYTES = 256 * 1024;
const JPEG_EXTS = ['.jpg', '.jpeg'];

async function readHead(filePath, bytes) {
    const fh = await fs.promises.open(filePath, 'r');
    try {
        const buf = Buffer.allocUnsafe(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close().catch(() => {});
    }
}

// 在 buf 里找 APP1/Exif 段。返回:
//   'full'   整段都在窗口内(可安全解析)
//   'beyond' 找到了,但段尾超出窗口
//   'no-exif' 扫到 SOS(压缩图像数据起点)仍没找到；JPEG 元数据段必须在 SOS 之前，
//             到这里就能确定没有 EXIF，不必再整读几十 MB
//   'absent' 扫到窗口末尾也没找到（可能不是 JPEG，也可能头部没截到 SOS）
function exifSegmentState(buf) {
    let off = 2;
    while (off + 4 <= buf.byteLength) {
        if (buf[off] !== 0xFF) { off++; continue; }
        const marker = buf[off + 1];
        if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
        // SOS 之后就是图像扫描数据，不会再有 APP1/Exif 段。
        if (marker === 0xDA) return 'no-exif';
        const len = buf.readUInt16BE(off + 2);
        if (marker === 0xE1 && len >= 10) {
            let isExif = true;
            const sig = 'Exif\0\0';
            for (let i = 0; i < 6; i++) if (buf[off + 4 + i] !== sig.charCodeAt(i)) { isExif = false; break; }
            if (isExif) return (off + 2 + len <= buf.byteLength) ? 'full' : 'beyond';
        }
        off += 2 + len;
    }
    return 'absent';
}

function parseBuf(buf) {
    if (!buf || !buf.length) return {};
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return exifUtil.parseExif(ab);
}

async function readExif(filePath) {
    try {
        if (!filePath) return {};
        const st = await fs.promises.stat(filePath).catch(() => null);
        if (!st || !st.isFile() || !st.size) return {};

        let raw;
        if (st.size <= EXIF_HEAD_BYTES) {
            raw = parseBuf(await fs.promises.readFile(filePath));
        } else {
            const isJpeg = JPEG_EXTS.includes(path.extname(filePath).toLowerCase());
            try {
                const head = await readHead(filePath, EXIF_HEAD_BYTES);
                const state = exifSegmentState(head);
                // 'no-exif' 已扫到 SOS，能确定没有 EXIF；只有「段尾超窗口」或
                // 「窗口里没扫完（absent）」才需要整读兜底，避免无 EXIF 大图反复搬运整文件。
                if (state === 'beyond' || (state === 'absent' && isJpeg)) {
                    raw = parseBuf(await fs.promises.readFile(filePath));  // 头部没覆盖到 → 整读
                } else {
                    raw = parseBuf(head);
                }
            } catch (e) {
                // 头部窗口里碰到越界偏移(畸形/异形 EXIF)会抛 RangeError —— 整读兜底,
                // 宁可多读一次也不能丢字段(丢了 orientation 会让照片错误旋转)。
                raw = parseBuf(await fs.promises.readFile(filePath));
            }
        }
        return exifUtil.exifSummary(raw) || {};
    } catch (e) { return {}; }
}

// ── ICC 色彩空间 ─────────────────────────────────────────────
// 相机可以选择把 JPEG 存成 Adobe RGB（色域比 sRGB 大）。浏览器（Chromium）加载时会读这段
// profile 并**转换成 sRGB** 再交给 canvas —— 也就是说渲染层拿到的数值已经不是文件里的数值了。
// PS 若按嵌入配置文件（Adobe RGB）工作，两边从第一步就不同，这不是调色算法能追平的。
// 这里只读出描述名，导入时告诉用户，避免把色彩空间差异误当成算法不准。
function iccDescFromProfile(seg) {
    if (!seg || seg.length < 132) return '';
    const count = seg.readUInt32BE(128);
    if (!(count > 0) || count > 64) return '';
    for (let i = 0; i < count; i++) {
        const off = 132 + i * 12;
        if (off + 12 > seg.length) break;
        if (seg.slice(off, off + 4).toString('latin1') !== 'desc') continue;
        const toff = seg.readUInt32BE(off + 4);
        if (toff + 12 > seg.length) continue;
        const type = seg.slice(toff, toff + 4).toString('latin1');
        if (type === 'desc') {
            const n = seg.readUInt32BE(toff + 8);
            const end = Math.min(seg.length, toff + 12 + Math.max(0, n - 1));
            return seg.slice(toff + 12, end).toString('latin1').replace(/\0+$/, '').trim();
        }
        if (type === 'mluc') {
            const cnt = seg.readUInt32BE(toff + 16);
            if (!(cnt > 0)) continue;
            const rec = toff + 20;
            if (rec + 12 > seg.length) continue;
            const len = seg.readUInt32BE(rec + 4);
            const o = seg.readUInt32BE(rec + 8);
            const s0 = Math.min(seg.length, toff + o);
            const buf = seg.slice(s0, Math.min(seg.length, s0 + len));
            let out = '';
            for (let k = 0; k + 1 < buf.length; k += 2) out += String.fromCharCode(buf.readUInt16BE(k));
            return out.replace(/\0+$/, '').trim();
        }
    }
    return '';
}

// 读 JPEG 的 APP2/ICC_PROFILE 段（可在 256KB 头部窗口内完成）
async function readIccName(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (ext !== '.jpg' && ext !== '.jpeg') return '';
    try {
        const buf = await readHead(filePath, EXIF_HEAD_BYTES);
        let off = 2;
        while (off + 4 <= buf.byteLength) {
            if (buf[off] !== 0xFF) { off++; continue; }
            const m = buf[off + 1];
            if (m === 0xD8 || m === 0xD9) { off += 2; continue; }
            if (m === 0xDA) break;
            const len = buf.readUInt16BE(off + 2);
            if (len < 2) break;
            if (m === 0xE2 && off + 4 + 12 <= buf.byteLength
                && buf.slice(off + 4, off + 16).toString('latin1') === 'ICC_PROFILE\0') {
                return iccDescFromProfile(buf.slice(off + 18, off + 2 + len));
            }
            off += 2 + len;
        }
    } catch (_) { /* 读不到就当没有 */ }
    return '';
}

module.exports = { readExif, exifSegmentState, readHead, EXIF_HEAD_BYTES, readIccName, iccDescFromProfile };

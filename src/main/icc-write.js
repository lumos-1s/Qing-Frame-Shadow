'use strict';
/* 给导出 JPEG 写 APP2/ICC_PROFILE。canvas 出来的 JPG 没有 ICC；
 * EXIF 写入是在 SOI 之后插 APP1，不会冲掉后面的 APP2，顺序无关。 */

function isJpeg(buf) {
    return !!buf && buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8;
}

function stripIcc(buf) {
    let out = buf;
    for (let guard = 0; guard < 8; guard++) {
        let off = 2, found = -1, total = 0;
        while (off + 4 <= out.length) {
            if (out[off] !== 0xFF) { off++; continue; }
            const marker = out[off + 1];
            if (marker === 0xD8 || marker === 0xD9 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
            if (marker === 0xDA) break;
            const len = out.readUInt16BE(off + 2);
            if (len < 2) break;
            if (marker === 0xE2 && len >= 14
                && out.subarray(off + 4, off + 15).toString('latin1') === 'ICC_PROFILE\0') {
                found = off; total = 2 + len; break;
            }
            off += 2 + len;
        }
        if (found < 0) return out;
        out = Buffer.concat([out.subarray(0, found), out.subarray(found + total)]);
    }
    return out;
}

function applyIccToJpeg(buf, profile) {
    if (!isJpeg(buf) || !profile || !profile.length) return buf;
    try {
        const base = stripIcc(buf);
        const name = Buffer.from('ICC_PROFILE\0', 'latin1');
        const payload = Buffer.concat([name, Buffer.from([1, 1]), Buffer.from(profile)]);
        const seg = Buffer.alloc(4 + payload.length);
        seg[0] = 0xFF; seg[1] = 0xE2;
        seg.writeUInt16BE(payload.length + 2, 2);
        payload.copy(seg, 4);
        return Buffer.concat([base.subarray(0, 2), seg, base.subarray(2)]);
    } catch (e) {
        return buf;
    }
}

module.exports = { applyIccToJpeg };

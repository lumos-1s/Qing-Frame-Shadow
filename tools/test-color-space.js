// 导出色域：sRGB / Display P3 / Adobe RGB 的像素转换与 ICC 嵌入（纯 Node）
'use strict';
const zlib = require('zlib');
const CS = require('../src/shared/color-space');
const { profileBytes } = require('../src/shared/icc-profile');
const png = require('../src/shared/png-srgb');
const { applyIccToJpeg } = require('../src/main/icc-write');

let bad = 0;
function check(ok, label, extra) {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) bad++;
}
function tagData(buf, name) {
    const n = buf.readUInt32BE(128);
    for (let i = 0; i < n; i++) {
        if (buf.subarray(132 + i * 12, 136 + i * 12).toString('latin1') !== name) continue;
        const off = buf.readUInt32BE(136 + i * 12), len = buf.readUInt32BE(140 + i * 12);
        return buf.subarray(off, off + len);
    }
    return Buffer.alloc(0);
}
function chunks(buf) {
    const out = [];
    let off = 8;
    while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.subarray(off + 4, off + 8).toString('latin1');
        out.push({ type, len });
        off += 12 + len;
        if (type === 'IEND') break;
    }
    return out;
}

// ── 像素转换 ──
const px = (arr) => { const b = Uint8ClampedArray.from(arr); CS.convertRgbaInPlace(b, 'p3'); return Array.from(b); };
const white = px([255, 255, 255, 255]);
check(white[0] > 250 && white[1] > 250 && white[2] > 250 && white[3] === 255,
    'P3：白点保持白，alpha 不动', JSON.stringify(white));
const red = px([255, 0, 0, 255]);
check(red[0] < 250 && red[1] > 20 && red[2] > 10,
    'P3：sRGB 红落进 P3 色域内（不再是最饱和的红）', JSON.stringify(red));
const ado = Uint8ClampedArray.from([255, 0, 0, 255]);
CS.convertRgbaInPlace(ado, 'adobergb');
check(ado[1] === 0 && ado[2] === 0 && ado[0] < 255,
    'Adobe RGB：红原色共用，只按亮度重标定', JSON.stringify(Array.from(ado)));

// ── ICC profile ──
for (const id of ['p3', 'adobergb']) {
    const p = profileBytes(id);
    const tags = [];
    const n = p.readUInt32BE(128);
    for (let i = 0; i < n; i++) tags.push(p.subarray(132 + i * 12, 136 + i * 12).toString('latin1'));
    const sorted = tags.join(',') === tags.slice().sort().join(',');
    const sizeOk = p.readUInt32BE(0) === p.length;
    const sig = p.subarray(36, 40).toString('latin1') === 'acsp';
    const trc = tagData(p, 'rTRC');
    const trcOk = trc.subarray(0, 4).toString('latin1') === 'curv'
        && trc.readUInt32BE(8) === (id === 'p3' ? 256 : 1)
        && (id !== 'p3' || trc.readUInt16BE(trc.length - 2) === 65535);  // count>1 用 uInt16 满量程
    check(!!p && sig && sizeOk && sorted && trcOk && tags.includes('wtpt'),
        id + '：ICC 结构合法（acsp / size / 标签升序 / TRC）', tags.join(','));
}

// ── PNG iCCP ──
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const withSrgb = Buffer.from(png.ensureBuffer(TINY_PNG));
const withIcc = Buffer.from(png.insertIcc(withSrgb, profileBytes('p3'), 'Display P3', (b) => zlib.deflateSync(b)));
const iccChunks = chunks(withIcc).map(c => c.type);
check(iccChunks.indexOf('iCCP') >= 0 && iccChunks.indexOf('sRGB') < 0
    && iccChunks.indexOf('IDAT') >= 0 && iccChunks.indexOf('IEND') >= 0,
'PNG：iCCP 已写入且 sRGB 标签被移除', iccChunks.join(','));

// ── JPEG APP2 ──
const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x08]), Buffer.alloc(8), Buffer.from([0xFF, 0xD9])]);
const outJpeg = applyIccToJpeg(jpeg, profileBytes('adobergb'));
check(outJpeg[0] === 0xFF && outJpeg[1] === 0xD8 && outJpeg[2] === 0xFF && outJpeg[3] === 0xE2
    && outJpeg.subarray(6, 18).toString('latin1') === 'ICC_PROFILE\0',
'JPG：ICC 写进 APP2/ICC_PROFILE，SOI 仍在最前', String(outJpeg.length - jpeg.length));

console.log(bad ? `\n未通过 ${bad} 项` : '\nALL PASS · 导出色域');
process.exit(bad ? 1 : 0);

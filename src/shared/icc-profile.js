'use strict';
/* 生成最小可用的 RGB 矩阵型 ICC profile（Display P3 / Adobe RGB 1998）。
 * 不想依赖机器里是否装了某个 ICC 文件，也不想引入第三方色彩库：
 * 色度值由 CIE xy 原色算出，D65→D50 用 Bradford 适配，TRC 用 ICC 标准曲线类型。
 * 只给导出写盘用；像素转换在渲染层做（见 app-export.js）。 */

const D65 = [0.3127, 0.3290];
const D50 = [0.9642, 1.0, 0.8249];

const DEFS = {
    p3: {
        name: 'Display P3',
        r: [0.680, 0.320], g: [0.265, 0.690], b: [0.150, 0.060],
        trc: 'srgb'
    },
    adobergb: {
        name: 'Adobe RGB (1998)',
        r: [0.640, 0.330], g: [0.210, 0.710], b: [0.150, 0.060],
        trc: 'gamma', gamma: 563 / 256
    }
};

const BRADFORD = [
    [1.0478112, 0.0228866, -0.0501270],
    [0.0295424, 0.9904844, -0.0170491],
    [-0.0092345, 0.0150436, 0.7521316]
];

function xyYToXYZ(x, y, Y) {
    if (!y) return [0, 0, 0];
    return [x * Y / y, Y, (1 - x - y) * Y / y];
}
function matVec(m, v) {
    return [0, 1, 2].map(i => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
}
function inv3(m) {
    const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
    const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
    const det = a * A + d * B + g * C;
    if (!det) return null;
    return [
        [A / det, B / det, C / det],
        [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]
    ];
}
function fixed(v) {
    const n = Math.round(Math.max(-32768, Math.min(32767.9999, v)) * 65536);
    const b = Buffer.alloc(4);
    b.writeInt32BE(n, 0);
    return b;
}
function xyzTag(xyz) {
    return Buffer.concat([Buffer.from('XYZ ', 'ascii'), Buffer.alloc(4),
        fixed(xyz[0]), fixed(xyz[1]), fixed(xyz[2])]);
}
function curveTag(def) {
    if (def.trc === 'srgb') {
        // 用 256 段采样曲线精确描述 sRGB TRC：'para' 在 ICC v2 里兼容性不稳，
        // 'curv' 是 v2 原生类型。count>1 时表项是 uInt16（0x0000..0xFFFF 对应 0..1），
        // 不是 count==1 时用的 u8Fixed8 —— 写错会让 lcms 把整条曲线压平。
        const n = 256;
        const b = Buffer.alloc(12 + n * 2);
        b.write('curv', 0, 4, 'ascii');
        b.writeUInt32BE(n, 8);
        for (let i = 0; i < n; i++) {
            const v = i / (n - 1);
            const lin = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            b.writeUInt16BE(Math.round(lin * 65535), 12 + i * 2);
        }
        return b;
    }
    const b = Buffer.alloc(16);
    b.write('curv', 0, 4, 'ascii');
    b.writeUInt32BE(1, 8);
    b.writeUInt16BE(Math.round(def.gamma * 256), 12);
    return b;
}
function descTag(text) {
    // ICC textDescriptionType：'desc' + 保留 4 + ASCII 长度(u32,含结尾 0) + ASCII 文本。
    // 省略长度会让 lcms/ColorSync 读到乱码描述（甚至拒绝整个 profile）。
    const body = Buffer.from(text + '\0', 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const raw = Buffer.concat([len, body, Buffer.alloc(12)]);  // 后面三段 Unicode/Scriptcode 计数据 0
    const pad = (4 - raw.length % 4) % 4;
    return Buffer.concat([Buffer.from('desc', 'ascii'), Buffer.alloc(4), raw, Buffer.alloc(pad)]);
}

function profileBytes(id) {
    const def = DEFS[id];
    if (!def) return null;
    const white = xyYToXYZ(D65[0], D65[1], 1);
    const raw = [def.r, def.g, def.b].map(p => xyYToXYZ(p[0], p[1], 1));
    const M = [[raw[0][0], raw[1][0], raw[2][0]],
               [raw[0][1], raw[1][1], raw[2][1]],
               [raw[0][2], raw[1][2], raw[2][2]]];
    const mins = matVec(inv3(M), white);
    const adapted = raw.map((c, i) => matVec(BRADFORD, c.map(v => v * mins[i])));
    // Bradford 表有取整误差：把三原色之和精确归一到 D50 PCS 白点，
    // 否则 profile 内部自相矛盾，严格的色彩管理引擎会给出偏色。
    const sum = [0, 1, 2].map(k => adapted.reduce((s, c) => s + c[k], 0));
    adapted.forEach((c) => { for (let k = 0; k < 3; k++) c[k] *= D50[k] / sum[k]; });

    const tags = {
        desc: descTag(def.name),
        wtpt: xyzTag(D50),
        rXYZ: xyzTag(adapted[0]), gXYZ: xyzTag(adapted[1]), bXYZ: xyzTag(adapted[2]),
        rTRC: curveTag(def), gTRC: curveTag(def), bTRC: curveTag(def)
    };
    const names = Object.keys(tags).sort();
    let offset = 128 + 4 + 12 * names.length;
    const table = Buffer.alloc(4 + 12 * names.length);
    table.writeUInt32BE(names.length, 0);
    const parts = [];
    names.forEach((name, i) => {
        table.write(name, 4 + i * 12, 4, 'ascii');
        table.writeUInt32BE(offset, 8 + i * 12);
        table.writeUInt32BE(tags[name].length, 12 + i * 12);
        parts.push(tags[name]);
        const pad = (4 - tags[name].length % 4) % 4;
        if (pad) parts.push(Buffer.alloc(pad));
        offset += tags[name].length + pad;
    });

    const header = Buffer.alloc(128);
    header.writeUInt32BE(offset, 0);
    header.writeUInt32BE(0x02100000, 8);        // ICC v2.1
    header.write('mntr', 12, 4, 'ascii');
    header.write('RGB ', 16, 4, 'ascii');
    header.write('XYZ ', 20, 4, 'ascii');
    header.write('acsp', 36, 4, 'ascii');
    header.writeUInt32BE(0, 64);                // rendering intent: perceptual
    fixed(D50[0]).copy(header, 68);
    fixed(D50[1]).copy(header, 72);
    fixed(D50[2]).copy(header, 76);
    return Buffer.concat([header, table].concat(parts));
}

module.exports = { DEFS, profileBytes };

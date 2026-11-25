// 轻量 EXIF/TIFF 解析器(纯 JS,无依赖)
// 从 ArrayBuffer 提取拍摄参数,并读取方向(Orientation)用于自动旋转竖拍照片
// 双端可用:渲染进程挂到 window.__parseExif/__exifSummary;主进程可 require(CommonJS)
(function () {
    function readUInt16(ab, off) { return ab.getUint16(off, ab.littleEndian); }
    function readUInt32(ab, off) { return ab.getUint32(off, ab.littleEndian); }

    // 解析 TIFF IFD,递归进入 EXIF/TGPS 子 IFD
    // base:TIFF 头相对整个文件的偏移;IFD 内偏移均为相对 base
    function parseIFD(ab, dirOffset, tags, base) {
        const n = readUInt16(ab, dirOffset);
        for (let i = 0; i < n; i++) {
            const entry = dirOffset + 2 + i * 12;
            const tag = readUInt16(ab, entry);
            const type = readUInt16(ab, entry + 2);
            const count = readUInt32(ab, entry + 4);
            const valueOffset = entry + 8;
            // type 尺寸:1=byte 2=ascii 3=short 4=long 5=rational 7=undefined 9=srational 10=srational
            const sizeMap = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
            const usize = sizeMap[type];
            if (!usize) continue;
            const dataLen = usize * count;
            let dataStart = valueOffset;
            if (dataLen > 4) dataStart = base + readUInt32(ab, valueOffset);
            // 数值提取(未提取过才写,tags 从空对象开始,保首个 IFD0 的 Make/Model)
            if (tags[tag] === undefined) {
                if (type === 2) { // ascii
                    const bytes = [];
                    for (let k = 0; k < count && k < 64; k++) {
                        const b = ab.getUint8(dataStart + k);
                        if (b === 0) break;
                        bytes.push(b);
                    }
                    tags[tag] = decodeURIComponent(escape(String.fromCharCode.apply(null, bytes))).trim();
                } else if (type === 5) { // rational(两个 4 字节无符号)
                    const num = readUInt32(ab, dataStart), den = readUInt32(ab, dataStart + 4);
                    tags[tag] = { num, den };
                } else if (type === 3) { // short
                    tags[tag] = count > 1 ? [readUInt16(ab, dataStart)] : readUInt16(ab, dataStart);
                } else if (type === 4) { // long
                    tags[tag] = readUInt32(ab, dataStart);
                }
            }
            // 子 IFD:EXIF(0x8769) 与 GPS(0x8825)
            // 指针 type=4 long。EXIF IFD 显示在值槽(≤4字节内联)或外置数据区。
            // 偏移均为相对 TIFF(base) 的相对值,须加上 base 才是文件绝对偏移。
            if (tag === 0x8769 || tag === 0x8825) {
                const subRaw = (dataLen <= 4) ? readUInt32(ab, valueOffset) : readUInt32(ab, base + readUInt32(ab, valueOffset));
                if (base + subRaw > 0 && base + subRaw < ab.byteLength) {
                    parseIFD(ab, base + subRaw, tags, base);
                }
            }
        }
    }

    const Exif = {
        parseExif: function (arrayBuffer) {
            const ab = new DataView(arrayBuffer);
            let result = {};
            // JPEG:FF xx FFD8,APP1 = FF E1,长度2字节, "Exif\0\0" 6字节, TIFF 头(8字节)
            let off = 2;
            while (off < arrayBuffer.byteLength - 4) {
                if (ab.getUint8(off) !== 0xFF) { off++; continue; }
                const marker = ab.getUint8(off + 1);
                if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
                const len = ab.getUint16(off + 2);
                if (marker === 0xE1 && len >= 10) {
                    // 检查 "Exif\x00\x00"
                    let isExif = true;
                    const sig = "Exif\0\0";
                    for (let i = 0; i < 6; i++) if (ab.getUint8(off + 4 + i) !== sig.charCodeAt(i)) { isExif = false; break; }
                    if (isExif) {
                        const tiffStart = off + 4 + 6;
                        const endian = ab.getUint16(tiffStart);
                        ab.littleEndian = (endian === 0x4949); // II
                        const magic = readUInt16(ab, tiffStart + 2);
                        if (magic === 42) {
                            const ifd0 = readUInt32(ab, tiffStart + 4);
                            result.endianLittle = ab.littleEndian;
                            parseIFD(ab, tiffStart + ifd0, result, tiffStart);
                            break;
                        }
                    }
                }
                off += 2 + len;
            }
            return result;
        },

        // 转成展示格式的对象
        exifSummary: function (raw) {
            const num = (a, b) => (a && b) ? (a / b) : null;
            const out = {};
            // parseIFD 以 EXIF tag 数字为键;统一常量
            const T_MAKE = 0x010F, T_MODEL = 0x0110, T_ORIENT = 0x0112;
            const T_EXPOSURE = 0x829A, T_FNUMBER = 0x829D, T_ISO = 0x8827, T_ISO2 = 0x8833, T_FOCAL = 0x920A;
            const T_FOCAL35 = 0xA405; // FocalLengthIn35mmFilm:相机/手机写好的 35mm 等效焦距
            const str = v => Array.isArray(v) ? (v[0] || '') : v;
            if (raw[T_MAKE]) out.make = String(str(raw[T_MAKE])).trim();
            if (raw[T_MODEL]) out.model = String(str(raw[T_MODEL])).trim();
            if (raw[T_ORIENT]) out.orientation = raw[T_ORIENT];
            const exp = raw[T_EXPOSURE];
            if (exp && exp.den) {
                out.shutter = exp.den >= 1 ? `1/${Math.round(exp.den / (exp.num || 1))}s` : `${exp.num}s`;
            }
            const fn = raw[T_FNUMBER];
            if (fn) { const v = num(fn.num, fn.den); if (v) out.aperture = 'f/' + v.toFixed(1).replace('.0', ''); }
            const fl = raw[T_FOCAL];
            if (fl) { const v = num(fl.num, fl.den); if (v) out.focal = Math.round(v) + 'mm'; }
            // 0xA405 是 SHORT;parseIFD 在 count=1 时给数字,count>1 时给数组,两种都收
            const f35 = Array.isArray(raw[T_FOCAL35]) ? raw[T_FOCAL35][0] : raw[T_FOCAL35];
            if (Number(f35) > 0) out.focal35 = Number(f35);
            const isoRaw = raw[T_ISO] != null ? raw[T_ISO] : raw[T_ISO2];
            const isoV = Array.isArray(isoRaw) ? isoRaw[0] : isoRaw;
            if (isoV) out.iso = 'ISO' + isoV;
            return out;
        }
    };

    const g = (typeof window !== 'undefined') ? window : ((typeof globalThis !== 'undefined') ? globalThis : null);
    if (g) {
        g.__parseExif = Exif.parseExif;
        g.__exifSummary = Exif.exifSummary;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = Exif;
})();
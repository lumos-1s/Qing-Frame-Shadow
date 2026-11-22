// 给 PNG 补一个 sRGB chunk(若还没有)。
//
// Chromium/Electron 45 的 canvas.toDataURL('image/png') 不再自动写 sRGB chunk,
// 而导出文件需要显式标注,否则第三方软件只能靠猜。所有成品 PNG 都经过主进程写盘,
// 因此在这一层统一补 chunk;输入不是 PNG 或已带 sRGB 时原样返回。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.QFpng = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    let table = null;

    function crcTable() {
        if (table) return table;
        table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        return table;
    }

    function crc32(bytes) {
        const t = crcTable();
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }

    function isPng(bytes) {
        if (!bytes || bytes.length < 16) return false;
        for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return false;
        return true;
    }

    function hasChunk(bytes, name) {
        let off = 8;
        while (off + 12 <= bytes.length) {
            const len = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
            const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
            if (type === name) return true;
            if (type === 'IEND' || off + 12 + len > bytes.length) break;
            off += 12 + len;
        }
        return false;
    }

    // 返回 Uint8Array(可能是原对象)。sRGB 紧跟在 IHDR 之后。
    function insertSrgb(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        if (!isPng(bytes) || hasChunk(bytes, 'sRGB')) return bytes;
        const ihdrLen = ((bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]) >>> 0;
        const insertAt = 8 + 12 + ihdrLen;
        if (insertAt > bytes.length) return bytes;
        const data = new Uint8Array([0]); // rendering intent: perceptual
        const type = [0x73, 0x52, 0x47, 0x42]; // sRGB
        const body = new Uint8Array(4 + data.length);
        body.set(type, 0);
        body.set(data, 4);
        const crc = crc32(body);
        const chunk = new Uint8Array(12 + data.length);
        chunk[0] = 0; chunk[1] = 0; chunk[2] = 0; chunk[3] = data.length;
        chunk.set(type, 4);
        chunk.set(data, 8);
        chunk[8 + data.length] = (crc >>> 24) & 0xff;
        chunk[9 + data.length] = (crc >>> 16) & 0xff;
        chunk[10 + data.length] = (crc >>> 8) & 0xff;
        chunk[11 + data.length] = crc & 0xff;
        const out = new Uint8Array(bytes.length + chunk.length);
        out.set(bytes.subarray(0, insertAt), 0);
        out.set(chunk, insertAt);
        out.set(bytes.subarray(insertAt), insertAt + chunk.length);
        return out;
    }

    function u32(bytes, off) {
        return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    }
    function setU32(bytes, off, v) {
        bytes[off] = (v >>> 24) & 0xff; bytes[off + 1] = (v >>> 16) & 0xff;
        bytes[off + 2] = (v >>> 8) & 0xff; bytes[off + 3] = v & 0xff;
    }

    // 用 iCCP 取代 sRGB chunk。deflate 由主进程传入(zlib.deflateSync)，浏览器里不调用。
    function insertIcc(input, profile, name, deflate) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        if (!isPng(bytes) || !profile || !profile.length || typeof deflate !== 'function') return bytes;
        const hasBuf = typeof Buffer !== 'undefined';
        const label = (hasBuf && Buffer.isBuffer(name)) || Array.isArray(name)
            ? name : Array.from(String(name || 'ICC') + '\0', (c) => c.charCodeAt(0) & 0xff);
        const comp = new Uint8Array(deflate(hasBuf && Buffer.isBuffer(profile) ? profile : Buffer.from(profile)));
        const data = new Uint8Array(label.length + 1 + comp.length);
        data.set(label, 0);
        data[label.length] = 0;                 // 压缩方法 0
        data.set(comp, label.length + 1);
        const type = [0x69, 0x43, 0x43, 0x50];  // iCCP
        const chunk = new Uint8Array(12 + data.length);
        setU32(chunk, 0, data.length);
        chunk.set(type, 4);
        chunk.set(data, 8);
        setU32(chunk, 8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));

        const parts = [bytes.subarray(0, 8)];
        let off = 8, inserted = false, done = false;
        while (off + 12 <= bytes.length && !done) {
            const len = u32(bytes, off);
            const t = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
            const end = off + 12 + len;
            if (end > bytes.length) break;
            if (t === 'sRGB' || t === 'iCCP') { off = end; continue; }
            if (!inserted && t === 'IDAT') { parts.push(chunk); inserted = true; }
            parts.push(bytes.subarray(off, end));
            if (t === 'IEND') done = true;
            off = end;
        }
        if (!inserted) parts.push(chunk);
        if (off < bytes.length) parts.push(bytes.subarray(off));
        let total = 0;
        parts.forEach((p) => { total += p.length; });
        const out = new Uint8Array(total);
        let at = 0;
        parts.forEach((p) => { out.set(p, at); at += p.length; });
        return out;
    }

    function ensureBuffer(buf) {
        if (!Buffer.isBuffer(buf)) return buf;
        const out = insertSrgb(buf);
        return out === buf ? buf : Buffer.from(out);
    }

    // 仅处理 data:image/png;base64,...;其他 MIME 原样返回。
    function ensureDataUrl(dataUrl) {
        const m = /^data:image\/png;base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
        if (!m || typeof atob !== 'function' || typeof btoa !== 'function') return dataUrl;
        try {
            const bin = atob(m[1]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const out = insertSrgb(bytes);
            if (out === bytes) return dataUrl;
            let s = '';
            for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
            return 'data:image/png;base64,' + btoa(s);
        } catch (e) { return dataUrl; }
    }

    return { insertSrgb, insertIcc, crc32, isPng, ensureBuffer, ensureDataUrl };
});

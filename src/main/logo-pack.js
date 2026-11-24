// Eagle 素材包(.eaglepack)导入。
//
// .eaglepack 本质是一个 zip：pack.json 里存整包的素材清单，
// 每个素材一个 `<id>.info/` 目录，里面是 metadata.json + 原图 + 缩略图。
//
// 这里只做三件事：
//   1) 读 central directory 建索引，按需解压单个 entry（不把整包展开到磁盘）；
//   2) 用 pack.json 的 images 清单拿到每个素材的名字与扩展名；
//   3) 把位图写进 userData/brandlogos，文件名直接用素材名 —— 与内置素材同一套
//      命名规范（Canon_White.png / SONY.png），brandLogoEntry 靠文件名匹配 EXIF 品牌，
//      所以「识别」不需要额外的品牌表：包里的名字本身就是品牌名。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

// zip 索引：name -> { method, compSize, size, lho }
function readZipIndex(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip / Eagle 素材包');
    let eocd = -1;
    const min = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip / Eagle 素材包');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const map = new Map();
    if (p < 0 || p >= buf.length) return map;
    for (let i = 0; i < count; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) break;
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const lho = buf.readUInt32LE(p + 42);
        const next = p + 46 + nameLen + extraLen + commentLen;
        // 畸形 central directory：名字/extra 越界时停止，不能拿越界区间当文件名。
        if (next > buf.length) break;
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        // 只收 local header 落在文件内的 entry；真正解压前 readEntry 还会再校验一次。
        if (lho >= 0 && lho + 30 <= buf.length) map.set(name, { method, compSize, size, lho });
        p = next;
    }
    return map;
}

function readEntry(buf, e) {
    if (!e) return null;
    // 解压炸弹防护：central directory 声明的大小先卡一道，解压输出再由
    // maxOutputLength 兜底。旧代码只在解压**之后**检查 20MB，恶意包可在
    // inflateRawSync 里直接把主进程内存吃满。
    if (!Number.isInteger(e.lho) || e.lho < 0 || e.lho + 30 > buf.length) return null;
    if (Number(e.size) > MAX_FILE) return null;
    if (!Number.isFinite(e.compSize) || e.compSize < 0) return null;
    const nameLen = buf.readUInt16LE(e.lho + 26);
    const extraLen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + nameLen + extraLen;
    if (start < 0 || start > buf.length || start + e.compSize > buf.length) return null;
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) {
        if (raw.length > MAX_FILE) return null;
        return Buffer.from(raw);
    }
    if (e.method === 8) {
        try { return zlib.inflateRawSync(raw, { maxOutputLength: MAX_FILE }); }
        catch (_) { return null; }
    }
    return null;
}

// 目标文件名：去掉路径分隔符与 Windows 非法字符，保留中英文与空格
function safeBase(name) {
    return String(name || '')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\.(png|jpe?g|webp|svg|gif)$/i, '')
        .trim()
        .slice(0, 80);
}

const RASTER = ['.png', '.jpg', '.jpeg', '.webp'];
const VECTOR = ['.svg'];
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;
// 整包上限：再大就不该一次性读进内存。压缩包本身可以很小、解压后很大，
// 真正的炸弹防护在 readEntry 的 maxOutputLength，这里只挡「文件本身就巨大」。
const MAX_PACK = 512 * 1024 * 1024;

// 返回 { ok, added, replaced, skipped, total, brands, shadowed, error? }
// destDir 不存在会创建；同名文件按覆盖处理（用户在应用里显式导入，应当生效）。
// builtinDir 可传内置素材目录，只用于统计「与内置同名」的个数（不影响导入行为）。
function importLogoPack(filePath, destDir, builtinDir) {
    const res = { ok: false, added: 0, replaced: 0, skipped: 0, total: 0, brands: [], shadowed: 0, svgOnly: 0 };
    let buf;
    try {
        const st = fs.statSync(filePath);
        if (!st.isFile()) { res.error = '这不是一个文件'; return res; }
        if (st.size > MAX_PACK) { res.error = '素材包太大（超过 512MB），请拆分后再导入'; return res; }
        buf = fs.readFileSync(filePath);
    }
    catch (e) { res.error = '读不到这个文件：' + (e && e.message || e); return res; }

    let index;
    try { index = readZipIndex(buf); }
    catch (e) { res.error = e.message; return res; }

    // pack.json 是 Eagle 的清单；没有它就退回逐目录扫描 metadata.json
    let pack = null;
    try {
        const ent = index.get('pack.json');
        if (ent) pack = JSON.parse(readEntry(buf, ent).toString('utf8'));
    } catch (_) { pack = null; }

    // 按 id 归组目录内的候选图片
    const dirFiles = new Map(); // 'ID.info' -> [{name, ext, file}]
    for (const name of index.keys()) {
        const m = name.match(/^([^/]+)\.info\/(.+)$/);
        if (!m) continue;
        const id = m[1];
        const file = m[2];
        const ext = path.extname(file).toLowerCase();
        if (!RASTER.includes(ext) && !VECTOR.includes(ext)) continue;
        if (/_thumbnail\.[a-z]+$/i.test(file)) continue;      // Eagle 的缩略图
        if (!dirFiles.has(id)) dirFiles.set(id, []);
        dirFiles.get(id).push({ name: file, ext });
    }

    const images = (pack && Array.isArray(pack.images) ? pack.images : [])
        .filter(im => im && im.id && !im.isDeleted);
    if (!images.length) {
        // 没有 pack.json：用目录名当素材名（Eagle 导出时总会带 pack.json，这里只是兜底）
        res.error = '这个包里没有 pack.json，认不出素材清单';
        return res;
    }

    try { fs.mkdirSync(destDir, { recursive: true }); }
    catch (e) { res.error = '无法创建 Logo 目录：' + (e && e.message || e); return res; }

    let written = 0;
    // 按素材名归组：Eagle 里同一个 Logo 往往有 png 与 svg 两条独立记录（name 相同），
    // 按名合并后只取一张，否则池子里会出现两个同名项。
    const groups = new Map(); // key -> { base, picks: [{name, ext}] }
    const uniqueBases = new Set();
    for (const im of images) {
        const base = safeBase(im.name);
        if (!base) { res.skipped++; continue; }
        uniqueBases.add(base.toLowerCase());
        const key = base.toLowerCase();
        const files = dirFiles.get(im.id) || [];
        const pick = files.find(f => RASTER.includes(f.ext)) || files.find(f => VECTOR.includes(f.ext));
        if (!pick) { res.skipped++; continue; }
        if (!groups.has(key)) groups.set(key, { base, picks: [] });
        groups.get(key).picks.push(pick);
    }
    res.total = uniqueBases.size;   // 用户视角：包里有多少个 Logo（不是多少个文件）

    for (const g of groups.values()) {
        // 位图优先（canvas 里尺寸稳定）。只有矢量时跳过 —— 这版只收位图，
        // 渲染层对无 intrinsic 尺寸的 SVG 没有兜底，宁可不要也不要在画布上开花。
        const pick = g.picks.find(p => RASTER.includes(p.ext));
        if (!pick) { res.skipped++; res.svgOnly++; continue; }
        // 同一个 id 目录里可能有多张（如 png + 缩略图已排除），按扩展名找对应 entry
        const img = images.find(im => (safeBase(im.name) || '').toLowerCase() === g.base.toLowerCase()
            && (dirFiles.get(im.id) || []).some(f => f.ext === pick.ext));
        const e = img ? index.get(`${img.id}.info/${pick.name}`) : null;
        let data;
        try { data = readEntry(buf, e); } catch (_) { data = null; }
        if (!data || !data.length || data.length > MAX_FILE) { res.skipped++; continue; }
        if (written + data.length > MAX_TOTAL) { res.skipped++; continue; }

        const dest = path.join(destDir, g.base + pick.ext);
        let existed = false;
        try { existed = fs.existsSync(dest); } catch (_) { existed = false; }
        try {
            fs.writeFileSync(dest, data);
            written += data.length;
            if (existed) res.replaced++; else res.added++;
            res.brands.push({ name: g.base, ext: pick.ext.slice(1) });
        } catch (_) { res.skipped++; }
    }
    res.ok = (res.added + res.replaced) > 0;
    // 与内置素材同名的个数：这份包常常就是内置那批的来源，开发版里导完池子数量不变，
    // 不说明会让人以为没生效（实际是「同名的换成导入版」，见 list-logos 合并规则）。
    try {
        const builtin = new Set(fs.readdirSync(builtinDir || '')
            .filter(f => /\.(png|jpe?g|webp)$/i.test(f))
            .map(f => f.replace(/\.[^.]+$/, '').toLowerCase()));
        if (builtin.size) res.shadowed = res.brands.filter(b => builtin.has(b.name.toLowerCase())).length;
    } catch (_) { res.shadowed = 0; }
    if (!res.ok && !res.error) res.error = '包里没有可导入的位图 Logo';
    return res;
}

module.exports = { importLogoPack, readZipIndex, readEntry };

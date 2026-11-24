'use strict';
// 调色预设的磁盘存储：userData/grade-presets/<名称>.xmp
//
// 预设就是 Lightroom / Camera Raw 能直接读的 .xmp 文件（内容是 XML）。
// 文件名即预设名，保存/重命名/删除都先经过 safeLeafName，杜绝 ../ 越界。
//
// 兼容旧版：上一版把预设存成 .json（清框影自己的结构）。list 仍会返回它们，
// 渲染进程读到后会转换成 .xmp 再删除旧文件，迁移完成后目录里只剩 .xmp。
const fs = require('fs');
const path = require('path');
const { safeLeafName } = require('./export-path');
const { writeFileAtomic } = require('./state');

// 一份调色预设正常只有几 KB；留 4MB 余量，同时防止被构造的文件撑爆主进程内存。
const MAX_BYTES = 4 * 1024 * 1024;
const XMP_EXT = '.xmp';
const LEGACY_EXT = '.json';

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function extOf(f) {
    if (f.endsWith(XMP_EXT)) return 'xmp';
    if (f.endsWith(LEGACY_EXT)) return 'json';
    return '';
}

function list(dir) {
    try {
        ensureDir(dir);
        const byName = new Map();
        for (const f of fs.readdirSync(dir)) {
            const ext = extOf(f);
            if (!ext) continue;
            const name = f.slice(0, -ext.length - 1);
            // 同名时优先 .xmp，忽略还没迁移掉的旧 .json。
            if (ext === 'xmp' || !byName.has(name)) byName.set(name, ext);
        }
        return [...byName.entries()]
            .map(([name, ext]) => ({ name, ext }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    } catch (_) {
        return [];
    }
}

function load(dir, name, ext) {
    const safe = safeLeafName(name, '');
    if (!safe) return null;
    const useExt = ext === 'json' ? LEGACY_EXT : XMP_EXT;
    try {
        const file = path.join(dir, safe + useExt);
        if (!fs.existsSync(file)) return null;
        if (fs.statSync(file).size > MAX_BYTES) return null;
        const text = fs.readFileSync(file, 'utf-8');
        if (useExt === LEGACY_EXT) {
            return { kind: 'json', data: JSON.parse(text) };
        }
        return { kind: 'xmp', xml: text };
    } catch (_) {
        return null;
    }
}

function save(dir, name, xml) {
    const safe = safeLeafName(name, '');
    if (!safe) return { ok: false, error: '预设名称不合法' };
    if (typeof xml !== 'string' || !xml.trim()) {
        return { ok: false, error: '预设内容为空' };
    }
    if (Buffer.byteLength(xml, 'utf-8') > MAX_BYTES) {
        return { ok: false, error: '调色预设超过 4MB，已拒绝保存' };
    }
    // 只做轻量格式校验：Lightroom 的 .xmp 一定有 xmpmeta / RDF 节点。
    if (!/<(?:x:)?xmpmeta|<rdf:RDF/i.test(xml)) {
        return { ok: false, error: '不是有效的 XMP 预设文件' };
    }
    try {
        ensureDir(dir);
        writeFileAtomic(path.join(dir, safe + XMP_EXT), xml, 'utf-8');
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

function remove(dir, name, ext) {
    const safe = safeLeafName(name, '');
    if (!safe) return { ok: false, error: '预设名称不合法' };
    try {
        const exts = ext === 'json' ? [LEGACY_EXT] : (ext === 'xmp' ? [XMP_EXT] : [XMP_EXT, LEGACY_EXT]);
        for (const e of exts) {
            const file = path.join(dir, safe + e);
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

function rename(dir, oldName, newName) {
    const fromName = safeLeafName(oldName, '');
    const toName = safeLeafName(newName, '');
    if (!fromName || !toName) return { ok: false, error: '预设名称不合法' };
    if (fromName === toName) return { ok: true };
    try {
        // 优先重命名 .xmp；只有旧 .json 时也允许改，迁移逻辑下次会处理。
        let fromExt = XMP_EXT;
        if (!fs.existsSync(path.join(dir, fromName + fromExt))) {
            if (fs.existsSync(path.join(dir, fromName + LEGACY_EXT))) fromExt = LEGACY_EXT;
            else return { ok: false, error: '源预设不存在' };
        }
        const toXmp = path.join(dir, toName + XMP_EXT);
        const toJson = path.join(dir, toName + LEGACY_EXT);
        if (fs.existsSync(toXmp) || fs.existsSync(toJson)) {
            return { ok: false, error: '已存在同名预设' };
        }
        fs.renameSync(path.join(dir, fromName + fromExt), path.join(dir, toName + fromExt));
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

// 保存到库外的位置后，还要在库里留一份；重名时自动加 (2)、(3)…
function uniqueName(dir, base) {
    const safe = safeLeafName(base, '') || '调色预设';
    let name = safe;
    let n = 2;
    while (fs.existsSync(path.join(dir, name + XMP_EXT))
        || fs.existsSync(path.join(dir, name + LEGACY_EXT))) {
        name = safe + ' (' + n + ')';
        n++;
    }
    return name;
}

module.exports = { MAX_BYTES, list, load, save, remove, rename, uniqueName };

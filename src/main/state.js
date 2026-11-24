// 主进程持久状态与文件命名工具(独立于 electron,便于单元测试)
const fs = require('fs');
const path = require('path');

// 通用原子写：同目录临时文件 + rename，避免进程在写一半时退出留下半截 JSON/XML。
// rename 跨设备会失败，所以临时文件必须和目标是同一目录。
function writeFileAtomic(file, data, encoding) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    fs.writeFileSync(tmp, data, encoding);
    try {
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
        throw e;
    }
}

function createStateStore(stateFile) {
    function loadState() {
        try {
            if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf-8')) || {};
        } catch (e) { /* 忽略损坏的配置 */ }
        return {};
    }
    function saveState(patch) {
        try {
            if (!patch || typeof patch !== 'object') return;
            const s = loadState();
            // prefs 由多个模块各写各的字段:整体替换会让后写的一方把别的字段抹掉。
            // 其余顶层键(user/lastOpenDir 等)仍按整体替换处理,允许显式写 null。
            if (patch.prefs && typeof patch.prefs === 'object' && !Array.isArray(patch.prefs)) {
                const prev = (s.prefs && typeof s.prefs === 'object' && !Array.isArray(s.prefs)) ? s.prefs : {};
                s.prefs = Object.assign({}, prev);
                // undefined 表示"这次没带这个字段",不能覆盖已存值(JSON.stringify 还会把它丢掉)。
                for (const [k, v] of Object.entries(patch.prefs)) {
                    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
                    if (v !== undefined) s.prefs[k] = v;
                }
                const rest = Object.assign({}, patch);
                delete rest.prefs;
                Object.assign(s, rest);
            } else {
                Object.assign(s, patch);
            }
            // 原子写:写到同目录临时文件再 rename。否则进程在 writeFileSync 中途退出
            // 会把 state.json 截断,下次启动 prefs/user/最近目录一起丢。
            const tmp = `${stateFile}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(s), 'utf-8');
            try { fs.renameSync(tmp, stateFile); }
            catch (e) {
                fs.writeFileSync(stateFile, JSON.stringify(s), 'utf-8');
                try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
            }
        } catch (e) { /* 忽略写入失败 */ }
    }
    function validDir(p) { return typeof p === 'string' && p && fs.existsSync(p); }
    // 目标目录已有同名文件时,在名称后追加 _1、_2… 取第一个可用名(第二次导出数字自动加一)
    // 目录内容只读一次:原实现对每个候选名都调一次 fs.existsSync,批量导出时每张都要往返磁盘若干次。
    // 目录读不到时退回逐个 existsSync(保持"读不到就当已占用"的原语义)。
    // 注意:Windows/macOS 的文件系统大小写不敏感,而 existsSync 也按平台语义工作,
    // 所以集合比对必须用全小写键 —— 否则「Photo.JPG 已存在、要写 photo.jpg」会被判为不冲突而覆盖掉旧文件。
    function freeFilePath(dir, filename, used) {
        const ext = path.extname(filename);
        const stem = filename.slice(0, filename.length - ext.length);
        let listing = null;
        try { listing = new Set(fs.readdirSync(dir).map(n => n.toLowerCase())); } catch (e) { listing = null; }
        const taken = (p) => {
            const base = path.basename(p);
            if (used && used.has(base)) return true;
            if (listing) return listing.has(base.toLowerCase());
            try { return fs.existsSync(p); } catch (e) { return true; }
        };
        let i = 0, cand = path.join(dir, filename);
        while (taken(cand)) {
            i++;
            cand = path.join(dir, `${stem}_${i}${ext}`);
        }
        return cand;
    }
    return { loadState, saveState, validDir, freeFilePath };
}

module.exports = { createStateStore, writeFileAtomic };
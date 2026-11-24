'use strict';
// Logo 素材包导入防护回归：畸形 zip / 解压炸弹不能把主进程拖死。
// 用法：node tools/test-logo-pack.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { importLogoPack, readZipIndex, readEntry } = require('../src/main/logo-pack');

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

// 构造最小 zip。entries: [{ name, data, method?, declaredSize? }]
// declaredSize 用来伪造 central directory 里的解压后大小（模拟解压炸弹）。
function makeZip(entries) {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
        const method = e.method === 0 ? 0 : 8;
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data || ''), 'utf8');
        const comp = method === 0 ? raw : zlib.deflateRawSync(raw);
        const name = Buffer.from(e.name, 'utf8');
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(LOCAL_SIG, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(method, 8);
        lh.writeUInt32LE(comp.length, 18);
        lh.writeUInt32LE(e.declaredSize != null ? e.declaredSize : raw.length, 22);
        lh.writeUInt16LE(name.length, 26);
        const local = Buffer.concat([lh, name, comp]);
        locals.push(local);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(CD_SIG, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt32LE(comp.length, 20);
        cd.writeUInt32LE(e.declaredSize != null ? e.declaredSize : raw.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([cd, name]));
        offset += local.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBuf, eocd]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-logopack-'));
try {
    // ① 正常包：pack.json + 一张真实位图
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const normalZip = makeZip([
        { name: 'pack.json', data: JSON.stringify({ images: [{ id: '1', name: 'TestLogo' }] }) },
        { name: '1.info/TestLogo.png', data: png }
    ]);
    const zipPath = path.join(tmp, 'normal.eaglepack');
    fs.writeFileSync(zipPath, normalZip);
    const dest = path.join(tmp, 'logos');
    const normal = importLogoPack(zipPath, dest, tmp);
    check(normal.ok && normal.added === 1 && fs.existsSync(path.join(dest, 'TestLogo.png')),
        '正常素材包仍能导入位图', JSON.stringify(normal));

    // ② 解压炸弹：CD 声称 1KB，实际展开 21MB（超过 20MB 上限），必须跳过而不是 OOM
    const bombZip = makeZip([
        { name: 'pack.json', data: JSON.stringify({ images: [{ id: '2', name: 'BombLogo' }] }) },
        { name: '2.info/BombLogo.png', data: Buffer.alloc(21 * 1024 * 1024), declaredSize: 1024 }
    ]);
    const bomb = readEntry(bombZip, readZipIndex(bombZip).get('2.info/BombLogo.png'));
    // 直接从 zip 索引读更贴近真实路径。
    const bombPath = path.join(tmp, 'bomb.eaglepack');
    fs.writeFileSync(bombPath, bombZip);
    const bombDest = path.join(tmp, 'bomb-logos');
    const bombRes = importLogoPack(bombPath, bombDest, tmp);
    check(bombRes.added === 0 && bombRes.skipped >= 1 && !fs.existsSync(path.join(bombDest, 'BombLogo.png')),
        '解压后超过 20MB 的条目被跳过，不写盘也不崩', JSON.stringify(bombRes));
    check(bomb === null, 'readEntry 对超限解压直接返回 null', String(bomb));

    // ③ 截断的 local header：返回 null，不抛越界异常
    const truncated = Buffer.alloc(30);
    truncated.writeUInt16LE(0, 26);
    truncated.writeUInt16LE(0, 28);
    let threw = null;
    let val = null;
    try { val = readEntry(truncated, { method: 8, compSize: 999, size: 999, lho: 0 }); }
    catch (e) { threw = e; }
    check(!threw && val === null, '截断条目不会越界抛错', threw ? String(threw.message) : 'null');

    // ④ 声明的解压大小已超限：不解压直接拒绝
    const declared = readEntry(Buffer.alloc(30), { method: 8, compSize: 0, size: 21 * 1024 * 1024, lho: 0 });
    check(declared === null, '声明大小超限的条目直接拒绝', String(declared));

    // ⑤ 不是 zip 的文件给出可读错误，而不是异常穿透
    const junk = path.join(tmp, 'junk.bin');
    fs.writeFileSync(junk, Buffer.from('not a zip at all'));
    const junkRes = importLogoPack(junk, path.join(tmp, 'junk-logos'), tmp);
    check(!!junkRes.error && /zip|素材包/.test(junkRes.error), '非法文件返回错误信息', junkRes.error);
} finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);

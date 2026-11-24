// 更新镜像模块单测（纯 node，不开窗口）。
// 重点不是"能下下来"，而是"下错了必须拒绝"——镜像方案的安全底线全在 sha512 校验这一步。
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { normalizeMirror, mirrorUrlFor, downloadVerified, releaseAssetUrl, sha512Base64 } = require('../src/main/update-mirror');

const fails = [];
let total = 0;
const check = (ok, label, detail) => {
    total++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
    if (detail) console.log(`       ${detail}`);
    if (!ok) fails.push(label);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-mirror-'));
const PAYLOAD = Buffer.from('qingframe-update-mirror-payload\n'.repeat(200));
const GOOD_SHA = crypto.createHash('sha512').update(PAYLOAD).digest('base64');

const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/good.bin' }); res.end(); return; }
    if (req.url === '/good.bin') {
        res.writeHead(200, { 'Content-Length': PAYLOAD.length, 'Content-Type': 'application/octet-stream' });
        res.end(PAYLOAD);
        return;
    }
    if (req.url === '/evil.bin') {
        const bad = Buffer.concat([PAYLOAD, Buffer.from('tampered')]);
        res.writeHead(200, { 'Content-Length': bad.length });
        res.end(bad);
        return;
    }
    if (req.url === '/missing') { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(500); res.end('boom');
});

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = 'http://127.0.0.1:' + port;

    console.log('更新镜像（地址校验 / URL 改写 / 校验和 / 失败清理）');
    console.log('─'.repeat(84));

    // 1) 地址校验
    check(normalizeMirror('').ok && normalizeMirror('').value === '', '空串 = 直连 GitHub', null);
    check(normalizeMirror('https://ghproxy.net/{url}').ok, 'https 前缀式镜像可用', null);
    check(normalizeMirror('http://127.0.0.1:8080/').ok, '本机 http 允许（测试/自建反代常见）', null);
    const httpRemote = normalizeMirror('http://cdn.example.com/');
    check(!httpRemote.ok, '远程 http 被拒（明文可被中间人替换）', httpRemote.error);
    const badScheme = normalizeMirror('ftp://cdn.example.com/');
    check(!badScheme.ok, '非 http(s) 协议被拒', badScheme.error);
    check(!normalizeMirror('https://a b.com/').ok, '含空格的地址被拒', null);

    // 2) URL 改写
    const original = releaseAssetUrl({ owner: 'lumos-1s', repo: 'Qing-Frame-Shadow', version: '0.1.22', file: 'Qingframe-Setup-0.1.22-x64.exe' });
    check(original === 'https://github.com/lumos-1s/Qing-Frame-Shadow/releases/download/v0.1.22/Qingframe-Setup-0.1.22-x64.exe',
        'releaseAssetUrl 拼出 GitHub 原始地址', original);
    const viaPlaceholder = mirrorUrlFor(original, 'https://ghproxy.net/{url}');
    check(viaPlaceholder === 'https://ghproxy.net/' + original, '{url} 原样替换（ghproxy 要求不编码）', viaPlaceholder);
    const viaEnc = mirrorUrlFor(original, 'https://x.example/{urlEnc}');
    check(viaEnc === 'https://x.example/' + encodeURIComponent(original), '{urlEnc} 提供编码版备用', viaEnc);
    const viaPrefix = mirrorUrlFor(original, 'https://cdn.example.com/');
    check(viaPrefix === 'https://cdn.example.com/' + original, '无反斜杠的前缀镜像直接拼接', viaPrefix);
    check(mirrorUrlFor(original, '') === original, '镜像为空时原样返回', null);

    // 3) 正常下载 + 进度
    const okPath = path.join(tmp, 'ok.exe');
    const progress = [];
    const r1 = await downloadVerified({ url: base + '/good.bin', sha512: GOOD_SHA, dest: okPath, onProgress: (p) => progress.push(p) });
    check(fs.existsSync(okPath) && fs.readFileSync(okPath).equals(PAYLOAD), '校验通过后落盘且内容一致', `bytes=${r1.bytes}`);
    check(progress.length > 0 && progress[progress.length - 1].percent === 100, '进度回调走到 100%',
        `采样 ${progress.length} 次，末次 ${progress.length ? progress[progress.length - 1].percent.toFixed(0) : '-'}%`);
    check(!fs.existsSync(okPath + '.part'), '成功后不残留 .part', null);

    // 4) 跟随重定向
    const redirPath = path.join(tmp, 'redir.exe');
    await downloadVerified({ url: base + '/redirect', sha512: GOOD_SHA, dest: redirPath });
    check(fs.existsSync(redirPath), '302 重定向后仍能下完', null);

    // 5) 内容被篡改 → 必须拒绝且不留文件
    const evilPath = path.join(tmp, 'evil.exe');
    let err = null;
    try { await downloadVerified({ url: base + '/evil.bin', sha512: GOOD_SHA, dest: evilPath }); }
    catch (e) { err = e; }
    check(!!err && /校验失败/.test(err.message), '内容不符时抛校验错误', err && err.message);
    check(!fs.existsSync(evilPath) && !fs.existsSync(evilPath + '.part'), '校验失败后不落盘、不留 .part', null);

    // 6) 404 / 缺校验值
    let e404 = null;
    try { await downloadVerified({ url: base + '/missing', sha512: GOOD_SHA, dest: path.join(tmp, 'x.exe') }); }
    catch (e) { e404 = e; }
    check(!!e404 && /HTTP 404/.test(e404.message), '404 报明确的 HTTP 错误', e404 && e404.message);
    let eNoSha = null;
    try { await downloadVerified({ url: base + '/good.bin', dest: path.join(tmp, 'y.exe') }); }
    catch (e) { eNoSha = e; }
    check(!!eNoSha && /校验值/.test(eNoSha.message), '缺 sha512 时拒绝下载（没有校验就等于不校验）', eNoSha && eNoSha.message);

    // 7) sha512Base64 与标准库一致
    const fileHash = await sha512Base64(okPath);
    check(fileHash === GOOD_SHA, 'sha512Base64 与清单格式（base64）一致', null);

    console.log('─'.repeat(84));
    console.log(fails.length ? `✖ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 ${total} 项通过`);

    server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); server.close(); process.exit(1); });

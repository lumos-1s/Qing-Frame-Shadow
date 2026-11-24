// 发布到 GitHub Releases —— 直接用 GitHub REST API，不经 electron-builder 的 publisher。
//
// 为什么要有它：electron-builder 26.15.3 在本机发版时 `POST /releases` 恒返回 404
// （三次复现），但同一个令牌、同一个代理，用裸请求打同一个端点返回 422（缺 tag_name），
// 说明令牌有 repo 权限、代理也放行 POST —— 卡在 publisher 自己身上。
// 本脚本只做「建 release + 上传产物」，与打包解耦：打包仍由 electron-builder 负责。
//
// 用法：
//   GH_TOKEN=... node tools/publish-release.js --tag v0.1.24 --target <commit> --notes dist/release-notes.md
//   加 --dry 只查询、不写。
//
// 代理：显式走 HTTPS_PROXY（本机直连 github 会 SSL 失败），用 CONNECT 建隧道。
const fs = require('fs');
const http = require('http');
const tls = require('tls');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, def) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const flag = (k) => argv.includes('--' + k);

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = 'lumos-1s';
const REPO = 'Qing-Frame-Shadow';
const TAG = arg('tag', 'v' + require('../package.json').version);
const TARGET = arg('target', '');
const NOTES = arg('notes', '');
const DRY = flag('dry');

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
const pg = proxyUrl ? new URL(proxyUrl) : null;

if (!TOKEN) { console.error('缺 GH_TOKEN'); process.exit(2); }

function tunnel(host) {
    return new Promise((resolve, reject) => {
        if (!pg) {
            const s = tls.connect({ host, port: 443, servername: host }, () => resolve(s));
            s.on('error', reject);
            return;
        }
        const req = http.request({ host: pg.hostname, port: pg.port, method: 'CONNECT', path: `${host}:443` });
        req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) { reject(new Error('CONNECT ' + res.statusCode)); return; }
            const s = tls.connect({ socket, servername: host }, () => resolve(s));
            s.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

// 发一个请求；body 可以是 Buffer 或 { file, size }（流式，避免 121MB 全读进内存）
async function api(method, host, pathname, headers, body) {
    const socket = await tunnel(host);
    return new Promise((resolve, reject) => {
        const h = Object.assign({
            Host: host, 'User-Agent': 'qingframe-release', Accept: 'application/vnd.github+json',
            Authorization: 'token ' + TOKEN, Connection: 'close'
        }, headers);
        let streamReader = null;
        if (body && body.file) {
            h['Content-Length'] = body.size;
            streamReader = fs.createReadStream(body.file);
        } else if (body) {
            h['Content-Length'] = Buffer.byteLength(body);
        }
        socket.write(`${method} ${pathname} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
        // 注意：这里不能主动 socket.end() —— 请求头写完就 FIN，会在服务器回包之前
        // 把连接关掉，表现为「拿到 HTTP 0」。Connection: close 下服务器自己会关。
        if (streamReader) {
            streamReader.pipe(socket, { end: true });
            streamReader.on('error', reject);
        } else if (body) {
            socket.write(body);
        }
        let buf = '';
        socket.on('data', (d) => { buf += d.toString('binary'); });
        socket.on('end', () => {
            const idx = buf.indexOf('\r\n\r\n');
            const head = buf.slice(0, idx);
            const status = Number((head.split('\r\n')[0].match(/\s(\d{3})\s?/) || [])[1] || 0);
            const raw = buf.slice(idx + 4);
            let text = raw;
            try { text = Buffer.from(raw, 'binary').toString('utf8'); } catch (_) { text = raw; }
            resolve({ status, text });
        });
        socket.on('error', reject);
    });
}

const json = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };

(async () => {
    console.log(`发布 ${OWNER}/${REPO} ${TAG}${DRY ? '  [dry]' : ''}`);

    // 1) release 是否已存在（幂等：存在就复用，避免重复建）
    let r = await api('GET', 'api.github.com', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, {});
    let rel = r.status === 200 ? json(r.text) : null;
    console.log(`  查询 ${TAG}: HTTP ${r.status}${rel ? ' 已存在 id=' + rel.id : ' 不存在'}`);
    if (DRY) {
        if (rel) console.log('  已有 assets:', (rel.assets || []).map((a) => a.name).join(', ') || '(无)');
        r = await api('GET', 'api.github.com', `/repos/${OWNER}/${REPO}/releases/tags/v0.1.23`, {});
        const prev = r.status === 200 ? json(r.text) : null;
        console.log('  参照 v0.1.23 assets:', prev ? (prev.assets || []).map((a) => a.name).join(', ') : '取不到');
        return;
    }

    // 2) 建 release
    if (!rel) {
        const body = {
            tag_name: TAG,
            name: TAG.replace(/^v/, 'Qingframe v'),
            body: NOTES && fs.existsSync(path.join(ROOT, NOTES)) ? fs.readFileSync(path.join(ROOT, NOTES), 'utf8') : '',
            draft: false, prerelease: false
        };
        if (TARGET) body.target_commitish = TARGET;
        r = await api('POST', 'api.github.com', `/repos/${OWNER}/${REPO}/releases`,
            { 'Content-Type': 'application/json' }, JSON.stringify(body));
        rel = json(r.text);
        if (r.status !== 201 || !rel) {
            console.error(`  创建 release 失败: HTTP ${r.status} ${(r.text || '').slice(0, 300)}`);
            process.exit(1);
        }
        console.log(`  已创建 release id=${rel.id}`);
    }

    // 3) 上传产物（同名已存在则跳过）
    const have = new Set((rel.assets || []).map((a) => a.name));
    const files = fs.readdirSync(path.join(ROOT, 'dist'))
        .filter((f) => /^Qingframe-(Setup|Portable)-.*\.(exe|blockmap)$|^latest\.yml$/.test(f))
        .map((f) => path.join(ROOT, 'dist', f));
    for (const f of files) {
        const name = path.basename(f);
        if (have.has(name)) { console.log(`  ${name} 已存在，跳过`); continue; }
        const size = fs.statSync(f).size;
        const up = await api('POST', 'uploads.github.com',
            `/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
            { 'Content-Type': 'application/octet-stream' }, { file: f, size });
        const ok = up.status === 201;
        console.log(`  ${name}  ${(size / 1048576).toFixed(1)} MB  →  HTTP ${up.status}${ok ? ' ✓' : ' ✗ ' + (up.text || '').slice(0, 200)}`);
        if (!ok) process.exit(1);
    }
    console.log(`完成：https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
})();

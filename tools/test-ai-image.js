'use strict';
// 主进程图像通道的端到端测试：起一个本地假网关，验 multipart 组包、响应解析、
// 以及「取图时只给同源地址带鉴权」这条安全边界。
// 纯 Node，不启动 Electron；重点是那段没法在渲染层桩里覆盖的请求组装。
const http = require('http');
const AI = require('../src/main/ai-provider');

const failures = [];
function check(ok, label, detail) {
    if (ok) console.log('OK   ' + label + (detail ? ' | ' + detail : ''));
    else { failures.push(label); console.log('FAIL ' + label + (detail ? ' | ' + detail : '')); }
}
function collect(req) {
    return new Promise((resolve) => {
        const bufs = [];
        req.on('data', (d) => bufs.push(d));
        req.on('end', () => resolve(Buffer.concat(bufs)));
    });
}

// 一段带 JPEG 头的小字节串：够用来确认二进制原样进了 multipart，不需要真能解码。
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0xFF, 0xD9]);
const SRC = 'data:image/jpeg;base64,' + JPEG.toString('base64');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

const seen = [];
let imgAuth = '';
let otherAuth = '';

function startServer(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
    });
}

(async () => {
    const main = await startServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/img.png') {
            imgAuth = req.headers.authorization || '';
            if (imgAuth !== 'Bearer k-123') { res.writeHead(401); res.end('no'); return; }
            res.writeHead(200, { 'content-type': 'image/png' });
            res.end(PNG);
            return;
        }
        const buf = await collect(req);
        const text = buf.toString('utf8');
        const meta = {
            url: req.url, ct: req.headers['content-type'] || '',
            auth: req.headers.authorization || '', extra: req.headers['x-test'] || '',
            text: text, buf: buf
        };
        seen.push(meta);
        const json = (code, body) => {
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (req.url === '/v1/images/edits') {
            if (text.includes('__404__')) return json(404, { error: { message: '模型不存在' } });
            if (text.includes('__URL_X__')) {
                return json(200, { data: [{ url: 'http://127.0.0.1:' + other.port + '/img.png' }] });
            }
            if (text.includes('__URL__')) {
                return json(200, { data: [{ url: 'http://127.0.0.1:' + main.port + '/img.png', revised_prompt: 'u' }] });
            }
            return json(200, { data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'rev' }] });
        }
        if (req.url === '/v1/images/generations') {
            return json(200, { data: [{ b64_json: PNG.toString('base64') }] });
        }
        return json(404, { error: { message: 'not found' } });
    });
    const other = await startServer(async (req, res) => {
        await collect(req);
        otherAuth = req.headers.authorization || '';
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
    });

    const baseUrl = 'http://127.0.0.1:' + main.port + '/v1';
    const cfg = { baseUrl, apiKey: 'k-123', model: 'gpt-image-1', headers: { 'x-test': 'yes' } };

    // ① 入参校验：不该发请求的时候一个包都不发
    const noModel = await AI.image({ baseUrl }, { prompt: 'x' });
    check(!noModel.ok && /图像模型/.test(noModel.error), '没填模型名就拦下', noModel.error);
    const noPrompt = await AI.image(cfg, { prompt: '  ' });
    check(!noPrompt.ok && /缺画面描述/.test(noPrompt.error), '空 prompt 拦下', noPrompt.error);
    const badSrc = await AI.image(cfg, { prompt: 'x', source: 'https://evil.example/a.jpg' });
    check(!badSrc.ok && /data URL/.test(badSrc.error), '远程图片地址在本地就被拒', badSrc.error);
    check(seen.length === 0, '以上三种情况都没打到网关', String(seen.length));

    // ② edits：multipart 组包要对，不能带 Content-Type
    const r1 = await AI.image(cfg, { prompt: '做成破框 __B64__', source: SRC, size: '1024x1536' });
    const q1 = seen[0] || {};
    check(r1.ok === true, 'edits 走通', JSON.stringify({ ok: r1.ok, path: r1.path }));
    check(q1.url === '/v1/images/edits', '落到 /images/edits', q1.url);
    check(/^multipart\/form-data; boundary=/.test(q1.ct), 'Content-Type 是 multipart 且带 boundary', q1.ct.slice(0, 48));
    check(!/application\/json/.test(q1.ct), '没有被误写成 application/json', q1.ct);
    check(q1.auth === 'Bearer k-123', '带上了 Bearer 鉴权', q1.auth);
    check(q1.extra === 'yes', '自定义头也带上了', q1.extra);
    check(/name="model"[\s\S]{0,80}gpt-image-1/.test(q1.text), 'model 字段正确', 'gpt-image-1');
    check(/name="size"[\s\S]{0,40}1024x1536/.test(q1.text), 'size 字段正确', '1024x1536');
    check(/name="n"[\s\S]{0,20}1/.test(q1.text), 'n=1', '1');
    check(/name="image"; filename="source\.jpeg"/.test(q1.text), '参考图字段名与文件名对', 'source.jpeg');
    check(/Content-Type: image\/jpeg/i.test(q1.text), '参考图 part 带 image/jpeg', 'image/jpeg');
    check(q1.buf.includes(JPEG), '参考图的二进制原样进了请求体', JPEG.length + 'B');
    check(r1.image === 'data:image/png;base64,' + PNG.toString('base64'), 'b64 响应折成 data URL');
    check(r1.revised === 'rev' && r1.path === 'edits', 'revised_prompt 与路径回传', String(r1.revised));

    // ③ generations：纯文字，不带 image 字段；乱填的 size 回落到 1024×1024
    const r2 = await AI.image(cfg, { prompt: '一张纸', size: 'huge' });
    const q2 = seen[1] || {};
    check(r2.ok === true && r2.path === 'generations', 'generations 走通', String(r2.path));
    check(q2.url === '/v1/images/generations', '落到 /images/generations', q2.url);
    check(!/name="image"/.test(q2.text), '纯文字请求里没有 image 字段');
    let body2 = null;
    try { body2 = JSON.parse(q2.text); } catch (_) { body2 = null; }
    check(body2 && body2.size === '1024x1024', '非法 size 回落 1024×1024', body2 && body2.size);
    check(body2 && body2.model === 'gpt-image-1' && body2.prompt === '一张纸', 'body 字段完整');

    // ④ 网关回 URL：同源才带鉴权，跨源一个头都不许带
    const r3 = await AI.image(cfg, { prompt: '__URL__', source: SRC });
    check(r3.ok === true && /^data:image\/png;base64,/.test(r3.image), '同源 URL 取回并折成 data URL', String(r3.path));
    check(imgAuth === 'Bearer k-123', '同源取图带上了鉴权', imgAuth);

    const r4 = await AI.image(cfg, { prompt: '__URL_X__', source: SRC });
    check(r4.ok === true && r4.sourceUrl === 'http://127.0.0.1:' + other.port + '/img.png', '跨源 URL 也能取回', String(r4.sourceUrl));
    check(otherAuth === '', '跨源取图没有泄露 Authorization', JSON.stringify(otherAuth));

    // ⑤ 报错要原样透出
    const r5 = await AI.image(cfg, { prompt: '__404__', source: SRC });
    check(r5.ok === false && r5.status === 404 && /模型不存在/.test(r5.error), '404 与服务端话术都保留', r5.error);

    main.server.close();
    other.server.close();
    if (main.server.closeAllConnections) main.server.closeAllConnections();
    if (other.server.closeAllConnections) other.server.closeAllConnections();
    console.log('');
    if (failures.length) { console.log('FAILED ' + failures.length + ' · 图像通道'); process.exit(1); }
    console.log('ALL PASS · 图像通道');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

// 纸刊图像通道单测：generations / url 回退 / edits 带源图 / 错误路径。本地 mock HTTP，纯 Node。
// 用法: node tools/test-zine-image.js
'use strict';

const http = require('http');
const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'main', 'ai-provider.js'));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};
function serve(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
}
function listen(s) { return 'http://127.0.0.1:' + s.address().port + '/v1'; }
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
    // 1) 地址推导
    check(P.endpoint('https://api.openai.com/v1', 'images') === 'https://api.openai.com/v1/images/generations', '图像地址 /images/generations', P.endpoint('https://api.openai.com/v1', 'images'));
    check(P.endpoint('https://api.openai.com', 'edits') === 'https://api.openai.com/v1/images/edits', '图生图地址 /images/edits');
    check(P.endpoint('https://gw/v1/images/generations', 'images') === 'https://gw/v1/images/generations', '完整图像地址原样');

    // 2) data URL 解码与响应解析
    check(P.decodeDataUrl(PNG).buffer.length > 0, 'data URL 可解码');
    check(P.decodeDataUrl('https://x/y.png') === null, '普通 URL 不当 data URL');
    check(P.pickImage({ data: [{ b64_json: 'AAAA' }] }).type === 'b64', '解析 b64_json');
    check(P.pickImage({ data: [{ url: 'https://x/y.png' }] }).value === 'https://x/y.png', '解析 url');
    check(P.pickImage({ data: [] }) === null, '空数据返回 null');

    // 3) generations：b64 直出 + 鉴权头 + 参数
    let seen = {};
    const s1 = await serve((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen = { url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: JSON.parse(body || '{}') };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }] }));
        });
    });
    const r1 = await P.image({ baseUrl: listen(s1), apiKey: 'sk-test', model: 'image-1' }, { prompt: 'a zine poster', size: '1024x1536' });
    s1.close();
    check(r1.ok === true && /^data:image\/png;base64,/.test(r1.image || ''), 'generations 返回 data URL', r1.error || r1.image.slice(0, 30));
    check(seen.auth === 'Bearer sk-test', 'Key 以 Bearer 头送出', seen.auth);
    check(/images\/generations$/.test(seen.url), '打到 images/generations', seen.url);
    check(seen.body.size === '1024x1536' && seen.body.n === 1 && seen.body.prompt === 'a zine poster', '参数正确', JSON.stringify(seen.body).slice(0, 100));

    // 4) url 回退：图像服务再取一次
    let gotPath = '';
    const s2 = await serve((req, res) => {
        if (/\/images\/generations$/.test(req.url)) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ url: 'http://127.0.0.1:' + res.socket.localPort + '/file.png' }] }));
        } else {
            gotPath = req.url;
            res.writeHead(200, { 'content-type': 'image/webp' });
            res.end(Buffer.from('RIFFfakeWEBP', 'utf8'));
        }
    });
    const r2 = await P.image({ baseUrl: listen(s2), apiKey: 'k', model: 'chat-m', imageModel: 'img-1' }, { prompt: 'x' });
    s2.close();
    check(r2.ok === true && /^data:image\/webp;base64,/.test(r2.image || ''), 'url 结果回退成 data URL', r2.error || r2.image.slice(0, 30));
    check(gotPath === '/file.png', '真的去取了图片地址', gotPath);

    // 5) edits：源图走 multipart，且 prompt/model 在表单里
    let form = { auth: '', type: '' };
    const s3 = await serve((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            form = { auth: req.headers.authorization, type: String(req.headers['content-type'] || '') };
            form.hasImage = /name="image"/.test(body);
            form.hasPrompt = /name="prompt"/.test(body);
            form.hasModel = /name="model"/.test(body);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }));
        });
    });
    const r3 = await P.image({ baseUrl: listen(s3), apiKey: 'k', model: 'chat-m', imageModel: 'img-edit' }, { prompt: 'keep the scene', source: PNG });
    s3.close();
    check(r3.ok === true && r3.path === 'edits', '带源图走 edits 路径', r3.error || r3.path);
    check(/multipart\/form-data/.test(form.type) && form.hasImage && form.hasPrompt && form.hasModel,
        'multipart 含源图 / prompt / model', JSON.stringify(form));
    check(form.auth === 'Bearer k', 'edits 也带鉴权头', form.auth);

    // 6) 错误路径
    const noModel = await P.image({ apiKey: 'k' }, { prompt: 'x' });
    check(noModel.ok === false && /模型/.test(noModel.error), '缺模型名直接拒绝', noModel.error);
    // 只填了对话模型 = 只配好了一半：不能拿它去请求画图接口，那只会换回一个 404
    const chatOnly = await P.image({ apiKey: 'k', model: 'chat-m' }, { prompt: 'x' });
    check(chatOnly.ok === false && chatOnly.code === 'need-image-model', '对话模型名不会被当成图像模型', chatOnly.error);
    const noPrompt = await P.image({ apiKey: 'k', model: 'chat-m', imageModel: 'img-1' }, {});
    check(noPrompt.ok === false && /画面描述/.test(noPrompt.error), '缺提示词直接拒绝', noPrompt.error);
    const badSource = await P.image({ apiKey: 'k', model: 'chat-m', imageModel: 'img-1' }, { prompt: 'x', source: 'not-a-data-url' });
    check(badSource.ok === false && /data URL/.test(badSource.error), '非法源图被拒绝', badSource.error);

    const s4 = await serve((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key' } })); });
    const r4 = await P.image({ baseUrl: listen(s4), apiKey: 'wrong', model: 'chat-m', imageModel: 'img-1' }, { prompt: 'x' });
    s4.close();
    check(r4.ok === false && /401/.test(r4.error) && /bad key/.test(r4.error), '401 带出原因', r4.error);

    const s5 = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [] })); });
    const r5 = await P.image({ baseUrl: listen(s5), apiKey: 'k', model: 'chat-m', imageModel: 'img-1' }, { prompt: 'x' });
    s5.close();
    check(r5.ok === false && /没返回/.test(r5.error), '空图响应被点破', r5.error);

    console.log('');
    if (failures.length) { console.log('FAILED ' + failures.length + ' 项：' + failures.join(' / ')); process.exit(1); }
    console.log('ALL PASS · 纸刊图像通道');
})().catch((e) => { console.error(e); process.exit(1); });

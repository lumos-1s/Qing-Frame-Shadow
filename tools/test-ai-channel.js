// API 通道单测：地址拼装 + 宽松 JSON 解析 + 真发一次请求（本地 mock 服务）。纯 Node。
// 用法: node tools/test-ai-channel.js
'use strict';

const http = require('http');
const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'main', 'ai-provider.js'));
const F = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-frame-plans.js'));

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

// ── 地址拼装 ──
check(P.endpoint('https://api.openai.com', 'chat') === 'https://api.openai.com/v1/chat/completions', '裸域名补 /v1/chat/completions', P.endpoint('https://api.openai.com', 'chat'));
check(P.endpoint('https://api.openai.com/v1', 'chat') === 'https://api.openai.com/v1/chat/completions', '/v1 补 chat/completions', P.endpoint('https://api.openai.com/v1', 'chat'));
check(P.endpoint('https://gw.example.com/v1/', 'chat') === 'https://gw.example.com/v1/chat/completions', '尾斜杠处理', P.endpoint('https://gw.example.com/v1/', 'chat'));
check(P.endpoint('https://gw.example.com/api/v1/chat/completions', 'chat') === 'https://gw.example.com/api/v1/chat/completions', '完整地址原样用');
check(P.endpoint('https://gw.example.com/v1', 'models') === 'https://gw.example.com/v1/models', '模型列表地址');
check(P.endpoint('https://gw.example.com', 'models') === 'https://gw.example.com/v1/models', '裸域名补 /v1/models');
check(P.normBase('  https://a.b/v1//  ') === 'https://a.b/v1', '去空白与尾斜杠', P.normBase('  https://a.b/v1//  '));

// 内置代理：环境变量兜底
process.env.QFS_AI_PROXY = 'https://relay.qingframe.app/v1';
check(P.endpoint('', 'chat') === 'https://relay.qingframe.app/v1/chat/completions', '空地址回落到内置代理');
delete process.env.QFS_AI_PROXY;
check(P.endpoint('', 'chat') === 'https://api.openai.com/v1/chat/completions', '无代理时回落到官方地址');

(async () => {
    // ── 参数校验 ──
    const noModel = await P.chat({ apiKey: 'k' }, [{ role: 'user', content: 'hi' }]);
    check(noModel.ok === false && /模型名/.test(noModel.error), '缺模型直接拒绝', noModel.error);
    const noMsg = await P.chat({ apiKey: 'k', model: 'm' }, []);
    check(noMsg.ok === false && /内容/.test(noMsg.error), '空消息直接拒绝', noMsg.error);
    const badRole = await P.chat({ apiKey: 'k', model: 'm' }, [{ role: 'tool', content: 'x' }]);
    check(badRole.ok === false, '非法角色被过滤后拒绝');

    // ── 真发一次请求 ──
    let seen = null;
    const okSrv = await serve((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ model: 'mock-1', choices: [{ message: { content: 'pong' } }], usage: { total_tokens: 3 } }));
        });
    });
    const r1 = await P.chat({ baseUrl: 'http://127.0.0.1:' + okSrv.address().port + '/v1', apiKey: 'sk-test', model: 'mock-1' },
        [{ role: 'user', content: 'ping' }]);
    okSrv.close();
    check(r1.ok === true && r1.content === 'pong', '真实 HTTP 请求拿到回复', JSON.stringify(r1).slice(0, 120));
    check(seen && seen.url === '/v1/chat/completions', '打到 /v1/chat/completions', seen && seen.url);
    check(seen && seen.auth === 'Bearer sk-test', '带上 Bearer 头', seen && seen.auth);
    check(seen && seen.body.model === 'mock-1' && seen.body.messages[0].content === 'ping' && seen.body.stream === false,
        '请求体正确', seen && JSON.stringify(seen.body).slice(0, 140));

    // 401：错误信息要能看懂
    const badSrv = await serve((req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    });
    const r2 = await P.chat({ baseUrl: 'http://127.0.0.1:' + badSrv.address().port, apiKey: 'sk-bad', model: 'm' },
        [{ role: 'user', content: 'x' }]);
    badSrv.close();
    check(r2.ok === false && /HTTP 401/.test(r2.error) && /Incorrect API key/.test(r2.error), '401 原因透传', r2.error);

    // 模型列表
    const mSrv = await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-1' }, { id: 'mock-2' }] }));
    });
    const r3 = await P.models({ baseUrl: 'http://127.0.0.1:' + mSrv.address().port + '/v1', apiKey: 'k' });
    mSrv.close();
    check(r3.ok === true && r3.models.join(',') === 'mock-1,mock-2', '模型列表解析', JSON.stringify(r3));

    // 连不上：给出可读失败而不是抛异常
    const r4 = await P.chat({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' }, [{ role: 'user', content: 'x' }]);
    check(r4.ok === false && /请求失败/.test(r4.error), '连不上时返回可读错误', r4.error);

    // ── 方案解析 ──
    const doc = (n) => ({ templateName: n, layers: [{ type: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 0.8 }] });

    check(F.plansFromText(JSON.stringify([doc('a'), doc('b')])).length === 2, '纯数组直接收');
    check(F.plansFromText('```json\n' + JSON.stringify([doc('a')]) + '\n```').length === 1, '```json 围栏');
    check(F.plansFromText('好的，这是 4 款：\n' + JSON.stringify([doc('a'), doc('b'), doc('c')]) + '\n希望喜欢').length === 3, '前后有废话');
    check(F.plansFromText(JSON.stringify({ plans: [doc('a'), doc('b')] })).length === 2, '{plans:[...]} 包装');
    check(F.plansFromText(JSON.stringify(doc('single'))).length === 1, '单个对象');
    check(F.plansFromText(JSON.stringify({ preset: doc('p') })).length === 1, '{preset:{...}} 包装');
    check(F.plansFromText(JSON.stringify([doc('a'), { foo: 1 }, null, doc('b')])).length === 2, '数组里的垃圾被过滤');
    check(F.plansFromText('{"a":1}').length === 0, '无关对象返回空');
    check(F.plansFromText('抱歉，我做不到').length === 0, '纯文本返回空');
    check(F.plansFromText('').length === 0, '空串返回空');
    check(F.plansFromText(null).length === 0, 'null 返回空');
    check(F.plansFromText(JSON.stringify([{ templateName: 'x', aiLayers: [] }])).length === 1, 'aiLayers 也认');

    console.log('');
    if (failures.length) {
        console.log('FAILED ' + failures.length + ' 项：' + failures.join(' / '));
        process.exit(1);
    }
    console.log('ALL PASS · API 通道');
})();

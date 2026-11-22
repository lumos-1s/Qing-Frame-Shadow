// 主进程 AI 通道的带图消息：确认图片内容块原样到达上游，非法图片在本地就被拦下。
// 用法: node tools/test-ai-vision.js
'use strict';

const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'main', 'ai-provider.js'));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};

const realFetch = global.fetch;
let seen = null;
let calls = 0;
global.fetch = async (url, opts) => {
    calls++;
    seen = { url: url, body: JSON.parse(opts.body || '{}') };
    return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '{"picks":[]}' } }], model: 'mock' })
    };
};

async function main() {
    const cfg = { baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'vision-model' };
    const img = 'data:image/jpeg;base64,AAAA';

    const r1 = await P.chat(cfg, [{ role: 'user', content: '只发文字' }]);
    check(r1.ok && typeof seen.body.messages[0].content === 'string',
        '纯文字消息仍按字符串发送（老通道不变）', JSON.stringify(seen.body.messages[0].content));

    const r2 = await P.chat(cfg, [{
        role: 'user',
        content: [
            { type: 'text', text: '看看这张照片' },
            { type: 'image_url', image_url: { url: img } }
        ]
    }]);
    const parts = seen.body.messages[0].content;
    check(r2.ok && Array.isArray(parts) && parts[0].type === 'text' && parts[1].type === 'image_url',
        '内容块原样到上游（text + image_url）', JSON.stringify(parts));
    check(parts[1].image_url.url === img, '图片 data URL 未被改写', parts[1].image_url.url.slice(0, 30));

    // 远程 URL 不出去：连 fetch 都不该被调用
    const before = calls;
    const bad = await P.chat(cfg, [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://evil.test/a.jpg' } }]
    }]);
    check(!bad.ok && /只支持内联/.test(bad.error), '远程图片地址在本地被拦下', bad.error);
    check(calls === before, '被拦下的请求没有发出去', String(calls - before));

    global.fetch = realFetch;
    console.log('');
    if (failures.length) {
        console.log('FAILED ' + failures.length + ' · 带图消息');
        process.exit(1);
    }
    console.log('ALL PASS · 带图消息');
}

main().catch((e) => {
    global.fetch = realFetch;
    console.error(e);
    process.exit(1);
});

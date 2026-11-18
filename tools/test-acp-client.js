// ACP 客户端协议单测：用 mock JSON-RPC server（node 子进程）验证握手 + 流式事件。
// 不依赖真实助手 / key。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AcpSession } = require(path.join(__dirname, '..', 'src', 'main', 'acp-client.js'));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};

// mock server：写一段 node 脚本，按 ACP JSON-RPC 回复
const MOCK = `
const lines = require('readline').createInterface({ input: process.stdin });
let sessionId = null;
function send(o){ process.stdout.write(JSON.stringify(o)+'\\n'); }
lines.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:1, agentInfo:{name:'mock',version:'1'} } });
  } else if (m.method === 'session/new') {
    sessionId = 'mock-session-1';
    send({ jsonrpc:'2.0', id:m.id, result:{ sessionId } });
  } else if (m.method === 'session/prompt') {
    // 流式文本
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId, update:{ type:'agent_message_chunk', content:{ type:'text', text:'已生成边框 ' } } } });
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId, update:{ type:'agent_message_chunk', content:{ type:'text', text:'mock-frame.json' } } } });
    // 再发一条用 sessionUpdate 字段（opencode 用的协议）的 chunk，验证客户端透传
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId, update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text:'[opencode]' } } } });
    send({ jsonrpc:'2.0', id:m.id, result:{ stopReason:'end_turn' } });
  } else if (m.id != null) {
    send({ jsonrpc:'2.0', id:m.id, result:{} });
  }
});
`;
const mockFile = path.join(os.tmpdir(), 'qfs-acp-mock-' + Date.now() + '.js');
fs.writeFileSync(mockFile, MOCK);

(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-acp-cwd-'));
    const session = new AcpSession({ command: process.execPath, args: [mockFile], cwd });
    let streamed = '';
    let sawSessionUpdate = false;
    try {
        const init = await session.init();
        check(init && init.protocolVersion === 1, 'initialize 握手返回协议版本', JSON.stringify(init));

        const ns = await session.newSession(cwd);
        check(ns && ns.sessionId === 'mock-session-1', 'session/new 返回 sessionId', JSON.stringify(ns));

        const r = await session.prompt('帮我做一个边框', (u) => {
            if (u && u.type === 'agent_message_chunk' && u.content) streamed += u.content.text || '';
            if (u && u.sessionUpdate === 'agent_message_chunk' && u.content) sawSessionUpdate = true;
        });
        check(r && r.stopReason === 'end_turn', 'session/prompt 返回 stopReason', JSON.stringify(r));
        check(streamed === '已生成边框 mock-frame.json', '流式 session/update 收到完整文本', streamed);
        check(sawSessionUpdate, '透传 opencode 的 sessionUpdate 字段', String(sawSessionUpdate));

        session.close();
    } catch (e) {
        check(false, 'ACP 流程无异常', e.message);
    }
    try { fs.unlinkSync(mockFile); } catch (_) { /* 临时文件已清 */ }
    console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
    process.exitCode = failures.length ? 1 : 0;
})();

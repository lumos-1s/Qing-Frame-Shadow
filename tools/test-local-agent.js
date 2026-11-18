// 本机助手接入逻辑单测（不真跑助手：验证探测结构、命令构造、错误路径）。
// 用法: node tools/test-local-agent.js
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { AGENTS, detect, run, injectSkill } = require(path.join(__dirname, '..', 'src', 'main', 'local-agent.js'));

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};

// 1) 定义了三个主流助手
check(!!AGENTS.claude && !!AGENTS.codex && !!AGENTS.opencode, '定义了 Claude/Codex/OpenCode 三个助手',
    Object.keys(AGENTS).join(','));
check(Object.values(AGENTS).every((a) => typeof a.name === 'string' && typeof a.args === 'function'),
    '每个助手有 name 与 args 构造函数');

// 2) 探测返回结构正确（装没装都行，但字段要全）
const list = detect();
check(Array.isArray(list) && list.length === 3 && list.every((a) =>
    typeof a.id === 'string' && typeof a.installed === 'boolean' && typeof a.path === 'string'),
    'detect() 返回三项且字段完整', JSON.stringify(list.map((a) => ({ id: a.id, installed: a.installed }))));

// 3) 未知助手报错
const bad = run('nope', 'hi', process.env.TEMP);
check(!bad.ok && /未知/.test(bad.error), '未知 id 报友好错误', bad.error);

// 4) 命令构造：三个助手都把 prompt 放进参数，且无 shell 拼接（防注入）
for (const id of ['claude', 'codex', 'opencode']) {
    const args = AGENTS[id].args('帮我做一个暖色胶片边框，右下角写日期');
    check(args.some((a) => /暖色胶片边框/.test(a)), `${id} 的 args 含用户 prompt`, JSON.stringify(args));
}

// 5) 未安装的助手 run 报「未安装」而非崩溃
const notInstalled = list.find((a) => !a.installed);
if (notInstalled) {
    const r = run(notInstalled.id, 'hi', process.env.TEMP);
    check(!r.ok && /未安装|PATH/.test(r.error), `未安装的 ${notInstalled.id} 报「未安装」`, r.error);
} else {
    check(true, '本机三个助手都已安装，跳过「未安装」路径');
}

// 6) skill 注入：AGENTS.md 被写入且含规则与设计规范
const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-skill-'));
injectSkill(wd, '# 清框影边框设计规范\n\n## 可用风格\nCARD_3D', '只改本目录的 json');
const agentsMd = path.join(wd, 'AGENTS.md');
const okSkill = fs.existsSync(agentsMd) && /只改本目录的 json/.test(fs.readFileSync(agentsMd, 'utf8'))
    && /CARD_3D/.test(fs.readFileSync(agentsMd, 'utf8'));
check(okSkill, 'injectSkill 写入 AGENTS.md（规则 + 规范）', 'exists=' + fs.existsSync(agentsMd));

// 7) detect 带 acp 能力标记
check(list.every((a) => typeof a.acp === 'boolean'), 'detect() 标记每个助手是否有 ACP 适配器',
    JSON.stringify(list.map((a) => ({ id: a.id, acp: a.acp }))));

console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;

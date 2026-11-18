'use strict';
/* 本机编程助手接入（对齐 openfilm：长会话 + 流式 + skill 注入）：
 * 不联网、不要 key——探测本机已装的 CLI，用 ACP（JSON-RPC over stdio）起长会话，
 * 发消息、收流式 session/update、可取消、可续聊。skill 通过 cwd 的 AGENTS.md 约定注入
 * （大多数 agent 启动时都会读），不逐助手改配置。
 *
 * 助手来源：
 *   opencode : opencode acp           （自带 ACP server）
 *   claude   : claude-agent-acp 适配器（有则用），否则降级一次性命令
 *   codex    : codex-acp 适配器（有则用），否则降级一次性命令
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { AcpSession } = require('./acp-client');

const AGENTS = {
    claude: {
        name: 'Claude Code', which: 'claude',
        acpCmd: 'claude-agent-acp', acpArgs: [],
        args: (prompt) => ['-p', '--dangerously-skip-permissions', prompt]
    },
    codex: {
        name: 'Codex', which: 'codex',
        acpCmd: 'codex-acp', acpArgs: [],
        args: (prompt) => ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]
    },
    opencode: {
        name: 'OpenCode', which: 'opencode',
        acpCmd: 'opencode', acpArgs: ['acp'],
        args: (prompt) => ['run', prompt]
    }
};

function resolveCli(which) {
    const isWin = process.platform === 'win32';
    const candidates = isWin ? [`${which}.cmd`, `${which}.exe`, `${which}.bat`] : [which];
    for (const c of candidates) {
        const r = spawnSync(isWin ? 'where' : 'which', [c], { encoding: 'utf8', windowsHide: true });
        if (r.status === 0 && r.stdout && r.stdout.trim()) {
            const first = r.stdout.trim().split(/\r?\n/)[0].trim();
            if (first) return first;
        }
    }
    return null;
}

function detect() {
    const out = [];
    for (const [id, def] of Object.entries(AGENTS)) {
        const exe = resolveCli(def.which);
        const acp = def.acpCmd ? resolveCli(def.acpCmd) : null;
        out.push({
            id, name: def.name, installed: !!exe, path: exe || '',
            acp: !!acp, acpPath: acp || ''
        });
    }
    return out;
}

// 把 skill 注入工作目录：写 AGENTS.md（大多数 agent 启动时读的通用约定）。
function injectSkill(cwd, skillText, rules) {
    try {
        fs.mkdirSync(cwd, { recursive: true });
        const content = [
            '# 清框影边框设计助手',
            '',
            '你在清框影的边框作品目录工作。用户会描述想要的边框，你在这个目录里创建或修改 *.json 边框文件。',
            '',
            rules || '',
            '',
            '--- 以下是完整设计规范 ---',
            '',
            (skillText || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
        ].join('\n');
        fs.writeFileSync(path.join(cwd, 'AGENTS.md'), content, 'utf8');
        return true;
    } catch (e) { return false; }
}

// ── 长会话（ACP）──
const sessions = new Map(); // key -> { session, agent, cwd }

async function start(id, cwd, skillText, rules) {
    const def = AGENTS[id];
    if (!def) return { ok: false, error: '未知助手：' + id };
    let acpPath = def.acpCmd ? resolveCli(def.acpCmd) : null;
    if (!acpPath) return { ok: false, error: `${def.name} 没有可用的 ACP 适配器，请用一次性模式` };
    injectSkill(cwd, skillText, rules);
    const key = id + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6);
    const session = new AcpSession({ command: acpPath, args: def.acpArgs, cwd });
    try {
        await session.init();
        const r = await session.newSession(cwd);
        const modelOpt = (r.configOptions || []).find((o) => o.id === 'model');
        const models = ((modelOpt && modelOpt.options) || []).map((o) => ({
            value: o.value, name: o.name || o.value, current: o.value === modelOpt.currentValue
        }));
        sessions.set(key, { session, agent: id, cwd });
        return { ok: true, key, agent: id, name: def.name, models, modelId: 'model' };
    } catch (e) {
        session.close();
        return { ok: false, error: '启动会话失败：' + e.message };
    }
}

// 切换会话模型
async function setModel(key, modelId, value) {
    const s = sessions.get(key);
    if (!s) return { ok: false, error: '会话不存在' };
    try { await s.session.setConfigOption(modelId || 'model', value); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
}

// 发消息：onEvent 回调把流式更新 push 给渲染层
async function prompt(key, text, onEvent) {
    const s = sessions.get(key);
    if (!s) return { ok: false, error: '会话不存在或已关闭' };
    try {
        await s.session.prompt(String(text || ''), (update) => {
            if (onEvent) onEvent(update);
        });
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
}

function cancel(key) {
    const s = sessions.get(key);
    if (s) s.session.cancel();
}
function close(key) {
    const s = sessions.get(key);
    if (s) { s.session.close(); sessions.delete(key); }
}
function closeAll() { for (const k of [...sessions.keys()]) close(k); }

// ── 一次性命令（降级：没有 ACP 适配器时用）──
function run(id, promptText, cwd, timeoutMs = 120000) {
    const def = AGENTS[id];
    if (!def) return { ok: false, error: '未知助手：' + id };
    const exe = resolveCli(def.which);
    if (!exe) return { ok: false, error: `${def.name} 未安装或未加入 PATH` };
    if (!cwd || !fs.existsSync(cwd)) {
        try { fs.mkdirSync(cwd, { recursive: true }); } catch (e) { return { ok: false, error: '工作目录不可用：' + e.message }; }
    }
    let r;
    const isScript = /\.cmd$|\.bat$/i.test(exe);
    try {
        const args = def.args(promptText).map((a) => `"${String(a).replace(/"/g, '\\"')}"`);
        r = spawnSync(exe, isScript ? args : def.args(promptText), {
            cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
            maxBuffer: 8 * 1024 * 1024, shell: isScript, env: { ...process.env }
        });
    } catch (e) { return { ok: false, error: e.message }; }
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0 && r.status !== null) {
        return { ok: false, error: (r.stderr || r.stdout || '').slice(-1500) || ('退出码 ' + r.status) };
    }
    return { ok: true, output: String(r.stdout || '') };
}

module.exports = { AGENTS, detect, injectSkill, start, setModel, prompt, cancel, close, closeAll, run };

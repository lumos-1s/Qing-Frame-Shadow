'use strict';
/* 本机编程助手接入（openfilm 同款的精简版）：
 * 不联网、不要 key——探测用户本机已装的 CLI，用一次性命令模式跑一条 prompt，
 * 让它在工作目录里读写文件（生成边框 JSON）。所有助手差异收敛在本模块。
 *
 * 支持的助手与一次性命令（cwd 为工作目录，prompt 经 stdin/参数传入）：
 *   claude   : claude -p <prompt>            （--dangerously-skip-permissions 让它在 cwd 自由读写）
 *   codex    : codex exec <prompt>
 *   opencode : opencode run <prompt>
 */
const { spawnSync } = require('child_process');
const fs = require('fs');

const AGENTS = {
    claude: {
        name: 'Claude Code',
        which: 'claude',
        args: (prompt) => ['-p', '--dangerously-skip-permissions', prompt]
    },
    codex: {
        name: 'Codex',
        which: 'codex',
        args: (prompt) => ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]
    },
    opencode: {
        name: 'OpenCode',
        which: 'opencode',
        args: (prompt) => ['run', prompt]
    }
};

// Windows 上探测 .cmd / .exe；which 命令在非 Windows 用。
function resolveCli(which) {
    const isWin = process.platform === 'win32';
    const candidates = isWin
        ? [`${which}.cmd`, `${which}.exe`, `${which}.bat`]
        : [which];
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
        out.push({ id, name: def.name, installed: !!exe, path: exe || '' });
    }
    return out;
}

// 同步跑一条 prompt。工作目录应是 userData/frames（agent 在那生成 JSON）。
// 返回 { ok, output, error }。filePrompt：把 skill 要求写进 prompt，强制 agent 只改 frame 文件。
function run(id, prompt, cwd, timeoutMs = 120000) {
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
        // Windows 上 .cmd/.bat 必须用 shell 执行；参数逐个加引号防 shell 注入
        const args = def.args(prompt).map((a) => `"${String(a).replace(/"/g, '\\"')}"`);
        r = spawnSync(exe, isScript ? args : def.args(prompt), {
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

module.exports = { AGENTS, detect, run };

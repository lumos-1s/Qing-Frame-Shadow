'use strict';
/* 精简 ACP（Agent Client Protocol）客户端：JSON-RPC over stdio，供助手长会话用。
 * 只需 initialize → session/new → session/prompt，并收 session/update 流式事件。
 * 不依赖外部 SDK；OpenCode 自带 `opencode acp`，Claude/Codex 走官方适配器（有则可用）。
 *
 * 用法：new AcpSession({ command, args, cwd, env })
 *   await session.init()            -> 握手
 *   await session.newSession()      -> { sessionId }
 *   await session.prompt(text, onUpdate) -> stopReason；onUpdate({kind, text, ...}) 流式回调
 *   session.cancel() / session.close()
 */
const { spawn } = require('child_process');

function decodeLines(stream, onLine) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) onLine(line);
        }
    });
}

class AcpSession {
    constructor({ command, args = [], cwd, env = {} }) {
        this.command = command;
        this.args = args;
        this.cwd = cwd;
        this.env = { ...process.env, ...env };
        this.proc = null;
        this.seq = 0;
        this.pending = new Map();
        this.sessionId = null;
        this.onEvent = null;
        this.closed = false;
        this._err = '';
    }

    _start() {
        if (this.proc) return;
        const isScript = /\.cmd$|\.bat$/i.test(this.command);
        this.proc = spawn(this.command, this.args, {
            cwd: this.cwd, env: this.env, windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'], shell: isScript
        });
        decodeLines(this.proc.stdout, (line) => this._onLine(line));
        decodeLines(this.proc.stderr, (line) => { this._err += line + '\n'; });
        this.proc.on('exit', () => { this.closed = true; this._rejectAll(new Error('助手进程已退出：' + this._err.slice(-400))); });
        this.proc.on('error', (e) => { this.closed = true; this._rejectAll(e); });
    }

    _onLine(line) {
        let msg;
        try { msg = JSON.parse(line); } catch (_) { return; }
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(typeof msg.error === 'string' ? msg.error : (msg.error.message || 'RPC 错误')));
            else p.resolve(msg.result);
            return;
        }
        // server 发来的带 id 的 method 请求（如 session/request_permission）：
        // 这是 JSON-RPC request，客户端必须用同 id 回 result，而不是 notify 新方法。
        if (msg.id != null && msg.method) {
            let result = {};
            if (msg.method === 'session/request_permission') {
                const opts = (msg.params && msg.params.options) || [];
                const allow = opts.find((o) => o.kind === 'allow_once') || opts.find((o) => o.kind === 'allow_always') || opts[0];
                result = { optionId: allow ? allow.optionId : null };
            }
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
            return;
        }
        if (msg.method && this.onEvent) this.onEvent(msg);
    }

    _rejectAll(err) {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
        this.pending.clear();
    }

    request(method, params = {}, timeoutMs = 1800000) {
        this._start();
        const id = ++this.seq;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('请求超时：' + method)); }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.proc.stdin.write(payload, (err) => { if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); } });
        });
    }

    notify(method, params = {}) {
        this._start();
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }

    async init() {
        return this.request('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'Qingframe', version: '0.1.29' },
            capabilities: {}
        });
    }

    async newSession(cwd) {
        const r = await this.request('session/new', { cwd: cwd || this.cwd, mcpServers: [] });
        this.sessionId = r.sessionId;
        this.configOptions = r.configOptions || [];
        return r;
    }

    // 切换会话配置（如模型）。ACP: session/set_config_option
    async setConfigOption(configId, value) {
        if (!this.sessionId) return null;
        return this.request('session/set_config_option', { sessionId: this.sessionId, configId, value: String(value) });
    }

    async prompt(text, onUpdate) {
        this.onEvent = (msg) => {
            if (msg.method === 'session/update' && onUpdate) {
                onUpdate(msg.params && msg.params.update ? msg.params.update : msg.params);
            }
        };
        const r = await this.request('session/prompt', {
            sessionId: this.sessionId,
            prompt: [{ type: 'text', text }]
        });
        return r;
    }

    cancel() { if (this.sessionId) this.notify('session/cancel', { sessionId: this.sessionId }); }
    close() { try { if (this.proc) this.proc.kill(); } catch (_) { /* 已退出 */ } this.closed = true; }
}

module.exports = { AcpSession };

'use strict';
/* OpenAI 兼容的模型通道：让 AI 边框不再绑死「本机装 OpenCode + 登录 + 额度」。
 *
 * 只做三件事：拼地址、发请求、把响应折成一段文本。
 * apiKey 只在主进程内存里经过，不写日志、不回传渲染层。
 *
 * 地址约定（base 可以是 https://host、https://host/v1 或完整的 .../chat/completions）：
 *   /v1            → /v1/chat/completions
 *   https://host   → https://host/v1/chat/completions
 * 内置代理：设置环境变量 QFS_AI_PROXY 即可让打包版默认走自己的中转。
 */
const DEFAULT_BASE = 'https://api.openai.com/v1';

function normBase(u) {
    let s = String(u || '').trim();
    if (!s) s = String(process.env.QFS_AI_PROXY || '').trim() || DEFAULT_BASE;
    return s.replace(/\/+$/, '');
}
function endpoint(base, kind) {
    const b = normBase(base);
    if (kind === 'models') {
        if (/\/models$/i.test(b)) return b;
        if (/\/v\d+$/i.test(b)) return b + '/models';
        return b + '/v1/models';
    }
    if (/\/chat\/completions$/i.test(b)) return b;
    if (/\/v\d+$/i.test(b)) return b + '/chat/completions';
    return b + '/v1/chat/completions';
}
function headers(cfg) {
    const h = { 'Content-Type': 'application/json' };
    const key = String((cfg && cfg.apiKey) || '').trim();
    if (key) h.Authorization = 'Bearer ' + key;
    return h;
}
function extraHeaders(cfg) {
    const h = {};
    const raw = cfg && cfg.headers;
    if (!raw || typeof raw !== 'object') return h;
    for (const k of Object.keys(raw)) {
        if (!k || /^(host|content-length|connection)$/i.test(k)) continue;
        const v = raw[k];
        if (typeof v === 'string' && v) h[k] = v;
    }
    return h;
}
function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
}

async function request(url, cfg, body, timeoutMs) {
    const ms = Math.max(3000, Math.min(300000, Number(timeoutMs) || 120000));
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), ms) : null;
    try {
        const res = await fetch(url, {
            method: body ? 'POST' : 'GET',
            headers: Object.assign(headers(cfg), extraHeaders(cfg)),
            body: body ? JSON.stringify(body) : undefined,
            signal: ac ? ac.signal : undefined
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.error && (data.error.message || data.error.type) || data.message)) || clip(text, 300);
            return { ok: false, status: res.status, error: 'HTTP ' + res.status + (msg ? '：' + msg : '') };
        }
        if (!data) return { ok: false, status: res.status, error: '返回不是 JSON：' + clip(text, 200) };
        return { ok: true, status: res.status, data };
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
        return { ok: false, status: 0, error: aborted ? '请求超时（' + Math.round(ms / 1000) + 's）' : '请求失败：' + (e && e.message ? e.message : String(e)) };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function chat(cfg, messages) {
    const c = cfg || {};
    const list = (Array.isArray(messages) ? messages : [])
        .filter((m) => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content }));
    if (!list.length) return { ok: false, error: '没有要发送的内容' };
    if (!String(c.model || '').trim()) return { ok: false, error: '还没填模型名' };
    const body = {
        model: String(c.model).trim(),
        messages: list,
        temperature: Number.isFinite(Number(c.temperature)) ? Number(c.temperature) : 0.8,
        stream: false
    };
    if (Number.isFinite(Number(c.maxTokens)) && Number(c.maxTokens) > 0) body.max_tokens = Math.floor(Number(c.maxTokens));
    const r = await request(endpoint(c.baseUrl, 'chat'), c, body, c.timeout);
    if (!r.ok) return r;
    const d = r.data || {};
    const choice = Array.isArray(d.choices) ? d.choices[0] : null;
    let content = choice && choice.message ? choice.message.content : '';
    if (Array.isArray(content)) content = content.map((p) => (p && (p.text || p.content)) || '').join('');
    if (!content && typeof d.output_text === 'string') content = d.output_text;
    if (!content && typeof d.content === 'string') content = d.content;
    if (!content) return { ok: false, status: r.status, error: '模型返回空内容（' + clip(JSON.stringify(d), 200) + '）' };
    return {
        ok: true, content: String(content), model: d.model || body.model,
        usage: d.usage || null
    };
}

async function models(cfg) {
    const r = await request(endpoint(cfg && cfg.baseUrl, 'models'), cfg, null, 20000);
    if (!r.ok) return r;
    const d = r.data || {};
    const arr = Array.isArray(d.data) ? d.data : (Array.isArray(d.models) ? d.models : []);
    return { ok: true, models: arr.map((m) => (typeof m === 'string' ? m : m && (m.id || m.name))).filter(Boolean) };
}

module.exports = { chat, models, endpoint, normBase, DEFAULT_BASE };

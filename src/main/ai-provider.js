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
    // 图像生成 / 图像编辑：同一套 base 约定，落到 /images/...
    if (kind === 'images' || kind === 'edits') {
        const tail = kind === 'edits' ? 'edits' : 'generations';
        if (new RegExp('/images/' + tail + '$', 'i').test(b)) return b;
        if (/\/images$/i.test(b)) return b + '/' + tail;
        if (/\/v\d+$/i.test(b)) return b + '/images/' + tail;
        return b + '/v1/images/' + tail;
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
// 供 multipart 用：只带鉴权与自定义头，绝不写 Content-Type
function authHeaders(cfg) {
    const h = extraHeaders(cfg);
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

// 图片只收内联 data URL：不让渲染层把任意 http 地址塞给上游（SSRF、防盗链、
// 内网探测都能借这条通道发生）。2 张 / 6MB 是「一张 512px 缩略图 + 一张对比图」
// 够用的上限，再大对选框没有帮助，只会把请求体顶到网关拒绝。
const IMAGE_DATA_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;
const MAX_IMAGE_CHARS = 9 * 1024 * 1024;
const MAX_IMAGES = 2;
const MAX_TEXT_CHARS = 60000;

function normalizeContent(content) {
    if (typeof content === 'string') {
        const t = content.slice(0, MAX_TEXT_CHARS);
        return t.trim() ? { ok: true, content: t } : { ok: false, error: '空消息' };
    }
    if (!Array.isArray(content)) return { ok: false, error: '消息内容必须是文本或内容块' };
    const parts = [];
    let images = 0;
    for (const raw of content) {
        const p = raw && typeof raw === 'object' ? raw : null;
        if (!p) continue;
        if (p.type === 'text' && typeof p.text === 'string') {
            const t = p.text.slice(0, MAX_TEXT_CHARS);
            if (t.trim()) parts.push({ type: 'text', text: t });
            continue;
        }
        if (p.type === 'image_url') {
            const url = typeof p.image_url === 'string' ? p.image_url : (p.image_url && p.image_url.url);
            const clean = typeof url === 'string' ? url.replace(/\s+/g, '') : '';
            if (!IMAGE_DATA_RE.test(clean)) return { ok: false, error: '只支持内联的 png/jpeg/webp 图片' };
            if (clean.length > MAX_IMAGE_CHARS) return { ok: false, error: '图片太大（上限约 6MB）' };
            if (++images > MAX_IMAGES) return { ok: false, error: '一条消息最多 2 张图' };
            parts.push({ type: 'image_url', image_url: { url: clean } });
            continue;
        }
        return { ok: false, error: '不支持的内容类型：' + String(p.type || '?') };
    }
    return parts.length ? { ok: true, content: parts } : { ok: false, error: '空消息' };
}

async function chat(cfg, messages) {
    const c = cfg || {};
    const list = [];
    for (const m of (Array.isArray(messages) ? messages : [])) {
        if (!m || (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant')) continue;
        const n = normalizeContent(m.content);
        if (!n.ok) return { ok: false, error: n.error };
        list.push({ role: m.role, content: n.content });
    }
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
    const probeMs = Math.max(3000, Math.min(20000, Number(cfg && cfg.timeout) || 20000));
    const r = await request(endpoint(cfg && cfg.baseUrl, 'models'), cfg, null, probeMs);
    if (!r.ok) return r;
    const d = r.data || {};
    const arr = Array.isArray(d.data) ? d.data : (Array.isArray(d.models) ? d.models : []);
    return { ok: true, models: arr.map((m) => (typeof m === 'string' ? m : m && (m.id || m.name))).filter(Boolean) };
}

// ── 图像生成 ──
// 支持两种源：纯 prompt（generations）与带参考图（edits，multipart）。
// 返回统一成 data URL，渲染层不需要碰网络、也不碰 Key。
function decodeDataUrl(s) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(s || ''));
    if (!m) return null;
    return { mime: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') };
}

async function fetchAsDataUrl(url, cfg, timeoutMs) {
    const ms = Math.max(3000, Math.min(120000, Number(timeoutMs) || 30000));
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), ms) : null;
    try {
        const res = await fetch(String(url), { headers: extraHeaders(cfg), signal: ac ? ac.signal : undefined });
        if (!res.ok) return { ok: false, error: '取图失败 HTTP ' + res.status };
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = String((res.headers && res.headers.get && res.headers.get('content-type')) || 'image/png').split(';')[0];
        return { ok: true, mime, data: 'data:' + mime + ';base64,' + buf.toString('base64') };
    } catch (e) {
        return { ok: false, error: '取图失败：' + (e && e.message ? e.message : String(e)) };
    } finally { if (timer) clearTimeout(timer); }
}

function pickImage(data) {
    if (!data || typeof data !== 'object') return null;
    const arr = Array.isArray(data.data) ? data.data : (Array.isArray(data.images) ? data.images : [data]);
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        if (item.b64_json) return { type: 'b64', value: item.b64_json, revised: item.revised_prompt || '' };
        if (item.url || item.image_url) return { type: 'url', value: item.url || item.image_url, revised: item.revised_prompt || '' };
    }
    if (typeof data.b64_json === 'string') return { type: 'b64', value: data.b64_json };
    if (typeof data.url === 'string') return { type: 'url', value: data.url };
    if (typeof data.image === 'string') return /^data:/.test(data.image) ? { type: 'data', value: data.image } : { type: 'url', value: data.image };
    return null;
}

async function image(cfg, params) {
    const c = cfg || {};
    const p = params || {};
    const prompt = String(p.prompt || '').trim();
    if (!prompt) return { ok: false, error: '缺画面描述' };
    if (!String(c.model || '').trim()) return { ok: false, error: '还没填图像模型名' };
    const src = typeof p.source === 'string' ? decodeDataUrl(p.source) : null;
    if (p.source && !src) return { ok: false, error: '参考图不是可识别的 data URL' };
    const size = /^\d+x\d+$/.test(String(p.size || '')) ? p.size : '1024x1024';
    const timeout = Math.max(30000, Number(c.timeout) || 180000);

    // edits：带参考图，告诉模型"保留现场身份"；generations：纯文字创作
    let r;
    if (src) {
        const form = new FormData();
        form.append('model', String(c.model).trim());
        form.append('prompt', prompt);
        form.append('size', size);
        form.append('n', '1');
        form.append('image', new Blob([src.buffer], { type: src.mime }), 'source.' + (src.mime.split('/')[1] || 'png'));
        const url = endpoint(c.baseUrl, 'edits');
        const ms = Math.max(3000, Math.min(300000, timeout));
        const ac = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ac ? setTimeout(() => ac.abort(), ms) : null;
        try {
            const res = await fetch(url, {
                method: 'POST',
                // 只带 Authorization + 自定义头；绝不带 Content-Type（headers() 里那个 json 头要剔掉），
                // 否则 fetch 不会生成 multipart boundary，服务端解析不到 form 字段。
                headers: authHeaders(c),
                body: form,
                signal: ac ? ac.signal : undefined
            });
            const text = await res.text();
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
            if (!res.ok) {
                const msg = (data && (data.error && (data.error.message || data.error.type) || data.message)) || clip(text, 300);
                return { ok: false, status: res.status, error: 'HTTP ' + res.status + (msg ? '：' + msg : '') };
            }
            r = { ok: true, status: res.status, data };
        } catch (e) {
            const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
            return { ok: false, status: 0, error: aborted ? '请求超时' : '请求失败：' + (e && e.message ? e.message : String(e)) };
        } finally { if (timer) clearTimeout(timer); }
    } else {
        const body = { model: String(c.model).trim(), prompt, size, n: 1 };
        r = await request(endpoint(c.baseUrl, 'images'), c, body, timeout);
    }
    if (!r.ok) return r;
    const picked = pickImage(r.data);
    if (!picked) return { ok: false, status: r.status, error: '图像接口没返回可用的图（' + clip(JSON.stringify(r.data), 200) + '）' };
    if (picked.type === 'b64') {
        return { ok: true, image: 'data:image/png;base64,' + String(picked.value || '').replace(/\s/g, ''), revised: picked.revised, path: src ? 'edits' : 'generations' };
    }
    if (picked.type === 'data') return { ok: true, image: picked.value, revised: picked.revised, path: src ? 'edits' : 'generations' };
    const got = await fetchAsDataUrl(picked.value, c, timeout);
    if (!got.ok) return got;
    return { ok: true, image: got.data, revised: picked.revised, path: src ? 'edits' : 'generations', sourceUrl: picked.value };
}

module.exports = { chat, models, image, endpoint, normBase, decodeDataUrl, pickImage, normalizeContent, DEFAULT_BASE };

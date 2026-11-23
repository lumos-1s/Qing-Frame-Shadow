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

// 有一类地址压根没有图像接口：OpenAI 兼容说的是「对话接口的形状一样」，
// 不等于它什么都有。这里只收「确定没有画图能力」的几家——命中时本地直接拦下，
// 一个请求都不发。否则用户看到的只是一个 404，然后开始怀疑 Key 和模型名。
const TEXT_ONLY_HOSTS = [
    { re: /(^|\.)deepseek\.com$/i, name: 'DeepSeek' },
    { re: /(^|\.)moonshot\.(cn|ai)$/i, name: 'Kimi（Moonshot）' },
    { re: /(^|\.)anthropic\.com$/i, name: 'Anthropic' }
];
function textOnlyGateway(baseUrl) {
    let host = '';
    try { host = new URL(normBase(baseUrl)).hostname; } catch (_) { return null; }
    for (const t of TEXT_ONLY_HOSTS) if (t.re.test(host)) return { host, name: t.name };
    return null;
}

// 图像模型名：显式填的 imageModel 优先；没填时，只有当对话模型名本身就像画图模型
// （有些中转把两者配成同一个名字）才复用。否则宁可拦下——拿 deepseek-chat 去请求
// /images/edits，回来的 404 只会把人引到错的方向。
const IMAGE_MODEL_RE = /(image|dall-?e|seedream|seededit|seedance|cogview|flux|sdxl|stable-?diffusion|kolors|wanx|qwen-image|imagen|ideogram|recraft|grok-2-image)/i;
function looksLikeImageModel(name) { return IMAGE_MODEL_RE.test(String(name || '')); }

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

// 取回模型给的图片地址。有的网关直接返回预签名 URL（不需要鉴权），有的是自家
// 需要 Bearer 的接口。只在与 baseUrl 同源时带上 Key 与自定义头——否则等于把
// 凭据发给一个响应里随便写的地址，那是最典型的凭据外泄路径。
function sameOrigin(a, b) {
    try { return new URL(String(a)).origin === new URL(normBase(b)).origin; }
    catch (_) { return false; }
}

async function fetchAsDataUrl(url, cfg, timeoutMs) {
    const ms = Math.max(3000, Math.min(120000, Number(timeoutMs) || 30000));
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), ms) : null;
    try {
        const trust = sameOrigin(url, cfg && cfg.baseUrl);
        const h = trust ? extraHeaders(cfg) : {};
        const key = String((cfg && cfg.apiKey) || '').trim();
        if (key && trust) h.Authorization = 'Bearer ' + key;
        const res = await fetch(String(url), { headers: h, signal: ac ? ac.signal : undefined });
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

// multipart 版：只有 edits 用它。注意这里绝不能再带 Content-Type——
// 那个头一旦出现，fetch 就不会生成 boundary，服务端一个字段都解析不到。
async function requestForm(url, cfg, form, timeoutMs) {
    const ms = Math.max(3000, Math.min(300000, Number(timeoutMs) || 180000));
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), ms) : null;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: authHeaders(cfg),
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
        return { ok: true, status: res.status, data };
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
        return { ok: false, status: 0, error: aborted ? '请求超时（' + Math.round(ms / 1000) + 's）' : '请求失败：' + (e && e.message ? e.message : String(e)) };
    } finally { if (timer) clearTimeout(timer); }
}

async function image(cfg, params) {
    const c = cfg || {};
    const p = params || {};
    const prompt = String(p.prompt || '').trim();
    if (!prompt) return { ok: false, error: '缺画面描述' };

    // ① 先问「这个地址有没有画图接口」，别让一次注定 404 的请求去冒充配置错误
    const only = textOnlyGateway(c.baseUrl);
    if (only) {
        return {
            ok: false, code: 'no-image-api',
            error: only.name + '（' + only.host + '）只提供对话接口，没有画图接口，AI 破框在这里出不了图。'
                + '要出图得换一个带图像模型的地址：火山方舟（ark.cn-beijing.volces.com/api/v3）、阿里百炼、'
                + 'OpenAI 官方，或支持图生图的中转站；地址、Key、图像模型三项要一起换。'
        };
    }

    // ② 模型名：出图用的是图像模型，不是对话模型
    const chatModel = String(c.model || '').trim();
    const model = String(c.imageModel || p.model || '').trim()
        || (looksLikeImageModel(chatModel) ? chatModel : '');
    if (!model) {
        return {
            ok: false, code: 'need-image-model',
            error: chatModel
                ? '还没填图像模型。上面那个「' + chatModel + '」是对话模型的名字，拿它请求画图接口只会换回 404——'
                    + '去 AI 设置里填一个能出图的模型名。'
                : '还没填图像模型名。'
        };
    }

    const src = typeof p.source === 'string' ? decodeDataUrl(p.source) : null;
    if (p.source && !src) return { ok: false, error: '参考图不是可识别的 data URL' };
    const size = /^\d+x\d+$/.test(String(p.size || '')) ? p.size : '1024x1024';
    const timeout = Math.max(30000, Number(c.timeout) || 180000);

    // edits：带参考图，告诉模型"保留现场身份"；generations：纯文字创作
    let r;
    let degraded = '';   // 网关没有 edits，退到 generations 的 image 字段
    if (src) {
        const form = new FormData();
        form.append('model', model);
        form.append('prompt', prompt);
        form.append('size', size);
        form.append('n', '1');
        form.append('image', new Blob([src.buffer], { type: src.mime }), 'source.' + (src.mime.split('/')[1] || 'png'));
        r = await requestForm(endpoint(c.baseUrl, 'edits'), c, form, timeout);
        // 404/405 说明这条路根本不存在（请求没执行、不会重复计费），可以安全地退一步：
        // 火山方舟的 seedream、硅基流动和一部分中转把图生图放在同一个 generations 端点，
        // 靠 JSON 里的 image 字段传参考图。
        if (!r.ok && (r.status === 404 || r.status === 405)) {
            const alt = await request(endpoint(c.baseUrl, 'images'), c,
                { model, prompt, size, n: 1, image: String(p.source) }, timeout);
            if (alt.ok) { r = alt; degraded = 'no-edits'; }
            else if (alt.status === 404 || alt.status === 405) {
                return {
                    ok: false, status: alt.status, code: 'no-images-api',
                    error: '这个地址下没有图像接口：/images/edits 和 /images/generations 都返回 ' + alt.status + '。'
                        + '它多半只能对话，换一个能出图的网关。'
                };
            } else r = alt;
        }
    } else {
        r = await request(endpoint(c.baseUrl, 'images'), c, { model, prompt, size, n: 1 }, timeout);
    }
    if (!r.ok) return r;
    const picked = pickImage(r.data);
    if (!picked) return { ok: false, status: r.status, error: '图像接口没返回可用的图（' + clip(JSON.stringify(r.data), 200) + '）' };
    // 退化的路径要说出来：不支持参考图的网关照样会出一张图，但那只是照着文字画的
    const path = src ? (degraded ? 'generations-img' : 'edits') : 'generations';
    const note = degraded ? '这个网关没开 edits，已改用 generations 的 image 字段重试' : '';
    if (picked.type === 'b64') {
        return { ok: true, image: 'data:image/png;base64,' + String(picked.value || '').replace(/\s/g, ''), revised: picked.revised, path, note };
    }
    if (picked.type === 'data') return { ok: true, image: picked.value, revised: picked.revised, path, note };
    const got = await fetchAsDataUrl(picked.value, c, timeout);
    if (!got.ok) return got;
    return { ok: true, image: got.data, revised: picked.revised, path, note, sourceUrl: picked.value };
}

module.exports = { chat, models, image, endpoint, normBase, decodeDataUrl, pickImage, normalizeContent, textOnlyGateway, looksLikeImageModel, DEFAULT_BASE };

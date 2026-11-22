'use strict';
/* API 通道：给不装本机 CLI 的用户一条直路。
 *
 * 配置只存在本机 localStorage（换机器不带走），请求由主进程发出，
 * 所以 key 不会出现在渲染层的网络日志里；这里也从不把 key 打进 console。
 *
 * 兼容 OpenAI 风格的 /chat/completions：官方、Azure 网关、one-api、自建中转都行。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.QfsAiProvider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const CFG_KEY = 'qfs_ai_api_v1';
    const CH_KEY = 'qfs_ai_channel';
    const DEFAULTS = { baseUrl: '', apiKey: '', model: '', imageModel: '' };

    function read(k, d) { try { return localStorage.getItem(k) || d; } catch (_) { return d; } }
    function write(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (_) {} }

    function load() {
        try {
            const raw = read(CFG_KEY, '');
            if (!raw) return Object.assign({}, DEFAULTS);
            const v = JSON.parse(raw);
            return {
                baseUrl: String((v && v.baseUrl) || ''),
                apiKey: String((v && v.apiKey) || ''),
                model: String((v && v.model) || ''),
                imageModel: String((v && v.imageModel) || '')
            };
        } catch (_) { return Object.assign({}, DEFAULTS); }
    }
    function save(cfg) {
        const c = cfg && typeof cfg === 'object' ? cfg : {};
        const out = {
            baseUrl: String(c.baseUrl || '').trim().slice(0, 500),
            apiKey: String(c.apiKey || '').trim().slice(0, 400),
            model: String(c.model || '').trim().slice(0, 200),
            imageModel: String(c.imageModel || '').trim().slice(0, 200)
        };
        write(CFG_KEY, JSON.stringify(out));
        return out;
    }
    // 通道按用途隔离：AI 造型（写图层 JSON，本机助手免 Key）与拾景纸刊（图像生成，
    // 必须走 API）对通道的要求相反。共用一个开关，拨哪头都废另一头。
    // scope: 'frame' | 'zine'；旧的单键 CH_KEY 直接作为 frame 的键（老用户无感迁移），
    // zine 单独用新键，默认 api，不继承 frame 的 local。
    const SCOPE_KEY = { frame: CH_KEY, zine: CH_KEY + ':zine' };
    // frame 默认走「本地配方」：不装 CLI、不填 Key、点一下秒出 4 款。
    // 想用模型自由发挥再切本机助手 / API，失败也不影响基础出片。
    const SCOPE_DEFAULT = { frame: 'recipe', zine: 'api' };
    const CHANNELS = ['recipe', 'local', 'api'];
    function scopeOf(s) { return s === 'zine' ? 'zine' : 'frame'; }
    function channel(scope) {
        const sc = scopeOf(scope);
        const legacy = read(CH_KEY, '');
        let v = read(SCOPE_KEY[sc], '');
        // 老用户的 CH_KEY 就是 frame 的值，无需搬；zine 没有旧值，
        // 落到 SCOPE_DEFAULT.zine（api），不会继承 frame 的 local 把纸刊废掉。
        if (!v && sc === 'frame' && legacy) v = legacy;
        return CHANNELS.includes(v) ? v : SCOPE_DEFAULT[sc];
    }
    const CHANGE_EVENT = 'qfs-ai-channel';
    function announce(scope, value) {
        if (typeof window === 'undefined' || !window.dispatchEvent) return;
        try {
            window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { scope: scopeOf(scope), channel: value } }));
        } catch (_) {
            try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch (__) {}
        }
    }
    function setChannel(v, scope) {
        const sc = scopeOf(scope);
        const next = CHANNELS.includes(v) ? v : 'recipe';
        write(SCOPE_KEY[sc], next);
        if (sc === 'frame') write(CH_KEY, next);   // 保持旧键同步，老代码仍可读
        announce(sc, next);
        return channel(sc);
    }
    // 本机回环地址（ComfyUI / SD WebUI / 自建网关）没有 Key 也能调，
    // _remote_ 服务仍必须有 Key。这样纸刊可以直接接本地文生图，不必买云端 Key。
    function isLocalBase(url) {
        const s = String(url || '').trim();
        if (!s) return false;
        try {
            const u = new URL(s, (typeof window !== 'undefined' && window.location && window.location.href) || 'http://localhost/');
            return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(u.hostname);
        } catch (_) {
            return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i.test(s);
        }
    }
    function hasCredential(c) { return !!(c && (c.apiKey || isLocalBase(c.baseUrl))); }
    function ready(cfg) {
        const c = cfg || load();
        return !!(c && hasCredential(c) && c.model);
    }
    function mask(key) {
        const s = String(key || '');
        if (!s) return '';
        if (s.length <= 8) return '····';
        return s.slice(0, 4) + '····' + s.slice(-4);
    }
    function bridge() { return (typeof window !== 'undefined' && window.qingframe) || {}; }

    async function chat(messages, opts) {
        const api = bridge();
        if (typeof api.aiChat !== 'function') return { ok: false, error: '这条通道只在桌面版可用' };
        const cfg = Object.assign(load(), opts || {});
        if (!hasCredential(cfg)) return { ok: false, error: '还没填 API Key（本机服务可留空）' };
        if (!cfg.model) return { ok: false, error: '还没填模型名' };
        try {
            return await api.aiChat(cfg, messages);
        } catch (e) {
            return { ok: false, error: '调用失败：' + (e && e.message ? e.message : String(e)) };
        }
    }
    async function models(cfg) {
        const api = bridge();
        if (typeof api.aiModels !== 'function') return { ok: false, error: '这条通道只在桌面版可用' };
        try { return await api.aiModels(Object.assign(load(), cfg || {})); }
        catch (e) { return { ok: false, error: '调用失败：' + (e && e.message ? e.message : String(e)) }; }
    }
    // 图像生成：prompt 必填，source 可选（实景拼贴带参考图，影像蒸馏不带）
    async function image(params) {
        const api = bridge();
        if (typeof api.aiImage !== 'function') return { ok: false, error: '图像通道只在桌面版可用' };
        const cfg = load();
        if (!hasCredential(cfg)) return { ok: false, error: '还没填 API Key（本机服务可留空）' };
        if (!cfg.imageModel && !cfg.model) return { ok: false, error: '还没填图像模型名' };
        const p = params && typeof params === 'object' ? params : {};
        try { return await api.aiImage(cfg, p); }
        catch (e) { return { ok: false, error: '调用失败：' + (e && e.message ? e.message : String(e)) }; }
    }
    function imageReady() { const c = load(); return !!(hasCredential(c) && (c.imageModel || c.model)); }

    // 一键本机模式：探测常见本地文生图端口，选中第一个能返回模型列表的地址。
    const LOCAL_CANDIDATES = [
        'http://127.0.0.1:7860/v1', 'http://127.0.0.1:8188/v1',
        'http://localhost:7860/v1', 'http://localhost:8188/v1'
    ];
    async function detectLocal() {
        const results = await Promise.all(LOCAL_CANDIDATES.map(async (baseUrl) => {
            try {
                const r = await models({ baseUrl, apiKey: '', model: 'probe', timeout: 3000 });
                return (r && r.ok) ? baseUrl : '';
            } catch (_) { return ''; }
        }));
        const found = results.filter(Boolean);
        return { ok: found.length > 0, base: found[0] || '', tried: LOCAL_CANDIDATES.slice() };
    }
    // 把探测到的本机服务写进配置：本机地址免 Key，模型名只是接口的非空占位。
    function applyLocal(baseUrl) {
        const base = String(baseUrl || '').trim();
        if (!base || !isLocalBase(base)) return false;
        // 只切纸刊通道：一键本机是纸刊功能，不该把 AI 造型的通道也拨走。
        // 文字模型保持原值，只补图像模型名（本地服务靠地址而不是模型名选后端）。
        const cur = load();
        save(Object.assign({}, cur, { baseUrl: base, apiKey: '', imageModel: 'local' }));
        setChannel('api', 'zine');
        return true;
    }
    // 连接测试：一句话、极短回复，只验「地址/Key/模型」三件事对不对
    async function test(cfg) {
        const c = Object.assign(load(), cfg || {});
        if (!hasCredential(c)) return { ok: false, error: '先填 API Key（本机服务可留空）' };
        if (!c.model) return { ok: false, error: '先填模型名' };
        const r = await chat([{ role: 'user', content: '只回复 ok 两个字符' }], { maxTokens: 16, temperature: 0 });
        if (!r.ok) return r;
        return { ok: true, text: String(r.content || '').trim().slice(0, 40), model: r.model || c.model };
    }

    return { CFG_KEY, CH_KEY, CHANGE_EVENT, LOCAL_CANDIDATES, load, save, channel, setChannel, ready, mask, chat, models, image, imageReady, test, isLocalBase, detectLocal, applyLocal };
});

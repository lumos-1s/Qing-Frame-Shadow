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
    const DEFAULTS = { baseUrl: '', apiKey: '', model: '' };

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
                model: String((v && v.model) || '')
            };
        } catch (_) { return Object.assign({}, DEFAULTS); }
    }
    function save(cfg) {
        const c = cfg && typeof cfg === 'object' ? cfg : {};
        const out = {
            baseUrl: String(c.baseUrl || '').trim().slice(0, 500),
            apiKey: String(c.apiKey || '').trim().slice(0, 400),
            model: String(c.model || '').trim().slice(0, 200)
        };
        write(CFG_KEY, JSON.stringify(out));
        return out;
    }
    function channel() { return read(CH_KEY, 'local') === 'api' ? 'api' : 'local'; }
    function setChannel(v) { write(CH_KEY, v === 'api' ? 'api' : 'local'); return channel(); }
    function ready(cfg) {
        const c = cfg || load();
        return !!(c && c.apiKey && c.model);
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
        if (!cfg.apiKey) return { ok: false, error: '还没填 API Key' };
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
    // 连接测试：一句话、极短回复，只验「地址/Key/模型」三件事对不对
    async function test(cfg) {
        const c = Object.assign(load(), cfg || {});
        if (!c.apiKey) return { ok: false, error: '先填 API Key' };
        if (!c.model) return { ok: false, error: '先填模型名' };
        const r = await chat([{ role: 'user', content: '只回复 ok 两个字符' }], { maxTokens: 16, temperature: 0 });
        if (!r.ok) return r;
        return { ok: true, text: String(r.content || '').trim().slice(0, 40), model: r.model || c.model };
    }

    return { CFG_KEY, load, save, channel, setChannel, ready, mask, chat, models, test };
});

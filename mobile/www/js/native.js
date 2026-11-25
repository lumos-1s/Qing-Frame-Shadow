'use strict';
/* P1 原生适配层：Capacitor 插件 + 浏览器降级。
   对上暴露 window.qfsNative（手机专用）与 window.qingframe（兼容桌面同步模块的子集）。 */
(function () {
    const C = window.Capacitor || {};
    const isNative = typeof C.isNativePlatform === 'function' && C.isNativePlatform();
    const platform = typeof C.getPlatform === 'function' ? C.getPlatform() : 'web';

    const plugins = {};
    function plugin(name) {
        if (!isNative) return null;
        if (!plugins[name]) plugins[name] = C.registerPlugin(name);
        return plugins[name];
    }

    const progressListeners = new Set();
    const prefs = (() => {
        try { return JSON.parse(localStorage.getItem('qfm_prefs') || '{}') || {}; }
        catch (_) { return {}; }
    })();

    /* ── 选图：Web 与原生都走 <input type=file>，原生端会调起系统图库/文件应用 ── */
    let fileInput = null;
    function pickImages() {
        return new Promise((resolve) => {
            if (!fileInput) {
                fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.multiple = true;
                fileInput.accept = 'image/*,.heic,.cr2,.nef,.arw,.dng';
                fileInput.style.display = 'none';
                document.body.appendChild(fileInput);
            }
            fileInput.value = '';
            fileInput.onchange = async () => {
                const files = Array.from(fileInput.files || []);
                const out = [];
                for (const f of files) {
                    try {
                        const url = URL.createObjectURL(f);
                        const img = await new Promise((res, rej) => {
                            const i = new Image();
                            i.onload = () => res(i); i.onerror = rej; i.src = url;
                        });
                        // 预览限制 1600px，避免手机上大图直接占满内存
                        const max = 1600;
                        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
                        const w = Math.max(1, Math.round(img.naturalWidth * scale));
                        const h = Math.max(1, Math.round(img.naturalHeight * scale));
                        const cv = document.createElement('canvas');
                        cv.width = w; cv.height = h;
                        cv.getContext('2d').drawImage(img, 0, 0, w, h);
                        cv.naturalWidth = w; cv.naturalHeight = h; cv.complete = true;
                        out.push({ el: cv, name: f.name, w, h, grade: null, file: f });
                    } catch (_) { /* 单张失败不影响其他照片 */ }
                }
                resolve(out);
            };
            fileInput.click();
        });
    }

    /* ── 保存 / 分享 ── */
    async function saveImage(dataUrl, filename) {
        const base64 = String(dataUrl || '').split(',').pop() || '';
        try {
            if (isNative) {
                const FS = plugin('Filesystem');
                const r = await FS.writeFile({ directory: 'CACHE', path: filename, data: base64, encoding: 'base64' });
                const uri = r && r.uri;
                const Share = plugin('Share');
                await Share.share({ title: '清框影', text: '照片已做好', url: uri, dialogTitle: '保存到相册或分享' });
                return { ok: true, mode: 'native', uri };
            }
        } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
        }
        // 浏览器降级：直接下载
        try {
            const a = document.createElement('a');
            a.href = 'data:' + (dataUrl.startsWith('data:') ? '' : 'image/png;base64,') + base64;
            a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            return { ok: true, mode: 'download' };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }

    /* ── 偏好 ── */
    async function getPrefs() {
        if (isNative) {
            try {
                const r = await plugin('Preferences').get({ key: 'qfm_prefs' });
                return JSON.parse(r.value || '{}') || {};
            } catch (_) { /* 回退 localStorage */ }
        }
        return prefs;
    }
    async function savePrefs(patch) {
        Object.assign(prefs, patch || {});
        try { localStorage.setItem('qfm_prefs', JSON.stringify(prefs)); } catch (_) {}
        if (isNative) {
            try { await plugin('Preferences').set({ key: 'qfm_prefs', value: JSON.stringify(prefs) }); }
            catch (_) { /* 本地副本已写 */ }
        }
        progressListeners.forEach((fn) => fn({ type: 'prefs', patch }));
        return { ok: true };
    }

    /* ── 模板：原生存沙盒文件，浏览器存 localStorage ── */
    const tplKey = 'qfm_templates';
    function readTplMap() {
        try { return JSON.parse(localStorage.getItem(tplKey) || '{}') || {}; }
        catch (_) { return {}; }
    }
    function writeTplMap(map) { localStorage.setItem(tplKey, JSON.stringify(map)); }

    const nativeApi = {
        platform: () => platform,
        isMac: () => platform === 'ios',
        pickImages,
        saveImage,
        getPrefs,
        savePrefs,
        loadAllPresets: async () => window.QF_PRESETS || [],
        listPresets: async () => (window.QF_PRESETS || []).map((p) => p._fileName),
        loadPreset: async (name) => (window.QF_PRESETS || []).find((p) => p._fileName === name) || null,
        listTemplates: async () => Object.keys(readTplMap()),
        loadTemplate: async (name) => readTplMap()[name] || null,
        saveTemplate: async (name, data) => { const m = readTplMap(); m[name] = data; writeTplMap(m); return { ok: true }; },
        deleteTemplate: async (name) => { const m = readTplMap(); delete m[name]; writeTplMap(m); return { ok: true }; },
        renameTemplate: async (from, to) => {
            const m = readTplMap(); if (!m[from] || m[to]) return { ok: false };
            m[to] = m[from]; delete m[from]; writeTplMap(m); return { ok: true };
        },
        defaultTemplate: () => JSON.parse(JSON.stringify(window.QF_DEFAULT_TEMPLATE || {})),
        onExportProgress(fn) { progressListeners.add(fn); return () => progressListeners.delete(fn); }
    };

    window.qfsNative = nativeApi;
    // 兼容同步过来的桌面模块（presets.js 等）用到的子集
    window.qingframe = Object.assign(window.qingframe || {}, nativeApi);
})();

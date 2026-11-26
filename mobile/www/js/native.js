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
    // 每张失败的照片都留一条原因：旧代码 catch 里什么都不做，RAW 解码失败时
    // 用户只看到「没反应」，分不清是没选图还是解码器坏了。
    let pickErrors = [];
    function getPickErrors() { return pickErrors.slice(); }

    function notify(text, ms) {
        if (typeof window.qfHint === 'function') window.qfHint(text, ms);
    }

    function drawDown(img, max) {
        const iw = img.naturalWidth || img.width || 0;
        const ih = img.naturalHeight || img.height || 0;
        const k = Math.min(1, max / Math.max(iw, ih));
        const w = Math.max(1, Math.round(iw * k));
        const h = Math.max(1, Math.round(ih * k));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cv.naturalWidth = w; cv.naturalHeight = h; cv.complete = true;
        return cv;
    }

    function loadImageFile(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                try { URL.revokeObjectURL(url); } catch (_) {}
                resolve(img);
            };
            img.onerror = () => {
                try { URL.revokeObjectURL(url); } catch (_) {}
                reject(new Error('图片格式无法解码'));
            };
            img.src = url;
        });
    }

    // 先让系统/WebView 解；HEIC 在 Android WebView 上经常直接失败，
    // 这时再懒加载 libheif(WASM) 兜底。解码结果统一缩到 1600px 预览。
    async function decodeStill(file) {
        const name = file.name || '';
        try {
            const img = await loadImageFile(file);
            return {
                el: drawDown(img, 1600),
                srcW: img.naturalWidth || img.width,
                srcH: img.naturalHeight || img.height,
                heic: false
            };
        } catch (e) {
            if (!/\.(heic|heif)$/i.test(name) || typeof window.qfHeicDecode !== 'function') throw e;
            notify('系统无法解码 HEIC，正在用内置解码器…', 12000);
            const full = await window.qfHeicDecode(file);
            const srcW = full.naturalWidth || full.width;
            const srcH = full.naturalHeight || full.height;
            const el = drawDown(full, 1600);
            try { full.width = 0; full.height = 0; } catch (_) {}
            return { el, srcW, srcH, heic: true };
        }
    }

    function pickImages() {
        return new Promise((resolve) => {
            if (!fileInput) {
                fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.multiple = true;
                fileInput.accept = 'image/*,.heic,.cr2,.nef,.arw,.dng,.raf,.orf,.rw2,.pef,.srw,.raw';
                fileInput.style.display = 'none';
                document.body.appendChild(fileInput);
            }
            fileInput.value = '';
            pickErrors = [];
            let settled = false;
            let focusTimer = 0;
            let watchdog = 0;
            const onFocus = () => {
                clearTimeout(focusTimer);
                // 用户取消选择时没有 change 事件；回到页面后若仍没有文件就当取消。
                // 有文件时 files.length > 0，不会被这里提前结束。
                focusTimer = setTimeout(() => {
                    if (!fileInput.files || !fileInput.files.length) done([]);
                }, 600);
            };
            const done = (out) => {
                if (settled) return;
                settled = true;
                clearTimeout(focusTimer);
                clearTimeout(watchdog);
                window.removeEventListener('focus', onFocus);
                fileInput.onchange = null;
                fileInput.oncancel = null;
                resolve(out);
            };
            fileInput.onchange = async () => {
                // 已经拿到文件，取消看门狗，别在解码途中把 Promise 结束掉
                clearTimeout(watchdog);
                const files = Array.from(fileInput.files || []);
                const out = [];
                for (const f of files) {
                    try {
                        if (/\.(arw|cr2|nef|dng|raf|orf|rw2|pef|srw|raw)$/i.test(f.name)) {
                            if (window.QF_RAW_READY) await window.QF_RAW_READY;
                            if (typeof window.qfRawDecode !== 'function') throw new Error('RAW 解码器尚未就绪');
                            out.push(await window.qfRawDecode(f));
                            continue;
                        }
                        const dec = await decodeStill(f);
                        out.push({
                            el: dec.el, name: f.name, w: dec.el.width, h: dec.el.height,
                            srcW: dec.srcW, srcH: dec.srcH, heic: dec.heic,
                            grade: null, file: f
                        });
                    } catch (e) {
                        // 单张失败不影响其他照片，但要留下可展示的原因
                        pickErrors.push({ name: f.name, error: String((e && e.message) || e) });
                    }
                }
                done(out);
            };
            // 新版 Chromium 支持 cancel 事件（Android WebView 可能没有，focus 兜底）
            fileInput.oncancel = () => done([]);
            // 最后一道保险：个别 WebView 既不发 cancel 也不发 focus，Promise 永不结束
            // 会把「导入」永久卡住。3 分钟后按取消处理，允许重新选图。
            watchdog = setTimeout(() => {
                if (!fileInput.files || !fileInput.files.length) done([]);
            }, 180000);
            window.addEventListener('focus', onFocus);
            fileInput.click();
        });
    }

    /* ── 保存 / 分享 ── */
    async function saveImage(dataUrl, filename) {
        const url = String(dataUrl || '');
        const base64 = url.split(',').pop() || '';
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
            const msg = String((e && e.message) || e);
            // 用户在系统分享面板点了取消：不是失败，界面应提示「已取消」
            return { ok: false, canceled: /cancel|取消|dismiss/i.test(msg), error: msg };
        }
        // 浏览器降级：直接下载
        try {
            const a = document.createElement('a');
            // dataUrl 已经带 data:image/jpeg;base64, 前缀时直接使用；
            // 旧写法又拼了一个 data:，下载出来的文件是坏图。
            a.href = url.startsWith('data:')
                ? url
                : ('data:image/png;base64,' + base64);
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
                const v = JSON.parse(r.value || '{}') || {};
                // 把原生端的值并回本地副本，否则之后 savePrefs 会拿旧副本
                // 整体覆盖，原生端后来写入的偏好会被悄悄回滚。
                Object.assign(prefs, v);
                return v;
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
        getPickErrors,
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

// 草稿自动保存:把当前会话(照片路径/模板/每图模板)写入 localStorage,崩溃后启动可恢复
window.App = Object.assign(window.App || {}, {
    _draftKey: 'qfs_draft_v1',
    _draftTimer: null,
    _draftDirty: false,
    _draftRev: 0,
    _draftSaving: false,

    initDraft() {
        if (typeof localStorage === 'undefined') return;
        this.scheduleDraft();
        window.addEventListener('pagehide', () => this.saveDraftNow());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveDraftNow(); });
        // 30 秒兜底只在有变更时写:旧写法无条件写,闲置时也反复同步落盘(leveldb flush),
        // 大图会话放久后每次写都是一次整库落盘,是"放着没动回来就卡"的贡献者之一
        setInterval(() => { if (this._draftDirty) this.saveDraftNow(); }, 30000);
        this.checkDraftRestore();
    },

    // 启动时仅提示"可恢复上次会话",不自动恢复(避免误以为出现默认图片)
    checkDraftRestore() {
        let draft = null;
        try {
            const raw = localStorage.getItem(this._draftKey);
            if (raw) draft = JSON.parse(raw);
        } catch (e) { draft = null; }
        const btn = document.getElementById('btnRestoreDraft');
        const hasRecoverable = !!(draft && Array.isArray(draft.images) && draft.images.length &&
            draft.images.some(m => m && m.path));
        if (btn) {
            const showBtn = hasRecoverable && !(this.images && this.images.length);
            btn.style.display = showBtn ? 'inline-block' : 'none';
            if (showBtn) btn.onclick = () => this.restoreDraft();
        }
    },

    scheduleDraft() {
        this._draftDirty = true;
        this._draftRev = (this._draftRev || 0) + 1;
        if (this._draftTimer) return;
        this._draftTimer = setTimeout(() => { this._draftTimer = null; this.saveDraftNow(); }, 1500);
    },

    // 剥离草稿树上超长的 data: 内嵌串(模板可携带元素图/自定义图标),返回剥离个数
    _stripDraftData(node) {
        if (!node || typeof node !== 'object') return 0;
        let n = 0;
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (typeof v === 'string') {
                if (v.length > 65536 && v.startsWith('data:')) { node[k] = ''; n++; }
            } else if (v && typeof v === 'object') {
                n += this._stripDraftData(v);
            }
        }
        return n;
    },

    saveDraftNow() {
        try {
            if (!this.images || !this.images.length) return;
            // 悬停预览时 this.template 是临时的，别把「划过的那一下」写进草稿；
            // 脏标记留着，等鼠标移开后的定时器再存。
            if (this._presetHover) return;
            // 内置示例照片没有磁盘路径,不能写进草稿:否则下次启动恢复时会被跳过,
            // 但它仍占着 currentIdx,真实照片的当前张就会错位。只存可再次加载的照片。
            const savable = [];
            let cur = 0;
            this.images.forEach((im, i) => {
                if (!im.path) return;
                if (i === this.currentIdx) cur = savable.length;
                savable.push(im);
            });
            if (!savable.length) return;
            const curIm = savable[cur] || savable[0];
            if (curIm !== savable[cur]) cur = 0;
            // 当前图可保存时,this.template 才是最新编辑状态(可能还没写回每图模板);
            // 当前图是内置示例时,退回第一张真实照片自己的模板,避免把示例模板当默认值。
            const srcTpl = (this.image && this.image.path) ? this.template : (this.getTpl(curIm) || this.template);
            const tpl = srcTpl ? JSON.parse(JSON.stringify(srcTpl)) : null;
            const imageTemplates = [];
            for (const im of savable) {
                const saved = this.getTpl(im);
                if (saved) imageTemplates.push({ path: im.path, tpl: JSON.parse(JSON.stringify(saved)) });
            }
            // 页签不属于模板，得单独记：拼图模板恢复得再完整，右侧还停在「画布」，
            // 用户也会以为拼图没回来。记下离开时的页签，恢复时照着回去。
            const activeTab = (this.dom && this.dom.tabs) ? this.dom.tabs.querySelector('.tab.active') : null;
            const draft = {
                v: 1,
                savedAt: Date.now(),
                tab: activeTab ? activeTab.dataset.tab : '',
                // 调色只存 7 个数字，重启后在新解码的底图上重放即可 —— 与裁切不同，
                // 它不需要重新编码，所以是真正无损可持久的
                images: savable.map(im => ({
                    name: im.name, path: im.path, w: im.w, h: im.h,
                    grade: (im.grade && !this.isNeutralGrade(im.grade)) ? im.grade : undefined,
                    // 几何编辑（旋转 / 裁切）记成可重放的数字日志：以前草稿只存
                    // path + 调色，恢复时从原文件重解码，裁切和旋转会静默丢失。
                    geo: (!im.raw && im.geoOps && im.geoOps.length)
                        ? JSON.parse(JSON.stringify(im.geoOps)) : undefined,
                    // RAW 只存显影参数 + 视图(几个数字),像素由主进程按参数重解,草稿不会因此变大
                    raw: (this.rawSnapshotOf ? this.rawSnapshotOf(im) : null) || undefined
                })),
                currentIdx: cur,
                template: tpl,
                imageTemplates
            };
            this._persistDraft(draft, this._draftRev || 0);
        } catch (e) { /* 忽略草稿写入错误 */ }
    },

    // 大 data: 图片交给主进程落盘,草稿只存 qfasset: 引用;主进程不可用时退回旧策略
    // (剥掉大串),至少保住路径/模板结构,不再因为 64KB/8MB 阈值整份放弃。
    async _persistDraft(draft, rev) {
        if (this._draftSaving) { this._draftDirty = true; return; }
        this._draftSaving = true;
        let raw = null;
        try {
            if (window.qingframe && typeof window.qingframe.externalizeDraft === 'function') {
                try {
                    const r = await window.qingframe.externalizeDraft(draft);
                    if (r && r.ok && r.json) raw = r.json;
                    if (r && r.stats && r.stats.dropped && this.diagLog) {
                        this.diagLog(`草稿附件有 ${r.stats.dropped} 个超过上限，已跳过`);
                    }
                } catch (e) { /* 主进程失败时走下面的回退 */ }
            }
            if (!raw) {
                const stripped = JSON.parse(JSON.stringify(draft));
                this._stripDraftData(stripped);
                raw = JSON.stringify(stripped);
            }
            if (raw.length > 8 * 1024 * 1024) {
                if (this.diagLog) this.diagLog(`草稿体积 ${(raw.length / 1048576).toFixed(1)}MB 超过上限，跳过本次保存`);
                this._draftDirty = false;
                return;
            }
            localStorage.setItem(this._draftKey, raw);
            // 保存期间又有编辑(rev 变了)时不能清 dirty,让下一轮继续写。
            if ((this._draftRev || 0) === rev) this._draftDirty = false;
        } catch (e) {
            // 配额不足时不要每 1.5 秒重试同一份超限草稿;放弃本轮,等用户下次编辑再试。
            this._draftDirty = false;
            if (this.diagLog) this.diagLog('草稿写入失败: ' + (e && e.message || e));
        } finally {
            this._draftSaving = false;
            if (this._draftDirty) this.scheduleDraft();
        }
    },

    clearDraft() {
        try { localStorage.removeItem(this._draftKey); } catch (e) { /* 忽略 */ }
        try {
            if (window.qingframe && typeof window.qingframe.clearDraftAssets === 'function') {
                window.qingframe.clearDraftAssets().catch(() => {});
            }
        } catch (e) { /* 忽略 */ }
    },

    async restoreDraft() {
        let draft = null;
        try {
            const raw = localStorage.getItem(this._draftKey);
            if (raw) draft = JSON.parse(raw);
        } catch (e) { return; }
        if (this._restoringDraft) return; // 连点保护:恢复是异步的,重复进入会并发重建 images
        if (!draft || !Array.isArray(draft.images) || !draft.images.length) return;
        if (this.images && this.images.length) return; // 已有手动会话则不覆盖
        this._restoringDraft = true;
        const restoreBtn = document.getElementById('btnRestoreDraft');
        const restoreLabel = restoreBtn ? restoreBtn.textContent : '';
        if (restoreBtn) { restoreBtn.disabled = true; restoreBtn.textContent = '恢复中…'; }
        // 进度条:1 步读附件 + N 张照片。大图会话每张都要 EXIF + 解码 + 可能的方向重绘,
        // 全程静默的话按钮点了像坏了,所以按张数给反馈。
        const metas = (draft.images || []).filter(m => m && m.path);
        const total = metas.length + 1;
        // 让出一个宏任务,让进度条有机会重绘(解码/方向重绘是同步的,不让出会跳帧)。
        // 只在窗口可见时让出:隐藏窗口下 rAF / timer 会被节流到约 1 次/秒,
        // 每张都等会把恢复拖慢几十倍(实测 3 张从 0.2s 变成 3s)。
        const yieldPaint = () => new Promise(r => {
            if (document.visibilityState && document.visibilityState !== 'visible') { r(); return; }
            setTimeout(r, 0);
        });
        try {
            this.showImportProgress(total, '正在恢复');
            this.setImportProgress(0, total, '读取草稿');
            // 草稿里的 qfasset: 引用还原成 data:,老版本草稿没有引用时原样返回
            if (window.qingframe && typeof window.qingframe.hydrateDraft === 'function') {
                try {
                    const hr = await window.qingframe.hydrateDraft(draft);
                    if (hr && hr.ok && hr.draft) draft = hr.draft;
                } catch (e) { /* 附件缺失时继续用剩余数据恢复 */ }
            }
            this.setImportProgress(1, total, null);
            await yieldPaint();
            const tplByPath = new Map();
            (draft.imageTemplates || []).forEach(entry => { if (entry && entry.path) tplByPath.set(entry.path, entry.tpl); });
            const restored = [];
            for (let i = 0; i < metas.length; i++) {
                const meta = metas[i];
                const im = await this.imageFromMeta(meta, tplByPath.get(meta.path));
                if (im) restored.push(im);
                this.setImportProgress(i + 2, total, meta.name || String(meta.path).split(/[\\/]/).pop());
                // 让出一帧:解码/方向重绘是同步的,不插空档进度条不会重绘
                await yieldPaint();
            }
            if (!restored.length) { this.finishImportProgress('没有可恢复的照片'); return; }
            this.images = restored;
            this.selectedIdx = [];
            this.batchSel = [];
            const ci = Math.min(Math.max(0, draft.currentIdx || 0), restored.length - 1);
            this.currentIdx = ci;
            this.image = restored[ci];
            // 换了一整批图片对象，旧撤销栈里的 __image 已经对不上，直接清空。
            if (typeof this._resetHistory === 'function') this._resetHistory();
            // 恢复草稿换了一批照片：退出蒙版原图预览，避免新图一直显示未调色源
            this._maskPreviewOriginal = false;
            if (this._syncMaskOrigHint) this._syncMaskOrigHint();
            const draftTpl = this.getTpl(this.image);
            this.template = draftTpl || (draft.template ? JSON.parse(JSON.stringify(draft.template)) : this.defaultTemplate());
            this.normalizeTemplate();
            // 草稿里的调色是「记录值」：imageFromMeta 只把 grade 挂回照片并作废缓存，
            // 没有烘焙。selectImage() 里有补烘，但恢复是直接给 this.image 赋值的，绕过了它
            // —— 结果面板已回显上次参数，photoSrcOf 却退回 im.el（原图），用户必须动一下
            // 滑块才看得到调色。这里补上与 selectImage 一致的收尾。
            const curIm = this.image;
            for (const im of restored) {
                const g = im && im._grade;
                if (!g || g.neutral || g.canvas || (g.low && g.lowKey)) continue;
                // bake() 按 window.App.image 取当前的 ACR 测度，逐张临时换过去。
                // 当前这张直接全分辨率；其余只出 1600px 降采样，避免 N 张全尺寸
                // 在恢复时一起吃内存，切到它们时 selectImage 会再补全。
                this.image = im;
                this.rebuildGrade(im === curIm ? 'full' : 'low');
            }
            this.image = curIm;
            // 缩略图在烘焙之前就入队了，强制重做一次，胶片条别停在原图。
            for (const im of restored) {
                if (!im || !im.grade || (im._grade && im._grade.neutral)) continue;
                im.thumb = null;
                im._thumbEl = null;
                im._tqAt = 0;
                this.queueThumb(im);
            }
            // RAW 恢复时只有 1600px 代理，切到这张图后要按老规矩自动补尺寸。
            if (curIm && curIm.raw && !curIm.raw.full && this._rawQueueFull) this._rawQueueFull(900);
            this.invalidateStyleCaches();
            this.buildThumbnails();
            this.afterImageSelect();
            // 草稿整批换了照片：左侧「我的调色」缩略图/使用中标记要按新图重算。
            if (this.onGradePresetImageChange) this.onGradePresetImageChange();
            this.refreshUI();
            // 拼图模板已经挂回照片，但页签不会跟着回来：不切回拼图，界面仍停在
            // 「画布」，看起来就像拼图没恢复。优先按草稿记下的页签；老草稿没有
            // tab 字段，但拼图是开着的，就回到拼图页签。
            const wantTab = String(draft.tab || '');
            const hasTab = !!(this.dom && this.dom.tabs
                && Array.from(this.dom.tabs.querySelectorAll('.tab[data-tab]'))
                    .some(t => t.dataset.tab === wantTab));
            const puzzleOn = !!(this.template && this.template.puzzle && this.template.puzzle.enabled);
            const backTab = hasTab ? wantTab : (puzzleOn ? 'puzzle' : '');
            if (backTab) this.switchTab(backTab);
            this.scheduleRender(true);
            const btn = document.getElementById('btnRestoreDraft');
            if (btn) btn.style.display = 'none';
            this.scheduleDraft();
            this.finishImportProgress('恢复完成');
            this.setStatus('已恢复上次会话草稿（' + restored.length + ' 张照片）');
        } catch (e) {
            this.finishImportProgress('恢复未完成');
            // 以前这里完全静默：草稿恢复半途抛异常时 A.image 停在 null，
            // 用户只看到空工作台、连「恢复失败」都不知道，测试也只报一句
            // "Cannot read properties of null"。把原因留在状态栏和控制台。
            const msg = String((e && e.message) || e || '未知错误');
            if (this.diagLog) this.diagLog('草稿恢复失败: ' + msg);
            console.error('[draft] restore failed:', e && e.stack ? e.stack : msg);
            this.setStatus('草稿恢复失败：' + msg);
        } finally {
            this._restoringDraft = false;
            const btn = document.getElementById('btnRestoreDraft');
            if (btn) { btn.disabled = false; btn.textContent = restoreLabel || '继续上次会话'; }
        }
    },

    // 按草稿元数据重新构建一张照片对象(含每图模板还原)
    async imageFromMeta(meta, savedTpl) {
        try {
            // 先 readExif:主进程会在这里把路径登记进 qflocal 白名单。
            // 顺序反了的话 <img> 会先撞 403,草稿恢复静默少图。
            let exif = {};
            if (window.qingframe && window.qingframe.readExif) {
                try { exif = (await window.qingframe.readExif(meta.path)) || {}; } catch (e) { exif = {}; }
            }
            const img = window.qfsImage();
            // 草稿里带 raw 参数 = 这张是 RAW：恢复时按同一套参数 + 视图重新显影，
            // 不存像素也不存缩略图，改过参数/裁切重开还是改过的样子。
            const rawView = meta.raw ? {
                crop: meta.raw.crop || null,
                rotate: ((Number(meta.raw.rotate) || 0) % 4 + 4) % 4
            } : null;
            const rawInfo = meta.raw
                ? {
                    // 显影档位已经并进「调色」：旧草稿里的 exposure/highlights 不再还原，
                    // 否则会出现"照片偏亮却找不到对应滑块"的僵局。视图（裁切/旋转）照旧恢复。
                    params: Object.assign({}, this.RAW_DEFAULTS),
                    crop: rawView.crop,
                    edge: this.RAW_PROXY_EDGE,
                    full: false,
                    seq: 0
                }
                : null;
            const src = rawInfo
                ? this.rawSrc(meta.path, rawInfo.params, rawInfo.edge, rawView)
                : this.photoUrl(meta.path);
            await new Promise(r => { img.onload = r; img.onerror = r; img.src = src; });
            if (!img.naturalWidth) return null;
            if (img.naturalWidth * img.naturalHeight > 200 * 1000 * 1000) {
                img.src = '';
                if (this.diagLog) this.diagLog('草稿照片像素超过 2 亿，已跳过: ' + (meta.name || meta.path));
                return null;
            }
            const oriented = await this.applyOrientation(img, exif.orientation);
            const useEl = oriented ? oriented.el : img;
            const im = {
                el: useEl,
                name: meta.name || String(meta.path).split(/[\\/]/).pop(),
                path: meta.path,
                w: oriented ? oriented.w : img.naturalWidth,
                h: oriented ? oriented.h : img.naturalHeight,
                exif,
                customSettings: null,
                raw: rawInfo,
                rotate: rawView ? rawView.rotate : 0,
                grade: meta.grade || null
            };
            // 重放几何编辑：起点是这张照片解码（含 EXIF 方向校正）后的原图，
            // 日志里全是数字，重放结果与当时逐次烘出来的位图逐像素一致。
            // orig 也一并留好，恢复后仍能继续「还原原图」和 Ctrl+Z。
            if (!rawInfo && Array.isArray(meta.geo) && meta.geo.length && window.qfsApplyGeo) {
                im.orig = { el: useEl, w: im.w, h: im.h, raw: null };
                im.geoOps = JSON.parse(JSON.stringify(meta.geo));
                const g = window.qfsApplyGeo(useEl, im.geoOps);
                im.el = g.el;
                im.w = g.w;
                im.h = g.h;
                im.rotate = g.turns;
            }
            // 有调色参数：只作废旧缓存（草稿里没有像素）。真正的重烘在 restoreDraft()
            // 里按当前张 / 其余张分别补，之后用户切图再由 selectImage 兜底。
            if (im.grade && this.invalidateGrade) this.invalidateGrade(im);
            if (savedTpl) this.setTpl(im, savedTpl);
            this.queueThumb(im);
            return im;
        } catch (e) { return null; }
    },
});
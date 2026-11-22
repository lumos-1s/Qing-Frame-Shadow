// 模板模块：模板页签 + 预设加载/预设树 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ══ 模板页签 ══ */
    refreshTemplateFields() {
        const $ = this.$;
        const t = this.template || {};
        if ($('tfTemplateName')) $('tfTemplateName').value = t.templateName || '';
        if ($('tfTemplateTag')) $('tfTemplateTag').value = t.templateTag || '';
    },

    async refreshTemplates() {
        const box = this.$('lvPresets');
        if (!box) return;
        const input = this.$('tfTemplateSearch');
        // 搜索词属于用户当前操作，保存/重命名/删除后重读列表时不能把它清空。
        if (input) this._tplQuery = input.value;
        const names = (await window.qingframe.listTemplates()) || [];
        this._savedTemplates = names;
        if (!this._tplCache) this._renderTplLoading(box);
        const cache = await Promise.all(names.map(async (n) => {
            try {
                const data = await window.qingframe.loadTemplate(n);
                if (!data) return null;
                return {
                    name: n,
                    disp: String(data.templateName || n),
                    tag: String(data.templateTag || ''),
                    tpl: data,
                };
            } catch (e) { return null; /* 跳过损坏模板 */ }
        }));
        this._tplCache = cache.filter(Boolean);
        // 读盘期间用户可能继续输入；以输入框最新值为准，避免刷新把刚敲的字覆盖掉。
        if (input) this._tplQuery = input.value;
        const keepScroll = box.scrollTop;
        this._renderTplList(box, this._filteredTplRows());
        this._syncTplSearchClear();
        box.scrollTop = keepScroll;
        this._renderTplThumbs();
    },

    _filteredTplRows() {
        const q = String(this._tplQuery || '').trim().toLowerCase();
        const src = this._tplCache || [];
        if (!q) return src.slice();
        return src.filter(r => [r.disp, r.tag, r.name].some(v => String(v || '').toLowerCase().includes(q)));
    },

    _applyTplFilter() {
        const box = this.$('lvPresets');
        if (!box) return;
        const input = this.$('tfTemplateSearch');
        this._tplQuery = input ? input.value : '';
        this._renderTplList(box, this._filteredTplRows());
        this._syncTplSearchClear();
        box.scrollTop = 0;
        this._renderTplThumbs();
    },

    _syncTplSearchClear() {
        const input = this.$('tfTemplateSearch');
        const clear = this.$('btnClearTplSearch');
        if (input && clear) clear.hidden = !input.value;
    },

    _updateTplCount(shown, total) {
        const el = this.$('tplCount');
        if (!el) return;
        const q = String(this._tplQuery || '').trim();
        if (!total) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        el.hidden = false;
        el.textContent = q ? (shown + '/' + total) : String(total);
        el.title = q ? `找到 ${shown} 个，共 ${total} 个模板` : `共 ${total} 个模板`;
    },

    _renderTplLoading(box) {
        if (!box) return;
        box.innerHTML = '<div class="tpl-empty tpl-loading"><div class="tpl-empty-title">正在读取样式…</div></div>';
    },

    _renderTplEmpty(box, has, q) {
        const wrap = document.createElement('div');
        wrap.className = 'tpl-empty';
        const icon = document.createElement('div');
        icon.className = 'tpl-empty-icon';
        icon.textContent = q ? '⌕' : '▤';
        const title = document.createElement('div');
        title.className = 'tpl-empty-title';
        title.textContent = q ? '没有匹配的样式' : (has ? '暂无已保存的样式' : '还没有保存过样式');
        const hint = document.createElement('div');
        hint.className = 'tpl-empty-hint';
        hint.textContent = q ? '换个名称或标签试试' : '调好边框后，点下方「保存」留一份';
        wrap.append(icon, title, hint);
        box.appendChild(wrap);
    },

    _renderTplList(box, rows) {
        box.innerHTML = '';
        const q = String(this._tplQuery || '').trim();
        const total = (this._tplCache || []).length;
        this._updateTplCount(rows.length, total);
        if (!rows.length) {
            this._renderTplEmpty(box, total > 0, q);
            this._thumbsPending = [];
            return;
        }
        const groups = new Map();
        rows.forEach(r => {
            const g = r.tag || '未分类';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(r);
        });
        const order = [...groups.keys()].sort((a, b) => (b === '未分类') - (a === '未分类') || a.localeCompare(b, 'zh'));
        // 首次打开时优先展开当前正在使用的模板组；之后尊重用户手动折叠状态。
        if (!this._tplGroupsReady) {
            const active = this._currentTplName();
            const first = order.find(g => groups.get(g).some(r => this._isActiveTpl(r, active))) || order[0];
            if (first) this._tplOpen.add(first);
            this._tplGroupsReady = true;
        } else if (!q && !order.some(g => this._tplOpen.has(g))) {
            // 分组被删光/改名后旧展开状态会全部失效，至少展开第一组，别让列表看起来是空的。
            this._tplOpen.add(order[0]);
        }
        const pending = [];
        order.forEach((g) => {
            const groupRows = groups.get(g).slice()
                .sort((a, b) => a.disp.localeCompare(b.disp, 'zh'));
            const open = !!q || this._tplOpen.has(g);
            const gEl = document.createElement('div');
            gEl.className = 'tpl-group' + (open ? ' open' : '');
            gEl.dataset.tplGroup = g;
            gEl._tplRows = groupRows;
            const gn = document.createElement('div');
            gn.className = 'tpl-group-name';
            gn.tabIndex = 0;
            gn.setAttribute('role', 'button');
            gn.setAttribute('aria-expanded', open ? 'true' : 'false');
            const caret = document.createElement('span');
            caret.className = 'caret'; caret.textContent = '▸';
            const label = document.createElement('span');
            label.className = 'tpl-group-label'; label.textContent = g;
            const count = document.createElement('span');
            count.className = 'tpl-group-count'; count.textContent = String(groupRows.length);
            gn.append(caret, label, count);
            gn.addEventListener('click', () => this._toggleTplGroup(gEl));
            gn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this._toggleTplGroup(gEl);
                }
            });
            gEl.appendChild(gn);
            groupRows.forEach(r => {
                gEl.appendChild(this._buildTplRow(r));
                if (open) pending.push(r);
            });
            box.appendChild(gEl);
        });
        this._thumbsPending = pending.filter(r => r.tpl && r._thumb);
    },

    _toggleTplGroup(gEl) {
        if (!gEl) return;
        const open = !gEl.classList.contains('open');
        this._setTplGroupOpen(gEl, open);
    },

    _setTplGroupOpen(gEl, open) {
        if (!gEl) return;
        gEl.classList.toggle('open', open);
        const gn = gEl.querySelector('.tpl-group-name');
        if (gn) gn.setAttribute('aria-expanded', open ? 'true' : 'false');
        const key = gEl.dataset.tplGroup;
        if (key) {
            if (open) this._tplOpen.add(key);
            else this._tplOpen.delete(key);
        }
        if (open) this._queueTplThumbs(gEl._tplRows || []);
        else {
            const rows = gEl._tplRows || [];
            this._thumbsPending = this._thumbsPending.filter(r => !rows.includes(r));
        }
        this._renderTplThumbs();
    },

    _queueTplThumbs(rows) {
        (rows || []).forEach(r => {
            if (r && r.tpl && r._thumb && !this._thumbsPending.includes(r)) this._thumbsPending.push(r);
        });
    },

    _currentTplName() {
        return (this.template && this.template.templateName) || '';
    },

    _isActiveTpl(r, active) {
        const name = active != null ? active : this._currentTplName();
        return !!(name && r && (r.disp === name || r.name === name));
    },

    _markTplRowActive(row, r) {
        if (!row) return;
        const active = this._isActiveTpl(r);
        row.classList.toggle('active', active);
        row.setAttribute('aria-current', active ? 'true' : 'false');
        if (r && r._activeTag) r._activeTag.hidden = !active;
        const hint = row.querySelector('.tpl-hint');
        if (hint) hint.hidden = active;
    },

    _markActiveTplRows() {
        const rows = this.$('lvPresets') ? this.$('lvPresets').querySelectorAll('.tpl-row') : [];
        rows.forEach(row => {
            const r = (this._tplCache || []).find(x => x.name === row.dataset.tplKey);
            if (r) this._markTplRowActive(row, r);
        });
    },

    async applySavedTemplate(r) {
        await this.loadTemplateByName(r.name);
    },

    _openTplMenu(r, btn) {
        const rect = btn.getBoundingClientRect();
        const x = Math.max(8, rect.right - 170);
        this.openCtx(x, rect.bottom + 4, [
            ['应用样式', () => { this.applySavedTemplate(r); }],
            ['重命名', () => { this.renameTemplateItem(r); }],
            ['删除', () => { this._deleteTpl(r); }],
        ]);
    },

    async _deleteTpl(r) {
        if (!confirm('确定删除样式「' + r.disp + '」？')) return;
        const res = await window.qingframe.deleteTemplate(r.name);
        if (res && res.ok === false) {
            this.setStatus('删除失败：' + (res.error || ''));
            return;
        }
        this.setStatus('已删除「' + r.disp + '」');
        await this.refreshTemplates();
    },

    _revealTpl(key) {
        const box = this.$('lvPresets');
        if (!box || !key) return false;
        const rows = [...box.querySelectorAll('.tpl-row')];
        const row = rows.find(el => el.dataset.tplKey === key) || rows.find(el => el.dataset.tplDisp === key);
        if (!row) return false;
        const gEl = row.closest('.tpl-group');
        if (gEl && !gEl.classList.contains('open')) this._setTplGroupOpen(gEl, true);
        try { row.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老环境无此 API */ }
        row.classList.add('tpl-flash');
        setTimeout(() => row.classList.remove('tpl-flash'), 900);
        return true;
    },

    _revealTplAfterChange(key) {
        if (this._revealTpl(key)) return;
        // 新名称/标签可能不满足当前搜索词，清空过滤后再定位，免得保存完看不到新模板。
        this._tplQuery = '';
        const input = this.$('tfTemplateSearch');
        if (input) input.value = '';
        this._applyTplFilter();
        this._revealTpl(key);
    },

    _buildTplRow(r) {
        const row = document.createElement('div');
        row.className = 'tpl-row';
        row.dataset.tplKey = r.name;
        row.dataset.tplDisp = r.disp;
        r._row = row;
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'tpl-main';
        main.title = '应用样式「' + r.disp + '」';
        main.setAttribute('aria-label', '应用样式「' + r.disp + '」');
        const thumb = document.createElement('img');
        thumb.className = 'tpl-thumb';
        thumb.alt = '';
        thumb.draggable = false;
        // 未渲染前给一个透明占位，避免出现破图图标。
        thumb.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
        r._thumb = thumb;
        const info = document.createElement('span');
        info.className = 'tpl-info';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tpl-name';
        nameSpan.textContent = r.disp;
        nameSpan.title = r.disp;
        const meta = document.createElement('span');
        meta.className = 'tpl-meta';
        const activeTag = document.createElement('span');
        activeTag.className = 'tpl-active-tag';
        activeTag.textContent = '使用中';
        r._activeTag = activeTag;
        const hint = document.createElement('span');
        hint.className = 'tpl-hint';
        hint.textContent = '单击应用';
        meta.append(activeTag, hint);
        info.append(nameSpan, meta);
        main.append(thumb, info);
        main.addEventListener('click', () => { this.applySavedTemplate(r); });
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'tpl-more';
        more.textContent = '⋯';
        more.title = '管理「' + r.disp + '」';
        more.setAttribute('aria-label', '管理样式「' + r.disp + '」');
        more.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._openTplMenu(r, more);
        });
        row.append(main, more);
        this._markTplRowActive(row, r);
        return row;
    },

    async renameTemplateItem(r) {
        const name = await this.promptText('重命名样式(另存为新名称并删除旧的)', r.disp);
        if (!name) return;
        // 与主进程 save/rename 的非法文件名字符处理保持一致，避免按未清洗的名字回读。
        const safe = String(name).trim().replace(/[\\:*?"<>|/]/g, '_');
        if (!safe || safe === r.name) return;
        const res = await window.qingframe.renameTemplate(r.name, safe);
        this.setStatus(res && res.ok ? '已重命名为「' + safe + '」' : '重命名失败：' + ((res && res.error) || ''));
        if (res && res.ok) {
            // 文件重命名后同步更新模板内的显示名,否则列表仍会显示旧名称。
            try {
                const data = await window.qingframe.loadTemplate(safe);
                if (data) {
                    data.templateName = safe;
                    await window.qingframe.saveTemplate(safe, data);
                    if (this.template && (this.template.templateName === r.disp || this.template.templateName === r.name)) {
                        this.template.templateName = safe;
                        this.refreshTemplateFields();
                        this.saveCurrentTemplate();
                    }
                }
            } catch (e) { /* 文件已改名,显示名更新失败不影响模板可用 */ }
            await this.refreshTemplates();
            this._revealTplAfterChange(safe);
        }
    },

    _tplQuery: '',
    _tplOpen: new Set(),
    _tplGroupsReady: false,
    _tplThumbsRendering: false,
    _thumbsPending: [],
    // 模板缩略图缓存:键 = 名称 + 内容指纹(见 _tplThumbKey),值 = dataURL。
    // 每个缩略图是一次完整引擎渲染 + 一次 toDataURL,而模板内容多数时候没变。
    _tplThumbCache: new Map(),

    _tplThumbKey(r) {
        // 模板对象每次 refreshTemplates 都是重新读盘的新对象,不能用对象身份当键;
        // 用 JSON 文本 + 长度当内容指纹,内容一改自然换键。
        let s;
        try { s = JSON.stringify(r.tpl); } catch (e) { s = 'x'; }
        return (r.name || '') + '#' + s.length + '#' + s;
    },

    // 单张缩略图渲染:临时借用主编辑器状态,渲染完立刻还原。不要跨 await 持有这份状态，
    // 否则等待期间用户应用模板/编辑参数会被还原操作覆盖。
    _renderTplThumbData(r, sample) {
        const prevCanvas = this.dom.canvas;
        const prevMax = this.displayMax;
        const prevImg = this.image;
        const prevTpl = this.template;
        // 渲染会往 app 写这一帧的几何(照片矩形 + 基准尺寸)，蒙版叠加层靠 _photoRect 定位。
        // 这里拿样例图 + 别人的模板 + displayMax=96 渲缩略图，写完必须还原，
        // 否则渲完模板列表后蒙版会按这次的矩形跑位。
        const prevPhotoRect = this._photoRect;
        const prevBaseW = this._canvasBaseW, prevBaseH = this._canvasBaseH;
        const prevScale = this._canvasScale;
        try {
            const cv = document.createElement('canvas');
            cv.width = 1; cv.height = 1;
            cv.style.position = 'absolute'; cv.style.visibility = 'hidden';
            this.dom.canvas = cv;
            this.displayMax = 96;
            this.image = { el: sample, exif: {}, w: sample.naturalWidth || 1000, h: sample.naturalHeight || 1250 };
            this.template = JSON.parse(JSON.stringify(r.tpl));
            if (r.tpl.puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false, true);
            else window.__render(this, false);
            return cv.toDataURL('image/jpeg', 0.75);
        } finally {
            this.image = prevImg;
            this.template = prevTpl;
            if (this.dom.canvas) this.dom.canvas = prevCanvas;
            if (prevMax === undefined) delete this.displayMax;
            else this.displayMax = prevMax;
            this._photoRect = prevPhotoRect;
            if (prevBaseW === undefined) delete this._canvasBaseW; else this._canvasBaseW = prevBaseW;
            if (prevBaseH === undefined) delete this._canvasBaseH; else this._canvasBaseH = prevBaseH;
            if (prevScale === undefined) delete this._canvasScale; else this._canvasScale = prevScale;
            // 临时借用主编辑器状态后，若当前图已被用户切走，以 currentIdx 为准补一帧
            if (this._reconcileCurrentImage && this._reconcileCurrentImage()) this.scheduleRender(true);
        }
    },

    async _renderTplThumbs() {
        if (!window.__render || !this._thumbsPending.length) return;
        // 面板不在前台就不渲染:每个缩略图是一次完整引擎渲染 + toDataURL(约 5~25ms),
        // 而 refreshTemplates 还会被保存/重命名/删除等路径调用。切到「模板」页签时
        // switchTab 会重新 refreshTemplates,那时再渲染;此处保留 _thumbsPending 不动。
        const panel = this.$('panel-template');
        if (panel && !panel.classList.contains('active')) return;
        if (this._tplThumbsRendering) return;
        this._tplThumbsRendering = true;
        const batch = this._thumbsPending.slice();
        this._thumbsPending = [];
        let rendered = 0;
        try {
            const sample = this._samplePhoto || (this._samplePhoto = this._makeSamplePhoto());
            for (const r of batch) {
                const thumb = r._thumb;
                if (!thumb || !r.tpl || !thumb.isConnected) continue;
                const tkey = this._tplThumbKey(r);
                const cached = this._tplThumbCache.get(tkey);
                if (cached) { thumb.src = cached; continue; }   // 内容没变,直接复用上次的图
                if (!sample.complete) await new Promise(res => { sample.onload = res; sample.onerror = res; });
                try {
                    const src = this._renderTplThumbData(r, sample);
                    thumb.src = src;
                    if (this._tplThumbCache.size > 200) this._tplThumbCache.clear();
                    this._tplThumbCache.set(tkey, src);
                } catch (_) { thumb.style.display = 'none'; }
                // 模板多时别让缩略图把主线程堵死,每 3 张让一帧给界面。
                if (++rendered % 3 === 0) await new Promise(res => setTimeout(res, 0));
            }
        } finally {
            this._tplThumbsRendering = false;
        }
        // 渲染期间可能又展开了新的分组;把新排队的缩略图接着处理。
        if (this._thumbsPending.length) setTimeout(() => this._renderTplThumbs(), 0);
    },

    _makeSamplePhoto() {
        const c = document.createElement('canvas');
        c.width = 1000; c.height = 1250;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 1000, 1250);
        grad.addColorStop(0, '#dfe9f3'); grad.addColorStop(0.5, '#c1a8e8'); grad.addColorStop(1, '#8b5cf6');
        g.fillStyle = grad; g.fillRect(0, 0, 1000, 1250);
        g.fillStyle = 'rgba(255,255,255,.5)';
        for (let i = 0; i < 16; i++) {
            g.beginPath();
            g.arc(Math.random() * 1000, Math.random() * 1250, 20 + Math.random() * 90, 0, Math.PI * 2);
            g.fill();
        }
        g.fillStyle = '#2b2f3a'; g.fillRect(0, 990, 1000, 260);
        g.strokeStyle = '#ffd166'; g.lineWidth = 6; g.strokeRect(40, 40, 920, 910);
        g.fillStyle = '#fff'; g.font = 'bold 76px "Microsoft YaHei", sans-serif'; g.textAlign = 'center';
        g.fillText('SAMPLE', 500, 620);
        const im = window.qfsImage();
        im.src = c.toDataURL('image/jpeg', 0.8);
        return im;
    },

    async saveTemplate() {
        const $ = this.$;
        const name = ($('tfTemplateName') ? $('tfTemplateName').value : '').trim();
        if (!name) { this.setStatus('请输入样式名称'); return; }
        // 从回显字段刷新模板(名称/标签)
        if (this.template) {
            this.template.templateName = name;
            this.template.templateTag = $('tfTemplateTag') ? $('tfTemplateTag').value.trim() : '';
        }
        this.syncModelFromUI();
        const r = await window.qingframe.saveTemplate(name, this.cloneTemplate());
        this.setStatus(r.ok ? `已保存模板「${name}」` : '保存失败：' + (r.error || ''));
        if (r.ok) {
            await this.refreshTemplates();
            this._revealTplAfterChange(name);
        }
    },

    async loadTemplateByName(name) {
        if (!window.qingframe.loadTemplate) return false;
        const data = await window.qingframe.loadTemplate(name);
        if (!data) { this.setStatus('加载样式失败'); return false; }
        this.onSettingCommit();
        this.template = JSON.parse(JSON.stringify(data));
        this.normalizeTemplate();
        if (typeof this._onTemplateChanged === 'function') this._onTemplateChanged();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus(`已应用样式「${data.templateName || name}」`);
        this._markActiveTplRows();
        return true;
    },

    async exportTemplate() {
        // 导出 .qfs 工程(含照片)或旧版裸模板 JSON
        if (this.images && this.images.length) return this.exportQFS();
        const name = (this.$('tfTemplateName') ? this.$('tfTemplateName').value : '').trim() || 'template';
        this.syncModelFromUI();
        const r = await window.qingframe.exportTemplate(name, this.cloneTemplate());
        this.setStatus(r.ok ? '样式已导出' : (r.canceled ? '已取消' : '导出失败'));
    },

    async importTemplate() {
        // 导入 .qfs 工程或旧版裸模板 JSON
        return this.importQFS();
    },

    // 导出「配置」:当前编辑状态(边框方案 + 右侧栏参数 + 签名/文字 + 相机参数)打包为
    // 单个轻量 JSON,不含照片 —— 用于备份 / 迁移 / 分享,微信传几 KB 就能给别人套用
    async exportConfig() {
        if (!this.template) { this.setStatus('没有可导出的配置'); return; }
        this.syncModelFromUI();
        const name = (this.$('tfTemplateName') && this.$('tfTemplateName').value.trim()) || '我的配置';
        const bundle = {
            v: 1,
            kind: 'qfs-config',
            app: 'qingframe-web',
            name,
            exportedAt: new Date().toISOString(),
            template: this.cloneTemplate()
        };
        this.setStatus('正在导出配置…');
        const r = await window.qingframe.exportTemplate(name, bundle);
        this.setStatus(r.ok ? `配置已导出为「${name}」` : (r.canceled ? '已取消导出' : '导出失败：' + (r.error || '')));
    },

    // 导入「配置」:读取上面的配置 JSON(也兼容裸模板 JSON),校验后还原到当前照片的编辑状态
    async importConfig() {
        const r = await window.qingframe.importTemplate();
        if (!r.ok) { this.setStatus(r.canceled ? '已取消' : '导入失败：' + (r.error || '')); return; }
        let data = r.data;
        if (!data || typeof data !== 'object') { this.setStatus('导入失败：文件内容无法识别'); return; }
        // 配置包:取内部 template;裸模板:直接用
        if (data.kind === 'qfs-config' && data.template && typeof data.template === 'object') data = data.template;
        if (!data || typeof data !== 'object'
            || (!(Array.isArray(data.aiLayers) && data.aiLayers.length)
                && !(Array.isArray(data.layers) && data.layers.length)
                && typeof data.photoFrameStyle !== 'string')) {
            this.setStatus('导入失败：不是有效的清框影配置/样式文件');
            return;
        }
        this.onSettingCommit();
        this.template = JSON.parse(JSON.stringify(data));
        this.normalizeTemplate();
        if (typeof this._onTemplateChanged === 'function') this._onTemplateChanged();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus(`已导入配置「${r.name}」（照片不变，边框/参数已还原）`);
    },

    /* ══ 模板分享码 ══
       把「导出配置」同一份 bundle 压成一段可复制的文本(QFSCFG1:<base64>),粘贴即可导入。
       用途:不开文件传输,聊天窗口/邮件/评论区直接发;配合仓库 Discussions 的模板分享区用。
       照片不带(与导出配置同口径);含自定义 Logo 的模板分享码会比较大(base64 图像数据),属预期。 */

    // Unicode 安全的 JSON ↔ base64(TextEncoder 中转,避免 btoa 对中文抛异常)
    _jsonToB64(json) {
        const bytes = new TextEncoder().encode(json);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    },
    _b64ToJson(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    },

    async copyShareCode() {
        if (!this.template) { this.setStatus('没有可分享的配置'); return; }
        this.syncModelFromUI();
        const name = (this.$('tfTemplateName') && this.$('tfTemplateName').value.trim()) || '我的配置';
        const bundle = {
            v: 1,
            kind: 'qfs-config',
            app: 'qingframe-web',
            name,
            exportedAt: new Date().toISOString(),
            template: this.cloneTemplate()
        };
        const code = 'QFSCFG1:' + this._jsonToB64(JSON.stringify(bundle));
        try {
            await navigator.clipboard.writeText(code);
            this.setStatus(`分享码已复制(约 ${Math.round(code.length / 1024)} KB),直接粘贴发给对方即可`);
        } catch (e) {
            this.setStatus('复制失败：' + (e && e.message || e));
        }
    },

    async importShareCode() {
        const text = await this.promptText('粘贴分享码(QFSCFG1: 开头),确认后导入', '');
        if (text == null) return; // 用户取消
        const code = String(text).replace(/\s+/g, '');
        if (!code) { this.setStatus('分享码为空'); return; }
        if (code.indexOf('QFSCFG1:') !== 0) { this.setStatus('导入失败：不是有效的分享码(应以 QFSCFG1: 开头)'); return; }
        let data;
        let shareName = '';
        try {
            data = JSON.parse(this._b64ToJson(code.slice(8)));
        } catch (e) {
            this.setStatus('导入失败：分享码内容无法识别(可能复制不完整)');
            return;
        }
        if (!data || typeof data !== 'object') { this.setStatus('导入失败：分享码内容无法识别'); return; }
        if (data.kind === 'qfs-config' && data.template && typeof data.template === 'object') { shareName = String(data.name || ''); data = data.template; }
        if (!data || typeof data !== 'object'
            || (!(Array.isArray(data.aiLayers) && data.aiLayers.length)
                && !(Array.isArray(data.layers) && data.layers.length)
                && typeof data.photoFrameStyle !== 'string')) {
            this.setStatus('导入失败：不是有效的清框影配置分享码');
            return;
        }
        this.onSettingCommit();
        this.template = JSON.parse(JSON.stringify(data));
        this.normalizeTemplate();
        if (typeof this._onTemplateChanged === 'function') this._onTemplateChanged();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus(`已从分享码导入「${(shareName || data.templateName || '未命名配置')}」（照片不变，边框/参数已还原）`);
    },

    // 注：UI 入口（侧栏「快速预设」分组的「复古胶片」按钮）已移除，函数保留备用。
    applyQuickPreset() {
        if (!this.presets.length) { this.setStatus('预设库未加载'); return; }
        const p = this.presets.find(x => /胶片/i.test(x.templateName));
        if (!p) { this.setStatus('未找到复古胶片预设'); return; }
        this.onSettingCommit();
        // 走 applyPreset 统一入口,保留用户的 logo/贴纸/自由文字(见 applyPreset 注释)。
        // undo 快照已由上面的 onSettingCommit() 压入,这里不要重复 pushUndo。
        this.applyPreset(p);
        this.setStatus(`已应用预设「${p.templateName}」`);
    },

    // 注：UI 入口（侧栏「快速预设」分组的「自动取色边框」按钮）已移除，函数保留备用。
    async autoColorBorder() {
        if (!this.image) { this.setStatus('请先导入照片'); return; }
        const color = window.EngineStyles && window.EngineStyles.extractDominant;
        if (typeof color !== 'function') { this.setStatus('自动取色不可用'); return; }
        try {
            const c = await color(this.image.el);
            this.onSettingCommit();
            const layer = this.currentLayer();
            layer.fillConfig.fillType = 'solid';
            layer.fillConfig.fillHex = c.replace('#', '');
            if (this.$('cpFillColor')) this.$('cpFillColor').value = c;
            this.refreshUI();
            this.scheduleRender(true);
            this.setStatus(`已应用自动取色边框 #${c}`);
        } catch (e) { this.setStatus('取色失败: ' + e.message); }
    },

    /* ══ 预设加载 ══ */
    async loadPresets() {
        this.splashStatus('正在加载预设…');
        try { this.presets = await window.__loadAllPresets(); }
        catch (e) { this.presets = []; }
        // 预设（含失败时的空数组）已经尘埃落定，启动状态恢复必须在这之后：
        // 早于这里的 restoreLastState 按名字找不到预设，template 也还是 null。
        this._presetsLoaded = true;
        if (typeof this.updateStatsText === 'function') this.updateStatsText();
        this.buildTree();
        this.refreshCamLibSelect();
        if (typeof this.restoreLastState === 'function') this.restoreLastState();
        // 首帧预设选择不在启动路径上执行:先把窗口/预设树渲染出来,选择推迟到
        // init() 末尾的空闲回调(见 app.js),恢复草稿/用户手动选择都不会被覆盖。
        this.splashTick();
    },

    async loadLogos() {
        try { this.logos = (await window.qingframe.listLogos()) || []; }
        catch (e) { this.logos = []; }
        try {
            const builtin = (await window.qingframe.listCustomIcons()) || [];
            builtin.forEach(c => { if (c && c.dataUrl) this.logos.push(c); });
        } catch(e) {}
        try {
            const saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
            saved.forEach(c => { if (c && c.dataUrl && !this.logos.some(l => l.dataUrl === c.dataUrl)) this.logos.push(c); });
        } catch(e) {}
        // 内置原创标记:单独放 this.marks,不进 this.logos —— 后者要参与品牌那套逻辑
        // (_brandRank 热度排序、brandLogoEntry 按文件名匹配 EXIF 品牌),标记混进去会被当成品牌。
        // 测试用的 preload-measure.js 没有 listMarks,所以先判存在性再调。
        try {
            const q = window.qingframe;
            if (q && typeof q.listMarks === 'function') {
                this.marks = ((await q.listMarks()) || []).filter(m => m && m.dataUrl);
                // 诊断信息会显示在「内置标记」标题后面 —— 空池时必须能一眼看出是哪一层的问题,
                // 否则界面只显示"缺失",排查得靠猜(这个坑已经踩过两次了)。
                this._marksDiag = this.marks.length === 0 ? '主进程返回空' : '';
            } else {
                // 测试用的 preload-measure.js 本来就没有这个方法(属正常),
                // 但正式版走到这里说明主进程/preload 是旧的(改了 main 或 preload 却没完全重启)。
                this.marks = [];
                this._marksDiag = 'preload 未提供';
                console.warn('[清框影] preload 未提供 listMarks:内置标记不可用。' +
                    '若刚改过 src/main 或 preload,请完全退出应用后重新启动(渲染进程刷新不够)。');
            }
        } catch (e) {
            this.marks = [];
            this._marksDiag = '调用失败';
            console.warn('[清框影] listMarks 调用失败(主进程可能还是旧的):', e && e.message);
        }
        this.splashTick();
        // 启动路径不立即构建 logo 池 DOM(上百个 img 赋值 src 会触发批量解码,是启动卡顿主因)。
        // 空闲时再建;用户切到「Logo」页签时 switchTab 有兜底渲染,数据(this.logos)已在上面就绪。
        const buildPools = () => { if (this.dom.stRes) this.renderLogoPools(); };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(buildPools, { timeout: 2500 });
        else setTimeout(buildPools, 1500);
    },
    saveCustomIcon(logo) {
        try {
            const saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
            saved.push(logo);
            localStorage.setItem('qfs_custom_icons', JSON.stringify(saved));
        } catch(e) {}
    },
    // 返回 { ok, error }:调用方要能告诉用户"这次没删掉",否则图标看着消失、重启又回来,
    // 用户只会以为应用有 bug。旧实现只 console.warn,失败完全不可见。
    async deleteCustomIcon(logo) {
        try {
            let saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
            saved = saved.filter(c => c.dataUrl !== logo.dataUrl);
            localStorage.setItem('qfs_custom_icons', JSON.stringify(saved));
        } catch(e) {}
        try {
            if (window.qingframe && typeof window.qingframe.deleteCustomIcon === 'function') {
                const r = await window.qingframe.deleteCustomIcon(logo.dataUrl) || {};
                if (r.ok === false) return { ok: false, error: r.error };
                return { ok: true, removed: r.removed };
            }
            return { ok: true };
        } catch(e) { return { ok: false, error: (e && e.message) || String(e) }; }
    },

    async loadTextures() {
        try { this.textures = (await window.qingframe.listTextures()) || []; }
        catch (e) { this.textures = []; }
        this.splashTick();
    },

    getFavorites() { try { return JSON.parse(localStorage.getItem("qfs_fav_presets") || "[]"); } catch(e) { return []; } },
    setFavorites(arr) { localStorage.setItem("qfs_fav_presets", JSON.stringify(arr)); },
    getRecent() { try { return JSON.parse(localStorage.getItem("qfs_recent_presets") || "[]"); } catch(e) { return []; } },
    pushRecent(name) {
        if (!name) return;
        let r = this.getRecent().filter(n => n !== name);
        r.unshift(name);
        if (r.length > 6) r = r.slice(0, 6);
        localStorage.setItem("qfs_recent_presets", JSON.stringify(r));
    },
    toggleFav(name) {
        let f = this.getFavorites();
        if (f.includes(name)) f = f.filter(n => n !== name);
        else f.push(name);
        this.setFavorites(f);
        this.buildTree(this._searchVal || "");
    },

    buildTree(filter) {
        const tree = this.dom.presetTree;
        // 行马上要被整片换掉，预览态先还原，避免临时模板留在画布上。
        if (this._presetHover) this._endPresetHover();
        tree.innerHTML = '';
        const f = (filter || '').toLowerCase();
        this._searchVal = filter || '';
        const favs = this.getFavorites();
        const recent = this.getRecent();
        // 分组大标题的显示顺序:不在这里的 tag 会被排到最末尾(99 位),所以新加预设分类时必须登记。
        // 「光影 / 水印」是优先入口,固定置顶;其余保持原有顺序。
        const DEFAULT_ORDER = ['光影', '水印', '票根', '邮票', '个性', '潮流', '高级感', '艺术', '极简', '胶片', '质感', '手作', '复古', '杂志', '氛围'];
        // 分组可拖拽排序:用户自定义顺序存 localStorage,未收录的新分类按默认顺序补尾
        let order = this._loadGroupOrder();
        if (!order || !order.length) order = DEFAULT_ORDER.slice();
        else for (const g of DEFAULT_ORDER) if (!order.includes(g)) order.push(g);
        const merge = { 创意: '潮流', 奢华: '高级感', 现代: '极简', 排版: '极简', 影院: '胶片', 星空: '氛围' };
        // 分类图标统一用一套线性 SVG：比 emoji 稳（不随系统字体变彩色/变粗），
        // 也比几何字符更容易一眼看出分类。路径都按 16×16 画。
        const GROUP_ICONS = {
            光影: ['M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M12.2 3.8l-1 1M4.8 11.2l-1 1', 'M8 5.3a2.7 2.7 0 1 0 0 5.4A2.7 2.7 0 1 0 8 5.3z'],
            水印: ['M8 2.2c2.2 2.5 3.4 4.2 3.4 6a3.4 3.4 0 0 1-6.8 0c0-1.8 1.2-3.5 3.4-6z'],
            票根: ['M2.5 5.5h11v1.8a1.4 1.4 0 0 0 0 2.8v1.8h-11v-1.8a1.4 1.4 0 0 0 0-2.8z', 'M9.8 5.5v7.2'],
            邮票: ['M3.5 3.5h9v9h-9z', 'M5.6 5.6h4.8v4.8H5.6z'],
            个性: ['M8 3.1a2.1 2.1 0 1 0 0 4.2A2.1 2.1 0 1 0 8 3.1z', 'M3.7 13c.4-2.4 2.1-3.8 4.3-3.8s3.9 1.4 4.3 3.8'],
            潮流: ['M9.1 2.2 4.4 9.1h3.1L6.9 13.8 11.6 6.9H8.5z'],
            高级感: ['M8 2.2 13.2 6 8 13.8 2.8 6z', 'M2.8 6h10.4'],
            艺术: ['M8 13.2a5.2 5.2 0 1 1 0-10.4c2.9 0 5.2 1.9 5.2 4.1 0 1.3-1 2.1-2.2 2.1h-1.1c-.8 0-1.4.6-1.4 1.3 0 .3.1.6.3.9.2.3.3.6.3.9 0 .6-.4 1.1-1.1 1.1z', 'M5.9 6.2h.01M9.6 5.5h.01M5.2 9.2h.01'],
            极简: ['M8 3a5 5 0 1 0 0 10A5 5 0 1 0 8 3z'],
            胶片: ['M3 3.5h10v9H3z', 'M5.2 3.5v9M10.8 3.5v9', 'M3 6.1h2.2M3 9.9h2.2M10.8 6.1H13M10.8 9.9H13'],
            质感: ['M8 2.5 13.5 5.5 8 8.5 2.5 5.5z', 'M2.5 8.6 8 11.6l5.5-3', 'M2.5 11.4 8 14.4l5.5-3'],
            手作: ['M4.1 3.6 11.9 12.4M11.9 3.6 4.1 12.4', 'M3 12.4a1.5 1.5 0 1 0 2.4-1.9M13 12.4a1.5 1.5 0 1 1-2.4-1.9'],
            复古: ['M8 3a5 5 0 1 0 0 10A5 5 0 1 0 8 3z', 'M8 5.2V8l2 1.4'],
            杂志: ['M3 3h10v10H3z', 'M5.2 5.2h5.6M5.2 7.6h5.6M5.2 10h3.4'],
            氛围: ['M10.8 2.8a5.3 5.3 0 1 0 2.4 8.8 4.4 4.4 0 0 1-2.4-8.8z'],
            比例: ['M5 2.5v8.5h8.5', 'M2.5 5h8.5v8.5'],
            收藏: ['M8 2.6l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8L2.5 6.6l3.8-.5z'],
            最近使用: ['M8 3a5 5 0 1 0 0 10A5 5 0 1 0 8 3z', 'M8 5.2V8l2 1.4'],
            其他: ['M3.5 3.5h9v9h-9z']
        };
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const makeGroupIcon = (key) => {
            const wrap = document.createElement('span');
            wrap.className = 'g-icon';
            // 未登记的分类也走同一套线性图标，不再回落成彩色几何字符。
            const paths = GROUP_ICONS[key] || GROUP_ICONS.其他;
            const svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', '0 0 16 16');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.4');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('aria-hidden', 'true');
            for (const d of paths) {
                const p = document.createElementNS(SVG_NS, 'path');
                p.setAttribute('d', d);
                svg.appendChild(p);
            }
            wrap.appendChild(svg);
            return wrap;
        };
        // 侧栏缩略图复用风格墙已经生成好的 90 张封面，不额外造资源；
        // 用户换过墙封面且开着自定义封面时，侧栏也跟着用同一张。
        const wallItems = (window.PRESET_WALL && Array.isArray(window.PRESET_WALL.items)) ? window.PRESET_WALL.items : [];
        const coverByName = new Map();
        for (const it of wallItems) if (it && it.name && it.cover) coverByName.set(it.name, it.cover);
        const customCoversOn = typeof this.wallCoversEnabled === 'function' && this.wallCoversEnabled();
        const coverFor = (name) => {
            const custom = customCoversOn && this._wallCovers && this._wallCovers[name];
            if (custom && typeof this.coverUrl === 'function') return this.coverUrl(custom);
            return coverByName.get(name) || '';
        };
        // 没有封面时用名字首字做铅字块：比几十个含义含糊的 emoji 更安静，
        // 也不会随系统 emoji 字体忽大忽小、忽彩忽灰。
        const iconFor = name => {
            const n = String(name || '').trim();
            return n ? n.charAt(0) : '·';
        };
        const groups = new Map();
        for (const p of this.presets) {
            if (f && !p.templateName.toLowerCase().includes(f) && !(p.templateTag || '').toLowerCase().includes(f)) continue;
            const grp = merge[p.templateTag] || p.templateTag || '其他';
            if (!groups.has(grp)) groups.set(grp, []);
            groups.get(grp).push(p);
        }
        const sorted = [...groups.keys()].sort((a, b) => {
            const ia = order.indexOf(a), ib = order.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'zh');
        });
        const curName = (this.template && this.template.templateName) || '';
        const curGrp = curName ? [...sorted].find(g => (groups.get(g) || []).some(p => p.templateName === curName)) : null;
        const defOpen = curGrp || sorted[0] || null;
        const groupState = this._loadPresetGroupState();
        const isOpen = (key, dflt) => (groupState[key] === undefined ? dflt : !!groupState[key]);
        const remember = (el, key) => { this._setPresetGroupOpen(key, el.classList.contains('open')); };
        const renderItem = (p, grp) => {
            const item = document.createElement('div');
            item.className = 'preset-item' + (p.templateName === curName ? ' active' : '');
            item.dataset.name = p.templateName;
            const thumb = document.createElement('span');
            thumb.className = 'preset-thumb';
            const cover = coverFor(p.templateName);
            if (cover) {
                const img = document.createElement('img');
                img.loading = 'lazy';
                img.decoding = 'async';
                img.alt = '';
                img.src = cover;
                thumb.appendChild(img);
            } else {
                // 没有封面（例如用户自存的模板）时回落到单色图标，保持行首对齐。
                thumb.textContent = iconFor(p.templateName);
            }
            item.appendChild(thumb);
            const label = document.createElement('span');
            label.className = 'preset-name';
            label.textContent = p.templateName;
            item.appendChild(label);
            const star = document.createElement('button');
            star.type = 'button';
            const isFav = favs.includes(p.templateName);
            star.className = 'preset-fav' + (isFav ? ' is-fav' : '');
            star.textContent = isFav ? '★' : '☆';
            star.title = isFav ? '取消收藏' : '收藏';
            star.setAttribute('aria-label', star.title);
            star.addEventListener('click', (e) => { e.stopPropagation(); this.toggleFav(p.templateName); });
            item.appendChild(star);
            item.title = '单击应用「' + p.templateName + '」；鼠标停留可在照片上预览';
            item.addEventListener('mouseenter', () => this._schedulePresetHover(p, item));
            item.addEventListener('mouseleave', () => this._schedulePresetHoverEnd());
            item.addEventListener('click', () => {
                // 预览只是临时的：先还原成已提交的模板，再走正常应用流程，
                // 否则 applyPreset 会拿预览态当「上一份模板」去合并用户内容。
                this._endPresetHover();
                this.selectPreset(p, item);
            });
            item.dataset.grp = grp;
            return item;
        };
        // 收藏分组
        if (!f || favs.some(n => n.toLowerCase().includes(f))) {
            const favPresets = favs.map(n => this.presets.find(p => p.templateName === n)).filter(Boolean);
            if (favPresets.length) {
                const gEl = document.createElement('div');
                gEl.className = 'preset-group' + ((f || isOpen('收藏', true)) ? ' open' : '');
                const nm = document.createElement('div');
                nm.className = 'group-name';
                const favCaret = document.createElement('span');
                favCaret.className = 'caret';
                favCaret.textContent = '\u25B8';
                nm.appendChild(favCaret);
                nm.appendChild(makeGroupIcon('收藏'));
                const favLabel = document.createElement('span');
                favLabel.textContent = '收藏 · ' + favPresets.length;
                nm.appendChild(favLabel);
                nm.addEventListener('click', () => { gEl.classList.toggle('open'); remember(gEl, '收藏'); });
                gEl.appendChild(nm);
                favPresets.forEach(p => gEl.appendChild(renderItem(p, '收藏')));
                tree.appendChild(gEl);
            }
        }
        // 最近使用分组
        if (!f) {
            // 「最近使用」里的条目和下面各分类里的同名项是重复的，全展开等于
            // 同一批名字看两遍。默认收起，展开了也只留最近 4 个。
            const recPresets = recent.map(n => this.presets.find(p => p.templateName === n))
                .filter(Boolean).slice(0, 4);
            if (recPresets.length) {
                const gEl = document.createElement('div');
                gEl.className = 'preset-group' + (isOpen('最近使用', false) ? ' open' : '');
                const nm = document.createElement('div');
                nm.className = 'group-name';
                nm.title = '只显示最近 4 个 · 点击展开/收起';
                const recCaret = document.createElement('span');
                recCaret.className = 'caret';
                recCaret.textContent = '\u25B8';
                nm.appendChild(recCaret);
                nm.appendChild(makeGroupIcon('最近使用'));
                const recLabel = document.createElement('span');
                recLabel.textContent = '最近使用 · ' + recPresets.length;
                nm.appendChild(recLabel);
                nm.addEventListener('click', () => { gEl.classList.toggle('open'); remember(gEl, '最近使用'); });
                gEl.appendChild(nm);
                recPresets.forEach(p => gEl.appendChild(renderItem(p, '最近使用')));
                tree.appendChild(gEl);
            }
        }
        for (const grp of sorted) {
            const groupEl = document.createElement('div');
            groupEl.className = 'preset-group' + ((f || isOpen(grp, grp === defOpen)) ? ' open' : '');
            const name = document.createElement('div');
            name.className = 'group-name';
            name.title = '点击展开/收起 · 拖动排序';
            name.draggable = true;
            const caret = document.createElement('span');
            caret.className = 'caret';
            caret.textContent = '\u25B8';
            name.appendChild(caret);
            const gic = makeGroupIcon(grp);
            name.appendChild(gic);
            const tag = document.createElement('span');
            tag.textContent = `${grp} · ${groups.get(grp).length}`;
            name.appendChild(tag);
            name.addEventListener('click', () => {
                groupEl.classList.toggle('open');
                remember(groupEl, grp);
            });
            /* 拖拽排序:拖动本组标题到其他组标题上/下,重排分类顺序 */
            name.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', grp);
                e.dataTransfer.effectAllowed = 'move';
                name.classList.add('dragging');
            });
            name.addEventListener('dragover', (e) => {
                if (!e.dataTransfer.types || !e.dataTransfer.types.includes('text/plain')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const r = name.getBoundingClientRect();
                const before = e.clientY < r.top + r.height / 2;
                name.classList.toggle('drop-before', before);
                name.classList.toggle('drop-after', !before);
            });
            name.addEventListener('dragleave', () => name.classList.remove('drop-before', 'drop-after'));
            name.addEventListener('drop', (e) => {
                e.preventDefault();
                name.classList.remove('drop-before', 'drop-after');
                const src = e.dataTransfer.getData('text/plain');
                if (!src || src === grp) return;
                const r = name.getBoundingClientRect();
                this.reorderGroups(src, grp, e.clientY < r.top + r.height / 2);
            });
            name.addEventListener('dragend', () => {
                document.querySelectorAll('.group-name.dragging, .group-name.drop-before, .group-name.drop-after')
                    .forEach(el => el.classList.remove('dragging', 'drop-before', 'drop-after'));
            });
            groupEl.appendChild(name);
            tree.appendChild(groupEl);
            for (const p of groups.get(grp)) groupEl.appendChild(renderItem(p, grp));
        }
        // 搜索无结果时给一句明确的话，别只留一片空白
        if (!tree.querySelector('.preset-item')) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '没有匹配的预设';
            tree.appendChild(empty);
        }
    },
    filterTree(v) { this.buildTree(v); },

    // 会走默认图层管线（因此「边框参数」真正生效）的预设：
    // 没有 photoFrameStyle，也不是 bgBlurEnable 的卡片 / 模糊底。
    // 与 app.js 的 applyModeControls 判定保持同一口径，供空态说明里的数量使用。
    isEditablePreset(p) {
        if (!p) return false;
        const pf = String(p.photoFrameStyle || '').toUpperCase();
        const frame = !!(pf && pf !== 'NONE');
        const card = !frame && (((p.baseMargin || {}).bgBlurEnable) || 0) === 1;
        return !frame && !card;
    },

    /* ══ 分组展开状态 ══
       原来只存分组顺序、不存展开态：每次 buildTree 都把「最近使用」和当前组一起
       重新展开，左侧一屏塞 20+ 行。现在默认只展开当前选中项所在组，其余收起，
       用户手动点过哪一组就记住哪一组。搜索时强制展开命中组，否则等于把结果藏了。 */
    _loadPresetGroupState() {
        try { const v = localStorage.getItem('qfs_preset_groups'); return v ? (JSON.parse(v) || {}) : {}; }
        catch { return {}; }
    },
    _setPresetGroupOpen(key, open) {
        const st = this._loadPresetGroupState();
        st[key] = !!open;
        try { localStorage.setItem('qfs_preset_groups', JSON.stringify(st)); } catch {}
    },

    /* ══ 分组拖拽排序 ══ */
    _loadGroupOrder() {
        try { const v = localStorage.getItem('qfs_group_order'); return v ? JSON.parse(v) : null; }
        catch { return null; }
    },
    _saveGroupOrder(arr) {
        try { localStorage.setItem('qfs_group_order', JSON.stringify(arr)); } catch {}
    },
    reorderGroups(srcGrp, tgtGrp, before) {
        let order = this._loadGroupOrder();
        if (!order || !order.length) order = ['光影', '水印', '票根', '邮票', '个性', '潮流', '高级感', '艺术', '极简', '胶片', '质感', '手作', '复古', '杂志', '氛围'];
        for (const g of ['光影', '水印', '票根', '邮票', '个性', '潮流', '高级感', '艺术', '极简', '胶片', '质感', '手作', '复古', '杂志', '氛围']) if (!order.includes(g)) order.push(g);
        const si = order.indexOf(srcGrp);
        if (si < 0) return;
        order.splice(si, 1);
        const ti = order.indexOf(tgtGrp);
        if (ti < 0) { order.push(srcGrp); }
        else order.splice(before ? ti : ti + 1, 0, srcGrp);
        this._saveGroupOrder(order);
        this.buildTree(this._searchVal || '');
    },

    // 墙 / 侧栏 / 导入 共用的「把风格套到当前状态」入口。
    // 有照片：走 selectPreset（撤销栈 + 保留用户 logo/贴纸 + 侧栏高亮 + 重建树）；
    // 没照片：记成 pendingPreset 并铺到空画布上，导入时由 importPicked 复制给每张新图。
    // 之前墙和侧栏各写一套分支，才会出现「墙选了、导入没了」这种不一致。
    applyPresetToCurrent(preset) {
        if (!preset) return false;
        if (this.images && this.images.length) {
            this.selectPreset(preset);
            return true;
        }
        this.pendingPreset = JSON.parse(JSON.stringify(preset));
        this.template = JSON.parse(JSON.stringify(preset));
        if (typeof this._onTemplateChanged === 'function') this._onTemplateChanged();
        // 没照片时也要把「背景模糊默认」记忆铺到空画布和待导入模板上。
        if (typeof this.applyBgBlurDefault === 'function') {
            this.applyBgBlurDefault(this.pendingPreset);
            this.applyBgBlurDefault(this.template);
        }
        if (typeof this.normalizeTemplate === 'function') this.normalizeTemplate();
        if (typeof this.pushRecent === 'function') this.pushRecent(preset.templateName);
        this.buildTree(this._searchVal || '');
        if (typeof this.refreshUI === 'function') this.refreshUI();
        if (typeof this.updateEmptyState === 'function') this.updateEmptyState();
        if (typeof this.scheduleRender === 'function') this.scheduleRender(true);
        return true;
    },

    selectPreset(p, itemEl) {
        this.pushUndo();
        this.applyPreset(p);
        this.pushRecent(p.templateName);
        document.querySelectorAll('.preset-item').forEach(el => el.classList.remove('active'));
        if (itemEl) itemEl.classList.add('active');
        this.buildTree(this._searchVal || '');
    },

    // 应用预设 = 换「边框方案」,不是换整张图。
    //
    // 旧实现直接 this.template = p,把用户已经加的 logo / 贴纸 / 文字一起丢掉。
    // 实测:先加 logo 再点任意预设,template.logoElements 变空 —— 画布上还留着上一帧的
    // 渲染残影,所以看起来「logo 还在」,但数据已不存在,于是点不中、拖不动、不能放缩。
    //
    // 统计全部 78 个预设:logoElements 字段虽然存在(45 个),但**全部为空数组**,
    // 从不携带 logo;stickers 也恒为 0。唯一例外是 textLines(27 个预设有),
    // 那是预设自带的排版文字(align 为 top/bottom/center 锚点对齐),属于边框方案本身,
    // 应当跟随预设替换。
    //
    // 区分用户文字与预设文字的依据:用户手动加的自由文字 align='free' 且带真实 x/y
    // (app-export.js 导出缩放时也按这个约定区分),预设文字一律是锚点对齐。
    // 因此只保留 align==='free' 的行,预设自带的排版照常跟随预设更新。
    mergePreset(prevTpl, p) {
        const prev = prevTpl || {};
        const next = JSON.parse(JSON.stringify(p));

        // 拼图是独立工作流：换边框预设不应把正在编辑的拼图清掉。
        // 内置预设 JSON 都不带 puzzle 字段，旧逻辑会被 coerceTemplate 补成默认单图。
        if (prev.puzzle && prev.puzzle.enabled && (!next.puzzle || !next.puzzle.enabled)) {
            next.puzzle = JSON.parse(JSON.stringify(prev.puzzle));
        }

        // 全局「背景模糊默认」偏好：显式记忆过时覆盖预设自带值；
        // 未设置(null)时保持预设原样，旧行为和视觉基线都不变。
        if (typeof this.applyBgBlurDefault === 'function') this.applyBgBlurDefault(next);

        // 用户内容:logo(品牌/自定义图标)与贴纸
        if (Array.isArray(prev.logoElements) && prev.logoElements.length) next.logoElements = JSON.parse(JSON.stringify(prev.logoElements));
        const prevStk = (prev.decorConfig && prev.decorConfig.stickers) || [];
        const prevTxt = (prev.decorConfig && prev.decorConfig.textLines) || [];
        const userFreeTxt = prevTxt.filter(t => t && t.align === 'free');
        const userStk = prevStk.length ? JSON.parse(JSON.stringify(prevStk)) : [];
        const userFree = userFreeTxt.length ? JSON.parse(JSON.stringify(userFreeTxt)) : [];

        // 预设自带的锚点排版文字要保留(它是边框方案的一部分),
        // 但若用户在同一处加过自由文字,则以用户的为准,避免两套文字叠在一起。
        const presetTxt = ((next.decorConfig && next.decorConfig.textLines) || []).filter(t => t && t.align !== 'free');
        const mergedTxt = presetTxt.concat(userFree);
        next.decorConfig = Object.assign({}, next.decorConfig || {}, {});
        if (mergedTxt.length || userStk.length) {
            if (mergedTxt.length) next.decorConfig.textLines = mergedTxt;
            else delete next.decorConfig.textLines;
            if (userStk.length) next.decorConfig.stickers = userStk;
            else delete next.decorConfig.stickers;
        }

        // 签名相关:预设完全没写这个键 = 沿用用户自己的(8 个签名/头像预设就是靠这条
        // 之外的「预设自带值」跑的)。预设显式写出来 = 预设说了算,哪怕写的是空串——
        // 票根/电影票四款用 userSignature:"" + avatarShow:0 表达「本预设默认不带签名/头像」,
        // 此时不能被上一份模板的签名盖回去。0 / '#fff' / 0.85 这些显式值本来就会保留。
        for (const k of ['userSignature', 'signFont', 'signColor', 'avatarScale', 'signSize', 'signIncludeModel', 'avatarShow', 'creditMode']) {
            if (prev[k] === undefined) continue;
            if (next[k] === undefined || next[k] === null) next[k] = prev[k];
        }

        // 签名默认值:票券风格的显式空签名是设计的一部分,保持空白;其余风格里
        // 预设的空串只是「没有自带签名」,用户已输入的内容优先,用户也没输入时
        // 统一落到「清框影」。
        if (!this.signatureDefaultOff(next)) {
            if (!next.userSignature && prev.userSignature) next.userSignature = prev.userSignature;
            this.fillDefaultSignature(next);
        }
        return next;
    },

    applyPreset(p) {
        const next = this.mergePreset(this.template, p);
        this.template = next;
        this.normalizeTemplate();
        if (typeof this._onTemplateChanged === 'function') this._onTemplateChanged();
        this.saveCurrentTemplate();
        this.refreshUI();
        // 换模板必须重新适配;苹果信息卡的"只变高不 fit"豁免不能把换模板也吃掉
        this._forceFitNext = true;
        this.scheduleRender(true);
    },

    /* ══ 悬停预览：鼠标停一下就套上边框，移开还原，点击才真正应用 ══
       不写模板文件、不进「最近使用」、不压撤销栈，也不刷新右侧参数面板——
       预览期间 this.template 是临时的，参数面板仍显示已提交的值。
       停留 160ms 才开渲染：扫列表时不会一路闪帧。 */
    _schedulePresetHover(p, item) {
        if (!p || !this.image) return;
        // 先撤掉待执行的「还原」：在同一行里移出又移回时，别让 120ms 前的定时器把预览关掉。
        this._clearPresetHoverTimer();
        if (this._presetHover && this._presetHover.name === p.templateName) return;
        this._presetHoverTimer = setTimeout(() => this._previewPresetOnPhoto(p, item), 160);
    },

    _clearPresetHoverTimer() {
        if (this._presetHoverTimer) { clearTimeout(this._presetHoverTimer); this._presetHoverTimer = 0; }
        if (this._presetHoverLeave) { clearTimeout(this._presetHoverLeave); this._presetHoverLeave = 0; }
    },

    _previewPresetOnPhoto(p, item) {
        this._presetHoverTimer = 0;
        if (!this.image || !p) return;
        if (this._presetHover && this._presetHover.name === p.templateName) return;
        // 快照只取一次：从已提交的模板起算，连续划过多个预设不会层层叠加。
        if (!this._presetHover) {
            this._presetHover = { snapshot: JSON.parse(JSON.stringify(this.template || {})), name: '', item: null };
        }
        const st = this._presetHover;
        if (st.item) st.item.classList.remove('previewing');
        st.name = p.templateName;
        st.item = item || null;
        if (item) item.classList.add('previewing');
        this.template = this.mergePreset(st.snapshot, p);
        this.normalizeTemplate();
        // 不设 _forceFitNext：画布尺寸真变了引擎自己会 fit；没变就别让画面跳。
        this.scheduleRender(true);
    },

    // 移开鼠标：先等 120ms 再还原，这样从一行划到下一行时不会先闪回原图。
    _schedulePresetHoverEnd() {
        this._clearPresetHoverTimer();
        if (!this._presetHover) return;
        this._presetHoverLeave = setTimeout(() => this._endPresetHover(), 120);
    },

    _endPresetHover() {
        this._clearPresetHoverTimer();
        const st = this._presetHover;
        if (!st) return;
        this._presetHover = null;
        if (st.item) st.item.classList.remove('previewing');
        this.template = st.snapshot;
        this.scheduleRender(true);
    },

    resetParams() {
        if (!this.template) return;
        this.pushUndo();
        // 重置后本图不再视为“已用预设”:清掉单一存取口的两处存储,
        // 否则切走再切回/导出时仍会取到重置前的旧边框
        if (this.image) this.clearTpl(this.image);
        this.template = this.defaultTemplate();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus('参数已重置');
    },

    randomBorder() {
        if (!this.presets.length) return;
        this.pushUndo();
        let p = this.presets[Math.floor(Math.random() * this.presets.length)];
        // 同样保留用户的 logo/贴纸/自由文字,理由见 applyPreset 注释
        this.applyPreset(p);
        this.setStatus(`已应用随机边框：${p.templateName}`);
    },

});

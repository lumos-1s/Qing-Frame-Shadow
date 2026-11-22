// 调色预设「我的调色」：保存 / 复用 / 批量导入当前照片的全局调色。
//
// 设计取舍
// ─────────────────────────────────────────────────────────────
// 1) 只存全局参数（GRADE_FIELDS + 曲线 / 校准 / 细节 / 混色器 / 颜色分级 /
//    黑白 / 色彩平衡 / 渐变映射 / 镜头校正），不存蒙版。蒙版是跟着具体画面
//    画的选区，换一张照片套用只会得到"错位的局部调整"。
// 2) 存储走主进程 userData/grade-presets/*.xmp。预设就是 Lightroom / Camera
//    Raw 能直接读的 XMP（内容是 XML），所以目录里的文件可以直接分享给别人，
//    也可以从 LR 批量导入。旧版 .json 会在读取时自动迁移成 .xmp。
// 3) 「我的调色」放在左侧素材栏，和「边框」双模式切换；右侧只留调色滑块，
//    照片完整可见。悬停预览、单击应用，最接近 Lightroom 的操作方式。
// 4) 列表只显示预设名，不放缩略图：左侧栏窄，文字列表更快扫读，也省掉每张
//    预设都跑一遍调色管线的开销。悬停预览只烘一张低分辨率图，不写 undo。
window.App = Object.assign(window.App || {}, {
    _gradePresets: [],
    _gradePresetRows: [],
    _gradeGroupHeads: [],
    _gradeGroupOpenMap: null,
    _gradePresetQuery: '',
    _gradePresetActiveTimer: 0,
    _gradePresetRevealTimer: 0,
    _gradePresetLoadSeq: 0,
    _gradePresetLoaded: false,
    _gradeHoverTimer: 0,
    _gradeHover: null,
    _sideMode: 'border',

    initGradePresets() {
        const $ = (id) => document.getElementById(id);
        const save = $('btnGradePresetSave');
        if (save) save.addEventListener('click', () => this.saveGradePresetFromCurrent());
        const imp = $('btnGradePresetImport');
        if (imp) imp.addEventListener('click', () => this.importGradePresets());
        const refresh = $('btnGradePresetRefresh');
        if (refresh) {
            refresh.addEventListener('click', (e) => {
                e.stopPropagation();
                this.refreshGradePresets({ announce: true });
            });
        }
        const openDir = $('btnGradePresetOpenDir');
        if (openDir) {
            openDir.addEventListener('click', async () => {
                const api = window.qingframe;
                if (!api || typeof api.openGradePresetsDir !== 'function') {
                    this.setStatus('当前环境不支持打开预设文件夹');
                    return;
                }
                try {
                    const r = await api.openGradePresetsDir();
                    if (r && r.ok === false) this.setStatus('打开文件夹失败：' + (r.message || '未知错误'));
                } catch (e) {
                    this.setStatus('打开文件夹失败：' + ((e && e.message) || e));
                }
            });
        }
        const search = $('tfGradePresetSearch');
        const clear = $('btnClearGradePresetSearch');
        if (search) {
            search.addEventListener('input', () => {
                this._gradePresetQuery = search.value;
                this._renderGradePresetList();
            });
            search.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape' || !search.value) return;
                search.value = '';
                this._gradePresetQuery = '';
                this._renderGradePresetList();
            });
        }
        if (clear) {
            clear.addEventListener('click', () => {
                if (search) search.value = '';
                this._gradePresetQuery = '';
                this._renderGradePresetList();
            });
        }

        // 左侧「边框 / 我的调色」双模式
        const tabs = [$('sideTabBorder'), $('sideTabGrade')];
        for (const tab of tabs) {
            if (!tab) continue;
            tab.addEventListener('click', () => this.setSideMode(tab.dataset.sideMode));
        }
        let savedMode = '';
        try { savedMode = localStorage.getItem('qfs_side_mode') || ''; } catch (_) { /* 隐私模式 */ }
        this.setSideMode(savedMode === 'grade' ? 'grade' : 'border', { activateTab: false });
        // 边框模式不预读调色库：真正切到「我的调色」时 setSideMode 才发起读取，
        // 不给启动首帧和不用预设的用户增加一次磁盘扫描。

        // 用户手动改任何一个调色控件后，"使用中"标记会过时；停手后再比对一次。
        const panel = $('panel-grade');
        if (panel) {
            const onEdit = () => {
                if (this._scheduleGradePresetActive) this._scheduleGradePresetActive();
            };
            panel.addEventListener('input', onEdit);
            panel.addEventListener('change', onEdit);
        }
        // 悬停预览时窗口失焦/切到后台，指针不会再触发 mouseleave，主动还原。
        window.addEventListener('blur', () => this._endGradePresetHover(true));
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this._endGradePresetHover(true);
        });
    },

    /* ══ 左侧双模式 ══ */

    setSideMode(mode, opts) {
        const m = (mode === 'grade' || mode === 'photo') ? mode : 'border';
        if (this._sideMode !== m) this._endGradePresetHover(true);
        this._sideMode = m;
        const aside = this.$('sidebar');
        if (aside) {
            aside.classList.toggle('mode-grade', m === 'grade');
            aside.classList.toggle('mode-border', m === 'border');
            aside.classList.toggle('mode-photo', m === 'photo');
        }
        const borderBody = this.$('sideBorderBody');
        const gradeBody = this.$('sideGradeBody');
        const photoBody = this.$('sidePhotoBody');
        if (borderBody) borderBody.hidden = m !== 'border';
        if (gradeBody) gradeBody.hidden = m !== 'grade';
        if (photoBody) photoBody.hidden = m !== 'photo';
        for (const [id, key] of [['sideTabBorder', 'border'], ['sideTabGrade', 'grade'], ['sideTabPhoto', 'photo']]) {
            const tab = this.$(id);
            if (!tab) continue;
            const on = key === m;
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        // 照片库是拼图页签的临时模式，不写进偏好，重启后仍是用户上次选的边框/调色。
        if (m !== 'photo') {
            try { localStorage.setItem('qfs_side_mode', m); } catch (_) { /* 隐私模式 */ }
        }
        if (m === 'photo') {
            if (this.renderPhotoLibrary) this.renderPhotoLibrary();
            return;
        }
        if (m === 'grade') {
            if (!this._gradePresetLoaded) this.refreshGradePresets();
            else this._renderGradePresetList();
            if (opts && opts.activateTab === false) return;
            // 从左侧点进「我的调色」时，右侧顺手切到调色页，滑块和预设同屏。
            if (this.switchTab) {
                const active = document.querySelector('#inspTabs .tab.active');
                if (!active || active.dataset.tab !== 'grade') this.switchTab('grade');
            }
        }
    },

    /* ══ 读取与列表 ══ */

    _gradePresetApi() {
        const api = window.qingframe;
        return (api && typeof api.listGradePresets === 'function') ? api : null;
    },

    async refreshGradePresets(opts) {
        const box = this.$('lvGradePresets');
        if (!box) return;
        const input = this.$('tfGradePresetSearch');
        if (input) this._gradePresetQuery = input.value;
        const api = this._gradePresetApi();
        if (!api) {
            this._gradePresets = [];
            this._gradePresetLoaded = true;
            this._renderGradePresetList();
            return;
        }
        const token = ++this._gradePresetLoadSeq;
        if (!this._gradePresets.length) {
            box.innerHTML = '<div class="tpl-empty tpl-loading"><div class="tpl-empty-title">正在读取调色预设…</div></div>';
        }
        let entries = [];
        try { entries = (await api.listGradePresets()) || []; } catch (_) { entries = []; }
        entries = entries.map((e) => (typeof e === 'string'
            ? { name: e, ext: 'json' }
            : { name: String((e && e.name) || ''), ext: (e && e.ext) === 'json' ? 'json' : 'xmp' }))
            .filter((e) => e.name);
        const rows = await Promise.all(entries.map(async (entry) => {
            try {
                const data = await api.loadGradePreset(entry.name, entry.ext);
                let grade = this._gradeFromLoad(entry, data);
                if (!grade) return null;
                // 旧版 .json 只有本应用能读；顺手迁移成 LR 也能打开的 .xmp。
                if (entry.ext === 'json') {
                    const xml = this._gradeToXmp(grade, entry.name);
                    if (xml) {
                        try {
                            const saved = await api.saveGradePreset(entry.name, xml);
                            if (saved && saved.ok !== false) {
                                await api.deleteGradePreset(entry.name, 'json');
                                entry.ext = 'xmp';
                            }
                        } catch (_) { /* 迁移失败就继续用旧文件 */ }
                    }
                }
                return { name: entry.name, ext: entry.ext, disp: entry.name, grade };
            } catch (_) { return null; }
        }));
        if (token !== this._gradePresetLoadSeq) return; // 更新的刷新已接管
        this._gradePresets = rows.filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        // 参数指纹一次算好：列表每行都要和当前照片比"是否使用中"，
        // 上千个预设时逐行 normalize + stringify 会拖慢拖滑块（250ms 防抖一次）。
        for (const r of this._gradePresets) r._hash = this._gradeHashOf(r.grade);
        this._gradePresetLoaded = true;
        this._renderGradePresetList();
        if (opts && opts.announce) {
            const n = this._gradePresets.length;
            this.setStatus(n ? `已刷新，共 ${n} 个调色预设` : '还没有调色预设');
        }
    },

    _gradeFromLoad(entry, data) {
        if (!data) return null;
        let grade = null;
        if (data.kind === 'xmp' || typeof data.xml === 'string') {
            if (!window.AppXmp || typeof window.AppXmp.mapXmp !== 'function') return null;
            const mapped = window.AppXmp.mapXmp(data.xml);
            if (!mapped || !mapped.hasAdjust || !mapped.patch || typeof mapped.patch !== 'object') return null;
            grade = mapped.patch;
        } else {
            const raw = data.kind === 'json' ? data.data : data;
            grade = raw && raw.grade;
        }
        if (!grade || typeof grade !== 'object') return null;
        const g = this.normalizeGrade(grade);
        g.masks = [];
        return g;
    },

    _gradeToXmp(grade, name) {
        if (!window.AppXmp || typeof window.AppXmp.gradeToXmp !== 'function') {
            this.setStatus('XMP 模块未加载，无法写入预设文件');
            return '';
        }
        try {
            const g = this.normalizeGrade(grade);
            g.masks = [];
            return window.AppXmp.gradeToXmp(g, name);
        } catch (e) {
            this.setStatus('生成 XMP 失败：' + ((e && e.message) || e));
            return '';
        }
    },

    _parseXmpGrade(xml) {
        if (!xml || !window.AppXmp || typeof window.AppXmp.mapXmp !== 'function') return null;
        try {
            const mapped = window.AppXmp.mapXmp(xml);
            if (!mapped || !mapped.hasAdjust || !mapped.patch || typeof mapped.patch !== 'object') return null;
            const g = this.normalizeGrade(mapped.patch);
            g.masks = [];
            return g;
        } catch (_) {
            return null;
        }
    },

    _safePresetName(name) {
        return String(name == null ? '' : name).trim()
            .replace(/[\\:*?"<>|/]/g, '_')
            .replace(/[. ]+$/g, '')
            .slice(0, 120) || '未命名调色';
    },

    _uniquePresetName(base, taken) {
        let name = base;
        let n = 2;
        while (taken.has(name)) {
            name = base + ' (' + n + ')';
            n++;
        }
        return name;
    },

    _syncGradePresetSearchClear() {
        const input = this.$('tfGradePresetSearch');
        const clear = this.$('btnClearGradePresetSearch');
        if (input && clear) clear.hidden = !input.value;
    },

    _updateGradePresetCount(shown, total) {
        const el = this.$('gradePresetCount');
        if (!el) return;
        if (!total) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        const q = String(this._gradePresetQuery || '').trim();
        el.hidden = false;
        el.textContent = q ? (shown + '/' + total) : String(total);
        el.title = q ? `找到 ${shown} 个，共 ${total} 个调色预设` : `共 ${total} 个调色预设`;
    },

    /* ══ 按命名自动分组（模仿 Lightroom 的「组 → 预设」两级） ══ */

    // 成员数 ≥2 才收成一组。只有 1 个的直接平铺，不制造只有一个成员的组头。
    _GRADE_GROUP_MIN: 2,
    // 库很小的时候全部展开：新用户不该为了看一眼预设多点一次。
    _GRADE_GROUP_AUTO_OPEN_MAX: 24,
    // 「未分组」的伪组名，用不可见字符避免和真实预设名撞车。
    _GRADE_GROUP_LOOSE: '\u0000loose',

    // 从文件名推断组名。LR 的组来自文件夹，我们只有一个扁平目录，只能看命名：
    //   001-滨田英明调色 [霜绝预设] → 滨田英明调色 [霜绝预设]（预设包导出常带序号）
    //   黑白预设 (12)              → 黑白预设            （同名导入时自动加的重复号）
    //   人像 - 白皙                 → 人像                （空格分隔的「组 - 名」）
    // 只影响列表怎么归堆；文件名本身不改，分享给 LR 时还是原名。
    _gradeGroupKeyOf(name) {
        const raw = String(name == null ? '' : name);
        let s = raw.replace(/^\s*\d{1,3}[-_.、．:：](?!\d)\s*/, '');
        s = s.replace(/\s*[（(]\s*\d{1,4}\s*[)）]\s*$/, '');
        const m = s.match(/^(.{1,24}?)\s+[-—–|｜/]\s+\S/);
        if (m) s = m[1];
        return s.trim() || raw.trim();
    },

    // 组内那行显示什么：组名已经在组头，行内只留能区分的部分（`白皙`）。
    // 但绝大多数预设名只是「编号 + 包名」，去掉包名后只剩一个光数字（`#001` / `(55)`），
    // 读不出是什么，于是把编号放前面、包名带回来：`#001 滨田英明调色`、`(55) 黑白预设`。
    _gradePresetVarLabel(r, key) {
        const name = String((r && r.name) || '');
        const seq = name.match(/^\s*(\d{1,3})[-_.、．:：](?!\d)\s*/);
        const dup = name.match(/\s*[（(]\s*(\d{1,4})\s*[)）]\s*$/);
        const noSeq = name.replace(/^\s*\d{1,3}[-_.、．:：](?!\d)\s*/, '');
        // `人像 - 白皙` 的剩余是 `- 白皙`，把分隔符也吃掉，只留名字。
        const rest = noSeq.indexOf(key) === 0
            ? noSeq.slice(key.length).replace(/^[\s\-—–|｜/:：]+/, '').trim()
            : '';
        const isNum = (s) => /^[（(]?\s*\d{1,4}\s*[)）]?$/.test(String(s).trim());
        if (rest && !isNum(rest)) return rest;          // 有真名字就用它
        const num = seq ? '#' + seq[1] : (dup ? '(' + dup[1] + ')' : '');
        // 组头已经带着 `[霜绝预设]` 这类厂牌尾注，行内不再重复，留出宽度给名字。
        const bare = key.replace(/\s*[\[【][^\]】]*[\]】]\s*$/, '').trim() || key;
        return (num ? num + ' ' : '') + bare;
    },

    _gradeHashOf(grade) {
        try {
            const g = this.normalizeGrade(grade);
            g.masks = [];
            return JSON.stringify(g);
        } catch (_) {
            return '';
        }
    },

    _gradePresetTree(rows) {
        const map = new Map();
        for (const r of rows) {
            const key = this._gradeGroupKeyOf(r.name);
            let g = map.get(key);
            if (!g) { g = { key, list: [] }; map.set(key, g); }
            g.list.push(r);
        }
        const groups = [];
        const loose = [];
        for (const g of map.values()) {
            g.list.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
            if (g.list.length >= this._GRADE_GROUP_MIN) {
                for (const r of g.list) {
                    r.groupKey = g.key;
                    r._label = this._gradePresetVarLabel(r, g.key);
                }
                groups.push(g);
            } else {
                for (const r of g.list) { r.groupKey = ''; delete r._label; }
                loose.push(g.list[0]);
            }
        }
        groups.sort((a, b) => a.key.localeCompare(b.key, 'zh'));
        loose.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
        return { groups, loose };
    },

    _gradeGroupState() {
        if (this._gradeGroupOpenMap) return this._gradeGroupOpenMap;
        let open = {};
        try {
            const parsed = JSON.parse(localStorage.getItem('qfs_grade_preset_groups') || 'null');
            if (parsed && parsed.open && typeof parsed.open === 'object') open = parsed.open;
        } catch (_) { /* 隐私模式 / 坏数据，用默认值 */ }
        this._gradeGroupOpenMap = { open };
        return this._gradeGroupOpenMap;
    },

    _gradeGroupIsOpen(key, total) {
        const st = this._gradeGroupState();
        const v = st.open[key];
        if (v === 0 || v === 1) return v === 1;   // 用户手动开/关过，以记忆为准
        return total <= this._GRADE_GROUP_AUTO_OPEN_MAX;
    },

    _gradeGroupSetOpen(key, open) {
        const st = this._gradeGroupState();
        st.open[key] = open ? 1 : 0;
        try { localStorage.setItem('qfs_grade_preset_groups', JSON.stringify(st)); } catch (_) {}
    },

    _renderGradePresetList() {
        const box = this.$('lvGradePresets');
        if (!box) return;
        const q = String(this._gradePresetQuery || '').trim();
        const total = this._gradePresets.length;
        const rows = total
            ? this._gradePresets.filter((r) => !q || r.name.indexOf(q) >= 0)
            : [];
        box.innerHTML = '';
        this._gradePresetRows = [];
        this._gradeGroupHeads = [];
        this._updateGradePresetCount(rows.length, total);
        this._syncGradePresetSearchClear();

        if (!rows.length) {
            const wrap = document.createElement('div');
            wrap.className = 'tpl-empty';
            const icon = document.createElement('div');
            icon.className = 'tpl-empty-icon';
            icon.textContent = q ? '⌕' : '◐';
            const title = document.createElement('div');
            title.className = 'tpl-empty-title';
            title.textContent = q ? '没有匹配的调色' : '还没有调色预设';
            const hint = document.createElement('div');
            hint.className = 'tpl-empty-hint';
            hint.textContent = q
                ? '换个名称试试'
                : '调好颜色后，点上方「保存当前」留一份；也可以导入 LR 的 .xmp';
            wrap.append(icon, title, hint);
            box.appendChild(wrap);
            return;
        }
        // 搜索时平铺：关键词已经把范围收窄，再折一层反而多一次点击。
        if (q) {
            for (const r of rows) box.appendChild(this._buildGradePresetRow(r, true));
            this._refreshGradePresetActive();
            return;
        }
        const tree = this._gradePresetTree(rows);
        // 全是落单的（新库 / 命名没规律）就不摆组头，保持原来的平铺列表。
        if (!tree.groups.length) {
            for (const r of tree.loose) box.appendChild(this._buildGradePresetRow(r, true));
            this._refreshGradePresetActive();
            return;
        }
        for (const g of tree.groups) box.appendChild(this._buildGradeGroup(g, total));
        if (tree.loose.length) {
            box.appendChild(this._buildGradeGroup({
                key: this._GRADE_GROUP_LOOSE, list: tree.loose, loose: true,
            }, total));
        }
        this._refreshGradePresetActive();
    },

    _buildGradePresetRow(r, plain) {
        const row = document.createElement('div');
        row.className = 'tpl-row grade-preset-row';
        row.dataset.gradePresetKey = r.name;
        row._preset = r;

        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'tpl-main';
        main.title = '单击应用调色「' + r.disp + '」到当前照片；悬停预览';
        main.setAttribute('aria-label', '应用调色「' + r.disp + '」');

        // 纯文字列表：预设名 +（使用中）标记；点击/悬停反馈就够了，不放缩略图。
        // 组内行只显示能区分的部分（`(12)` / `#004`），全名放 title。
        const info = document.createElement('span');
        info.className = 'tpl-info grade-preset-info';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tpl-name';
        nameSpan.textContent = (!plain && r._label) ? r._label : r.disp;
        nameSpan.title = r.disp;
        const activeTag = document.createElement('span');
        activeTag.className = 'tpl-active-tag';
        activeTag.textContent = '使用中';
        info.append(nameSpan, activeTag);
        main.append(info);
        main.addEventListener('click', () => this.applyGradePreset(r, [this.currentIdx]));

        row.addEventListener('mouseenter', () => this._scheduleGradePresetHover(r, row));
        row.addEventListener('mouseleave', () => this._cancelGradePresetHover(row));

        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'tpl-more';
        more.textContent = '⋯';
        more.title = '管理「' + r.disp + '」';
        more.setAttribute('aria-label', '管理调色预设「' + r.disp + '」');
        more.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._endGradePresetHover(true);
            this._openGradePresetMenu(r, more);
        });
        row.append(main, more);
        this._gradePresetRows.push(row);
        // 「使用中」标记统一由 _refreshGradePresetActive 一次算，避免逐行比参数。
        return row;
    },

    // 组头：▸ 组名 [数量] + 「组内有正在使用的调色」小圆点。
    _buildGradeGroup(g, total) {
        const key = g.key;
        const open = this._gradeGroupIsOpen(key, total);
        const wrap = document.createElement('div');
        wrap.className = 'preset-group grade-group' + (open ? ' open' : '');

        const head = document.createElement('div');
        head.className = 'group-name grade-group-head';
        head.setAttribute('role', 'button');
        head.setAttribute('tabindex', '0');
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        head.title = (g.loose ? '未分组' : key) + ' · ' + g.list.length + ' 个（点击折叠 / 展开）';

        const caret = document.createElement('span');
        caret.className = 'caret';
        caret.textContent = '\u25B8';

        const title = document.createElement('span');
        title.className = 'grade-group-title';
        title.textContent = g.loose ? '未分组' : key;

        const count = document.createElement('span');
        count.className = 'grade-group-count';
        count.textContent = String(g.list.length);

        const dot = document.createElement('span');
        dot.className = 'grade-group-active';
        dot.textContent = '●';
        dot.title = '组内有正在使用的调色';
        dot.hidden = true;

        head.append(caret, title, count, dot);
        head.addEventListener('click', () => this._toggleGradeGroup(wrap, key, total));
        head.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            this._toggleGradeGroup(wrap, key, total);
        });
        wrap.appendChild(head);

        const rowEls = [];
        for (const r of g.list) {
            const row = this._buildGradePresetRow(r, false);
            row._groupKey = key;
            wrap.appendChild(row);
            rowEls.push(row);
        }
        head._rowEls = rowEls;
        this._gradeGroupHeads.push(head);
        return wrap;
    },

    _toggleGradeGroup(wrap, key, total) {
        if (!wrap) return;
        const open = !wrap.classList.contains('open');
        wrap.classList.toggle('open', open);
        const head = wrap.querySelector('.grade-group-head');
        if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
        this._gradeGroupSetOpen(key, open);
        // 展开后把"使用中"的点补上（折叠时行是隐藏的，标记仍然算过）。
        this._refreshGradeGroupDots();
    },

    _openGradePresetMenu(r, btn) {
        const rect = btn.getBoundingClientRect();
        const x = Math.max(8, rect.right - 190);
        this.openCtx(x, rect.bottom + 4, [
            ['应用到当前照片', () => this.applyGradePreset(r, [this.currentIdx])],
            ['应用到选中照片', () => {
                const idxs = this._gradePresetSelectedTargets();
                if (idxs.length <= 1) {
                    this.setStatus('先在胶片条多选要应用的照片（Ctrl / Shift + 单击）');
                    return;
                }
                this.applyGradePreset(r, idxs);
            }],
            ['应用到全部照片', () => this.applyGradePreset(r, (this.images || []).map((_, i) => i))],
            ['导出 XMP…', () => this.exportGradePresetToFile(r)],
            ['重命名', () => this.renameGradePresetItem(r)],
            ['删除', () => this.deleteGradePresetItem(r)],
        ]);
    },

    _gradePresetSelectedTargets() {
        const raw = (this.selectedIdx && this.selectedIdx.length)
            ? this.selectedIdx
            : (this.batchSel || []);
        const max = (this.images || []).length;
        return Array.from(new Set((raw || []).filter((i) => Number.isInteger(i) && i >= 0 && i < max)));
    },

    /* ══ 悬停预览（只换画面，不写参数 / 不产生撤销记录） ══ */

    _gradePresetSideVisible() {
        if (this._sideMode !== 'grade') return false;
        if (document.body.classList.contains('sidebar-collapsed')) return false;
        const body = this.$('sideGradeBody');
        return !body || !body.hidden;
    },

    _scheduleGradePresetHover(r, row) {
        if (!this.image || !this.image.el) return;
        if (this._gradePresetMatches(r)) return; // 已经是这套调色，无需预览
        clearTimeout(this._gradeHoverTimer);
        this._gradeHoverTimer = setTimeout(() => this._previewGradePreset(r, row), 70);
    },

    _cancelGradePresetHover(row) {
        clearTimeout(this._gradeHoverTimer);
        if (this._gradeHover && (!row || this._gradeHover.row === row)) {
            this._endGradePresetHover(true);
        }
    },

    _previewGradePreset(r, row) {
        if (!r || !r.grade || !this.image || !this.image.el || this._sideMode !== 'grade') return;
        if (!this._gradePresetSideVisible()) return;
        this._endGradePresetHover(true);
        const im = this.image;
        let cv = null;
        try {
            cv = this.bakeGradePreview(Object.assign({}, r.grade, { masks: [] }), 1400);
        } catch (_) { cv = null; }
        if (!cv) return;
        // 只替换 _grade 缓存：im.grade 不变，撤销栈不受影响。
        const prev = im._grade;
        const preview = { neutral: false, canvas: null, low: cv, lowKey: 'grade-hover', fullKey: '' };
        im._grade = preview;
        this._gradeHover = { im, prev, preview, row };
        if (row) row.classList.add('previewing');
        if (this.scheduleRender) this.scheduleRender(true);
    },

    _endGradePresetHover(restore) {
        clearTimeout(this._gradeHoverTimer);
        const h = this._gradeHover;
        if (!h) return;
        this._gradeHover = null;
        if (h.row) h.row.classList.remove('previewing');
        // 只有预览缓存还挂在原位置时才还原；中途被应用/切图覆盖时不能把新状态冲掉。
        if (restore && h.im && h.im._grade === h.preview) {
            h.im._grade = h.prev;
            if (this.scheduleRender) this.scheduleRender(true);
        }
    },

    /* ══ 应用 ══ */

    // targets 省略 = 当前照片；传索引数组 = 当前 / 选中 / 全部。
    applyGradePreset(preset, targets) {
        if (!preset || !preset.grade) return false;
        this._endGradePresetHover(true);
        const im = this.image;
        if (!im || !this.images || !this.images.length) {
            this.setStatus('请先导入照片');
            return false;
        }
        const max = this.images.length;
        const list = Array.isArray(targets) && targets.length ? targets : [this.currentIdx];
        const idxs = Array.from(new Set(list.filter((i) => Number.isInteger(i) && i >= 0 && i < max)));
        if (!idxs.length) return false;

        const base = this.normalizeGrade(preset.grade);
        base.masks = [];
        const touchesCurrent = idxs.indexOf(this.currentIdx) >= 0;
        if (touchesCurrent && this.pushUndo) this.pushUndo();
        if (touchesCurrent && this.setActiveMask) this.setActiveMask(null);

        let n = 0;
        for (const i of idxs) {
            const it = this.images[i];
            if (!it) continue;
            // 蒙版是"这张画面的局部选区"，换预设时保留；预设本身也不含蒙版。
            const masks = (it.grade && Array.isArray(it.grade.masks))
                ? JSON.parse(JSON.stringify(it.grade.masks)) : [];
            const next = this._cloneGrade(Object.assign({}, base, { masks }));
            it.grade = next;
            it._gradeCache = null;
            it._grade = {
                neutral: this.isNeutralGrade ? this.isNeutralGrade(next) : false,
                canvas: null, low: null, lowKey: '', fullKey: '',
            };
            n++;
        }
        if (!n) return false;

        if (touchesCurrent) {
            // 预设是「一整套参数」，不是拖动中的中间态：直接烘出全分辨率画布，
            // 否则 photoSrcOf 没有 canvas / low 可拿，会退回原图（滑块变了但画面没变）。
            if (this.rebuildGrade) this.rebuildGrade('full');
            this.syncGradeUI();
            if (this.renderFramedThumb) this.renderFramedThumb(im);
        }
        if (this.buildThumbnails) this.buildThumbnails();
        if (this.scheduleRender) this.scheduleRender(true);
        if (this.scheduleDraft) this.scheduleDraft();
        this._refreshGradePresetActive();
        this.setStatus(`已应用调色「${preset.disp}」到 ${n} 张照片`);
        return true;
    },

    _cloneGrade(p) {
        try { return JSON.parse(JSON.stringify(p)); }
        catch (_) { return this.normalizeGrade(p); }
    },

    _gradePresetMatches(r, curHash) {
        const im = this.image;
        if (!im || !im.grade || !r || !r.grade) return false;
        try {
            const cur = typeof curHash === 'string' ? curHash : this._gradeHashOf(im.grade);
            const pre = r._hash || (r._hash = this._gradeHashOf(r.grade));
            return !!cur && cur === pre;
        } catch (_) {
            return false;
        }
    },

    _markGradePresetRowActive(row, r, curHash) {
        if (!row) return;
        const active = this._gradePresetMatches(r, curHash);
        row.classList.toggle('active', active);
        row.setAttribute('aria-current', active ? 'true' : 'false');
        const tag = row.querySelector('.tpl-active-tag');
        if (tag) tag.hidden = !active;
    },

    _refreshGradePresetActive() {
        const rows = this._gradePresetRows || [];
        if (!rows.length && !(this._gradeGroupHeads || []).length) return;
        // 当前照片的指纹只算一次，上千行共享；逐行 normalize 会明显拖慢拖滑块。
        const cur = (this.image && this.image.grade) ? this._gradeHashOf(this.image.grade) : '';
        for (const row of rows) this._markGradePresetRowActive(row, row._preset, cur);
        this._refreshGradeGroupDots();
    },

    // 组折叠时行看不见，"使用中"要能在组头上体现，否则用户不知道正用着哪个包里的预设。
    _refreshGradeGroupDots() {
        for (const head of this._gradeGroupHeads || []) {
            const dot = head.querySelector('.grade-group-active');
            if (!dot) continue;
            const rowEls = head._rowEls || [];
            dot.hidden = !rowEls.some((el) => el.classList.contains('active'));
        }
    },

    _scheduleGradePresetActive() {
        clearTimeout(this._gradePresetActiveTimer);
        this._gradePresetActiveTimer = setTimeout(() => this._refreshGradePresetActive(), 250);
    },

    // 切图后「使用中」标记属于上一张照片，需要按新图重算。
    onGradePresetImageChange() {
        this._endGradePresetHover(true);
        this._refreshGradePresetActive();
    },

    /* ══ 保存 / 导入 / 重命名 / 删除 / 导出 ══ */

    async saveGradePresetFromCurrent(nameOverride) {
        const im = this.image;
        if (!im) { this.setStatus('请先导入照片'); return false; }
        const grade = this.normalizeGrade(im.grade || null);
        grade.masks = [];
        if (this.isNeutralGrade && this.isNeutralGrade(grade)) {
            this.setStatus('当前照片没有可保存的全局调色（蒙版不保存）');
            return false;
        }
        let name;
        if (nameOverride != null) {
            name = String(nameOverride);
        } else {
            const typed = await this.promptText('给这套调色起个名字（之后可在列表里重命名）', '调色预设');
            if (typed == null) return false;
            name = String(typed);
        }
        name = this._safePresetName(name);
        if (!name) { this.setStatus('预设名称不能为空'); return false; }

        const api = this._gradePresetApi();
        if (!api) {
            this.setStatus('当前环境不支持保存调色预设');
            return false;
        }
        // 没有保存对话框的环境（开发/旧版桥）退回直接存库。
        if (typeof api.pickGradePresetSavePath !== 'function'
            || typeof api.saveGradePresetXmp !== 'function') {
            return this._saveGradePresetToLibrary(name, grade, { reveal: true });
        }

        let picked = null;
        try { picked = await api.pickGradePresetSavePath(name); }
        catch (e) { picked = { ok: false, error: String(e) }; }
        if (!picked || picked.canceled) return false;
        if (picked.ok === false) {
            this.setStatus('保存调色失败：' + (picked.error || '无法打开保存位置'));
            return false;
        }
        const finalName = this._safePresetName(picked.name || name);
        // 覆盖确认由系统保存框负责（Windows/macOS 都会在文件已存在时询问），
        // 这里不再二次弹窗；选到库外时主进程会自动收录成唯一名称。
        const xml = this._gradeToXmp(grade, finalName);
        if (!xml) return false;
        let res = null;
        try { res = await api.saveGradePresetXmp(picked.path, xml); }
        catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('保存调色失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        await this.refreshGradePresets();
        const savedName = res.libraryName || finalName;
        this._revealGradePreset(savedName);
        const extra = (res.libraryPath && res.libraryPath !== picked.path)
            ? '，已收录到「调色预设」' : '';
        this.setStatus(`已保存调色「${savedName}」（XMP）${extra}`);
        return true;
    },

    // 直接写入预设库（只有旧桥/测试环境才会走到）。
    async _saveGradePresetToLibrary(name, grade, opts) {
        const api = this._gradePresetApi();
        if (!api || typeof api.saveGradePreset !== 'function') {
            this.setStatus('当前环境不支持保存调色预设');
            return false;
        }
        let names = [];
        try { names = (await api.listGradePresets()) || []; } catch (_) { names = []; }
        const exists = names.some((e) => (typeof e === 'string' ? e : e.name) === name);
        if (exists && !window.confirm(`已存在同名调色「${name}」，要覆盖吗？`)) return false;
        const xml = this._gradeToXmp(grade, name);
        if (!xml) return false;
        let res = null;
        try { res = await api.saveGradePreset(name, xml); }
        catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('保存调色失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        await this.refreshGradePresets();
        if (!opts || opts.reveal !== false) this._revealGradePreset(name);
        this.setStatus(`已保存调色「${name}」（XMP）`);
        return true;
    },

    async importGradePresets() {
        const api = this._gradePresetApi();
        if (!api || typeof api.pickGradeXmpFiles !== 'function' || typeof api.saveGradePreset !== 'function') {
            this.setStatus('当前环境不支持导入调色预设');
            return false;
        }
        // 标准 LR 预设的参数曲线要用实测表才准；没加载好也继续，走公式兜底。
        if (window.QfsAcr && QfsAcr.ensure) { try { await QfsAcr.ensure(); } catch (_) {} }
        let picked = null;
        try { picked = await api.pickGradeXmpFiles(); }
        catch (e) { picked = { ok: false, error: String(e) }; }
        if (!picked || picked.canceled) return false;
        if (picked.ok === false) {
            this.setStatus('导入失败：' + (picked.error || '无法读取预设文件'));
            return false;
        }
        const files = Array.isArray(picked.files) ? picked.files : [];
        if (!files.length) {
            this.setStatus('没有选择可导入的 .xmp 文件');
            return false;
        }
        this.setStatus(`正在导入 ${files.length} 个调色预设…`);
        let entries = [];
        try { entries = (await api.listGradePresets()) || []; } catch (_) { entries = []; }
        const taken = new Set(entries.map((e) => (typeof e === 'string' ? e : e.name)));
        let ok = 0;
        let dup = 0;
        let bad = 0;
        const badNames = [];
        const imported = [];
        for (let i = 0; i < files.length; i++) {
            const f = files[i] || {};
            const grade = this._parseXmpGrade(f.xml);
            if (!grade) {
                bad++;
                if (f.name) badNames.push(String(f.name));
                continue;
            }
            const base = this._safePresetName(f.name || '导入的调色');
            let target = base;
            if (taken.has(base)) {
                // 同名且内容完全一致：真重复，跳过；同名不同内容：加 (2) 保留两份。
                const same = await this._libraryGradeEquals(base, grade);
                if (same) { dup++; continue; }
                target = this._uniquePresetName(base, taken);
            }
            const xml = this._gradeToXmp(grade, target);
            if (!xml) { bad++; if (f.name) badNames.push(String(f.name)); continue; }
            let res = null;
            try { res = await api.saveGradePreset(target, xml); }
            catch (e) { res = { ok: false, error: String(e) }; }
            if (res && res.ok !== false) {
                ok++;
                imported.push(target);
                taken.add(target);
            } else {
                bad++;
                if (f.name) badNames.push(String(f.name));
            }
            if (i % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await this.refreshGradePresets();
        if (imported.length) this._revealGradePreset(imported[0]);
        const parts = [`成功 ${ok} 个`];
        if (dup) parts.push(`跳过 ${dup} 个已存在`);
        if (bad) parts.push(`跳过 ${bad} 个无法识别`);
        if (picked.skipped && picked.skipped.length) parts.push(`读取失败 ${picked.skipped.length} 个`);
        let msg = '导入完成：' + parts.join('，');
        if (badNames.length) {
            msg += '（' + badNames.slice(0, 3).join('、') + (badNames.length > 3 ? ' 等' : '') + '）';
        }
        this.setStatus(msg);
        return ok > 0;
    },

    async _libraryGradeEquals(name, grade) {
        const api = this._gradePresetApi();
        if (!api) return false;
        try {
            const data = await api.loadGradePreset(name, 'xmp');
            const other = this._gradeFromLoad({ name, ext: 'xmp' }, data);
            if (!other) return false;
            const a = this.normalizeGrade(other);
            const b = this.normalizeGrade(grade);
            a.masks = [];
            b.masks = [];
            return JSON.stringify(a) === JSON.stringify(b);
        } catch (_) {
            return false;
        }
    },

    _revealGradePreset(key) {
        const box = this.$('lvGradePresets');
        if (!box || !key) return false;
        const row = [...box.querySelectorAll('.tpl-row')]
            .find((el) => el.dataset.gradePresetKey === key);
        if (!row) return false;
        // 刚保存 / 刚导入的预设可能落在折叠的组里，先展开再滚动，否则滚了个看不见的行。
        const wrap = row.closest('.preset-group');
        if (wrap && !wrap.classList.contains('open')) {
            wrap.classList.add('open');
            const head = wrap.querySelector('.grade-group-head');
            if (head) head.setAttribute('aria-expanded', 'true');
            this._gradeGroupSetOpen(row._groupKey || '', true);
        }
        try { row.scrollIntoView({ block: 'nearest' }); } catch (_) { /* 老环境无此 API */ }
        row.classList.add('tpl-flash');
        clearTimeout(this._gradePresetRevealTimer);
        this._gradePresetRevealTimer = setTimeout(() => row.classList.remove('tpl-flash'), 900);
        return true;
    },

    async renameGradePresetItem(r) {
        const typed = await this.promptText('重命名调色预设', r.disp);
        if (typed == null) return false;
        const safe = this._safePresetName(typed);
        if (!safe || safe === r.name) return false;
        const api = this._gradePresetApi();
        if (!api || typeof api.renameGradePreset !== 'function') {
            this.setStatus('当前环境不支持重命名调色预设');
            return false;
        }
        let res = null;
        try { res = await api.renameGradePreset(r.name, safe); }
        catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('重命名失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        // 文件改名后，把 XMP 里的预设名也重写一遍，分享给 LR 时标题不会还是旧名字。
        const xml = this._gradeToXmp(r.grade, safe);
        if (xml) {
            try {
                await api.saveGradePreset(safe, xml);
                // 旧版 .json 被改名后会在旁边留一份；已经有新 .xmp，旧格式可以删了。
                if (r.ext === 'json' && typeof api.deleteGradePreset === 'function') {
                    await api.deleteGradePreset(safe, 'json');
                }
            } catch (_) { /* 内容重写失败不影响改名 */ }
        }
        await this.refreshGradePresets();
        this._revealGradePreset(safe);
        this.setStatus(`已重命名为「${safe}」`);
        return true;
    },

    async deleteGradePresetItem(r) {
        if (!window.confirm(`确定删除调色「${r.disp}」？`)) return false;
        const api = this._gradePresetApi();
        if (!api || typeof api.deleteGradePreset !== 'function') {
            this.setStatus('当前环境不支持删除调色预设');
            return false;
        }
        let res = null;
        try { res = await api.deleteGradePreset(r.name, r.ext); }
        catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('删除失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        await this.refreshGradePresets();
        this.setStatus(`已删除「${r.disp}」`);
        return true;
    },

    async exportGradePresetToFile(r) {
        if (!r || !r.grade) return false;
        const api = this._gradePresetApi();
        if (!api || typeof api.pickGradePresetSavePath !== 'function') {
            this.setStatus('当前环境不支持导出调色预设');
            return false;
        }
        let picked = null;
        try { picked = await api.pickGradePresetSavePath(r.disp); }
        catch (e) { picked = { ok: false, error: String(e) }; }
        if (!picked || picked.canceled) return false;
        if (picked.ok === false) {
            this.setStatus('导出失败：' + (picked.error || '无法打开保存位置'));
            return false;
        }
        const name = this._safePresetName(picked.name || r.disp);
        const xml = this._gradeToXmp(r.grade, name);
        if (!xml) return false;
        let res = null;
        try {
            if (typeof api.exportGradePresetXmp === 'function') {
                res = await api.exportGradePresetXmp(picked.path, xml);
            } else {
                res = await api.saveGradePresetXmp(picked.path, xml);
            }
        } catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('导出失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        if (picked.inLibrary) await this.refreshGradePresets();
        this.setStatus(`已导出调色「${name}」（XMP）`);
        return true;
    },
});

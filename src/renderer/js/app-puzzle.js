// 拼图模块：拼图页签 + 拼图画布交互 + 拼图导出 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ══ 拼图页签 ══ */
    puzzleLayouts() {
        return [
            ['single', '单张'], ['h2', '2·左右'], ['v2', '2·上下'], ['as2', '一大一小'],
            ['h3', '3·横排'], ['v3', '3·竖排'], ['grid4', '4·宫格'], ['as4', '1大3小'],
            ['h4', '4·横排'], ['v4', '4·竖排'], ['grid6', '6·宫格'], ['grid9', '9·宫格'],
        ];
    },

    layoutTypeOf(layout) {
        const map = { single: 0, h2: 1, v2: 2, as2: 3, h3: 4, v3: 5, grid4: 6, as4: 7, h4: 8, v4: 9, grid6: 10, grid9: 11 };
        return map[layout] != null ? map[layout] : 0;
    },

    layoutKeyOf(type) {
        const keys = ['single', 'h2', 'v2', 'as2', 'h3', 'v3', 'grid4', 'as4', 'h4', 'v4', 'grid6', 'grid9'];
        return (type >= 0 && type < keys.length) ? keys[type] : 'single';
    },

    buildPuzzleLayoutBtns() {
        const box = this.$('puzzleLayouts');
        if (!box) return;
        box.innerHTML = '';
        this.puzzleLayouts().forEach(([val, label]) => {
            const b = document.createElement('button');
            b.className = 'mini-btn';
            b.textContent = label;
            b.dataset.val = val;
            b.addEventListener('click', () => {
                this.onSettingCommit();
                this.setPuzzleLayout(this.layoutTypeOf(val));
                this.setStatus(`已启用拼图布局「${label}」`);
            });
            box.appendChild(b);
        });
    },

    // 切换布局并尽量保留各照片槽位(imageIndex 不改)
    setPuzzleLayout(layoutType) {
        if (!this.template) return;
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        const oldAxes = pk.axisVals;
        pk.layout = this.layoutKeyOf(layoutType);
        pk.layoutType = layoutType;
        pk.axisVals = oldAxes || {};
        pk.enabled = 1;
        this._puzzleAxisHover = null;
        this.migratePuzzle();
        this.ensurePuzzleSlotsCount(pk);
        this.reconcilePuzzleCaptions(pk);
        this.autoFillPuzzleSlots();
        this.saveCurrentTemplate();
        this.switchTab('puzzle');
        this.refreshPuzzleUI();
        this.scheduleRender(true);
    },

    // 批量放图:勾选照片按勾选顺序填各格,勾选不够用当前打开的主图补位;
    // 无勾选时只做布局几何更新(重算格子位置/大小),绝不改动已有格子内容
    // (图片 / 平移 / 缩放 / 双击替换全部保留),即使重复点击当前布局也不重填
    autoFillPuzzleSlots() {
        const pk = this.template && this.template.puzzle;
        if (!pk || !pk.enabled) return;
        const n = this.puzzleSlotCount(pk.layout || 'single');
        const main = this.image ? this.images.indexOf(this.image) : -1;
        if (!this.batchSel.length) return;
        // 按勾选顺序依次填格(不排序),不够用当前主图补位
        const order = this.batchSel.slice();
        for (let i = 0; i < n; i++) {
            const idx = i < order.length ? order[i] : main;
            const sc = pk.slots[i] || (pk.slots[i] = {});
            if (idx >= 0) { sc.imageIndex = idx; sc.imagePath = undefined; }
            else { sc.imageIndex = undefined; sc.imagePath = undefined; }
        }
        this.batchSel = [];
        // 勾选已被填格消费,随后“导出图片”应回到导出当前单张,而不是残留的多选
        this.selectedIdx = [];
    },

    // 兼容旧模型:补 layoutType/axisVals/gapCaptions,并把旧 slots 数组升级为 dict
    migratePuzzle() {
        const pk = this.template.puzzle;
        if (!pk) return;
        if (pk.layoutType == null) pk.layoutType = this.layoutTypeOf(pk.layout || 'single');
        if (!pk.slots) pk.slots = {};
        if (pk.axisVals == null) pk.axisVals = {};
        if (!pk.gapCaptions) pk.gapCaptions = {};
        if (Array.isArray(pk.slots)) {
            const arr = pk.slots;
            pk.slots = {};
            arr.forEach((sc, i) => { if (sc) pk.slots[i] = sc; });
        }
    },

    // 确保每个槽位有配置对象
    ensurePuzzleSlotsCount(pk) {
        const n = this.puzzleSlotCount(pk.layout || 'single');
        this.migratePuzzle();
        for (let i = 0; i < n; i++) {
            if (!pk.slots[i]) pk.slots[i] = { fillMode: pk.slotFill || 'cover', zoom: pk.zoom || 100, offsetX: 0, offsetY: 0 };
        }
    },

    // 布局切换巡检字幕:绑定的分割轴在新布局不存在的间隙字幕直接删;格子字幕仅在下标越界时删
    reconcilePuzzleCaptions(pk) {
        if (!pk) return;
        const n = this.puzzleSlotCount(pk.layout || 'single');
        if (pk.captions) {
            for (const k in pk.captions) {
                const idx = parseInt(k, 10);
                if (!isNaN(idx) && idx >= n) delete pk.captions[k];
            }
        }
        const axes = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(pk.layout || 'single', pk.axisVals) : { v: [], h: [] };
        if (pk.gapCaptions) {
            for (const key in pk.gapCaptions) {
                const m = /^([vh])(\d+)$/.exec(key);
                if (!m) continue;
                // h 字幕按行计数(行数 = 横轴数 + 1,含底部字幕带);v 字幕按竖轴计数
                const maxN = m[1] === 'h' ? ((axes.h || []).length + 1) : (axes.v || []).length;
                if (parseInt(m[2], 10) >= maxN) delete pk.gapCaptions[key];
            }
        }
    },

    puzzleSlotCount(layout) {
        const n = { single: 1, as2: 2, h2: 2, v2: 2, h3: 3, v3: 3, as4: 4, grid4: 4, h4: 4, v4: 4, grid6: 6, grid9: 9 };
        return n[layout] || 1;
    },

    syncPuzzleFromUI() {
        if (!this.template) return;
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        const $ = this.$;
        pk.gap = $('slPuzzleGap') ? parseInt($('slPuzzleGap').value, 10) : pk.gap;
        pk.cornerRadius = $('slPuzzleCorner') ? parseInt($('slPuzzleCorner').value, 10) : (pk.cornerRadius == null ? 3 : pk.cornerRadius);
        pk.bgMode = $('cbPuzzleBg') ? parseInt($('cbPuzzleBg').value, 10) : 0;
        pk.canvasRatio = $('cbPuzzleCanvas') ? $('cbPuzzleCanvas').value : 'auto';
        pk.borderColor = $('cpPuzzleBorder') ? $('cpPuzzleBorder').value.replace('#', '') : 'ffffff';
        pk.slotFill = $('cbSlotFill') ? $('cbSlotFill').value : 'cover';
        this.ensurePuzzleSlotsCount(pk);
        // 选中槽位 per-slot 写回(整体偏移/缩放滑块 = 该槽配置)
        if (typeof this._puzzleSlot === 'string' && this._puzzleSlot.charAt(0) === 's') {
            const si = parseInt(this._puzzleSlot.substring(1), 10);
            const sc = pk.slots[si] || (pk.slots[si] = {});
            sc.offsetX = $('slSlotOffsetX') ? parseInt($('slSlotOffsetX').value, 10) : (sc.offsetX || 0);
            sc.offsetY = $('slSlotOffsetY') ? parseInt($('slSlotOffsetY').value, 10) : (sc.offsetY || 0);
            sc.zoom = $('slSlotZoom') ? parseInt($('slSlotZoom').value, 10) : (sc.zoom != null ? sc.zoom : 100);
            sc.fillMode = pk.slotFill || 'cover';
        }
        // 间隙字幕捕获(v/h 键)
        if (!this._skipPuzzleCapture && this._puzzleSlot != null) this.captureCaptionToModel(this._puzzleSlot);
    },

    // 槽位/间隙下拉改变:先把当前编辑字幕写回旧项,再提交/加载新项
    onPuzzleSlotChange() {
        const $ = this.$;
        if (this._puzzleSlot != null) this.captureCaptionToModel(this._puzzleSlot);
        this._skipPuzzleCapture = true;
        try {
            this.onSettingCommit();
        } finally {
            this._skipPuzzleCapture = false;
        }
        if ($('cbPuzzleGapPick')) this._puzzleSlot = $('cbPuzzleGapPick').value;
        if (this._puzzleSlot === '') this._activePuzzleSlot = null;
        if (/^s\d+$/.test(this._puzzleSlot)) {
            const si = parseInt(this._puzzleSlot.substring(1), 10);
            if (this._activePuzzleSlot !== si) { this._activePuzzleSlot = si; this.scheduleRender(); }
        } else if (/^[vh]\d+$/.test(this._puzzleSlot) && this._activePuzzleSlot != null) {
            // 选中的是间隙字幕 = 编辑间隙,不同时保留某一格的高亮/单图控件
            this._activePuzzleSlot = null;
            this.scheduleRender();
        }
        // onSettingCommit 里的刷新发生在读取新值之前,这里再刷一次,让标签/滑块跟上新选中
        this.refreshPuzzleUI();
    },

    refreshPuzzleUI() {
        if (!this.template) return;
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        this.ensurePuzzleSlotsCount(pk);
        this.reconcilePuzzleCaptions(pk);
        // 「重拼(按序填满)」:拼图内存在图片内容时可用,拼图为空时置灰
        const rep = this.$('btnPuzzleRepuzzle');
        if (rep) {
            const hasContent = pk.slots && Object.keys(pk.slots).some(k => {
                const sc = pk.slots[k];
                return sc && (sc.imageIndex != null || sc.imagePath != null);
            });
            rep.disabled = !hasContent;
        }
        const $ = this.$;
        const n = this.puzzleSlotCount(pk.layout);
        if ($('slPuzzleGap')) $('slPuzzleGap').value = pk.gap != null ? pk.gap : 6;
        this.updateLabel('lblPuzzleGap', pk.gap != null ? pk.gap : 6);
        if ($('slPuzzleCorner')) $('slPuzzleCorner').value = pk.cornerRadius != null ? pk.cornerRadius : 3;
        this.updateLabel('lblPuzzleCorner', (pk.cornerRadius != null ? pk.cornerRadius : 3) + '%');
        if ($('cbPuzzleBg')) $('cbPuzzleBg').value = String(pk.bgMode || 0);
        if ($('cbPuzzleCanvas')) $('cbPuzzleCanvas').value = pk.canvasRatio || 'auto';
        if ($('cpPuzzleBorder')) $('cpPuzzleBorder').value = '#' + (pk.borderColor || 'ffffff');
        if ($('cbSlotFill')) $('cbSlotFill').value = pk.slotFill || 'cover';
        // 字幕门牌下拉:列出全部分割间隙与全部格子;已绑定字幕的项带圆点标记
        const pick = $('cbPuzzleGapPick');
        if (pick) {
            pick.innerHTML = '';
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.textContent = '不选中';
            pick.appendChild(noneOpt);
            const mark = (bound) => bound ? '● ' : '';
            for (let i = 0; i < n; i++) {
                const o = document.createElement('option');
                o.value = 's' + i;
                o.textContent = mark(!!(pk.captions && pk.captions[i])) + `格子 ${i + 1}`;
                pick.appendChild(o);
            }
            const axes = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(pk.layout || 'single', pk.axisVals) : { v: [], h: [] };
            const vAxes = axes.v || [], hAxes = axes.h || [];
            // 横间隙:每行图片下方一条全宽字幕带(行数 = 横轴数 + 1,最末一条为底部字幕带)
            const capRowN = hAxes.length + 1;
            for (let i = 0; i < capRowN; i++) {
                const o = document.createElement('option');
                o.value = 'h' + i;
                o.textContent = mark(!!(pk.gapCaptions && pk.gapCaptions['h' + i])) + `横间隙 ${i + 1}`;
                pick.appendChild(o);
            }
            vAxes.forEach((_, i) => {
                const o = document.createElement('option');
                o.value = 'v' + i;
                o.textContent = mark(!!(pk.gapCaptions && pk.gapCaptions['v' + i])) + `竖间隙 ${i + 1}`;
                pick.appendChild(o);
            });
            const isNone = this._puzzleSlot == null || this._puzzleSlot === '';
            if (isNone) {
                pick.value = '';
            } else if (typeof this._puzzleSlot === 'string' && pick.querySelector('option[value="' + this._puzzleSlot + '"]')) {
                pick.value = this._puzzleSlot;
            } else { this._puzzleSlot = ''; pick.value = ''; }
            // 画布选中槽位是单图控件的唯一入口:没选中就禁用偏移/缩放,避免"控制整个拼图"时偷偷改某一格
            const hasSlot = this._activePuzzleSlot != null && this._activePuzzleSlot >= 0 && this._activePuzzleSlot < n;
            if (!hasSlot) this._activePuzzleSlot = null;
            if (hasSlot) {
                const sc = pk.slots[this._activePuzzleSlot] || {};
                this.setSlotOffsetSliders(sc);
                if ($('slSlotZoom')) $('slSlotZoom').value = sc.zoom != null ? sc.zoom : 100;
                this.updateLabel('lblSlotZoom', (sc.zoom != null ? sc.zoom : 100) + '%');
            }
            ['slSlotOffsetX', 'slSlotOffsetY', 'slSlotZoom'].forEach(id => {
                const el = $(id);
                if (!el) return;
                el.disabled = !hasSlot;
                if (hasSlot) el.removeAttribute('title');
                else el.title = '先在画布上点击选中一个格子';
            });
            const lbl = $('lblPuzzleSlot');
            if (lbl) {
                if (!pk.enabled) lbl.textContent = '当前槽位：无（未启用）';
                else if (hasSlot) {
                    const ai = this._activePuzzleSlot;
                    const nm = this.slotImageName(ai);
                    lbl.textContent = `当前槽位:${ai + 1}/${n}${nm ? ` · ${nm}` : '（空）'} (布局 ${pk.layout})`;
                    lbl.title = nm || '';
                } else if (/^[vh]\d+$/.test(this._puzzleSlot || '')) {
                    lbl.textContent = `当前项:${this._puzzleSlot.toUpperCase()} 间隙字幕 (布局 ${pk.layout})`;
                    lbl.title = '';
                } else {
                    lbl.textContent = `当前槽位:未选中 (布局 ${pk.layout})`;
                    lbl.title = '';
                }
            }
        }
        this.loadCaptionFromModel();
        this.renderCaptionEditorVisibility();
    },

    // 将槽位偏移同步到滑块 + 标签(拖动/回读共用;松手 commit 从滑块回写,需先同步防止被旧值覆盖)
    setSlotOffsetSliders(sc) {
        const $ = this.$;
        if ($('slSlotOffsetX')) $('slSlotOffsetX').value = clampNum((sc && sc.offsetX) || 0, -100, 100);
        if ($('slSlotOffsetY')) $('slSlotOffsetY').value = clampNum((sc && sc.offsetY) || 0, -100, 100);
        this.updateLabel('lblSlotOffsetX', (sc && sc.offsetX) || 0);
        this.updateLabel('lblSlotOffsetY', (sc && sc.offsetY) || 0);
    },

    loadCaptionFromModel() {
        const $ = this.$;
        const pk = this.template.puzzle || {};
        const key = $('cbPuzzleGapPick') ? $('cbPuzzleGapPick').value : 's0';
        const isGap = /^[vh]\d+$/.test(key);
        let cap = null;
        if (isGap) cap = (pk.gapCaptions && pk.gapCaptions[key]) || null;
        else if (key) { const idx = parseInt(key.substring(1), 10); cap = (pk.captions && pk.captions[idx]) || null; }
        // 记录正在编辑的门牌号:仅当该位置已绑定字幕(或刚通过「添加/编辑字幕」显式新建)时打开编辑器,
        // 仅在下拉里选择空位置不弹出空编辑器,避免误以为是添加字幕入口
        this._editingGap = key && cap ? key.toUpperCase() : null;
        const lblEdit = $('lblEditingCap');
        if (lblEdit) {
            const nLabel = isGap ? (key.charAt(0) === 'h' ? '横间隙 ' : '竖间隙 ') : (/^s\d+$/.test(key) ? '格子 ' : '');
            lblEdit.textContent = this._editingGap ? `正在编辑：${nLabel}${this._editingGap}` : '';
        }
        const cbV = $('cbCapVertical');
        if (cbV) { cbV.disabled = !isGap; cbV.checked = !!(isGap && cap && cap.direction === 'vertical'); }
        const set = (id, v) => { const e = $(id); if (e) e.value = v == null ? '' : v; };
        if (cap) {
            set('tfCapLine1', cap.line1); set('tfCapLine2', cap.line2);
            set('slCapSize1', cap.size1 || 28); set('slCapSize2', cap.size2 || 20);
            set('cbCapFont1', cap.font1 || 'Microsoft YaHei'); set('cbCapFont2', cap.font2 || 'Microsoft YaHei');
            if ($('cpCapColor')) $('cpCapColor').value = '#' + (cap.color || 'ffffff');
            if ($('cbCapBgBar')) $('cbCapBgBar').checked = (cap.bgBar || 0) === 1;
            set('slCapSpacing', cap.spacing != null ? cap.spacing : 0);
            this.updateLabel('lblCapSize1', cap.size1 || 28); this.updateLabel('lblCapSize2', cap.size2 || 20);
            this.updateLabel('lblCapSpacing', (cap.spacing != null ? cap.spacing : 0) + '%');
        } else {
            set('tfCapLine1', ''); set('tfCapLine2', '');
            set('slCapSize1', 28); set('slCapSize2', 20);
            set('cbCapFont1', 'Microsoft YaHei'); set('cbCapFont2', 'Microsoft YaHei');
            if ($('cpCapColor')) $('cpCapColor').value = '#ffffff';
            if ($('cbCapBgBar')) $('cbCapBgBar').checked = false;
            set('slCapSpacing', 0);
            this.updateLabel('lblCapSize1', 28); this.updateLabel('lblCapSize2', 20); this.updateLabel('lblCapSpacing', '0%');
        }
    },

    // 字幕写入:槽位键 's0'.. → captions[数字];间隙键 'v0'/'h0'.. → gapCaptions[key]
    captureCaptionToModel(key) {
        if (!this.template || key == null) return;
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        const isGap = typeof key === 'string' && /^[vh]\d+$/.test(key);
        if (isGap) return this.captureGapCaptionToModel(key);
        const idx = typeof key === 'string' ? parseInt(key.substring(1), 10) : key;
        if (isNaN(idx)) return;
        if (!pk.captions) pk.captions = {};
        const $ = this.$;
        const line1 = $('tfCapLine1') ? $('tfCapLine1').value.trim() : '';
        const line2 = $('tfCapLine2') ? $('tfCapLine2').value.trim() : '';
        if (!line1 && !line2) { delete pk.captions[idx]; if (this._editingGap === ('S' + idx)) this._editingGap = null; return; }
        pk.captions[idx] = {
            line1, line2, gapId: 'S' + idx,
            size1: $('slCapSize1') ? parseInt($('slCapSize1').value, 10) : 28,
            size2: $('slCapSize2') ? parseInt($('slCapSize2').value, 10) : 20,
            font1: $('cbCapFont1') ? $('cbCapFont1').value : 'Microsoft YaHei',
            font2: $('cbCapFont2') ? $('cbCapFont2').value : 'Microsoft YaHei',
            color: ($('cpCapColor') ? $('cpCapColor').value : '#ffffff').replace('#', ''),
            bgBar: ($('cbCapBgBar') && $('cbCapBgBar').checked) ? 1 : 0,
            spacing: $('slCapSpacing') ? parseInt($('slCapSpacing').value, 10) : 0,
        };
    },

    captureGapCaptionToModel(key) {
        if (!this.template || key == null) return;
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        if (!pk.gapCaptions) pk.gapCaptions = {};
        const $ = this.$;
        const line1 = $('tfCapLine1') ? $('tfCapLine1').value.trim() : '';
        const line2 = $('tfCapLine2') ? $('tfCapLine2').value.trim() : '';
        if (!line1 && !line2) { delete pk.gapCaptions[key]; if (this._editingGap === key.toUpperCase()) this._editingGap = null; return; }
        pk.gapCaptions[key] = {
            line1, line2, gapId: key.toUpperCase(),
            size1: $('slCapSize1') ? parseInt($('slCapSize1').value, 10) : 28,
            size2: $('slCapSize2') ? parseInt($('slCapSize2').value, 10) : 20,
            font1: $('cbCapFont1') ? $('cbCapFont1').value : 'Microsoft YaHei',
            font2: $('cbCapFont2') ? $('cbCapFont2').value : 'Microsoft YaHei',
            color: ($('cpCapColor') ? $('cpCapColor').value : '#ffffff').replace('#', ''),
            bgBar: ($('cbCapBgBar') && $('cbCapBgBar').checked) ? 1 : 0,
            spacing: $('slCapSpacing') ? parseInt($('slCapSpacing').value, 10) : 0,
            direction: ($('cbCapVertical') && $('cbCapVertical').checked) ? 'vertical' : 'horizontal',
        };
    },

    toggleCaptionEditor(show) {
        const editor = this.$('vbCaptionEditor');
        if (editor) editor.style.display = show ? 'block' : 'none';
    },

    renderCaptionEditorVisibility() {
        this.toggleCaptionEditor(this._editingGap != null);
    },

    // 「添加/编辑字幕」:按选中项的门牌号到字幕列表找对应,没有则新建一条并绑定,然后打开编辑
    addEditGapCaption() {
        const $ = this.$;
        const key = $('cbPuzzleGapPick') ? $('cbPuzzleGapPick').value : '';
        if (!key) { this.setStatus('请先在上方选择一条分割间隙或格子'); return; }
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        const isGap = /^[vh]\d+$/.test(key);
        let cap = null;
        if (isGap) { if (!pk.gapCaptions) pk.gapCaptions = {}; cap = pk.gapCaptions[key]; if (!cap) cap = pk.gapCaptions[key] = { size1: 28, size2: 20, color: 'ffffff', bgBar: 0, spacing: 0, direction: 'horizontal' }; }
        else { if (!pk.captions) pk.captions = {}; const idx = parseInt(key.substring(1), 10); cap = pk.captions[idx]; if (!cap) cap = pk.captions[idx] = { size1: 28, size2: 20, color: 'ffffff', bgBar: 0, spacing: 0 }; }
        if (cap && !cap.gapId) cap.gapId = key.toUpperCase();
        this._editingGap = key.toUpperCase();
        this.loadCaptionFromModel();
        this.renderCaptionEditorVisibility();
        this.setStatus(`已绑定字幕到 ${this._editingGap}，编辑输入即时生效`);
    },

    deleteCaption() {
        const $ = this.$;
        const key = $('cbPuzzleGapPick') ? $('cbPuzzleGapPick').value : 's0';
        if (!key) { this.setStatus('请先在上方选择要删除的一条字幕'); return; }
        this.onSettingCommit();
        const pk = this.template.puzzle || {};
        if (/^[vh]\d+$/.test(key)) { if (pk.gapCaptions) delete pk.gapCaptions[key]; }
        else if (pk.captions) delete pk.captions[parseInt(key.substring(1), 10)];
        if (this._editingGap === key.toUpperCase()) this._editingGap = null;
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        this.setStatus('已删除字幕 ' + key.toUpperCase());
    },

    // 旋转当前格子图片 90°
    rotatePuzzleSlot(i) {
        const pk = this.tplPuzzle();
        if (!pk) return;
        this.onSettingCommit();
        const sc = pk.slots[i] || (pk.slots[i] = {});
        sc.rotate = ((sc.rotate || 0) + 1) % 4;
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus('格子旋转 90°');
    },

    // 重置单个格子的缩放/位置
    resetPuzzleSlot(i) {
        const pk = this.tplPuzzle();
        if (!pk) return;
        this.onSettingCommit();
        const sc = pk.slots[i];
        if (sc) { delete sc.zoom; delete sc.offsetX; delete sc.offsetY; }
        this.saveCurrentTemplate();
        this.setSlotOffsetSliders(sc);
        this.scheduleRender(true);
        this.setStatus('已重置格子 ' + (i + 1));
    },

    // 全部重置:所有格子的缩放/位置/旋转
    resetAllSlots() {
        const pk = this.tplPuzzle();
        if (!pk) return;
        this.onSettingCommit();
        for (const k in pk.slots) {
            const sc = pk.slots[k];
            delete sc.zoom; delete sc.offsetX; delete sc.offsetY; delete sc.rotate;
        }
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus('已重置所有格子');
    },

    // 清空全部格子图片(保留布局/间距/缩放,便于重新放入)
    clearPuzzleSlots() {
        const pk = this.template && this.template.puzzle;
        if (!pk || Object.keys(pk.slots || {}).length === 0) { this.setStatus('格子已是空的'); return; }
        this.onSettingCommit();
        Object.keys(pk.slots).forEach(k => {
            const sc = pk.slots[k];
            if (sc) { sc.imageIndex = undefined; sc.imagePath = undefined; }
        });
        pk.offsetX = 0; pk.offsetY = 0; pk.zoom = 100;
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        this.setStatus('已清空全部格子图片，可重新勾选照片放图');
    },

    // 重拼:按胶片条中勾选的照片顺序填格(勾选不够用当前主图补位,无勾选用主图铺满),
    // 同时重置全部格子的平移/缩放,恢复默认填充状态。会覆盖用户所有手工编辑。
    rePuzzleFill() {
        const pk = this.template && this.template.puzzle;
        if (!pk || !pk.enabled) { this.setStatus('拼图未启用'); return; }
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        const n = this.puzzleSlotCount(pk.layout || 'single');
        const main = this.image ? this.images.indexOf(this.image) : -1;
        const order = this.batchSel.slice();
        this.batchSel = [];
        this.selectedIdx = this.batchSel.slice();
        for (let i = 0; i < n; i++) {
            const idx = i < order.length ? order[i] : main;
            const sc = pk.slots[i] || (pk.slots[i] = {});
            if (idx >= 0) { sc.imageIndex = idx; sc.imagePath = undefined; }
            else { sc.imageIndex = undefined; sc.imagePath = undefined; }
            sc.zoom = 100;
            sc.offsetX = 0;
            sc.offsetY = 0;
        }
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.buildThumbnails();
        this.scheduleRender(true);
        this.setStatus(order.length ? `已按勾选照片顺序重新拼接${n} 个格子，平移/缩放已重置` : '无勾选照片，已用当前主图铺满 ' + n + ' 个格子，平移/缩放已重置');
    },

    // 只清空指定格子的图片(照片仍保留在胶片条,可再放)
    clearSlotImage(i) {
        const pk = this.tplPuzzle();
        if (!pk) return;
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        const sc = pk.slots[i];
        if (sc) { sc.imageIndex = undefined; sc.imagePath = undefined; }
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        this.setStatus('已清空槽位 ' + (i + 1) + '(照片仍保留在胶片条)');
    },

    // 完全退出拼图(回到单照片编辑)
    disablePuzzle() {
        if (!this.template || !this.template.puzzle) return;
        this.onSettingCommit();
        const pk = this.template.puzzle;
        pk.enabled = 0;
        this._puzzleSlot = '';
        this._activePuzzleSlot = null;
        this._puzzleAxisHover = null;
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.toggleCaptionEditor(false);
        this.scheduleRender(true);
        this.setStatus('已退出拼图');
    },

    /* ══ 拼图画布交互(Canva/PicsArt 式:格内平移,拖出格=放下即互换) ══ */
    tplPuzzle() {
        const pk = this.template && this.template.puzzle;
        return (pk && pk.enabled) ? pk : null;
    },

    // 屏幕坐标→画布像素坐标(计入 CSS zoom 与 pan)
    puzzlePx(e) {
        const canvas = this.dom.canvas;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return { x: 0, y: 0 };
        return {
            x: (e.clientX - rect.left) / rect.width * canvas.width,
            y: (e.clientY - rect.top) / rect.height * canvas.height,
        };
    },

    // 命中:分隔线 / 槽位
    puzzleHitTest(e) {
        const pk = this.tplPuzzle();
        if (!pk || !window.__buildPuzzleSlots) return null;
        const p = this.puzzlePx(e);
        // 先检测是否在分隔线附近(屏幕约 ±6px,见 puzzleAxisAtPx)
        const axisHit = this.puzzleAxisAtPx(p.x, p.y);
        if (axisHit) return { type: 'axis', dim: axisHit.dim, idx: axisHit.idx, pos: axisHit.pos, x: p.x, y: p.y };
        const hit = this.puzzleSlotAtPx(p.x, p.y);
        return hit != null ? { type: 'slot', slot: hit, x: p.x, y: p.y } : null;
    },

    // 检测鼠标是否在分隔线(轴线)附近,返回 {dim, idx, pos} 或 null。
    // 容差按屏幕 CSS 像素换算:画布后备缓冲被 DPR/显示缩放放大后,固定 10 个后备像素
    // 在屏幕上只有 2–3px,分隔线几乎点不中。
    puzzleAxisAtPx(x, y) {
        const pk = this.tplPuzzle();
        if (!pk || !pk.layout || pk.layout === 'single') return null;
        const canvas = this.dom.canvas;
        const W = canvas.width, H = canvas.height;
        const rect = canvas.getBoundingClientRect();
        const tol = rect.width > 0 ? Math.max(1, (W / rect.width) * 6) : 10;
        const axes = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(pk.layout, pk.axisVals) : (pk.axisVals || {});
        // 竖轴(v):垂直线,检测 x
        const vList = (axes.v || []);
        for (let i = 0; i < vList.length; i++) {
            const ax = vList[i] * W;
            if (Math.abs(x - ax) <= tol && y > 0 && y < H) return { dim: 'v', idx: i, pos: vList[i] };
        }
        // 横轴(h):水平线,检测 y
        const hList = (axes.h || []);
        for (let i = 0; i < hList.length; i++) {
            const ay = hList[i] * H;
            if (Math.abs(y - ay) <= tol && x > 0 && x < W) return { dim: 'h', idx: i, pos: hList[i] };
        }
        return null;
    },

    // 悬停/拖动分隔线时记录状态,画布上画一条淡蓝高亮线(导出不画)
    _setPuzzleAxisHover(ax) {
        const a = ax ? ax.dim + ax.idx : '';
        const b = this._puzzleAxisHover ? (this._puzzleAxisHover.dim + this._puzzleAxisHover.idx) : '';
        if (a === b) return;
        this._puzzleAxisHover = ax ? { dim: ax.dim, idx: ax.idx } : null;
        this.scheduleRender();
    },

    // 拖拽分隔线:更新轴位。按当前轴列表夹在左右邻轴之间,不跨轴、不留 <12% 的窄格;
    // 按下时记录 grabOff,拖动过程中分隔线不会跳到指针中心。
    puzzleDragAxis(pk, d, e) {
        const W = this.dom.canvas.width, H = this.dom.canvas.height;
        const p = this.puzzlePx(e);
        const axes = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(pk.layout, pk.axisVals) : (pk.axisVals || {});
        const vals = axes[d.dim] || [];
        if (d.idx < 0 || d.idx >= vals.length) return;
        if (!pk.axisVals) pk.axisVals = {};
        const MIN = 0.12;
        const lo = (d.idx > 0 ? vals[d.idx - 1] : 0) + MIN;
        const hi = (d.idx < vals.length - 1 ? vals[d.idx + 1] : 1) - MIN;
        const raw = (d.dim === 'v' ? p.x / W : p.y / H) - (d.grabOff || 0);
        let v = clampNum(raw, Math.max(MIN, lo), Math.min(1 - MIN, hi));
        // 拖到接近默认分割比例时吸附,方便把某条分隔线拖回等高/等宽
        const defs = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(pk.layout, {}) : null;
        const snap = defs && defs[d.dim] ? defs[d.dim][d.idx] : null;
        if (snap != null && snap >= lo && snap <= hi && Math.abs(v - snap) <= 0.015) v = snap;
        vals[d.idx] = v;
        pk.axisVals[d.dim] = vals.slice();
    },

    // 恢复某条分隔线到布局默认比例(双击分隔线 / 右键菜单)
    resetPuzzleAxis(dim, idx) {
        const pk = this.tplPuzzle();
        if (!pk || !window.__clampPuzzleAxes) return;
        const axes = window.__clampPuzzleAxes(pk.layout, pk.axisVals);
        const defs = window.__clampPuzzleAxes(pk.layout, {});
        const list = axes[dim] || [];
        const dlist = defs[dim] || [];
        if (idx < 0 || idx >= list.length || dlist[idx] == null) return;
        this.onSettingCommit();
        list[idx] = dlist[idx];
        const fixed = window.__clampPuzzleAxes(pk.layout, Object.assign({}, pk.axisVals, { [dim]: list }));
        if (!pk.axisVals) pk.axisVals = {};
        pk.axisVals[dim] = fixed[dim];
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus('分隔线已恢复默认比例');
    },

    // 恢复全部分隔线到布局默认比例
    resetPuzzleAxes() {
        const pk = this.tplPuzzle();
        if (!pk) return;
        this.onSettingCommit();
        pk.axisVals = {};
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus('已恢复全部分隔线为默认比例');
    },

    // 画布像素→槽位索引(按引擎可见区域内缩 gap,间隙/边框处返回 null)
    puzzleSlotAtPx(x, y) {
        const pk = this.tplPuzzle();
        if (!pk || !window.__buildPuzzleSlots) return null;
        const W = this.dom.canvas.width, H = this.dom.canvas.height;
        const layout = pk.layout || 'single';
        const axes = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(layout, pk.axisVals) : (pk.axisVals || {});
        const rects = window.__buildPuzzleSlots(layout, axes);
        const gapPx = Math.max(0, (pk.gap == null ? 6 : pk.gap) * (Math.min(W, H) / 1000) * 0.5);
        const shiftX = gapPx / W, shiftY = gapPx / H;
        const EPS = 1e-6;
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            let x0 = r[0], y0 = r[1], x1 = r[0] + r[2], y1 = r[1] + r[3];
            if (x0 <= EPS) x0 += shiftX;
            if (x1 >= 1 - EPS) x1 -= shiftX;
            if (y0 <= EPS) y0 += shiftY;
            if (y1 >= 1 - EPS) y1 -= shiftY;
            const hx0 = x0 * W + gapPx, hy0 = y0 * H + gapPx;
            const hx1 = x1 * W - gapPx, hy1 = y1 * H - gapPx;
            if (x >= hx0 && x <= hx1 && y >= hy0 && y <= hy1) return i;
        }
        return null;
    },

    puzzleSlotAt(e) {
        const p = this.puzzlePx(e);
        return this.puzzleSlotAtPx(p.x, p.y);
    },

    // 该格的图片对象(严格按槽位配置解析;空格返回 null,不再按胶片条顺序兜底)
    puzzleImageFor(pk, i) {
        const srcs = (this.images && this.images.length) ? this.images : (this.image ? [this.image] : []);
        if (!srcs.length) return null;
        const sc = pk.slots[i] || {};
        let im = null;
        if (sc.imageIndex != null && srcs[sc.imageIndex]) im = srcs[sc.imageIndex];
        else if (sc.imagePath) im = srcs.find(x => x.name === sc.imagePath) || null;
        return (im && im.el) ? im : null;
    },

    puzzleImageAt(pk, i) {
        const im = this.puzzleImageFor(pk, i);
        return im ? { iw: im.el.naturalWidth || 1, ih: im.el.naturalHeight || 1 } : { iw: 1, ih: 1 };
    },

    // 该格"可平移余量"(画布像素)
    slotSlackPx(pk, i) {
        if (!window.__puzzleFit) return { x: 0, y: 0 };
        const r = this.slotRectPx(pk, i);
        if (!r) return { x: 0, y: 0 };
        const sc = pk.slots[i] || (pk.slots[i] = {});
        const gap = (this.template && this.template.puzzle && this.template.puzzle.gap) || 6;
        const W = this.dom.canvas.width, H = this.dom.canvas.height;
        const gapPx = Math.max(0, gap * (Math.min(W, H) / 1000) * 0.5);
        const cw = Math.max(1, r.w - gapPx * 2), chh = Math.max(1, r.h - gapPx * 2);
        const im = this.puzzleImageAt(pk, i);
        const fillMode = sc.fillMode || (this.template.puzzle.slotFill) || 'cover';
        const zoom = sc.zoom != null ? sc.zoom : 100;
        const fit = window.__puzzleFit({ x: 0, y: 0, w: cw, h: chh }, im.iw, im.ih, fillMode, zoom, 0, 0);
        if (!fit) return { x: 0, y: 0 };
        return { x: cw - fit.dw, y: chh - fit.dh };
    },

    slotRectPx(pk, i) {
        if (!window.__buildPuzzleSlots) return null;
        const W = this.dom.canvas.width, H = this.dom.canvas.height;
        const axes = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(pk.layout, pk.axisVals) : (pk.axisVals || {});
        const rects = window.__buildPuzzleSlots(pk.layout, axes);
        const r = rects[i];
        if (!r) return null;
        return { x: r[0] * W, y: r[1] * H, w: r[2] * W, h: r[3] * H };
    },

    // 拖拽:格内→图片精确跟随(anchor+余量换算);进入其他格→"放下即互换"预备态
    puzzleDragMove(pk, d, e) {
        // 拖拽分隔线
        if (d.type === 'axis') { this.puzzleDragAxis(pk, d, e); return; }
        this.ensurePuzzleSlotsCount(pk);
        const src = d.slot;
        const p = this.puzzlePx(e);
        const sc = pk.slots[src] || (pk.slots[src] = {});
        const im0 = this.puzzleImageFor(pk, src);
        // 指针在另一格:冻结平移,标记互换目标,抓取预览;但位移过小或仅是蹭过格沿时仍按"格内平移"对待,
        // 避免用户小幅拖动误触"放下即互换"(中途挪出格沿即被误判换图)
        const j = this.puzzleSlotAtPx(p.x, p.y);
        const rr0 = this.slotRectPx(pk, src);
        const travel = Math.hypot(p.x - (d.x0 != null ? d.x0 : p.x), p.y - (d.y0 != null ? d.y0 : p.y));
        const swapThresh = rr0 ? Math.min(rr0.w, rr0.h) * 0.5 : 60;
        // "落入目标中心区"判定:指针需在目标格中央 60% 范围内才视为真正想放下
        let deepIn = false;
        if (j != null && j !== src) {
            const W = this.dom.canvas.width, H = this.dom.canvas.height;
            const rj = this.slotRectPx(pk, j);
            if (rj) {
                const nx = p.x / W, ny = p.y / H;
                const jcx = rj.x / W + rj.w / W / 2, jcy = rj.y / H + rj.h / H / 2;
                const hw = rj.w / W / 2, hh = rj.h / H / 2;
                deepIn = Math.abs(nx - jcx) <= hw * 0.6 && Math.abs(ny - jcy) <= hh * 0.6;
            }
        }
        if (j != null && j !== src && travel >= swapThresh && deepIn) {
            if (d.swap !== j) { d.swap = j; this.dom.canvas.style.cursor = 'alias'; }
            if (im0) {
                const rr = this.slotRectPx(pk, src);
                this._puzzlePick = {
                    mode: 'target', target: j, el: im0.el,
                    iw: im0.el.naturalWidth || 1, ih: im0.el.naturalHeight || 1,
                    w0: rr ? Math.max(1, rr.w) : 1, h0: rr ? Math.max(1, rr.h) : 1,
                };
            }
            return;
        }
        // 间隙/外沿:图片浮空跟手,不互换
        if (j == null) {
            if (d.swap != null) { d.swap = null; this.dom.canvas.style.cursor = 'move'; }
            if (im0) {
                const rr = this.slotRectPx(pk, src);
                this._puzzlePick = {
                    mode: 'float', x: p.x, y: p.y, el: im0.el,
                    iw: im0.el.naturalWidth || 1, ih: im0.el.naturalHeight || 1,
                    w0: rr ? Math.max(1, rr.w) : 1, h0: rr ? Math.max(1, rr.h) : 1,
                };
            }
            return;
        }
        // 回源格:收起草图,重设锚点,继续平移
        if (d.swap != null) { d.swap = null; this.dom.canvas.style.cursor = 'move'; d._anchored = false; }
        this._puzzlePick = null;
        if (!d._anchored) { d._anchored = true; d._ax = p.x; d._ay = p.y; d._oaX = sc.offsetX || 0; d._oaY = sc.offsetY || 0; }
        const slack = this.slotSlackPx(pk, src);
        const mdx = p.x - d._ax, mdy = p.y - d._ay;
        if (Math.abs(slack.x) > 2) sc.offsetX = clampNum(d._oaX + (mdx / slack.x) * 100, -100, 100);
        if (Math.abs(slack.y) > 2) sc.offsetY = clampNum(d._oaY + (mdy / slack.y) * 100, -100, 100);
        // 拖动结果同步到滑块(松手 commit 时会从滑块回写,不同步则会被旧值覆盖)
        this.setSlotOffsetSliders(sc);
    },

    // 互换两格图片(imageIndex/imagePath)
    swapSlotImages(pk, a, b) {
        const sa = pk.slots[a] || (pk.slots[a] = {}), sb = pk.slots[b] || (pk.slots[b] = {});
        const tmpIdx = sa.imageIndex, tmpPath = sa.imagePath;
        sa.imageIndex = sb.imageIndex;
        sa.imagePath = sb.imagePath;
        sb.imageIndex = tmpIdx;
        sb.imagePath = tmpPath;
        // 绑在格子上的字幕跟图:交换两个格子的字幕并更新其门牌号
        if (pk.captions) {
            const ka = String(a), kb = String(b);
            const ta = pk.captions[ka], tb = pk.captions[kb];
            if (tb !== undefined) { pk.captions[ka] = tb; tb.gapId = 'S' + a; } else delete pk.captions[ka];
            if (ta !== undefined) { pk.captions[kb] = ta; ta.gapId = 'S' + b; } else delete pk.captions[kb];
        }
        // 交换淡入动画
        const cv = this.dom.canvas;
        if (cv) {
            cv.style.transition = 'opacity 0.35s ease-out, filter 0.35s ease-out';
            cv.style.opacity = '0.15';
            cv.style.filter = 'blur(3px)';
            requestAnimationFrame(() => requestAnimationFrame(() => {
                cv.style.opacity = '1';
                cv.style.filter = '';
                setTimeout(() => { cv.style.transition = ''; cv.style.opacity = ''; cv.style.filter = ''; }, 400);
            }));
        }
    },

    // 点击图片以外(背景板/格间空隙/分隔线)时取消格子选中:
    // 蓝框消失,滚轮/拖拽/单图滑块回到"整个拼图";若当前下拉选的是间隙字幕则保留,避免把字幕编辑器关掉。
    clearActivePuzzleSlot(silent) {
        const slotKey = typeof this._puzzleSlot === 'string' && /^s\d+$/.test(this._puzzleSlot);
        if (this._activePuzzleSlot == null && !slotKey) return false;
        // 先保存字幕编辑框里尚未提交的内容,再清选中(清完编辑器会收起)
        if (slotKey) this.captureCaptionToModel(this._puzzleSlot);
        this._activePuzzleSlot = null;
        if (slotKey) this._puzzleSlot = '';
        this.refreshPuzzleUI();
        this.scheduleRender();
        if (!silent) this.setStatus('已取消格子选中');
        return true;
    },

    // 点击画布选择当前编辑/渲染的槽位
    setActivePuzzleSlot(i) {
        this._activePuzzleSlot = i;
        const oldKey = this._puzzleSlot;
        if (typeof oldKey === 'string' && /^[vh]\d+$/.test(oldKey)) this.captureGapCaptionToModel(oldKey);
        this._puzzleSlot = 's' + i;
        const pick = this.$('cbPuzzleGapPick');
        if (pick) pick.value = 's' + i;
        this.refreshPuzzleUI();
        this.scheduleRender();
        this.setStatus(`已选中槽位 ${i + 1}`);
    },

    // 胶片条照片→当前选中槽(拼图模式下 buildThumbnails 点击调用)
    assignSlotImage(pk, slotIdx, imgIdx) {
        if (!this.images || this.images[imgIdx] == null) return;
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        const sc = pk.slots[slotIdx] || (pk.slots[slotIdx] = {});
        sc.imageIndex = imgIdx;
        sc.imagePath = undefined;
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        const im = this.images[imgIdx];
        this.setStatus(`槽位 ${slotIdx + 1} 已使用「${im && im.name ? im.name : '照片' + (imgIdx + 1)}」`);
    },

    // 滚轮缩放该格图片(100%–400%,100% 即图片自然铺满格的"最小限度")
    puzzleWheelSlot(i, factor) {
        const pk = this.tplPuzzle();
        if (!pk) return;
        this.ensurePuzzleSlotsCount(pk);
        const sc = pk.slots[i] || (pk.slots[i] = {});
        const cur = sc.zoom != null ? sc.zoom : 100;
        const z = clampNum(Math.round(cur * factor), 100, 400);
        if (Math.abs(z - cur) < 1) return;
        if (!this._wheelUndo) { this._wheelUndo = setTimeout(() => this._wheelUndo = null, 600); this.pushUndo(); }
        sc.zoom = z;
        const sl = this.$('slSlotZoom');
        if (sl) { sl.value = String(z); this.updateLabel('lblSlotZoom', z + '%'); }
        this.saveCurrentTemplate();
        this.scheduleRender();
    },

    // 双击切换该格图片;Ctrl/Shift 双击与前一格交换
    puzzleSwapSlotImage(pk, i, swapWithPrev) {
        const srcs = (this.images && this.images.length) ? this.images : (this.image ? [this.image] : []);
        if (!srcs.length) { this.setStatus('拼图:尚无胶片照片'); return; }
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        if (swapWithPrev) {
            const j = Math.max(0, i - 1);
            if (j !== i && pk.slots[j]) {
                const a = pk.slots[i], b = pk.slots[j];
                const tmp = a.imageIndex != null ? a.imageIndex : a.imagePath || null;
                a.imageIndex = b.imageIndex != null ? b.imageIndex : (b.imagePath != null ? this.images.findIndex(x => x.name === b.imagePath) : null);
                a.imagePath = undefined;
                b.imageIndex = typeof tmp === 'number' ? tmp : (typeof tmp === 'string' ? this.images.findIndex(x => x.name === tmp) : null);
                b.imagePath = undefined;
            }
        } else {
            const sc = pk.slots[i] || (pk.slots[i] = {});
            const cur = sc.imageIndex != null ? sc.imageIndex : (sc.imagePath != null ? this.images.findIndex(x => x.name === sc.imagePath) : 0);
            sc.imageIndex = ((cur == null ? 0 : cur) + 1) % srcs.length;
            sc.imagePath = undefined;
        }
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
    },

    // 桌面右键菜单:画布槽位 / 胶片条缩略图共用
    openCtx(x, y, items) {
        this.closeCtx();
        const m = document.createElement('div');
        m.className = 'ctx-menu';
        items.forEach(it => {
            // 分隔线:第二项为 null/undefined 时渲染为不可点击的分隔条,避免 it[1]() 抛 TypeError
            if (!it || it[1] === null || it[1] === undefined) {
                const s = document.createElement('div');
                s.className = 'ctx-sep';
                m.appendChild(s);
                return;
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = it[0];
            // 第三项可选：悬停说明。多数老菜单没传，保持兼容。
            if (it[2]) b.title = it[2];
            b.addEventListener('click', () => { this.closeCtx(); it[1](); });
            m.appendChild(b);
        });
        document.body.appendChild(m);
        const mw = m.offsetWidth || 0, mh = m.offsetHeight || 0;
        m.style.left = Math.min(x, Math.max(8, window.innerWidth - mw - 8)) + 'px';
        m.style.top = Math.min(y, Math.max(8, window.innerHeight - mh - 8)) + 'px';
        this._ctx = m;
    },

    closeCtx() {
        if (this._ctx) { this._ctx.remove(); this._ctx = null; }
    },

    async exportPuzzle() {
        // 拼图导出跟随导出设置(默认 JPG):此前这里硬编码 PNG,想导 JPG 只能切到别的页签走主导出。
        // 尺寸仍恒 4000(拼图版式坐标固定在 1000 单位),与主导出的「原图尺寸」档一致。
        const fmt = (this.dom.selFormat && this.dom.selFormat.value) || 'jpeg';
        const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[fmt] || 'image/jpeg';
        const ext = fmt === 'jpeg' ? 'jpg' : fmt;
        const qRaw = this.dom.slExportQuality ? parseInt(this.dom.slExportQuality.value, 10) : 92;
        const quality = fmt === 'png' ? 1 : Math.min(1, Math.max(0.6, (qRaw || 92) / 100));
        // 槽位里如果有 RAW，先把参与合成的照片补到全尺寸：拼图成品是 4000px，
        // 用 1600px 代理画进去那几格会明显糊。
        if (this.rawPrepareOutput) await this.rawPrepareOutput([this.image], [this.template]);
        const exportPuzzleNow = () => {
            if (!window.__renderPuzzle) { this.setStatus('拼图渲染不可用'); return Promise.resolve(false); }
            const prev = this.displayMax;
            const prevDpr = this.uiDprOverride;
            const prevScale = this.exportScale;
            this.displayMax = 4000;
            this.uiDprOverride = 1;
            this.exportScale = 4000;
            return (async () => {
                try {
                    await this._awaitFrameRender(true);
                    let src = this.dom.canvas;
                    if (fmt === 'jpeg') {
                        // JPG 不支持透明:与主导出一致,先铺白底再合成
                        const bg = document.createElement('canvas');
                        bg.width = src.width; bg.height = src.height;
                        const bgx = bg.getContext('2d');
                        bgx.fillStyle = '#ffffff';
                        bgx.fillRect(0, 0, bg.width, bg.height);
                        bgx.drawImage(src, 0, 0);
                        src = bg;
                    }
                    return this.applyExportColorSpace(src).toDataURL(mime, quality).split(',')[1];
                } catch (e) {
                    console.error('[exportPuzzle] render failed', e);
                    this.setStatus('导出失败');
                    return false;
                } finally {
                    // 临时档位必须还原:渲染/取数抛错时旧写法 res 永不执行,会把 4000 档永久钉死
                    if (prev === undefined) delete this.displayMax;
                    else this.displayMax = prev;
                    if (prevDpr === undefined) delete this.uiDprOverride;
                    else this.uiDprOverride = prevDpr;
                    if (prevScale === undefined) delete this.exportScale;
                    else this.exportScale = prevScale;
                }
            })();
        };
        const base64 = await exportPuzzleNow();
        if (!base64) {
            // 导出档渲染的最后一帧还留在 canvas 上,重排一帧把预览画回正常档位
            if (this.image) this.scheduleRender(true);
            return;
        }
        const im0 = this.images && this.images.length ? this.images[this.currentIdx != null ? this.currentIdx : 0] : null;
        const pzName = im0 ? (im0.name || 'photo').replace(/\.[^.]+$/, '') : '';
        const filename = pzName ? `${pzName}_拼图.${ext}` : `拼图.${ext}`;
        const r = await window.qingframe.saveImage(base64, filename, this.exportColorSpace());
        if (r) this.setStatus('拼图已导出');
        else this.setStatus('导出失败');
        if (this.image) this.scheduleRender(true);
    }
});

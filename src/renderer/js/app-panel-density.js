'use strict';
/* 参数栏「密度分级 / 低频组折叠 / 页签收纳 / 状态收敛」
 *
 * 编辑页显得拥挤，不是控件多，而是四件事叠在一起：三栏常驻、一页 15 组参数、
 * 两层页签、状态信息四处重复。这里只改「什么时候显示」，不动任何渲染与数据流。
 *
 * 折叠状态走 qingframe.savePrefs（prefs 是字段级合并，不会覆盖界面缩放/主题等），
 * 不用 localStorage：GUI 用例的 get-prefs 一律返回 {}，save-prefs 是空实现，
 * 于是测试里点折叠不会污染下一次运行的初始状态。
 */
(function () {
    // 默认收起的低频组。RAW 显影组不在此列：那组本身就是「让用户看得见状态」的入口。
    const DEFAULT_FOLDS = ['grpMask', 'grpBw', 'grpCb', 'grpGm', 'grpLc', 'grpCal'];
    const DENSITY_KEY = 'panelDensity';   // 'auto' | 'compact' | 'comfortable'
    const FOLDS_KEY = 'panelFolds';       // { groupId: true(收起) / false(展开) }
    const $ = (id) => document.getElementById(id);

    let app = null;
    let densityPref = 'auto';
    let folds = null;      // null = 还没读偏好，按默认值走
    let menuOpen = false;

    function savePrefs(patch) {
        if (!window.qingframe || !window.qingframe.savePrefs) return;
        try { window.qingframe.savePrefs(patch).catch(() => {}); } catch (_) { /* 测试环境无 IPC */ }
    }

    function insp() { return $('inspector'); }

    // ── ① 密度 ─────────────────────────────────────────────────────────
    // --density 只乘纵向间距，不动字号/列宽：字号已经由 --font-scale 统一管，
    // 再叠一层只会让窄栏里的标签和数字打架。
    function currentTab() {
        const t = document.querySelector('#inspTabs .tab[data-tab].active');
        return t ? t.dataset.tab : 'canvas';
    }

    function applyDensity(tab) {
        const el = insp();
        if (!el) return;
        const compact = densityPref === 'compact'
            || (densityPref === 'auto' && (tab || currentTab()) === 'grade');
        el.classList.toggle('density-compact', compact);
    }

    function syncDensityButtons() {
        const map = { auto: 'btnDensityAuto', compact: 'btnDensityCompact', comfortable: 'btnDensityComfortable' };
        for (const [key, id] of Object.entries(map)) {
            const b = $(id);
            if (!b) continue;
            const on = densityPref === key;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }

    // ── ② 折叠 ─────────────────────────────────────────────────────────
    function gradeGroups() {
        return Array.prototype.slice.call(document.querySelectorAll('#panel-grade .param-group[id]'));
    }

    function isDefaultFold(id) { return DEFAULT_FOLDS.indexOf(id) >= 0; }

    function applyFolds() {
        for (const g of gradeGroups()) {
            // folds 为 null 表示还没读过偏好：必须是 undefined 才走默认值，
            // 写成 `folds && folds[id]` 会得到 null，被当成「显式展开」直接放过。
            const saved = folds ? folds[g.id] : undefined;
            const folded = (saved === undefined) ? isDefaultFold(g.id) : !!saved;
            g.classList.toggle('collapsed', folded);
        }
        syncFoldNotice();
    }

    // 用户点组标题后由 app.js 调用：记下这一组的显式状态并写盘。
    function onFoldChange(group) {
        if (!group || !group.id || !group.closest('#panel-grade')) return;
        if (!folds) folds = {};
        folds[group.id] = group.classList.contains('collapsed');
        savePrefs({ [FOLDS_KEY]: folds });
        syncFoldNotice();
    }

    function expandAll() {
        const next = folds ? Object.assign({}, folds) : {};
        for (const g of gradeGroups()) next[g.id] = false;
        folds = next;
        applyFolds();
        savePrefs({ [FOLDS_KEY]: folds });
        if (app && app.setStatus) app.setStatus('已展开全部参数组');
    }

    function resetFolds() {
        folds = {};
        applyFolds();
        savePrefs({ [FOLDS_KEY]: folds });
        if (app && app.setStatus) app.setStatus('低频参数组已恢复默认收起');
    }

    function syncFoldNotice() {
        const box = $('foldNotice');
        if (!box) return;
        const n = gradeGroups().filter((g) => g.classList.contains('collapsed')).length;
        const text = $('foldNoticeText');
        // 组标题本身有展开箭头，提示只报数量，不再重复「点标题展开」。
        if (text) text.textContent = n ? `${n} 组已收起` : '全部参数组已展开';
        // 只在调色页签、且确实有组被收起时出现；其它页签不占空间。
        const show = currentTab() === 'grade' && n > 0;
        box.hidden = !show;
        const btn = $('btnFoldReset');
        if (btn) btn.hidden = !show;
    }

    // 有蒙版时把蒙版组自动展开：草稿还原 / 上次编辑带出蒙版却看不见列表，
    // 会让人以为「蒙版丢了」。用户显式收起过（folds.grpMask === true）不抢他的决定。
    // 蒙版的新建 / 管理入口都在下方「蒙版」折叠组里（直方图卡上不再放 ＋ 蒙版 按钮）。
    function syncMasks(im) {
        const masks = im && im.grade && im.grade.masks;
        if (!masks || !masks.length) return;
        if (folds && folds.grpMask === true) return;
        const g = $('grpMask');
        if (g && g.classList.contains('collapsed')) {
            g.classList.remove('collapsed');
            syncFoldNotice();
        }
    }

    // ── ③ 页签收纳 ─────────────────────────────────────────────────────
    function closeMenu() {
        const menu = $('tabMoreMenu');
        const btn = $('btnTabMore');
        if (menu) menu.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
        menuOpen = false;
    }

    function toggleMenu(force) {
        const menu = $('tabMoreMenu');
        const btn = $('btnTabMore');
        if (!menu || !btn) return;
        const open = force === undefined ? !menuOpen : force;
        menu.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        menuOpen = open;
    }

    // 激活的页签在弹出菜单里时，「更多」按钮直接显示它的名字，
    // 否则用户切到「样式」后看不出自己身在哪个页签。
    function syncMoreLabel() {
        const btn = $('btnTabMore');
        const menu = $('tabMoreMenu');
        if (!btn || !menu) return;
        const active = menu.querySelector('.tab[data-tab].active');
        btn.textContent = active ? (active.textContent.trim() + ' ▾') : '更多 ▾';
        btn.classList.toggle('has-active', !!active);
    }

    function onTab(name) {
        syncMoreLabel();
        closeMenu();
        applyDensity(name);
        syncFoldNotice();
    }

    // ── ④ 状态收敛 ─────────────────────────────────────────────────────
    // 「当前样式」原先是参数栏顶部一条常驻横幅，每个页签都占一行。
    // 现在收进底部状态栏的一个字段，顶部整行还给用户。
    function setStyleLabel(text) {
        const el = $('stStyle');
        if (!el) return;
        el.textContent = text ? '预设 · ' + text : '';
        el.hidden = !text;
    }

    // RAW 状态并进直方图卡右下角：一块地方同时看 EXIF 与显影阶段。
    function setRawTag(im) {
        const tag = $('gradeRawTag');
        if (!tag) return;
        if (!im || !im.raw) { tag.hidden = true; tag.textContent = ''; return; }
        const r = im.raw;
        tag.textContent = r.error ? '显影失败'
            : (r.fullPending ? 'RAW 显影中' : (r.full ? 'RAW 全尺寸' : 'RAW 代理'));
        tag.className = 'histo-raw' + (r.error ? ' is-err' : (r.fullPending ? ' is-busy' : ''));
        tag.hidden = false;
    }

    // ── 初始化 ─────────────────────────────────────────────────────────
    function setPrefs(p) {
        if (!p) return;
        densityPref = ['auto', 'compact', 'comfortable'].indexOf(p[DENSITY_KEY]) >= 0 ? p[DENSITY_KEY] : 'auto';
        if (p[FOLDS_KEY] && typeof p[FOLDS_KEY] === 'object' && !Array.isArray(p[FOLDS_KEY])) {
            folds = Object.assign({}, p[FOLDS_KEY]);
        }
        syncDensityButtons();
        applyDensity();
        applyFolds();
    }

    function init(appRef) {
        app = appRef;
        // 先按默认值落地，避免等异步 prefs 回来之前先看到一屏全展开的参数。
        applyDensity();
        applyFolds();
        syncDensityButtons();

        const btn = $('btnTabMore');
        if (btn) {
            btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
        }
        const menu = $('tabMoreMenu');
        if (menu) {
            menu.addEventListener('click', (e) => {
                if (e.target.closest('.tab[data-tab]')) closeMenu();
            });
        }
        document.addEventListener('click', (e) => {
            if (menuOpen && !(e.target.closest('#tabMoreWrap'))) closeMenu();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) closeMenu(); });
        syncMoreLabel();

        // 「当前样式」不是状态展示而是调色起点：点它去左侧边框列表换底子。
        // 用 span + role=button，避免给状态栏塞一个抢占视觉的按钮样式。
        const styleEl = $('stStyle');
        if (styleEl) {
            const locateStyle = () => {
                if (!app) return;
                if (typeof app.setSideMode === 'function') app.setSideMode('border');
                if (typeof app.buildTree === 'function') app.buildTree('');
            };
            styleEl.addEventListener('click', locateStyle);
            styleEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); locateStyle(); }
            });
        }

        const expand = $('btnExpandAll');
        if (expand) expand.addEventListener('click', expandAll);
        for (const id of ['btnFoldReset', 'btnMenuFoldReset']) {
            const b = $(id);
            if (b) b.addEventListener('click', (e) => { e.stopPropagation(); resetFolds(); closeMenu(); });
        }

        for (const [key, id] of Object.entries({ auto: 'btnDensityAuto', compact: 'btnDensityCompact', comfortable: 'btnDensityComfortable' })) {
            const b = $(id);
            if (!b) continue;
            b.addEventListener('click', () => {
                densityPref = key;
                syncDensityButtons();
                applyDensity();
                savePrefs({ [DENSITY_KEY]: densityPref });
            });
        }
    }

    window.QfsPanelDensity = {
        init, setPrefs, onTab, onFoldChange, syncMasks, setStyleLabel, setRawTag,
        DEFAULT_FOLDS,
        // 测试用：读到当前生效值，不必去猜 CSS class
        state() {
            return {
                density: densityPref,
                compact: !!(insp() && insp().classList.contains('density-compact')),
                folded: gradeGroups().filter((g) => g.classList.contains('collapsed')).map((g) => g.id),
                folds: folds ? Object.assign({}, folds) : null
            };
        }
    };
})();

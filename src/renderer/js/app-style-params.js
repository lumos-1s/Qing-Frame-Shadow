// 样式私有参数的 UI 侧:按 style-params.js 生成控件、绑定、回显、复位、显隐。
//
// 单独成模块,不往 app.js(5000+ 行)里再塞逻辑。app.js 只在四处调它:
//   bind() / refreshUI() / updatePersonalVisibility() / resetBlurAdvanced()
//
// 存量六项(path:'root')的 DOM 行是 index.html 里手写的,这里只认领绑定与显隐,
// 字段名和 id 一律不动 —— 0.1.26 及更早的工程/草稿里调过的参数不会丢。
// 新参数(path:'style')的行由这里动态生成,写进 t.styleParams[STYLE]。
(function () {
    'use strict';
    const api = window.StyleParams;
    if (!api) return;   // 声明表没加载时静默降级,老页面照常跑

    const $ = (id) => document.getElementById(id);
    const bound = new WeakSet();
    let mountedStyle = null;

    const current = (app) => api.styleOf(app.template);
    const ids = (style, p) => {
        if (p.path === 'root') return { row: p.row, slider: p.slider, label: p.valueLabel };
        const stem = `sp_${style}_${p.key}`;
        return { row: `row_${stem}`, slider: `sl_${stem}`, label: `lbl_${stem}` };
    };
    const text = (p, v) => String(v) + (p.unit || '');

    // 只为当前样式生成「新参数」行;切样式时重建,行 id 稳定可测。
    function mount(app, style) {
        const box = $('styleParamsRows');
        if (!box) return false;
        if (mountedStyle === style && box.childElementCount) return false;
        box.textContent = '';
        for (const p of api.styleParams(style)) {
            const id = ids(style, p);
            const row = document.createElement('div');
            row.className = 'param-row';
            row.id = id.row;
            const label = document.createElement('label');
            label.textContent = p.label;
            const sl = document.createElement('input');
            sl.type = 'range';
            sl.className = 'ctl-rng';
            sl.id = id.slider;
            sl.min = p.min; sl.max = p.max; sl.step = p.step; sl.value = p.def;
            sl.title = p.hint || p.label;
            sl.dataset.spKey = p.key;
            const val = document.createElement('span');
            val.className = 'pval';
            val.id = id.label;
            row.appendChild(label); row.appendChild(sl); row.appendChild(val);
            box.appendChild(row);
        }
        mountedStyle = style;
        // 动态行也要拿到「精确数字框 / Shift 微调 / 双击复位」这一整套交互。
        // enhanceRangeRows 是幂等的(已有 .pval-num 的行会跳过),静态行不受影响。
        if (app && typeof app.enhanceRangeRows === 'function') app.enhanceRangeRows();
        return true;
    }

    // 绑定幂等:同一个 input 只挂一次。事件里现取当前样式,避免切样式后闭包写错命名空间。
    function bind(app, style) {
        for (const p of api.forStyle(style)) {
            const id = ids(style, p);
            const sl = $(id.slider);
            if (!sl || bound.has(sl)) continue;
            sl.dataset.spKey = p.key;
            sl.addEventListener('input', () => {
                const st = current(app);
                const spec = api.forStyle(st).find((x) => x.key === sl.dataset.spKey);
                if (!spec || !app.template) return;
                api.set(app.template, st, spec, sl.value);
                if (app.updateLabel) app.updateLabel(id.label, text(spec, sl.value));
                if (app.onSettingChanged) app.onSettingChanged();
            });
            bound.add(sl);
        }
    }

    function refresh(app, style) {
        for (const p of api.forStyle(style)) {
            const id = ids(style, p);
            const sl = $(id.slider);
            const v = api.get(app.template, style, p);
            if (sl) sl.value = v;
            if (app.updateLabel) app.updateLabel(id.label, text(p, v));
        }
    }

    function updateVisibility(app, style) {
        const twoLine = Number((app.template && app.template.paramType) || 0) === 0;
        const declared = api.forStyle(style);
        const visibleKeys = new Set(declared.map((p) => p.key));
        for (const p of declared) {
            const row = $(ids(style, p).row);
            if (!row) continue;
            const show = !(p.twoLineOnly && !twoLine);
            row.style.display = show ? '' : 'none';
        }
        // index.html 里静态存在的存量行不属于当前样式时必须收起，
        // 否则切到别的预设会看到一排「拖了没反应」的滑块。
        const seen = new Set();
        for (const st of Object.keys(api.TABLE)) {
            for (const p of api.TABLE[st]) {
                if (p.path !== 'root' || seen.has(p.row)) continue;
                seen.add(p.row);
                if (visibleKeys.has(p.key)) continue;
                const row = $(p.row);
                if (row) row.style.display = 'none';
            }
        }
        const grp = $('grpStyleParams');
        if (grp) grp.style.display = api.styleParams(style).length ? '' : 'none';
        const title = $('styleParamsTitle');
        if (title) {
            const name = (app.template && app.template.templateName) || style;
            title.textContent = `${name} · 样式参数`;
        }
    }

    const UI = {
        ensure(app) {
            const style = current(app);
            const rebuilt = mount(app, style);
            bind(app, style);
            // 换样式会重建行,新行的数值标签默认是空的 —— 立刻回显一次,
            // 顺便让 updateLabel 把精确数字框同步上。
            if (rebuilt) refresh(app, style);
            const btn = $('btnStyleParamsReset');
            if (btn && !bound.has(btn)) {
                btn.addEventListener('click', () => UI.reset(app));
                bound.add(btn);
            }
            return style;
        },
        bind(app) { UI.ensure(app); },
        refresh(app) {
            const style = UI.ensure(app);
            refresh(app, style);
        },
        reset(app) {
            if (!app.template) return;
            const style = current(app);
            api.reset(app.template, style);
            refresh(app, style);
            if (app.onSettingChanged) app.onSettingChanged();
            if (app.setStatus) app.setStatus('已恢复样式参数默认');
        },
        updateVisibility(app) {
            const style = UI.ensure(app);
            updateVisibility(app, style);
        }
    };

    window.QfsStyleParamsUI = UI;
})();

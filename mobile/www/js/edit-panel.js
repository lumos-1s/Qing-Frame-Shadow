'use strict';
/* 手机版「编辑 › 边框」面板：把桌面散在「画布基本 / 画布边框」两处的控件合成一页。
   只读写 state.template 上的既有字段（layerList/fillConfig/...），
   渲染交给同步过来的引擎；本文件不碰桌面 app.js 的 DOM。 */
(function () {
    let tmpl = null;
    let style = '';
    let ctls = [];

    function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
    function color(v, d) {
        const s = String(v || '').replace('#', '');
        return /^[0-9a-f]{6}$/i.test(s) ? '#' + s : d;
    }

    // 与桌面 app.js applyGlobalMargin 同口径：按参考值等比缩放四边，
    // 缺省参考值取当前边距，保证没有 ref* 的老预设也能直接拖。
    function applyGlobalMargin(t, scale) {
        const m = t.baseMargin || (t.baseMargin = {});
        if (m.refTop == null) {
            m.refTop = m.marginTop != null ? m.marginTop : 80;
            m.refBottom = m.marginBottom != null ? m.marginBottom : 120;
            m.refLeft = m.marginLeft != null ? m.marginLeft : 80;
            m.refRight = m.marginRight != null ? m.marginRight : 80;
        }
        m.marginTop = Math.round((m.refTop || 0) * scale);
        m.marginBottom = Math.round((m.refBottom || 0) * scale);
        m.marginLeft = Math.round((m.refLeft || 0) * scale);
        m.marginRight = Math.round((m.refRight || 0) * scale);
        m.globalMargin = scale;
    }

    function layerOf(t) {
        const list = t.layerList || (t.layerList = []);
        let l = list.find((x) => x && x.visible !== false);
        if (!l) {
            l = list[0] || {};
            list[0] = l; // 样式型预设可能没有 layerList：补一个空层，否则改动写不回模板
        }
        return l;
    }

    function defs(t) {
        const m = t.baseMargin || (t.baseMargin = {});
        const c = t.cornerConfig || (t.cornerConfig = {});
        const l = layerOf(t);
        const f = l.fillConfig || (l.fillConfig = {});
        const s = l.strokeConfig || (l.strokeConfig = {});
        const lc = l.cornerConfig || (l.cornerConfig = {});
        const sg = l.shadowGlowConfig || (l.shadowGlowConfig = {});
        const set = (fn) => (v) => fn(v, t);
        return [
            { g: 'basic', label: '边距大小', type: 'range', min: 20, max: 200, step: 5, unit: '%',
              value: Math.round((m.globalMargin == null ? 1 : m.globalMargin) * 100),
              set: set((v, o) => applyGlobalMargin(o, v / 100)) },
            { g: 'basic', label: '照片缩放', type: 'range', min: 50, max: 200, step: 5, unit: '%',
              value: Math.round((m.imgScale == null ? 1 : m.imgScale) * 100),
              set: set((v, o) => { (o.baseMargin || (o.baseMargin = {})).imgScale = v / 100; }) },
            { g: 'basic', label: '照片位移 X', type: 'range', min: -200, max: 200, step: 5, unit: '',
              value: Math.round(num(m.imgOffsetX, 0)),
              set: set((v, o) => { (o.baseMargin || (o.baseMargin = {})).imgOffsetX = v; }) },
            { g: 'basic', label: '照片位移 Y', type: 'range', min: -200, max: 200, step: 5, unit: '',
              value: Math.round(num(m.imgOffsetY, 0)),
              set: set((v, o) => { (o.baseMargin || (o.baseMargin = {})).imgOffsetY = v; }) },
            { g: 'basic', label: '照片圆角', type: 'range', min: 0, max: 200, step: 2, unit: '',
              only: 'rowCornerRadius', value: Math.round(num(c.cornerRadiusAll, 0)),
              set: set((v, o) => {
                  const cc = o.cornerConfig || (o.cornerConfig = {});
                  cc.cornerRadiusAll = v;
                  cc.cornerRadiusTL = cc.cornerRadiusTR = cc.cornerRadiusBL = cc.cornerRadiusBR = v;
              }) },

            { g: 'fill', label: '填充方式', type: 'select',
              options: [['transparent', '透明'], ['solid', '纯色'], ['gradient', '渐变'], ['texture', '纹理']],
              value: f.fillType || 'transparent',
              set: set((v, o) => { layerOf(o).fillConfig.fillType = v; }) },
            { g: 'fill', label: '填充颜色', type: 'color', value: color(f.fillHex, '#eeeeee'),
              set: set((v, o) => { layerOf(o).fillConfig.fillHex = v.replace('#', ''); }) },
            { g: 'fill', label: '填充透明度', type: 'range', min: 0, max: 100, step: 1, unit: '%',
              value: Math.round(num(f.fillOpacity, 100)),
              set: set((v, o) => { layerOf(o).fillConfig.fillOpacity = v; }) },
            { g: 'fill', label: '渐变角度', type: 'range', min: 0, max: 360, step: 5, unit: '°',
              value: Math.round(num(f.gradientAngle, 45)),
              set: set((v, o) => { layerOf(o).fillConfig.gradientAngle = v; }) },

            { g: 'stroke', label: '描边宽度', type: 'range', min: 0, max: 80, step: 1, unit: '',
              value: Math.round(num(s.strokeWidth, 0)),
              set: set((v, o) => { layerOf(o).strokeConfig.strokeWidth = v; }) },
            { g: 'stroke', label: '描边位置', type: 'select',
              options: [['inside', '内侧'], ['center', '居中'], ['outside', '外侧']],
              value: s.strokePos || 'inside',
              set: set((v, o) => { layerOf(o).strokeConfig.strokePos = v; }) },
            { g: 'stroke', label: '描边颜色', type: 'color', value: color(s.strokeColorHex, '#000000'),
              set: set((v, o) => { layerOf(o).strokeConfig.strokeColorHex = v.replace('#', ''); }) },
            { g: 'stroke', label: '描边透明度', type: 'range', min: 0, max: 100, step: 1, unit: '%',
              value: Math.round(num(s.strokeOpacity, 100)),
              set: set((v, o) => { layerOf(o).strokeConfig.strokeOpacity = v; }) },

            { g: 'corner', label: '边框圆角', type: 'range', min: 0, max: 200, step: 2, unit: '',
              value: Math.round(num(lc.cornerRadiusAll, 0)),
              set: set((v, o) => {
                  const cc = layerOf(o).cornerConfig || (layerOf(o).cornerConfig = {});
                  cc.cornerRadiusAll = v;
                  cc.cornerRadiusTL = cc.cornerRadiusTR = cc.cornerRadiusBL = cc.cornerRadiusBR = v;
              }) },

            { g: 'shadow', label: '阴影透明度', type: 'range', min: 0, max: 100, step: 1, unit: '%',
              value: Math.round(num(sg.shadowOpacity, 35)),
              set: set((v, o) => {
                  const g = layerOf(o).shadowGlowConfig || (layerOf(o).shadowGlowConfig = {});
                  g.shadowOpacity = v; g.shadowEnable = v > 0 ? 1 : 0;
              }) },
            { g: 'shadow', label: '阴影颜色', type: 'color', value: color(sg.shadowColorHex, '#000000'),
              set: set((v, o) => { layerOf(o).shadowGlowConfig.shadowColorHex = v.replace('#', ''); }) },
            { g: 'shadow', label: '阴影模糊', type: 'range', min: 0, max: 100, step: 2, unit: '',
              value: Math.round(num(sg.shadowBlur, 20)),
              set: set((v, o) => { layerOf(o).shadowGlowConfig.shadowBlur = v; }) },
            { g: 'shadow', label: '阴影 X 偏移', type: 'range', min: -60, max: 60, step: 2, unit: '',
              value: Math.round(num(sg.shadowOffsetX, 0)),
              set: set((v, o) => { layerOf(o).shadowGlowConfig.shadowOffsetX = v; }) },
            { g: 'shadow', label: '阴影 Y 偏移', type: 'range', min: -60, max: 60, step: 2, unit: '',
              value: Math.round(num(sg.shadowOffsetY, 8)),
              set: set((v, o) => { layerOf(o).shadowGlowConfig.shadowOffsetY = v; }) },
            { g: 'shadow', label: '发光透明度', type: 'range', min: 0, max: 100, step: 1, unit: '%',
              value: Math.round(num(sg.glowOpacity, 60)),
              set: set((v, o) => {
                  const g = layerOf(o).shadowGlowConfig || (layerOf(o).shadowGlowConfig = {});
                  g.glowOpacity = v; g.glowEnable = v > 0 ? 1 : 0;
              }) },
            { g: 'shadow', label: '发光颜色', type: 'color', value: color(sg.glowColorHex, '#ffffff'),
              set: set((v, o) => { layerOf(o).shadowGlowConfig.glowColorHex = v.replace('#', ''); }) },
            { g: 'shadow', label: '发光模糊', type: 'range', min: 0, max: 120, step: 2, unit: '',
              value: Math.round(num(sg.glowBlur, 30)),
              set: set((v, o) => { layerOf(o).shadowGlowConfig.glowBlur = v; }) }
        ];
    }

    const GROUPS = [
        ['basic', '基础'],
        ['fill', '填充'],
        ['stroke', '描边'],
        ['corner', '边框圆角'],
        ['shadow', '阴影 / 发光']
    ];

    function rowHtml(c) {
        const id = c.id;
        let input = '';
        if (c.type === 'range') {
            input = `<input type="range" data-ctl="${id}" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.value}">`
                + `<output data-out="${id}">${c.value}${c.unit || ''}</output>`;
        } else if (c.type === 'select') {
            input = `<select data-ctl="${id}">` + c.options.map(([v, label]) =>
                `<option value="${v}"${v === c.value ? ' selected' : ''}>${label}</option>`).join('') + `</select>`;
        } else if (c.type === 'color') {
            input = `<input type="color" data-ctl="${id}" value="${c.value}">`;
        }
        return `<div class="ctl-row"><label>${c.label}</label>${input}</div>`
            + (c.hint ? `<p class="ctl-hint">${c.hint}</p>` : '');
    }

    function html(sub, tpl, styleName) {
        tmpl = tpl;
        style = String(styleName || '');
        ctls = [];
        if (sub !== 'border') {
            return `<p class="panel-note">${sub === 'text' ? '文字 / 签名 / EXIF' : sub === 'element' ? 'Logo / 贴纸 / 元素' : '样式管理'}将在后续版本开放。</p>`;
        }
        const rows = window.StyleParams || {};
        const vis = (window.StyleCaps && window.StyleCaps.visibleRows)
            ? window.StyleCaps.visibleRows(style) : {};
        let out = '';
        for (const [key, title] of GROUPS) {
            const list = defs(tmpl).filter((c) => c.g === key && (!c.only || vis[c.only] !== false));
            if (!list.length) continue;
            const body = list.map((c) => {
                c.id = ctls.length;
                ctls.push(c);
                return rowHtml(c);
            }).join('');
            out += `<details class="ctl-group"${key === 'basic' ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
        }
        // 样式私有参数：缺省不写字段，拖过才写进 t.styleParams[STYLE]
        const params = rows.forStyle ? rows.forStyle(style) : [];
        if (params.length) {
            const byGroup = new Map();
            params.forEach((p) => {
                const g = p.group || '样式参数';
                if (!byGroup.has(g)) byGroup.set(g, []);
                byGroup.get(g).push(p);
            });
            let phtml = '';
            byGroup.forEach((list, g) => {
                phtml += `<p class="ctl-sub">${g}</p>`;
                list.forEach((p) => {
                    const c = {
                        id: ctls.length, type: 'range', label: p.label,
                        min: p.min, max: p.max, step: p.step, unit: p.unit || '%',
                        value: rows.get(tmpl, style, p), hint: p.hint,
                        set: (v) => rows.set(tmpl, style, p, v)
                    };
                    ctls.push(c);
                    phtml += rowHtml(c);
                });
            });
            phtml += `<div class="puzzle-acts"><button id="btnBorderParamReset" type="button">恢复样式默认</button></div>`;
            out += `<details class="ctl-group" open><summary>样式参数</summary>${phtml}</details>`;
        }
        return out || '<p class="panel-note">这个风格没有可调参数</p>';
    }

    function bind(panel, onChange, onRebuild) {
        panel.querySelectorAll('[data-ctl]').forEach((el) => {
            const c = ctls[Number(el.dataset.ctl)];
            if (!c) return;
            const ev = (c.type === 'range' || c.type === 'color') ? 'input' : 'change';
            el.addEventListener(ev, () => {
                const v = c.type === 'range' ? Number(el.value) : el.value;
                c.set(v);
                const out = panel.querySelector(`[data-out="${c.id}"]`);
                if (out) out.textContent = v + (c.unit || '');
                onChange();
            });
        });
        const reset = panel.querySelector('#btnBorderParamReset');
        if (reset) reset.addEventListener('click', () => {
            if (window.StyleParams && window.StyleParams.reset) window.StyleParams.reset(tmpl, style);
            onRebuild();
        });
    }

    window.QF_EditPanel = { html, bind };
})();

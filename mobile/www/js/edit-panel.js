'use strict';
/* 手机版「编辑 › 边框」面板：把桌面散在「画布基本 / 画布边框」两处的控件合成一页。
   只读写 state.template 上的既有字段（layerList/fillConfig/...），
   渲染交给同步过来的引擎；本文件不碰桌面 app.js 的 DOM。 */
(function () {
    let tmpl = null;
    let style = '';
    let ctls = [];
    let selectedText = 0;
    let selectedEl = '';
    let draftLogoText = '';
    let info = {};

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

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

    const TEXT_GROUPS = [
        ['free', '自由文字'],
        ['sign', '签名 / 头像'],
        ['exif', 'EXIF 参数'],
        ['param', '参数带']
    ];

    function addText(t) {
        const decor = t.decorConfig || (t.decorConfig = {});
        const lines = decor.textLines || (decor.textLines = []);
        const bw = Math.max(100, Number(info.baseW) || 1000);
        const bh = Math.max(100, Number(info.baseH) || 1000);
        const fs = Math.max(12, Math.round(Math.min(bw, bh) * 0.06));
        lines.push({
            text: '文字', align: 'free',
            x: Math.round(bw / 2), y: Math.round(bh / 2),
            fontFamily: 'Microsoft YaHei', fontSize: fs, fontWeight: 400, letterSpacing: 0,
            colorHex: '#ffffff', opacity: 100, rotation: 0,
            enableShadow: 1, shadowColorHex: '#000000', shadowOpacity: 45,
            shadowBlur: Math.max(2, Math.round(fs * 0.18)),
            shadowOffsetX: 0, shadowOffsetY: Math.max(1, Math.round(fs * 0.05))
        });
        selectedText = lines.length - 1;
    }

    function textDefs(t) {
        const decor = t.decorConfig || (t.decorConfig = {});
        const lines = decor.textLines || (decor.textLines = []);
        const line = lines[selectedText] || null;
        const man = t.manualExif || (t.manualExif = {});
        const bw = Math.max(100, Number(info.baseW) || 1000);
        const bh = Math.max(100, Number(info.baseH) || 1000);
        const out = [];
        const S = (g, label, type, value, setter, extra) =>
            out.push(Object.assign({ g, label, type, value, set: setter }, extra || {}));

        if (line) {
            S('free', '内容', 'text', line.text || '', (v) => { line.text = v; });
            S('free', '字号', 'range', line.fontSize || 48, (v) => { line.fontSize = v; },
                { min: 12, max: 240, step: 1, unit: '' });
            S('free', '颜色', 'color', color(line.colorHex, '#ffffff'), (v) => { line.colorHex = v; });
            S('free', '位置 X', 'range', num(line.x, 0), (v) => { line.x = v; },
                { min: 0, max: bw, step: 5, unit: '' });
            S('free', '位置 Y', 'range', num(line.y, 0), (v) => { line.y = v; },
                { min: 0, max: bh, step: 5, unit: '' });
            S('free', '旋转', 'range', num(line.rotation, 0), (v) => { line.rotation = v; },
                { min: -180, max: 180, step: 5, unit: '°' });
            S('free', '透明度', 'range', num(line.opacity, 100), (v) => { line.opacity = v; },
                { min: 0, max: 100, step: 1, unit: '%' });
        }
        S('sign', '署名内容', 'text', t.userSignature || '', (v) => { t.userSignature = v; });
        S('sign', '署名字体', 'select', t.signFont || 'Courier New', (v) => { t.signFont = v; },
            { options: [['Courier New', 'Courier New'], ['Microsoft YaHei', '微软雅黑'], ['SimSun', '宋体'], ['Trebuchet MS', 'Trebuchet']] });
        S('sign', '署名颜色', 'color', color(t.signColor, '#555555'), (v) => { t.signColor = v; });
        S('sign', '署名大小', 'range', Math.round((t.signSize == null ? 1 : t.signSize) * 100),
            (v) => { t.signSize = v / 100; }, { min: 50, max: 200, step: 5, unit: '%' });
        S('sign', '显示头像', 'check', t.avatarShow !== 0, (v) => { t.avatarShow = v ? 1 : 0; });

        S('exif', 'EXIF 参数条', 'check', (decor.exifAutoText || 0) === 1,
            (v) => { decor.exifAutoText = v ? 1 : 0; });
        S('exif', '等效焦距', 'check', (t.focalEq || 0) === 1, (v) => { t.focalEq = v ? 1 : 0; });
        [['brand', '品牌'], ['model', '型号'], ['focal', '焦距'], ['aperture', '光圈'],
            ['iso', 'ISO'], ['shutter', '快门']].forEach(([k, label]) => {
            S('exif', label, 'text', man[k] || '', (v) => { man[k] = v; });
        });

        S('param', '参数字号', 'range', num(t.paramFontSize, 33), (v) => { t.paramFontSize = v; },
            { min: 12, max: 160, step: 1, unit: '' });
        S('param', '参数位置', 'select', t.paramPosition || 'CENTER', (v) => { t.paramPosition = v; },
            { options: [['CENTER', '居中'], ['LEFT', '左'], ['RIGHT', '右'], ['TOP', '上']] });
        return out;
    }

    function textHtml(t) {
        const decor = t.decorConfig || (t.decorConfig = {});
        const lines = decor.textLines || (decor.textLines = []);
        if (selectedText >= lines.length) selectedText = Math.max(0, lines.length - 1);
        let out = `<div class="text-acts">`
            + `<button id="btnAddText" type="button">＋ 添加文字</button>`
            + (lines.length ? `<button id="btnDeleteText" type="button">删除选中</button>` : '')
            + `</div>`;
        if (lines.length) {
            out += `<div class="chips">` + lines.map((l, i) =>
                `<button class="chip${i === selectedText ? ' active' : ''}" data-text-index="${i}">${esc((l.text || '文字').slice(0, 8))}</button>`
            ).join('') + `</div>`;
        }
        const list = textDefs(t);
        for (const [key, title] of TEXT_GROUPS) {
            const rows = list.filter((c) => c.g === key);
            if (!rows.length) continue;
            const body = rows.map((c) => {
                c.id = ctls.length;
                ctls.push(c);
                return rowHtml(c);
            }).join('');
            out += `<details class="ctl-group"${key === 'free' ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
        }
        return out;
    }

    const SYMBOLS = ['★', '♥', '✦', '✓', '●', '☀'];

    function elemsOf(t) {
        const decor = t.decorConfig || (t.decorConfig = {});
        const logos = t.logoElements || (t.logoElements = []);
        const stickers = decor.stickers || (decor.stickers = []);
        const texts = decor.textLines || (decor.textLines = []);
        const out = [];
        logos.forEach((o, i) => out.push({ key: `logo:${i}`, kind: 'logo', obj: o,
            label: String(o.name || 'Logo').slice(0, 8) }));
        stickers.forEach((o, i) => out.push({ key: `sticker:${i}`, kind: 'sticker', obj: o, label: '贴纸 ' + (i + 1) }));
        texts.forEach((o, i) => {
            if (o.align === 'free') out.push({ key: `text:${i}`, kind: 'text', obj: o,
                label: String(o.text || '文字').slice(0, 8) });
        });
        if (!out.some((e) => e.key === selectedEl)) selectedEl = out.length ? out[0].key : '';
        return out;
    }

    function findEl(list, key) { return list.find((e) => e.key === key) || null; }

    function elPos(e) {
        const o = e.obj;
        if (e.kind === 'logo' && !(typeof o.x === 'number' && typeof o.y === 'number')) {
            return {
                x: Math.round((o.rx == null ? 0.5 : o.rx) * (Number(info.baseW) || 1000)),
                y: Math.round((o.ry == null ? 0.5 : o.ry) * (Number(info.baseH) || 1000))
            };
        }
        return { x: num(o.x, 0), y: num(o.y, 0) };
    }

    function badge(text, symbol) {
        const c = document.createElement('canvas');
        const w = symbol ? 96 : 320, h = 96;
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.font = symbol ? '64px sans-serif' : 'bold 44px "Microsoft YaHei", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = symbol ? 2 : 6;
        g.strokeStyle = 'rgba(0,0,0,.55)';
        g.fillStyle = '#ffffff';
        g.strokeText(symbol || text, w / 2, h / 2);
        g.fillText(symbol || text, w / 2, h / 2);
        return c.toDataURL('image/png');
    }

    function addBadge(t, text, symbol) {
        const bw = Number(info.baseW) || 1000, bh = Number(info.baseH) || 1000;
        const list = t.logoElements || (t.logoElements = []);
        list.push({
            dataUrl: badge(text, symbol),
            name: symbol ? `标记 ${symbol}` : `文字 ${text || 'Logo'}`,
            size: symbol ? 90 : Math.min(240, Math.round(bw * 0.22)),
            opacity: 100, rotation: 0,
            x: Math.round(bw / 2), y: Math.round(bh / 2), z: list.length + 1
        });
        selectedEl = `logo:${list.length - 1}`;
    }

    function addSticker(t, symbol) {
        const decor = t.decorConfig || (t.decorConfig = {});
        const list = decor.stickers || (decor.stickers = []);
        list.push({
            src: badge('', symbol), x: Math.round((Number(info.baseW) || 1000) / 2),
            y: Math.round((Number(info.baseH) || 1000) / 2),
            scale: 1, opacity: 100, rotation: 0, z: list.length + 1
        });
        selectedEl = `sticker:${list.length - 1}`;
    }

    function elDefs(t, cur) {
        const o = cur.obj;
        const pos = elPos(cur);
        const bw = Math.max(100, Number(info.baseW) || 1000);
        const bh = Math.max(100, Number(info.baseH) || 1000);
        const bwRange = bw * 2, bhRange = bh * 2;
        const out = [];
        const S = (label, type, value, setter, extra) =>
            out.push(Object.assign({ g: 'geo', label, type, value, set: setter }, extra || {}));
        S('位置 X', 'range', pos.x, (v) => {
            if (cur.kind === 'logo') { o.rel = 0; o.x = v; }
            else o.x = v;
        }, { min: -bw, max: bwRange, step: 5, unit: '' });
        S('位置 Y', 'range', pos.y, (v) => {
            if (cur.kind === 'logo') { o.rel = 0; o.y = v; }
            else o.y = v;
        }, { min: -bh, max: bhRange, step: 5, unit: '' });
        S('透明度', 'range', num(o.opacity, 100), (v) => { o.opacity = v; },
            { min: 0, max: 100, step: 1, unit: '%' });
        S('旋转', 'range', num(o.rotation, 0), (v) => { o.rotation = v; },
            { min: -180, max: 180, step: 5, unit: '°' });
        if (cur.kind === 'logo') {
            S('大小', 'range', num(o.size, 80), (v) => { o.size = v; },
                { min: 10, max: bwRange, step: 5, unit: '' });
        } else if (cur.kind === 'sticker') {
            S('大小', 'range', Math.round(num(o.scale, 1) * 100), (v) => { o.scale = v / 100; },
                { min: 10, max: 400, step: 5, unit: '%' });
        } else {
            S('字号', 'range', num(o.fontSize, 48), (v) => { o.fontSize = v; },
                { min: 12, max: 240, step: 1, unit: '' });
        }
        return out;
    }

    function elementHtml(t) {
        const list = elemsOf(t);
        const cur = findEl(list, selectedEl);
        let out = `<div class="text-acts">`
            + `<button id="btnAddTextLogo" type="button">＋ 用文字做 Logo</button>`
            + `<button id="btnAddSticker" type="button">＋ 贴纸 ★</button></div>`
            + `<div class="ctl-row"><label>Logo 文字</label><input type="text" data-draft-logo value="${esc(draftLogoText)}"></div>`
            + `<p class="ctl-sub">或加个内置标记 / 贴纸：</p><div class="chips">`
            + SYMBOLS.map((s) => `<button class="chip" data-symbol="${esc(s)}">${esc(s)}</button>`).join('')
            + `</div>`;
        if (!list.length) {
            return out + '<p class="panel-note">还没有 Logo / 贴纸 / 自由文字。添加一个，或去「文字」页加自由文字。</p>';
        }
        out += `<div class="chips">` + list.map((e) =>
            `<button class="chip${e.key === selectedEl ? ' active' : ''}" data-el-key="${esc(e.key)}">${esc(e.label)}</button>`
        ).join('') + `</div><div class="text-acts">`
            + `<button id="btnCopyEl" type="button">复制</button>`
            + `<button id="btnDeleteEl" type="button">删除</button>`
            + `<button id="btnClearEls" type="button">清空</button></div>`;
        if (cur) {
            const rows = elDefs(t, cur).map((c) => {
                c.id = ctls.length;
                ctls.push(c);
                return rowHtml(c);
            }).join('');
            out += `<details class="ctl-group" open><summary>${cur.kind === 'logo' ? 'Logo' : cur.kind === 'sticker' ? '贴纸' : '文字'} 位置与大小</summary>${rows}</details>`;
        }
        return out;
    }

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
        } else if (c.type === 'text') {
            input = `<input type="text" data-ctl="${id}" value="${esc(c.value)}">`;
        } else if (c.type === 'check') {
            input = `<input type="checkbox" data-ctl="${id}"${c.value ? ' checked' : ''}>`;
        }
        return `<div class="ctl-row"><label>${c.label}</label>${input}</div>`
            + (c.hint ? `<p class="ctl-hint">${c.hint}</p>` : '');
    }

    function html(sub, tpl, styleName, extra) {
        tmpl = tpl;
        style = String(styleName || '');
        info = extra || {};
        ctls = [];
        if (sub === 'text') return textHtml(tmpl);
        if (sub === 'element') return elementHtml(tmpl);
        if (sub !== 'border') return '<p class="panel-note">样式管理将在后续版本开放。</p>';
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
            const ev = (c.type === 'select' || c.type === 'check') ? 'change' : 'input';
            el.addEventListener(ev, () => {
                const v = c.type === 'range' ? Number(el.value)
                    : (c.type === 'check' ? el.checked : el.value);
                c.set(v);
                const out = panel.querySelector(`[data-out="${c.id}"]`);
                if (out && c.type === 'range') out.textContent = v + (c.unit || '');
                onChange();
            });
        });
        const reset = panel.querySelector('#btnBorderParamReset');
        if (reset) reset.addEventListener('click', () => {
            if (window.StyleParams && window.StyleParams.reset) window.StyleParams.reset(tmpl, style);
            onRebuild();
        });
        const add = panel.querySelector('#btnAddText');
        if (add) add.addEventListener('click', () => { addText(tmpl); onRebuild(); });
        const del = panel.querySelector('#btnDeleteText');
        if (del) del.addEventListener('click', () => {
            const lines = (tmpl.decorConfig || {}).textLines || [];
            if (lines.length) lines.splice(selectedText, 1);
            selectedText = Math.max(0, selectedText - 1);
            onRebuild();
        });
        panel.querySelectorAll('[data-text-index]').forEach((b) => {
            b.addEventListener('click', () => {
                selectedText = Number(b.dataset.textIndex) || 0;
                onRebuild();
            });
        });

        const draft = panel.querySelector('[data-draft-logo]');
        if (draft) draft.addEventListener('input', () => { draftLogoText = draft.value; });
        const addLogo = panel.querySelector('#btnAddTextLogo');
        if (addLogo) addLogo.addEventListener('click', () => { addBadge(tmpl, draftLogoText); onRebuild(); });
        const addStickerBtn = panel.querySelector('#btnAddSticker');
        if (addStickerBtn) addStickerBtn.addEventListener('click', () => { addSticker(tmpl, '★'); onRebuild(); });
        panel.querySelectorAll('[data-symbol]').forEach((b) => {
            b.addEventListener('click', () => { addBadge(tmpl, '', b.dataset.symbol); onRebuild(); });
        });
        panel.querySelectorAll('[data-el-key]').forEach((b) => {
            b.addEventListener('click', () => { selectedEl = b.dataset.elKey; onRebuild(); });
        });

        const listFor = (kind) => {
            const decor = tmpl.decorConfig || (tmpl.decorConfig = {});
            if (kind === 'logo') return tmpl.logoElements || (tmpl.logoElements = []);
            if (kind === 'sticker') return decor.stickers || (decor.stickers = []);
            return decor.textLines || (decor.textLines = []);
        };
        const copyEl = panel.querySelector('#btnCopyEl');
        if (copyEl) copyEl.addEventListener('click', () => {
            const cur = findEl(elemsOf(tmpl), selectedEl);
            if (cur) {
                const list = listFor(cur.kind);
                const dup = JSON.parse(JSON.stringify(cur.obj));
                const pos = elPos(cur);
                if (cur.kind === 'logo') { dup.rel = 0; dup.x = pos.x + 30; dup.y = pos.y + 30; }
                else { dup.x = pos.x + 30; dup.y = pos.y + 30; }
                list.push(dup);
                selectedEl = `${cur.kind}:${list.length - 1}`;
            }
            onRebuild();
        });
        const delEl = panel.querySelector('#btnDeleteEl');
        if (delEl) delEl.addEventListener('click', () => {
            const cur = findEl(elemsOf(tmpl), selectedEl);
            if (cur) listFor(cur.kind).splice(Number(selectedEl.split(':')[1]), 1);
            selectedEl = '';
            onRebuild();
        });
        const clearEls = panel.querySelector('#btnClearEls');
        if (clearEls) clearEls.addEventListener('click', () => {
            const decor = tmpl.decorConfig || (tmpl.decorConfig = {});
            tmpl.logoElements = [];
            decor.stickers = [];
            decor.textLines = (decor.textLines || []).filter((l) => l.align !== 'free');
            selectedEl = '';
            selectedText = 0;
            onRebuild();
        });
    }

    window.QF_EditPanel = { html, bind };
})();

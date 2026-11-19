// qfs frame —— AI 边框工作流的最小原型（openfilm 思路：可读写、可预览、可自检的纯文本协议）
//
//   节点：一份「边框描述文件」就是一份完整预设 JSON，App 直接能加载、agent 直接能改。
//   两种格式都认：
//     · 图层模式 {templateName, layers:[...]}  ← AI / skill 的产物
//     · 预设模式 {photoFrameStyle / baseMargin / layerList}  ← 内置预设、init 拷出来的底稿
//   子命令：
//     init   <风格名> [-o 路径]              从内置预设拷一份代表出来当工作底稿
//     init   --blank [名字] [-o 路径]         出一份「出生即过体检」的图层骨架
//     check  <frame.json|目录> ...            纯 Node 体检（图层结构/照片槽位/文字约束；预设则查结构/风格/参数），毫秒级
//     preview <frame.json|目录> [--image 图] [--out png|目录]
//                                            用真实引擎渲染成 PNG + 报告渲染期警告（自动转交 Electron）
//
// 隐私：全程本地；--image 只读本地图片转 data URL 喂给离屏渲染，不联网、不上传。
// 用法：node tools/qfs-frame.js <命令> ...
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const FRAMES_DIR = path.join(ROOT, 'frames');
const REGRESS_PAGE = path.join(ROOT, 'design', 'regress.html');
const StyleParams = require(path.join(ROOT, 'src', 'renderer', 'js', 'style-params.js'));
const StyleCaps = require(path.join(ROOT, 'src', 'renderer', 'js', 'style-caps.js'));
// 图层体检复用引擎自己的 normalize / 图元表：校验口径与 App 渲染完全同源，
// 不再维护第二套「什么算合法图层」。
const AiLayers = require(path.join(ROOT, 'src', 'renderer', 'js', 'app-ai-layers.js'));

function parseArgs(argv) {
    const [cmd, ...rest] = argv;
    const opts = { _: [] };
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '-o' || a === '--out') opts.out = rest[++i];
        else if (a === '--image') opts.image = rest[++i];
        else if (a === '--blank') opts.blank = true;
        else opts._.push(a);
    }
    return { cmd, ...opts };
}

// ── blank：给「图层 JSON」用的最小可过体检底稿 ──
// 从零写 JSON 最容易漏 maxW / 多写一个 photo，先给一份能通过 check 的骨架，
// agent 可以改构图、颜色、留白、文字，不必先猜字段。
function blankDoc(name) {
    return {
        _about: '清框影边框描述文件（图层模式）。改完跑 check 体检、preview 看效果；可被 App 直接加载。',
        templateName: name || '未命名边框',
        layers: [
            { type: 'rect', x: 0.04, y: 0.04, w: 0.92, h: 0.92, fill: '#f6f2e9', radius: 0.008 },
            { type: 'photo', x: 0.08, y: 0.08, w: 0.84, h: 0.74, radius: 0.006, fit: 'cover' },
            { type: 'line', x1: 0.08, y1: 0.865, x2: 0.92, y2: 0.865, color: '#c8b491', width: 1 },
            {
                type: 'text', x: 0.08, y: 0.90, text: name || 'QINGFRAME', size: 0.026,
                color: '#5d5344', align: 'left', weight: 600, letterSpacing: 0.08, maxW: 0.5, maxLines: 1
            },
            {
                type: 'text', x: 0.92, y: 0.90, text: '2026', size: 0.022,
                color: '#8a7f6d', align: 'right', maxW: 0.3, maxLines: 1
            }
        ]
    };
}

// ── init：从内置预设里找该风格的代表，拷成工作底稿；--blank 出图层骨架 ──
function init(args) {
    const name = (args._[0] || '').trim();
    if (args.blank) {
        const out = args.out || path.join(FRAMES_DIR, 'a1.json');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (fs.existsSync(out) && !args.out) return die(`目标已存在：${out}（换 -o 指定新文件）`);
        fs.writeFileSync(out, JSON.stringify(blankDoc(name), null, 2) + '\n', 'utf8');
        console.log(`已生成图层底稿 ${path.relative(ROOT, out)}（改完跑 check / preview）`);
        return;
    }
    if (!name) return die('用法：qfs-frame.js init <风格名或预设名> [-o frames/xxx.json]\n      qfs-frame.js init --blank [名字] [-o frames/a1.json]');
    const files = fs.readdirSync(PRESET_DIR).filter((f) => f.endsWith('.json'));
    const presetOf = (f) => {
        try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, f), 'utf8')); } catch (_) { return null; }
    };
    const key = name.toUpperCase();
    // 先按预设名（去扩展名）精确匹配，再按 photoFrameStyle 匹配
    let hit = files.find((f) => f.replace(/\.json$/, '') === name)
        || files.find((f) => {
            const p = presetOf(f);
            return p && String(p.photoFrameStyle || '').toUpperCase() === key;
        });
    if (!hit) return die(`找不到「${name}」对应的内置预设`);
    const preset = presetOf(hit);
    const out = args.out || path.join(FRAMES_DIR, preset.templateName.replace(/[\\/:*?"<>|]/g, '_') + '.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (fs.existsSync(out) && !args.out) return die(`目标已存在：${out}（换 -o 指定新文件）`);
    const doc = Object.assign({ _about: '清框影边框描述文件：改完用 `qfs-frame.js check` 体检、`preview` 看效果。本文件可被 App 直接加载。' }, preset);
    fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log(`已生成 ${path.relative(ROOT, out)}（底稿：${hit}）`);
}

// ── check：纯 Node 体检 ──
// 两套格式分开验：
//   · 图层模式（{layers:[...]}）—— skill 的产物，逐层按引擎 normalize 的口径验；
//   · 预设模式（photoFrameStyle / baseMargin / layerList）—— 内置预设与 init 底稿。
// 以前只有预设模式，图层 JSON 会拿满分（连两个 photo 都放行），等于假绿灯。

const LAYER_FIELDS = {
    rect: ['type', 'x', 'y', 'w', 'h', 'radius', 'fill', 'fillOpacity', 'stroke', 'strokeWidth', 'shadow', 'opacity'],
    circle: ['type', 'cx', 'cy', 'r', 'fill', 'fillOpacity', 'stroke', 'strokeWidth', 'shadow', 'opacity'],
    line: ['type', 'x1', 'y1', 'x2', 'y2', 'color', 'stroke', 'width', 'strokeWidth', 'dash', 'opacity'],
    text: ['type', 'x', 'y', 'text', 'size', 'color', 'font', 'align', 'weight', 'letterSpacing',
        'maxW', 'maxLines', 'opacity', 'shadow'],
    image: ['type', 'src', 'x', 'y', 'w', 'h', 'radius', 'fit', 'opacity'],
    photo: ['type', 'x', 'y', 'w', 'h', 'radius', 'fit']
};
// 最常写错的别名：引擎对未知字段是静默忽略，结果就是「图层凭空消失」。
const FIELD_ALIASES = {
    width: 'w', height: 'h', fontSize: 'size', textSize: 'size', fillColor: 'fill',
    backgroundColor: 'fill', strokeColor: 'stroke', borderColor: 'stroke', lineWidth: 'width',
    position: '（用 x/y）', left: 'x', top: 'y', textAlign: 'align', content: 'text'
};

const isNum = (v) => Number.isFinite(Number(v));
const clamp01n = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function colorOk(v) {
    if (v == null) return true;
    const s = String(v).trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) || /^rgba?\(/i.test(s);
}

function layerBox(l) {
    const n = (v) => Number(v) || 0;
    if (l.type === 'circle') {
        const r = n(l.r);
        return { x: n(l.cx) - r, y: n(l.cy) - r, w: r * 2, h: r * 2 };
    }
    if (l.type === 'line') {
        const x1 = n(l.x1), x2 = n(l.x2), y1 = n(l.y1), y2 = n(l.y2);
        return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
    if (l.type === 'text') {
        const x = n(l.x), y = n(l.y), size = n(l.size) || 0.04;
        const align = ['left', 'center', 'right'].includes(l.align) ? l.align : 'left';
        const mw = n(l.maxW) || (align === 'center' ? Math.min(x, 1 - x) * 2 : align === 'right' ? x : 1 - x);
        const lines = Math.max(1, Math.floor(n(l.maxLines) || 3));
        const h = lines * size * 1.25;
        const left = align === 'center' ? x - mw / 2 : align === 'right' ? x - mw : x;
        return { x: left, y: y - h / 2, w: mw, h };
    }
    return { x: n(l.x), y: n(l.y), w: n(l.w), h: n(l.h) };
}

function overlapRatio(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w <= 0 || h <= 0 || a.w <= 0 || a.h <= 0) return 0;
    return (w * h) / (a.w * a.h);
}

function checkLayerDoc(t) {
    const errors = [];
    const warnings = [];
    const notes = [];
    if (!t.templateName || typeof t.templateName !== 'string') errors.push('缺 templateName（字符串）');
    const rawLayers = Array.isArray(t.layers) ? t.layers : t.aiLayers;
    if (!Array.isArray(rawLayers) || !rawLayers.length) {
        errors.push('layers 不是非空数组');
        return { errors, warnings, notes };
    }
    notes.push(`图层模式：${rawLayers.length} 层，画布比例由 photo 槽位决定`);

    const photos = [];
    const norm = [];
    rawLayers.forEach((l, i) => {
        const at = `第 ${i + 1} 层`;
        if (!l || typeof l !== 'object' || Array.isArray(l)) { errors.push(`${at}不是对象`); norm.push(null); return; }
        const type = String(l.type || '').toLowerCase();
        if (!AiLayers.TYPES.includes(type)) {
            errors.push(`${at} type=${JSON.stringify(l.type)} 不认识（支持 ${AiLayers.TYPES.join(' / ')}）`);
            norm.push(null);
            return;
        }
        const nl = AiLayers.normalize(l);
        if (!nl) { errors.push(`${at}（${type}）字段非法，引擎会跳过`); norm.push(null); return; }
        norm.push(nl);
        const known = LAYER_FIELDS[type] || ['type'];
        for (const k of Object.keys(l)) {
            if (known.includes(k) || k.startsWith('_')) continue;
            const hint = FIELD_ALIASES[k] ? `，应写成 ${FIELD_ALIASES[k]}` : '';
            warnings.push(`${at}（${type}）出现未知字段 ${k}${hint}（引擎会忽略，可能是笔误）`);
        }
        for (const k of ['fill', 'stroke', 'color']) {
            if (l[k] != null && !colorOk(l[k])) warnings.push(`${at} ${k}=${JSON.stringify(l[k])} 不是可识别的颜色`);
        }
        if (type === 'photo') photos.push({ i, l: nl });
        if (type === 'text') {
            if (!String(l.text == null ? '' : l.text).trim()) errors.push(`${at} 文字为空`);
            if (l.size == null) warnings.push(`${at} 缺 size，引擎会按 0.04 画`);
            else if (!isNum(l.size)) errors.push(`${at} size 不是数：${JSON.stringify(l.size)}`);
            else if (Number(l.size) > 1) errors.push(`${at} size=${l.size} 像是像素值；图层模式请用相对画布高的比例（≤0.13）`);
            else if (Number(l.size) > 0.13) errors.push(`${at} size=${l.size} 超过 0.13 上限（硬规则），引擎会夹到 20% 画布高`);
            else if (Number(l.size) < 0.012) warnings.push(`${at} size=${l.size} 偏小，缩略图下会看不清`);
            if (l.maxW == null) errors.push(`${at} 缺 maxW（硬规则：文字必须带 maxW / maxLines）`);
            else if (Number(l.maxW) > 1) warnings.push(`${at} maxW=${l.maxW} 像是像素值；这里要的是占画布宽的比例`);
            if (l.maxLines == null) errors.push(`${at} 缺 maxLines（硬规则：文字必须带 maxW / maxLines）`);
            if (l.letterSpacing != null && Number(l.letterSpacing) > 1) {
                warnings.push(`${at} letterSpacing=${l.letterSpacing} 会被当成像素；建议写相对字号的比例`);
            }
            if (l.align != null && !['left', 'center', 'right'].includes(l.align)) {
                warnings.push(`${at} align=${JSON.stringify(l.align)} 不支持（left / center / right）`);
            }
        }
        const box = layerBox(nl);
        if (type !== 'line') {
            if (box.w <= 0 || box.h <= 0) {
                (type === 'photo' ? errors : warnings).push(`${at}（${type}）宽或高为 0，画不出东西`);
            }
        }
        const out = box.x < -0.002 || box.y < -0.002 || box.x + box.w > 1.002 || box.y + box.h > 1.002;
        if (out) {
            warnings.push(type === 'photo'
                ? `${at}（photo）槽位超出画布 0..1，照片会被裁掉超出部分`
                : `${at}（${type}）超出画布 0..1，引擎会夹住，渲染结果与写的值不同`);
        }
    });

    if (photos.length === 0) errors.push('没有 photo 图层（硬规则：必须有且只有一个）');
    else if (photos.length > 1) {
        errors.push(`有 ${photos.length} 个 photo 图层（第 ${photos.map((p) => p.i + 1).join('、')} 层），只允许一个`);
    }
    const pi = photos.length ? photos[0].i : -1;
    if (pi >= 0) {
        const p = photos[0].l;
        if (!(Number(p.w) > 0 && Number(p.h) > 0)) errors.push('photo 槽位的 w / h 必须大于 0');
        const edge = Math.min(Number(p.x) || 0, Number(p.y) || 0,
            1 - (Number(p.x) + Number(p.w)), 1 - (Number(p.y) + Number(p.h)));
        if (edge < 0.04 - 1e-6) {
            notes.push(`photo 槽位贴边/出血（距边 ${(Math.max(0, edge) * 100).toFixed(1)}%）：如果是故意构图就保留，注意别把主信息挤在同一侧`);
        }
        notes.push(`照片槽位：x=${p.x} y=${p.y} w=${p.w} h=${p.h}（宽高比 ${(p.w / p.h).toFixed(2)}）`);

        let hasBackdrop = false;
        rawLayers.forEach((l, i) => {
            if (i >= pi || !l) return;
            if (String(l.type).toLowerCase() === 'text') {
                warnings.push(`第 ${i + 1} 层文字在 photo 之前，会被照片整个盖住`);
            }
            const nl = norm[i];
            if (nl && (nl.type === 'rect' || nl.type === 'image') && (Number(nl.w) || 0) >= 0.9 && (Number(nl.h) || 0) >= 0.9) hasBackdrop = true;
        });
        if (!hasBackdrop) notes.push('photo 之前没有整幅底色层，画布会露出默认白底');

        const pbox = { x: Number(p.x) || 0, y: Number(p.y) || 0, w: Number(p.w) || 0, h: Number(p.h) || 0 };
        for (let i = pi + 1; i < rawLayers.length; i++) {
            const nl = norm[i];
            if (!nl || (nl.type !== 'rect' && nl.type !== 'circle' && nl.type !== 'image')) continue;
            // 只有描边的框不算「盖住」；image 没有 src 也画不出来。
            if (nl.type === 'image' ? !nl.src : !nl.fill) continue;
            const fillA = nl.fillOpacity != null ? clamp01n(nl.fillOpacity) : 1;
            const alpha = fillA * (nl.opacity != null ? clamp01n(nl.opacity) : 1);
            if (alpha < 0.5) continue;
            const ratio = overlapRatio(layerBox(nl), pbox);
            if (ratio > 0.5) {
                warnings.push(`第 ${i + 1} 层（${nl.type}）不透明覆盖照片 ${Math.round(ratio * 100)}%，违反「不遮照片」`);
            }
        }
    }
    return { errors, warnings, notes };
}

function checkLegacyDoc(t) {
    const issues = [];
    const notes = [];
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
        issues.push('根节点不是对象');
        return { issues, notes, warnings: [] };
    }
    if (!t.templateName || typeof t.templateName !== 'string') issues.push('缺 templateName（字符串）');

    // 风格名是否为引擎支持（MEASURED）或空（走传统 baseMargin/layerList 管线）
    const style = String(t.photoFrameStyle || '').toUpperCase();
    if (style && !Object.prototype.hasOwnProperty.call(StyleCaps.MEASURED, style)) {
        issues.push(`photoFrameStyle="${t.photoFrameStyle}" 不在引擎已知风格表（可能回落原图）`);
    }

    // style-params 声明表：范围/类型 + 默认值自检
    const declared = StyleParams.forStyle(style);
    for (const p of declared) {
        // get 内部已 clamp；这里再对照原始值抓越界/非数
        const rawV = p.path === 'root' ? t[p.key] : (t.styleParams && t.styleParams[style] && t.styleParams[style][p.key]);
        if (rawV != null && !Number.isFinite(Number(rawV))) issues.push(`参数 ${p.key} 不是有限数：${JSON.stringify(rawV)}`);
        if (rawV != null && (Number(rawV) < p.min || Number(rawV) > p.max)) {
            issues.push(`参数 ${p.key}=${rawV} 超出范围 [${p.min},${p.max}]`);
        }
        if (p.path === 'style' && t.styleParams && typeof t.styleParams !== 'object') {
            issues.push('styleParams 不是对象');
        }
    }
    const badDefaults = StyleParams.defaultsOk();
    if (badDefaults.length) issues.push(`默认值与引擎字面量不符：${badDefaults.join('; ')}`);

    // 常见字段类型
    const bm = t.baseMargin || {};
    for (const k of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'imgScale']) {
        if (bm[k] != null && !Number.isFinite(Number(bm[k]))) issues.push(`baseMargin.${k} 不是数：${JSON.stringify(bm[k])}`);
    }
    if (t.layerList != null && !Array.isArray(t.layerList)) issues.push('layerList 不是数组');

    if (declared.length) notes.push(`风格 ${style} 有 ${declared.length} 个可调参数`);
    notes.push(`默认预设 ${Object.keys(StyleCaps.MEASURED).length} 种风格`);
    return { issues, notes, warnings: [] };
}

function collectTargets(args) {
    const files = [];
    for (const p of args._) {
        let st = null;
        try { st = fs.statSync(p); } catch (_) { /* 交给下面报错 */ }
        if (!st) { files.push(p); continue; }
        if (st.isDirectory()) {
            for (const f of fs.readdirSync(p).sort()) {
                if (/\.json$/i.test(f)) files.push(path.join(p, f));
            }
        } else files.push(p);
    }
    return files;
}

function check(args) {
    if (!args._.length) return die('用法：qfs-frame.js check <frame.json|目录> [更多文件...]');
    const files = collectTargets(args);
    if (!files.length) return die('没有找到 .json 文件');
    let bad = 0;
    let errTotal = 0;
    files.forEach((file, idx) => {
        if (idx) console.log('');
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
            console.log(`体检：${path.basename(file)}\n${'─'.repeat(60)}\n  ✗ 读不到文件：${e.message}`);
            bad++; errTotal++;
            process.exitCode = 1;
            return;
        }
        let t;
        try { t = JSON.parse(raw); } catch (e) {
            console.log(`体检：${path.basename(file)}`);
            console.log('─'.repeat(60));
            console.log(`  ✗ JSON 解析失败：${e.message}`);
            bad++; errTotal++;
            process.exitCode = 1;
            return;
        }
        const isLayer = t && typeof t === 'object' && !Array.isArray(t)
            && (t.layers != null || t.aiLayers != null);
        const r = isLayer ? checkLayerDoc(t) : checkLegacyDoc(t);
        const errors = r.errors || r.issues || [];
        const warnings = r.warnings || [];
        console.log(`体检：${path.basename(file)}`);
        console.log('─'.repeat(60));
        r.notes.forEach((n) => console.log('  · ' + n));
        warnings.forEach((w) => console.log('  ! ' + w));
        errors.forEach((e) => console.log('  ✗ ' + e));
        if (errors.length) {
            console.log(`\n✖ ${errors.length} 项错误${warnings.length ? ` / ${warnings.length} 项提醒` : ''}`);
            process.exitCode = 1;
            bad++;
            errTotal += errors.length;
        } else {
            const what = isLayer ? '图层结构、照片槽位、文字约束均正常' : '结构、风格名、参数范围、默认值均正常';
            console.log(`\n✓ 通过：${what}${warnings.length ? `（${warnings.length} 项提醒）` : ''}`);
        }
    });
    if (files.length > 1) {
        console.log(`\n${files.length - bad}/${files.length} 份通过${errTotal ? `，${errTotal} 项错误` : ''}`);
        if (bad) process.exitCode = 1;
    }
}

// ── preview：启隐藏 Electron 加载 regress.html，用真实引擎渲染 ──
function readPhotoData(file) {
    const img = path.resolve(file);
    if (!fs.existsSync(img)) return { error: `图片不存在：${img}` };
    const ext = path.extname(img).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png'
        : ext === '.bmp' ? 'image/bmp' : 'image/png';
    return { data: `data:${mime};base64,` + fs.readFileSync(img).toString('base64') };
}

async function preview(args) {
    if (!args._.length) return die('用法：qfs-frame.js preview <frame.json|目录> [更多文件...] [--image 本地路径] [-o 输出.png|目录]');
    const files = collectTargets(args).filter((f) => /\.json$/i.test(f));
    if (!files.length) return die('没有找到 .json 文件');
    let imageData = null;
    if (args.image) {
        const img = readPhotoData(args.image);
        if (img.error) return die(img.error);
        imageData = img.data;
    }

    const { app, BrowserWindow } = require('electron');
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1000, height: 800, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { backgroundThrottling: false, sandbox: false }
    });
    await win.loadFile(REGRESS_PAGE);
    await sleep(200);
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    if (imageData) await exec(`window.__QR.setPhoto(${JSON.stringify(imageData)})`);

    let failed = 0;
    for (const file of files) {
        let preset;
        try { preset = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
            console.log(`✗ ${path.basename(file)}：JSON 解析失败 ${e.message}`);
            failed++;
            continue;
        }
        let out;
        if (args.out && files.length > 1) {
            fs.mkdirSync(args.out, { recursive: true });
            out = path.join(args.out, path.basename(file, '.json') + '.preview.png');
        } else {
            out = args.out || path.join(path.dirname(file), path.basename(file, '.json') + '.preview.png');
        }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const r = await exec(`window.__QR.renderFrame(${JSON.stringify(preset)})`);
        if (r && r.error) console.log(`渲染警告/错误（${path.basename(file)}）：${r.error}`);
        if (!r || !r.png) { console.log(`✗ ${path.basename(file)}：渲染失败，没有输出 PNG`); failed++; continue; }
        fs.writeFileSync(out, Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
        const mode = r.path === 'layer' ? '图层' : r.path;
        const layers = r.layers ? `  图层=${r.layers}` : '';
        console.log(`预览：${path.relative(ROOT, out)}  ${r.W}×${r.H}${layers}  路径=${mode}`);
    }
    if (!imageData) console.log('（用的是内置合成底图；加 --image 换成真实照片看效果）');
    win.destroy();
    app.exit(failed ? 1 : 0);
}

// 不带参数：打印完整手册（frames/SKILL.md 去掉 frontmatter），让 agent / 人都能自描述地读到全部说明。
function printManual(args) {
    if (args._.length && args._[0] === 'help') {
        // `qfs-frame help <主题>` 预留：现在只支持整体手册，主题参数忽略并提示。
        console.log('（本原型只有一份手册，直接显示全部）\n');
    }
    const manual = path.join(ROOT, 'frames', 'SKILL.md');
    if (!fs.existsSync(manual)) return die(`找不到手册：${manual}`);
    let text = fs.readFileSync(manual, 'utf8');
    // 去掉 YAML frontmatter（--- 包裹的第一段）
    text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    process.stdout.write(text);
}

function die(msg) { console.error('✗ ' + msg); process.exitCode = 1; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
    // run-electron.js 包装时 argv 前面会多出 electron 可执行路径 + 一堆 --开关 + 脚本路径，
    // 直接 node 跑时则没有。统一从第一个已知子命令开始切，避免偏移误判。
    const raw = process.argv.slice(2);
    const start = raw.findIndex((a) => a === 'init' || a === 'check' || a === 'preview');
    const args = parseArgs(start >= 0 ? raw.slice(start) : raw);
    // preview 必须跑在 Electron 里。直接在 node 下调会自动转交给 run-electron，
    // 让 `node tools/qfs-frame.js preview x.json` 和手册里写的一模一样能用。
    if (args.cmd === 'preview' && !process.versions.electron) {
        const { spawnSync } = require('child_process');
        const rest = raw.slice(start >= 0 ? start : 0);
        const r = spawnSync(process.execPath, [path.join(__dirname, 'run-electron.js'), __filename, ...rest],
            { stdio: 'inherit' });
        if (r.error) return die('启动 Electron 失败：' + r.error.message);
        process.exit(typeof r.status === 'number' ? r.status : 1);
    }
    switch (args.cmd) {
        case 'init': return init(args);
        case 'check': return check(args);
        case 'preview': return await preview(args);
        default:
            // 自描述：不带参数就打印完整手册（对标 openfilm 不带参数打印 manual）。
            // 手册唯一来源是 frames/SKILL.md，避免入口与手册两份内容漂移。
            return printManual(args);
    }
}
main().catch((e) => { console.error('✗ ' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });

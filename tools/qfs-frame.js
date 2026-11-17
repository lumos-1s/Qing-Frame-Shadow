// qfs frame —— AI 边框工作流的最小原型（openfilm 思路：可读写、可预览、可自检的纯文本协议）
//
//   节点：一份「边框描述文件」就是一份完整预设 JSON，App 直接能加载、agent 直接能改。
//   子命令：
//     init   <风格名> [-o 路径]              从内置预设拷一份代表出来当工作底稿
//     check  <frame.json>                     纯 Node 体检（结构/风格名/style-params 范围/默认值），毫秒级
//     preview <frame.json> [--image 本地图] [-o out.png]   用真实引擎渲染成 PNG + 报告渲染期警告
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

function parseArgs(argv) {
    const [cmd, ...rest] = argv;
    const opts = { _: [] };
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '-o' || a === '--out') opts.out = rest[++i];
        else if (a === '--image') opts.image = rest[++i];
        else opts._.push(a);
    }
    return { cmd, ...opts };
}

// ── init：从内置预设里找该风格的代表，拷成工作底稿 ──
function init(args) {
    const name = (args._[0] || '').trim();
    if (!name) return die('用法：qfs-frame.js init <风格名或预设名> [-o frames/xxx.json]');
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

// ── check：纯 Node 体检，返回问题数 ──
function check(args) {
    const file = args._[0];
    if (!file) return die('用法：qfs-frame.js check <frame.json>');
    const raw = fs.readFileSync(file, 'utf8');
    let t;
    try { t = JSON.parse(raw); } catch (e) { return die(`JSON 解析失败：${e.message}`); }
    const issues = [];
    const notes = [];

    // 1) 顶层结构
    if (!t || typeof t !== 'object' || Array.isArray(t)) issues.push('根节点不是对象');
    if (!t.templateName || typeof t.templateName !== 'string') issues.push('缺 templateName（字符串）');

    // 2) 风格名是否为引擎支持（MEASURED）或空（走传统 baseMargin/layerList 管线）
    const style = String(t.photoFrameStyle || '').toUpperCase();
    if (style && !Object.prototype.hasOwnProperty.call(StyleCaps.MEASURED, style)) {
        issues.push(`photoFrameStyle="${t.photoFrameStyle}" 不在引擎已知风格表（可能回落原图）`);
    }

    // 3) style-params 声明表：范围/类型 + 默认值自检
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

    // 4) 常见字段类型
    const bm = t.baseMargin || {};
    for (const k of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'imgScale']) {
        if (bm[k] != null && !Number.isFinite(Number(bm[k]))) issues.push(`baseMargin.${k} 不是数：${JSON.stringify(bm[k])}`);
    }
    if (t.layerList != null && !Array.isArray(t.layerList)) issues.push('layerList 不是数组');

    if (declared.length) notes.push(`风格 ${style} 有 ${declared.length} 个可调参数`);
    notes.push(`默认预设 ${Object.keys(StyleCaps.MEASURED).length} 种风格`);

    console.log(`体检：${path.basename(file)}`);
    console.log('─'.repeat(60));
    notes.forEach((n) => console.log('  · ' + n));
    if (issues.length) {
        issues.forEach((it) => console.log('  ✗ ' + it));
        console.log(`\n✖ ${issues.length} 项问题`);
        process.exitCode = 1;
    } else {
        console.log('\n✓ 通过：结构、风格名、参数范围、默认值均正常');
    }
}

// ── preview：启隐藏 Electron 加载 regress.html，用真实引擎渲染 ──
async function preview(args) {
    const file = args._[0];
    if (!file) return die('用法：qfs-frame.js preview <frame.json> [--image 本地路径] [-o out.png]');
    const preset = JSON.parse(fs.readFileSync(file, 'utf8'));
    let imageData = null;
    if (args.image) {
        const img = path.resolve(args.image);
        if (!fs.existsSync(img)) return die(`图片不存在：${img}`);
        const ext = path.extname(img).toLowerCase();
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png'
            : ext === '.bmp' ? 'image/bmp' : 'image/png';
        imageData = `data:${mime};base64,` + fs.readFileSync(img).toString('base64');
    }
    const out = args.out || path.join(path.dirname(file), path.basename(file, '.json') + '.preview.png');

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
    const r = await exec(`window.__QR.renderFrame(${JSON.stringify(preset)})`);
    win.destroy();
    app.exit(0);

    if (r && r.error) {
        console.log(`渲染警告/错误：${r.error}`);
    }
    if (!r || !r.png) return die('渲染失败：没有输出 PNG');
    fs.writeFileSync(out, Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
    console.log(`预览：${path.relative(ROOT, out)}  ${r.W}×${r.H}  路径=${r.path}`);
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

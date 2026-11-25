'use strict';
// 把桌面端的「引擎 + 预设」同步到手机版 www/，保证两边算法只有一份真源。
// 用法：
//   node tools/sync-mobile-engine.js          同步（覆盖）
//   node tools/sync-mobile-engine.js --check  只校验，有差异退出 1（CI 用）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MOBILE = path.join(ROOT, 'mobile', 'www');
const CHECK = process.argv.includes('--check');

// 引擎与纯算法模块：手机端后续按需要加载，这里先保证文件到位。
const JS_FILES = [
    'engine.js',
    'engine-styles.js',
    'presets.js',
    'style-caps.js',
    'style-params.js',
    'exif.js',
    'focal-eq.js',
    'qfs-img.js',
    'app-grade.js',
    'app-acr.js',
    'app-histogram.js',
    'app-clip.js',
    'app-auto-grade.js',
    'app-puzzle.js',
    'app-crop.js',
    'app-export.js',
    'app-state.js',
    'app-render.js',
    'app-view.js',
    'app-elements.js',
    'app-templates.js',
    'app-sync.js',
    'app-grade-presets.js',
    'app-mask.js',
    'app-mix.js',
    'app-curve.js',
    'app-color-grade.js'
];

const PAIRS = [
    ...JS_FILES.map((f) => [path.join(ROOT, 'src', 'renderer', 'js', f), path.join(MOBILE, 'js', f)]),
    [path.join(ROOT, 'src', 'shared', 'color-space.js'), path.join(MOBILE, 'js', 'color-space.js')],
    [path.join(ROOT, 'mobile', 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'), path.join(MOBILE, 'js', 'capacitor.js')]
];

// 从桌面 app.js 直接求值出默认模板，避免手机端另写一份造成漂移。
function defaultTemplateLiteral() {
    const code = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'app.js'), 'utf8');
    const sandbox = {
        window: { App: {}, addEventListener() {} },
        document: { addEventListener() {} },
        localStorage: { getItem() { return null; }, setItem() {} },
        console, setTimeout, clearTimeout
    };
    vm.runInNewContext(code, sandbox);
    return `window.QF_DEFAULT_TEMPLATE = ${JSON.stringify(sandbox.window.App.defaultTemplate())};\n`;
}

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
let bad = 0;

for (const [from, to] of PAIRS) {
    if (!fs.existsSync(from)) {
        console.error(`[sync-mobile-engine] 源文件不存在: ${path.relative(ROOT, from)}`);
        bad++;
        continue;
    }
    if (fs.existsSync(to) && md5(from) === md5(to)) continue;
    if (CHECK) {
        console.error(`[sync-mobile-engine] 不同步: ${path.relative(ROOT, to)}`);
        bad++;
        continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log(`[sync-mobile-engine] 复制 ${path.relative(ROOT, to)}`);
}

// 预设 JSON 随包内置（封面图较大，第一版不复制）
const presetSrc = path.join(ROOT, 'shared', 'presets');
const presetDst = path.join(MOBILE, 'presets');
if (fs.existsSync(presetSrc)) {
    for (const name of fs.readdirSync(presetSrc).filter((n) => n.endsWith('.json'))) {
        const from = path.join(presetSrc, name);
        const to = path.join(presetDst, name);
        if (fs.existsSync(to) && md5(from) === md5(to)) continue;
        if (CHECK) {
            console.error(`[sync-mobile-engine] 预设不同步: ${name}`);
            bad++;
            continue;
        }
        fs.mkdirSync(presetDst, { recursive: true });
        fs.copyFileSync(from, to);
    }
}

// 预设打包成单个 JS，手机端一次读取，避免 91 次 fetch
{
    const src = path.join(presetSrc);
    const names = fs.existsSync(src) ? fs.readdirSync(src).filter((n) => n.endsWith('.json')).sort() : [];
    const list = names.map((n) => JSON.parse(fs.readFileSync(path.join(src, n), 'utf8')));
    list.forEach((p, i) => { p._fileName = names[i].replace(/\.json$/, ''); });
    const literal = `window.QF_PRESETS = ${JSON.stringify(list)};\n`;
    const to = path.join(MOBILE, 'js', 'presets-bundle.js');
    const cur = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : '';
    if (cur !== literal) {
        if (CHECK) { console.error('[sync-mobile-engine] presets-bundle.js 不同步'); bad++; }
        else fs.writeFileSync(to, literal, 'utf8');
    }
}

// 默认模板也从桌面求值生成
{
    const literal = defaultTemplateLiteral();
    const to = path.join(MOBILE, 'js', 'default-template.js');
    const cur = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : '';
    if (cur !== literal) {
        if (CHECK) { console.error('[sync-mobile-engine] default-template.js 不同步'); bad++; }
        else fs.writeFileSync(to, literal, 'utf8');
    }
}

if (CHECK) {
    if (bad) {
        console.error(`[sync-mobile-engine] ${bad} 个文件不同步，请先运行 npm run sync:engine`);
        process.exit(1);
    }
    console.log('[sync-mobile-engine] 校验通过：手机端引擎与桌面端一致');
} else {
    console.log('[sync-mobile-engine] 同步完成');
}

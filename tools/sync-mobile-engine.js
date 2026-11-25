'use strict';
// 把桌面端的「引擎 + 预设」同步到手机版 www/，保证两边算法只有一份真源。
// 用法：
//   node tools/sync-mobile-engine.js          同步（覆盖）
//   node tools/sync-mobile-engine.js --check  只校验，有差异退出 1（CI 用）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    [path.join(ROOT, 'src', 'shared', 'color-space.js'), path.join(MOBILE, 'js', 'color-space.js')]
];

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

if (CHECK) {
    if (bad) {
        console.error(`[sync-mobile-engine] ${bad} 个文件不同步，请先运行 npm run sync:engine`);
        process.exit(1);
    }
    console.log('[sync-mobile-engine] 校验通过：手机端引擎与桌面端一致');
} else {
    console.log('[sync-mobile-engine] 同步完成');
}

// 品牌与图标语言防回归：渲染层与用户可见文档里不许再出现旧品牌名或彩色 emoji。
// ★ / ☆ / ✓ / ⚠ / ✈ 这类字形是有语义的符号（收藏、完成、警示、票根），不在此列。
// signpath/ 下的签名项目名是外部配置，不归本检查管。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const DOCS = ['README.md', 'PRIVACY.md', 'ARCHITECTURE.md', 'THIRD-PARTY-ASSETS.md',
    'assets/readme/hero.svg'];

const LEGACY_BRAND = /Frame Studio|QingFramShadow/gi;
// 只扫彩色图形字符区间（U+1F300–U+1FAFF + 变体选择符），不误伤语义符号。
// 拆成两条是 eslint no-misleading-character-class 的要求（变体选择符不能并进区间）。
const EMOJI = [/[\u{1F300}-\u{1FAFF}]/gu, /\u{FE0F}/gu];

function* filesIn(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* filesIn(full);
        else if (/\.(html|css|js)$/.test(entry.name)) yield full;
    }
}

function main() {
    const files = [...filesIn(RENDERER), ...DOCS.map((f) => path.join(ROOT, f))];
    const errors = [];

    for (const file of files) {
        if (!fs.existsSync(file)) {
            errors.push(`文件不存在：${path.relative(ROOT, file)}`);
            continue;
        }
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
            for (const [name, re] of [['旧品牌名', LEGACY_BRAND], ...EMOJI.map((re, i) => ['彩色 emoji ' + i, re])]) {
                re.lastIndex = 0;
                if (re.test(line)) {
                    errors.push(`${path.relative(ROOT, file)}:${i + 1} ${name}：${line.trim().slice(0, 120)}`);
                }
            }
        });
    }

    if (errors.length) {
        console.error('品牌 / 图标语言校验失败：');
        errors.forEach((e) => console.error('  - ' + e));
        process.exit(1);
    }
    console.log(`品牌 / 图标语言校验通过：${files.length} 个文件，无旧品牌名、无彩色 emoji`);
}

main();

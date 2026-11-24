'use strict';
// Linear 设计语言回归：把 DESIGN.md 里的关键 token 与 style.css 对齐，防止后续改主题时漂移。
// 用法：node tools/test-design-linear.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'css', 'style.css'), 'utf8');
const design = fs.readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf8');
const fails = [];
const ok = (cond, label, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!cond) fails.push(label + (extra ? ': ' + extra : ''));
};

function block(selector) {
    const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm'));
    if (!m) return {};
    const out = {};
    for (const line of m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
}
const dark = block('html.dark');

ok(design.includes('VoltAgent/awesome-design-md') || design.includes('Linear-design-analysis'),
    'DESIGN.md 来自 Linear 设计分析');
ok(dark['--bg'] === '#16171c', '深色画布 = 深石板 #16171c（比 #010102 亮一档）', dark['--bg']);
ok(dark['--surface'] === '#1d2027', '面板 = #1d2027', dark['--surface']);
ok(dark['--border'] === '#363a46', '发丝描边 = #363a46', dark['--border']);
ok(dark['--primary'] === '#7b87e8', '强调色 = 柔化薰衣草蓝 #7b87e8', dark['--primary']);
ok(dark['--primary-strong'] === '#98a3f5', '强调色 hover = #98a3f5', dark['--primary-strong']);
ok(dark['--text'] === '#f0f2f5', '正文 = #f0f2f5', dark['--text']);
ok(dark['--text-3'] === '#9ba1ae', '弱化文字 = #9ba1ae', dark['--text-3']);
ok(dark['--text-2'] === '#c8ccd6', '次级文字 = #c8ccd6', dark['--text-2']);
ok(dark['--shadow'] === 'none' && dark['--shadow-lg'] === 'none',
    '层级靠表面 + 发丝线，不靠投影', dark['--shadow'] + '/' + dark['--shadow-lg']);
ok(css.includes('--font-ui: Inter,') && css.includes('--mono: "JetBrains Mono"'),
    '字体栈 = Inter / JetBrains Mono（Linear 推荐免费替代）');
ok(css.includes(':focus-visible { outline: 2px solid rgba(123,135,232,.6)'),
    '焦点环 = 半透明薰衣草描边');
ok(css.includes('html.dark .tbtn.primary') && css.includes('html.dark .mini-btn.primary'),
    '主按钮填充跟随薰衣草蓝，不残留旧绿色');

console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);

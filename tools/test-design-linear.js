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
ok(dark['--bg'] === '#010102', '深色画布 = Linear #010102', dark['--bg']);
ok(dark['--surface'] === '#0f1011', '面板 = Linear surface-1 #0f1011', dark['--surface']);
ok(dark['--border'] === '#23252a', '发丝描边 = Linear hairline #23252a', dark['--border']);
ok(dark['--primary'] === '#5e6ad2', '强调色 = Linear 薰衣草蓝 #5e6ad2', dark['--primary']);
ok(dark['--primary-strong'] === '#828fff', '强调色 hover = #828fff', dark['--primary-strong']);
ok(dark['--text'] === '#f7f8f8', '正文 = Linear ink #f7f8f8', dark['--text']);
ok(dark['--text-3'] === '#8a8f98', '弱化文字 = Linear ink-subtle #8a8f98', dark['--text-3']);
ok(dark['--text-2'] === '#d0d6e0', '次级文字 = Linear ink-muted #d0d6e0', dark['--text-2']);
ok(dark['--shadow'] === 'none' && dark['--shadow-lg'] === 'none',
    '层级靠表面 + 发丝线，不靠投影', dark['--shadow'] + '/' + dark['--shadow-lg']);
ok(css.includes('--font-ui: Inter,') && css.includes('--mono: "JetBrains Mono"'),
    '字体栈 = Inter / JetBrains Mono（Linear 推荐免费替代）');
ok(css.includes(':focus-visible { outline: 2px solid rgba(94,106,210,.55)'),
    '焦点环 = 半透明薰衣草描边');
ok(css.includes('html.dark .tbtn.primary') && css.includes('html.dark .mini-btn.primary'),
    '主按钮填充跟随薰衣草蓝，不残留旧绿色');

console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);

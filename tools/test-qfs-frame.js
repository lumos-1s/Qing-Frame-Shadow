// qfs-frame 原型回归：init 生成底稿 / check 抓结构·风格·参数问题（纯 Node，毫秒级）。
// preview 走真实引擎，已由 visual-regression 覆盖 __render 路径，且手工验证过合成图与 --image。
// 用法: node tools/test-qfs-frame.js（不需要 run-electron）
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'qfs-frame.js');
const TMP = path.join(ROOT, '.tmp', 'qfs-frame-test');
fs.mkdirSync(TMP, { recursive: true });

const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label);
};
const run = (args) => {
    try {
        const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
};

// 1) init：从风格名生成底稿
const f1 = path.join(TMP, 'from-style.json');
let r = run(['init', 'CARD_3D', '-o', f1]);
check(r.code === 0 && fs.existsSync(f1), 'init 按风格名生成底稿', r.out.trim().slice(0, 120));
const doc = fs.existsSync(f1) ? JSON.parse(fs.readFileSync(f1, 'utf8')) : {};
check(doc.templateName && doc.photoFrameStyle === 'CARD_3D', '底稿含 templateName 与正确的风格名',
    JSON.stringify({ name: doc.templateName, style: doc.photoFrameStyle }));

// 2) check：干净底稿应通过
r = run(['check', f1]);
check(r.code === 0 && /通过/.test(r.out), 'check 对合法底稿报通过', r.out.trim().slice(-80));

// 3) check：未知风格名要报错（非零退出）
const f2 = path.join(TMP, 'bad-style.json');
fs.writeFileSync(f2, JSON.stringify({ templateName: 'x', photoFrameStyle: 'NO_SUCH_STYLE' }), 'utf8');
r = run(['check', f2]);
check(r.code !== 0 && /风格/.test(r.out), 'check 抓未知风格名并非零退出', r.out.trim().slice(-100));

// 4) check：styleParams 参数越界要报错
const f3 = path.join(TMP, 'bad-param.json');
const bad = JSON.parse(fs.readFileSync(f1, 'utf8'));
bad.styleParams = { CARD_3D: { padX: 999 } }; // padX 范围 [5,40]
fs.writeFileSync(f3, JSON.stringify(bad), 'utf8');
r = run(['check', f3]);
check(r.code !== 0 && /越界|范围/.test(r.out), 'check 抓参数越界', r.out.trim().slice(-120));

// 5) check：缺 templateName 要报错
const f4 = path.join(TMP, 'no-name.json');
fs.writeFileSync(f4, JSON.stringify({ photoFrameStyle: 'CARD_3D' }), 'utf8');
r = run(['check', f4]);
check(r.code !== 0 && /templateName/.test(r.out), 'check 抓缺失 templateName', r.out.trim().slice(-100));

// 6) CLI 自描述：不带参数打印完整手册（含图层协议关键段，且不含 frontmatter）
r = run([]);
check(r.code === 0 && /图层/.test(r.out) && /photo/.test(r.out) && /硬规则/.test(r.out) && /maxW/.test(r.out)
    && /构图语法/.test(r.out) && !/^---/.test(r.out.trim()), 'CLI 无参数打印完整手册（去 frontmatter）',
    JSON.stringify({ code: r.code, hasLayers: /图层/.test(r.out), hasPhoto: /photo/.test(r.out), hasRules: /硬规则/.test(r.out) }));

// 7) 入口 skill 结构：skills/qingframe/SKILL.md 有标准 frontmatter
const entrySkill = path.join(ROOT, 'skills', 'qingframe', 'SKILL.md');
const sk = fs.existsSync(entrySkill) ? fs.readFileSync(entrySkill, 'utf8') : '';
check(/^---\r?\n/.test(sk) && /name:\s*qingframe/.test(sk) && /description:/.test(sk)
    && /qfs-frame\.js/.test(sk), '入口 skill 有标准 frontmatter 并指向 CLI',
    JSON.stringify({ exists: !!sk, name: /name:\s*qingframe/.test(sk), pointsToCli: /qfs-frame\.js/.test(sk) }));
check(/check frames\//.test(sk) && /preview frames\//.test(sk) && !/不要跑[^\n]*check/.test(sk),
    '入口 skill 把 check / preview 写进工作流（不再劝退自检）',
    JSON.stringify({ check: /check frames\//.test(sk), preview: /preview frames\//.test(sk) }));
check(/四种不同构图语法|构图先行/.test(sk) && /不要默认/.test(sk),
    '入口 skill 要求四种构图语法并反默认相框',
    JSON.stringify({ families: /四种不同构图语法|构图先行/.test(sk), antiDefault: /不要默认/.test(sk) }));

// 8) 图层模式：init --blank 出的骨架必须过体检（出生即合法）
const f5 = path.join(TMP, 'blank.json');
r = run(['init', '--blank', '暖灰胶片', '-o', f5]);
const blank = fs.existsSync(f5) ? JSON.parse(fs.readFileSync(f5, 'utf8')) : {};
r = run(['check', f5]);
check(r.code === 0 && /通过/.test(r.out) && /图层模式/.test(r.out),
    'init --blank 骨架通过图层体检', r.out.trim().slice(-90));
check(Array.isArray(blank.layers) && blank.layers.filter((l) => l.type === 'photo').length === 1,
    '骨架只有一个 photo 槽位', JSON.stringify({ layers: (blank.layers || []).length }));

// 9) 图层模式：5 个典型错误全部要抓到（旧版 check 在这里是假绿灯）
const f6 = path.join(TMP, 'bad-layers.json');
fs.writeFileSync(f6, JSON.stringify({
    templateName: '坏样例',
    layers: [
        { type: 'rect', x: 0.04, y: 0.04, w: 1.2, h: 0.92, fill: '#f6efe0' },
        { type: 'photo', x: 0.08, y: 0.08, w: 0.84, h: 0.7 },
        { type: 'photo', x: 0.02, y: 0.02, w: 0.3, h: 0.3 },
        { type: 'text', x: 0.5, y: 0.9, text: '溢出画布的标题', size: 0.2, color: '#111' },
        { type: 'blur', x: 0.1, y: 0.1 }
    ]
}, null, 2), 'utf8');
r = run(['check', f6]);
check(r.code !== 0 && /2 个 photo/.test(r.out), 'check 抓多个 photo 槽位', r.out.trim().split('\n').slice(-4).join(' / '));
check(/size=0\.2 超过 0\.13/.test(r.out) && /缺 maxW/.test(r.out) && /缺 maxLines/.test(r.out),
    'check 抓文字超限与缺 maxW / maxLines');
check(/type="blur" 不认识/.test(r.out) && /超出画布/.test(r.out), 'check 抓未知图元与越界');

// 10) 图层模式：错名字段要提醒（width / fontSize 会被引擎静默忽略）
const f7 = path.join(TMP, 'typo-field.json');
fs.writeFileSync(f7, JSON.stringify({
    templateName: '错名',
    layers: [
        { type: 'photo', x: 0.08, y: 0.08, w: 0.84, h: 0.7 },
        { type: 'rect', x: 0.1, y: 0.1, width: 0.2, height: 0.2, fill: '#000' },
        { type: 'text', x: 0.1, y: 0.9, text: 'A', fontSize: 0.03, maxW: 0.4, maxLines: 1 }
    ]
}, null, 2), 'utf8');
r = run(['check', f7]);
check(/未知字段 width/.test(r.out) && /未知字段 fontSize/.test(r.out) && /应写成 w/.test(r.out),
    'check 提醒错名字段并给出正确写法', r.out.trim().split('\n').filter((s) => /未知字段/.test(s)).join(' / '));

// 10b) 海报级展示字（0.12）与照片出血应被允许；贴边只作提示，不当问题
const f8 = path.join(TMP, 'poster.json');
fs.writeFileSync(f8, JSON.stringify({
    templateName: '偏置海报',
    layers: [
        { type: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#101010' },
        { type: 'photo', x: 0, y: 0, w: 0.72, h: 1, fit: 'cover' },
        { type: 'rect', x: 0.72, y: 0, w: 0.28, h: 1, fill: '#f2e4c4' },
        { type: 'text', x: 0.75, y: 0.18, text: '2026', size: 0.12, color: '#1a1a1a', align: 'left', maxW: 0.22, maxLines: 1 }
    ]
}, null, 2), 'utf8');
r = run(['check', f8]);
check(r.code === 0 && /贴边|出血/.test(r.out) && !/✗/.test(r.out),
    '海报级展示字与照片出血可过体检', r.out.trim().split('\n').slice(-4).join(' / '));

// 11) 整批体检：目录里一好一坏，汇总 1/2
const batch = path.join(TMP, 'batch');
fs.mkdirSync(batch, { recursive: true });
fs.writeFileSync(path.join(batch, 'a1.json'), fs.readFileSync(f5, 'utf8'), 'utf8');
fs.writeFileSync(path.join(batch, 'a2.json'), fs.readFileSync(f6, 'utf8'), 'utf8');
r = run(['check', batch]);
check(r.code !== 0 && /1\/2 份通过/.test(r.out), 'check 目录整批并汇总通过数', r.out.trim().slice(-60));

console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;

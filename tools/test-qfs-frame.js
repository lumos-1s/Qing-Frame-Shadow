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

console.log(failures.length ? `\n未通过 ${failures.length} 项：${failures.join(', ')}` : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;

'use strict';
/* 手机版 P0 骨架：只做页面切换与画布占位。
   后续 P1 会用 Capacitor 插件替换 window.qingframe，并接上桌面引擎。 */
(function () {
    const panel = document.getElementById('panel');
    const stageEmpty = document.getElementById('stageEmpty');
    const canvas = document.getElementById('previewCanvas');

    // 画一个占位画面，确认 Canvas 在移动端可用
    function paintPlaceholder() {
        const w = canvas.width = 720, h = canvas.height = 960;
        const g = canvas.getContext('2d');
        const grad = g.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#202422');
        grad.addColorStop(1, '#181B1A');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
        g.strokeStyle = 'rgba(61,217,176,.25)'; g.lineWidth = 2;
        g.strokeRect(40, 40, w - 80, h - 80);
        if (window.__render) {
            stageEmpty.querySelector('span').textContent = '引擎已就绪：' + (typeof window.__render === 'function' ? 'renderToCanvas' : '?');
        }
    }

    const PAGES = {
        style: () => `
            <h2>选一个风格</h2>
            <div class="style-grid">
                ${Array.from({ length: 9 }, (_, i) => `<div class="style-card">风格 ${i + 1}</div>`).join('')}
            </div>
            <button class="primary-btn" id="btnPick">导入照片</button>
            <p class="panel-note">引擎与预设已从桌面端同步；此页在 P2 接入真实风格列表与相册导入。</p>`,
        puzzle: () => `<h2>拼图</h2><p class="panel-note">P3：布局横滑 + 底部相册抽屉 + 格子动作条。</p>`,
        grade: () => `<h2>调色</h2><p class="panel-note">P4：直方图 + 分组滑块 + 溢出按钮 + 自动调色。</p>`,
        crop: () => `<h2>切图</h2><p class="panel-note">P5：九宫格预览 + 勾选块 + 系统分享。</p>`
    };

    function render(name) {
        panel.innerHTML = (PAGES[name] || PAGES.style)();
        document.querySelectorAll('#tabs .tab').forEach((b) => {
            b.classList.toggle('active', b.dataset.tab === name);
        });
        const btn = document.getElementById('btnPick');
        if (btn) btn.addEventListener('click', () => {
            stageEmpty.querySelector('b').textContent = '导入接口将在 P1 接入';
        });
    }

    document.getElementById('tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (tab) render(tab.dataset.tab);
    });
    document.getElementById('btnSettings').addEventListener('click', () => {
        panel.innerHTML = '<h2>设置</h2><p class="panel-note">P1：偏好、主题、内测信息。</p>';
    });

    paintPlaceholder();
    render('style');
    window.QF_MOBILE_READY = true;
})();

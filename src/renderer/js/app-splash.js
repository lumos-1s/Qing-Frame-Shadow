// 启动页面:填充加载进度文案,三路资源(预设/标志/纹理)就绪后淡出
window.App = Object.assign(window.App || {}, {
    // 由 init() 调用一次,注入开始文案并兜底 8 秒强制放行(避免加载异常时卡死)
    initSplash() {
        this._splashDone = false;
        this._splashEl = document.getElementById('splash');
        const st = document.getElementById('splashStatus');
        this._splashStatusEl = st;
        if (st) st.textContent = '正在启动…';
        // 加载兜底:8 秒内无论如何都撤掉启动页
        this._splashFailSafe = setTimeout(() => this.teardownSplash(), 8000);
    },

    // 更新启动页状态文案(用于各加载阶段)
    splashStatus(msg) {
        if (this._splashStatusEl && msg != null) this._splashStatusEl.textContent = msg;
    },

    // 每个异步加载任务完成时调用一次(预设/标志/纹理共 3 次),全部就绪后收起启动页
    splashTick() {
        this._splashTasks = (this._splashTasks || 0) + 1;
        if (this._splashTasks >= 3) this.teardownSplash();
    },

    // 全部资源就绪后调用:淡出并移除启动页
    teardownSplash() {
        if (this._splashDone) return;
        this._splashDone = true;
        clearTimeout(this._splashFailSafe);
        const el = this._splashEl;
        this._splashEl = null;
        if (!el || !el.parentNode) return;
        this.splashStatus('');
        el.classList.add('splash-hide');
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 180);
    }
});
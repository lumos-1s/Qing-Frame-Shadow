/* 发布开关：功能代码已经在仓库里，但还没准备好上线时，先在这里关着。
   - 默认值就是「发版状态」，改这里等于做发布决定；不要在别处散落第二套判断。
   - 测试/开发可临时打开：QfsFeatures.override('aiBreak', true)，只对当前页面有效。
   - 关掉的功能不只是按钮隐藏：入口、设置项、状态栏提示、执行函数都要一起拦住，
     否则用户能在别处看到「还差一个图像模型」这种指向不存在功能的提示。 */
(function () {
    const DEFAULTS = {
        // 整个 AI 窗口（AI 造型 + 拾景纸刊）：本版先不发布。关掉时主工具栏的入口、
        // 窗口本身、里面的 AI 设置与破框都不可达，代码与测试仍留在仓库里。
        aiPanel: false,
        // 窗口里的「AI 破框」：即使窗口以后放出来，它也要等真实 Key 下验过保脸、
        // 耗时与各家网关的兼容性再单独打开。
        aiBreak: false
    };
    const state = Object.assign({}, DEFAULTS);
    window.QfsFeatures = {
        on(name) { return state[name] === true; },
        // 传 null / undefined 复原默认；返回生效后的值
        override(name, value) {
            if (!Object.prototype.hasOwnProperty.call(DEFAULTS, name)) return false;
            state[name] = value == null ? DEFAULTS[name] : !!value;
            return state[name];
        },
        defaults() { return Object.assign({}, DEFAULTS); }
    };
})();

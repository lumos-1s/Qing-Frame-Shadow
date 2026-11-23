/* 发布开关：功能代码已经在仓库里，但还没准备好上线时，先在这里关着。
   - 默认值就是「发版状态」，改这里等于做发布决定；不要在别处散落第二套判断。
   - 测试/开发可临时打开：QfsFeatures.override('aiBreak', true)，只对当前页面有效。
   - 关掉的功能不只是按钮隐藏：入口、设置项、状态栏提示、执行函数都要一起拦住，
     否则用户能在别处看到「还差一个图像模型」这种指向不存在功能的提示。 */
(function () {
    const DEFAULTS = {
        // AI 破框（图像模型直出）：链路是通的，但还没在真实 Key 下验过保脸、
        // 耗时和各家网关的兼容性。先不上线，等真出过几张成片再打开。
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

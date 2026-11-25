'use strict';
/* 在加载 app-grade.js 之前建立最小 App 容器；桌面调色模块会往它上面挂方法。 */
window.App = window.App || {
    dom: {},
    image: null,
    images: [],
    template: null,
    selectedEls: [],
    displayMax: 1600,
    uiDprOverride: 1,
    fitZoom() {},
    applyZoomStyle() {},
    requestRender() {},
    syncGradeUI() {},
    scheduleRender() {},
    scheduleDraft() {},
    setStatus() {}
};

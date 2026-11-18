// 测量专用 preload:提供 App 启动所需的 IPC 桥 + 测试图注入
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('qingframe', {

    // frames 面板测试桥接
    framesList: () => ipcRenderer.invoke('frames:list'),
    framesRead: (n) => ipcRenderer.invoke('frames:read', n),
    framesSave: (n, x) => ipcRenderer.invoke('frames:save', n, x),
    framesDir: () => ipcRenderer.invoke('frames:dir'),
    framesOpenDir: () => ipcRenderer.invoke('frames:openDir'),
    framesWatch: () => ipcRenderer.invoke('frames:watch'),
    framesRemove: (n) => ipcRenderer.invoke('frames:remove', n),
    agentDetect: () => ipcRenderer.invoke('agent:detect'),
    agentStart: (id, skill, rules) => ipcRenderer.invoke('agent:start', id, skill, rules),
    agentPrompt: (key, text) => ipcRenderer.invoke('agent:prompt', key, text),
    agentCancel: (key) => ipcRenderer.invoke('agent:cancel', key),
    agentClose: (key) => ipcRenderer.invoke('agent:close', key),
    agentSetModel: (key, m, v) => ipcRenderer.invoke('agent:setModel', key, m, v),
    agentRun: (id, p) => ipcRenderer.invoke('agent:run', id, p),
    framesSkill: () => ipcRenderer.invoke('frames:skill'),
    onAgentEvent: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('agent-event', h); return () => ipcRenderer.removeListener('agent-event', h); },
    onFramesChanged: (cb) => {
        const h = (_e, p) => cb(p);
        ipcRenderer.on('frames-changed', h);
        return () => ipcRenderer.removeListener('frames-changed', h);
    },

    openImage: () => ipcRenderer.invoke('open-image'),
    openImages: () => ipcRenderer.invoke('open-images'),
    collectImages: (paths) => ipcRenderer.invoke('collect-images', paths),
    // 拖放用例用：和真实 preload 同一条 webUtils 路径（Electron 32 起 File.path 被移除）
    getPathForFile: (file) => {
        try {
            if (webUtils && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file);
        } catch (e) { /* 回退 */ }
        return (file && file.path) || '';
    },
    listPresets: () => ipcRenderer.invoke('list-presets'),
    loadPreset: (name) => ipcRenderer.invoke('load-preset', name),
    saveImage: () => ipcRenderer.invoke('save-image-base64'),
    saveImagesBatch: () => ipcRenderer.invoke('save-images-batch'),
    pickExportLocation: (payload) => ipcRenderer.invoke('pick-export-location', payload),
    writeExportFiles: (payload) => ipcRenderer.invoke('write-export-files', payload),
    showItemInFolder: (p) => ipcRenderer.invoke('show-item-in-folder', p),
    listLogos: () => ipcRenderer.invoke('list-logos'),
    importLogoPack: (filePath) => ipcRenderer.invoke('import-logo-pack', filePath),
    listTextures: () => ipcRenderer.invoke('list-textures'),
    saveTemplate: (n, d) => ipcRenderer.invoke('save-template', { name: n, data: d }),
    listTemplates: () => ipcRenderer.invoke('list-templates'),
    loadTemplate: () => ipcRenderer.invoke('load-template'),
    deleteTemplate: () => ipcRenderer.invoke('delete-template'),
    renameTemplate: () => ipcRenderer.invoke('rename-template'),
    exportTemplate: () => ipcRenderer.invoke('export-template'),
    importTemplate: () => ipcRenderer.invoke('import-template'),
    saveGradePreset: (name, xml) => ipcRenderer.invoke('save-grade-preset', { name, xml }),
    listGradePresets: () => ipcRenderer.invoke('list-grade-presets'),
    loadGradePreset: (name, ext) => ipcRenderer.invoke('load-grade-preset', { name, ext }),
    deleteGradePreset: (name, ext) => ipcRenderer.invoke('delete-grade-preset', { name, ext }),
    renameGradePreset: (oldName, newName) => ipcRenderer.invoke('rename-grade-preset', { oldName, newName }),
    pickGradePresetSavePath: (name) => ipcRenderer.invoke('pick-grade-preset-save-path', name),
    saveGradePresetXmp: (filePath, xml) => ipcRenderer.invoke('save-grade-preset-xmp', { path: filePath, xml }),
    exportGradePresetXmp: (filePath, xml) => ipcRenderer.invoke('export-grade-preset-xmp', { path: filePath, xml }),
    pickGradeXmpFiles: () => ipcRenderer.invoke('pick-grade-xmp-files'),
    openGradePresetsDir: () => ipcRenderer.invoke('open-grade-presets-dir'),
    exportQfs: () => ipcRenderer.invoke('export-qfs'),
    openQfs: () => ipcRenderer.invoke('open-qfs'),
    getUser: () => ipcRenderer.invoke('get-user'),
    saveUser: () => ipcRenderer.invoke('save-user'),
    logoutUser: () => ipcRenderer.invoke('logout-user'),
    getPrefs: () => ipcRenderer.invoke('get-prefs'),
    savePrefs: (p) => ipcRenderer.invoke('save-prefs', p),
    readExif: () => ipcRenderer.invoke('read-exif'),
    loadAcrTables: () => ipcRenderer.invoke('load-acr-tables'),
    loadAcrShadows: () => ipcRenderer.invoke('load-acr-shadows'),
    openStickerImage: () => ipcRenderer.invoke('open-sticker-image'),
    listWallCovers: () => ipcRenderer.invoke('list-wall-covers'),
    openWallCoversDir: () => ipcRenderer.invoke('open-wall-covers-dir'),
    pickWallCover: (name, filePath) => ipcRenderer.invoke('pick-wall-cover', name, filePath),
    clearWallCover: (name) => ipcRenderer.invoke('clear-wall-cover', name)
});

// 测试标记：page 主世界可读。app.js 据此跳过「启动即开预设墙」——
// 老用例是在墙出现之前写的，墙的 fixed 覆盖层会把真实鼠标事件全挡在画布外。
contextBridge.exposeInMainWorld('__qfTest', true);
// 默认测试不恢复开发机上残留的 qfs_last_state（否则上一次手工选过的预设
// 会悄悄改掉每个用例的初始外观）。启动恢复用例用 additionalArguments 打开。
contextBridge.exposeInMainWorld('__qfAllowLastState',
    Array.isArray(process.argv) && process.argv.indexOf('--qf-allow-last-state') !== -1);

contextBridge.exposeInMainWorld('__measure', {
    testImage: () => ipcRenderer.invoke('measure:test-image')
});

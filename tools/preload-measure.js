// 测量专用 preload:提供 App 启动所需的 IPC 桥 + 测试图注入
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('qingframe', {
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
    saveTemplate: () => ipcRenderer.invoke('save-template'),
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

contextBridge.exposeInMainWorld('__measure', {
    testImage: () => ipcRenderer.invoke('measure:test-image')
});

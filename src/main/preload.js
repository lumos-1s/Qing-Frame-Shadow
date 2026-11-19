const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('qingframe', {
    openImage: () => ipcRenderer.invoke('open-image'),
    openImages: () => ipcRenderer.invoke('open-images'),
    openImageFolder: () => ipcRenderer.invoke('open-image-folder'),
    collectImages: (paths) => ipcRenderer.invoke('collect-images', paths),
    readClipboardImage: () => ipcRenderer.invoke('read-clipboard-image'),
    // Electron 32 起 File.path 被移除;统一走 webUtils,旧版本回退到 file.path
    getPathForFile: (file) => {
        try {
            if (webUtils && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file);
        } catch (e) { /* 回退 */ }
        return (file && file.path) || '';
    },
    listPresets: () => ipcRenderer.invoke('list-presets'),
    loadPreset: (name) => ipcRenderer.invoke('load-preset', name),
    // AI 边框协作面板
    framesList: () => ipcRenderer.invoke('frames:list'),
    framesRead: (name) => ipcRenderer.invoke('frames:read', name),
    framesSave: (name, text) => ipcRenderer.invoke('frames:save', name, text),
    framesDir: () => ipcRenderer.invoke('frames:dir'),
    framesRemove: (name) => ipcRenderer.invoke('frames:remove', name),
    framesSkill: () => ipcRenderer.invoke('frames:skill'),
    framesOpenDir: () => ipcRenderer.invoke('frames:openDir'),
    framesWatch: () => ipcRenderer.invoke('frames:watch'),
    agentDetect: () => ipcRenderer.invoke('agent:detect'),
    agentRun: (id, prompt) => ipcRenderer.invoke('agent:run', id, prompt),
    agentStart: (id, skill, rules) => ipcRenderer.invoke('agent:start', id, skill, rules),
    agentPrompt: (key, text) => ipcRenderer.invoke('agent:prompt', key, text),
    agentCancel: (key) => ipcRenderer.invoke('agent:cancel', key),
    agentSetModel: (key, modelId, value) => ipcRenderer.invoke('agent:setModel', key, modelId, value),
    agentClose: (key) => ipcRenderer.invoke('agent:close', key),
    // API 通道：免装本机 CLI，key 只在主进程里用
    aiChat: (cfg, messages) => ipcRenderer.invoke('ai:chat', cfg, messages),
    aiModels: (cfg) => ipcRenderer.invoke('ai:models', cfg),
    aiImage: (cfg, params) => ipcRenderer.invoke('ai:image', cfg, params),
    zineImport: (dataUrl, filename) => ipcRenderer.invoke('zine:import', dataUrl, filename),
    onAgentEvent: (cb) => {
        const h = (_e, payload) => cb(payload);
        ipcRenderer.on('agent-event', h);
        return () => ipcRenderer.removeListener('agent-event', h);
    },
    onFramesChanged: (cb) => {
        const h = (_e, payload) => cb(payload);
        ipcRenderer.on('frames-changed', h);
        return () => ipcRenderer.removeListener('frames-changed', h);
    },
    loadAllPresets: () => ipcRenderer.invoke('load-all-presets'),
    saveImage: (data, filename) => ipcRenderer.invoke('save-image-base64', { data, filename }),
    saveImagesBatch: (files) => ipcRenderer.invoke('save-images-batch', files),
    pickExportLocation: (payload) => ipcRenderer.invoke('pick-export-location', payload),
    pickDefaultExportDir: () => ipcRenderer.invoke('pick-default-export-dir'),
    writeExportFiles: (payload) => ipcRenderer.invoke('write-export-files', payload),
    listLogos: () => ipcRenderer.invoke('list-logos'),
    importLogoPack: (filePath) => ipcRenderer.invoke('import-logo-pack', filePath),
    openLogoDir: () => ipcRenderer.invoke('open-logo-dir'),
    listCustomIcons: () => ipcRenderer.invoke('list-custom-icons'),
    deleteCustomIcon: (dataUrl) => ipcRenderer.invoke('delete-custom-icon', dataUrl),
    renameCustomIcon: (dataUrl, name) => ipcRenderer.invoke('rename-custom-icon', dataUrl, name),
    listTextures: () => ipcRenderer.invoke('list-textures'),
    listMarks: () => ipcRenderer.invoke('list-marks'),
    saveTemplate: (name, data) => ipcRenderer.invoke('save-template', { name, data }),
    listTemplates: () => ipcRenderer.invoke('list-templates'),
    loadTemplate: (name) => ipcRenderer.invoke('load-template', name),
    deleteTemplate: (name) => ipcRenderer.invoke('delete-template', name),
    renameTemplate: (oldName, newName) => ipcRenderer.invoke('rename-template', { oldName, newName }),
    exportTemplate: (name, data) => ipcRenderer.invoke('export-template', { name, data }),
    importTemplate: () => ipcRenderer.invoke('import-template'),
    // 调色预设（只存全局调色参数，不含蒙版；与样式模板分库）
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
    importXmp: () => ipcRenderer.invoke('import-xmp'),
    exportQfs: (data) => ipcRenderer.invoke('export-qfs', data),
    // 流式 .qfs:先 begin(选位置),逐张 add,最后 finish 拼装;失败时 cancel 清临时文件
    qfsBeginExport: (meta) => ipcRenderer.invoke('qfs-begin-export', meta),
    qfsAddImage: (payload) => ipcRenderer.invoke('qfs-add-image', payload),
    qfsFinishExport: (id) => ipcRenderer.invoke('qfs-finish-export', id),
    qfsCancelExport: (id) => ipcRenderer.invoke('qfs-cancel-export', id),
    openQfs: () => ipcRenderer.invoke('open-qfs'),
    getUser: () => ipcRenderer.invoke('get-user'),
    saveUser: (user) => ipcRenderer.invoke('save-user', user),
    logoutUser: () => ipcRenderer.invoke('logout-user'),
    getPrefs: () => ipcRenderer.invoke('get-prefs'),
    savePrefs: (prefs) => ipcRenderer.invoke('save-prefs', prefs),
    // 草稿里的大 data: 图片搬到 userData/draft-assets,避免 localStorage 超限后静默丢图
    externalizeDraft: (draft) => ipcRenderer.invoke('draft-externalize', draft),
    hydrateDraft: (draft) => ipcRenderer.invoke('draft-hydrate', draft),
    clearDraftAssets: () => ipcRenderer.invoke('draft-clear-assets'),
    // 更新下载源（空 = GitHub 直连）；清单与校验值始终来自 GitHub
    setUpdateMirror: (url) => ipcRenderer.invoke('set-update-mirror', url),
    readExif: (filePath) => ipcRenderer.invoke('read-exif', filePath),
    // ACR 实测查找表（调色管线 ground truth，见 app-acr.js）
    loadAcrTables: () => ipcRenderer.invoke('load-acr-tables'),
    // 阴影的空间自适应系数（见 app-acr-shadows.js）
    loadAcrShadows: () => ipcRenderer.invoke('load-acr-shadows'),
    openStickerImage: () => ipcRenderer.invoke('open-sticker-image'),
    getAppInfo: () => ipcRenderer.invoke('get-app-info'),
    // 给渲染层同步判断平台用;不需要异步 invoke 就能决定快捷键显示/行为
    platform: process.platform,
    isMac: process.platform === 'darwin',
    showItemInFolder: (p) => ipcRenderer.invoke('show-item-in-folder', p),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    openDataDir: () => ipcRenderer.invoke('open-data-dir'),
    listWallCovers: () => ipcRenderer.invoke('list-wall-covers'),
    openWallCoversDir: () => ipcRenderer.invoke('open-wall-covers-dir'),
    pickWallCover: (name, filePath) => ipcRenderer.invoke('pick-wall-cover', name, filePath),
    clearWallCover: (name) => ipcRenderer.invoke('clear-wall-cover', name),
    copyText: (text) => ipcRenderer.invoke('copy-text', text),
    copyImage: (dataUrl) => ipcRenderer.invoke('copy-image', dataUrl),
    saveDiagnosticsFile: (text) => ipcRenderer.invoke('save-diagnostics', text),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    startUpdateDownload: () => ipcRenderer.invoke('start-update-download'),
    quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
    onUpdaterEvent: (cb) => {
        const l = (_e, payload) => cb(payload);
        ipcRenderer.on('updater:event', l);
        return () => ipcRenderer.removeListener('updater:event', l);
    },
    onExportProgress: (cb) => {
        const l = (_e, payload) => cb(payload);
        ipcRenderer.on('export-progress', l);
        return () => ipcRenderer.removeListener('export-progress', l);
    },
    // 自定义标题栏窗口控制
    winControls: {
        minimize: () => ipcRenderer.send('win-minimize'),
        toggleMaximize: () => ipcRenderer.send('win-toggle-max'),
        toggleFullScreen: () => ipcRenderer.send('win-toggle-fullscreen'),
        close: () => ipcRenderer.send('win-close'),
        onMaximizedChange: (cb) => {
            const l = (_e, v) => cb(v);
            ipcRenderer.on('win-maximized', l);
            return () => ipcRenderer.removeListener('win-maximized', l);
        },
        onFullScreenChange: (cb) => {
            const l = (_e, v) => cb(v);
            ipcRenderer.on('win-fullscreen', l);
            return () => ipcRenderer.removeListener('win-fullscreen', l);
        }
    }
});
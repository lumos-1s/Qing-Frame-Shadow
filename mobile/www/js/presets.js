// 通过 IPC(主进程 fs)加载预设 JSON
// 优先走合并通道 load-all-presets:一次往返读完 78 个预设(主进程并发读盘),
// 替代原来的「1 次 list + 78 次 load-preset」往返。
// 测试用的 preload 桥(tools/preload-measure.js)没有这个方法,所以保留逐个读取的回退路径。
async function loadAllPresets() {
    const q = window.qingframe;
    if (q && typeof q.loadAllPresets === 'function') {
        try {
            const all = await q.loadAllPresets();
            if (Array.isArray(all) && all.length) {
                // 刻意用"就地打标 + 返回原对象",而不是 Object.assign({_fileName}, data):
                // 后者会把 _fileName 放到键序最前面,与逐个读取的路径(末尾追加)不同形。
                // 模板最终会被 JSON.stringify 写进 .qfs / 模板文件,保持键序一致最稳妥。
                return all.filter(x => x && x.data).map(x => {
                    x.data._fileName = x.name;
                    return x.data;
                });
            }
        } catch (e) { /* 回退到逐个读取 */ }
    }
    const names = await q.listPresets();
    const out = [];
    for (const name of names) {
        const data = await q.loadPreset(name);
        if (data) {
            data._fileName = name;
            out.push(data);
        }
    }
    return out;
}

window.__loadAllPresets = loadAllPresets;

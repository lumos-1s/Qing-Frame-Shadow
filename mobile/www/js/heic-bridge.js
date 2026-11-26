'use strict';
/* 手机端 HEIC/HEIF 解码兜底：优先让 WebView/系统解码，失败后再懒加载 libheif(WASM)。
   libheif 包体约 2MB，只在真的遇到 HEIC 且系统解不了时才加载，不拖慢正常启动。
   资源与许可证见 www/vendor/libheif/（LGPL-3.0）。 */
(function () {
    let factoryPromise = null;
    let modulePromise = null;

    function loadFactory() {
        if (typeof window.libheif === 'function') return Promise.resolve(window.libheif);
        if (factoryPromise) return factoryPromise;
        factoryPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'vendor/libheif/libheif-bundle.js';
            s.async = true;
            s.onload = () => {
                if (typeof window.libheif === 'function') resolve(window.libheif);
                else reject(new Error('HEIC 解码器初始化失败'));
            };
            s.onerror = () => reject(new Error('HEIC 解码器加载失败'));
            document.head.appendChild(s);
        }).catch((e) => {
            // 加载失败时清掉缓存，用户重试/重进页面还能再试一次
            factoryPromise = null;
            throw e;
        });
        return factoryPromise;
    }

    function getModule() {
        if (modulePromise) return modulePromise;
        modulePromise = loadFactory()
            .then((factory) => factory())
            .then(async (lib) => {
                if (lib && lib.ready) await lib.ready;
                return lib;
            })
            .catch((e) => { modulePromise = null; throw e; });
        return modulePromise;
    }

    // file / Blob / ArrayBuffer / Uint8Array → 全尺寸 canvas。
    // 调用方负责在导出结束后释放画布（width/height 置 0）。
    window.qfHeicDecode = async function (input) {
        let bytes;
        if (input instanceof Uint8Array) bytes = input;
        else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
        else if (input && typeof input.arrayBuffer === 'function') bytes = new Uint8Array(await input.arrayBuffer());
        else throw new Error('HEIC 输入数据无效');

        const libheif = await getModule();
        const decoder = new libheif.HeifDecoder();
        let images = [];
        try {
            images = decoder.decode(bytes) || [];
            if (!images.length) throw new Error('HEIC 中没有可解码的图像');
            const img = images[0];
            const w = Number(img.get_width()) || 0;
            const h = Number(img.get_height()) || 0;
            if (!w || !h) throw new Error('HEIC 尺寸无效');

            const data = new Uint8ClampedArray(w * h * 4);
            await new Promise((resolve, reject) => {
                img.display({ data, width: w, height: h }, (out) => {
                    if (out) resolve(out);
                    else reject(new Error('HEIC 解码失败'));
                });
            });

            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            cv.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
            cv.naturalWidth = w; cv.naturalHeight = h; cv.complete = true;
            return cv;
        } finally {
            images.forEach((im) => { try { im.free(); } catch (_) {} });
            // HeifDecoder 内部持有 C++ decoder，必须显式 delete，否则每次解码都漏一块 wasm 内存
            try { if (decoder.decoder) decoder.decoder.delete(); } catch (_) {}
        }
    };

    window.qfIsHeicName = (name) => /\.(heic|heif)$/i.test(String(name || ''));
})();

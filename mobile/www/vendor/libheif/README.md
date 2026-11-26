# libheif-js (wasm bundle)

- Source: `node_modules/libheif-js/libheif-wasm/libheif-bundle.js` (libheif-js 1.23.5)
- License: LGPL-3.0, full text in `LICENSE`
- Use: loaded lazily by `js/heic-bridge.js` only when the WebView cannot decode a HEIC/HEIF image.
  The WASM binary is embedded in the JS bundle, so no extra `.wasm` fetch is needed.

This file is a vendored third-party artifact. Do not hand-edit; refresh it from npm with:

```bat
copy node_modules\libheif-js\libheif-wasm\libheif-bundle.js mobile\www\vendor\libheif\libheif-bundle.js
copy node_modules\libheif-js\libheif-wasm\LICENSE mobile\www\vendor\libheif\LICENSE
```

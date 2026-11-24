// 端到端验证 0.1.10 的更新检查 patch:
// 用 mock executor 替代真实网络, 完整跑 GitHubProvider.getLatestVersion(),
// 确认: ①atom 返回伪造 feed 能被解析; ②releases/latest 与 latest.yml 走镜像 URL;
// ③返回的 updateInfo.version 正确; ④resolveFiles 的下载 URL 也走镜像。
const GH_PROXIES = ['https://ghproxy.net', 'https://ghfast.top', 'https://gh-proxy.com'];
const FAKE_ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Qing-Frame-Shadow Releases</title>
  <entry>
    <title>新版本可用</title>
    <link href="https://github.com/lumos-1s/Qing-Frame-Shadow/releases/tag/v0.1.10"/>
    <content type="html">更新检查与下载已全部走加速镜像, 修复国内网络直连失败问题</content>
  </entry>
</feed>`;
const FAKE_LATEST_YML = `version: 0.1.10
files:
  - url: Qingframe-Setup-0.1.10-x64.exe
    sha512: sIV8K6vfU9ipzKzwFQtZA3Ds18f0jEJ0K6Okux2liUam8C6YX+Ho9BelCCz3VsytEdS8W5hpGg13Mq89Nz4mHw==
    size: 78661168
path: Qingframe-Setup-0.1.10-x64.exe
sha512: sIV8K6vfU9ipzKzwFQtZA3Ds18f0jEJ0K6Okux2liUam8C6YX+Ho9BelCCz3VsytEdS8W5hpGg13Mq89Nz4mHw==
releaseDate: '2026-10-10T15:02:38.263Z'`;
const FAKE_LATEST_JSON = JSON.stringify({ tag_name: 'v0.1.10' });

const provMod = require('electron-updater/out/providers/Provider');
const ghMod = require('electron-updater/out/providers/GitHubProvider');
const ProviderCls = provMod.Provider;
const GHProvider = ghMod.GitHubProvider;

// 与 src/main/index.js 相同的两个 patch(镜像替换下沉到 createRequestOptions, 覆盖 httpRequest 与 executor.request 两条链路)
const origHttp = ProviderCls.prototype.httpRequest;
const origCreateOpts = ProviderCls.prototype.createRequestOptions;
ProviderCls.prototype.createRequestOptions = function (url, headers) {
    const proxy = GH_PROXIES[0];
    if (proxy && url) {
        const href = (typeof url === 'string') ? url : url.href;
        if (href && href.startsWith('https://github.com/') && !/\/releases\.atom$/.test(href)) {
            const proxied = proxy + '/' + href;
            url = (typeof url === 'string') ? proxied : new URL(proxied);
        }
    }
    return origCreateOpts.call(this, url, headers);
};
ProviderCls.prototype.httpRequest = function (url, headers, cancellationToken) {
    if (url) {
        const href = (typeof url === 'string') ? url : url.href;
        if (href && /\/releases\.atom$/.test(href)) return Promise.resolve(FAKE_ATOM_XML);
    }
    return origHttp.call(this, url, headers, cancellationToken);
};
const origRes = GHProvider.prototype.resolveFiles;
GHProvider.prototype.resolveFiles = function (updateInfo) {
    const files = origRes.call(this, updateInfo);
    const proxy = GH_PROXIES[0];
    for (const f of files) {
        const href = f.url.href;
        if (href.startsWith('https://github.com/')) f.url = new URL(proxy + '/' + href);
    }
    return files;
};

// mock executor: 按 options 里的 host/path 返回对应内容, 并记录实际请求 URL
const requested = [];
const executor = {
    request: async (options, token) => {
        const host = options.hostname || options.host;
        const path = options.path || '';
        requested.push('https://' + host + path);
        if (/\/releases\/latest$/.test(path)) return FAKE_LATEST_JSON;
        if (/latest\.yml$/.test(path)) return FAKE_LATEST_YML;
        throw new Error('unexpected request: ' + host + path);
    }
};
const updaterMock = {
    channel: 'latest',
    allowPrerelease: false,
    fullChangelog: false,
    currentVersion: require('semver')('0.1.9'),
    isAddNoCacheQuery: false
};
const provider = new GHProvider({ owner: 'lumos-1s', repo: 'Qing-Frame-Shadow' }, updaterMock, { executor });

(async () => {
    const info = await provider.getLatestVersion();
    console.log('--- 检查链路实际请求(应全部走镜像, 且无 github.com 直连) ---');
    for (const u of requested) console.log(u);
    console.log('--- 结果 ---');
    console.log('version:', info.version);
    console.log('tag:', info.tag);
    console.log('releaseName:', info.releaseName);
    console.log('releaseNotes:', JSON.stringify(info.releaseNotes));
    const files = provider.resolveFiles(info);
    console.log('file url:', files[0].url.href);
    const allMirrored = requested.every(u => new URL(u).hostname === new URL(GH_PROXIES[0]).hostname);
    const noDirectGitHub = requested.every(u => new URL(u).hostname !== 'github.com');
    console.log('所有请求走镜像:', allMirrored, '| 无 github.com 直连:', noDirectGitHub);
    if (info.version !== '0.1.10' || !noDirectGitHub || !allMirrored) { process.exit(1); }
    console.log('PASS');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });

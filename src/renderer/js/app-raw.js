// RAW 显影：像素换装 + 状态。
//
// 交互模型（为什么不是"每拖一下重解全尺寸"）：
//   · 拖动调色滑块时用半尺寸代理（长边 1600），够看清曝光/高光/白平衡；
//   · 停手后自动升到全尺寸（~2s），导出/拼图前也会强制补齐；
//   · 两组结果都落在主进程磁盘缓存里，参数回到旧值就直接命中，不重复解码。
//
// **显影不再有自己的滑块**。曝光/对比/高光/色温/色调只在「调色」里出现一次：
// 解码时已经把这几档折成一条固定基线（自动曝光 + 高光肩），再摆一套同名滑块，
// 只会变成第二套方向还相反的控件（显影的「高光 +」压高光，调色的「高光 +」提亮高光）。
//
// 位深：全尺寸显影走 16 位（Buffer 里 65536 级，高光肩/曝光都在这个精度上算），
// 代理图走 8 位（只用来拖动时看效果，解码还快一倍）。两条路径的自动基线一致，
// 所以代理和导出不会一亮一暗——这条由 tools/test-raw-view.js 断言。
// 解码时固定做自动曝光基线 + 高光肩，用户能调的全在调色里，一套数值。
//
// 显影参数仍然保留在 raw.params 里：一是裁切/旋转这类「视图」要跟着 URL 走，
// 二是旧草稿/旧工程里可能存过 tone 数值，读进来还得能重现。
(function () {
    const DEFAULTS = { exposure: 0, contrast: 0, highlights: 25, temperature: 0, tint: 0 };
    const PROXY_EDGE = 1600;
    const FULL_IDLE = 1100;

    window.App = Object.assign(window.App || {}, {
        RAW_DEFAULTS: DEFAULTS,
        RAW_PROXY_EDGE: PROXY_EDGE,

        // 路径 + 参数 + 长边 + 视图（裁切/旋转）→ qflocal URL。
        // 参数变了 URL 就变，浏览器不会拿旧像素，主进程也能按 URL 里的参数直接命中缓存。
        rawSrc(filePath, params, edge, view) {
            const p = Object.assign({}, DEFAULTS, params || {});
            let url = 'qflocal://img?p=' + encodeURIComponent(filePath)
                + '&raw=' + encodeURIComponent(JSON.stringify(p))
                + '&q=' + (edge || 0);
            const rot = (((Number(view && view.rotate) || 0) % 4) + 4) % 4;
            if (rot) url += '&rot=' + rot;
            if (view && view.crop) url += '&crop=' + encodeURIComponent(JSON.stringify(view.crop));
            return url;
        },

        rawParamsOf(im) {
            if (!im || !im.raw) return null;
            return Object.assign({}, DEFAULTS, im.raw.params || {});
        },

        // 视图是显影状态的一部分：撤销、草稿、裁切都要能原样存回来。
        rawSnapshotOf(im) {
            if (!im || !im.raw) return null;
            return {
                params: Object.assign({}, DEFAULTS, im.raw.params || {}),
                crop: im.raw.crop ? Object.assign({}, im.raw.crop) : null,
                rotate: ((Number(im.rotate) || 0) % 4 + 4) % 4
            };
        },

        rawUrl(im, edge) {
            return this.rawSrc(im.path, this.rawParamsOf(im), edge, {
                crop: im.raw.crop || null,
                rotate: ((Number(im.rotate) || 0) % 4 + 4) % 4
            });
        },

        initRawPanel() {
            const wrap = document.getElementById('grpRaw');
            if (!wrap) return;
            // 面板只剩「状态 + 一个按钮」：显影参数没有滑块可调，但必须让用户
            // 看得见它现在算什么尺寸、正在做什么，也留一个手动入口（重试/重来）。
            this._rawDom = {
                wrap,
                badge: document.getElementById('rawBadge'),
                state: document.getElementById('rawState'),
                btn: document.getElementById('btnRawDevelop')
            };
            wrap.hidden = true;
            const d = this._rawDom;
            if (d.btn) {
                d.btn.addEventListener('click', () => {
                    const im = this.image;
                    if (!im || !im.raw || im.raw.fullPending) return;
                    // 已经是全尺寸时按钮是「重新显影」：强制再解一次。
                    // 参数没变会命中磁盘缓存，所以通常一闪就好；失败过的话这次能重来。
                    this.rawEnsureFull(im, { force: !!im.raw.full });
                });
            }
        },

        // 视图（裁切/旋转）变了：立刻作废在途请求和排队中的全尺寸，别让旧结果盖回新画面。
        _rawInvalidate(im) {
            if (!im || !im.raw) return;
            im.raw.seq = (im.raw.seq || 0) + 1;
            im.raw.full = false;
            im.raw.fullPending = null;
            im.raw.error = false;
            if (im === this.image) clearTimeout(this._rawFullTimer);
        },

        _rawQueueFull(delay) {
            clearTimeout(this._rawFullTimer);
            const im = this.image;
            if (!im || !im.raw || im.raw.full) return;
            this._rawFullTimer = setTimeout(() => {
                // 自动升级不抢状态栏：导入时那句「已导入 N 张…跳过 M 个文件」更有信息量，
                // 显影进度看面板与状态栏的 RAW 标记就够了。
                if (this.image === im) this.rawEnsureFull(im, { silent: true });
            }, delay == null ? FULL_IDLE : delay);
        },

        // 把当前参数 + 视图显影出来并换进 im.el。返回是否真的换了。
        _rawReload(im, edge) {
            if (!im || !im.raw || !im.path) return Promise.resolve(false);
            const seq = (im.raw.seq || 0) + 1;
            im.raw.seq = seq;
            im.raw.error = false;
            const url = this.rawUrl(im, edge);
            const img = window.qfsImage();
            img.decoding = 'async';
            return new Promise((resolve) => {
                const finish = (ok) => {
                    // 更新的请求已经发出：这次的结果作废，别把旧像素盖回去
                    if (im.raw.seq !== seq) { resolve(false); return; }
                    if (!ok || !img.naturalWidth) {
                        im.raw.error = true;
                        if (im === this.image) { this.syncRawUI(); this.scheduleRender(true); }
                        resolve(false);
                        return;
                    }
                    im.el = img;
                    im.w = img.naturalWidth;
                    im.h = img.naturalHeight;
                    im.raw.edge = edge;
                    im.raw.full = edge === 0;
                    im.raw.error = false;
                    // 底图换了：旧缩略图必须作废，否则胶片条还是上一版显影
                    im.thumb = null;
                    im._thumbEl = null;
                    im._tqAt = 0;
                    if (this.invalidateStyleCaches) this.invalidateStyleCaches();
                    // 调色缓存按"源图版本 + 参数"记，换了像素必须作废；
                    // 参数还在，当前图立刻在新底图上重放，避免显影后调色像丢了。
                    if (this.invalidateGrade) this.invalidateGrade(im);
                    if (im === this.image && this.rebuildGrade) {
                        this.rebuildGrade(edge === 0 ? 'full' : 'low');
                    }
                    if (typeof this.queueThumb === 'function') this.queueThumb(im);
                    if (im === this.image) {
                        this.syncRawUI();
                        this.scheduleRender(true);
                    }
                    resolve(true);
                };
                img.onload = () => finish(true);
                img.onerror = () => finish(false);
                img.src = url;
            });
        },

        // 全尺寸显影：切图后自动调用，导出前强制补齐，面板上的按钮也走这里。
        // 并发同一个参数时只跑一次；force 用于「已经是全尺寸，但想重来一遍」。
        async rawEnsureFull(im, opts) {
            if (!im || !im.raw) return true;
            if (im.raw.fullPending) return im.raw.fullPending;
            if (im.raw.full && !(opts && opts.force)) return true;
            const t0 = Date.now();
            const p = (async () => {
                let ok = await this._rawReload(im, 0);
                // 解码失败时主进程已经把解码线程换成了新的（wasm 堆吃满就只能换线程），
                // 再试一次通常就能成功；不重试的话导出会悄悄停在 1600px 代理上。
                if (!ok && im.raw.error) {
                    await new Promise((r) => setTimeout(r, 120));
                    ok = await this._rawReload(im, 0);
                }
                if (im.raw.fullPending === p) im.raw.fullPending = null;
                if (im === this.image) {
                    this.syncRawUI();
                    if (ok && !(opts && opts.silent)) {
                        this.setStatus(`RAW 已按全尺寸显影（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
                    }
                    // 被更新的参数/视图请求取代时也会 resolve(false)，那不是失败，别误报。
                    if (!ok && im.raw.error) this.setStatus('RAW 全尺寸显影失败，点「重试显影」再解一次');
                }
                return ok;
            })();
            im.raw.fullPending = p;
            // 解码要 1~4 秒：按钮和状态行必须马上变成「显影中」，否则点下去像没反应。
            if (im === this.image) {
                this.syncRawUI();
                if (this.updateStatusBar) this.updateStatusBar();
            }
            return p;
        },

        // 导出/拼图前调用：参与输出的 RAW 图必须都是全尺寸，否则成品只有 1600px。
        // extraTemplates：导出时可能临时沿用「当前模板」（多选导出时的‘沿用这套边框’），
        // 拼图槽位引用的是那份模板，不在任何图片自己的 customSettings 里。
        async rawPrepareOutput(images, extraTemplates) {
            const list = [];
            const seen = new Set();
            const push = (im) => {
                if (im && im.raw && !im.raw.full && !seen.has(im)) { seen.add(im); list.push(im); }
            };
            // 拼图会把别的照片画进同一张成品，那些槽位图也得是全尺寸，否则成品里
            // 只有主图清晰、其他格子糊。槽位优先按 imageIndex 指回 this.images，
            // 兼容旧工程/外部引用用的 imagePath（与 engine.js 的解析顺序一致）。
            const addSlots = (tpl) => {
                const slots = tpl && tpl.puzzle && tpl.puzzle.slots;
                if (!slots) return;
                for (const k in slots) {
                    const sc = slots[k];
                    if (!sc) continue;
                    let slot = null;
                    if (sc.imageIndex != null) slot = this.images[sc.imageIndex];
                    if (!slot && sc.imagePath) {
                        slot = (this.images || []).find(x => x && x.name === sc.imagePath) || null;
                    }
                    push(slot);
                }
            };
            for (const im of images || []) {
                push(im);
                const own = this.getTpl ? this.getTpl(im) : null;
                addSlots(own || (im === this.image ? this.template : null));
            }
            for (const tpl of extraTemplates || []) addSlots(tpl);
            if (!list.length) return { total: 0, failed: 0, upgraded: 0 };
            if (list.length > 1) this.setStatus(`正在按全尺寸显影 ${list.length} 张 RAW…`);
            const failed = [];
            let upgraded = 0;
            for (const im of list) {
                const before = im.w;
                await this.rawEnsureFull(im);
                if (im.w > before) upgraded++;
                // 以「最后到底是不是全尺寸」为准，不看 error 标记：被更新的请求取代、
                // 参数刚好又变了，这两种情况都不算失败，但结果同样不是全尺寸。
                if (!im.raw.full) failed.push(im);
            }
            if (failed.length) {
                this.setStatus(`有 ${failed.length} 张 RAW 未能按全尺寸显影，本次成品只有 1600px 代理`);
            }
            return { total: list.length, failed: failed.length, upgraded };
        },

        // 把「旋转后的显示坐标」中的归一化矩形，反推回「裁切后、旋转前」的归一化坐标。
        // 90°/270° 会交换宽高，所以不能只做平移。
        rawUnrotateRect(rect, turns) {
            const r = {
                x: Math.min(1, Math.max(0, Number(rect.x) || 0)),
                y: Math.min(1, Math.max(0, Number(rect.y) || 0)),
                w: Math.min(1, Math.max(0.001, Number(rect.w) || 0)),
                h: Math.min(1, Math.max(0.001, Number(rect.h) || 0))
            };
            const t = ((Math.round(Number(turns) || 0) % 4) + 4) % 4;
            if (t === 1) return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
            if (t === 2) return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
            if (t === 3) return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
            return r;
        },

        // 把裁切弹层里的框记成显影参数。st.src 可能已经带裁切/旋转，
        // 所以按「当前视图 + 弹层里再转的次数」反推回原图坐标，再换底图。
        async rawRecordCrop(im, st, box) {
            if (!im || !im.raw || !st || !box) return false;
            const W = Number(st.W) || 0;
            const H = Number(st.H) || 0;
            if (!W || !H) return false;
            const norm = { x: box.x / W, y: box.y / H, w: box.w / W, h: box.h / H };
            const useOrig = !!st.useOrig;
            const base = useOrig
                ? ((im.orig && im.orig.raw) || { crop: null, rotate: 0 })
                : { crop: im.raw.crop || null, rotate: im.rotate || 0 };
            const turns = ((Math.round((Number(base.rotate) || 0) + (Number(st.turns) || 0)) % 4) + 4) % 4;
            const local = this.rawUnrotateRect(norm, turns);
            const crop = base.crop || null;
            let out = crop ? {
                x: crop.x + local.x * crop.w,
                y: crop.y + local.y * crop.h,
                w: local.w * crop.w,
                h: local.h * crop.h
            } : local;
            out = {
                x: Math.min(0.999, Math.max(0, out.x)),
                y: Math.min(0.999, Math.max(0, out.y)),
                w: Math.min(1, Math.max(0.001, out.w)),
                h: Math.min(1, Math.max(0.001, out.h))
            };
            // 先夹左上角，再把宽高压回画面内，保证 x+w / y+h 不会超过 1。
            out.w = Math.min(1 - out.x, out.w);
            out.h = Math.min(1 - out.y, out.h);
            // 整张图 + 不旋转 = 没裁切，存 null 让 URL 更短、缓存键更干净。
            im.raw.crop = (out.x < 0.0005 && out.y < 0.0005 && out.w > 0.999 && out.h > 0.999)
                ? null : out;
            im.rotate = turns;
            this._rawInvalidate(im);
            this.syncRawUI();
            const ok = await this._rawReload(im, PROXY_EDGE);
            if (ok && im === this.image) this._rawQueueFull(400);
            return ok;
        },

        // 撤销 / 还原原图：把参数和视图恢复到快照，再重新显影。
        async rawApplyUndo(im, state) {
            if (!im || !im.raw || !state) return false;
            im.raw.params = Object.assign({}, DEFAULTS, state.params || {});
            if (state.crop) {
                const crop = {
                    x: Math.min(0.999, Math.max(0, Number(state.crop.x) || 0)),
                    y: Math.min(0.999, Math.max(0, Number(state.crop.y) || 0)),
                    w: Math.min(1, Math.max(0.001, Number(state.crop.w) || 1)),
                    h: Math.min(1, Math.max(0.001, Number(state.crop.h) || 1))
                };
                crop.w = Math.min(1 - crop.x, crop.w);
                crop.h = Math.min(1 - crop.y, crop.h);
                im.raw.crop = crop;
            } else {
                im.raw.crop = null;
            }
            im.rotate = ((Number(state.rotate) || 0) % 4 + 4) % 4;
            this._rawInvalidate(im);
            this.syncRawUI();
            const ok = await this._rawReload(im, PROXY_EDGE);
            if (ok && im === this.image) this._rawQueueFull(400);
            return ok;
        },

        // 面板显隐与状态。切图、撤销、导出补尺寸后都会被顺带叫到。
        syncRawUI() {
            const d = this._rawDom;
            if (!d) return;
            const im = this.image;
            const on = !!(im && im.raw);
            d.wrap.hidden = !on;
            // 直方图卡右下角同时显示显影阶段，抬眼就能看到，不必再往下找组
            if (window.QfsPanelDensity) window.QfsPanelDensity.setRawTag(im);
            if (!on) return;
            if (d.badge) {
                const ext = String(im.path || '').split('.').pop().toUpperCase();
                d.badge.textContent = ext && ext.length <= 4 ? ext : 'RAW';
            }
            const busy = !!im.raw.fullPending;
            if (d.state) {
                d.state.classList.toggle('busy', busy);
                if (im.raw.error) d.state.textContent = '显影失败';
                else if (busy) d.state.textContent = '显影中…';
                else if (im.raw.full) d.state.textContent = `${im.w}×${im.h}`;
                else d.state.textContent = `代理 ${Math.max(im.w, im.h)}px`;
            }
            // 按钮本身就是「显影」这件事的入口：代理状态可手动升，失败时是重试，
            // 已全尺寸时还能强制重来（命中缓存时一闪而过）。
            if (d.btn) {
                d.btn.disabled = busy;
                d.btn.textContent = busy
                    ? '显影中…'
                    : (im.raw.error ? '重试显影' : (im.raw.full ? '重新显影' : '按全尺寸显影'));
            }
        }
    });
})();

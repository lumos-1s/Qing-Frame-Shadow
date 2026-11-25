// 同步模块：边框同步 —— 各入口共用同一核心（从 app.js / app-templates.js 拆出）
//   · 右键菜单「同步边框」/ Ctrl 单张场景：syncBorderTo —— 单张，不弹覆盖确认
//   · 「同步到选中」按钮 / Ctrl+D 批量：syncToSelected / applyBorderToSelected —— 覆盖已有边框时先确认
//   · 缩略图右键另两条：applyGradeToTargets（只调色）、syncSettingsToTargets（边框+调色）
//     目标由右键位置决定，见 app.js 的 buildThumbnails
//
// 同步语义（唯一权威定义；改行为必须改这里并同步更新上方入口与状态文案）：
//   · 带过去（源图 → 目标图）：全部边框与参数 + logoElements（多图统一元素布局用）；
//   · 保留目标图自己的：贴纸(stickers)、自由文字(textLines)、拼图(puzzle) ——
//     边框之外的各图独立内容不参与同步，也不会被清掉；
//   · 相机数据三级规则：目标图自有 EXIF → 用它（清掉历史同步写入的手动值）；无 EXIF 但
//     手动填过 → 保留目标图自己的；都无 → 沿用源图的有效相机数据；
//   · 写入一律走 setTpl 单一存取口（Map 与 customSettings 恒为同一对象，见 app-state.js）。
window.App = Object.assign(window.App || {}, {
    // 核心：把当前编辑中的模板复制到 idxs 指定的一批目标图。返回成功张数；用户取消返回 -1。
    // opts.confirm=true 时，若目标里已有边框（会被覆盖）则先弹一次确认 —— 防误同步覆盖手工成果。
    _syncTplToTargets(idxs, opts) {
        if (!this.image || !this.template) return 0;
        // 去重、过滤非法索引；当前编辑图就是"源"，从目标里剔除
        const list = Array.from(new Set(
            (idxs || []).filter(i => Number.isInteger(i) && i >= 0 && i < this.images.length)
        )).filter(i => i !== this.currentIdx);
        if (!list.length) return 0;
        const applied = this.cloneTemplate();
        if (!applied) return 0;
        delete applied.puzzle;
        // 横竖混排自适应(模板页签 cbSyncAdapt,默认开):目标图与源图尺寸/方向不一致时,
        // 边距与圆角按目标尺寸换算,避免"横向调好的边框同步到竖图后留白比例失衡"。
        // 关闭时保持旧口径:逐字复制边距。
        const adapt = !(typeof this.$ === 'function') || !this.$('cbSyncAdapt') || this.$('cbSyncAdapt').checked;
        const srcEl = this.image.el;
        const srcW = srcEl ? srcEl.naturalWidth : 0, srcH = srcEl ? srcEl.naturalHeight : 0;
        const overwrite = list.filter(i => !!this.getTpl(this.images[i]));
        if (opts && opts.confirm && overwrite.length && !window.confirm(
            `将把当前边框同步到 ${list.length} 张照片，其中 ${overwrite.length} 张已有边框会被覆盖。\n\n继续?`)) {
            this.setStatus('已取消同步');
            return -1;
        }
        let count = 0;
        for (const i of list) {
            const im = this.images[i];
            if (!im) continue;
            const tgtSnap = JSON.parse(JSON.stringify(applied));
            const tgtEl = im.el;
            if (adapt && srcW > 0 && srcH > 0 && tgtEl && tgtEl.naturalWidth > 0) {
                this._adaptTplToSize(tgtSnap, srcW, srcH, tgtEl.naturalWidth, tgtEl.naturalHeight);
            }
            const prev = this.getTpl(im);
            // 贴纸/自由文字/拼图：源图的不带过去（沿用旧口径），目标图自己的保留 ——
            // 这三类随各图独立记忆，同步只动边框本身
            if (tgtSnap.decorConfig) { delete tgtSnap.decorConfig.stickers; delete tgtSnap.decorConfig.textLines; }
            if (prev) {
                if (prev.puzzle) tgtSnap.puzzle = JSON.parse(JSON.stringify(prev.puzzle));
                const pk = prev.decorConfig, tk = tgtSnap.decorConfig;
                if (pk && (pk.stickers || pk.textLines)) {
                    tgtSnap.decorConfig = tk || {};
                    if (pk.stickers) tgtSnap.decorConfig.stickers = JSON.parse(JSON.stringify(pk.stickers));
                    if (pk.textLines) tgtSnap.decorConfig.textLines = JSON.parse(JSON.stringify(pk.textLines));
                }
            }
            // 相机数据：同步只动边框。目标图自己能识别 EXIF → 用自己的（清除历史同步/兜底写入的手动参数）；
            // 没有 EXIF 但手动填过 → 保留该图自己的手动参数；都无 → 沿用当前图的有效相机数据
            const prevManual = (prev && prev.manualExif && typeof prev.manualExif === 'object') ? prev.manualExif : null;
            const ownExif = (im.exif && typeof im.exif === 'object') ? im.exif : {};
            const hasOwn = ['make', 'model', 'focal', 'aperture', 'iso', 'shutter'].some(k => String(ownExif[k] || '').trim() !== '');
            if (hasOwn) {
                delete tgtSnap.manualExif;
            } else if (prevManual) {
                delete tgtSnap.manualExif;
                if (Object.keys(prevManual).length) tgtSnap.manualExif = JSON.parse(JSON.stringify(prevManual));
            } else {
                const srcManual = (this.template.manualExif && typeof this.template.manualExif === 'object') ? this.template.manualExif : {};
                const srcAuto = (this.image.exif && typeof this.image.exif === 'object') ? this.image.exif : {};
                const base = {
                    brand: String(srcManual.brand || '').trim() || String(srcAuto.make || '').trim(),
                    model: String(srcManual.model || '').trim() || String(srcAuto.model || '').trim(),
                    focal: String(srcManual.focal || '').trim() || String(srcAuto.focal || '').trim(),
                    aperture: String(srcManual.aperture || '').trim() || String(srcAuto.aperture || '').trim(),
                    iso: String(srcManual.iso || '').trim() || String(srcAuto.iso || '').trim(),
                    shutter: String(srcManual.shutter || '').trim() || String(srcAuto.shutter || '').trim()
                };
                const hasCam = ['brand', 'model', 'focal', 'aperture', 'iso', 'shutter'].some(k => base[k] !== '');
                delete tgtSnap.manualExif;
                if (hasCam) tgtSnap.manualExif = base;
            }
            // 每张目标图各自压一条撤销步：以前同步出去的边框撤不掉，
            // 用户切到那张照片按 Ctrl+Z 只会得到「没有可撤销的操作」。
            if (!opts || opts.undo !== false) {
                const base = prev || (typeof this.defaultTemplate === 'function' ? this.defaultTemplate() : null);
                if (base) this.pushUndoForImage(im, base);
            }
            this.setTpl(im, tgtSnap);
            this.queueThumb(im);
            count++;
        }
        if (count && typeof this.scheduleDraft === 'function') this.scheduleDraft();
        return count;
    },

    // 尺寸/方向适配:把按源图调好的绝对边距换算到目标图尺寸。
    //   · 四边各自按同轴比例缩放(top/bottom×ky,left/right×kx):横→竖时竖直留白相对变厚、
    //     水平留白相对变薄,视觉比例与源图一致;参数条等"贴照片下沿"的内容方向不变,不交换轴;
    //   · refTop/refBottom/refLeft/refRight(边距大小的基准值)同比例换算,globalMargin 保持不变;
    //   · 圆角按几何均值 √(kx·ky) 缩放(圆角同时受两个方向约束,取折中);
    //   · 显式 paramFontSize(>0,绝对 px)同样按几何均值缩放;0(自适应)不动,引擎会按目标图重算。
    _adaptTplToSize(tpl, sw, sh, tw, th) {
        if (!tpl || sw <= 0 || sh <= 0 || tw <= 0 || th <= 0) return;
        const kx = tw / sw, ky = th / sh;
        const kr = Math.sqrt(kx * ky);
        const m = tpl.baseMargin;
        if (m) {
            const scalePair = (valKey, refKey, k) => {
                if (m[valKey] != null) m[valKey] = Math.max(0, Math.round(m[valKey] * k));
                if (m[refKey] != null) m[refKey] = Math.max(0, Math.round(m[refKey] * k));
            };
            scalePair('marginTop', 'refTop', ky);
            scalePair('marginBottom', 'refBottom', ky);
            scalePair('marginLeft', 'refLeft', kx);
            scalePair('marginRight', 'refRight', kx);
        }
        const cc = tpl.cornerConfig;
        if (cc && kr !== 1) {
            ['cornerRadiusAll', 'cornerRadiusTL', 'cornerRadiusTR', 'cornerRadiusBL', 'cornerRadiusBR'].forEach(k => {
                if (cc[k] != null) cc[k] = Math.max(0, Math.round(cc[k] * kr));
            });
        }
        if (tpl.paramFontSize > 0 && kr !== 1) {
            tpl.paramFontSize = Math.max(2, Math.round(tpl.paramFontSize * kr));
        }
    },

    // 单张同步：右键菜单「同步边框」（落在单张缩略图上）。指向明确，不弹覆盖确认
    syncBorderTo(i) {
        const tgt = this.images[i];
        if (!tgt || !this.image) return;
        const n = this._syncTplToTargets([i], { confirm: false });
        if (n > 0) this.setStatus('已将当前边框同步到「' + tgt.name + '」');
    },

    // 批量同步：「同步到选中」按钮。目标 = 全部选中 − 当前编辑图
    // （Ctrl+A 全选时含第 1 张；旧写法 selectedIdx.slice(1) 会固定漏掉下标最小的那张）
    syncToSelected() {
        if (this.selectedIdx.length <= 1) { this.setStatus('请先在胶片条中多选需要同步的照片(Ctrl/Shift+点击)'); return; }
        const n = this._syncTplToTargets(this.selectedIdx, { confirm: true });
        if (n < 0) return; // 用户在覆盖确认里取消
        this.setStatus(n
            ? `已将当前边框同步到 ${n} 张照片（含 Logo；贴纸/文字/拼图保留各图自有）`
            : '没有需要同步的选中照片');
        },

        // 缩略图右键「同步边框 + 调色」：一步把当前照片的边框和调色参数都给目标图，
        // 不用先「复制设置」再「粘贴设置」，也不会动系统剪贴板。
        // 两套语义分别复用 _syncTplToTargets（保留目标自己的贴纸/文字/拼图、
        // EXIF 三级规则、横竖自适应）和 _applyGradeTo（曲线/混色器/蒙版深拷贝），
        // 不在右键里另写一份复制逻辑，免得以后只修其中一处。
        syncSettingsToTargets(idxs) {
            const max = (this.images || []).length;
            const list = Array.from(new Set((idxs || []).filter((i) =>
                Number.isInteger(i) && i >= 0 && i < max && i !== this.currentIdx)));
            if (!list.length) {
                this.setStatus('右键目标就是当前编辑的这张，无需同步');
                return false;
            }
            const nTpl = this._syncTplToTargets(list, { confirm: false });
            if (nTpl < 0) return false;   // 覆盖确认被取消（当前不弹，留好口子）
            if (this.applyGradeToTargets) this.applyGradeToTargets(list, { silent: true });
            if (this.buildThumbnails) this.buildThumbnails();
            this.setStatus('已将当前边框 + 调色参数同步到 ' + list.length + ' 张照片');
            return true;
        },

        // 「复制设置 / 粘贴设置」：LR 左栏底部那对按钮的等价物。
    // 与现有几条能力互补，不重复：
    //   · 应用到全部   = 只搬调色，目标是全部照片
    //   · 应用到选中   = 只搬调色，目标是胶片条多选照片（调色组 ⋯ 菜单）
    //   · 同步到选中   = 只搬边框，目标是多选照片
    //   · 缩略图右键   = 调色 / 边框 / 两者都同步，目标看右键落在哪张（单张或整批）
    //   · 复制/粘贴设置 = 调色 + 边框一起搬，目标由胶片条多选决定
    // 只存内存、不写系统剪贴板、不落草稿：重启即失效，和 LR 一致。
    copySettings() {
        const im = this.image;
        if (!im) { this.setStatus('请先打开一张照片'); return false; }
        this._copiedSettings = {
            grade: JSON.parse(JSON.stringify(im.grade || {})),
            template: this.template && this.cloneTemplate ? this.cloneTemplate() : null,
            from: im.name || '当前照片'
        };
        this.setStatus('已复制「' + this._copiedSettings.from + '」的调色与边框设置；在胶片条多选照片后点「粘贴设置」');
        return true;
    },

    pasteSettings() {
        const src = this._copiedSettings;
        if (!src) { this.setStatus('请先点「复制设置」'); return false; }
        const idxs = Array.from(new Set((this.selectedIdx || [])
            .filter((i) => Number.isInteger(i) && i !== this.currentIdx && this.images[i])));
        if (!idxs.length) {
            this.setStatus('请先在胶片条多选要粘贴的照片（Ctrl / Shift + 点击）');
            return false;
        }
        for (const i of idxs) {
            const it = this.images[i];
            it.grade = JSON.parse(JSON.stringify(src.grade || {}));
            // 缓存作废：切到这张时 selectImage 会按新参数重烘，避免显示上一版画面
            it._grade = { neutral: false, canvas: null, low: null, lowKey: '', fullKey: '' };
            if (src.template && this.setTpl) {
                this.setTpl(it, JSON.parse(JSON.stringify(src.template)));
            }
        }
        if (this.buildThumbnails) this.buildThumbnails();
        if (this.scheduleDraft) this.scheduleDraft();
        this.setStatus('已把调色与边框粘贴到 ' + idxs.length + ' 张照片');
        return true;
    }
});

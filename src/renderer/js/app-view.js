// 视图模块：缩放/平移 / 状态栏 / 通用弹窗 / 主题 / 本地用户 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ══ 缩放 / 平移 / 状态栏 / 主题 ══ */
    zoomAt(e, stage, factor) {
        const rect = stage.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const cx = rect.width / 2, cy = rect.height / 2;
        const z0 = this.zoom;
        const z1 = Math.min(3, Math.max(0.1, z0 * factor));
        if (z1 === z0) return;
        const px = (mx - cx - this.panX) / z0;
        const py = (my - cy - this.panY) / z0;
        this.panX = mx - cx - px * z1;
        this.panY = my - cy - py * z1;
        this.setZoom(z1);
    },

    setZoom(z) {
        // 任何显式缩放(滚轮/滑杆/输入/元素聚焦)都退出「跟随适应」:窗口变化不再自动重算
        this._followFit = false;
        this.zoom = z;
        this.dom.zoomInput.value = Math.round(z * 100) + '%';
        this.dom.zoomRange.value = Math.round(z * 100);
        this.applyZoomStyle();
    },
    fitZoom() {
        if (!this.image) return;
        // 导出渲染期间不动 CSS/缩放(画布只是临时放大),避免大导出时视图抖动
        if (this.uiDprOverride === 1) return;
        const canvas = this.dom.canvas;
        if (!canvas.width) return;
        const stage = this.dom.stage;
        const sw = stage.clientWidth - 8, sh = Math.max(60, stage.clientHeight - 8);
        // 用「显示逻辑尺寸」而不是画布像素:手势低清预览时 canvas.width 会临时变小,
        // 拿它算缩放会让画面突然放大;正常态两者相等,行为不变。
        const cw = canvas._logW || canvas.width, ch = canvas._logH || canvas.height;
        const z = Math.min(sw / cw, sh / ch);
        this.panX = 0; this.panY = 0;
        this.setZoom(Math.max(0.1, z));
        // 视图回到「适应」状态:窗口尺寸变化时自动重算(app.js 的 ResizeObserver 读这个标志)
        this._followFit = true;
    },
    applyZoomStyle() {
        // 导出渲染期间不动 CSS 显示样式(见 fitZoom 守卫)
        if (this.uiDprOverride === 1) return;
        const canvas = this.dom.canvas;
        const z = this.zoom;
        // 显示尺寸用逻辑像素(backing/DPR),高分屏不放大,文字保持清晰
        const lw = canvas._logW || canvas.width, lh = canvas._logH || canvas.height;
        canvas.style.width = Math.max(1, Math.round(lw * z)) + 'px';
        canvas.style.height = Math.max(1, Math.round(lh * z)) + 'px';
        canvas.style.transform = `translate(${Math.round(this.panX)}px, ${Math.round(this.panY)}px)`;
        // 蒙版编辑层跟着画布的显示尺寸/位移走；有选中蒙版时顺带重画叠加层
        // （照片矩形 app._photoRect 是渲染时写进来的，缩放后必须重算位置）
        if (typeof this.syncOverlayGeometry === 'function') this.syncOverlayGeometry();
        if (typeof this.drawMaskOverlay === 'function'
            && typeof this.activeMask === 'function' && this.activeMask(this.image)) {
            this.drawMaskOverlay();
        }
    },

    switchTab(name) {
        this.dom.tabs.querySelectorAll('.tab[data-tab]').forEach(t => {
            const on = t.dataset.tab === name;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        this.dom.panels.forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
        // 蒙版编辑层盖在画布上并接管 pointer 事件。离开调色页签时必须退出蒙版编辑，
        // 否则去 Logo/文字页拖元素时，点击会先被透明蒙版层吃掉（看起来像画布点不动）。
        if (name !== 'grade' && this._activeMaskId) this.setActiveMask(null);
        if (name === 'logo') this.renderLogoPools();
        if (name === 'template') this.refreshTemplates();
        if (name === 'puzzle') this.refreshPuzzleUI();
        // 直方图留在调色页签内，切到调色页时补一次（有图才画，无图时模块自己跳过）；
        // 切到别的页签时调色面板被隐藏，直方图自动不画。
        if (name === 'grade' && window.QfsHistogram && this.image) window.QfsHistogram.refresh(this.image);
        // 密度按页签切换、折叠提示按收起数量刷新、更多按钮回显当前页签
        if (window.QfsPanelDensity) window.QfsPanelDensity.onTab(name);
        this.updateExportEntry();
    },

    // 主导出按钮跟随当前页签:拼图/切图页签下它变成「导出拼图 / 导出切图」。
    // 三个出口原先分散在工具栏和两个面板里,在拼图页签点「导出」却导出单图 ——
    // 这也是"导出只有几百 KB"困惑的来源之一。
    // 导出设置箭头保持常驻:三个通道都读格式/质量(拼图还读尺寸),没有"设置不适用"的页签。
    updateExportEntry() {
        const btn = this.dom.btnSave;
        if (!btn) return;
        const active = this.dom.tabs && this.dom.tabs.querySelector('.tab.active');
        const tab = active ? active.dataset.tab : 'canvas';
        const selected = Array.isArray(this.selectedIdx) ? this.selectedIdx.length : 0;
        // 普通页签:勾选多张时主导出按钮就是批量导出,不再另放一个「批量导出」按钮。
        const label = tab === 'puzzle' ? '导出拼图'
            : tab === 'grid' ? '导出切图'
                : selected > 1 ? `导出 ${selected} 张` : '导出';
        const labelEl = this.$('btnSaveLabel');
        if (labelEl) {
            if (labelEl.textContent !== label) labelEl.textContent = label;
        } else if (btn.textContent !== label) {
            btn.textContent = label;
        }
        // 切图页签的产物是多张图,画布不是最终成品,复制按钮在这个页签下没有意义
        if (this.dom.btnCopy) this.dom.btnCopy.style.display = tab === 'grid' ? 'none' : '';
        btn.title = tab === 'puzzle' ? '导出拼图（格式/质量/尺寸按导出设置，默认 JPG）'
            : tab === 'grid' ? '导出切图（格式/质量按导出设置）'
                : selected > 1 ? `导出选中的 ${selected} 张照片（Ctrl+E）` : '导出当前图片（Ctrl+E）';
    },

    setupShortcuts() {
        // macOS 用 Command,Windows/Linux 用 Ctrl;其余逻辑完全一致
        const isMac = !!(window.qingframe && window.qingframe.isMac);
        document.addEventListener('keydown', e => {
            if (this._immersionOpen) return;
            const mod = isMac ? e.metaKey : e.ctrlKey;
            // 输入框/文本域聚焦时不触发快捷键(避免打字冲突)
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            // range 滑块(透明度/缩放/旋转)聚焦不算打字:否则拖完滑块按 Delete 删不掉选中元素
            let typing = tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable);
            if (tag === 'INPUT') {
                const itype = ((document.activeElement.type) || 'text').toLowerCase();
                typing = ['text', 'search', 'number', 'password', 'email', 'url', 'tel'].includes(itype);
            }
            if (typing && !mod) return;
            // 文本编辑里 Cmd/Ctrl+A/Z/Y 交给系统,不要抢成画布全选/撤销
            if (typing && ['a', 'z', 'y'].includes(e.key.toLowerCase())) return;

            if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); this.openImageFolder(); }
            else if (mod && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); if (this.openImmersive) this.openImmersive(); }
            else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); this.openImages(); }
            else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
            else if ((mod && e.key.toLowerCase() === 'y') || (mod && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); this.redo(); }
            else if (mod && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                // 有图片时全选缩略图(批量勾选),再按一次取消全选;无图片则回退画布元素全选
                if (this.images && this.images.length) {
                    const allSel = this.images.every((_, i) => this.batchSel.includes(i));
                    this.batchSel = allSel ? [] : this.images.map((_, i) => i);
                    this.selectedIdx = this.batchSel.slice();
                    this.buildThumbnails();
                    this.setStatus(allSel ? '已取消全选' : '已全选 ' + this.images.length + ' 张图片');
                } else {
                    this.selectAllEls();
                }
            }
            else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { if (typing) return; e.preventDefault(); this.copyImage && this.copyImage(); }
            else if (mod && e.key.toLowerCase() === 'c') { if (!typing) this.copyElement(); }
            else if (mod && e.shiftKey && e.key.toLowerCase() === 'v') { if (typing) return; e.preventDefault(); this.pasteImageFromClipboard(); }
            else if (mod && e.key.toLowerCase() === 'v') {
                if (typing) return;
                e.preventDefault();
                // 有元素剪贴板时保持原行为;否则尝试把系统剪贴板里的截图/图片导入
                if (this._elClip) this.pasteElement();
                else this.pasteImageFromClipboard();
            }
            else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
                e.preventDefault();
                // 优先处理批量勾选的照片(Ctrl+A 全选后按 Delete = 删掉全部勾选的)。
                // 必须放在最前:selectImage/afterImageSelect 会清空 selectedEls,所以"刚勾选完"
                // 这个时刻画布元素本来也是空的,不会抢走"删元素"的语义;而 >=2 才算批量,
                // 单击缩略图(batchSel 只有 1 项)仍保持原来的行为。
                if (this.batchSel && this.batchSel.length > 1) {
                    this.confirmRemoveImages(this.batchSel.slice());
                    return;
                }
                // 优先删拼图字幕,但必须确认「拼图已启用」且「该槽位真有字幕」。
                //
                // 这里必须走 this.$:本模块被拆成独立 <script> 后,$ 只在 app.js 的
                // 方法作用域里通过 const $ = this.$ 局部引入,setupShortcuts 作用域内
                // 没有裸 $ 绑定 —— 直接写 $('x') 会抛 ReferenceError: $ is not defined。
                //
                // 旧条件只看 this.template.puzzle 对象存在 + gapPick.value 非空,是错的:
                // refreshPuzzleUI 在 _puzzleSlot 为空时会自动把下拉选成 's0'(app-puzzle.js),
                // 于是任何带 puzzle 字段的模板(哪怕拼图根本没启用)都让 gapPick.value 恒为 's0',
                // Delete 就永远走 deleteCaption,画布上选中的元素一个都删不掉。
                // 现象:按 Delete 没反应,状态栏却提示「已删除字幕 S0」。
                const pk = this.template && this.template.puzzle;
                const gapPick = this.$('cbPuzzleGapPick');
                const key = gapPick ? gapPick.value : '';
                // 'v3'/'h3' = 竖/横拼图间隙; 's3' = 第 3 个宫格。取真实字幕值而非仅 key 存在。
                const cap = !key ? null
                    : (/^[vh]\d+$/.test(key) ? (pk && pk.gapCaptions && pk.gapCaptions[key])
                        : (/^s\d+$/.test(key) ? (pk && pk.captions && pk.captions[parseInt(key.substring(1), 10)]) : null));
                if (pk && pk.enabled && cap) {
                    this.deleteCaption();
                } else if (this.selectedEls.length) {
                    this.deleteElement();
                }
            }
            // 新增快捷键
            else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); this.doExport(); }
            else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this.applyBorderToSelected(); }
            else if (mod && e.key === '0') { e.preventDefault(); this.fitZoom(); }
            else if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveTemplate(); }
            // Compositor 借鉴:选中元素时方向键微移(1px/次,Shift=10px);无选中元素时左右键仍切图
            else if (this.selectedEls && this.selectedEls.length && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
                const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
                this.nudgeSelectedPosition(dx, dy);
            }
            else if (e.key === 'ArrowLeft' && this.images && this.images.length > 1) { e.preventDefault(); this.selectImage((this.currentIdx - 1 + this.images.length) % this.images.length); }
            else if (e.key === 'ArrowRight' && this.images && this.images.length > 1) { e.preventDefault(); this.selectImage((this.currentIdx + 1) % this.images.length); }
        });
    },

    // 把当前边框参数应用到所有勾选的照片(右键菜单「同步边框（N 张）」/ Ctrl+D)
    applyBorderToSelected() {
        if (!this.image) { this.setStatus('请先打开一张照片'); return; }
        const targets = (this.batchSel && this.batchSel.length) ? this.batchSel.slice() : [this.currentIdx];
        const n = this._syncTplToTargets(targets, { confirm: true });
        if (n < 0) return; // 用户在覆盖确认里取消
        this.setStatus(n ? `已把当前边框同步到 ${n} 张选中照片` : '没有需要同步的选中照片(仅当前张)');
    },

    selectAllEls() {
        if (!this.template) return;
        this.selectedEls = [];
        (this.template.logoElements || []).forEach(o => this.selectedEls.push({ kind: 'logo', obj: o }));
        (this.template.decorConfig && this.template.decorConfig.stickers || []).forEach(o => this.selectedEls.push({ kind: 'sticker', obj: o }));
        (this.template.decorConfig && this.template.decorConfig.textLines || []).forEach(o => { if (o.align === 'free') this.selectedEls.push({ kind: 'text', obj: o }); });
        this.refreshElList();
    },

    /* ── 拖拽导入 ── */
    // 整窗接收:以前只绑在中间画布上,把照片拖到左侧素材栏 / 右侧参数栏 / 底部胶片条
    // 上什么都不会发生——落点没人管,Chromium 就按默认行为导航到那个 file:// URL,
    // 整个界面被一张图替换,用户看到的是「拖进去把软件弄坏了」,自然以为不支持拖入。
    setupDragDrop() {
        // 遮罩挂到 body 上,才能盖住三栏(fixed 定位不受 #canvasPane 的 overflow 影响)。
        const overlay = this.dom.dropOverlay;
        if (overlay && overlay.parentNode !== document.body) document.body.appendChild(overlay);

        // 只认操作系统文件(types 含 "Files");应用内拖元素(模板分组、缩略图)不带这个类型
        const hasFiles = (e) => {
            const types = (e.dataTransfer && e.dataTransfer.types) || [];
            for (let i = 0; i < types.length; i++) {
                if (String(types[i]).toLowerCase() === 'files') return true;
            }
            return false;
        };
        // 预设墙的卡片自己接「拖图换封面」:让卡片优先,别同时当成导入
        const ownDrop = (e) => e.target instanceof Element && !!e.target.closest('.pw-tile');

        let hideTimer = 0;
        const show = () => { document.body.classList.add('drop-active'); };
        const hide = () => { clearTimeout(hideTimer); document.body.classList.remove('drop-active'); };
        // dragover 在窗口内的连续触发就是「还在拖」的心跳:心跳停了 260ms 就收起遮罩。
        // 比 dragenter/dragleave 计数稳——后者在子元素之间移动时配对经常对不上,遮罩会闪。
        const beat = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 260); };

        window.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();            // 不拦 dragenter/dragover,drop 事件根本不会派发
            if (ownDrop(e)) { hide(); return; }
            show(); beat();
        });
        window.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            if (ownDrop(e)) { hide(); return; }
            show(); beat();
        });
        window.addEventListener('dragleave', (e) => { if (hasFiles(e)) beat(); });
        window.addEventListener('dragend', hide);
        window.addEventListener('blur', hide);
        window.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            hide();
            // 卡片等内部区域已经处理过这次 drop(preventDefault),不再当导入
            if (e.defaultPrevented) return;
            e.preventDefault();
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
            if (!files.length) return;
            // 统一走路径:文件与文件夹都能处理,RAW/HEIC 由主进程解码
            const paths = files.map(f => window.qingframe.getPathForFile(f)).filter(Boolean);
            if (!paths.length) { this.setStatus('无法读取拖入文件的路径'); return; }
            // 启动时盖着的是边框墙：拖图进来就是「我要开始做图」，
            // 先关墙（workbench 模式，不顺手套任何预设），导入进度条才看得见。
            if (this._wallActive && typeof this.closePresetWall === 'function') this.closePresetWall(true);
            this.importPaths(paths);
        });
    },

    /* 状态栏 / 主题 */
    statusMsg: '',
    setStatus(msg) {
        this.statusMsg = msg;
        this.diagLog && this.diagLog('状态: ' + msg);
        if (this.dom.stCanvas) {
            const m = String(msg || '');
            // 引导语和「批量导入结果」都是过程性提示，不是需要庆祝的操作结果：
            // 一律用中性灰，导入后让白色文件信息 (#stInfo) 接过主视线。
            // 文字完整保留 —— 跳过数 / ICC / 内存警告都在这句话里，只是不抢颜色。
            // 其它「已导入模板 / 已导入配置 / 已导入 LR 预设」仍是实打实的操作结果，保持成功绿。
            const guide = /已进入工作台|从左侧工具栏导入|导入照片开始|^已导入\s*\d+\s*张图片/.test(m);
            let level = ' st-hint';
            if (!guide && /失败|错误|不支持|不可用|无法|未找到|未加载|请先|请输入|至少保留|没有可|不存在|异常|缺失|未知原因/.test(m)) level = ' st-err';
            else if (!guide && /已|完成|成功/.test(m)) level = ' st-ok';
            this.dom.stCanvas.className = 'st-item grow' + level;
            this.dom.stCanvas.textContent = `输出 ${this.canvasW()}×${this.canvasH()}` + (m ? ` · ${m}` : '');
        }
    },
    canvasW() { return this.dom.canvas ? (this.dom.canvas._logW || this.dom.canvas.width) : 0; },
    canvasH() { return this.dom.canvas ? (this.dom.canvas._logH || this.dom.canvas.height) : 0; },

    // 通用文本输入弹窗(Electron 不支持 window.prompt),resolve 值或 null(取消)
    promptText(title, def) {
        return new Promise(resolve => {
            const ov = document.createElement('div');
            ov.className = 'modal-overlay';
            const card = document.createElement('div');
            card.className = 'modal-card';
            const head = document.createElement('div');
            head.className = 'modal-header';
            const t = document.createElement('div');
            t.className = 'modal-title';
            t.textContent = title || '输入';
            t.style.whiteSpace = 'pre-wrap';
            t.style.lineHeight = '1.5';
            t.style.maxHeight = '40vh';
            t.style.overflow = 'auto';
            const close = document.createElement('button');
            close.className = 'modal-close'; close.textContent = '\u00d7'; close.title = '取消';
            head.appendChild(t); head.appendChild(close);
            const body = document.createElement('div');
            body.className = 'modal-body';
            const input = document.createElement('input');
            input.type = 'text';
            input.value = def || '';
            input.className = 'ctl-tx';
            input.style.cssText = 'width:100%;box-sizing:border-box;font-size:13px;padding:8px 9px;';
            const btns = document.createElement('div');
            btns.className = 'btn-row btn-2';
            btns.style.cssText = 'padding:14px 0 0;';
            const btnCancel = document.createElement('button');
            btnCancel.className = 'mini-btn'; btnCancel.textContent = '取消';
            const btnOk = document.createElement('button');
            btnOk.className = 'mini-btn primary'; btnOk.textContent = '确定';
            btns.appendChild(btnCancel); btns.appendChild(btnOk);
            body.appendChild(input); body.appendChild(btns);
            card.appendChild(head); card.appendChild(body);
            ov.appendChild(card);
            document.body.appendChild(ov);
            const done = v => { document.body.removeChild(ov); resolve(v); };
            const ok = () => done(input.value);
            const cancel = () => done(null);
            btnOk.addEventListener('click', ok);
            btnCancel.addEventListener('click', cancel);
            close.addEventListener('click', cancel);
            ov.addEventListener('mousedown', e => { if (e.target === ov) cancel(); });
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') ok();
                if (e.key === 'Escape') cancel();
            });
            input.focus();
            try { input.select(); } catch (_) { /* 忽略 */ }
        });
    },
    updateStatusBar() {
        const tf = document.getElementById('titlebarFile');
        if (!this.image) {
            this.setStatus('');
            if (tf) tf.hidden = true;
            return;
        }
        const im = this.image;
        // 标题栏中间那行：文件名 + 序号。← / → 本来就能切图，这里只把
        // 「我在第几张」写进视线，让用户知道那对快捷键存在。
        if (tf) {
            tf.textContent = (im.name || '未命名') + ' · ' + (this.currentIdx + 1) + '/' + this.images.length;
            tf.title = '当前照片 · ← / → 切换上一张 / 下一张';
            tf.hidden = false;
        }
        // RAW 在代理阶段只有 1600px：不标注的话，状态栏会把代理尺寸当成照片尺寸，
        // 用户既看不出「还在显影」，也看不出「导出掉到了代理分辨率」。
        const rawTag = im.raw
            ? (im.raw.fullPending ? ' · RAW 显影中' : (im.raw.full ? ' · RAW' : ' · RAW 代理'))
            : '';
        this.dom.stRes.textContent = `原片 ${im.w}×${im.h}${rawTag}`;
        this.dom.stInfo.textContent = `${im.name} · ${this.currentIdx + 1}/${this.images.length}`;
        this.setStatus(this.statusMsg && !this.statusMsg.startsWith('输出') ? this.statusMsg : '');
    },

    toggleTheme() {
        const isDark = !document.documentElement.classList.contains('dark');
        const theme = isDark ? 'dark' : 'light';
        this.applyTheme(theme);
        // 持久化:下次启动沿用当前主题。主进程对 prefs 做字段级合并,单独存 theme 不会冲掉
        // fontScale / exportQuality 等其它偏好(见 main/state.js saveState)。
        if (window.qingframe && window.qingframe.savePrefs) {
            window.qingframe.savePrefs({ theme }).catch(() => {});
        }
        return isDark;
    },

    // 应用主题:theme 为 'dark' | 'light'。启动恢复与手动切换统一走这里,并同步设置里的分段控件。
    applyTheme(theme) {
        const root = document.documentElement;
        root.classList.toggle('dark', theme === 'dark');
        const seg = document.getElementById('segTheme');
        if (seg) {
            seg.querySelectorAll('[data-theme]').forEach((b) => {
                const on = b.dataset.theme === theme;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
        }
    },

    /* ── 用户资料(仅本地,用于签名/头像) ── */
    user: null,

    async initLogin() {
        try {
            const u = await window.qingframe.getUser();
            this.user = u;
        } catch (e) {
            this.user = null;
        }
        this.refreshLoginStatus();
    },

    openLoginModal() {
        const d = this.dom;
        d.loginModal.style.display = 'flex';
        if (this.user) {
            d.loginFormView.style.display = 'none';
            d.loginProfileView.style.display = 'block';
            this.renderProfile();
        } else {
            d.loginFormView.style.display = 'block';
            d.loginProfileView.style.display = 'none';
            d.loginUsername.value = '';
            d.loginNickname.value = '';
            setTimeout(() => d.loginUsername.focus(), 60);
        }
    },

    closeLoginModal() {
        this.dom.loginModal.style.display = 'none';
    },

    renderProfile() {
        const d = this.dom;
        const name = (this.user.nickname || this.user.username).trim();
        const av = localStorage.getItem('qfs_user_avatar');
        if (av) { d.loginAvatar.style.background = 'url(' + av + ') center/cover'; d.loginAvatar.textContent = ''; }
        else { d.loginAvatar.style.background = 'var(--avatar-bg)'; d.loginAvatar.textContent = ''; }
        d.loginDisplayName.textContent = name;
        d.loginUsernameDisplay.textContent = '仅保存在本机 · 用于签名 / 头像';
    },

    async doLogin() {
        const username = this.dom.loginUsername.value.trim();
        if (!username) { this.setStatus('请输入名称'); return; }
        const nickname = this.dom.loginNickname.value.trim() || username;
        this.user = { username, nickname, createdAt: Date.now() };
        try {
            await window.qingframe.saveUser(this.user);
            this.closeLoginModal();
            this.setStatus(`已保存「${nickname}」`);
            this.updateTopBar();
        } catch (e) {
            this.setStatus('保存失败：' + e.message);
        }
        this.refreshLoginStatus();
    },

    async doLogout() {
        try {
            await window.qingframe.logoutUser();
            this.user = null;
            this.closeLoginModal();
            // 旧版遗留键一并清掉，避免下次启动又读出一个已经不存在的名字
            localStorage.removeItem('qfs_username');
            localStorage.removeItem('qfs_nickname');
            this.setStatus('已清除名称');
            this.updateTopBar();
        } catch (e) {
            this.setStatus('清除失败：' + e.message);
        }
        this.refreshLoginStatus();
    },

    refreshLoginStatus() {
        // 顶栏不再有账号入口。用户资料只服务「签名 / 头像」参数，
        // 入口就是那个参数组里的按钮，这里只把已有昵称写在按钮上。
        const btn = document.getElementById('btnEditUserProfile');
        if (!btn) return;
        const name = this.user ? (this.user.nickname || this.user.username).trim() : '';
        btn.textContent = name ? '昵称与头像 · ' + name : '昵称与头像…';
        btn.title = this.user
            ? ('@' + this.user.username + ' · 点击修改；仅保存在本机')
            : '设置昵称与头像；仅保存在本机，用于签名 / 头像参数';
    },
});

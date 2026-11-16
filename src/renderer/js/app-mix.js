'use strict';
/* 混色器：8 色相带 × 色相/饱和度/明亮度（对齐 LR 的 HSL 面板），外加
 * 「细节」「校准」两组滑块的 UI 绑定（渲染本体在 app-grade.js）。
 *
 * 设计取舍
 * ─────────────────────────────────────────────────────────────
 * 1) 混色器是「按色相选区」的调整 —— 权重取决于每个像素自己的色相，
 *    本质是三维操作，逐通道 256 项 LUT 表达不了；SVG 掩膜近似每带要
 *    十几个滤镜原语 × 8 带，软件渲染烘焙会慢一个数量级。所以这一步
 *    用 WebGL 单 pass 着色器（RGB↔HSV + 带权重平滑混合），
 *    1600px 预览一次 <2ms，全分辨率也在个位数毫秒。
 * 2) WebGL 只是烘焙管线的**前置级**：原图 → GL(混色) → ctx.filter(其余全部)。
 *    GL 不可用/上下文丢失/着色器异常时 pass() 返回 null，bake 自动
 *    退回原图，混色器 UI 标记为不可用，其余功能完全不受影响。
 * 3) 带权重用 smoothstep 过渡、跨带重叠取加权平均而不是叠加，
 *    避免相邻带（红/橙只差 30°）同时拉满时颜色串台。
 */
(function () {
    // 点颜色最多几个样本。着色器按 8 组 uniform 写死，这里只是 UI 上限：
    // 6 个圆点刚好在「取样」右边排成一行，再多就得换行，反而看不清谁是谁。
    const PC_MAX = 6;

    // ── WebGL 烘焙前置级 ─────────────────────────────────────────
    const VS = 'attribute vec2 aP;varying vec2 vUV;void main(){vUV=aP*0.5+0.5;gl_Position=vec4(aP,0.0,1.0);}';
    const FS = [
        'precision mediump float;',
        'varying vec2 vUV;',
        'uniform sampler2D uT;',
        'uniform float uDh[8];uniform float uDs[8];uniform float uDl[8];',
        'uniform float uHc[8];uniform float uHw[8];',
        // 点颜色（LR 的 Point Color）：样本中心色 + 范围 + 四档调整，最多 8 个样本
        'uniform int uSn;',
        'uniform float uPH[8];uniform float uPS[8];uniform float uPL[8];uniform float uPR[8];',
        'uniform float uPDh[8];uniform float uPDs[8];uniform float uPDl[8];uniform float uPDv[8];',
        // LR 的「混色器」在 **HSL** 空间（色相/饱和度/明亮度），不是 HSV。
        // 用 HSV 的 V 当"明亮度"会出两个偏差：高饱和色 V 已经是 1，提亮完全提不动
        // （纯红 +24 明亮度在 LR 里会变亮变粉，我们纹丝不动）；低饱和色的 S 又偏高。
        // 实测同一组参数（饱和度 −13、明亮度 +24）两者最大单通道差 32 级。
        'vec3 rgb2hsl(vec3 c){',
        '  float mx=max(max(c.r,c.g),c.b);',
        '  float mn=min(min(c.r,c.g),c.b);',
        '  float d=mx-mn;',
        '  float l=(mx+mn)*0.5;',
        '  float s=0.0;',
        '  if(d>1e-6){ float den=1.0-abs(2.0*l-1.0); s=den>1e-4?d/den:0.0; }',
        '  float h=0.0;',
        '  if(d>1e-6){',
        // 色相必须「先除 6 再 fract」：写成 fract((g-b)/d+6.0)/6.0 时，
        // 纯黄 (r==g) 的 (g-b)/d 正好是 1，fract(7)=0 → 黄色被读成 0°，
        // 只要混色器 / 点颜色一跑，画面里的纯黄就会变红。
        '    if(mx==c.r) h=fract(((c.g-c.b)/d+6.0)/6.0);',
        '    else if(mx==c.g) h=((c.b-c.r)/d+2.0)/6.0;',
        '    else h=((c.r-c.g)/d+4.0)/6.0;',
        '  }',
        '  return vec3(h,s,l);',
        '}',
        'vec3 hsl2rgb(vec3 c){',
        '  float h=c.x;float s=c.y;float l=c.z;',
        '  float C=(1.0-abs(2.0*l-1.0))*s;',
        '  float X=C*(1.0-abs(mod(h*6.0,2.0)-1.0));',
        '  float m=l-C*0.5;',
        '  vec3 rgb;',
        '  if(h<1.0/6.0) rgb=vec3(C,X,0.0);',
        '  else if(h<2.0/6.0) rgb=vec3(X,C,0.0);',
        '  else if(h<3.0/6.0) rgb=vec3(0.0,C,X);',
        '  else if(h<4.0/6.0) rgb=vec3(0.0,X,C);',
        '  else if(h<5.0/6.0) rgb=vec3(X,0.0,C);',
        '  else rgb=vec3(C,0.0,X);',
        '  return rgb+m;',
        '}',
        'void main(){',
        '  vec3 c=texture2D(uT,vUV).rgb;',
        '  vec3 hsl=rgb2hsl(c);',
        '  float wsum=0.0,dh=0.0,ds=0.0,dl=0.0;',
        '  for(int i=0;i<8;i++){',
        '    float d=abs(hsl.x*360.0-uHc[i]);',
        '    d=min(d,360.0-d);',
        '    float w=clamp(1.0-d/uHw[i],0.0,1.0);',
        '    w=w*w*(3.0-2.0*w);',
        '    wsum+=w;dh+=w*uDh[i];ds+=w*uDs[i];dl+=w*uDl[i];',
        '  }',
        // 灰/黑/白不参与（HSL 里纯黑的 S 无意义，纯白/纯黑的 L 调整也无意义）
        '  if(wsum>0.001&&hsl.y>0.003&&hsl.z>0.01&&hsl.z<0.99){',
        '    hsl.x=fract(hsl.x+dh/wsum*0.1111);',
        '    hsl.y=clamp(hsl.y*(1.0+ds/wsum),0.0,1.0);',
        // 明亮度直接加到 L：L 与感知亮度同构，不需要 HSV 那套"提亮抑制亮端"的补丁。
        // 0.42 是满档幅度，1−0.9L 让接近纯白时收力，避免整片糊成白。
        '    hsl.z=clamp(hsl.z+dl/wsum*0.42*(1.0-0.9*hsl.z),0.0,1.0);',
        '  }',
        // ── 点颜色样本 ──
        // 权重 = 色相距离（由「范围」决定半宽）+ 饱和度/亮度接近度衰减；
        // 颜色越接近样本色权重越高，所以一片同色会被整体带动，邻近色只被扫到一点。
        // 单位约定：uPH 与 hsl.x 都是 0–1 的归一化色相（pass() 上传前 /360），
        // 所以距离要先换算成角度，才能和下面按「度」定义的 hw 比。
        // 早先这里写成 hsl.x*360.0-uPH[k]，等于拿 0–360 去减 0–1：
        // 只有样本色相接近 0°（红色）时权重才不为 0，其余颜色全部静默失效。
        '  if(uSn>0&&hsl.y>0.003&&hsl.z>0.01&&hsl.z<0.99){',
        '    float ws=0.0,sh=0.0,ss=0.0,sl=0.0,sv=0.0,ha=0.0,sa=0.0,la=0.0;',
        '    for(int k=0;k<8;k++){',
        '      float live=step(float(k)+0.5,float(uSn));',
        '      float d2=abs(hsl.x-uPH[k])*360.0;d2=min(d2,360.0-d2);',
        '      float hw=6.0+uPR[k]*0.72;',
        '      float w2=clamp(1.0-d2/hw,0.0,1.0);w2=w2*w2*(3.0-2.0*w2);',
        // 范围越窄，饱和/亮度也要更接近才算同一个颜色；范围拉宽则一起放宽。
        // rt 必须随「范围」单调递增：早先写成 1-uPR*0.01，范围拉满时色相容差最大、
        // 饱和/亮度容差却收到最紧，等于「范围越大越不灵」，和滑块的语义相反。
        '      float rt=uPR[k]*0.01;',
        '      float dsa=abs(hsl.y-uPS[k])/(0.30+0.40*rt);',
        '      w2*=clamp(1.0-dsa*dsa,0.0,1.0);',
        '      float dla=abs(hsl.z-uPL[k])/(0.45+0.45*rt);',
        '      w2*=clamp(1.0-dla*dla,0.0,1.0);',
        '      w2*=live;',
        '      ws+=w2;sh+=w2*uPDh[k];ss+=w2*uPDs[k];sl+=w2*uPDl[k];sv+=w2*uPDv[k];',
        '      ha+=w2*uPH[k];sa+=w2*uPS[k];la+=w2*uPL[k];',
        '    }',
        '    if(ws>0.001){',
        '      float t=min(ws,1.0);',
        '      hsl.x=fract(hsl.x+(sh/ws)*0.1111*t);',
        '      hsl.y=clamp(hsl.y*(1.0+(ss/ws)*t),0.0,1.0);',
        '      hsl.z=clamp(hsl.z+(sl/ws)*0.42*(1.0-0.9*hsl.z)*t,0.0,1.0);',
        // 变量：负值把范围内颜色向样本中心收拢、正值增强彼此的差异（LR 的「变异」）
        '      float vv=(sv/ws)*t;',
        '      if(abs(vv)>0.001){',
        '        float hd=hsl.x-ha/ws;hd=hd-floor(hd+0.5);',
        '        hsl.x=fract(hsl.x+vv*0.5*hd);',
        '        hsl.y=clamp(hsl.y+vv*0.5*(hsl.y-sa/ws),0.0,1.0);',
        '        hsl.z=clamp(hsl.z+vv*0.35*(hsl.z-la/ws),0.0,1.0);',
        '      }',
        '    }',
        '  }',
        '  gl_FragColor=vec4(hsl2rgb(hsl),1.0);',
        '}'
    ].join('\n');
    // 0.1111 = 40/360：滑块满档 ±100 → 色相 ±40°

    let gl = null, glc = null, prog = null, uni = null, quad = null;

    function init() {
        if (gl && prog) return true;
        if (!gl) {
            try {
                glc = document.createElement('canvas');
                gl = glc.getContext('webgl', { preserveDrawingBuffer: true, antialias: false })
                    || glc.getContext('experimental-webgl', { preserveDrawingBuffer: true, antialias: false });
            } catch (_) { gl = null; }
            if (!gl) return false;
            glc.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                gl = null; prog = null; uni = null;
            });
        }
        try {
            const sh = (type, src) => {
                const s = gl.createShader(type);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
                return s;
            };
            prog = gl.createProgram();
            gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
            gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
            gl.useProgram(prog);
            quad = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quad);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
            const loc = gl.getAttribLocation(prog, 'aP');
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            // 画布坐标 y 向下、纹理 t 向上：翻转上传，免得画出来是倒的
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            uni = {
                dh: gl.getUniformLocation(prog, 'uDh'),
                ds: gl.getUniformLocation(prog, 'uDs'),
                dl: gl.getUniformLocation(prog, 'uDl'),
                hc: gl.getUniformLocation(prog, 'uHc'),
                hw: gl.getUniformLocation(prog, 'uHw'),
                sn: gl.getUniformLocation(prog, 'uSn'),
                pH: gl.getUniformLocation(prog, 'uPH'),
                pS: gl.getUniformLocation(prog, 'uPS'),
                pL: gl.getUniformLocation(prog, 'uPL'),
                pR: gl.getUniformLocation(prog, 'uPR'),
                pDh: gl.getUniformLocation(prog, 'uPDh'),
                pDs: gl.getUniformLocation(prog, 'uPDs'),
                pDl: gl.getUniformLocation(prog, 'uPDl'),
                pDv: gl.getUniformLocation(prog, 'uPDv')
            };
            gl.uniform1i(gl.getUniformLocation(prog, 'uT'), 0);
            return true;
        } catch (_) {
            gl = null; prog = null; uni = null;
            return false;
        }
    }

    function pass(src, mix, samples, w, h, withBands) {
        if (!init()) return null;
        try {
            if (glc.width !== w || glc.height !== h) { glc.width = w; glc.height = h; }
            gl.viewport(0, 0, w, h);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
            const bands = (window.App && window.App.MIX_BANDS) || [];
            // mix 可能是 null（defaultGrade / sanitizeMix 都给 null），直接下标会抛
            // TypeError，被下面的 catch 吞成「pass 返回 null」，于是整张图退回原样 ——
            // 表现就是「点颜色调了没反应」。这里先兜成空对象。
            // 三维表可用时色带已经在表里，这里只补样本 —— 把带的三档全部置 0，
            // 权重仍算但不产生位移（乘法 1、加法 0），就不用给着色器加分支。
            const mv = mix || {};
            const bandsOn = withBands !== false;
            const dh = [], ds = [], dl = [], hc = [], hw = [];
            for (const b of bands) {
                const v = (bandsOn && (mv[b.k] || {})) || {};
                dh.push((Number(v.h) || 0) / 100);
                ds.push((Number(v.s) || 0) / 100);
                dl.push((Number(v.l) || 0) / 100);
                hc.push(b.hue);
                hw.push(b.hw);
            }
            gl.uniform1fv(uni.dh, new Float32Array(dh));
            gl.uniform1fv(uni.ds, new Float32Array(ds));
            gl.uniform1fv(uni.dl, new Float32Array(dl));
            gl.uniform1fv(uni.hc, new Float32Array(hc));
            gl.uniform1fv(uni.hw, new Float32Array(hw));
            // 样本：固定上传 8 组，用 uSn 截断实际生效个数（未用的位置填中性值）
            const list = Array.isArray(samples) ? samples.slice(0, 8) : [];
            const pH = [], pS = [], pL = [], pR = [];
            const pDh = [], pDs = [], pDl = [], pDv = [];
            for (let i = 0; i < 8; i++) {
                const s = list[i];
                pH.push(s ? ((((Number(s.hue) || 0) % 360) + 360) % 360) / 360 : 0);
                pS.push(s ? Math.max(0, Math.min(1, Number(s.sat) || 0)) : 0);
                pL.push(s ? Math.max(0.01, Math.min(0.99, Number(s.light) || 0.5)) : 0.5);
                pR.push(s ? Math.max(0, Math.min(100, Number(s.range) || 0)) : 0);
                pDh.push(s ? (Number(s.dh) || 0) / 100 : 0);
                pDs.push(s ? (Number(s.ds) || 0) / 100 : 0);
                pDl.push(s ? (Number(s.dl) || 0) / 100 : 0);
                pDv.push(s ? (Number(s.dv) || 0) / 100 : 0);
            }
            gl.uniform1i(uni.sn, list.length);
            gl.uniform1fv(uni.pH, new Float32Array(pH));
            gl.uniform1fv(uni.pS, new Float32Array(pS));
            gl.uniform1fv(uni.pL, new Float32Array(pL));
            gl.uniform1fv(uni.pR, new Float32Array(pR));
            gl.uniform1fv(uni.pDh, new Float32Array(pDh));
            gl.uniform1fv(uni.pDs, new Float32Array(pDs));
            gl.uniform1fv(uni.pDl, new Float32Array(pDl));
            gl.uniform1fv(uni.pDv, new Float32Array(pDv));
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            return glc;
        } catch (e) {
            return null;
        }
    }

    window.QfsMix = {
        pass,
        available() { return init(); }
    };

    // ── UI：细节 / 校准 / 混色器三组滑块 ─────────────────────────
    function fmt(v) { return v === 0 ? '0' : (v > 0 ? '+' + v : String(v)); }
    // 「效果」段的纹理 / 清晰度 / 去除薄雾与同组晕影、颗粒对齐，用纯数字；
    // 其余（锐化 / 校准 / 混色器）沿用带符号整数或各自的 fmt。
    const PLAIN_DET_KEYS = new Set(['tex', 'clar', 'dhz']);
    const labelText = (rec, v) => {
        const n = Number(v) || 0;
        if (rec.fmt) return rec.fmt(n);
        return rec.plain ? String(n) : fmt(n);
    };

    Object.assign(window.App || (window.App = {}), {
        _mixMetric: 'h',

        initGradeExtra() {
            const $ = (id) => document.getElementById(id);
            this._gradeExtra = { det: {}, cal: {}, mix: {} };
            const showLabel = (rec) => {
                const lbl = rec && rec.lbl;
                if (!lbl) return;
                const text = labelText(rec, rec.inp.value);
                // 与 syncGradeExtraUI 一样走 updateLabel：它是数字框(.pval-num)的唯一同步入口。
                if (lbl.id && typeof this.updateLabel === 'function') this.updateLabel(lbl.id, text);
                else lbl.textContent = text;
            };
            const bind = (inp, rec, apply) => {
                if (!inp) return;
                let settle = 0;
                const thumb = () => {
                    const im = this.image;
                    if (im && this.renderFramedThumb) {
                        clearTimeout(im._gradeThumbT);
                        im._gradeThumbT = setTimeout(() => this.renderFramedThumb(im), 260);
                    }
                };
                inp.addEventListener('input', () => {
                    apply(Number(inp.value) || 0);
                    // 拖动时即时回填：只靠 syncGradeExtraUI（切图/撤销/套预设才跑）
                    // 会让标签在整个拖动过程里停在旧值，看上去像控件没反应。
                    showLabel(rec);
                    clearTimeout(settle);
                    settle = setTimeout(() => { this.rebuildGrade('full'); thumb(); }, 220);
                });
                inp.addEventListener('change', () => {
                    clearTimeout(settle);
                    apply(Number(inp.value) || 0);
                    showLabel(rec);
                    this.rebuildGrade('full');
                    thumb();
                });
                showLabel(rec);
            };
            // 细节 / 校准：扁平参数组，patch 进 grade.det / grade.cal
            const bindGroup = (spec, key) => {
                for (const it of spec) {
                    const inp = $('sl' + it.id), lbl = $('lbl' + it.id);
                    if (inp) {
                        // fmt：半径这类小数字段要自己决定显示（+0.5 不合适），
                        // 没有就用默认的「带符号整数」
                        const rec = { inp, lbl, fmt: it.fmt, plain: !!it.plain };
                        this._gradeExtra[key][it.k] = rec;
                        bind(inp, rec, (v) => {
                            const cur = this.gradeOf(this.image);
                            const g = Object.assign({}, cur[key] || {}, { [it.k]: v });
                            this.setGrade({ [key]: g });
                        });
                    }
                }
            };
            // fmt 要一起带过去：半径是小数，默认的「带符号整数」会显示成 +0.8
            bindGroup(this.DET_FIELDS.map((f) => ({
                k: f.k, id: 'Det' + f.k.charAt(0).toUpperCase() + f.k.slice(1), fmt: f.fmt,
                plain: PLAIN_DET_KEYS.has(f.k)
            })), 'det');
            bindGroup(this.CAL_FIELDS.map((f) => ({ k: f.k, id: 'Cal' + f.k.toUpperCase() })), 'cal');
            // 混色器：24 个滑块（8 带 × 3 项），patch 进 grade.mix
            for (const b of this.MIX_BANDS) {
                for (const mt of this.MIX_METRICS) {
                    const id = 'Mix' + b.k.toUpperCase() + mt.k.toUpperCase();
                    const inp = $('sl' + id), lbl = $('lbl' + id);
                    if (inp) {
                        inp.style.setProperty('--h', String(b.hue));
                        const rec = { inp, lbl };
                        this._gradeExtra.mix[b.k + '.' + mt.k] = rec;
                        bind(inp, rec, (v) => {
                            const cur = this.gradeOf(this.image);
                            const m = Object.assign({}, cur.mix || {});
                            m[b.k] = Object.assign({ h: 0, s: 0, l: 0 }, m[b.k] || {}, { [mt.k]: v });
                            this.setGrade({ mix: m });
                        });
                    }
                }
            }
            // 混色器「色相/饱和度/明亮度」子页
            const tabs = $('mixMetrics');
            if (tabs) {
                const btns = Array.prototype.slice.call(tabs.querySelectorAll('.curve-chan'));
                btns.forEach((btn) => {
                    btn.addEventListener('click', () => {
                        this._mixMetric = btn.dataset.m || 'h';
                        const grp = $('grpMix');
                        if (grp) grp.dataset.m = this._mixMetric;
                        btns.forEach((x) => x.classList.toggle('active', x === btn));
                    });
                });
                const grp = $('grpMix');
                if (grp) grp.dataset.m = this._mixMetric;
            }
            const mixReset = $('btnMixReset');
            if (mixReset) {
                mixReset.addEventListener('click', () => {
                    // 点颜色样本也在这个组里：只清八条色带会让「重置」看起来没生效
                    const hadSamples = this._pcSamples().length > 0;
                    this.setGrade(hadSamples ? { mix: null, samples: null } : { mix: null });
                    this._pcRefresh();
                    this.setStatus(hadSamples ? '已重置混色器与点颜色样本' : '已重置混色器');
                });
            }
            // 吸管取色（LR 的 TAT）：必须在混色器滑块绑定之后，
            // 它要读写 _mixMetric 与 _gradeExtra.mix 的那一套 id。
            this._initMixPicker();
            // 点颜色（LR 的 Point Color）：取色建样本，和上面那套互斥
            this._initPointColor();
            // WebGL 不可用：混色器整组禁用并说明原因，其余功能照常
            const grpMix = $('grpMix');
            if (grpMix && window.QfsMix && !window.QfsMix.available()) {
                grpMix.classList.add('mix-na');
            }
        },

        /* ── 吸管取色（对齐 LR 的目标调整工具 / TAT）────────────────────
         * LR 的 HSL 面板有个「在图上点一下就锁到那条色带」的工具：点一处颜色，
         * 它按该像素的色相判断属于哪条带，之后上下拖就只改这一条。
         *
         * 这里照同一套：① 取色从**当前烘焙结果**采样（所见即所得，调过色相
         * 之后仍点得中眼睛看到的那个色）；② 命中判定用与 GL 着色器**完全
         * 相同**的带权重公式（clamp(1-d/hw) 再 smoothstep），保证"点中的那条"
         * 就是"着色器认为权重最大的那条"；③ 拖动只写当前子页的指标
         * （色相/饱和度/明亮度），与面板状态一致。
         *
         * 事件全走 capture 阶段并 stopPropagation：否则按下会被画布的平移/
         * 元素拖动接走，吸管就成了"点一下画面就跳"。
         */
        _initMixPicker() {
            const btn = document.getElementById('btnMixPick');
            const cv = this.dom && this.dom.canvas;
            if (!btn || !cv) return;
            const ov = document.getElementById('maskOverlay');
            const pane = (this.dom && this.dom.canvasPane) || document.getElementById('canvasPane');
            // 1×1 采样画布：只读回一个像素，比 getImageData 整幅便宜一个数量级
            const tmp = document.createElement('canvas');
            tmp.width = 1; tmp.height = 1;
            const st = this._mixPick = {
                on: false, band: null, metric: 'h', y0: 0, v0: 0, hue: 0,
                moved: false, raf: 0, pending: 0,
                ctx: tmp.getContext('2d', { willReadFrequently: true })
            };
            const METRIC_LABEL = { h: '色相', s: '饱和度', l: '明亮度' };
            let lastHover = 0;

            const setOn = (on) => {
                st.on = !!on;
                if (st.on && this._pc && this._pc.setOn) this._pc.setOn(false);
                btn.classList.toggle('active', st.on);
                btn.setAttribute('aria-pressed', st.on ? 'true' : 'false');
                if (pane) pane.classList.toggle('mix-picking', st.on);
                if (st.on) {
                    this.setStatus('吸管：在照片上点一下取色，再上下拖动单独调这条色带（Esc 退出）');
                } else {
                    st.band = null;
                    this._mixPickHot(null);
                }
            };
            st.setOn = setOn;

            const onDown = (e) => {
                if (!st.on || e.button !== 0) return;
                const s = this._mixPickSample(e);
                if (!s) {
                    e.preventDefault(); e.stopPropagation();
                    this.setStatus('点在照片范围内取色（这里落在画布或边框上）');
                    return;
                }
                e.preventDefault(); e.stopPropagation();
                st.band = s.band;
                st.metric = this._mixMetric || 'h';
                st.y0 = e.clientY;
                st.v0 = this._mixPickValue(s.band.k, st.metric);
                st.hue = s.hue;
                st.moved = false;
                st.pending = st.v0;
                this._mixPickHot(s.band, st.metric);
                this.setStatus('已锁定「' + s.band.label + '」· 上下拖动调' +
                    (METRIC_LABEL[st.metric] || '数值') +
                    (s.flat ? '（此处接近中性灰，幅度有限）' : ''));
                document.addEventListener('mousemove', onDrag, true);
                document.addEventListener('mouseup', onUp, true);
            };

            const onDrag = (e) => {
                if (!st.on || !st.band) return;
                e.preventDefault(); e.stopPropagation();
                const dy = st.y0 - e.clientY;
                // 3px 死区：单击（或手抖）不该改数值，只用来锁色带
                if (!st.moved && Math.abs(dy) < 3) return;
                st.moved = true;
                const val = Math.max(-100, Math.min(100, Math.round(st.v0 + dy * 0.5)));
                if (val === st.pending) return;
                st.pending = val;
                if (st.raf) return;
                // 一帧只烘一次：拖动时 mousemove 比 rAF 密得多，逐条 setGrade 会白烘好几遍
                st.raf = requestAnimationFrame(() => {
                    st.raf = 0;
                    const band = st.band;
                    if (!band || !st.on) return;
                    const cur = this.gradeOf(this.image);
                    const m = Object.assign({}, cur.mix || {});
                    m[band.k] = Object.assign({ h: 0, s: 0, l: 0 }, m[band.k] || {},
                        { [st.metric]: st.pending });
                    this.setGrade({ mix: m });
                    this.setStatus('「' + band.label + '」' + (METRIC_LABEL[st.metric] || '') +
                        ' ' + fmt(st.pending));
                });
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onDrag, true);
                document.removeEventListener('mouseup', onUp, true);
                if (!st.on || !st.band) return;
                if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
                if (st.moved) {
                    // 松手补全分辨率：拖动期间只走 1600px 低档，停在半截预览上不好看
                    const band = st.band;
                    setTimeout(() => { if (this.image) this.rebuildGrade('full'); }, 0);
                    this.setStatus('「' + band.label + '」' + (METRIC_LABEL[st.metric] || '') +
                        ' ' + fmt(st.pending));
                } else {
                    this.setStatus('已选中「' + st.band.label + '」' + Math.round(st.hue) +
                        '° · 上下拖动即可单独调' + (METRIC_LABEL[st.metric] || ''));
                }
            };

            // 悬停先给反馈：高亮即将命中的那条，用户还没按下就知道会点到哪
            const onHover = (e) => {
                if (!st.on || st.band) return;
                const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                if (now - lastHover < 40) return;   // 40ms 节流：采样+高亮不必每像素一次
                lastHover = now;
                const s = this._mixPickSample(e);
                this._mixPickHot(s ? s.band : null, this._mixMetric || 'h');
            };

            btn.addEventListener('click', () => setOn(!st.on));
            for (const el of [cv, ov]) {
                if (!el) continue;
                el.addEventListener('mousedown', onDown, true);
                el.addEventListener('mousemove', onHover, true);
            }
            cv.addEventListener('mouseleave', () => {
                if (st.on && !st.band) this._mixPickHot(null);
            });
            document.addEventListener('keydown', (e) => {
                if (st.on && e.key === 'Escape') { setOn(false); this.setStatus('已退出吸管'); }
            });
        },

        /* 屏幕坐标 → 照片像素 → 色相 → 命中的色带。
           坐标口径：画布视觉矩形 = 整幅画布；_photoRect 与 _baseSize() 都是
           「基准坐标」（与蒙版浮层同一套），不能拿 canvas.width 直接比。 */
        _mixPickSample(e) {
            const cv = this.dom && this.dom.canvas;
            const im = this.image;
            const st = this._mixPick;
            if (!cv || !im || !im.el || !st || !st.ctx) return null;
            const rect = cv.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            const pr = this._photoRect;
            if (!pr || !(pr.w > 0) || !(pr.h > 0)) return null;
            const base = (typeof this._baseSize === 'function')
                ? this._baseSize() : { w: cv.width, h: cv.height };
            const bx = (e.clientX - rect.left) / rect.width * base.w;
            const by = (e.clientY - rect.top) / rect.height * base.h;
            const nx = (bx - pr.x) / pr.w, ny = (by - pr.y) / pr.h;
            if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return null;
            // 采样源优先用烘焙后的降采样画布：拖过参数之后还能点中眼睛看到的颜色。
            // 但 grade 回到中性时那张画布是**上一次烘焙的残留**（neutral 分支只清 key、
            // 不清图，为的是省一次重烘），拿它取色会读到早就撤掉的调整 —— 此时必须回原图。
            const gd = im._grade || {};
            const baked = !gd.neutral ? (gd.low || gd.canvas) : null;
            const src = baked || im.el;
            const W = src.width || src.naturalWidth || 0;
            const H = src.height || src.naturalHeight || 0;
            if (!W || !H) return null;
            const sx = Math.max(0, Math.min(W - 1, Math.floor(nx * W)));
            const sy = Math.max(0, Math.min(H - 1, Math.floor(ny * H)));
            let px = null;
            try {
                st.ctx.clearRect(0, 0, 1, 1);
                st.ctx.drawImage(src, sx, sy, 1, 1, 0, 0, 1, 1);
                px = st.ctx.getImageData(0, 0, 1, 1).data;
            } catch (_) { px = null; }
            if (!px) return null;
            const r = px[0] / 255, g = px[1] / 255, b = px[2] / 255;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
            const l = (mx + mn) * 0.5;
            const den = 1 - Math.abs(2 * l - 1);
            const sat = (d > 1e-6 && den > 1e-4) ? d / den : 0;
            let hue = 0;
            if (d > 1e-6) {
                if (mx === r) hue = ((g - b) / d + 6) % 6;
                else if (mx === g) hue = (b - r) / d + 2;
                else hue = (r - g) / d + 4;
                hue *= 60;
            }
            hue = ((hue % 360) + 360) % 360;
            // 与着色器同一条判据：灰/近黑/近白本来就不参与混色器
            const flat = sat <= 0.003 || l <= 0.01 || l >= 0.99;
            return { hue, sat, light: l, flat, band: this._mixPickBand(hue) };
        },

        /* 与 GL 着色器完全相同的带权重：w = clamp(1 - d/hw, 0, 1)，再 smoothstep。
           权重全为 0（落在带间空档）时退到角度最近的那条，保证点了总有反馈。 */
        _mixPickBand(hue) {
            const bands = this.MIX_BANDS || [];
            let best = null, bestW = 0, near = null, nearD = 1e9;
            for (const b of bands) {
                let dd = Math.abs(hue - b.hue);
                dd = Math.min(dd, 360 - dd);
                if (dd < nearD) { nearD = dd; near = b; }
                const w = Math.max(0, 1 - dd / b.hw);
                const ww = w * w * (3 - 2 * w);
                if (ww > bestW) { bestW = ww; best = b; }
            }
            return bestW > 1e-4 ? best : near;
        },

        _mixPickValue(k, metric) {
            const g = this.gradeOf(this.image);
            const v = g && g.mix && g.mix[k];
            return v ? Math.round(Number(v[metric]) || 0) : 0;
        },

        /* 高亮命中的色带行：按 id 找行（slMix + 带 + 指标），不依赖 DOM 顺序 */
        _mixPickHot(band, metric) {
            const rows = document.querySelectorAll('#mixRows .mix-row');
            for (const r of rows) r.classList.remove('mix-hot');
            if (!band) return;
            const id = 'slMix' + band.k.toUpperCase() + (metric || this._mixMetric || 'h').toUpperCase();
            const inp = document.getElementById(id);
            const row = (inp && inp.closest) ? inp.closest('.param-row') : null;
            if (row) row.classList.add('mix-hot');
        },

        /* ── 点颜色（对齐 LR 的 Point Color）────────────────────────────
         * 和混色器的 8 个固定色带是两件事：这里的样本中心色就是「用户点到的那个
         * 颜色」，界面最多 6 个（着色器 uniform 按 8 组写死，留出旧工程的余量）；
         * 样本自己的 色相/饱和度/明亮度/变量 只作用在够接近
         * 它的像素上，「范围」决定"够接近"有多宽。
         *
         * 采样复用 _mixPickSample：同一套坐标口径、同样从烘焙结果取样，
         * 所以取色取到的就是屏幕上看到的那个颜色。
         */
        _initPointColor() {
            const $ = (id) => document.getElementById(id);
            const cv = this.dom && this.dom.canvas;
            const ov = document.getElementById('maskOverlay');
            const pane = (this.dom && this.dom.canvasPane) || document.getElementById('canvasPane');
            const btn = $('btnPcPick');
            const grp = $('grpMix');
            if (!btn || !grp) return;
            const tmp = document.createElement('canvas');
            tmp.width = 1; tmp.height = 1;
            const st = this._pc = {
                on: false, idx: 0, max: PC_MAX,
                ctx: tmp.getContext('2d', { willReadFrequently: true })
            };
            // 滑块拖动走 rAF 节流：这份「还没落地」的快照必须在样本集合变化时作废，
            // 否则一个排在队列里的旧快照会把刚删掉 / 刚新增的样本覆盖回去。
            let raf = 0, pending = null, settle = 0;
            const dropPending = () => {
                pending = null;
                if (raf) { cancelAnimationFrame(raf); raf = 0; }
                clearTimeout(settle);
                settle = 0;
            };
            st.dropPending = dropPending;

            const setOn = (on) => {
                st.on = !!on;
                // 两套取色互斥：同时开着会抢同一个画布按下事件
                if (st.on && this._mixPick && this._mixPick.setOn) this._mixPick.setOn(false);
                btn.classList.toggle('active', st.on);
                btn.setAttribute('aria-pressed', st.on ? 'true' : 'false');
                if (pane) pane.classList.toggle('mix-picking', st.on);
                if (st.on) this.setStatus('点颜色取样：在照片上点一下取这个颜色（Esc 退出）');
            };
            st.setOn = setOn;

            const onDown = (e) => {
                if (!st.on || e.button !== 0) return;
                if (this._mixPick && this._mixPick.on) return;
                const s = this._mixPickSample(e);
                e.preventDefault(); e.stopPropagation();
                if (!s) { this.setStatus('点在照片范围内取色（这里落在画布或边框上）'); return; }
                if (s.flat) { this.setStatus('这里接近中性灰，没有可归属的颜色'); return; }
                dropPending();
                const list = this._pcSamples().slice();
                let near = -1;
                for (let i = 0; i < list.length; i++) {
                    const x = list[i];
                    let d = Math.abs((x.hue || 0) - s.hue);
                    d = Math.min(d, 360 - d);
                    if (d < 8 && Math.abs((x.sat || 0) - s.sat) < 0.08
                        && Math.abs((x.light || 0.5) - s.light) < 0.15) { near = i; break; }
                }
                if (near >= 0) {
                    st.idx = near;
                    st.on = false;
                    btn.classList.remove('active');
                    btn.setAttribute('aria-pressed', 'false');
                    if (pane) pane.classList.remove('mix-picking');
                    this.setStatus('这个颜色已经有样本（' + Math.round(list[near].hue) + '°），直接调它就行');
                    this._pcRefresh();
                    return;
                }
                // 满 6 个就拦下：不静默替换当前样本（那样用户不知道丢了哪个），
                // 抖动一下样本条 + 说明怎么腾位置，取样态保持开着，还能点已有颜色切样本。
                if (list.length >= PC_MAX) {
                    const box = $('pcStrip');
                    if (box) {
                        box.classList.remove('pc-full');
                        void box.offsetWidth;     // 强制重排，动画重新开始
                        box.classList.add('pc-full');
                        setTimeout(() => box.classList.remove('pc-full'), 900);
                    }
                    this.setStatus('最多 ' + PC_MAX + ' 个样本：先点样本右上角的 × 删掉一个，再取新颜色');
                    return;
                }
                const smp = {
                    hue: Math.round(s.hue),
                    sat: Math.round(s.sat * 1000) / 1000,
                    light: Math.round(s.light * 1000) / 1000,
                    range: 30, dh: 0, ds: 0, dl: 0, dv: 0
                };
                list.push(smp);
                st.idx = list.length - 1;
                this.setGrade({ samples: list });
                setOn(false);
                this._pcRefresh();
                this.setStatus('已取样 ' + smp.hue + '° · 用下面四个滑块单独调它');
            };

            for (const el of [cv, ov]) {
                if (!el) continue;
                el.addEventListener('mousedown', onDown, true);
            }
            btn.addEventListener('click', () => setOn(!st.on));

            // 一级页签：混色器 / 点颜色
            const tabs = $('mixTabs');
            if (tabs) {
                const tset = Array.prototype.slice.call(tabs.querySelectorAll('.mix-tab'));
                tset.forEach((b) => {
                    b.addEventListener('click', () => {
                        const t = b.dataset.tab || 'mix';
                        grp.dataset.tab = t;
                        tset.forEach((x) => x.classList.toggle('active', x === b));
                        dropPending();
                        if (t !== 'pc') setOn(false);
                        else { this._pcRefresh(); this.setStatus('点颜色：取样后单独调那个颜色'); }
                    });
                });
            }

            // 样本条：圆点就摆在「取样」右边，点圆点切样本、点 × 删、点空格子进取样态
            const strip = $('pcStrip');
            if (strip) {
                strip.addEventListener('click', (e) => {
                    const t = e.target;
                    const del = t.closest ? t.closest('[data-del]') : null;
                    if (del) {
                        e.preventDefault(); e.stopPropagation();
                        dropPending();
                        const i = Number(del.dataset.del) || 0;
                        const list = this._pcSamples().slice();
                        list.splice(i, 1);
                        this.setGrade({ samples: list.length ? list : null });
                        // 删除当前选中项之前的样本时，后面的样本整体前移一格。
                        // 只夹上界会让 idx 原地指向"下一个颜色"，滑块静默改错样本。
                        if (i < st.idx) st.idx--;
                        else if (st.idx >= list.length) st.idx = Math.max(0, list.length - 1);
                        this._pcRefresh();
                        this.setStatus(list.length ? '已删除这个样本' : '样本已清空');
                        return;
                    }
                    if (t.closest && t.closest('[data-add]')) { setOn(true); return; }
                    const chip = t.closest ? t.closest('.pc-chip') : null;
                    if (chip) {
                        st.idx = Number(chip.dataset.i) || 0;
                        this._pcRefresh();
                        this.setStatus('已切到样本 ' + (st.idx + 1) + ' · 用下面四个滑块单独调它');
                    }
                });
                // 圆点是 div[role=button]，补上键盘回车 / 空格
                strip.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    const chip = e.target.closest ? e.target.closest('.pc-chip') : null;
                    if (!chip) return;
                    e.preventDefault();
                    st.idx = Number(chip.dataset.i) || 0;
                    this._pcRefresh();
                });
            }

            // 五个滑块：改的是「当前样本」的那一项，拖动走 rAF 节流，松手补全分辨率
            const FIELDS = [
                { id: 'slPcH', k: 'dh', plain: false },
                { id: 'slPcS', k: 'ds', plain: false },
                { id: 'slPcL', k: 'dl', plain: false },
                { id: 'slPcVar', k: 'dv', plain: false },
                { id: 'slPcRange', k: 'range', plain: true }
            ];
            const pushFrame = (list) => {
                pending = list;
                if (raf) return;
                raf = requestAnimationFrame(() => {
                    raf = 0;
                    if (!pending) return;
                    this.setGrade({ samples: pending });
                    pending = null;
                });
            };
            for (const f of FIELDS) {
                const inp = $(f.id);
                if (!inp) continue;
                const lbl = $(f.id.replace('sl', 'lbl'));
                const show = (v) => { if (lbl) lbl.textContent = f.plain ? String(v) : fmt(v); };
                inp.addEventListener('input', () => {
                    const v = Number(inp.value) || 0;
                    show(v);
                    const list = this._pcSamples().slice();
                    const cur = list[st.idx];
                    if (!cur) return;
                    list[st.idx] = Object.assign({}, cur, { [f.k]: v });
                    pushFrame(list);
                    clearTimeout(settle);
                    settle = setTimeout(() => { this.rebuildGrade('full'); }, 220);
                });
                inp.addEventListener('change', () => {
                    clearTimeout(settle);
                    const v = Number(inp.value) || 0;
                    show(v);
                    const list = this._pcSamples().slice();
                    const cur = list[st.idx];
                    if (cur) {
                        list[st.idx] = Object.assign({}, cur, { [f.k]: v });
                        this.setGrade({ samples: list });
                    }
                    this.rebuildGrade('full');
                });
            }

            document.addEventListener('keydown', (e) => {
                if (st.on && e.key === 'Escape') { setOn(false); this.setStatus('已退出取样'); }
            });
            this._pcRefresh();
        },

        _pcSamples() {
            const g = this.gradeOf(this.image);
            return (g && Array.isArray(g.samples)) ? g.samples : [];
        },

        _pcCss(s) {
            return 'hsl(' + Math.round(s.hue) + ',' + Math.round((s.sat || 0) * 100) + '%,'
                + Math.round((Number.isFinite(s.light) ? s.light : 0.5) * 100) + '%)';
        },

        /* 把当前样本回填到色块 / 五个滑块 / 样本列表（切图、撤销、套预设后也要跑）*/
        _pcRefresh() {
            const list = this._pcSamples();
            if (!this._pc) return;
            this._pc.idx = Math.min(this._pc.idx, Math.max(0, list.length - 1));
            const cur = list[this._pc.idx] || null;
            const panel = document.getElementById('pcPanel');
            if (panel) panel.classList.toggle('pc-none', !list.length);
            // 三条轨道按当前样本色相铺渐变（CSS 里读 --h）；没样本时用中性黄
            const hVar = cur ? String(Math.round(Number(cur.hue) || 0)) : '45';
            for (const id of ['slPcH', 'slPcS', 'slPcL']) {
                const el = document.getElementById(id);
                if (el) el.style.setProperty('--h', hVar);
            }
            const set = (id, k, plain) => {
                const inp = document.getElementById(id);
                const v = cur ? (Number(cur[k]) || 0) : (k === 'range' ? 30 : 0);
                if (inp) inp.value = String(v);
                const lbl = document.getElementById(id.replace('sl', 'lbl'));
                if (lbl) lbl.textContent = plain ? String(v) : fmt(v);
            };
            set('slPcH', 'dh');
            set('slPcS', 'ds');
            set('slPcL', 'dl');
            set('slPcVar', 'dv');
            set('slPcRange', 'range', true);
            this._pcRenderStrip();
        },

        /* 样本条：最多 6 个圆点，空格子用虚线占位（点它直接进取样态）。
           老工程里可能带着 8 个（旧上限），这里照旧全部显示，方便逐个删掉。 */
        _pcRenderStrip() {
            const strip = document.getElementById('pcStrip');
            if (!strip) return;
            const list = this._pcSamples();
            const idx = this._pc ? this._pc.idx : 0;
            const slots = Math.max(PC_MAX, list.length);
            let html = '';
            for (let i = 0; i < slots; i++) {
                const s = list[i];
                if (!s) {
                    html += '<button type="button" class="pc-slot" data-add="1"'
                        + ' aria-label="空位，点一下开始取样" title="空位：点一下开始取样"></button>';
                    continue;
                }
                html += '<div class="pc-chip' + (i === idx ? ' active' : '') + '" data-i="' + i + '"'
                    + ' role="button" tabindex="0" aria-pressed="' + (i === idx ? 'true' : 'false') + '"'
                    + ' style="--c:' + this._pcCss(s) + '"'
                    + ' title="样本 ' + (i + 1) + '：色相 ' + Math.round(s.hue) + '° · 范围 ' + (s.range || 0)
                    + '，点一下切到它；悬停右上角 × 删除">'
                    + '<button type="button" class="pc-x" data-del="' + i + '"'
                    + ' aria-label="删除样本 ' + (i + 1) + '" title="删除这个样本">×</button>'
                    + '</div>';
            }
            strip.innerHTML = html;
        },

        syncGradeExtraUI(p) {
            const ex = this._gradeExtra;
            if (!ex) return;
            const setOne = (rec, v) => {
                if (!rec) return;
                rec.inp.value = String(v);
                const text = labelText(rec, v);
                const id = rec.lbl ? rec.lbl.id : null;
                if (id && typeof this.updateLabel === 'function') this.updateLabel(id, text);
                else if (rec.lbl) rec.lbl.textContent = text;
            };
            for (const f of this.DET_FIELDS) setOne(ex.det[f.k], (p.det && p.det[f.k]) || 0);
            for (const f of this.CAL_FIELDS) setOne(ex.cal[f.k], (p.cal && p.cal[f.k]) || 0);
            for (const b of this.MIX_BANDS) {
                for (const mt of this.MIX_METRICS) {
                    const v = (p.mix && p.mix[b.k] && p.mix[b.k][mt.k]) || 0;
                    setOne(ex.mix[b.k + '.' + mt.k], v);
                }
            }
            const det = document.getElementById('grpDet'),
                cal = document.getElementById('grpCal'),
                mix = document.getElementById('grpMix');
            if (det) det.classList.toggle('grade-on', this.isDetActive(p.det));
            if (cal) cal.classList.toggle('grade-on', this.isCalActive(p.cal));
            if (mix) mix.classList.toggle('grade-on', this.isMixActive(p.mix));
            if (this._pcRefresh) this._pcRefresh();
        }
    });
})();

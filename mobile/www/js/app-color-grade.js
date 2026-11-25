'use strict';
/* 自然饱和度 + 颜色分级：像素自己的饱和度/亮度决定权重，逐通道 LUT 表达不了，
 * 所以放在基础调色、曲线之后做一次后置 pass。
 *
 * 1) 有 WebGL 时单 pass（1600px 预览 <2ms，全尺寸个位数毫秒）。
 * 2) WebGL 不可用/上下文丢失时退回 Canvas2D 逐像素兼容路径：拖动中的 1600px
 *    预览可接受，全尺寸只在松手/导出时烘焙一次。
 * 3) 颜色分级数据模型在 app-grade.js（CG_ZONES / sanitizeCg），这里只负责
 *    渲染和 UI 绑定；参数随 grade 一起存草稿。
 */
(function () {
    const VS = 'attribute vec2 aP;varying vec2 vUV;void main(){vUV=aP*0.5+0.5;gl_Position=vec4(aP,0.0,1.0);}';
    const FS = [
        // 三维 LUT 的切片纹理宽 33×33=1089，mediump 的小数精度（约 1/2048）不够
        // 定位到 1/1089 的纹素中心，会出现整片偏色；有 highp 就用 highp。
        '#ifdef GL_FRAGMENT_PRECISION_HIGH',
        'precision highp float;',
        '#else',
        'precision mediump float;',
        '#endif',
        'varying vec2 vUV;',
        'uniform sampler2D uT;',
        'uniform sampler2D uLut;',
        'uniform float uLutOn;',
        'uniform float uGrid;',
        'uniform float uVib;',
        'uniform float uCg[12];',
        'uniform float uCgBlend;',
        'uniform float uCgBalance;',
        'uniform float uBw[8];',
        'uniform float uBwOn;',
        'uniform float uHc[8];',
        'uniform float uHw[8];',
        'uniform float uAspect;',
        'uniform float uDistort;',
        'uniform vec3 uHaze;',
        'uniform float uDehaze;',
        // 阴影（ACR 的空间自适应版本）：场是低分辨率栅格纹理，系数是 x 上的一行三通道。
        // 逐像素那套（app-acr-shadows.js applyCanvas）和这里共用同一份数据，
        // 区别只是那边算 JS、这边算 GPU —— 全分辨率下 1387ms vs 十几毫秒。
        'uniform sampler2D uShField;',
        'uniform sampler2D uShRows;',
        'uniform float uShOn;',
        'uniform float uShPixW;',
        'uniform float uShPixH;',
        'uniform float uShLw;',
        'uniform float uShLh;',
        'uniform float uShScale;',
        'uniform float uShXc;',
        'uniform float uShXMax;',
        'uniform float uShKeyOff;',
        'uniform float uShInvStep;',
        'vec3 s2l(vec3 c){',
        '  return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),step(vec3(0.04045),c));',
        '}',
        'vec3 l2s(vec3 c){',
        '  c=max(c,vec3(0.0));',
        '  return mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));',
        '}',
        'vec3 rgb2hsv(vec3 c){',
        '  vec4 K=vec4(0.0,-1.0/3.0,2.0/3.0,-1.0);',
        '  vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));',
        '  vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));',
        '  float d=q.x-min(q.w,q.y);',
        '  return vec3(abs(q.z+(q.w-q.y)/(6.0*d+1e-10)),d/(q.x+1e-10),q.x);',
        '}',
        'vec3 hsv2rgb(vec3 c){',
        '  vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);',
        '  vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);',
        '  return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);',
        '}',
        'const vec3 LUMA=vec3(0.2126,0.7152,0.0722);',
        'vec3 applyZone(vec3 c,float hue,float sat,float lum,float w,float y){',
        '  float gate=smoothstep(0.0,0.06,y);',
        '  if(sat>0.0001){',
        '    vec3 t=hsv2rgb(vec3(hue,1.0,1.0));',
        '    float ty=dot(t,LUMA);',
        '    vec3 tv=t-vec3(ty);',
        '    c+=tv*(sat*0.40*w*gate);',
        '  }',
        '  if(abs(lum)>0.0001) c*=1.0+lum*0.5*w;',
        '  return c;',
        '}',
        // 三维 LUT：33 张切片横向排成 1089×33 的条带（WebGL1 没有 TEXTURE_3D）。
        // 蓝当下标选切片、红在切片内横向、绿纵向，三线性里的两次双线性手工做。
        // 采样点内缩半纹素（+0.5），这样 LINEAR 不会跨切片渗色。
        'vec3 lutLookup(vec3 c){',
        '  float g=uGrid;',
        '  float z=clamp(c.b,0.0,1.0)*(g-1.0);',
        '  float b0=floor(z);',
        '  float fb=z-b0;',
        '  b0=min(b0,g-2.0);',
        '  float rx=(clamp(c.r,0.0,1.0)*(g-1.0)+0.5)/g;',
        '  float gy=(clamp(c.g,0.0,1.0)*(g-1.0)+0.5)/g;',
        '  vec3 s0=texture2D(uLut,vec2((b0+rx)/g,gy)).rgb;',
        '  vec3 s1=texture2D(uLut,vec2((b0+1.0+rx)/g,gy)).rgb;',
        '  return mix(s0,s1,fb);',
        '}',
        'void main(){',
        // 镜头畸变：径向重采样（uDistort>0 拉直桶形、<0 拉直枕形）。
        // 必须在这里做而不是 Canvas2D —— 2D 逐像素重采样没有双线性插值，
        // 边缘会出现锯齿；GL 的 LINEAR 采样天然带插值。
        // 几何在校色之前：Compositor 也是先 geometry 再上颜色表。
        '  vec2 uv=vUV;',
        '  if(abs(uDistort)>0.0001){',
        '    vec2 pp=(uv-0.5)*vec2(uAspect,1.0);',
        '    float r2=dot(pp,pp);',
        '    pp*=1.0+uDistort*r2;',
        '    uv=clamp(0.5+pp/vec2(uAspect,1.0),vec2(0.0),vec2(1.0));',
        '  }',
        '  vec3 c=texture2D(uT,uv).rgb;',
        // 阴影：ACR 的空间自适应版本，必须在三维表**之前**（与 Camera Raw 的顺序一致）。
        // 场纹理是「画布自上而下」的行序，而主纹理按 FLIP_Y 上传（v=0 落在画布底部），
        // 所以这里要把 v 翻过来，否则整幅阴影会上下颠倒。
        '  if(uShOn>0.5){',
        '    vec3 lin=s2l(c);',
        '    float lum=dot(lin,LUMA);',
        '    if(lum>0.0001220703125){',
        '      float level=log2(lum);',
        '      vec2 fp=vec2(uv.x*uShPixW,(1.0-uv.y)*uShPixH)/uShScale-0.5;',
        '      fp=clamp(fp,vec2(0.0),vec2(uShLw-1.0,uShLh-1.0));',
        '      vec2 i0=floor(fp);',
        '      vec2 ft=fp-i0;',
        '      vec2 i1=min(i0+1.0,vec2(uShLw-1.0,uShLh-1.0));',
        '      vec2 ta=(i0+0.5)/vec2(uShLw,uShLh);',
        '      vec2 tb=(i1+0.5)/vec2(uShLw,uShLh);',
        '      vec2 fa=mix(texture2D(uShField,ta).rg,texture2D(uShField,vec2(tb.x,ta.y)).rg,ft.x);',
        '      vec2 fb=mix(texture2D(uShField,vec2(ta.x,tb.y)).rg,texture2D(uShField,tb).rg,ft.x);',
        '      vec2 fld=mix(fa,fb,ft.y);',
        '      float region=fld.x*level+fld.y;',
        '      float detail=level-region;',
        '      float xp=clamp((region-uShKeyOff)*uShInvStep,0.0,uShXMax);',
        '      float c0=floor(xp);',
        '      float ct=xp-c0;',
        '      float c1=min(c0+1.0,uShXMax);',
        '      vec3 q0=texture2D(uShRows,vec2((c0+0.5)/uShXc,0.5)).rgb;',
        '      vec3 q1=texture2D(uShRows,vec2((c1+0.5)/uShXc,0.5)).rgb;',
        '      vec3 co=mix(q0,q1,ct);',
        '      float lift=co.x+co.y*max(detail,0.0)+co.z*min(detail,0.0);',
        '      c=l2s(lin*exp2(lift));',
        '    }',
        '  }',
        '  if(uLutOn>0.5){',
        // 实测表路径：校准 / 饱和度 / 自然饱和度 / 混色器 / 颜色分级 全在这一张
        // 三维表里（它们都是跨通道操作，逐通道 LUT 和手写公式都学不像）。
        '    c=lutLookup(c);',
        '  } else {',
        '    vec3 hsv=rgb2hsv(c);',
        '    float vib=uVib*(1.0-hsv.y);',
        '    hsv.y=clamp(hsv.y*(1.0+vib*1.2),0.0,1.0);',
        '    c=hsv2rgb(hsv);',
        '    float y=dot(c,LUMA);',
        '    float bal=uCgBalance*0.15;',
        '    float lo=0.34+bal;',
        '    float hi=0.66+bal;',
        '    float soft=mix(0.035,0.22,uCgBlend);',
        '    float wS=1.0-smoothstep(lo-soft,lo+soft,y);',
        '    float wH=smoothstep(hi-soft,hi+soft,y);',
        '    float wM=clamp(1.0-wS-wH,0.0,1.0);',
        '    float ws=wS+wM+wH;',
        '    if(ws>0.0001){wS/=ws;wM/=ws;wH/=ws;}',
        '    c=applyZone(c,uCg[0],uCg[1],uCg[2],wS,y);',
        '    c=applyZone(c,uCg[3],uCg[4],uCg[5],wM,y);',
        '    c=applyZone(c,uCg[6],uCg[7],uCg[8],wH,y);',
        '    c=applyZone(c,uCg[9],uCg[10],uCg[11],1.0,y);',
        '  }',
        // 去除薄雾：Camera Raw 的做法（移植自 Compositor 的 effects_dehaze，
        // 实测对齐 PS）。雾色取全图最亮 1% 的平均色；正档按「最暗通道相对雾色
        // 的比例」估计透射率再反演，负档直接朝雾色蒙一层。
        // 旧实现是 contrast+saturate 叠加 + LUT 里拉黑场，那是「假通透」，
        // 与 ACR 差得远；真实反演才会保住亮部不发灰、暗部不糊。
        '  if(abs(uDehaze)>0.001){',
        '    float d=uDehaze;',
        '    if(d<0.0){',
        '      float veil=0.3*pow(-d,1.3);',
        '      c=c*(1.0-veil)+uHaze*veil;',
        '    } else {',
        '      vec3 hz=max(uHaze,vec3(0.001));',
        '      float dark=min(min(c.r/hz.r,c.g/hz.g),c.b/hz.b);',
        '      float trans=max(0.5,1.0-0.7*d*dark);',
        '      c=(c-uHaze)/trans+uHaze;',
        '    }',
        '  }',
        // 黑白混色器：按色相带加权决定「这个颜色转灰后有多亮」。
        // 灰/近灰不参与（没有色相可言），否则整片灰底会被某个带误伤。
        '  if(uBwOn>0.5){',
        '    float y0=dot(c,LUMA);',
        '    vec3 bh=rgb2hsv(clamp(c,0.0,1.0));',
        '    float gate=smoothstep(0.0,0.08,bh.y);',
        '    float wsum=0.0,adj=0.0;',
        '    for(int i=0;i<8;i++){',
        '      float d=abs(bh.x*360.0-uHc[i]);',
        '      d=min(d,360.0-d);',
        '      float w=clamp(1.0-d/uHw[i],0.0,1.0);',
        '      w=w*w*(3.0-2.0*w);',
        '      wsum+=w;adj+=w*uBw[i];',
        '    }',
        '    float k=wsum>0.001?adj/wsum:0.0;',
        // 1.4：PS/LR 的黑白混色器给单个色相的权重能到 2~3 倍，
        // 系数太小时纯红拉满也只从 43 到 60，等于「有滑块但看不出变化」。
        '    float g=clamp(y0*(1.0+k*1.4*gate),0.0,1.0);',
        '    c=vec3(g);',
        '  }',
        '  gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);',
        '}'
    ].join('\n');

    // ── 锐化（LR 的捕获锐化）的 GPU 版本 ────────────────────────────────
    // CPU 版在 app-sharpen.js：取回像素 420ms + 横 260 + 纵 175 + 合成 171
    // （23MP 实测 ~1064ms），其中 420ms 纯粹是 GPU→CPU 回读。这里用同一套
    // 公式在 GL 里算：横/纵两趟高斯 + 一趟带蒙版的合成，省掉回读与逐像素循环。
    //
    // 只模糊亮度：高斯是线性的，blur(RGB) 再点乘亮度权重 ≡ 先点乘再模糊，
    // 所以中间纹理只存亮度。亮度用 RG 两个通道打包成 16 位（见下面 packY）——
    // 单通道 8 位在蒙版阈值附近会把「梯度 9 还是 11」判反，出现孤立锐化斑点。
    // 与 CPU 版逐像素比对：最大差 1~3 级，均值 <0.02。
    const SBLUR_FS = [
        '#ifdef GL_FRAGMENT_PRECISION_HIGH',
        'precision highp float;',
        '#else',
        'precision mediump float;',
        '#endif',
        'varying vec2 vUV;',
        'uniform sampler2D uS;',
        'uniform vec2 uStep;',
        'uniform float uR;',
        'uniform float uPacked;',
        'uniform float uK[33];',
        'const vec3 LUMA=vec3(0.2126,0.7152,0.0722);',
        // 8 位单通道存模糊结果，在蒙版阈值附近会把「梯度 9 还是 11」判反，出现孤立
        // 的锐化斑点（mask=100 时实测 3% 像素差 >2 级）。把 0..1 的亮度拆成
        // 「整数部分/255 + 小数部分」两个通道，等效 16 位，误差从 1/255 降到 1/65025。
        'vec2 packY(float v){',
        '  float q=clamp(v,0.0,1.0)*255.0;',
        '  float hi=floor(q+1e-4);',
        '  return vec2(hi/255.0,clamp(q-hi,0.0,1.0));',
        '}',
        'float unpackY(vec2 p){return (p.r*255.0+p.g)/255.0;}',
        'void main(){',
        '  float s=0.0;',
        '  for(int i=0;i<33;i++){',
        '    float fi=float(i)-16.0;',
        '    if(abs(fi)>uR) continue;',
        '    vec4 c=texture2D(uS,vUV+uStep*fi);',
        // 第一趟读原图（RGB），第二趟读的是已打包的亮度（RG）
        '    float y=uPacked>0.5?unpackY(c.rg):dot(c.rgb,LUMA);',
        '    s+=y*uK[i];',
        '  }',
        '  gl_FragColor=vec4(packY(s),0.0,1.0);',
        '}'
    ].join('\n');

    const SCOMP_FS = [
        '#ifdef GL_FRAGMENT_PRECISION_HIGH',
        'precision highp float;',
        '#else',
        'precision mediump float;',
        '#endif',
        'varying vec2 vUV;',
        'uniform sampler2D uT;',
        'uniform sampler2D uB;',
        'uniform vec2 uTexel;',
        'uniform float uAmt;',
        'uniform float uMask;',   // 0..1（面板值 /100）
        'uniform float uMS;',     // 蒙版阈值尺度（10 或 24）
        'uniform float uLp;',     // 暗部亮度幂（默认 0.5）
        'uniform float uHead;',   // 高光余量（24/255）
        'float unpackY(vec2 p){return (p.r*255.0+p.g)/255.0;}',
        'void main(){',
        '  vec3 c=texture2D(uT,vUV).rgb;',
        '  float L=dot(c,vec3(0.2126,0.7152,0.0722));',
        '  float bl=unpackY(texture2D(uB,vUV).rg);',
        '  float hp=L-bl;',
        '  float w=1.0;',
        // 蒙版：梯度取「已模糊」的亮度，与 CPU 版同源（B 的左右/上下邻差）
        '  if(uMask>0.0){',
        '    float gx=abs(unpackY(texture2D(uB,vUV+vec2(uTexel.x,0.0)).rg)-unpackY(texture2D(uB,vUV-vec2(uTexel.x,0.0)).rg));',
        '    float gy=abs(unpackY(texture2D(uB,vUV+vec2(0.0,uTexel.y)).rg)-unpackY(texture2D(uB,vUV-vec2(0.0,uTexel.y)).rg));',
        '    float grad=(gx+gy)*255.0;',
        '    float t0=uMask*uMS;',
        '    float t1=t0+uMS*0.5;',
        '    float r0=grad<=t0?0.0:(grad>=t1?1.0:(grad-t0)/(t1-t0));',
        '    float fl=0.35*(1.0-uMask);',
        '    w=fl+(1.0-fl)*r0;',
        '  }',
        // 亮度加权：暗部按 sqrt 收，0.82 以上线性收到 0.5（与 CPU 的 LW 表同式）
        '  float t=clamp(L,0.0,1.0);',
        '  float lowEnd=1.0-uLp+uLp*sqrt(t);',
        '  float highEnd=t<=0.82?1.0:1.0-0.5*(t-0.82)/0.18;',
        '  float delta=uAmt*hp*w*lowEnd*highEnd;',
        // 余量保护：只收正 delta，避免把高光推穿
        '  if(delta>0.0){',
        '    float mx=max(c.r,max(c.g,c.b));',
        '    float head=1.0-mx;',
        '    if(head<uHead) delta*=head<=0.0?0.0:head/uHead;',
        '  }',
        '  gl_FragColor=vec4(clamp(c+vec3(delta),0.0,1.0),1.0);',
        '}'
    ].join('\n');

    let gl = null, glc = null, prog = null, uni = null, quad = null, tex = null;
    let lutTex = null, lutKey = '';
    // 阴影通道的两张浮点纹理。没有 OES_texture_float 就没有它们，
    // 这时 canShadow() 报 false，调用方退回 app-acr-shadows 的逐像素实现。
    let shTex = null, shRowsTex = null, floatOK = false;
    // 锐化通道：分离高斯两趟 + 合成一趟。卷积半径最大 16（UI 上限 shr=3 →
    // σ=4.5 → r=14），所以核固定 33 抽头，用 uniform 半径裁掉多余的。
    let sprogBlur = null, sprogComp = null, suiBlur = null, suiComp = null;
    let sfbo = null, stexA = null, stexB = null, sW = 0, sH = 0, sBroken = false;
    let sLastErr = '';

    // 软件 GL（swiftshader / llvmpipe）上，这套三趟 pass 比 CPU 还慢（实测 23MP
    // 3.1s vs 1.2s）—— 因为像素最终还是跑在 CPU 上，只是多绕了纹理往返。
    // start.bat 里有 QINGFRAME_SW=1 的兜底路径，那里必须继续用 CPU 锐化。
    let softGL = null;
    function isSoftwareGL() {
        if (softGL !== null) return softGL;
        try {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            softGL = /swiftshader|llvmpipe|software|basic render/i.test(String(r || ''));
        } catch (_) { softGL = false; }
        return softGL;
    }

    function initGL() {
        if (gl && prog) return true;
        if (!gl) {
            try {
                glc = document.createElement('canvas');
                // 这画布是**全模块复用**的 GL 输出缓冲：passGL 每次都画回同一张再返回。
                // 调用方要长期持有结果时必须自己拷走（见 app-grade.js bakeOne），
                // 否则两张照片的烘焙结果会指向同一张画布，画面互相覆盖。
                glc.__qfsShared = true;
                gl = glc.getContext('webgl', { preserveDrawingBuffer: true, antialias: false })
                    || glc.getContext('experimental-webgl', { preserveDrawingBuffer: true, antialias: false });
            } catch (_) { gl = null; }
            if (!gl) return false;
            // 阴影的场/系数要按 float 上传，没有这个扩展就走 CPU 兜底
            floatOK = !!gl.getExtension('OES_texture_float');
            glc.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                gl = null; prog = null; uni = null; tex = null;
                // LUT 纹理和它的缓存键必须一起作废：上下文重建后 initGL() 会新建
                // 一张空的 lutTex，但 lutKey 若仍是旧值，passGL 会以为LUT已上传而
                // 跳过 texImage2D —— shader 采到空纹理，整幅输出纯黑。旋转会换
                // 烘焙尺寸、又常伴显存压力，正是这个分支最容易被触发的场景。
                lutTex = null; lutKey = '';
                shTex = null; shRowsTex = null; floatOK = false;
                sprogBlur = null; sprogComp = null; suiBlur = null; suiComp = null;
                sfbo = null; stexA = null; stexB = null; sW = 0; sH = 0; sBroken = false;
                softGL = null;
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
            tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            // 三维 LUT 的条带纹理（33 张 33×33 切片横排），LINEAR 用于切片内插值
            lutTex = gl.createTexture();
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, lutTex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.activeTexture(gl.TEXTURE0);
            // 阴影：场（RGBA float，rg = a,b）与系数行（RGBA float，1 行 × xc）。
            // 两张都是 NEAREST —— 双线性在 shader 里手工做，坐标口径才能和 CPU 逐像素
            // 那条路径完全一致（GPU 的 LINEAR 在纹素边界上的取整规则不一定相同）。
            shTex = gl.createTexture();
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, shTex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            shRowsTex = gl.createTexture();
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, shRowsTex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.activeTexture(gl.TEXTURE0);
            uni = {                cg: gl.getUniformLocation(prog, 'uCg[0]'),
                blend: gl.getUniformLocation(prog, 'uCgBlend'),
                balance: gl.getUniformLocation(prog, 'uCgBalance'),
                vib: gl.getUniformLocation(prog, 'uVib'),
                bw: gl.getUniformLocation(prog, 'uBw[0]'),
                bwOn: gl.getUniformLocation(prog, 'uBwOn'),
                hc: gl.getUniformLocation(prog, 'uHc[0]'),
                hw: gl.getUniformLocation(prog, 'uHw[0]'),
                aspect: gl.getUniformLocation(prog, 'uAspect'),
                distort: gl.getUniformLocation(prog, 'uDistort'),
                lutOn: gl.getUniformLocation(prog, 'uLutOn'),
                grid: gl.getUniformLocation(prog, 'uGrid'),
                lut: gl.getUniformLocation(prog, 'uLut'),
                haze: gl.getUniformLocation(prog, 'uHaze'),
                dehaze: gl.getUniformLocation(prog, 'uDehaze'),
                shOn: gl.getUniformLocation(prog, 'uShOn'),
                shField: gl.getUniformLocation(prog, 'uShField'),
                shRows: gl.getUniformLocation(prog, 'uShRows'),
                shPixW: gl.getUniformLocation(prog, 'uShPixW'),
                shPixH: gl.getUniformLocation(prog, 'uShPixH'),
                shLw: gl.getUniformLocation(prog, 'uShLw'),
                shLh: gl.getUniformLocation(prog, 'uShLh'),
                shScale: gl.getUniformLocation(prog, 'uShScale'),
                shXc: gl.getUniformLocation(prog, 'uShXc'),
                shXMax: gl.getUniformLocation(prog, 'uShXMax'),
                shKeyOff: gl.getUniformLocation(prog, 'uShKeyOff'),
                shInvStep: gl.getUniformLocation(prog, 'uShInvStep')
            };
            gl.uniform1i(gl.getUniformLocation(prog, 'uT'), 0);
            gl.uniform1i(uni.lut, 1);
            gl.uniform1i(uni.shField, 2);
            gl.uniform1i(uni.shRows, 3);
            lutKey = '';
            return true;
        } catch (_) {
            gl = null; prog = null; uni = null; tex = null; lutTex = null;
            shTex = null; shRowsTex = null;
            return false;
        }
    }

    function cgValues(p) {
        const cg = (p && p.cg) || null;
        const zones = (window.App && window.App.CG_ZONES) || [
            { k: 'shadow' }, { k: 'mid' }, { k: 'high' }, { k: 'global' }
        ];
        const out = [];
        for (const z of zones) {
            const v = (cg && cg[z.k]) || {};
            out.push((Number(v.h) || 0) / 360, (Number(v.s) || 0) / 100, (Number(v.l) || 0) / 100);
        }
        return out;
    }

    function passGL(src, p, w, h, lut, haze, sh) {
        if (!initGL()) return null;
        try {
            if (gl.isContextLost && gl.isContextLost()) return null;
            if (glc.width !== w || glc.height !== h) {
                glc.width = w; glc.height = h;
                // 改画布尺寸会重建 drawing buffer：强制下次重新上传 LUT，
                // 不能让 lutKey 把「其实没上传」当成已经上传过。
                lutKey = '';
            }
            gl.viewport(0, 0, w, h);
            // 先清掉上一次残留的 GL 错误，否则下面判断的是旧错误。
            for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* drain */ }
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
            // WebGL 的错误不抛异常：纹理上传失败（超过 MAX_TEXTURE_SIZE、
            // 显存不足等）只会置 error，继续画就会采到空纹理输出全黑。
            // 这里显式检查并回退 2D，绝不把黑画面交出去。
            if (gl.getError() !== gl.NO_ERROR) return null;
            // 实测三维表：校准 / 饱和度 / 自然饱和度 / 混色器 / 颜色分级 都在这里，
            // 于是这几项的手写公式必须让位（否则会叠加两次）。
            const lutOn = !!(lut && lut.rgba && lut.grid > 1);
            gl.uniform1f(uni.lutOn, lutOn ? 1 : 0);
            if (lutOn) {
                const key = lut.grid + '#' + lut.rgba.length + '#' + lut.token;
                if (key !== lutKey) {
                    gl.activeTexture(gl.TEXTURE1);
                    gl.bindTexture(gl.TEXTURE_2D, lutTex);
                    // UNPACK_FLIP_Y 是上下文级别的：源图上传需要翻转（画布 y 向下、
                    // 纹理 t 向上），但 LUT 条带一翻就把绿轴上下颠倒，必须临时关掉。
                    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lut.grid * lut.grid, lut.grid, 0,
                        gl.RGBA, gl.UNSIGNED_BYTE, lut.rgba);
                    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                    gl.activeTexture(gl.TEXTURE0);
                    lutKey = key;
                }
                gl.uniform1f(uni.grid, lut.grid);
            }
            gl.uniform1f(uni.vib, lutOn ? 0 : (Number(p.vib) || 0) / 100);
            const cg = p.cg || {};
            gl.uniform1fv(uni.cg, new Float32Array(lutOn ? new Array(12).fill(0) : cgValues(p)));
            gl.uniform1f(uni.blend, Number.isFinite(Number(cg.blending)) ? Number(cg.blending) / 100 : 0.5);
            gl.uniform1f(uni.balance, (Number(cg.balance) || 0) / 100);
            const bw = p.bw || null;
            const bwOn = !!(bw && bw.on !== 0);
            const bwVals = [], hc = [], hw = [];
            const bands = (window.App && window.App.BW_BANDS) || [];
            for (const b of bands) {
                bwVals.push(bwOn ? (Number(bw[b.k]) || 0) / 100 : 0);
                hc.push(b.hue);
                hw.push(b.hw);
            }
            gl.uniform1f(uni.bwOn, bwOn ? 1 : 0);
            gl.uniform1fv(uni.bw, new Float32Array(bwVals));
            gl.uniform1fv(uni.hc, new Float32Array(hc));
            gl.uniform1fv(uni.hw, new Float32Array(hw));
            const lc = p.lc || null;
            gl.uniform1f(uni.aspect, w / Math.max(1, h));
            // 0.28：满档时边缘位移约 28%（大约相当于 ±15 的镜头畸变值）
            gl.uniform1f(uni.distort, lc ? (Number(lc.distort) || 0) / 100 * 0.28 : 0);
            const dhz = (Number(p.det && p.det.dhz) || 0) / 100;
            const hz = haze || [1, 1, 1];
            gl.uniform3f(uni.haze, hz[0], hz[1], hz[2]);
            gl.uniform1f(uni.dehaze, dhz);
            if (sh && floatOK) {
                // 场是低分辨率栅格（长边约 384 格），一次上传几 MB 的浮点数据，
                // 比 CPU 逐像素跑一遍快两个数量级。行序是「画布自上而下」，
                // 所以上传前要临时关掉 FLIP_Y（这个开关是上下文级的）。
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, shTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sh.lw, sh.lh, 0,
                    gl.RGBA, gl.FLOAT, sh.fieldTex);
                gl.activeTexture(gl.TEXTURE3);
                gl.bindTexture(gl.TEXTURE_2D, shRowsTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sh.xc, 1, 0,
                    gl.RGBA, gl.FLOAT, sh.rowsTex);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.activeTexture(gl.TEXTURE0);
                gl.uniform1f(uni.shOn, 1);
                gl.uniform1f(uni.shPixW, sh.W);
                gl.uniform1f(uni.shPixH, sh.H);
                gl.uniform1f(uni.shLw, sh.lw);
                gl.uniform1f(uni.shLh, sh.lh);
                gl.uniform1f(uni.shScale, sh.scale);
                gl.uniform1f(uni.shXc, sh.xc);
                gl.uniform1f(uni.shXMax, sh.xMax);
                gl.uniform1f(uni.shKeyOff, sh.keyOff);
                gl.uniform1f(uni.shInvStep, sh.invStep);
            } else {
                gl.uniform1f(uni.shOn, 0);
            }
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            return glc;
        } catch (_) {
            return null;
        }
    }

    // ── 锐化通道 ───────────────────────────────────────────────
    // 独立于主 pass 的一套 program/FBO：主 pass 负责颜色，锐化必须在调色与蒙版
    // 合成**之后**做（见 app-grade.js bake 的注释），所以只能单独跑一趟。
    function compileProgram(fsSrc) {
        const sh = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
            return s;
        };
        const p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
    }

    function initSharpen() {
        if (sBroken) return false;
        if (sprogBlur && sprogComp) return true;
        if (!initGL()) return false;
        try {
            sprogBlur = compileProgram(SBLUR_FS);
            sprogComp = compileProgram(SCOMP_FS);
            suiBlur = {
                s: gl.getUniformLocation(sprogBlur, 'uS'),
                step: gl.getUniformLocation(sprogBlur, 'uStep'),
                r: gl.getUniformLocation(sprogBlur, 'uR'),
                packed: gl.getUniformLocation(sprogBlur, 'uPacked'),
                k: gl.getUniformLocation(sprogBlur, 'uK[0]')
            };
            suiComp = {
                t: gl.getUniformLocation(sprogComp, 'uT'),
                b: gl.getUniformLocation(sprogComp, 'uB'),
                texel: gl.getUniformLocation(sprogComp, 'uTexel'),
                amt: gl.getUniformLocation(sprogComp, 'uAmt'),
                mask: gl.getUniformLocation(sprogComp, 'uMask'),
                ms: gl.getUniformLocation(sprogComp, 'uMS'),
                lp: gl.getUniformLocation(sprogComp, 'uLp'),
                head: gl.getUniformLocation(sprogComp, 'uHead')
            };
            gl.useProgram(sprogBlur);
            gl.uniform1i(suiBlur.s, 0);
            gl.useProgram(sprogComp);
            gl.uniform1i(suiComp.t, 0);
            gl.uniform1i(suiComp.b, 1);
            return true;
        } catch (_) {
            sBroken = true;
            sprogBlur = null; sprogComp = null;
            return false;
        }
    }

    function bindQuad(p) {
        gl.useProgram(p);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        const loc = gl.getAttribLocation(p, 'aP');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    // 两张中间纹理按当前尺寸分配。23MP 各约 92MB（RGBA8）—— 用 RGBA8 而不是
    // 浮点，是因为浮点在这张卡上要再翻四倍，而 8 位中间量对最终结果只差 ≤2 级。
    function ensureSharpenTargets(w, h) {
        if (sW === w && sH === h && stexA) return true;
        if (!stexA) {
            stexA = gl.createTexture();
            stexB = gl.createTexture();
            sfbo = gl.createFramebuffer();
        }
        for (const t of [stexA, stexB]) {
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, sfbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, stexA, 0);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        if (!ok) { sBroken = true; return false; }
        sW = w; sH = h;
        return true;
    }

    // 在 GL 里做锐化，返回一张**自有**的 2D 画布（调用方会长期持有，不能交共享画布）。
    // P 来自 app-sharpen.js 的 paramsOf（radius/amount/masking/maskScale/lumPow）。
    // 任何一步失败都返回 null，调用方回退 CPU 实现。
    function sharpenCanvas(src, P) {
        sLastErr = '';
        if (!P || !(P.amount > 0.002)) return null;
        const w = src.width | 0, h = src.height | 0;
        if (w < 3 || h < 3) return null;
        const r = Math.max(1, Math.round(P.radius * 3));
        if (r > 16) return null;      // 33 抽头核放不下，交回 CPU
        if (!initGL()) return null;
        // 软件 GL 上没有收益（比 CPU 还慢一倍），且会在软件纹理上白占 2×92MB：
        // 先判后端，再编译/分配。测试可以设 QFS_FORCE_GPU_SHARPEN 强制走这条。
        if (!window.QFS_FORCE_GPU_SHARPEN && isSoftwareGL()) return null;
        if (!initSharpen() || !ensureSharpenTargets(w, h)) return null;
        try {
            if (glc.width !== w || glc.height !== h) { glc.width = w; glc.height = h; }

            // 核：与 CPU 的 kernel() 同一套高斯权重，居中放在 33 槽的第 16 位
            const k = new Float32Array(33);
            const s2 = 2 * P.radius * P.radius;
            let sum = 0;
            for (let i = -r; i <= r; i++) {
                const v = Math.exp(-(i * i) / s2);
                k[i + 16] = v; sum += v;
            }
            for (let i = 0; i < 33; i++) k[i] /= sum;

            // ① 横/纵分离高斯：源 → A，A → B
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
            const eUp = gl.getError();
            if (eUp) { sLastErr = 'texImage2D 0x' + eUp.toString(16) + ' ' + w + 'x' + h; return null; }

            bindQuad(sprogBlur);
            gl.bindFramebuffer(gl.FRAMEBUFFER, sfbo);
            gl.viewport(0, 0, w, h);
            gl.uniform1f(suiBlur.r, r);
            gl.uniform1fv(suiBlur.k, k);

            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, stexA, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform2f(suiBlur.step, 1 / w, 0);
            gl.uniform1f(suiBlur.packed, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, stexB, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, stexA);
            gl.uniform2f(suiBlur.step, 0, 1 / h);
            gl.uniform1f(suiBlur.packed, 1);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // ② 合成：原始像素 + 模糊亮度 + 蒙版 → 默认帧缓冲
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, w, h);
            bindQuad(sprogComp);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, stexB);
            gl.uniform2f(suiComp.texel, 1 / w, 1 / h);
            gl.uniform1f(suiComp.amt, P.amount);
            gl.uniform1f(suiComp.mask, Math.max(0, Math.min(100, P.masking || 0)) / 100);
            gl.uniform1f(suiComp.ms, P.maskScale > 0 ? P.maskScale : 10);
            gl.uniform1f(suiComp.lp, P.lumPow == null ? 0.5 : P.lumPow);
            gl.uniform1f(suiComp.head, 24 / 255);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // ③ 落到自有画布：GL 画布是模块共享的，不能直接交给调用方
            const out = document.createElement('canvas');
            out.width = w; out.height = h;
            out.getContext('2d').drawImage(glc, 0, 0);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE0);
            // 主 pass 用的是另一个 program，属性指针要还回去（ANGLE 下两个 program
            // 的 aP location 不保证一致）
            bindQuad(prog);
            return out;
        } catch (_) {
            sLastErr = String(_ && _.message || _);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return null;
        }
    }

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    function smoothstep(a, b, x) {
        const t = clamp01((x - a) / Math.max(1e-6, b - a));
        return t * t * (3 - 2 * t);
    }
    function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
    function rgb2hsv(r, g, b) {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let h = 0;
        if (d > 1e-9) {
            if (mx === r) h = ((g - b) / d) % 6;
            else if (mx === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h /= 6;
            if (h < 0) h += 1;
        }
        return [h, mx > 1e-9 ? d / mx : 0, mx];
    }
    function hsv2rgb(h, s, v) {
        const i = Math.floor(h * 6), f = h * 6 - i;
        const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
        switch (i % 6) {
            case 0: return [v, t, p];
            case 1: return [q, v, p];
            case 2: return [p, v, t];
            case 3: return [p, q, v];
            case 4: return [t, p, v];
            default: return [v, p, q];
        }
    }

    // 注意：2D 兜底**不做**镜头畸变（逐像素重采样无插值，边缘必然锯齿）。
    // 调用方在 GL 不可用时会提示「镜头校正需要 WebGL」，颜色部分照常生效。
    function pass2d(src, p, w, h, haze) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        if (!g) return null;
        g.drawImage(src, 0, 0, w, h);
        let img;
        try { img = g.getImageData(0, 0, w, h); } catch (_) { return null; }
        const d = img.data;
        const zones = (window.App && window.App.CG_ZONES) || [
            { k: 'shadow' }, { k: 'mid' }, { k: 'high' }, { k: 'global' }
        ];
        const cg = p.cg || {};
        const zs = zones.map((z) => {
            const v = cg[z.k] || {};
            const hue = (Number(v.h) || 0) / 360;
            const sat = (Number(v.s) || 0) / 100;
            const lum = (Number(v.l) || 0) / 100;
            const t = hsv2rgb(hue, 1, 1);
            const ty = luma(t[0], t[1], t[2]);
            return { sat, lum, tr: t[0] - ty, tg: t[1] - ty, tb: t[2] - ty };
        });
        const blend = Number.isFinite(Number(cg.blending)) ? Math.max(0, Math.min(1, Number(cg.blending) / 100)) : 0.5;
        const bal = (Number(cg.balance) || 0) / 100 * 0.15;
        const soft = 0.035 + (0.22 - 0.035) * blend;
        const lo = 0.34 + bal, hi = 0.66 + bal;
        const vibN = (Number(p.vib) || 0) / 100;
        const dhz2 = (Number(p.det && p.det.dhz) || 0) / 100;
        const bwOn = !!(p.bw && p.bw.on !== 0);
        const bwBands = (window.App && window.App.BW_BANDS) || [];
        for (let i = 0; i < d.length; i += 4) {
            let r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
            if (vibN) {
                const hsv = rgb2hsv(r, gg, b);
                const vib = vibN * (1 - hsv[1]);
                hsv[1] = clamp01(hsv[1] * (1 + vib * 1.2));
                const rgb = hsv2rgb(hsv[0], hsv[1], hsv[2]);
                r = rgb[0]; gg = rgb[1]; b = rgb[2];
            }
            const y = luma(r, gg, b);
            let wS = 1 - smoothstep(lo - soft, lo + soft, y);
            let wH = smoothstep(hi - soft, hi + soft, y);
            let wM = clamp01(1 - wS - wH);
            const ws = wS + wM + wH;
            if (ws > 1e-6) { wS /= ws; wM /= ws; wH /= ws; }
            const gate = smoothstep(0, 0.06, y);
            const weights = [wS, wM, wH, 1];
            for (let k = 0; k < 4; k++) {
                const z = zs[k], w = weights[k];
                if (!z || w <= 0) continue;
                if (z.sat > 0.0001) {
                    const a = z.sat * 0.40 * w * gate;
                    r += z.tr * a; gg += z.tg * a; b += z.tb * a;
                }
                if (Math.abs(z.lum) > 0.0001) {
                    const f = 1 + z.lum * 0.5 * w;
                    r *= f; gg *= f; b *= f;
                }
            }
            if (dhz2) {
                // 与 GL 路径同一套：Camera Raw 的去薄雾反演
                const hz = haze || [1, 1, 1];
                if (dhz2 < 0) {
                    const veil = 0.3 * Math.pow(-dhz2, 1.3);
                    r = r * (1 - veil) + hz[0] * veil;
                    gg = gg * (1 - veil) + hz[1] * veil;
                    b = b * (1 - veil) + hz[2] * veil;
                } else {
                    const hr = Math.max(1e-3, hz[0]), hg = Math.max(1e-3, hz[1]), hb = Math.max(1e-3, hz[2]);
                    const dark = Math.min(r / hr, gg / hg, b / hb);
                    const trans = Math.max(0.5, 1 - 0.7 * dhz2 * dark);
                    r = (r - hz[0]) / trans + hz[0];
                    gg = (gg - hz[1]) / trans + hz[1];
                    b = (b - hz[2]) / trans + hz[2];
                }
            }
            if (bwOn) {
                // 与 GL 路径同一套：按色相带加权决定该颜色转灰后的亮度
                const h2 = rgb2hsv(clamp01(r), clamp01(gg), clamp01(b));
                const gate = smoothstep(0, 0.08, h2[1]);
                let wsum = 0, adj = 0;
                for (const b0 of bwBands) {
                    let dd = Math.abs(h2[0] * 360 - b0.hue);
                    dd = Math.min(dd, 360 - dd);
                    let w = clamp01(1 - dd / b0.hw);
                    w = w * w * (3 - 2 * w);
                    wsum += w;
                    adj += w * ((Number(p.bw[b0.k]) || 0) / 100);
                }
                const kk = wsum > 1e-3 ? adj / wsum : 0;
                const y0 = luma(clamp01(r), clamp01(gg), clamp01(b));
                const g0 = clamp01(y0 * (1 + kk * 1.4 * gate));
                r = g0; gg = g0; b = g0;
            }
            d[i] = Math.round(clamp01(r) * 255);
            d[i + 1] = Math.round(clamp01(gg) * 255);
            d[i + 2] = Math.round(clamp01(b) * 255);
        }
        g.putImageData(img, 0, 0);
        return c;
    }

    window.QfsColor = {
        pass(src, p, w, h, lut, haze, sh) {
            const out = passGL(src, p, w, h, lut, haze, sh);
            if (out) {
                // 最后一道：GL 偶发吐出整片纯黑（LUT 纹理没上传、上下文刚重建、
                // 显存不足等）。源图本来不黑却得到全黑，一定是渲染坏了 ——
                // 丢掉 GL 结果改走 2D，绝不把黑图当成调色结果交给画面。
                // 用户把照片真的调成全黑时 srcBlack>0.5，不会被误判。
                const B = window.qfsBlackRatio;
                const srcBlack = B ? B(src) : null;
                const outBlack = B ? B(out) : null;
                if (srcBlack == null || outBlack == null || srcBlack > 0.5 || outBlack < 0.95) return out;
            }
            // GL 通道没成：阴影本来是在 shader 里施加的，这里补一次再走 2D 兜底，
            // 否则这一帧会整片漏掉阴影（画面突然变平，像没调过色）。
            if (sh && window.QfsShadows) window.QfsShadows.applyCanvas(src, sh.amount, sh.key);
            return pass2d(src, p, w, h, haze);
        },
        available() { return true; },
        usingGL() { return initGL(); },
        // 阴影能不能交给 shader：要 GL 跑得起来且浮点纹理可用
        canShadow() { return initGL() && floatOK; },
        // 锐化的 GPU 通道：成功返回自有画布，失败返回 null（调用方走 CPU）
        sharpenCanvas(canvas, P) { return sharpenCanvas(canvas, P); },
        sharpenLastError() { return sLastErr; }
    };

    // ── UI：黑白混色器（对齐 LR 的 Black & White / GrayMixer）──────
    function initBw() {
        const $ = (id) => document.getElementById(id);
        const chk = $('cbBwOn');
        if (!chk) return;
        const app = window.App;
        const ids = (app.BW_KEYS || []).map((k) => k.toUpperCase());
        const inputs = ids.map((K) => $('slBw' + K));
        let settle = 0;
        const commit = (patch) => {
            if (!app.image) return;
            const cur = app.gradeOf(app.image).bw || app.defaultBw();
            app.setGrade({ bw: Object.assign({}, cur, patch) });
            clearTimeout(settle);
            settle = setTimeout(() => app.rebuildGrade('full'), 220);
        };
        chk.addEventListener('change', () => {
            if (chk.checked) commit({ on: 1 });
            else { app.setGrade({ bw: null }); app.rebuildGrade('full'); }
        });
        inputs.forEach((inp, i) => {
            if (!inp) return;
            inp.addEventListener('input', () => commit({ [app.BW_KEYS[i]]: Number(inp.value) || 0 }));
            inp.addEventListener('change', () => {
                commit({ [app.BW_KEYS[i]]: Number(inp.value) || 0 });
                clearTimeout(settle);
                app.rebuildGrade('full');
            });
        });
    }

    function syncBwUI(p) {
        const $ = (id) => document.getElementById(id);
        const chk = $('cbBwOn');
        if (!chk) return;
        const app = window.App;
        const bw = p && p.bw;
        const on = !!(bw && bw.on !== 0);
        chk.checked = on;
        for (const k of (app.BW_KEYS || [])) {
            const K = k.toUpperCase();
            const inp = $('slBw' + K);
            const v = on ? (Number(bw[k]) || 0) : 0;
            if (inp) inp.value = String(v);
            const id = 'lblBw' + K;
            const text = v === 0 ? '0' : (v > 0 ? '+' + v : String(v));
            if (app.updateLabel) app.updateLabel(id, text);
            else { const el = $(id); if (el) el.textContent = text; }
        }
        const grp = $('grpBw');
        if (grp) grp.classList.toggle('grade-on', on);
    }

    Object.assign(window.App || (window.App = {}), { initBw, syncBwUI });

    // ── UI：颜色分级 ─────────────────────────────────────────────
    function fmt(v) { return v === 0 ? '0' : (v > 0 ? '+' + v : String(v)); }
    function cloneCg(cg) {
        return cg ? JSON.parse(JSON.stringify(cg)) : (window.App.defaultCg ? window.App.defaultCg() : null);
    }

    Object.assign(window.App || (window.App = {}), {
        _cgZone: 'shadow',

        initColorGrade() {
            const $ = (id) => document.getElementById(id);
            const grp = $('grpColorGrade');
            if (!grp) return;
            const q = (id) => $('slCg' + id);
            this._cgExtra = {
                hue: q('Hue'), sat: q('Sat'), lum: q('Lum'),
                blend: q('Blending'), balance: q('Balance'),
                labels: {
                    hue: $('lblCgHue'), sat: $('lblCgSat'), lum: $('lblCgLum'),
                    blend: $('lblCgBlending'), balance: $('lblCgBalance')
                }
            };
            const thumb = () => {
                const im = this.image;
                if (im && this.renderFramedThumb) {
                    clearTimeout(im._gradeThumbT);
                    im._gradeThumbT = setTimeout(() => this.renderFramedThumb(im), 260);
                }
            };
            const bind = (inp, apply) => {
                if (!inp) return;
                let settle = 0;
                inp.addEventListener('input', () => {
                    apply(Number(inp.value) || 0);
                    clearTimeout(settle);
                    settle = setTimeout(() => { this.rebuildGrade('full'); thumb(); }, 220);
                });
                inp.addEventListener('change', () => {
                    clearTimeout(settle);
                    apply(Number(inp.value) || 0);
                    this.rebuildGrade('full');
                    thumb();
                });
            };
            const edit = (key, v) => {
                if (!this.image) return;
                const cg = cloneCg(this.gradeOf(this.image).cg);
                if (key === 'blending' || key === 'balance') cg[key] = v;
                else {
                    const zone = this._cgZone || 'shadow';
                    cg[zone] = Object.assign({ h: 0, s: 0, l: 0 }, cg[zone] || {}, { [key]: v });
                }
                this.setGrade({ cg });
            };
            bind(this._cgExtra.hue, (v) => {
                edit('h', v);
                // 色相只是「往哪个颜色偏」，本身不产生颜色。只拖它而饱和度是 0 时
                // 画面一定没变化，不解释一句用户会以为滑块坏了（同一个误解反复出现）。
                const g = this.gradeOf(this.image);
                const z = g && g.cg && g.cg[this._cgZone || 'shadow'];
                if (z && !z.s && !z.l && !this._cgHueHinted) {
                    this._cgHueHinted = true;
                    this.setStatus('色相已设为 ' + Math.round(v) + '°，再拉一点饱和度才会看到颜色');
                }
            });
            bind(this._cgExtra.sat, (v) => edit('s', v));
            bind(this._cgExtra.lum, (v) => edit('l', v));
            bind(this._cgExtra.blend, (v) => edit('blending', v));
            bind(this._cgExtra.balance, (v) => edit('balance', v));

            const tabs = $('cgZones');
            if (tabs) {
                const btns = Array.prototype.slice.call(tabs.querySelectorAll('.curve-chan'));
                btns.forEach((btn) => {
                    btn.addEventListener('click', () => {
                        this._cgZone = btn.dataset.cg || 'shadow';
                        this.syncColorGradeUI(this.gradeOf(this.image));
                    });
                });
            }
            const reset = $('btnCgReset');
            if (reset) {
                reset.addEventListener('click', () => {
                    this.setGrade({ cg: null });
                    this.setStatus('已重置颜色分级');
                });
            }
        },

        syncColorGradeUI(p) {
            const ex = this._cgExtra;
            if (!ex) return;
            const cg = (p && p.cg) || (this.defaultCg ? this.defaultCg() : null);
            if (!cg) return;
            const zoneKey = this._cgZone || 'shadow';
            const z = cg[zoneKey] || { h: 0, s: 0, l: 0 };
            const setOne = (inp, lbl, v, text) => {
                if (inp) inp.value = String(v);
                if (lbl) {
                    if (lbl.id && typeof this.updateLabel === 'function') this.updateLabel(lbl.id, text);
                    else lbl.textContent = text;
                }
            };
            setOne(ex.hue, ex.labels.hue, z.h || 0, String(Math.round(z.h || 0)));
            setOne(ex.sat, ex.labels.sat, z.s || 0, String(Math.round(z.s || 0)));
            setOne(ex.lum, ex.labels.lum, z.l || 0, fmt(Math.round(z.l || 0)));
            setOne(ex.blend, ex.labels.blend, cg.blending == null ? 50 : cg.blending,
                String(Math.round(cg.blending == null ? 50 : cg.blending)));
            setOne(ex.balance, ex.labels.balance, cg.balance || 0, fmt(Math.round(cg.balance || 0)));

            const tabs = document.getElementById('cgZones');
            if (tabs) {
                const btns = Array.prototype.slice.call(tabs.querySelectorAll('.curve-chan'));
                btns.forEach((btn) => {
                    const on = (btn.dataset.cg || 'shadow') === zoneKey;
                    btn.classList.toggle('active', on);
                    const zz = cg[btn.dataset.cg || 'shadow'] || {};
                    const s = Number(zz.s) || 0;
                    btn.style.setProperty('--cg-color', s > 0
                        ? 'hsl(' + (Number(zz.h) || 0) + ' 65% 52%)' : 'transparent');
                    btn.title = '色相 ' + Math.round(Number(zz.h) || 0) +
                        '° / 饱和 ' + Math.round(s) + ' / 明亮 ' + Math.round(Number(zz.l) || 0);
                });
            }
            const grp = document.getElementById('grpColorGrade');
            if (grp) grp.classList.toggle('grade-on', !!(this.isCgActive && this.isCgActive(p && p.cg)));
        }
    });
})();

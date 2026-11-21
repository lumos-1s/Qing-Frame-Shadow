'use strict';
/* 纸刊本地渲染器：不调模型，但也不能画出「一块黑板」或「一张截图」。
 * 这里用像素不变量守住几件看得见的事：
 *   · 六种纸感都能出 PNG，尺寸对得上，画面不透明
 *   · 同一个 seed 结果完全一致，不同 seed 必须换构图
 *   · 竖图撕口：左边必须是纸（浅、低饱和），照片不能糊满整幅
 *   · 上下二分：下半必须明显比上半「少色」，否则等于没做重构
 *   · 留空标题就是真的不印字，不是偷偷塞一句默认英文
 * 依赖 design/regress.html 里的 makePhoto() 做确定性样张。
 */
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(ok, label, detail) {
    if (ok) { pass++; console.log('  ok  ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail === undefined ? '' : '  -> ' + detail)); }
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    await win.loadFile(path.join(ROOT, 'design', 'regress.html'));
    const fs = require('fs');
    const code = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'app-zine-render.js'), 'utf8');
    await win.webContents.executeJavaScript(code + '\n;true');

    const ids = await win.webContents.executeJavaScript('QfsZineRender.PRESETS.slice()');
    check(Array.isArray(ids) && ids.length === 6, '六种纸感都注册了', JSON.stringify(ids));

    // 1) 全部能出图
    const out = await win.webContents.executeJavaScript(`(function(){
        var img = makePhoto(800, 1000);
        var r = {};
        QfsZineRender.PRESETS.forEach(function(id){
            var o = QfsZineRender.render(id, img, { id: id, seed: 3, bold: 0.6, title: 'HELD', subtitle: 'after rain' });
            r[id] = { w: o.W, h: o.H, png: String(o.dataUrl).indexOf('data:image/png') === 0, pal: o.palette.length, uniq: new Set(o.palette).size, tone: o.tone };
        });
        return r;
    })()`);
    ids.forEach((id) => {
        const r = out[id];
        check(r && r.png && r.w >= 640 && r.h >= 640 && r.pal === 4, '「' + id + '」出 PNG 且取到 4 主色', JSON.stringify(r));
        check(r && r.uniq === 4, '「' + id + '」四枚色卡互不重复', r && String(r.uniq));
    });
    check(out['ink-bifold'].h > out['ink-bifold'].w, '上下二分是竖开本', out['ink-bifold'].w + 'x' + out['ink-bifold'].h);

    // 2) 透明度：纸是不透明的
    const opaque = await win.webContents.executeJavaScript(`new Promise(function(res){
        var img = makePhoto(800, 1000);
        var o = QfsZineRender.render('tear-narrative', img, { seed: 5 });
        var im = new Image();
        im.onload = function(){
            var c = document.createElement('canvas'); c.width = 40; c.height = 40;
            var x = c.getContext('2d'); x.drawImage(im, 0, 0, 40, 40);
            var d = x.getImageData(0, 0, 40, 40).data, min = 255;
            for (var i = 3; i < d.length; i += 4) if (d[i] < min) min = d[i];
            res(min);
        };
        im.src = o.dataUrl;
    })`);
    check(opaque === 255, '成片没有透明像素', String(opaque));

    // 3) 确定性 + 变化
    const det = await win.webContents.executeJavaScript(`(function(){
        var img = makePhoto(800, 1000);
        function one(seed){ return QfsZineRender.render('tear-narrative', img, { seed: seed, title: 'A' }).dataUrl; }
        return { same: one(9) === one(9), diff: one(9) !== one(10) };
    })()`);
    check(det.same && det.diff, '同 seed 稳定、换 seed 换构图', JSON.stringify(det));

    // 4) 竖图撕口：左栏必须是纸，右边必须有照片
    const zones = await win.webContents.executeJavaScript(`new Promise(function(res){
        var img = makePhoto(800, 1000);
        var o = QfsZineRender.render('tear-narrative', img, { seed: 3, title: 'HELD' });
        var im = new Image();
        im.onload = function(){
            var c = document.createElement('canvas'); c.width = o.W; c.height = o.H;
            var x = c.getContext('2d'); x.drawImage(im, 0, 0);
            function stats(x0, x1, y0, y1){
                var d = x.getImageData(Math.round(o.W*x0), Math.round(o.H*y0),
                    Math.max(1, Math.round(o.W*(x1-x0))), Math.max(1, Math.round(o.H*(y1-y0)))).data;
                var sum = 0, sq = 0, n = 0;
                for (var i = 0; i < d.length; i += 4) {
                    var l = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
                    sum += l; sq += l*l; n++;
                }
                var mean = sum/n;
                return { mean: mean, sd: Math.sqrt(Math.max(0, sq/n - mean*mean)) };
            }
            res({ left: stats(0.01, 0.09, 0.10, 0.50), photo: stats(0.55, 0.95, 0.10, 0.45) });
        };
        im.src = o.dataUrl;
    })`);
    check(zones.left.mean > 195 && zones.left.sd < 22, '左边留的是纸，不是照片', JSON.stringify(zones.left));
    check(zones.photo.sd > 30, '照片区有画面层次，不是一块平色', JSON.stringify(zones.photo));

    // 5) 上下二分：下半必须是块面化的剪纸/墨阶，不是把原图贴回去
    const levels = await win.webContents.executeJavaScript(`new Promise(function(res){
        var img = makePhoto(800, 1000);
        var o = QfsZineRender.render('ink-bifold', img, { seed: 2, title: 'HELD' });
        var im = new Image();
        im.onload = function(){
            var c = document.createElement('canvas'); c.width = o.W; c.height = o.H;
            var x = c.getContext('2d'); x.drawImage(im, 0, 0);
            function spread(y0, y1){
                var d = x.getImageData(0, Math.round(o.H*y0), o.W, Math.round(o.H*(y1-y0))).data;
                var map = {}, n = 0;
                for (var i = 0; i < d.length; i += 4) {
                    var k = (d[i]>>4)+','+(d[i+1]>>4)+','+(d[i+2]>>4);
                    map[k] = (map[k] || 0) + 1; n++;
                }
                var arr = Object.keys(map).map(function(k){ return map[k]; }).sort(function(a,b){ return b-a; });
                var acc = 0, need = 0;
                while (acc < n * 0.9 && need < arr.length) { acc += arr[need]; need++; }
                return need;
            }
            res({ top: spread(0.05, 0.35), bottom: spread(0.60, 0.82) });
        };
        im.src = o.dataUrl;
    })`);
    check(levels.bottom <= 8 && levels.bottom * 2 < levels.top, '下半压成少数几块平涂，不是原图', JSON.stringify(levels));

    // 6) 留空标题：不印默认英文
    const blank = await win.webContents.executeJavaScript(`new Promise(function(res){
        var img = makePhoto(800, 1000);
        function grab(opts){
            var o = QfsZineRender.render('tear-narrative', img, opts);
            return new Promise(function(done){
                var im = new Image();
                im.onload = function(){
                    var c = document.createElement('canvas'); c.width = o.W; c.height = o.H;
                    var x = c.getContext('2d'); x.drawImage(im, 0, 0);
                    done(x.getImageData(0, Math.round(o.H*0.76), o.W, Math.round(o.H*0.20)).data);
                };
                im.src = o.dataUrl;
            });
        }
        Promise.all([grab({ seed: 3 }), grab({ seed: 3, title: 'HELD' })]).then(function(pair){
            var a = pair[0], b = pair[1], diff = 0;
            for (var i = 0; i < a.length; i += 4) diff += Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]);
            res({ diff: diff, n: a.length/4 });
        });
    })`);
    check(blank.diff / blank.n > 0.5, '给了标题才印字，留空就是留白', (blank.diff / blank.n).toFixed(2));

    // 7) 手绘：照片必须被「重画」，不是加一层滤镜
    const hand = await win.webContents.executeJavaScript(`new Promise(function(res){
        var img = makePhoto(800, 1000);
        var o = QfsZineRender.render('ink-sketch', img, { seed: 4, title: 'DRAWN' });
        var im = new Image();
        im.onload = function(){
            var c = document.createElement('canvas'); c.width = o.W; c.height = o.H;
            var x = c.getContext('2d'); x.drawImage(im, 0, 0);
            var d = x.getImageData(Math.round(o.W*0.08), Math.round(o.H*0.06),
                Math.round(o.W*0.84), Math.round(o.H*0.55)).data;
            var dark = 0, bright = 0, sat = 0, n = 0;
            for (var i = 0; i < d.length; i += 4) {
                var l = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
                var s = Math.max(d[i],d[i+1],d[i+2]) - Math.min(d[i],d[i+1],d[i+2]);
                if (l < 80) { dark++; sat += s; }
                if (l > 205) bright++;
                n++;
            }
            res({ dark: dark/n, bright: bright/n, sat: sat/Math.max(1,dark) });
        };
        im.src = o.dataUrl;
    })`);
    check(hand.dark > 0.03 && hand.dark < 0.40, '手绘页有墨线，也没糊成黑块', JSON.stringify(hand));
    check(hand.sat < 70, '线是墨，不是深色色块', hand.sat.toFixed(1));
    check(hand.bright > 0.06, '手绘页留了纸白', (hand.bright * 100).toFixed(1) + '%');

    // 7b) 颜料不能被「兑水」成灰：去掉纸白后，剩下的必须还有色相。
    // 之前的做法是先把颜料混进纸色，饱和掉到六分之一，整张会变成灰米色。
    const paint = await win.webContents.executeJavaScript(`new Promise(function(res){
        var img = makePhoto(800, 1000);
        var o = QfsZineRender.render('ink-sketch', img, { seed: 4, title: 'DRAWN' });
        var im = new Image();
        im.onload = function(){
            var c = document.createElement('canvas'); c.width = o.W; c.height = o.H;
            var x = c.getContext('2d'); x.drawImage(im, 0, 0);
            var d = x.getImageData(Math.round(o.W*0.08), Math.round(o.H*0.06),
                Math.round(o.W*0.84), Math.round(o.H*0.55)).data;
            var sum = 0, n = 0;
            for (var i = 0; i < d.length; i += 4) {
                var l = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
                if (l > 215) continue;
                sum += Math.max(d[i],d[i+1],d[i+2]) - Math.min(d[i],d[i+1],d[i+2]);
                n++;
            }
            res({ sat: sum / Math.max(1, n), n: n });
        };
        im.src = o.dataUrl;
    })`);
    check(paint.sat > 18, '手绘版留住了颜色，没洗成灰米色', paint.sat.toFixed(1));

    // 7c) 留白要成片：碎白点像漏印，一块整的才是纸。
    const holes = await win.webContents.executeJavaScript(`new Promise(function(res){
        var img = makePhoto(800, 1000);
        var o = QfsZineRender.render('ink-sketch', img, { seed: 4, title: 'DRAWN' });
        var im = new Image();
        im.onload = function(){
            var W = 140, H = Math.round(140 * o.H / o.W);
            var c = document.createElement('canvas'); c.width = W; c.height = H;
            var x = c.getContext('2d'); x.drawImage(im, 0, 0, W, H);
            var d = x.getImageData(0, 0, W, H).data;
            var on = new Uint8Array(W*H), total = 0;
            for (var p = 0; p < W*H; p++) {
                var i = p*4;
                if (0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2] > 208) { on[p] = 1; total++; }
            }
            var seen = new Uint8Array(W*H), stack = new Int32Array(W*H), best = 0;
            for (var p0 = 0; p0 < W*H; p0++) {
                if (!on[p0] || seen[p0]) continue;
                var sp = 0, n = 0;
                stack[sp++] = p0; seen[p0] = 1;
                while (sp) {
                    var p = stack[--sp]; n++;
                    var px = p % W, py = (p / W) | 0;
                    for (var dy = -1; dy <= 1; dy++) {
                        for (var dx = -1; dx <= 1; dx++) {
                            var qx = px + dx, qy = py + dy;
                            if (qx < 0 || qx >= W || qy < 0 || qy >= H) continue;
                            var q = qy*W + qx;
                            if (on[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
                        }
                    }
                }
                if (n > best) best = n;
            }
            res({ share: best / Math.max(1, total), total: total / (W*H) });
        };
        im.src = o.dataUrl;
    })`);
    check(holes.share > 0.45 && holes.total > 0.05, '留白是成片的纸，不是碎白点', JSON.stringify(holes));

    // 8) 手绘不能把照片的噪点抄进去：同一张加噪照片，重画后高频能量要明显更低
    const hf = await win.webContents.executeJavaScript(`(function(){
        var img = makePhoto(800, 1000);
        var c = document.createElement('canvas'); c.width = 800; c.height = 1000;
        var x = c.getContext('2d'); x.drawImage(img, 0, 0);
        var d = x.getImageData(0, 0, 800, 1000), dd = d.data;
        // 固定的伪随机噪点：测试要可复现
        var s = 12345;
        for (var i = 0; i < dd.length; i += 4) {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            var nz = ((s >> 16) % 47) - 23;
            dd[i] += nz; dd[i+1] += nz; dd[i+2] += nz;
        }
        x.putImageData(d, 0, 0);
        var noisy = new Image(); noisy.src = c.toDataURL('image/png');
        return new Promise(function(res){
            noisy.onload = function(){
                var W = 600, H = 450;
                var a = document.createElement('canvas'); a.width = W; a.height = H;
                a.getContext('2d').drawImage(noisy, 0, 0, W, H);
                var plate = QfsZineRender.sketchPlate(noisy, W, H, {
                    pal: QfsZineRender.samplePalette(noisy, 4), paper: '#F2E7D2', ink: '#2A2622', seed: 3
                });
                var b = document.createElement('canvas'); b.width = W; b.height = H;
                var bx = b.getContext('2d');
                bx.fillStyle = '#F2E7D2'; bx.fillRect(0, 0, W, H); bx.drawImage(plate, 0, 0);
                function hfOf(ctx){
                    var px = ctx.getImageData(0, 0, W, H).data, sum = 0, m = 0;
                    for (var y = 2; y < H - 2; y += 2) {
                        for (var xx = 2; xx < W - 2; xx += 2) {
                            var i = (y*W+xx)*4, j = (y*W+xx+2)*4;
                            sum += Math.abs(px[i]-px[j]) + Math.abs(px[i+1]-px[j+1]) + Math.abs(px[i+2]-px[j+2]);
                            m++;
                        }
                    }
                    return sum / m;
                }
                res({ photo: hfOf(a.getContext('2d')), plate: hfOf(bx) });
            };
        });
    })()`);
    check(hf.plate < hf.photo * 0.55, '照片的噪点被抹掉了，不是滤镜', JSON.stringify(hf));

    // 9) 钢笔淡彩也走手绘：有墨线、有纸白，且同 seed 稳定
    const wash = await win.webContents.executeJavaScript(`new Promise(function(res){
        var img = makePhoto(800, 1000);
        var o = QfsZineRender.render('pen-wash-travel', img, { seed: 6 });
        var im = new Image();
        im.onload = function(){
            var c = document.createElement('canvas'); c.width = o.W; c.height = o.H;
            var x = c.getContext('2d'); x.drawImage(im, 0, 0);
            var d = x.getImageData(0, 0, o.W, o.H).data, dark = 0, bright = 0, n = 0, sat = 0;
            for (var i = 0; i < d.length; i += 4) {
                var l = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
                if (l < 80) { dark++; sat += Math.max(d[i],d[i+1],d[i+2]) - Math.min(d[i],d[i+1],d[i+2]); }
                if (l > 205) bright++;
                n++;
            }
            res({ dark: dark/n, bright: bright/n, sat: sat/Math.max(1,dark),
                  stable: QfsZineRender.render('pen-wash-travel', img, { seed: 6 }).dataUrl === o.dataUrl });
        };
        im.src = o.dataUrl;
    })`);
    check(wash.dark > 0.008, '淡彩页有钢笔线', (wash.dark * 100).toFixed(1) + '%');
    check(wash.sat < 70, '淡彩的暗部是墨线，不是深色颜料', wash.sat.toFixed(1));
    check(wash.bright > 0.10, '淡彩页大面积留纸', (wash.bright * 100).toFixed(1) + '%');
    check(wash.stable, '淡彩同 seed 稳定');


    // 10) 明暗判定：只有真的暗才归夜景
    const tone = await win.webContents.executeJavaScript(`({
        bright: QfsZineRender.toneFor({ mean: 150, warm: 20 }),
        dark: QfsZineRender.toneFor({ mean: 52, warm: 4 }),
        cool: QfsZineRender.toneFor({ mean: 160, warm: -18 })
    })`);
    check(tone.bright === 'warm' && tone.dark === 'night' && tone.cool === 'cool', '明暗/冷暖判定分档正确', JSON.stringify(tone));

    win.destroy();
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });

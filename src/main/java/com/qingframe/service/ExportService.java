package com.qingframe.service;

import com.qingframe.core.BorderEngine;
import com.qingframe.core.ExifReader;
import com.qingframe.model.BaseMargin;
import com.qingframe.model.CornerConfig;
import com.qingframe.model.FilmTearConfig;
import com.qingframe.model.LayerBorder;
import com.qingframe.model.ShadowGlowConfig;
import com.qingframe.model.StrokeConfig;
import com.qingframe.model.TemplateModel;
import com.qingframe.model.TextStickerConfig;
import com.qingframe.util.FileUtil;
import com.qingframe.util.ImageExportUtil;
import com.qingframe.util.JsonUtil;
import javafx.application.Platform;
import javafx.embed.swing.SwingFXUtils;
import javafx.scene.image.WritableImage;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 图片导出服务：负责单张/批量导出的渲染与写盘。
 * 解码与写盘在有限线程池中并行，渲染因依赖 Canvas snapshot 仍经由界面线程串行执行。
 * 所有 UI 更新通过 {@link Listener} 回调，由服务内部切回界面线程后触发。
 */
public class ExportService {

    /** 导出渲染的安全长边（约 1600px），落在大多数 GPU 的稳定渲染区，避免 D3D 设备丢失 */
    public static final int EXPORT_SAFE_EDGE = 1600;

    /** 导出设置文件：记住上次导出目录 */
    public static final String EXPORT_SETTINGS_FILE =
            System.getProperty("user.home") + "/.qingkuangying-export-settings.txt";

    /** 导出进度回调（均在界面线程触发） */
    public interface Listener {
        void onProgress(int done, int total, String fileName);

        void onFileFailed(String fileName, String message);

        /** 某张图因显卡渲染限制被降级导出（requestedEdge > usedEdge 时触发） */
        void onQualityDegraded(String fileName, int requestedEdge, int usedEdge);

        void onFinished(int success, int failed, long elapsedSeconds);
    }

    /** 单张渲染结果：图片 + 实际使用的长边像素（用于判断是否发生了降级） */
    public static final class RenderResult {
        public final WritableImage image;
        /** 期望长边 = min(图片原始长边, 用户选择的上限) */
        public final int requestedEdge;
        /** 实际成功渲染的长边 */
        public final int usedEdge;

        public RenderResult(WritableImage image, int requestedEdge, int usedEdge) {
            this.image = image;
            this.requestedEdge = requestedEdge;
            this.usedEdge = usedEdge;
        }
    }

    private final BorderEngine engine;

    public ExportService(BorderEngine engine) {
        this.engine = engine;
    }

    /** 读取上次导出目录（无记录或已失效返回 null） */
    public File getLastExportDir() {
        try {
            String p = Files.readString(Paths.get(EXPORT_SETTINGS_FILE), StandardCharsets.UTF_8).trim();
            if (!p.isEmpty()) {
                File f = new File(p);
                if (f.isDirectory()) return f;
            }
        } catch (Exception ignored) {}
        return null;
    }

    /** 记住导出目录，供下次导出默认打开 */
    public void saveLastExportDir(File dir) {
        if (dir == null) return;
        try {
            Files.writeString(Paths.get(EXPORT_SETTINGS_FILE), dir.getAbsolutePath(), StandardCharsets.UTF_8);
        } catch (Exception ignored) {}
    }

    /** 扫描目录中 *_bordered_NNN.ext 文件，返回下一个编号（跨会话不重复） */
    public int nextExportNumber(File dir, String ext) {
        int max = 0;
        File[] files = dir.listFiles();
        if (files != null) {
            String suffix = "_bordered_";
            String lowerExt = ext.toLowerCase();
            for (File f : files) {
                String name = f.getName().toLowerCase();
                if (name.endsWith("." + lowerExt) && name.contains(suffix)) {
                    int idx = name.lastIndexOf(suffix);
                    String numPart = name.substring(idx + suffix.length(), name.length() - lowerExt.length() - 1);
                    try {
                        max = Math.max(max, Integer.parseInt(numPart));
                    } catch (Exception ignored) {}
                }
            }
        }
        return max + 1;
    }

    /**
     * 批量导出：解码与写盘阶段并行（有限线程池），
     * 渲染因依赖 Canvas snapshot 仍在界面线程串行执行；输出内容与顺序无关，结果与串行版本一致。
     *
     * @param maxEdge 用户选择的长边上限（如原画质 4096 / 2K 2560 / 安全 1600），渲染失败会自动向下降级
     */
    public void exportFiles(List<File> files, File exportDir, String fmt, float jpegQuality,
                            TemplateModel template, int maxEdge, Listener listener) {
        int threads = Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors()));
        ExecutorService pool = Executors.newFixedThreadPool(threads, r -> {
            Thread t = new Thread(r, "export-worker");
            t.setDaemon(true);
            return t;
        });
        // 导出开始前固化当前设置，避免导出过程中界面改动影响后续图片
        TemplateModel exportTemplate = cloneTemplate(template);
        String ext = "png".equalsIgnoreCase(fmt) ? "png" : "jpg";
        AtomicInteger fileNum = new AtomicInteger(nextExportNumber(exportDir, ext));
        int total = files.size();
        AtomicInteger completed = new AtomicInteger(0);
        AtomicInteger failed = new AtomicInteger(0);
        CountDownLatch allDone = new CountDownLatch(total);
        long startTime = System.currentTimeMillis();

        for (File src : files) {
            final String fileName = src.getName();
            pool.execute(() -> {
                try {
                    RenderResult result = renderFile(src, exportTemplate, maxEdge);
                    if (result.usedEdge < result.requestedEdge) {
                        final int req = result.requestedEdge;
                        final int used = result.usedEdge;
                        Platform.runLater(() -> listener.onQualityDegraded(fileName, req, used));
                    }
                    int n = fileNum.getAndIncrement();
                    String outPath = exportDir.getAbsolutePath() + File.separator +
                            FileUtil.getFileNameWithoutExt(fileName) + "_bordered_" + String.format("%03d", n) + "." + ext;
                    ImageExportUtil.export(result.image, outPath, fmt, jpegQuality);
                } catch (Exception e) {
                    failed.incrementAndGet();
                    e.printStackTrace();
                    final String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                    Platform.runLater(() -> listener.onFileFailed(fileName, msg));
                }
                int doneN = completed.incrementAndGet();
                allDone.countDown();
                if (doneN % 5 == 0 || doneN == total) {
                    final double p = (double) doneN / total;
                    Platform.runLater(() -> listener.onProgress(doneN, total, fileName));
                }
            });
        }
        pool.shutdown();

        new Thread(() -> {
            try {
                allDone.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            final int failedFinal = failed.get();
            final int successFinal = total - failedFinal;
            final long elapsed = (System.currentTimeMillis() - startTime + 500) / 1000;
            Platform.runLater(() -> listener.onFinished(successFinal, failedFinal, elapsed));
        }).start();
    }

    /** 读取文件并渲染出边框图（后台线程调用） */
    public RenderResult renderFile(File src, TemplateModel tmpl, int maxEdge) throws Exception {
        BufferedImage awtImg = ImageIO.read(src);
        if (awtImg == null) throw new IOException("无法读取图片: " + src.getName());
        ExifReader.ExifData exif = ExifReader.parse(src);
        if (exif != null) awtImg = applyOrientation(awtImg, exif.orientation);
        return renderAwtWithFallback(awtImg, tmpl, maxEdge);
    }

    /** 由已解码的 AWT 图像渲染（后台线程调用，含分级降级） */
    public RenderResult renderFromAwt(BufferedImage awt, TemplateModel tmpl, int maxEdge) throws Exception {
        return renderAwtWithFallback(awt, tmpl, maxEdge);
    }

    /** 按 EXIF 方向旋转图像（与 JavaFX 预览自动应用方向保持一致） */
    public BufferedImage applyOrientation(BufferedImage img, int orientation) {
        if (img == null || orientation == 1 || orientation == 0) return img;
        int w = img.getWidth(), h = img.getHeight();
        switch (orientation) {
            case 3:
            {
                BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
                for (int y = 0; y < h; y++) {
                    int[] row = img.getRGB(0, y, w, 1, null, 0, w);
                    int[] rev = new int[w];
                    for (int x = 0; x < w; x++) rev[x] = row[w - 1 - x];
                    out.setRGB(0, h - 1 - y, w, 1, rev, 0, w);
                }
                return out;
            }
            case 6: {
                // 顺时针 90°：源 (x,y) -> 目标 (h-1-y, x)
                BufferedImage out = new BufferedImage(h, w, BufferedImage.TYPE_INT_ARGB);
                for (int y = 0; y < h; y++) {
                    int[] row = img.getRGB(0, y, w, 1, null, 0, w);
                    for (int x = 0; x < w; x++) {
                        out.setRGB(h - 1 - y, x, row[x]);
                    }
                }
                return out;
            }
            case 8: {
                // 逆时针 90°：源 (x,y) -> 目标 (y, w-1-x)
                BufferedImage out = new BufferedImage(h, w, BufferedImage.TYPE_INT_ARGB);
                for (int y = 0; y < h; y++) {
                    int[] row = img.getRGB(0, y, w, 1, null, 0, w);
                    for (int x = 0; x < w; x++) {
                        out.setRGB(y, w - 1 - x, row[x]);
                    }
                }
                return out;
            }
            default:
                return img;
        }
    }

    /** 按长边上限缩小 AWT 图像（不超过上限则原样返回） */
    private BufferedImage downscaleAwtToMaxEdge(BufferedImage awt, int maxEdge) {
        int longEdge = Math.max(awt.getWidth(), awt.getHeight());
        if (longEdge <= maxEdge) return awt;
        double scale = (double) maxEdge / longEdge;
        int nw = Math.max(1, (int) (awt.getWidth() * scale));
        int nh = Math.max(1, (int) (awt.getHeight() * scale));
        BufferedImage scaled = new BufferedImage(nw, nh, BufferedImage.TYPE_INT_ARGB);
        java.awt.Graphics2D g = scaled.createGraphics();
        g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.drawImage(awt, 0, 0, nw, nh, null);
        g.dispose();
        return scaled;
    }

    /** 单张/批量导出：渲染空白或异常时自动向下降级，直到成功或全部失败（后台线程调用） */
    private RenderResult renderAwtWithFallback(BufferedImage awt, TemplateModel tmpl, int maxEdge) throws Exception {
        int longEdge = Math.max(awt.getWidth(), awt.getHeight());
        int target = Math.min(longEdge, maxEdge);
        logExport("原始尺寸: " + awt.getWidth() + "x" + awt.getHeight() + "，目标长边: " + target);

        // 候选档位：目标长边 + 依次更低的降级档（图片本身小于目标时不做任何缩放）
        List<Integer> candidates = new ArrayList<>();
        candidates.add(target);
        for (int fb : new int[]{2400, 1600, 1024}) {
            if (fb < target && !candidates.contains(fb)) candidates.add(fb);
        }

        Exception lastErr = null;
        for (int edge : candidates) {
            try {
                BufferedImage scaled = (edge >= longEdge) ? awt : downscaleAwtToMaxEdge(awt, edge);
                TemplateModel scaledTmpl = (edge >= longEdge) ? tmpl
                        : scaleTemplateForExport(tmpl, (double) scaled.getWidth() / awt.getWidth());
                WritableImage r = renderAwtScaled(scaled, awt, scaledTmpl);
                boolean blank = r == null || ImageExportUtil.looksBlank(r);
                logExport("渲染长边 " + edge + "(" + scaled.getWidth() + "x" + scaled.getHeight() + ") 空白=" + blank);
                if (!blank) return new RenderResult(r, target, edge);
            } catch (Exception e) {
                lastErr = e;
                logExport("渲染长边 " + edge + " 异常: " + e.getClass().getSimpleName() + " - " + e.getMessage());
            }
        }
        if (lastErr != null) {
            throw new IOException("渲染失败（全部分级均异常）: " + lastErr.getMessage(), lastErr);
        }
        throw new IOException(String.format("渲染结果异常（接近空白），且自动缩放后仍失败：照片 %dx%d",
                awt.getWidth(), awt.getHeight()));
    }

    /** 渲染指定尺寸图，并按比例同步图标位置/大小（保证降级导出时 Logo 位置与预览一致） */
    private WritableImage renderAwtScaled(BufferedImage renderImg, BufferedImage origImg, TemplateModel tmpl) throws Exception {
        double sx = (double) renderImg.getWidth() / origImg.getWidth();
        double sy = (double) renderImg.getHeight() / origImg.getHeight();
        engine.setIconRenderScale(sx, sy);
        try {
            WritableImage fx = SwingFXUtils.toFXImage(renderImg, null);
            return renderOnFx(fx, tmpl);
        } finally {
            engine.setIconRenderScale(1.0, 1.0);
        }
    }

    private WritableImage renderOnFx(WritableImage fx, TemplateModel tmpl) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        WritableImage[] result = new WritableImage[1];
        Exception[] err = new Exception[1];
        Platform.runLater(() -> {
            try {
                result[0] = engine.renderBorder(fx, tmpl);
            } catch (Exception e) {
                err[0] = e;
            } finally {
                latch.countDown();
            }
        });
        latch.await();
        if (err[0] != null) throw err[0];
        return result[0];
    }

    /** 按比例缩放模板的全部像素参数（边距/描边/圆角/阴影/文字/胶片效果），用于降级导出保持视觉一致 */
    private TemplateModel scaleTemplateForExport(TemplateModel src, double s) {
        TemplateModel t = cloneTemplate(src);
        BaseMargin m = t.getBaseMargin();
        m.setMarginTop((int) Math.round(m.getMarginTop() * s));
        m.setMarginBottom((int) Math.round(m.getMarginBottom() * s));
        m.setMarginLeft((int) Math.round(m.getMarginLeft() * s));
        m.setMarginRight((int) Math.round(m.getMarginRight() * s));
        m.setImgOffsetX((int) Math.round(m.getImgOffsetX() * s));
        m.setImgOffsetY((int) Math.round(m.getImgOffsetY() * s));
        m.setBgBlurRadius((int) Math.round(m.getBgBlurRadius() * s));

        for (LayerBorder layer : t.getLayerList()) {
            layer.setMarginTop((int) Math.round(layer.getMarginTop() * s));
            layer.setMarginBottom((int) Math.round(layer.getMarginBottom() * s));
            layer.setMarginLeft((int) Math.round(layer.getMarginLeft() * s));
            layer.setMarginRight((int) Math.round(layer.getMarginRight() * s));
            StrokeConfig st = layer.getStrokeConfig();
            if (st.getStrokeWidth() > 0) {
                st.setStrokeWidth(Math.max(1, (int) Math.round(st.getStrokeWidth() * s)));
            }
            if (st.getStrokeDashArray() != null && !st.getStrokeDashArray().isEmpty()) {
                List<Double> scaledDashes = new ArrayList<>();
                for (double d : st.getStrokeDashArray()) scaledDashes.add(d * s);
                st.setStrokeDashArray(scaledDashes);
            }
            st.setStrokeDashOffset(st.getStrokeDashOffset() * s);
            ShadowGlowConfig sg = layer.getShadowGlowConfig();
            sg.setShadowOffsetX(sg.getShadowOffsetX() * s);
            sg.setShadowOffsetY(sg.getShadowOffsetY() * s);
            sg.setShadowBlur(sg.getShadowBlur() * s);
            sg.setShadowSpread(sg.getShadowSpread() * s);
            sg.setGlowBlur(sg.getGlowBlur() * s);
            sg.setGlowSpread(sg.getGlowSpread() * s);
        }

        CornerConfig c = t.getCornerConfig();
        c.setCornerRadiusAll(c.getCornerRadiusAll() * s);
        c.setCornerRadiusTL(c.getCornerRadiusTL() * s);
        c.setCornerRadiusTR(c.getCornerRadiusTR() * s);
        c.setCornerRadiusBL(c.getCornerRadiusBL() * s);
        c.setCornerRadiusBR(c.getCornerRadiusBR() * s);

        FilmTearConfig ft = t.getFilmTearConfig();
        ft.setTearStrength(ft.getTearStrength() * s);
        ft.setTearDensity(ft.getTearDensity() * s);
        ft.setFilmPerforationSize(ft.getFilmPerforationSize() * s);
        ft.setFilmPerforationSpacing(ft.getFilmPerforationSpacing() * s);
        ft.setDustScratchIntensity((int) Math.round(ft.getDustScratchIntensity() * s));
        ft.setYellowingStrength((int) Math.round(ft.getYellowingStrength() * s));

        TextStickerConfig dec = t.getDecorConfig();
        for (TextStickerConfig.TextLine line : dec.getTextLines()) {
            line.setFontSize(line.getFontSize() * s);
            line.setX(line.getX() * s);
            line.setY(line.getY() * s);
            line.setLetterSpacing(line.getLetterSpacing() * s);
        }
        dec.setCornerDecorSize(dec.getCornerDecorSize() * s);
        t.setParamFontSize((int) Math.round(t.getParamFontSize() * s));
        return t;
    }

    private TemplateModel cloneTemplate(TemplateModel src) {
        try {
            String json = JsonUtil.toJson(src);
            return JsonUtil.fromJson(json);
        } catch (Exception e) {
            return new TemplateModel();
        }
    }

    /** 导出诊断日志：写入用户目录 QingFrameShadow-export.log，用于定位导出失败原因 */
    public static void logExport(String msg) {
        try {
            FileWriter fw = new FileWriter(
                    System.getProperty("user.home") + "/QingFrameShadow-export.log", true);
            fw.write(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date()) + "  " + msg + "\n");
            fw.close();
        } catch (Exception ignored) {}
    }
}

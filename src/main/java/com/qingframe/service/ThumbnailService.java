package com.qingframe.service;

import com.qingframe.core.ExifReader;
import com.qingframe.model.TemplateModel;
import javafx.application.Platform;
import javafx.embed.swing.SwingFXUtils;
import javafx.scene.image.Image;
import javafx.scene.image.WritableImage;

import java.awt.image.BufferedImage;
import java.io.File;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;

/**
 * 胶片条缩略图服务：单线程队列生成、带边框缩略图缓存（淘汰减半策略）、代次防过期任务。
 * 从 MainController 抽出；边框渲染通过 FrameRenderer 回调注入，本类不依赖控制器与 FXML。
 */
public class ThumbnailService {

    /** 带边框缩略图的最终渲染回调（在 FX 线程执行），由持有 BorderEngine 的一方注入 */
    public interface FrameRenderer {
        Image render(Image src, TemplateModel tmpl);
    }

    private static final int THUMB_MAX_DIM = 1280;
    private static final int THUMB_CACHE_MAX = 200;

    private final FrameRenderer renderer;
    private final Map<File, Image> thumbCache = new ConcurrentHashMap<>();
    private final ExecutorService thumbExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "thumb-worker");
        t.setDaemon(true);
        return t;
    });
    /** 缩略图队列代次：每次重建胶片条时递增，用于丢弃过期任务 */
    private volatile long generation = 0;

    public ThumbnailService(FrameRenderer renderer) {
        this.renderer = renderer;
    }

    /** 重建胶片条时调用：递增代次使旧任务全部失效 */
    public long bumpGeneration() {
        return ++generation;
    }

    public Image getCached(File file) {
        return thumbCache.get(file);
    }

    public void evict(File file) {
        if (file != null) thumbCache.remove(file);
    }

    public void clear() {
        thumbCache.clear();
    }

    /** 后台队列渲染带边框缩略图，完成后经 onReady 回 FX 线程替换（onReady 参数：格子下标, 缩略图） */
    public void schedule(int idx, File file, TemplateModel tmpl, BiConsumer<Integer, Image> onReady) {
        final long gen = generation;
        thumbExecutor.execute(() -> {
            if (gen != generation) return;
            Image thumb = getOrCreate(file, tmpl);
            if (thumb == null || gen != generation) return;
            Platform.runLater(() -> {
                if (gen != generation) return;
                onReady.accept(idx, thumb);
            });
        });
    }

    private Image getOrCreate(File file, TemplateModel tmpl) {
        Image cached = thumbCache.get(file);
        if (cached != null && cached.getWidth() > 0) return cached;
        try {
            // 缩略图只需 1280 长边：降采样解码替代全尺寸解码，大图耗时从秒级降到几十毫秒
            BufferedImage awtImg = PuzzleImageService.decodeScaled(file, THUMB_MAX_DIM, true);
            if (awtImg == null) return null;
            ExifReader.ExifData exif = ExifReader.parse(file);
            if (exif != null) awtImg = PuzzleImageService.applyOrientation(awtImg, exif.orientation);
            CountDownLatch latch = new CountDownLatch(1);
            Image[] result = new Image[1];
            final BufferedImage finalImg = awtImg;
            Platform.runLater(() -> {
                try {
                    WritableImage fxImg = SwingFXUtils.toFXImage(finalImg, null);
                    result[0] = renderer.render(fxImg, tmpl);
                } catch (Exception ignored) {
                } finally {
                    latch.countDown();
                }
            });
            if (!latch.await(15, TimeUnit.SECONDS)) return null;
            if (result[0] != null) {
                if (thumbCache.size() >= THUMB_CACHE_MAX) {
                    // 淘汰约一半而不是全部清空，避免大图库瞬间集体重新解码
                    int toRemove = thumbCache.size() / 2;
                    Iterator<File> it = thumbCache.keySet().iterator();
                    while (toRemove-- > 0 && it.hasNext()) {
                        it.next();
                        it.remove();
                    }
                }
                thumbCache.put(file, result[0]);
            }
            return result[0];
        } catch (Exception e) {
            return null;
        }
    }
}

package com.qingframe.service;

import com.qingframe.core.ExifReader;
import com.qingframe.core.PuzzlrRenderer;
import com.qingframe.model.PuzzlrConfig;

import java.awt.image.BufferedImage;
import java.io.File;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 拼图图片服务：格子图片的降采样解码 + EXIF 方向 + sRGB 统一 + 分辨率档位 LRU 缓存，
 * 以及整幅拼图的合成入口。从 MainController 抽出，不依赖任何 UI 类型。
 */
public class PuzzleImageService {

    /** 拼图图片缓存：path@分辨率档 → 解码+方向+sRGB+降采样后的图（LRU 上限 16 张，超大图不缓存）。
     *  按分辨率档位缓存后，滚轮连续缩放格子时各档复用，避免反复解码大图卡顿 */
    private final Map<String, BufferedImage> puzzleImageCache =
            Collections.synchronizedMap(new LinkedHashMap<String, BufferedImage>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, BufferedImage> eldest) {
                    return size() > 16;
                }
            });

    /** 合成整幅拼图（预览 edge=1600 / 导出 edge=4000） */
    public BufferedImage renderPuzzle(PuzzlrConfig pc, int edge) {
        List<com.qingframe.model.SlotConfig> slots = pc.getSlots();
        double[][] rel = pc.buildSlots();
        java.util.List<BufferedImage> imgs = new java.util.ArrayList<>();
        for (int i = 0; i < slots.size(); i++) {
            com.qingframe.model.SlotConfig s = slots.get(i);
            BufferedImage img = null;
            if (s.getImagePath() != null) {
                double frac = i < rel.length ? Math.max(rel[i][2], rel[i][3]) : 1.0;
                int need = (int) Math.min(6000, Math.max(600, frac * edge * s.getZoom() * 1.15));
                // 预览渲染（edge<4000）：限制原图分辨率上限，避免格子滚轮缩放时反复解码超大图
                if (edge < 4000) need = Math.min(need, 2400);
                img = loadSlotImage(s.getImagePath(), need);
            }
            imgs.add(img);
        }
        return PuzzlrRenderer.render(imgs, pc, edge);
    }

    /** 读取单格图片：EXIF 方向 + sRGB + 降采样到 needEdge 长边；带 LRU 缓存避免拖动时反复解码 */
    public BufferedImage loadSlotImage(String path, int needEdge) {
        // 分辨率档位化：need 随滚轮缩放连续变化，按档缓存避免缓存频繁失效
        int tier = 800;
        if (needEdge > 1200) tier = 1200;
        if (needEdge > 1600) tier = 1600;
        if (needEdge > 2000) tier = 2000;
        if (needEdge > 2400) tier = 2400;
        if (needEdge > 3000) tier = 3000;
        if (needEdge > 4000) tier = 4000;
        if (needEdge > 5000) tier = 5000;
        String key = path + "@" + tier;
        BufferedImage cached = puzzleImageCache.get(key);
        if (cached != null && Math.max(cached.getWidth(), cached.getHeight()) >= needEdge) return cached;
        try {
            File f = new File(path);
            if (!f.exists()) return null;
            int target = Math.max(needEdge, 800);
            // 先缩略解码 + 降采样，再做方向旋转/色彩转换：
            // 大图全尺寸逐像素旋转/转色会卡死数秒并占用数百 MB 内存，缩到目标尺寸后这些操作只需几十毫秒
            BufferedImage img = decodeScaled(f, target, false);
            if (img == null) return null;
            ExifReader.ExifData ex = ExifReader.parse(f);
            if (ex != null) img = applyOrientation(img, ex.orientation);
            img = toSRGB(img);
            // 超大图不进缓存（防内存膨胀），其余 LRU 缓存
            if ((long) img.getWidth() * img.getHeight() <= 24_000_000L) {
                puzzleImageCache.put(key, img);
            }
            return img;
        } catch (Exception e) {
            return null;
        }
    }

    /** 解码图片并按目标长边降采样：ImageIO 整数采样粗读（JPEG/PNG 解码层直接跳像素），再精确缩放。
     *  避免对几千万像素大图全尺寸解码后再缩放（卡顿与内存峰值的主要来源） */
    public static BufferedImage decodeScaled(File f, int target, boolean keepAlpha) {
        int rgbType = keepAlpha ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB;
        try (javax.imageio.stream.ImageInputStream in = javax.imageio.ImageIO.createImageInputStream(f)) {
            if (in != null) {
                java.util.Iterator<javax.imageio.ImageReader> it = javax.imageio.ImageIO.getImageReaders(in);
                if (it.hasNext()) {
                    javax.imageio.ImageReader r = it.next();
                    try {
                        r.setInput(in, true, true);
                        int w = r.getWidth(0), h = r.getHeight(0);
                        int subs = 1;
                        while (w / (subs * 2L) > target || h / (subs * 2L) > target) subs *= 2;
                        javax.imageio.ImageReadParam p = r.getDefaultReadParam();
                        if (subs > 1) p.setSourceSubsampling(subs, subs, 0, 0);
                        BufferedImage img = r.read(0, p);
                        // 整数采样后可能仍大于目标，精确缩放到目标长边
                        int le = Math.max(img.getWidth(), img.getHeight());
                        if (le > target) {
                            double sc = (double) target / le;
                            BufferedImage small = new BufferedImage(
                                    Math.max(1, (int) Math.round(img.getWidth() * sc)),
                                    Math.max(1, (int) Math.round(img.getHeight() * sc)),
                                    keepAlpha && img.getColorModel().hasAlpha() ? BufferedImage.TYPE_INT_ARGB : rgbType);
                            java.awt.Graphics2D gg = small.createGraphics();
                            gg.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION,
                                    java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                            gg.drawImage(img, 0, 0, small.getWidth(), small.getHeight(), null);
                            gg.dispose();
                            img = small;
                        }
                        return img;
                    } finally {
                        r.dispose();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        // 无可用 reader 或读取异常：回退全量解码 + 缩放
        try {
            BufferedImage fallback = javax.imageio.ImageIO.read(f);
            if (fallback == null) return null;
            int le = Math.max(fallback.getWidth(), fallback.getHeight());
            if (le > target) {
                double sc = (double) target / le;
                BufferedImage small = new BufferedImage(
                        Math.max(1, (int) Math.round(fallback.getWidth() * sc)),
                        Math.max(1, (int) Math.round(fallback.getHeight() * sc)),
                        keepAlpha && fallback.getColorModel().hasAlpha() ? BufferedImage.TYPE_INT_ARGB : rgbType);
                java.awt.Graphics2D gg = small.createGraphics();
                gg.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION,
                        java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                gg.drawImage(fallback, 0, 0, small.getWidth(), small.getHeight(), null);
                gg.dispose();
                return small;
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }

    /** 非 sRGB 色彩空间（如 Display P3/Adobe RGB）统一转换到 sRGB，保证导出与显示一致 */
    public static BufferedImage toSRGB(BufferedImage img) {
        try {
            java.awt.color.ColorSpace cs = img.getColorModel().getColorSpace();
            if (cs.getType() != java.awt.color.ColorSpace.TYPE_RGB) return img;
            if (cs instanceof java.awt.color.ICC_ColorSpace) {
                byte[] srcData = ((java.awt.color.ICC_ColorSpace) cs).getProfile().getData();
                if (java.util.Arrays.equals(srcData,
                        java.awt.color.ICC_Profile.getInstance(java.awt.color.ColorSpace.CS_sRGB).getData())) {
                    return img;
                }
                java.awt.image.ColorConvertOp op = new java.awt.image.ColorConvertOp(
                        cs, java.awt.color.ColorSpace.getInstance(java.awt.color.ColorSpace.CS_sRGB), null);
                BufferedImage out = new BufferedImage(img.getWidth(), img.getHeight(), BufferedImage.TYPE_INT_ARGB);
                return op.filter(img, out);
            }
        } catch (Exception ignored) {
        }
        return img;
    }

    /** 按 EXIF orientation 摆正方向：3=180°、6=顺时针 90°、8=逆时针 90° */
    public static BufferedImage applyOrientation(BufferedImage img, int orientation) {
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
}

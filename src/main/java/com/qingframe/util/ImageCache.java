package com.qingframe.util;

import javafx.scene.image.Image;

import java.io.InputStream;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * JavaFX Image 全局缓存。
 * 纹理、贴纸、图标等重复绘制的图片按资源路径缓存，避免每次渲染都从磁盘重新解码。
 * 线程安全，容量超限时按最久未使用（LRU）淘汰。
 */
public final class ImageCache {

    private static final int MAX_ENTRIES = 128;
    private static final Map<String, Image> CACHE = new LinkedHashMap<>(64, 0.75f, true);

    private ImageCache() {
    }

    /**
     * 获取（必要时加载并缓存）指定来源的图片。
     *
     * @param src 图片来源（file: URI、http URL 或资源路径）
     * @return 图片；src 为空或加载失败时返回 null
     */
    public static Image get(String src) {
        if (src == null || src.isEmpty()) return null;
        synchronized (CACHE) {
            Image img = CACHE.get(src);
            if (img != null) return img;
            try {
                // 同步加载：new Image(InputStream) 会阻塞直到解码完成，
                // 避免异步 new Image(String) 返回未就绪/失败图被缓存
                img = loadSynchronously(src);
            } catch (Exception e) {
                return null;
            }
            if (img == null || img.isError()) {
                return null;
            }
            CACHE.put(src, img);
            trim();
            return img;
        }
    }

    /** 同步加载图片（InputStream 构造器在调用线程完成解码） */
    private static Image loadSynchronously(String src) throws Exception {
        if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("file:")) {
            try (InputStream in = new java.net.URL(src).openStream()) {
                return new Image(in);
            }
        }
        // 类路径资源（如 /com/qingframe/textures/...）
        InputStream res = ImageCache.class.getResourceAsStream(src);
        if (res != null) {
            try (InputStream in = res) {
                return new Image(in);
            }
        }
        // 普通本地文件路径兜底
        java.io.File f = new java.io.File(src);
        if (f.isFile()) {
            try (InputStream in = new java.io.FileInputStream(f)) {
                return new Image(in);
            }
        }
        return null;
    }

    public static void clear() {
        synchronized (CACHE) {
            CACHE.clear();
        }
    }

    public static int size() {
        synchronized (CACHE) {
            return CACHE.size();
        }
    }

    private static void trim() {
        if (CACHE.size() <= MAX_ENTRIES) return;
        Iterator<Map.Entry<String, Image>> it = CACHE.entrySet().iterator();
        while (it.hasNext() && CACHE.size() > MAX_ENTRIES) {
            it.next();
            it.remove();
        }
    }
}

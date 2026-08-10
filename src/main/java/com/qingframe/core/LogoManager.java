package com.qingframe.core;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

public class LogoManager {

    private static final File CACHE_FILE = new File(
            System.getProperty("user.home") + File.separator + ".qingkuangying-custom-logo.png");

    private static BufferedImage cachedLogo;

    public static synchronized BufferedImage load() {
        if (CACHE_FILE.exists()) {
            try {
                cachedLogo = ImageIO.read(CACHE_FILE);
            } catch (IOException e) {
                System.err.println("[LogoManager] 读取自定义 Logo 缓存失败: " + e.getMessage());
            }
        }
        return cachedLogo;
    }

    public static synchronized void save(BufferedImage img) {
        cachedLogo = img;
        try {
            ImageIO.write(img, "PNG", CACHE_FILE);
        } catch (IOException e) {
            System.err.println("[LogoManager] 保存自定义 Logo 缓存失败: " + e.getMessage());
        }
    }

    public static synchronized BufferedImage get() {
        return cachedLogo;
    }

    public static synchronized void clear() {
        cachedLogo = null;
        try {
            Files.deleteIfExists(CACHE_FILE.toPath());
        } catch (IOException e) {
            System.err.println("[LogoManager] 删除自定义 Logo 缓存失败: " + e.getMessage());
        }
    }

    public static synchronized boolean hasCustom() {
        return cachedLogo != null;
    }
}

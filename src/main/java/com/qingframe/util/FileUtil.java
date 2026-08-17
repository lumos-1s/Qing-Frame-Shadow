package com.qingframe.util;

import java.io.*;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class FileUtil {

    /** 本软件导出的文件名形如 xxx_bordered_001.jpg：文件夹批量导出时需排除，避免把上次导出产物再次纳入 */
    private static final java.util.regex.Pattern EXPORT_PRODUCT_PATTERN =
            java.util.regex.Pattern.compile("(?i)_bordered_\\d{3}\\.(jpg|jpeg|png)$");

    public static List<String> listImageFiles(String dirPath) {
        List<String> images = new ArrayList<>();
        File dir = new File(dirPath);
        if (!dir.exists() || !dir.isDirectory()) return images;

        for (File f : dir.listFiles()) {
            String name = f.getName().toLowerCase();
            if (name.endsWith(".jpg") || name.endsWith(".jpeg") ||
                    name.endsWith(".png") || name.endsWith(".bmp") ||
                    name.endsWith(".tiff") || name.endsWith(".webp")) {
                if (EXPORT_PRODUCT_PATTERN.matcher(f.getName()).matches()) continue;
                images.add(f.getAbsolutePath());
            }
        }
        // 固定排序：批量导出顺序不依赖文件系统枚举
        Collections.sort(images);
        return images;
    }

    public static String getExtension(String fileName) {
        int dot = fileName.lastIndexOf('.');
        return dot >= 0 ? fileName.substring(dot).toLowerCase() : "";
    }

    public static String getFileNameWithoutExt(String fileName) {
        int dot = fileName.lastIndexOf('.');
        return dot >= 0 ? fileName.substring(0, dot) : fileName;
    }

    public static void ensureDir(String dirPath) {
        File dir = new File(dirPath);
        if (!dir.exists()) dir.mkdirs();
    }

    public static String getDefaultExportDir() {
        String userHome = System.getProperty("user.home");
        String dir = userHome + File.separator + "Desktop" + File.separator + "清框影导出";
        ensureDir(dir);
        return dir;
    }

    public static String getDefaultTemplateDir() {
        String userHome = System.getProperty("user.home");
        String dir = userHome + File.separator + "Documents" + File.separator + "QingFrameShadow" + File.separator + "templates";
        ensureDir(dir);
        return dir;
    }
}

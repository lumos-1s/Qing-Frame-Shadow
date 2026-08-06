package com.qingframe.util;

import java.io.*;
import java.util.ArrayList;
import java.util.List;

public class FileUtil {

    public static List<String> listImageFiles(String dirPath) {
        List<String> images = new ArrayList<>();
        File dir = new File(dirPath);
        if (!dir.exists() || !dir.isDirectory()) return images;

        for (File f : dir.listFiles()) {
            String name = f.getName().toLowerCase();
            if (name.endsWith(".jpg") || name.endsWith(".jpeg") ||
                    name.endsWith(".png") || name.endsWith(".bmp") ||
                    name.endsWith(".tiff") || name.endsWith(".webp")) {
                images.add(f.getAbsolutePath());
            }
        }
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

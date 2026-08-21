package com.qingframe.util;

import javafx.embed.swing.SwingFXUtils;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;

import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.util.Iterator;

public class ImageExportUtil {

    /**
     * 渲染结果自检：采样判断图片是否接近全白/全透明（防止导出空白文件）。
     *
     * @return true 表示结果异常（接近空白）
     */
    public static boolean looksBlank(Image image) {
        if (image == null) return true;
        int w = (int) image.getWidth();
        int h = (int) image.getHeight();
        if (w <= 0 || h <= 0) return true;
        PixelReader pr = image.getPixelReader();
        int stepX = Math.max(1, w / 48);
        int stepY = Math.max(1, h / 48);
        int samples = 0;
        int nonBlank = 0;
        for (int y = 0; y < h; y += stepY) {
            for (int x = 0; x < w; x += stepX) {
                samples++;
                int argb = pr.getArgb(x, y);
                if (((argb >>> 24) & 0xFF) > 0) {
                    int r = (argb >> 16) & 0xFF, g = (argb >> 8) & 0xFF, b = argb & 0xFF;
                    if (r < 250 || g < 250 || b < 250) nonBlank++;
                }
            }
        }
        return samples == 0 || nonBlank * 100 / samples < 5;
    }

    public static void exportPng(Image image, String outputPath) throws IOException {
        BufferedImage bImg = SwingFXUtils.fromFXImage(image, null);
        ImageIO.write(bImg, "png", new File(outputPath));
    }

    public static void exportJpg(Image image, String outputPath, float quality) throws IOException {
        BufferedImage bImg = SwingFXUtils.fromFXImage(image, null);
        BufferedImage rgb = new BufferedImage(bImg.getWidth(), bImg.getHeight(), BufferedImage.TYPE_INT_RGB);
        java.awt.Graphics2D g = rgb.createGraphics();
        try {
            g.drawImage(bImg, 0, 0, java.awt.Color.WHITE, null);
        } finally {
            g.dispose();
        }
        writeJpeg(rgb, new File(outputPath), quality);
    }

    public static void export(Image image, String outputPath, String format) throws IOException {
        export(image, outputPath, format, 0.95f);
    }

    public static void export(Image image, String outputPath, String format, float jpegQuality) throws IOException {
        if ("png".equalsIgnoreCase(format)) {
            exportPng(image, outputPath);
        } else {
            exportJpg(image, outputPath, jpegQuality);
        }
    }

    /** 写出 JPEG：高质量 + 优化哈夫曼表；色彩空间统一 sRGB 由读入端 toSRGB 保证（JPEG 无 ICC 时查看器按 sRGB 解释） */
    private static void writeJpeg(BufferedImage rgb, File outFile, float quality) throws IOException {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
        if (writers.hasNext()) {
            ImageWriter writer = writers.next();
            try (ImageOutputStream ios = ImageIO.createImageOutputStream(outFile)) {
                writer.setOutput(ios);
                javax.imageio.plugins.jpeg.JPEGImageWriteParam param =
                        new javax.imageio.plugins.jpeg.JPEGImageWriteParam(null);
                param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                param.setCompressionQuality(Math.max(0.1f, Math.min(1.0f, quality)));
                param.setOptimizeHuffmanTables(true);
                // 不传自定义 metadata（JPEG 元数据树修改易导致写出损坏），像素直写 + 默认 JFIF 段
                writer.write(null, new javax.imageio.IIOImage(rgb, null, null), param);
            } finally {
                writer.dispose();
            }
        } else {
            ImageIO.write(rgb, "jpeg", outFile);
        }
    }
}

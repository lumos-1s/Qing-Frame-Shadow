package com.qingframe.core;

import com.qingframe.model.IconItem;
import com.qingframe.util.ImageCache;
import javafx.scene.canvas.GraphicsContext;
import javafx.scene.effect.DropShadow;
import javafx.scene.effect.BlurType;
import javafx.scene.image.Image;
import javafx.scene.paint.Color;
import javafx.scene.shape.ArcType;
import javafx.scene.text.Font;
import javafx.scene.text.FontWeight;
import javafx.scene.text.TextAlignment;
import javafx.geometry.VPos;

public class IconRenderer {

    public static void draw(GraphicsContext gc, IconItem item, double x, double y, double size) {
        gc.save();
        gc.translate(x, y);
        gc.setGlobalAlpha(item.getOpacity() / 100.0);

        String id = item.getId();
        if (item.getSrc() != null && !item.getSrc().isEmpty()) {
            Image img = ImageCache.get(item.getSrc());
            if (img != null) {
                gc.drawImage(img, -size / 2, -size / 2, size, size);
            }
            gc.restore();
            return;
        }

        // 品牌文字 Logo（id 形如 brand_LEICA）
        if (id != null && id.startsWith("brand_")) {
            String brand = id.substring("brand_".length());
            double fs = Math.max(10, size * 0.22);
            gc.setFont(Font.font("Arial", FontWeight.BOLD, fs));
            gc.setTextAlign(TextAlignment.CENTER);
            gc.setTextBaseline(VPos.CENTER);
            // 黑色光晕保证在浅色背景上可见
            gc.setEffect(new DropShadow(BlurType.GAUSSIAN, Color.rgb(0, 0, 0, 0.65), Math.max(3, size * 0.08), 0.4, 0, 0));
            gc.setFill(Color.WHITE);
            gc.fillText(brand, 0, 0);
            gc.restore();
            return;
        }

        // 内置矢量图标：黑色加粗光晕 + 白色主体，两遍绘制保证在浅色/深色背景上都清晰可见
        gc.setEffect(null);
        double lw = Math.max(1.5, size / 20);
        gc.setStroke(Color.rgb(0, 0, 0, 0.5));
        gc.setFill(Color.rgb(0, 0, 0, 0.5));
        gc.setLineWidth(lw * 2.4);
        drawShape(gc, shapeId(id), size);
        gc.setStroke(Color.WHITE);
        gc.setFill(Color.WHITE);
        gc.setLineWidth(lw);
        drawShape(gc, shapeId(id), size);
        gc.restore();
    }

    /** 放置到画布时 id 带有 _<nanoTime> 后缀，绘制前还原基础形状 id（brand_* 与图片路径已提前返回） */
    private static String shapeId(String id) {
        if (id == null) return "";
        int us = id.lastIndexOf('_');
        if (us > 0) {
            String suffix = id.substring(us + 1);
            if (!suffix.isEmpty() && suffix.chars().allMatch(Character::isDigit)) {
                return id.substring(0, us);
            }
        }
        return id;
    }

    /** 按 id 绘制图标形状（供黑白两遍绘制复用） */
    private static void drawShape(GraphicsContext gc, String id, double size) {
        switch (id) {
            case "lens" -> drawLens(gc, size);
            case "camera_body" -> drawCameraBody(gc, size);
            case "tripod" -> drawTripod(gc, size);
            case "shutter" -> drawShutter(gc, size);
            case "aperture" -> drawAperture(gc, size);
            case "star" -> drawStar(gc, size);
            case "film_perf" -> drawFilmPerf(gc, size);
            case "camera_line" -> drawCameraLine(gc, size);
            case "camera_circle" -> drawCameraCircle(gc, size);
            case "shutter_simple" -> drawShutterSimple(gc, size);
            case "moon" -> drawMoon(gc, size);
            case "sun" -> drawSun(gc, size);
            case "cloud" -> drawCloud(gc, size);
            case "star_weather" -> drawStarWeather(gc, size);
            case "mountain" -> drawMountain(gc, size);
            default -> {}
        }
    }

    private static void drawLens(GraphicsContext gc, double s) {
        gc.strokeOval(-s * 0.4, -s * 0.4, s * 0.8, s * 0.8);
        gc.strokeOval(-s * 0.25, -s * 0.25, s * 0.5, s * 0.5);
        gc.strokeLine(-s * 0.4, 0, s * 0.4, 0);
        gc.strokeLine(0, -s * 0.4, 0, s * 0.4);
    }

    private static void drawCameraBody(GraphicsContext gc, double s) {
        double w = s * 0.7, h = s * 0.5;
        gc.strokeRoundRect(-w / 2, -h / 2 + s * 0.05, w, h, s * 0.08, s * 0.08);
        gc.strokeRoundRect(-w * 0.25, -h / 2 - s * 0.05, w * 0.5, h * 0.3, s * 0.06, s * 0.06);
        gc.fillOval(-s * 0.06, -s * 0.01, s * 0.12, s * 0.12);
    }

    private static void drawTripod(GraphicsContext gc, double s) {
        gc.strokeLine(0, -s * 0.4, 0, s * 0.1);
        double leg = s * 0.28;
        gc.strokeLine(0, s * 0.1, -leg, s * 0.45);
        gc.strokeLine(0, s * 0.1, leg, s * 0.45);
        gc.strokeLine(0, s * 0.1, 0, s * 0.45);
        gc.strokeRect(-s * 0.08, -s * 0.45, s * 0.16, s * 0.08);
        gc.strokeOval(-s * 0.12, -s * 0.42, s * 0.24, s * 0.08);
    }

    private static void drawShutter(GraphicsContext gc, double s) {
        gc.strokeRect(-s * 0.3, -s * 0.08, s * 0.6, s * 0.16);
        double cx = 0;
        for (int i = 0; i < 3; i++) {
            double angle = i * Math.PI * 2 / 3 - Math.PI / 2;
            double sx = cx + Math.cos(angle) * s * 0.2;
            double sy = Math.sin(angle) * s * 0.2;
            gc.strokeLine(cx, 0, sx, sy);
        }
    }

    private static void drawAperture(GraphicsContext gc, double s) {
        gc.strokeOval(-s * 0.35, -s * 0.35, s * 0.7, s * 0.7);
        for (int i = 0; i < 7; i++) {
            double angle = i * Math.PI * 2 / 7;
            double x1 = Math.cos(angle) * s * 0.15;
            double y1 = Math.sin(angle) * s * 0.15;
            double x2 = Math.cos(angle) * s * 0.35;
            double y2 = Math.sin(angle) * s * 0.35;
            gc.strokeLine(x1, y1, x2, y2);
        }
    }

    private static void drawStar(GraphicsContext gc, double s) {
        double[] xp = new double[5], yp = new double[5];
        for (int i = 0; i < 5; i++) {
            double angle = i * Math.PI * 2 / 5 - Math.PI / 2;
            xp[i] = Math.cos(angle) * s * 0.4;
            yp[i] = Math.sin(angle) * s * 0.4;
        }
        gc.strokePolygon(xp, yp, 5);
        gc.strokeLine(xp[0], yp[0], xp[2], yp[2]);
        gc.strokeLine(xp[1], yp[1], xp[3], yp[3]);
        gc.strokeLine(xp[2], yp[2], xp[4], yp[4]);
        gc.strokeLine(xp[3], yp[3], xp[0], yp[0]);
        gc.strokeLine(xp[4], yp[4], xp[1], yp[1]);
    }

    private static void drawFilmPerf(GraphicsContext gc, double s) {
        double w = s * 0.7, h = s * 0.3;
        gc.strokeRoundRect(-w / 2, -h / 2, w, h, s * 0.04, s * 0.04);
        double perW = w / 6;
        for (int i = 0; i < 5; i++) {
            double px = -w / 2 + perW * (i + 1);
            gc.fillRoundRect(px - perW * 0.2, -h / 2 - s * 0.06, perW * 0.4, s * 0.06, 2, 2);
            gc.fillRoundRect(px - perW * 0.2, h / 2, perW * 0.4, s * 0.06, 2, 2);
        }
    }

    private static void drawCameraLine(GraphicsContext gc, double s) {
        double w = s * 0.6, h = s * 0.45;
        gc.strokeRoundRect(-w / 2, -h / 2, w, h, s * 0.06, s * 0.06);
        gc.strokeRoundRect(-w * 0.2, -h / 2 - s * 0.04, w * 0.4, h * 0.25, s * 0.04, s * 0.04);
        gc.fillOval(-s * 0.05, -s * 0.01, s * 0.1, s * 0.1);
    }

    private static void drawCameraCircle(GraphicsContext gc, double s) {
        gc.strokeOval(-s * 0.4, -s * 0.4, s * 0.8, s * 0.8);
        double w = s * 0.45, h = s * 0.35;
        gc.strokeRoundRect(-w / 2, -h / 2, w, h, s * 0.05, s * 0.05);
        gc.fillOval(-s * 0.04, -s * 0.01, s * 0.08, s * 0.08);
    }

    private static void drawShutterSimple(GraphicsContext gc, double s) {
        gc.setLineWidth(Math.max(2, s / 16));
        double cx = 0, cy = 0, r = s * 0.35;
        gc.strokeOval(cx - r, cy - r, r * 2, r * 2);
        for (int i = 0; i < 3; i++) {
            double angle = i * Math.PI * 2 / 3;
            gc.strokeLine(cx, cy, cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
        }
    }

    private static void drawMoon(GraphicsContext gc, double s) {
        gc.setFill(Color.rgb(255, 255, 200));
        gc.fillOval(-s * 0.35, -s * 0.35, s * 0.7, s * 0.7);
        gc.setFill(Color.rgb(60, 60, 70));
        gc.fillOval(-s * 0.15, -s * 0.3, s * 0.4, s * 0.4);
    }

    private static void drawSun(GraphicsContext gc, double s) {
        gc.setFill(Color.rgb(255, 220, 50));
        gc.fillOval(-s * 0.3, -s * 0.3, s * 0.6, s * 0.6);
        gc.setStroke(Color.rgb(255, 220, 50));
        gc.setLineWidth(Math.max(1.5, s / 24));
        for (int i = 0; i < 8; i++) {
            double angle = i * Math.PI / 4;
            double x1 = Math.cos(angle) * s * 0.35;
            double y1 = Math.sin(angle) * s * 0.35;
            double x2 = Math.cos(angle) * s * 0.48;
            double y2 = Math.sin(angle) * s * 0.48;
            gc.strokeLine(x1, y1, x2, y2);
        }
    }

    private static void drawCloud(GraphicsContext gc, double s) {
        gc.setFill(Color.rgb(220, 220, 240));
        gc.fillOval(-s * 0.2, -s * 0.1, s * 0.4, s * 0.35);
        gc.fillOval(-s * 0.35, s * 0.0, s * 0.7, s * 0.3);
        gc.fillOval(-s * 0.1, -s * 0.25, s * 0.35, s * 0.35);
        gc.fillOval(s * 0.1, -s * 0.2, s * 0.3, s * 0.3);
    }

    private static void drawStarWeather(GraphicsContext gc, double s) {
        gc.setFill(Color.rgb(255, 255, 200));
        double[] xp = new double[5], yp = new double[5];
        for (int i = 0; i < 5; i++) {
            double angle = i * Math.PI * 2 / 5 - Math.PI / 2;
            xp[i] = Math.cos(angle) * s * 0.4;
            yp[i] = Math.sin(angle) * s * 0.4;
        }
        gc.fillPolygon(xp, yp, 5);
    }

    private static void drawMountain(GraphicsContext gc, double s) {
        gc.setStroke(Color.rgb(180, 200, 220));
        gc.setLineWidth(Math.max(2, s / 16));
        gc.strokeLine(-s * 0.45, s * 0.35, -s * 0.1, -s * 0.3);
        gc.strokeLine(-s * 0.1, -s * 0.3, s * 0.15, s * 0.05);
        gc.strokeLine(s * 0.15, s * 0.05, s * 0.45, s * 0.15);
        gc.strokeLine(-s * 0.3, s * 0.35, -s * 0.05, -s * 0.15);
        gc.strokeLine(-s * 0.05, -s * 0.15, s * 0.25, s * 0.2);
        gc.strokeLine(s * 0.25, s * 0.2, s * 0.4, s * 0.25);
    }
}

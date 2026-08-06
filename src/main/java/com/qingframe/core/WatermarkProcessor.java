package com.qingframe.core;

import java.awt.*;
import java.awt.image.BufferedImage;
import java.text.SimpleDateFormat;
import java.util.Date;

public class WatermarkProcessor {

    private static volatile int rotation = 0;
    private static volatile int offsetX = 0;
    private static volatile int offsetY = 0;

    public static void setRotation(int v) { rotation = v; }
    public static int getRotation() { return rotation; }
    public static void setOffsetX(int v) { offsetX = v; }
    public static int getOffsetX() { return offsetX; }
    public static void setOffsetY(int v) { offsetY = v; }
    public static int getOffsetY() { return offsetY; }

    public static BufferedImage apply(BufferedImage src, String text, String fontName,
                                       int fontSize, Color color, double opacity,
                                       String position, boolean addDate, BufferedImage logo) {
        float alpha = (float) Math.min(1.0, Math.max(0.0, opacity));

        BufferedImage result = deepCopy(src);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);

        g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, alpha));

        if (rotation != 0 && text != null && !text.trim().isEmpty()) {
            g.rotate(Math.toRadians(rotation), result.getWidth() / 2.0, result.getHeight() / 2.0);
        }

        if (text != null && !text.trim().isEmpty()) {
            Font font = resolveFont(fontName, text, fontSize);
            g.setFont(font);
            g.setColor(color);
            FontMetrics fm = g.getFontMetrics();
            int textW = fm.stringWidth(text);
            int textH = fm.getHeight();
            int x = calcX(position, result.getWidth(), textW, 20) + offsetX;
            int y = calcY(position, result.getHeight(), textH, 20) + fm.getAscent() + offsetY;
            g.drawString(text, x, y);
        }

        if (addDate) {
            String dateStr = new SimpleDateFormat("yyyy.MM.dd HH:mm").format(new Date());
            int dateSize = Math.max(14, fontSize / 2);
            Font dateFont = resolveFont(fontName != null ? fontName : "SansSerif", dateStr, dateSize);
            g.setFont(dateFont);
            g.setColor(color);
            FontMetrics dfm = g.getFontMetrics();
            int dateW = dfm.stringWidth(dateStr);
            int dateX = result.getWidth() - dateW - 20 + offsetX;
            int dateY = result.getHeight() - 20 + offsetY;
            g.drawString(dateStr, dateX, dateY);
        }

        if (logo != null) {
            int logoW = Math.min(logo.getWidth(), result.getWidth() / 3);
            int logoH = logo.getHeight() * logoW / logo.getWidth();
            int logoX = 20 + offsetX;
            int logoY = result.getHeight() - logoH - 20 + offsetY;
            if (addDate) logoY -= dfmOffset(g, fontName);
            g.drawImage(logo, logoX, logoY, logoW, logoH, null);
        }

        g.dispose();
        return result;
    }

    private static int dfmOffset(Graphics2D g, String fontName) {
        Font f = new Font(fontName != null ? fontName : "SansSerif", Font.PLAIN, 14);
        return f.getSize() + 8;
    }

    private static int calcX(String position, int cw, int ew, int m) {
        int base = switch (position) {
            case "左上", "左中", "左下" -> m;
            case "右上", "右中", "右下" -> cw - ew - m;
            default -> (cw - ew) / 2;
        };
        return base;
    }

    private static int calcY(String position, int ch, int eh, int m) {
        return switch (position) {
            case "左上", "中上", "右上" -> m;
            case "左下", "中下", "右下" -> ch - eh - m;
            case "居中" -> (ch - eh) / 2;
            case "左中", "右中" -> (ch - eh) / 2;
            default -> ch - eh - m;
        };
    }

    private static BufferedImage deepCopy(BufferedImage src) {
        BufferedImage copy = new BufferedImage(src.getWidth(), src.getHeight(), BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = copy.createGraphics();
        g.drawImage(src, 0, 0, null);
        g.dispose();
        return copy;
    }

    private static Font resolveFont(String preferred, String text, int size) {
        Font f = new Font(preferred != null ? preferred : "SansSerif", Font.PLAIN, size);
        if (f.canDisplayUpTo(text) == -1) return f;
        String[] cjk = {"微软雅黑", "Microsoft YaHei", "宋体", "SimSun",
                "Noto Sans CJK SC", "Source Han Sans SC",
                "PingFang SC", "Hiragino Sans GB", "STHeiti"};
        for (String name : cjk) {
            Font ff = new Font(name, Font.PLAIN, size);
            if (ff.canDisplayUpTo(text) == -1) return ff;
        }
        return f;
    }
}

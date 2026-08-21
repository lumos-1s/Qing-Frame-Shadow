package com.qingframe.core;

import com.qingframe.model.GapCaption;
import com.qingframe.model.PuzzlrConfig;
import com.qingframe.model.SlotConfig;

import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.util.List;

/** 拼图 AWT 渲染：按布局坐标 + 每格图片/裁剪参数合成，白底 + 可调间距（gap 相对 4000 长边基准缩放） */
public class PuzzlrRenderer {
    public static final int GAP_BASE_EDGE = 4000;

    public static BufferedImage render(List<BufferedImage> images, PuzzlrConfig cfg, int outLongEdge) {
        double[][] rel = cfg.buildSlots();
        int n = rel.length;
        int W, H;
        double ratio = cfg.getCanvasRatio();
        if (ratio > 0) {
            // 指定画布比例：outLongEdge 为长边，格子相对坐标拉伸铺满
            if (ratio >= 1.0) {
                W = outLongEdge;
                H = Math.max(1, (int) Math.round(W / ratio));
            } else {
                H = outLongEdge;
                W = Math.max(1, (int) Math.round(H * ratio));
            }
        } else {
            double maxW = 0, maxH = 0;
            for (double[] r : rel) {
                maxW = Math.max(maxW, r[0] + r[2]);
                maxH = Math.max(maxH, r[1] + r[3]);
            }
            double scale = outLongEdge / Math.max(maxW, maxH);
            W = Math.max(1, (int) Math.round(maxW * scale));
            H = Math.max(1, (int) Math.round(maxH * scale));
        }
        int gap = Math.max(0, (int) Math.round(cfg.getGap() * outLongEdge / (double) GAP_BASE_EDGE));

        BufferedImage out = new BufferedImage(W, H, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
        g.setColor(parseColor(cfg.getBorderColor(), Color.WHITE));
        g.fillRect(0, 0, W, H);
        // 醒图式模糊照片背景：格子照片铺满画布后重度虚化
        if (cfg.getBgMode() == 1) {
            BufferedImage bg = buildBlurBackground(images, W, H);
            if (bg != null) g.drawImage(bg, 0, 0, null);
        }

        List<SlotConfig> slots = cfg.getSlots();
        for (int i = 0; i < n; i++) {
            double[] r = rel[i];
            int x = (int) Math.round(r[0] * W);
            int y = (int) Math.round(r[1] * H);
            int w = (int) Math.round(r[2] * W);
            int h = (int) Math.round(r[3] * H);
            int ix = x + gap / 2;
            int iy = y + gap / 2;
            int iw = w - gap;
            int ih = h - gap;
            if (iw <= 0 || ih <= 0) continue;
            BufferedImage img = i < images.size() ? images.get(i) : null;
            if (img == null) continue;
            SlotConfig s = slots.size() > i ? slots.get(i) : new SlotConfig();
            // 裁剪到本格矩形：图片任何情况下都不会溢出覆盖邻格或间隙
            java.awt.Shape oldClip = g.getClip();
            g.setClip(ix, iy, iw, ih);
            drawSlot(g, img, ix, iy, iw, ih, s);
            g.setClip(oldClip);
        }
        drawGapCaptions(g, cfg, W, H);
        g.dispose();
        return out;
    }

    /** 间隙电影字幕：横向间隙→水平字幕条，竖向间隙→竖排字幕条；两行可各自字体字号；超界自动等比缩小 */
    private static void drawGapCaptions(Graphics2D g, PuzzlrConfig cfg, int W, int H) {
        List<GapCaption> caps = cfg.getGapCaptions();
        if (caps == null || caps.isEmpty()) return;
        int[][] axes = PuzzlrConfig.axesOf(cfg.getLayoutType());
        double[] av = cfg.getAxisVals();
        double scaleF = Math.max(W, H) / (double) GAP_BASE_EDGE;
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON);
        for (GapCaption c : caps) {
            int[] axis = gapAxisOf(c.getGapId(), axes);
            if (axis == null) continue;
            String l1 = c.getTextContent() == null ? "" : c.getTextContent().trim();
            String l2 = c.getTextContent2() == null ? "" : c.getTextContent2().trim();
            if (l1.isEmpty() && l2.isEmpty()) continue;
            if (l1.isEmpty()) { l1 = l2; l2 = ""; }
            double pos = axis[1] < av.length ? av[axis[1]] : 0.5;
            float f1 = (float) Math.max(8, c.getFontSize() * scaleF);
            float f2 = l2.isEmpty() ? 0 : (float) Math.max(8, c.getFontSize2() * scaleF);
            Color color = parseColor(c.getColorHex(), Color.WHITE);
            int pad = Math.round(Math.max(f1, f2) * 0.35f);

            if (axis[0] == 1) {
                // 横向间隙：通栏水平字幕条
                Font ft1 = new Font(c.getFontFamily(), Font.PLAIN, Math.round(f1));
                Font ft2 = new Font(c.getFontFamily2(), Font.PLAIN, Math.round(f2));
                FontMetrics m1 = g.getFontMetrics(ft1);
                FontMetrics m2 = g.getFontMetrics(ft2);
                int w1 = m1.stringWidth(l1);
                int w2 = l2.isEmpty() ? 0 : m2.stringWidth(l2);
                // 超出画布宽度 → 两行等比缩小（保持大小差异）
                float shrink = 1f;
                int maxW = Math.max(w1, w2);
                if (maxW > W * 0.96f) shrink = (float) (W * 0.96) / maxW;
                if (shrink < 1f) {
                    f1 *= shrink;
                    f2 *= shrink;
                    ft1 = new Font(c.getFontFamily(), Font.PLAIN, Math.max(6, Math.round(f1)));
                    ft2 = new Font(c.getFontFamily2(), Font.PLAIN, Math.max(6, Math.round(f2)));
                    m1 = g.getFontMetrics(ft1);
                    m2 = g.getFontMetrics(ft2);
                    w1 = m1.stringWidth(l1);
                    w2 = l2.isEmpty() ? 0 : m2.stringWidth(l2);
                    pad = Math.round(Math.max(f1, f2) * 0.35f);
                }
                int lineGap = Math.round(Math.max(f1, f2) * (float) Math.max(0, c.getLineSpacing()));
                int totalH = m1.getHeight() + (l2.isEmpty() ? 0 : lineGap + m2.getHeight()) + pad * 2;
                int cy = (int) Math.round(pos * H);
                int barY = clampInt(cy - totalH / 2, 0, Math.max(0, H - totalH));
                if (c.isBgBar()) {
                    g.setColor(new Color(0, 0, 0, 145));
                    g.fillRect(0, barY, W, totalH);
                }
                g.setColor(color);
                g.setFont(ft1);
                g.drawString(l1, (W - w1) / 2, barY + pad + m1.getAscent());
                if (!l2.isEmpty()) {
                    g.setFont(ft2);
                    g.drawString(l2, (W - w2) / 2, barY + pad + m1.getHeight() + lineGap + m2.getAscent());
                }
            } else {
                // 竖向间隙：竖排逐字字幕条（第一行字接第二行字）
                float shrink = 1f;
                int vGap = l2.isEmpty() ? 0 : Math.round(Math.max(f1, f2) * (float) Math.max(0, c.getLineSpacing()));
                int step1 = Math.round(f1 * 1.15f);
                int step2 = l2.isEmpty() ? 0 : Math.round(f2 * 1.15f);
                int totalH = l1.length() * step1 + vGap + l2.length() * step2 + pad * 2;
                if (totalH > H * 0.96f) {
                    shrink = (float) (H * 0.96) / totalH;
                    f1 *= shrink;
                    f2 *= shrink;
                    vGap = l2.isEmpty() ? 0 : Math.round(Math.max(f1, f2) * (float) Math.max(0, c.getLineSpacing()));
                    step1 = Math.round(f1 * 1.15f);
                    step2 = l2.isEmpty() ? 0 : Math.round(f2 * 1.15f);
                    totalH = l1.length() * step1 + vGap + l2.length() * step2 + pad * 2;
                    pad = Math.round(Math.max(f1, f2) * 0.35f);
                }
                Font ft1 = new Font(c.getFontFamily(), Font.PLAIN, Math.max(6, Math.round(f1)));
                Font ft2 = new Font(c.getFontFamily2(), Font.PLAIN, Math.max(6, Math.round(f2)));
                int barW = Math.round(Math.max(f1, f2) * 1.4f) + pad * 2;
                int cx = (int) Math.round(pos * W);
                int barX = clampInt(cx - barW / 2, 0, Math.max(0, W - barW));
                if (c.isBgBar()) {
                    g.setColor(new Color(0, 0, 0, 145));
                    g.fillRect(barX, 0, barW, H);
                }
                g.setColor(color);
                int y = clampInt((H - totalH) / 2 + pad, pad, Math.max(pad, H - pad));
                g.setFont(ft1);
                for (char ch : l1.toCharArray()) {
                    String cs = String.valueOf(ch);
                    g.drawString(cs, cx - g.getFontMetrics().stringWidth(cs) / 2, y + g.getFontMetrics().getAscent());
                    y += step1;
                }
                if (!l2.isEmpty()) {
                    y += vGap;
                    g.setFont(ft2);
                    for (char ch : l2.toCharArray()) {
                        String cs = String.valueOf(ch);
                        g.drawString(cs, cx - g.getFontMetrics().stringWidth(cs) / 2, y + g.getFontMetrics().getAscent());
                        y += step2;
                    }
                }
            }
        }
    }

    /** gapId → 对应轴 [type,index]；布局切换后该轴不存在返回 null（字幕随之失效/删除） */
    public static int[] gapAxisOf(String gapId, int[][] axes) {
        if (gapId == null || gapId.length() < 2) return null;
        int type = gapId.charAt(0) == 'H' ? 1 : 0;
        int idx;
        try {
            idx = Integer.parseInt(gapId.substring(1));
        } catch (NumberFormatException e) {
            return null;
        }
        if (idx < 0 || idx >= axes.length || axes[idx][0] != type) return null;
        return new int[]{type, idx};
    }

    /** 醒图式模糊背景：把各格照片按网格 cover 铺满画布 → 缩到极小再放大（重度虚化、色彩融合） */
    private static BufferedImage buildBlurBackground(List<BufferedImage> images, int W, int H) {
        List<BufferedImage> valid = new java.util.ArrayList<>();
        for (BufferedImage im : images) if (im != null) valid.add(im);
        if (valid.isEmpty()) return null;
        // 极小画布：每格照片占一格，cover 填充
        int tw = Math.max(6, Math.min(48, W / 64));
        int th = Math.max(6, Math.min(48, H / 64));
        BufferedImage tiny = new BufferedImage(tw, th, BufferedImage.TYPE_INT_RGB);
        Graphics2D tg = tiny.createGraphics();
        tg.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        int cols = (int) Math.ceil(Math.sqrt(valid.size()));
        int rows = (int) Math.ceil((double) valid.size() / cols);
        for (int k = 0; k < valid.size(); k++) {
            int cx = (k % cols) * tw / cols;
            int cy = (k / cols) * th / rows;
            int cwid = (k % cols == cols - 1) ? tw - cx : tw / cols;
            int chei = (k / cols == rows - 1) ? th - cy : th / rows;
            if (cwid <= 0 || chei <= 0) continue;
            BufferedImage im = valid.get(k);
            double s = Math.max(cwid / (double) im.getWidth(), chei / (double) im.getHeight());
            int dw = (int) Math.ceil(im.getWidth() * s);
            int dh = (int) Math.ceil(im.getHeight() * s);
            tg.drawImage(im, cx - (dw - cwid) / 2, cy - (dh - chei) / 2, dw, dh, null);
        }
        tg.dispose();
        // 放大回原尺寸：双线性重采样即重度模糊
        BufferedImage bg = new BufferedImage(W, H, BufferedImage.TYPE_INT_RGB);
        Graphics2D bgg = bg.createGraphics();
        bgg.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        bgg.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        bgg.drawImage(tiny, 0, 0, W, H, null);
        bgg.dispose();
        return bg;
    }
    /** 单格绘制：fill（裁切填满）或 fit（完整包含），再叠加格内偏移与缩放。
     *  cover 模式钳制偏移保证图片始终铺满格子，杜绝边缘白缝。 */
    private static void drawSlot(Graphics2D g, BufferedImage img, int x, int y, int w, int h, SlotConfig s) {
        double sx = (double) w / img.getWidth();
        double sy = (double) h / img.getHeight();
        double scale;
        if (s.getFillMode() == 1) {
            scale = Math.min(sx, sy);
        } else {
            scale = Math.max(sx, sy);
        }
        scale *= s.getZoom();
        int dw = (int) Math.round(img.getWidth() * scale);
        int dh = (int) Math.round(img.getHeight() * scale);
        int dx = x + (int) Math.round((w - dw) * s.getOffsetX());
        int dy = y + (int) Math.round((h - dh) * s.getOffsetY());
        if (s.getFillMode() != 1) {
            // cover：偏移钳制在 [x-(dw-w), x]，保证覆盖整个格子
            if (dw > w) dx = clampInt(dx, x - (dw - w), x); else dx = x + ((w - dw) >> 1);
            if (dh > h) dy = clampInt(dy, y - (dh - h), y); else dy = y + ((h - dh) >> 1);
        }
        g.drawImage(img, dx, dy, dw, dh, null);
    }

    private static int clampInt(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    /** 解析 #RRGGBB 颜色，失败回退默认色 */
    private static Color parseColor(String hex, Color def) {
        try {
            return Color.decode(hex == null ? "" : hex.trim());
        } catch (Exception e) {
            return def;
        }
    }
}
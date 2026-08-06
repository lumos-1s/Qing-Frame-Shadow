package com.qingframe.core;

import java.awt.*;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;
import java.util.ArrayList;

public class WatermarkRender {

    public enum Position { LEFT, CENTER, RIGHT, SPLIT }

    private static volatile Position currentPosition = Position.CENTER;
    private static volatile double maskOpacity = 1.0;

    public static void setPosition(Position p) { currentPosition = p; }
    public static Position getPosition() { return currentPosition; }
    public static void setMaskOpacity(double v) { maskOpacity = Math.max(0, Math.min(1, v)); }
    public static double getMaskOpacity() { return maskOpacity; }

    public static void drawParamMask(Graphics2D g, BufferedImage fullImage,
                                      String brand, String model, String focal,
                                      String aperture, String iso, String shutter) {
        drawParamMask(g, fullImage, brand, model, focal, aperture, iso, shutter, currentPosition);
    }

    private static void drawParamMask(Graphics2D g, BufferedImage fullImage,
                                       String brand, String model, String focal,
                                       String aperture, String iso, String shutter,
                                       Position pos) {
        java.util.List<String> lines = new ArrayList<>();
        if (brand != null && !brand.isEmpty()) lines.add(brand);
        if (model != null && !model.isEmpty()) lines.add(model);
        if (focal != null && !focal.isEmpty()) lines.add(focal);
        if (aperture != null && !aperture.isEmpty()) lines.add(aperture);
        if (iso != null && !iso.isEmpty()) lines.add(iso);
        if (shutter != null && !shutter.isEmpty()) lines.add(shutter);
        if (lines.isEmpty()) return;

        if (pos == Position.SPLIT) {
            int mid = lines.size() / 2;
            java.util.List<String> leftLines = new ArrayList<>(lines.subList(0, mid));
            java.util.List<String> rightLines = new ArrayList<>(lines.subList(mid, lines.size()));
            drawSingleMask(g, fullImage, leftLines, Position.LEFT);
            drawSingleMask(g, fullImage, rightLines, Position.RIGHT);
            return;
        }
        drawSingleMask(g, fullImage, lines, pos);
    }

    private static Rectangle calcBounds(java.util.List<String> lines, FontMetrics fm, int containerW, int containerH, Position pos) {
        int maxW = 0;
        for (String line : lines) maxW = Math.max(maxW, fm.stringWidth(line));

        int lineH = fm.getHeight();
        int maskW = maxW + GlobalBorderConstant.PARAM_MASK_PADDING_X * 2;
        int maskH = lines.size() * lineH + (lines.size() - 1) * GlobalBorderConstant.PARAM_TEXT_LINE_SPACE
                + GlobalBorderConstant.PARAM_MASK_PADDING_Y * 2;

        int x, y = (containerH - maskH) / 2;
        switch (pos) {
            case LEFT, CENTER -> x = GlobalBorderConstant.PARAM_MASK_PADDING_X;
            case RIGHT -> x = containerW - maskW - GlobalBorderConstant.PARAM_MASK_PADDING_X;
            default -> x = GlobalBorderConstant.PARAM_MASK_PADDING_X;
        }
        return new Rectangle(x, y, maskW, maskH);
    }

    private static void drawSingleMask(Graphics2D g, BufferedImage fullImage,
                                        java.util.List<String> lines, Position pos) {
        int cw = fullImage.getWidth(), ch = fullImage.getHeight();
        int fs = Math.max(11, BorderProcessor.getExifFontSize());
        Font font = new Font("Monospaced", Font.PLAIN, fs);
        g.setFont(font);
        FontMetrics fm = g.getFontMetrics();

        Rectangle bounds = calcBounds(lines, fm, cw, ch, pos);
        int mx = bounds.x, my = bounds.y, mw = bounds.width, mh = bounds.height;

        mx = Math.max(0, mx); my = Math.max(0, my);
        mw = Math.min(cw - mx, mw); mh = Math.min(ch - my, mh);
        if (mw <= 0 || mh <= 0) return;

        int sx = Math.min(mx, cw - 1), sy = Math.min(my, ch - 1);
        int sw = Math.min(mw, cw - sx), sh = Math.min(mh, ch - sy);
        if (sw <= 0 || sh <= 0) return;
        BufferedImage sub = fullImage.getSubimage(sx, sy, sw, sh);
        BufferedImage blurred = BorderProcessor.fastBlur(sub, Math.max(8, fs / 2));

        g.drawImage(blurred, mx, my, mw, mh, null);

        float alpha = (float) (GlobalBorderConstant.PARAM_MASK_ALPHA_BASE * maskOpacity);
        alpha = Math.min(0.7f, Math.max(0.05f, alpha));
        g.setColor(new Color(0, 0, 0, (int)(alpha * 255)));
        g.fillRoundRect(mx, my, mw, mh, GlobalBorderConstant.PARAM_MASK_RADIUS, GlobalBorderConstant.PARAM_MASK_RADIUS);

        Shape savedClip = g.getClip();
        g.setClip(new RoundRectangle2D.Float(mx, my, mw, mh,
                GlobalBorderConstant.PARAM_MASK_RADIUS, GlobalBorderConstant.PARAM_MASK_RADIUS));

        g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, 1f));
        g.setColor(Color.WHITE);
        int lineH = fm.getHeight();
        int textY = my + GlobalBorderConstant.PARAM_MASK_PADDING_Y + fm.getAscent();
        for (String line : lines) {
            g.drawString(line, mx + GlobalBorderConstant.PARAM_MASK_PADDING_X, textY);
            textY += lineH + GlobalBorderConstant.PARAM_TEXT_LINE_SPACE;
        }

        g.setClip(savedClip);
        g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, 1f));
    }
}

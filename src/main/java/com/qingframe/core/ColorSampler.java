package com.qingframe.core;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;

public class ColorSampler {

    public static Color sampleEdgeColor(BufferedImage img) {
        int w = img.getWidth(), h = img.getHeight();
        int scale = Math.max(1, Math.max(w, h) / 64);
        int sw = w / scale, sh = h / scale;
        BufferedImage small = new BufferedImage(sw, sh, BufferedImage.TYPE_INT_ARGB);
        Graphics2D sg = small.createGraphics();
        sg.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        sg.drawImage(img, 0, 0, sw, sh, null);
        sg.dispose();

        int stripW = Math.max(1, sw / 10);
        int stripH = Math.max(1, sh / 10);
        long r = 0, g = 0, b = 0, n = 0;

        for (int x = 0; x < sw; x++) {
            for (int y = 0; y < stripH; y++) {
                int argb = small.getRGB(x, y);
                r += (argb >> 16) & 0xFF;
                g += (argb >> 8) & 0xFF;
                b += argb & 0xFF;
                n++;
            }
        }
        for (int x = 0; x < sw; x++) {
            for (int y = sh - stripH; y < sh; y++) {
                int argb = small.getRGB(x, y);
                r += (argb >> 16) & 0xFF;
                g += (argb >> 8) & 0xFF;
                b += argb & 0xFF;
                n++;
            }
        }
        for (int y = stripH; y < sh - stripH; y++) {
            for (int x = 0; x < stripW; x++) {
                int argb = small.getRGB(x, y);
                r += (argb >> 16) & 0xFF;
                g += (argb >> 8) & 0xFF;
                b += argb & 0xFF;
                n++;
            }
            for (int x = sw - stripW; x < sw; x++) {
                int argb = small.getRGB(x, y);
                r += (argb >> 16) & 0xFF;
                g += (argb >> 8) & 0xFF;
                b += argb & 0xFF;
                n++;
            }
        }

        if (n == 0) return new Color(100, 120, 140);
        return new Color((int) (r / n), (int) (g / n), (int) (b / n));
    }

    public static Color sampleBottomDarkColor(BufferedImage img) {
        int w = img.getWidth(), h = img.getHeight();
        int scale = Math.max(1, Math.max(w, h) / 64);
        int sw = w / scale, sh = h / scale;
        BufferedImage small = new BufferedImage(sw, sh, BufferedImage.TYPE_INT_ARGB);
        Graphics2D sg = small.createGraphics();
        sg.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        sg.drawImage(img, 0, 0, sw, sh, null);
        sg.dispose();

        int stripH = Math.max(1, sh / 5);
        long r = 0, g = 0, b = 0, n = 0;
        for (int y = sh - stripH; y < sh; y++) {
            for (int x = 0; x < sw; x++) {
                int argb = small.getRGB(x, y);
                int red = (argb >> 16) & 0xFF;
                int green = (argb >> 8) & 0xFF;
                int blue = argb & 0xFF;
                int lum = (red + green + blue) / 3;
                if (lum < 128) {
                    r += red;
                    g += green;
                    b += blue;
                    n++;
                }
            }
        }
        if (n == 0) return new Color(25, 25, 30);
        return new Color((int) (r / n), (int) (g / n), (int) (b / n));
    }
}

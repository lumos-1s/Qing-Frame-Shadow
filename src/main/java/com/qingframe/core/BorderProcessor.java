package com.qingframe.core;

import java.awt.*;
import java.awt.font.TextAttribute;
import java.awt.geom.Path2D;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;
import java.awt.image.ConvolveOp;
import java.awt.image.Kernel;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;

public class BorderProcessor {

    /** 高斯卷积算子缓存：key 为卷积核边长 kSize（由模糊半径唯一决定） */
    private static final Map<Integer, ConvolveOp> CONVOLVE_OP_CACHE = new ConcurrentHashMap<>();

    public enum Style {
        NONE, SIMPLE, POLAROID, FILM_STRIP, ROUNDED, DOUBLE_LINE, VINTAGE, GRADIENT, DROP_SHADOW,
        BLUR_CLASSIC, BLUR_DATE,
        WM_CLASSIC, WM_SINGLE, WM_BRAND_LOGO,
        IMP_FROSTED, IMP_CLASSIC, XIAOMI_IMP,
        CARD_LEICA, CARD_LOGO_PARAM, CARD_PURE_LOGO, CARD_SIMPLE, CARD_IMMERSION,
        COLOR_CLASSIC, COLOR_REFINED, ART_CARD,
        WHITE_PLAIN, FUJI_WHITE,
        PARAM_TOP_LEFT, PARAM_BOTTOM_LEFT, PARAM_BOTTOM_SINGLE, SIMPLE_FILM
    }

    public static BufferedImage apply(Style style, BufferedImage src, int size) {
        if (src == null) return null;
        int scaled = Math.max(5, (int) (size * 2.0));
        double ref = Math.min(src.getWidth(), src.getHeight());
        scaled = Math.max(5, (int) (scaled * ref / 1000.0));
        try {
            BufferedImage result = switch (style) {
                case NONE -> src;
                case SIMPLE -> addSimpleBorder(src, scaled);
                case POLAROID -> addPolaroid(src, scaled);
                case FILM_STRIP -> addFilmStrip(src, scaled);
                case ROUNDED -> addRounded(src, scaled);
                case DOUBLE_LINE -> addDoubleLine(src, scaled);
                case VINTAGE -> addVintage(src, scaled);
                case GRADIENT -> addGradient(src, scaled);
                case DROP_SHADOW -> addDropShadow(src, scaled);
                case CARD_LEICA -> addCardLeica(src, scaled);
                case FUJI_WHITE -> addFujiWhite(src, scaled);
                case XIAOMI_IMP -> addXiaomiImp(src, scaled);
                case ART_CARD -> addArtCard(src, scaled);
                case SIMPLE_FILM -> addSimpleFilm(src, scaled);

                case BLUR_CLASSIC -> addBlurClassic(src, scaled);
                case BLUR_DATE -> addBlurDate(src, scaled);
                case WM_CLASSIC -> addWmClassic(src, scaled);
                case WM_SINGLE -> addWmSingle(src, scaled);
                case WM_BRAND_LOGO -> addWmBrandLogo(src, scaled);
                case IMP_FROSTED -> addImpFrosted(src, scaled);
                case IMP_CLASSIC -> addImpClassic(src, scaled);
                case CARD_LOGO_PARAM -> addCardLogoParam(src, scaled);
                case CARD_PURE_LOGO -> addCardPureLogo(src, scaled);
                case CARD_SIMPLE -> addCardSimple(src, scaled);
                case CARD_IMMERSION -> addCardImmersion(src, scaled);
                case COLOR_CLASSIC -> addColorClassic(src, scaled);
                case COLOR_REFINED -> addColorRefined(src, scaled);
                case WHITE_PLAIN -> addWhitePlain(src, scaled);
                case PARAM_TOP_LEFT -> addParamTopLeft(src, scaled);
                case PARAM_BOTTOM_LEFT -> addParamBottomLeft(src, scaled);
                case PARAM_BOTTOM_SINGLE -> addParamBottomSingle(src, scaled);
            };
            if (result != null) {
                boolean useIndividual = switch (style) {
                    case ROUNDED -> true;
                    default -> false;
                };
                if (useIndividual && (cornerTl > 0 || cornerTr > 0 || cornerBl > 0 || cornerBr > 0)) {
                    result = applyCornerRadius(result, cornerTl, cornerTr, cornerBl, cornerBr);
                } else if (cornerRadius > 0) {
                    // 背景模糊边框保持最初的样式：照片本身圆角，模糊背景不做整图裁角
                    boolean blurStyle = switch (style) {
                        case BLUR_CLASSIC, BLUR_DATE -> true;
                        default -> false;
                    };
                    if (!blurStyle) {
                        result = applyCornerRadius(result, cornerRadius);
                    }
                }
            }
            return result;
        } catch (Exception e) {
            System.err.println("[BorderProcessor] render error: " + e.getMessage());
            return src;
        }
    }

    private static BufferedImage applyCornerRadius(BufferedImage src, int radius) {
        int w = src.getWidth(), h = src.getHeight();
        if (w <= 0 || h <= 0) return src;
        int r = Math.min(radius, Math.min(w, h) / 2);
        if (r <= 0) return src;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setClip(new RoundRectangle2D.Float(0, 0, w, h, r, r));
        g.drawImage(src, 0, 0, null);
        g.dispose();
        return result;
    }

    private static BufferedImage applyCornerRadius(BufferedImage src, int tl, int tr, int bl, int br) {
        int w = src.getWidth(), h = src.getHeight();
        if (w <= 0 || h <= 0) return src;
        int maxR = Math.min(w, h) / 2;
        tl = Math.min(tl, maxR); tr = Math.min(tr, maxR);
        bl = Math.min(bl, maxR); br = Math.min(br, maxR);
        if (tl <= 0 && tr <= 0 && bl <= 0 && br <= 0) return src;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        Path2D.Float path = new Path2D.Float();
        path.moveTo(tl, 0);
        path.lineTo(w - tr, 0);
        if (tr > 0) path.quadTo(w, 0, w, tr);
        else path.lineTo(w, 0);
        path.lineTo(w, h - br);
        if (br > 0) path.quadTo(w, h, w - br, h);
        else path.lineTo(w, h);
        path.lineTo(bl, h);
        if (bl > 0) path.quadTo(0, h, 0, h - bl);
        else path.lineTo(0, h);
        path.lineTo(0, tl);
        if (tl > 0) path.quadTo(0, 0, tl, 0);
        else path.lineTo(0, 0);
        path.closePath();
        g.setClip(path);
        g.drawImage(src, 0, 0, null);
        g.dispose();
        return result;
    }

    public static void cleanupRenderResources() {}

    /** 像素常量按导出降级比例缩放（blurScale=1 时为原值，预览不受影响） */
    private static int scaledPx(int px) {
        return (int) Math.round(px * blurScale);
    }

    /** 加载用户选择的背景图（带缓存），未设置或加载失败返回 null */
    private static BufferedImage loadBgImage() {
        if (bgImagePath == null || bgImagePath.isEmpty()) return null;
        if (cachedBgImage != null && bgImagePath.equals(cachedBgImagePath)) return cachedBgImage;
        try {
            java.io.File f = new java.io.File(bgImagePath);
            if (!f.exists()) return null;
            cachedBgImage = javax.imageio.ImageIO.read(f);
            cachedBgImagePath = bgImagePath;
            return cachedBgImage;
        } catch (Exception e) {
            cachedBgImage = null;
            cachedBgImagePath = "";
            return null;
        }
    }

    /** 模糊半径随导出比例缩放，保证降级导出时背景模糊强度与预览一致 */
    private static int scaledBlurRadius() {
        return Math.max(6, (int) Math.round((50 + blurIntensity / 2.0) * blurScale));
    }

    private static volatile ExifReader.ExifData currentExif;
    private static volatile boolean useExifEnabled = true;
    private static volatile String manualLogoBrand;
    private static volatile int exifFontSize = 35;
    private static volatile int cornerRadius = 30;
    private static volatile int blurIntensity = 50;
    /** 导出降级缩放系数：让模糊半径/边距/文字间距等像素参数随照片尺寸同比缩放，保证导出与预览一致 */
    private static volatile double blurScale = 1.0;
    private static volatile int logoSize = 14;
    private static volatile java.awt.Color logoColor = java.awt.Color.WHITE;
    private static volatile int paramType = 0;
    private static volatile int shadowSize = 0;
    private static volatile int shadowDepth = 30;
    private static volatile java.awt.Color shadowColor = new java.awt.Color(0, 0, 0, 80);

    public static void setExifData(ExifReader.ExifData data) { currentExif = data; }
    public static ExifReader.ExifData getCurrentExif() { return currentExif; }
    public static void setUseExifEnabled(boolean enabled) { useExifEnabled = enabled; }
    public static void clearExifData() { currentExif = null; }
    public static void setManualLogoBrand(String brand) { manualLogoBrand = brand; }
    public static String getManualLogoBrand() { return manualLogoBrand; }
    public static void setExifFontSize(int size) { exifFontSize = Math.max(2, Math.min(160, size)); }
    public static int getExifFontSize() { return exifFontSize; }
    public static void setCornerRadius(int v) {
        v = Math.max(0, Math.min(500, v));
        cornerRadius = v;
        cornerTl = cornerTr = cornerBl = cornerBr = v;
    }
    public static int getCornerRadius() { return cornerRadius; }
    private static volatile int cornerTl = 30, cornerTr = 30, cornerBl = 30, cornerBr = 30;
    public static void setCornerIndividual(String key, int v) {
        v = Math.max(0, Math.min(500, v));
        switch (key) {
            case "cornerTl" -> cornerTl = v;
            case "cornerTr" -> cornerTr = v;
            case "cornerBl" -> cornerBl = v;
            case "cornerBr" -> cornerBr = v;
        }
    }
    public static int getCornerTl() { return cornerTl; }
    public static int getCornerTr() { return cornerTr; }
    public static int getCornerBl() { return cornerBl; }
    public static int getCornerBr() { return cornerBr; }
    private static int[] getFourCorners() {
        return new int[]{cornerTl, cornerTr, cornerBl, cornerBr};
    }
    public static void setBlurIntensity(int v) { blurIntensity = Math.max(0, Math.min(100, v)); }
    public static int getBlurIntensity() { return blurIntensity; }
    public static void setBlurScale(double s) { blurScale = Math.max(0.05, Math.min(1.0, s)); }
    public static double getBlurScale() { return blurScale; }
    public static void setLogoSize(int v) { logoSize = Math.max(6, Math.min(60, v)); }
    public static int getLogoSize() { return logoSize; }
    public static void setLogoColor(java.awt.Color c) { logoColor = c; }
    public static java.awt.Color getLogoColor() { return logoColor; }
    public static void setParamType(int v) { paramType = Math.max(0, Math.min(2, v)); }
    public static int getParamType() { return paramType; }
    public static void setShadowSize(int v) { shadowSize = Math.max(0, Math.min(80, v)); }
    public static int getShadowSize() { return shadowSize; }
    public static void setShadowDepth(int v) { shadowDepth = Math.max(0, Math.min(100, v)); }
    public static int getShadowDepth() { return shadowDepth; }
    public static void setShadowColor(java.awt.Color c) { shadowColor = c; }
    public static java.awt.Color getShadowColor() { return shadowColor; }

    private static volatile String aspectRatio = "原始比例";
    private static volatile String gradientDirection = "左右渐变";
    private static volatile String cornerDecoration = "无";
    private static volatile int cornerDecoSize = 30;
    private static volatile int cornerDecoOpacity = 80;
    private static volatile String bgImagePath = "";
    private static volatile BufferedImage cachedBgImage;
    private static volatile String cachedBgImagePath = "";
    private static volatile int bgImageBlur = 30;
    private static volatile int fileSizeLimitMB = 0;

    public static void setAspectRatio(String v) { aspectRatio = v; }
    public static String getAspectRatio() { return aspectRatio; }
    public static void setGradientDirection(String v) { gradientDirection = v; }
    public static String getGradientDirection() { return gradientDirection; }
    public static void setCornerDecoration(String v) { cornerDecoration = v; }
    public static String getCornerDecoration() { return cornerDecoration; }
    public static void setCornerDecoSize(int v) { cornerDecoSize = Math.max(0, Math.min(100, v)); }
    public static int getCornerDecoSize() { return cornerDecoSize; }
    public static void setCornerDecoOpacity(int v) { cornerDecoOpacity = Math.max(0, Math.min(100, v)); }
    public static int getCornerDecoOpacity() { return cornerDecoOpacity; }
    public static void setBgImagePath(String v) {
        bgImagePath = v == null ? "" : v;
        cachedBgImage = null;
        cachedBgImagePath = "";
    }
    public static String getBgImagePath() { return bgImagePath; }
    public static void setBgImageBlur(int v) { bgImageBlur = Math.max(0, Math.min(100, v)); }
    public static int getBgImageBlur() { return bgImageBlur; }
    public static void setFileSizeLimitMB(int v) { fileSizeLimitMB = v; }
    public static int getFileSizeLimitMB() { return fileSizeLimitMB; }

    private static class CameraSpec {
        String brand, model, focal, aperture, iso, shutter;
        CameraSpec(String b, String m, String f, String a, String i, String s) {
            brand = b; model = m; focal = f; aperture = a; iso = i; shutter = s;
        }
    }

    private static CameraSpec cameraFor(BufferedImage src, Style style) {
        String brandOverride = manualLogoBrand;
        if (useExifEnabled && currentExif != null && currentExif.hasData()) {
            String b = currentExif.brand();
            String m = currentExif.cleanModel();
            String f = !currentExif.focalLength.isEmpty() ? currentExif.focalLength : "50mm";
            String a = !currentExif.aperture.isEmpty()  ? currentExif.aperture  : "f/2.8";
            String i = !currentExif.iso.isEmpty()       ? currentExif.iso       : "ISO 400";
            String s = !currentExif.shutter.isEmpty()   ? currentExif.shutter   : "1/125";
            if (style == Style.SIMPLE_FILM || style == Style.PARAM_BOTTOM_SINGLE) {
                return new CameraSpec("", "", f, a, "", "");
            }
            if (b.isEmpty() && m.isEmpty()) b = "CAMERA";
            if (m.isEmpty() && !b.isEmpty()) {
                CameraSpec fallback = fallbackCamera(b, style);
                if (fallback != null) m = fallback.model;
            }
            if (brandOverride != null && !brandOverride.isEmpty()) b = brandOverride;
            return new CameraSpec(b, m, f, a, i, s);
        }
        long seed = (long) src.getWidth() * 313 + src.getHeight() * 997 + style.ordinal();
        Random rnd = new Random(seed);
        String[] focals = {"24mm", "28mm", "35mm", "50mm", "85mm", "135mm", "200mm"};
        String[] apertures = {"f/1.4", "f/2.0", "f/2.8", "f/4.0", "f/5.6", "f/8.0", "f/11"};
        String[] isos = {"ISO 100", "ISO 200", "ISO 400", "ISO 800", "ISO 1600", "ISO 3200"};
        String[] shutters = {"1/60", "1/125", "1/250", "1/500", "1/1000", "1/2000", "1/4000"};
        CameraSpec result = switch (style) {
            case CARD_LEICA, CARD_LOGO_PARAM, CARD_IMMERSION -> new CameraSpec("LEICA", "M10-P",
                    focals[rnd.nextInt(focals.length)], apertures[rnd.nextInt(apertures.length)],
                    isos[rnd.nextInt(isos.length)], shutters[rnd.nextInt(shutters.length)]);
            case FUJI_WHITE -> new CameraSpec("FUJIFILM", "X-T5",
                    focals[rnd.nextInt(focals.length)], apertures[rnd.nextInt(apertures.length)],
                    isos[rnd.nextInt(isos.length)], shutters[rnd.nextInt(shutters.length)]);
            case XIAOMI_IMP, IMP_FROSTED, IMP_CLASSIC -> new CameraSpec("XIAOMI", "14 Ultra",
                    focals[rnd.nextInt(focals.length)], apertures[rnd.nextInt(apertures.length)],
                    isos[rnd.nextInt(isos.length)], shutters[rnd.nextInt(shutters.length)]);
            case ART_CARD, COLOR_CLASSIC, COLOR_REFINED -> new CameraSpec("GFX", "100S",
                    focals[rnd.nextInt(focals.length)], apertures[rnd.nextInt(apertures.length)],
                    isos[rnd.nextInt(isos.length)], shutters[rnd.nextInt(shutters.length)]);
            case WM_CLASSIC, WM_SINGLE, WM_BRAND_LOGO, BLUR_CLASSIC, BLUR_DATE -> new CameraSpec("SONY", "A7 IV",
                    focals[rnd.nextInt(focals.length)], apertures[rnd.nextInt(apertures.length)],
                    isos[rnd.nextInt(isos.length)], shutters[rnd.nextInt(shutters.length)]);
            case CARD_PURE_LOGO -> new CameraSpec("LEICA", "Q3",
                    focals[rnd.nextInt(focals.length)], apertures[rnd.nextInt(apertures.length)],
                    isos[rnd.nextInt(isos.length)], shutters[rnd.nextInt(shutters.length)]);
            case CARD_SIMPLE, PARAM_TOP_LEFT, PARAM_BOTTOM_LEFT -> new CameraSpec("CANON", "EOS R5",
                    focals[rnd.nextInt(focals.length)], apertures[rnd.nextInt(apertures.length)],
                    isos[rnd.nextInt(isos.length)], shutters[rnd.nextInt(shutters.length)]);
            case SIMPLE_FILM, PARAM_BOTTOM_SINGLE -> new CameraSpec("", "",
                    focals[rnd.nextInt(focals.length)], apertures[rnd.nextInt(apertures.length)], "", "");
            default -> new CameraSpec("", "", "", "", "", "");
        };
        if (brandOverride != null && !result.brand.isEmpty()) {
            result = new CameraSpec(brandOverride, result.model, result.focal, result.aperture, result.iso, result.shutter);
        }
        return result;
    }

    private static CameraSpec fallbackCamera(String brand, Style style) {
        String model = CameraDatabase.getInstance().fallbackModel(brand);
        if (!model.isEmpty()) {
            return new CameraSpec(brand, model, "50mm", "f/2.8", "ISO 400", "1/125");
        }
        return null;
    }

    private static void drawText(Graphics2D g, String text, int x, int y, Font font, Color color) {
        g.setFont(font);
        g.setColor(color);
        g.drawString(text, x, y);
    }

    private static int centerX(int canvasW, int textW) { return (canvasW - textW) / 2; }

    private static Font fontSans(int style, int size) { return new Font("SansSerif", style, size); }
    private static Font fontMono(int style, int size) { return new Font("Monospaced", style, size); }

    private static void drawBrandLogo(Graphics2D g, String brand, int x, int y, Font font) {
        if (LogoManager.hasCustom()) {
            BufferedImage logo = LogoManager.get();
            int targetH = font.getSize() * 3 / 2;
            double sc = (double) targetH / logo.getHeight();
            int lw = (int) (logo.getWidth() * sc);
            g.drawImage(logo, x, y - targetH, lw, targetH, null);
            return;
        }
        LogoResource.draw(g, brand, x, y, font);
    }

    private static int brandLogoWidth(String brand, Font font) {
        if (LogoManager.hasCustom()) {
            BufferedImage logo = LogoManager.get();
            int targetH = font.getSize() * 3 / 2;
            double sc = (double) targetH / logo.getHeight();
            return (int) (logo.getWidth() * sc);
        }
        return LogoResource.width(brand, font);
    }

    private static BufferedImage createBlurBacking(BufferedImage src, int size, int blurMargin, int blurBottom) {
        int bw = src.getWidth() + blurMargin * 2;
        int bh = src.getHeight() + blurMargin + blurBottom;

        BufferedImage temp = new BufferedImage(bw, bh, BufferedImage.TYPE_INT_ARGB);
        Graphics2D tg = temp.createGraphics();
        tg.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);

        // 用户选择的背景图优先（cover 铺满画布）；未设置/加载失败则用照片本身模糊
        BufferedImage bgSource = loadBgImage();
        if (bgSource != null) {
            double sc = Math.max(bw / (double) bgSource.getWidth(), bh / (double) bgSource.getHeight());
            int sw = (int) Math.ceil(bgSource.getWidth() * sc);
            int sh = (int) Math.ceil(bgSource.getHeight() * sc);
            tg.drawImage(bgSource, (bw - sw) / 2, (bh - sh) / 2, sw, sh, null);
        } else {
            double sc = 1.2 + blurIntensity * 0.003;
            int sw = (int) (src.getWidth() * sc);
            int sh = (int) (src.getHeight() * sc);
            tg.drawImage(src, (bw - sw) / 2, (bh - sh) / 2, sw, sh, null);
        }
        tg.dispose();

        int blurRadius = scaledBlurRadius();
        BufferedImage blurred = fastBlur(temp, blurRadius);

        BufferedImage result = new BufferedImage(bw, bh, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.drawImage(blurred, 0, 0, null);
        g.dispose();
        return result;
    }

    private static void applyCardShadow(Graphics2D g, int x, int y, int w, int h, int arc) {
        int sSize = shadowSize;
        if (sSize <= 0) return;
        int depth = Math.max(1, shadowDepth * sSize / 100);
        int offset = Math.max(1, sSize / 4);
        Color sc = shadowColor;
        int alpha = Math.max(10, Math.min(180, sc.getAlpha()));
        Color sCol = new Color(sc.getRed(), sc.getGreen(), sc.getBlue(), alpha);
        for (int i = 0; i < 3; i++) {
            int layerOff = offset + i * offset / 2;
            int layerSize = sSize - i * sSize / 6;
            int layerAlpha = alpha - i * 30;
            if (layerAlpha < 5) break;
            g.setColor(new Color(sCol.getRed(), sCol.getGreen(), sCol.getBlue(), layerAlpha));
            g.fillRoundRect(x + layerOff, y + layerOff, w, h, Math.max(1, arc - i * 2), Math.max(1, arc - i * 2));
        }
        int depthOff = Math.max(1, depth / 2);
        g.setColor(new Color(0, 0, 0, Math.min(60, alpha / 2)));
        g.fillRoundRect(x + depthOff, y + depth, w, h, Math.max(1, arc), Math.max(1, arc));
    }

    private static void applyBlurOuterShadow(Graphics2D g, int x, int y, int w, int h, int arc) {
        int sSize = shadowSize;
        if (sSize <= 0) return;
        int depth = Math.max(1, shadowDepth * sSize / 100);
        int alpha = Math.max(10, Math.min(180, shadowColor.getAlpha()));
        Color sCol = new Color(shadowColor.getRed(), shadowColor.getGreen(), shadowColor.getBlue(), alpha);
        for (int i = 0; i < 3; i++) {
            int ext = sSize - i * sSize / 6;
            int layerAlpha = alpha - i * 30;
            if (layerAlpha < 5) break;
            g.setColor(new Color(sCol.getRed(), sCol.getGreen(), sCol.getBlue(), layerAlpha));
            g.fillRoundRect(x - ext, y - ext, w + 2 * ext, h + 2 * ext,
                Math.max(1, arc - i * 2), Math.max(1, arc - i * 2));
        }
        g.setColor(new Color(0, 0, 0, Math.min(60, alpha / 2)));
        g.fillRoundRect(x - 2, y + depth, w + 4, h, Math.max(1, arc), Math.max(1, arc));
    }

    private static BufferedImage addBlurClassic(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.BLUR_CLASSIC);
        int blurRadius = scaledBlurRadius();
        int blurMargin = Math.max(Math.max(scaledPx(50), size / 2), blurRadius);

        BufferedImage backing = createBlurBacking(src, size, blurMargin, blurMargin);
        int cx = blurMargin;
        int cy = blurMargin;

        BufferedImage result = new BufferedImage(backing.getWidth(), backing.getHeight(), BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);

        drawBlurBackground(g, backing, src, cx, cy, blurMargin);
        int photoCr = Math.min(cornerRadius, Math.min(src.getWidth(), src.getHeight()) / 2);
        drawMainPhoto(g, src, cx, cy, photoCr);

        boolean showParams = useExifEnabled;
        if (showParams) {
            int topY = cy + src.getHeight();
            int maskH = result.getHeight() - topY;
            int centerY = topY + maskH / 2;

            boolean showModel = paramType == 0;
            int modelSz = exifFontSize + scaledPx(4);
            int paramSz = exifFontSize;

            Color bc = ColorSampler.sampleBottomDarkColor(src);
            g.setPaint(new GradientPaint(0, topY,
                    new Color(bc.getRed(), bc.getGreen(), bc.getBlue(), 0),
                    0, result.getHeight(),
                    new Color(bc.getRed(), bc.getGreen(), bc.getBlue(), 200)));
            g.fillRect(0, topY, result.getWidth(), maskH);

            WatermarkRender.Position pos = WatermarkRender.getPosition();
            int padX = Math.max(scaledPx(20), scaledPx(10) + exifFontSize);

            if (showModel) {
                int gap = Math.min(scaledPx(6), Math.max(0, maskH - modelSz - paramSz));
                int blockH = modelSz + gap + paramSz;
                int modelY = Math.max(topY + modelSz, centerY - blockH / 2 + modelSz);
                int paramsY = modelY + paramSz + gap;

                String model = cam.brand + " " + cam.model;
                Font mf = fontSans(Font.BOLD, modelSz).deriveFont(Map.of(TextAttribute.TRACKING, 0.08));
                g.setFont(mf);
                FontMetrics mfm = g.getFontMetrics();
                g.setColor(new Color(255, 255, 255, 235));
                if (pos == WatermarkRender.Position.LEFT) {
                    g.drawString(model, padX, modelY);
                } else if (pos == WatermarkRender.Position.RIGHT) {
                    g.drawString(model, result.getWidth() - mfm.stringWidth(model) - padX, modelY);
                } else if (pos == WatermarkRender.Position.SPLIT) {
                    g.drawString(model, padX, modelY);
                } else {
                    g.drawString(model, centerX(result.getWidth(), mfm.stringWidth(model)), modelY);
                }

                String params = buildParamString(cam);
                if (!params.isEmpty()) {
                    Font pf = fontMono(Font.PLAIN, paramSz).deriveFont(Map.of(TextAttribute.TRACKING, 0.10));
                    g.setFont(pf);
                    FontMetrics pfm = g.getFontMetrics();
                    g.setColor(new Color(220, 220, 220, 210));
                    if (pos == WatermarkRender.Position.LEFT) {
                        g.drawString(params, padX, paramsY);
                    } else if (pos == WatermarkRender.Position.RIGHT) {
                        g.drawString(params, result.getWidth() - pfm.stringWidth(params) - padX, paramsY);
                    } else if (pos == WatermarkRender.Position.SPLIT) {
                        g.drawString(params, result.getWidth() - pfm.stringWidth(params) - padX, paramsY);
                    } else {
                        g.drawString(params, centerX(result.getWidth(), pfm.stringWidth(params)), paramsY);
                    }
                }
            } else {
                String params = buildParamString(cam);
                if (!params.isEmpty()) {
                    int paramsY = centerY + paramSz / 2;
                    Font pf = fontMono(Font.PLAIN, paramSz).deriveFont(Map.of(TextAttribute.TRACKING, 0.10));
                    g.setFont(pf);
                    FontMetrics pfm = g.getFontMetrics();
                    g.setColor(new Color(220, 220, 220, 210));
                    if (pos == WatermarkRender.Position.LEFT) {
                        g.drawString(params, padX, paramsY);
                    } else if (pos == WatermarkRender.Position.RIGHT) {
                        g.drawString(params, result.getWidth() - pfm.stringWidth(params) - padX, paramsY);
                    } else if (pos == WatermarkRender.Position.SPLIT) {
                        g.drawString(params, padX, paramsY);
                    } else {
                        g.drawString(params, centerX(result.getWidth(), pfm.stringWidth(params)), paramsY);
                    }
                }
            }
        }

        g.dispose();
        return result;
    }

    private static BufferedImage addBlurDate(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.BLUR_DATE);
        int blurRadius = scaledBlurRadius();
        int blurMargin = Math.max(Math.max(scaledPx(50), size / 2), blurRadius);

        BufferedImage backing = createBlurBacking(src, size, blurMargin, blurMargin);
        int cx = blurMargin;
        int cy = blurMargin;

        BufferedImage result = new BufferedImage(backing.getWidth(), backing.getHeight(), BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);

        drawBlurBackground(g, backing, src, cx, cy, blurMargin);
        drawMainPhoto(g, src, cx, cy, Math.min(cornerRadius, Math.min(src.getWidth(), src.getHeight()) / 2));

        boolean showParams = useExifEnabled;
        if (showParams) {
            int topY = cy + src.getHeight();
            int maskH = result.getHeight() - topY;
            int centerY = topY + maskH / 2;

            boolean showModel = paramType == 0;
            int modelSz = exifFontSize + scaledPx(4);
            int paramSz = exifFontSize;

            Color bc = ColorSampler.sampleBottomDarkColor(src);
            g.setPaint(new GradientPaint(0, topY,
                    new Color(bc.getRed(), bc.getGreen(), bc.getBlue(), 0),
                    0, result.getHeight(),
                    new Color(bc.getRed(), bc.getGreen(), bc.getBlue(), 200)));
            g.fillRect(0, topY, result.getWidth(), maskH);

            WatermarkRender.Position pos = WatermarkRender.getPosition();
            int padX = Math.max(scaledPx(20), scaledPx(10) + exifFontSize);

            if (showModel) {
                int gap = Math.min(scaledPx(6), Math.max(0, maskH - modelSz - paramSz));
                int blockH = modelSz + gap + paramSz;
                int modelY = Math.max(topY + modelSz, centerY - blockH / 2 + modelSz);
                int paramsY = modelY + paramSz + gap;

                String model = cam.brand + " " + cam.model;
                Font mf = fontSans(Font.BOLD, modelSz).deriveFont(Map.of(TextAttribute.TRACKING, 0.08));
                g.setFont(mf);
                FontMetrics mfm = g.getFontMetrics();
                g.setColor(new Color(255, 255, 255, 235));
                if (pos == WatermarkRender.Position.LEFT) {
                    g.drawString(model, padX, modelY);
                } else if (pos == WatermarkRender.Position.RIGHT) {
                    g.drawString(model, result.getWidth() - mfm.stringWidth(model) - padX, modelY);
                } else if (pos == WatermarkRender.Position.SPLIT) {
                    g.drawString(model, padX, modelY);
                } else {
                    g.drawString(model, centerX(result.getWidth(), mfm.stringWidth(model)), modelY);
                }

                String date = new SimpleDateFormat("yyyy.MM.dd").format(new Date());
                Font pf = fontMono(Font.PLAIN, paramSz).deriveFont(Map.of(TextAttribute.TRACKING, 0.10));
                g.setFont(pf);
                FontMetrics pfm = g.getFontMetrics();
                g.setColor(new Color(220, 220, 220, 210));
                if (pos == WatermarkRender.Position.LEFT) {
                    g.drawString(date, padX, paramsY);
                } else if (pos == WatermarkRender.Position.RIGHT) {
                    g.drawString(date, result.getWidth() - pfm.stringWidth(date) - padX, paramsY);
                } else if (pos == WatermarkRender.Position.SPLIT) {
                    g.drawString(date, result.getWidth() - pfm.stringWidth(date) - padX, paramsY);
                } else {
                    g.drawString(date, centerX(result.getWidth(), pfm.stringWidth(date)), paramsY);
                }
            } else {
                String date = new SimpleDateFormat("yyyy.MM.dd").format(new Date());
                int paramsY = centerY + paramSz / 2;
                Font pf = fontMono(Font.PLAIN, paramSz).deriveFont(Map.of(TextAttribute.TRACKING, 0.10));
                g.setFont(pf);
                FontMetrics pfm = g.getFontMetrics();
                g.setColor(new Color(220, 220, 220, 210));
                if (pos == WatermarkRender.Position.LEFT) {
                    g.drawString(date, padX, paramsY);
                } else if (pos == WatermarkRender.Position.RIGHT) {
                    g.drawString(date, result.getWidth() - pfm.stringWidth(date) - padX, paramsY);
                } else if (pos == WatermarkRender.Position.SPLIT) {
                    g.drawString(date, padX, paramsY);
                } else {
                    g.drawString(date, centerX(result.getWidth(), pfm.stringWidth(date)), paramsY);
                }
            }
        }

        g.dispose();
        return result;
    }

    private static void drawBlurBackground(Graphics2D g, BufferedImage backing, BufferedImage src,
            int cx, int cy, int blurMargin) {
        g.drawImage(backing, 0, 0, null);
        // 用户选择背景图时，不再叠加照片边缘色渐变，保持背景图自身的模糊效果
        if (loadBgImage() != null) return;
        Color edgeColor = ColorSampler.sampleEdgeColor(src);
        float imgCX = cx + src.getWidth() / 2f;
        float imgCY = cy + src.getHeight() / 2f;
        float innerR = Math.min(src.getWidth(), src.getHeight()) / 2f;
        float outerR = innerR + blurMargin;
        float[] dist = { Math.min(1f, innerR / outerR), 1f };
        Color[] rColors = { new Color(0, 0, 0, 0),
                new Color(edgeColor.getRed(), edgeColor.getGreen(), edgeColor.getBlue(), 180) };
        g.setPaint(new RadialGradientPaint(imgCX, imgCY, outerR, dist, rColors));
        g.fillRect(0, 0, backing.getWidth(), backing.getHeight());
    }

    private static void drawMainPhoto(Graphics2D g, BufferedImage src, int cx, int cy, int arc) {
        RoundRectangle2D rr = new RoundRectangle2D.Float(cx, cy, src.getWidth(), src.getHeight(), arc, arc);
        g.setClip(rr);
        g.drawImage(src, cx, cy, null);
        g.setColor(new Color(120, 120, 120, 28));
        g.setStroke(new BasicStroke(Math.max(1, scaledPx(2)), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        g.draw(rr);
        g.setColor(new Color(120, 120, 120, 16));
        g.setStroke(new BasicStroke(Math.max(1, scaledPx(5)), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        g.draw(rr);
        g.setColor(new Color(120, 120, 120, 8));
        g.setStroke(new BasicStroke(Math.max(1, scaledPx(8)), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        g.draw(rr);
        g.setClip(null);
    }

    private static void drawBottomMaskAndText(Graphics2D g, BufferedImage src, CameraSpec cam,
            int cx, int cy, int arc, int overlayH, boolean showParams, int canvasW, boolean dateLayout) {
        RoundRectangle2D rr = new RoundRectangle2D.Float(cx, cy, src.getWidth(), src.getHeight(), arc, arc);
        g.setClip(rr);
        Color bc = ColorSampler.sampleBottomDarkColor(src);
        g.setPaint(new GradientPaint(0, cy + src.getHeight() - overlayH,
                new Color(bc.getRed(), bc.getGreen(), bc.getBlue(), 0),
                0, cy + src.getHeight(),
                new Color(bc.getRed(), bc.getGreen(), bc.getBlue(), 210)));
        g.fillRect(cx, cy + src.getHeight() - overlayH, src.getWidth(), overlayH);

        if (showParams) {
            if (dateLayout) {
                int textY = cy + src.getHeight() - overlayH / 2;
                int padX = Math.max(scaledPx(24), scaledPx(20) + exifFontSize);

                boolean showModel = paramType == 0;

                if (showModel) {
                    String date = new SimpleDateFormat("yyyy.MM.dd").format(new Date());
                    Font df = fontMono(Font.PLAIN, exifFontSize).deriveFont(Map.of(TextAttribute.TRACKING, 0.10));
                    g.setFont(df);
                    g.setColor(new Color(240, 240, 240, 230));
                    g.drawString(date, cx + padX, textY);

                    int ls = Math.max(4, scaledPx(logoSize));
                    int rightX = cx + src.getWidth() - padX;
                    if (ls > 4 && !cam.brand.isEmpty()) {
                        Font lf = fontSans(Font.BOLD, ls).deriveFont(Map.of(TextAttribute.TRACKING, 0.08));
                        int logoW = LogoResource.width(cam.brand, lf);
                        rightX -= logoW;
                        LogoResource.draw(g, cam.brand, rightX, textY, lf);
                        rightX -= scaledPx(8);
                    }
                    String params = buildParamString(cam);
                    if (!params.isEmpty()) {
                        Font pf = fontMono(Font.PLAIN, exifFontSize).deriveFont(Map.of(TextAttribute.TRACKING, 0.10));
                        g.setFont(pf);
                        FontMetrics pfm = g.getFontMetrics();
                        int infoX = rightX - pfm.stringWidth(params);
                        g.setColor(new Color(220, 220, 220, 210));
                        g.drawString(params, infoX, textY);
                    }

                    String model = cam.brand + " " + cam.model;
                    Font mf = fontSans(Font.BOLD, exifFontSize + scaledPx(6)).deriveFont(Map.of(TextAttribute.TRACKING, 0.08));
                    g.setFont(mf);
                    FontMetrics mfm = g.getFontMetrics();
                    g.setColor(new Color(255, 255, 255, 235));
                    g.drawString(model, centerX(canvasW, mfm.stringWidth(model)), textY - exifFontSize);
                } else {
                    String params = buildParamString(cam);
                    if (!params.isEmpty()) {
                        Font pf = fontMono(Font.PLAIN, exifFontSize + scaledPx(2)).deriveFont(Map.of(TextAttribute.TRACKING, 0.10));
                        g.setFont(pf);
                        FontMetrics pfm = g.getFontMetrics();
                        g.setColor(new Color(220, 220, 220, 210));
                        g.drawString(params, centerX(canvasW, pfm.stringWidth(params)), textY);
                    }
                }
            } else {
                int textY = cy + src.getHeight() - overlayH / 2;
                int modelSz = exifFontSize + scaledPx(4);
                int paramSz = exifFontSize;
                int blockH = modelSz + scaledPx(6) + paramSz;
                int modelY = textY - blockH / 2 + modelSz;
                int paramsY = textY + blockH / 2;

                String model = cam.brand + " " + cam.model;
                Font mf = fontSans(Font.BOLD, modelSz).deriveFont(Map.of(TextAttribute.TRACKING, 0.08));
                g.setFont(mf);
                FontMetrics mfm = g.getFontMetrics();
                g.setColor(new Color(255, 255, 255, 235));
                g.drawString(model, centerX(canvasW, mfm.stringWidth(model)), modelY);

                String params = buildParamString(cam);
                if (!params.isEmpty()) {
                    Font pf = fontMono(Font.PLAIN, paramSz).deriveFont(Map.of(TextAttribute.TRACKING, 0.10));
                    g.setFont(pf);
                    FontMetrics pfm = g.getFontMetrics();
                    g.setColor(new Color(220, 220, 220, 210));
                    g.drawString(params, centerX(canvasW, pfm.stringWidth(params)), paramsY);
                }
            }
        }
        g.setClip(null);
    }

    private static String buildParamString(CameraSpec cam) {
        String ap = cam.aperture.replace("f/", "F");
        String ss = cam.shutter.endsWith("s") ? cam.shutter : cam.shutter + "s";
        return switch (paramType) {
            case 1 -> cam.focal + "  " + ap;
            case 2 -> new SimpleDateFormat("yyyy.MM.dd").format(new Date());
            default -> cam.focal + "  " + ap + "  " + ss + "  " + cam.iso;
        };
    }

    private static BufferedImage addWmClassic(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.WM_CLASSIC);
        int barH = Math.max(50, size);
        int pad = size;
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad + barH;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, pad, pad, null);
        int barY = src.getHeight() + pad;
        int fs = Math.max(11, size / 3);
        g.setColor(new Color(30, 30, 30));
        g.fillRect(pad, barY, src.getWidth(), barH);
        drawBrandLogo(g, cam.brand, pad + 10, barY + barH / 2 + fs / 3, fontSans(Font.BOLD, fs));
        String line2 = cam.model + "  |  " + cam.focal + "  " + cam.aperture;
        drawText(g, line2, pad + 10 + fs * 4, barY + barH / 2 + fs / 3, fontMono(Font.PLAIN, exifFontSize), new Color(180, 180, 180));
        g.dispose();
        return result;
    }

    private static BufferedImage addWmSingle(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.WM_SINGLE);
        int barH = Math.max(32, size);
        int pad = Math.max(8, size / 2);
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad + barH;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, pad, pad, null);
        int barY = src.getHeight() + pad;
        int fs = Math.max(10, size / 3);
        String line = cam.focal + "  " + cam.aperture + "  " + cam.iso + "  " + cam.shutter;
        g.setColor(new Color(60, 60, 60));
        g.setFont(fontMono(Font.PLAIN, exifFontSize));
        FontMetrics fm = g.getFontMetrics();
        g.drawString(line, centerX(w, fm.stringWidth(line)), barY + barH / 2 + fm.getAscent() / 2);
        g.dispose();
        return result;
    }

    private static BufferedImage addWmBrandLogo(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.WM_BRAND_LOGO);
        int barH = Math.max(56, size * 3 / 2);
        int pad = size;
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad + barH;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(new Color(20, 20, 20)); g.fillRect(0, 0, w, h);
        g.drawImage(src, pad, pad, null);
        int barY = src.getHeight() + pad;
        int textCenterY = barY + barH / 2;
        boolean show = useExifEnabled;
        if (show) {
            int logoFs = Math.max(14, exifFontSize + 4);
            Font lf = fontSans(Font.BOLD, logoFs).deriveFont(Map.of(TextAttribute.TRACKING, 0.06));
            int logoX = pad + 16;
            drawBrandLogo(g, cam.brand, logoX, textCenterY + logoFs / 3, lf);
            String params = buildParamString(cam);
            if (!params.isEmpty()) {
                Font pf = fontMono(Font.PLAIN, exifFontSize).deriveFont(Map.of(TextAttribute.TRACKING, 0.08));
                g.setFont(pf);
                FontMetrics pfm = g.getFontMetrics(pf);
                g.setColor(new Color(200, 200, 200));
                int paramsX = w - pad - 16 - pfm.stringWidth(params);
                g.drawString(params, paramsX, textCenterY + pfm.getAscent() / 2);
            }
        }
        g.dispose();
        return result;
    }

    private static BufferedImage addImpFrosted(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.IMP_FROSTED);
        int pad = Math.max(8, size / 2);
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(new Color(30, 30, 30)); g.fillRect(0, 0, w, h);
        g.drawImage(src, pad, pad, null);
        if (useExifEnabled) {
            WatermarkRender.drawParamMask(g, result, cam.brand, cam.model,
                cam.focal, cam.aperture, cam.iso, cam.shutter);
        }
        g.dispose();
        return result;
    }

    private static BufferedImage addImpClassic(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.IMP_CLASSIC);
        int pad = Math.max(8, size / 2);
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(new Color(40, 40, 45)); g.fillRect(0, 0, w, h);
        g.drawImage(src, pad, pad, null);
        if (useExifEnabled) {
            WatermarkRender.drawParamMask(g, result, cam.brand, cam.model,
                cam.focal, cam.aperture, cam.iso, cam.shutter);
        }
        g.dispose();
        return result;
    }

    private static BufferedImage addCardLogoParam(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.CARD_LOGO_PARAM);
        int pad = size;
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE);
        g.fillRect(0, 0, w, h);
        BufferedImage work = new BufferedImage(src.getWidth(), src.getHeight(), BufferedImage.TYPE_INT_ARGB);
        Graphics2D wg = work.createGraphics();
        wg.drawImage(src, 0, 0, null);
        if (useExifEnabled) {
            WatermarkRender.drawParamMask(wg, work, cam.brand, cam.model,
                cam.focal, cam.aperture, cam.iso, cam.shutter);
        }
        wg.dispose();
        g.drawImage(work, pad, pad, null);
        g.dispose();
        return result;
    }

    private static BufferedImage addCardPureLogo(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.CARD_PURE_LOGO);
        int pad = size;
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE);
        g.fillRect(0, 0, w, h);
        BufferedImage work = new BufferedImage(src.getWidth(), src.getHeight(), BufferedImage.TYPE_INT_ARGB);
        Graphics2D wg = work.createGraphics();
        wg.drawImage(src, 0, 0, null);
        if (useExifEnabled) {
            WatermarkRender.drawParamMask(wg, work, cam.brand, "", "", "", "", "");
        }
        wg.dispose();
        g.drawImage(work, pad, pad, null);
        g.dispose();
        return result;
    }

    private static BufferedImage addCardSimple(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.CARD_SIMPLE);
        int pad = Math.max(10, size / 2);
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        BufferedImage work = new BufferedImage(src.getWidth(), src.getHeight(), BufferedImage.TYPE_INT_ARGB);
        Graphics2D wg = work.createGraphics();
        wg.drawImage(src, 0, 0, null);
        if (useExifEnabled) {
            WatermarkRender.drawParamMask(wg, work, cam.brand, cam.model, "", "", "", "");
        }
        wg.dispose();
        g.drawImage(work, pad, pad, null);
        g.dispose();
        return result;
    }

    private static BufferedImage addCardImmersion(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.CARD_IMMERSION);
        int pad = size;
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        BufferedImage work = new BufferedImage(src.getWidth(), src.getHeight(), BufferedImage.TYPE_INT_ARGB);
        Graphics2D wg = work.createGraphics();
        wg.drawImage(src, 0, 0, null);
        if (useExifEnabled) {
            WatermarkRender.drawParamMask(wg, work, cam.brand, cam.model,
                cam.focal, cam.aperture, cam.iso, cam.shutter);
        }
        wg.dispose();
        g.drawImage(work, pad, pad, null);
        g.dispose();
        return result;
    }

    private static BufferedImage addColorClassic(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.COLOR_CLASSIC);
        int barH = Math.max(40, size);
        int pad = Math.max(8, size / 2);
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad + barH;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, pad, pad, null);
        int barY = src.getHeight() + pad;
        Color[] cols = extractMultipleDominant(src, 5);
        int swatchH = barH;
        int swW = w / cols.length;
        for (int i = 0; i < cols.length; i++) {
            g.setColor(cols[i]);
            g.fillRect(i * swW, barY, swW, swatchH);
        }
        int fs = Math.max(10, size / 3);
        g.setFont(fontSans(Font.BOLD, fs));
        g.setColor(Color.WHITE);
        String label = cam.brand + " " + cam.model;
        g.drawString(label, 12, barY + barH / 2 + fs / 3);
        g.dispose();
        return result;
    }

    private static BufferedImage addColorRefined(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.COLOR_REFINED);
        int barH = Math.max(50, size * 4 / 3);
        int pad = Math.max(8, size / 2);
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad + barH;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(new Color(245, 245, 245)); g.fillRect(0, 0, w, h);
        g.drawImage(src, pad, pad, null);
        int barY = src.getHeight() + pad;
        Color[] cols = extractMultipleDominant(src, 5);
        int swatchH = barH * 3 / 5;
        int swW = w / cols.length;
        for (int i = 0; i < cols.length; i++) {
            g.setColor(cols[i]);
            g.fillRect(i * swW, barY, swW, swatchH);
        }
        int fs = Math.max(9, size / 4);
        g.setColor(new Color(60, 60, 60));
        g.setFont(fontMono(Font.PLAIN, exifFontSize));
        String line = cam.focal + "  " + cam.aperture + "  " + cam.iso + "  " + cam.shutter;
        FontMetrics fm = g.getFontMetrics();
        g.drawString(line, 12, barY + swatchH + (barH - swatchH + fm.getAscent()) / 2);
        g.dispose();
        return result;
    }

    private static BufferedImage addWhitePlain(BufferedImage src, int size) {
        int w = src.getWidth() + size * 2;
        int h = src.getHeight() + size * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(new Color(0xCC, 0xCC, 0xCC));
        g.fillRect(0, 0, w, h);
        g.drawImage(src, size, size, null);
        g.setColor(new Color(0xDD, 0xDD, 0xDD));
        g.setStroke(new BasicStroke(1));
        g.drawRect(size - 1, size - 1, src.getWidth() + 1, src.getHeight() + 1);
        g.dispose();
        return result;
    }

    private static BufferedImage addParamTopLeft(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.PARAM_TOP_LEFT);
        int w = src.getWidth() + size * 2;
        int h = src.getHeight() + size * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, size, size, null);
        int fs = Math.max(9, size / 4);
        g.setFont(fontMono(Font.PLAIN, exifFontSize));
        g.setColor(new Color(100, 100, 100));
        String line = cam.focal + "  " + cam.aperture + "  " + cam.iso + "  " + cam.shutter;
        g.drawString(line, size + 8, size + fs + 4);
        g.dispose();
        return result;
    }

    private static BufferedImage addParamBottomLeft(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.PARAM_BOTTOM_LEFT);
        int w = src.getWidth() + size * 2;
        int h = src.getHeight() + size * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, size, size, null);
        int fs = Math.max(9, size / 4);
        g.setFont(fontMono(Font.PLAIN, exifFontSize));
        g.setColor(new Color(100, 100, 100));
        String line = cam.brand + " " + cam.model + "  |  " + cam.focal + "  " + cam.aperture + "  " + cam.iso + "  " + cam.shutter;
        g.drawString(line, size + 8, h - size - 4);
        g.dispose();
        return result;
    }

    private static BufferedImage addParamBottomSingle(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.PARAM_BOTTOM_SINGLE);
        int w = src.getWidth() + size * 2;
        int h = src.getHeight() + size * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, size, size, null);
        int fs = Math.max(9, size / 4);
        g.setFont(fontMono(Font.PLAIN, exifFontSize));
        g.setColor(new Color(140, 140, 140));
        String info = cam.focal + "  " + cam.aperture;
        FontMetrics fm = g.getFontMetrics();
        g.drawString(info, centerX(w, fm.stringWidth(info)), h - size / 2);
        g.dispose();
        return result;
    }

    private static volatile Color manualGrad1, manualGrad2;
    public static void setGradientColors(Color c1, Color c2) { manualGrad1 = c1; manualGrad2 = c2; }
    public static void clearGradientColors() { manualGrad1 = null; manualGrad2 = null; }

    private static Color[] getGradientColors(BufferedImage src) {
        if (manualGrad1 != null && manualGrad2 != null) return new Color[]{manualGrad1, manualGrad2};
        return extractDominantColors(src);
    }

    private static BufferedImage addGradient(BufferedImage src, int size) {
        int w = src.getWidth() + size * 2;
        int h = src.getHeight() + size * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        Color[] cols = getGradientColors(src);
        GradientPaint gp = new GradientPaint(0, 0, cols[0], w, h, cols[1]);
        g.setPaint(gp);
        g.fillRect(0, 0, w, h);
        g.drawImage(src, size, size, null);
        g.dispose();
        return result;
    }

    public static Color[] extractMultipleDominant(BufferedImage img, int n) {
        int sw = Math.min(48, img.getWidth());
        int sh = Math.max(1, (int) (sw * (double) img.getHeight() / img.getWidth()));
        BufferedImage small = new BufferedImage(sw, sh, BufferedImage.TYPE_INT_ARGB);
        Graphics2D sg = small.createGraphics();
        sg.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        sg.drawImage(img, 0, 0, sw, sh, null);
        sg.dispose();
        int bins = 12;
        java.util.Map<String, Integer> map = new java.util.HashMap<>();
        for (int y = 0; y < sh; y++) {
            for (int x = 0; x < sw; x++) {
                int argb = small.getRGB(x, y);
                int r = (argb >> 16) & 0xFF, gv = (argb >> 8) & 0xFF, b = argb & 0xFF;
                int ri = r * bins / 256, gi = gv * bins / 256, bi = b * bins / 256;
                String key = ri + "," + gi + "," + bi;
                map.merge(key, 1, Integer::sum);
            }
        }
        java.util.List<String> keys = new java.util.ArrayList<>(map.keySet());
        keys.sort((a, k) -> map.get(k) - map.get(a));
        Color[] result = new Color[n];
        java.util.Random rndCol = new java.util.Random(42);
        for (int i = 0; i < n; i++) {
            if (i < keys.size()) {
                String[] parts = keys.get(i).split(",");
                int ri = Integer.parseInt(parts[0]);
                int gi = Integer.parseInt(parts[1]);
                int bi = Integer.parseInt(parts[2]);
                result[i] = new Color(
                        Math.min(255, ri * 256 / bins + 8),
                        Math.min(255, gi * 256 / bins + 8),
                        Math.min(255, bi * 256 / bins + 8));
            } else {
                result[i] = new Color(
                        50 + rndCol.nextInt(180),
                        50 + rndCol.nextInt(180),
                        50 + rndCol.nextInt(180));
            }
        }
        return result;
    }

    public static Color[] extractDominantColors(BufferedImage img) {
        int sw = Math.min(64, img.getWidth());
        int sh = (int) (sw * (double) img.getHeight() / img.getWidth());
        if (sh < 1) sh = 1;
        BufferedImage small = new BufferedImage(sw, sh, BufferedImage.TYPE_INT_ARGB);
        Graphics2D sg = small.createGraphics();
        sg.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        sg.drawImage(img, 0, 0, sw, sh, null);
        sg.dispose();
        int bins = 16;
        int[][][] hist = new int[bins][bins][bins];
        for (int y = 0; y < sh; y++) {
            for (int x = 0; x < sw; x++) {
                int argb = small.getRGB(x, y);
                int r = (argb >> 16) & 0xFF, gv = (argb >> 8) & 0xFF, b = argb & 0xFF;
                int ri = Math.min(bins - 1, r * bins / 256);
                int gi = Math.min(bins - 1, gv * bins / 256);
                int bi = Math.min(bins - 1, b * bins / 256);
                hist[ri][gi][bi]++;
            }
        }
        class Bin implements Comparable<Bin> {
            int ri, gi, bi, count;
            Bin(int r, int gv, int b, int c) { ri = r; gi = gv; bi = b; count = c; }
            public int compareTo(Bin o) { return o.count - count; }
        }
        java.util.ArrayList<Bin> list = new java.util.ArrayList<>();
        for (int ri = 0; ri < bins; ri++) {
            for (int gi = 0; gi < bins; gi++) {
                for (int bi = 0; bi < bins; bi++) {
                    int c = hist[ri][gi][bi];
                    if (c > 0) {
                        int avg = (ri * 256 / bins + gi * 256 / bins + bi * 256 / bins) / 3;
                        if (avg < 35 || avg > 225) continue;
                        list.add(new Bin(ri, gi, bi, c));
                    }
                }
            }
        }
        list.sort(null);
        Color[] result = new Color[2];
        if (list.isEmpty()) {
            result[0] = new Color(100, 180, 255); result[1] = new Color(255, 180, 100);
            return result;
        }
        Bin f = list.get(0);
        result[0] = new Color(f.ri * 256 / bins + 8, f.gi * 256 / bins + 8, f.bi * 256 / bins + 8);
        Bin s = null;
        for (int i = 1; i < list.size(); i++) {
            Bin b = list.get(i);
            double dist = Math.sqrt(Math.pow(b.ri - f.ri, 2) + Math.pow(b.gi - f.gi, 2) + Math.pow(b.bi - f.bi, 2));
            if (dist >= 30) { s = b; break; }
        }
        if (s == null) s = f;
        result[1] = new Color(s.ri * 256 / bins + 8, s.gi * 256 / bins + 8, s.bi * 256 / bins + 8);
        return result;
    }

    private static BufferedImage addCardLeica(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.CARD_LEICA);
        int pad = size;
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        BufferedImage work = new BufferedImage(src.getWidth(), src.getHeight(), BufferedImage.TYPE_INT_ARGB);
        Graphics2D wg = work.createGraphics();
        wg.drawImage(src, 0, 0, null);
        if (useExifEnabled) {
            WatermarkRender.drawParamMask(wg, work, cam.brand, cam.model,
                cam.focal, cam.aperture, cam.iso, cam.shutter);
        }
        wg.dispose();
        g.drawImage(work, pad, pad, null);
        g.dispose();
        return result;
    }

    private static BufferedImage addFujiWhite(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.FUJI_WHITE);
        int barH = Math.max(36, size);
        int pad = Math.max(8, size / 2);
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad + barH;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, pad, pad, null);
        int barY = src.getHeight() + pad;
        int fs = Math.max(11, size / 3);
        Font fuji = fontSans(Font.BOLD, fs);
        Font para = fontMono(Font.PLAIN, exifFontSize);
        String line1 = "FUJIFILM " + cam.model;
        drawText(g, line1, centerX(w, g.getFontMetrics(fuji).stringWidth(line1)), barY + fs, fuji, new Color(40, 40, 40));
        String line2 = cam.focal + "  " + cam.aperture + "  " + cam.iso + "  " + cam.shutter;
        drawText(g, line2, centerX(w, g.getFontMetrics(para).stringWidth(line2)),
                barY + fs + Math.max(12, fs * 2 / 3), para, new Color(120, 120, 120));
        g.dispose();
        return result;
    }

    private static BufferedImage addXiaomiImp(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.XIAOMI_IMP);
        int topPad = Math.max(20, size / 2);
        int barH = Math.max(50, size * 2);
        int sidePad = Math.max(6, size / 3);
        int w = src.getWidth() + sidePad * 2;
        int h = src.getHeight() + topPad + barH;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, sidePad, topPad, null);
        int barY = src.getHeight() + topPad;
        int fs = Math.max(10, size / 4);
        Font pf = fontMono(Font.PLAIN, exifFontSize);
        g.setColor(new Color(240, 240, 240));
        g.fillRect(sidePad, barY, src.getWidth(), barH);
        String[][] btns = {{"焦距", cam.focal}, {"光圈", cam.aperture}, {"ISO", cam.iso}, {"快门", cam.shutter}};
        int btnW = src.getWidth() / btns.length;
        int btnGap = 8;
        for (int i = 0; i < btns.length; i++) {
            int bx = sidePad + i * btnW + btnGap / 2;
            int by = barY + 6;
            int bw = btnW - btnGap;
            int bh = barH - 12;
            g.setColor(new Color(220, 220, 220));
            g.fillRoundRect(bx, by, bw, bh, 8, 8);
            g.setColor(new Color(80, 80, 80));
            FontMetrics fm = g.getFontMetrics(pf);
            drawText(g, btns[i][0], bx + (bw - fm.stringWidth(btns[i][0])) / 2, by + fm.getAscent() + 4, pf, new Color(120, 120, 120));
            drawText(g, btns[i][1], bx + (bw - fm.stringWidth(btns[i][1])) / 2, by + bh - 8, pf, new Color(30, 30, 30));
        }
        g.dispose();
        return result;
    }

    private static BufferedImage addArtCard(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.ART_CARD);
        int barH = Math.max(36, size);
        int pad = Math.max(8, size / 2);
        int w = src.getWidth() + pad * 2;
        int h = src.getHeight() + pad + barH;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, pad, pad, null);
        int barY = src.getHeight() + pad;
        Color[] swatches = ColorClassicSwatches();
        int swatchH = barH * 2 / 3;
        int swW = w / swatches.length;
        for (int i = 0; i < swatches.length; i++) {
            g.setColor(swatches[i]);
            g.fillRect(i * swW, barY, swW, swatchH);
        }
        int fs = Math.max(11, size / 3);
        Font mf = fontSans(Font.BOLD, fs);
        String model = "GFX " + cam.model;
        drawText(g, model, w - pad - g.getFontMetrics(mf).stringWidth(model),
                barY + swatchH + (barH - swatchH + fs) / 2, mf, new Color(60, 60, 60));
        g.dispose();
        return result;
    }

    private static BufferedImage addSimpleFilm(BufferedImage src, int size) {
        CameraSpec cam = cameraFor(src, Style.SIMPLE_FILM);
        int w = src.getWidth() + size * 2;
        int h = src.getHeight() + size * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, size, size, null);
        int fs = Math.max(9, size / 4);
        Font sf = fontMono(Font.PLAIN, exifFontSize);
        String info = cam.focal + "  " + cam.aperture;
        g.setColor(new Color(140, 140, 140));
        FontMetrics fm = g.getFontMetrics(sf);
        int infoX = size + (src.getWidth() - fm.stringWidth(info)) / 2;
        int infoY = h - size / 2;
        drawText(g, info, infoX, infoY, sf, new Color(140, 140, 140));
        g.dispose();
        return result;
    }

    private static BufferedImage addSimpleBorder(BufferedImage src, int size) {
        int w = src.getWidth() + size * 2, h = src.getHeight() + size * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h); g.drawImage(src, size, size, null); g.dispose();
        return result;
    }

    private static BufferedImage addPolaroid(BufferedImage src, int size) {
        int bottom = size * 3, w = src.getWidth() + size * 2, h = src.getHeight() + size + bottom;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h); g.drawImage(src, size, size, null);
        g.setColor(new Color(160, 160, 160));
        String date = new SimpleDateFormat("yyyy.MM.dd").format(new Date());
        Font f = fontMono(Font.PLAIN, Math.max(10, size / 3));
        g.setFont(f); FontMetrics fm = g.getFontMetrics();
        int tx = (w - fm.stringWidth(date)) / 2;
        int ty = src.getHeight() + size + (bottom - fm.getHeight()) / 2 + fm.getAscent();
        g.drawString(date, tx, ty); g.dispose();
        return result;
    }

    private static BufferedImage addFilmStrip(BufferedImage src, int size) {
        int railH = Math.max(20, size), sprocket = Math.max(6, railH / 4), gap = sprocket * 2;
        int w = src.getWidth() + size * 2, h = src.getHeight() + railH * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(Color.BLACK); g.fillRect(0, 0, w, h);
        g.setColor(Color.WHITE);
        for (int x = size + gap / 2; x < w - size; x += sprocket + gap) {
            g.fillRect(x, railH / 2 - sprocket / 2, sprocket, sprocket);
            g.fillRect(x, h - railH / 2 - sprocket / 2, sprocket, sprocket);
        }
        g.drawImage(src, size, railH, null); g.dispose();
        return result;
    }

    private static BufferedImage addRounded(BufferedImage src, int size) {
        int w = src.getWidth() + size * 2, h = src.getHeight() + size * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h);
        g.drawImage(src, size, size, null); g.dispose();
        return result;
    }

    private static BufferedImage addDoubleLine(BufferedImage src, int size) {
        int outer = size, gap = Math.max(4, size / 3), inner = size - gap;
        int w = src.getWidth() + outer * 2, h = src.getHeight() + outer * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h); g.drawImage(src, outer, outer, null);
        g.setColor(new Color(60, 60, 60)); g.setStroke(new BasicStroke(Math.max(1, gap / 2)));
        int l = outer - inner; g.drawRect(l, l, w - l * 2 - 1, h - l * 2 - 1);
        g.setColor(new Color(40, 40, 40)); g.setStroke(new BasicStroke(Math.max(2, outer / 5)));
        g.drawRect(gap / 2, gap / 2, w - gap - 1, h - gap - 1); g.dispose();
        return result;
    }

    private static BufferedImage addVintage(BufferedImage src, int size) {
        int w = src.getWidth() + size * 2, h = src.getHeight() + size * 2;
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(new Color(210, 190, 165)); g.fillRect(0, 0, w, h);
        g.setColor(new Color(160, 140, 115)); g.setStroke(new BasicStroke(Math.max(2, size / 8)));
        g.drawRect(size - 2, size - 2, src.getWidth() + 3, src.getHeight() + 3);
        g.drawImage(src, size, size, null); g.dispose();
        return result;
    }

    public static BufferedImage addDropShadow(BufferedImage src, int size) {
        int offset = Math.max(8, size / 2), softness = Math.max(8, size / 2), margin = size;
        int w = src.getWidth() + margin * 2 + offset, h = src.getHeight() + margin * 2 + offset;
        BufferedImage shadow = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D sg = shadow.createGraphics();
        sg.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        sg.setColor(Color.BLACK);
        sg.fillRoundRect(margin + offset, margin + offset, src.getWidth(), src.getHeight(), Math.max(5, size / 4), Math.max(5, size / 4));
        sg.dispose();
        BufferedImage blurred = fastBlur(shadow, softness);
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.drawImage(blurred, 0, 0, null); g.drawImage(src, margin, margin, null); g.dispose();
        return result;
    }

    public static BufferedImage blur(BufferedImage src, int radius) { return fastBlur(src, radius); }

    static BufferedImage fastBlur(BufferedImage src, int radius) {
        int w = Math.max(1, src.getWidth()), h = Math.max(1, src.getHeight());
        int scale = Math.max(1, radius / 6);
        int sw = Math.max(1, w / scale), sh = Math.max(1, h / scale);
        BufferedImage small = new BufferedImage(sw, sh, BufferedImage.TYPE_INT_ARGB);
        Graphics2D sg = small.createGraphics();
        sg.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        sg.drawImage(src, 0, 0, sw, sh, null); sg.dispose();
        int kSize = Math.max(3, radius / scale); if (kSize % 2 == 0) kSize++;
        ConvolveOp conv = CONVOLVE_OP_CACHE.computeIfAbsent(kSize, ks -> {
            float[] kernel = new float[ks * ks]; float sum = 0; float sigma = ks / 4.0f;
            for (int y = 0; y < ks; y++)
                for (int x = 0; x < ks; x++) {
                    float v = (float) Math.exp(-(Math.pow(x - ks / 2, 2) + Math.pow(y - ks / 2, 2)) / (2 * sigma * sigma));
                    kernel[y * ks + x] = v; sum += v;
                }
            for (int i = 0; i < kernel.length; i++) kernel[i] /= sum;
            return new ConvolveOp(new Kernel(ks, ks, kernel), ConvolveOp.EDGE_NO_OP, null);
        });
        BufferedImage blurred = conv.filter(small, null);
        BufferedImage result = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = result.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.drawImage(blurred, 0, 0, w, h, null); g.dispose();
        return result;
    }

    private static Color[] ColorClassicSwatches() {
        return new Color[]{new Color(220, 80, 60), new Color(60, 140, 200),
                new Color(240, 200, 50), new Color(80, 180, 100), new Color(180, 100, 180)};
    }
}

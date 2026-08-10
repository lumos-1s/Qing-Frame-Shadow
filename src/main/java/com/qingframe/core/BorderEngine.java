package com.qingframe.core;

import com.qingframe.model.*;
import com.qingframe.util.ImageCache;
import javafx.embed.swing.SwingFXUtils;
import javafx.scene.canvas.Canvas;
import javafx.scene.canvas.GraphicsContext;
import javafx.scene.effect.BlurType;
import javafx.scene.effect.DropShadow;
import javafx.scene.SnapshotParameters;
import javafx.scene.image.Image;
import javafx.scene.image.WritableImage;
import javafx.scene.paint.*;
import javafx.scene.text.Font;
import javafx.scene.text.TextAlignment;

import java.awt.image.BufferedImage;
import java.util.List;
import java.util.Random;

public class BorderEngine {

    private Random rand = new Random();
    /** 是否绘制图标选中框（仅预览绘制，导出/缩略图必须关闭） */
    private boolean renderSelection = true;
    /** 图标渲染缩放（导出降级时按比例同步图标位置与大小，保证与预览位置一致） */
    private double iconScaleX = 1.0;
    private double iconScaleY = 1.0;

    public void setIconRenderScale(double sx, double sy) {
        this.iconScaleX = sx;
        this.iconScaleY = sy;
    }

    public void renderToCanvas(Image originImg, TemplateModel template, GraphicsContext gc, double targetW, double targetH) {
        String pfStyle = template.getPhotoFrameStyle();
        if (pfStyle != null && !pfStyle.isEmpty() && !"NONE".equals(pfStyle)) {
            renderPhotoFrameStyle(originImg, template, gc, targetW, targetH);
            return;
        }
        BaseMargin margin = template.getBaseMargin();
        if (margin.getBgBlurEnable() == 1) {
            renderCardStyle(originImg, template, gc, targetW, targetH);
            return;
        }
        double[] canvasSize = computeCanvasSize(originImg, template);
        double canvasW = canvasSize[0];
        double canvasH = canvasSize[1];

        double scale = Math.min(targetW / canvasW, targetH / canvasH);
        double ox = (targetW - canvasW * scale) / 2;
        double oy = (targetH - canvasH * scale) / 2;
        gc.save();
        gc.translate(ox, oy);
        gc.scale(scale, scale);

        gc.setFill(Color.WHITE);
        gc.fillRect(0, 0, canvasW, canvasH);

        List<LayerBorder> layers = template.getLayerList();
        for (int i = layers.size() - 1; i >= 0; i--) {
            LayerBorder layer = layers.get(i);
            // 阴影/辉光源必须先画：本体随后被图层填充覆盖，只露出外溢的投影/光晕
            applyLayerShadowGlow(gc, layer, canvasW, canvasH, margin);
            drawSingleLayer(gc, layer, canvasW, canvasH, margin);
        }

        CornerConfig corner = template.getCornerConfig();
        drawOriginImage(gc, originImg, margin, canvasW, canvasH, corner, template);

        applyShapeMask(gc, template.getCornerConfig(), template.getFilmTearConfig(), canvasW, canvasH);

        applyGlobalLight(gc, template.getLightEffect(), canvasW, canvasH);

        drawDecoration(gc, template.getDecorConfig(), canvasW, canvasH);

        drawActiveIcons(gc, canvasW, canvasH);

        gc.restore();
    }

    /**
     * 计算渲染画布尺寸（含画布比例调整逻辑），供图标放置/命中检测等复用。
     *
     * @return [宽度, 高度]
     */
    public double[] computeCanvasSize(Image originImg, TemplateModel template) {
        BaseMargin margin = template.getBaseMargin();
        double originW = originImg.getWidth();
        double originH = originImg.getHeight();
        double canvasW = originW + margin.getTotalLeft() + margin.getTotalRight();
        double canvasH = originH + margin.getTotalTop() + margin.getTotalBottom();
        // 侧投影模式（如“浮影白框”）：画布四周额外预留柔和弥散阴影空间，避免阴影被裁剪
        double shadowSpace = getShadowSpace(originImg, template);
        if (shadowSpace > 0) {
            canvasW += shadowSpace * 2;
            canvasH += shadowSpace * 2;
        }

        String ratio = template.getCanvasRatio();
        if (!"original".equals(ratio)) {
            double[] wh = parseRatio(ratio);
            if (wh != null) {
                double targetRatio = wh[0] / wh[1];
                double currentRatio = canvasW / canvasH;
                if (currentRatio > targetRatio) {
                    canvasW = canvasH * targetRatio;
                } else {
                    canvasH = canvasW / targetRatio;
                }
            }
        }
        return new double[]{canvasW, canvasH};
    }

    /** 侧投影模式的阴影预留空间：容纳环境阴影层的模糊半径 + 最大偏移量 */
    private double getShadowSpace(Image originImg, TemplateModel template) {
        if (template == null) return 0;
        for (LayerBorder layer : template.getLayerList()) {
            ShadowGlowConfig sg = layer.getShadowGlowConfig();
            if (sg != null && sg.getSideShadow() == 1) {
                double radius = Math.max(4.0, sg.getShadowBlur() * 1.5);
                double off = Math.max(0, Math.max(sg.getShadowOffsetX(), sg.getShadowOffsetY())) * 2.4;
                return Math.max(24.0, radius * 2.0 + off);
            }
        }
        return 0;
    }

    // ═══════════════ Icon rendering ═══════════════

    private void drawActiveIcons(GraphicsContext gc, double canvasW, double canvasH) {
        List<IconItem> icons = IconManager.getActiveIcons();
        IconItem selected = IconManager.getSelected();
        for (IconItem item : icons) {
            Image img = IconManager.getIconImage(item);
            boolean imgReady = img != null && img.getWidth() > 0 && img.getHeight() > 0;
            double base = imgReady ? Math.max(img.getWidth(), img.getHeight()) : 60;
            // 图片图标尺寸封顶：不超过画布短边的 40%，防止大图白底覆盖整张照片
            if (imgReady) {
                base = Math.min(base, Math.max(canvasW, canvasH) * 0.4);
            }
            double sz = base * item.getScale() * Math.min(iconScaleX, iconScaleY);
            double half = sz / 2;
            double px = item.getX() * iconScaleX;
            double py = item.getY() * iconScaleY;
            gc.save();
            gc.translate(px, py);
            gc.setGlobalAlpha(item.getOpacity() / 100.0);
            if (imgReady) {
                gc.drawImage(img, -half, -half, sz, sz);
            } else {
                IconRenderer.draw(gc, item, 0, 0, 60 * item.getScale());
            }
            gc.restore();

            // 选中标记：虚线框 + 四角手柄
            if (renderSelection && item == selected) {
                gc.save();
                double pad = Math.max(4, sz * 0.12);
                gc.setLineWidth(1.2);
                gc.setLineDashes(6, 4);
                gc.setStroke(Color.rgb(52, 137, 232));
                gc.strokeRect(px - half - pad, py - half - pad, sz + pad * 2, sz + pad * 2);
                gc.setLineDashes();
                gc.setFill(Color.rgb(52, 137, 232));
                double h = Math.max(3, pad);
                double[][] corners = {
                        {px - half - pad, py - half - pad},
                        {px + half + pad, py - half - pad},
                        {px - half - pad, py + half + pad},
                        {px + half + pad, py + half + pad}
                };
                for (double[] c : corners) {
                    gc.fillRect(c[0] - h / 2, c[1] - h / 2, h, h);
                }
                gc.restore();
            }
        }
    }

    private void renderPhotoFrameStyle(Image originImg, TemplateModel template, GraphicsContext gc, double targetW, double targetH) {
        String styleStr = template.getPhotoFrameStyle();
        BorderProcessor.Style style;
        try {
            style = BorderProcessor.Style.valueOf(styleStr);
        } catch (Exception e) {
            style = BorderProcessor.Style.NONE;
        }
        if (style == BorderProcessor.Style.NONE) return;

        int w = (int) originImg.getWidth();
        int h = (int) originImg.getHeight();
        BufferedImage awtSrc = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB_PRE);
        SwingFXUtils.fromFXImage(originImg, awtSrc);

        int size = Math.max(5, template.getPhotoFrameBorderSize());
        BufferedImage borderedImg = BorderProcessor.apply(style, awtSrc, size);
        if (borderedImg == null) return;

        int bw = borderedImg.getWidth();
        int bh = borderedImg.getHeight();
        double scale = Math.min(targetW / bw, targetH / bh);
        double ox = (targetW - bw * scale) / 2;
        double oy = (targetH - bh * scale) / 2;

        Image fxResult = SwingFXUtils.toFXImage(borderedImg, null);
        gc.save();
        gc.translate(ox, oy);
        gc.scale(scale, scale);
        gc.drawImage(fxResult, 0, 0);
        gc.restore();
    }

    public WritableImage renderBorder(Image originImg, TemplateModel template) {
        boolean prevSelection = renderSelection;
        renderSelection = false;
        try {
            String pfStyle = template.getPhotoFrameStyle();
            if (pfStyle != null && !pfStyle.isEmpty() && !"NONE".equals(pfStyle)) {
                BorderProcessor.Style style;
                try {
                    style = BorderProcessor.Style.valueOf(pfStyle);
                } catch (Exception e) {
                    style = BorderProcessor.Style.NONE;
                }
                if (style != BorderProcessor.Style.NONE) {
                    int pw = (int) originImg.getWidth();
                    int ph = (int) originImg.getHeight();
                    BufferedImage awtSrc = new BufferedImage(pw, ph, BufferedImage.TYPE_INT_ARGB_PRE);
                    SwingFXUtils.fromFXImage(originImg, awtSrc);
                    int size = Math.max(5, template.getPhotoFrameBorderSize());
                    BufferedImage borderedImg = BorderProcessor.apply(style, awtSrc, size);
                    if (borderedImg != null) {
                        WritableImage result = new WritableImage(borderedImg.getWidth(), borderedImg.getHeight());
                        SwingFXUtils.toFXImage(borderedImg, result);
                        return result;
                    }
                }
            }
            BaseMargin margin = template.getBaseMargin();
            // 统一按 computeCanvasSize 计算（含侧投影模式的阴影预留空间）
            double[] cs = computeCanvasSize(originImg, template);
            int w = (int) Math.ceil(cs[0]);
            int h = (int) Math.ceil(cs[1]);
            if (w <= 0) w = 1;
            if (h <= 0) h = 1;

            Canvas canvas = new Canvas(w, h);
            GraphicsContext gc = canvas.getGraphicsContext2D();
        gc.setFill(Color.WHITE);
            gc.fillRect(0, 0, w, h);
            renderToCanvas(originImg, template, gc, w, h);
            WritableImage result = new WritableImage(Math.max(1, w), Math.max(1, h));
            canvas.snapshot(null, result);
            return result;
        } finally {
            renderSelection = prevSelection;
        }
    }

    public Image renderThumbnail(Image originImg, TemplateModel template) {
        boolean prevSelection = renderSelection;
        renderSelection = false;
        try {
            int ts = 240;
            Canvas canvas = new Canvas(ts, ts);
            GraphicsContext gc = canvas.getGraphicsContext2D();
        gc.setFill(Color.WHITE);
            gc.fillRect(0, 0, ts, ts);
            renderToCanvas(originImg, template, gc, ts, ts);
            WritableImage result = new WritableImage(ts, ts);
            canvas.snapshot(null, result);
            return result;
        } finally {
            renderSelection = prevSelection;
        }
    }

    private void drawBlurredBackground(GraphicsContext gc, Image originImg, double cw, double ch, BaseMargin margin) {
        double imgW = originImg.getWidth();
        double imgH = originImg.getHeight();
        double scale = Math.max(cw / imgW, ch / imgH);
        double sx = (cw - imgW * scale) / 2;
        double sy = (ch - imgH * scale) / 2;
        
        int blurRadius = Math.max(1, margin.getBgBlurRadius());
        gc.save();
        javafx.scene.effect.GaussianBlur blur = new javafx.scene.effect.GaussianBlur(blurRadius);
        gc.setEffect(blur);
        gc.drawImage(originImg, sx, sy, imgW * scale, imgH * scale);
        gc.restore();
    }

    private double[] parseRatio(String ratio) {
        try {
            String[] parts = ratio.split(":");
            return new double[]{Double.parseDouble(parts[0]), Double.parseDouble(parts[1])};
        } catch (Exception e) {
            return null;
        }
    }

    private void drawSingleLayer(GraphicsContext gc, LayerBorder layer, double cw, double ch, BaseMargin margin) {
        if (!layer.isVisible()) return;

        double bx = margin.getMarginLeft() + layer.getMarginLeft();
        double by = margin.getMarginTop() + layer.getMarginTop();
        double bw = cw - margin.getMarginLeft() - margin.getMarginRight() - layer.getMarginLeft() - layer.getMarginRight();
        double bh = ch - margin.getMarginTop() - margin.getMarginBottom() - layer.getMarginTop() - layer.getMarginBottom();

        if (bw <= 0 || bh <= 0) return;

        FillConfig fill = layer.getFillConfig();
        applyFill(gc, fill, bx, by, bw, bh);
        gc.fillRect(bx, by, bw, bh);
        gc.setGlobalBlendMode(javafx.scene.effect.BlendMode.SRC_OVER);

        StrokeConfig stroke = layer.getStrokeConfig();
        if (stroke.getStrokeWidth() > 0) {
            applyStroke(gc, stroke, bx, by, bw, bh);
        }
    }

    private void applyFill(GraphicsContext gc, FillConfig fill, double x, double y, double w, double h) {
        switch (fill.getFillType()) {
            case "solid":
                gc.setFill(parseColor(fill.getFillHex(), fill.getFillOpacity()));
                break;
            case "gradient":
                applyGradient(gc, fill, x, y, w, h);
                break;
            case "transparent":
                gc.setFill(Color.TRANSPARENT);
                break;
            case "texture":
                String texSrc = fill.getTextureSrc();
                if (texSrc != null && !texSrc.isEmpty()) {
                    try {
                        Image tex = ImageCache.get(texSrc);
                        if (tex == null) throw new IllegalArgumentException("texture load failed");
                        javafx.scene.effect.BlendMode bm = mapBlendMode(fill.getTextureBlend());
                        if (bm != null) gc.setGlobalBlendMode(bm);
                        gc.setFill(new ImagePattern(tex, x + fill.getTextureOffsetX(), y + fill.getTextureOffsetY(),
                                tex.getWidth() * fill.getTextureScale(), tex.getHeight() * fill.getTextureScale(), false));
                    } catch (Exception e) {
                        gc.setFill(Color.WHITE);
                    }
                } else {
                    gc.setFill(Color.WHITE);
                }
                break;
            default:
                gc.setFill(Color.WHITE);
        }
    }

    /** 纹理混合模式映射（normal 返回 null 表示不改变混合） */
    private javafx.scene.effect.BlendMode mapBlendMode(String blend) {
        if (blend == null) return null;
        switch (blend) {
            case "multiply": return javafx.scene.effect.BlendMode.MULTIPLY;
            case "screen": return javafx.scene.effect.BlendMode.SCREEN;
            case "overlay": return javafx.scene.effect.BlendMode.OVERLAY;
            default: return null;
        }
    }

    private void applyGradient(GraphicsContext gc, FillConfig fill, double x, double y, double w, double h) {
        List<FillConfig.GradientColorStop> stops = fill.getGradientStops();
        if (stops == null || stops.isEmpty()) {
            gc.setFill(Color.WHITE);
            return;
        }
        Stop[] stopArray = stops.stream()
                .map(s -> new Stop(s.getPosition(), parseColor(s.getColor(), fill.getGradientOpacity())))
                .toArray(Stop[]::new);

        double angle = Math.toRadians(fill.getGradientAngle());
        double cos = Math.cos(angle);
        double sin = Math.sin(angle);
        double cx = x + w / 2;
        double cy = y + h / 2;
        double dx = Math.abs(w * cos / 2) + Math.abs(h * sin / 2);
        double dy = Math.abs(w * sin / 2) + Math.abs(h * cos / 2);

        if ("radial".equals(fill.getGradientType())) {
            gc.setFill(new RadialGradient(0, 0, cx, cy, Math.max(dx, dy), false, CycleMethod.NO_CYCLE, stopArray));
        } else {
            gc.setFill(new LinearGradient(cx - dx, cy - dy, cx + dx, cy + dy, false, CycleMethod.NO_CYCLE, stopArray));
        }
    }

    private void applyStroke(GraphicsContext gc, StrokeConfig stroke, double x, double y, double w, double h) {
        double sw = stroke.getStrokeWidth();
        String pos = stroke.getStrokePos();
        double inset = "inside".equals(pos) ? 0 : "center".equals(pos) ? sw / 2 : sw;

        gc.setStroke(parseColor(stroke.getStrokeColorHex(), stroke.getStrokeOpacity()));
        gc.setLineWidth(sw);

        if (stroke.getStrokeDashArray() != null && !stroke.getStrokeDashArray().isEmpty()) {
            gc.setLineDashes(stroke.getStrokeDashArray().stream().mapToDouble(Double::doubleValue).toArray());
            gc.setLineDashOffset(stroke.getStrokeDashOffset());
        }

        gc.strokeRect(x + inset, y + inset, w - 2 * inset, h - 2 * inset);
        gc.setLineDashes();
    }

    private void applyShapeMask(GraphicsContext gc, CornerConfig cornerConfig, FilmTearConfig filmTearConfig, double cw, double ch) {
        boolean hasPerf = filmTearConfig != null && filmTearConfig.getFilmPerforationEnable() == 1;
        if (hasPerf) {
            drawFilmPerforations(gc, filmTearConfig, cw, ch);
        }
    }

    private void drawFilmPerforations(GraphicsContext gc, FilmTearConfig config, double cw, double ch) {
        double size = config.getFilmPerforationSize();
        double spacing = config.getFilmPerforationSpacing();
        boolean isRound = "round".equals(config.getFilmPerforationType());
        double m = 15;
        gc.setFill(Color.WHITE);
        double y = m;
        while (y + size <= ch - m) {
            for (double xv : new double[]{m, cw - m - size}) {
                if (isRound) gc.fillOval(xv, y, size, size);
                else gc.fillRect(xv, y, size, size);
            }
            y += size + spacing;
        }
    }

    private void drawOriginImage(GraphicsContext gc, Image originImg, BaseMargin margin, double cw, double ch,
                                 CornerConfig corner, TemplateModel template) {
        double iw = originImg.getWidth() * margin.getImgScale();
        double ih = originImg.getHeight() * margin.getImgScale();
        double usableW = cw - margin.getMarginLeft() - margin.getMarginRight();
        double usableH = ch - margin.getMarginTop() - margin.getMarginBottom();
        double ox = margin.getMarginLeft() + (usableW - iw) / 2 + margin.getImgOffsetX();
        double oy = margin.getMarginTop() + (usableH - ih) / 2 + margin.getImgOffsetY();

        double rTL = corner.getCornerRadiusTL();
        double rTR = corner.getCornerRadiusTR();
        double rBL = corner.getCornerRadiusBL();
        double rBR = corner.getCornerRadiusBR();

        boolean hasCorner = rTL > 0 || rTR > 0 || rBL > 0 || rBR > 0;

        // 照片后的投影：优先使用图层中启用的阴影参数（照片轮廓投影，照片像悬浮起来）；
        // 没有启用阴影时保留原来的默认小阴影。
        ShadowGlowConfig photoShadow = null;
        if (template != null) {
            for (LayerBorder layer : template.getLayerList()) {
                ShadowGlowConfig sg = layer.getShadowGlowConfig();
                if (sg != null && sg.getShadowEnable() == 1) {
                    photoShadow = sg;
                    break;
                }
            }
        }

        if (photoShadow != null) {
            gc.save();
            double offX = photoShadow.getShadowOffsetX();
            double offY = photoShadow.getShadowOffsetY();
            // 侧投影模式：模板显式开启（如“浮影白框”）时走平面悬浮卡片投影；
            // 其余模板保持四边均匀投影（历史外观不变）
            if (photoShadow.getSideShadow() != 1) {
                // 四边均匀投影：投影从照片四周均匀扩散（默认）
                DropShadow ds = new DropShadow();
                ds.setBlurType(BlurType.GAUSSIAN);
                ds.setOffsetX(0);
                ds.setOffsetY(0);
                ds.setRadius(photoShadow.getShadowBlur());
                ds.setSpread(photoShadow.getShadowSpread() / 100.0);
                ds.setColor(parseColor(photoShadow.getShadowColorHex(), photoShadow.getShadowOpacity()));
                gc.setEffect(ds);
                if (hasCorner) {
                    buildRoundedPath(gc, ox, oy, iw, ih, rTL, rTR, rBL, rBR);
                    gc.clip();
                }
                gc.drawImage(originImg, ox, oy, iw, ih);
            } else {
                // 立体悬浮卡片（浮影白框）：白色衬边 + 双层立体投影。
                // 环境阴影（远、浅、大模糊）+ 接触阴影（近、深、小模糊）叠加，
                // 阴影向四周柔和扩散且右下最重，呈现真实的悬浮立体感
                double matL = margin.getMarginLeft();
                double matT = margin.getMarginTop();
                double matR = margin.getMarginRight();
                double matB = margin.getMarginBottom();
                double cx = ox - matL;
                double cy = oy - matT;
                double cw2 = iw + matL + matR;
                double ch2 = ih + matT + matB;

                Color sc = parseColor(photoShadow.getShadowColorHex(), photoShadow.getShadowOpacity());
                double blur = Math.max(4.0, photoShadow.getShadowBlur());

                // 环境阴影：大模糊、浅色、偏移更远，营造悬浮高度
                DropShadow ambient = new DropShadow();
                ambient.setBlurType(BlurType.GAUSSIAN);
                ambient.setRadius(blur * 1.5);
                // 环境阴影偏移加大：阴影离卡片更远，悬浮高度更强
                ambient.setOffsetX(offX * 2.4);
                ambient.setOffsetY(offY * 2.4);
                ambient.setSpread(0);
                ambient.setColor(Color.color(sc.getRed(), sc.getGreen(), sc.getBlue(), sc.getOpacity() * 0.6));
                gc.setEffect(ambient);
                gc.setFill(Color.WHITE);
                gc.fillRect(cx, cy, cw2, ch2);

                // 接触阴影：小模糊、深色、紧贴卡片，呈现“落地”层次
                DropShadow contact = new DropShadow();
                contact.setBlurType(BlurType.GAUSSIAN);
                contact.setRadius(blur * 0.5);
                contact.setOffsetX(offX * 0.5);
                contact.setOffsetY(offY * 0.5);
                contact.setSpread(0);
                contact.setColor(Color.color(sc.getRed(), sc.getGreen(), sc.getBlue(), sc.getOpacity()));
                gc.setEffect(contact);
                gc.setFill(Color.WHITE);
                gc.fillRect(cx, cy, cw2, ch2);

                // 卡片本体（白色衬边）
                gc.setEffect(null);
                gc.setFill(Color.WHITE);
                gc.fillRect(cx, cy, cw2, ch2);
            }
            gc.restore();
        } else {
            // 默认小阴影（保持原有外观）
            gc.save();
            gc.setFill(Color.rgb(0, 0, 0, 0.35));
            if (hasCorner) {
                buildRoundedPath(gc, ox + 5, oy + 5, iw, ih, rTL, rTR, rBL, rBR);
                gc.fill();
            } else {
                gc.fillRect(ox + 5, oy + 5, iw, ih);
            }
            gc.restore();
        }

        // Draw image on top
        if (hasCorner) {
            gc.save();
            buildRoundedPath(gc, ox, oy, iw, ih, rTL, rTR, rBL, rBR);
            gc.clip();
            gc.drawImage(originImg, ox, oy, iw, ih);
            gc.restore();
        } else {
            gc.drawImage(originImg, ox, oy, iw, ih);
        }
    }

    /** 构建圆角矩形路径（供投影与照片裁剪复用） */
    private void buildRoundedPath(GraphicsContext gc, double x, double y, double w, double h,
                                  double tl, double tr, double bl, double br) {
        gc.beginPath();
        gc.moveTo(x + tl, y);
        gc.lineTo(x + w - tr, y);
        gc.quadraticCurveTo(x + w, y, x + w, y + tr);
        gc.lineTo(x + w, y + h - br);
        gc.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
        gc.lineTo(x + bl, y + h);
        gc.quadraticCurveTo(x, y + h, x, y + h - bl);
        gc.lineTo(x, y + tl);
        gc.quadraticCurveTo(x, y, x + tl, y);
        gc.closePath();
    }

    private void applyLayerShadowGlow(GraphicsContext gc, LayerBorder layer, double cw, double ch, BaseMargin margin) {
        ShadowGlowConfig sg = layer.getShadowGlowConfig();
        if (sg == null) return;

        double lx = margin.getMarginLeft() + layer.getMarginLeft();
        double ly = margin.getMarginTop() + layer.getMarginTop();
        double lw = cw - margin.getMarginLeft() - margin.getMarginRight() - layer.getMarginLeft() - layer.getMarginRight();
        double lh = ch - margin.getMarginTop() - margin.getMarginBottom() - layer.getMarginTop() - layer.getMarginBottom();

        if (sg.getShadowEnable() == 1) {
            gc.save();
            DropShadow ds = new DropShadow();
            ds.setBlurType(BlurType.GAUSSIAN);
            ds.setOffsetX(sg.getShadowOffsetX());
            ds.setOffsetY(sg.getShadowOffsetY());
            ds.setRadius(sg.getShadowBlur());
            ds.setSpread(sg.getShadowSpread() / 100.0);
            ds.setColor(parseColor(sg.getShadowColorHex(), sg.getShadowOpacity()));
            gc.setEffect(ds);
            // 阴影源与图层填充一致：本体随后被填充覆盖，只露出外溢投影
            applyFill(gc, layer.getFillConfig(), lx, ly, lw, lh);
            gc.fillRect(lx, ly, lw, lh);
            gc.restore();
        }

        if (sg.getGlowEnable() == 1) {
            gc.save();
            Color glowColor = parseColor(sg.getGlowColorHex(), sg.getGlowOpacity());
            DropShadow glow = new DropShadow();
            glow.setBlurType(BlurType.GAUSSIAN);
            glow.setRadius(sg.getGlowBlur());
            glow.setSpread(sg.getGlowSpread() / 100.0);
            glow.setColor(glowColor);
            gc.setEffect(glow);
            gc.setFill(glowColor);
            gc.fillRect(lx, ly, lw, lh);
            gc.restore();
        }
    }

    private void applyGlobalLight(GraphicsContext gc, com.qingframe.model.LightEffect light, double cw, double ch) {
        if (light == null) return;

        if (light.getVignetteEnable() == 1) {
            double s = light.getVignetteStrength() / 100.0;
            gc.save();
            gc.setGlobalBlendMode(javafx.scene.effect.BlendMode.MULTIPLY);
            gc.setFill(new RadialGradient(0, 0, cw / 2, ch / 2, Math.max(cw, ch) / 2, false, CycleMethod.NO_CYCLE,
                    new Stop(0, Color.TRANSPARENT),
                    new Stop(Math.max(0, 1 - s), Color.TRANSPARENT),
                    new Stop(1, Color.rgb(0, 0, 0, Math.min(1, s)))));
            gc.fillRect(0, 0, cw, ch);
            gc.restore();
        }

        if (light.getLightLeakEnable() == 1) {
            gc.save();
            gc.setGlobalBlendMode(javafx.scene.effect.BlendMode.SCREEN);
            Color lc = "warm".equals(light.getLightLeakType()) ?
                    Color.rgb(255, 200, 100, light.getLightLeakOpacity() / 100.0) :
                    Color.rgb(100, 200, 255, light.getLightLeakOpacity() / 100.0);
            gc.setFill(lc);
            double a = Math.toRadians(light.getLightLeakAngle());
            double ex = cw / 2 + Math.cos(a) * cw;
            double ey = ch / 2 + Math.sin(a) * ch;
            gc.fillOval(ex - cw * 0.3, ey - ch * 0.3, cw * 0.6, ch * 0.6);
            gc.restore();
        }
    }

    private void drawDecoration(GraphicsContext gc, TextStickerConfig decor, double cw, double ch) {
        if (decor == null) return;

        // Draw text lines
        for (TextStickerConfig.TextLine textLine : decor.getTextLines()) {
            if (textLine.getText() == null || textLine.getText().isEmpty()) continue;
            gc.save();
            gc.setFont(new Font(textLine.getFontFamily(), textLine.getFontSize()));
            gc.setTextAlign(TextAlignment.CENTER);
            gc.setFill(parseColor(textLine.getColorHex(), textLine.getOpacity()));
            double tx = textLine.getX() > 0 ? textLine.getX() : cw / 2;
            double ty = textLine.getY() > 0 ? textLine.getY() : ch - textLine.getFontSize() - 10;
            if ("bottom".equals(textLine.getAlign())) ty = ch - textLine.getFontSize() - 10;
            else if ("top".equals(textLine.getAlign())) ty = textLine.getFontSize() + 10;
            gc.fillText(textLine.getText(), tx, ty);
            gc.restore();
        }

        // Draw stickers
        for (TextStickerConfig.Sticker sticker : decor.getStickers()) {
            if (sticker.getSrc() == null || sticker.getSrc().isEmpty()) continue;
            try {
                Image simg = ImageCache.get(sticker.getSrc());
                if (simg == null) continue;
                gc.save();
                gc.translate(sticker.getX(), sticker.getY());
                gc.rotate(sticker.getRotation());
                gc.setGlobalAlpha(sticker.getOpacity() / 100.0);
                gc.drawImage(simg, -simg.getWidth() * sticker.getScale() / 2, -simg.getHeight() * sticker.getScale() / 2);
                gc.restore();
            } catch (Exception ignored) {}
        }

        // Corner decorations
        if (decor.getCornerDecorEnable() == 1) {
            double s = decor.getCornerDecorSize();
            gc.setStroke(Color.GRAY);
            gc.setLineWidth(2);
            double[][] corners = {{s, s}, {cw - s, s}, {s, ch - s}, {cw - s, ch - s}};
            for (double[] c : corners) {
                double x = c[0], y = c[1];
                if (x < cw / 2) { gc.strokeLine(x, y, x + s, y); gc.strokeLine(x, y, x, y + s); }
                else { gc.strokeLine(x, y, x - s, y); gc.strokeLine(x, y, x, y + s); }
            }
        }
        
        // EXIF watermark bar at bottom
        if (decor.getExifAutoText() == 1 && !decor.getTextLines().isEmpty()) {
            String exifText = "";
            for (TextStickerConfig.TextLine l : decor.getTextLines()) {
                if (l.getText() != null && !l.getText().isEmpty()) {
                    exifText = l.getText();
                    break;
                }
            }
            if (!exifText.isEmpty()) {
                double barH = 40;
                gc.setFill(Color.rgb(0, 0, 0, 0.6));
                gc.fillRect(0, ch - barH, cw, barH);
                gc.setFill(Color.WHITE);
                gc.setFont(new Font("Microsoft YaHei", 14));
                gc.setTextAlign(TextAlignment.CENTER);
                gc.fillText(exifText, cw / 2, ch - barH + 26);
            }
        }
    }

    private void renderCardStyle(Image originImg, TemplateModel template, GraphicsContext gc, double targetW, double targetH) {
        BaseMargin margin = template.getBaseMargin();
        double originW = originImg.getWidth();
        double originH = originImg.getHeight();
        double canvasW = originW + margin.getTotalLeft() + margin.getTotalRight();
        double canvasH = originH + margin.getTotalTop() + margin.getTotalBottom();

        String ratio = template.getCanvasRatio();
        if (!"original".equals(ratio)) {
            double[] wh = parseRatio(ratio);
            if (wh != null) {
                double targetRatio = wh[0] / wh[1];
                double currentRatio = canvasW / canvasH;
                if (currentRatio > targetRatio) {
                    canvasW = canvasH * targetRatio;
                } else {
                    canvasH = canvasW / targetRatio;
                }
            }
        }

        double scale = Math.min(targetW / canvasW, targetH / canvasH);
        double ox = (targetW - canvasW * scale) / 2;
        double oy = (targetH - canvasH * scale) / 2;
        gc.save();
        gc.translate(ox, oy);
        gc.scale(scale, scale);

        // 1. Blurred image as substrate background
        drawBlurredBackground(gc, originImg, canvasW, canvasH, margin);
        if (margin.getBgBlurWhiteOverlay() == 1) {
            gc.setFill(Color.rgb(255, 255, 255, 0.15));
            gc.fillRect(0, 0, canvasW, canvasH);
        }

        // 2. Radial gradient vignette overlay (darker edges, lighter center)
        double cx = canvasW / 2;
        double cy = canvasH / 2;
        double gradientRadius = Math.sqrt(cx * cx + cy * cy);
        RadialGradient vignette = new RadialGradient(0, 0, cx, cy, gradientRadius, false, CycleMethod.NO_CYCLE,
            new Stop(0, Color.rgb(255, 255, 255, 0.0)),
            new Stop(0.5, Color.rgb(0, 0, 0, 0.0)),
            new Stop(1, Color.rgb(0, 0, 0, 0.25)));
        gc.setFill(vignette);
        gc.fillRect(0, 0, canvasW, canvasH);

        // 3. Content area
        double cardX = margin.getMarginLeft();
        double cardY = margin.getMarginTop();
        double cardW = canvasW - margin.getTotalLeft() - margin.getTotalRight();
        double cardH = canvasH - margin.getTotalTop() - margin.getTotalBottom();
        double textAreaH = 48;
        double textY = canvasH - 14;
        cardH -= textAreaH;

        // 4. Photo with rounded corners and soft shadow
        CornerConfig corner = template.getCornerConfig();
        double cr = Math.min(Math.max(corner.getCornerRadiusAll(), 0), cardW / 2);
        double prTL = corner.getCornerRadiusTL() > 0 ? Math.min(corner.getCornerRadiusTL(), cardW / 2) : cr;
        double prTR = corner.getCornerRadiusTR() > 0 ? Math.min(corner.getCornerRadiusTR(), cardW / 2) : cr;
        double prBL = corner.getCornerRadiusBL() > 0 ? Math.min(corner.getCornerRadiusBL(), cardH / 2) : cr;
        double prBR = corner.getCornerRadiusBR() > 0 ? Math.min(corner.getCornerRadiusBR(), cardH / 2) : cr;

        double imgScale = Math.min(cardW / originW, cardH / originH);
        double drawW = originW * imgScale;
        double drawH = originH * imgScale;
        double drawX = cardX + (cardW - drawW) / 2;
        double drawY = cardY + (cardH - drawH) / 2;

        // Draw image with rounded corners and soft shadow (no white fill layer)
        // Step 1: render clipped image onto temp canvas, snapshot to WritableImage
        Canvas tempCanvas = new Canvas(drawW, drawH);
        GraphicsContext tgc = tempCanvas.getGraphicsContext2D();
        tgc.save();
        tgc.beginPath();
        tgc.moveTo(prTL, 0);
        tgc.lineTo(drawW - prTR, 0);
        tgc.quadraticCurveTo(drawW, 0, drawW, prTR);
        tgc.lineTo(drawW, drawH - prBR);
        tgc.quadraticCurveTo(drawW, drawH, drawW - prBR, drawH);
        tgc.lineTo(prBL, drawH);
        tgc.quadraticCurveTo(0, drawH, 0, drawH - prBL);
        tgc.lineTo(0, prTL);
        tgc.quadraticCurveTo(0, 0, prTL, 0);
        tgc.closePath();
        tgc.clip();
        tgc.drawImage(originImg, 0, 0, drawW, drawH);
        tgc.restore();
        SnapshotParameters sp = new SnapshotParameters();
        sp.setFill(Color.TRANSPARENT);
        WritableImage clippedImg = tempCanvas.snapshot(sp, null);

        // Step 2: draw clipped image on main canvas with DropShadow
        gc.save();
        DropShadow imgShadow = new DropShadow();
        imgShadow.setBlurType(BlurType.GAUSSIAN);
        // 卡片阴影：优先使用图层中启用的阴影参数（可在“光影”面板调节）；
        // 未启用时保持默认柔和阴影（背景模糊卡片默认带阴影）
        ShadowGlowConfig cardShadow = null;
        if (template != null) {
            for (LayerBorder layer : template.getLayerList()) {
                ShadowGlowConfig sg = layer.getShadowGlowConfig();
                if (sg != null && sg.getShadowEnable() == 1) {
                    cardShadow = sg;
                    break;
                }
            }
        }
        if (cardShadow != null) {
            imgShadow.setRadius(cardShadow.getShadowBlur());
            imgShadow.setOffsetX(cardShadow.getShadowOffsetX());
            imgShadow.setOffsetY(cardShadow.getShadowOffsetY());
            imgShadow.setSpread(cardShadow.getShadowSpread() / 100.0);
            imgShadow.setColor(parseColor(cardShadow.getShadowColorHex(), cardShadow.getShadowOpacity()));
        } else {
            imgShadow.setRadius(36);
            imgShadow.setOffsetX(0);
            imgShadow.setOffsetY(8);
            imgShadow.setSpread(0);
            imgShadow.setColor(Color.rgb(0, 0, 0, 0.30));
        }
        gc.setEffect(imgShadow);
        gc.drawImage(clippedImg, drawX, drawY, drawW, drawH);
        gc.restore();

        // Step 3: draw same clipped image on top (no shadow) — covers inner shadow
        gc.drawImage(clippedImg, drawX, drawY, drawW, drawH);

        // 7. Decorations (custom text, stickers, EXIF at bottom)
        TextStickerConfig decor = template.getDecorConfig();
        if (decor != null) {
            for (TextStickerConfig.TextLine textLine : decor.getTextLines()) {
                if (textLine.getText() == null || textLine.getText().isEmpty()) continue;
                gc.save();
                gc.setFont(new Font(textLine.getFontFamily(), textLine.getFontSize()));
                gc.setTextAlign(TextAlignment.CENTER);
                gc.setFill(parseColor(textLine.getColorHex(), textLine.getOpacity()));
                double tx = textLine.getX() > 0 ? textLine.getX() : canvasW / 2;
                double ty = textLine.getY() > 0 ? textLine.getY() : cardY + cardH + 30;
                if ("bottom".equals(textLine.getAlign())) ty = cardY + cardH + 30;
                else if ("top".equals(textLine.getAlign())) ty = textLine.getFontSize() + 10;
                gc.fillText(textLine.getText(), tx, ty);
                gc.restore();
            }

            for (TextStickerConfig.Sticker sticker : decor.getStickers()) {
                if (sticker.getSrc() == null || sticker.getSrc().isEmpty()) continue;
                try {
                    Image simg = ImageCache.get(sticker.getSrc());
                    if (simg == null) continue;
                    gc.save();
                    gc.translate(sticker.getX(), sticker.getY());
                    gc.rotate(sticker.getRotation());
                    gc.setGlobalAlpha(sticker.getOpacity() / 100.0);
                    gc.drawImage(simg, -simg.getWidth() * sticker.getScale() / 2, -simg.getHeight() * sticker.getScale() / 2);
                    gc.restore();
                } catch (Exception ignored) {}
            }

            // EXIF auto text at canvas bottom center (no black bar)
            if (decor.getExifAutoText() == 1) {
                String exifText = "";
                for (TextStickerConfig.TextLine l : decor.getTextLines()) {
                    if (l.getText() != null && !l.getText().isEmpty()) {
                        exifText = l.getText();
                        break;
                    }
                }
                if (!exifText.isEmpty()) {
                    gc.setTextAlign(TextAlignment.CENTER);
        gc.setFill(Color.WHITE);
                    gc.setFont(new Font("Microsoft YaHei", 13));
                    gc.fillText(exifText, canvasW / 2, textY);
                }
            }
        }

        // 8. Global light effects
        applyGlobalLight(gc, template.getLightEffect(), canvasW, canvasH);

        drawActiveIcons(gc, canvasW, canvasH);

        gc.restore();
    }

    private Color parseColor(String hex, double opacity) {
        try {
            hex = hex.replace("#", "");
            if (hex.length() == 3) hex = "" + hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
            if (hex.length() == 6) hex = "FF" + hex;
            long argb = Long.parseLong(hex, 16);
            int a = (int) ((argb >> 24) & 0xFF);
            int r = (int) ((argb >> 16) & 0xFF);
            int g = (int) ((argb >> 8) & 0xFF);
            int b = (int) (argb & 0xFF);
            return Color.rgb(r, g, b, (a / 255.0) * (opacity / 100.0));
        } catch (Exception e) {
            return Color.BLACK;
        }
    }

}

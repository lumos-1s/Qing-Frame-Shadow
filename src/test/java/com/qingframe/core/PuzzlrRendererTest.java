package com.qingframe.core;

import com.qingframe.model.GapCaption;
import com.qingframe.model.PuzzlrConfig;
import org.junit.jupiter.api.Test;

import java.awt.image.BufferedImage;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PuzzlrRenderer 渲染正确性测试（无头环境可跑）：输出尺寸、比例、空格容错、字幕不崩溃
 */
class PuzzlrRendererTest {

    private static BufferedImage solid(int w, int h) {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        java.awt.Graphics2D g = img.createGraphics();
        g.setColor(java.awt.Color.RED);
        g.fillRect(0, 0, w, h);
        g.dispose();
        return img;
    }

    private static PuzzlrConfig cfgWithSlots(int layoutType, int count) {
        PuzzlrConfig cfg = new PuzzlrConfig();
        cfg.setLayoutType(layoutType);
        cfg.setGap(80);
        return cfg;
    }

    @Test
    void squareRatioGivesRequestedLongEdge() {
        PuzzlrConfig cfg = new PuzzlrConfig();
        cfg.setLayoutType(PuzzlrConfig.LAYOUT_4_GRID);
        cfg.setCanvasRatio(1.0);
        List<BufferedImage> imgs = Arrays.asList(solid(100, 100), solid(100, 100),
                solid(100, 100), solid(100, 100));
        BufferedImage out = PuzzlrRenderer.render(imgs, cfg, 1200);
        assertEquals(1200, out.getWidth());
        assertEquals(1200, out.getHeight());
    }

    @Test
    void wideRatioKeepsWidthAsLongEdge() {
        PuzzlrConfig cfg = new PuzzlrConfig();
        cfg.setCanvasRatio(4.0 / 3.0);
        List<BufferedImage> imgs = Collections.singletonList(solid(100, 100));
        BufferedImage out = PuzzlrRenderer.render(imgs, cfg, 1600);
        assertEquals(1600, out.getWidth());
        assertEquals(1200, out.getHeight());
    }

    @Test
    void tallRatioKeepsHeightAsLongEdge() {
        PuzzlrConfig cfg = new PuzzlrConfig();
        cfg.setCanvasRatio(0.75);
        List<BufferedImage> imgs = Collections.singletonList(solid(100, 100));
        BufferedImage out = PuzzlrRenderer.render(imgs, cfg, 2000);
        assertEquals(1500, out.getWidth());
        assertEquals(2000, out.getHeight());
    }

    @Test
    void autoRatioFollowsLayoutExtents() {
        PuzzlrConfig cfg = new PuzzlrConfig();
        cfg.setLayoutType(PuzzlrConfig.LAYOUT_2_SIDE);
        cfg.setCanvasRatio(0);
        cfg.setAxisVals(new double[]{0.5});
        BufferedImage out = PuzzlrRenderer.render(Collections.emptyList(), cfg, 1000);
        // 布局铺满单位方形 → 长边即请求值
        assertEquals(1000, Math.max(out.getWidth(), out.getHeight()));
    }

    @Test
    void nullAndMissingImagesDoNotCrash() {
        for (int type : new int[]{
                PuzzlrConfig.LAYOUT_2_SIDE, PuzzlrConfig.LAYOUT_3_MAIN,
                PuzzlrConfig.LAYOUT_4_STAG, PuzzlrConfig.LAYOUT_6_32}) {
            PuzzlrConfig cfg = cfgWithSlots(type, PuzzlrConfig.slotCount(type));
            cfg.setCanvasRatio(1.0);
            List<BufferedImage> imgs = Arrays.asList(null, solid(50, 50));
            BufferedImage out = PuzzlrRenderer.render(imgs, cfg, 800);
            assertTrue(out.getWidth() > 0 && out.getHeight() > 0);
        }
    }

    @Test
    void blurBackgroundWithNoImagesDoesNotCrash() {
        PuzzlrConfig cfg = new PuzzlrConfig();
        cfg.setBgMode(1);
        BufferedImage out = PuzzlrRenderer.render(Collections.emptyList(), cfg, 600);
        assertTrue(out.getWidth() > 0);
    }

    @Test
    void gapCaptionsRenderAtSpacingExtremes() {
        PuzzlrConfig cfg = new PuzzlrConfig();
        cfg.setLayoutType(PuzzlrConfig.LAYOUT_2_SIDE);
        cfg.setCanvasRatio(1.0);
        GapCaption cap = new GapCaption();
        cap.setGapId("H0");
        cap.setTextContent("第一行");
        cap.setTextContent2("第二行");
        cfg.getGapCaptions().add(cap);

        for (double spacing : new double[]{0.0, 0.25, 3.0}) {
            cap.setLineSpacing(spacing);
            BufferedImage out = PuzzlrRenderer.render(
                    Arrays.asList(solid(100, 100), solid(100, 100)), cfg, 900);
            assertEquals(900, out.getWidth());
        }
    }

    @Test
    void hugeGapDoesNotCrashWhenCellsCollapse() {
        PuzzlrConfig cfg = new PuzzlrConfig();
        cfg.setGap(PuzzlrRenderer.GAP_BASE_EDGE);
        BufferedImage out = PuzzlrRenderer.render(
                Collections.singletonList(solid(100, 100)), cfg, 500);
        assertTrue(out.getWidth() > 0 && out.getHeight() > 0);
    }
}

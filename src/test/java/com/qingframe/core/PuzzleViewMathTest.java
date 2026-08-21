package com.qingframe.core;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PuzzleViewMath 几何测试：适配缩放、16000 显示硬上限、平移钳制——
 * 锁定布局反馈死循环防护逻辑的行为
 */
class PuzzleViewMathTest {

    private static final double EPS = 1e-9;

    @Test
    void fitContainsImageInsideViewport() {
        // 视口 1000x800，图 2000x1000 → 宽度受限 s=0.5
        double[] r = PuzzleViewMath.fit(1000, 800, 2000, 1000, 1.0);
        assertEquals(0.5, r[0], EPS);
        assertEquals(1000, r[1], EPS);
        assertEquals(500, r[2], EPS);
    }

    @Test
    void fitAppliesUserZoom() {
        double[] r = PuzzleViewMath.fit(1000, 800, 2000, 1000, 2.0);
        assertEquals(2000, r[1], EPS);
        assertEquals(1000, r[2], EPS);
    }

    @Test
    void fitCapsDisplayAtMaxEdge() {
        // 极端 zoom 会算出 10 万级显示尺寸 → 必须被 16000 硬上限压回
        double[] r = PuzzleViewMath.fit(500, 500, 50, 50, 1000);
        assertTrue(r[1] <= PuzzleViewMath.MAX_DISPLAY_EDGE + EPS, "fitW 超过硬上限");
        assertTrue(r[2] <= PuzzleViewMath.MAX_DISPLAY_EDGE + EPS, "fitH 超过硬上限");
        assertEquals(PuzzleViewMath.MAX_DISPLAY_EDGE, Math.max(r[1], r[2]), EPS);
    }

    @Test
    void fitRejectsInvalidInputs() {
        assertNull(PuzzleViewMath.fit(Double.NaN, 800, 2000, 1000, 1.0));
        assertNull(PuzzleViewMath.fit(1000, Double.POSITIVE_INFINITY, 2000, 1000, 1.0));
        assertNull(PuzzleViewMath.fit(5, 5, 2000, 1000, 1.0), "视口过小应视为未完成布局");
        assertNull(PuzzleViewMath.fit(1000, 800, 0, 1000, 1.0));
        assertNull(PuzzleViewMath.fit(1000, 800, -3, 1000, 1.0));
        assertNull(PuzzleViewMath.fit(1000, 800, 2000, 1000, -1.0));
        assertNull(PuzzleViewMath.fit(1000, 800, 2000, 1000, Double.NaN));
    }

    @Test
    void translateZeroesWhenNotZoomed() {
        double[] t = PuzzleViewMath.clampTranslate(123, -456, 2000, 1500, 1000, 800, 1.0);
        assertArrayEquals(new double[]{0, 0}, t, EPS);
        // 阈值边界：恰好 1.001 仍归零
        t = PuzzleViewMath.clampTranslate(123, -456, 2000, 1500, 1000, 800, PuzzleViewMath.ZOOM_IDLE_EPSILON);
        assertArrayEquals(new double[]{0, 0}, t, EPS);
    }

    @Test
    void translateClampsToOverflowWhenZoomed() {
        // fitW=2000 视口 1000 → 单侧可平移 (2000-1000)/2 = 500
        double[] t = PuzzleViewMath.clampTranslate(9999, -9999, 2000, 1500, 1000, 800, 2.0);
        assertEquals(500, t[0], EPS);
        assertEquals(-350, t[1], EPS); // (1500-800)/2 = 350
        // 范围内的值原样保留
        t = PuzzleViewMath.clampTranslate(120, -80, 2000, 1500, 1000, 800, 2.0);
        assertArrayEquals(new double[]{120, -80}, t, EPS);
    }
}

package com.qingframe.model;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PuzzlrConfig 拼图布局测试：格数一致性、格子铺满单位方形、坐标范围合法
 */
class PuzzlrConfigTest {

    private static final int[] ALL_TYPES = {
            PuzzlrConfig.LAYOUT_2_SIDE, PuzzlrConfig.LAYOUT_2_STACK, PuzzlrConfig.LAYOUT_2_BIG,
            PuzzlrConfig.LAYOUT_3_H, PuzzlrConfig.LAYOUT_3_V, PuzzlrConfig.LAYOUT_3_MAIN,
            PuzzlrConfig.LAYOUT_4_GRID, PuzzlrConfig.LAYOUT_4_MAIN, PuzzlrConfig.LAYOUT_4_STAG,
            PuzzlrConfig.LAYOUT_6_23, PuzzlrConfig.LAYOUT_6_32
    };

    @Test
    void slotCountMatchesBuildSlotsForEveryLayout() {
        for (int type : ALL_TYPES) {
            double[][] slots = PuzzlrConfig.buildSlots(type, PuzzlrConfig.defaultAxes(type));
            assertEquals(PuzzlrConfig.slotCount(type), slots.length,
                    "布局 " + type + " 的 buildSlots 格数与 slotCount 不一致");
        }
    }

    @Test
    void slotsTileTheUnitSquare() {
        for (int type : ALL_TYPES) {
            double[][] slots = PuzzlrConfig.buildSlots(type, PuzzlrConfig.defaultAxes(type));
            double area = 0;
            for (double[] s : slots) {
                assertTrue(s[2] > 0 && s[3] > 0, "布局 " + type + " 出现零面积格子");
                assertTrue(s[0] >= -1e-9 && s[1] >= -1e-9, "布局 " + type + " 格子越出左/上边界");
                assertTrue(s[0] + s[2] <= 1 + 1e-9 && s[1] + s[3] <= 1 + 1e-9,
                        "布局 " + type + " 格子越出右/下边界");
                area += s[2] * s[3];
            }
            assertEquals(1.0, area, 1e-6, "布局 " + type + " 格子未铺满画布");
        }
    }

    @Test
    void axesOfReturnValidTypesAndIndices() {
        for (int type : ALL_TYPES) {
            int[][] axes = PuzzlrConfig.axesOf(type);
            assertTrue(axes.length > 0, "布局 " + type + " 无可拖轴");
            for (int[] axis : axes) {
                assertEquals(2, axis.length);
                assertTrue((axis[0] == 0 || axis[0] == 1) && (axis[1] == 0 || axis[1] == 1),
                        "布局 " + type + " 轴类型非法（应为 0 竖线 / 1 横线）");
                assertTrue(axis[1] >= 0, "布局 " + type + " 轴下标非法");
            }
        }
    }

    @Test
    void layoutNameNeverEmpty() {
        for (int type : ALL_TYPES) {
            String name = PuzzlrConfig.layoutName(type);
            assertNotNull(name, "布局 " + type + " 无名称");
            assertTrue(!name.isBlank(), "布局 " + type + " 名称为空");
        }
    }

    @Test
    void defaultConstructorProducesTwoSideLayout() {
        PuzzlrConfig cfg = new PuzzlrConfig();
        assertEquals(PuzzlrConfig.LAYOUT_2_SIDE, cfg.getLayoutType());
        assertEquals(8, cfg.getGap());
        assertEquals(2, cfg.getSlots().size());
        assertEquals(0, cfg.getCanvasRatio(), 1e-9);
    }

    @Test
    void setLayoutTypeResizesSlotsKeepingExistingImages() {
        PuzzlrConfig cfg = new PuzzlrConfig();
        SlotConfig first = cfg.getSlots().get(0);
        first.setImagePath("D:/photos/a.jpg");
        cfg.setLayoutType(PuzzlrConfig.LAYOUT_6_23);
        assertEquals(6, cfg.getSlots().size());
        assertEquals("D:/photos/a.jpg", cfg.getSlots().get(0).getImagePath(), "切布局应保留已填图片");
    }
}

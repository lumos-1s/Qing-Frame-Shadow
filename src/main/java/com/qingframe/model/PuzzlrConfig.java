package com.qingframe.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 拼图配置：布局类型（2/3/4/6 张共 11 种）+ 格子间距 + 每格图片与裁剪参数 + 可拖拽分割轴。
 * 格子坐标不落盘，由布局类型 + 轴位置实时计算（buildSlots），拖拽分割线只改轴位置。
 */
public class PuzzlrConfig {
    public static final int LAYOUT_2_SIDE = 0;
    public static final int LAYOUT_2_STACK = 1;
    public static final int LAYOUT_2_BIG = 2;
    public static final int LAYOUT_3_H = 3;
    public static final int LAYOUT_3_V = 4;
    public static final int LAYOUT_3_MAIN = 5;
    public static final int LAYOUT_4_GRID = 6;
    public static final int LAYOUT_4_MAIN = 7;
    public static final int LAYOUT_4_STAG = 8;
    public static final int LAYOUT_6_23 = 9;
    public static final int LAYOUT_6_32 = 10;

    private int layoutType;
    private int gap;
    /** 背景：0=白色 1=模糊照片底（格子照片铺满放大模糊） */
    private int bgMode;
    /** 画布比例：0=自动（随布局），否则为 宽/高 值（如 1.0、0.75、1.7778） */
    private double canvasRatio;
    /** 格子间隙/边框颜色（#RRGGBB，纯色背景下生效） */
    private String borderColor = "#FFFFFF";
    /** 绑定分割间隙的电影字幕（跟随间隙移动，间隙消失自动删除） */
    private List<GapCaption> gapCaptions = new ArrayList<>();
    private List<SlotConfig> slots;
    private double[] axisVals;

    public PuzzlrConfig() {
        this.layoutType = LAYOUT_2_SIDE;
        this.gap = 8;
        this.bgMode = 0;
        this.canvasRatio = 0;
        this.axisVals = defaultAxes(LAYOUT_2_SIDE);
        this.slots = new ArrayList<>();
        for (int i = 0; i < slotCount(LAYOUT_2_SIDE); i++) slots.add(new SlotConfig());
    }

    public int getLayoutType() { return layoutType; }
    public void setLayoutType(int layoutType) {
        this.layoutType = layoutType;
        this.axisVals = defaultAxes(layoutType);
        // 切换布局：调整格子数量，已填图片保留
        List<SlotConfig> old = this.slots;
        int n = slotCount(layoutType);
        List<SlotConfig> next = new ArrayList<>();
        for (int i = 0; i < n; i++) next.add(i < old.size() ? old.get(i) : new SlotConfig());
        this.slots = next;
    }
    public int getGap() { return gap; }
    public void setGap(int gap) { this.gap = gap; }
    public int getBgMode() { return bgMode; }
    public void setBgMode(int bgMode) { this.bgMode = bgMode; }
    public double getCanvasRatio() { return canvasRatio; }
    public void setCanvasRatio(double canvasRatio) { this.canvasRatio = canvasRatio; }
    public String getBorderColor() { return borderColor; }
    public void setBorderColor(String borderColor) { this.borderColor = borderColor; }
    public List<GapCaption> getGapCaptions() {
        if (gapCaptions == null) gapCaptions = new ArrayList<>();
        return gapCaptions;
    }
    public void setGapCaptions(List<GapCaption> gapCaptions) { this.gapCaptions = gapCaptions; }
    public List<SlotConfig> getSlots() { return slots; }
    public void setSlots(List<SlotConfig> slots) { this.slots = slots; }
    public double[] getAxisVals() { return axisVals; }
    public void setAxisVals(double[] axisVals) { this.axisVals = axisVals; }

    /** 当前布局各格坐标（相对 0-1），调用方负责用 gap 再做内缩 */
    public double[][] buildSlots() {
        return buildSlots(layoutType, axisVals);
    }

    public static String layoutName(int type) {
        return switch (type) {
            case LAYOUT_2_SIDE -> "2张-左右";
            case LAYOUT_2_STACK -> "2张-上下";
            case LAYOUT_2_BIG -> "2张-一大一小";
            case LAYOUT_3_H -> "3张-三横条";
            case LAYOUT_3_V -> "3张-三竖条";
            case LAYOUT_3_MAIN -> "3张-一大两小";
            case LAYOUT_4_GRID -> "4张-四宫格";
            case LAYOUT_4_MAIN -> "4张-一大三小";
            case LAYOUT_4_STAG -> "4张-2x2错落";
            case LAYOUT_6_23 -> "6张-2x3网格";
            case LAYOUT_6_32 -> "6张-3x2网格";
            default -> "未知布局";
        };
    }

    public static int slotCount(int type) {
        return switch (type) {
            case LAYOUT_2_SIDE, LAYOUT_2_STACK, LAYOUT_2_BIG -> 2;
            case LAYOUT_3_H, LAYOUT_3_V, LAYOUT_3_MAIN -> 3;
            case LAYOUT_4_GRID, LAYOUT_4_MAIN, LAYOUT_4_STAG -> 4;
            default -> 6;
        };
    }

    /** 布局的可拖轴：type=0 竖线 / 1 横线，第 index 条（按 0-1 位置） */
    public static int[][] axesOf(int type) {
        return switch (type) {
            case LAYOUT_2_SIDE, LAYOUT_2_BIG -> new int[][]{{0, 0}};
            case LAYOUT_2_STACK -> new int[][]{{1, 0}};
            case LAYOUT_3_H -> new int[][]{{1, 0}, {1, 1}};
            case LAYOUT_3_V -> new int[][]{{0, 0}, {0, 1}};
            case LAYOUT_3_MAIN, LAYOUT_4_GRID -> new int[][]{{0, 0}, {1, 0}};
            case LAYOUT_4_MAIN -> new int[][]{{0, 0}, {1, 0}, {1, 1}};
            case LAYOUT_4_STAG -> new int[][]{{0, 0}, {1, 0}};
            case LAYOUT_6_23 -> new int[][]{{0, 0}, {1, 0}, {1, 1}};
            default -> new int[][]{{0, 0}, {0, 1}, {1, 0}};
        };
    }

    public static double[] defaultAxes(int type) {
        return switch (type) {
            case LAYOUT_2_SIDE, LAYOUT_2_STACK, LAYOUT_3_MAIN,
                 LAYOUT_4_GRID, LAYOUT_6_23 -> new double[]{0.5, 0.5, 0.5};
            case LAYOUT_2_BIG -> new double[]{0.62};
            case LAYOUT_3_H, LAYOUT_3_V -> new double[]{1.0 / 3.0, 2.0 / 3.0, 0.5};
            case LAYOUT_4_MAIN -> new double[]{0.5, 1.0 / 3.0, 2.0 / 3.0};
            case LAYOUT_4_STAG -> new double[]{0.66, 0.66, 0.5};
            case LAYOUT_6_32 -> new double[]{1.0 / 3.0, 2.0 / 3.0, 0.5};
            default -> new double[]{0.5, 0.5, 0.5};
        };
    }

    /** 由布局类型 + 轴位置计算各格坐标，返回 [x,y,w,h]（0-1 相对） */
    public static double[][] buildSlots(int type, double[] a) {
        double x0 = a[0], y0 = a.length > 1 ? a[1] : 0.5, y1 = a.length > 2 ? a[2] : 0.5;
        return switch (type) {
            case LAYOUT_2_SIDE -> new double[][]{{0, 0, x0, 1}, {x0, 0, 1 - x0, 1}};
            case LAYOUT_2_STACK -> new double[][]{{0, 0, 1, x0}, {0, x0, 1, 1 - x0}};
            case LAYOUT_2_BIG -> new double[][]{{0, 0, x0, 1}, {x0, 0, 1 - x0, 1}};
            case LAYOUT_3_H -> new double[][]{
                    {0, 0, 1, x0}, {0, x0, 1, y0 - x0}, {0, y0, 1, 1 - y0}};
            case LAYOUT_3_V -> new double[][]{
                    {0, 0, x0, 1}, {x0, 0, y0 - x0, 1}, {y0, 0, 1 - y0, 1}};
            case LAYOUT_3_MAIN -> new double[][]{
                    {0, 0, x0, 1}, {x0, 0, 1 - x0, y0}, {x0, y0, 1 - x0, 1 - y0}};
            case LAYOUT_4_GRID -> new double[][]{
                    {0, 0, x0, y0}, {x0, 0, 1 - x0, y0},
                    {0, y0, x0, 1 - y0}, {x0, y0, 1 - x0, 1 - y0}};
            case LAYOUT_4_MAIN -> new double[][]{
                    {0, 0, x0, 1}, {x0, 0, 1 - x0, y0},
                    {x0, y0, 1 - x0, y1 - y0}, {x0, y1, 1 - x0, 1 - y1}};
            case LAYOUT_4_STAG -> new double[][]{
                    {0, 0, x0, y0}, {x0, 0, 1 - x0, y0},
                    {x0, y0, 1 - x0, 1 - y0}, {0, y0, x0, 1 - y0}};
            case LAYOUT_6_23 -> new double[][]{
                    {0, 0, x0, y0}, {x0, 0, 1 - x0, y0},
                    {0, y0, x0, y1 - y0}, {x0, y0, 1 - x0, y1 - y0},
                    {0, y1, x0, 1 - y1}, {x0, y1, 1 - x0, 1 - y1}};
            case LAYOUT_6_32 -> new double[][]{
                    {0, 0, x0, y0}, {x0, 0, y0 - x0, y0}, {y0, 0, 1 - y0, y0},
                    {0, y0, x0, 1 - y0}, {x0, y0, y0 - x0, 1 - y0}, {y0, y0, 1 - y0, 1 - y0}};
            default -> new double[][]{{0, 0, 0.5, 0.5}, {0.5, 0, 0.5, 0.5},
                    {0, 0.5, 0.5, 0.5}, {0.5, 0.5, 0.5, 0.5},
                    {0, 0, 0.5, 1}, {0.5, 0, 0.5, 1}};
        };
    }
}
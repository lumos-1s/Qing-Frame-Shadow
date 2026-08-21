package com.qingframe.core;

/**
 * 拼图预览视图几何计算（纯数学，可单测）：适配缩放 + 显示硬上限 + 平移钳制。
 * FX 节点操作留在控制器，这里只做数值计算，保证布局反馈死循环的防护逻辑可被测试锁定。
 */
public class PuzzleViewMath {

    /** 显示边长硬上限：防止任何异常路径把显示尺寸推到画布渲染缓冲极限 */
    public static final double MAX_DISPLAY_EDGE = 16000.0;
    /** 视口小于该值视为未完成布局，不计算 */
    private static final double MIN_VIEWPORT_EDGE = 10.0;
    /** 缩放 ≤ 此值视为未放大，平移归零 */
    public static final double ZOOM_IDLE_EPSILON = 1.001;

    private PuzzleViewMath() {}

    /**
     * 计算图片在视口内的适配显示尺寸。
     *
     * @param cw/ch 视口尺寸；iw/ih 图片尺寸；zoom 用户整体缩放倍数
     * @return [scale, fitW, fitH]；输入非法（NaN/无穷/非正/视口过小）返回 null
     */
    public static double[] fit(double cw, double ch, double iw, double ih, double zoom) {
        if (!isFinite(cw) || !isFinite(ch) || !isFinite(iw) || !isFinite(ih)) return null;
        if (cw <= MIN_VIEWPORT_EDGE || ch <= MIN_VIEWPORT_EDGE) return null;
        if (iw <= 0 || ih <= 0) return null;
        double s = Math.min(cw / iw, ch / ih) * zoom;
        if (!isFinite(s) || s <= 0) return null;
        if (iw * s > MAX_DISPLAY_EDGE || ih * s > MAX_DISPLAY_EDGE) {
            s = Math.min(MAX_DISPLAY_EDGE / iw, MAX_DISPLAY_EDGE / ih);
        }
        return new double[]{s, iw * s, ih * s};
    }

    /**
     * 平移钳制：未放大时归零；放大后限制在超出视口的范围内。
     *
     * @return [tx, ty]
     */
    public static double[] clampTranslate(double tx, double ty,
                                          double fitW, double fitH,
                                          double viewportW, double viewportH,
                                          double zoom) {
        double ovfX = Math.max(0, fitW - viewportW) / 2;
        double ovfY = Math.max(0, fitH - viewportH) / 2;
        if (zoom <= ZOOM_IDLE_EPSILON) { tx = 0; ty = 0; }
        return new double[]{clamp(tx, -ovfX, ovfX), clamp(ty, -ovfY, ovfY)};
    }

    private static boolean isFinite(double v) { return Double.isFinite(v); }

    private static double clamp(double v, double lo, double hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}

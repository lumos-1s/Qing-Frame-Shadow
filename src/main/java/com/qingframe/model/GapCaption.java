package com.qingframe.model;

/**
 * 拼图间隙电影字幕：绑定一条分割间隙，复用装饰面板的文字样式字段。
 * gapId 规则："H0"/"H1"=横向分割轴（上下格子之间），"V0"/"V1"=竖向分割轴（左右格子之间），
 * 数字为 PuzzlrConfig.axesOf 中的轴下标；布局切换后轴不存在则该字幕自动删除。
 */
public class GapCaption {
    private String gapId;
    private String textContent = "";
    private String textContent2 = "";
    private String fontFamily = "Microsoft YaHei";
    /** 字号，相对 GAP_BASE_EDGE=4000 长边的像素值 */
    private double fontSize = 60;
    private String fontFamily2 = "Microsoft YaHei";
    private double fontSize2 = 60;
    private String colorHex = "#FFFFFF";
    /** 半透明黑色电影字幕底条 */
    private boolean bgBar = false;
    /** 两行文字间距（相对最大字号的倍数，默认 0.25） */
    private double lineSpacing = 0.25;

    public String getGapId() { return gapId; }
    public void setGapId(String gapId) { this.gapId = gapId; }
    public String getTextContent() { return textContent; }
    public void setTextContent(String textContent) { this.textContent = textContent; }
    public String getTextContent2() { return textContent2; }
    public void setTextContent2(String textContent2) { this.textContent2 = textContent2; }
    public String getFontFamily() { return fontFamily; }
    public void setFontFamily(String fontFamily) { this.fontFamily = fontFamily; }
    public double getFontSize() { return fontSize; }
    public void setFontSize(double fontSize) { this.fontSize = fontSize; }
    public String getFontFamily2() { return fontFamily2; }
    public void setFontFamily2(String fontFamily2) { this.fontFamily2 = fontFamily2; }
    public double getFontSize2() { return fontSize2; }
    public void setFontSize2(double fontSize2) { this.fontSize2 = fontSize2; }
    public double getLineSpacing() { return lineSpacing; }
    public void setLineSpacing(double lineSpacing) { this.lineSpacing = lineSpacing; }
    public String getColorHex() { return colorHex; }
    public void setColorHex(String colorHex) { this.colorHex = colorHex; }
    public boolean isBgBar() { return bgBar; }
    public void setBgBar(boolean bgBar) { this.bgBar = bgBar; }
}

package com.qingframe.model;

public class LayerBorder {
    private boolean visible;
    private int marginTop;
    private int marginBottom;
    private int marginLeft;
    private int marginRight;
    private FillConfig fillConfig;
    private StrokeConfig strokeConfig;
    private ShadowGlowConfig shadowGlowConfig;

    public LayerBorder() {
        this.visible = true;
        this.marginTop = 0;
        this.marginBottom = 0;
        this.marginLeft = 0;
        this.marginRight = 0;
        this.fillConfig = new FillConfig();
        this.strokeConfig = new StrokeConfig();
        this.shadowGlowConfig = new ShadowGlowConfig();
    }

    public boolean isVisible() { return visible; }
    public void setVisible(boolean visible) { this.visible = visible; }
    public int getMarginTop() { return marginTop; }
    public void setMarginTop(int marginTop) { this.marginTop = marginTop; }
    public int getMarginBottom() { return marginBottom; }
    public void setMarginBottom(int marginBottom) { this.marginBottom = marginBottom; }
    public int getMarginLeft() { return marginLeft; }
    public void setMarginLeft(int marginLeft) { this.marginLeft = marginLeft; }
    public int getMarginRight() { return marginRight; }
    public void setMarginRight(int marginRight) { this.marginRight = marginRight; }
    public FillConfig getFillConfig() { return fillConfig; }
    public void setFillConfig(FillConfig fillConfig) { this.fillConfig = fillConfig; }
    public StrokeConfig getStrokeConfig() { return strokeConfig; }
    public void setStrokeConfig(StrokeConfig strokeConfig) { this.strokeConfig = strokeConfig; }
    public ShadowGlowConfig getShadowGlowConfig() { return shadowGlowConfig; }
    public void setShadowGlowConfig(ShadowGlowConfig shadowGlowConfig) { this.shadowGlowConfig = shadowGlowConfig; }
}

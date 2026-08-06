package com.qingframe.model;

public class BaseMargin {
    private int marginLock;
    private int marginTop;
    private int marginBottom;
    private int marginLeft;
    private int marginRight;
    private double imgScale;
    private int imgOffsetX;
    private int imgOffsetY;
    private int bgBlurEnable;
    private int bgBlurRadius;
    private int bgBlurWhiteOverlay;

    public BaseMargin() {
        this.marginLock = 0;
        this.marginTop = 80;
        this.marginBottom = 120;
        this.marginLeft = 80;
        this.marginRight = 80;
        this.imgScale = 1.0;
        this.imgOffsetX = 0;
        this.imgOffsetY = 0;
        this.bgBlurEnable = 0;
        this.bgBlurRadius = 30;
        this.bgBlurWhiteOverlay = 0;
    }

    public int getTotalLeft() { return marginLeft; }
    public int getTotalRight() { return marginRight; }
    public int getTotalTop() { return marginTop; }
    public int getTotalBottom() { return marginBottom; }

    public int getMarginLock() { return marginLock; }
    public void setMarginLock(int marginLock) { this.marginLock = marginLock; }
    public int getMarginTop() { return marginTop; }
    public void setMarginTop(int marginTop) { this.marginTop = marginTop; }
    public int getMarginBottom() { return marginBottom; }
    public void setMarginBottom(int marginBottom) { this.marginBottom = marginBottom; }
    public int getMarginLeft() { return marginLeft; }
    public void setMarginLeft(int marginLeft) { this.marginLeft = marginLeft; }
    public int getMarginRight() { return marginRight; }
    public void setMarginRight(int marginRight) { this.marginRight = marginRight; }
    public double getImgScale() { return imgScale; }
    public void setImgScale(double imgScale) { this.imgScale = imgScale; }
    public int getImgOffsetX() { return imgOffsetX; }
    public void setImgOffsetX(int imgOffsetX) { this.imgOffsetX = imgOffsetX; }
    public int getImgOffsetY() { return imgOffsetY; }
    public void setImgOffsetY(int imgOffsetY) { this.imgOffsetY = imgOffsetY; }
    public int getBgBlurEnable() { return bgBlurEnable; }
    public void setBgBlurEnable(int bgBlurEnable) { this.bgBlurEnable = bgBlurEnable; }
    public int getBgBlurRadius() { return bgBlurRadius; }
    public void setBgBlurRadius(int bgBlurRadius) { this.bgBlurRadius = bgBlurRadius; }
    public int getBgBlurWhiteOverlay() { return bgBlurWhiteOverlay; }
    public void setBgBlurWhiteOverlay(int bgBlurWhiteOverlay) { this.bgBlurWhiteOverlay = bgBlurWhiteOverlay; }
}

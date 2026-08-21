package com.qingframe.model;

/** 拼图格子：图片引用 + 格内显示（偏移/缩放/填充方式） */
public class SlotConfig {
    private String imagePath;
    private double offsetX;
    private double offsetY;
    private double zoom;
    private int fillMode;

    public SlotConfig() {
        this.imagePath = null;
        this.offsetX = 0.5;
        this.offsetY = 0.5;
        this.zoom = 1.0;
        this.fillMode = 0;
    }

    public String getImagePath() { return imagePath; }
    public void setImagePath(String imagePath) { this.imagePath = imagePath; }
    public double getOffsetX() { return offsetX; }
    public void setOffsetX(double offsetX) { this.offsetX = offsetX; }
    public double getOffsetY() { return offsetY; }
    public void setOffsetY(double offsetY) { this.offsetY = offsetY; }
    public double getZoom() { return zoom; }
    public void setZoom(double zoom) { this.zoom = zoom; }
    public int getFillMode() { return fillMode; }
    public void setFillMode(int fillMode) { this.fillMode = fillMode; }
}
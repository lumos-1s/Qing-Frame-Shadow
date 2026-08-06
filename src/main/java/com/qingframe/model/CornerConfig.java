package com.qingframe.model;

public class CornerConfig {
    private int cornerLock;
    private double cornerRadiusAll;
    private double cornerRadiusTL;
    private double cornerRadiusTR;
    private double cornerRadiusBL;
    private double cornerRadiusBR;
    private String shapeType;
    private String customShapeSvg;

    public CornerConfig() {
        this.cornerLock = 1;
        this.cornerRadiusAll = 250;
        this.cornerRadiusTL = 20;
        this.cornerRadiusTR = 20;
        this.cornerRadiusBL = 20;
        this.cornerRadiusBR = 20;
        this.shapeType = "rect";
        this.customShapeSvg = "";
    }

    public int getCornerLock() { return cornerLock; }
    public void setCornerLock(int cornerLock) { this.cornerLock = cornerLock; }
    public double getCornerRadiusAll() { return cornerRadiusAll; }
    public void setCornerRadiusAll(double cornerRadiusAll) { this.cornerRadiusAll = cornerRadiusAll; }
    public double getCornerRadiusTL() { return cornerRadiusTL; }
    public void setCornerRadiusTL(double cornerRadiusTL) { this.cornerRadiusTL = cornerRadiusTL; }
    public double getCornerRadiusTR() { return cornerRadiusTR; }
    public void setCornerRadiusTR(double cornerRadiusTR) { this.cornerRadiusTR = cornerRadiusTR; }
    public double getCornerRadiusBL() { return cornerRadiusBL; }
    public void setCornerRadiusBL(double cornerRadiusBL) { this.cornerRadiusBL = cornerRadiusBL; }
    public double getCornerRadiusBR() { return cornerRadiusBR; }
    public void setCornerRadiusBR(double cornerRadiusBR) { this.cornerRadiusBR = cornerRadiusBR; }
    public String getShapeType() { return shapeType; }
    public void setShapeType(String shapeType) { this.shapeType = shapeType; }
    public String getCustomShapeSvg() { return customShapeSvg; }
    public void setCustomShapeSvg(String customShapeSvg) { this.customShapeSvg = customShapeSvg; }
}

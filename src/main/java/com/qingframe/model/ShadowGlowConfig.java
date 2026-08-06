package com.qingframe.model;

public class ShadowGlowConfig {
    private int shadowEnable;
    private double shadowOffsetX;
    private double shadowOffsetY;
    private double shadowBlur;
    private double shadowSpread;
    private String shadowColorHex;
    private double shadowOpacity;
    private int glowEnable;
    private String glowColorHex;
    private double glowBlur;
    private double glowSpread;
    private double glowOpacity;
    private String glowType;

    public ShadowGlowConfig() {
        this.shadowEnable = 0;
        this.shadowOffsetX = 3;
        this.shadowOffsetY = 3;
        this.shadowBlur = 10;
        this.shadowSpread = 0;
        this.shadowColorHex = "#000000";
        this.shadowOpacity = 40;
        this.glowEnable = 0;
        this.glowColorHex = "#ffffff";
        this.glowBlur = 15;
        this.glowSpread = 0;
        this.glowOpacity = 60;
        this.glowType = "outer";
    }

    public int getShadowEnable() { return shadowEnable; }
    public void setShadowEnable(int shadowEnable) { this.shadowEnable = shadowEnable; }
    public double getShadowOffsetX() { return shadowOffsetX; }
    public void setShadowOffsetX(double shadowOffsetX) { this.shadowOffsetX = shadowOffsetX; }
    public double getShadowOffsetY() { return shadowOffsetY; }
    public void setShadowOffsetY(double shadowOffsetY) { this.shadowOffsetY = shadowOffsetY; }
    public double getShadowBlur() { return shadowBlur; }
    public void setShadowBlur(double shadowBlur) { this.shadowBlur = shadowBlur; }
    public double getShadowSpread() { return shadowSpread; }
    public void setShadowSpread(double shadowSpread) { this.shadowSpread = shadowSpread; }
    public String getShadowColorHex() { return shadowColorHex; }
    public void setShadowColorHex(String shadowColorHex) { this.shadowColorHex = shadowColorHex; }
    public double getShadowOpacity() { return shadowOpacity; }
    public void setShadowOpacity(double shadowOpacity) { this.shadowOpacity = shadowOpacity; }
    public int getGlowEnable() { return glowEnable; }
    public void setGlowEnable(int glowEnable) { this.glowEnable = glowEnable; }
    public String getGlowColorHex() { return glowColorHex; }
    public void setGlowColorHex(String glowColorHex) { this.glowColorHex = glowColorHex; }
    public double getGlowBlur() { return glowBlur; }
    public void setGlowBlur(double glowBlur) { this.glowBlur = glowBlur; }
    public double getGlowSpread() { return glowSpread; }
    public void setGlowSpread(double glowSpread) { this.glowSpread = glowSpread; }
    public double getGlowOpacity() { return glowOpacity; }
    public void setGlowOpacity(double glowOpacity) { this.glowOpacity = glowOpacity; }
    public String getGlowType() { return glowType; }
    public void setGlowType(String glowType) { this.glowType = glowType; }
}

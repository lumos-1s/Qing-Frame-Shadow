package com.qingframe.model;

import java.util.ArrayList;
import java.util.List;

public class FillConfig {
    private String fillType;
    private String fillHex;
    private int fillOpacity;
    private String gradientType;
    private double gradientAngle;
    private List<GradientColorStop> gradientStops;
    private int gradientOpacity;
    private String textureSrc;
    private double textureScale;
    private int textureOffsetX;
    private int textureOffsetY;
    private int textureOpacity;
    private String textureBlend;

    public FillConfig() {
        this.fillType = "solid";
        this.fillHex = "#ffffff";
        this.fillOpacity = 100;
        this.gradientType = "linear";
        this.gradientAngle = 0;
        this.gradientStops = new ArrayList<>();
        this.gradientStops.add(new GradientColorStop(0.0, "#ffffff"));
        this.gradientStops.add(new GradientColorStop(1.0, "#cccccc"));
        this.gradientOpacity = 100;
        this.textureSrc = "";
        this.textureScale = 1.0;
        this.textureOffsetX = 0;
        this.textureOffsetY = 0;
        this.textureOpacity = 100;
        this.textureBlend = "normal";
    }

    public String getFillType() { return fillType; }
    public void setFillType(String fillType) { this.fillType = fillType; }
    public String getFillHex() { return fillHex; }
    public void setFillHex(String fillHex) { this.fillHex = fillHex; }
    public int getFillOpacity() { return fillOpacity; }
    public void setFillOpacity(int fillOpacity) { this.fillOpacity = fillOpacity; }
    public String getGradientType() { return gradientType; }
    public void setGradientType(String gradientType) { this.gradientType = gradientType; }
    public double getGradientAngle() { return gradientAngle; }
    public void setGradientAngle(double gradientAngle) { this.gradientAngle = gradientAngle; }
    public List<GradientColorStop> getGradientStops() { return gradientStops; }
    public void setGradientStops(List<GradientColorStop> gradientStops) { this.gradientStops = gradientStops; }
    public int getGradientOpacity() { return gradientOpacity; }
    public void setGradientOpacity(int gradientOpacity) { this.gradientOpacity = gradientOpacity; }
    public String getTextureSrc() { return textureSrc; }
    public void setTextureSrc(String textureSrc) { this.textureSrc = textureSrc; }
    public double getTextureScale() { return textureScale; }
    public void setTextureScale(double textureScale) { this.textureScale = textureScale; }
    public int getTextureOffsetX() { return textureOffsetX; }
    public void setTextureOffsetX(int textureOffsetX) { this.textureOffsetX = textureOffsetX; }
    public int getTextureOffsetY() { return textureOffsetY; }
    public void setTextureOffsetY(int textureOffsetY) { this.textureOffsetY = textureOffsetY; }
    public int getTextureOpacity() { return textureOpacity; }
    public void setTextureOpacity(int textureOpacity) { this.textureOpacity = textureOpacity; }
    public String getTextureBlend() { return textureBlend; }
    public void setTextureBlend(String textureBlend) { this.textureBlend = textureBlend; }

    public static class GradientColorStop {
        private double position;
        private String color;

        public GradientColorStop() {}
        public GradientColorStop(double position, String color) {
            this.position = position;
            this.color = color;
        }

        public double getPosition() { return position; }
        public void setPosition(double position) { this.position = position; }
        public String getColor() { return color; }
        public void setColor(String color) { this.color = color; }
    }
}

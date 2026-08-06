package com.qingframe.model;

public class LightEffect {
    private int vignetteEnable;
    private double vignetteStrength;
    private double vignetteFeather;
    private int lightLeakEnable;
    private String lightLeakType;
    private double lightLeakOpacity;
    private double lightLeakAngle;
    private double filmGrainEnable;
    private double filmGrainIntensity;

    public LightEffect() {
        this.vignetteEnable = 0;
        this.vignetteStrength = 35;
        this.vignetteFeather = 50;
        this.lightLeakEnable = 0;
        this.lightLeakType = "warm";
        this.lightLeakOpacity = 20;
        this.lightLeakAngle = 45;
        this.filmGrainEnable = 0;
        this.filmGrainIntensity = 10;
    }

    public int getVignetteEnable() { return vignetteEnable; }
    public void setVignetteEnable(int vignetteEnable) { this.vignetteEnable = vignetteEnable; }
    public double getVignetteStrength() { return vignetteStrength; }
    public void setVignetteStrength(double vignetteStrength) { this.vignetteStrength = vignetteStrength; }
    public double getVignetteFeather() { return vignetteFeather; }
    public void setVignetteFeather(double vignetteFeather) { this.vignetteFeather = vignetteFeather; }
    public int getLightLeakEnable() { return lightLeakEnable; }
    public void setLightLeakEnable(int lightLeakEnable) { this.lightLeakEnable = lightLeakEnable; }
    public String getLightLeakType() { return lightLeakType; }
    public void setLightLeakType(String lightLeakType) { this.lightLeakType = lightLeakType; }
    public double getLightLeakOpacity() { return lightLeakOpacity; }
    public void setLightLeakOpacity(double lightLeakOpacity) { this.lightLeakOpacity = lightLeakOpacity; }
    public double getLightLeakAngle() { return lightLeakAngle; }
    public void setLightLeakAngle(double lightLeakAngle) { this.lightLeakAngle = lightLeakAngle; }
    public double getFilmGrainEnable() { return filmGrainEnable; }
    public void setFilmGrainEnable(double filmGrainEnable) { this.filmGrainEnable = filmGrainEnable; }
    public double getFilmGrainIntensity() { return filmGrainIntensity; }
    public void setFilmGrainIntensity(double filmGrainIntensity) { this.filmGrainIntensity = filmGrainIntensity; }
}

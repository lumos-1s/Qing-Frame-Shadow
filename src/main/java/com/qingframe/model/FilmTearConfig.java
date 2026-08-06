package com.qingframe.model;

public class FilmTearConfig {
    private int tearEnable;
    private double tearStrength;
    private double tearDensity;
    private int filmPerforationEnable;
    private String filmPerforationType;
    private double filmPerforationSize;
    private double filmPerforationSpacing;
    private int dustScratchEnable;
    private int dustScratchIntensity;
    private int yellowingEnable;
    private int yellowingStrength;

    public FilmTearConfig() {
        this.tearEnable = 0;
        this.tearStrength = 10;
        this.tearDensity = 50;
        this.filmPerforationEnable = 0;
        this.filmPerforationType = "round";
        this.filmPerforationSize = 15;
        this.filmPerforationSpacing = 30;
        this.dustScratchEnable = 0;
        this.dustScratchIntensity = 20;
        this.yellowingEnable = 0;
        this.yellowingStrength = 15;
    }

    public int getTearEnable() { return tearEnable; }
    public void setTearEnable(int tearEnable) { this.tearEnable = tearEnable; }
    public double getTearStrength() { return tearStrength; }
    public void setTearStrength(double tearStrength) { this.tearStrength = tearStrength; }
    public double getTearDensity() { return tearDensity; }
    public void setTearDensity(double tearDensity) { this.tearDensity = tearDensity; }
    public int getFilmPerforationEnable() { return filmPerforationEnable; }
    public void setFilmPerforationEnable(int filmPerforationEnable) { this.filmPerforationEnable = filmPerforationEnable; }
    public String getFilmPerforationType() { return filmPerforationType; }
    public void setFilmPerforationType(String filmPerforationType) { this.filmPerforationType = filmPerforationType; }
    public double getFilmPerforationSize() { return filmPerforationSize; }
    public void setFilmPerforationSize(double filmPerforationSize) { this.filmPerforationSize = filmPerforationSize; }
    public double getFilmPerforationSpacing() { return filmPerforationSpacing; }
    public void setFilmPerforationSpacing(double filmPerforationSpacing) { this.filmPerforationSpacing = filmPerforationSpacing; }
    public int getDustScratchEnable() { return dustScratchEnable; }
    public void setDustScratchEnable(int dustScratchEnable) { this.dustScratchEnable = dustScratchEnable; }
    public int getDustScratchIntensity() { return dustScratchIntensity; }
    public void setDustScratchIntensity(int dustScratchIntensity) { this.dustScratchIntensity = dustScratchIntensity; }
    public int getYellowingEnable() { return yellowingEnable; }
    public void setYellowingEnable(int yellowingEnable) { this.yellowingEnable = yellowingEnable; }
    public int getYellowingStrength() { return yellowingStrength; }
    public void setYellowingStrength(int yellowingStrength) { this.yellowingStrength = yellowingStrength; }
}

package com.qingframe.model;

import java.util.ArrayList;
import java.util.List;

public class StrokeConfig {
    private int strokeWidth;
    private String strokePos;
    private String strokeColorHex;
    private int strokeOpacity;
    private List<Double> strokeDashArray;
    private double strokeDashOffset;
    private String strokeFillType;
    private String strokeGradientType;
    private double strokeGradientAngle;
    private List<FillConfig.GradientColorStop> strokeGradientStops;

    public StrokeConfig() {
        this.strokeWidth = 0;
        this.strokePos = "inside";
        this.strokeColorHex = "#222222";
        this.strokeOpacity = 100;
        this.strokeDashArray = new ArrayList<>();
        this.strokeDashOffset = 0;
        this.strokeFillType = "solid";
        this.strokeGradientType = "linear";
        this.strokeGradientAngle = 0;
        this.strokeGradientStops = new ArrayList<>();
    }

    public int getStrokeWidth() { return strokeWidth; }
    public void setStrokeWidth(int strokeWidth) { this.strokeWidth = strokeWidth; }
    public String getStrokePos() { return strokePos; }
    public void setStrokePos(String strokePos) { this.strokePos = strokePos; }
    public String getStrokeColorHex() { return strokeColorHex; }
    public void setStrokeColorHex(String strokeColorHex) { this.strokeColorHex = strokeColorHex; }
    public int getStrokeOpacity() { return strokeOpacity; }
    public void setStrokeOpacity(int strokeOpacity) { this.strokeOpacity = strokeOpacity; }
    public List<Double> getStrokeDashArray() { return strokeDashArray; }
    public void setStrokeDashArray(List<Double> strokeDashArray) { this.strokeDashArray = strokeDashArray; }
    public double getStrokeDashOffset() { return strokeDashOffset; }
    public void setStrokeDashOffset(double strokeDashOffset) { this.strokeDashOffset = strokeDashOffset; }
    public String getStrokeFillType() { return strokeFillType; }
    public void setStrokeFillType(String strokeFillType) { this.strokeFillType = strokeFillType; }
    public String getStrokeGradientType() { return strokeGradientType; }
    public void setStrokeGradientType(String strokeGradientType) { this.strokeGradientType = strokeGradientType; }
    public double getStrokeGradientAngle() { return strokeGradientAngle; }
    public void setStrokeGradientAngle(double strokeGradientAngle) { this.strokeGradientAngle = strokeGradientAngle; }
    public List<FillConfig.GradientColorStop> getStrokeGradientStops() { return strokeGradientStops; }
    public void setStrokeGradientStops(List<FillConfig.GradientColorStop> strokeGradientStops) { this.strokeGradientStops = strokeGradientStops; }
}

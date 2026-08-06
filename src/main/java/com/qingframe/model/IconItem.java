package com.qingframe.model;

public class IconItem {
    public enum Category {
        BRAND, PHOTO_DECOR, SIMPLE, WEATHER, CUSTOM
    }

    private String id;
    private Category category;
    private String label;
    private String src;
    private double x;
    private double y;
    private double scale;
    private int opacity;
    private int layer;

    public IconItem() {
        this.id = "";
        this.category = Category.CUSTOM;
        this.label = "";
        this.src = "";
        this.x = 0;
        this.y = 0;
        this.scale = 1.0;
        this.opacity = 100;
        this.layer = 0;
    }

    public IconItem(String id, Category category, String label, String src) {
        this.id = id;
        this.category = category;
        this.label = label;
        this.src = src;
        this.x = 0;
        this.y = 0;
        this.scale = 1.0;
        this.opacity = 100;
        this.layer = 0;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public Category getCategory() { return category; }
    public void setCategory(Category category) { this.category = category; }
    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }
    public String getSrc() { return src; }
    public void setSrc(String src) { this.src = src; }
    public double getX() { return x; }
    public void setX(double x) { this.x = x; }
    public double getY() { return y; }
    public void setY(double y) { this.y = y; }
    public double getScale() { return scale; }
    public void setScale(double scale) { this.scale = scale; }
    public int getOpacity() { return opacity; }
    public void setOpacity(int opacity) { this.opacity = opacity; }
    public int getLayer() { return layer; }
    public void setLayer(int layer) { this.layer = layer; }
}

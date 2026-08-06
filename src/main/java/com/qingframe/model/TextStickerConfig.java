package com.qingframe.model;

import java.util.ArrayList;
import java.util.List;

public class TextStickerConfig {
    private List<TextLine> textLines;
    private List<Sticker> stickers;
    private int cornerDecorEnable;
    private String cornerDecorType;
    private double cornerDecorSize;
    private int exifAutoText;

    public TextStickerConfig() {
        this.textLines = new ArrayList<>();
        this.stickers = new ArrayList<>();
        this.cornerDecorEnable = 0;
        this.cornerDecorType = "none";
        this.cornerDecorSize = 30;
        this.exifAutoText = 0;
    }

    public List<TextLine> getTextLines() { return textLines; }
    public void setTextLines(List<TextLine> textLines) { this.textLines = textLines; }
    public List<Sticker> getStickers() { return stickers; }
    public void setStickers(List<Sticker> stickers) { this.stickers = stickers; }
    public int getCornerDecorEnable() { return cornerDecorEnable; }
    public void setCornerDecorEnable(int cornerDecorEnable) { this.cornerDecorEnable = cornerDecorEnable; }
    public String getCornerDecorType() { return cornerDecorType; }
    public void setCornerDecorType(String cornerDecorType) { this.cornerDecorType = cornerDecorType; }
    public double getCornerDecorSize() { return cornerDecorSize; }
    public void setCornerDecorSize(double cornerDecorSize) { this.cornerDecorSize = cornerDecorSize; }
    public int getExifAutoText() { return exifAutoText; }
    public void setExifAutoText(int exifAutoText) { this.exifAutoText = exifAutoText; }

    public static class TextLine {
        private String text;
        private String fontFamily;
        private double fontSize;
        private int fontWeight;
        private double letterSpacing;
        private String colorHex;
        private int opacity;
        private double x;
        private double y;
        private String align;
        private int enableShadow;

        public TextLine() {
            this.text = "";
            this.fontFamily = "Microsoft YaHei";
            this.fontSize = 16;
            this.fontWeight = 400;
            this.letterSpacing = 0;
            this.colorHex = "#000000";
            this.opacity = 100;
            this.x = 0;
            this.y = 0;
            this.align = "bottom";
            this.enableShadow = 0;
        }

        public String getText() { return text; }
        public void setText(String text) { this.text = text; }
        public String getFontFamily() { return fontFamily; }
        public void setFontFamily(String fontFamily) { this.fontFamily = fontFamily; }
        public double getFontSize() { return fontSize; }
        public void setFontSize(double fontSize) { this.fontSize = fontSize; }
        public int getFontWeight() { return fontWeight; }
        public void setFontWeight(int fontWeight) { this.fontWeight = fontWeight; }
        public double getLetterSpacing() { return letterSpacing; }
        public void setLetterSpacing(double letterSpacing) { this.letterSpacing = letterSpacing; }
        public String getColorHex() { return colorHex; }
        public void setColorHex(String colorHex) { this.colorHex = colorHex; }
        public int getOpacity() { return opacity; }
        public void setOpacity(int opacity) { this.opacity = opacity; }
        public double getX() { return x; }
        public void setX(double x) { this.x = x; }
        public double getY() { return y; }
        public void setY(double y) { this.y = y; }
        public String getAlign() { return align; }
        public void setAlign(String align) { this.align = align; }
        public int getEnableShadow() { return enableShadow; }
        public void setEnableShadow(int enableShadow) { this.enableShadow = enableShadow; }
    }

    public static class Sticker {
        private String src;
        private double x;
        private double y;
        private double scale;
        private double rotation;
        private int opacity;

        public Sticker() {
            this.src = "";
            this.x = 0;
            this.y = 0;
            this.scale = 1.0;
            this.rotation = 0;
            this.opacity = 100;
        }

        public String getSrc() { return src; }
        public void setSrc(String src) { this.src = src; }
        public double getX() { return x; }
        public void setX(double x) { this.x = x; }
        public double getY() { return y; }
        public void setY(double y) { this.y = y; }
        public double getScale() { return scale; }
        public void setScale(double scale) { this.scale = scale; }
        public double getRotation() { return rotation; }
        public void setRotation(double rotation) { this.rotation = rotation; }
        public int getOpacity() { return opacity; }
        public void setOpacity(int opacity) { this.opacity = opacity; }
    }
}

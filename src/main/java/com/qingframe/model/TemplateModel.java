package com.qingframe.model;

import java.util.ArrayList;
import java.util.List;

public class TemplateModel {
    private BaseMargin baseMargin;
    private List<LayerBorder> layerList;
    private CornerConfig cornerConfig;
    private FilmTearConfig filmTearConfig;
    private LightEffect lightEffect;
    private TextStickerConfig decorConfig;
    private PuzzlrConfig puzzlrConfig;
    private String templateName;
    private String templateTag;
    private int exportDpi;
    private String canvasRatio;
    private int compareMode;
    private String photoFrameStyle;
    private int photoFrameBorderSize;
    private int paramFontSize;
    private int paramType;
    private String paramPosition;
    private int blurIntensity;

    public TemplateModel() {
        this.baseMargin = new BaseMargin();
        this.layerList = new ArrayList<>();
        LayerBorder defaultLayer = new LayerBorder();
        defaultLayer.getFillConfig().setFillHex("#ffffff");
        layerList.add(defaultLayer);
        this.cornerConfig = new CornerConfig();
        this.filmTearConfig = new FilmTearConfig();
        this.lightEffect = new LightEffect();
        this.decorConfig = new TextStickerConfig();
        this.puzzlrConfig = new PuzzlrConfig();
        this.templateName = "默认模板";
        this.templateTag = "通用";
        this.exportDpi = 300;
        this.canvasRatio = "original";
        this.compareMode = 0;
        this.photoFrameStyle = null;
        this.photoFrameBorderSize = 60;
        this.paramFontSize = 100;
        this.paramType = 0;
        this.paramPosition = "居中";
        this.blurIntensity = 50;
    }

    public BaseMargin getBaseMargin() { return baseMargin; }
    public void setBaseMargin(BaseMargin baseMargin) { this.baseMargin = baseMargin; }
    public List<LayerBorder> getLayerList() { return layerList; }
    public void setLayerList(List<LayerBorder> layerList) { this.layerList = layerList; }
    public CornerConfig getCornerConfig() { return cornerConfig; }
    public void setCornerConfig(CornerConfig cornerConfig) { this.cornerConfig = cornerConfig; }
    public FilmTearConfig getFilmTearConfig() { return filmTearConfig; }
    public void setFilmTearConfig(FilmTearConfig filmTearConfig) { this.filmTearConfig = filmTearConfig; }
    public LightEffect getLightEffect() { return lightEffect; }
    public void setLightEffect(LightEffect lightEffect) { this.lightEffect = lightEffect; }
    public TextStickerConfig getDecorConfig() { return decorConfig; }
    public void setDecorConfig(TextStickerConfig decorConfig) { this.decorConfig = decorConfig; }
    public PuzzlrConfig getPuzzlrConfig() { return puzzlrConfig; }
    public void setPuzzlrConfig(PuzzlrConfig puzzlrConfig) { this.puzzlrConfig = puzzlrConfig; }
    public String getTemplateName() { return templateName; }
    public void setTemplateName(String templateName) { this.templateName = templateName; }
    public String getTemplateTag() { return templateTag; }
    public void setTemplateTag(String templateTag) { this.templateTag = templateTag; }
    public int getExportDpi() { return exportDpi; }
    public void setExportDpi(int exportDpi) { this.exportDpi = exportDpi; }
    public String getCanvasRatio() { return canvasRatio; }
    public void setCanvasRatio(String canvasRatio) { this.canvasRatio = canvasRatio; }
    public int getCompareMode() { return compareMode; }
    public void setCompareMode(int compareMode) { this.compareMode = compareMode; }
    public String getPhotoFrameStyle() { return photoFrameStyle; }
    public void setPhotoFrameStyle(String photoFrameStyle) { this.photoFrameStyle = photoFrameStyle; }
    public int getPhotoFrameBorderSize() { return photoFrameBorderSize; }
    public void setPhotoFrameBorderSize(int photoFrameBorderSize) { this.photoFrameBorderSize = photoFrameBorderSize; }
    public int getParamFontSize() { return paramFontSize; }
    public void setParamFontSize(int paramFontSize) { this.paramFontSize = paramFontSize; }
    public int getParamType() { return paramType; }
    public void setParamType(int paramType) { this.paramType = paramType; }
    public String getParamPosition() { return paramPosition; }
    public void setParamPosition(String paramPosition) { this.paramPosition = paramPosition; }
    public int getBlurIntensity() { return blurIntensity > 0 ? blurIntensity : 50; }
    public void setBlurIntensity(int blurIntensity) { this.blurIntensity = blurIntensity; }
}

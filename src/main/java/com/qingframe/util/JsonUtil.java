package com.qingframe.util;

import com.google.gson.*;
import com.google.gson.reflect.TypeToken;
import com.qingframe.model.*;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Map;

public class JsonUtil {

    private static final Gson gson = new GsonBuilder()
            .setPrettyPrinting()
            .serializeNulls()
            .create();

    public static String toJson(TemplateModel model) {
        return gson.toJson(model);
    }

    public static TemplateModel fromJson(String json) {
        TemplateModel model = gson.fromJson(json, TemplateModel.class);
        normalize(model);
        return model;
    }

    /** 归一化：Gson 反序列化不调用构造器，空/缺字段会留 null，
     *  这里兜底保证 layerList 至少含一个默认图层，避免 getLayerList().get(0) 越界 */
    private static void normalize(TemplateModel model) {
        if (model == null) return;
        if (model.getLayerList() == null || model.getLayerList().isEmpty()) {
            java.util.List<LayerBorder> layers = new java.util.ArrayList<>();
            LayerBorder defaultLayer = new LayerBorder();
            defaultLayer.getFillConfig().setFillHex("#ffffff");
            layers.add(defaultLayer);
            model.setLayerList(layers);
        }
        if (model.getBaseMargin() == null) model.setBaseMargin(new BaseMargin());
        if (model.getCornerConfig() == null) model.setCornerConfig(new CornerConfig());
        if (model.getFilmTearConfig() == null) model.setFilmTearConfig(new FilmTearConfig());
        if (model.getLightEffect() == null) model.setLightEffect(new LightEffect());
        if (model.getDecorConfig() == null) model.setDecorConfig(new TextStickerConfig());
    }

    public static void saveToFile(TemplateModel model, String filePath) throws IOException {
        String json = toJson(model);
        Files.writeString(Paths.get(filePath), json, StandardCharsets.UTF_8);
    }

    public static TemplateModel loadFromFile(String filePath) throws IOException {
        String json = Files.readString(Paths.get(filePath), StandardCharsets.UTF_8);
        return fromJson(json);
    }

    public static boolean isValidTemplate(String json) {
        try {
            TemplateModel model = fromJson(json);
            return model != null && model.getBaseMargin() != null;
        } catch (Exception e) {
            return false;
        }
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> fromJsonMap(String json) {
        try {
            return gson.fromJson(json, new TypeToken<Map<String, Object>>(){}.getType());
        } catch (Exception e) {
            return null;
        }
    }
}

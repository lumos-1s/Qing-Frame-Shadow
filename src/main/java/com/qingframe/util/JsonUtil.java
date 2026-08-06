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
        return gson.fromJson(json, TemplateModel.class);
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

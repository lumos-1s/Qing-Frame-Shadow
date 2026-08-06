package com.qingframe.core;

import java.io.InputStream;
import java.util.*;

public class CameraDatabase {

    private static volatile CameraDatabase instance;

    private final Map<String, String> brandAliases = new HashMap<>();
    private final Map<String, Map<String, String>> brandModels = new HashMap<>();

    public CameraDatabase() {
        loadFromJson();
    }

    public static CameraDatabase getInstance() {
        if (instance == null) {
            synchronized (CameraDatabase.class) {
                if (instance == null) {
                    instance = new CameraDatabase();
                }
            }
        }
        return instance;
    }

    @SuppressWarnings("unchecked")
    private void loadFromJson() {
        try (InputStream is = getClass().getResourceAsStream("/com/qingframe/core/camera-db.json")) {
            if (is == null) {
                System.err.println("[CameraDatabase] camera-db.json not found");
                return;
            }
            String json = new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            Map<String, Object> root = com.qingframe.util.JsonUtil.fromJsonMap(json);
            if (root == null) return;

            List<Map<String, Object>> brandsList = (List<Map<String, Object>>) root.get("brands");
            if (brandsList != null) {
                for (Map<String, Object> entry : brandsList) {
                    String id = (String) entry.get("id");
                    List<String> aliases = (List<String>) entry.get("aliases");
                    if (id != null && aliases != null) {
                        for (String alias : aliases) {
                            brandAliases.put(alias.toLowerCase().trim(), id);
                        }
                    }
                }
            }

            Map<String, Object> modelsObj = (Map<String, Object>) root.get("models");
            if (modelsObj != null) {
                for (Map.Entry<String, Object> e : modelsObj.entrySet()) {
                    String brandId = e.getKey();
                    Map<String, Object> rawModels = (Map<String, Object>) e.getValue();
                    if (rawModels == null) continue;
                    Map<String, String> modelMap = new HashMap<>();
                    for (Map.Entry<String, Object> me : rawModels.entrySet()) {
                        modelMap.put(me.getKey().toLowerCase().trim(), (String) me.getValue());
                    }
                    brandModels.put(brandId, modelMap);
                }
            }
        } catch (Exception e) {
            System.err.println("[CameraDatabase] load error: " + e.getMessage());
        }
    }

    /**
     * Resolve a brand string (from EXIF Make) to canonical brand ID.
     */
    public String resolveBrand(String make) {
        if (make == null || make.isEmpty()) return "";
        String key = make.toLowerCase().trim();
        // Try exact match first
        String found = brandAliases.get(key);
        if (found != null) return found;
        // Try substring match：按别名长度降序，更具体的别名优先，避免短别名误匹配
        String best = null;
        int bestLen = 0;
        for (Map.Entry<String, String> e : brandAliases.entrySet()) {
            if (key.contains(e.getKey()) && e.getKey().length() > bestLen) {
                best = e.getValue();
                bestLen = e.getKey().length();
            }
        }
        if (best != null) return best;
        return make.trim();
    }

    /**
     * Resolve a model string (from EXIF Model) to canonical display name.
     */
    public String resolveModel(String brandId, String model) {
        if (brandId == null || brandId.isEmpty() || model == null || model.isEmpty()) {
            return model != null ? model.trim() : "";
        }
        Map<String, String> models = brandModels.get(brandId);
        if (models == null) return model.trim();
        String key = model.toLowerCase().trim();
        String canonical = models.get(key);
        if (canonical != null) return canonical;

        // 规范化匹配：忽略大小写、空格、连字符、下划线、点、斜杠、括号
        String normKey = normalizeKey(key);
        if (!normKey.equals(key)) {
            for (Map.Entry<String, String> me : models.entrySet()) {
                if (normalizeKey(me.getKey()).equals(normKey)) {
                    return me.getValue();
                }
            }
        }

        // 尝试去掉品牌前缀后再匹配（原始与规范化各一次）
        String stripped = key;
        String prefix = brandId.toLowerCase() + " ";
        if (stripped.startsWith(prefix)) {
            stripped = stripped.substring(prefix.length()).trim();
            canonical = models.get(stripped);
            if (canonical != null) return canonical;
            String normStripped = normalizeKey(stripped);
            for (Map.Entry<String, String> me : models.entrySet()) {
                if (normalizeKey(me.getKey()).equals(normStripped)) {
                    return me.getValue();
                }
            }
        }
        return model.trim();
    }

    /** 规范化型号键：小写并去除空格与常见分隔符 */
    private static String normalizeKey(String s) {
        return s.toLowerCase()
                .replace(" ", "")
                .replace("-", "")
                .replace("_", "")
                .replace(".", "")
                .replace("/", "")
                .replace("(", "")
                .replace(")", "");
    }

    /**
     * Get a fallback model for a brand when no model is available from EXIF.
     */
    public String fallbackModel(String brandId) {
        Map<String, String> models = brandModels.get(brandId);
        if (models == null || models.isEmpty()) return "";
        return models.values().iterator().next();
    }
}

package com.qingframe.network;

import com.qingframe.network.dto.PresetItem;
import com.qingframe.util.JsonUtil;
import com.qingframe.model.TemplateModel;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * 模板市场服务：登录/注册、模板列表/搜索/下载/上传/点赞。
 * 纯逻辑不依赖 UI，供 MarketController / LoginController 调用。
 */
public class PresetMarketService {

    private PresetMarketService() {
    }

    // ────────────── 认证 ──────────────

    public static CompletableFuture<ApiResult> register(String username, String password) {
        return ApiClient.post("/api/auth/register", new LoginBody(username, password));
    }

    public static CompletableFuture<ApiResult> login(String username, String password) {
        return ApiClient.post("/api/auth/login", new LoginBody(username, password));
    }

    public static CompletableFuture<ApiResult> me() {
        return ApiClient.get("/api/auth/me");
    }

    public static void setToken(String token) {
        ApiClient.token = token;
    }

    // ────────────── 模板市场 ──────────────

    public static CompletableFuture<ApiResult> list(int page, int size, String tag, String keyword) {
        StringBuilder sb = new StringBuilder("/api/presets?page=").append(page).append("&size=").append(size);
        if (tag != null && !tag.isEmpty()) sb.append("&tag=").append(urlEncode(tag));
        if (keyword != null && !keyword.isEmpty()) sb.append("&keyword=").append(urlEncode(keyword));
        return ApiClient.get(sb.toString());
    }

    public static CompletableFuture<ApiResult> tags() {
        return ApiClient.get("/api/tags");
    }

    /** 下载模板：返回 contentJson 字符串；失败返回 null */
    public static CompletableFuture<String> downloadContent(Long id) {
        return ApiClient.post("/api/presets/" + id + "/download", null)
                .thenApply(r -> {
                    if (!r.isOk()) return null;
                    JsonObject obj = r.data.getAsJsonObject();
                    return obj.has("contentJson") ? obj.get("contentJson").getAsString() : null;
                });
    }

    public static CompletableFuture<ApiResult> upload(String name, String tag, String description, String contentJson) {
        return ApiClient.post("/api/presets", new UploadBody(name, tag, description, contentJson));
    }

    public static CompletableFuture<ApiResult> delete(Long id) {
        return ApiClient.delete("/api/presets/" + id);
    }

    public static CompletableFuture<ApiResult> like(Long id) {
        return ApiClient.post("/api/presets/" + id + "/like", null);
    }

    public static CompletableFuture<ApiResult> unlike(Long id) {
        return ApiClient.delete("/api/presets/" + id + "/like");
    }

    /** 解析列表接口返回的分页数据 */
    public static com.qingframe.network.dto.PageResult<PresetItem> parsePage(ApiResult r) {
        return ApiClient.parseData(r, ApiClient.pageResultType(PresetItem.class));
    }

    /** 解析 tags 接口返回的标签列表 */
    public static List<String> parseTags(ApiResult r) {
        return ApiClient.parseData(r, new com.google.gson.reflect.TypeToken<List<String>>() {
        }.getType());
    }

    /** 校验并反序列化服务端返回的模板 JSON；非法返回 null（拒绝落盘） */
    public static TemplateModel parseTemplateJson(String contentJson) {
        if (contentJson == null || contentJson.isBlank()) return null;
        if (!JsonUtil.isValidTemplate(contentJson)) return null;
        return JsonUtil.fromJson(contentJson);
    }

    private static String urlEncode(String s) {
        try {
            return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            return s;
        }
    }

    private static class LoginBody {
        private final String username;
        private final String password;

        LoginBody(String username, String password) {
            this.username = username;
            this.password = password;
        }
    }

    private static class UploadBody {
        private final String name;
        private final String tag;
        private final String description;
        private final String contentJson;

        UploadBody(String name, String tag, String description, String contentJson) {
            this.name = name;
            this.tag = tag;
            this.description = description;
            this.contentJson = contentJson;
        }
    }
}

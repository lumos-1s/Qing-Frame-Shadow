package com.qingframe.network;

import com.qingframe.network.dto.PresetItem;
import com.qingframe.util.JsonUtil;
import com.qingframe.model.TemplateModel;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * 模板市场服务：登录/注册、模板列表/搜索/下载/上传/点赞。
 * 纯逻辑不依赖 UI，供 MarketController / LoginController 调用。
 */
public class PresetMarketService {

    private PresetMarketService() {
    }

    // ────────────── 认证 ──────────────

    public static CompletableFuture<ApiResult> register(String username, String password, String email) {
        return ApiClient.post("/api/auth/register", new RegisterBody(username, password, email));
    }

    public static CompletableFuture<ApiResult> login(String username, String password) {
        return ApiClient.post("/api/auth/login", new LoginBody(username, password));
    }

    /** 忘记密码第一步：发送验证码到邮箱 */
    public static CompletableFuture<ApiResult> forgotPassword(String email) {
        return ApiClient.post("/api/auth/forgot-password", java.util.Map.of("email", email));
    }

    /** 忘记密码第二步：邮箱 + 验证码 + 新密码重置 */
    public static CompletableFuture<ApiResult> resetPassword(String email, String code, String newPassword) {
        return ApiClient.post("/api/auth/reset-password",
                java.util.Map.of("email", email, "code", code, "newPassword", newPassword));
    }

    public static CompletableFuture<ApiResult> me() {
        return ApiClient.get("/api/auth/me");
    }

    /** 更新个人资料：昵称 / 头像（base64 data URL）/ 邮箱，null 字段不修改 */
    public static CompletableFuture<ApiResult> updateProfile(String nickname, String avatar, String email) {
        Map<String, String> body = new java.util.HashMap<>();
        if (nickname != null) body.put("nickname", nickname);
        if (avatar != null) body.put("avatar", avatar);
        if (email != null) body.put("email", email);
        return ApiClient.put("/api/auth/profile", body);
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
                    if (!r.isOk() || r.data == null || !r.data.isJsonObject()) return null;
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

    private static class RegisterBody {
        private final String username;
        private final String password;
        private final String email;

        RegisterBody(String username, String password, String email) {
            this.username = username;
            this.password = password;
            this.email = email;
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

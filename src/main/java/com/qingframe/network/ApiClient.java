package com.qingframe.network;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.reflect.TypeToken;

import java.lang.reflect.Type;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * 清框影服务端 API 客户端（JDK 内置 HttpClient，零新依赖）。
 * 统一响应格式：{ "code": 0, "message": "ok", "data": {...} }。
 * 所有方法异步执行，回调线程非 JavaFX 主线程，更新 UI 必须 Platform.runLater。
 */
public final class ApiClient {

    private static final Gson GSON = new Gson();
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    /** 服务端地址，可在设置面板修改 */
    public static volatile String BASE_URL = "http://localhost:8080";

    /** 当前登录 token，未登录为 null */
    public static volatile String token = null;

    private ApiClient() {
    }

    public static boolean isLoggedIn() {
        return token != null && !token.isEmpty();
    }

    public static CompletableFuture<ApiResult> get(String path) {
        return request("GET", path, null);
    }

    public static CompletableFuture<ApiResult> post(String path, Object body) {
        return request("POST", path, body);
    }

    public static CompletableFuture<ApiResult> put(String path, Object body) {
        return request("PUT", path, body);
    }

    public static CompletableFuture<ApiResult> delete(String path) {
        return request("DELETE", path, null);
    }

    private static CompletableFuture<ApiResult> request(String method, String path, Object body) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(BASE_URL + path))
                .timeout(Duration.ofSeconds(10));
        if (token != null && !token.isEmpty()) {
            builder.header("Authorization", "Bearer " + token);
        }
        if (body != null) {
            builder.header("Content-Type", "application/json; charset=UTF-8");
            builder.method(method, HttpRequest.BodyPublishers.ofString(GSON.toJson(body), java.nio.charset.StandardCharsets.UTF_8));
        } else {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        }
        return HTTP.sendAsync(builder.build(), HttpResponse.BodyHandlers.ofString(java.nio.charset.StandardCharsets.UTF_8))
                .thenApply(ApiClient::parse);
    }

    private static ApiResult parse(HttpResponse<String> resp) {
        ApiResult result = new ApiResult();
        result.httpStatus = resp.statusCode();
        String body = resp.body();
        try {
            JsonObject obj = GSON.fromJson(body, JsonObject.class);
            if (obj != null && obj.has("code")) {
                result.code = obj.get("code").getAsInt();
                if (obj.has("message")) result.message = obj.get("message").getAsString();
                if (obj.has("data") && !obj.get("data").isJsonNull()) {
                    result.data = obj.get("data");
                }
            } else {
                result.code = -1;
                result.message = "服务器响应格式异常";
            }
        } catch (Exception e) {
            result.code = -1;
            result.message = "服务器响应解析失败 (HTTP " + resp.statusCode() + ")";
        }
        // 401：token 失效，自动登出
        if (result.code == 401 || result.httpStatus == 401) {
            token = null;
        }
        return result;
    }

    /** 解析 data 为指定类型（如 PageResult、Map） */
    public static <T> T parseData(ApiResult result, Type type) {
        if (result == null || result.data == null) return null;
        return GSON.fromJson(result.data, type);
    }

    public static <T> T parseData(ApiResult result, Class<T> clazz) {
        if (result == null || result.data == null) return null;
        return GSON.fromJson(result.data, clazz);
    }

    public static Type pageResultType(Type itemType) {
        return TypeToken.getParameterized(com.qingframe.network.dto.PageResult.class, itemType).getType();
    }

    public static Type stringMapType() {
        return new TypeToken<Map<String, Object>>() {
        }.getType();
    }
}

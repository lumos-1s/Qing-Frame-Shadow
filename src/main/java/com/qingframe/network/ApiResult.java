package com.qingframe.network;

import com.google.gson.JsonElement;

/** API 统一响应结果：{ code, message, data } + 原始 HTTP 状态码 */
public class ApiResult {

    public int code;
    public String message;
    public JsonElement data;
    public int httpStatus;

    public boolean isOk() {
        return code == 0;
    }

    public String errorMessage() {
        return message == null || message.isEmpty() ? ("HTTP " + httpStatus) : message;
    }
}

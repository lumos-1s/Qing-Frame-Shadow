package com.qingframe.server.util;

/** 统一响应格式：{ "code": 0, "message": "ok", "data": {...} } */
public class Result {

    private int code;
    private String message;
    private Object data;

    public Result() {
    }

    public Result(int code, String message, Object data) {
        this.code = code;
        this.message = message;
        this.data = data;
    }

    public static Result ok(Object data) {
        return new Result(0, "ok", data);
    }

    public static Result ok() {
        return new Result(0, "ok", null);
    }

    public static Result error(String message) {
        return new Result(1, message, null);
    }

    public static Result error(int code, String message) {
        return new Result(code, message, null);
    }

    public int getCode() { return code; }
    public void setCode(int code) { this.code = code; }
    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }
    public Object getData() { return data; }
    public void setData(Object data) { this.data = data; }
}

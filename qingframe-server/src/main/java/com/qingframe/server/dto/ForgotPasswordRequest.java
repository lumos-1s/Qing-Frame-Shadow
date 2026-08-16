package com.qingframe.server.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;

/** 发送重置验证码请求：仅邮箱 */
public class ForgotPasswordRequest {

    @NotBlank(message = "邮箱不能为空")
    @Email(message = "邮箱格式不正确")
    private String email;

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
}

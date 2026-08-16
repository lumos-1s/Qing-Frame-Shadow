package com.qingframe.server.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 重置密码请求：用户名 + 新密码（忘记密码场景，免登录调用） */
public class ResetPasswordRequest {

    @NotBlank(message = "用户名不能为空")
    private String username;

    @NotBlank(message = "新密码不能为空")
    @Size(min = 6, max = 64, message = "密码长度需在 6-64 之间")
    private String newPassword;

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }
    public String getNewPassword() { return newPassword; }
    public void setNewPassword(String newPassword) { this.newPassword = newPassword; }
}

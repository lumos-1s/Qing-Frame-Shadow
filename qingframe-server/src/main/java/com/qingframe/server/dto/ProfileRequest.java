package com.qingframe.server.dto;

import jakarta.validation.constraints.Size;

/** 个人资料更新请求：昵称 / 头像（base64 data URL） */
public class ProfileRequest {

    @Size(max = 50, message = "昵称最长 50 字")
    private String nickname;

    @Size(max = 2_000_000, message = "头像数据过大（限 2MB）")
    private String avatar;

    public String getNickname() { return nickname; }
    public void setNickname(String nickname) { this.nickname = nickname; }
    public String getAvatar() { return avatar; }
    public void setAvatar(String avatar) { this.avatar = avatar; }
}

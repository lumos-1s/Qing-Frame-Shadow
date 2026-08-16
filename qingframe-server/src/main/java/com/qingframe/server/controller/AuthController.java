package com.qingframe.server.controller;

import com.qingframe.server.dto.LoginRequest;
import com.qingframe.server.dto.ProfileRequest;
import com.qingframe.server.dto.RegisterRequest;
import com.qingframe.server.dto.ResetPasswordRequest;
import com.qingframe.server.entity.User;
import com.qingframe.server.interceptor.BizException;
import com.qingframe.server.interceptor.JwtInterceptor;
import com.qingframe.server.service.AuthService;
import com.qingframe.server.util.Result;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    @PostMapping("/register")
    public Result register(@Valid @RequestBody RegisterRequest req) {
        return Result.ok(authService.register(req));
    }

    @PostMapping("/login")
    public Result login(@Valid @RequestBody LoginRequest req) {
        return Result.ok(authService.login(req));
    }

    @GetMapping("/me")
    public Result me(HttpServletRequest request) {
        Long userId = (Long) request.getAttribute(JwtInterceptor.ATTR_USER_ID);
        if (userId == null) {
            throw new BizException(401, "未登录");
        }
        User u = authService.me(userId);
        Map<String, Object> data = new HashMap<>();
        data.put("id", u.getId());
        data.put("username", u.getUsername());
        data.put("nickname", u.getNickname());
        data.put("avatar", u.getAvatar());
        data.put("role", u.getRole());
        return Result.ok(data);
    }

    /** 更新个人资料：昵称 / 头像（需登录） */
    @PutMapping("/profile")
    public Result updateProfile(HttpServletRequest request, @RequestBody ProfileRequest req) {
        Long userId = (Long) request.getAttribute(JwtInterceptor.ATTR_USER_ID);
        if (userId == null) {
            throw new BizException(401, "未登录");
        }
        return Result.ok(authService.updateProfile(userId, req));
    }

    /** 忘记密码：用户名 + 新密码直接重置（免登录） */
    @PostMapping("/reset-password")
    public Result resetPassword(@Valid @RequestBody ResetPasswordRequest req) {
        authService.resetPassword(req);
        return Result.ok();
    }
}

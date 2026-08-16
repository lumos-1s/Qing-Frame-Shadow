package com.qingframe.server.service;

import com.qingframe.server.dto.LoginRequest;
import com.qingframe.server.dto.RegisterRequest;
import com.qingframe.server.entity.User;
import com.qingframe.server.interceptor.BizException;
import com.qingframe.server.mapper.UserMapper;
import com.qingframe.server.util.JwtUtil;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;

/** 注册 / 登录 / 当前用户：密码只存 BCrypt 哈希，绝不存明文 */
@Service
public class AuthService {

    private final UserMapper userMapper;
    private final JwtUtil jwtUtil;
    private final BCryptPasswordEncoder passwordEncoder = new BCryptPasswordEncoder();

    public AuthService(UserMapper userMapper, JwtUtil jwtUtil) {
        this.userMapper = userMapper;
        this.jwtUtil = jwtUtil;
    }

    /** 注册：先查重，再 BCrypt 加密入库 */
    public Map<String, Object> register(RegisterRequest req) {
        String username = req.getUsername().trim();
        if (userMapper.findByUsername(username) != null) {
            throw new BizException("用户名已存在");
        }
        User user = new User();
        user.setUsername(username);
        // BCrypt 自带随机盐，相同密码两次加密结果不同
        user.setPasswordHash(passwordEncoder.encode(req.getPassword()));
        user.setNickname(username);
        user.setRole("user");
        user.setStatus(1);
        userMapper.insert(user);

        Map<String, Object> data = new HashMap<>();
        data.put("id", user.getId());
        data.put("username", user.getUsername());
        return data;
    }

    /** 登录：查用户 → BCrypt 比对 → 签发 token */
    public Map<String, Object> login(LoginRequest req) {
        User u = userMapper.findByUsername(req.getUsername().trim());
        if (u == null || u.getStatus() == null || u.getStatus() != 1
                || !passwordEncoder.matches(req.getPassword(), u.getPasswordHash())) {
            throw new BizException("用户名或密码错误");
        }
        Map<String, Object> data = new HashMap<>();
        data.put("token", jwtUtil.createToken(u.getId()));
        data.put("expiresIn", jwtUtil.getExpireSeconds());
        return data;
    }

    public User me(Long userId) {
        User u = userMapper.findById(userId);
        if (u == null) {
            throw new BizException(401, "用户不存在或已禁用");
        }
        return u;
    }
}

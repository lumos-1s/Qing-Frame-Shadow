package com.qingframe.server.service;

import com.qingframe.server.dto.LoginRequest;
import com.qingframe.server.dto.ForgotPasswordRequest;
import com.qingframe.server.dto.ProfileRequest;
import com.qingframe.server.dto.RegisterRequest;
import com.qingframe.server.dto.ResetPasswordRequest;
import com.qingframe.server.entity.PasswordReset;
import com.qingframe.server.entity.User;
import com.qingframe.server.interceptor.BizException;
import com.qingframe.server.mapper.PasswordResetMapper;
import com.qingframe.server.mapper.UserMapper;
import com.qingframe.server.util.JwtUtil;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;
import java.time.LocalDateTime;
import java.security.SecureRandom;

/** 注册 / 登录 / 当前用户：密码只存 BCrypt 哈希，绝不存明文 */
@Service
public class AuthService {

    private final UserMapper userMapper;
    private final PasswordResetMapper passwordResetMapper;
    private final MailService mailService;
    private final JwtUtil jwtUtil;
    private final BCryptPasswordEncoder passwordEncoder = new BCryptPasswordEncoder();
    private static final SecureRandom RANDOM = new SecureRandom();

    public AuthService(UserMapper userMapper, PasswordResetMapper passwordResetMapper,
                       MailService mailService, JwtUtil jwtUtil) {
        this.userMapper = userMapper;
        this.passwordResetMapper = passwordResetMapper;
        this.mailService = mailService;
        this.jwtUtil = jwtUtil;
    }

    /** 注册：先查重，再 BCrypt 加密入库 */
    public Map<String, Object> register(RegisterRequest req) {
        String username = req.getUsername().trim();
        if (userMapper.findByUsername(username) != null) {
            throw new BizException("用户名已存在");
        }
        String email = req.getEmail().trim();
        if (userMapper.findByEmail(email) != null) {
            throw new BizException("该邮箱已注册");
        }
        User user = new User();
        user.setUsername(username);
        // BCrypt 自带随机盐，相同密码两次加密结果不同
        user.setPasswordHash(passwordEncoder.encode(req.getPassword()));
        user.setEmail(email);
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

    /** 更新昵称/头像；base64 头像需带 data URL 前缀且解码后不超过 1MB */
    public Map<String, Object> updateProfile(Long userId, ProfileRequest req) {
        User u = userMapper.findById(userId);
        if (u == null) {
            throw new BizException(401, "用户不存在或已禁用");
        }
        String nickname = req.getNickname();
        String avatar = req.getAvatar();
        String email = req.getEmail();
        // 全空请求：直接返回当前资料，避免生成非法 SQL（UPDATE ... SET WHERE）导致 500
        if (nickname == null && avatar == null && email == null) {
            return buildProfileData(u);
        }
        if (nickname != null) {
            nickname = nickname.trim();
            if (nickname.isEmpty()) {
                throw new BizException("昵称不能为空");
            }
            if (nickname.length() > 50) {
                throw new BizException("昵称最长 50 字");
            }
        }
        if (avatar != null && !avatar.isEmpty()) {
            validateAvatar(avatar);
        }
        if (email != null) {
            email = email.trim();
            if (!email.matches("^[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+$")) {
                throw new BizException("邮箱格式不正确");
            }
            User byEmail = userMapper.findByEmail(email);
            if (byEmail != null && !byEmail.getId().equals(userId)) {
                throw new BizException("该邮箱已被其他账号使用");
            }
        }
        userMapper.updateProfile(userId, nickname, avatar, email);

        User updated = userMapper.findById(userId);
        return buildProfileData(updated);
    }

    private Map<String, Object> buildProfileData(User u) {
        Map<String, Object> data = new HashMap<>();
        data.put("id", u.getId());
        data.put("username", u.getUsername());
        data.put("email", u.getEmail());
        data.put("nickname", u.getNickname());
        data.put("avatar", u.getAvatar());
        return data;
    }

    /** 头像必须是 data:image/xxx;base64,... 且解码后不超过 1MB；仅允许位图格式，禁止 SVG 等可执行内容 */
    private static final java.util.Set<String> ALLOWED_AVATAR_TYPES =
            java.util.Set.of("png", "jpeg", "jpg", "webp", "gif");

    private void validateAvatar(String avatar) {
        int comma = avatar.indexOf(',');
        if (!avatar.startsWith("data:image/") || comma <= 0) {
            throw new BizException("头像格式必须是 base64 图片数据");
        }
        String mime = avatar.substring("data:image/".length(), comma);
        if (mime.endsWith(";base64")) {
            mime = mime.substring(0, mime.length() - ";base64".length());
        }
        if (!ALLOWED_AVATAR_TYPES.contains(mime.toLowerCase())) {
            throw new BizException("头像格式仅支持 png/jpeg/webp/gif");
        }
        try {
            byte[] bytes = java.util.Base64.getDecoder().decode(avatar.substring(comma + 1));
            if (bytes.length > 1024 * 1024) {
                throw new BizException("头像图片过大（解码后限 1MB）");
            }
        } catch (IllegalArgumentException e) {
            throw new BizException("头像 base64 数据非法");
        }
    }

    /** 发送重置验证码：生成 6 位码存表，SMTP 可用则发邮件，否则降级返回验证码（仅开发环境） */
    public Map<String, Object> sendResetCode(ForgotPasswordRequest req) {
        String email = req.getEmail().trim();
        User u = userMapper.findByEmail(email);
        if (u == null) {
            throw new BizException("该邮箱未注册");
        }
        if (u.getStatus() == null || u.getStatus() != 1) {
            throw new BizException("账号已被禁用");
        }
        String code = String.format("%06d", RANDOM.nextInt(1_000_000));
        PasswordReset pr = new PasswordReset();
        pr.setUserId(u.getId());
        pr.setEmail(email);
        pr.setCode(code);
        pr.setUsed(0);
        pr.setExpiresAt(LocalDateTime.now().plusMinutes(10));
        passwordResetMapper.insert(pr);

        boolean sent = mailService.sendResetCode(email, code);
        Map<String, Object> data = new HashMap<>();
        data.put("email", email);
        data.put("sent", sent);
        // 安全约束：验证码绝不随响应返回（SMTP 未配置/发送失败时仅返回 sent=false）
        return data;
    }

    /** 校验验证码并重置密码：验证码 10 分钟有效且未使用；原子消费防止并发重复重置 */
    @org.springframework.transaction.annotation.Transactional
    public void resetPassword(ResetPasswordRequest req) {
        String email = req.getEmail().trim();
        User u = userMapper.findByEmail(email);
        if (u == null) {
            throw new BizException("该邮箱未注册");
        }
        PasswordReset pr = passwordResetMapper.findLatestByEmail(email);
        if (pr == null || pr.getUsed() != null && pr.getUsed() == 1) {
            throw new BizException("验证码不存在或已使用，请重新获取");
        }
        if (pr.getExpiresAt() == null || pr.getExpiresAt().isBefore(LocalDateTime.now())) {
            throw new BizException("验证码已过期，请重新获取");
        }
        if (!pr.getCode().equals(req.getCode().trim())) {
            throw new BizException("验证码错误");
        }
        // 原子抢占：仅当仍为未使用状态时标记，失败说明已被其他请求消费
        if (passwordResetMapper.markUsed(pr.getId()) == 0) {
            throw new BizException("验证码已被使用，请重新获取");
        }
        userMapper.updatePassword(u.getId(), passwordEncoder.encode(req.getNewPassword()));
    }
}

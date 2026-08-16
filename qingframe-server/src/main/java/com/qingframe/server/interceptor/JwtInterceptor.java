package com.qingframe.server.interceptor;

import com.qingframe.server.util.JwtUtil;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/** JWT 拦截器：校验 Bearer token，通过后把 userId 放入 request attribute。
 *  公开接口（免登录的 GET 列表/详情/下载）在无 token 时直接放行，不带 userId。 */
@Component
public class JwtInterceptor implements HandlerInterceptor {

    public static final String ATTR_USER_ID = "userId";

    private final JwtUtil jwtUtil;

    public JwtInterceptor(JwtUtil jwtUtil) {
        this.jwtUtil = jwtUtil;
    }

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse resp, Object handler) {
        String auth = req.getHeader("Authorization");
        if (auth == null || !auth.startsWith("Bearer ")) {
            // 无 token：仅放行公开接口（列表/详情/下载）
            if (isPublic(req)) {
                return true;
            }
            throw new BizException(401, "未登录");
        }
        try {
            Long userId = jwtUtil.parseUserId(auth.substring(7));
            req.setAttribute(ATTR_USER_ID, userId);
            return true;
        } catch (Exception e) {
            throw new BizException(401, "登录已过期，请重新登录");
        }
    }

    /** 公开接口：GET /api/presets(列表) / GET /api/presets/{id}(详情) / POST /api/presets/{id}/download(下载) */
    private boolean isPublic(HttpServletRequest req) {
        String path = req.getRequestURI();
        String method = req.getMethod();
        if (path == null || !path.startsWith("/api/presets")) {
            return false;
        }
        if ("GET".equals(method)) {
            // 列表与详情都允许匿名（详情路径为 /api/presets/{id}）
            return true;
        }
        if ("POST".equals(method) && path.endsWith("/download")) {
            return true;
        }
        return false;
    }
}

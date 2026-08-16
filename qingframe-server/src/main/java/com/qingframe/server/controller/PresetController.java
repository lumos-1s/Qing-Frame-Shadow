package com.qingframe.server.controller;

import com.qingframe.server.dto.PresetRequest;
import com.qingframe.server.entity.Preset;
import com.qingframe.server.interceptor.JwtInterceptor;
import com.qingframe.server.service.PresetService;
import com.qingframe.server.util.Result;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/presets")
public class PresetController {

    private final PresetService presetService;

    public PresetController(PresetService presetService) {
        this.presetService = presetService;
    }

    /** 列表（免登录）：分页 + 标签 + 关键字搜索，不返回 contentJson */
    @GetMapping
    public Result list(@RequestParam(defaultValue = "1") int page,
                       @RequestParam(defaultValue = "10") int size,
                       @RequestParam(required = false) String tag,
                       @RequestParam(required = false) String keyword) {
        return Result.ok(presetService.list(tag, keyword, page, size));
    }

    /** 详情（免登录） */
    @GetMapping("/{id}")
    public Result detail(@PathVariable Long id) {
        return Result.ok(presetService.detail(id));
    }

    /** 上传（需登录） */
    @PostMapping
    public Result upload(HttpServletRequest request, @Valid @RequestBody PresetRequest req) {
        Long userId = (Long) request.getAttribute(JwtInterceptor.ATTR_USER_ID);
        return Result.ok(presetService.upload(userId, req));
    }

    /** 更新（本人/admin） */
    @PutMapping("/{id}")
    public Result update(HttpServletRequest request, @PathVariable Long id,
                         @Valid @RequestBody PresetRequest req) {
        Long userId = (Long) request.getAttribute(JwtInterceptor.ATTR_USER_ID);
        presetService.update(userId, id, req);
        return Result.ok();
    }

    /** 删除（本人/admin） */
    @DeleteMapping("/{id}")
    public Result delete(HttpServletRequest request, @PathVariable Long id) {
        Long userId = (Long) request.getAttribute(JwtInterceptor.ATTR_USER_ID);
        presetService.delete(userId, id);
        return Result.ok();
    }

    /** 下载（免登录）：下载数 +1，返回 contentJson */
    @PostMapping("/{id}/download")
    public Result download(@PathVariable Long id, HttpServletRequest request) {
        Long userId = (Long) request.getAttribute(JwtInterceptor.ATTR_USER_ID);
        String ip = request.getRemoteAddr();
        Preset p = presetService.download(id, userId, ip);
        return Result.ok(p);
    }

    /** 点赞（需登录） */
    @PostMapping("/{id}/like")
    public Result like(HttpServletRequest request, @PathVariable Long id) {
        Long userId = (Long) request.getAttribute(JwtInterceptor.ATTR_USER_ID);
        return Result.ok(presetService.like(id, userId));
    }

    /** 取消点赞（需登录） */
    @DeleteMapping("/{id}/like")
    public Result unlike(HttpServletRequest request, @PathVariable Long id) {
        Long userId = (Long) request.getAttribute(JwtInterceptor.ATTR_USER_ID);
        return Result.ok(presetService.unlike(id, userId));
    }
}

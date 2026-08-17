package com.qingframe.server.service;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.qingframe.server.dto.PageResult;
import com.qingframe.server.dto.PresetRequest;
import com.qingframe.server.entity.Preset;
import com.qingframe.server.entity.User;
import com.qingframe.server.interceptor.BizException;
import com.qingframe.server.mapper.PresetMapper;
import com.qingframe.server.mapper.UserMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 模板市场：列表分页 / 搜索 / 详情 / 上传 / 下载 / 删除 / 点赞 */
@Service
public class PresetService {

    private final PresetMapper presetMapper;
    private final UserMapper userMapper;
    private final Gson gson = new Gson();

    public PresetService(PresetMapper presetMapper, UserMapper userMapper) {
        this.presetMapper = presetMapper;
        this.userMapper = userMapper;
    }

    public PageResult<Preset> list(String tag, String keyword, int page, int size) {
        // page 上限 10000：保证 (safePage-1)*safeSize 不溢出（max ≈ 100 万，int 安全）
        int safePage = Math.min(10000, Math.max(1, page));
        int safeSize = Math.min(100, Math.max(1, size));
        int offset = (safePage - 1) * safeSize;
        List<Preset> list = presetMapper.findPage(tag, keyword, offset, safeSize);
        long total = presetMapper.countPage(tag, keyword);
        return new PageResult<>(total, safePage, safeSize, list);
    }

    public Preset detail(Long id) {
        Preset p = presetMapper.findById(id);
        if (p == null) {
            throw new BizException("模板不存在");
        }
        return p;
    }

    /** 上传：校验 contentJson 是合法 JSON 且含必要字段，防止脏数据入库 */
    public Preset upload(Long userId, PresetRequest req) {
        validateContentJson(req.getContentJson());
        Preset p = new Preset();
        p.setUserId(userId);
        p.setName(req.getName().trim());
        p.setTag(req.getTag() == null || req.getTag().isEmpty() ? "其他" : req.getTag().trim());
        p.setDescription(req.getDescription() == null ? "" : req.getDescription().trim());
        p.setContentJson(req.getContentJson());
        presetMapper.insert(p);
        return p;
    }

    /** 更新：本人或 admin 才能改 */
    public void update(Long userId, Long id, PresetRequest req) {
        Preset exist = presetMapper.findById(id);
        if (exist == null) {
            throw new BizException("模板不存在");
        }
        checkOwnerOrAdmin(userId, exist);
        validateContentJson(req.getContentJson());
        Preset p = new Preset();
        p.setId(id);
        p.setName(req.getName().trim());
        p.setTag(req.getTag() == null || req.getTag().isEmpty() ? "其他" : req.getTag().trim());
        p.setDescription(req.getDescription() == null ? "" : req.getDescription().trim());
        p.setContentJson(req.getContentJson());
        presetMapper.update(p);
    }

    /** 删除：本人或 admin 才能删 */
    public void delete(Long userId, Long id) {
        Preset exist = presetMapper.findById(id);
        if (exist == null) {
            throw new BizException("模板不存在");
        }
        checkOwnerOrAdmin(userId, exist);
        presetMapper.delete(id);
    }

    /** 下载：下载数 +1，写下载日志，返回含 contentJson 的完整数据 */
    @Transactional
    public Preset download(Long presetId, Long userId, String ip) {
        Preset p = presetMapper.findById(presetId);
        if (p == null) {
            throw new BizException("模板不存在");
        }
        presetMapper.incDownloadCount(presetId);
        presetMapper.insertDownloadLog(presetId, userId, ip);
        return p;
    }

    /** 点赞 / 取消点赞：用联合唯一键防重复，like_count 同步增减 */
    @Transactional
    public int like(Long presetId, Long userId) {
        Preset p = presetMapper.findById(presetId);
        if (p == null) {
            throw new BizException("模板不存在");
        }
        int inserted = presetMapper.insertLike(presetId, userId);
        if (inserted > 0) {
            presetMapper.incLikeCount(presetId);
        }
        return presetMapper.countLike(presetId, userId);
    }

    @Transactional
    public int unlike(Long presetId, Long userId) {
        int deleted = presetMapper.deleteLike(presetId, userId);
        if (deleted > 0) {
            presetMapper.decLikeCount(presetId);
        }
        return presetMapper.countLike(presetId, userId);
    }

    public List<String> tags() {
        return presetMapper.findTags();
    }

    /** 校验 contentJson：必须是合法 JSON 且含 baseMargin / layerList 必要字段（对应桌面端 JsonUtil.isValidTemplate 思路） */
    private void validateContentJson(String json) {
        if (json == null || json.isBlank()) {
            throw new BizException("contentJson 不能为空");
        }
        try {
            JsonObject obj = gson.fromJson(json, JsonObject.class);
            if (obj == null || !obj.has("baseMargin")) {
                throw new BizException("contentJson 缺少必要字段 baseMargin");
            }
        } catch (Exception e) {
            if (e instanceof BizException) {
                throw (BizException) e;
            }
            throw new BizException("contentJson 不是合法 JSON");
        }
    }

    private void checkOwnerOrAdmin(Long userId, Preset preset) {
        User u = userMapper.findById(userId);
        boolean isAdmin = u != null && "admin".equals(u.getRole());
        if (!isAdmin && !preset.getUserId().equals(userId)) {
            throw new BizException(403, "无权操作该模板");
        }
    }
}

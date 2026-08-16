package com.qingframe.server.controller;

import com.qingframe.server.service.PresetService;
import com.qingframe.server.util.Result;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api")
public class TagController {

    private final PresetService presetService;

    public TagController(PresetService presetService) {
        this.presetService = presetService;
    }

    @GetMapping("/tags")
    public Result tags() {
        List<String> tags = presetService.tags();
        return Result.ok(tags);
    }

    @GetMapping("/health")
    public Result health() {
        return Result.ok("qingframe-server is running");
    }
}

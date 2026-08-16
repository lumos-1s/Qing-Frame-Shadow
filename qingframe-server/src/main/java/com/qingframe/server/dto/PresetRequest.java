package com.qingframe.server.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public class PresetRequest {

    @NotBlank(message = "模板名不能为空")
    @Size(max = 100, message = "模板名最长 100 字")
    private String name;

    @Size(max = 50, message = "标签最长 50 字")
    private String tag;

    @Size(max = 500, message = "描述最长 500 字")
    private String description;

    @NotBlank(message = "contentJson 不能为空")
    private String contentJson;

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getTag() { return tag; }
    public void setTag(String tag) { this.tag = tag; }
    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }
    public String getContentJson() { return contentJson; }
    public void setContentJson(String contentJson) { this.contentJson = contentJson; }
}

package com.qingframe.network.dto;

/** 模板市场条目（对应服务端 preset 表，列表接口不含 contentJson） */
public class PresetItem {

    private Long id;
    private Long userId;
    private String name;
    private String tag;
    private String description;
    private Integer downloadCount;
    private Integer likeCount;
    private String author;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getTag() { return tag; }
    public void setTag(String tag) { this.tag = tag; }
    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }
    public Integer getDownloadCount() { return downloadCount; }
    public void setDownloadCount(Integer downloadCount) { this.downloadCount = downloadCount; }
    public Integer getLikeCount() { return likeCount; }
    public void setLikeCount(Integer likeCount) { this.likeCount = likeCount; }
    public String getAuthor() { return author; }
    public void setAuthor(String author) { this.author = author; }

    /** 列表友好展示：名称 + 作者 + 下载/点赞数 */
    public String displayText() {
        StringBuilder sb = new StringBuilder(name == null ? "" : name);
        if (author != null && !author.isEmpty()) sb.append("  [").append(author).append("]");
        sb.append("  ⬇").append(downloadCount == null ? 0 : downloadCount)
          .append(" ♥").append(likeCount == null ? 0 : likeCount);
        return sb.toString();
    }
}

package com.qingframe.server.dto;

import java.util.List;

/** 分页响应：{ total, page, size, list } */
public class PageResult<T> {

    private long total;
    private int page;
    private int size;
    private List<T> list;

    public PageResult() {
    }

    public PageResult(long total, int page, int size, List<T> list) {
        this.total = total;
        this.page = page;
        this.size = size;
        this.list = list;
    }

    public long getTotal() { return total; }
    public void setTotal(long total) { this.total = total; }
    public int getPage() { return page; }
    public void setPage(int page) { this.page = page; }
    public int getSize() { return size; }
    public void setSize(int size) { this.size = size; }
    public List<T> getList() { return list; }
    public void setList(List<T> list) { this.list = list; }
}

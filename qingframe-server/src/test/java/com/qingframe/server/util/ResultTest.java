package com.qingframe.server.util;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class ResultTest {

    @Test
    void okWrapsData() {
        Result r = Result.ok("hello");
        assertEquals(0, r.getCode());
        assertEquals("ok", r.getMessage());
        assertEquals("hello", r.getData());
    }

    @Test
    void errorWrapsMessage() {
        Result r = Result.error("失败");
        assertEquals(1, r.getCode());
        assertEquals("失败", r.getMessage());
        assertNull(r.getData());
    }

    @Test
    void gsonSerializesShape() {
        String json = new com.google.gson.Gson().toJson(Result.ok(null));
        assertNotNull(json);
        assertEquals(true, json.contains("\"code\":0"));
    }
}

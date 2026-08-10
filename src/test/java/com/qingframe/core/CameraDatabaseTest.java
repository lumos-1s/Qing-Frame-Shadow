package com.qingframe.core;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * 相机品牌库测试：品牌识别、大小写不敏感、未知品牌兜底。
 */
class CameraDatabaseTest {

    @Test
    void resolveKnownBrandReturnsNonEmptyId() {
        String brand = CameraDatabase.getInstance().resolveBrand("Canon");
        assertNotNull(brand);
        assertFalse(brand.isEmpty());
    }

    @Test
    void resolveBrandIsCaseInsensitive() {
        CameraDatabase db = CameraDatabase.getInstance();
        assertEquals(db.resolveBrand("CANON"), db.resolveBrand("canon"));
    }

    @Test
    void resolveUnknownBrandReturnsTrimmedInput() {
        CameraDatabase db = CameraDatabase.getInstance();
        String unknown = "NoSuchBrandXYZ";
        assertEquals(unknown, db.resolveBrand(unknown));
        assertEquals(unknown, db.resolveBrand("  " + unknown + "  "));
    }

    @Test
    void resolveNullAndEmptyReturnEmpty() {
        CameraDatabase db = CameraDatabase.getInstance();
        assertEquals("", db.resolveBrand(null));
        assertEquals("", db.resolveBrand(""));
        assertEquals("", db.resolveBrand("   "));
    }
}

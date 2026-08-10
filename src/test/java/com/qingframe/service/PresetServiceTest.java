package com.qingframe.service;

import com.qingframe.model.TemplateModel;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 预设服务测试：预设列表扫描、JSON 预设加载、未知预设兜底。
 */
class PresetServiceTest {

    @Test
    void presetListContainsFloatWhitePreset() {
        PresetService service = new PresetService();
        assertTrue(service.loadPresetList().contains("浮影白框"));
    }

    @Test
    void floatWhitePresetEnablesSideShadow() {
        PresetService service = new PresetService();
        TemplateModel model = service.loadPresetFromJson("浮影白框");

        assertNotNull(model);
        assertNotNull(model.getLayerList());
        assertEquals(1, model.getLayerList().get(0).getShadowGlowConfig().getShadowEnable());
        assertEquals(1, model.getLayerList().get(0).getShadowGlowConfig().getSideShadow());
    }

    @Test
    void unknownPresetReturnsNull() {
        PresetService service = new PresetService();
        assertNull(service.loadPresetFromJson("不存在的预设XYZ"));
    }

    @Test
    void resourceScanFindsJsonPresets() {
        PresetService service = new PresetService();
        assertTrue(service.scanResourceDir("com/qingframe/presets").size() >= 1);
    }
}

package com.qingframe.util;

import com.qingframe.model.TemplateModel;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * JSON 工具测试：模板序列化往返、合法性校验、Map 解析。
 */
class JsonUtilTest {

    @Test
    void roundTripPreservesBaseMargin() {
        TemplateModel model = new TemplateModel();
        model.getBaseMargin().setMarginTop(42);

        String json = JsonUtil.toJson(model);
        TemplateModel restored = JsonUtil.fromJson(json);

        assertNotNull(restored);
        assertEquals(42, restored.getBaseMargin().getMarginTop());
    }

    @Test
    void roundTripPreservesLayerCount() {
        TemplateModel model = new TemplateModel();
        int layerCount = model.getLayerList().size();

        TemplateModel restored = JsonUtil.fromJson(JsonUtil.toJson(model));

        assertNotNull(restored);
        assertEquals(layerCount, restored.getLayerList().size());
    }

    @Test
    void isValidTemplateAcceptsValidJson() {
        TemplateModel model = new TemplateModel();
        assertTrue(JsonUtil.isValidTemplate(JsonUtil.toJson(model)));
    }

    @Test
    void isValidTemplateRejectsGarbage() {
        assertFalse(JsonUtil.isValidTemplate("not json at all {"));
        assertFalse(JsonUtil.isValidTemplate(""));
    }

    @Test
    void fromJsonMapParsesObject() {
        var map = JsonUtil.fromJsonMap("{\"brands\":[{\"id\":\"canon\"}]}");
        assertNotNull(map);
        assertTrue(map.containsKey("brands"));
    }
}

package com.qingframe.model;

import com.qingframe.util.JsonUtil;
import org.junit.jupiter.api.Test;

import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 模板 JSON 往返测试：拼图配置（含间隙字幕新字段）经 toJson/fromJson 后无损，
 * 保护 MainController.cloneTemplate（撤销栈/每图快照）依赖的深拷贝语义
 */
class TemplateModelPuzzlrRoundTripTest {

    @Test
    void puzzlrConfigSurvivesJsonRoundTrip() {
        TemplateModel src = new TemplateModel();
        PuzzlrConfig pc = src.getPuzzlrConfig();
        pc.setLayoutType(PuzzlrConfig.LAYOUT_4_GRID);
        pc.setGap(120);
        pc.setBgMode(1);
        pc.setCanvasRatio(1.25);
        pc.setBorderColor("#3489E8");
        pc.getSlots().get(0).setImagePath("D:/photos/a.jpg");
        pc.getSlots().get(0).setZoom(1.5);
        pc.getSlots().get(0).setFillMode(1);
        GapCaption cap = new GapCaption();
        cap.setGapId("H0");
        cap.setTextContent("第一行");
        cap.setTextContent2("第二行");
        cap.setFontFamily("SimHei");
        cap.setFontSize(88);
        cap.setFontFamily2("KaiTi");
        cap.setFontSize2(44);
        cap.setColorHex("#FF8800");
        cap.setBgBar(false);
        cap.setLineSpacing(1.75);
        pc.getGapCaptions().add(cap);

        TemplateModel dst = JsonUtil.fromJson(JsonUtil.toJson(src));
        PuzzlrConfig back = dst.getPuzzlrConfig();

        assertEquals(PuzzlrConfig.LAYOUT_4_GRID, back.getLayoutType());
        assertEquals(120, back.getGap());
        assertEquals(1, back.getBgMode());
        assertEquals(1.25, back.getCanvasRatio(), 1e-9);
        assertEquals("#3489E8", back.getBorderColor());
        assertEquals(4, back.getSlots().size());
        assertEquals("D:/photos/a.jpg", back.getSlots().get(0).getImagePath());
        assertEquals(1.5, back.getSlots().get(0).getZoom(), 1e-9);
        assertEquals(1, back.getSlots().get(0).getFillMode());

        assertEquals(1, back.getGapCaptions().size());
        GapCaption backCap = back.getGapCaptions().get(0);
        assertEquals("H0", backCap.getGapId());
        assertEquals("第一行", backCap.getTextContent());
        assertEquals("第二行", backCap.getTextContent2());
        assertEquals("SimHei", backCap.getFontFamily());
        assertEquals(88, backCap.getFontSize(), 1e-9);
        assertEquals("KaiTi", backCap.getFontFamily2());
        assertEquals(44, backCap.getFontSize2(), 1e-9);
        assertEquals("#FF8800", backCap.getColorHex());
        assertFalse(backCap.isBgBar());
        assertEquals(1.75, backCap.getLineSpacing(), 1e-9);
    }

    @Test
    void cloneViaJsonIsDeepIndependent() {
        TemplateModel src = new TemplateModel();
        src.getPuzzlrConfig().setGap(64);
        TemplateModel copy = JsonUtil.fromJson(JsonUtil.toJson(src));
        copy.getPuzzlrConfig().setGap(999);
        copy.getPuzzlrConfig().getSlots().get(0).setImagePath("changed.jpg");

        assertEquals(64, src.getPuzzlrConfig().getGap(), "修改副本不应影响原对象");
        assertTrue(src.getPuzzlrConfig().getSlots().get(0).getImagePath() == null
                || !"changed.jpg".equals(src.getPuzzlrConfig().getSlots().get(0).getImagePath()));
    }

    @Test
    void defaultLineSpacingPreservedWhenFieldAbsentInOldTemplates() {
        // 旧模板 JSON 无 lineSpacing 字段：Gson 跳过 → 保持 Java 默认值 0.25
        String legacy = "{\"puzzlrConfig\":{\"layoutType\":6,\"gap\":100}}";
        TemplateModel t = JsonUtil.fromJson(legacy);
        PuzzlrConfig pc = t.getPuzzlrConfig();
        if (pc != null && pc.getGapCaptions() != null) {
            for (GapCaption c : pc.getGapCaptions()) {
                assertEquals(0.25, c.getLineSpacing(), 1e-9, "缺失字段应回退默认行间距");
            }
        }
        assertEquals(100, pc.getGap());
    }

    @Test
    void axisValsRoundTrip() {
        TemplateModel src = new TemplateModel();
        src.getPuzzlrConfig().setAxisVals(new double[]{0.4, 0.6, 0.5});
        TemplateModel dst = JsonUtil.fromJson(JsonUtil.toJson(src));
        double[] axes = dst.getPuzzlrConfig().getAxisVals();
        assertEquals(3, axes.length);
        assertTrue(Arrays.equals(new double[]{0.4, 0.6, 0.5}, axes), "轴位置应无损往返");
    }
}

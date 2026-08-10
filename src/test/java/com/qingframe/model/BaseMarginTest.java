package com.qingframe.model;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * BaseMargin 边距模型测试：默认值、总边距计算、图片缩放参数。
 */
class BaseMarginTest {

    @Test
    void defaultMarginsMatchPreset() {
        BaseMargin margin = new BaseMargin();
        assertEquals(80, margin.getMarginTop());
        assertEquals(120, margin.getMarginBottom());
        assertEquals(80, margin.getMarginLeft());
        assertEquals(80, margin.getMarginRight());
    }

    @Test
    void totalMarginsReturnConfiguredValues() {
        BaseMargin margin = new BaseMargin();
        margin.setMarginTop(10);
        margin.setMarginBottom(20);
        margin.setMarginLeft(30);
        margin.setMarginRight(40);

        assertEquals(10, margin.getTotalTop());
        assertEquals(20, margin.getTotalBottom());
        assertEquals(30, margin.getTotalLeft());
        assertEquals(40, margin.getTotalRight());
    }

    @Test
    void imageScaleDefaultsToOneAndCanBeChanged() {
        BaseMargin margin = new BaseMargin();
        assertEquals(1.0, margin.getImgScale(), 0.0001);
        margin.setImgScale(0.5);
        assertEquals(0.5, margin.getImgScale(), 0.0001);
    }
}

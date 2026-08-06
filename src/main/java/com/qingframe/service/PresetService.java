package com.qingframe.service;

import com.qingframe.model.BaseMargin;
import com.qingframe.model.CornerConfig;
import com.qingframe.model.FilmTearConfig;
import com.qingframe.model.FillConfig;
import com.qingframe.model.LayerBorder;
import com.qingframe.model.LightEffect;
import com.qingframe.model.ShadowGlowConfig;
import com.qingframe.model.StrokeConfig;
import com.qingframe.model.TemplateModel;
import com.qingframe.model.TextStickerConfig;
import com.qingframe.util.JsonUtil;

import java.io.File;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Random;

/**
 * 预设服务：内置代码预设 / classpath JSON 预设的创建、加载与随机边框生成。
 * 不依赖 UI，供控制器直接调用。
 */
public class PresetService {

    /** 随机边框使用的协调色板（每组 3 色：主色 / 辅色 / 点缀） */
    private static final String[][] COLOR_PALETTES = {
            {"#f7f4ef", "#d8cdb8", "#8b7355"},
            {"#1c1c1e", "#3a3a40", "#c9a24b"},
            {"#ffffff", "#e8e3da", "#b0563f"},
            {"#f2ede4", "#c97b4a", "#7c5a3a"},
            {"#eef1f4", "#7d93a8", "#2f3b4c"},
            {"#f5f0e8", "#6f7d5c", "#3d4632"},
            {"#fdf6ec", "#d9a441", "#8a6d2a"},
            {"#f4ece7", "#7c3a3d", "#4a1f21"}
    };

    /** 内置预设 = 代码预设 + classpath 下的 JSON 预设 + 自动取色 */
    public List<String> loadPresetList() {
        List<String> list = new ArrayList<>(List.of("极简白框", "复古胶片", "拍立得", "证件照", "电影宽屏"));
        for (String name : scanResourceDir("com/qingframe/presets")) {
            if (!list.contains(name)) list.add(name);
        }
        list.add("自动取色边框");
        return list;
    }

    /** 扫描 classpath 指定目录下的 .json 预设文件名（兼容开发目录与打包后 jar） */
    public List<String> scanResourceDir(String path) {
        List<String> names = new ArrayList<>();
        try {
            Enumeration<URL> urls = getClass().getClassLoader().getResources(path);
            while (urls.hasMoreElements()) {
                URL u = urls.nextElement();
                if ("file".equals(u.getProtocol())) {
                    File dir = new File(u.toURI());
                    File[] files = dir.listFiles();
                    if (files != null) {
                        for (File f : files) {
                            if (f.getName().endsWith(".json")) names.add(f.getName().replace(".json", ""));
                        }
                    }
                } else if ("jar".equals(u.getProtocol())) {
                    try (java.util.jar.JarFile jar = ((java.net.JarURLConnection) u.openConnection()).getJarFile()) {
                        jar.stream()
                                .filter(e -> e.getName().startsWith(path + "/") && e.getName().endsWith(".json"))
                                .forEach(e -> names.add(e.getName().substring(path.length() + 1).replace(".json", "")));
                    }
                }
            }
        } catch (Exception ignored) {}
        Collections.sort(names);
        return names;
    }

    /** 从 classpath 的 presets 目录加载 JSON 预设，不存在或解析失败返回 null */
    public TemplateModel loadPresetFromJson(String name) {
        try (InputStream in = getClass().getResourceAsStream("/com/qingframe/presets/" + name + ".json")) {
            if (in == null) return null;
            String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            return JsonUtil.fromJson(json);
        } catch (Exception e) {
            return null;
        }
    }

    /** 一键随机边框：随机组合边距/图层/描边/阴影/圆角/光效/胶片效果 */
    public TemplateModel randomTemplate() {
        Random rnd = new Random();
        TemplateModel t = new TemplateModel();
        BaseMargin m = t.getBaseMargin();
        boolean bottomHeavy = rnd.nextBoolean();
        int pad = 40 + rnd.nextInt(80);
        m.setMarginTop(bottomHeavy ? 50 + rnd.nextInt(70) : pad);
        m.setMarginBottom(bottomHeavy ? 100 + rnd.nextInt(90) : pad);
        m.setMarginLeft(pad);
        m.setMarginRight(pad);
        m.setImgScale(0.86 + rnd.nextDouble() * 0.14);
        m.setMarginLock(0);
        if (rnd.nextInt(100) < 15) {
            m.setBgBlurEnable(1);
            m.setBgBlurRadius(20 + rnd.nextInt(30));
        }

        String[] palette = COLOR_PALETTES[rnd.nextInt(COLOR_PALETTES.length)];
        String bg = palette[rnd.nextInt(palette.length)];
        String accent = palette[rnd.nextInt(palette.length)];

        // 图层1：填充
        LayerBorder l1 = t.getLayerList().get(0);
        FillConfig f1 = l1.getFillConfig();
        int fillKind = rnd.nextInt(10);
        if (fillKind < 6) {
            f1.setFillType("solid");
            f1.setFillHex(bg);
            f1.setFillOpacity(100);
        } else if (fillKind < 8) {
            f1.setFillType("gradient");
            f1.setGradientStops(new ArrayList<>(List.of(
                    new FillConfig.GradientColorStop(0.0, bg),
                    new FillConfig.GradientColorStop(1.0, accent))));
            f1.setGradientAngle(rnd.nextInt(3) * 90);
            f1.setGradientOpacity(100);
        } else {
            f1.setFillType("transparent");
        }

        // 图层1：描边
        StrokeConfig s1 = l1.getStrokeConfig();
        if (rnd.nextInt(100) < 70) {
            s1.setStrokeWidth(1 + rnd.nextInt(7));
            s1.setStrokeColorHex(accent);
            s1.setStrokeOpacity(60 + rnd.nextInt(41));
            if (rnd.nextInt(100) < 25) {
                s1.setStrokeDashArray(new ArrayList<>(List.of(4.0 + rnd.nextInt(6), 2.0 + rnd.nextInt(4))));
            }
        }

        // 图层1：阴影 / 辉光
        ShadowGlowConfig sg1 = l1.getShadowGlowConfig();
        if (rnd.nextInt(100) < 45) {
            sg1.setShadowEnable(1);
            sg1.setShadowOffsetX(2 + rnd.nextInt(6));
            sg1.setShadowOffsetY(2 + rnd.nextInt(6));
            sg1.setShadowBlur(8 + rnd.nextInt(18));
            sg1.setShadowOpacity(15 + rnd.nextInt(40));
        }
        if (rnd.nextInt(100) < 18) {
            sg1.setGlowEnable(1);
            sg1.setGlowColorHex(accent);
            sg1.setGlowBlur(15 + rnd.nextInt(20));
            sg1.setGlowOpacity(40 + rnd.nextInt(40));
        }

        // 图层2：内层细线（45% 概率）
        if (rnd.nextInt(100) < 45) {
            LayerBorder l2 = new LayerBorder();
            l2.getFillConfig().setFillType("transparent");
            int inner = 6 + rnd.nextInt(10);
            l2.setMarginTop(inner);
            l2.setMarginBottom(inner);
            l2.setMarginLeft(inner);
            l2.setMarginRight(inner);
            StrokeConfig s2 = l2.getStrokeConfig();
            s2.setStrokeWidth(1 + rnd.nextInt(3));
            s2.setStrokeColorHex(accent);
            s2.setStrokeOpacity(50 + rnd.nextInt(50));
            t.getLayerList().add(l2);
        }

        // 圆角
        CornerConfig c = t.getCornerConfig();
        double[] radii = {0, 6, 12, 24, 48, 96};
        double r = radii[rnd.nextInt(radii.length)];
        c.setCornerRadiusAll(r);
        c.setCornerRadiusTL(r);
        c.setCornerRadiusTR(r);
        c.setCornerRadiusBL(r);
        c.setCornerRadiusBR(r);
        c.setCornerLock(1);
        c.setShapeType("round");

        // 胶片效果
        FilmTearConfig ft = t.getFilmTearConfig();
        if (rnd.nextInt(100) < 22) {
            ft.setTearEnable(1);
            ft.setTearStrength(8 + rnd.nextInt(20));
            ft.setTearDensity(30 + rnd.nextInt(50));
        }
        if (rnd.nextInt(100) < 25) {
            ft.setFilmPerforationEnable(1);
            ft.setFilmPerforationType(rnd.nextBoolean() ? "round" : "square");
            ft.setFilmPerforationSize(10 + rnd.nextInt(10));
            ft.setFilmPerforationSpacing(24 + rnd.nextInt(16));
        }
        if (rnd.nextInt(100) < 30) {
            ft.setDustScratchEnable(1);
            ft.setDustScratchIntensity(8 + rnd.nextInt(20));
            ft.setYellowingEnable(1);
            ft.setYellowingStrength(8 + rnd.nextInt(20));
        }

        // 光效
        LightEffect le = t.getLightEffect();
        if (rnd.nextInt(100) < 45) {
            le.setVignetteEnable(1);
            le.setVignetteStrength(20 + rnd.nextInt(45));
        }
        if (rnd.nextInt(100) < 30) {
            le.setLightLeakEnable(1);
            le.setLightLeakType(rnd.nextBoolean() ? "warm" : "cool");
            le.setLightLeakOpacity(8 + rnd.nextInt(20));
        }
        if (rnd.nextInt(100) < 35) {
            le.setFilmGrainEnable(1);
            le.setFilmGrainIntensity(6 + rnd.nextInt(18));
        }

        // 装饰
        TextStickerConfig dec = t.getDecorConfig();
        if (rnd.nextInt(100) < 55) dec.setExifAutoText(1);
        if (rnd.nextInt(100) < 25) {
            dec.setCornerDecorEnable(1);
            dec.setCornerDecorType("line");
            dec.setCornerDecorSize(20 + rnd.nextInt(30));
        }
        return t;
    }

    /** 内置代码预设工厂 */
    public TemplateModel createPreset(String name) {
        TemplateModel t = new TemplateModel();
        switch (name) {
            case "极简白框":
                t.getBaseMargin().setMarginTop(60);
                t.getBaseMargin().setMarginBottom(60);
                t.getBaseMargin().setMarginLeft(60);
                t.getBaseMargin().setMarginRight(60);
                t.getBaseMargin().setImgScale(1.0);
                t.getLayerList().get(0).getFillConfig().setFillHex("#ffffff");
                t.getLayerList().get(0).getStrokeConfig().setStrokeWidth(2);
                t.getLayerList().get(0).getStrokeConfig().setStrokeColorHex("#333333");
                break;
            case "复古胶片":
                t.getBaseMargin().setMarginTop(100);
                t.getBaseMargin().setMarginBottom(140);
                t.getBaseMargin().setImgScale(0.90);
                t.getLayerList().get(0).getFillConfig().setFillHex("#f5f0e8");
                t.getLayerList().get(0).getStrokeConfig().setStrokeWidth(4);
                t.getLayerList().get(0).getStrokeConfig().setStrokeColorHex("#8b7355");
                t.getLightEffect().setVignetteEnable(1);
                t.getLightEffect().setVignetteStrength(50);
                t.getFilmTearConfig().setFilmPerforationEnable(1);
                t.getFilmTearConfig().setFilmPerforationType("round");
                t.getFilmTearConfig().setFilmPerforationSize(15);
                t.getFilmTearConfig().setFilmPerforationSpacing(30);
                break;
            case "拍立得":
                t.getBaseMargin().setMarginBottom(200);
                t.getBaseMargin().setMarginTop(80);
                t.getBaseMargin().setMarginLeft(70);
                t.getBaseMargin().setMarginRight(70);
                t.getBaseMargin().setImgScale(0.88);
                t.getLayerList().get(0).getFillConfig().setFillHex("#f0f0f0");
                break;
            case "证件照":
                t.getBaseMargin().setMarginTop(30);
                t.getBaseMargin().setMarginBottom(30);
                t.getBaseMargin().setMarginLeft(30);
                t.getBaseMargin().setMarginRight(30);
                t.getBaseMargin().setImgScale(1.0);
                t.getLayerList().get(0).getFillConfig().setFillHex("#ffffff");
                t.getLayerList().get(0).getStrokeConfig().setStrokeWidth(1);
                t.getLayerList().get(0).getStrokeConfig().setStrokeColorHex("#cccccc");
                break;
            case "电影宽屏":
                t.getBaseMargin().setMarginTop(120);
                t.getBaseMargin().setMarginBottom(120);
                t.getBaseMargin().setMarginLeft(0);
                t.getBaseMargin().setMarginRight(0);
                t.getBaseMargin().setImgScale(1.0);
                t.getLayerList().get(0).getFillConfig().setFillHex("#000000");
                break;
            case "无边框":
                t.getBaseMargin().setMarginTop(0);
                t.getBaseMargin().setMarginBottom(0);
                t.getBaseMargin().setMarginLeft(0);
                t.getBaseMargin().setMarginRight(0);
                t.getBaseMargin().setImgScale(1.0);
                t.getLayerList().get(0).getFillConfig().setFillHex("#ffffff");
                t.getLayerList().get(0).getStrokeConfig().setStrokeWidth(0);
                break;
            case "简约白边":
                t.getBaseMargin().setMarginTop(60);
                t.getBaseMargin().setMarginBottom(60);
                t.getBaseMargin().setMarginLeft(60);
                t.getBaseMargin().setMarginRight(60);
                t.getBaseMargin().setImgScale(1.0);
                t.getLayerList().get(0).getFillConfig().setFillHex("#ffffff");
                t.getLayerList().get(0).getStrokeConfig().setStrokeWidth(2);
                t.getLayerList().get(0).getStrokeConfig().setStrokeColorHex("#333333");
                break;
            case "复古边框":
                t.getBaseMargin().setMarginTop(80);
                t.getBaseMargin().setMarginBottom(80);
                t.getBaseMargin().setMarginLeft(80);
                t.getBaseMargin().setMarginRight(80);
                t.getBaseMargin().setImgScale(0.92);
                t.getLayerList().get(0).getFillConfig().setFillHex("#f5f0e8");
                t.getLayerList().get(0).getStrokeConfig().setStrokeWidth(6);
                t.getLayerList().get(0).getStrokeConfig().setStrokeColorHex("#8b7355");
                break;
            case "圆角边框":
                t.getBaseMargin().setMarginTop(60);
                t.getBaseMargin().setMarginBottom(60);
                t.getBaseMargin().setMarginLeft(60);
                t.getBaseMargin().setMarginRight(60);
                t.getBaseMargin().setImgScale(0.95);
                t.getCornerConfig().setCornerRadiusAll(250);
                t.getLayerList().get(0).getFillConfig().setFillHex("#ffffff");
                t.getLayerList().get(0).getStrokeConfig().setStrokeWidth(2);
                t.getLayerList().get(0).getStrokeConfig().setStrokeColorHex("#999999");
                break;
            case "双线边框":
                t.getBaseMargin().setMarginTop(80);
                t.getBaseMargin().setMarginBottom(80);
                t.getBaseMargin().setMarginLeft(80);
                t.getBaseMargin().setMarginRight(80);
                t.getBaseMargin().setImgScale(0.92);
                // 图层0 是顶层：默认层改造为内层细线
                LayerBorder inner = t.getLayerList().get(0);
                inner.getFillConfig().setFillType("transparent");
                inner.getStrokeConfig().setStrokeWidth(2);
                inner.getStrokeConfig().setStrokeColorHex("#222222");
                inner.setMarginTop(6);
                inner.setMarginBottom(6);
                inner.setMarginLeft(6);
                inner.setMarginRight(6);
                // 底层：外层白底粗线（先画，被内线覆盖）
                LayerBorder outer = new LayerBorder();
                outer.getFillConfig().setFillHex("#ffffff");
                outer.getStrokeConfig().setStrokeWidth(4);
                outer.getStrokeConfig().setStrokeColorHex("#222222");
                t.getLayerList().add(outer);
                break;
            case "投影边框":
                // 悬浮相纸风：深灰背景 + 白色相纸 + 大而柔和的投影
                t.getBaseMargin().setMarginTop(100);
                t.getBaseMargin().setMarginBottom(100);
                t.getBaseMargin().setMarginLeft(100);
                t.getBaseMargin().setMarginRight(100);
                t.getBaseMargin().setImgScale(0.85);
                t.getCornerConfig().setCornerRadiusAll(0);
                t.getCornerConfig().setCornerRadiusTL(0);
                t.getCornerConfig().setCornerRadiusTR(0);
                t.getCornerConfig().setCornerRadiusBL(0);
                t.getCornerConfig().setCornerRadiusBR(0);
                // 顶层：白色相纸（后画，带大投影）
                LayerBorder paper = t.getLayerList().get(0);
                paper.getFillConfig().setFillHex("#ffffff");
                paper.getStrokeConfig().setStrokeWidth(0);
                ShadowGlowConfig psc = paper.getShadowGlowConfig();
                psc.setShadowEnable(1);
                psc.setShadowOffsetX(8);
                psc.setShadowOffsetY(8);
                psc.setShadowBlur(30);
                psc.setShadowSpread(0);
                psc.setShadowColorHex("#000000");
                psc.setShadowOpacity(55);
                // 底层：深灰背景铺满全画布（负边距扩展到画布边缘）
                LayerBorder bg = new LayerBorder();
                bg.getFillConfig().setFillHex("#2a2a2e");
                bg.getStrokeConfig().setStrokeWidth(0);
                bg.setMarginTop(-100);
                bg.setMarginBottom(-100);
                bg.setMarginLeft(-100);
                bg.setMarginRight(-100);
                t.getLayerList().add(bg);
                break;
            case "胶片框":
                t.getBaseMargin().setMarginTop(100);
                t.getBaseMargin().setMarginBottom(140);
                t.getBaseMargin().setMarginLeft(80);
                t.getBaseMargin().setMarginRight(80);
                t.getBaseMargin().setImgScale(0.90);
                t.getLayerList().get(0).getFillConfig().setFillHex("#f0ece4");
                t.getLayerList().get(0).getStrokeConfig().setStrokeWidth(3);
                t.getLayerList().get(0).getStrokeConfig().setStrokeColorHex("#8b7355");
                t.getLightEffect().setVignetteEnable(1);
                t.getLightEffect().setVignetteStrength(40);
                t.getFilmTearConfig().setFilmPerforationEnable(1);
                t.getFilmTearConfig().setFilmPerforationType("round");
                t.getFilmTearConfig().setFilmPerforationSize(12);
                t.getDecorConfig().setExifAutoText(1);
                TextStickerConfig.TextLine fline = new TextStickerConfig.TextLine();
                fline.setText("FUJI FILM | 35mm f/2.0  1/250s  ISO 400");
                fline.setAlign("bottom");
                t.getDecorConfig().getTextLines().add(fline);
                break;
        }
        return t;
    }
}

package com.qingframe.core;

import com.qingframe.model.IconItem;
import javafx.scene.image.Image;

import java.io.File;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;

public class IconManager {

    private static final List<IconItem> builtInIcons = new ArrayList<>();
    private static final List<IconItem> customIcons = new CopyOnWriteArrayList<>();
    private static final List<IconItem> activeIcons = new CopyOnWriteArrayList<>();
    /** 当前画布选中的图标（用于绘制选中框/删除） */
    private static volatile IconItem selectedIcon;
    private static int nextLayer = 0;

    static {
        registerBuiltIn();
    }

    private static void registerBuiltIn() {
        // 内置图标为纯矢量绘制（IconRenderer），src 留空即可，不再引用不存在的图片资源
        builtInIcons.add(new IconItem("lens", IconItem.Category.PHOTO_DECOR, "镜头", ""));
        builtInIcons.add(new IconItem("camera_body", IconItem.Category.PHOTO_DECOR, "机身", ""));
        builtInIcons.add(new IconItem("tripod", IconItem.Category.PHOTO_DECOR, "三脚架", ""));
        builtInIcons.add(new IconItem("shutter", IconItem.Category.PHOTO_DECOR, "快门", ""));
        builtInIcons.add(new IconItem("aperture", IconItem.Category.PHOTO_DECOR, "月牙光圈", ""));
        builtInIcons.add(new IconItem("star", IconItem.Category.PHOTO_DECOR, "星光", ""));
        builtInIcons.add(new IconItem("film_perf", IconItem.Category.PHOTO_DECOR, "胶片齿孔", ""));

        builtInIcons.add(new IconItem("camera_line", IconItem.Category.SIMPLE, "相机线框", ""));
        builtInIcons.add(new IconItem("camera_circle", IconItem.Category.SIMPLE, "圆形相机标", ""));
        builtInIcons.add(new IconItem("shutter_simple", IconItem.Category.SIMPLE, "快门简约标", ""));

        builtInIcons.add(new IconItem("moon", IconItem.Category.WEATHER, "月亮", ""));
        builtInIcons.add(new IconItem("sun", IconItem.Category.WEATHER, "太阳", ""));
        builtInIcons.add(new IconItem("cloud", IconItem.Category.WEATHER, "云朵", ""));
        builtInIcons.add(new IconItem("star_weather", IconItem.Category.WEATHER, "星星", ""));
        builtInIcons.add(new IconItem("mountain", IconItem.Category.WEATHER, "山峰", ""));
    }

    private static final Map<String, Image> imageCache = new HashMap<>();

    public static List<IconItem> getBuiltInByCategory(IconItem.Category cat) {
        List<IconItem> result = new ArrayList<>();
        for (IconItem item : builtInIcons) {
            if (item.getCategory() == cat) result.add(item);
        }
        return result;
    }

    public static List<IconItem> getCustomIcons() { return customIcons; }

    public static List<IconItem> getActiveIcons() { return activeIcons; }

    public static synchronized Image getIconImage(IconItem item) {
        String src = item.getSrc();
        if (src == null || src.isEmpty()) return null;
        if (imageCache.containsKey(src)) return imageCache.get(src);
        Image img = null;
        // 仅加载真实文件/网络图片；内置矢量图标直接返回 null 走矢量绘制
        if (src.startsWith("file:") || src.startsWith("http")) {
            try {
                img = new Image(src);
            } catch (Exception ignored) {}
        }
        if (img != null) imageCache.put(src, img);
        return img;
    }

    public static synchronized IconItem addCustomIcon(File file) {
        String src = file.toURI().toString();
        for (IconItem existing : customIcons) {
            if (existing.getSrc().equals(src)) return existing;
        }
        String name = file.getName();
        int dot = name.lastIndexOf('.');
        if (dot > 0) name = name.substring(0, dot);
        IconItem item = new IconItem("custom_" + System.currentTimeMillis(),
                IconItem.Category.CUSTOM, name, src);
        customIcons.add(item);
        return item;
    }

    public static synchronized IconItem addToCanvas(IconItem template, double canvasW, double canvasH) {
        IconItem placed = new IconItem(template.getId() + "_" + System.nanoTime(),
                template.getCategory(), template.getLabel(), template.getSrc());
        placed.setX(canvasW - 80);
        placed.setY(canvasH - 80);
        placed.setScale(0.5);
        placed.setOpacity(100);
        placed.setLayer(nextLayer++);
        activeIcons.add(placed);
        return placed;
    }

    /** 直接把已配置好坐标/样式的元素加入画布（用于复制粘贴），并分配新 id 与层级 */
    public static synchronized IconItem addToCanvas(IconItem item) {
        IconItem placed = item.copy();
        placed.setId(item.getId() + "_" + System.nanoTime());
        placed.setLayer(nextLayer++);
        activeIcons.add(placed);
        return placed;
    }

    public static synchronized void removeFromCanvas(IconItem item) {
        activeIcons.remove(item);
    }

    public static synchronized void clearCanvas() {
        activeIcons.clear();
        selectedIcon = null;
        nextLayer = 0;
    }

    public static synchronized void setSelected(IconItem item) {
        selectedIcon = item;
    }

    public static IconItem getSelected() {
        return selectedIcon;
    }

}

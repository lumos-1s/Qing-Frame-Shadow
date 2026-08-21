package com.qingframe.ui;

import com.qingframe.core.PuzzlrRenderer;
import com.qingframe.model.GapCaption;
import com.qingframe.model.PuzzlrConfig;
import javafx.scene.control.CheckBox;
import javafx.scene.control.ColorPicker;
import javafx.scene.control.ComboBox;
import javafx.scene.control.Label;
import javafx.scene.control.Slider;
import javafx.scene.control.TextField;
import javafx.scene.layout.VBox;

import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * 间隙电影字幕编辑器：两行文字/字号/字体/颜色/黑底条/行间距的回显与实时应用。
 * 从 MainController 抽出；控件由 FXML 注入后传入，模板配置与渲染触发经回调注入。
 */
public class CaptionEditorHelper {

    private final VBox editorBox;
    private final TextField tfLine1, tfLine2;
    private final Slider slSize1, slSize2, slSpacing;
    private final Label lblSize1, lblSize2;
    private final ComboBox<String> cbFont1, cbFont2;
    private final ColorPicker cpColor;
    private final CheckBox cbBgBar;
    private final ComboBox<String> gapPick;
    private final BooleanSupplier puzzleMode;
    private final Supplier<PuzzlrConfig> config;
    private final Consumer<String> status;
    private final Runnable onChange;

    /** 当前正在编辑的间隙下标（-1 = 编辑器关闭） */
    private int editingGap = -1;
    /** 回显控件时置 true，避免监听器把值写回字幕造成循环 */
    private boolean updating = false;

    public CaptionEditorHelper(VBox editorBox,
                               TextField tfLine1, TextField tfLine2,
                               Slider slSize1, Slider slSize2,
                               Label lblSize1, Label lblSize2,
                               ComboBox<String> cbFont1, ComboBox<String> cbFont2,
                               ColorPicker cpColor, CheckBox cbBgBar,
                               Slider slSpacing,
                               ComboBox<String> gapPick,
                               BooleanSupplier puzzleMode,
                               Supplier<PuzzlrConfig> config,
                               Consumer<String> status,
                               Runnable onChange) {
        this.editorBox = editorBox;
        this.tfLine1 = tfLine1;
        this.tfLine2 = tfLine2;
        this.slSize1 = slSize1;
        this.slSize2 = slSize2;
        this.lblSize1 = lblSize1;
        this.lblSize2 = lblSize2;
        this.cbFont1 = cbFont1;
        this.cbFont2 = cbFont2;
        this.cpColor = cpColor;
        this.cbBgBar = cbBgBar;
        this.slSpacing = slSpacing;
        this.gapPick = gapPick;
        this.puzzleMode = puzzleMode;
        this.config = config;
        this.status = status;
        this.onChange = onChange;
    }

    /** 控件默认值 + 监听接线（在 FXML 注入与字体项填充之后调用一次） */
    public void wire() {
        cbFont1.setValue("Microsoft YaHei");
        cbFont2.setValue("Microsoft YaHei");
        tfLine1.textProperty().addListener((o, ov, nv) -> apply());
        tfLine2.textProperty().addListener((o, ov, nv) -> apply());
        slSize1.valueProperty().addListener((o, ov, nv) -> {
            if (lblSize1 != null) lblSize1.setText(String.valueOf(nv.intValue()));
            apply();
        });
        slSize2.valueProperty().addListener((o, ov, nv) -> {
            if (lblSize2 != null) lblSize2.setText(String.valueOf(nv.intValue()));
            apply();
        });
        cbFont1.valueProperty().addListener((o, ov, nv) -> apply());
        cbFont2.valueProperty().addListener((o, ov, nv) -> apply());
        cpColor.valueProperty().addListener((o, ov, nv) -> apply());
        cbBgBar.selectedProperty().addListener((o, ov, nv) -> apply());
        slSpacing.valueProperty().addListener((o, ov, nv) -> apply());
    }

    /** 当前选中间隙已绑定的字幕，无则 null */
    public GapCaption current() {
        if (!puzzleMode.getAsBoolean() || config.get() == null) return null;
        int idx = gapPick.getSelectionModel().getSelectedIndex();
        PuzzlrConfig pc = config.get();
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        if (idx < 0 || idx >= axes.length) return null;
        String gid = (axes[idx][0] == 0 ? "V" : "H") + idx;
        for (GapCaption c : pc.getGapCaptions()) {
            if (gid.equals(c.getGapId())) return c;
        }
        return null;
    }

    /** 添加/编辑字幕按钮：对选中间隙创建（如无）并打开下方编辑器 */
    public void editSelected() {
        if (!puzzleMode.getAsBoolean()) return;
        int idx = gapPick.getSelectionModel().getSelectedIndex();
        PuzzlrConfig pc = config.get();
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        if (idx < 0 || idx >= axes.length) {
            status.accept("请先在上方选择一条间隙");
            return;
        }
        String gid = (axes[idx][0] == 0 ? "V" : "H") + idx;
        GapCaption cap = current();
        if (cap == null) {
            cap = new GapCaption();
            cap.setGapId(gid);
            pc.getGapCaptions().add(cap);
            status.accept("已在间隙 " + gid + " 创建字幕，输入文字即可");
        } else {
            status.accept("正在编辑间隙 " + gid + " 的字幕");
        }
        editingGap = idx;
        load(cap);
        editorBox.setVisible(true);
        editorBox.setManaged(true);
        refreshPicker();
        onChange.run();
    }

    /** 删除字幕按钮：删除当前选中间隙绑定的字幕 */
    public void deleteSelected() {
        if (!puzzleMode.getAsBoolean()) return;
        int idx = gapPick.getSelectionModel().getSelectedIndex();
        PuzzlrConfig pc = config.get();
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        if (idx < 0 || idx >= axes.length) {
            status.accept("请先在上方选择一条间隙");
            return;
        }
        String gid = (axes[idx][0] == 0 ? "V" : "H") + idx;
        boolean removed = pc.getGapCaptions().removeIf(c -> gid.equals(c.getGapId()));
        if (editingGap == idx) close();
        refreshPicker();
        onChange.run();
        status.accept(removed ? "已删除间隙 " + gid + " 的字幕" : "该间隙没有字幕");
    }

    /** 关闭字幕编辑器 */
    public void close() {
        editingGap = -1;
        if (editorBox != null) {
            editorBox.setVisible(false);
            editorBox.setManaged(false);
        }
    }

    /** 把字幕内容回显到编辑器控件（updating 防回写） */
    public void load(GapCaption c) {
        updating = true;
        try {
            tfLine1.setText(c.getTextContent());
            tfLine2.setText(c.getTextContent2());
            slSize1.setValue(clamp(c.getFontSize(), 8, 200));
            slSize2.setValue(clamp(c.getFontSize2(), 8, 200));
            lblSize1.setText(String.valueOf((int) Math.round(clamp(c.getFontSize(), 8, 200))));
            lblSize2.setText(String.valueOf((int) Math.round(clamp(c.getFontSize2(), 8, 200))));
            cbFont1.setValue(c.getFontFamily() != null ? c.getFontFamily() : "Microsoft YaHei");
            cbFont2.setValue(c.getFontFamily2() != null ? c.getFontFamily2() : "Microsoft YaHei");
            try {
                cpColor.setValue(javafx.scene.paint.Color.web(c.getColorHex()));
            } catch (Exception ignored) {}
            cbBgBar.setSelected(c.isBgBar());
            slSpacing.setValue(clamp(c.getLineSpacing() * 100, 0, 300));
        } finally {
            updating = false;
        }
    }

    /** 编辑器控件 → 当前字幕（内容变化即实时渲染） */
    public void apply() {
        if (updating || editingGap < 0) return;
        GapCaption c = current();
        if (c == null) return;
        c.setTextContent(tfLine1.getText() == null ? "" : tfLine1.getText().trim());
        c.setTextContent2(tfLine2.getText() == null ? "" : tfLine2.getText().trim());
        c.setFontSize(slSize1.getValue());
        c.setFontSize2(slSize2.getValue());
        if (cbFont1.getValue() != null) c.setFontFamily(cbFont1.getValue());
        if (cbFont2.getValue() != null) c.setFontFamily2(cbFont2.getValue());
        c.setColorHex(toHex(cpColor.getValue()));
        c.setBgBar(cbBgBar.isSelected());
        c.setLineSpacing(Math.max(0, slSpacing.getValue()) / 100.0);
        onChange.run();
    }

    /** 间隙下拉框：列出当前布局所有分割间隙，已绑定字幕的标记 ● */
    public void refreshPicker() {
        if (gapPick == null || config.get() == null) return;
        PuzzlrConfig pc = config.get();
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        javafx.collections.ObservableList<String> items = javafx.collections.FXCollections.observableArrayList();
        for (int i = 0; i < axes.length; i++) {
            String gid = (axes[i][0] == 0 ? "V" : "H") + i;
            boolean bound = false;
            for (GapCaption c : pc.getGapCaptions()) {
                if (gid.equals(c.getGapId())) { bound = true; break; }
            }
            items.add((axes[i][0] == 0 ? "竖向间隙 " : "横向间隙 ") + (i + 1)
                    + (axes[i][0] == 0 ? "（左右格之间）" : "（上下格之间）") + (bound ? " ●" : ""));
        }
        int sel = gapPick.getSelectionModel().getSelectedIndex();
        gapPick.setItems(items);
        if (sel >= 0 && sel < items.size()) gapPick.getSelectionModel().select(sel);
    }

    /** 布局切换后清理：绑定的分割轴已不存在的字幕自动删除 */
    public void prune(PuzzlrConfig pc) {
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        pc.getGapCaptions().removeIf(c -> PuzzlrRenderer.gapAxisOf(c.getGapId(), axes) == null);
        if (editingGap >= 0 && current() == null) close();
        refreshPicker();
    }

    private static double clamp(double v, double lo, double hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private static String toHex(javafx.scene.paint.Color c) {
        return String.format("#%02x%02x%02x", (int) (c.getRed() * 255), (int) (c.getGreen() * 255), (int) (c.getBlue() * 255));
    }
}

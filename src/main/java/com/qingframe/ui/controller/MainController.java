package com.qingframe.ui.controller;

import com.qingframe.core.BorderEngine;
import com.qingframe.core.BorderProcessor;
import com.qingframe.core.ExifReader;
import com.qingframe.core.ExifTextParser;
import com.qingframe.core.IconManager;
import com.qingframe.core.IconRenderer;
import com.qingframe.core.WatermarkRender;
import com.qingframe.model.*;
import com.qingframe.util.FileUtil;
import com.qingframe.util.ImageExportUtil;
import com.qingframe.util.JsonUtil;
import javafx.animation.PauseTransition;
import javafx.application.Platform;
import javafx.beans.value.ChangeListener;
import javafx.collections.FXCollections;
import javafx.embed.swing.SwingFXUtils;
import javafx.fxml.FXML;
import javafx.fxml.Initializable;
import javafx.scene.canvas.Canvas;
import javafx.scene.canvas.GraphicsContext;
import javafx.scene.Cursor;
import javafx.scene.control.*;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import javafx.scene.image.WritableImage;
import javafx.scene.Node;
import javafx.scene.input.DragEvent;
import javafx.scene.input.KeyCode;
import javafx.scene.input.ScrollEvent;
import javafx.scene.input.TransferMode;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.HBox;
import javafx.scene.layout.StackPane;
import javafx.scene.layout.VBox;
import javafx.scene.paint.Color;
import javafx.util.Duration;
import javafx.stage.FileChooser;
import javafx.stage.Stage;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public class MainController implements Initializable {

    @FXML private Canvas previewCanvas;
    @FXML private Label statusLabel, zoomLabel, lblImageInfo, lblCanvasSize;
    @FXML private Label lblImgScale, lblFillOpacity, lblStrokeWidth, lblGlobalMargin, lblParamFontSize;
    @FXML private Slider zoomSlider, slImgScale, slFillOpacity, slStrokeWidth;
    @FXML private Slider slGradientAngle, slTextureScale, slStrokeOpacity;
    @FXML private Slider slCornerRadius, slTearStrength, slTearDensity;
    @FXML private TabPane rightTabPane;
    @FXML private TextField tfCornerRadius;
    @FXML private Slider slShadowX, slShadowY, slShadowBlur, slShadowSpread;
    @FXML private Slider slGlowBlur, slGlowOpacity, slVignetteStrength;
    @FXML private Slider slTextSize, slCornerDecorSize, slGlobalMargin, slParamFontSize;
    @FXML private TextField tfMarginTop, tfMarginBottom, tfMarginLeft, tfMarginRight;
    @FXML private TextField tfImgOffsetX, tfImgOffsetY;
    @FXML private TextField tfLayerMarginTop, tfLayerMarginBottom, tfLayerMarginLeft, tfLayerMarginRight;
    @FXML private TextField tfStrokeDash, tfTemplateName, tfTemplateTag, tfCustomText;
    @FXML private TextField tfExifBrand, tfExifModel, tfExifFocal, tfExifAperture, tfExifIso, tfExifShutter;
    @FXML private CheckBox cbMarginLock, cbLayerVisible, cbCornerLock;
    @FXML private CheckBox cbBgBlur;
    @FXML private CheckBox cbBgBlurWhite;
    @FXML private Slider slBgBlurRadius, slBgBlurIntensity;
    @FXML private CheckBox cbTearEnable, cbShadow, cbGlow;
    @FXML private CheckBox cbVignette, cbLightLeak, cbExifText, cbCornerDecor;
    @FXML private ColorPicker cpFillColor, cpStrokeColor, cpGlowColor, cpTextColor;
    @FXML private ScrollPane brandIconScroll, photoDecorScroll, simpleIconScroll, weatherIconScroll;
    @FXML private HBox brandIconBox, photoDecorBox, simpleIconBox, weatherIconBox, customIconBox;
    @FXML private Slider slActiveIconOpacity;
    @FXML private ComboBox<String> cbLayerSelect, cbFillType, cbGradientType, cbStrokePos, cbLeakType, cbExportFormat;
    @FXML private ComboBox<String> cbTextureBlend;
    @FXML private ListView<String> lvPresets;
    @FXML private ProgressBar progressBar;
    @FXML private Button btnOpenImage, btnSaveImage, btnBatchExport, btnAddLayer;
    @FXML private ToggleButton btnThemeToggle;
    @FXML private BorderPane rootPane;
    @FXML private StackPane dropTarget;
    @FXML private VBox placeholderView;
    @FXML private TextField tfZoomValue;
    @FXML private ComboBox<String> cbParamType, cbCanvasRatio, cbRecipeFilter, cbParamPosition;
    @FXML private Slider slCornerTL, slCornerTR, slCornerBL, slCornerBR;
    @FXML private Label lblResolution;
    @FXML private ScrollBar hScrollBar, vScrollBar;
    @FXML private ScrollPane filmStrip;
    @FXML private HBox thumbnailBox;

    private Image originImage;
    private TemplateModel template;
    private BorderEngine engine = new BorderEngine();
    private boolean isDarkTheme = true;
    private boolean isUpdating = false;
    private final Stack<TemplateModel> undoStack = new Stack<>();
    private final Stack<TemplateModel> redoStack = new Stack<>();
    private double panX = 0, panY = 0;
    private double dragStartX = Double.NaN, dragStartY = Double.NaN;
    private boolean isUpdatingSB = false;
    private final List<File> imageFiles = new ArrayList<>();
    private final Set<Integer> selectedIndices = new HashSet<>();
    private int currentImageIndex = -1;
    private int[] refMargins = new int[4];
    private final Map<File, TemplateModel> imageTemplates = new HashMap<>();
    private final Map<File, Image> thumbCache = new HashMap<>();
    private static final int THUMB_MAX_DIM = 1280;
    private static final int THUMB_CACHE_MAX = 200;
    private static final long RENDER_DEBOUNCE_MS = 50;
    /** 导出渲染的安全长边（约 2400px，约 400 万像素），落在大多数环境的稳定渲染区 */
    private static final int EXPORT_SAFE_EDGE = 2400;
    /** 导出设置文件：记住上次导出目录 */
    private static final String EXPORT_SETTINGS_FILE =
            System.getProperty("user.home") + "/.qingkuangying-export-settings.txt";
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
    private volatile boolean isExporting = false;

    @Override
    public void initialize(URL url, ResourceBundle rb) {
        template = new TemplateModel();

        previewCanvas.setManaged(false);
        previewCanvas.widthProperty().bind(dropTarget.widthProperty());
        previewCanvas.heightProperty().bind(dropTarget.heightProperty());

        Platform.runLater(() -> {
            renderPreview();
        });

        dropTarget.widthProperty().addListener((o,ov,nv) -> {
            if (nv.doubleValue() > 0) scheduleRender();
        });
        dropTarget.heightProperty().addListener((o,ov,nv) -> {
            if (nv.doubleValue() > 0) scheduleRender();
        });

        setupScrollBars();
        setupPanDrag();

        setupDragDrop();

        cbFillType.setItems(FXCollections.observableArrayList("solid", "gradient", "texture", "transparent"));
        cbFillType.setValue("solid");
        cbGradientType.setItems(FXCollections.observableArrayList("linear", "radial"));
        cbGradientType.setValue("linear");
        cbStrokePos.setItems(FXCollections.observableArrayList("inside", "center", "outside"));
        cbStrokePos.setValue("inside");
        cbLeakType.setItems(FXCollections.observableArrayList("warm", "cool", "magenta"));
        cbLeakType.setValue("warm");
        cbTextureBlend.setItems(FXCollections.observableArrayList("normal", "multiply", "screen", "overlay"));
        cbTextureBlend.setValue("normal");

        cbExportFormat.setItems(FXCollections.observableArrayList("JPEG", "PNG"));
        cbExportFormat.setValue("JPEG");

        lvPresets.setItems(FXCollections.observableArrayList(loadPresetList()));

        cbCanvasRatio.setItems(FXCollections.observableArrayList("original", "1:1", "4:3", "3:4", "16:9", "9:16", "2.35:1"));
        cbCanvasRatio.setValue("original");
        
        cbParamType.setItems(FXCollections.observableArrayList("完整参数", "居中参数"));
        cbParamType.setValue("完整参数");
        
        cbRecipeFilter.setItems(FXCollections.observableArrayList("全部", "自定义"));
        cbRecipeFilter.setValue("全部");

        cbParamPosition.setItems(FXCollections.observableArrayList("居左", "居中", "居右", "分列"));
        cbParamPosition.setValue("居中");
        cbParamPosition.valueProperty().addListener((o,ov,nv) -> {
            if (nv == null) return;
            switch (nv) {
                case "居左" -> WatermarkRender.setPosition(WatermarkRender.Position.LEFT);
                case "居中" -> WatermarkRender.setPosition(WatermarkRender.Position.CENTER);
                case "居右" -> WatermarkRender.setPosition(WatermarkRender.Position.RIGHT);
                case "分列" -> WatermarkRender.setPosition(WatermarkRender.Position.SPLIT);
            }
            onSettingChanged();
        });

        bindSliders();
        bindTextFields();
        bindChecks();
        bindCombos();
        bindColorPickers();
        bindLayerSelect();

        cbCanvasRatio.valueProperty().addListener((o,ov,nv) -> {
            if (nv != null) { template.setCanvasRatio(nv); onSettingChanged(); }
        });

        tfZoomValue.setOnAction(e -> {
            try {
                double val = Double.parseDouble(tfZoomValue.getText().replace("%", "")) / 100.0;
                zoomSlider.setValue(Math.max(0.1, Math.min(3.0, val)));
            } catch (NumberFormatException ex) {
                tfZoomValue.setText(String.format("%.0f%%", zoomSlider.getValue() * 100));
            }
        });
        zoomSlider.valueProperty().addListener((o,ov,nv) -> {
            zoomLabel.setText(String.format("%.0f%%", nv.doubleValue() * 100));
            tfZoomValue.setText(String.format("%.0f%%", nv.doubleValue() * 100));
            scheduleRender();
        });

        cbParamType.valueProperty().addListener((o,ov,nv) -> {
            if (nv == null) return;
            BorderProcessor.setParamType("完整参数".equals(nv) ? 0 : 1);
            onSettingChanged();
        });

        cbRecipeFilter.valueProperty().addListener((o,ov,nv) -> {
            if (nv == null) return;
            if ("全部".equals(nv)) {
                lvPresets.setItems(FXCollections.observableArrayList(loadPresetList()));
            } else {
                lvPresets.getItems().clear();
            }
        });
        
        ChangeListener<Number> cornerListener = (o,ov,nv) -> {
            if (cbCornerLock.isSelected()) {
                double v = nv.doubleValue();
                slCornerTL.setValue(v);
                slCornerTR.setValue(v);
                slCornerBL.setValue(v);
                slCornerBR.setValue(v);
            }
            onSettingChanged();
        };
        slCornerTL.valueProperty().addListener(cornerListener);
        slCornerTR.valueProperty().addListener(cornerListener);
        slCornerBL.valueProperty().addListener(cornerListener);
        slCornerBR.valueProperty().addListener(cornerListener);
        setupSliderUndo(slCornerTL, slCornerTR, slCornerBL, slCornerBR);

        slGlobalMargin.setValue(1.0);
        lblGlobalMargin.setText("100%");
        slGlobalMargin.setOnMousePressed(e -> {
            double scale = slGlobalMargin.getValue();
            if (scale == 0) scale = 1.0;
            refMargins[0] = (int)(parseInt(tfMarginTop.getText(), 80) / scale);
            refMargins[1] = (int)(parseInt(tfMarginBottom.getText(), 120) / scale);
            refMargins[2] = (int)(parseInt(tfMarginLeft.getText(), 80) / scale);
            refMargins[3] = (int)(parseInt(tfMarginRight.getText(), 80) / scale);
        });
        slGlobalMargin.valueProperty().addListener((o,ov,nv) -> {
            double scale = nv.doubleValue();
            lblGlobalMargin.setText(String.format("%.0f%%", scale * 100));
            if (isUpdating) return;
            isUpdating = true;
            tfMarginTop.setText(String.valueOf((int)(refMargins[0] * scale)));
            tfMarginBottom.setText(String.valueOf((int)(refMargins[1] * scale)));
            tfMarginLeft.setText(String.valueOf((int)(refMargins[2] * scale)));
            tfMarginRight.setText(String.valueOf((int)(refMargins[3] * scale)));
            isUpdating = false;
        });
        slGlobalMargin.setOnMouseReleased(e -> onSettingChanged());

        dropTarget.setOnScroll(e -> {
            if (e.isAltDown()) {
                double delta = e.getDeltaY() > 0 ? 0.1 : -0.1;
                zoomSlider.setValue(Math.max(0.1, Math.min(3.0, zoomSlider.getValue() + delta)));
                e.consume();
            }
        });

        rootPane.sceneProperty().addListener((obs, oldScene, newScene) -> {
            if (newScene != null) {
                newScene.setOnKeyPressed(ke -> {
                    if (ke.isControlDown() && ke.getCode() == KeyCode.A) {
                        selectAllImages();
                        ke.consume();
                    } else if (ke.getCode() == KeyCode.DELETE && IconManager.getSelected() != null) {
                        onDeleteActiveIcon();
                        ke.consume();
                    }
                });
            }
        });

        // Amplify right panel scroll wheel speed
        Platform.runLater(() -> {
            for (Tab tab : rightTabPane.getTabs()) {
                if (tab.getContent() instanceof ScrollPane) {
                    ScrollPane sp = (ScrollPane) tab.getContent();
                    sp.addEventFilter(ScrollEvent.SCROLL, e -> {
                        if (e.getDeltaY() == 0) return;
                        double newV = sp.getVvalue() - e.getDeltaY() * 0.04;
                        sp.setVvalue(Math.max(0, Math.min(1, newV)));
                        e.consume();
                    });
                }
            }
            initLogoTab();
            setupCanvasIconInteraction();

            slActiveIconOpacity.valueProperty().addListener((o,ov,nv) -> {
                if (selectedIcon != null) {
                    selectedIcon.setOpacity(nv.intValue());
                    renderPreview();
                }
            });
        });

        refreshUI();
    }

    private void bindSliders() {
        slImgScale.valueProperty().addListener((o,ov,nv) -> {
            lblImgScale.setText(String.format("%.0f%%", nv.doubleValue() * 100));
            onSettingChanged();
        });
        slFillOpacity.valueProperty().addListener((o,ov,nv) -> {
            lblFillOpacity.setText(String.format("%.0f%%", nv.doubleValue()));
            onSettingChanged();
        });
        slStrokeWidth.valueProperty().addListener((o,ov,nv) -> {
            lblStrokeWidth.setText(String.format("%.0fpx", nv.doubleValue()));
            onSettingChanged();
        });
        slStrokeOpacity.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slGradientAngle.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slTextureScale.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slCornerRadius.valueProperty().addListener((o,ov,nv) -> {
            String txt = String.format("%.0f", nv.doubleValue());
            if (!tfCornerRadius.getText().equals(txt)) {
                tfCornerRadius.setText(txt);
            }
            double v = nv.doubleValue();
            slCornerTL.setValue(v);
            slCornerTR.setValue(v);
            slCornerBL.setValue(v);
            slCornerBR.setValue(v);
            onSettingChanged();
        });
        tfCornerRadius.setOnAction(e -> {
            try {
                double v = Double.parseDouble(tfCornerRadius.getText());
                v = Math.max(0, Math.min(500, v));
                slCornerRadius.setValue(v);
            } catch (NumberFormatException ex) {
                tfCornerRadius.setText(String.format("%.0f", slCornerRadius.getValue()));
            }
        });
        tfCornerRadius.focusedProperty().addListener((o,ov,nv) -> {
            if (!nv) {
                try {
                    double v = Double.parseDouble(tfCornerRadius.getText());
                    v = Math.max(0, Math.min(500, v));
                    slCornerRadius.setValue(v);
                } catch (NumberFormatException ex) {
                    tfCornerRadius.setText(String.format("%.0f", slCornerRadius.getValue()));
                }
            }
        });
        slTearStrength.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slTearDensity.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slParamFontSize.valueProperty().addListener((o,ov,nv) -> {
            int sz = (int) nv.doubleValue();
            lblParamFontSize.setText(sz + "px");
            BorderProcessor.setExifFontSize(sz);
            onSettingChanged();
        });
        slShadowX.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slShadowY.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slShadowBlur.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slShadowSpread.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slGlowBlur.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slGlowOpacity.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slVignetteStrength.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slBgBlurRadius.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slBgBlurIntensity.valueProperty().addListener((o,ov,nv) -> {
            BorderProcessor.setBlurIntensity((int) nv.doubleValue());
            onSettingChanged();
        });
        slTextSize.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slCornerDecorSize.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        setupSliderUndo(slImgScale, slFillOpacity, slStrokeWidth, slStrokeOpacity,
                slGradientAngle, slTextureScale, slCornerRadius, slTearStrength, slTearDensity,
                slShadowX, slShadowY, slShadowBlur, slShadowSpread,
                slGlowBlur, slGlowOpacity, slVignetteStrength, slTextSize, slCornerDecorSize,
                slGlobalMargin);
    }

    private void setupSliderUndo(Slider... sliders) {
        for (Slider s : sliders) {
            javafx.event.EventHandler<javafx.scene.input.MouseEvent> existing = (javafx.event.EventHandler<javafx.scene.input.MouseEvent>) s.getOnMousePressed();
            s.setOnMousePressed(e -> {
                if (existing != null) existing.handle(e);
                undoStack.push(cloneTemplate(template));
                redoStack.clear();
            });
        }
    }

    private void bindTextFields() {
        ChangeListener<String> listener = (o,ov,nv) -> onSettingChanged();
        tfMarginTop.textProperty().addListener(listener);
        tfMarginBottom.textProperty().addListener(listener);
        tfMarginLeft.textProperty().addListener(listener);
        tfMarginRight.textProperty().addListener(listener);
        tfImgOffsetX.textProperty().addListener(listener);
        tfImgOffsetY.textProperty().addListener(listener);
        tfLayerMarginTop.textProperty().addListener(listener);
        tfLayerMarginBottom.textProperty().addListener(listener);
        tfLayerMarginLeft.textProperty().addListener(listener);
        tfLayerMarginRight.textProperty().addListener(listener);
        tfStrokeDash.textProperty().addListener(listener);
        tfTemplateName.textProperty().addListener(listener);
        tfTemplateTag.textProperty().addListener(listener);
        tfCustomText.textProperty().addListener(listener);
        setupTextFieldUndo(tfMarginTop, tfMarginBottom, tfMarginLeft, tfMarginRight,
                tfImgOffsetX, tfImgOffsetY, tfLayerMarginTop, tfLayerMarginBottom,
                tfLayerMarginLeft, tfLayerMarginRight, tfStrokeDash);
    }

    private void setupTextFieldUndo(TextField... fields) {
        for (TextField tf : fields) {
            tf.focusedProperty().addListener((o,ov,focused) -> {
                if (focused) {
                    undoStack.push(cloneTemplate(template));
                    redoStack.clear();
                }
            });
        }
    }

    private void bindChecks() {
        cbMarginLock.selectedProperty().addListener((o,ov,nv) -> {
            boolean lock = nv;
            tfMarginTop.setDisable(lock);
            tfMarginBottom.setDisable(lock);
            tfMarginLeft.setDisable(lock);
            tfMarginRight.setDisable(lock);
            slGlobalMargin.setDisable(lock);
            onSettingCommit();
        });
        cbLayerVisible.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbCornerLock.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbBgBlur.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbBgBlurWhite.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbTearEnable.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbShadow.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbGlow.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbVignette.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbLightLeak.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbExifText.selectedProperty().addListener((o,ov,nv) -> {
            BorderProcessor.setUseExifEnabled(nv);
            onSettingCommit();
        });
        cbCornerDecor.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());

        TextField[] exifFields = {tfExifBrand, tfExifModel, tfExifFocal, tfExifAperture, tfExifIso, tfExifShutter};
        for (TextField f : exifFields) {
            f.textProperty().addListener((o,ov,nv) -> onSettingChanged());
        }
    }

    private void bindCombos() {
        cbFillType.valueProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbGradientType.valueProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbStrokePos.valueProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbLeakType.valueProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbTextureBlend.valueProperty().addListener((o,ov,nv) -> onSettingCommit());
    }

    private void bindColorPickers() {
        cpFillColor.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        cpStrokeColor.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        cpGlowColor.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        cpTextColor.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
    }

    private void bindLayerSelect() {
        cbLayerSelect.valueProperty().addListener((o,ov,nv) -> {
            if (nv != null) loadLayerToUI();
        });
    }

    private final ScheduledExecutorService renderScheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "render-debounce");
        t.setDaemon(true);
        return t;
    });
    private final AtomicBoolean renderScheduled = new AtomicBoolean(false);

    private final ExecutorService thumbExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "thumb-worker");
        t.setDaemon(true);
        return t;
    });
    /** 缩略图队列代次：每次重建胶片条时递增，用于丢弃过期任务 */
    private volatile long thumbGeneration = 0;

    private void onSettingChanged() {
        if (isUpdating) return;
        syncModelFromUI();
        clearThumbCache();
        scheduleRender();
    }

    /** 合并高频参数变化：防抖窗口内最多触发一次预览渲染，避免拖动滑块时逐帧全量重绘 */
    private void scheduleRender() {
        if (renderScheduled.compareAndSet(false, true)) {
            renderScheduler.schedule(() -> {
                renderScheduled.set(false);
                Platform.runLater(this::refreshView);
            }, RENDER_DEBOUNCE_MS, TimeUnit.MILLISECONDS);
        }
    }

    private void onSettingCommit() {
        if (isUpdating) return;
        undoStack.push(cloneTemplate(template));
        redoStack.clear();
        syncModelFromUI();
        clearThumbCache();
        renderPreview();
    }

    private void syncModelFromUI() {
        BaseMargin margin = template.getBaseMargin();
        try {
            margin.setMarginLock(cbMarginLock.isSelected() ? 1 : 0);
            margin.setMarginTop(parseInt(tfMarginTop.getText(), 80));
            margin.setMarginBottom(parseInt(tfMarginBottom.getText(), 120));
            margin.setMarginLeft(parseInt(tfMarginLeft.getText(), 80));
            margin.setMarginRight(parseInt(tfMarginRight.getText(), 80));
            margin.setImgScale(slImgScale.getValue());
            margin.setImgOffsetX(parseInt(tfImgOffsetX.getText(), 0));
            margin.setImgOffsetY(parseInt(tfImgOffsetY.getText(), 0));
            margin.setBgBlurEnable(cbBgBlur.isSelected() ? 1 : 0);
            margin.setBgBlurRadius((int) slBgBlurRadius.getValue());
            margin.setBgBlurWhiteOverlay(cbBgBlurWhite.isSelected() ? 1 : 0);
            int top = parseInt(tfMarginTop.getText(), 80);
            int bot = parseInt(tfMarginBottom.getText(), 120);
            int left = parseInt(tfMarginLeft.getText(), 80);
            int right = parseInt(tfMarginRight.getText(), 80);
            int minMargin = Math.min(Math.min(top, bot), Math.min(left, right));
            if (minMargin >= 5) {
                template.setPhotoFrameBorderSize(minMargin);
            }
        } catch (Exception ignored) {}

        LayerBorder layer = getCurrentLayer();
        if (layer != null) {
            layer.setVisible(cbLayerVisible.isSelected());
            layer.setMarginTop(parseInt(tfLayerMarginTop.getText(), 0));
            layer.setMarginBottom(parseInt(tfLayerMarginBottom.getText(), 0));
            layer.setMarginLeft(parseInt(tfLayerMarginLeft.getText(), 0));
            layer.setMarginRight(parseInt(tfLayerMarginRight.getText(), 0));

            FillConfig fill = layer.getFillConfig();
            fill.setFillType(cbFillType.getValue());
            fill.setFillHex(toHex(cpFillColor.getValue()));
            fill.setFillOpacity((int) slFillOpacity.getValue());
            fill.setGradientType(cbGradientType.getValue());
            fill.setGradientAngle(slGradientAngle.getValue());
            fill.setTextureScale(slTextureScale.getValue());
            fill.setTextureBlend(cbTextureBlend.getValue());

            StrokeConfig stroke = layer.getStrokeConfig();
            stroke.setStrokeWidth((int) slStrokeWidth.getValue());
            stroke.setStrokePos(cbStrokePos.getValue());
            stroke.setStrokeColorHex(toHex(cpStrokeColor.getValue()));
            stroke.setStrokeOpacity((int) slStrokeOpacity.getValue());
            String dashText = tfStrokeDash.getText();
            if (!dashText.isEmpty()) {
                String[] parts = dashText.split(",");
                List<Double> dashes = new ArrayList<>();
                for (String p : parts) {
                    try { dashes.add(Double.parseDouble(p.trim())); } catch (Exception ignored) {}
                }
                stroke.setStrokeDashArray(dashes);
            }

            ShadowGlowConfig sg = layer.getShadowGlowConfig();
            sg.setShadowEnable(cbShadow.isSelected() ? 1 : 0);
            sg.setShadowOffsetX(slShadowX.getValue());
            sg.setShadowOffsetY(slShadowY.getValue());
            sg.setShadowBlur(slShadowBlur.getValue());
            sg.setShadowSpread(slShadowSpread.getValue());
            sg.setGlowEnable(cbGlow.isSelected() ? 1 : 0);
            sg.setGlowColorHex(toHex(cpGlowColor.getValue()));
            sg.setGlowBlur(slGlowBlur.getValue());
            sg.setGlowOpacity(slGlowOpacity.getValue());
        }

        CornerConfig corner = template.getCornerConfig();
        corner.setCornerLock(cbCornerLock.isSelected() ? 1 : 0);
        double rAll = slCornerRadius.getValue();
        corner.setCornerRadiusAll(rAll);
        corner.setCornerRadiusTL(slCornerTL.getValue());
        corner.setCornerRadiusTR(slCornerTR.getValue());
        corner.setCornerRadiusBL(slCornerBL.getValue());
        corner.setCornerRadiusBR(slCornerBR.getValue());
        BorderProcessor.setCornerRadius((int) rAll);
        BorderProcessor.setCornerIndividual("cornerTl", (int) slCornerTL.getValue());
        BorderProcessor.setCornerIndividual("cornerTr", (int) slCornerTR.getValue());
        BorderProcessor.setCornerIndividual("cornerBl", (int) slCornerBL.getValue());
        BorderProcessor.setCornerIndividual("cornerBr", (int) slCornerBR.getValue());

        FilmTearConfig tear = template.getFilmTearConfig();
        tear.setTearEnable(cbTearEnable.isSelected() ? 1 : 0);
        tear.setTearStrength(slTearStrength.getValue());
        tear.setTearDensity(slTearDensity.getValue());
        LightEffect light = template.getLightEffect();
        light.setVignetteEnable(cbVignette.isSelected() ? 1 : 0);
        light.setVignetteStrength(slVignetteStrength.getValue());
        light.setLightLeakEnable(cbLightLeak.isSelected() ? 1 : 0);
        light.setLightLeakType(cbLeakType.getValue());

        template.setParamFontSize((int) slParamFontSize.getValue());

        TextStickerConfig decor = template.getDecorConfig();
        decor.setExifAutoText(cbExifText.isSelected() ? 1 : 0);
        decor.setCornerDecorEnable(cbCornerDecor.isSelected() ? 1 : 0);
        decor.setCornerDecorSize(slCornerDecorSize.getValue());

        syncManualExif();
    }

    private void syncManualExif() {
        ExifReader.ExifData manual = new ExifReader.ExifData();
        manual.make = tfExifBrand.getText();
        manual.model = tfExifModel.getText();
        manual.focalLength = tfExifFocal.getText();
        manual.aperture = tfExifAperture.getText();
        manual.iso = tfExifIso.getText();
        manual.shutter = tfExifShutter.getText();
        BorderProcessor.setExifData(manual);
    }

    private LayerBorder getCurrentLayer() {
        int idx = cbLayerSelect.getSelectionModel().getSelectedIndex();
        if (idx >= 0 && idx < template.getLayerList().size()) {
            return template.getLayerList().get(idx);
        }
        return null;
    }

    private void loadLayerToUI() {
        LayerBorder layer = getCurrentLayer();
        if (layer == null) return;
        isUpdating = true;

        cbLayerVisible.setSelected(layer.isVisible());
        tfLayerMarginTop.setText(String.valueOf(layer.getMarginTop()));
        tfLayerMarginBottom.setText(String.valueOf(layer.getMarginBottom()));
        tfLayerMarginLeft.setText(String.valueOf(layer.getMarginLeft()));
        tfLayerMarginRight.setText(String.valueOf(layer.getMarginRight()));

        FillConfig fill = layer.getFillConfig();
        cbFillType.setValue(fill.getFillType());
        cpFillColor.setValue(parseColor(fill.getFillHex()));
        slFillOpacity.setValue(fill.getFillOpacity());
        cbGradientType.setValue(fill.getGradientType());
        slGradientAngle.setValue(fill.getGradientAngle());
        slTextureScale.setValue(fill.getTextureScale());
        cbTextureBlend.setValue(fill.getTextureBlend() != null ? fill.getTextureBlend() : "normal");

        StrokeConfig stroke = layer.getStrokeConfig();
        slStrokeWidth.setValue(stroke.getStrokeWidth());
        cbStrokePos.setValue(stroke.getStrokePos());
        cpStrokeColor.setValue(parseColor(stroke.getStrokeColorHex()));
        slStrokeOpacity.setValue(stroke.getStrokeOpacity());

        ShadowGlowConfig sg = layer.getShadowGlowConfig();
        cbShadow.setSelected(sg.getShadowEnable() == 1);
        slShadowX.setValue(sg.getShadowOffsetX());
        slShadowY.setValue(sg.getShadowOffsetY());
        slShadowBlur.setValue(sg.getShadowBlur());
        slShadowSpread.setValue(sg.getShadowSpread());
        cbGlow.setSelected(sg.getGlowEnable() == 1);
        cpGlowColor.setValue(parseColor(sg.getGlowColorHex()));
        slGlowBlur.setValue(sg.getGlowBlur());
        slGlowOpacity.setValue(sg.getGlowOpacity());

        isUpdating = false;
    }

    private void refreshUI() {
        isUpdating = true;

        BaseMargin margin = template.getBaseMargin();
        cbMarginLock.setSelected(margin.getMarginLock() == 1);
        cbBgBlur.setSelected(margin.getBgBlurEnable() == 1);
        cbBgBlurWhite.setSelected(margin.getBgBlurWhiteOverlay() == 1);
        slBgBlurRadius.setValue(margin.getBgBlurRadius());
        slBgBlurIntensity.setValue(BorderProcessor.getBlurIntensity());
        boolean marginLocked = margin.getMarginLock() == 1;
        tfMarginTop.setDisable(marginLocked);
        tfMarginBottom.setDisable(marginLocked);
        tfMarginLeft.setDisable(marginLocked);
        tfMarginRight.setDisable(marginLocked);
        slGlobalMargin.setDisable(marginLocked);
        tfMarginTop.setText(String.valueOf(margin.getMarginTop()));
        tfMarginBottom.setText(String.valueOf(margin.getMarginBottom()));
        tfMarginLeft.setText(String.valueOf(margin.getMarginLeft()));
        tfMarginRight.setText(String.valueOf(margin.getMarginRight()));
        slGlobalMargin.setValue(1.0);
        refMargins[0] = margin.getMarginTop();
        refMargins[1] = margin.getMarginBottom();
        refMargins[2] = margin.getMarginLeft();
        refMargins[3] = margin.getMarginRight();
        slImgScale.setValue(margin.getImgScale());
        tfImgOffsetX.setText(String.valueOf(margin.getImgOffsetX()));
        tfImgOffsetY.setText(String.valueOf(margin.getImgOffsetY()));
        slParamFontSize.setValue(template.getParamFontSize());
        BorderProcessor.setExifFontSize((int) slParamFontSize.getValue());
        lblParamFontSize.setText((int)slParamFontSize.getValue() + "px");

        updateLayerList();
        cbLayerSelect.getSelectionModel().select(0);
        loadLayerToUI();

        CornerConfig corner = template.getCornerConfig();
        cbCornerLock.setSelected(corner.getCornerLock() == 1);
        slCornerRadius.setValue(corner.getCornerRadiusAll());
        slCornerTL.setValue(corner.getCornerRadiusTL());
        slCornerTR.setValue(corner.getCornerRadiusTR());
        slCornerBL.setValue(corner.getCornerRadiusBL());
        slCornerBR.setValue(corner.getCornerRadiusBR());

        FilmTearConfig tear = template.getFilmTearConfig();
        cbTearEnable.setSelected(tear.getTearEnable() == 1);
        slTearStrength.setValue(tear.getTearStrength());
        slTearDensity.setValue(tear.getTearDensity());

        LightEffect light = template.getLightEffect();
        cbVignette.setSelected(light.getVignetteEnable() == 1);
        slVignetteStrength.setValue(light.getVignetteStrength());
        cbLightLeak.setSelected(light.getLightLeakEnable() == 1);
        cbLeakType.setValue(light.getLightLeakType());

        TextStickerConfig decor = template.getDecorConfig();
        cbExifText.setSelected(decor.getExifAutoText() == 1);
        cbCornerDecor.setSelected(decor.getCornerDecorEnable() == 1);
        slCornerDecorSize.setValue(decor.getCornerDecorSize());

        isUpdating = false;
    }

    private void updateLayerList() {
        int oldIdx = cbLayerSelect.getSelectionModel().getSelectedIndex();
        List<String> items = new ArrayList<>();
        for (int i = 0; i < template.getLayerList().size(); i++) {
            items.add("图层 " + (i + 1));
        }
        cbLayerSelect.setItems(FXCollections.observableArrayList(items));
        if (oldIdx >= 0 && oldIdx < items.size()) {
            cbLayerSelect.getSelectionModel().select(oldIdx);
        } else if (!items.isEmpty()) {
            cbLayerSelect.getSelectionModel().select(0);
        }
    }

    @FXML
    private void onOpenImage() {
        FileChooser fc = new FileChooser();
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("图片文件", "*.jpg", "*.jpeg", "*.png", "*.bmp", "*.tiff", "*.webp"));
        fc.setTitle("选择图片");
        List<File> files = fc.showOpenMultipleDialog(btnOpenImage.getScene().getWindow());
        if (files != null && !files.isEmpty()) {
            loadImage(files.get(0));
            for (int i = 1; i < files.size(); i++) {
                imageFiles.add(files.get(i));
            }
            updateFilmStrip();
        }
    }

    private void setupDragDrop() {
        rootPane.sceneProperty().addListener((obs, oldScene, newScene) -> {
            if (newScene != null) {
                newScene.setOnDragOver(e -> {
                    if (e.getDragboard().hasFiles()) {
                        e.acceptTransferModes(TransferMode.COPY);
                    }
                    e.consume();
                });
                newScene.setOnDragDropped(e -> {
                    statusLabel.setText("检测到拖放...");
                    var db = e.getDragboard();
                    boolean ok = false;
                    if (db.hasFiles()) {
                        for (File f : db.getFiles()) {
                            String n = f.getName().toLowerCase();
                            if (n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png")
                                    || n.endsWith(".bmp") || n.endsWith(".tiff") || n.endsWith(".webp")) {
                                if (!ok) {
                                    loadImage(f);
                                    ok = true;
                                } else {
                                    imageFiles.add(f);
                                }
                            } else {
                                statusLabel.setText("不支持的文件格式: " + n);
                            }
                        }
                        if (ok) updateFilmStrip();
                    }
                    e.setDropCompleted(ok);
                    e.consume();
                });
                newScene.setOnDragEntered(e -> {
                    if (e.getDragboard().hasFiles()) {
                        dropTarget.setStyle("-fx-border-color: #4a90d9; -fx-border-width: 3; -fx-border-style: dashed; -fx-background-color: rgba(74,144,217,0.1);");
                    }
                });
                newScene.setOnDragExited(e -> {
                    dropTarget.setStyle("-fx-border-color: transparent;");
                });
            }
        });
    }

    private void loadImage(File file) {
        try {
            // Save current template for the image being left
            if (currentImageIndex >= 0 && currentImageIndex < imageFiles.size()) {
                File oldFile = imageFiles.get(currentImageIndex);
                if (oldFile != null && !oldFile.equals(file)) {
                    syncModelFromUI();
                    imageTemplates.put(oldFile, cloneTemplate(template));
                }
            }

            int idx = imageFiles.indexOf(file);
            if (idx < 0) {
                imageFiles.add(file);
                idx = imageFiles.size() - 1;
            }
            currentImageIndex = idx;

            // Restore saved template for this image, or start fresh
            TemplateModel saved = imageTemplates.get(file);
            if (saved != null) {
                template = saved;
            } else {
                template = new TemplateModel();
            }

            selectedIndices.clear();
            selectedIndices.add(idx);
            originImage = new Image(file.toURI().toString(), false);

            ExifReader.ExifData exifData = ExifReader.parse(file);
            BorderProcessor.setExifData(exifData);

            if (exifData != null) {
                tfExifBrand.setText(exifData.make != null ? exifData.make : "");
                tfExifModel.setText(exifData.model != null ? exifData.model : "");
                tfExifFocal.setText(exifData.focalLength != null ? exifData.focalLength : "");
                tfExifAperture.setText(exifData.aperture != null ? exifData.aperture : "");
                tfExifIso.setText(exifData.iso != null ? exifData.iso : "");
                tfExifShutter.setText(exifData.shutter != null ? exifData.shutter : "");
            }

            if (saved == null && cbExifText.isSelected()) {
                Map<String, String> exif = ExifTextParser.readExif(file.getAbsolutePath());
                String exifText = ExifTextParser.formatExifText(exif, "");
                if (!exifText.isEmpty()) {
                    TextStickerConfig.TextLine line = new TextStickerConfig.TextLine();
                    line.setText(exifText);
                    line.setAlign("bottom");
                    template.getDecorConfig().getTextLines().clear();
                    template.getDecorConfig().getTextLines().add(line);
                }
            }

            refreshUI();

            lblImageInfo.setText((idx + 1) + "/" + imageFiles.size() + " " + file.getName() + " (" + (int)originImage.getWidth() + "x" + (int)originImage.getHeight() + ")");
            statusLabel.setText("已加载: " + file.getName());

            renderPreview();
        } catch (Exception e) {
            statusLabel.setText("加载失败: " + e.getMessage());
        }
    }

    private void updateFilmStrip() {
        if (imageFiles.isEmpty()) {
            filmStrip.setVisible(false);
            return;
        }
        filmStrip.setVisible(true);
        thumbGeneration++;
        thumbnailBox.getChildren().clear();
        for (int i = 0; i < imageFiles.size(); i++) {
            File f = imageFiles.get(i);

            StackPane container = new StackPane();
            container.setPadding(new javafx.geometry.Insets(2));
            container.setCursor(Cursor.HAND);

            ImageView iv = new ImageView();
            iv.setFitWidth(96);
            iv.setFitHeight(96);
            iv.setPreserveRatio(true);

            // 先显示原图占位（异步加载，不阻塞 UI）
            Image raw = new Image(f.toURI().toString(), 96, 96, true, true, true);
            iv.setImage(raw);

            // 检查缓存，如有带边框缩略图直接替换
            Image cached = thumbCache.get(f);
            if (cached != null && cached.getWidth() > 0) {
                iv.setImage(cached);
            }

            String style;
            if (i == currentImageIndex && selectedIndices.contains(i)) {
                style = "-fx-effect: dropshadow(gaussian, rgba(52,137,232,0.5), 6, 0.8, 0, 0); -fx-border-color: #3489E8; -fx-border-width: 3; -fx-background-color: rgba(52,137,232,0.15);";
            } else if (selectedIndices.contains(i)) {
                style = "-fx-border-color: #3489E8; -fx-border-width: 2; -fx-background-color: rgba(52,137,232,0.08);";
            } else {
                style = "-fx-border-color: transparent; -fx-border-width: 2; -fx-background-color: #2A2A2A;";
            }
            container.setStyle(style);

            // 点击缩放反馈
            container.setOnMousePressed(ev -> {
                container.setScaleX(0.92);
                container.setScaleY(0.92);
                PauseTransition pt = new PauseTransition(Duration.millis(80));
                pt.setOnFinished(e -> {
                    container.setScaleX(1.0);
                    container.setScaleY(1.0);
                });
                pt.play();
            });

            int idx = i;
            container.setOnMouseClicked(e -> {
                if (e.isControlDown()) {
                    if (selectedIndices.contains(idx)) {
                        selectedIndices.remove(idx);
                    } else {
                        selectedIndices.add(idx);
                    }
                } else {
                    selectedIndices.clear();
                    selectedIndices.add(idx);
                    switchToImage(idx);
                }
                updateFilmStrip();
            });

            container.getChildren().add(iv);
            thumbnailBox.getChildren().add(container);

            // 后台队列渲染带边框缩略图，完成后替换（单线程队列，避免并发风暴）
            TemplateModel imgTmpl = imageTemplates.getOrDefault(f, template);
            scheduleThumbnail(idx, f, imgTmpl);
        }
    }

    private void scheduleThumbnail(int idx, File file, TemplateModel tmpl) {
        final long gen = thumbGeneration;
        thumbExecutor.execute(() -> {
            if (gen != thumbGeneration) return;
            Image thumb = getOrCreateThumbnail(file, tmpl);
            if (thumb == null || gen != thumbGeneration) return;
            Platform.runLater(() -> {
                if (gen != thumbGeneration) return;
                if (idx < thumbnailBox.getChildren().size()) {
                    Node node = thumbnailBox.getChildren().get(idx);
                    if (node instanceof StackPane) {
                        ImageView innerIv = (ImageView) ((StackPane) node).getChildren().get(0);
                        innerIv.setImage(thumb);
                    }
                }
            });
        });
    }

    private void switchToImage(int idx) {
        if (idx < 0 || idx >= imageFiles.size() || idx == currentImageIndex) return;
        loadImage(imageFiles.get(idx));
    }

    private void selectAllImages() {
        if (imageFiles.isEmpty()) return;
        selectedIndices.clear();
        for (int i = 0; i < imageFiles.size(); i++) {
            selectedIndices.add(i);
        }
        updateFilmStrip();
        statusLabel.setText("已选中 " + selectedIndices.size() + " 张图片");
    }

    private void setExportUI(boolean exporting) {
        btnBatchExport.setDisable(exporting);
        btnSaveImage.setDisable(exporting);
        btnBatchExport.setText(exporting ? "📦 导出中..." : "📦 批量导出");
        btnSaveImage.setText(exporting ? "💾 导出中..." : "💾 导出图片");
    }

    private void exportSelectedImages() {
        if (selectedIndices.isEmpty()) return;
        javafx.stage.DirectoryChooser dc = new javafx.stage.DirectoryChooser();
        dc.setTitle("选择导出目录");
        File lastDir = getLastExportDir();
        if (lastDir != null) dc.setInitialDirectory(lastDir);
        File exportDir = dc.showDialog(previewCanvas.getScene().getWindow());
        if (exportDir == null) return;
        saveLastExportDir(exportDir);

        syncModelFromUI();
        isExporting = true;
        setExportUI(true);

        String fmt = cbExportFormat.getValue();
        float jpegQuality = 0.9f;
        List<File> files = new ArrayList<>();
        for (int idx : selectedIndices) {
            files.add(imageFiles.get(idx));
        }
        int total = files.size();

        progressBar.setVisible(true);
        progressBar.setProgress(0);
        exportImagesInParallel(files, exportDir, fmt, jpegQuality);
    }

    /**
     * 批量导出：解码与写盘阶段并行（有限线程池），
     * 渲染因依赖 Canvas snapshot 仍在界面线程串行执行；输出内容与顺序无关，结果与串行版本一致。
     */
    private void exportImagesInParallel(List<File> files, File exportDir, String fmt, float jpegQuality) {
        int threads = Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors()));
        ExecutorService pool = Executors.newFixedThreadPool(threads, r -> {
            Thread t = new Thread(r, "export-worker");
            t.setDaemon(true);
            return t;
        });
        // 导出开始前固化当前设置，避免导出过程中界面改动影响后续图片
        TemplateModel exportTemplate = cloneTemplate(template);
        // 自动编号：从目录已有最大编号 +1 开始，批内原子递增，保证不重复
        String ext = "png".equalsIgnoreCase(fmt) ? "png" : "jpg";
        AtomicInteger fileNum = new AtomicInteger(nextExportNumber(exportDir, ext));
        int total = files.size();
        AtomicInteger completed = new AtomicInteger(0);
        AtomicInteger failed = new AtomicInteger(0);
        CountDownLatch allDone = new CountDownLatch(total);
        long startTime = System.currentTimeMillis();

        for (File src : files) {
            final String fileName = src.getName();
            pool.execute(() -> {
                try {
                    WritableImage result = renderFileOnFxThread(src, exportTemplate);
                    int n = fileNum.getAndIncrement();
                    String outPath = exportDir.getAbsolutePath() + File.separator +
                            FileUtil.getFileNameWithoutExt(fileName) + "_bordered_" + String.format("%03d", n) + "." + ext;
                    ImageExportUtil.export(result, outPath, fmt, jpegQuality);
                } catch (Exception e) {
                    failed.incrementAndGet();
                    e.printStackTrace();
                    Platform.runLater(() -> showAlert("跳过损坏文件: " + fileName + "\n" + e.getMessage()));
                }
                int doneN = completed.incrementAndGet();
                allDone.countDown();
                if (doneN % 5 == 0 || doneN == total) {
                    final double p = (double) doneN / total;
                    final String label = "正在导出 " + doneN + "/" + total + " - " + fileName;
                    Platform.runLater(() -> {
                        progressBar.setProgress(p);
                        statusLabel.setText(label);
                    });
                }
            });
        }
        pool.shutdown();

        new Thread(() -> {
            try {
                allDone.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            final int failedFinal = failed.get();
            final int doneFinal = total - failedFinal;
            final long elapsed = (System.currentTimeMillis() - startTime + 500) / 1000;
            Platform.runLater(() -> {
                isExporting = false;
                setExportUI(false);
                progressBar.setVisible(false);
                String msg = "导出完成 成功" + doneFinal + "张";
                if (failedFinal > 0) msg += " 跳过" + failedFinal + "张";
                msg += " 用时" + elapsed + "秒";
                statusLabel.setText(msg);
            });
        }).start();
    }

    /** 读取上次导出目录（无记录或已失效返回 null） */
    private File getLastExportDir() {
        try {
            String p = java.nio.file.Files.readString(
                    java.nio.file.Paths.get(EXPORT_SETTINGS_FILE), StandardCharsets.UTF_8).trim();
            if (!p.isEmpty()) {
                File f = new File(p);
                if (f.isDirectory()) return f;
            }
        } catch (Exception ignored) {}
        return null;
    }

    /** 记住导出目录，供下次导出默认打开 */
    private void saveLastExportDir(File dir) {
        if (dir == null) return;
        try {
            java.nio.file.Files.writeString(
                    java.nio.file.Paths.get(EXPORT_SETTINGS_FILE), dir.getAbsolutePath(), StandardCharsets.UTF_8);
        } catch (Exception ignored) {}
    }

    /** 扫描目录中 *_bordered_NNN.ext 文件，返回下一个编号（跨会话不重复） */
    private int nextExportNumber(File dir, String ext) {
        int max = 0;
        File[] files = dir.listFiles();
        if (files != null) {
            String suffix = "_bordered_";
            String lowerExt = ext.toLowerCase();
            for (File f : files) {
                String name = f.getName().toLowerCase();
                if (name.endsWith("." + lowerExt) && name.contains(suffix)) {
                    int idx = name.lastIndexOf(suffix);
                    String numPart = name.substring(idx + suffix.length(), name.length() - lowerExt.length() - 1);
                    try {
                        max = Math.max(max, Integer.parseInt(numPart));
                    } catch (Exception ignored) {}
                }
            }
        }
        return max + 1;
    }

    @FXML
    private void onSyncToSelected() {
        if (selectedIndices.size() < 2) {
            showAlert("请选中至少两张图片（Ctrl+单击多选）");
            return;
        }
        syncModelFromUI();
        int count = 0;
        for (int idx : selectedIndices) {
            if (idx == currentImageIndex) continue;
            // 真正把当前边框同步到选中的图片：切换预览与导出都使用同一套边框
            imageTemplates.put(imageFiles.get(idx), cloneTemplate(template));
            count++;
        }
        clearThumbCache();
        updateFilmStrip();
        statusLabel.setText("已同步边框到 " + count + " 张图片");
    }

    @FXML
    private void onUndo() {
        if (undoStack.isEmpty()) return;
        redoStack.push(cloneTemplate(template));
        template = undoStack.pop();
        refreshUI();
        renderPreview();
    }

    @FXML
    private void onRedo() {
        if (redoStack.isEmpty()) return;
        undoStack.push(cloneTemplate(template));
        template = redoStack.pop();
        refreshUI();
        renderPreview();
    }

    private TemplateModel cloneTemplate(TemplateModel src) {
        try {
            String json = com.qingframe.util.JsonUtil.toJson(src);
            return com.qingframe.util.JsonUtil.fromJson(json);
        } catch (Exception e) {
            return new TemplateModel();
        }
    }

    @FXML
    private void onZoomIn() {
        zoomSlider.setValue(Math.min(3.0, zoomSlider.getValue() + 0.2));
    }

    @FXML
    private void onZoomOut() {
        zoomSlider.setValue(Math.max(0.1, zoomSlider.getValue() - 0.2));
    }

    @FXML
    private void onZoomFit() {
        zoomSlider.setValue(1.0);
    }

    @FXML
    private void onResetAll() {
        template = new TemplateModel();
        BorderProcessor.setExifData(null);
        refreshUI();
        renderPreview();
    }

    @FXML
    private void onCompareToggle() {
        template.setCompareMode(template.getCompareMode() == 0 ? 1 : 0);
        renderPreview();
    }

    @FXML
    private void onPresetNoBorder() {
        template = createPreset("无边框");
        refreshUI();
        renderPreview();
    }

    @FXML
    private void onPresetSimpleWhite() {
        template = createPreset("简约白边");
        refreshUI();
        renderPreview();
    }

    @FXML
    private void onPresetRounded() {
        template = createPreset("圆角边框");
        refreshUI();
        renderPreview();
    }

    @FXML
    private void onPresetVintage() {
        template = createPreset("复古边框");
        refreshUI();
        renderPreview();
    }

    @FXML
    private void onPresetPolaroid() {
        template = createPreset("拍立得");
        refreshUI();
        renderPreview();
    }

    @FXML
    private void onPresetFilm() {
        template = createPreset("胶片框");
        refreshUI();
        renderPreview();
    }

    @FXML
    private void onPresetDoubleLine() {
        template = createPreset("双线边框");
        refreshUI();
        renderPreview();
    }

    @FXML
    private void onPresetShadow() {
        template = createPreset("投影边框");
        refreshUI();
        renderPreview();
    }

    @FXML
    private void onBlurNormal() {
        template.setPhotoFrameStyle("BLUR_CLASSIC");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onBlurWhite() {
        template.setPhotoFrameStyle("BLUR_DATE");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onBlurImageBg() {
        template.setPhotoFrameStyle("BLUR_CLASSIC");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onSelectBgImage() {
        FileChooser fc = new FileChooser();
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("图片", "*.png", "*.jpg", "*.jpeg"));
        File file = fc.showOpenDialog(previewCanvas.getScene().getWindow());
        if (file != null) {
            BorderProcessor.setBgImagePath(file.getAbsolutePath());
            template.getBaseMargin().setBgBlurEnable(1);
            onSettingChanged();
        }
    }

    @FXML
    private void onWatermarkExif() {
        template.setPhotoFrameStyle("WM_CLASSIC");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onWatermarkSingle() {
        template.setPhotoFrameStyle("WM_SINGLE");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onWatermarkBrand() {
        template.setPhotoFrameStyle("WM_BRAND_LOGO");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onPresetImpFrosted() {
        template.setPhotoFrameStyle("IMP_FROSTED");
        template.setPhotoFrameBorderSize(40);
        onSettingChanged();
    }

    @FXML
    private void onPresetImpClassic() {
        template.setPhotoFrameStyle("IMP_CLASSIC");
        template.setPhotoFrameBorderSize(40);
        onSettingChanged();
    }

    @FXML
    private void onPresetXiaomiImp() {
        template.setPhotoFrameStyle("XIAOMI_IMP");
        template.setPhotoFrameBorderSize(50);
        onSettingChanged();
    }

    @FXML
    private void onPresetCardLeica() {
        template.setPhotoFrameStyle("CARD_LEICA");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    /** 浮影白框：平面悬浮卡片（等宽白色衬边 + 柔和弥散投影） */
    @FXML
    private void onPresetFloatWhite() {
        TemplateModel loaded = loadPresetFromJson("浮影白框");
        template = (loaded != null) ? loaded : createPreset("浮影白框");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: 浮影白框（白色衬边 + 柔和悬浮投影）");
    }

    @FXML
    private void onPresetCardLogoParam() {
        template.setPhotoFrameStyle("CARD_LOGO_PARAM");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onPresetCardPureLogo() {
        template.setPhotoFrameStyle("CARD_PURE_LOGO");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onPresetCardSimple() {
        template.setPhotoFrameStyle("CARD_SIMPLE");
        template.setPhotoFrameBorderSize(40);
        onSettingChanged();
    }

    @FXML
    private void onPresetCardImmersion() {
        template.setPhotoFrameStyle("CARD_IMMERSION");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onPresetColorClassic() {
        template.setPhotoFrameStyle("COLOR_CLASSIC");
        template.setPhotoFrameBorderSize(50);
        onSettingChanged();
    }

    @FXML
    private void onPresetColorRefined() {
        template.setPhotoFrameStyle("COLOR_REFINED");
        template.setPhotoFrameBorderSize(50);
        onSettingChanged();
    }

    @FXML
    private void onPresetArtCard() {
        template.setPhotoFrameStyle("ART_CARD");
        template.setPhotoFrameBorderSize(50);
        onSettingChanged();
    }

    @FXML
    private void onPresetWhitePlain() {
        template.setPhotoFrameStyle("WHITE_PLAIN");
        template.setPhotoFrameBorderSize(40);
        onSettingChanged();
    }

    @FXML
    private void onPresetFujiWhite() {
        template.setPhotoFrameStyle("FUJI_WHITE");
        template.setPhotoFrameBorderSize(50);
        onSettingChanged();
    }

    @FXML
    private void onPresetParamTopLeft() {
        template.setPhotoFrameStyle("PARAM_TOP_LEFT");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onPresetParamBottomLeft() {
        template.setPhotoFrameStyle("PARAM_BOTTOM_LEFT");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onPresetParamBottomSingle() {
        template.setPhotoFrameStyle("PARAM_BOTTOM_SINGLE");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onPresetSimpleFilm() {
        template.setPhotoFrameStyle("SIMPLE_FILM");
        template.setPhotoFrameBorderSize(60);
        onSettingChanged();
    }

    @FXML
    private void onSaveImage() {
        if (originImage == null) {
            showAlert("请先打开一张图片");
            return;
        }
        FileChooser fc = new FileChooser();
        fc.setTitle("保存导出图片");
        fc.getExtensionFilters().addAll(
                new FileChooser.ExtensionFilter("JPEG 图片 (*.jpg)", "*.jpg"),
                new FileChooser.ExtensionFilter("PNG 图片 (*.png)", "*.png"));
        String fmt = cbExportFormat.getValue();
        if ("PNG".equals(fmt)) {
            fc.setSelectedExtensionFilter(fc.getExtensionFilters().get(1));
        }
        File lastDir = getLastExportDir();
        if (lastDir != null) fc.setInitialDirectory(lastDir);
        String ext = "PNG".equals(fmt) ? "png" : "jpg";
        String base = "output";
        if (currentImageIndex >= 0 && currentImageIndex < imageFiles.size()) {
            base = FileUtil.getFileNameWithoutExt(imageFiles.get(currentImageIndex).getName());
        }
        int num = (lastDir != null && lastDir.exists()) ? nextExportNumber(lastDir, ext) : 1;
        fc.setInitialFileName(base + "_bordered_" + String.format("%03d", num) + "." + ext);
        File file = fc.showSaveDialog(btnSaveImage.getScene().getWindow());
        if (file == null) return;
        saveLastExportDir(file.getParentFile());

        setExportUI(true);
        progressBar.setVisible(true);
        progressBar.setProgress(-1);
        statusLabel.setText("正在渲染导出…");

        syncModelFromUI();

        final File outFile = file;
        final float quality = 0.9f;
        final String format = outFile.getName().toLowerCase().endsWith(".png") ? "png" : "jpg";
        final TemplateModel exportTemplate = cloneTemplate(template);

        // 导出全程后台执行：读图/缩放/写文件不占界面线程，界面线程只做渲染快照（短暂）
        new Thread(() -> {
            try {
                logExport("== 开始导出: " + outFile.getName());
                // 1. 后台读取当前照片
                BufferedImage awt = null;
                if (currentImageIndex >= 0 && currentImageIndex < imageFiles.size()) {
                    File srcFile = imageFiles.get(currentImageIndex);
                    logExport("照片文件: " + srcFile.getAbsolutePath());
                    try {
                        awt = ImageIO.read(srcFile);
                        ExifReader.ExifData exif = ExifReader.parse(srcFile);
                        if (awt != null && exif != null) {
                            awt = applyOrientation(awt, exif.orientation);
                        }
                        logExport(awt != null ? ("ImageIO 读取成功: " + awt.getWidth() + "x" + awt.getHeight())
                                : "ImageIO 读取返回 null（将回退到界面图像）");
                    } catch (Exception ex) {
                        logExport("ImageIO 读取异常: " + ex);
                        awt = null;
                    }
                }
                if (awt == null) {
                    // 回退：界面线程做一次像素转换
                    logExport("回退：从界面图像转换像素");
                    CountDownLatch latch = new CountDownLatch(1);
                    AtomicReference<BufferedImage> ref = new AtomicReference<>();
                    Platform.runLater(() -> {
                        try {
                            ref.set(SwingFXUtils.fromFXImage(originImage, null));
                            logExport("界面图像转换成功: " + originImage.getWidth() + "x" + originImage.getHeight());
                        } finally {
                            latch.countDown();
                        }
                    });
                    latch.await();
                    awt = ref.get();
                }
                if (awt == null) throw new IOException("无法读取照片");

                // 2. 渲染（超大图自动预降级；失败再分级缩小，界面线程只做快照）
                WritableImage result = renderAwtWithFallback(awt, exportTemplate);
                logExport(result != null ? "渲染成功: " + (int) result.getWidth() + "x" + (int) result.getHeight()
                        : "渲染失败（全部分级均空白）");
                if (result == null) {
                    final int pw = awt.getWidth();
                    final int ph = awt.getHeight();
                    final String tn = exportTemplate.getTemplateName();
                    Platform.runLater(() -> {
                        setExportUI(false);
                        progressBar.setVisible(false);
                        showAlert("渲染结果异常（接近全白/透明），且自动缩放后仍失败。\n照片: "
                                + pw + "x" + ph + "  模板: " + tn
                                + "\n渲染环境可能已异常，请完全退出软件后重新打开，再导出一次；"
                                + "若仍失败，请把 C:\\Users\\" + System.getProperty("user.name")
                                + "\\QingFrameShadow-export.log 内容发给我。");
                    });
                    return;
                }

                // 3. 后台写文件
                ImageExportUtil.export(result, outFile.getAbsolutePath(), format, quality);
                Platform.runLater(() -> {
                    setExportUI(false);
                    progressBar.setVisible(false);
                    statusLabel.setText("已导出: " + outFile.getName());
                });
            } catch (Exception e) {
                e.printStackTrace();
                logExport("导出异常: " + e);
                Platform.runLater(() -> {
                    setExportUI(false);
                    progressBar.setVisible(false);
                    showAlert("导出失败: " + e.getMessage());
                });
            }
        }).start();
    }

    @FXML
    private void onAddLayer() {
        LayerBorder newLayer = new LayerBorder();
        newLayer.getFillConfig().setFillHex("#eeeeee");
        template.getLayerList().add(newLayer);
        updateLayerList();
        cbLayerSelect.getSelectionModel().select(template.getLayerList().size() - 1);
        onSettingChanged();
    }

    @FXML
    private void onRemoveLayer() {
        if (template.getLayerList().size() <= 1) {
            showAlert("至少保留一个图层");
            return;
        }
        int idx = cbLayerSelect.getSelectionModel().getSelectedIndex();
        if (idx >= 0) {
            template.getLayerList().remove(idx);
            updateLayerList();
            cbLayerSelect.getSelectionModel().select(Math.min(idx, template.getLayerList().size() - 1));
            onSettingChanged();
        }
    }

    @FXML
    private void onResetLayer() {
        LayerBorder layer = getCurrentLayer();
        if (layer != null) {
            int idx = cbLayerSelect.getSelectionModel().getSelectedIndex();
            template.getLayerList().set(idx, new LayerBorder());
            loadLayerToUI();
            onSettingChanged();
        }
    }

    @FXML
    private void onSelectTexture() {
        FileChooser fc = new FileChooser();
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("纹理图片", "*.png", "*.jpg", "*.jpeg"));
        File file = fc.showOpenDialog(previewCanvas.getScene().getWindow());
        if (file != null) {
            LayerBorder layer = getCurrentLayer();
            if (layer != null) {
                layer.getFillConfig().setTextureSrc(file.toURI().toString());
                layer.getFillConfig().setFillType("texture");
                cbFillType.setValue("texture");
                onSettingChanged();
            }
        }
    }

    @FXML
    private void onAddTextLine() {
        String text = tfCustomText.getText();
        if (text == null || text.trim().isEmpty()) return;
        TextStickerConfig.TextLine line = new TextStickerConfig.TextLine();
        line.setText(text.trim());
        line.setFontSize(slTextSize.getValue());
        line.setColorHex(toHex(cpTextColor.getValue()));
        template.getDecorConfig().getTextLines().add(line);
        onSettingChanged();
        tfCustomText.clear();
    }

    @FXML
    private void onAddSticker() {
        FileChooser fc = new FileChooser();
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("贴纸图片", "*.png", "*.jpg", "*.jpeg"));
        File file = fc.showOpenDialog(previewCanvas.getScene().getWindow());
        if (file != null) {
            TextStickerConfig.Sticker sticker = new TextStickerConfig.Sticker();
            sticker.setSrc(file.toURI().toString());
            sticker.setX(previewCanvas.getWidth() / 2);
            sticker.setY(previewCanvas.getHeight() / 2);
            template.getDecorConfig().getStickers().add(sticker);
            onSettingChanged();
        }
    }

    @FXML
    private void onSaveTemplate() {
        try {
            syncModelFromUI();
            String name = tfTemplateName.getText();
            if (name.isEmpty()) name = template.getTemplateName();
            template.setTemplateName(name);
            template.setTemplateTag(tfTemplateTag.getText());
            String dir = FileUtil.getDefaultTemplateDir();
            String path = dir + File.separator + name + ".qfs";
            JsonUtil.saveToFile(template, path);
            statusLabel.setText("模板已保存: " + name);
        } catch (Exception e) {
            showAlert("保存失败: " + e.getMessage());
        }
    }

    @FXML
    private void onLoadTemplate() {
        FileChooser fc = new FileChooser();
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("清框影模板", "*.qfs"));
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("JSON 文件", "*.json"));
        File file = fc.showOpenDialog(previewCanvas.getScene().getWindow());
        if (file != null) {
            try {
                template = JsonUtil.loadFromFile(file.getAbsolutePath());
                refreshUI();
                renderPreview();
                updateFilmStrip();
                statusLabel.setText("已加载模板: " + file.getName());
            } catch (Exception e) {
                showAlert("加载失败: " + e.getMessage());
            }
        }
    }

    @FXML
    private void onLoadPreset() {
        String selected = lvPresets.getSelectionModel().getSelectedItem();
        if (selected == null) return;
        if ("自动取色边框".equals(selected)) {
            onPresetAutoColor();
            return;
        }
        TemplateModel loaded = loadPresetFromJson(selected);
        template = (loaded != null) ? loaded : createPreset(selected);
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: " + selected);
    }

    /** 内置预设 = 代码预设 + classpath 下的 JSON 预设 + 自动取色 */
    private List<String> loadPresetList() {
        List<String> list = new ArrayList<>(List.of("极简白框", "复古胶片", "拍立得", "证件照", "电影宽屏"));
        for (String name : scanResourceDir("com/qingframe/presets")) {
            if (!list.contains(name)) list.add(name);
        }
        list.add("自动取色边框");
        return list;
    }

    /** 扫描 classpath 指定目录下的 .json 预设文件名（兼容开发目录与打包后 jar） */
    private List<String> scanResourceDir(String path) {
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

    private TemplateModel loadPresetFromJson(String name) {
        try (InputStream in = getClass().getResourceAsStream("/com/qingframe/presets/" + name + ".json")) {
            if (in == null) return null;
            String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            return JsonUtil.fromJson(json);
        } catch (Exception e) {
            return null;
        }
    }

    /** 从照片提取主色生成同色系边框 */
    private void onPresetAutoColor() {
        if (originImage == null) {
            showAlert("请先打开一张图片，自动取色需要以照片为参考");
            return;
        }
        BufferedImage awt = SwingFXUtils.fromFXImage(originImage, null);
        java.awt.Color[] colors = BorderProcessor.extractDominantColors(awt);
        if (colors == null || colors.length == 0) {
            showAlert("取色失败，请重试");
            return;
        }
        undoStack.push(cloneTemplate(template));
        redoStack.clear();
        template = new TemplateModel();
        template.getBaseMargin().setMarginTop(70);
        template.getBaseMargin().setMarginBottom(70);
        template.getBaseMargin().setMarginLeft(70);
        template.getBaseMargin().setMarginRight(70);
        template.getBaseMargin().setImgScale(0.95);
        String main = toHex(colors[0]);
        String sec = colors.length > 1 ? toHex(colors[1]) : "#ffffff";
        LayerBorder layer = template.getLayerList().get(0);
        layer.getFillConfig().setFillHex(main);
        layer.getStrokeConfig().setStrokeWidth(3);
        layer.getStrokeConfig().setStrokeColorHex(sec);
        ShadowGlowConfig sg = layer.getShadowGlowConfig();
        sg.setShadowEnable(1);
        sg.setShadowOffsetX(4);
        sg.setShadowOffsetY(4);
        sg.setShadowBlur(12);
        sg.setShadowOpacity(35);
        refreshUI();
        renderPreview();
        statusLabel.setText("已从照片提取主色生成边框（主色 " + main + "）");
    }

    private String toHex(java.awt.Color c) {
        return String.format("#%02x%02x%02x", c.getRed(), c.getGreen(), c.getBlue());
    }

    /** 一键随机边框：随机组合边距/图层/描边/阴影/圆角/光效/胶片效果 */
    @FXML
    private void onRandomizeBorder() {
        if (originImage == null) {
            showAlert("请先打开一张图片作为参考");
            return;
        }
        undoStack.push(cloneTemplate(template));
        redoStack.clear();
        template = randomTemplate();
        refreshUI();
        renderPreview();
        statusLabel.setText("已生成随机边框，不满意可继续 🎲 或按 ↩ 撤销");
    }

    private TemplateModel randomTemplate() {
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

    /** 内置纹理选择：从 classpath 的 textures 目录弹出选择框 */
    @FXML
    private void onBuiltinTexture() {
        List<String> names = scanResourceDir("com/qingframe/textures");
        if (names.isEmpty()) {
            showAlert("未找到内置纹理");
            return;
        }
        ChoiceDialog<String> dialog = new ChoiceDialog<>(names.get(0), names);
        dialog.setTitle("内置纹理");
        dialog.setHeaderText("选择一种纹理作为当前图层填充");
        dialog.setContentText("纹理：");
        dialog.showAndWait().ifPresent(name -> {
            String url = getClass().getResource("/com/qingframe/textures/" + name).toExternalForm();
            LayerBorder layer = getCurrentLayer();
            if (layer != null) {
                layer.getFillConfig().setTextureSrc(url);
                layer.getFillConfig().setFillType("texture");
                cbFillType.setValue("texture");
                onSettingChanged();
            }
        });
    }

    @FXML
    private void onBatchExport() {
        if (isExporting) return;
        if (!selectedIndices.isEmpty()) {
            exportSelectedImages();
            return;
        }
        if (originImage == null) {
            showAlert("请先打开一张图片作为样式参考，然后选择批量文件夹");
            return;
        }
        javafx.stage.DirectoryChooser dc = new javafx.stage.DirectoryChooser();
        dc.setTitle("选择图片文件夹");
        File dir = dc.showDialog(previewCanvas.getScene().getWindow());
        if (dir == null) return;

        List<String> images = FileUtil.listImageFiles(dir.getAbsolutePath());
        if (images.isEmpty()) {
            showAlert("文件夹中没有找到图片");
            return;
        }

        javafx.stage.DirectoryChooser outDir = new javafx.stage.DirectoryChooser();
        outDir.setTitle("选择导出目录");
        File lastDir = getLastExportDir();
        if (lastDir != null) outDir.setInitialDirectory(lastDir);
        File exportDir = outDir.showDialog(previewCanvas.getScene().getWindow());
        if (exportDir == null) return;
        saveLastExportDir(exportDir);

        isExporting = true;
        setExportUI(true);
        progressBar.setVisible(true);
        progressBar.setProgress(0);

        syncModelFromUI();

        String fmt = cbExportFormat.getValue();
        float jpegQuality = 0.9f;
        List<File> files = new ArrayList<>();
        for (String p : images) {
            files.add(new File(p));
        }
        exportImagesInParallel(files, exportDir, fmt, jpegQuality);
    }

    @FXML
    private void onToggleTheme() {
        isDarkTheme = !isDarkTheme;
        String css;
        if (isDarkTheme) {
            css = getClass().getResource("/com/qingframe/ui/css/dark-theme.css").toExternalForm();
            btnThemeToggle.setText("🌙 深色");
        } else {
            css = getClass().getResource("/com/qingframe/ui/css/light-theme.css").toExternalForm();
            btnThemeToggle.setText("☀️ 浅色");
        }
        rootPane.getStylesheets().clear();
        rootPane.getStylesheets().add(css);
    }

    private void renderPreview() {
        refreshView();
    }

    private void refreshView() {
        double cw = previewCanvas.getWidth();
        double ch = previewCanvas.getHeight();
        if (cw <= 0 || ch <= 0) return;

        if (originImage == null) {
            placeholderView.setVisible(true);
            return;
        }
        placeholderView.setVisible(false);

        GraphicsContext gc = previewCanvas.getGraphicsContext2D();
        try {
            double zoom = zoomSlider.getValue();
            boolean compare = template.getCompareMode() == 1;

            gc.setFill(Color.rgb(200, 200, 200));
            gc.fillRect(0, 0, cw, ch);

            if (panX != 0 || panY != 0) {
                double prangeX = cw * (zoom - 1) / 2;
                double prangeY = ch * (zoom - 1) / 2;
                if (zoom <= 1.0) { panX = 0; panY = 0; }
                else {
                    panX = clamp(panX, -prangeX, prangeX);
                    panY = clamp(panY, -prangeY, prangeY);
                }
            }

            if (compare) {
                // 原图按比例缩放并居中显示，避免被拉伸变形
                double halfW = cw / 2;
                double imgScale = Math.min(halfW / originImage.getWidth(), ch / originImage.getHeight());
                double dw = originImage.getWidth() * imgScale;
                double dh = originImage.getHeight() * imgScale;
                gc.drawImage(originImage, (halfW - dw) / 2, (ch - dh) / 2, dw, dh);
                gc.save();
                gc.translate(cw * 3 / 4 + panX * 2, ch / 2 + panY);
                gc.scale(zoom, zoom);
                gc.translate(-cw / 4, -ch / 2);
                engine.renderToCanvas(originImage, template, gc, cw / 2, ch);
                gc.restore();
                gc.setStroke(Color.WHITE);
                gc.setLineWidth(3);
                gc.strokeLine(cw / 2, 0, cw / 2, ch);
            } else {
                double[] cs = engine.computeCanvasSize(originImage, template);
                viewScale = Math.min(cw / cs[0], ch / cs[1]);
                viewOX = (cw - cs[0] * viewScale) / 2;
                viewOY = (ch - cs[1] * viewScale) / 2;
                gc.save();
                gc.translate(cw / 2 + panX, ch / 2 + panY);
                gc.scale(zoom, zoom);
                gc.translate(-cw / 2, -ch / 2);
                engine.renderToCanvas(originImage, template, gc, cw, ch);
                gc.restore();
            }

            updateScrollBars(cw, ch);
            lblResolution.setText(String.format("分辨率: %.0fx%.0f", originImage.getWidth(), originImage.getHeight()));
            double[] csSize = engine.computeCanvasSize(originImage, template);
            lblCanvasSize.setText(String.format("画布: %.0fx%.0f", csSize[0], csSize[1]));
        } catch (Exception e) {
            statusLabel.setText("渲染错误: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private void setupScrollBars() {
        hScrollBar.setManaged(false);
        vScrollBar.setManaged(false);
        double sbSize = 14;

        Platform.runLater(() -> {
            double w = dropTarget.getWidth();
            double h = dropTarget.getHeight();
            hScrollBar.setPrefWidth(w - sbSize);
            hScrollBar.setLayoutY(h - sbSize);
            vScrollBar.setPrefHeight(h - sbSize);
            vScrollBar.setLayoutX(w - sbSize);
        });

        dropTarget.widthProperty().addListener((o,ov,nv) -> {
            double w = nv.doubleValue();
            hScrollBar.setPrefWidth(w - sbSize);
            vScrollBar.setLayoutX(w - sbSize);
        });
        dropTarget.heightProperty().addListener((o,ov,nv) -> {
            double h = nv.doubleValue();
            vScrollBar.setPrefHeight(h - sbSize);
            hScrollBar.setLayoutY(h - sbSize);
        });

        hScrollBar.valueProperty().addListener((o,ov,nv) -> {
            if (isUpdatingSB) return;
            panX = nv.doubleValue();
            refreshView();
        });
        vScrollBar.valueProperty().addListener((o,ov,nv) -> {
            if (isUpdatingSB) return;
            panY = nv.doubleValue();
            refreshView();
        });
        hScrollBar.setUnitIncrement(10);
        vScrollBar.setUnitIncrement(10);
        hScrollBar.setBlockIncrement(50);
        vScrollBar.setBlockIncrement(50);
    }

    private void setupPanDrag() {
        previewCanvas.setOnMousePressed(e -> {
            if (zoomSlider.getValue() > 1.0 || template.getCompareMode() == 1) {
                previewCanvas.getScene().setCursor(javafx.scene.Cursor.CLOSED_HAND);
                dragStartX = e.getSceneX();
                dragStartY = e.getSceneY();
            }
        });
        previewCanvas.setOnMouseDragged(e -> {
            if ((zoomSlider.getValue() > 1.0 || template.getCompareMode() == 1) && !Double.isNaN(dragStartX)) {
                double dx = e.getSceneX() - dragStartX;
                double dy = e.getSceneY() - dragStartY;
                dragStartX = e.getSceneX();
                dragStartY = e.getSceneY();
                panX += dx;
                panY += dy;
                refreshView();
            }
        });
        previewCanvas.setOnMouseReleased(e -> {
            previewCanvas.getScene().setCursor(javafx.scene.Cursor.DEFAULT);
            dragStartX = Double.NaN;
            dragStartY = Double.NaN;
        });
        previewCanvas.setOnMouseExited(e -> {
            previewCanvas.getScene().setCursor(javafx.scene.Cursor.DEFAULT);
        });
    }

    private void updateScrollBars(double cw, double ch) {
        double zoom = zoomSlider.getValue();
        boolean visible = zoom > 1.05 || template.getCompareMode() == 1;
        hScrollBar.setVisible(visible);
        vScrollBar.setVisible(visible);
        if (visible) {
            double prangeX = cw * (zoom - 1) / 2;
            double prangeY = ch * (zoom - 1) / 2;
            if (template.getCompareMode() == 1) {
                prangeX = cw / 2 * (zoom - 1) / 2;
            }
            hScrollBar.setMin(-prangeX);
            hScrollBar.setMax(prangeX);
            vScrollBar.setMin(-prangeY);
            vScrollBar.setMax(prangeY);
            isUpdatingSB = true;
            hScrollBar.setValue(panX);
            vScrollBar.setValue(panY);
            isUpdatingSB = false;
        }
    }

    private double clamp(double v, double lo, double hi) {
        return v < lo ? lo : v > hi ? hi : v;
    }

    private TemplateModel createPreset(String name) {
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

    private String toHex(Color c) {
        return String.format("#%02x%02x%02x", (int)(c.getRed()*255), (int)(c.getGreen()*255), (int)(c.getBlue()*255));
    }

    private Color parseColor(String hex) {
        try {
            hex = hex.replace("#", "");
            if (hex.length() == 3) hex = "" + hex.charAt(0)+hex.charAt(0)+hex.charAt(1)+hex.charAt(1)+hex.charAt(2)+hex.charAt(2);
            if (hex.length() == 6) hex = "FF" + hex;
            long argb = Long.parseLong(hex, 16);
            int r = (int)((argb>>16)&0xFF);
            int g = (int)((argb>>8)&0xFF);
            int b = (int)(argb&0xFF);
            return Color.rgb(r, g, b);
        } catch (Exception e) {
            return Color.WHITE;
        }
    }

    private int parseInt(String text, int def) {
        try { return Integer.parseInt(text.trim()); } catch (Exception e) { return def; }
    }

    private WritableImage renderFileOnFxThread(File src, TemplateModel tmpl) throws Exception {
        BufferedImage awtImg = ImageIO.read(src);
        if (awtImg == null) throw new IOException("无法读取图片: " + src.getName());
        ExifReader.ExifData exif = ExifReader.parse(src);
        if (exif != null) awtImg = applyOrientation(awtImg, exif.orientation);
        WritableImage result = renderAwtWithFallback(awtImg, tmpl);
        if (result == null) {
            throw new IOException(String.format("渲染结果异常（接近空白），且自动缩放后仍失败：照片 %dx%d",
                    awtImg.getWidth(), awtImg.getHeight()));
        }
        return result;
    }

    /** 单张导出：渲染空白时逐级缩小重试，直到成功或全部失败 */
    /** 批量导出：AWT 版本的分级降级（后台线程调用） */
    private WritableImage renderAwtWithFallback(BufferedImage awt, TemplateModel tmpl) throws Exception {
        // 超大图先预降级，避免在界面线程上做注定失败的全尺寸渲染
        BufferedImage target = awt;
        TemplateModel renderTmpl = tmpl;
        logExport("原始尺寸: " + awt.getWidth() + "x" + awt.getHeight());
        if (Math.max(awt.getWidth(), awt.getHeight()) > EXPORT_SAFE_EDGE) {
            target = downscaleAwtToMaxEdge(awt, EXPORT_SAFE_EDGE);
            // 模板参数按同一比例缩放，保证导出边框/文字相对照片大小与预览一致
            renderTmpl = scaleTemplateForExport(tmpl, (double) target.getWidth() / awt.getWidth());
            logExport("预降级到 " + target.getWidth() + "x" + target.getHeight() + "，模板参数缩放 x"
                    + String.format("%.2f", (double) target.getWidth() / awt.getWidth()));
        }
        WritableImage r = renderAwtScaled(target, awt, renderTmpl);
        boolean firstBlank = r == null || ImageExportUtil.looksBlank(r);
        logExport("首轮渲染 " + target.getWidth() + "x" + target.getHeight() + " 空白=" + firstBlank);
        if (!firstBlank) return r;
        BufferedImage cur = target;
        int[] edges = {1800, 1200};
        for (int edge : edges) {
            BufferedImage scaled = downscaleAwtToMaxEdge(cur, edge);
            if (scaled == cur) break;
            cur = scaled;
            r = renderAwtScaled(cur, awt, scaleTemplateForExport(tmpl, (double) cur.getWidth() / awt.getWidth()));
            boolean blank = r == null || ImageExportUtil.looksBlank(r);
            logExport("降级长边 " + edge + "(" + cur.getWidth() + "x" + cur.getHeight() + ") 渲染空白=" + blank);
            if (!blank) return r;
        }
        return null;
    }

    /** 按比例缩放模板的全部像素参数（边距/描边/圆角/阴影/文字/胶片效果），用于降级导出保持视觉一致 */
    private TemplateModel scaleTemplateForExport(TemplateModel src, double s) {
        TemplateModel t = cloneTemplate(src);
        BaseMargin m = t.getBaseMargin();
        m.setMarginTop((int) Math.round(m.getMarginTop() * s));
        m.setMarginBottom((int) Math.round(m.getMarginBottom() * s));
        m.setMarginLeft((int) Math.round(m.getMarginLeft() * s));
        m.setMarginRight((int) Math.round(m.getMarginRight() * s));
        m.setImgOffsetX((int) Math.round(m.getImgOffsetX() * s));
        m.setImgOffsetY((int) Math.round(m.getImgOffsetY() * s));
        m.setBgBlurRadius((int) Math.round(m.getBgBlurRadius() * s));

        for (LayerBorder layer : t.getLayerList()) {
            layer.setMarginTop((int) Math.round(layer.getMarginTop() * s));
            layer.setMarginBottom((int) Math.round(layer.getMarginBottom() * s));
            layer.setMarginLeft((int) Math.round(layer.getMarginLeft() * s));
            layer.setMarginRight((int) Math.round(layer.getMarginRight() * s));
            StrokeConfig st = layer.getStrokeConfig();
            if (st.getStrokeWidth() > 0) {
                st.setStrokeWidth(Math.max(1, (int) Math.round(st.getStrokeWidth() * s)));
            }
            if (st.getStrokeDashArray() != null && !st.getStrokeDashArray().isEmpty()) {
                List<Double> scaledDashes = new ArrayList<>();
                for (double d : st.getStrokeDashArray()) scaledDashes.add(d * s);
                st.setStrokeDashArray(scaledDashes);
            }
            st.setStrokeDashOffset(st.getStrokeDashOffset() * s);
            ShadowGlowConfig sg = layer.getShadowGlowConfig();
            // 侧投影模式（如“浮影白框”）的模糊值是相对照片的比例系数，
            // 导出降级时保持原值，阴影长度随照片尺寸同比缩放，视觉与预览一致
            boolean sideShadow = sg.getSideShadow() == 1;
            sg.setShadowOffsetX(sg.getShadowOffsetX() * s);
            sg.setShadowOffsetY(sg.getShadowOffsetY() * s);
            if (!sideShadow) {
                sg.setShadowBlur(sg.getShadowBlur() * s);
            }
            sg.setShadowSpread(sg.getShadowSpread() * s);
            sg.setGlowBlur(sg.getGlowBlur() * s);
            sg.setGlowSpread(sg.getGlowSpread() * s);
        }

        CornerConfig c = t.getCornerConfig();
        c.setCornerRadiusAll(c.getCornerRadiusAll() * s);
        c.setCornerRadiusTL(c.getCornerRadiusTL() * s);
        c.setCornerRadiusTR(c.getCornerRadiusTR() * s);
        c.setCornerRadiusBL(c.getCornerRadiusBL() * s);
        c.setCornerRadiusBR(c.getCornerRadiusBR() * s);

        FilmTearConfig ft = t.getFilmTearConfig();
        ft.setTearStrength(ft.getTearStrength() * s);
        ft.setTearDensity(ft.getTearDensity() * s);
        ft.setFilmPerforationSize(ft.getFilmPerforationSize() * s);
        ft.setFilmPerforationSpacing(ft.getFilmPerforationSpacing() * s);
        ft.setDustScratchIntensity((int) Math.round(ft.getDustScratchIntensity() * s));
        ft.setYellowingStrength((int) Math.round(ft.getYellowingStrength() * s));

        TextStickerConfig dec = t.getDecorConfig();
        for (TextStickerConfig.TextLine line : dec.getTextLines()) {
            line.setFontSize(line.getFontSize() * s);
            line.setX(line.getX() * s);
            line.setY(line.getY() * s);
            line.setLetterSpacing(line.getLetterSpacing() * s);
        }
        dec.setCornerDecorSize(dec.getCornerDecorSize() * s);
        t.setParamFontSize((int) Math.round(t.getParamFontSize() * s));
        return t;
    }

    /** 渲染指定尺寸图，并按比例同步图标位置/大小（保证降级导出时 Logo 位置与预览一致） */
    private WritableImage renderAwtScaled(BufferedImage renderImg, BufferedImage origImg, TemplateModel tmpl) throws Exception {
        double sx = (double) renderImg.getWidth() / origImg.getWidth();
        double sy = (double) renderImg.getHeight() / origImg.getHeight();
        engine.setIconRenderScale(sx, sy);
        try {
            WritableImage fx = SwingFXUtils.toFXImage(renderImg, null);
            return renderOnFx(fx, tmpl);
        } finally {
            engine.setIconRenderScale(1.0, 1.0);
        }
    }

    /** 导出诊断日志：写入用户目录 QingFrameShadow-export.log，用于定位导出失败原因 */
    private void logExport(String msg) {
        try {
            java.io.FileWriter fw = new java.io.FileWriter(
                    System.getProperty("user.home") + "/QingFrameShadow-export.log", true);
            fw.write(new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date()) + "  " + msg + "\n");
            fw.close();
        } catch (Exception ignored) {}
    }

    private WritableImage renderOnFx(WritableImage fx, TemplateModel tmpl) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        WritableImage[] result = new WritableImage[1];
        Exception[] err = new Exception[1];
        Platform.runLater(() -> {
            try {
                result[0] = engine.renderBorder(fx, tmpl);
            } catch (Exception e) {
                err[0] = e;
            } finally {
                latch.countDown();
            }
        });
        latch.await();
        if (err[0] != null) throw err[0];
        return result[0];
    }

    /** 按长边上限缩小 AWT 图像（不超过上限则原样返回） */
    private BufferedImage downscaleAwtToMaxEdge(BufferedImage awt, int maxEdge) {
        int longEdge = Math.max(awt.getWidth(), awt.getHeight());
        if (longEdge <= maxEdge) return awt;
        double scale = (double) maxEdge / longEdge;
        int nw = Math.max(1, (int) (awt.getWidth() * scale));
        int nh = Math.max(1, (int) (awt.getHeight() * scale));
        BufferedImage scaled = new BufferedImage(nw, nh, BufferedImage.TYPE_INT_ARGB);
        java.awt.Graphics2D g = scaled.createGraphics();
        g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.drawImage(awt, 0, 0, nw, nh, null);
        g.dispose();
        return scaled;
    }

    /** 按 EXIF 方向旋转图像（与 JavaFX 预览自动应用方向保持一致） */
    private BufferedImage applyOrientation(BufferedImage img, int orientation) {
        if (img == null || orientation == 1 || orientation == 0) return img;
        int w = img.getWidth(), h = img.getHeight();
        switch (orientation) {
            case 3:
            {
                BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
                for (int y = 0; y < h; y++) {
                    int[] row = img.getRGB(0, y, w, 1, null, 0, w);
                    int[] rev = new int[w];
                    for (int x = 0; x < w; x++) rev[x] = row[w - 1 - x];
                    out.setRGB(0, h - 1 - y, w, 1, rev, 0, w);
                }
                return out;
            }
            case 6: {
                // 顺时针 90°：源 (x,y) -> 目标 (h-1-y, x)
                BufferedImage out = new BufferedImage(h, w, BufferedImage.TYPE_INT_ARGB);
                for (int y = 0; y < h; y++) {
                    int[] row = img.getRGB(0, y, w, 1, null, 0, w);
                    for (int x = 0; x < w; x++) {
                        out.setRGB(h - 1 - y, x, row[x]);
                    }
                }
                return out;
            }
            case 8: {
                // 逆时针 90°：源 (x,y) -> 目标 (y, w-1-x)
                BufferedImage out = new BufferedImage(h, w, BufferedImage.TYPE_INT_ARGB);
                for (int y = 0; y < h; y++) {
                    int[] row = img.getRGB(0, y, w, 1, null, 0, w);
                    for (int x = 0; x < w; x++) {
                        out.setRGB(y, w - 1 - x, row[x]);
                    }
                }
                return out;
            }
            default:
                return img;
        }
    }

    private BufferedImage downscaleIfNeeded(BufferedImage img) {
        int w = img.getWidth();
        int h = img.getHeight();
        if (w <= THUMB_MAX_DIM && h <= THUMB_MAX_DIM) return img;
        double scale = Math.min((double) THUMB_MAX_DIM / w, (double) THUMB_MAX_DIM / h);
        int nw = (int) (w * scale);
        int nh = (int) (h * scale);
        BufferedImage scaled = new BufferedImage(nw, nh, BufferedImage.TYPE_INT_ARGB);
        java.awt.Graphics2D g = scaled.createGraphics();
        g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.drawImage(img, 0, 0, nw, nh, null);
        g.dispose();
        return scaled;
    }

    private Image getOrCreateThumbnail(File file, TemplateModel tmpl) {
        Image cached = thumbCache.get(file);
        if (cached != null && cached.getWidth() > 0) return cached;
        try {
            BufferedImage awtImg = ImageIO.read(file);
            if (awtImg == null) return null;
            ExifReader.ExifData exif = ExifReader.parse(file);
            if (exif != null) awtImg = applyOrientation(awtImg, exif.orientation);
            awtImg = downscaleIfNeeded(awtImg);
            CountDownLatch latch = new CountDownLatch(1);
            Image[] result = new Image[1];
            final BufferedImage finalImg = awtImg;
            Platform.runLater(() -> {
                try {
                    WritableImage fxImg = SwingFXUtils.toFXImage(finalImg, null);
                    result[0] = engine.renderThumbnail(fxImg, tmpl);
                } catch (Exception ignored) {
                } finally {
                    latch.countDown();
                }
            });
            latch.await();
            if (result[0] != null) {
                if (thumbCache.size() >= THUMB_CACHE_MAX) {
                    thumbCache.clear();
                }
                thumbCache.put(file, result[0]);
            }
            return result[0];
        } catch (Exception e) {
            return null;
        }
    }

    private void clearThumbCache() {
        thumbCache.clear();
    }

    private void showAlert(String msg) {
        if (Platform.isFxApplicationThread()) {
            Alert alert = new Alert(Alert.AlertType.INFORMATION, msg, ButtonType.OK);
            alert.showAndWait();
        } else {
            Platform.runLater(() -> {
                Alert alert = new Alert(Alert.AlertType.INFORMATION, msg, ButtonType.OK);
                alert.showAndWait();
            });
        }
    }

    // ═══════════════ Logo / Icon Tab ═══════════════

    private volatile IconItem selectedIcon;
    /** 预览视图变换：模板坐标 → 预览画布坐标的换算参数（refreshView 每次渲染时更新） */
    private double viewScale = 1.0;
    private double viewOX = 0.0;
    private double viewOY = 0.0;

    private void initLogoTab() {
        Platform.runLater(() -> {
            brandIconBox.getChildren().clear();
            String[] brands = {
                    // 相机
                    "LEICA","CANON","NIKON","FUJIFILM","SONY","HASSELBLAD",
                    "LUMIX","PANASONIC","OLYMPUS","PENTAX","RICOH","ZEISS","DJI",
                    "SIGMA","TAMRON","GOPRO","INSTA360","RED","BLACKMAGIC",
                    "KODAK","POLAROID","PHASE ONE","MAMIYA","CASIO","AGFA",
                    // 手机
                    "APPLE","SAMSUNG","HUAWEI","XIAOMI","REDMI","VIVO","OPPO",
                    "REALME","ONEPLUS","IQOO","HONOR","GOOGLE","NOTHING",
                    "MOTOROLA","NOKIA","MEIZU","ZTE","ASUS","LG","HTC",
                    "TECNO","INFINIX","LENOVO",
                    // 扩充：相机老牌 + 更多手机品牌
                    "ROLLEI","CONTAX","VOIGTLÄNDER","HORSEMAN","LINHOF","TOYO",
                    "SEAGULL","LOMO","ALPA",
                    "NUBIA","REDMAGIC","BLACKSHARK","ITEL","DOOGEE","ULEFONE","CAT","VERTU"
            };
            for (String brand : brands) {
                javafx.scene.control.Button btn = new javafx.scene.control.Button();
                btn.setPrefSize(76, 40);
                btn.setStyle("-fx-background-color:#333; -fx-background-radius:6; -fx-cursor:hand; -fx-padding:0;");
                String logoUrl = brandLogoUrl(brand);
                if (logoUrl != null) {
                    ImageView iv = new ImageView(new Image(logoUrl, true));
                    iv.setFitWidth(68);
                    iv.setFitHeight(32);
                    iv.setPreserveRatio(true);
                    btn.setGraphic(iv);
                } else {
                    btn.setText(brand);
                    btn.setStyle(btn.getStyle() + "-fx-font-size:10;");
                }
                btn.setOnAction(e -> placeBrandLogo(brand));
                brandIconBox.getChildren().add(btn);
            }
            populateIconCategory(photoDecorBox, IconItem.Category.PHOTO_DECOR);
            populateIconCategory(simpleIconBox, IconItem.Category.SIMPLE);
            populateIconCategory(weatherIconBox, IconItem.Category.WEATHER);
            refreshCustomIcons();
        });
    }

    private String brandLogoUrl(String brand) {
        String fileName = brand.replace(" ", "").toUpperCase() + ".png";
        java.net.URL url = getClass().getResource("/com/qingframe/brandlogos/" + fileName);
        return url != null ? url.toExternalForm() : null;
    }

    private void populateIconCategory(HBox box, IconItem.Category cat) {
        box.getChildren().clear();
        for (IconItem item : IconManager.getBuiltInByCategory(cat)) {
            javafx.scene.control.Button btn = new javafx.scene.control.Button();
            btn.setPrefSize(40, 40);
            btn.setStyle("-fx-background-color:#444; -fx-background-radius:6; -fx-cursor:hand;");
            Canvas iconCanvas = new Canvas(36, 36);
            GraphicsContext igc = iconCanvas.getGraphicsContext2D();
            IconRenderer.draw(igc, item, 18, 18, 28);
            btn.setGraphic(iconCanvas);
            IconItem finalItem = item;
            btn.setOnAction(e -> placeIcon(finalItem));
            box.getChildren().add(btn);
        }
    }

    private void refreshCustomIcons() {
        customIconBox.getChildren().clear();
        for (IconItem item : IconManager.getCustomIcons()) {
            javafx.scene.control.Button btn = new javafx.scene.control.Button();
            btn.setPrefSize(40, 40);
            btn.setStyle("-fx-background-color:#444; -fx-background-radius:6; -fx-cursor:hand;");
            Image img = IconManager.getIconImage(item);
            if (img != null) {
                ImageView iv = new ImageView(img);
                iv.setFitWidth(32); iv.setFitHeight(32); iv.setPreserveRatio(true);
                btn.setGraphic(iv);
            }
            IconItem finalItem = item;
            btn.setOnAction(e -> placeIcon(finalItem));
            customIconBox.getChildren().add(btn);
        }
    }

    private void placeBrandLogo(String brand) {
        BorderProcessor.setManualLogoBrand(brand);
        String logoUrl = brandLogoUrl(brand);
        IconItem item = new IconItem("brand_" + brand, IconItem.Category.BRAND, brand, logoUrl != null ? logoUrl : "");
        placeIcon(item);
    }

    private void placeIcon(IconItem srcItem) {
        if (originImage == null) {
            showAlert("请先打开一张图片，再放置图标");
            return;
        }
        // 图标使用模板坐标系，保证预览与导出位置一致
        double[] cs = engine.computeCanvasSize(originImage, this.template);
        IconItem placed = IconManager.addToCanvas(srcItem, cs[0], cs[1]);
        // 默认大小约为画布宽度的 8%，保证在各种尺寸的照片上可见
        placed.setScale(Math.max(0.6, cs[0] / 750.0));
        if (srcItem.getSrc() != null && !srcItem.getSrc().isEmpty()) {
            adjustImageIconScale(placed, cs);
        }
        selectCanvasIcon(placed);
        renderPreview();
    }

    /** 图片图标（自定义 Logo 等）：按画布宽度 25% 自适应，避免大图白底覆盖整张照片 */
    private void adjustImageIconScale(IconItem placed, double[] cs) {
        Image img = IconManager.getIconImage(placed);
        if (img != null && img.getWidth() > 0) {
            placed.setScale(cs[0] * 0.25 / Math.max(img.getWidth(), img.getHeight()));
            return;
        }
        if (img != null) {
            img.progressProperty().addListener((o, ov, nv) -> {
                if (nv.doubleValue() >= 1.0 && img.getWidth() > 0) {
                    Platform.runLater(() -> {
                        placed.setScale(cs[0] * 0.25 / Math.max(img.getWidth(), img.getHeight()));
                        renderPreview();
                    });
                }
            });
        }
    }

    /** 预览画布坐标 → 模板坐标（还原缩放/平移/适配变换） */
    private double[] previewToTemplate(double px, double py) {
        double cw = previewCanvas.getWidth();
        double ch = previewCanvas.getHeight();
        double zoom = zoomSlider.getValue();
        double x, y, scale, ox, oy;
        if (template.getCompareMode() == 1) {
            x = (px - (cw * 3 / 4 + panX * 2)) / zoom + cw / 4;
            y = (py - (ch / 2 + panY)) / zoom + ch / 2;
            double[] cs = engine.computeCanvasSize(originImage, template);
            scale = Math.min((cw / 2) / cs[0], ch / cs[1]);
            ox = ((cw / 2) - cs[0] * scale) / 2;
            oy = (ch - cs[1] * scale) / 2;
        } else {
            x = (px - (cw / 2 + panX)) / zoom + cw / 2;
            y = (py - (ch / 2 + panY)) / zoom + ch / 2;
            scale = viewScale;
            ox = viewOX;
            oy = viewOY;
        }
        return new double[]{(x - ox) / scale, (y - oy) / scale};
    }

    private void selectCanvasIcon(IconItem item) {
        selectedIcon = item;
        IconManager.setSelected(item);
        if (item != null) {
            slActiveIconOpacity.setValue(item.getOpacity());
        }
    }

    @FXML
    private void onAddCustomIcon() {
        FileChooser fc = new FileChooser();
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("图片", "*.png", "*.jpg", "*.jpeg", "*.webp"));
        fc.setTitle("导入自定义图标");
        File file = fc.showOpenDialog(previewCanvas.getScene().getWindow());
        if (file != null) {
            IconManager.addCustomIcon(file);
            refreshCustomIcons();
        }
    }

    @FXML
    private void onDeleteActiveIcon() {
        if (selectedIcon != null) {
            IconManager.removeFromCanvas(selectedIcon);
            selectCanvasIcon(null);
            renderPreview();
        }
    }

    @FXML
    private void onClearAllIcons() {
        IconManager.clearCanvas();
        selectCanvasIcon(null);
        renderPreview();
    }

    // Canvas interaction for icons
    private double iconDragStartX, iconDragStartY;
    private double iconOrigX, iconOrigY;
    private boolean draggingIcon;

    private void setupCanvasIconInteraction() {
        previewCanvas.setOnMousePressed(e -> {
            if (e.isPrimaryButtonDown()) {
                double[] tc = previewToTemplate(e.getX(), e.getY());
                IconItem hit = hitTestIcon(tc[0], tc[1]);
                if (hit != null) {
                    selectCanvasIcon(hit);
                    draggingIcon = true;
                    iconDragStartX = tc[0];
                    iconDragStartY = tc[1];
                    iconOrigX = hit.getX();
                    iconOrigY = hit.getY();
                    e.consume();
                    renderPreview();
                    return;
                }
                selectCanvasIcon(null);
                if (!e.isAltDown() && !e.isControlDown()) {
                    draggingIcon = false;
                }
            }
        });
        previewCanvas.setOnMouseDragged(e -> {
            if (draggingIcon && selectedIcon != null) {
                double[] tc = previewToTemplate(e.getX(), e.getY());
                double dx = tc[0] - iconDragStartX;
                double dy = tc[1] - iconDragStartY;
                selectedIcon.setX(iconOrigX + dx);
                selectedIcon.setY(iconOrigY + dy);
                renderPreview();
                e.consume();
            }
        });
        previewCanvas.setOnMouseReleased(e -> {
            if (draggingIcon) {
                draggingIcon = false;
                onSettingChanged();
            }
        });
        previewCanvas.setOnScroll(e -> {
            if (selectedIcon != null) {
                double delta = e.getDeltaY() > 0 ? 0.1 : -0.1;
                double newScale = Math.max(0.1, Math.min(3.0, selectedIcon.getScale() + delta));
                selectedIcon.setScale(newScale);
                renderPreview();
                e.consume();
            }
        });
    }

    private IconItem hitTestIcon(double mx, double my) {
        java.util.List<IconItem> icons = IconManager.getActiveIcons();
        double[] cs = engine.computeCanvasSize(originImage, this.template);
        double cap = Math.max(cs[0], cs[1]) * 0.4;
        for (int i = icons.size() - 1; i >= 0; i--) {
            IconItem item = icons.get(i);
            Image img = IconManager.getIconImage(item);
            boolean imgReady = img != null && img.getWidth() > 0 && img.getHeight() > 0;
            double base = imgReady ? Math.max(img.getWidth(), img.getHeight()) : 60;
            if (imgReady) base = Math.min(base, cap);
            double sz = base * item.getScale();
            double hw = sz / 2;
            if (mx >= item.getX() - hw && mx <= item.getX() + hw &&
                my >= item.getY() - hw && my <= item.getY() + hw) {
                return item;
            }
        }
        return null;
    }
}

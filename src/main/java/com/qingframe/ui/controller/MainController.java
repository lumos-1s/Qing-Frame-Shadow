package com.qingframe.ui.controller;

import com.qingframe.core.BorderEngine;
import com.qingframe.core.BorderProcessor;
import com.qingframe.core.ExifReader;
import com.qingframe.core.ExifTextParser;
import com.qingframe.core.IconManager;
import com.qingframe.core.IconRenderer;
import com.qingframe.util.ImageCache;
import com.qingframe.core.WatermarkRender;
import com.qingframe.model.*;
import com.qingframe.network.ApiClient;
import com.qingframe.network.LoginController;
import com.qingframe.network.TokenStore;
import com.qingframe.network.WelcomeController;
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
import javafx.scene.Scene;
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
import javafx.stage.Modality;
import javafx.stage.Stage;

import javax.imageio.ImageIO;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public class MainController implements Initializable {

    @FXML private Canvas previewCanvas;
    @FXML private Label statusLabel, lblImageInfo, lblCanvasSize;
    @FXML private Label lblImgScale, lblFillOpacity, lblStrokeWidth, lblGlobalMargin, lblParamFontSize;
    @FXML private Slider zoomSlider, slImgScale, slFillOpacity, slStrokeWidth;
    @FXML private Slider slGradientAngle, slTextureScale, slStrokeOpacity;
    @FXML private Slider slCornerRadius, slTearStrength, slTearDensity;
    @FXML private TabPane rightTabPane;
    @FXML private TextField tfCornerRadius;
    @FXML private Slider slShadowX, slShadowY, slShadowBlur, slShadowSpread;
    @FXML private Slider slGlowBlur, slGlowOpacity, slVignetteStrength, slLeakOpacity, slLeakAngle;
    @FXML private Slider slTextSize, slCornerDecorSize, slGlobalMargin, slParamFontSize;
    @FXML private TextField tfMarginTop, tfMarginBottom, tfMarginLeft, tfMarginRight;
    @FXML private TextField tfImgOffsetX, tfImgOffsetY;
    @FXML private TextField tfLayerMarginTop, tfLayerMarginBottom, tfLayerMarginLeft, tfLayerMarginRight;
    @FXML private TextField tfStrokeDash, tfTemplateName, tfTemplateTag, tfCustomText;
    @FXML private TextField tfExifBrand, tfExifModel, tfExifFocal, tfExifAperture, tfExifIso, tfExifShutter;
    @FXML private CheckBox cbMarginLock, cbLayerVisible, cbCornerLock;
    @FXML private CheckBox cbTearEnable, cbShadow, cbGlow;
    @FXML private CheckBox cbVignette, cbLightLeak, cbExifText, cbCornerDecor;
    @FXML private ColorPicker cpFillColor, cpStrokeColor, cpGlowColor, cpTextColor;
    @FXML private ComboBox<String> cbTextFont;
    @FXML private ScrollPane brandIconScroll, photoDecorScroll, simpleIconScroll, weatherIconScroll;
    @FXML private HBox brandIconBox, photoDecorBox, simpleIconBox, weatherIconBox, customIconBox;
    @FXML private Slider slActiveIconOpacity;
    @FXML private Slider slElementRotation;
    @FXML private ComboBox<String> cbLayerSelect, cbFillType, cbGradientType, cbStrokePos, cbLeakType, cbExportFormat;
    @FXML private ComboBox<String> cbTextureBlend;
    @FXML private ListView<String> lvPresets;
    @FXML private ProgressBar progressBar;
    @FXML private Button btnOpenImage, btnSaveImage, btnAddLayer;
    @FXML private Label lblLoginStatus;
    @FXML private Button btnLoginToggle;
    @FXML private ImageView ivAvatar;
    @FXML private ToggleButton btnThemeToggle;
    @FXML private BorderPane rootPane;
    @FXML private ScrollPane sidebarScroll;
    @FXML private StackPane dropTarget;
    @FXML private VBox placeholderView;
    @FXML private TextField tfZoomValue;
    @FXML private ComboBox<String> cbParamType, cbCanvasRatio, cbRecipeFilter, cbParamPosition;
    @FXML private Slider slCornerTL, slCornerTR, slCornerBL, slCornerBR;
    @FXML private Label lblResolution;
    @FXML private ScrollBar hScrollBar, vScrollBar;
    @FXML private ScrollPane filmStrip;
    @FXML private HBox thumbnailBox;
    @FXML private ImageView puzzlePreviewView;
    @FXML private Label lblPuzzleSlot;
    @FXML private Slider slPuzzleGap, slSlotOffsetX, slSlotOffsetY, slSlotZoom;
    @FXML private ComboBox<String> cbSlotFill;
    @FXML private ComboBox<String> cbPuzzleBg;
    @FXML private ComboBox<String> cbPuzzleCanvas;
    @FXML private ComboBox<String> cbPuzzleGapPick;
    @FXML private javafx.scene.layout.StackPane puzzleViewport;
    @FXML private javafx.scene.layout.VBox vbCaptionEditor;
    @FXML private TextField tfCapLine1, tfCapLine2;
    @FXML private Slider slCapSize1, slCapSize2;
    @FXML private ComboBox<String> cbCapFont1, cbCapFont2;
    @FXML private ColorPicker cpCapColor;
    @FXML private CheckBox cbCapBgBar;
    @FXML private Slider slCapSpacing;
    @FXML private javafx.scene.control.Label lblCapSize1, lblCapSize2;
    @FXML private javafx.scene.control.ColorPicker cpPuzzleBorder;
    @FXML private javafx.scene.layout.Pane puzzleOverlay;

    /** 拼图模式：当前是否处于拼图渲染；拼图配置存在 template.getPuzzlrConfig()，每图模板独立保存 */
    private boolean puzzleMode = false;
    /** 拼图模式下当前选中的格子（面板操作/换图对象），-1 表示未选中 */
    private int puzzleSelectedSlot = -1;
    /** 拼图预览 ImageView 的 fit 比例（鼠标坐标→画布相对坐标换算） */
    private double puzzleViewScale = 1.0;
    private boolean puzzleDragging = false;
    private boolean puzzleDragAxis = false;
    private int puzzleDragAxisIdx = -1;
    private double puzzleDragX = 0, puzzleDragY = 0;
    private double puzzleDragStartRelX = 0, puzzleDragStartRelY = 0;
    private int puzzlePressCell = -1;
    /** 间隙字幕编辑器当前打开的间隙下标（-1=未打开） */
    private int captionEditorGap = -1;
    /** 拼图预览整体缩放（1=适配窗口）与平移量 */
    private double puzzlePreviewZoom = 1.0;
    private double puzzleViewTx = 0, puzzleViewTy = 0;
    private double puzzleFitW = 0, puzzleFitH = 0;
    private boolean panningView = false;
    private double panStartX = 0, panStartY = 0, panStartTx = 0, panStartTy = 0;

    private Image originImage;
    private TemplateModel template;
    private File currentImageFile;
    private BorderEngine engine = new BorderEngine();
    private boolean isDarkTheme = true;
    private boolean isUpdating = false;
    private final Stack<TemplateModel> undoStack = new Stack<>();
    private final Stack<TemplateModel> redoStack = new Stack<>();
    private double panX = 0, panY = 0;
    /** 预览缩放（10%~300%），由顶部数字输入框控制 */
    private double zoomValue = 1.0;
    private double dragStartX = Double.NaN, dragStartY = Double.NaN;
    private boolean isUpdatingSB = false;
    private final List<File> imageFiles = new ArrayList<>();
    private final Set<Integer> selectedIndices = new HashSet<>();
    private int currentImageIndex = -1;
    private int[] refMargins = new int[4];
    private final Map<File, TemplateModel> imageTemplates = new HashMap<>();
    private final Map<File, Image> thumbCache = new ConcurrentHashMap<>();
    private static final int THUMB_MAX_DIM = 1280;
    private static final int THUMB_CACHE_MAX = 200;
    private static final long RENDER_DEBOUNCE_MS = 50;
    /** 导出渲染的安全长边（约 2400px，约 400 万像素），落在大多数环境的稳定渲染区 */
    private static final int EXPORT_SAFE_EDGE = 2400;
    /** 导出设置文件：记住上次导出目录 */
    private static final String EXPORT_SETTINGS_FILE =
            System.getProperty("user.home") + "/.qingkuangying-export-settings.txt";
    /** 打开设置文件：记住上次打开图片的目录 */
    private static final String OPEN_SETTINGS_FILE =
            System.getProperty("user.home") + "/.qingkuangying-open-settings.txt";
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
    /** 最近一次从照片读取的 EXIF 参数文本（缓存，供预设切换后恢复显示） */
    private String cachedExifText = "";

    @Override
    public void initialize(URL url, ResourceBundle rb) {
        template = new TemplateModel();

        previewCanvas.setManaged(false);
        // 画布尺寸守卫同步：布局瞬间可能出现 0/负/NaN，直接 bind 会让渲染线程
        // 创建纹理失败（NGCanvas RenderBuf NPE 且每帧重复），仅在合法尺寸时同步
        javafx.beans.InvalidationListener pcSizeSync = obs -> {
            double w = dropTarget.getWidth(), h = dropTarget.getHeight();
            if (Double.isFinite(w) && Double.isFinite(h) && w >= 1 && h >= 1) {
                if (previewCanvas.getWidth() != w) previewCanvas.setWidth(w);
                if (previewCanvas.getHeight() != h) previewCanvas.setHeight(h);
            }
        };
        dropTarget.widthProperty().addListener(pcSizeSync);
        dropTarget.heightProperty().addListener(pcSizeSync);

        Platform.runLater(() -> {
            renderPreview();
        });

        dropTarget.widthProperty().addListener((o,ov,nv) -> {
            if (nv.doubleValue() > 0) {
                if (puzzleMode && puzzlePreviewView.getImage() != null) {
                    updatePuzzleViewFit();
                } else {
                    scheduleRender();
                }
            }
        });
        dropTarget.heightProperty().addListener((o,ov,nv) -> {
            if (nv.doubleValue() > 0) {
                if (puzzleMode && puzzlePreviewView.getImage() != null) {
                    updatePuzzleViewFit();
                } else {
                    scheduleRender();
                }
            }
        });

        setupScrollBars();

        setupDragDrop();

        // 右侧栏所有滑块自动附加数值标签（已有专属数值显示的除外）
        attachSliderValueLabels(rightTabPane);

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

        // ── 拼图面板 ──
        cbSlotFill.setItems(FXCollections.observableArrayList("填满裁切", "完整包含"));
        cbSlotFill.setValue("填满裁切");
        // 拼图视口裁剪：整体放大后超出部分不外溢（视口内无 Canvas，安全）
        // 视图节点全部非托管：ImageView/Overlay 的 pref 尺寸会随整体缩放变大，
        // 若参与布局会把父容器最小尺寸撑大 → 触发重绘 → 再撑大（×缩放系数的布局死循环）
        javafx.scene.shape.Rectangle vpClip = new javafx.scene.shape.Rectangle();
        vpClip.widthProperty().bind(puzzleViewport.widthProperty());
        vpClip.heightProperty().bind(puzzleViewport.heightProperty());
        puzzleViewport.setClip(vpClip);
        puzzlePreviewView.setManaged(false);
        puzzleOverlay.setManaged(false);
        // 点击拼图画布以外 → 取消选中格子
        dropTarget.addEventFilter(javafx.scene.input.MouseEvent.MOUSE_CLICKED, e -> {
            if (!puzzleMode || puzzlePreviewView.getImage() == null) return;
            javafx.geometry.Point2D lp = puzzlePreviewView.sceneToLocal(e.getSceneX(), e.getSceneY());
            if (lp != null && lp.getX() >= 0 && lp.getY() >= 0
                    && lp.getX() <= puzzlePreviewView.getBoundsInLocal().getWidth()
                    && lp.getY() <= puzzlePreviewView.getBoundsInLocal().getHeight()) return;
            if (puzzleSelectedSlot != -1) {
                puzzleSelectedSlot = -1;
                updatePuzzleSlotUI();
                refreshPuzzleOverlay();
                statusLabel.setText("已取消选中格子");
            }
        });
        cbPuzzleBg.setItems(FXCollections.observableArrayList("白色背景", "模糊照片底"));
        cbPuzzleBg.setValue("白色背景");
        cbPuzzleBg.valueProperty().addListener((o,ov,nv) -> {
            if (isUpdating) return;
            template.getPuzzlrConfig().setBgMode("模糊照片底".equals(nv) ? 1 : 0);
            cpPuzzleBorder.setDisable("模糊照片底".equals(nv));
            schedulePuzzleRender();
        });
        cbPuzzleCanvas.setItems(FXCollections.observableArrayList(
                "自动", "1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"));
        cbPuzzleCanvas.setValue("自动");
        cbPuzzleCanvas.valueProperty().addListener((o,ov,nv) -> {
            if (isUpdating) return;
            template.getPuzzlrConfig().setCanvasRatio(parseCanvasRatio(nv));
            schedulePuzzleRender();
        });
        cpPuzzleBorder.setValue(javafx.scene.paint.Color.WHITE);
        cpPuzzleBorder.valueProperty().addListener((o,ov,nv) -> {
            if (isUpdating) return;
            template.getPuzzlrConfig().setBorderColor(String.format("#%02X%02X%02X",
                    (int) Math.round(nv.getRed() * 255),
                    (int) Math.round(nv.getGreen() * 255),
                    (int) Math.round(nv.getBlue() * 255)));
            schedulePuzzleRender();
        });
        slPuzzleGap.valueProperty().addListener((o,ov,nv) -> {
            if (isUpdating) return;
            template.getPuzzlrConfig().setGap((int) Math.round(nv.doubleValue()));
            schedulePuzzleRender();
        });
        slSlotOffsetX.valueProperty().addListener((o,ov,nv) -> {
            if (isUpdating || puzzleSelectedSlot < 0) return;
            currentPuzzleSlot().setOffsetX(nv.doubleValue());
            schedulePuzzleRender();
        });
        slSlotOffsetY.valueProperty().addListener((o,ov,nv) -> {
            if (isUpdating || puzzleSelectedSlot < 0) return;
            currentPuzzleSlot().setOffsetY(nv.doubleValue());
            schedulePuzzleRender();
        });
        slSlotZoom.valueProperty().addListener((o,ov,nv) -> {
            if (isUpdating || puzzleSelectedSlot < 0) return;
            currentPuzzleSlot().setZoom(nv.doubleValue());
            schedulePuzzleRender();
        });
        cbSlotFill.valueProperty().addListener((o,ov,nv) -> {
            if (isUpdating || puzzleSelectedSlot < 0) return;
            currentPuzzleSlot().setFillMode("填满裁切".equals(nv) ? 0 : 1);
            schedulePuzzleRender();
        });
        setupPuzzleInteraction();

        lvPresets.setItems(FXCollections.observableArrayList(loadPresetList()));
        updatePresetListHeight();
        // 内置预设列表滚轮转发给外层 ScrollPane：ListView 即使内容全显示也会拦截滚轮，
        // 转发后鼠标停在列表上滚轮即可滚动整个右侧面板
        lvPresets.addEventFilter(javafx.scene.input.ScrollEvent.SCROLL, e -> {
            javafx.scene.Node n = lvPresets;
            javafx.scene.control.ScrollPane sp = null;
            while (n != null) {
                n = n.getParent();
                if (n instanceof javafx.scene.control.ScrollPane) {
                    sp = (javafx.scene.control.ScrollPane) n;
                    break;
                }
            }
            if (sp != null) {
                double delta = e.getDeltaY();
                sp.setVvalue(Math.max(0, Math.min(sp.getVmax(), sp.getVvalue() - delta / 300.0)));
                e.consume();
            }
        });

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

        // 自定义文字：输入实时预览，字号/颜色/字体改动即时应用到当前文字行
        // 精选字体：去掉不够好看的字体，加入艺术字/签名类，国产字体排在最前
        List<String[]> curatedFonts = List.of(
                // 国产字体
                new String[]{"微软雅黑", "Microsoft YaHei"},
                new String[]{"黑体", "SimHei"},
                new String[]{"宋体", "SimSun"},
                new String[]{"楷体", "KaiTi"},
                new String[]{"仿宋", "FangSong"},
                new String[]{"隶书", "LiSu"},
                new String[]{"幼圆", "YouYuan"},
                new String[]{"等线", "DengXian"},
                new String[]{"思源黑体", "Noto Sans SC"},
                new String[]{"思源宋体", "Noto Serif SC"},
                new String[]{"汉仪中黑体", "HYZhongHeiTi"},
                new String[]{"华文行楷", "STXingkai"},
                new String[]{"华文楷体", "STKaiti"},
                new String[]{"华文隶书", "STLiti"},
                new String[]{"华文新魏", "STXinwei"},
                new String[]{"华文琥珀", "STHupo"},
                new String[]{"华文彩云", "STCaiyun"},
                new String[]{"华文细黑", "STXihei"},
                new String[]{"华文宋体", "STSong"},
                new String[]{"华文中宋", "STZhongsong"},
                new String[]{"华文仿宋", "STFangsong"},
                new String[]{"方正舒体", "FZShuTi"},
                new String[]{"方正姚体", "FZYaoTi"},
                // 签名类
                new String[]{"Brush Script MT"},
                new String[]{"Edwardian Script ITC"},
                new String[]{"French Script MT"},
                new String[]{"Freestyle Script"},
                new String[]{"Palace Script MT"},
                new String[]{"Script MT Bold"},
                new String[]{"Kunstler Script"},
                new String[]{"Blackadder ITC"},
                new String[]{"Mistral"},
                new String[]{"Rage Italic"},
                new String[]{"Segoe Script"},
                new String[]{"Segoe Print"},
                new String[]{"Lucida Handwriting"},
                new String[]{"Lucida Calligraphy"},
                new String[]{"Vivaldi"},
                new String[]{"Vladimir Script"},
                new String[]{"Monotype Corsiva"},
                new String[]{"Bradley Hand ITC"},
                new String[]{"Kristen ITC"},
                new String[]{"Viner Hand ITC"},
                // 艺术装饰类
                new String[]{"Chiller"},
                new String[]{"Jokerman"},
                new String[]{"Showcard Gothic"},
                new String[]{"Cooper Black"},
                new String[]{"Old English Text MT"},
                new String[]{"Broadway"},
                new String[]{"Wide Latin"},
                new String[]{"Stencil"},
                new String[]{"Harlow Solid Italic"},
                new String[]{"Harrington"},
                new String[]{"Matura MT Script Capitals"},
                new String[]{"Papyrus"},
                new String[]{"Parchment"},
                new String[]{"Playbill"},
                new String[]{"Pristina"},
                new String[]{"Ravie"},
                new String[]{"Snap ITC"},
                new String[]{"Tempus Sans ITC"},
                new String[]{"Gigi"},
                new String[]{"Curlz MT"},
                new String[]{"Juice ITC"},
                new String[]{"Bauhaus 93"},
                new String[]{"Agency FB"},
                new String[]{"Algerian"},
                new String[]{"Magneto"},
                new String[]{"Castellar"},
                new String[]{"Colonna MT"},
                new String[]{"Forte"},
                new String[]{"Gabriola"},
                new String[]{"Goudy Stout"},
                new String[]{"Rockwell Extra Bold"},
                new String[]{"Onyx"},
                new String[]{"Informal Roman"},
                new String[]{"Arial Rounded MT Bold"},
                new String[]{"Niagara"},
                new String[]{"Engravers MT"},
                // 经典衬线
                new String[]{"Georgia"},
                new String[]{"Palatino Linotype"},
                new String[]{"Bookman Old Style"},
                new String[]{"Book Antiqua"},
                new String[]{"Garamond"},
                new String[]{"Baskerville Old Face"},
                new String[]{"Century Schoolbook"},
                new String[]{"Century"},
                new String[]{"Century Gothic"},
                new String[]{"Cambria"},
                new String[]{"Constantia"},
                new String[]{"Perpetua"},
                new String[]{"Bodoni MT"},
                new String[]{"Bell MT"},
                new String[]{"Times New Roman"},
                new String[]{"Rockwell"},
                new String[]{"Lucida Bright"},
                new String[]{"Lucida Fax"},
                new String[]{"Lucida Sans"},
                new String[]{"Lucida Sans Typewriter"},
                new String[]{"OCR A Extended"});
        java.util.Set<String> fontNorm = new java.util.HashSet<>();
        for (String f : javafx.scene.text.Font.getFamilies()) fontNorm.add(normFontName(f));
        List<String> fontFamilies = new ArrayList<>();
        for (String[] cand : curatedFonts) {
            String hit = null;
            for (String name : cand) {
                if (fontNorm.contains(normFontName(name))) { hit = name; break; }
            }
            if (hit != null) fontFamilies.add(hit);
        }
        cbTextFont.setItems(FXCollections.observableArrayList(fontFamilies));
        cbTextFont.setValue("Microsoft YaHei");

        // ── 间隙字幕编辑器（两行独立字体/字号）──
        cbCapFont1.setItems(FXCollections.observableArrayList(fontFamilies));
        cbCapFont2.setItems(FXCollections.observableArrayList(fontFamilies));
        cbCapFont1.setValue("Microsoft YaHei");
        cbCapFont2.setValue("Microsoft YaHei");
        tfCapLine1.textProperty().addListener((o, ov, nv) -> applyCaptionEditor());
        tfCapLine2.textProperty().addListener((o, ov, nv) -> applyCaptionEditor());
        slCapSize1.valueProperty().addListener((o, ov, nv) -> {
            if (lblCapSize1 != null) lblCapSize1.setText(String.valueOf(nv.intValue()));
            applyCaptionEditor();
        });
        slCapSize2.valueProperty().addListener((o, ov, nv) -> {
            if (lblCapSize2 != null) lblCapSize2.setText(String.valueOf(nv.intValue()));
            applyCaptionEditor();
        });
        cbCapFont1.valueProperty().addListener((o, ov, nv) -> applyCaptionEditor());
        cbCapFont2.valueProperty().addListener((o, ov, nv) -> applyCaptionEditor());
        cpCapColor.valueProperty().addListener((o, ov, nv) -> applyCaptionEditor());
        cbCapBgBar.selectedProperty().addListener((o, ov, nv) -> applyCaptionEditor());
        slCapSpacing.valueProperty().addListener((o, ov, nv) -> applyCaptionEditor());

        tfCustomText.textProperty().addListener((o, ov, nv) -> {
            syncLiveTextLine();
            renderPreview();
        });
        slTextSize.valueProperty().addListener((o, ov, nv) -> applyTextStyleToCurrent());
        cpTextColor.valueProperty().addListener((o, ov, nv) -> applyTextStyleToCurrent());
        cbTextFont.valueProperty().addListener((o, ov, nv) -> applyTextStyleToCurrent());

        cbCanvasRatio.valueProperty().addListener((o,ov,nv) -> {
            if (nv != null) { template.setCanvasRatio(nv); onSettingChanged(); }
        });

        tfZoomValue.setOnAction(e -> {
            try {
                double val = Double.parseDouble(tfZoomValue.getText().replace("%", "")) / 100.0;
                setZoom(val);
            } catch (NumberFormatException ex) {
                tfZoomValue.setText(String.format("%.0f%%", getZoom() * 100));
            }
        });
        // 滑杆与数字输入框双向同步
        zoomSlider.valueProperty().addListener((o, ov, nv) -> {
            double z = nv.doubleValue();
            if (puzzleMode) {
                if (!isUpdating) setZoom(z);
                return;
            }
            if (Math.abs(z - zoomValue) > 0.0001) {
                zoomValue = z;
                tfZoomValue.setText(String.format("%.0f%%", z * 100));
                scheduleRender();
            }
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
                updatePresetListHeight();
            } else {
                lvPresets.getItems().clear();
                updatePresetListHeight();
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
                setZoom((puzzleMode ? puzzlePreviewZoom : getZoom()) + delta);
                e.consume();
            }
        });

        rootPane.sceneProperty().addListener((obs, oldScene, newScene) -> {
            if (newScene != null) {
                // 窗口最小化/隐藏时暂停重绘，恢复后补渲染（规避 D3D 退化状态下的纹理异常）
                newScene.windowProperty().addListener((wo, oldWin, newWin) -> attachWindowPause(newWin));
                if (newScene.getWindow() != null) attachWindowPause(newScene.getWindow());
                newScene.setOnKeyPressed(ke -> {
                    if (ke.isControlDown() && ke.getCode() == KeyCode.A) {
                        selectAllImages();
                        ke.consume();
                    } else if (ke.isControlDown() && ke.getCode() == KeyCode.C) {
                        copySelectedElement();
                        ke.consume();
                    } else if (ke.isControlDown() && ke.getCode() == KeyCode.V) {
                        pasteClipboardElement();
                        ke.consume();
                    } else if (ke.getCode() == KeyCode.DELETE && (IconManager.getSelected() != null || selectedTextLine != null || selectedSticker != null)) {
                        onDeleteActiveElement();
                        ke.consume();
                    }
                });
            }
        });

        // Amplify right panel scroll wheel speed
        Platform.runLater(() -> {
            // 左侧边框栏滚轮提速 5 倍（与右侧面板同一机制）
            if (sidebarScroll != null) {
                sidebarScroll.addEventFilter(ScrollEvent.SCROLL, e -> {
                    if (e.getDeltaY() == 0) return;
                    double newV = sidebarScroll.getVvalue() - e.getDeltaY() * 0.04;
                    sidebarScroll.setVvalue(Math.max(0, Math.min(1, newV)));
                    e.consume();
                });
            }
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
                } else if (selectedSticker != null) {
                    selectedSticker.setOpacity(nv.intValue());
                    renderPreview();
                } else if (selectedTextLine != null) {
                    selectedTextLine.setOpacity(nv.intValue());
                    renderPreview();
                }
            });
            slElementRotation.valueProperty().addListener((o,ov,nv) -> {
                double deg = nv.doubleValue();
                if (selectedIcon != null) {
                    selectedIcon.setRotation(deg);
                    renderPreview();
                } else if (selectedSticker != null) {
                    selectedSticker.setRotation(deg);
                    renderPreview();
                } else if (selectedTextLine != null) {
                    selectedTextLine.setRotation(deg);
                    renderPreview();
                }
            });
        });

        refreshUI();

        // 启动时恢复登录态并刷新主界面登录状态
        updateLoginUi();
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
        slLeakOpacity.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slLeakAngle.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slTextSize.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        slCornerDecorSize.valueProperty().addListener((o,ov,nv) -> onSettingChanged());
        setupSliderUndo(slImgScale, slFillOpacity, slStrokeWidth, slStrokeOpacity,
                slGradientAngle, slTextureScale, slCornerRadius, slTearStrength, slTearDensity,
                slShadowX, slShadowY, slShadowBlur, slShadowSpread,
                slGlowBlur, slGlowOpacity, slVignetteStrength, slTextSize, slCornerDecorSize,
                slLeakOpacity, slLeakAngle,
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
        cbTearEnable.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbShadow.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbGlow.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbVignette.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbLightLeak.selectedProperty().addListener((o,ov,nv) -> onSettingCommit());
        cbExifText.selectedProperty().addListener((o,ov,nv) -> {
            BorderProcessor.setUseExifEnabled(nv);
            syncExifTextLine();
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
    private final AtomicBoolean puzzleRenderScheduled = new AtomicBoolean(false);
    private final AtomicBoolean puzzleDirty = new AtomicBoolean(false);
    private final AtomicBoolean normalDirty = new AtomicBoolean(false);
    /** 窗口最小化/不可见时暂停重绘：Canvas 在退化渲染状态下保持脏区会每帧重试创建纹理，
     *  触发 Intel 核显 D3D 驱动的 "Illegal texture dimensions" 已知缺陷（恢复可见后补一次渲染） */
    private volatile boolean windowRenderPaused = false;
    /** 拼图图片缓存：path@分辨率档 → 解码+方向+sRGB+降采样后的图（LRU 上限 16 张，超大图不缓存）。
     *  按分辨率档位缓存后，滚轮连续缩放格子时各档复用，避免反复解码大图卡顿 */
    private final Map<String, BufferedImage> puzzleImageCache =
            Collections.synchronizedMap(new LinkedHashMap<String, BufferedImage>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, BufferedImage> eldest) {
                    return size() > 16;
                }
            });

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
        saveCurrentTemplate();
        invalidateCurrentThumb();
        scheduleRender();
    }

    /** 当前图模板立即写回独立快照：保证每张照片参数完全独立，切换/预览/导出都从各自快照恢复 */
    private void saveCurrentTemplate() {
        if (currentImageIndex >= 0 && currentImageIndex < imageFiles.size()) {
            File cur = imageFiles.get(currentImageIndex);
            if (cur != null) {
                imageTemplates.put(cur, cloneTemplate(template));
            }
        }
    }

    /** 合并高频参数变化：防抖窗口内最多触发一次预览渲染，避免拖动滑块时逐帧全量重绘 */
    private void scheduleRender() {
        if (isWindowPaused()) {
            normalDirty.set(true);
            return;
        }
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
        invalidateCurrentThumb();
        renderPreview();
    }

    /** 仅失效当前图片的缩略图：参数变化只影响当前图的独立模板快照，其他图缩略图仍然有效 */
    private void invalidateCurrentThumb() {
        if (currentImageIndex >= 0 && currentImageIndex < imageFiles.size()) {
            File cur = imageFiles.get(currentImageIndex);
            if (cur != null) thumbCache.remove(cur);
        }
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
            int top = parseInt(tfMarginTop.getText(), 80);
            int bot = parseInt(tfMarginBottom.getText(), 120);
            int left = parseInt(tfMarginLeft.getText(), 80);
            int right = parseInt(tfMarginRight.getText(), 80);
            int minMargin = Math.min(Math.min(top, bot), Math.min(left, right));
            if (minMargin >= 5) {
                template.setPhotoFrameBorderSize(minMargin);
            }
        } catch (Exception ignored) {}

        // 相框参数区：类型/位置/字号/模糊强度写入模板，保证每张图片各自独立
        try {
            template.setParamType("完整参数".equals(cbParamType.getValue()) ? 0 : 1);
            template.setParamPosition(cbParamPosition.getValue());
        } catch (Exception ignored) {}
        BorderProcessor.setParamType(template.getParamType());
        BorderProcessor.setBlurIntensity(template.getBlurIntensity());
        try {
            WatermarkRender.setPosition(positionOf(cbParamPosition.getValue()));
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
        light.setLightLeakOpacity(slLeakOpacity.getValue());
        light.setLightLeakAngle(slLeakAngle.getValue());

        template.setParamFontSize((int) slParamFontSize.getValue());

        TextStickerConfig decor = template.getDecorConfig();
        if (decor != null) {
            decor.setExifAutoText(cbExifText.isSelected() ? 1 : 0);
            decor.setCornerDecorEnable(cbCornerDecor.isSelected() ? 1 : 0);
            decor.setCornerDecorSize(slCornerDecorSize.getValue());
        }

        syncManualExif();
        // 手动修改 EXIF 字段后同步参数行到当前模板
        syncExifTextLine();
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

        // 画布比例：跟随模板当前值回显（旧模板无该字段时为 original）
        String cr = template.getCanvasRatio();
        cbCanvasRatio.setValue(cr == null || cr.isEmpty() ? "original" : cr);

        BaseMargin margin = template.getBaseMargin();
        cbMarginLock.setSelected(margin.getMarginLock() == 1);
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
        cbParamType.setValue(template.getParamType() == 0 ? "完整参数" : "居中参数");
        String pos = template.getParamPosition();
        cbParamPosition.setValue(pos == null || pos.isEmpty() ? "居中" : pos);
        BorderProcessor.setParamType(template.getParamType());
        BorderProcessor.setBlurIntensity(template.getBlurIntensity());
        WatermarkRender.setPosition(positionOf(cbParamPosition.getValue()));

        updateLayerList();
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
        slLeakOpacity.setValue(light.getLightLeakOpacity());
        slLeakAngle.setValue(light.getLightLeakAngle());

        TextStickerConfig decor = template.getDecorConfig();
        if (decor != null) {
            cbCornerDecor.setSelected(decor.getCornerDecorEnable() == 1);
            slCornerDecorSize.setValue(decor.getCornerDecorSize());
            // 参数水印开关随模板/预设回写，保证加载模板后显示与导出一致
            if (cbExifText != null) cbExifText.setSelected(decor.getExifAutoText() == 1);
        }

        // 按用户勾选状态把 EXIF 参数行同步进当前模板（预设切换后参数不丢失）
        syncExifTextLine();

        // 模板刷新后清空画布元素选中态
        selectedTextLine = null;
        selectedSticker = null;
        selectedKind = null;
        liveTextLine = null;
        engine.setSelectedTextLine(null);
        engine.setSelectedSticker(null);
        IconManager.setSelected(null);

        // 拼图面板回显
        if (slPuzzleGap != null) {
            slPuzzleGap.setValue(template.getPuzzlrConfig().getGap());
            boolean blurBg = template.getPuzzlrConfig().getBgMode() == 1;
            cbPuzzleBg.setValue(blurBg ? "模糊照片底" : "白色背景");
            cpPuzzleBorder.setDisable(blurBg);
            try {
                cpPuzzleBorder.setValue(javafx.scene.paint.Color.web(template.getPuzzlrConfig().getBorderColor()));
            } catch (Exception e) {
                cpPuzzleBorder.setValue(javafx.scene.paint.Color.WHITE);
            }
            double canvasR = template.getPuzzlrConfig().getCanvasRatio();
            cbPuzzleCanvas.setValue(canvasR <= 0 ? "自动" : ratioLabel(canvasR));
        }

        isUpdating = false;
    }

    /** 把 EXIF 参数（照片读取或手动填写）同步为当前模板底部的参数行 */
    private void syncExifTextLine() {
        if (template == null || template.getDecorConfig() == null) return;
        String text = cachedExifText;
        if (text.isEmpty()) text = buildManualExifText();
        List<TextStickerConfig.TextLine> lines = template.getDecorConfig().getTextLines();
        if (cbExifText != null && cbExifText.isSelected() && !text.isEmpty()) {
            // 移除旧的自动参数行（兼容旧版 bottom 标记），避免重复
            lines.removeIf(l -> l.getText() != null && isAutoExifLine(l));
            TextStickerConfig.TextLine line = new TextStickerConfig.TextLine();
            line.setText(text);
            line.setAlign("exif");
            int fs = template.getParamFontSize();
            line.setFontSize(fs > 0 ? fs : 16);
            lines.add(line);
        } else {
            // 未开启参数显示：移除可能残留的自动参数行
            lines.removeIf(l -> l.getText() != null && isAutoExifLine(l));
        }
    }

    /** 判断是否为自动生成的 EXIF 参数行（新标记 exif，兼容旧标记 bottom） */
    private static boolean isAutoExifLine(TextStickerConfig.TextLine l) {
        if (l == null || l.getAlign() == null) return false;
        if ("exif".equals(l.getAlign())) return true;
        // 兼容旧模板：bottom 行且文本符合 EXIF 参数格式才视为自动参数行，避免误删用户手写文字
        if (!"bottom".equals(l.getAlign())) return false;
        String t = l.getText() == null ? "" : l.getText();
        if (t.isEmpty()) return false;
        return t.matches("(?s).*(mm|F/|ISO|1/\\d|\\d{4}:\\d{2}:\\d{2}).*");
    }

    /** 从手动输入的 EXIF 字段拼装参数文本（照片无 EXIF 时的兜底） */
    private String buildManualExifText() {
        StringBuilder sb = new StringBuilder();
        String brand = tfExifBrand.getText() == null ? "" : tfExifBrand.getText().trim();
        String model = tfExifModel.getText() == null ? "" : tfExifModel.getText().trim();
        if (!brand.isEmpty() || !model.isEmpty()) sb.append(brand).append(" ").append(model).append("  ");
        String focal = tfExifFocal.getText() == null ? "" : tfExifFocal.getText().trim();
        if (!focal.isEmpty()) sb.append(focal).append("  ");
        String ap = tfExifAperture.getText() == null ? "" : tfExifAperture.getText().trim();
        if (!ap.isEmpty()) sb.append(ap).append("  ");
        String iso = tfExifIso.getText() == null ? "" : tfExifIso.getText().trim();
        if (!iso.isEmpty()) sb.append(iso).append("  ");
        String sh = tfExifShutter.getText() == null ? "" : tfExifShutter.getText().trim();
        if (!sh.isEmpty()) {
            sb.append(sh);
            if (!sh.endsWith("s") && !sh.endsWith("S")) sb.append("s");
        }
        return sb.toString().trim();
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
        // 默认定位到上次打开图片的目录
        File lastOpen = getLastOpenDir();
        if (lastOpen != null) fc.setInitialDirectory(lastOpen);
        List<File> files = fc.showOpenMultipleDialog(btnOpenImage.getScene().getWindow());
        if (files != null && !files.isEmpty()) {
            saveLastOpenDir(files.get(0).getParentFile());
            loadImage(files.get(0));
            for (int i = 1; i < files.size(); i++) {
                if (!imageFiles.contains(files.get(i))) {
                    imageFiles.add(files.get(i));
                }
            }
            updateFilmStrip();
        }
    }

    /** 右侧栏所有滑块自动附加数值标签（已有专属数值显示的除外） */
    private void attachSliderValueLabels(javafx.scene.Parent root) {
        java.util.Set<String> skip = java.util.Set.of("slCapSize1", "slCapSize2", "slGlobalMargin");
        java.util.List<javafx.scene.control.Slider> sliders = new java.util.ArrayList<>();
        collectSliders(root, sliders);
        for (javafx.scene.control.Slider s : sliders) {
            if (s.getId() != null && skip.contains(s.getId())) continue;
            if (!(s.getParent() instanceof javafx.scene.layout.Pane pane)) continue;
            javafx.scene.control.Label lbl = new javafx.scene.control.Label();
            lbl.setStyle("-fx-min-width: 34; -fx-alignment: CENTER_RIGHT; -fx-text-fill: -fx-text-background-color;");
            int idx = pane.getChildren().indexOf(s);
            pane.getChildren().add(idx + 1, lbl);
            Runnable upd = () -> {
                double v = s.getValue();
                double range = s.getMax() - s.getMin();
                lbl.setText(range >= 20 ? String.valueOf((int) Math.round(v)) : String.format("%.1f", v));
            };
            s.valueProperty().addListener((o, ov, nv) -> upd.run());
            upd.run();
        }
    }

    private void collectSliders(javafx.scene.Node node, java.util.List<javafx.scene.control.Slider> out) {
        if (node instanceof javafx.scene.control.Slider s) { out.add(s); return; }
        if (node instanceof javafx.scene.Parent p) {
            for (javafx.scene.Node n : p.getChildrenUnmodifiable()) collectSliders(n, out);
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
                                } else if (!imageFiles.contains(f)) {
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
            currentImageFile = file;
            // Save current template for the image being left
            if (currentImageIndex >= 0 && currentImageIndex < imageFiles.size()) {
                File oldFile = imageFiles.get(currentImageIndex);
                if (oldFile != null && !oldFile.equals(file)) {
                    syncModelFromUI();
                    imageTemplates.put(oldFile, cloneTemplate(template));
                }
            }

            // 切换照片前记录旧画布尺寸，用于把已放置的 Logo/图标按比例换算到新照片上
            double[] oldCanvas = null;
            if (originImage != null && !IconManager.getActiveIcons().isEmpty()) {
                oldCanvas = engine.computeCanvasSize(originImage, this.template);
            }

            int idx = imageFiles.indexOf(file);
            if (idx < 0) {
                imageFiles.add(file);
                idx = imageFiles.size() - 1;
            }
            currentImageIndex = idx;

            // Restore saved template for this image, or start fresh
            // 深拷贝恢复：当前编辑模板与快照彻底解耦，避免引用共享导致调节互相影响
            TemplateModel saved = imageTemplates.get(file);
            if (saved != null) {
                template = cloneTemplate(saved);
            } else {
                // 新图无快照：继承当前编辑中的模板（克隆解耦），保证连续打开/拖入的图片效果一致；
                // 调参后 saveCurrentTemplate 写入独立快照，每图仍然各自独立
                template = cloneTemplate(template);
                // 参数水印开关不随新图继承：新图默认不显示相机参数，避免点击胶片框时复选框被自动选中
                if (template.getDecorConfig() != null) {
                    template.getDecorConfig().setExifAutoText(0);
                }
            }
            logExport("[loadImage] " + file.getName() + " saved=" + (saved != null) + " idx=" + idx
                    + " current=" + currentImageIndex + " fp=" + templateFingerprint(template));

            selectedIndices.clear();
            selectedIndices.add(idx);
            originImage = new Image(file.toURI().toString(), false);

            // 预览照片按 EXIF 方向旋转，与导出/缩略图方向一致：
            // 竖拍照片旋转后宽高互换，画布尺寸与文字位置才能与导出完全一致
            ExifReader.ExifData exifData = ExifReader.parse(file);
            if (exifData != null && exifData.orientation > 1) {
                originImage = rotateFxImage(originImage, exifData.orientation);
            }
            BorderProcessor.setExifData(exifData);

            // 画布尺寸随照片变化：按比例平移已放置图标，保证在其他照片上的相对位置一致
            if (oldCanvas != null && oldCanvas[0] > 0 && oldCanvas[1] > 0) {
                double[] newCanvas = engine.computeCanvasSize(originImage, this.template);
                if (newCanvas[0] > 0 && newCanvas[1] > 0) {
                    double rx = newCanvas[0] / oldCanvas[0];
                    double ry = newCanvas[1] / oldCanvas[1];
                    for (IconItem icon : IconManager.getActiveIcons()) {
                        icon.setX(icon.getX() * rx);
                        icon.setY(icon.getY() * ry);
                    }
                }
            }

            if (exifData != null) {
                tfExifBrand.setText(exifData.make != null ? exifData.make : "");
                tfExifModel.setText(exifData.model != null ? exifData.model : "");
                tfExifFocal.setText(exifData.focalLength != null ? exifData.focalLength : "");
                tfExifAperture.setText(exifData.aperture != null ? exifData.aperture : "");
                tfExifIso.setText(exifData.iso != null ? exifData.iso : "");
                tfExifShutter.setText(exifData.shutter != null ? exifData.shutter : "");
            }

            // 总是缓存 EXIF 参数文本（不依赖复选框），供任何边框模式按需显示；
            // 实际写入 textLines 由 syncExifTextLine 在 refreshUI 时统一处理
            Map<String, String> exif = ExifTextParser.readExif(file.getAbsolutePath());
            cachedExifText = ExifTextParser.formatExifText(exif, "");

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
                // 仅左键处理切换/多选；右键只弹菜单，不触发图片切换
                if (e.getButton() != javafx.scene.input.MouseButton.PRIMARY) return;
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

            // 右键菜单：同步边框 / 删除
            ContextMenu menu = new ContextMenu();
            MenuItem syncItem = new MenuItem("同步边框");
            syncItem.setOnAction(e -> {
                if (idx == currentImageIndex) {
                    statusLabel.setText("当前图片已应用此边框，无需同步");
                    return;
                }
                syncModelFromUI();
                TemplateModel target = cloneTemplate(template);
                // 文字坐标按源画布→目标画布换算，保证在其他照片上的相对位置一致
                double[] srcCanvas = engine.computeCanvasSize(originImage, template);
                double[] dstSize = readImageSize(imageFiles.get(idx));
                if (dstSize != null) {
                    double[] dstCanvas = engine.computeCanvasSize(dstSize[0], dstSize[1], target);
                    rebaseTextLinesToCanvas(target, srcCanvas[0], srcCanvas[1], dstCanvas[0], dstCanvas[1]);
                }
                imageTemplates.put(imageFiles.get(idx), target);
                clearThumbCache();
                updateFilmStrip();
                statusLabel.setText("已同步边框到: " + imageFiles.get(idx).getName());
            });
            MenuItem delItem = new MenuItem("删除");
            delItem.setOnAction(e -> removeImageAt(idx));
            menu.getItems().addAll(syncItem, delItem);
            container.setOnContextMenuRequested(e -> {
                e.consume();
                menu.show(container, e.getScreenX(), e.getScreenY());
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
        if (idx < 0 || idx >= imageFiles.size() || idx == currentImageIndex) {
            logExport("[switchToImage] skip idx=" + idx + " current=" + currentImageIndex);
            return;
        }
        loadImage(imageFiles.get(idx));
    }

    /** 从胶片条删除指定图片（仅移出列表，不删除磁盘文件） */
    private void removeImageAt(int idx) {
        if (idx < 0 || idx >= imageFiles.size()) return;
        File removed = imageFiles.remove(idx);
        imageTemplates.remove(removed);
        thumbCache.remove(removed);

        // 修正多选下标
        selectedIndices.removeIf(s -> s == idx);
        java.util.Set<Integer> shifted = new java.util.HashSet<>();
        for (int s : selectedIndices) {
            shifted.add(s > idx ? s - 1 : s);
        }
        selectedIndices.clear();
        selectedIndices.addAll(shifted);

        if (idx < currentImageIndex) {
            currentImageIndex--;
        } else if (idx == currentImageIndex) {
            if (imageFiles.isEmpty()) {
                currentImageIndex = -1;
                originImage = null;
                template = new TemplateModel();
                placeholderView.setVisible(true);
                GraphicsContext gc = previewCanvas.getGraphicsContext2D();
                gc.setFill(Color.rgb(200, 200, 200));
                gc.fillRect(0, 0, previewCanvas.getWidth(), previewCanvas.getHeight());
                lblImageInfo.setText("0/0 无图片");
            } else {
                int next = Math.min(idx, imageFiles.size() - 1);
                currentImageIndex = -1; // 避免 loadImage 把已删除文件存回模板表
                loadImage(imageFiles.get(next));
            }
        }

        clearThumbCache();
        updateFilmStrip();
        statusLabel.setText("已从列表删除: " + removed.getName());
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
        btnSaveImage.setDisable(exporting);
        btnSaveImage.setText(exporting ? "导出中..." : "导出图片");
    }

    /**
     * 批量导出：解码与写盘阶段并行（有限线程池），
     * 渲染因依赖 Canvas snapshot 仍在界面线程串行执行；输出内容与顺序无关，结果与串行版本一致。
     */
    private void exportImagesInParallel(List<File> files, File exportDir, String fmt, float jpegQuality) {
        // FX 渲染（Canvas.snapshot）在界面线程串行执行，多线程并行只对 AWT 预处理有收益；
        // 单线程可避免多线程同时创建/写入大尺寸 WritableImage 时的 GPU 纹理竞争（曾触发 D3D 设备崩溃）
        int threads = 1;
        ExecutorService pool = Executors.newFixedThreadPool(threads, r -> {
            Thread t = new Thread(r, "export-worker");
            t.setDaemon(true);
            return t;
        });
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
            // 每图独立模板：同步边框到选中图片后，导出与预览使用同一套边框
            TemplateModel fileTmpl = cloneTemplate(imageTemplates.getOrDefault(src, template));
            pool.execute(() -> {
                try {
                    WritableImage result = renderFileOnFxThread(src, fileTmpl);
                    int n = fileNum.getAndIncrement();
                    String outPath = exportDir.getAbsolutePath() + File.separator +
                            FileUtil.getFileNameWithoutExt(fileName) + "_bordered_" + String.format("%03d", n) + "." + ext;
                    ImageExportUtil.export(result, outPath, fmt, jpegQuality);
                } catch (Exception e) {
                    failed.incrementAndGet();
                    e.printStackTrace();
                    Platform.runLater(() -> showAlert("跳过损坏文件: " + fileName + "\n" + e.getMessage()));
                } catch (Throwable t) {
                    // OOM 等 Error 也计入失败并释放 latch，避免批量导出永久挂起
                    failed.incrementAndGet();
                    t.printStackTrace();
                    Platform.runLater(() -> showAlert("跳过文件: " + fileName + "\n" + t.getMessage()));
                } finally {
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

    private File getLastOpenDir() {
        try {
            String p = java.nio.file.Files.readString(
                    java.nio.file.Paths.get(OPEN_SETTINGS_FILE), StandardCharsets.UTF_8).trim();
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

    /** 记住上次打开图片的目录，供下次打开默认定位 */
    private void saveLastOpenDir(File dir) {
        if (dir == null) return;
        try {
            java.nio.file.Files.writeString(
                    java.nio.file.Paths.get(OPEN_SETTINGS_FILE), dir.getAbsolutePath(), StandardCharsets.UTF_8);
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
        saveCurrentTemplate();
        // 同步边框只同步边框效果：剥离 EXIF 自动参数行，相机参数由每张图片自己的 EXIF 决定
        int count = 0;
        for (int idx : selectedIndices) {
            try {
                if (idx == currentImageIndex) continue;
                TemplateModel target = cloneTemplate(template);
                if (target.getDecorConfig() != null && target.getDecorConfig().getTextLines() != null) {
                    target.getDecorConfig().getTextLines().removeIf(MainController::isAutoExifLine);
                }
                // 文字坐标按源画布→目标画布换算，保证同步后文字在其他照片上的相对位置一致
                double[] srcCanvas = engine.computeCanvasSize(originImage, template);
                double[] dstSize = readImageSize(imageFiles.get(idx));
                if (dstSize != null) {
                    double[] dstCanvas = engine.computeCanvasSize(dstSize[0], dstSize[1], target);
                    rebaseTextLinesToCanvas(target, srcCanvas[0], srcCanvas[1], dstCanvas[0], dstCanvas[1]);
                }
                // 真正把当前边框同步到选中的图片：切换预览与导出都使用同一套边框
                imageTemplates.put(imageFiles.get(idx), target);
                count++;
            } catch (Exception ignored) {}
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
        setZoom(getZoom() + 0.2);
    }

    @FXML
    private void onZoomOut() {
        setZoom(getZoom() - 0.2);
    }

    @FXML
    private void onZoomFit() {
        setZoom(1.0);
        panX = 0;
        panY = 0;
        refreshView();
    }

    /** 读取当前预览缩放（10%~300%） */
    private double getZoom() {
        return zoomValue;
    }

    /** 设置预览缩放并刷新输入框与预览 */
    /** 实时求值窗口是否处于不可绘制状态（最小化/未显示），避免依赖监听器缓存导致永久暂停 */
    private boolean isWindowPaused() {
        if (rootPane.getScene() == null) return false;
        javafx.stage.Window w = rootPane.getScene().getWindow();
        if (w == null || !w.isShowing()) return true;
        return w instanceof javafx.stage.Stage s && s.isIconified();
    }

    /** 挂接窗口显示/最小化状态 → 暂停或恢复重绘 */
    private void attachWindowPause(javafx.stage.Window w) {
        if (w == null) return;
        w.showingProperty().addListener((o, ov, nv) -> updateWindowPause());
        if (w instanceof javafx.stage.Stage st) {
            st.iconifiedProperty().addListener((o, ov, nv) -> updateWindowPause());
        }
        updateWindowPause();
    }

    /** 依据窗口当前状态切换重绘暂停；恢复可见时补一次渲染 */
    private void updateWindowPause() {
        boolean paused = isWindowPaused();
        windowRenderPaused = paused;
        if (!paused) {
            if (puzzleMode) {
                if (puzzleDirty.get()) schedulePuzzleRender();
                else updatePuzzleViewFit();
            } else if (normalDirty.compareAndSet(true, false)) {
                refreshView();
            }
        }
    }

    /** 顶部缩放控件回显指定值（不触发渲染） */
    private void syncTopZoomUI(double z) {
        isUpdating = true;
        try {
            if (zoomSlider != null) zoomSlider.setValue(z);
            if (tfZoomValue != null) tfZoomValue.setText(String.format("%.0f%%", z * 100));
        } finally {
            isUpdating = false;
        }
    }

    private void setZoom(double z) {
        // 拼图模式：顶部缩放控件/普通滚轮/Alt+滚轮 控制拼图预览整体缩放
        if (puzzleMode) {
            puzzlePreviewZoom = Math.max(1.0, Math.min(4.0, z));
            if (tfZoomValue != null) {
                tfZoomValue.setText(String.format("%.0f%%", puzzlePreviewZoom * 100));
            }
            if (zoomSlider != null && Math.abs(zoomSlider.getValue() - puzzlePreviewZoom) > 0.0001) {
                zoomSlider.setValue(puzzlePreviewZoom);
            }
            updatePuzzleViewFit();
            return;
        }
        zoomValue = Math.max(0.1, Math.min(3.0, z));
        if (tfZoomValue != null) {
            tfZoomValue.setText(String.format("%.0f%%", zoomValue * 100));
        }
        if (zoomSlider != null && Math.abs(zoomSlider.getValue() - zoomValue) > 0.0001) {
            zoomSlider.setValue(zoomValue);
        }
        scheduleRender();
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
        applyBlurPreset("BLUR_CLASSIC");
    }

    @FXML
    private void onBlurWhite() {
        applyBlurPreset("BLUR_DATE");
    }

    /** 背景模糊按钮：重置模板与共享渲染参数，避免上一个边框（如“浮影白框”）的直角/强度参数泄漏 */
    private void applyBlurPreset(String style) {
        template = new TemplateModel();
        template.setPhotoFrameStyle(style);
        template.setPhotoFrameBorderSize(60);
        // 背景模糊/日期模糊默认使用照片自身模糊：清除之前导入的背景图
        BorderProcessor.setBgImagePath("");
        template.getBaseMargin().setBgBlurEnable(0);
        // 背景模糊的内部圆角（照片圆角）默认 200
        template.getCornerConfig().setCornerRadiusAll(200);
        template.getCornerConfig().setCornerRadiusTL(200);
        template.getCornerConfig().setCornerRadiusTR(200);
        template.getCornerConfig().setCornerRadiusBL(200);
        template.getCornerConfig().setCornerRadiusBR(200);
        // 模糊强度写入模板（渲染时从模板应用，保证每图独立）
        template.setBlurIntensity(50);
        refreshUI();
        renderPreview();
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

    /** 移除已导入的背景图，恢复照片自身模糊背景 */
    @FXML
    private void onClearBgImage() {
        BorderProcessor.setBgImagePath("");
        template.getBaseMargin().setBgBlurEnable(0);
        onSettingChanged();
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

    /** 潮流风格：小红书 3:4 竖版封面（白边 + 底部留白文字） */
    @FXML
    private void onPresetXhsCover() {
        TemplateModel loaded = loadPresetFromJson("小红书3比4封面");
        template = (loaded != null) ? loaded : createPreset("小红书3比4封面");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: 小红书 3:4 封面（竖版白边卡）");
    }

    /** 潮流风格：Instagram 渐变光环（深色底 + 紫粉橙渐变描边 + 白细线） */
    @FXML
    private void onPresetIgGradient() {
        TemplateModel loaded = loadPresetFromJson("IG渐变光环");
        template = (loaded != null) ? loaded : createPreset("IG渐变光环");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: IG 渐变光环（紫粉橙渐变描边）");
    }

    /** 潮流风格：醒图奶油风（奶油底色 + 圆角照片 + 暖色柔和投影） */
    @FXML
    private void onPresetCream() {
        TemplateModel loaded = loadPresetFromJson("醒图奶油风");
        template = (loaded != null) ? loaded : createPreset("醒图奶油风");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: 醒图奶油风（奶油底 + 圆角暖影）");
    }

    /** 潮流风格：Canva 错位拼贴（背景色块 + 照片偏移叠放） */
    @FXML
    private void onPresetCanvaCollage() {
        TemplateModel loaded = loadPresetFromJson("Canva错位拼贴");
        template = (loaded != null) ? loaded : createPreset("Canva错位拼贴");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: Canva 错位拼贴（色块 + 偏移叠放）");
    }

    /** 潮流风格：NOMO 复古相机（黑底 + 白色大日期 + 暖漏光） */
    @FXML
    private void onPresetNomo() {
        TemplateModel loaded = loadPresetFromJson("NOMO复古相机");
        template = (loaded != null) ? loaded : createPreset("NOMO复古相机");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: NOMO 复古相机（黑底白字 + 漏光）");
    }

    /** 潮流风格：苹果深色圆角卡（纯黑底 + 圆角照片 + 柔和投影） */
    @FXML
    private void onPresetAppleDark() {
        TemplateModel loaded = loadPresetFromJson("苹果深色圆角卡");
        template = (loaded != null) ? loaded : createPreset("苹果深色圆角卡");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: 苹果深色圆角卡（黑底圆角悬浮）");
    }

    /** 潮流风格：波普漫画风（白底粗黑描边 + 漫画拟声字） */
    @FXML
    private void onPresetPopArt() {
        TemplateModel loaded = loadPresetFromJson("波普漫画风");
        template = (loaded != null) ? loaded : createPreset("波普漫画风");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: 波普漫画风（粗黑描边 + POW! 拟声字）");
    }

    /** 潮流风格：极光渐变（深蓝底 + 青紫粉渐变边带 + 柔光） */
    @FXML
    private void onPresetAurora() {
        TemplateModel loaded = loadPresetFromJson("极光渐变");
        template = (loaded != null) ? loaded : createPreset("极光渐变");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: 极光渐变（青紫粉渐变 + 霓虹柔光）");
    }

    /** 潮流风格：杂志大刊头（超大衬线刊名 + 日期页码） */
    @FXML
    private void onPresetMagazine() {
        TemplateModel loaded = loadPresetFromJson("杂志大刊头");
        template = (loaded != null) ? loaded : createPreset("杂志大刊头");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: 杂志大刊头（超大刊名 + 细线版式）");
    }

    /** 潮流风格：暗夜星空（深蓝底 + 星字符 + 浅蓝细描边） */
    @FXML
    private void onPresetStarry() {
        TemplateModel loaded = loadPresetFromJson("暗夜星空");
        template = (loaded != null) ? loaded : createPreset("暗夜星空");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: 暗夜星空（深蓝星夜 + 星点装饰）");
    }

    /** 潮流风格：复古登机牌（米色票根 + 齿孔 + 票面文字） */
    @FXML
    private void onPresetBoarding() {
        TemplateModel loaded = loadPresetFromJson("复古登机牌");
        template = (loaded != null) ? loaded : createPreset("复古登机牌");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: 复古登机牌（票根齿孔 + 登机信息）");
    }

    /** 潮流风格：金箔奢华（金属纹理金边 + 深棕底 + 金色柔光） */
    @FXML
    private void onPresetGold() {
        TemplateModel loaded = loadPresetFromJson("金箔奢华");
        template = (loaded != null) ? loaded : createPreset("金箔奢华");
        refreshUI();
        renderPreview();
        statusLabel.setText("已应用预设: 金箔奢华（金属金边 + 金色柔光）");
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

    // ══════════════════════════ 拼图 ══════════════════════════

    /** 左侧拼图布局按钮：userData=布局类型 */
    @FXML
    private void onPuzzleLayout(javafx.event.ActionEvent e) {
        int type = Integer.parseInt(((Button) e.getSource()).getUserData().toString());
        enterPuzzleMode(type);
    }

    /** 进入拼图模式：设置样式 PUZZLE + 布局类型；按胶片框选中顺序填充空槽，不足用当前图补位 */
    private void enterPuzzleMode(int type) {
        PuzzlrConfig pc = template.getPuzzlrConfig();
        pc.setLayoutType(type);
        // 切换布局：绑定轴已消失的间隙字幕自动删除
        pruneGapCaptions(pc);
        closeCaptionEditor();
        // 进入拼图：视图缩放复位 100%，顶部缩放控件切到拼图状态
        puzzlePreviewZoom = 1.0;
        puzzleViewTx = 0;
        puzzleViewTy = 0;
        syncTopZoomUI(1.0);
        // 目标填充序列：胶片框选中顺序（按索引排序）优先，不足用当前图补位
        List<String> want = new ArrayList<>();
        List<Integer> sel = new ArrayList<>(selectedIndices);
        Collections.sort(sel);
        for (int idx : sel) {
            if (idx >= 0 && idx < imageFiles.size() && want.size() < pc.getSlots().size()) {
                want.add(imageFiles.get(idx).getAbsolutePath());
            }
        }
        for (int j = want.size(); j < pc.getSlots().size(); j++) {
            want.add(currentImageFile != null ? currentImageFile.getAbsolutePath() : null);
        }
        // 与现状不同才重填（相同则保留裁剪微调）；换图的格子重置缩放/偏移
        for (int j = 0; j < pc.getSlots().size(); j++) {
            String nw = want.get(j);
            if (!Objects.equals(pc.getSlots().get(j).getImagePath(), nw)) {
                pc.getSlots().get(j).setImagePath(nw);
                pc.getSlots().get(j).setOffsetX(0.5);
                pc.getSlots().get(j).setOffsetY(0.5);
                pc.getSlots().get(j).setZoom(1.0);
            }
        }
        template.setPhotoFrameStyle("PUZZLE");
        puzzleMode = true;
        puzzleSelectedSlot = 0;
        previewCanvas.setVisible(false);
        hScrollBar.setVisible(false);
        vScrollBar.setVisible(false);
        try {
            rightTabPane.getSelectionModel().select(6);
        } catch (Exception ignored) {}
        updatePuzzleSlotUI();
        refreshGapPicker();
        schedulePuzzleRender();
        statusLabel.setText("拼图: " + PuzzlrConfig.layoutName(type) + "（双击格子换图，拖动分割线调大小）");
    }

    @FXML
    private void onPuzzleClearSlots() {
        for (SlotConfig s : template.getPuzzlrConfig().getSlots()) s.setImagePath(null);
        schedulePuzzleRender();
        statusLabel.setText("已清空拼图格子");
    }

    private SlotConfig currentPuzzleSlot() {
        List<SlotConfig> slots = template.getPuzzlrConfig().getSlots();
        if (puzzleSelectedSlot < 0 || puzzleSelectedSlot >= slots.size()) {
            puzzleSelectedSlot = slots.isEmpty() ? -1 : 0;
            if (puzzleSelectedSlot < 0) return null;
        }
        return slots.get(puzzleSelectedSlot);
    }

    /** 拼接预览渲染：AWT 合成 → ImageView 显示，fit 到预览区（仅 FX 线程应用结果） */
    private void applyPuzzlePreview(BufferedImage out) {
        if (out == null) return;
        WritableImage fx = SwingFXUtils.toFXImage(out, null);
        puzzlePreviewView.setImage(fx);
        puzzlePreviewView.setVisible(true);
        placeholderView.setVisible(false);
        updatePuzzleViewFit();
        lblResolution.setText(String.format("拼图分辨率: %dx%d", out.getWidth(), out.getHeight()));
        lblCanvasSize.setText("画布: 拼图合成");
    }

    /** 拼图合成：读每格图片（EXIF 方向 + sRGB + 按需降采样），按布局/间距/裁剪参数合成。edge=输出长边。
     *  重活（解码数亿像素）只允许在后台线程调用，禁止在 FX 线程直接调用。 */
    private BufferedImage renderPuzzleImage(int edge) {
        PuzzlrConfig pc = template.getPuzzlrConfig();
        List<BufferedImage> imgs = new ArrayList<>();
        double[][] rel = pc.buildSlots();
        for (int i = 0; i < pc.getSlots().size(); i++) {
            SlotConfig s = pc.getSlots().get(i);
            BufferedImage img = null;
            if (s.getImagePath() != null) {
                double frac = i < rel.length ? Math.max(rel[i][2], rel[i][3]) : 1.0;
                int need = (int) Math.min(6000, Math.max(600, frac * edge * s.getZoom() * 1.15));
                // 预览渲染（edge<4000）：限制原图分辨率上限，避免格子滚轮缩放时反复解码超大图
                if (edge < 4000) need = Math.min(need, 2400);
                img = loadPuzzleSlotImage(s.getImagePath(), need);
            }
            imgs.add(img);
        }
        return com.qingframe.core.PuzzlrRenderer.render(imgs, pc, edge);
    }

    /** 读取单格图片：EXIF 方向 + sRGB + 降采样到 needEdge 长边；带 LRU 缓存避免拖动时反复解码 */
    private BufferedImage loadPuzzleSlotImage(String path, int needEdge) {
        // 分辨率档位化：need 随滚轮缩放连续变化，按档缓存避免缓存频繁失效
        int tier = 800;
        if (needEdge > 1200) tier = 1200;
        if (needEdge > 1600) tier = 1600;
        if (needEdge > 2000) tier = 2000;
        if (needEdge > 2400) tier = 2400;
        if (needEdge > 3000) tier = 3000;
        if (needEdge > 4000) tier = 4000;
        if (needEdge > 5000) tier = 5000;
        String key = path + "@" + tier;
        BufferedImage cached = puzzleImageCache.get(key);
        if (cached != null && Math.max(cached.getWidth(), cached.getHeight()) >= needEdge) return cached;
        try {
            File f = new File(path);
            if (!f.exists()) return null;
            int target = Math.max(needEdge, 800);
            // 先缩略解码 + 降采样，再做方向旋转/色彩转换：
            // 大图全尺寸逐像素旋转/转色会卡死数秒并占用数百 MB 内存，缩到目标尺寸后这些操作只需几十毫秒
            BufferedImage img = decodePuzzleScaled(f, target);
            if (img == null) return null;
            ExifReader.ExifData ex = ExifReader.parse(f);
            if (ex != null) img = applyOrientation(img, ex.orientation);
            img = toSRGB(img);
            // 超大图不进缓存（防内存膨胀），其余 LRU 缓存
            if ((long) img.getWidth() * img.getHeight() <= 24_000_000L) {
                puzzleImageCache.put(key, img);
            }
            return img;
        } catch (Exception e) {
            return null;
        }
    }

    /** 解码图片并按目标长边降采样：ImageIO 整数采样粗读（JPEG/PNG 解码层直接跳像素），再精确缩放。
     *  避免对几千万像素大图全尺寸解码后再缩放（卡顿与内存峰值的主要来源） */
    private BufferedImage decodePuzzleScaled(File f, int target) {
        return decodePuzzleScaled(f, target, false);
    }

    /** keepAlpha=true 时缩放目标保留透明通道（供缩略图等可能含透明的场景） */
    private BufferedImage decodePuzzleScaled(File f, int target, boolean keepAlpha) {
        int rgbType = keepAlpha ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB;
        try (javax.imageio.stream.ImageInputStream in = javax.imageio.ImageIO.createImageInputStream(f)) {
            if (in != null) {
                java.util.Iterator<javax.imageio.ImageReader> it = javax.imageio.ImageIO.getImageReaders(in);
                if (it.hasNext()) {
                    javax.imageio.ImageReader r = it.next();
                    try {
                        r.setInput(in, true, true);
                        int w = r.getWidth(0), h = r.getHeight(0);
                        int subs = 1;
                        while (w / (subs * 2L) > target || h / (subs * 2L) > target) subs *= 2;
                        javax.imageio.ImageReadParam p = r.getDefaultReadParam();
                        if (subs > 1) p.setSourceSubsampling(subs, subs, 0, 0);
                        BufferedImage img = r.read(0, p);
                        // 整数采样后可能仍大于目标，精确缩放到目标长边
                        int le = Math.max(img.getWidth(), img.getHeight());
                        if (le > target) {
                            double sc = (double) target / le;
                            BufferedImage small = new BufferedImage(
                                    Math.max(1, (int) Math.round(img.getWidth() * sc)),
                                    Math.max(1, (int) Math.round(img.getHeight() * sc)),
                                    keepAlpha && img.getColorModel().hasAlpha() ? BufferedImage.TYPE_INT_ARGB : rgbType);
                            Graphics2D gg = small.createGraphics();
                            gg.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION,
                                    java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                            gg.drawImage(img, 0, 0, small.getWidth(), small.getHeight(), null);
                            gg.dispose();
                            img = small;
                        }
                        return img;
                    } finally {
                        r.dispose();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        // 无可用 reader 或读取异常：回退全量解码 + 缩放
        try {
            BufferedImage fallback = ImageIO.read(f);
            if (fallback == null) return null;
            int le = Math.max(fallback.getWidth(), fallback.getHeight());
            if (le > target) {
                double sc = (double) target / le;
                BufferedImage small = new BufferedImage(
                        Math.max(1, (int) Math.round(fallback.getWidth() * sc)),
                        Math.max(1, (int) Math.round(fallback.getHeight() * sc)),
                        keepAlpha && fallback.getColorModel().hasAlpha() ? BufferedImage.TYPE_INT_ARGB : rgbType);
                Graphics2D gg = small.createGraphics();
                gg.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION,
                        java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                gg.drawImage(fallback, 0, 0, small.getWidth(), small.getHeight(), null);
                gg.dispose();
                return small;
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }

    /** 拼图渲染入口（线程安全）：置脏 + 后台合成，完成后回 FX 线程应用；渲染期间再有变更会自动补一轮 */
    private void schedulePuzzleRender() {
        puzzleDirty.set(true);
        if (isWindowPaused()) return;
        if (!puzzleRenderScheduled.compareAndSet(false, true)) return;
        renderScheduler.schedule(() -> {
            puzzleDirty.set(false);
            BufferedImage out = null;
            try {
                // 预览分辨率：预览框显示尺寸有限，1600 长边足够，合成与转换更快
                out = renderPuzzleImage(1600);
            } catch (Exception ignored) {}
            BufferedImage fin = out;
            Platform.runLater(() -> {
                puzzleRenderScheduled.set(false);
                if (puzzleMode && fin != null) applyPuzzlePreview(fin);
                if (puzzleDirty.get()) schedulePuzzleRender();
            });
        }, 150, TimeUnit.MILLISECONDS);
    }

    private void updatePuzzleSlotUI() {
        if (lblPuzzleSlot == null) return;
        List<SlotConfig> slots = template.getPuzzlrConfig().getSlots();
        // -1 = 已取消选中（点击画布外），不自动回选
        if (puzzleSelectedSlot < 0 || puzzleSelectedSlot >= slots.size()) {
            lblPuzzleSlot.setText("未选中格子");
            return;
        }
        SlotConfig s = slots.get(puzzleSelectedSlot);
        String name = s.getImagePath() != null ? new File(s.getImagePath()).getName() : "（空）";
        lblPuzzleSlot.setText("格子 " + (puzzleSelectedSlot + 1) + ": " + name);
        isUpdating = true;
        try {
            slSlotOffsetX.setValue(s.getOffsetX());
            slSlotOffsetY.setValue(s.getOffsetY());
            slSlotZoom.setValue(s.getZoom());
            cbSlotFill.setValue(s.getFillMode() == 1 ? "完整包含" : "填满裁切");
        } finally {
            isUpdating = false;
        }
        refreshPuzzleOverlay();
    }

    /** 拼图预览 fit 到预览区（整体缩放 puzzlePreviewZoom ≥1，不重渲染） */
    private void updatePuzzleViewFit() {
        Image img = puzzlePreviewView.getImage();
        if (img == null || !puzzleMode) return;
        double cw = puzzleViewport.getWidth();
        double ch = puzzleViewport.getHeight();
        if (!Double.isFinite(cw) || !Double.isFinite(ch) || cw <= 10 || ch <= 10) return;
        double iw = img.getWidth(), ih = img.getHeight();
        if (!Double.isFinite(iw) || !Double.isFinite(ih) || iw <= 0 || ih <= 0) return;
        double s = Math.min(cw / iw, ch / ih) * puzzlePreviewZoom;
        if (!Double.isFinite(s) || s <= 0) return;
        // 硬上限：防止任何异常路径把显示尺寸推到纹理极限
        if (iw * s > 16000 || ih * s > 16000) s = Math.min(16000 / iw, 16000 / ih);
        puzzleViewScale = s;
        puzzleFitW = img.getWidth() * s;
        puzzleFitH = img.getHeight() * s;
        puzzlePreviewView.setFitWidth(puzzleFitW);
        puzzlePreviewView.setFitHeight(puzzleFitH);
        // 非托管节点手动居中（不参与布局，避免反馈循环）
        puzzlePreviewView.relocate((cw - puzzleFitW) / 2, (ch - puzzleFitH) / 2);
        applyPuzzleViewTranslate();
        refreshPuzzleOverlay();
    }

    /** 钳制并应用视图平移（放大后可平移，未放大归零） */
    private void applyPuzzleViewTranslate() {
        double ovfX = Math.max(0, puzzleFitW - puzzleViewport.getWidth()) / 2;
        double ovfY = Math.max(0, puzzleFitH - puzzleViewport.getHeight()) / 2;
        if (puzzlePreviewZoom <= 1.001) { puzzleViewTx = 0; puzzleViewTy = 0; }
        puzzleViewTx = clamp(puzzleViewTx, -ovfX, ovfX);
        puzzleViewTy = clamp(puzzleViewTy, -ovfY, ovfY);
        puzzlePreviewView.setTranslateX(puzzleViewTx);
        puzzlePreviewView.setTranslateY(puzzleViewTy);
        if (puzzleOverlay != null) {
            puzzleOverlay.setTranslateX(puzzleViewTx);
            puzzleOverlay.setTranslateY(puzzleViewTy);
        }
    }

    /** 高亮层：选中格粗描边 + 分割把手条（mouseTransparent，仅视觉；交互仍在 puzzlePreviewView） */
    private void refreshPuzzleOverlay() {
        if (puzzleOverlay == null) return;
        Image img = puzzlePreviewView.getImage();
        boolean show = puzzleMode && img != null && puzzlePreviewView.getFitWidth() > 0;
        puzzlePreviewView.setVisible(show);
        puzzleOverlay.setVisible(show);
        if (!show) {
            puzzleOverlay.getChildren().clear();
            return;
        }
        double w = puzzlePreviewView.getFitWidth();
        double h = puzzlePreviewView.getFitHeight();
        // 非托管 overlay：手动调整大小并居中到视口（禁止设置 min/pref，会撑爆布局形成死循环）
        puzzleOverlay.resize(w, h);
        puzzleOverlay.relocate((puzzleViewport.getWidth() - w) / 2, (puzzleViewport.getHeight() - h) / 2);
        puzzleOverlay.getChildren().clear();
        PuzzlrConfig pc = template.getPuzzlrConfig();
        double[][] rel = pc.buildSlots();
        // 分割把手：轴位置画半透明细条，提示可拖拽
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        double[] av = pc.getAxisVals();
        for (int i = 0; i < axes.length; i++) {
            javafx.scene.shape.Rectangle hnd = axes[i][0] == 0
                    ? new javafx.scene.shape.Rectangle(clamp(av[i] * w, 0, w) - 3, 0, 6, h)
                    : new javafx.scene.shape.Rectangle(0, clamp(av[i] * h, 0, h) - 3, w, 6);
            hnd.setFill(javafx.scene.paint.Color.web("#4FC3F7", 0.30));
            hnd.setStroke(null);
            puzzleOverlay.getChildren().add(hnd);
        }
        // 选中格高亮粗描边
        if (puzzleSelectedSlot >= 0 && puzzleSelectedSlot < rel.length) {
            double[] r = rel[puzzleSelectedSlot];
            javafx.scene.shape.Rectangle sel = new javafx.scene.shape.Rectangle(
                    r[0] * w + 1.5, r[1] * h + 1.5, Math.max(0, r[2] * w - 3), Math.max(0, r[3] * h - 3));
            sel.setFill(null);
            sel.setStroke(javafx.scene.paint.Color.web("#4FC3F7"));
            sel.setStrokeWidth(3);
            sel.setStrokeType(javafx.scene.shape.StrokeType.INSIDE);
            puzzleOverlay.getChildren().add(sel);
        }
    }

    /** 鼠标坐标 → 画布相对坐标（0-1） */
    private double puzzleRelX(double x) {
        double w = puzzlePreviewView.getFitWidth();
        return w > 0 ? x / w : 0;
    }

    private double puzzleRelY(double y) {
        double h = puzzlePreviewView.getFitHeight();
        return h > 0 ? y / h : 0;
    }

    private int puzzleSlotAt(double rx, double ry) {
        double[][] slots = template.getPuzzlrConfig().buildSlots();
        for (int i = 0; i < slots.length; i++) {
            double[] r = slots[i];
            if (rx >= r[0] && rx <= r[0] + r[2] && ry >= r[1] && ry <= r[1] + r[3]) return i;
        }
        return -1;
    }

    private void setupPuzzleInteraction() {
        // 悬浮反馈：近分割线 → 调整大小光标；格内 → 移动光标
        puzzlePreviewView.setOnMouseMoved(e -> {
            if (puzzlePreviewView.getImage() == null || puzzleDragging) return;
            double rx = puzzleRelX(e.getX());
            double ry = puzzleRelY(e.getY());
            PuzzlrConfig pc = template.getPuzzlrConfig();
            double[] av = pc.getAxisVals();
            int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
            Cursor c = null;
            for (int i = 0; i < axes.length; i++) {
                if (axes[i][0] == 0 && Math.abs(rx - av[i]) < 0.02) { c = Cursor.H_RESIZE; break; }
                if (axes[i][0] == 1 && Math.abs(ry - av[i]) < 0.02) { c = Cursor.V_RESIZE; break; }
            }
            if (c == null && puzzleSlotAt(rx, ry) >= 0) c = Cursor.MOVE;
            puzzlePreviewView.setCursor(c != null ? c : Cursor.DEFAULT);
        });
        puzzlePreviewView.setOnMousePressed(e -> {
            if (puzzlePreviewView.getImage() == null) return;
            // Shift+按下：平移预览视图（不干扰格子编辑）
            if (e.isShiftDown()) {
                panningView = true;
                puzzleDragging = false;
                panStartX = e.getSceneX();
                panStartY = e.getSceneY();
                panStartTx = puzzleViewTx;
                panStartTy = puzzleViewTy;
                e.consume();
                return;
            }
            puzzleDragX = e.getX();
            puzzleDragY = e.getY();
            double rx = puzzleRelX(e.getX());
            double ry = puzzleRelY(e.getY());
            puzzleDragStartRelX = rx;
            puzzleDragStartRelY = ry;
            PuzzlrConfig pc = template.getPuzzlrConfig();
            double[] av = pc.getAxisVals();
            int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
            puzzleDragAxis = false;
            for (int i = 0; i < axes.length; i++) {
                double pos = av[i];
                boolean near = axes[i][0] == 0 ? Math.abs(rx - pos) < 0.03 : Math.abs(ry - pos) < 0.03;
                if (near) {
                    puzzleDragAxis = true;
                    puzzleDragAxisIdx = i;
                    break;
                }
            }
            // 按下即选中所在格：高亮描边即时跟随
            puzzlePressCell = puzzleSlotAt(rx, ry);
            if (!puzzleDragAxis && puzzlePressCell >= 0 && puzzlePressCell != puzzleSelectedSlot) {
                puzzleSelectedSlot = puzzlePressCell;
                updatePuzzleSlotUI();
                refreshPuzzleOverlay();
            }
            puzzleDragging = true;
            e.consume();
        });
        puzzlePreviewView.setOnMouseDragged(e -> {
            if (panningView) {
                puzzleViewTx = panStartTx + (e.getSceneX() - panStartX);
                puzzleViewTy = panStartTy + (e.getSceneY() - panStartY);
                applyPuzzleViewTranslate();
                e.consume();
                return;
            }
            if (!puzzleDragging) return;
            double rx = puzzleRelX(e.getX());
            double ry = puzzleRelY(e.getY());
            PuzzlrConfig pc = template.getPuzzlrConfig();
            if (puzzleDragAxis) {
                double[] av = pc.getAxisVals();
                int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
                double v = axes[puzzleDragAxisIdx][0] == 0 ? rx : ry;
                v = clamp(v, 0.12, 0.88);
                for (int i = 0; i < axes.length; i++) {
                    if (i == puzzleDragAxisIdx || axes[i][0] != axes[puzzleDragAxisIdx][0]) continue;
                    if (Math.abs(av[i] - v) < 0.12) {
                        v = av[i] + (v > av[i] ? 0.12 : -0.12);
                    }
                }
                av[puzzleDragAxisIdx] = clamp(v, 0.12, 0.88);
                refreshPuzzleOverlay();
                schedulePuzzleRender();
            } else {
                double[][] slots = pc.buildSlots();
                int si = puzzleSlotAt(puzzleDragStartRelX, puzzleDragStartRelY);
                if (si >= 0 && si < pc.getSlots().size()) {
                    SlotConfig s = pc.getSlots().get(si);
                    double[] r = slots[si];
                    double dw = rx - puzzleDragStartRelX;
                    double dh = ry - puzzleDragStartRelY;
                    // 取景窗口与鼠标反向：内容跟随手部拖动方向（抓住图片拖拽的手感）
                    s.setOffsetX(clamp(s.getOffsetX() - dw / r[2], 0, 1));
                    s.setOffsetY(clamp(s.getOffsetY() - dh / r[3], 0, 1));
                    puzzleDragStartRelX = rx;
                    puzzleDragStartRelY = ry;
                    puzzleSelectedSlot = si;
                    updatePuzzleSlotUI();
                    schedulePuzzleRender();
                }
            }
            e.consume();
        });
        puzzlePreviewView.setOnMouseReleased(e -> {
            if (panningView) {
                panningView = false;
                e.consume();
                return;
            }
            if (!puzzleDragging) return;
            puzzleDragging = false;
            double dist = Math.hypot(e.getX() - puzzleDragX, e.getY() - puzzleDragY);
            int over = puzzleSlotAt(puzzleRelX(e.getX()), puzzleRelY(e.getY()));
            if (dist < 6) {
                // 双击才更换图片；单击仅选中格子（间隙字幕改由拼图面板按钮进入，避免与分割线拖拽冲突）
                if (over >= 0 && e.getClickCount() >= 2) choosePuzzleImage(over);
            } else if (puzzlePressCell >= 0 && over >= 0 && over != puzzlePressCell) {
                // 拖拽到另一格：交换两张图片（含裁剪参数）
                swapPuzzleSlots(puzzlePressCell, over);
                updatePuzzleSlotUI();
                schedulePuzzleRender();
                statusLabel.setText("已交换格子 " + (puzzlePressCell + 1) + " 与 " + (over + 1));
            }
            puzzlePressCell = -1;
            e.consume();
        });
        puzzlePreviewView.setOnScroll(e -> {
            // Alt+滚轮：整体缩放视图，交给 dropTarget 的统一处理（兼容旧交互）
            if (e.isAltDown()) return;
            List<SlotConfig> slots = template.getPuzzlrConfig().getSlots();
            if (puzzleSelectedSlot >= 0 && puzzleSelectedSlot < slots.size()) {
                // 选中格子：滚轮缩放格子内图片
                SlotConfig s = slots.get(puzzleSelectedSlot);
                double factor = e.getDeltaY() > 0 ? 1.1 : 1 / 1.1;
                s.setZoom(clamp(s.getZoom() * factor, 0.2, 4.0));
                updatePuzzleSlotUI();
                schedulePuzzleRender();
                e.consume();
                return;
            }
            // 未选中格子（点击画布外已取消选中）：滚轮缩放整体图片，与普通画布一致（步进 ±10%）
            double delta = e.getDeltaY() > 0 ? 0.1 : -0.1;
            setZoom(puzzlePreviewZoom + delta);
            e.consume();
        });
        // 鼠标停在图片外的预览区：按选中状态与图片上滚轮行为保持一致
        puzzleViewport.setOnScroll(e -> {
            if (e.isAltDown()) return; // Alt+滚轮仍交给 dropTarget 统一处理
            List<SlotConfig> slots = template.getPuzzlrConfig().getSlots();
            if (puzzleSelectedSlot >= 0 && puzzleSelectedSlot < slots.size()) {
                SlotConfig s = slots.get(puzzleSelectedSlot);
                double factor = e.getDeltaY() > 0 ? 1.1 : 1 / 1.1;
                s.setZoom(clamp(s.getZoom() * factor, 0.2, 4.0));
                updatePuzzleSlotUI();
                schedulePuzzleRender();
                e.consume();
                return;
            }
            // 未选中：滚轮缩放整体图片
            double delta = e.getDeltaY() > 0 ? 0.1 : -0.1;
            setZoom(puzzlePreviewZoom + delta);
            e.consume();
        });
    }

    /** "3:4" → 0.75；"自动" → 0 */
    private static double parseCanvasRatio(String label) {
        if (label == null || "自动".equals(label)) return 0;
        String[] p = label.split(":");
        if (p.length != 2) return 0;
        try {
            double a = Double.parseDouble(p[0].trim());
            double b = Double.parseDouble(p[1].trim());
            return b > 0 ? a / b : 0;
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** 比例值 → 最接近的预设标签（回显用） */
    private static String ratioLabel(double r) {
        String best = "自动";
        double bestDiff = Double.MAX_VALUE;
        for (String label : List.of("1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2")) {
            double diff = Math.abs(parseCanvasRatio(label) - r);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = label;
            }
        }
        return best;
    }

    /** 当前下拉框选中间隙对应的字幕（无则 null） */
    private GapCaption currentGapCaption() {
        if (!puzzleMode || template == null) return null;
        int idx = cbPuzzleGapPick.getSelectionModel().getSelectedIndex();
        PuzzlrConfig pc = template.getPuzzlrConfig();
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        if (idx < 0 || idx >= axes.length) return null;
        String gid = (axes[idx][0] == 0 ? "V" : "H") + idx;
        for (GapCaption c : pc.getGapCaptions()) {
            if (gid.equals(c.getGapId())) return c;
        }
        return null;
    }

    /** 添加/编辑字幕按钮：对选中间隙创建（如无）并打开下方编辑器 */
    @FXML
    private void onEditGapCaption() {
        if (!puzzleMode) return;
        int idx = cbPuzzleGapPick.getSelectionModel().getSelectedIndex();
        PuzzlrConfig pc = template.getPuzzlrConfig();
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        if (idx < 0 || idx >= axes.length) {
            statusLabel.setText("请先在上方选择一条间隙");
            return;
        }
        String gid = (axes[idx][0] == 0 ? "V" : "H") + idx;
        GapCaption cap = currentGapCaption();
        if (cap == null) {
            cap = new GapCaption();
            cap.setGapId(gid);
            pc.getGapCaptions().add(cap);
            statusLabel.setText("已在间隙 " + gid + " 创建字幕，输入文字即可");
        } else {
            statusLabel.setText("正在编辑间隙 " + gid + " 的字幕");
        }
        captionEditorGap = idx;
        loadCaptionEditor(cap);
        vbCaptionEditor.setVisible(true);
        vbCaptionEditor.setManaged(true);
        refreshGapPicker();
        schedulePuzzleRender();
    }

    /** 删除字幕按钮：删除当前选中间隙绑定的字幕 */
    @FXML
    private void onDeleteGapCaption() {
        if (!puzzleMode) return;
        int idx = cbPuzzleGapPick.getSelectionModel().getSelectedIndex();
        PuzzlrConfig pc = template.getPuzzlrConfig();
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        if (idx < 0 || idx >= axes.length) {
            statusLabel.setText("请先在上方选择一条间隙");
            return;
        }
        String gid = (axes[idx][0] == 0 ? "V" : "H") + idx;
        boolean removed = pc.getGapCaptions().removeIf(c -> gid.equals(c.getGapId()));
        if (captionEditorGap == idx) closeCaptionEditor();
        refreshGapPicker();
        schedulePuzzleRender();
        statusLabel.setText(removed ? "已删除间隙 " + gid + " 的字幕" : "该间隙没有字幕");
    }

    /** 关闭字幕编辑器 */
    private void closeCaptionEditor() {
        captionEditorGap = -1;
        if (vbCaptionEditor != null) {
            vbCaptionEditor.setVisible(false);
            vbCaptionEditor.setManaged(false);
        }
    }

    /** 把字幕内容回显到编辑器控件（isUpdating 防回写） */
    private void loadCaptionEditor(GapCaption c) {
        isUpdating = true;
        try {
            tfCapLine1.setText(c.getTextContent());
            tfCapLine2.setText(c.getTextContent2());
            slCapSize1.setValue(clamp(c.getFontSize(), 8, 200));
            slCapSize2.setValue(clamp(c.getFontSize2(), 8, 200));
            lblCapSize1.setText(String.valueOf((int) Math.round(clamp(c.getFontSize(), 8, 200))));
            lblCapSize2.setText(String.valueOf((int) Math.round(clamp(c.getFontSize2(), 8, 200))));
            cbCapFont1.setValue(c.getFontFamily() != null ? c.getFontFamily() : "Microsoft YaHei");
            cbCapFont2.setValue(c.getFontFamily2() != null ? c.getFontFamily2() : "Microsoft YaHei");
            try {
                cpCapColor.setValue(javafx.scene.paint.Color.web(c.getColorHex()));
            } catch (Exception ignored) {}
            cbCapBgBar.setSelected(c.isBgBar());
            slCapSpacing.setValue(clamp(c.getLineSpacing() * 100, 0, 300));
        } finally {
            isUpdating = false;
        }
    }

    /** 编辑器控件 → 当前字幕（内容变化即实时渲染） */
    private void applyCaptionEditor() {
        if (isUpdating || captionEditorGap < 0) return;
        GapCaption c = currentGapCaption();
        if (c == null) return;
        c.setTextContent(tfCapLine1.getText() == null ? "" : tfCapLine1.getText().trim());
        c.setTextContent2(tfCapLine2.getText() == null ? "" : tfCapLine2.getText().trim());
        c.setFontSize(slCapSize1.getValue());
        c.setFontSize2(slCapSize2.getValue());
        if (cbCapFont1.getValue() != null) c.setFontFamily(cbCapFont1.getValue());
        if (cbCapFont2.getValue() != null) c.setFontFamily2(cbCapFont2.getValue());
        c.setColorHex(toHex(cpCapColor.getValue()));
        c.setBgBar(cbCapBgBar.isSelected());
        c.setLineSpacing(Math.max(0, slCapSpacing.getValue()) / 100.0);
        schedulePuzzleRender();
    }

    /** 间隙下拉框：列出当前布局所有分割间隙，已绑定字幕的标记 ● */
    private void refreshGapPicker() {
        if (cbPuzzleGapPick == null || template == null) return;
        PuzzlrConfig pc = template.getPuzzlrConfig();
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        javafx.collections.ObservableList<String> items = FXCollections.observableArrayList();
        for (int i = 0; i < axes.length; i++) {
            String gid = (axes[i][0] == 0 ? "V" : "H") + i;
            boolean bound = false;
            for (GapCaption c : pc.getGapCaptions()) {
                if (gid.equals(c.getGapId())) { bound = true; break; }
            }
            items.add((axes[i][0] == 0 ? "竖向间隙 " : "横向间隙 ") + (i + 1)
                    + (axes[i][0] == 0 ? "（左右格之间）" : "（上下格之间）") + (bound ? " ●" : ""));
        }
        int sel = cbPuzzleGapPick.getSelectionModel().getSelectedIndex();
        cbPuzzleGapPick.setItems(items);
        if (sel >= 0 && sel < items.size()) cbPuzzleGapPick.getSelectionModel().select(sel);
    }

    /** 添加/编辑字幕按钮：对当前选中的间隙创建或进入编辑 */
    /** 布局切换后清理：绑定的分割轴已不存在的字幕自动删除 */
    private void pruneGapCaptions(PuzzlrConfig pc) {
        int[][] axes = PuzzlrConfig.axesOf(pc.getLayoutType());
        pc.getGapCaptions().removeIf(c -> com.qingframe.core.PuzzlrRenderer.gapAxisOf(c.getGapId(), axes) == null);
        if (captionEditorGap >= 0 && currentGapCaption() == null) closeCaptionEditor();
        refreshGapPicker();
    }

    /** 交换两格内容：图片路径 + 偏移/缩放/填充参数整体互换 */
    private void swapPuzzleSlots(int a, int b) {
        List<SlotConfig> slots = template.getPuzzlrConfig().getSlots();
        if (a < 0 || b < 0 || a >= slots.size() || b >= slots.size() || a == b) return;
        SlotConfig sa = slots.get(a), sb = slots.get(b);
        String p = sa.getImagePath(); sa.setImagePath(sb.getImagePath()); sb.setImagePath(p);
        double ox = sa.getOffsetX(); sa.setOffsetX(sb.getOffsetX()); sb.setOffsetX(ox);
        double oy = sa.getOffsetY(); sa.setOffsetY(sb.getOffsetY()); sb.setOffsetY(oy);
        double z = sa.getZoom(); sa.setZoom(sb.getZoom()); sb.setZoom(z);
        int f = sa.getFillMode(); sa.setFillMode(sb.getFillMode()); sb.setFillMode(f);
    }

    /** 点击格子换图 */
    private void choosePuzzleImage(int si) {
        javafx.stage.FileChooser fc = new javafx.stage.FileChooser();
        fc.setTitle("选择拼图照片（格子 " + (si + 1) + "）");
        fc.getExtensionFilters().add(new javafx.stage.FileChooser.ExtensionFilter(
                "图片", "*.jpg", "*.jpeg", "*.png", "*.bmp", "*.webp"));
        File lastDir = getLastExportDir();
        if (lastDir != null) fc.setInitialDirectory(lastDir);
        File f = fc.showOpenDialog(previewCanvas.getScene().getWindow());
        if (f != null) {
            template.getPuzzlrConfig().getSlots().get(si).setImagePath(f.getAbsolutePath());
            saveLastOpenDir(f.getParentFile());
            statusLabel.setText("已放入拼图: " + f.getName());
            schedulePuzzleRender();
        }
    }

    @FXML
    private void onSaveImage() {
        if (isExporting) return;
        // 拼图模式：只导出当前拼图合成图
        if (puzzleMode && "PUZZLE".equals(template.getPhotoFrameStyle())) {
            exportCurrentPuzzle();
            return;
        }
        // 统一导出逻辑：优先导出胶片条中选中的图片，否则导出当前打开的所有图片（一张或多张均可）
        List<File> files = new ArrayList<>();
        if (!selectedIndices.isEmpty()) {
            for (int idx : selectedIndices) {
                if (idx >= 0 && idx < imageFiles.size()) files.add(imageFiles.get(idx));
            }
        } else {
            files.addAll(imageFiles);
        }
        // 没有任何打开图片：回退到原"批量导出"的文件夹批量能力
        if (files.isEmpty()) {
            chooseFolderAndExport();
            return;
        }
        // 选择导出目录（自动编号，保证不重复；一张或多张走同一逻辑）
        javafx.stage.DirectoryChooser dc = new javafx.stage.DirectoryChooser();
        dc.setTitle("选择导出目录");
        File lastDir = getLastExportDir();
        if (lastDir != null) dc.setInitialDirectory(lastDir);
        File exportDir = dc.showDialog(btnSaveImage.getScene().getWindow());
        if (exportDir == null) return;
        saveLastExportDir(exportDir);

        syncModelFromUI();
        isExporting = true;
        setExportUI(true);
        progressBar.setVisible(true);
        progressBar.setProgress(0);
        statusLabel.setText("准备导出 " + files.size() + " 张图片…");

        String fmt = cbExportFormat.getValue();
        exportImagesInParallel(files, exportDir, fmt, 0.95f);
    }

    /** 拼图导出：只导出当前拼图合成（长边 4000） */
    private void exportCurrentPuzzle() {
        if (isExporting) return;
        javafx.stage.DirectoryChooser dc = new javafx.stage.DirectoryChooser();
        dc.setTitle("选择导出目录");
        File lastDir = getLastExportDir();
        if (lastDir != null) dc.setInitialDirectory(lastDir);
        File exportDir = dc.showDialog(btnSaveImage.getScene().getWindow());
        if (exportDir == null) return;
        saveLastExportDir(exportDir);
        isExporting = true;
        setExportUI(true);
        progressBar.setVisible(true);
        progressBar.setProgress(-1);
        statusLabel.setText("正在导出拼图…");
        String fmt = cbExportFormat.getValue();
        String ext = "PNG".equalsIgnoreCase(fmt) ? "png" : "jpg";
        File out = new File(exportDir, "puzzle_" + System.currentTimeMillis() + "." + ext);
        // 后台线程合成大图，避免阻塞 UI
        javafx.concurrent.Task<BufferedImage> task = new javafx.concurrent.Task<>() {
            @Override
            protected BufferedImage call() {
                return renderPuzzleImage(4000);
            }
        };
        task.setOnSucceeded(e -> {
            try {
                BufferedImage outImg = task.getValue();
                if (outImg == null) throw new IOException("拼图渲染失败");
                ImageExportUtil.export(SwingFXUtils.toFXImage(outImg, null), out.getAbsolutePath(), fmt, 0.95f);
                statusLabel.setText("拼图已导出: " + out.getName());
            } catch (Exception ex) {
                statusLabel.setText("拼图导出失败: " + ex.getMessage());
                logExport("拼图导出失败: " + ex.getMessage());
            } finally {
                isExporting = false;
                setExportUI(false);
                progressBar.setVisible(false);
            }
        });
        task.setOnFailed(e -> {
            Throwable ex = task.getException();
            String msg = ex != null ? ex.getMessage() : "未知错误";
            statusLabel.setText("拼图导出失败: " + msg);
            logExport("拼图导出失败: " + msg);
            isExporting = false;
            setExportUI(false);
            progressBar.setVisible(false);
        });
        new Thread(task, "puzzle-export").start();
    }

    /** 原"批量导出"的文件夹批量能力：没有打开图片时，选择任意文件夹统一套用当前边框导出 */
    private void chooseFolderAndExport() {
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

        syncModelFromUI();
        isExporting = true;
        setExportUI(true);
        progressBar.setVisible(true);
        progressBar.setProgress(0);

        String fmt = cbExportFormat.getValue();
        List<File> files = new ArrayList<>();
        for (String p : images) files.add(new File(p));
        exportImagesInParallel(files, exportDir, fmt, 0.95f);
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

    /** 字体名归一化：忽略大小写与空格/连字符/下划线，用于精选字体与系统字体匹配 */
    private static String normFontName(String name) {
        return name.toLowerCase(java.util.Locale.ROOT).replace(" ", "").replace("-", "").replace("_", "");
    }

    /** 参数位置中文名 → WatermarkRender 枚举 */
    private static WatermarkRender.Position positionOf(String label) {
        if (label == null) return WatermarkRender.Position.CENTER;
        return switch (label) {
            case "居左" -> WatermarkRender.Position.LEFT;
            case "居右" -> WatermarkRender.Position.RIGHT;
            case "分列" -> WatermarkRender.Position.SPLIT;
            default -> WatermarkRender.Position.CENTER;
        };
    }

    @FXML
    private void onAddTextLine() {
        String text = tfCustomText.getText();
        if (text == null || text.trim().isEmpty()) return;
        if (liveTextLine == null) syncLiveTextLine();
        if (liveTextLine == null) return;
        // 把实时预览草稿固化为正式文字行（拖动过保持自由坐标，未拖动过保持底部对齐）
        if ("live".equals(liveTextLine.getAlign())) liveTextLine.setAlign("bottom");
        liveTextLine.setText(text.trim());
        liveTextLine.setFontSize(slTextSize.getValue());
        liveTextLine.setColorHex(toHex(cpTextColor.getValue()));
        if (cbTextFont.getValue() != null) liveTextLine.setFontFamily(cbTextFont.getValue());
        liveTextLine = null;
        selectedTextLine = null;
        engine.setSelectedTextLine(null);
        tfCustomText.clear();
        onSettingChanged();
    }

    /** 把输入框内容同步为画布上的实时预览文字行（空文本则移除草稿行） */
    private void syncLiveTextLine() {
        if (template == null || template.getDecorConfig() == null) return;
        String text = tfCustomText.getText() == null ? "" : tfCustomText.getText().trim();
        List<TextStickerConfig.TextLine> lines = template.getDecorConfig().getTextLines();
        if (liveTextLine != null && !lines.contains(liveTextLine)) {
            liveTextLine = null;
            if (selectedTextLine != null && !lines.contains(selectedTextLine)) {
                selectedTextLine = null;
                engine.setSelectedTextLine(null);
            }
        }
        if (text.isEmpty()) {
            if (liveTextLine != null) {
                lines.remove(liveTextLine);
                if (selectedTextLine == liveTextLine) {
                    selectedTextLine = null;
                    engine.setSelectedTextLine(null);
                }
                liveTextLine = null;
            }
            return;
        }
        if (liveTextLine == null) {
            liveTextLine = new TextStickerConfig.TextLine();
            liveTextLine.setAlign("live");
            lines.add(liveTextLine);
        }
        liveTextLine.setText(text);
        selectTextLine(liveTextLine);
    }

    /** 字号/颜色/字体改动：应用到正在输入的草稿行；无草稿时应用到选中的文字行 */
    private void applyTextStyleToCurrent() {
        TextStickerConfig.TextLine target = liveTextLine != null ? liveTextLine : selectedTextLine;
        if (target == null) return;
        target.setFontSize(slTextSize.getValue());
        target.setColorHex(toHex(cpTextColor.getValue()));
        if (cbTextFont.getValue() != null) target.setFontFamily(cbTextFont.getValue());
        renderPreview();
    }

    /** 选中画布上的文字行（蓝色虚线框），并让字号/颜色/字体控件回显当前值 */
    private void selectTextLine(TextStickerConfig.TextLine line) {
        if (line != null) {
            selectedIcon = null;
            selectedSticker = null;
            selectedKind = ElementKind.TEXT;
            engine.setSelectedSticker(null);
            slActiveIconOpacity.setValue(line.getOpacity());
            slElementRotation.setValue(line.getRotation());
        }
        selectedTextLine = line;
        engine.setSelectedTextLine(line);
        IconManager.setSelected(null);
        if (line != null) {
            slTextSize.setValue(Math.max(8, Math.min(200, line.getFontSize())));
            try {
                cpTextColor.setValue(javafx.scene.paint.Color.web(line.getColorHex()));
            } catch (Exception ignored) {}
            if (line.getFontFamily() != null) cbTextFont.setValue(line.getFontFamily());
        }
    }

    @FXML
    private void onDeleteSelectedTextLine() {
        if (selectedKind != ElementKind.TEXT) {
            onDeleteActiveElement();
            return;
        }
        if (selectedTextLine == null) return;
        if (template.getDecorConfig() != null) {
            template.getDecorConfig().getTextLines().remove(selectedTextLine);
        }
        if (liveTextLine == selectedTextLine) liveTextLine = null;
        selectedTextLine = null;
        engine.setSelectedTextLine(null);
        renderPreview();
    }

    @FXML
    private void onAddSticker() {
        FileChooser fc = new FileChooser();
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("贴纸图片", "*.png", "*.jpg", "*.jpeg"));
        File file = fc.showOpenDialog(previewCanvas.getScene().getWindow());
        if (file != null) {
            TextStickerConfig.Sticker sticker = new TextStickerConfig.Sticker();
            sticker.setSrc(file.toURI().toString());
            if (template.getDecorConfig() == null) {
                template.setDecorConfig(new TextStickerConfig());
            }
            if (originImage != null) {
                double[] cs = engine.computeCanvasSize(originImage, template);
                sticker.setX(cs[0] / 2);
                sticker.setY(cs[1] / 2);
                // 自动适配画布大小，保证加入后完整可见、四角标记在画布内
                Image simg = ImageCache.get(sticker.getSrc());
                if (simg != null && simg.getWidth() > 0) {
                    double fit = cs[0] * 0.25 / Math.max(simg.getWidth(), simg.getHeight());
                    sticker.setScale(Math.max(0.02, Math.min(3.0, fit)));
                }
            } else {
                // 未加载照片：按预览视图中心换算到模板坐标，保证贴纸落在可见区域
                double[] tc = previewToTemplate(previewCanvas.getWidth() / 2, previewCanvas.getHeight() / 2);
                sticker.setX(tc[0]);
                sticker.setY(tc[1]);
            }
            template.getDecorConfig().getStickers().add(sticker);
            selectSticker(sticker);
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
        // 与左侧栏边框按钮效果重复的预设，不再列入右侧内置预设列表
        // （JSON 文件保留，左侧按钮仍可加载；仅从右侧列表移除，避免双入口同效果）
        Set<String> duplicateWithSidebar = Set.of(
                "拍立得",
                "浮影白框", "小红书3比4封面", "IG渐变光环",
                "醒图奶油风", "Canva错位拼贴", "NOMO复古相机", "苹果深色圆角卡",
                "波普漫画风", "极光渐变", "杂志大刊头", "暗夜星空", "复古登机牌", "金箔奢华");
        List<String> list = new ArrayList<>(List.of("复古胶片", "证件照"));
        for (String name : scanResourceDir("com/qingframe/presets")) {
            if (!duplicateWithSidebar.contains(name) && !list.contains(name)) list.add(name);
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

    /** 扫描 classpath 指定目录下的图片文件（纹理等，兼容开发目录与打包后 jar） */
    private List<String> scanImageResourceDir(String path) {
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
                            String n = f.getName().toLowerCase();
                            if (n.endsWith(".png") || n.endsWith(".jpg") || n.endsWith(".jpeg")) {
                                names.add(f.getName());
                            }
                        }
                    }
                } else if ("jar".equals(u.getProtocol())) {
                    try (java.util.jar.JarFile jar = ((java.net.JarURLConnection) u.openConnection()).getJarFile()) {
                        jar.stream()
                                .filter(e -> e.getName().startsWith(path + "/")
                                        && (e.getName().endsWith(".png") || e.getName().endsWith(".jpg")
                                            || e.getName().endsWith(".jpeg")))
                                .forEach(e -> names.add(e.getName().substring(path.length() + 1)));
                    }
                }
            }
        } catch (Exception ignored) {}
        Collections.sort(names);
        return names;
    }

    private TemplateModel loadPresetFromJson(String name) {
        try (InputStream in = getClass().getResourceAsStream("/com/qingframe/presets/" + name + ".json")) {
            if (in != null) {
                String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                return JsonUtil.fromJson(json);
            }
        } catch (Exception ignored) {
        }
        // 市场下载的模板：查 ~/.qingframe/market-presets 目录
        try {
            java.io.File f = new java.io.File(
                    System.getProperty("user.home"),
                    ".qingframe/market-presets/" + name + ".json");
            if (f.isFile()) {
                return JsonUtil.loadFromFile(f.getAbsolutePath());
            }
        } catch (Exception ignored) {
        }
        statusLabel.setText("预设加载失败: " + name + "（JSON 格式错误，已回退默认模板）");
        return null;
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
        statusLabel.setText("已生成随机边框，可再次点击继续随机，或点撤销返回");
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
        List<String> names = scanImageResourceDir("com/qingframe/textures");
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
    private void onToggleTheme() {
        isDarkTheme = !isDarkTheme;
        String css;
        if (isDarkTheme) {
            css = getClass().getResource("/com/qingframe/ui/css/dark-theme.css").toExternalForm();
            btnThemeToggle.setGraphic(createThemeIcon(false));
            btnThemeToggle.setTooltip(new Tooltip("当前：深色主题（点击切换浅色）"));
        } else {
            css = getClass().getResource("/com/qingframe/ui/css/light-theme.css").toExternalForm();
            btnThemeToggle.setGraphic(createThemeIcon(true));
            btnThemeToggle.setTooltip(new Tooltip("当前：浅色主题（点击切换深色）"));
        }
        rootPane.getStylesheets().clear();
        rootPane.getStylesheets().add(css);
    }

    /** 主题切换按钮图标：浅色模式显示太阳，深色模式显示月亮 */
    private javafx.scene.shape.SVGPath createThemeIcon(boolean light) {
        javafx.scene.shape.SVGPath p = new javafx.scene.shape.SVGPath();
        p.getStyleClass().add("ui-icon");
        p.setContent(light
                ? "M12 4V2 M12 22v-2 M5 12H3 M21 12h-2 M6.3 6.3L4.9 4.9 M19.1 19.1l-1.4-1.4 M17.7 6.3l1.4-1.4 M4.9 19.1l1.4-1.4 M12 17m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0"
                : "M20 13A8 8 0 1 1 11 3a6 6 0 0 0 9 10z");
        return p;
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

        // 拼图模式：样式仍为 PUZZLE 则渲染拼图；点普通预设后样式变化即自动退出
        if (puzzleMode && "PUZZLE".equals(template.getPhotoFrameStyle())) {
            schedulePuzzleRender();
            return;
        } else if (puzzleMode) {
            puzzleMode = false;
            closeCaptionEditor();
            puzzlePreviewView.setVisible(false);
            if (puzzleOverlay != null) {
                puzzleOverlay.getChildren().clear();
                puzzleOverlay.setVisible(false);
            }
            previewCanvas.setVisible(true);
            // 退出拼图：顶部缩放控件恢复普通画布缩放
            syncTopZoomUI(zoomValue);
            // Canvas 由隐藏恢复可见后纹理缓冲需重建，延迟一帧再绘制，
            // 避免渲染缓冲未就绪时触发 NGCanvas RTTexture NPE
            Platform.runLater(this::refreshView);
            return;
        }

        GraphicsContext gc = previewCanvas.getGraphicsContext2D();
        try {
            double zoom = getZoom();
            boolean compare = template.getCompareMode() == 1;

            gc.setFill(Color.rgb(200, 200, 200));
            gc.fillRect(0, 0, cw, ch);

            if (panX != 0 || panY != 0) {
                // 平移范围：放大后随倍数增大；100% 时保留窗口 25% 的活动空间，方便自由查看
                double prangeX = cw * (Math.max(1.0, zoom) - 1) / 2 + cw * 0.25;
                double prangeY = ch * (Math.max(1.0, zoom) - 1) / 2 + ch * 0.25;
                panX = clamp(panX, -prangeX, prangeX);
                panY = clamp(panY, -prangeY, prangeY);
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
            double[] csSize = engine.computeCanvasSize(originImage.getWidth(), originImage.getHeight(), template);
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

    private void updateScrollBars(double cw, double ch) {
        double zoom = getZoom();
        // 加载照片后滚动条始终可见：100% 时也有少量活动空间，放大后可拖动查看细节
        boolean visible = originImage != null;
        hScrollBar.setVisible(visible);
        vScrollBar.setVisible(visible);
        if (visible) {
            double prangeX = cw * (Math.max(1.0, zoom) - 1) / 2 + cw * 0.25;
            double prangeY = ch * (Math.max(1.0, zoom) - 1) / 2 + ch * 0.25;
if (template.getCompareMode() == 1 && originImage != null) {
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
            case "圆角边框":
                t.getBaseMargin().setMarginTop(60);
                t.getBaseMargin().setMarginBottom(60);
                t.getBaseMargin().setMarginLeft(60);
                t.getBaseMargin().setMarginRight(60);
                t.getBaseMargin().setImgScale(0.95);
                // 普通边框渲染读取各角字段，必须与 all 一致才会真正生效
                t.getCornerConfig().setCornerRadiusAll(250);
                t.getCornerConfig().setCornerRadiusTL(250);
                t.getCornerConfig().setCornerRadiusTR(250);
                t.getCornerConfig().setCornerRadiusBL(250);
                t.getCornerConfig().setCornerRadiusBR(250);
                t.getLayerList().get(0).getFillConfig().setFillHex("#ffffff");
                // 不要四周细线：关闭描边
                t.getLayerList().get(0).getStrokeConfig().setStrokeWidth(0);
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
                // 经典 135 胶片底片风：宽黑轨道 + 方形齿孔 + 胶片名 + 旧化质感
                t.getBaseMargin().setMarginTop(300);
                t.getBaseMargin().setMarginBottom(300);
                t.getBaseMargin().setMarginLeft(90);
                t.getBaseMargin().setMarginRight(90);
                t.getBaseMargin().setImgScale(0.95);
                t.getLayerList().get(0).getFillConfig().setFillHex("#141414");
                t.getLayerList().get(0).getStrokeConfig().setStrokeWidth(0);
                t.getCornerConfig().setCornerRadiusAll(0);
                t.getCornerConfig().setCornerRadiusTL(0);
                t.getCornerConfig().setCornerRadiusTR(0);
                t.getCornerConfig().setCornerRadiusBL(0);
                t.getCornerConfig().setCornerRadiusBR(0);
                t.getFilmTearConfig().setFilmPerforationEnable(1);
                t.getFilmTearConfig().setFilmPerforationType("hstrip");
                t.getFilmTearConfig().setFilmPerforationSize(20);
                t.getFilmTearConfig().setFilmPerforationSpacing(40);
                t.getDecorConfig().setExifAutoText(1);
                t.getDecorConfig().getTextLines().clear();
                // 顶部胶片名：显示在上方轨道齿孔下方（勾选“显示参数水印”后底部会追加真实 EXIF 参数）
                TextStickerConfig.TextLine filmName = new TextStickerConfig.TextLine();
                filmName.setText("35MM FILM  ·  36 EXP");
                filmName.setAlign("top");
                filmName.setY(60);
                filmName.setColorHex("#ffffff");
                filmName.setFontSize(15);
                filmName.setLetterSpacing(3);
                t.getDecorConfig().getTextLines().add(filmName);
                // 旧化质感：泛黄 + 灰尘划痕 + 颗粒 + 暗角
                t.getFilmTearConfig().setYellowingEnable(1);
                t.getFilmTearConfig().setYellowingStrength(15);
                t.getFilmTearConfig().setDustScratchEnable(1);
                t.getFilmTearConfig().setDustScratchIntensity(8);
                t.getLightEffect().setFilmGrainEnable(1);
                t.getLightEffect().setFilmGrainIntensity(12);
                t.getLightEffect().setVignetteEnable(1);
                t.getLightEffect().setVignetteStrength(30);
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
        // 统一 sRGB：原图带非 sRGB ICC（如 AdobeRGB）时读入即转换，保证导出色彩空间与原图解释一致
        awtImg = toSRGB(awtImg);
        // 基础边框的 EXIF 参数行：同步边框只同步效果，参数行用本图 EXIF 重建
        TemplateModel renderTmpl = tmpl;
        if (tmpl.getDecorConfig() != null && tmpl.getDecorConfig().getExifAutoText() == 1) {
            String exifText = ExifTextParser.formatExifText(
                    ExifTextParser.readExif(src.getAbsolutePath()), "");
            if (!exifText.isEmpty()) {
                renderTmpl = cloneTemplate(tmpl);
                List<TextStickerConfig.TextLine> lines = renderTmpl.getDecorConfig().getTextLines();
                lines.removeIf(MainController::isAutoExifLine);
                TextStickerConfig.TextLine line = new TextStickerConfig.TextLine();
                line.setText(exifText);
                line.setAlign("exif");
                int fs = renderTmpl.getParamFontSize();
                line.setFontSize(fs > 0 ? fs : 16);
                lines.add(line);
            }
        }
        WritableImage result;
        // 相机参数文字必须由每张图片自己的 EXIF 决定；同步边框只同步边框效果。
        // 加锁保证批量导出并发时 EXIF/渲染参数不互相串扰。
        synchronized (BorderProcessor.class) {
            ExifReader.ExifData prevExif = BorderProcessor.getCurrentExif();
            BorderProcessor.setExifData(exif);
            try {
                result = renderAwtWithFallback(awtImg, renderTmpl);
            } finally {
                BorderProcessor.setExifData(prevExif);
            }
        }
        if (result == null) {
            throw new IOException(String.format("渲染结果异常（接近空白），且自动缩放后仍失败：照片 %dx%d",
                    awtImg.getWidth(), awtImg.getHeight()));
        }
        return result;
    }

    /** 导出渲染：原画质优先（与预览一致），内存不足/空白时自动逐级降级，保证稳定输出 */
    private WritableImage renderAwtWithFallback(BufferedImage awt, TemplateModel tmpl) throws Exception {
        logExport("原始尺寸: " + awt.getWidth() + "x" + awt.getHeight());
        // 原画质优先：直接用原图全尺寸渲染，边框/文字比例与预览完全一致
        // （应用已固定使用软件渲染管线，不受 D3D 大图分块渲染崩溃影响）
        WritableImage r = renderQuietly(awt, awt, tmpl);
        boolean firstBlank = r == null || ImageExportUtil.looksBlank(r);
        logExport("原画质渲染 " + awt.getWidth() + "x" + awt.getHeight() + " 空白=" + firstBlank);
        if (!firstBlank) return r;

        // 原画质失败（内存不足/空白）→ 逐级降级渲染
        BufferedImage cur = awt;
        int[] edges = {EXPORT_SAFE_EDGE, 1800, 1200};
        for (int edge : edges) {
            // 跳过不小于当前尺寸的档位，继续尝试更小档（小图原画质失败时仍能逐级降级）
            if (Math.max(cur.getWidth(), cur.getHeight()) <= edge) continue;
            BufferedImage scaled = downscaleAwtToMaxEdge(cur, edge);
            if (scaled == cur) continue;
            cur = scaled;
            r = renderQuietly(cur, awt, scaleTemplateForExport(tmpl, (double) cur.getWidth() / awt.getWidth()));
            boolean blank = r == null || ImageExportUtil.looksBlank(r);
            logExport("降级长边 " + edge + "(" + cur.getWidth() + "x" + cur.getHeight() + ") 渲染空白=" + blank);
            if (!blank) return r;
        }
        return null;
    }

    /** 渲染并吞掉内存不足/异常，返回 null 表示失败（由调用方走降级） */
    private WritableImage renderQuietly(BufferedImage renderImg, BufferedImage origImg, TemplateModel tmpl) {
        try {
            return renderAwtScaledWithStatic(renderImg, origImg, tmpl);
        } catch (OutOfMemoryError e) {
            System.gc();
            logExport("内存不足，自动降级: " + e.getMessage());
            return null;
        } catch (Exception e) {
            logExport("渲染异常，自动降级: " + e.getMessage());
            return null;
        }
    }

    /** 渲染前从模板应用相框静态参数并按比例缩放像素参数（圆角/EXIF 字号），渲染后恢复，保证降级导出与预览比例一致、每图独立 */
    private WritableImage renderAwtScaledWithStatic(BufferedImage renderImg, BufferedImage origImg, TemplateModel tmpl)
            throws Exception {
        double s = (double) renderImg.getWidth() / origImg.getWidth();
        int origCorner = BorderProcessor.getCornerRadius();
        int origExif = BorderProcessor.getExifFontSize();
        int origBlur = BorderProcessor.getBlurIntensity();
        int origType = BorderProcessor.getParamType();
        WatermarkRender.Position origPos = WatermarkRender.getPosition();
        double origBlurScale = BorderProcessor.getBlurScale();
        BorderEngine.applyTemplateStaticParams(tmpl);
        if (s != 1.0) {
            BorderProcessor.setCornerRadius(Math.max(0, (int) Math.round(BorderProcessor.getCornerRadius() * s)));
            // 字号下限只保留可渲染的最小值：固定 8px 会让小字号在降级导出时相对照片偏大
            BorderProcessor.setExifFontSize(Math.max(2, (int) Math.round(BorderProcessor.getExifFontSize() * s)));
            BorderProcessor.setBlurScale(s);
        }
        try {
            return renderAwtScaled(renderImg, origImg, tmpl);
        } finally {
            BorderProcessor.setCornerRadius(origCorner);
            BorderProcessor.setExifFontSize(origExif);
            BorderProcessor.setBlurIntensity(origBlur);
            BorderProcessor.setParamType(origType);
            WatermarkRender.setPosition(origPos);
            BorderProcessor.setBlurScale(origBlurScale);
        }
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
        for (TextStickerConfig.Sticker sticker : dec.getStickers()) {
            sticker.setX(sticker.getX() * s);
            sticker.setY(sticker.getY() * s);
            sticker.setScale(sticker.getScale() * s);
            sticker.setRotation(sticker.getRotation());
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

    /** 导出诊断日志：写入用户目录 QingFrameShadow-export.log，用于定位导出失败原因；超过上限自动清空防止无限增长 */
    private static final int EXPORT_LOG_MAX_BYTES = 2 * 1024 * 1024;

    /** 模板指纹摘要：用于诊断"同图重复点击效果漂移"（边距/图层/文字行/参数类型/比较模式等关键差异） */
    private String templateFingerprint(TemplateModel t) {
        if (t == null) return "null";
        BaseMargin m = t.getBaseMargin();
        StringBuilder sb = new StringBuilder();
        sb.append("pf=").append(t.getPhotoFrameStyle());
        sb.append(" pt=").append(t.getParamType()).append(" pos=").append(t.getParamPosition());
        sb.append(" cmp=").append(t.getCompareMode()).append(" ratio=").append(t.getCanvasRatio());
        sb.append(" M=").append(m.getMarginTop()).append('/').append(m.getMarginBottom()).append('/')
                .append(m.getMarginLeft()).append('/').append(m.getMarginRight())
                .append(" scale=").append(String.format("%.3f", m.getImgScale()));
        sb.append(" bgblur=").append(m.getBgBlurEnable()).append('/').append(m.getBgBlurRadius());
        for (LayerBorder l : t.getLayerList()) {
            FillConfig f = l.getFillConfig();
            sb.append(" [").append(l.getMarginTop()).append('/').append(l.getMarginBottom()).append('/')
                    .append(l.getMarginLeft()).append('/').append(l.getMarginRight()).append(' ')
                    .append(f.getFillType()).append(' ').append(f.getFillHex()).append(']');
        }
        sb.append(" txt=").append(t.getDecorConfig() != null && t.getDecorConfig().getTextLines() != null
                ? t.getDecorConfig().getTextLines().size() : -1);
        return sb.toString();
    }

    private void logExport(String msg) {
        try {
            java.io.File logFile = new java.io.File(
                    System.getProperty("user.home") + "/QingFrameShadow-export.log");
            if (logFile.length() > EXPORT_LOG_MAX_BYTES) {
                logFile.delete();
            }
            java.io.FileWriter fw = new java.io.FileWriter(logFile, true);
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
        // 超时保护：FX 线程被阻塞/退出时避免导出线程永久挂死
        if (!latch.await(15, TimeUnit.SECONDS)) {
            throw new IOException("渲染超时：界面线程未响应");
        }
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
    /** 按 EXIF 方向旋转 JavaFX 预览图（与导出/缩略图的 AWT applyOrientation 等效），需在 FX 线程调用 */
    /**
     * 按 EXIF 方向旋转 JavaFX 预览图（与导出/缩略图的 AWT applyOrientation 等效）。
     * 用纯 AWT 实现而非 Canvas.snapshot：大尺寸照片的 Canvas 离屏纹理会大幅占用 GPU 显存，
     * 叠加导出时的纹理分配容易触发 D3D 设备超时（TDR）导致"全部导出报错"。
     */
    private Image rotateFxImage(Image src, int orientation) {
        if (src == null || orientation <= 1) return src;
        int sw = (int) src.getWidth();
        int sh = (int) src.getHeight();
        boolean swap = orientation == 6 || orientation == 8;
        int outW = swap ? sh : sw;
        int outH = swap ? sw : sh;
        BufferedImage in = SwingFXUtils.fromFXImage(src, null);
        BufferedImage out = new BufferedImage(outW, outH, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = out.createGraphics();
        switch (orientation) {
            case 3 -> { g.translate(outW, outH); g.rotate(Math.toRadians(180)); }
            case 6 -> { g.translate(outW, 0); g.rotate(Math.toRadians(90)); }
            case 8 -> { g.translate(0, outH); g.rotate(Math.toRadians(-90)); }
            default -> { g.dispose(); return src; }
        }
        g.drawImage(in, 0, 0, null);
        g.dispose();
        return SwingFXUtils.toFXImage(out, null);
    }

    /** 非 sRGB 色彩空间的图转换到 sRGB；已是 sRGB 或无 ICC 的图原样返回（转换失败也回退原图） */
    private BufferedImage toSRGB(BufferedImage img) {
        try {
            java.awt.color.ColorSpace cs = img.getColorModel().getColorSpace();
            if (cs.getType() != java.awt.color.ColorSpace.TYPE_RGB) return img;
            if (cs instanceof java.awt.color.ICC_ColorSpace) {
                byte[] srcData = ((java.awt.color.ICC_ColorSpace) cs).getProfile().getData();
                if (java.util.Arrays.equals(srcData,
                        java.awt.color.ICC_Profile.getInstance(java.awt.color.ColorSpace.CS_sRGB).getData())) {
                    return img;
                }
                java.awt.image.ColorConvertOp op = new java.awt.image.ColorConvertOp(
                        cs, java.awt.color.ColorSpace.getInstance(java.awt.color.ColorSpace.CS_sRGB), null);
                BufferedImage out = new BufferedImage(img.getWidth(), img.getHeight(), BufferedImage.TYPE_INT_ARGB);
                return op.filter(img, out);
            }
        } catch (Exception ignored) {
        }
        return img;
    }

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
            // 缩略图只需 1280 长边：用降采样解码替代全尺寸解码，大图耗时从秒级降到几十毫秒
            BufferedImage awtImg = decodePuzzleScaled(file, THUMB_MAX_DIM, true);
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
            if (!latch.await(15, TimeUnit.SECONDS)) return null;
            if (result[0] != null) {
                if (thumbCache.size() >= THUMB_CACHE_MAX) {
                    // 淘汰约一半而不是全部清空，避免大图库瞬间集体重新解码
                    int toRemove = thumbCache.size() / 2;
                    java.util.Iterator<File> it = thumbCache.keySet().iterator();
                    while (toRemove-- > 0 && it.hasNext()) {
                        it.next();
                        it.remove();
                    }
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
                btn.getStyleClass().add("icon-pick-btn");
                String logoUrl = brandLogoUrl(brand);
                if (logoUrl != null) {
                    ImageView iv = new ImageView(new Image(logoUrl, true));
                    iv.setFitWidth(68);
                    iv.setFitHeight(32);
                    iv.setPreserveRatio(true);
                    btn.setGraphic(iv);
                } else {
                    btn.setText(brand);
                    btn.setStyle("-fx-font-size:10;");
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
            btn.getStyleClass().add("icon-pick-btn");
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
            btn.getStyleClass().add("icon-pick-btn");
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
        double zoom = getZoom();
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
        if (item != null) {
            selectedTextLine = null;
            selectedSticker = null;
            selectedKind = ElementKind.ICON;
            engine.setSelectedTextLine(null);
            engine.setSelectedSticker(null);
        }
        selectedIcon = item;
        IconManager.setSelected(item);
        if (item != null) {
            slActiveIconOpacity.setValue(item.getOpacity());
            slElementRotation.setValue(item.getRotation());
        }
    }

    /** 选中画布贴纸（蓝色虚线框），并同步透明度/旋转控件 */
    private void selectSticker(TextStickerConfig.Sticker sticker) {
        if (sticker != null) {
            selectedIcon = null;
            selectedTextLine = null;
            selectedKind = ElementKind.STICKER;
            engine.setSelectedTextLine(null);
            IconManager.setSelected(null);
            slActiveIconOpacity.setValue(sticker.getOpacity());
            slElementRotation.setValue(sticker.getRotation());
        }
        selectedSticker = sticker;
        engine.setSelectedSticker(sticker);
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
        onDeleteActiveElement();
    }

    /** 删除当前选中的画布元素（图标/贴纸/文字），未选中时无操作 */
    private void onDeleteActiveElement() {
        if (selectedKind == ElementKind.STICKER && selectedSticker != null) {
            if (template.getDecorConfig() != null) {
                template.getDecorConfig().getStickers().remove(selectedSticker);
            }
            selectedSticker = null;
            engine.setSelectedSticker(null);
            renderPreview();
            onSettingChanged();
        } else if (selectedKind == ElementKind.TEXT && selectedTextLine != null) {
            onDeleteSelectedTextLine();
        } else if (selectedIcon != null) {
            IconManager.removeFromCanvas(selectedIcon);
            selectCanvasIcon(null);
            renderPreview();
            onSettingChanged();
        }
    }

    /** 复制当前选中元素（仅内存） */
    @FXML
    private void onCopySelectedElement() {
        copySelectedElement();
    }

    private void copySelectedElement() {
        if (selectedKind == ElementKind.STICKER && selectedSticker != null) {
            clipSticker = selectedSticker.copy();
            clipTextLine = null;
            clipIcon = null;
            statusLabel.setText("已复制贴纸");
        } else if (selectedKind == ElementKind.TEXT && selectedTextLine != null && selectedTextLine != liveTextLine) {
            clipTextLine = selectedTextLine.copy();
            clipSticker = null;
            clipIcon = null;
            statusLabel.setText("已复制文字");
        } else if (selectedIcon != null) {
            clipIcon = selectedIcon.copy();
            clipTextLine = null;
            clipSticker = null;
            statusLabel.setText("已复制图标");
        }
    }

    /** 粘贴：在原元素位置偏移 24px 处创建副本并选中 */
    @FXML
    private void onPasteClipboardElement() {
        pasteClipboardElement();
    }

    private void pasteClipboardElement() {
        if (clipIcon != null) {
            IconItem c = clipIcon.copy();
            c.setX(clipIcon.getX() + 24);
            c.setY(clipIcon.getY() + 24);
            IconManager.addToCanvas(c);
            selectCanvasIcon(c);
            renderPreview();
            onSettingChanged();
        } else if (clipSticker != null) {
            TextStickerConfig.Sticker c = clipSticker.copy();
            c.setX(clipSticker.getX() + 24);
            c.setY(clipSticker.getY() + 24);
            template.getDecorConfig().getStickers().add(c);
            selectSticker(c);
            renderPreview();
            onSettingChanged();
        } else if (clipTextLine != null) {
            TextStickerConfig.TextLine c = clipTextLine.copy();
            c.setX(clipTextLine.getX() + 24);
            c.setY(clipTextLine.getY() + 24);
            c.setAlign("free");
            template.getDecorConfig().getTextLines().add(c);
            selectTextLine(c);
            renderPreview();
            onSettingChanged();
        }
    }

    /** 层级调整：置顶/置底/上移/下移（图标、贴纸、文字各自列表内重排） */
    @FXML
    private void onZOrderTop() { moveZOrder(1); }
    @FXML
    private void onZOrderBottom() { moveZOrder(-1); }
    @FXML
    private void onZOrderUp() { moveZOrder(2); }
    @FXML
    private void onZOrderDown() { moveZOrder(-2); }

    private void moveZOrder(int op) {
        boolean changed = false;
        if (selectedIcon != null) {
            java.util.List<IconItem> icons = IconManager.getActiveIcons();
            int idx = icons.indexOf(selectedIcon);
            if (idx >= 0) {
                icons.remove(idx);
                if (op == 1) {
                    icons.add(selectedIcon);
                } else if (op == -1) {
                    icons.add(0, selectedIcon);
                } else if (op == 2 && idx < icons.size()) {
                    icons.add(idx + 1, selectedIcon);
                } else if (op == -2 && idx > 0) {
                    icons.add(idx - 1, selectedIcon);
                }
                changed = true;
            }
        } else if (selectedKind == ElementKind.STICKER && selectedSticker != null && template.getDecorConfig() != null) {
            java.util.List<TextStickerConfig.Sticker> stickers = template.getDecorConfig().getStickers();
            int idx = stickers.indexOf(selectedSticker);
            if (idx >= 0) {
                stickers.remove(idx);
                if (op == 1) {
                    stickers.add(selectedSticker);
                } else if (op == -1) {
                    stickers.add(0, selectedSticker);
                } else if (op == 2 && idx < stickers.size()) {
                    stickers.add(idx + 1, selectedSticker);
                } else if (op == -2 && idx > 0) {
                    stickers.add(idx - 1, selectedSticker);
                }
                changed = true;
            }
        } else if (selectedKind == ElementKind.TEXT && selectedTextLine != null && template.getDecorConfig() != null) {
            java.util.List<TextStickerConfig.TextLine> lines = template.getDecorConfig().getTextLines();
            int idx = lines.indexOf(selectedTextLine);
            if (idx >= 0) {
                lines.remove(idx);
                if (op == 1) {
                    lines.add(selectedTextLine);
                } else if (op == -1) {
                    lines.add(0, selectedTextLine);
                } else if (op == 2 && idx < lines.size()) {
                    lines.add(idx + 1, selectedTextLine);
                } else if (op == -2 && idx > 0) {
                    lines.add(idx - 1, selectedTextLine);
                }
                changed = true;
            }
        }
        if (changed) {
            renderPreview();
            onSettingChanged();
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
    // Canvas interaction for custom text lines
    private TextStickerConfig.TextLine liveTextLine;
    private TextStickerConfig.TextLine selectedTextLine;
    private double textDragStartX, textDragStartY;
    private double textOrigX, textOrigY;
    private boolean draggingTextLine;
    // Canvas interaction for stickers
    private TextStickerConfig.Sticker selectedSticker;
    private double stickerDragStartX, stickerDragStartY;
    private double stickerOrigX, stickerOrigY;
    private boolean draggingSticker;
    // 贴纸选中框角点手柄拖拽缩放（围绕贴纸中心）
    private boolean resizingSticker;
    private double stickerResizeStartDist;
    private double stickerOrigScale;
    // 贴纸选中框顶部旋转手柄拖拽旋转（围绕贴纸中心）
    private boolean rotatingSticker;
    private double stickerRotStartAngle;
    private double stickerRotStartRotation;
    // 统一画布元素：当前选中的元素种类（用于删除/复制/层级/旋转/透明度）
    private enum ElementKind { TEXT, STICKER, ICON }
    private ElementKind selectedKind;
    // 剪贴板（复制/粘贴，仅元素坐标/样式，不落盘）
    private TextStickerConfig.TextLine clipTextLine;
    private TextStickerConfig.Sticker clipSticker;
    private IconItem clipIcon;

    private void setupCanvasIconInteraction() {
        previewCanvas.setOnMousePressed(e -> {
            if (e.isPrimaryButtonDown()) {
                double[] tc = previewToTemplate(e.getX(), e.getY());
                // 已选中贴纸：先检测旋转手柄（顶边圆点），再检测四角手柄（缩放），最后贴纸本体（移动）
                if (selectedSticker != null && isStickerRotateHandle(tc[0], tc[1], selectedSticker)) {
                    rotatingSticker = true;
                    stickerRotStartRotation = selectedSticker.getRotation();
                    stickerRotStartAngle = Math.toDegrees(Math.atan2(
                            tc[1] - selectedSticker.getY(), tc[0] - selectedSticker.getX()));
                    e.consume();
                    renderPreview();
                    return;
                }
                if (selectedSticker != null && isStickerHandle(tc[0], tc[1], selectedSticker)) {
                    resizingSticker = true;
                    stickerOrigScale = selectedSticker.getScale();
                    stickerResizeStartDist = Math.max(1,
                            Math.hypot(tc[0] - selectedSticker.getX(), tc[1] - selectedSticker.getY()));
                    e.consume();
                    renderPreview();
                    return;
                }
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
                TextStickerConfig.Sticker sHit = hitTestSticker(tc[0], tc[1]);
                if (sHit != null) {
                    selectSticker(sHit);
                    draggingSticker = true;
                    stickerDragStartX = tc[0];
                    stickerDragStartY = tc[1];
                    stickerOrigX = sHit.getX();
                    stickerOrigY = sHit.getY();
                    e.consume();
                    renderPreview();
                    return;
                }
                TextStickerConfig.TextLine tLine = hitTestTextLine(tc[0], tc[1]);
                if (tLine != null) {
                    selectTextLine(tLine);
                    draggingTextLine = true;
                    textDragStartX = tc[0];
                    textDragStartY = tc[1];
                    // 拖拽起点取文字行当前实际渲染位置（底部/顶部对齐行的 getX/getY 可能还是 0/未设置，
                    // 直接用原始坐标起拖会把文字甩到左上角）
                    double[] anchor = engine.textLineAnchor(tLine, originImage, template);
                    if (anchor != null) {
                        textOrigX = anchor[0];
                        textOrigY = anchor[1];
                    } else {
                        textOrigX = tLine.getX();
                        textOrigY = tLine.getY();
                    }
                    e.consume();
                    renderPreview();
                    return;
                }
                selectCanvasIcon(null);
                selectTextLine(null);
                selectSticker(null);
                // 未命中元素：按下即开始视图平移（抓手光标），任意缩放级别均可拖动
                previewCanvas.getScene().setCursor(javafx.scene.Cursor.CLOSED_HAND);
                dragStartX = e.getSceneX();
                dragStartY = e.getSceneY();
                if (!e.isAltDown() && !e.isControlDown()) {
                    draggingIcon = false;
                }
            }
        });
        previewCanvas.setOnMouseDragged(e -> {
            if (rotatingSticker && selectedSticker != null) {
                double[] tc = previewToTemplate(e.getX(), e.getY());
                double ang = Math.toDegrees(Math.atan2(
                        tc[1] - selectedSticker.getY(), tc[0] - selectedSticker.getX()));
                double rot = normalizeRotation(stickerRotStartRotation + (ang - stickerRotStartAngle));
                selectedSticker.setRotation(rot);
                slElementRotation.setValue(rot);
                renderPreview();
                e.consume();
            } else if (resizingSticker && selectedSticker != null) {
                double[] tc = previewToTemplate(e.getX(), e.getY());
                double dist = Math.hypot(tc[0] - selectedSticker.getX(), tc[1] - selectedSticker.getY());
                if (stickerResizeStartDist > 1 && dist > 1) {
                    double ns = Math.max(0.02, Math.min(5.0, stickerOrigScale * dist / stickerResizeStartDist));
                    selectedSticker.setScale(ns);
                    renderPreview();
                }
                e.consume();
            } else if (draggingTextLine && selectedTextLine != null) {
                double[] tc = previewToTemplate(e.getX(), e.getY());
                double dx = tc[0] - textDragStartX;
                double dy = tc[1] - textDragStartY;
                selectedTextLine.setX(textOrigX + dx);
                selectedTextLine.setY(textOrigY + dy);
                String align = selectedTextLine.getAlign();
                if ("bottom".equals(align) || "live".equals(align) || "top".equals(align) || "exif".equals(align)) {
                    selectedTextLine.setAlign("free");
                }
                renderPreview();
                e.consume();
            } else if (draggingSticker && selectedSticker != null) {
                double[] tc = previewToTemplate(e.getX(), e.getY());
                double dx = tc[0] - stickerDragStartX;
                double dy = tc[1] - stickerDragStartY;
                selectedSticker.setX(stickerOrigX + dx);
                selectedSticker.setY(stickerOrigY + dy);
                renderPreview();
                e.consume();
            } else if (draggingIcon && selectedIcon != null) {
                double[] tc = previewToTemplate(e.getX(), e.getY());
                double dx = tc[0] - iconDragStartX;
                double dy = tc[1] - iconDragStartY;
                selectedIcon.setX(iconOrigX + dx);
                selectedIcon.setY(iconOrigY + dy);
                renderPreview();
                e.consume();
            } else if (!Double.isNaN(dragStartX)) {
                // 视图平移：按场景坐标增量移动观察位置
                double dx = e.getSceneX() - dragStartX;
                double dy = e.getSceneY() - dragStartY;
                dragStartX = e.getSceneX();
                dragStartY = e.getSceneY();
                panX += dx;
                panY += dy;
                refreshView();
                e.consume();
            }
        });
        previewCanvas.setOnMouseReleased(e -> {
            if (draggingIcon || draggingTextLine || draggingSticker || resizingSticker || rotatingSticker) {
                draggingIcon = false;
                draggingTextLine = false;
                draggingSticker = false;
                resizingSticker = false;
                rotatingSticker = false;
                onSettingChanged();
            }
            previewCanvas.getScene().setCursor(javafx.scene.Cursor.DEFAULT);
            dragStartX = Double.NaN;
            dragStartY = Double.NaN;
        });
        previewCanvas.setOnMouseExited(e -> {
            previewCanvas.getScene().setCursor(javafx.scene.Cursor.DEFAULT);
        });
        previewCanvas.setOnMouseClicked(e -> {
            if (e.getClickCount() == 2 && selectedIcon == null && selectedTextLine == null && selectedSticker == null) {
                // 双击空白处：恢复居中显示
                panX = 0;
                panY = 0;
                setZoom(1.0);
                refreshView();
            }
        });
        previewCanvas.setOnScroll(e -> {
            if (e.isControlDown()) {
                // Ctrl + 滚轮：旋转选中元素（图标/贴纸/文字），步进 15°
                double delta = e.getDeltaY() > 0 ? 15 : -15;
                if (selectedIcon != null) {
                    selectedIcon.setRotation(normalizeRotation(selectedIcon.getRotation() + delta));
                    slElementRotation.setValue(selectedIcon.getRotation());
                } else if (selectedSticker != null) {
                    selectedSticker.setRotation(normalizeRotation(selectedSticker.getRotation() + delta));
                    slElementRotation.setValue(selectedSticker.getRotation());
                } else if (selectedTextLine != null) {
                    selectedTextLine.setRotation(normalizeRotation(selectedTextLine.getRotation() + delta));
                    slElementRotation.setValue(selectedTextLine.getRotation());
                }
                renderPreview();
                e.consume();
                return;
            }
            if (selectedIcon != null) {
                double delta = e.getDeltaY() > 0 ? 0.1 : -0.1;
                double newScale = Math.max(0.1, Math.min(3.0, selectedIcon.getScale() + delta));
                selectedIcon.setScale(newScale);
                renderPreview();
                e.consume();
            } else if (selectedSticker != null) {
                double delta = e.getDeltaY() > 0 ? 0.1 : -0.1;
                double newScale = Math.max(0.02, Math.min(3.0, selectedSticker.getScale() + delta));
                selectedSticker.setScale(newScale);
                renderPreview();
                e.consume();
            } else if (selectedTextLine != null) {
                double delta = e.getDeltaY() > 0 ? 2 : -2;
                double newSize = Math.max(8, Math.min(200, selectedTextLine.getFontSize() + delta));
                selectedTextLine.setFontSize(newSize);
                if (selectedTextLine == liveTextLine) slTextSize.setValue(newSize);
                renderPreview();
                e.consume();
            } else {
                // 未选中元素：滚轮直接缩放视图（拖动可平移查看细节）
                double delta = e.getDeltaY() > 0 ? 0.1 : -0.1;
                setZoom(getZoom() + delta);
                e.consume();
            }
        });
    }

    /** 旋转角度归一化到 [-180, 180) */
    private double normalizeRotation(double deg) {
        double r = deg % 360;
        if (r >= 180) r -= 360;
        if (r < -180) r += 360;
        return r;
    }

    /** 命中测试：贴纸顶部旋转手柄（圆点 + 连杆），位置与绘制一致（含旋转） */
    private boolean isStickerRotateHandle(double mx, double my, TextStickerConfig.Sticker s) {
        if (s.getSrc() == null || s.getSrc().isEmpty()) return false;
        Image simg = ImageCache.get(s.getSrc());
        if (simg == null || simg.getWidth() <= 0) return false;
        double sw = simg.getWidth() * s.getScale();
        double sh = simg.getHeight() * s.getScale();
        double pad = Math.max(5, Math.max(sw, sh) * 0.06);
        double rad = Math.toRadians(s.getRotation());
        // 画布坐标 → 贴纸局部坐标
        double lx = (mx - s.getX()) * Math.cos(-rad) - (my - s.getY()) * Math.sin(-rad);
        double ly = (mx - s.getX()) * Math.sin(-rad) + (my - s.getY()) * Math.cos(-rad);
        double hy = -sh / 2 - pad - 14;
        if (Math.hypot(lx, ly - hy) <= 12) return true;
        if (Math.abs(lx) <= 5 && ly >= -sh / 2 - pad - 12 && ly <= -sh / 2 - pad + 4) return true;
        return false;
    }

    /** 命中测试：贴纸选中框的四角手柄（用于拖动缩放），位置与绘制一致（含旋转） */
    private boolean isStickerHandle(double mx, double my, TextStickerConfig.Sticker s) {
        if (s.getSrc() == null || s.getSrc().isEmpty()) return false;
        Image simg = ImageCache.get(s.getSrc());
        if (simg == null || simg.getWidth() <= 0) return false;
        double sw = simg.getWidth() * s.getScale();
        double sh = simg.getHeight() * s.getScale();
        double pad = Math.max(5, Math.max(sw, sh) * 0.06);
        double hd = Math.max(3, pad) * 1.8;
        double rad = Math.toRadians(s.getRotation());
        double cos = Math.cos(rad);
        double sin = Math.sin(rad);
        double[][] corners = {
                {-sw / 2 - pad, -sh / 2 - pad},
                {sw / 2 + pad, -sh / 2 - pad},
                {-sw / 2 - pad, sh / 2 + pad},
                {sw / 2 + pad, sh / 2 + pad}
        };
        for (double[] c : corners) {
            double wx = s.getX() + c[0] * cos - c[1] * sin;
            double wy = s.getY() + c[0] * sin + c[1] * cos;
            if (Math.abs(mx - wx) <= hd / 2 && Math.abs(my - wy) <= hd / 2) {
                return true;
            }
        }
        return false;
    }

    /** 命中测试：贴纸（中心 + 旋转包围盒，右上优先） */
    private TextStickerConfig.Sticker hitTestSticker(double mx, double my) {
        if (template == null || template.getDecorConfig() == null) return null;
        java.util.List<TextStickerConfig.Sticker> stickers = template.getDecorConfig().getStickers();
        for (int i = stickers.size() - 1; i >= 0; i--) {
            TextStickerConfig.Sticker s = stickers.get(i);
            if (s.getSrc() == null || s.getSrc().isEmpty()) continue;
            Image simg = ImageCache.get(s.getSrc());
            if (simg == null || simg.getWidth() <= 0) continue;
            double sw = simg.getWidth() * s.getScale();
            double sh = simg.getHeight() * s.getScale();
            if (pointInRotatedBox(mx, my, s.getX(), s.getY(), sw, sh, Math.toRadians(s.getRotation()))) {
                return s;
            }
        }
        return null;
    }

    /** 判断点是否在旋转矩形内（cx,cy 为中心，w,h 未旋转尺寸，rad 弧度） */
    private boolean pointInRotatedBox(double px, double py, double cx, double cy, double w, double h, double rad) {
        double dx = px - cx;
        double dy = py - cy;
        double cos = Math.cos(-rad);
        double sin = Math.sin(-rad);
        double lx = dx * cos - dy * sin;
        double ly = dx * sin + dy * cos;
        return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
    }

    private IconItem hitTestIcon(double mx, double my) {
        java.util.List<IconItem> icons = IconManager.getActiveIcons();
        if (originImage == null || icons.isEmpty()) return null;
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

    /** 读取图片像素尺寸（仅解析文件头，不加载整图） */
    private double[] readImageSize(File f) {
        try (javax.imageio.stream.ImageInputStream in = javax.imageio.ImageIO.createImageInputStream(f)) {
            java.util.Iterator<javax.imageio.ImageReader> readers = javax.imageio.ImageIO.getImageReaders(in);
            if (readers.hasNext()) {
                javax.imageio.ImageReader r = readers.next();
                try {
                    r.setInput(in);
                    return new double[]{r.getWidth(0), r.getHeight(0)};
                } finally {
                    r.dispose();
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    /** 把模板中的自定义文字坐标从源画布换算到目标画布，保证同步后文字在其他照片上的相对位置一致（0 视为未设置，保持居中/自动对齐） */
    private void rebaseTextLinesToCanvas(TemplateModel tmpl, double srcW, double srcH, double dstW, double dstH) {
        if (tmpl == null || tmpl.getDecorConfig() == null) return;
        if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return;
        double rx = dstW / srcW;
        double ry = dstH / srcH;
        for (TextStickerConfig.TextLine l : tmpl.getDecorConfig().getTextLines()) {
            if (l.getX() != 0) l.setX(l.getX() * rx);
            if (l.getY() != 0) l.setY(l.getY() * ry);
        }
    }

    private TextStickerConfig.TextLine hitTestTextLine(double mx, double my) {
        if (originImage == null || template == null || template.getDecorConfig() == null) return null;
        List<TextStickerConfig.TextLine> lines = template.getDecorConfig().getTextLines();
        for (int i = lines.size() - 1; i >= 0; i--) {
            TextStickerConfig.TextLine l = lines.get(i);
            if (l.getText() == null || l.getText().isEmpty()) continue;
            double[] anchor = engine.textLineAnchor(l, originImage, template);
            if (anchor == null) continue;
            double fs = Math.max(1, l.getFontSize());
            double w = BorderEngine.measureTextWidth(l.getText(), l.getFontFamily(), fs);
            double h = fs * 1.25;
            double cx = anchor[0];
            double cy = anchor[1] - fs * 0.35;
            double pad = Math.max(6, fs * 0.15);
            if (mx >= cx - w / 2 - pad && mx <= cx + w / 2 + pad &&
                my >= cy - h / 2 - pad && my <= cy + h / 2 + pad) {
                return l;
            }
        }
        return null;
    }

    // ═══════════════ 模板市场（云） ═══════════════

    /** 供市场窗口获取当前编辑中的模板（用于上传） */
    public TemplateModel getCurrentTemplate() {
        return template;
    }

    /** 供市场窗口通知：云端模板已下载到本地，刷新本地预设列表 */
    public void notifyMarketPresetChanged() {
        Platform.runLater(() -> {
            List<String> base = loadPresetList();
            // 追加市场下载目录中的模板
            java.io.File dir = new java.io.File(
                    System.getProperty("user.home"), ".qingframe/market-presets");
            java.io.File[] files = dir.listFiles((d, name) -> name.endsWith(".json"));
            if (files != null) {
                for (java.io.File f : files) {
                    String name = f.getName().replace(".json", "");
                    if (!base.contains(name)) base.add(name);
                }
            }
            lvPresets.setItems(FXCollections.observableArrayList(base));
            updatePresetListHeight();
            statusLabel.setText("已刷新模板列表（含市场下载）");
        });
    }

    /** 内置预设列表自适应内容高度，交由外层 ScrollPane 统一滚动，避免嵌套滚动导致滚轮失效 */
    private void updatePresetListHeight() {
        lvPresets.setFixedCellSize(28);
        int count = lvPresets.getItems() == null ? 0 : lvPresets.getItems().size();
        lvPresets.setPrefHeight(Math.max(120, count * 28 + 6));
    }

    /** 打开模板市场窗口 */
    @FXML
    private void onOpenMarket() {
        try {
            javafx.fxml.FXMLLoader loader = new javafx.fxml.FXMLLoader(
                    getClass().getResource("/com/qingframe/network/MarketView.fxml"));
            javafx.scene.layout.BorderPane root = loader.load();
            com.qingframe.network.MarketController c = loader.getController();
            c.setMainController(this);
            Stage stage = new Stage();
            stage.setTitle("清框影 · 模板市场");
            stage.setScene(new javafx.scene.Scene(root));
            stage.show();
        } catch (Exception e) {
            showAlert("打开模板市场失败: " + e.getMessage());
        }
    }

    // ═══════════════ 账号体系（方案 B + C：启动恢复登录态 / 主界面入口 / 欢迎页） ═══════════════

    /** 当前主题的 CSS 路径（供登录/欢迎等子窗口复用，保证视觉一致） */
    public String currentThemeCss() {
        String theme = isDarkTheme ? "dark-theme.css" : "light-theme.css";
        return getClass().getResource("/com/qingframe/ui/css/" + theme).toExternalForm();
    }

    /** 刷新主界面登录状态显示：恢复本地 token，更新"已登录: xxx / 未登录" */
    public void updateLoginUi() {
        if (ApiClient.token == null) {
            ApiClient.token = TokenStore.load();
        }
        boolean loggedIn = ApiClient.isLoggedIn();
        String nickname = TokenStore.loadNickname();
        if (lblLoginStatus != null) {
            lblLoginStatus.setText(loggedIn ? ("已登录: " + (nickname == null ? "用户" : nickname)) : "未登录");
        }
        if (btnLoginToggle != null) {
            btnLoginToggle.setText(loggedIn ? "资料" : "登录");
            btnLoginToggle.setTooltip(new javafx.scene.control.Tooltip(loggedIn ? "个人资料 / 退出登录" : "登录以使用模板市场"));
        }
        updateAvatarUi(loggedIn);
    }

    /** 主界面右上角圆形头像：已登录且本地有头像则显示，否则隐藏 */
    private void updateAvatarUi(boolean loggedIn) {
        if (ivAvatar == null) return;
        if (!loggedIn) {
            ivAvatar.setImage(null);
            ivAvatar.setVisible(false);
            return;
        }
        String avatar = TokenStore.loadAvatar();
        if (avatar == null) {
            ivAvatar.setImage(null);
            ivAvatar.setVisible(false);
            return;
        }
        try {
            int comma = avatar.indexOf(',');
            byte[] bytes = java.util.Base64.getDecoder().decode(avatar.substring(comma + 1));
            ivAvatar.setImage(new Image(new ByteArrayInputStream(bytes)));
            ivAvatar.setVisible(true);
        } catch (Exception e) {
            ivAvatar.setVisible(false);
        }
    }

    /** 主界面登录/退出按钮 */
    @FXML
    private void onLoginToggle() {
        if (ApiClient.isLoggedIn()) {
            openProfileWindow();
            return;
        }
        openLoginWindow(() -> {
            updateLoginUi();
            statusLabel.setText("登录成功");
        });
    }

    /** 点击头像/昵称：已登录打开个人资料，未登录打开登录窗口 */
    @FXML
    private void onOpenProfile() {
        if (ApiClient.isLoggedIn()) {
            openProfileWindow();
        } else {
            openLoginWindow(() -> updateLoginUi());
        }
    }

    /** 个人资料窗口：头像上传 / 昵称修改 / 退出登录 */
    public void openProfileWindow() {
        try {
            javafx.fxml.FXMLLoader loader = new javafx.fxml.FXMLLoader(
                    getClass().getResource("/com/qingframe/network/ProfileView.fxml"));
            BorderPane root = loader.load();
            com.qingframe.network.ProfileController c = loader.getController();
            c.init(this);
            Stage stage = new Stage();
            stage.setTitle("个人资料");
            stage.initModality(Modality.APPLICATION_MODAL);
            Scene scene = new Scene(root);
            scene.getStylesheets().add(currentThemeCss());
            stage.setScene(scene);
            stage.showAndWait();
            updateLoginUi();
        } catch (Exception e) {
            showAlert("打开个人资料失败: " + e.getMessage());
        }
    }

    /** 打开登录/注册窗口（模态），登录成功后回调 */
    public void openLoginWindow(Runnable afterLogin) {
        try {
            javafx.fxml.FXMLLoader loader = new javafx.fxml.FXMLLoader(
                    getClass().getResource("/com/qingframe/network/LoginView.fxml"));
            BorderPane root = loader.load();
            LoginController c = loader.getController();
            c.setOnLoggedIn(afterLogin);
            Stage stage = new Stage();
            stage.setTitle("登录清框影");
            stage.initModality(Modality.APPLICATION_MODAL);
            Scene scene = new Scene(root);
            scene.getStylesheets().add(currentThemeCss());
            stage.setScene(scene);
            stage.showAndWait();
        } catch (Exception e) {
            showAlert("打开登录窗口失败: " + e.getMessage());
        }
    }

    /** 启动后弹出欢迎页：仅未登录且未勾选"不再提示"时显示，可登录或跳过 */
    public void maybeShowWelcome() {
        if (ApiClient.isLoggedIn() || TokenStore.loadSkipWelcome()) {
            return;
        }
        try {
            javafx.fxml.FXMLLoader loader = new javafx.fxml.FXMLLoader(
                    getClass().getResource("/com/qingframe/network/WelcomeView.fxml"));
            BorderPane root = loader.load();
            WelcomeController c = loader.getController();
            c.init(this);
            Stage stage = new Stage();
            stage.setTitle("欢迎使用清框影");
            stage.initModality(Modality.APPLICATION_MODAL);
            Scene scene = new Scene(root);
            scene.getStylesheets().add(currentThemeCss());
            stage.setScene(scene);
            stage.showAndWait();
            updateLoginUi();
        } catch (Exception e) {
            // 欢迎页异常不阻塞主界面
            showAlert("欢迎页加载失败: " + e.getMessage());
        }
    }
}

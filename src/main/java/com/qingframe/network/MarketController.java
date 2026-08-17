package com.qingframe.network;

import com.qingframe.model.TemplateModel;
import com.qingframe.network.dto.PresetItem;
import com.qingframe.service.PresetService;
import com.qingframe.ui.controller.MainController;
import com.qingframe.util.JsonUtil;
import javafx.application.Platform;
import javafx.fxml.FXML;
import javafx.fxml.FXMLLoader;
import javafx.fxml.Initializable;
import javafx.scene.Scene;
import javafx.scene.control.Button;
import javafx.scene.control.ComboBox;
import javafx.scene.control.Label;
import javafx.scene.control.ListView;
import javafx.scene.control.TextField;
import javafx.scene.layout.BorderPane;
import javafx.stage.Modality;
import javafx.stage.Stage;

import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.ResourceBundle;

/**
 * 模板市场窗口：浏览/搜索/下载/上传/点赞/删除云端模板。
 * 通过 PresetMarketService 异步调用服务端，UI 更新全部回到 FX 线程。
 */
public class MarketController implements Initializable {

    @FXML private Label lblServer, lblUser, lblTotal, lblHint;
    @FXML private Button btnLogin, btnLogout, btnDownload, btnUpload, btnLike, btnDelete;
    @FXML private TextField tfSearch, tfServer;
    @FXML private ComboBox<String> cbTag;
    @FXML private ListView<String> lvPresets;

    /** 当前主界面引用：用于获取当前模板上传、下载后刷新本地预设 */
    private MainController mainController;
    /** 本地预设列表刷新入口（MainController.loadPresetList 逻辑已存在，这里直接重建） */
    private final List<Long> loadedPresetIds = new ArrayList<>();
    private final List<PresetItem> currentList = new ArrayList<>();
    private String currentKeyword = "";
    private String currentTag = "";
    private int currentPage = 1;
    private long total = 0;
    private final List<String> allTags = new ArrayList<>();
    /** 请求代次：连续触发 loadPage 时丢弃过期响应，避免旧结果覆盖新列表 */
    private int pageRequestGen = 0;

    public void setMainController(MainController mainController) {
        this.mainController = mainController;
    }

    @Override
    public void initialize(URL url, ResourceBundle rb) {
        loadServerUrl();
        lblServer.setText("服务端: " + ApiClient.BASE_URL);
        updateLoginState();
        loadTags();
        loadPage(1);
    }

    // ────────────── 服务器地址 ──────────────

    /** 从 ~/.qingframe/server-url 读取上次保存的服务器地址 */
    private void loadServerUrl() {
        String saved = null;
        try {
            java.nio.file.Path p = java.nio.file.Paths.get(
                    System.getProperty("user.home"), ".qingframe", "server-url");
            if (java.nio.file.Files.exists(p)) {
                saved = java.nio.file.Files.readString(p, StandardCharsets.UTF_8).trim();
            }
        } catch (Exception ignored) {
        }
        if (saved != null && !saved.isEmpty()) {
            ApiClient.BASE_URL = saved;
        }
        tfServer.setText(ApiClient.BASE_URL);
    }

    @FXML
    private void onSaveServer() {
        String url = tfServer.getText().trim();
        if (url.isEmpty()) {
            lblHint.setText("服务器地址不能为空");
            return;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }
        ApiClient.BASE_URL = url;
        lblServer.setText("服务端: " + url);
        try {
            java.nio.file.Path dir = java.nio.file.Paths.get(
                    System.getProperty("user.home"), ".qingframe");
            java.nio.file.Files.createDirectories(dir);
            java.nio.file.Files.writeString(dir.resolve("server-url"), url, StandardCharsets.UTF_8);
        } catch (Exception ignored) {
        }
        lblHint.setText("服务器地址已保存，正在重新连接...");
        loadTags();
        loadPage(1);
    }

    private void updateLoginState() {
        boolean loggedIn = ApiClient.isLoggedIn();
        lblUser.setText(loggedIn ? ("已登录: " + currentUsername()) : "未登录");
        btnLogin.setVisible(!loggedIn);
        btnLogout.setVisible(loggedIn);
        btnUpload.setDisable(!loggedIn);
        btnLike.setDisable(!loggedIn);
        btnDelete.setVisible(false);
    }

    private String currentUsername() {
        // token 中不含用户名；本地记住的用户名由 login 时缓存
        String cached = TokenStore.loadUsername();
        return cached == null ? "用户" : cached;
    }

    // ────────────── 登录 ──────────────

    @FXML
    private void onOpenLogin() {
        openLoginWindow(() -> {
            updateLoginState();
            loadTags();
            loadPage(1);
        });
    }

    @FXML
    private void onLogout() {
        ApiClient.token = null;
        TokenStore.clear();
        updateLoginState();
        loadPage(1);
    }

    private void openLoginWindow(Runnable afterLogin) {
        try {
            FXMLLoader loader = new FXMLLoader(getClass().getResource("/com/qingframe/network/LoginView.fxml"));
            BorderPane root = loader.load();
            LoginController c = loader.getController();
            c.setOnLoggedIn(afterLogin);
            Stage stage = new Stage();
            stage.setTitle("登录清框影");
            stage.initModality(Modality.APPLICATION_MODAL);
            Scene scene = new Scene(root);
            if (mainController != null) {
                scene.getStylesheets().add(mainController.currentThemeCss());
            }
            stage.setScene(scene);
            stage.show();
        } catch (Exception e) {
            lblHint.setText("打开登录窗口失败: " + e.getMessage());
        }
    }

    // ────────────── 列表 / 搜索 ──────────────

    @FXML
    private void onSearch() {
        currentKeyword = tfSearch.getText().trim();
        currentTag = cbTag.getValue() == null ? "" : cbTag.getValue();
        if ("全部".equals(currentTag)) currentTag = "";
        loadPage(1);
    }

    @FXML
    private void onRefresh() {
        loadTags();
        loadPage(1);
    }

    private void loadTags() {
        PresetMarketService.tags().whenComplete((r, err) -> Platform.runLater(() -> {
            if (err == null && r != null && r.isOk()) {
                List<String> tags = PresetMarketService.parseTags(r);
                allTags.clear();
                if (tags != null) allTags.addAll(tags);
                cbTag.getItems().clear();
                cbTag.getItems().add("全部");
                cbTag.getItems().addAll(allTags);
                cbTag.setValue("全部");
            }
        }));
    }

    private void loadPage(int page) {
        final int gen = ++pageRequestGen;
        lblTotal.setText("加载中...");
        PresetMarketService.list(page, 50, currentTag, currentKeyword)
                .whenComplete((r, err) -> Platform.runLater(() -> {
                    // 已有更新的请求发出，本次响应作废
                    if (gen != pageRequestGen) return;
                    if (err != null || r == null) {
                        lblTotal.setText("无法连接服务器");
                        lblHint.setText("请确认服务端已启动 (mvn spring-boot:run)");
                        return;
                    }
                    if (!r.isOk()) {
                        lblTotal.setText(r.errorMessage());
                        return;
                    }
                    var pageResult = PresetMarketService.parsePage(r);
                    if (pageResult == null || pageResult.getList() == null) {
                        lvPresets.getItems().clear();
                        lblTotal.setText("0 个模板");
                        return;
                    }
                    currentPage = page;
                    total = pageResult.getTotal();
                    currentList.clear();
                    currentList.addAll(pageResult.getList());
                    lvPresets.getItems().clear();
                    for (PresetItem item : pageResult.getList()) {
                        lvPresets.getItems().add(item.displayText());
                    }
                    lblTotal.setText("共 " + total + " 个模板");
                    updateLoginState();
                }));
    }

    // ────────────── 下载 ──────────────

    @FXML
    private void onDownload() {
        int idx = lvPresets.getSelectionModel().getSelectedIndex();
        if (idx < 0 || idx >= currentList.size()) {
            lblHint.setText("请先在列表中选择一个模板");
            return;
        }
        PresetItem item = currentList.get(idx);
        btnDownload.setDisable(true);
        lblHint.setText("正在下载: " + item.getName() + "...");
        PresetMarketService.downloadContent(item.getId())
                .whenComplete((json, err) -> Platform.runLater(() -> {
                    btnDownload.setDisable(false);
                    if (err != null || json == null) {
                        lblHint.setText("下载失败，请检查网络或服务端");
                        return;
                    }
                    // 校验后写入本地 presets 目录，拒绝脏数据落盘
                    TemplateModel model = PresetMarketService.parseTemplateJson(json);
                    if (model == null) {
                        lblHint.setText("模板数据校验失败，已拒绝落盘");
                        return;
                    }
                    try {
                        Path dir = Paths.get(System.getProperty("user.home"), ".qingframe", "market-presets");
                        Files.createDirectories(dir);
                        String safe = item.getName().replaceAll("[\\\\/:*?\"<>|]", "_");
                        Path target = dir.resolve(safe + ".json");
                        Files.writeString(target, JsonUtil.toJson(model), StandardCharsets.UTF_8);
                        lblHint.setText("已下载并保存: " + target);
                        refreshLocalPresets();
                    } catch (Exception ex) {
                        lblHint.setText("本地保存失败: " + ex.getMessage());
                    }
                }));
    }

    /** 下载后通知主界面刷新本地预设列表（通过重新扫描 classpath 目录） */
    private void refreshLocalPresets() {
        // 本地下载目录加入 classpath 扫描结果：主界面预设列表由 MainController 维护，
        // 此处通过回调让主界面重建列表。
        if (mainController != null) {
            mainController.notifyMarketPresetChanged();
        }
    }

    // ────────────── 上传当前模板 ──────────────

    @FXML
    private void onUploadCurrent() {
        if (!ApiClient.isLoggedIn()) {
            lblHint.setText("请先登录再上传");
            return;
        }
        if (mainController == null || mainController.getCurrentTemplate() == null) {
            lblHint.setText("请先在主界面编辑一个模板");
            return;
        }
        TemplateModel current = mainController.getCurrentTemplate();
        String name = current.getTemplateName();
        if (name == null || name.isEmpty() || "默认模板".equals(name)) {
            name = "我的模板 " + System.currentTimeMillis() % 100000;
        }
        final String uploadName = name;
        String tag = current.getTemplateTag() == null ? "其他" : current.getTemplateTag();
        if ("通用".equals(tag)) tag = "其他";
        String description = "由清框影桌面端上传";
        btnUpload.setDisable(true);
        lblHint.setText("正在上传...");
        PresetMarketService.upload(uploadName, tag, description, JsonUtil.toJson(current))
                .whenComplete((r, err) -> Platform.runLater(() -> {
                    btnUpload.setDisable(false);
                    if (err != null || r == null) {
                        lblHint.setText("上传失败，无法连接服务器");
                        return;
                    }
                    if (!r.isOk()) {
                        lblHint.setText("上传失败: " + r.errorMessage());
                        return;
                    }
                    lblHint.setText("上传成功: " + uploadName);
                    loadTags();
                    loadPage(1);
                }));
    }

    // ────────────── 点赞 / 删除 ──────────────

    @FXML
    private void onToggleLike() {
        int idx = lvPresets.getSelectionModel().getSelectedIndex();
        if (idx < 0 || idx >= currentList.size()) {
            lblHint.setText("请先选择模板");
            return;
        }
        if (!ApiClient.isLoggedIn()) {
            lblHint.setText("请先登录");
            return;
        }
        PresetItem item = currentList.get(idx);
        PresetMarketService.like(item.getId()).whenComplete((r, err) -> Platform.runLater(() -> {
            if (err != null || r == null) {
                lblHint.setText("操作失败，无法连接服务器");
                return;
            }
            lblHint.setText(r.isOk() ? "已点赞" : ("点赞失败: " + r.errorMessage()));
            loadPage(currentPage);
        }));
    }

    @FXML
    private void onDelete() {
        int idx = lvPresets.getSelectionModel().getSelectedIndex();
        if (idx < 0 || idx >= currentList.size()) {
            return;
        }
        PresetItem item = currentList.get(idx);
        if (!ApiClient.isLoggedIn()) {
            lblHint.setText("请先登录");
            return;
        }
        PresetMarketService.delete(item.getId()).whenComplete((r, err) -> Platform.runLater(() -> {
            if (err != null || r == null) {
                lblHint.setText("删除失败，无法连接服务器");
                return;
            }
            lblHint.setText(r.isOk() ? "已删除: " + item.getName() : ("删除失败: " + r.errorMessage()));
            loadPage(currentPage);
        }));
    }
}

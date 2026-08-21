package com.qingframe;

import com.qingframe.network.ApiClient;
import com.qingframe.network.TokenStore;
import com.qingframe.ui.SplashScreen;
import com.qingframe.ui.controller.MainController;
import javafx.animation.KeyFrame;
import javafx.animation.Timeline;
import javafx.application.Application;
import javafx.fxml.FXMLLoader;
import javafx.scene.Scene;
import javafx.scene.image.Image;
import javafx.scene.layout.BorderPane;
import javafx.stage.Stage;
import javafx.util.Duration;

public class Main extends Application {

    private static Stage primaryStage;

    @Override
    public void start(Stage stage) throws Exception {
        primaryStage = stage;
        // Photoshop 风格启动加载页：分阶段状态提示，动画结束后构建主窗口并淡出
        SplashScreen splash = new SplashScreen();
        splash.show();

        String[] steps = {
                "正在加载界面资源…",
                "正在初始化渲染引擎…",
                "正在加载字体与内置素材…",
                "正在恢复登录会话…",
                "启动完成，正在进入主界面…"
        };
        Timeline timeline = new Timeline();
        for (int i = 0; i < steps.length; i++) {
            final int idx = i;
            timeline.getKeyFrames().add(new KeyFrame(
                    Duration.millis(200 + i * 300), e -> splash.setStatus(steps[idx])));
        }
        timeline.setOnFinished(e -> {
            try {
                buildMainWindow(stage);
                splash.closeFade();
            } catch (Exception ex) {
                splash.setStatus("启动失败: " + ex.getMessage());
                ex.printStackTrace();
            }
        });
        timeline.play();
    }

    private void buildMainWindow(Stage stage) throws Exception {
        // 启动时静默恢复上次"记住登录"的会话（方案 B）
        if (ApiClient.token == null) {
            ApiClient.token = TokenStore.load();
        }
        FXMLLoader loader = new FXMLLoader(getClass().getResource("/com/qingframe/ui/MainView.fxml"));
        BorderPane root = loader.load();
        MainController controller = loader.getController();
        Scene scene = new Scene(root, 1400, 900);
        scene.getStylesheets().add(getClass().getResource("/com/qingframe/ui/css/dark-theme.css").toExternalForm());
        stage.getIcons().add(new Image(getClass().getResourceAsStream("/com/qingframe/ui/icons/app-icon-256.png")));
        stage.setTitle("清框影 QingFrameShadow - Image Border Editor");
        stage.setScene(scene);
        stage.setMinWidth(1100);
        stage.setMinHeight(700);
        stage.show();
        // 主窗口显示后再弹欢迎页（未登录且未勾选"不再提示"时）
        controller.maybeShowWelcome();
    }

    public static Stage getPrimaryStage() {
        return primaryStage;
    }

    public static void main(String[] args) {
        // 渲染管线智能选择：仅核显的机器上 D3D 硬件加速对 4000px+ 大图分块渲染会触发显卡驱动崩溃，
        // 自动切换软件渲染；检测到独立显卡（NVIDIA/AMD 独显）则保持默认硬件加速
        String order = detectPrismOrder();
        if ("sw".equals(order)) {
            System.setProperty("prism.order", "sw");
        }
        launch(args);
    }

    /** 探测显卡类型：无独立显卡（仅核显）返回 "sw"；有独显或检测失败返回 null（保持 JavaFX 默认） */
    private static String detectPrismOrder() {
        try {
            Process p = new ProcessBuilder("powershell", "-NoProfile", "-Command",
                    "Get-CimInstance win32_VideoController | Select-Object -ExpandProperty Name")
                    .redirectErrorStream(true).start();
            String out = new String(p.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            if (!out.trim().isEmpty()) {
                boolean hasDiscrete = false;
                boolean hasIgorOnly = false;
                for (String line : out.split("\\r?\\n")) {
                    String v = line.trim().toLowerCase();
                    if (v.contains("nvidia") || v.contains("geforce") || v.contains("rtx")
                            || v.contains("quadro") || v.contains("radeon rx")) {
                        hasDiscrete = true;
                    }
                    if (v.contains("intel") || (v.contains("radeon") && !v.contains("rx"))) {
                        hasIgorOnly = true;
                    }
                }
                // 有独立显卡 → 硬件加速；仅核显 → 软件渲染
                if (hasDiscrete) return null;
                if (hasIgorOnly) return "sw";
            }
        } catch (Exception ignored) {
        }
        return null;
    }
}

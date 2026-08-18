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
        launch(args);
    }
}

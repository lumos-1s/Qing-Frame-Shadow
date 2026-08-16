package com.qingframe;

import com.qingframe.network.ApiClient;
import com.qingframe.network.TokenStore;
import com.qingframe.ui.controller.MainController;
import javafx.application.Application;
import javafx.fxml.FXMLLoader;
import javafx.scene.Scene;
import javafx.scene.image.Image;
import javafx.scene.layout.BorderPane;
import javafx.stage.Stage;

public class Main extends Application {

    private static Stage primaryStage;

    @Override
    public void start(Stage stage) throws Exception {
        primaryStage = stage;
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

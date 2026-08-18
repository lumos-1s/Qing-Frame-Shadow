package com.qingframe.ui;

import javafx.animation.FadeTransition;
import javafx.application.Platform;
import javafx.geometry.Pos;
import javafx.scene.Scene;
import javafx.scene.control.Label;
import javafx.scene.control.ProgressBar;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import javafx.scene.layout.VBox;
import javafx.scene.paint.Color;
import javafx.stage.Stage;
import javafx.stage.StageStyle;
import javafx.util.Duration;

/**
 * Photoshop 风格启动加载页：无边框置顶小窗，应用图标 + 产品名 + 进度条 + 分阶段状态文字。
 * 主窗口构建完成后调用 {@link #closeFade()} 淡出关闭。
 */
public class SplashScreen {

    private final Stage stage = new Stage(StageStyle.TRANSPARENT);
    private final ProgressBar progressBar = new ProgressBar(-1);
    private final Label statusLabel = new Label("正在启动…");

    public SplashScreen() {
        VBox panel = new VBox(14);
        panel.setAlignment(Pos.CENTER);
        panel.setStyle("-fx-background-color: #14161B; -fx-background-radius: 14;");
        panel.setPrefSize(380, 250);

        ImageView icon = new ImageView(new Image(
                getClass().getResourceAsStream("/com/qingframe/ui/icons/app-icon-256.png")));
        icon.setFitWidth(72);
        icon.setFitHeight(72);
        icon.setPreserveRatio(true);

        Label title = new Label("清框影 QingFrameShadow");
        title.setStyle("-fx-text-fill: #E6E9EF; -fx-font-size: 17px; -fx-font-weight: bold;");
        Label subtitle = new Label("Image Border Editor");
        subtitle.setStyle("-fx-text-fill: #6F7787; -fx-font-size: 12px;");

        progressBar.setPrefWidth(280);
        progressBar.setPrefHeight(6);
        progressBar.setStyle("-fx-accent: #5B8DEF;");

        statusLabel.setStyle("-fx-text-fill: #A8B0BD; -fx-font-size: 12px;");

        panel.getChildren().addAll(icon, title, subtitle, progressBar, statusLabel);
        Scene scene = new Scene(panel);
        scene.setFill(Color.TRANSPARENT);
        stage.setScene(scene);
        stage.setAlwaysOnTop(true);
    }

    public void show() {
        stage.show();
        stage.centerOnScreen();
    }

    public void setStatus(String text) {
        Platform.runLater(() -> statusLabel.setText(text));
    }

    /** 主窗口显示后调用：淡出并关闭加载页 */
    public void closeFade() {
        FadeTransition ft = new FadeTransition(Duration.millis(260), stage.getScene().getRoot());
        ft.setFromValue(1.0);
        ft.setToValue(0.0);
        ft.setOnFinished(e -> stage.close());
        ft.play();
    }
}

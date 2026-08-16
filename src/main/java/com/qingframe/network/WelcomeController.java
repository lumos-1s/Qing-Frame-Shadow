package com.qingframe.network;

import com.qingframe.ui.controller.MainController;
import javafx.event.ActionEvent;
import javafx.fxml.FXML;
import javafx.fxml.FXMLLoader;
import javafx.scene.Scene;
import javafx.scene.control.Button;
import javafx.scene.control.CheckBox;
import javafx.scene.layout.BorderPane;
import javafx.stage.Modality;
import javafx.stage.Stage;

/**
 * 欢迎页（方案 C）：未登录启动时展示，可登录/注册，也可跳过。
 * 勾选"下次启动不再显示"后写入 ~/.qingframe/skip-welcome。
 */
public class WelcomeController {

    @FXML private Button btnLogin;
    @FXML private Button btnSkip;
    @FXML private CheckBox cbNoMore;

    /** 主界面引用：登录成功后刷新主界面登录状态 */
    private MainController mainController;

    public void init(MainController mainController) {
        this.mainController = mainController;
    }

    /** 打开登录/注册窗口；登录成功后关闭欢迎页并刷新主界面 */
    @FXML
    private void onLogin(ActionEvent e) {
        try {
            FXMLLoader loader = new FXMLLoader(getClass().getResource("/com/qingframe/network/LoginView.fxml"));
            BorderPane root = loader.load();
            LoginController c = loader.getController();
            c.setOnLoggedIn(() -> {
                rememberChoice();
                close();
                if (mainController != null) {
                    mainController.updateLoginUi();
                }
            });
            Stage stage = new Stage();
            stage.setTitle("登录清框影");
            stage.initModality(Modality.APPLICATION_MODAL);
            Scene scene = new Scene(root);
            if (mainController != null) {
                scene.getStylesheets().add(mainController.currentThemeCss());
            }
            stage.setScene(scene);
            stage.showAndWait();
        } catch (Exception ex) {
            close();
        }
    }

    /** 跳过欢迎页，直接进入主界面 */
    @FXML
    private void onSkip(ActionEvent e) {
        rememberChoice();
        close();
    }

    private void rememberChoice() {
        if (cbNoMore.isSelected()) {
            TokenStore.saveSkipWelcome(true);
        }
    }

    private void close() {
        Stage stage = (Stage) btnSkip.getScene().getWindow();
        stage.close();
    }
}

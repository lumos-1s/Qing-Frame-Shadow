package com.qingframe.network;

import com.google.gson.JsonObject;
import javafx.application.Platform;
import javafx.event.ActionEvent;
import javafx.fxml.FXML;
import javafx.fxml.Initializable;
import javafx.scene.Scene;
import javafx.scene.control.Button;
import javafx.scene.control.CheckBox;
import javafx.scene.control.Label;
import javafx.scene.control.PasswordField;
import javafx.scene.control.TextField;
import javafx.scene.layout.BorderPane;
import javafx.stage.Modality;
import javafx.stage.Stage;

import java.net.URL;
import java.util.ResourceBundle;

/** 登录/注册窗口：成功后保存 token（可勾选记住），回调登录成功监听器 */
public class LoginController implements Initializable {

    @FXML private TextField tfUsername;
    @FXML private PasswordField tfPassword;
    @FXML private CheckBox cbRemember;
    @FXML private Label lblError;
    @FXML private Button btnLogin;
    @FXML private Button btnRegister;

    /** 登录成功回调（UI 线程执行） */
    private Runnable onLoggedIn;

    public void setOnLoggedIn(Runnable onLoggedIn) {
        this.onLoggedIn = onLoggedIn;
    }

    @Override
    public void initialize(URL url, ResourceBundle rb) {
        // 启动时自动恢复登录态
        if (TokenStore.load() != null && ApiClient.token == null) {
            ApiClient.token = TokenStore.load();
            btnLogin.setText("重新登录");
            btnRegister.setDisable(true);
        }
    }

    @FXML
    private void onLogin(ActionEvent e) {
        String username = tfUsername.getText().trim();
        String password = tfPassword.getText();
        if (username.isEmpty() || password.isEmpty()) {
            showError("请输入用户名和密码");
            return;
        }
        setBusy(true, "登录中...");
        PresetMarketService.login(username, password).whenComplete((r, err) -> Platform.runLater(() -> {
            setBusy(false, "登录");
            if (err != null || r == null) {
                showError("无法连接服务器，请检查服务是否已启动");
                return;
            }
            if (!r.isOk()) {
                showError(r.errorMessage());
                return;
            }
            JsonObject obj = r.data.getAsJsonObject();
            String token = obj.get("token").getAsString();
            ApiClient.token = token;
            TokenStore.saveUsername(username);
            if (cbRemember.isSelected()) {
                TokenStore.save(token);
            } else {
                TokenStore.clear();
            }
            cacheProfile();
            if (onLoggedIn != null) {
                onLoggedIn.run();
            }
            close();
        }));
    }

    @FXML
    private void onRegister(ActionEvent e) {
        String username = tfUsername.getText().trim();
        String password = tfPassword.getText();
        if (username.isEmpty() || password.isEmpty()) {
            showError("请输入用户名和密码");
            return;
        }
        if (password.length() < 6) {
            showError("密码至少 6 位");
            return;
        }
        setBusy(true, "注册中...");
        PresetMarketService.register(username, password).whenComplete((r, err) -> Platform.runLater(() -> {
            setBusy(false, "登录");
            if (err != null || r == null) {
                showError("无法连接服务器，请检查服务是否已启动");
                return;
            }
            if (!r.isOk()) {
                showError(r.errorMessage());
                return;
            }
            // 注册成功自动登录
            PresetMarketService.login(username, password).whenComplete((r2, err2) -> Platform.runLater(() -> {
                if (err2 != null || r2 == null || !r2.isOk()) {
                    showError("注册成功，请手动登录");
                    return;
                }
                JsonObject obj = r2.data.getAsJsonObject();
                ApiClient.token = obj.get("token").getAsString();
                TokenStore.saveUsername(username);
                if (cbRemember.isSelected()) {
                    TokenStore.save(ApiClient.token);
                }
                cacheProfile();
                if (onLoggedIn != null) {
                    onLoggedIn.run();
                }
                close();
            }));
        }));
    }

    /** 忘记密码：打开重置密码窗口 */
    @FXML
    private void onForgotPassword() {
        try {
            javafx.fxml.FXMLLoader loader = new javafx.fxml.FXMLLoader(
                    getClass().getResource("/com/qingframe/network/ResetPasswordView.fxml"));
            BorderPane root = loader.load();
            Stage stage = new Stage();
            stage.setTitle("忘记密码");
            stage.initModality(Modality.APPLICATION_MODAL);
            Scene scene = new Scene(root);
            scene.getStylesheets().add(getClass().getResource("/com/qingframe/ui/css/dark-theme.css").toExternalForm());
            stage.setScene(scene);
            stage.show();
        } catch (Exception ex) {
            showError("打开重置窗口失败: " + ex.getMessage());
        }
    }

    private void setBusy(boolean busy, String text) {
        btnLogin.setText(text);
        btnLogin.setDisable(busy);
        btnRegister.setDisable(busy);
    }

    private void showError(String msg) {
        lblError.setText(msg);
        lblError.setVisible(true);
    }

    private void close() {
        Stage stage = (Stage) tfUsername.getScene().getWindow();
        stage.close();
    }

    /** 登录/注册成功后拉取昵称头像并缓存到本地，供主界面/个人资料展示 */
    private void cacheProfile() {
        PresetMarketService.me().whenComplete((r, err) -> Platform.runLater(() -> {
            try {
                if (r != null && r.isOk() && r.data != null) {
                    JsonObject d = r.data.getAsJsonObject();
                    if (d.has("nickname")) {
                        TokenStore.saveNickname(d.get("nickname").getAsString());
                    }
                    if (d.has("avatar") && !d.get("avatar").isJsonNull()) {
                        TokenStore.saveAvatar(d.get("avatar").getAsString());
                    }
                }
            } catch (Exception ignored) {
            }
        }));
    }
}

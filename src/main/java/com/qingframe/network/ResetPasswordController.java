package com.qingframe.network;

import javafx.application.Platform;
import javafx.fxml.FXML;
import javafx.fxml.Initializable;
import javafx.scene.control.Button;
import javafx.scene.control.Label;
import javafx.scene.control.PasswordField;
import javafx.scene.control.TextField;
import javafx.stage.Stage;

import java.net.URL;
import java.util.ResourceBundle;

/** 忘记密码窗口：用户名 + 新密码重置 */
public class ResetPasswordController implements Initializable {

    @FXML private TextField tfUsername;
    @FXML private PasswordField tfNewPassword, tfConfirm;
    @FXML private Label lblHint;
    @FXML private Button btnReset;

    @Override
    public void initialize(URL url, ResourceBundle rb) {
        // 已登录时预填用户名，方便主动改密
        String username = TokenStore.loadUsername();
        if (username != null && ApiClient.isLoggedIn()) {
            tfUsername.setText(username);
        }
    }

    @FXML
    private void onReset() {
        String username = tfUsername.getText().trim();
        String pwd = tfNewPassword.getText();
        String confirm = tfConfirm.getText();
        if (username.isEmpty()) {
            showHint("请输入用户名");
            return;
        }
        if (pwd.length() < 6) {
            showHint("新密码至少 6 位");
            return;
        }
        if (!pwd.equals(confirm)) {
            showHint("两次输入的密码不一致");
            return;
        }
        setBusy(true);
        PresetMarketService.resetPassword(username, pwd).whenComplete((r, err) -> Platform.runLater(() -> {
            setBusy(false);
            if (err != null || r == null) {
                showHint("无法连接服务器，请检查服务是否已启动");
                return;
            }
            if (!r.isOk()) {
                showHint(r.errorMessage());
                return;
            }
            showHint("重置成功，请用新密码登录");
            lblHint.setStyle("-fx-text-fill: -qfx-success;");
        }));
    }

    private void setBusy(boolean busy) {
        btnReset.setDisable(busy);
        btnReset.setText(busy ? "提交中..." : "重置密码");
    }

    private void showHint(String msg) {
        lblHint.setText(msg);
        lblHint.setVisible(true);
    }

    @FXML
    private void onClose() {
        Stage stage = (Stage) tfUsername.getScene().getWindow();
        stage.close();
    }
}

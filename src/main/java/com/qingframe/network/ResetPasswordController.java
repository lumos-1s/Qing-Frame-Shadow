package com.qingframe.network;

import com.google.gson.JsonObject;
import javafx.application.Platform;
import javafx.fxml.FXML;
import javafx.fxml.Initializable;
import javafx.scene.control.Button;
import javafx.scene.control.Label;
import javafx.scene.control.PasswordField;
import javafx.scene.control.TextField;

import java.net.URL;
import java.util.ResourceBundle;

/** 找回密码窗口：邮箱获取验证码 → 验证码 + 新密码重置 */
public class ResetPasswordController implements Initializable {

    @FXML private TextField tfEmail, tfCode;
    @FXML private PasswordField tfNewPassword, tfConfirm;
    @FXML private Label lblHint;
    @FXML private Button btnSendCode, btnReset;

    @Override
    public void initialize(URL url, ResourceBundle rb) {
        String email = TokenStore.loadEmail();
        if (email != null && !email.isEmpty()) {
            tfEmail.setText(email);
        }
    }

    /** 第一步：发送验证码到邮箱 */
    @FXML
    private void onSendCode() {
        String email = tfEmail.getText().trim();
        if (email.isEmpty() || !email.matches("^[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+$")) {
            showHint("请输入正确的邮箱", false);
            return;
        }
        btnSendCode.setDisable(true);
        btnSendCode.setText("发送中...");
        PresetMarketService.forgotPassword(email).whenComplete((r, err) -> Platform.runLater(() -> {
            btnSendCode.setDisable(false);
            btnSendCode.setText("获取验证码");
            if (err != null || r == null) {
                showHint("无法连接服务器，请检查服务是否已启动", false);
                return;
            }
            if (!r.isOk()) {
                showHint(r.errorMessage(), false);
                return;
            }
            // 服务端不再返回验证码；sent=false 表示邮件服务未配置/发送失败
            boolean sent = false;
            try {
                JsonObject data = r.data.getAsJsonObject();
                if (data.has("sent")) {
                    sent = data.get("sent").getAsBoolean();
                }
            } catch (Exception ignored) {
            }
            if (!sent) {
                showHint("验证码邮件发送失败：邮件服务未配置或不可用，请联系管理员", false);
            } else {
                showHint("验证码已发送到 " + email + "，请查收邮件", true);
            }
        }));
    }

    /** 第二步：验证码 + 新密码重置 */
    @FXML
    private void onReset() {
        String email = tfEmail.getText().trim();
        String code = tfCode.getText().trim();
        String pwd = tfNewPassword.getText();
        String confirm = tfConfirm.getText();
        if (email.isEmpty()) {
            showHint("请输入邮箱", false);
            return;
        }
        if (code.isEmpty()) {
            showHint("请输入验证码", false);
            return;
        }
        if (pwd.length() < 6) {
            showHint("新密码至少 6 位", false);
            return;
        }
        if (!pwd.equals(confirm)) {
            showHint("两次输入的密码不一致", false);
            return;
        }
        btnReset.setDisable(true);
        btnReset.setText("提交中...");
        PresetMarketService.resetPassword(email, code, pwd).whenComplete((r, err) -> Platform.runLater(() -> {
            btnReset.setDisable(false);
            btnReset.setText("重置密码");
            if (err != null || r == null) {
                showHint("无法连接服务器，请检查服务是否已启动", false);
                return;
            }
            if (!r.isOk()) {
                showHint(r.errorMessage(), false);
                return;
            }
            showHint("重置成功，请用新密码登录", true);
        }));
    }

    private void showHint(String msg, boolean success) {
        lblHint.setText(msg);
        lblHint.setStyle(success ? "-fx-text-fill: -qfx-success;" : "-fx-text-fill: -qfx-danger;");
        lblHint.setVisible(true);
    }
}

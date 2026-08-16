package com.qingframe.network;

import com.qingframe.ui.controller.MainController;
import javafx.application.Platform;
import javafx.fxml.FXML;
import javafx.fxml.Initializable;
import javafx.scene.control.Label;
import javafx.scene.control.TextField;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import javafx.stage.FileChooser;
import javafx.stage.Stage;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.net.URL;
import java.util.Base64;
import java.util.ResourceBundle;

/** 个人资料窗口：圆形头像展示/上传 + 昵称修改 + 退出登录 */
public class ProfileController implements Initializable {

    @FXML private ImageView ivAvatar;
    @FXML private TextField tfNickname;
    @FXML private TextField tfEmail;
    @FXML private Label lblUsername, lblHint;

    private MainController mainController;
    /** 当前头像（base64 data URL），null 表示未设置 */
    private String avatarDataUrl;

    public void init(MainController mainController) {
        this.mainController = mainController;
    }

    @Override
    public void initialize(URL url, ResourceBundle rb) {
        lblUsername.setText(ApiClient.isLoggedIn() ? TokenStore.loadUsername() : "");
        tfNickname.setText(TokenStore.loadNickname());
        String email = TokenStore.loadEmail();
        if (email != null) {
            tfEmail.setText(email);
        }
        avatarDataUrl = TokenStore.loadAvatar();
        loadAvatarImage();
    }

    /** 选择本地图片 → 居中裁剪为正方形 → 压缩 128x128 → base64 预览 */
    @FXML
    private void onChooseAvatar() {
        FileChooser fc = new FileChooser();
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("图片", "*.png", "*.jpg", "*.jpeg", "*.bmp"));
        File file = fc.showOpenDialog(ivAvatar.getScene().getWindow());
        if (file == null) return;
        try {
            BufferedImage src = ImageIO.read(file);
            if (src == null) {
                showHint("无法读取该图片，请换一张");
                return;
            }
            int side = Math.min(src.getWidth(), src.getHeight());
            int sx = (src.getWidth() - side) / 2;
            int sy = (src.getHeight() - side) / 2;
            BufferedImage thumb = new BufferedImage(128, 128, BufferedImage.TYPE_INT_ARGB);
            java.awt.Graphics2D g = thumb.createGraphics();
            g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION,
                    java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING,
                    java.awt.RenderingHints.VALUE_ANTIALIAS_ON);
            g.drawImage(src, 0, 0, 128, 128, sx, sy, sx + side, sy + side, null);
            g.dispose();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            ImageIO.write(thumb, "png", bos);
            avatarDataUrl = "data:image/png;base64," + Base64.getEncoder().encodeToString(bos.toByteArray());
            loadAvatarImage();
            lblHint.setVisible(false);
        } catch (Exception e) {
            showHint("头像读取失败: " + e.getMessage());
        }
    }

    @FXML
    private void onSave() {
        String nick = tfNickname.getText().trim();
        String email = tfEmail.getText().trim();
        if (nick.isEmpty()) {
            showHint("昵称不能为空");
            return;
        }
        if (!email.isEmpty() && !email.matches("^[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+$")) {
            showHint("邮箱格式不正确");
            return;
        }
        lblHint.setVisible(false);
        PresetMarketService.updateProfile(nick, avatarDataUrl, email.isEmpty() ? null : email)
                .whenComplete((r, err) -> Platform.runLater(() -> {
                    if (err != null || r == null || !r.isOk()) {
                        showHint(r == null ? "无法连接服务器" : r.errorMessage());
                        return;
                    }
                    TokenStore.saveNickname(nick);
                    if (avatarDataUrl != null) {
                        TokenStore.saveAvatar(avatarDataUrl);
                    }
                    if (!email.isEmpty()) {
                        TokenStore.saveEmail(email);
                    }
                    if (mainController != null) {
                        mainController.updateLoginUi();
                    }
                    close();
                }));
    }

    @FXML
    private void onLogout() {
        ApiClient.token = null;
        TokenStore.clear();
        if (mainController != null) {
            mainController.updateLoginUi();
        }
        close();
    }

    private void loadAvatarImage() {
        if (avatarDataUrl == null) {
            ivAvatar.setImage(null);
            return;
        }
        try {
            int comma = avatarDataUrl.indexOf(',');
            byte[] bytes = Base64.getDecoder().decode(avatarDataUrl.substring(comma + 1));
            ivAvatar.setImage(new Image(new ByteArrayInputStream(bytes)));
        } catch (Exception e) {
            ivAvatar.setImage(null);
        }
    }

    private void showHint(String msg) {
        lblHint.setText(msg);
        lblHint.setVisible(true);
    }

    private void close() {
        Stage stage = (Stage) tfNickname.getScene().getWindow();
        stage.close();
    }
}

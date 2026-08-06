package com.qingframe;

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
        FXMLLoader loader = new FXMLLoader(getClass().getResource("/com/qingframe/ui/MainView.fxml"));
        BorderPane root = loader.load();
        Scene scene = new Scene(root, 1400, 900);
        scene.getStylesheets().add(getClass().getResource("/com/qingframe/ui/css/dark-theme.css").toExternalForm());
        stage.getIcons().add(new Image(getClass().getResourceAsStream("/com/qingframe/ui/icons/app-icon-256.png")));
        stage.setTitle("清框影 QingFrameShadow - Image Border Editor");
        stage.setScene(scene);
        stage.setMinWidth(1100);
        stage.setMinHeight(700);
        stage.show();
    }

    public static Stage getPrimaryStage() {
        return primaryStage;
    }

    public static void main(String[] args) {
        launch(args);
    }
}

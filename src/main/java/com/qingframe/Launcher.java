package com.qingframe;

import javafx.application.Application;

/**
 * 独立启动器：主类不继承 Application，避免 JavaFX 在 classpath 运行模式下
 * 检查主类时误判"缺少 JavaFX 运行时组件"。
 * 打包与命令行运行时请使用本类作为 main-class。
 */
public class Launcher {

    public static void main(String[] args) {
        Application.launch(Main.class, args);
    }
}

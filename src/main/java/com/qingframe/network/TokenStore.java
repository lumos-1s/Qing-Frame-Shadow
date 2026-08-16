package com.qingframe.network;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/** 登录 token 本地存储：~/.qingframe/token，启动时自动恢复登录态 */
public final class TokenStore {

    private static final Path TOKEN_FILE = Paths.get(
            System.getProperty("user.home"), ".qingframe", "token");
    private static final Path USER_FILE = Paths.get(
            System.getProperty("user.home"), ".qingframe", "username");
    /** 欢迎页"下次不再显示"标记：~/.qingframe/skip-welcome */
    private static final Path SKIP_WELCOME_FILE = Paths.get(
            System.getProperty("user.home"), ".qingframe", "skip-welcome");
    /** 昵称本地缓存：~/.qingframe/nickname */
    private static final Path NICKNAME_FILE = Paths.get(
            System.getProperty("user.home"), ".qingframe", "nickname");
    /** 头像本地缓存（base64 data URL）：~/.qingframe/avatar */
    private static final Path AVATAR_FILE = Paths.get(
            System.getProperty("user.home"), ".qingframe", "avatar");

    private TokenStore() {
    }

    public static void save(String token) {
        try {
            Files.createDirectories(TOKEN_FILE.getParent());
            Files.writeString(TOKEN_FILE, token == null ? "" : token, StandardCharsets.UTF_8);
        } catch (IOException ignored) {
        }
    }

    public static void saveUsername(String username) {
        try {
            Files.createDirectories(USER_FILE.getParent());
            Files.writeString(USER_FILE, username == null ? "" : username, StandardCharsets.UTF_8);
        } catch (IOException ignored) {
        }
    }

    /** 保存昵称到本地缓存 */
    public static void saveNickname(String nickname) {
        try {
            Files.createDirectories(NICKNAME_FILE.getParent());
            Files.writeString(NICKNAME_FILE, nickname == null ? "" : nickname, StandardCharsets.UTF_8);
        } catch (IOException ignored) {
        }
    }

    /** 读取本地缓存的昵称，无则回退到用户名 */
    public static String loadNickname() {
        try {
            if (Files.exists(NICKNAME_FILE)) {
                String n = Files.readString(NICKNAME_FILE, StandardCharsets.UTF_8).trim();
                if (!n.isEmpty()) return n;
            }
        } catch (IOException ignored) {
        }
        return loadUsername();
    }

    /** 保存头像（base64 data URL）到本地缓存 */
    public static void saveAvatar(String avatar) {
        try {
            Files.createDirectories(AVATAR_FILE.getParent());
            Files.writeString(AVATAR_FILE, avatar == null ? "" : avatar, StandardCharsets.UTF_8);
        } catch (IOException ignored) {
        }
    }

    /** 读取本地缓存的头像（base64 data URL），无则返回 null */
    public static String loadAvatar() {
        try {
            if (!Files.exists(AVATAR_FILE)) return null;
            String a = Files.readString(AVATAR_FILE, StandardCharsets.UTF_8).trim();
            return a.isEmpty() ? null : a;
        } catch (IOException e) {
            return null;
        }
    }

    public static String loadUsername() {
        try {
            if (!Files.exists(USER_FILE)) return null;
            String u = Files.readString(USER_FILE, StandardCharsets.UTF_8).trim();
            return u.isEmpty() ? null : u;
        } catch (IOException e) {
            return null;
        }
    }

    public static String load() {
        try {
            if (!Files.exists(TOKEN_FILE)) return null;
            String t = Files.readString(TOKEN_FILE, StandardCharsets.UTF_8).trim();
            return t.isEmpty() ? null : t;
        } catch (IOException e) {
            return null;
        }
    }

    public static void clear() {
        try {
            Files.deleteIfExists(TOKEN_FILE);
            Files.deleteIfExists(USER_FILE);
            Files.deleteIfExists(NICKNAME_FILE);
            Files.deleteIfExists(AVATAR_FILE);
        } catch (IOException ignored) {
        }
    }

    /** 是否勾选过"启动不再显示欢迎页" */
    public static boolean loadSkipWelcome() {
        try {
            if (!Files.exists(SKIP_WELCOME_FILE)) return false;
            return "1".equals(Files.readString(SKIP_WELCOME_FILE, StandardCharsets.UTF_8).trim());
        } catch (IOException e) {
            return false;
        }
    }

    /** 保存"启动不再显示欢迎页"标记 */
    public static void saveSkipWelcome(boolean skip) {
        try {
            Files.createDirectories(SKIP_WELCOME_FILE.getParent());
            Files.writeString(SKIP_WELCOME_FILE, skip ? "1" : "", StandardCharsets.UTF_8);
        } catch (IOException ignored) {
        }
    }
}

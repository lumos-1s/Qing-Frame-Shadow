-- 清框影模板云市场建表脚本（MySQL 8/9 通用）
-- 执行：mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS qingframe
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE qingframe;

CREATE TABLE IF NOT EXISTS `user` (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  username      VARCHAR(50)  NOT NULL COMMENT '登录名',
  password_hash VARCHAR(100) NOT NULL COMMENT 'BCrypt 哈希',
  email         VARCHAR(100) NOT NULL DEFAULT '' COMMENT '邮箱（找回密码用）',
  nickname      VARCHAR(50)  NOT NULL DEFAULT '' COMMENT '昵称',
  avatar        MEDIUMTEXT   NULL COMMENT '头像 base64 data URL',
  role          VARCHAR(20)  NOT NULL DEFAULT 'user' COMMENT 'user/admin',
  status        TINYINT      NOT NULL DEFAULT 1 COMMENT '1正常 0禁用',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username)
) ENGINE = InnoDB COMMENT '用户表';

CREATE TABLE IF NOT EXISTS preset (
  id             BIGINT       NOT NULL AUTO_INCREMENT,
  user_id        BIGINT       NOT NULL COMMENT '上传者',
  name           VARCHAR(100) NOT NULL COMMENT '模板名',
  tag            VARCHAR(50)  NOT NULL DEFAULT '其他',
  description    VARCHAR(500) NOT NULL DEFAULT '',
  content_json   MEDIUMTEXT   NOT NULL COMMENT 'TemplateModel JSON',
  download_count INT          NOT NULL DEFAULT 0,
  like_count     INT          NOT NULL DEFAULT 0,
  status         TINYINT      NOT NULL DEFAULT 1 COMMENT '1正常 0下架',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tag (tag),
  KEY idx_download (download_count),
  KEY idx_user (user_id)
) ENGINE = InnoDB COMMENT '模板表';

CREATE TABLE IF NOT EXISTS preset_download_log (
  id         BIGINT      NOT NULL AUTO_INCREMENT,
  preset_id  BIGINT      NOT NULL,
  user_id    BIGINT      NULL COMMENT '未登录为 NULL',
  ip         VARCHAR(45) NOT NULL DEFAULT '',
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_preset (preset_id)
) ENGINE = InnoDB COMMENT '下载记录表';

CREATE TABLE IF NOT EXISTS preset_like (
  id         BIGINT   NOT NULL AUTO_INCREMENT,
  preset_id  BIGINT   NOT NULL,
  user_id    BIGINT   NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_preset_user (preset_id, user_id)
) ENGINE = InnoDB COMMENT '点赞表';

CREATE TABLE IF NOT EXISTS password_reset (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  user_id    BIGINT       NOT NULL COMMENT '用户 id',
  email      VARCHAR(100) NOT NULL COMMENT '接收验证码的邮箱',
  code       VARCHAR(10)  NOT NULL COMMENT '6 位验证码',
  used       TINYINT      NOT NULL DEFAULT 0 COMMENT '0未使用 1已使用',
  expires_at DATETIME     NOT NULL COMMENT '过期时间',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_email (email)
) ENGINE = InnoDB COMMENT '密码重置验证码表';

-- 存量库升级（已按旧版建过库时执行一次）：
-- ALTER TABLE `user` ADD COLUMN avatar MEDIUMTEXT NULL COMMENT '头像 base64 data URL' AFTER nickname;
-- ALTER TABLE `user` ADD COLUMN email VARCHAR(100) NOT NULL DEFAULT '' COMMENT '邮箱（找回密码用）' AFTER password_hash;

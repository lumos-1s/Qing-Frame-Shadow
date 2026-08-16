# 清框影 QingFrameShadow —— 双端（桌面端 + 服务端）启动指南

清框影由两个独立 Maven 项目组成，仅通过 HTTP + JSON 通信：

| 项目 | 位置 | 技术栈 | 职责 |
|---|---|---|---|
| qingframe-server | `C:\Users\lumos\Desktop\qingframe-server` | Java 17 + Spring Boot 3 + MyBatis + MySQL 8/9 + JWT | 模板云市场 API（用户/模板/点赞/下载） |
| QingFrameShadow | `C:\Users\lumos\Desktop\QingFrameShadow - 副本` | JavaFX 17 + Gson + JDK HttpClient | 照片加框编辑器 + 模板市场客户端 |

---

## 一、启动服务端

### 1. 启动 MySQL 并初始化数据库（只需一次）

```powershell
# 启动 MySQL 服务
Start-Service -Name "MySQL97"

# 建库建表（qingframe 库 + user/preset/preset_download_log/preset_like 四张表）
mysql -u root -p < C:\Users\lumos\Desktop\qingframe-server\src\main\resources\schema.sql
```

### 2. 启动后端

```powershell
cd C:\Users\lumos\Desktop\qingframe-server
# 设置数据库密码环境变量（Windows PowerShell）
$env:MYSQL_PASSWORD = "你的MySQL密码"
mvn spring-boot:run
```

验证：浏览器访问 <http://localhost:8080/api/health> 应返回 `{"code":0,"message":"ok","data":"..."}`。

> 密码也可写入 `application.yml` 的 `password` 字段（明文，仅本地开发推荐）。
> JWT 密钥可通过环境变量 `JWT_SECRET` 覆盖（默认值仅适合开发）。

### 3. 接口速查

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/register` | 否 | 注册 |
| POST | `/api/auth/login` | 否 | 登录，返回 token |
| GET | `/api/auth/me` | Bearer | 当前用户 |
| GET | `/api/presets?page=&size=&tag=&keyword=` | 否 | 模板分页列表（不含 contentJson） |
| GET | `/api/presets/{id}` | 否 | 详情（含 contentJson） |
| POST | `/api/presets` | Bearer | 上传模板 |
| PUT/DELETE | `/api/presets/{id}` | 本人/admin | 更新/删除 |
| POST | `/api/presets/{id}/download` | 否 | 下载（计数 +1） |
| POST/DELETE | `/api/presets/{id}/like` | Bearer | 点赞/取消 |
| GET | `/api/tags`、`/api/health` | 否 | 标签列表、健康检查 |

---

## 二、启动桌面端

```powershell
cd "C:\Users\lumos\Desktop\QingFrameShadow - 副本"
mvn javafx:run
```

或双击根目录 `run.bat`（自动配置 JDK17 环境）。

---

## 三、使用模板市场（双端联调）

1. 先启动服务端（见上），保持运行。
2. 启动桌面端 → 右侧 **模板** Tab → 点击 **打开模板市场**。
3. 市场窗口顶部可修改**服务器地址**（默认 `http://localhost:8080`，保存后持久化到 `~/.qingframe/server-url`）。
4. 点 **登录/注册** 创建账号（密码至少 6 位），勾选"记住登录"后 token 存于 `~/.qingframe/token`，下次自动登录。
5. 浏览/搜索模板（按标签过滤、按下载量排序），选中后点 **下载所选模板**：
   - 服务端返回的 `contentJson` 先经 `JsonUtil.isValidTemplate` 校验，合法才写入 `~/.qingframe/market-presets/`；
   - 主界面预设列表自动刷新，**应用预设**即可使用。
6. 在主界面编辑好模板后，点 **上传当前模板** 发布到市场（需登录）。

---

## 四、常见问题

| 现象 | 处理 |
|---|---|
| 市场窗口提示"无法连接服务器" | 确认服务端已 `mvn spring-boot:run`，端口 8080 未被占用；检查市场窗口顶部服务器地址 |
| 登录返回"用户名或密码错误" | 先注册；数据库被清过需重新注册 |
| 401"登录已过期" | token 过期（默认 24h），重新登录 |
| 下载提示"模板数据校验失败" | 服务端该模板的 contentJson 损坏，已拒绝落盘保护本地预设库 |
| 端口被占用 | `application.yml` 修改 `server.port`，桌面端市场窗口同步修改服务器地址 |

---

## 五、测试

```powershell
# 服务端单测（JWT/Result，不依赖数据库）
cd C:\Users\lumos\Desktop\qingframe-server && mvn test

# 桌面端单测（16 用例）
cd "C:\Users\lumos\Desktop\QingFrameShadow - 副本" && mvn test
```

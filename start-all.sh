#!/usr/bin/env bash
# 清框影 QingFrameShadow 双端一键启动（Ubuntu）
# 用法: ./start-all.sh          # 交互输入 MySQL 密码
#       ./start-all.sh 123456   # 直接传密码
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "========== 清框影 QingFrameShadow 一键启动 =========="

# 1. 检测/启动 MySQL
if systemctl is-active --quiet mysql 2>/dev/null; then
    echo "[1/3] MySQL 已在运行"
else
    echo "[1/3] 启动 MySQL..."
    sudo systemctl start mysql 2>/dev/null || sudo service mysql start || echo "[警告] MySQL 启动失败，请手动启动"
fi

# 2. 配置数据库密码环境变量
if [ -z "${MYSQL_PASSWORD:-}" ]; then
    if [ $# -ge 1 ] && [ -n "$1" ]; then
        export MYSQL_PASSWORD="$1"
    else
        read -rsp "请输入 MySQL root 密码: " MYSQL_PASSWORD
        echo
        export MYSQL_PASSWORD
    fi
fi

# 3. 后台启动服务端，并轮询健康检查
echo "[2/3] 启动服务端 (qingframe-server, 端口 8080)..."
(cd "$ROOT/qingframe-server" && mvn spring-boot:run > /tmp/qingframe-server.log 2>&1) &
SERVER_PID=$!
echo "      服务端进程 PID: $SERVER_PID (日志: /tmp/qingframe-server.log)"

READY=0
for i in $(seq 1 60); do
    sleep 1
    if curl -sf "http://localhost:8080/api/health" 2>/dev/null | grep -q '"code":0'; then
        READY=1
        break
    fi
    echo "      等待服务端就绪... ${i}/60s"
done

if [ "$READY" = "1" ]; then
    echo "[OK] 服务端已就绪: http://localhost:8080/api/health"
else
    echo "[警告] 服务端 60 秒内未就绪，请检查 /tmp/qingframe-server.log"
fi

# 4. 前台启动桌面端
echo "[3/3] 启动桌面端 (QingFrameShadow)..."
mvn javafx:run || true
echo "桌面端已退出。服务端仍在后台运行 (PID: $SERVER_PID)，停止命令: kill $SERVER_PID"

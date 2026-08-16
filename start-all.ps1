<#
清框影 QingFrameShadow 双端一键启动（Windows PowerShell）

用法:
  .\start-all.ps1                  # 交互输入 MySQL 密码
  .\start-all.ps1 -MysqlPassword 123456
  .\start-all.ps1 -SkipServer      # 仅启动桌面端（服务端已运行）
#>
param(
    [string]$MysqlPassword = "",
    [switch]$SkipServer
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$serverProc = $null

Write-Host "========== 清框影 QingFrameShadow 一键启动 =========="

# 1. 检测 MySQL 服务并启动（服务名与 qingframe-server/README.md 一致）
try {
    $svc = Get-Service -Name "MySQL97" -ErrorAction Stop
    if ($svc.Status -ne "Running") {
        Write-Host "[1/3] 启动 MySQL 服务 (MySQL97)..."
        Start-Service -Name "MySQL97"
    } else {
        Write-Host "[1/3] MySQL 服务已在运行"
    }
} catch {
    Write-Host "[1/3][警告] 未找到 MySQL97 服务，请确认 MySQL 已安装并手动启动"
}

# 2. 配置数据库密码环境变量（服务端 application.yml 读取 ${MYSQL_PASSWORD}）
if ([string]::IsNullOrEmpty($env:MYSQL_PASSWORD)) {
    if ([string]::IsNullOrEmpty($MysqlPassword)) {
        $env:MYSQL_PASSWORD = Read-Host "请输入 MySQL root 密码"
    } else {
        $env:MYSQL_PASSWORD = $MysqlPassword
    }
}

# 3. 后台启动服务端（隐藏窗口），并轮询健康检查
if (-not $SkipServer) {
    Write-Host "[2/3] 启动服务端 (qingframe-server, 端口 8080)..."
    $serverProc = Start-Process -FilePath "mvn.cmd" -ArgumentList "spring-boot:run" `
        -WorkingDirectory (Join-Path $Root "qingframe-server") `
        -WindowStyle Hidden -PassThru
    Write-Host "      服务端进程 PID: $($serverProc.Id)"

    $ready = $false
    for ($i = 1; $i -le 60; $i++) {
        Start-Sleep -Seconds 1
        try {
            $resp = Invoke-RestMethod -Uri "http://localhost:8080/api/health" -TimeoutSec 2
            if ($resp.code -eq 0) { $ready = $true; break }
        } catch { }
        Write-Host "      等待服务端就绪... ${i}/60s"
    }
    if ($ready) {
        Write-Host "[OK] 服务端已就绪: http://localhost:8080/api/health"
    } else {
        Write-Host "[警告] 服务端 60 秒内未就绪，请检查数据库密码或端口占用"
    }
} else {
    Write-Host "[2/3] 已跳过服务端启动"
}

# 4. 前台启动桌面端
Write-Host "[3/3] 启动桌面端 (QingFrameShadow)..."
try {
    mvn javafx:run
} finally {
    if ($serverProc -ne $null -and -not $serverProc.HasExited) {
        Write-Host ""
        Write-Host "桌面端已退出。服务端仍在后台运行 (PID: $($serverProc.Id))，如需停止："
        Write-Host "  Stop-Process -Id $($serverProc.Id)"
    }
}

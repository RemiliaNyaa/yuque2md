@echo off
chcp 65001 >nul 2>&1
title 语雀文档下载工具

:: 检查 Node.js 是否安装
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Node.js，请先安装: https://nodejs.org/
    pause
    exit /b 1
)

:: 首次运行：安装依赖
if not exist "node_modules\" (
    echo [1/3] 首次运行，正在安装依赖（淘宝镜像）...
    call npm install --registry=https://registry.npmmirror.com
    if %errorlevel% neq 0 (
        echo ❌ 依赖安装失败，请检查网络后重试
        pause
        exit /b 1
    )
    echo ✅ 依赖安装完成
    echo.
) else (
    echo 📦 依赖已安装，跳过
    echo.
)

:: 杀掉占用 3456 端口的进程
echo [2/3] 清理 3456 端口...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3456" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo   端口已就绪
echo.

:: 启动服务并打开浏览器
echo [3/3] 启动服务...
start "" http://localhost:3456
echo   浏览器已打开，若未自动弹出请手动访问 http://localhost:3456
echo   关闭此窗口将停止服务
echo.
node server.js
pause

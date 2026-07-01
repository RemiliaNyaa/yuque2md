@echo off
chcp 65001 >nul
title 语雀文档下载工具

:: 首次运行：安装依赖（使用淘宝镜像）
if not exist "node_modules\" (
    echo [1/3] 首次运行，正在安装依赖...
    npm install --registry=https://registry.npmmirror.com
    if %errorlevel% neq 0 (
        echo ❌ 依赖安装失败，请检查网络后重试
        pause
        exit /b 1
    )
    echo ✅ 依赖安装完成
) else (
    echo 📦 依赖已安装，跳过
)

:: 杀掉占用 3456 端口的进程
echo [2/3] 清理端口...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3456" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)

:: 启动服务
echo [3/3] 启动服务...
start "" http://localhost:3456
node server.js
pause

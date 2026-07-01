@echo off
setlocal enabledelayedexpansion
set NODE_OPTIONS=
title yuque2md

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from: https://nodejs.org/
    pause
    exit /b 1
)

:: First run: install dependencies via taobao mirror
if not exist "node_modules\" (
    echo [1/3] First run - installing dependencies...
    call npm install --registry=https://registry.npmmirror.com
    if !errorlevel! neq 0 (
        echo [ERROR] npm install failed. Check network and retry.
        pause
        exit /b 1
    )
    echo Done.
    echo.
) else (
    echo Dependencies already installed.
    echo.
)

:: Kill process on port 3456
echo [2/3] Cleaning port 3456...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3456" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo Port ready.
echo.

:: Launch server and browser
echo [3/3] Starting server...
start "" http://localhost:3456
echo Browser opened. If not, visit http://localhost:3456
echo Close this window to stop the server.
echo.
node server.js
pause

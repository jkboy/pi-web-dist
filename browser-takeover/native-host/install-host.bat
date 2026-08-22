@echo off
rem ============================================================
rem 注册 Native Messaging Host（Windows，Brave + Chrome）
rem
rem 步骤：
rem   1. 先到浏览器地址栏加载扩展（brave://extensions 开启开发者模式 → 加载已解压的扩展）
rem   2. 记下该扩展的 ID（形如 aaaabbbbccccdddd... 32 位十六进制）
rem   3. 运行本脚本，输入扩展 ID
rem   4. 脚本自动：
rem        - 生成含正确路径和扩展 ID 的 manifest
rem        - 写入 HKCU 注册表，注册给 Brave 和 Chrome
rem
rem 卸载：运行 install-host.bat uninstall
rem ============================================================

setlocal

if "%1"=="uninstall" goto uninstall

set "HOST_NAME=com.example.browser_takeover"
set "HOST_DIR=%~dp0"
set "HOST_CMD=%HOST_DIR%host.cmd"

rem ---- 请求扩展 ID ----
set /p EXT_ID=请输入扩展 ID（brave://extensions 里那一串）： 
if "%EXT_ID%"=="" (
  echo [错误] 未输入扩展 ID
  exit /b 1
)

rem ---- 生成 manifest（把路径和 ID 替换进模板）----
rem 注意：path 不要加双引号——Chromium 把 path 当文件名，带引号会报 host not found。
set "MANIFEST=%HOST_DIR%com.example.browser_takeover.json"
(
  echo {
  echo   "name": "%HOST_NAME%",
  echo   "description": "QikaCode - Native Messaging Host",
  echo   "path": "%HOST_CMD%",
  echo   "type": "stdio",
  echo   "allowed_origins": [
  echo     "chrome-extension://%EXT_ID%/"
  echo   ]
  echo }
) > "%MANIFEST%"
echo [OK] 已生成 manifest: %MANIFEST%

rem ---- 写入注册表（Brave 和 Chrome 各一份）----
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /ve /d "%MANIFEST%" /f
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /d "%MANIFEST%" /f
echo [OK] 已注册到 Brave 和 Chrome 的 NativeMessagingHosts

echo.
echo 完成！接下来：
echo   1. 完全关闭并重启 Brave（让注册表生效）
echo   2. 重开 brave://extensions 确认扩展已加载
echo   3. 打开一个网页，扩展会自动连接 host
echo   4. 另开终端跑: node cli/drive.js
exit /b 0

:uninstall
set "HOST_NAME=com.example.browser_takeover"
reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /f 2>nul
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /f 2>nul
echo [OK] 已注销 Native Messaging Host
exit /b 0

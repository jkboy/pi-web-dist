@echo off
setlocal
rem Register the Native Messaging Host with Brave/Chrome (HKCU).
rem NOTE: run "node setup-host.js" FIRST to generate com.example.browser_takeover.json
rem with the correct absolute path for THIS machine.
set "HOST_NAME=com.example.browser_takeover"
set "MANIFEST=%~dp0com.example.browser_takeover.json"

if not exist "%MANIFEST%" (
  echo [ERROR] %MANIFEST% not found.
  echo Please run:  node setup-host.js
  echo then re-run this script.
  exit /b 1
)

reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f

echo.
echo Done. Verify Brave:
reg query "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /ve
endlocal

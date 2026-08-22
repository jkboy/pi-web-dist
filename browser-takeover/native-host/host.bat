@echo off
rem Browser takeover Native Messaging Host launcher (Windows)
rem NOTE: keep this file ASCII-only. cmd.exe mangles UTF-8 Chinese comments
rem and may mis-parse the batch, corrupting the native messaging pipe.
node "%~dp0host.js"

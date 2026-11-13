@echo off
chcp 65001 >nul
title Codex Web（局域网）
rem 双击运行：开放局域网访问，使用终端打印的带令牌网址
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js，请先安装：https://nodejs.org
  echo.
  pause
  exit /b 1
)
node "%~dp0server.js" --cwd "%USERPROFILE%" --lan %*
pause

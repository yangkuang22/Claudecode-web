@echo off
chcp 65001 >nul
title Claude Web
rem 双击运行：启动 Claude Web 并自动打开浏览器（默认项目为用户主目录，网页里可切换）
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js，请先安装：https://nodejs.org
  echo.
  pause
  exit /b 1
)
node "%~dp0server.js" --cwd "%USERPROFILE%" %*
pause

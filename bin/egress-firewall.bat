@echo off
chcp 65001 >nul
rem 双击运行：给 claude.exe 加防火墙规则，只许它连本机代理。加 -Remove 参数删除规则
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0egress-firewall.ps1" %*

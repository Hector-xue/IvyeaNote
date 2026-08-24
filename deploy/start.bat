@echo off
rem Ivyea Note one-click launcher for Windows (double-click me)
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo [Ivyea Note] Wei jian ce dao Docker.
  echo Qing xian an zhuang Docker Desktop: https://www.docker.com/products/docker-desktop/
  echo An zhuang bing qi dong ta, deng you xia jiao tu biao bian lv hou, zai shuang ji ben wen jian.
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo [Ivyea Note] Docker yi an zhuang dan wei yun xing.
  echo Qing da kai Docker Desktop, deng ta wan quan qi dong hou zai shuang ji ben wen jian.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $src=[IO.File]::ReadAllText('%~dp0windows-helper.ps1',[Text.Encoding]::UTF8); Invoke-Expression $src"
if errorlevel 1 (
  echo.
  echo [Ivyea Note] Chu cuo le, qing kan shang fang hong se bao cuo xin xi.
  pause
  exit /b 1
)
pause

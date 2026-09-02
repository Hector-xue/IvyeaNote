@echo off
rem Ivyea Note one-click launcher for Windows (double-click me)
rem
rem v0.10.5: bu zai qiang zhi yao qiu Docker.
rem   Fu wu duan mo ren yong SQLite, mi yao he guan li yuan zhang hao dou zi dong sheng cheng,
rem   suo yi ta jiu shi "yi ge exe pao qi lai jiu wan shi". Docker shi zi zhao de.
rem   Yi qian zhe ge wen jian di 7 hang jiu zai `where docker`, jian ce bu dao jiu rang ni
rem   qu zhuang Docker Desktop -- er pang bian de ivnote-win-setup.ps1 ming ming shi mian Docker de.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ---------- Lu jing 1: ben di ke zhi xing wen jian (tui jian, wu yi lai) ----------
if exist "ivnote-server.exe" (
  echo [Ivyea Note] Zhao dao ivnote-server.exe, zhi jie qi dong ^(SQLite mo shi, wu xu Docker^).
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ivnote-win-setup.ps1"
  goto :done
)

rem ---------- Lu jing 2: Docker ----------
where docker >nul 2>nul
if not errorlevel 1 (
  docker info >nul 2>nul
  if not errorlevel 1 (
    echo [Ivyea Note] Wei zhao dao ivnote-server.exe, gai yong Docker qi dong.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $src=[IO.File]::ReadAllText('%~dp0windows-helper.ps1',[Text.Encoding]::UTF8); Invoke-Expression $src"
    if errorlevel 1 (
      echo.
      echo [Ivyea Note] Chu cuo le, qing kan shang fang bao cuo xin xi.
    )
    goto :done
  )
)

rem ---------- Liang tiao lu dou zou bu tong: gao su yong hu zui jian dan de na tiao ----------
echo.
echo [Ivyea Note] Hai que yi ge fu wu duan cheng xu.
echo.
echo   Zui jian dan de zuo fa ^(bu xu yao Docker^):
echo   1^) Da kai xiang mu de GitHub Releases ye
echo   2^) Xia zai  ivnote-server-windows-amd64.exe
echo   3^) Ba ta fang dao ben mu lu, chong ming ming wei  ivnote-server.exe
echo   4^) Zai ci shuang ji ben wen jian
echo.
echo   ^(ru guo ni de dian nao shi ARM jia gou, xia  ivnote-server-windows-arm64.exe^)
echo.

:done
pause

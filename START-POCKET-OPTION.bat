@echo off
setlocal
title Pocket Option Background - Update and Launch
cd /d "%~dp0"

echo.
echo ================================================
echo   Pocket Option Background
echo   Update source code and launch
echo ================================================
echo.

if not exist ".git" (
  echo [ERROR] Git repository not found in this folder.
  echo Clone first: https://github.com/Maestro-777/pocket-option-app
  goto :failed
)

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Git for Windows is not installed or not in PATH.
  goto :failed
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 22 LTS or newer is required.
  goto :failed
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js with npm.
  goto :failed
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer is required. Installed version:
  node --version
  goto :failed
)

echo [1/4] Updating source code from origin/main...
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo [ERROR] Could not update source code.
  echo Check your internet connection and local changes.
  echo Local changes are not overwritten.
  goto :failed
)

echo.
echo [2/4] Installing dependencies...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  goto :failed
)

echo.
echo [3/4] Checking source code...
call npm run check
if errorlevel 1 (
  echo [ERROR] Source checks failed. Launch cancelled.
  goto :failed
)

echo.
echo [4/4] Launching application...
call npm start
set "APP_EXIT=%ERRORLEVEL%"

echo.
echo Application exited with code %APP_EXIT%.
pause
exit /b %APP_EXIT%

:failed
echo.
echo Fix the problem shown above, then run this file again.
pause
exit /b 1

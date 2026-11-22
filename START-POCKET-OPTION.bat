@echo off
setlocal
title Pocket Option Background - Update and Launch

echo.
echo ================================================
echo   Pocket Option Background
echo   Download, update and launch
echo ================================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Git for Windows is required. Install Git, then run this file again.
  goto :failed
)

rem If this BAT is already inside the cloned repository, use that folder.
if exist "%~dp0.git" (
  set "PROJECT_DIR=%~dp0"
  goto :project_ready
)

rem Otherwise keep the repository in a subfolder next to this BAT.
set "PROJECT_DIR=%~dp0pocket-option-app"

if not exist "%PROJECT_DIR%\.git" (
  if exist "%PROJECT_DIR%" (
    echo [ERROR] The folder "%PROJECT_DIR%" exists but is not a Git repository.
    echo Rename or remove that folder, then run this file again.
    goto :failed
  )
  echo [1/5] Downloading the application source code...
  git clone https://github.com/Maestro-777/pocket-option-app "%PROJECT_DIR%"
  if errorlevel 1 (
    echo [ERROR] Could not download the repository. Check your internet connection.
    goto :failed
  )
)

:project_ready
cd /d "%PROJECT_DIR%"
if errorlevel 1 (
  echo [ERROR] Could not open the project folder.
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

echo [2/5] Updating source code...
git pull --ff-only origin main
if errorlevel 1 (
  echo [ERROR] Could not update source code. Check internet and local changes.
  goto :failed
)

echo.
echo [3/5] Installing dependencies...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  goto :failed
)

echo.
echo [4/5] Checking source code...
call npm run check
if errorlevel 1 (
  echo [ERROR] Source checks failed. Launch cancelled.
  goto :failed
)

echo.
echo [5/6] Running regression tests...
call npm test
if errorlevel 1 (
  echo [ERROR] Regression tests failed. Launch cancelled.
  goto :failed
)

echo.
echo [6/6] Launching application...
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

@echo off
chcp 65001 >nul
setlocal
title Pocket Option Background - обновление и запуск

cd /d "%~dp0"
echo.
echo ================================================
echo   Pocket Option Background
echo   Обновление исходников и запуск
echo ================================================
echo.

if not exist ".git" (
  echo [ОШИБКА] Папка .git не найдена.
  echo Сначала клонируйте репозиторий:
  echo https://github.com/Maestro-777/pocket-option-app
  goto :failed
)

where git >nul 2>&1
if errorlevel 1 (
  echo [ОШИБКА] Git не найден. Установите Git for Windows.
  goto :failed
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден. Установите Node.js 22 LTS или новее.
  goto :failed
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ОШИБКА] npm не найден. Переустановите Node.js с npm.
  goto :failed
)

for /f "delims=" %%V in ('node -p "Number(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%V
if not defined NODE_MAJOR (
  echo [ОШИБКА] Не удалось определить версию Node.js.
  goto :failed
)
if %NODE_MAJOR% LSS 22 (
  echo [ОШИБКА] Требуется Node.js 22 или новее. Установлена версия:
  node --version
  goto :failed
)

echo [1/4] Получаю последние исходники из ветки main...
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo [ОШИБКА] Не удалось обновить исходники.
  echo Проверьте интернет и локальные изменения в папке проекта.
  echo Скрипт не перезаписывает ваши локальные изменения.
  goto :failed
)

echo.
echo [2/4] Устанавливаю/обновляю зависимости...
call npm install
if errorlevel 1 (
  echo [ОШИБКА] npm install завершился с ошибкой.
  goto :failed
)

echo.
echo [3/4] Проверяю исходники...
call npm run check
if errorlevel 1 (
  echo [ОШИБКА] Проверка исходников не пройдена. Запуск отменён.
  goto :failed
)

echo.
echo [4/4] Запускаю приложение...
echo Для следующего запуска снова используйте этот BAT-файл.
echo.
call npm start
set APP_EXIT=%ERRORLEVEL%

echo.
echo Приложение завершило работу (код: %APP_EXIT%).
pause
exit /b %APP_EXIT%

:failed
echo.
echo Исправьте указанную выше проблему и запустите BAT-файл снова.
pause
exit /b 1

@echo off
chcp 65001 >nul
REM Vicem — Windows 1-Click Setup Launcher
REM Double-click this file (setup.bat) in Explorer to complete automatic setup.

cd /d "%~dp0"
node "%~dp0vicem.mjs" setup
if errorlevel 1 (
  echo [ERR] Vicem setup failed. Check the error above and try again.
  exit /b 1
)
echo.
echo ================================================================
echo [OK] Vicem 1-Click Setup Complete!
echo      You can now run 'node vicem.mjs' or 'vicem' in any project.
echo ================================================================
if "%1"=="" pause

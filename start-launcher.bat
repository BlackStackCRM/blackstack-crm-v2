@echo off
chcp 65001 >nul
cls
echo ========================================
echo   BlackStack CRM V2 - Server Launcher
echo ========================================
echo.
echo The launcher is the always-running gateway on port 3000.
echo When the CRM backend is stopped, it shows a "Server Offline" page
echo with a Start button. When the CRM is running, it proxies to it.
echo.
echo Open http://localhost:3000 in your browser.
echo.
echo ========================================
echo.

REM Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed. Please install Node.js >= 18 from https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js detected:
node --version
echo.

REM Start the launcher from the project root
cd /d "%~dp0"
node launcher/app.js

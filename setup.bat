@echo off
chcp 65001 >nul
echo ========================================
echo   BlackStack CRM V2 - Setup
echo ========================================
echo.

REM Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed. Please install Node.js >= 18 from https://nodejs.org/
    pause
    exit /b 1
)

echo [1/5] Node.js detected
echo.

REM Install dependencies
echo [2/5] Installing dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)
echo.

REM Create data directory
echo [3/5] Creating data directory...
if not exist data mkdir data
echo.

REM Run migrations
echo [4/5] Running database migrations...
node setup.js
if errorlevel 1 (
    echo ERROR: Setup failed
    pause
    exit /b 1
)
echo.

REM Start server
echo [5/5] Setup complete!
echo.
echo Starting server...
echo.
echo Open http://localhost:3000 in your browser
echo.
call npm run dev

@echo off
REM ============================================================
REM  Shanhai Bestiary Archive Console - one click dev server
REM  Double-click this file. Keep the console open while using.
REM  Close the window or press Ctrl+C to stop.
REM ============================================================
setlocal
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 goto NO_NPM

if not exist "node_modules" (
  echo.
  echo   node_modules not found. Running npm install first...
  echo.
  call npm install
  if errorlevel 1 goto FAILED
)

echo.
echo   Starting dev server...
echo   Open  http://127.0.0.1:5173/  in your browser.
echo.
call npm run dev
goto END

:NO_NPM
echo.
echo   [ERROR] npm not found. Install Node.js first:
echo   https://nodejs.org/
echo.
pause
goto END

:FAILED
echo.
echo   [ERROR] npm install failed. Check the network and try again.
echo.
pause

:END
echo.
echo   Server stopped.
pause

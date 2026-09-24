@echo off
setlocal EnableExtensions

rem P1b one-click launcher for Windows.
rem Keep this file ASCII-only so cmd.exe does not misparse UTF-8 text.
cd /d "%~dp0"

echo [P1b] Osteosome launcher
echo [P1b] Working directory: %CD%
echo.

where pnpm.cmd >nul 2>nul
if errorlevel 1 (
  echo [P1b] ERROR: pnpm was not found in PATH.
  echo [P1b] Install Node.js and pnpm, then run this file again.
  pause
  exit /b 1
)

echo [P1b] Building Core, SDK, hello service, and client...
call pnpm.cmd build
if errorlevel 1 (
  echo.
  echo [P1b] ERROR: build failed. Review the log above.
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo [P1b] ERROR: port 1420 is already in use. Close the existing Core process first.
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo [P1b] ERROR: port 5173 is already in use. Close the existing Vite process first.
  pause
  exit /b 1
)

echo [P1b] Starting Core on port 1420...
start "Osteosome Core" /D "%~dp0" cmd.exe /k node core\dist\main.js --services "%~dp0\services" --data "%~dp0\.data" --dist "%~dp0\core\dist\client"

rem Wait for Core instead of opening the browser too early.
for /l %%I in (1,1,20) do (
  powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
  if not errorlevel 1 goto core_ready
  timeout /t 1 /nobreak >nul
)
echo [P1b] ERROR: Core did not open port 1420. Check the Core window.
pause
exit /b 1

:core_ready
echo [P1b] Core is ready. Starting client on port 5173...
start "Osteosome Client" /D "%~dp0client" cmd.exe /k node_modules\.bin\vite.cmd --host 127.0.0.1 --port 5173

rem Wait for Vite before opening the browser.
for /l %%I in (1,1,20) do (
  powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
  if not errorlevel 1 goto client_ready
  timeout /t 1 /nobreak >nul
)
echo [P1b] ERROR: client did not open port 5173. Check the Client window.
pause
exit /b 1

:client_ready
start "" "http://127.0.0.1:5173/"

echo.
echo [P1b] Two server windows were opened.
echo [P1b] Close the Core and Client windows to stop the servers.
echo.
pause
endlocal

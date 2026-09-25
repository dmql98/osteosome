@echo off
setlocal EnableExtensions
rem ==========================================================================
rem  Osteosome client launcher - dev: run the CLIENT app (not webui)
rem
rem  Goal: build the Tauri shell once; afterwards edit frontend/backend and
rem        run the client directly without repacking the shell.
rem
rem  How:
rem    tauri dev incrementally compiles the debug shell (shell Rust unchanged
rem    -> reuse cache, no repack)
rem    -> opens the real native client window -> loads localhost:5173 (Vite)
rem    -> frontend HMR auto-refreshes, shell untouched; backend (Core) changes
rem       only need a Core restart.
rem
rem  Prereqs:
rem    1. Tauri shell present (repo has src-tauri/ with devUrl=http://localhost:5173)
rem    2. pnpm and Rust toolchain (cargo) installed
rem
rem  IMPORTANT: Keep this file ASCII-only so cmd.exe does not misparse UTF-8.
rem ==========================================================================
cd /d "%~dp0"

echo [client] Osteosome client launcher (Tauri shell)
echo [client] Working directory: %CD%
echo.

where pnpm.cmd >nul 2>nul
if errorlevel 1 (
  echo [client] ERROR: pnpm was not found in PATH.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [client] ERROR: cargo / Rust was not found in PATH.
  echo [client] Install Rust toolchain, then run this file again.
  pause
  exit /b 1
)

if not exist "%~dp0src-tauri\Cargo.toml" (
  echo [client] WARNING: src-tauri/ not found. Tauri shell has not been scaffolded yet.
  echo [client] This script will still start Core + Vite, then open the webui fallback.
  echo [client] Once you scaffold Tauri, uncomment the tauri dev step.
  echo.
)

echo [client] Starting Core on port 1420...
start "Osteosome Core" /D "%~dp0" cmd.exe /k node core\dist\main.js --services "%~dp0\services" --data "%~dp0\.data" --dist "%~dp0\core\dist\client"

for /l %%I in (1,1,20) do (
  powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
  if not errorlevel 1 goto core_ready
  timeout /t 1 /nobreak >nul
)
echo [client] ERROR: Core did not open port 1420. Check the Core window.
pause
exit /b 1

:core_ready
echo [client] Core is ready. Starting Vite dev on port 5173...
start "Osteosome Vite" /D "%~dp0client" cmd.exe /k node_modules\.bin\vite.cmd --host 127.0.0.1 --port 5173

for /l %%I in (1,1,20) do (
  powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
  if not errorlevel 1 goto vite_ready
  timeout /t 1 /nobreak >nul
)
echo [client] ERROR: Vite did not open port 5173. Check the Vite window.
pause
exit /b 1

:vite_ready
if not exist "%~dp0src-tauri\Cargo.toml" goto webui_fallback

echo [client] Vite ready. Launching Tauri shell (client window)...
rem -------------------------------------------------------------------------
rem  Tauri dev: opens the native client window, loading localhost:5173.
rem  Shell Rust unchanged -> incremental build, no repack; frontend HMR
rem  auto-refreshes; backend changes only need a Core restart.
rem
rem  Windows prereqs (first time only, one-time):
rem    1. Rust: rustup install stable-msvc (includes cargo)
rem    2. MSVC build tools: Visual Studio 2022 -> install
rem         - C++ desktop development (Microsoft.VisualStudio.Component.VC.Tools.x86.x64)
rem         - Windows 10 SDK (Microsoft.VisualStudio.Component.Windows10SDK.19041)
rem        Missing Windows SDK -> compile error LNK1181 cannot find kernel32.lib
rem    3. src-tauri deps: pnpm install (includes @tauri-apps/cli)
rem -------------------------------------------------------------------------
cd /d "%~dp0"

rem Try to locate MSVC environment (vswhere -> vcvarsall). Leave to user if missing.
set "VS_INSTALL="
set "VCVARSALL="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
  for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_INSTALL=%%i"
)
if defined VS_INSTALL (
  set "VCVARSALL=%VS_INSTALL%\VC\Auxiliary\Build\vcvarsall.bat"
)

if defined VCVARSALL (
  if exist "%VCVARSALL%" (
    echo [client] Loading MSVC env from %VS_INSTALL%
    call "%VCVARSALL%" x64 >nul 2>&1
  ) else (
    echo [client] WARNING: vcvarsall not found at %VCVARSALL%
  )
) else (
  echo [client] WARNING: MSVC build tools / Windows SDK not found.
  echo [client]   Install via VS Installer: VC Tools + Windows 10 SDK, then rerun.
  echo [client]   Compiling the Tauri shell will fail with LNK1181 until then.
)

start "Osteosome Client (Tauri)" cmd.exe /k pnpm.cmd --filter @osteosome/tauri-app tauri dev
echo.
echo [client] Client window launched. Frontend HMR will auto-refresh.
echo [client] Close the Core / Vite / Client windows to stop.
echo.
pause
endlocal
exit /b 0

:webui_fallback
echo [client] Tauri shell not scaffolded yet - opening webui fallback (dev/debug only).
start "" "http://127.0.0.1:5173/"
echo.
echo [client] NOTE: Osteosome is a client-first product; webui is dev/debug only.
echo [client] Close the Core and Vite windows to stop.
echo.
pause
endlocal

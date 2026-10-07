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

rem -------------------------------------------------------------------------
rem  Node runtime check (P3-0). The repo pins no runtime, and node:sqlite
rem  (the P3-1 storage path) needs Node >= 22.5. Fail fast right here with the
rem  exact detected version and a download link, instead of letting a stale
rem  Node blow up later inside a service process nobody is watching.
rem  Keep this file ASCII-only (see header).
rem -------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [client] ERROR: node was not found in PATH.
  echo [client] Install Node.js 22.5+ from https://nodejs.org/en/download then rerun.
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "try { $v = [Version]((node --version).TrimStart('v')); if ($v -lt [Version]'22.5.0') { Write-Host ('[client] ERROR: Node ' + $v + ' is too old; need >= 22.5.0 for node:sqlite. Download: https://nodejs.org/en/download'); exit 1 } } catch { Write-Host '[client] ERROR: could not parse the Node version.'; exit 1 }"
if errorlevel 1 (
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

rem -------------------------------------------------------------------------
rem  Build the Core runtime (shared / service-sdk / services / core) so that
rem  core\dist\main.js exists before we start it. Excludes the Tauri shell
rem  (tauri build needs the packaged web assets) and the client (served by
rem  Vite in dev, no build needed).
rem -------------------------------------------------------------------------
echo [client] Building Core runtime (shared / sdk / services / core)...
call pnpm.cmd -r --filter "!@osteosome/tauri-app" --filter "!@osteosome/client" run build
if errorlevel 1 (
  echo [client] ERROR: Core build failed. Review the log above.
  pause
  exit /b 1
)

rem -------------------------------------------------------------------------
rem  Stop a stale Core first: whoever still holds 1420 wins, and the Core we
rem  launch below cannot bind. This is worse than a plain "port busy":
rem
rem    - a fresh build runs migratePluginOwnedData() BEFORE bridge.listen()
rem      (one-time data move), so the new Core relocates the data and *then*
rem      exits on bind failure -- silently, because its output goes to a window
rem      nobody is reading;
rem    - the client then keeps talking to the OLD build, so the UI half-updates:
rem      new bus commands rejected with 400 while old ones still work. Symptom we
rem      actually hit: session view fine (llm.provider.* exists in both builds),
rem      settings view blank (models.* only exists in the new one).
rem
rem  Safety: only a process whose command line looks like our Core entry
rem  (core\dist\main.js) is killed. Anything else on 1420 is reported, not
rem  touched -- this script must never take out a stranger's process.
rem -------------------------------------------------------------------------
set "PORT_STATE="
for /f "usebackq delims=" %%s in (`powershell.exe -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess) -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -and $p.CommandLine -like '*core*dist*main.js*') { 'PID:' + $p.ProcessId } else { 'OTHER:' + $c.OwningProcess } }"`) do set "PORT_STATE=%%s"

if not defined PORT_STATE goto no_stale_core
for /f "tokens=2 delims=:" %%p in ("%PORT_STATE%") do set "OWNER_PID=%%p"

if /i "%PORT_STATE:~0,5%"=="OTHER" goto foreign_port

echo [client] Port 1420 is held by a stale Osteosome Core (PID %OWNER_PID%) - stopping it.
taskkill /PID %OWNER_PID% /T /F >nul 2>nul
rem wait for the port to actually come back, otherwise the new Core loses the race
for /l %%I in (1,1,10) do (
  powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
  if errorlevel 1 goto port_free
  timeout /t 1 /nobreak >nul
)
echo [client] ERROR: port 1420 is still held after stopping PID %OWNER_PID%.
echo [client] Close that process by hand, then run this script again.
pause
exit /b 1

:foreign_port
echo [client] ERROR: port 1420 is held by PID %OWNER_PID%, and it is NOT an Osteosome Core.
echo [client] Refusing to kill it. Free the port, then run this script again.
pause
exit /b 1

:no_stale_core
echo [client] Port 1420 is free.

:port_free
echo [client] Starting Core on port 1420...
rem data dir is NOT passed on the command line any more: the default is repo-root
rem userData, and an explicit ost.config.json overrides it. Passing --data here
rem would outrank that file, so settings would silently stop working.
start "Osteosome Core" /D "%~dp0" cmd.exe /k node core\dist\main.js --plugins "%~dp0\plugins" --dist "%~dp0\core\dist\client"

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

rem NOTE: keep %VS_INSTALL% / %VCVARSALL% out of the parenthesised blocks below.
rem The default path contains "Program Files (x86)": its ")" would close the
rem block early and abort the script before the Tauri window is launched.
if defined VS_INSTALL echo [client] VS install path: %VS_INSTALL%

if defined VCVARSALL (
  if exist "%VCVARSALL%" (
    echo [client] Loading MSVC build env for x64...
    call "%VCVARSALL%" x64 >nul 2>&1
  ) else (
    echo [client] WARNING: vcvarsall.bat not found under the VS install path above.
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

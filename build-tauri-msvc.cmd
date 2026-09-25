@echo off
setlocal EnableExtensions
cd /d "%~dp0src-tauri"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo ERROR: vswhere.exe was not found.
  exit /b 1
)
set "VS_INSTALL="
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_INSTALL=%%i"
if not defined VS_INSTALL (
  echo ERROR: Visual Studio C++ build tools were not found.
  exit /b 1
)
set "VCVARSALL=%VS_INSTALL%\VC\Auxiliary\Build\vcvarsall.bat"
if not exist "%VCVARSALL%" (
  echo ERROR: vcvarsall.bat was not found.
  exit /b 1
)
call "%VCVARSALL%" x64 >nul 2>&1
if errorlevel 1 (
  echo ERROR: Failed to initialize the MSVC environment.
  exit /b 1
)

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
echo === BUILD START ===
call pnpm.cmd exec tauri build --no-bundle 2>&1
set "BUILD_EXIT=%ERRORLEVEL%"
echo === BUILD END errorlevel=%BUILD_EXIT% ===
exit /b %BUILD_EXIT%

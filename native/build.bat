@echo off
rem Compila apploopback.exe con Visual Studio (workload "Sviluppo di applicazioni desktop con C++").
for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS=%%i"
if not defined VS (echo Visual Studio con strumenti C++ non trovato & exit /b 1)
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
pushd "%~dp0"
cl /nologo /O2 /EHsc /std:c++17 apploopback.cpp /Fe:apploopback.exe
set ERR=%ERRORLEVEL%
del /q apploopback.obj 2>nul
popd
exit /b %ERR%

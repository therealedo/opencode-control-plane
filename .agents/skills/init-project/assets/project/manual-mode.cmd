@echo off
setlocal
node "%~dp0.autopilot\bin\manual-mode.mjs" --root "%~dp0." %*
set "manual_mode_exit=%errorlevel%"
endlocal & exit /b %manual_mode_exit%

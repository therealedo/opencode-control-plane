@echo off
setlocal
node "%~dp0.autopilot\bin\control-plane.mjs" --root "%~dp0." %*
set "control_plane_exit=%errorlevel%"
endlocal & exit /b %control_plane_exit%

@echo off
setlocal
node "%~dp0.agents\skills\init-project\bin\control-plane-global.mjs" --home "%~dp0.control-plane-home" --source-root "%~dp0." %*
set "control_plane_exit=%errorlevel%"
endlocal & exit /b %control_plane_exit%

@echo off
setlocal
if "%~1"=="" (
  echo Usage: install-project.cmd PROJECT_FOLDER
  exit /b 2
)
node "%~dp0scripts\install-project.mjs" --target "%~1"
set "install_project_exit=%errorlevel%"
endlocal & exit /b %install_project_exit%

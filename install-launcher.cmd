@echo off
node "%~dp0scripts\install-launcher.mjs" %*
exit /b %errorlevel%

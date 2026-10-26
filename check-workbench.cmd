@echo off
setlocal
node "%~dp0scripts\workbench.mjs" verify
set "workbench_result=%errorlevel%"
pause
exit /b %workbench_result%

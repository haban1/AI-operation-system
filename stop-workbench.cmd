@echo off
setlocal
node "%~dp0scripts\workbench.mjs" stop
if errorlevel 1 (
  pause
  exit /b 1
)

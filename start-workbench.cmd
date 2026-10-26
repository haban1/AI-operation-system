@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. See docs\Windows*.md.
  pause
  exit /b 1
)
node "%~dp0scripts\workbench.mjs" start %*
if errorlevel 1 (
  pause
  exit /b 1
)

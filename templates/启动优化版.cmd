@echo off
start "" powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0start-optimized.ps1"
exit /b

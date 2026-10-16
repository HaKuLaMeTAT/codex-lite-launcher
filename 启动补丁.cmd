@echo off
start "" powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
exit /b

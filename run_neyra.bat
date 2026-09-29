@echo off
REM Thin wrapper: UTF-8 PowerShell menu via ASCII bootstrap (server\scripts\neyra_win_boot.ps1).
setlocal EnableExtensions
cd /d "%~dp0"

set "_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%_PS%" set "_PS=%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%_PS%" (
  echo [ERR] PowerShell not found under %%SystemRoot%%\System32
  pause
  exit /b 1
)

title Neyra control deck
"%_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\scripts\neyra_win_boot.ps1"
exit /b %ERRORLEVEL%

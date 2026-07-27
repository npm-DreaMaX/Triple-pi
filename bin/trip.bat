@echo off
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
call "%REPO_ROOT%\pi-runtime\pi-test.bat" %*

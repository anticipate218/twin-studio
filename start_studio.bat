@echo off
rem Twin Studio launcher: starts the local server (port 8090) and opens the browser.
setlocal
cd /d "%~dp0"
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
if "%TWIN_PORT%"=="" set "TWIN_PORT=8090"
echo Twin Studio  ->  http://127.0.0.1:%TWIN_PORT%/
echo Python       ->  %PY%
"%PY%" "%~dp0server.py" --port %TWIN_PORT% --open %*
endlocal

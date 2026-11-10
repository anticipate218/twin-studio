@echo off
rem Stops only the Twin Studio server process recorded in data\server.pid (never other python.exe).
setlocal
set "PIDFILE=%~dp0data\server.pid"
if not exist "%PIDFILE%" (
  echo Twin Studio is not running ^(no data\server.pid^).
  exit /b 0
)
set /p PID=<"%PIDFILE%"
taskkill /PID %PID% /T /F >nul 2>&1 && echo Stopped Twin Studio ^(PID %PID%^). || echo Process %PID% was not running.
del "%PIDFILE%" >nul 2>&1
endlocal

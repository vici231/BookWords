@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul 2>&1

title 刊见单词 Launcher

echo ============================================
echo   刊见单词 Word Journal - one-click launcher
echo ============================================
echo.

rem ---------- locate a working system Python ----------
set "PY="
python --version >nul 2>&1
if not errorlevel 1 set "PY=python"

if not defined PY (
  py -3 --version >nul 2>&1
  if not errorlevel 1 set "PY=py -3"
)

if not defined PY call :find_common_python

if not defined PY (
  echo [ERROR] Python 3.11+ was not found.
  echo         Install Python from https://www.python.org/downloads/
  echo         and enable "Add python.exe to PATH", then run this file again.
  pause
  exit /b 1
)

rem ---------- if the service is already running, just open the browser ----------
netstat -ano | findstr ":5000" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [INFO] Service is already running at http://127.0.0.1:5000
  start "" "http://127.0.0.1:5000"
  echo Browser opened. This window can be closed.
  timeout /t 3 /nobreak >nul
  exit /b 0
)

rem ---------- create or repair the virtual environment ----------
set "VENV_OK=0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys; print(sys.version)" >nul 2>&1
  if not errorlevel 1 set "VENV_OK=1"
)

if "%VENV_OK%"=="0" (
  if exist ".venv" (
    echo [INFO] Existing virtual environment is unavailable. Recreating it...
    rmdir /s /q ".venv"
    if exist ".venv" (
      echo [ERROR] Cannot remove the broken .venv folder.
      echo         Close any Python process using this project and retry.
      pause
      exit /b 1
    )
  )
  echo [1/3] Creating virtualenv .venv ...
  %PY% -m venv .venv
  if errorlevel 1 goto :fail
) else (
  echo [1/3] Virtualenv ready, skip.
)

rem ---------- install dependencies if missing ----------
".venv\Scripts\python.exe" -c "import flask, requests, cryptography" >nul 2>&1
if errorlevel 1 (
  echo [2/3] Installing backend dependencies ...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
  if errorlevel 1 (
    echo       Mirror failed, retrying with default index...
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt
  )
  if errorlevel 1 goto :fail
) else (
  echo [2/3] Dependencies ready, skip.
)

rem ---------- start the backend ----------
echo [3/3] Starting backend at http://127.0.0.1:5000 ...
start "刊见单词" /min "%~dp0.venv\Scripts\python.exe" "%~dp0backend\app.py"

rem ---------- wait until the service is ready (up to ~15s) ----------
powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 30;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:5000/api/health';if($r.StatusCode -eq 200){exit 0}}catch{};Start-Sleep -Milliseconds 500};exit 1"
if errorlevel 1 (
  echo [ERROR] Service failed to start in time.
  echo         Check the minimized "刊见单词" window for the error message.
  pause
  exit /b 1
)

rem ---------- open the browser ----------
if /i not "%~1"=="--no-browser" start "" "http://127.0.0.1:5000"

echo.
echo Service is ready: http://127.0.0.1:5000
echo To stop: press Ctrl+C in the minimized "刊见单词" window, or close it.
echo.
pause
exit /b 0

:fail
echo.
echo [ERROR] Setup failed. See the messages above.
pause
exit /b 1

:find_common_python
for %%P in (
  "%LocalAppData%\Programs\Python\Python313\python.exe"
  "%LocalAppData%\Programs\Python\Python312\python.exe"
  "%LocalAppData%\Programs\Python\Python311\python.exe"
  "%ProgramFiles%\Python313\python.exe"
  "%ProgramFiles%\Python312\python.exe"
  "%ProgramFiles%\Python311\python.exe"
  "%ProgramData%\Anaconda3\python.exe"
  "%USERPROFILE%\anaconda3\python.exe"
  "%USERPROFILE%\miniconda3\python.exe"
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
) do if not defined PY if exist "%%~P" (
  "%%~P" --version >nul 2>&1
  if not errorlevel 1 set "PY=%%~P"
)
exit /b 0


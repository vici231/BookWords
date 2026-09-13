@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul 2>&1

title Bookwords Node Launcher

echo ============================================
echo   Bookwords (Node) - one-click launcher
echo ============================================
echo.

rem ---------- locate node ----------
node --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install Node 20+ from https://nodejs.org/ and retry.
  pause
  exit /b 1
)

rem ---------- restart if an old instance is running ----------
set "OLDPID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":9000" ^| findstr "LISTENING"') do set "OLDPID=%%P"
if defined OLDPID (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -eq $env:OLDPID};if($p -and $p.CommandLine -like '*bookwords-node*server.js*'){Stop-Process -Id $env:OLDPID -Force;exit 0}else{exit 1}"
  if not errorlevel 1 (
    echo [INFO] Stopped old server PID !OLDPID! - restarting with latest code...
    ping -n 2 127.0.0.1 >nul
  ) else (
    echo [INFO] Port 9000 is used by another program, not touched.
  )
  set "OLDPID="
)

rem ---------- install dependencies if missing ----------
if not exist "node_modules\express\" (
  echo [1/2] Installing dependencies with npm ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your network and retry.
    pause
    exit /b 1
  )
) else (
  echo [1/2] Dependencies ready, skip.
)

rem ---------- start the server ----------
echo [2/2] Starting server at http://127.0.0.1:9000 ...
start "Bookwords Node" /min cmd /c "cd /d "%~dp0" && node server.js"

rem ---------- wait until the service is ready (up to ~15s) ----------
powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 30;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:9000/api/health';if($r.StatusCode -eq 200){exit 0}}catch{};Start-Sleep -Milliseconds 500};exit 1"
if errorlevel 1 (
  echo [ERROR] Service failed to start in time.
  echo         Check the minimized "Bookwords Node" window for the error message.
  pause
  exit /b 1
)

rem ---------- open the browser ----------
if /i not "%~1"=="--no-browser" start "" "http://127.0.0.1:9000"

echo.
echo Service is ready: http://127.0.0.1:9000
echo To stop: close the minimized "Bookwords Node" window.
echo.
pause
exit /b 0

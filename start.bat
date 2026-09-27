@echo off
rem Starts the Study Hub and opens it in the browser.
cd /d "%~dp0"
title Study Hub
echo.
echo   Study Hub
echo   ---------
echo   1  This computer only
echo   2  This computer + my phone or tablet on the same Wi-Fi
echo      (anyone on that Wi-Fi can open it; the hub shows a QR code for your phone)
echo.
choice /c 12 /n /m "  Choose 1 or 2: "
echo.
if errorlevel 2 (
  python server.py --lan --open
) else (
  python server.py --open
)
pause

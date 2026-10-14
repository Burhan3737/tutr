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
echo   3  This computer + anywhere, through a Cloudflare link (any Wi-Fi or mobile data)
echo      (anyone with the link can open it; the link changes every time)
echo.
python -c "import claude_agent_sdk, fitz, faster_whisper, kokoro_onnx" 2>nul || (
  echo   First run: installing the Study Hub's Python packages...
  python -m pip install -q -r requirements.txt
  echo.
)
choice /c 123 /n /m "  Choose 1, 2 or 3: "
echo.
if errorlevel 3 (
  python server.py --tunnel --open
) else if errorlevel 2 (
  python server.py --lan --open
) else (
  python server.py --open
)
pause

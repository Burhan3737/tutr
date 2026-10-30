@echo off
rem Starts Tutr and opens it in the browser.
cd /d "%~dp0"
title Tutr
echo.
echo   Tutr
echo   ----
rem First run: your library starts as a copy of example-library, with the preparing-slides skill beside it.
if not exist library\ (
  if exist example-library\ (
    echo   Setting up your library from example-library...
    xcopy /e /i /q /y example-library library >nul
  )
)
if exist library\ if not exist library\.claude\skills\preparing-slides\ (
  if exist .claude\skills\preparing-slides\ (
    echo   Adding the preparing-slides skill to your library...
    xcopy /e /i /q /y .claude\skills\preparing-slides library\.claude\skills\preparing-slides >nul
  )
)
echo.
echo   1  This computer only
echo   2  This computer + my phone or tablet on the same Wi-Fi
echo      (anyone on that Wi-Fi can open it; Tutr shows a QR code for your phone)
echo   3  This computer + anywhere, through a Cloudflare link (any Wi-Fi or mobile data)
echo      (anyone with the link can open it; the link changes every time)
echo.
python -c "import claude_agent_sdk, faster_whisper, kokoro_onnx" 2>nul || (
  echo   First run: installing Tutr's Python packages...
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

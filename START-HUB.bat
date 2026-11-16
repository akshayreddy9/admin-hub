@echo off
title Admin Hub
cd /d "%~dp0"
if not exist node_modules (
  echo Installing hub packages...
  call npm install
)
echo.
echo Admin Hub: http://localhost:5000  (login: admin / admin123)
echo Start each app server too: GGPay on 4000, PayTwin on 4001.
echo.
start "" http://localhost:5000
node src\index.js
pause

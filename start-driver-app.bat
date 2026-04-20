@echo off
cd /d C:\Users\umesh\my-app
start "Driver App Backend" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "Driver App Preview" cmd /k node preview-server.js

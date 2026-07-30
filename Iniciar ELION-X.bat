@echo off
chcp 65001 >nul
title E-L-I-O-N X  -  AI Command Center
cd /d "%~dp0"
echo.
echo   ============================================
echo     E-L-I-O-N  X   -   AI COMMAND CENTER
echo     http://localhost:3001
echo   ============================================
echo.

rem  Se o ELION ja estiver no ar, apenas abre o navegador (evita erro de porta em uso)
powershell -NoProfile -Command "try{ Invoke-WebRequest http://localhost:3001/api/status -UseBasicParsing -TimeoutSec 2 ^| Out-Null; exit 0 }catch{ exit 1 }"
if %errorlevel%==0 (
  echo   ELION-X ja esta em execucao. Abrindo o navegador...
  start "" http://localhost:3001
  timeout /t 2 >nul
  exit /b
)

echo   Iniciando o nucleo neural... mantenha esta janela aberta.
echo   ^(Para desligar o ELION-X, basta fechar esta janela.^)
echo.
start "" http://localhost:3001
node server.js

echo.
echo   O servidor foi encerrado. Se houve erro, ele aparece acima.
pause

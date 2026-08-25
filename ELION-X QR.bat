@echo off
chcp 65001 >nul
title E-L-I-O-N X  -  QR de acesso pelo celular
cd /d "%~dp0"
echo.
echo   ============================================
echo     E-L-I-O-N  X   -   QR DE ACESSO
echo   ============================================
echo.

rem  Sobe o nucleo se ele ainda nao estiver no ar
powershell -NoProfile -Command "try{ Invoke-WebRequest http://localhost:3001/api/status -UseBasicParsing -TimeoutSec 2 ^| Out-Null; exit 0 }catch{ exit 1 }"
if %errorlevel%==1 (
  echo   Iniciando o nucleo neural em segundo plano...
  start "ELION-X" /min cmd /c "node server.js"
  timeout /t 4 >nul
)

echo   Abrindo a pagina de QR...
echo.
echo   A pagina mostra os enderecos em que o celular alcanca este PC.
echo   Escaneie o QR com a camera do celular.
echo.
echo   Se o celular nao abrir o endereco da rede local, o Firewall do
echo   Windows esta barrando a porta 3001. Para liberar, abra um
echo   PowerShell COMO ADMINISTRADOR e rode:
echo.
echo     netsh advfirewall firewall add rule name="ELION-X 3001" ^
echo       dir=in action=allow protocol=TCP localport=3001
echo.
echo   Para voz e camera no celular, use o tunel HTTPS:
echo   atalho "ELION-X Mobile.bat".
echo.

start "" http://localhost:3001/qr
timeout /t 3 >nul

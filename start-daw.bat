@echo off
REM Web DAW - Digital Audio Workstation starter
REM Inicia o servidor de desenvolvimento Vite + React

cd /d C:\Users\fkffr\daw-project

echo Iniciando Web DAW...
echo.

REM Verifica se as dependências estão instaladas
if not exist node_modules\vite (
    echo Instalando dependências...
    npm install
)

echo Iniciando servidor de desenvolvimento...
echo O navegador abrira automaticamente.
echo.
npm run dev -- --open

pause
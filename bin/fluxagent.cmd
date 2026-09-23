@echo off
rem FluxAgent CLI shim - forwards everything to the real CLI.
node --experimental-strip-types "%~dp0..\src\cli\index.ts" %*
exit /b %ERRORLEVEL%

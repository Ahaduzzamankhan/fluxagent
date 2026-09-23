# FluxAgent CLI shim - forwards everything to the real CLI.
& node --experimental-strip-types (Join-Path $PSScriptRoot "..\src\cli\index.ts") @args
exit $LASTEXITCODE

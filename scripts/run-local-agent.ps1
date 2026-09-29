# Runs the local API in the foreground for the current Windows sign-in session.
# Secrets stay in .env; none are passed on the command line or printed here.
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$envPath = Join-Path $projectRoot '.env'
$entryPath = Join-Path $projectRoot 'apps/api/dist/index.js'

if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    throw 'Local agent configuration (.env) is missing.'
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw 'Built local agent is missing. Run the project build before signing in again.'
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
Set-Location -LiteralPath $projectRoot
& $node '--env-file=.env' 'apps/api/dist/index.js'
exit $LASTEXITCODE

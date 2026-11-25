param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (Test-Path -LiteralPath (Join-Path $projectRoot '.folio-local/paused')) { exit 0 }
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw 'The configured Node executable is missing. Update the Folio startup task.'
}
$entry = Join-Path $PSScriptRoot 'local-services.ts'
# An existing healthy supervisor can be owned by another terminal. Never duplicate it.
$ErrorActionPreference = 'Continue'
& $NodePath --import tsx $entry status *> $null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -eq 0) { exit 0 }
$logDirectory = Join-Path $projectRoot '.folio-local/logs'
[IO.Directory]::CreateDirectory($logDirectory) | Out-Null
$startupLog = Join-Path $logDirectory 'startup.log'
if ((Test-Path -LiteralPath $startupLog) -and (Get-Item -LiteralPath $startupLog).Length -gt 262144) {
  Move-Item -LiteralPath $startupLog -Destination ($startupLog + '.1') -Force
}
# The scheduled task owns this foreground process, independent of Codex/terminal lifetime.
$ErrorActionPreference = 'Continue'
& $NodePath --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx $entry start >> $startupLog 2>&1
$folioExitCode = $LASTEXITCODE
exit $folioExitCode

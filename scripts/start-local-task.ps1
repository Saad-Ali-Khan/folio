$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-task-config.ps1')
$projectRoot = Split-Path -Parent $PSScriptRoot
$configuration = Get-FolioTaskConfiguration -ProjectRoot $projectRoot -NodePath (Get-Command node.exe -ErrorAction Stop).Source
$task = Get-ScheduledTask -TaskName $configuration.TaskName -TaskPath '\' -ErrorAction Stop
Assert-FolioTaskOwnership -Task $task -Configuration $configuration
Start-ScheduledTask -InputObject $task -ErrorAction Stop
Write-Output 'Folio Windows startup task requested.'

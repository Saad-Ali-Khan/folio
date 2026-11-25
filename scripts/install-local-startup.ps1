param([switch]$Remove, [switch]$Update, [switch]$Describe)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-task-config.ps1')
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$configuration = Get-FolioTaskConfiguration -ProjectRoot $projectRoot -NodePath $nodePath
$taskName = $configuration.TaskName
if ($Describe) { $configuration | ConvertTo-Json; exit }
$existing = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($existing) { Assert-FolioTaskOwnership -Task $existing -Configuration $configuration }
if ($Remove) {
  if ($existing) { Unregister-ScheduledTask -InputObject $existing -Confirm:$false }
  Write-Output 'Folio logon startup removed. Running services were not stopped.'
  exit
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($existing -and -not $Update) { throw 'Task already exists. Run npm run local:install-startup -- -Update to safely update it.' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $configuration.Arguments -WorkingDirectory $projectRoot
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes $configuration.WatchdogMinutes)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger, $watchdogTrigger) -Principal $principal -Settings $settings -Force:$Update | Out-Null
Write-Output 'Folio startup task installed: hidden logon startup and a five-minute restart check. PC sleep/shutdown still pauses imports. Run npm run local:up to start now.'

param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskName = 'Folio Local Inventory'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output 'Folio logon startup removed. Running services were not stopped.'
  exit
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $PSScriptRoot 'local-services.ts'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { throw 'Task already exists. Inspect it or run this script with -Remove first.' }
# A hidden host avoids a console window and does not load a PowerShell script at logon.
$quotedNode = $nodePath.Replace("'", "''")
$quotedEntry = $entry.Replace("'", "''")
$arguments = '-NoProfile -WindowStyle Hidden -Command "& ''{0}'' --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx ''{1}'' start; exit $LASTEXITCODE"' -f $quotedNode, $quotedEntry
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Output 'Folio starts hidden at your next Windows logon. PC sleep/shutdown still stops imports. Run npm run local:up to start now.'

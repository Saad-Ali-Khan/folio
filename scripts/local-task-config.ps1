function Get-FolioTaskConfiguration {
  param([string]$ProjectRoot, [string]$NodePath)
  $launcher = Join-Path $ProjectRoot 'scripts/run-local-startup.ps1'
  [pscustomobject]@{
    TaskName = 'Folio Local Inventory'
    ProjectRoot = $ProjectRoot
    NodePath = $NodePath
    Entry = (Join-Path $ProjectRoot 'scripts/local-services.ts')
    Launcher = $launcher
    Arguments = ('-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NodePath "{1}"' -f $launcher, $NodePath)
    WatchdogMinutes = 5
  }
}

function Assert-FolioTaskOwnership {
  param($Task, $Configuration)
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) { throw 'Existing Folio task has unexpected actions; it was not modified.' }
  $action = $actions[0]
  $sameRoot = [string]::Equals(([string]$action.WorkingDirectory).TrimEnd('\'), $Configuration.ProjectRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
  $knownHost = [IO.Path]::GetFileName($action.Execute) -in @('powershell.exe', 'pwsh.exe')
  $knownEntry = ([string]$action.Arguments).IndexOf($Configuration.Entry, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $knownLauncher = ([string]$action.Arguments).IndexOf($Configuration.Launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0
  if (-not $sameRoot -or -not $knownHost -or -not ($knownEntry -or $knownLauncher)) {
    throw 'Existing Folio task belongs to another folder or command; it was not modified.'
  }
}

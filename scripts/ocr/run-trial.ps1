param([ValidateSet('existing','web')][string]$Corpus, [switch]$DownloadWebAfter, [switch]$Stronger, [switch]$Geometry)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location -LiteralPath $projectRoot
try {
    if (($Stronger -and $Geometry) -or (($Stronger -or $Geometry) -and ($Corpus -or $DownloadWebAfter))) {
        throw 'Choose one trial profile and reuse the frozen corpus.'
    }
    if ($Corpus) {
        & npx.cmd tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/ocr/collect.ts $Corpus
        if ($LASTEXITCODE -ne 0) { throw 'Corpus collection failed.' }
    }
    if ($Stronger -or $Geometry) { & npx.cmd tsx scripts/ocr/benchmark.ts validate }
    else { & npm.cmd run ocr:prepare }
    if ($LASTEXITCODE -ne 0) { throw 'Preparing the comparison failed.' }
    if ($Geometry) {
        & npx.cmd tsx scripts/ocr/geometry.ts prepare
        if ($LASTEXITCODE -ne 0) { throw 'Preparing crop views failed.' }
    }
    $linuxRoot = (& wsl.exe --exec wslpath -u $projectRoot | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $linuxRoot.StartsWith('/')) { throw 'Cannot access Ubuntu through WSL.' }
    $profile = if ($Geometry) { 'geometry' } elseif ($Stronger) { 'stronger' } else { 'mobile' }
    & wsl.exe --exec bash "$linuxRoot/scripts/ocr/run-trial.sh" $linuxRoot $profile
    if ($LASTEXITCODE -ne 0) { throw 'PaddleOCR trial failed; see the message above. The live bot was not changed.' }
    if ($Geometry) {
        & npx.cmd tsx scripts/ocr/geometry.ts order
        if ($LASTEXITCODE -ne 0) { throw 'Trial reading-order normalization failed.' }
        & npx.cmd tsx scripts/ocr/benchmark.ts report --geometry
    }
    elseif ($Stronger) { & npx.cmd tsx scripts/ocr/benchmark.ts report --stronger }
    else { & npm.cmd run ocr:report }
    if ($LASTEXITCODE -ne 0) { throw 'Reading the comparison report failed.' }
    if ($DownloadWebAfter) {
        & npx.cmd tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/ocr/collect.ts web
        if ($LASTEXITCODE -ne 0) { throw 'Web collection failed; existing-photo results are retained.' }
    }
} finally { Pop-Location }

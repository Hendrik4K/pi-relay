# Activates a tested build from release-next: waits for Pi Relay to exit, backs up release\,
# swaps in the new files (renaming files still locked by MCP stdio clients) and relaunches
# Pi Relay through Explorer, so it never inherits this script's or an agent's environment.
param(
    [int]$WaitPid = 0,
    [string]$ExpectedVersion = '',
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$ReleaseDir = '',
    [string]$StagingDir = '',
    [string]$BackupRoot = '',
    [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$swapStarted = $false
if (-not $ReleaseDir) { $ReleaseDir = Join-Path $ProjectRoot 'release' }
if (-not $StagingDir) { $StagingDir = Join-Path $ProjectRoot 'release-next' }
if (-not $BackupRoot) { $BackupRoot = Join-Path $ProjectRoot 'backups' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $BackupRoot "activate-$stamp"
New-Item -ItemType Directory -Force $backup | Out-Null
$log = Join-Path $backup 'activate.log'
function Write-Log([string]$text) { $line = (Get-Date -Format 'HH:mm:ss') + ' ' + $text; Add-Content -LiteralPath $log -Value $line; Write-Host $line }

try {
    $info = Get-Content -LiteralPath (Join-Path $StagingDir 'build-info.json') -Raw | ConvertFrom-Json
    if (-not $info.testsPassed) { throw 'Der vorbereitete Build ist nicht als getestet markiert.' }
    if ($ExpectedVersion -and $info.appVersion -ne $ExpectedVersion) { throw "Erwartet $ExpectedVersion, vorbereitet ist $($info.appVersion)." }
    if (-not (Test-Path -LiteralPath (Join-Path $StagingDir 'PiRelay.exe'))) { throw 'release-next enthält keine PiRelay.exe.' }

    if ($WaitPid) {
        Write-Log "Warte auf das Ende von Pi Relay (PID $WaitPid) ..."
        $deadline = (Get-Date).AddSeconds(60)
        while (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) {
            if ((Get-Date) -gt $deadline) { throw 'Pi Relay wurde nicht beendet. Es wurde nichts ausgetauscht.' }
            Start-Sleep -Milliseconds 300
        }
    }
    $running = Get-CimInstance Win32_Process -Filter "Name='PiRelay.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($ReleaseDir, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '--mcp' }
    if ($running) { throw 'Eine Pi-Relay-Oberfläche aus release\ läuft noch. Es wurde nichts ausgetauscht.' }

    Write-Log "Sichere $ReleaseDir nach $backup"
    foreach ($name in 'PiRelay.exe', 'PiRelay.dll', 'PiRelay.deps.json', 'PiRelay.runtimeconfig.json', 'PiRelay.ico', 'build-info.json', 'THIRD-PARTY-NOTICES.md') {
        $source = Join-Path $ReleaseDir $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $backup }
    }
    if (Test-Path -LiteralPath (Join-Path $ReleaseDir 'ui')) { Copy-Item -LiteralPath (Join-Path $ReleaseDir 'ui') -Destination $backup -Recurse }

    # Files of the old version still mapped by running MCP stdio clients cannot be overwritten,
    # but they can be renamed; the new file then takes the original name.
    $swapStarted = $true
    if (Test-Path -LiteralPath (Join-Path $ReleaseDir 'ui')) { Remove-Item -LiteralPath (Join-Path $ReleaseDir 'ui') -Recurse -Force }
    $suffix = ".old-$stamp"; $renamed = 0
    foreach ($file in Get-ChildItem -LiteralPath $StagingDir -Recurse -File) {
        $relative = $file.FullName.Substring($StagingDir.TrimEnd('\').Length + 1)
        $target = Join-Path $ReleaseDir $relative
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        try { Copy-Item -LiteralPath $file.FullName -Destination $target -Force }
        catch { Rename-Item -LiteralPath $target -NewName ((Split-Path $target -Leaf) + $suffix); $renamed++; Copy-Item -LiteralPath $file.FullName -Destination $target -Force }
    }
    Write-Log "Neue Version $($info.appVersion) mit noVNC $($info.novnc) übernommen; $renamed gesperrte Dateien umbenannt."

    # Earlier renamed files can go once no process maps them any more.
    $removed = 0
    foreach ($old in Get-ChildItem -LiteralPath $ReleaseDir -Recurse -File -Filter '*.old-*') {
        if ($old.Name.EndsWith($suffix)) { continue }
        try { Remove-Item -LiteralPath $old.FullName -Force; $removed++ } catch { }
    }
    if ($removed) { Write-Log "$removed alte, nicht mehr genutzte Dateien entfernt." }

    if (-not $NoLaunch) {
        Write-Log 'Starte Pi Relay über den Explorer ...'
        & (Join-Path $env:WINDIR 'explorer.exe') (Join-Path $ReleaseDir 'PiRelay.exe')
    }
    Write-Log 'Fertig.'
} catch {
    Write-Log ('FEHLER: ' + $_.Exception.Message)
    if ($swapStarted) {
        # Put the previous app files back so a half-copied release never starts.
        try {
            if (Test-Path -LiteralPath (Join-Path $ReleaseDir 'ui')) { Remove-Item -LiteralPath (Join-Path $ReleaseDir 'ui') -Recurse -Force }
            foreach ($file in Get-ChildItem -LiteralPath $backup -Recurse -File | Where-Object { $_.Name -ne 'activate.log' }) {
                $target = Join-Path $ReleaseDir $file.FullName.Substring($backup.Length + 1)
                New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
                try { Copy-Item -LiteralPath $file.FullName -Destination $target -Force } catch { Rename-Item -LiteralPath $target -NewName ((Split-Path $target -Leaf) + ".failed-$stamp"); Copy-Item -LiteralPath $file.FullName -Destination $target -Force }
            }
            Write-Log 'Vorherige Version wiederhergestellt.'
        } catch { Write-Log ('Wiederherstellung fehlgeschlagen: ' + $_.Exception.Message) }
    }
    Write-Log "Sicherung und Protokoll: $backup"
    if (-not $NoLaunch -and (Test-Path -LiteralPath (Join-Path $ReleaseDir 'PiRelay.exe'))) { & (Join-Path $env:WINDIR 'explorer.exe') (Join-Path $ReleaseDir 'PiRelay.exe') }
    exit 1
}

# Updates the bundled noVNC of the integrated viewer as a new Pi Relay release:
# exact npm version, license check, patch version bump, full build, all checks, installer.
# Only after everything passed is release-next marked as ready (build-info.json); the running
# app is never touched. On failure the source changes are rolled back.
param(
    [string]$Version = '',
    [switch]$Force,
    [switch]$AllowMajor
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
$tracked = 'package.json', 'package-lock.json', 'native\PiRelay.csproj', 'installer\PiRelay.iss', 'build-installer.ps1', 'THIRD-PARTY-NOTICES.md'
$saved = @{}; $changed = $false
try {
    $current = (Get-Content 'node_modules\@novnc\novnc\package.json' -Raw | ConvertFrom-Json).version
    if (-not $Version) { $Version = (Invoke-RestMethod 'https://registry.npmjs.org/-/package/@novnc/novnc/dist-tags' -TimeoutSec 20).latest }
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Keine stabile Versionsnummer: $Version" }
    Write-Host "Integrierter Viewer: noVNC $current -> $Version" -ForegroundColor Cyan
    if ($Version -eq $current -and -not $Force) { Write-Host 'Bereits aktuell. Nichts zu tun.' -ForegroundColor Green; return }
    if ([version]$Version -lt [version]$current) { throw 'Ein Rückschritt auf eine ältere noVNC-Version ist hier nicht vorgesehen.' }
    if (([version]$Version).Major -ne ([version]$current).Major -and -not $AllowMajor) { throw "Neue Hauptversion. Änderungen prüfen (https://github.com/novnc/noVNC/releases) und mit -AllowMajor bestätigen." }
    Write-Host "Änderungen: https://github.com/novnc/noVNC/releases/tag/v$Version"
    $info = Join-Path $root 'release-next\build-info.json'; if (Test-Path -LiteralPath $info) { Remove-Item -LiteralPath $info -Force }
    foreach ($file in $tracked) { $saved[$file] = [IO.File]::ReadAllBytes((Join-Path $root $file)) }

    $appVersion = ([xml](Get-Content 'native\PiRelay.csproj' -Raw)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
    if ($Version -ne $current) {
        $changed = $true
        & npm.cmd install --save-exact "@novnc/novnc@$Version"
        if ($LASTEXITCODE -ne 0) { throw 'npm install fehlgeschlagen.' }
        $package = Get-Content 'node_modules\@novnc\novnc\package.json' -Raw | ConvertFrom-Json
        if ($package.version -ne $Version) { throw 'Installierte noVNC-Version stimmt nicht.' }
        if ($package.license -ne 'MPL-2.0') { throw "Lizenz geändert ($($package.license)). Weitergabebedingungen prüfen, bevor das Update übernommen wird." }
        $parts = ([version]$appVersion); $appVersion = "$($parts.Major).$($parts.Minor).$($parts.Build + 1)"
        (Get-Content 'native\PiRelay.csproj' -Raw) -replace '<Version>[^<]+</Version>', "<Version>$appVersion</Version>" | Set-Content 'native\PiRelay.csproj' -NoNewline -Encoding utf8
        (Get-Content 'installer\PiRelay.iss' -Raw) -replace '#define AppVersion "[^"]+"', "#define AppVersion `"$appVersion`"" | Set-Content 'installer\PiRelay.iss' -NoNewline -Encoding utf8
        (Get-Content 'build-installer.ps1' -Raw) -replace "\[string\]\`$Version='[^']+'", "[string]`$Version='$appVersion'" | Set-Content 'build-installer.ps1' -NoNewline -Encoding utf8
        (Get-Content 'THIRD-PARTY-NOTICES.md' -Raw).Replace("noVNC $current", "noVNC $Version").Replace('`@novnc/novnc` ' + $current, '`@novnc/novnc` ' + $Version) | Set-Content 'THIRD-PARTY-NOTICES.md' -NoNewline -Encoding utf8
        Write-Host "Pi Relay $appVersion enthält noVNC $Version." -ForegroundColor Cyan
    }

    & (Join-Path $root 'build-windows.ps1') -OutputDirectory release-next
    & (Join-Path $PSScriptRoot 'run-checks.ps1')
    & (Join-Path $root 'build-installer.ps1') -Version $appVersion | Out-Null
    $installer = Join-Path $root "artifacts\PiRelay-Setup-$appVersion-x64.exe"
    $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
    [ordered]@{ appVersion = $appVersion; noVnc = $Version; builtAt = (Get-Date).ToString('o'); testsPassed = $true; installer = $installer; sha256 = $hash } | ConvertTo-Json | Set-Content -LiteralPath $info -Encoding utf8
    Write-Host ''
    Write-Host "Fertig: Pi Relay $appVersion mit noVNC $Version ist gebaut und geprüft." -ForegroundColor Green
    Write-Host "Installer: $installer"
    Write-Host 'Aktivieren: In Pi Relay unter Pi-Bildschirm auf „Jetzt aktivieren“ klicken. Dieses Fenster kann geschlossen werden.'
} catch {
    Write-Host ('FEHLER: ' + $_.Exception.Message) -ForegroundColor Red
    if ($changed) {
        Write-Host 'Stelle den vorherigen Stand wieder her ...'
        foreach ($file in $saved.Keys) { [IO.File]::WriteAllBytes((Join-Path $root $file), $saved[$file]) }
        & npm.cmd install --no-audit --no-fund | Out-Null
        Write-Host "Projekt wieder auf noVNC $current. Die laufende App wurde nicht verändert."
    }
    exit 1
} finally { Pop-Location }

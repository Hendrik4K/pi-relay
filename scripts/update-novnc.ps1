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
    # Supply chain: a freshly published release is not taken right away. Hijacked npm releases are usually
    # found and pulled within days; 14 days of public exposure leave room for that.
    if ($Version -ne $current) {
        $published = (Invoke-RestMethod 'https://registry.npmjs.org/@novnc/novnc' -TimeoutSec 30).time.$Version
        if (-not $published) { throw "Veröffentlichungsdatum von noVNC $Version nicht gefunden." }
        $age = (Get-Date).ToUniversalTime() - ([datetime]$published).ToUniversalTime()
        if ($age.TotalDays -lt 14) { throw ("noVNC $Version ist erst {0:N0} Tage alt. Aus Sicherheitsgründen wird eine neue Version frühestens nach 14 Tagen übernommen." -f [math]::Floor($age.TotalDays)) }
    }
    Write-Host "Änderungen: https://github.com/novnc/noVNC/releases/tag/v$Version"
    $info = Join-Path $root 'release-next\build-info.json'; if (Test-Path -LiteralPath $info) { Remove-Item -LiteralPath $info -Force }
    foreach ($file in $tracked) { $saved[$file] = [IO.File]::ReadAllBytes((Join-Path $root $file)) }

    # The padded date version (YY.MM.DD) lives in the installer script; the project file keeps the plain number form.
    $appVersion = [regex]::Match((Get-Content 'installer\PiRelay.iss' -Raw), '#define AppVersion "([^"]+)"').Groups[1].Value
    if ($Version -ne $current) {
        $changed = $true
        # No install scripts: noVNC needs none, and a compromised package could otherwise run code right here.
        & npm.cmd install --save-exact --ignore-scripts "@novnc/novnc@$Version"
        if ($LASTEXITCODE -ne 0) { throw 'npm install fehlgeschlagen.' }
        & npm.cmd audit signatures
        if ($LASTEXITCODE -ne 0) { throw 'npm-Signaturprüfung der Pakete fehlgeschlagen.' }
        $package = Get-Content 'node_modules\@novnc\novnc\package.json' -Raw | ConvertFrom-Json
        if ($package.version -ne $Version) { throw 'Installierte noVNC-Version stimmt nicht.' }
        if ($package.license -ne 'MPL-2.0') { throw "Lizenz geändert ($($package.license)). Weitergabebedingungen prüfen, bevor das Update übernommen wird." }
        $appVersion = & (Join-Path $PSScriptRoot 'bump-version.ps1') | Select-Object -Last 1
        # Explicit UTF-8 without BOM: Windows PowerShell 5 would read the BOM-less file as ANSI and break its umlauts.
        $notices = Join-Path $root 'THIRD-PARTY-NOTICES.md'; $utf8 = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText($notices, [IO.File]::ReadAllText($notices, $utf8).Replace("noVNC $current", "noVNC $Version").Replace('`@novnc/novnc` ' + $current, '`@novnc/novnc` ' + $Version), $utf8)
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
        & npm.cmd install --no-audit --no-fund --ignore-scripts | Out-Null
        Write-Host "Projekt wieder auf noVNC $current. Die laufende App wurde nicht verändert."
    }
    exit 1
} finally { Pop-Location }

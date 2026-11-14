# Checks scripts\activate-release.ps1 in a temporary folder: version guard, backup, swap with a
# locked file (as held by MCP stdio clients) and cleanup. No app is stopped or launched.
$ErrorActionPreference = 'Stop'
$script = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\activate-release.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('pi-relay-activate-' + [guid]::NewGuid().ToString('N'))
function Require([bool]$ok, [string]$message) { if (-not $ok) { throw "FAIL: $message" } }
try {
    $release = Join-Path $root 'release'; $staging = Join-Path $root 'release-next'; $backups = Join-Path $root 'backups'
    New-Item -ItemType Directory -Force (Join-Path $release 'ui\assets'), (Join-Path $staging 'ui\assets') | Out-Null
    Set-Content (Join-Path $release 'PiRelay.exe') 'old exe'; Set-Content (Join-Path $release 'PiRelay.dll') 'old dll'; Set-Content (Join-Path $release 'ui\assets\old.js') 'old ui'
    Set-Content (Join-Path $release 'stale.dll.old-20200101000000') 'stale'
    Set-Content (Join-Path $staging 'PiRelay.exe') 'new exe'; Set-Content (Join-Path $staging 'PiRelay.dll') 'new dll'; Set-Content (Join-Path $staging 'ui\assets\new.js') 'new ui'
    '{"appVersion":"9.9.9","noVnc":"1.8.0","testsPassed":true}' | Set-Content (Join-Path $staging 'build-info.json')

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -ExpectedVersion '9.9.8' -ReleaseDir $release -StagingDir $staging -BackupRoot $backups -NoLaunch | Out-Null
    Require ($LASTEXITCODE -ne 0) 'Version mismatch must fail'
    Require ((Get-Content (Join-Path $release 'PiRelay.exe')) -eq 'old exe') 'Nothing is swapped on a version mismatch'

    $lock = [IO.File]::Open((Join-Path $release 'PiRelay.dll'), 'Open', 'Read', 'Read, Delete')
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -ExpectedVersion '9.9.9' -ReleaseDir $release -StagingDir $staging -BackupRoot $backups -NoLaunch | Out-Null
        Require ($LASTEXITCODE -eq 0) 'Activation succeeds'
    } finally { $lock.Dispose() }
    Require ((Get-Content (Join-Path $release 'PiRelay.exe')) -eq 'new exe') 'New executable in place'
    Require ((Get-Content (Join-Path $release 'PiRelay.dll')) -eq 'new dll') 'Locked file replaced after renaming'
    Require (@(Get-ChildItem $release -Filter 'PiRelay.dll.old-*').Count -eq 1) 'Locked old file kept under a new name'
    Require (-not (Test-Path (Join-Path $release 'ui\assets\old.js')) -and (Test-Path (Join-Path $release 'ui\assets\new.js'))) 'UI replaced completely'
    Require (-not (Test-Path (Join-Path $release 'stale.dll.old-20200101000000'))) 'Unused earlier leftovers removed'
    $backup = Get-ChildItem $backups -Directory | Sort-Object Name | Select-Object -Last 1
    Require ((Get-Content (Join-Path $backup.FullName 'PiRelay.exe')) -eq 'old exe' -and (Test-Path (Join-Path $backup.FullName 'ui\assets\old.js'))) 'Previous version backed up'
    Write-Host 'PASS: version guard, backup, locked-file swap, complete UI swap, leftover cleanup. No app stopped or launched.'
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }

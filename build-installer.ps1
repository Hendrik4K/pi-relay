param([string]$Compiler='', [string]$ReleaseDirectory='release-next', [string]$Version='1.7.11')
$ErrorActionPreference='Stop'
if(-not $Compiler){
    $taskLocal=Join-Path (Split-Path $PSScriptRoot -Parent) '.tools\inno\ISCC.exe'
    if(Test-Path -LiteralPath $taskLocal){$Compiler=$taskLocal}
    else { $taskCommand=Get-Command ISCC.exe -ErrorAction SilentlyContinue; if($taskCommand){$Compiler=$taskCommand.Source} }
}
if(-not $Compiler){throw 'Inno Setup 7 oder 6 installieren oder -Compiler mit dem Pfad zu ISCC.exe angeben.'}
$taskRelease=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot $ReleaseDirectory)).Path
if(-not (Test-Path -LiteralPath (Join-Path $taskRelease 'PiRelay.exe'))){throw 'Zuerst build-windows.ps1 ausführen.'}
if($Version -notmatch '^\d+\.\d+\.\d+$'){throw 'Versionsnummer muss aus drei Zahlen bestehen.'}
# Only the published app is packaged. Reject known user-data/key/viewer files.
$taskBlocked=@(Get-ChildItem -LiteralPath $taskRelease -Recurse -File | Where-Object { $_.Extension -in '.pub','.pem','.key' -or $_.Name -in 'settings.json','viewer.json','updates.json','VNC-Viewer.exe','vncviewer.exe' })
if($taskBlocked.Count){throw 'Unerwartete Benutzerdaten oder Viewer-Dateien im Release. Installer wurde nicht gebaut.'}
& $Compiler ('/DReleaseDir='+$taskRelease) ('/DAppVersion='+$Version) (Join-Path $PSScriptRoot 'installer\PiRelay.iss')
if($LASTEXITCODE -ne 0){throw 'Installer-Build fehlgeschlagen.'}
Get-FileHash -LiteralPath (Join-Path $PSScriptRoot "artifacts\PiRelay-Setup-$Version-x64.exe") -Algorithm SHA256

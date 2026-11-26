# Sets the Pi Relay version to today's date: YY.MM.DD (e.g. 26.12.01 for 1 December 2026).
# A second build on the same day gets a fourth number (26.12.01.2, .3, ...), so newer always compares higher.
# The project file keeps the plain number form (26.12.1) because .NET does not accept leading zeros there;
# the installer, build-info.json and the app show the padded date.
param([datetime]$Date = (Get-Date))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$csproj = Join-Path $root 'native\PiRelay.csproj'
$iss = Join-Path $root 'installer\PiRelay.iss'
$installer = Join-Path $root 'build-installer.ps1'

$current = [version](([xml](Get-Content -LiteralPath $csproj -Raw)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1)
$year = $Date.Year % 100
$day = [version]::new($year, $Date.Month, $Date.Day)
if ($current.Major -eq $day.Major -and $current.Minor -eq $day.Minor -and $current.Build -eq $day.Build) {
    $next = [version]::new($year, $Date.Month, $Date.Day, [math]::Max($current.Revision, 1) + 1)
} elseif ($current -gt $day) {
    throw "Die aktuelle Version $current ist neuer als das Datum $($Date.ToString('dd.MM.yyyy'))."
} else {
    $next = $day
}
$number = if ($next.Revision -gt 0) { "$($next.Major).$($next.Minor).$($next.Build).$($next.Revision)" } else { "$($next.Major).$($next.Minor).$($next.Build)" }
$display = '{0}.{1:00}.{2:00}' -f $next.Major, $next.Minor, $next.Build
if ($next.Revision -gt 0) { $display += ".$($next.Revision)" }

# Read and write as UTF-8 explicitly and keep a byte-order mark only where the file already had one:
# Windows PowerShell 5 would otherwise read BOM-less files as ANSI and double-encode the umlauts.
function Update-File([string]$path, [string]$pattern, [string]$replacement) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, $(if ($bom) { 3 } else { 0 }), $bytes.Length - $(if ($bom) { 3 } else { 0 }))
    if (-not [regex]::IsMatch($text, $pattern)) { throw "Versionsstelle in $path nicht gefunden." }
    $next = [regex]::Replace($text, $pattern, $replacement.Replace('$', '$$'))
    [IO.File]::WriteAllText($path, $next, [Text.UTF8Encoding]::new($bom))
}
Update-File $csproj '<Version>[^<]+</Version>' "<Version>$number</Version>"
Update-File $iss '#define AppVersion "[^"]+"' "#define AppVersion `"$display`""
Update-File $installer "\[string\]\`$Version='[^']+'" "[string]`$Version='$display'"
Write-Host "Pi Relay $display" -ForegroundColor Cyan
$display

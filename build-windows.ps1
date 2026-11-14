param([string]$Dotnet = '', [string]$OutputDirectory = 'release')
$ErrorActionPreference = 'Stop'
$taskAppRoot = $PSScriptRoot
$env:DOTNET_CLI_HOME = Join-Path (Split-Path $taskAppRoot -Parent) '.tools\dotnet-home'
$env:NUGET_PACKAGES = Join-Path (Split-Path $taskAppRoot -Parent) '.tools\nuget'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
if (-not $Dotnet) {
    $taskLocalSdk = Join-Path (Split-Path $taskAppRoot -Parent) '.tools\dotnet\dotnet.exe'
    $Dotnet = if (Test-Path -LiteralPath $taskLocalSdk) { $taskLocalSdk } else { 'dotnet' }
}
Push-Location $taskAppRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    & $Dotnet restore (Join-Path $taskAppRoot 'native\PiRelay.csproj') --runtime win-x64 --configfile (Join-Path $taskAppRoot 'native\NuGet.Config')
    if ($LASTEXITCODE -ne 0) { throw 'Restore failed' }
    & $Dotnet publish (Join-Path $taskAppRoot 'native\PiRelay.csproj') -c Release -r win-x64 --self-contained true --no-restore -o (Join-Path $taskAppRoot $OutputDirectory)
    if ($LASTEXITCODE -ne 0) { throw 'Windows publish failed' }
} finally { Pop-Location }

# Runs every automated Pi Relay check against the current dist/ and sources. No SSH, no Pi,
# no visible browser: UI suites use headless Chrome, native window checks stay off-screen.
param([string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
Push-Location $ProjectRoot
$preview = $null
try {
    $tools = Join-Path (Split-Path $ProjectRoot -Parent) '.tools'
    $env:DOTNET_CLI_HOME = Join-Path $tools 'dotnet-home'; $env:NUGET_PACKAGES = Join-Path $tools 'nuget'
    $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'; $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    $dotnet = Join-Path $tools 'dotnet\dotnet.exe'; if (-not (Test-Path -LiteralPath $dotnet)) { $dotnet = 'dotnet' }
    $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if (-not $python) { throw 'Python 3 wurde nicht gefunden.' }
    if (-not $env:PI_RELAY_NODE_MODULES) {
        $found = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'node_modules\playwright\package.json') } | Select-Object -First 1
        if (-not $found) { throw 'Playwright wurde nicht gefunden. PI_RELAY_NODE_MODULES setzen.' }
        $env:PI_RELAY_NODE_MODULES = Join-Path $found.FullName 'node_modules'
    }
    if (-not $env:PI_RELAY_CHROME) {
        $env:PI_RELAY_CHROME = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
    function Step([string]$name, [scriptblock]$run) {
        Write-Host "== $name" -ForegroundColor Cyan
        & $run
        if ($LASTEXITCODE -ne 0) { throw "$name fehlgeschlagen" }
    }
    Step 'Python-Worker' { & $python -I native\test_worker.py }
    Step 'Gemeinsamer Transport' { & $dotnet run --project tests\native-transport\TransportChecks.csproj -- $python tests\native-transport\test-data\root }
    Step 'Bildschirm-Transport' { & $dotnet run --project tests\screen-bridge\ScreenChecks.csproj -- $python }
    Step 'Bildschirmfenster (WebView2, unsichtbar)' { & $dotnet run --project tests\screen-window\ScreenWindowChecks.csproj -- $python }
    Step 'Integrierter Viewer: Updateprüfung' { & $dotnet run --project tests\integrated-viewer\IntegratedViewerChecks.csproj -- tests\integrated-viewer\test-data }
    Step 'Externe Viewer-Updates' { & $dotnet run --project tests\viewer-updates\ViewerChecks.csproj -- tests\viewer-updates\test-data }
    Step 'Aktivierungsskript' { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\activate-release.ps1 }
    Step 'Fensterkontur' { & $dotnet run --project tests\window-outline\WindowOutlineChecks.csproj }
    $port = 4173
    $preview = Start-Process -FilePath 'node.exe' -ArgumentList @('node_modules\vite\bin\vite.js', 'preview', '--host', '127.0.0.1', '--port', "$port", '--strictPort') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(20)
    function Listening { $client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', $port); $true } catch { $false } finally { $client.Dispose() } }
    while (-not (Listening)) { if ((Get-Date) -gt $deadline) { throw 'Vorschau-Server startet nicht.' }; Start-Sleep -Milliseconds 300 }
    $env:PI_RELAY_QA_URL = $null
    Step 'Oberfläche: integrierter Viewer' { & node tests\ui-screen.cjs }
    Step 'Oberfläche: Ansichten' { & node tests\ui-views.cjs }
    Step 'Oberfläche: Tray und Viewer-Verwaltung' { & node tests\ui-tray-reopen.cjs }
    Write-Host 'Alle Prüfungen bestanden.' -ForegroundColor Green
} finally {
    if ($preview -and -not $preview.HasExited) { & taskkill.exe /PID $preview.Id /T /F | Out-Null }
    Pop-Location
}

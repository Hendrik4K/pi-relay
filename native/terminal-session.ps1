param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')][string]$HostAlias,[Parameter(Mandatory=$true)][string]$SessionLog)
$Host.UI.RawUI.WindowTitle = 'Pi Relay · ' + $HostAlias
Write-Host ('Pi Relay · ' + $HostAlias) -ForegroundColor Magenta
Write-Host 'Sicherheitsschlüssel bei Aufforderung bestätigen.'
& "$env:WINDIR\System32\OpenSSH\ssh.exe" -v -E $SessionLog -o ConnectTimeout=15 -o ConnectionAttempts=1 -o ServerAliveInterval=30 -o ServerAliveCountMax=10 $HostAlias
$taskSshExit = $LASTEXITCODE
if ($taskSshExit -ne 0) {
    Write-Host ('SSH wurde mit Code ' + $taskSshExit + ' beendet. Die Meldung steht auch in Pi Relay.') -ForegroundColor Yellow
    Read-Host 'Enter zum Schließen'
}
exit $taskSshExit

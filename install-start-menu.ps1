param([string]$ReportPath = '', [switch]$ViaExplorer)
$ErrorActionPreference = 'Stop'
if ($ViaExplorer) {
    $taskDesktopShell = New-Object -ComObject Shell.Application
    $taskExplorer = $taskDesktopShell.Windows().Item(0)
    if ($null -eq $taskExplorer) { throw 'Bitte ein Explorer-Fenster öffnen oder das Skript in einer normalen PowerShell ausführen.' }
    $taskArguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
    if ($ReportPath) { $taskArguments += ' -ReportPath "' + $ReportPath + '"' }
    $taskExplorer.Document.Application.ShellExecute('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',$taskArguments,$PSScriptRoot,'open',0)
    return
}
$taskExe = Join-Path $PSScriptRoot 'release\PiRelay.exe'
if (-not (Test-Path -LiteralPath $taskExe)) { throw 'PiRelay.exe wurde nicht gefunden.' }
$taskMenu = [Environment]::GetFolderPath('Programs')
$taskLink = Join-Path $taskMenu 'Pi Relay.lnk'
$taskShell = New-Object -ComObject WScript.Shell
$taskShortcut = $taskShell.CreateShortcut($taskLink)
$taskShortcut.TargetPath = $taskExe
$taskShortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($taskExe)
$taskShortcut.Description = 'Pi Relay – SSH-Terminals, AI-Agenten und Pi-Bildschirm'
$taskShortcut.IconLocation = $taskExe + ',0'
$taskShortcut.Save()

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PiRelayStartRegistration {
 [StructLayout(LayoutKind.Sequential,Pack=4)] public struct Key {public Guid format;public uint id;}
 [StructLayout(LayoutKind.Explicit,Size=24)] public struct Value {
  [FieldOffset(0)] public ushort type;
  [FieldOffset(8)] public IntPtr pointer;
 }
 [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 public interface Store {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index,out Key key);
  [PreserveSig] int GetValue(ref Key key,out Value value);
  [PreserveSig] int SetValue(ref Key key,ref Value value);
  [PreserveSig] int Commit();
 }
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,PreserveSig=true)]
 static extern int SHGetPropertyStoreFromParsingName(string path,IntPtr context,uint flags,ref Guid iid,out Store store);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)]
 public static extern void SHChangeNotify(uint change,uint flags,string first,IntPtr second);
 public static void SetAppId(string path,string id){
  var iid=typeof(Store).GUID;Store store;
  Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path,IntPtr.Zero,2,ref iid,out store));
  var key=new Key{format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),id=5};
  var value=new Value{type=31,pointer=Marshal.StringToCoTaskMemUni(id)};
  try{Marshal.ThrowExceptionForHR(store.SetValue(ref key,ref value));Marshal.ThrowExceptionForHR(store.Commit());}
  finally{Marshal.FreeCoTaskMem(value.pointer);Marshal.ReleaseComObject(store);}
 }
}
'@
[PiRelayStartRegistration]::SetAppId($taskLink, 'PiRelay.Desktop')
$taskAppPaths = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\PiRelay.exe'
New-Item -Path $taskAppPaths -Force | Out-Null
Set-Item -LiteralPath $taskAppPaths -Value $taskExe
New-ItemProperty -LiteralPath $taskAppPaths -Name Path -Value ([IO.Path]::GetDirectoryName($taskExe)) -PropertyType String -Force | Out-Null
[PiRelayStartRegistration]::SHChangeNotify(0x00002000,0x1005,$taskLink,[IntPtr]::Zero)
[PiRelayStartRegistration]::SHChangeNotify(0x00001000,0x1005,$taskMenu,[IntPtr]::Zero)
$taskReport = [pscustomobject]@{shortcut=$taskLink;appId='PiRelay.Desktop';appPath=$taskExe;pid=$PID;apps=@(Get-StartApps | Where-Object { $_.Name -match 'Pi.?Relay' -or $_.AppID -eq 'PiRelay.Desktop' })} | ConvertTo-Json -Depth 4
if ($ReportPath) { [IO.File]::WriteAllText($ReportPath,$taskReport,[Text.UTF8Encoding]::new($false)) }
$taskReport

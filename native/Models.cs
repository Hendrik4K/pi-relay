using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.IO;

namespace PiRelay;

public sealed class UiSettings { public bool Minimized {get;set;} public bool Autostart {get;set;} public bool Motion {get;set;}=true; public string VncViewer {get;set;}=""; public bool ManagedViewer {get;set;}=true; public bool ExternalViewer {get;set;} public bool ClipboardFromPi {get;set;}=true; public bool ClipboardToPi {get;set;}=true; public bool ShowFps {get;set;} public string Language {get;set;}=Lang.English?"en":"de"; }
// Language of the texts Windows shows itself (tray menu, dialogs, notifications); the panel translates itself.
// Until the settings say otherwise, it follows the Windows display language.
public static class Lang { public static bool English=System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName!="de"; public static string L(string de,string en)=>English?en:de; }
public sealed class AgentConfig { public string Alias {get;set;}=""; public string Root {get;set;}=""; public bool AllowCommands {get;set;} public bool AllowWrite {get;set;} }
// Board facts read once over an existing SSH session, remembered per Pi address.
public sealed class DeviceFacts { public string Model {get;set;}=""; public long MemoryBytes {get;set;} public long StorageBytes {get;set;} public string StorageKind {get;set;}=""; }
public sealed class SavedState { public Dictionary<string,DeviceFacts> Devices {get;set;}=new(StringComparer.OrdinalIgnoreCase); public UiSettings Settings {get;set;}=new(); public Dictionary<string,AgentConfig> Agents {get;set;}=new(){{"codex",new()},{"claude",new()}}; public List<string> AddedKeys {get;set;}=[]; }
public sealed class Profile { public string Alias {get;set;}=""; public string Hostname {get;set;}=""; public string User {get;set;}=""; public string KeyType {get;set;}="SSH-Schlüssel"; public string State {get;set;}="disconnected"; }
public record PublicKey(string Name,string Type,string Fingerprint,string Path);
public record EventRow(string Time,string Message);

public static class Json {
 public static readonly JsonSerializerOptions Options=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase,PropertyNameCaseInsensitive=true,WriteIndented=false};
 public static string Encode(object? value)=>JsonSerializer.Serialize(value,Options);
 public static T? Decode<T>(string value)=>JsonSerializer.Deserialize<T>(value,Options);
}
public static partial class Discovery {
 public static readonly string SshExe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","OpenSSH","ssh.exe");
 public static readonly string KeygenExe=Path.Combine(Path.GetDirectoryName(SshExe)!,"ssh-keygen.exe");
 public static readonly string SshFolder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ssh");
 [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")] private static partial Regex AliasPattern();
 public static bool ValidAlias(string alias)=>AliasPattern().IsMatch(alias);
 public static ProcessStartInfo StartInfo(string exe,params string[] args){var p=new ProcessStartInfo(exe){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};foreach(var a in args)p.ArgumentList.Add(a);return p;}
 public static async Task<string> Capture(string exe,params string[] args){using var p=Process.Start(StartInfo(exe,args))??throw new IOException("Prozess konnte nicht starten");var output=p.StandardOutput.ReadToEndAsync();var errors=p.StandardError.ReadToEndAsync();using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(8));try{await p.WaitForExitAsync(timeout.Token);}catch{try{p.Kill(true);}catch{}throw;}var text=await output;await errors;if(p.ExitCode!=0)throw new IOException("SSH-Konfiguration konnte nicht gelesen werden");return text;}
 public static IEnumerable<string> Aliases(string file,HashSet<string>? seen=null,int depth=0){seen??=new(StringComparer.OrdinalIgnoreCase);if(depth>8||!File.Exists(file)||!seen.Add(Path.GetFullPath(file)))yield break;foreach(var raw in File.ReadLines(file)){var line=raw.Trim();if(line.StartsWith("#"))continue;var parts=Regex.Split(line,"[\\s=]+",RegexOptions.None,TimeSpan.FromSeconds(1));if(parts.Length<2)continue;if(parts[0].Equals("Host",StringComparison.OrdinalIgnoreCase)){foreach(var alias in parts.Skip(1).TakeWhile(s=>!s.StartsWith('#')))if(ValidAlias(alias))yield return alias;}else if(parts[0].Equals("Include",StringComparison.OrdinalIgnoreCase)){foreach(var item in parts.Skip(1)){var path=item.Trim('"').Replace("~/",Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)+Path.DirectorySeparatorChar);if(!Path.IsPathRooted(path))path=Path.Combine(SshFolder,path);var folder=Path.GetDirectoryName(path);if(folder==null||!Directory.Exists(folder))continue;foreach(var match in Directory.GetFiles(folder,Path.GetFileName(path)))foreach(var alias in Aliases(match,seen,depth+1))yield return alias;}}}}
 public static async Task<List<Profile>> Profiles(){var list=new List<Profile>();foreach(var alias in Aliases(Path.Combine(SshFolder,"config")).Distinct(StringComparer.OrdinalIgnoreCase)){try{var text=await Capture(SshExe,"-G",alias);string Get(string key)=>text.Split('\n').FirstOrDefault(l=>l.StartsWith(key+" ",StringComparison.Ordinal))?.Trim()[(key.Length+1)..]??"";list.Add(new(){Alias=alias,Hostname=Get("hostname"),User=Get("user"),KeyType=text.Contains("_sk",StringComparison.OrdinalIgnoreCase)?"Hardware-Schlüssel":"SSH-Schlüssel"});}catch{}}return list;}
 public static async Task<List<PublicKey>> Keys(IEnumerable<string> added){var files=Directory.Exists(SshFolder)?Directory.GetFiles(SshFolder,"*.pub"):[];var result=new List<PublicKey>();foreach(var path in files.Concat(added).Distinct(StringComparer.OrdinalIgnoreCase)){try{if(!File.Exists(path)||!path.EndsWith(".pub",StringComparison.OrdinalIgnoreCase))continue;var output=(await Capture(KeygenExe,"-lf",path)).Trim();var parts=output.Split(' ',StringSplitOptions.RemoveEmptyEntries);var type=File.ReadLines(path).FirstOrDefault()?.Split(' ')[0]??"";result.Add(new(Path.GetFileNameWithoutExtension(path),type.Contains("sk-")?"Hardware-Schlüssel (FIDO)":type,parts.Length>1?parts[1]:output,path));}catch{}}return result;}
}

using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PiRelay;
public sealed class IntegratedViewerCache {
 public string Latest {get;set;}="";
 public DateTimeOffset? LastChecked {get;set;}
 public DateTimeOffset? LastAttempt {get;set;}
 public string NotifiedVersion {get;set;}="";
 public string SkippedVersion {get;set;}="";
}
public sealed record StagedBuild(string AppVersion,string NoVnc,DateTimeOffset BuiltAt,bool TestsPassed,string Installer="");

// Restarts always go through Explorer, so the new process gets the user's normal environment
// instead of inheriting this process tree (an inherited agent environment once broke SSH).
public static class Relaunch {
 // The executable path travels in an environment variable, never inside the script text, so no
 // quote character in a path can end a string; PowerShell itself comes from System32.
 public static string PowerShell=>Path.Combine(Environment.SystemDirectory,"WindowsPowerShell","v1.0","powershell.exe");
 public const string ExeVariable="PIRELAY_RELAUNCH_EXE";
 public static string Script(int processId)=>"Wait-Process -Id "+processId+" -Timeout 30 -ErrorAction SilentlyContinue; & (Join-Path $env:WINDIR 'explorer.exe') $env:"+ExeVariable;
 public static ProcessStartInfo Info(int processId,string exe){
  var info=new ProcessStartInfo(PowerShell){UseShellExecute=false,CreateNoWindow=true};
  foreach(var arg in new[]{"-NoProfile","-NonInteractive","-EncodedCommand",Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(Script(processId)))})info.ArgumentList.Add(arg);
  info.Environment[ExeVariable]=exe;
  return info;
 }
 public static void Start(int processId,string exe)=>Process.Start(Info(processId,exe));
}

// The integrated viewer (bundled noVNC) changes only with a new, tested Pi Relay build.
// This class reads version metadata; it never downloads or executes viewer code itself.
public sealed partial class IntegratedViewer {
 public const string TagsUrl="https://registry.npmjs.org/-/package/@novnc/novnc/dist-tags";
 private readonly string appFolder,cacheFile;
 private readonly Func<Task<string>> fetchTags;
 private readonly Action changed;
 private readonly Action<string> notify;
 private readonly SemaphoreSlim gate=new(1,1);
 private IntegratedViewerCache cache=new();
 private Process? build;
 public string AppVersion {get;}
 public string Installed {get;}
 public string Error {get;private set;}="";
 public bool Busy {get;private set;}
 // Building is offered only where the app runs from its project's release folder.
 public string? ProjectRoot {get;}
 public IntegratedViewer(string appFolder,string dataFolder,string appVersion,Func<Task<string>> fetchTags,Action changed,Action<string> notify){
  this.appFolder=Path.GetFullPath(appFolder);cacheFile=Path.Combine(dataFolder,"integrated-viewer.json");AppVersion=appVersion;this.fetchTags=fetchTags;this.changed=changed;this.notify=notify;
  try{using var doc=JsonDocument.Parse(File.ReadAllText(Path.Combine(this.appFolder,"ui","integrated-viewer.json")));Installed=doc.RootElement.GetProperty("novnc").GetString()??"";}catch{Installed="";}
  var parent=Path.GetDirectoryName(this.appFolder.TrimEnd(Path.DirectorySeparatorChar));
  if(parent!=null&&string.Equals(Path.GetFileName(this.appFolder.TrimEnd(Path.DirectorySeparatorChar)),"release",StringComparison.OrdinalIgnoreCase)&&File.Exists(Path.Combine(parent,"scripts","update-novnc.ps1"))&&File.Exists(Path.Combine(parent,"package.json")))ProjectRoot=parent;
  try{cache=Json.Decode<IntegratedViewerCache>(File.ReadAllText(cacheFile))??new();}catch{}
 }
 public static Func<Task<string>> NpmTags(){
  var http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(20)};http.DefaultRequestHeaders.UserAgent.ParseAdd("PiRelay (+integrated-viewer-version-check)");
  return async()=>{using var response=await http.GetAsync(TagsUrl,HttpCompletionOption.ResponseHeadersRead);response.EnsureSuccessStatusCode();if(response.Content.Headers.ContentLength>65536)throw new IOException("Versionsantwort zu groß");var text=await response.Content.ReadAsStringAsync();if(text.Length>65536)throw new IOException("Versionsantwort zu groß");return text;};
 }
 [GeneratedRegex("^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}$")] private static partial Regex StablePattern();
 public static bool IsStable(string version)=>StablePattern().IsMatch(version);
 public static string ParseLatest(string json){using var doc=JsonDocument.Parse(json);var latest=doc.RootElement.GetProperty("latest").GetString()??"";if(!IsStable(latest))throw new IOException("Keine stabile noVNC-Version veröffentlicht");return latest;}
 private static bool Newer(string candidate,string current)=>Version.TryParse(candidate,out var a)&&Version.TryParse(current,out var b)&&a>b;
 public string Latest=>cache.Latest;
 public bool HasUpdate=>IsStable(cache.Latest)&&Newer(cache.Latest,Installed);
 public bool IsSkipped=>HasUpdate&&cache.SkippedVersion==cache.Latest;
 public bool Building{get{try{return build is {HasExited:false};}catch(InvalidOperationException){return false;}}}
 public StagedBuild? Staged{get{
  if(ProjectRoot==null)return null;
  try{var staged=Json.Decode<StagedBuild>(File.ReadAllText(Path.Combine(ProjectRoot,"release-next","build-info.json")));return staged is {TestsPassed:true}&&Newer(staged.AppVersion,AppVersion)&&File.Exists(Path.Combine(ProjectRoot,"release-next","PiRelay.exe"))?staged:null;}catch{return null;}
 }}
 public object Snapshot(bool sshActive)=>new{appVersion=AppVersion,installed=Installed,latest=IsStable(cache.Latest)?cache.Latest:null,updateAvailable=HasUpdate,skipped=IsSkipped,lastChecked=cache.LastChecked,error=Error,busy=Busy,canBuild=ProjectRoot!=null,building=Building,staged=Staged,sshActive};
 public async Task Check(){
  if(!await gate.WaitAsync(0))return;Busy=true;Error="";changed();
  try{cache.LastAttempt=DateTimeOffset.UtcNow;cache.Latest=ParseLatest(await fetchTags());cache.LastChecked=DateTimeOffset.UtcNow;Save();
   if(HasUpdate&&!IsSkipped&&cache.NotifiedVersion!=cache.Latest){cache.NotifiedVersion=cache.Latest;Save();notify("noVNC "+cache.Latest+" ist erschienen. Im Pi-Bildschirm-Menü kannst du ein geprüftes Pi-Relay-Update bauen lassen.");}}
  catch(Exception e){Error="Prüfung nicht möglich: "+e.Message;try{Save();}catch{}}
  finally{Busy=false;changed();gate.Release();}
 }
 public void Tick(){if(!Busy&&(!cache.LastAttempt.HasValue||DateTimeOffset.UtcNow-cache.LastAttempt.Value>TimeSpan.FromHours(24)))_=Check();}
 public void Skip(string version){if(!HasUpdate||version!=cache.Latest)throw new InvalidOperationException("Die Update-Anzeige hat sich geändert. Bitte erneut prüfen.");cache.SkippedVersion=version;Save();changed();}
 public void Restore(){cache.SkippedVersion="";Save();changed();}
 // Opens a visible PowerShell window: update, full build and all tests. Nothing is activated.
 public void StartBuild(string version){
  if(ProjectRoot==null)throw new InvalidOperationException("Diese Pi-Relay-Installation enthält keinen Projektordner. Das Update kommt mit dem nächsten Installer.");
  if(Building)throw new InvalidOperationException("Ein Update-Build läuft bereits.");
  if(!HasUpdate||version!=cache.Latest)throw new InvalidOperationException("Die Update-Anzeige hat sich geändert. Bitte erneut prüfen.");
  var info=new ProcessStartInfo(Relaunch.PowerShell){UseShellExecute=true,WorkingDirectory=ProjectRoot};
  foreach(var arg in new[]{"-NoProfile","-ExecutionPolicy","Bypass","-NoExit","-File",Path.Combine(ProjectRoot,"scripts","update-novnc.ps1"),"-Version",version})info.ArgumentList.Add(arg);
  build=Process.Start(info);changed();
 }
 // Hands over to a script that waits for this process, backs up release\, swaps in release-next\ and relaunches via Explorer.
 public void StartActivation(int processId){
  var staged=Staged??throw new InvalidOperationException("Kein fertig getesteter Build zum Aktivieren vorhanden.");
  var info=new ProcessStartInfo(Relaunch.PowerShell){UseShellExecute=true,WorkingDirectory=ProjectRoot!,WindowStyle=ProcessWindowStyle.Minimized};
  foreach(var arg in new[]{"-NoProfile","-ExecutionPolicy","Bypass","-File",Path.Combine(ProjectRoot!,"scripts","activate-release.ps1"),"-WaitPid",processId.ToString(),"-ExpectedVersion",staged.AppVersion})info.ArgumentList.Add(arg);
  _=Process.Start(info)??throw new IOException("Aktivierungsskript konnte nicht starten.");
 }
 private void Save(){Directory.CreateDirectory(Path.GetDirectoryName(cacheFile)!);var temp=cacheFile+".tmp";File.WriteAllText(temp,Json.Encode(cache));File.Move(temp,cacheFile,true);}
}

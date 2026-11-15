using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace PiRelay;
public sealed record ViewerRelease(string Provider,string Version,string Page,string Download,string Digest,string DigestType,long Size=0);
public sealed class ViewerUpdateCache {
 public ViewerRelease? Latest {get;set;}
 public DateTimeOffset? LastChecked {get;set;}
 public DateTimeOffset? LastAttempt {get;set;}
 public string NotifiedVersion {get;set;}="";
 public Dictionary<string,string> SkippedVersions {get;set;}=new();
}
public sealed class ViewerUpdates {
 private readonly string root;
 private readonly Action changed;
 private readonly Action<string> notify;
 private readonly SemaphoreSlim gate=new(1,1);
 private readonly HttpClient http;
 private ViewerUpdateCache cache=new();
 public ViewerStore Store {get;}
 public string Error {get;private set;}="";
 public bool Busy {get;private set;}
 public string Phase {get;private set;}="";
 public static string DefaultRoot=>Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,"..","tools","vnc"));
 public ViewerUpdates(string root,Action changed,Action<string> notify){
  this.root=Path.GetFullPath(root);this.changed=changed;this.notify=notify;
  http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(30)};
  http.DefaultRequestHeaders.UserAgent.ParseAdd("PiRelay/0.2 (+local-portable-viewer)");
  Store=new(this.root,ViewerRunning);
  try{cache=Json.Decode<ViewerUpdateCache>(File.ReadAllText(Path.Combine(this.root,"updates.json")))??new();}catch{}
 }
 public object Snapshot()=>new{provider=Store.Manifest.Current?.Provider??"",installed=Store.Manifest.Current?.Version??"",latest=cache.Latest?.Provider==Store.Manifest.Current?.Provider?cache.Latest?.Version:null,pending=Store.Manifest.Pending?.Version,previous=Store.PreviousVersion,lastChecked=cache.LastChecked,busy=Busy,phase=Phase,error=Error,updateAvailable=HasUpdate,skipped=IsSkipped,ready=Store.CurrentPath is {} path&&File.Exists(path),managedPath=Store.CurrentPath};
 public bool HasUpdate=>Store.Manifest.Current is {} current&&cache.Latest is {} latest&&current.Provider==latest.Provider&&Version.TryParse(latest.Version,out var available)&&Version.TryParse(current.Version,out var installed)&&available>installed;
 public bool IsSkipped=>HasUpdate&&cache.Latest is {} latest&&cache.SkippedVersions.TryGetValue(latest.Provider,out var skipped)&&skipped==latest.Version;
 public void SkipVersion(string provider,string version){
  if(Busy)throw new InvalidOperationException("Update läuft noch");
  if(!HasUpdate||Store.Manifest.Pending!=null||cache.Latest is not {} latest||latest.Provider!=provider||latest.Version!=version)throw new InvalidOperationException("Die Update-Anzeige hat sich geändert. Bitte die aktuelle Version prüfen.");
  cache.SkippedVersions[provider]=version;SaveCache();changed();
 }
 public void RestoreSkippedVersion(){if(Busy)throw new InvalidOperationException("Update läuft noch");if(Store.Manifest.Current is {} current){cache.SkippedVersions.Remove(current.Provider);SaveCache();changed();}}
 private bool ViewerRunning(){
  foreach(var p in Process.GetProcessesByName("vncviewer")){using(p){try{var path=p.MainModule?.FileName;if(path!=null&&Path.GetFullPath(path).StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))return true;}catch{return true;}}}return false;
 }
 private void SaveCache(){var file=Path.Combine(root,"updates.json");var temp=file+".tmp";File.WriteAllText(temp,Json.Encode(cache));File.Move(temp,file,true);}
 private static bool Allowed(Uri url)=>url.Scheme=="https"&&(url.Host is "api.github.com" or "github.com" or "sourceforge.net" or "downloads.sourceforge.net" or "help.realvnc.com"||url.Host.EndsWith(".dl.sourceforge.net",StringComparison.OrdinalIgnoreCase));
 private async Task<HttpResponseMessage> Get(Uri url){
  for(int i=0;i<8;i++){
   if(!Allowed(url))throw new IOException("Nicht freigegebene Download-Quelle");
   var response=await http.GetAsync(url,HttpCompletionOption.ResponseHeadersRead);
   if((int)response.StatusCode is >=300 and <400&&response.Headers.Location is {} location){var next=location.IsAbsoluteUri?location:new Uri(url,location);response.Dispose();url=next;continue;}
   try{response.EnsureSuccessStatusCode();return response;}catch{response.Dispose();throw;}
  }throw new IOException("Zu viele Download-Weiterleitungen");
 }
 private async Task<string> Text(string url){using var response=await Get(new Uri(url));if(response.Content.Headers.ContentLength>3000000)throw new IOException("Versionsantwort zu groß");return await response.Content.ReadAsStringAsync();}
 public static ViewerRelease ParseTiger(string releaseJson,string feedXml){
  using var release=JsonDocument.Parse(releaseJson);var r=release.RootElement;
  if(r.GetProperty("draft").GetBoolean()||r.GetProperty("prerelease").GetBoolean())throw new IOException("Keine stabile Viewer-Version");
  var version=r.GetProperty("tag_name").GetString()?.TrimStart('v')??"";
  if(!Regex.IsMatch(version,"^[0-9]+\\.[0-9]+\\.[0-9]+$"))throw new IOException("Unbekannte Versionsangabe");
  var filename="vncviewer64-"+version+".exe";
  var doc=XDocument.Parse(feedXml);
  var file=doc.Descendants().Where(x=>x.Name.LocalName=="content"&&x.Name.NamespaceName is "http://search.yahoo.com/mrss/" or "http://video.search.yahoo.com/mrss/").FirstOrDefault(x=>((string?)x.Attribute("url"))?.EndsWith("/"+filename+"/download",StringComparison.Ordinal)==true)??throw new IOException("Für die aktuelle Version ist kein portabler Windows-Viewer veröffentlicht");
  var digest=file.Elements(file.Name.Namespace+"hash").FirstOrDefault(x=>(string?)x.Attribute("algo")=="md5")?.Value??"";
  if(!Regex.IsMatch(digest,"^[a-fA-F0-9]{32}$"))throw new IOException("Hersteller-Prüfsumme fehlt");
  return new("tigervnc",version,"https://github.com/TigerVNC/tigervnc/releases/tag/v"+version,"https://downloads.sourceforge.net/project/tigervnc/stable/"+version+"/"+filename,digest.ToLowerInvariant(),"md5",(long?)file.Attribute("filesize")??0);
 }
 public static ViewerRelease ParseRealVnc(string articleJson){
  using var doc=JsonDocument.Parse(articleJson);var html=doc.RootElement.GetProperty("article").GetProperty("body").GetString()??"";
  foreach(Match row in Regex.Matches(html,"<tr\\b[^>]*>(.*?)</tr>",RegexOptions.Singleline|RegexOptions.IgnoreCase)){
   var text=WebUtility.HtmlDecode(Regex.Replace(row.Groups[1].Value,"<[^>]+>"," "));text=Regex.Replace(text,"\\s+"," ");
   var m=Regex.Match(text,"Standalone EXE x64\\s+([0-9]+\\.[0-9]+\\.[0-9]+)\\s+([a-fA-F0-9]{64})\\s+VNC-Viewer-([0-9.]+)-Windows-64bit\\.exe");
   if(m.Success&&m.Groups[1].Value==m.Groups[3].Value)return new("realvnc-classic",m.Groups[1].Value,"https://manage.realvnc.com/","",m.Groups[2].Value.ToLowerInvariant(),"sha256");
  }throw new IOException("Classic-Viewer-Version konnte nicht aus der Herstellerliste gelesen werden");
 }
 private async Task<ViewerRelease> Latest(string provider){
  if(provider=="realvnc-classic")return ParseRealVnc(await Text("https://help.realvnc.com/api/v2/help_center/en-us/articles/5835892358941.json"));
  if(provider!="tigervnc")throw new IOException("Unbekannter Viewer");
  var release=await Text("https://api.github.com/repos/TigerVNC/tigervnc/releases/latest");
  using var doc=JsonDocument.Parse(release);var version=doc.RootElement.GetProperty("tag_name").GetString()?.TrimStart('v')??"";
  if(!Regex.IsMatch(version,"^[0-9]+\\.[0-9]+\\.[0-9]+$"))throw new IOException("Unbekannte Versionsangabe");
  return ParseTiger(release,await Text("https://sourceforge.net/projects/tigervnc/rss?path=/stable/"+version));
 }
 public Task<ViewerRelease> FetchLatest(string provider)=>Latest(provider);
 public async Task Check(string? provider=null){
  if(!await gate.WaitAsync(0))return;Busy=true;Phase="checking";Error="";changed();
  try{cache.LastAttempt=DateTimeOffset.UtcNow;var latest=await Latest(provider??Store.Manifest.Current?.Provider??"tigervnc");cache.Latest=latest;cache.LastChecked=DateTimeOffset.UtcNow;SaveCache();AnnounceUpdate();}
  catch(Exception e){Error="Update-Prüfung nicht möglich: "+e.Message;SaveCache();}finally{Busy=false;Phase="";changed();gate.Release();}
 }
 private void AnnounceUpdate(){if(HasUpdate&&!IsSkipped&&cache.Latest is {} latest&&cache.NotifiedVersion!=latest.Provider+":"+latest.Version){cache.NotifiedVersion=latest.Provider+":"+latest.Version;SaveCache();notify(Lang.L("Neue Viewer-Version "+latest.Version+" verfügbar. Im Bildschirm-Menü aktualisieren.","New viewer version "+latest.Version+" available. Update it in the screen menu."));}}
 public async Task InstallTiger(){
  if(!await gate.WaitAsync(0))return;Busy=true;Phase="downloading";Error="";changed();string? temp=null;
  try{
   var latest=await Latest("tigervnc");cache.Latest=latest;cache.LastChecked=DateTimeOffset.UtcNow;cache.LastAttempt=cache.LastChecked;SaveCache();
   Directory.CreateDirectory(Path.Combine(root,"downloads"));temp=Path.Combine(root,"downloads",Guid.NewGuid().ToString("N")+".part");
   using var response=await Get(new Uri(latest.Download));if(response.Content.Headers.ContentLength>100000000)throw new IOException("Download ist unerwartet groß");
   await using(var input=await response.Content.ReadAsStreamAsync()){await using var output=File.Create(temp);var buffer=new byte[65536];long total=0;int count;using var timeout=new CancellationTokenSource(TimeSpan.FromMinutes(3));while((count=await input.ReadAsync(buffer,timeout.Token))>0){total+=count;if(total>100000000)throw new IOException("Download ist zu groß");await output.WriteAsync(buffer.AsMemory(0,count),timeout.Token);}if(latest.Size>0&&total!=latest.Size)throw new IOException("Download ist unvollständig");}
   // SourceForge's published MD5 catches transfer damage; transport authenticity
   // comes from verified HTTPS and the project-specific official release URLs.
   using(var input=File.OpenRead(temp)){if(Convert.ToHexString(MD5.HashData(input)).ToLowerInvariant()!=latest.Digest)throw new IOException("Download stimmt nicht mit der offiziellen Dateiprüfsumme überein");}
   ValidateExecutable(temp,latest);
   Store.Stage(temp,latest.Provider,latest.Version,ViewerStore.Hash(temp),latest.Download);
   notify(Store.Manifest.Pending!=null?Lang.L("Viewer-Update bereit. Es wird nach dem Schließen des Viewers aktiviert.","Viewer update ready. It is activated after the viewer is closed."):Lang.L("Portabler TigerVNC Viewer "+latest.Version+" ist bereit.","Portable TigerVNC viewer "+latest.Version+" is ready."));
  }catch(Exception e){Error="Viewer nicht geändert: "+e.Message;throw new IOException(Error,e);}finally{if(temp!=null&&File.Exists(temp))File.Delete(temp);Busy=false;Phase="";changed();gate.Release();}
 }
 public async Task ImportRealVnc(string file){
  if(!await gate.WaitAsync(0))return;Busy=true;Phase="installing";Error="";changed();
  string? temp=null;
  try{
   Directory.CreateDirectory(Path.Combine(root,"downloads"));temp=Path.Combine(root,"downloads",Guid.NewGuid().ToString("N")+".exe");File.Copy(file,temp);
   var info=FileVersionInfo.GetVersionInfo(temp);var match=Regex.Match(info.ProductVersion??info.FileVersion??"","^7\\.[0-9]+\\.[0-9]+");
   if(!match.Success)throw new IOException("Bitte den vorhandenen portablen RealVNC Classic Viewer (Version 7) auswählen");
   var hash=ViewerStore.Hash(temp);var adopted=new ViewerRelease("realvnc-classic",match.Value,"https://help.realvnc.com/","",hash,"sha256");
   ValidateExecutable(temp,adopted);await ValidateRealVncSignature(temp);
   if(ViewerStore.Hash(temp)!=hash)throw new IOException("Die Viewer-Datei wurde während der Prüfung verändert");
   cache.LastAttempt=DateTimeOffset.UtcNow;
   try{var latest=await Latest("realvnc-classic");cache.Latest=latest;cache.LastChecked=DateTimeOffset.UtcNow;}catch(Exception e){Error="Viewer übernommen; Update-Prüfung noch nicht möglich: "+e.Message;}
   Store.Stage(temp,adopted.Provider,adopted.Version,hash,"Vorhandener, signierter RealVNC Viewer");SaveCache();AnnounceUpdate();
  }
  catch(Exception e){Error="Viewer nicht geändert: "+e.Message;throw;}finally{if(temp!=null&&File.Exists(temp))File.Delete(temp);Busy=false;Phase="";changed();gate.Release();}
 }
 internal const string RealVncPublisher="RealVNC Ltd";
 private static async Task ValidateRealVncSignature(string file){
  // The selected file is passed as environment data, never as PowerShell code.
  var command=@"$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'); $s=Get-AuthenticodeSignature -LiteralPath $env:PI_RELAY_SIGNATURE_FILE; [pscustomobject]@{status=$s.Status.ToString();publisher=$(if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{''})} | ConvertTo-Json -Compress";
  var info=Discovery.StartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoLogo","-NoProfile","-NonInteractive","-Command",command);
  info.Environment["PI_RELAY_SIGNATURE_FILE"]=file;
  // A PowerShell 7 parent can otherwise make Windows PowerShell 5 load the
  // incompatible PS7 security module. Use the child's own inbox modules.
  info.Environment.Remove("PSModulePath");
  using var process=Process.Start(info)??throw new IOException("Signaturprüfung konnte nicht starten");var output=process.StandardOutput.ReadToEndAsync();var errors=process.StandardError.ReadToEndAsync();
  using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(20));try{await process.WaitForExitAsync(timeout.Token);}catch{try{process.Kill(true);}catch{}throw new IOException("Zeitlimit bei der Signaturprüfung");}
  var text=await output;var detail=(await errors).Trim();if(process.ExitCode!=0)throw new IOException("Signaturprüfung fehlgeschlagen: "+detail[..Math.Min(detail.Length,400)]);
  // "Valid" is WinVerifyTrust's full chain check; the publisher must match RealVNC's certificate name exactly.
  using var result=JsonDocument.Parse(text);if(result.RootElement.GetProperty("status").GetString()!="Valid"||result.RootElement.GetProperty("publisher").GetString()!=RealVncPublisher)throw new IOException("Keine gültige RealVNC-Herstellersignatur gefunden");
 }
 private static void ValidateExecutable(string file,ViewerRelease release){
  using(var input=new BinaryReader(File.OpenRead(file))){if(input.ReadUInt16()!=0x5A4D)throw new IOException("Download ist keine Windows-Anwendung");input.BaseStream.Position=0x3c;var pe=input.ReadUInt32();if(pe>input.BaseStream.Length-8)throw new IOException("Ungültige Windows-Anwendung");input.BaseStream.Position=pe;if(input.ReadUInt32()!=0x4550)throw new IOException("Ungültige Windows-Anwendung");var machine=input.ReadUInt16();if(machine!=0x8664&&(release.Provider!="realvnc-classic"||machine!=0x14c))throw new IOException("Kein kompatibler Windows-Viewer");}
  var version=FileVersionInfo.GetVersionInfo(file);var product=version.ProductName??"";
  if(release.Provider=="tigervnc"&&!product.Contains("TigerVNC",StringComparison.OrdinalIgnoreCase))throw new IOException("Download enthält keinen TigerVNC Viewer");
  if(release.Provider=="realvnc-classic"&&!product.Contains("VNC",StringComparison.OrdinalIgnoreCase))throw new IOException("Datei enthält keinen RealVNC Viewer");
 }
 public void Tick(){
  if(Busy)return;
  try{if(Store.Reload())changed();if(Store.ApplyPending()){changed();notify(Lang.L("Die vorbereitete Viewer-Version ist jetzt aktiv.","The prepared viewer version is active now."));}}catch(Exception e){Error=e.Message;changed();}
  if(Store.Manifest.Current!=null&&(!cache.LastAttempt.HasValue||DateTimeOffset.UtcNow-cache.LastAttempt.Value>TimeSpan.FromHours(24)))_=Check();
 }
 public void Rollback(){if(Busy)throw new InvalidOperationException("Update läuft noch");Store.Rollback();Error="";changed();}
}

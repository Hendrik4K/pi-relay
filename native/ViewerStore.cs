using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PiRelay;
public sealed record ViewerPackage(string Provider,string Version,string RelativePath,string Sha256,string Source);
public sealed record ViewerManifest(ViewerPackage? Current=null,ViewerPackage? Previous=null,ViewerPackage? Pending=null);

// Version directories are immutable. Only the small current/previous pointer is
// replaced atomically; a failed download or update never overwrites a working EXE.
public sealed class ViewerStore {
 private readonly string root;
 private readonly Func<bool> running;
 public ViewerManifest Manifest {get;private set;}=new();
 public ViewerStore(string root,Func<bool> running){
  this.root=Path.GetFullPath(root);this.running=running;Directory.CreateDirectory(this.root);
  var file=Path.Combine(this.root,"viewer.json");
  if(File.Exists(file))Manifest=Json.Decode<ViewerManifest>(File.ReadAllText(file))??throw new IOException("Viewer-Konfiguration ist ungültig");
 }
 public string? CurrentPath=>Manifest.Current is {} current?Resolve(current):null;
 public string? PreviousVersion=>Manifest.Previous?.Version;
 public bool Reload(){
  var file=Path.Combine(root,"viewer.json");if(!File.Exists(file))return false;
  var next=Json.Decode<ViewerManifest>(File.ReadAllText(file))??throw new IOException("Viewer-Konfiguration ist ungültig");
  foreach(var item in new[]{next.Current,next.Previous,next.Pending})if(item!=null)Resolve(item);
  if(Json.Encode(next)==Json.Encode(Manifest))return false;
  Manifest=next;return true;
 }
 private string Resolve(ViewerPackage package){
  if(Path.IsPathRooted(package.RelativePath))throw new IOException("Ungültiger Viewer-Pfad");
  var path=Path.GetFullPath(Path.Combine(root,package.RelativePath));
  if(!path.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new IOException("Viewer-Pfad außerhalb des Programmordners");
  return path;
 }
 public static string Hash(string path){using var input=File.OpenRead(path);return Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant();}
 public string VerifiedCurrentPath(){
  var current=Manifest.Current??throw new IOException("Portablen Viewer zuerst einrichten");var path=Resolve(current);
  if(!File.Exists(path)||!Hash(path).Equals(current.Sha256,StringComparison.OrdinalIgnoreCase))throw new IOException("Viewer-Datei fehlt oder wurde verändert. Erneut einrichten oder vorige Version verwenden.");
  return path;
 }
 public void Stage(string source,string provider,string version,string expectedSha256,string sourceUrl){
  if(!Regex.IsMatch(provider,"^[a-z0-9-]{1,30}$")||!Regex.IsMatch(version,"^[0-9]+(?:\\.[0-9]+){1,3}$"))throw new IOException("Ungültige Viewer-Version");
  var hash=Hash(source);if(!Regex.IsMatch(expectedSha256,"^[a-fA-F0-9]{64}$")||!hash.Equals(expectedSha256,StringComparison.OrdinalIgnoreCase))throw new IOException("Die Download-Prüfsumme stimmt nicht überein");
  var relative=Path.Combine("versions",provider+"-"+version+"-"+hash[..12],"vncviewer.exe");
  var package=new ViewerPackage(provider,version,relative,hash,sourceUrl);var destination=Resolve(package);Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
  if(File.Exists(destination)){if(Hash(destination)!=hash)throw new IOException("Vorhandene Viewer-Version wurde verändert");}
  else{
   var temp=destination+"."+Guid.NewGuid().ToString("N")+".part";
   try{File.Copy(source,temp);if(Hash(temp)!=hash)throw new IOException("Kopierprüfung fehlgeschlagen");File.Move(temp,destination);}finally{if(File.Exists(temp))File.Delete(temp);}
  }
  Commit(Manifest with{Pending=package});ApplyPending();
 }
 public bool ApplyPending(){
  if(Manifest.Pending is not {} pending||running())return false;
  var path=Resolve(pending);if(!File.Exists(path)||Hash(path)!=pending.Sha256)throw new IOException("Die vorbereitete Viewer-Version ist beschädigt");
  if(Manifest.Current?.Sha256==pending.Sha256){Commit(Manifest with{Pending=null});return false;}
  Commit(new(Current:pending,Previous:Manifest.Current,Pending:null));return true;
 }
 public void Rollback(){
  if(running())throw new InvalidOperationException("Viewer zuerst schließen. Die Bildschirmverbindung wird nicht unterbrochen.");
  var previous=Manifest.Previous??throw new InvalidOperationException("Noch keine vorige Viewer-Version vorhanden");
  var path=Resolve(previous);if(!File.Exists(path)||Hash(path)!=previous.Sha256)throw new IOException("Die vorige Viewer-Version ist nicht verfügbar");
  Commit(new(Current:previous,Previous:Manifest.Current));
 }
 private void Commit(ViewerManifest next){
  var file=Path.Combine(root,"viewer.json");var temp=file+"."+Guid.NewGuid().ToString("N")+".tmp";
  try{File.WriteAllText(temp,Json.Encode(next));File.Move(temp,file,true);Manifest=next;}finally{if(File.Exists(temp))File.Delete(temp);}
 }
}

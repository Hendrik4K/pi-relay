using System.IO;
using System.Text.RegularExpressions;

namespace PiRelay;
// Moves every alias from one Pi address to another (e.g. after a new DHCP lease) and carries the
// Pi's already trusted host keys to the new address, so strict host-key checking stays on and the
// next connect still verifies it is the same Pi. Files are rewritten in place to keep their ACLs.
public static partial class SshHostEdit {
 [GeneratedRegex("^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$")] private static partial Regex HostPattern();
 [GeneratedRegex("^([ \\t]*HostName[ \\t]*(?:=[ \\t]*|[ \\t]+))(\\S+)([ \\t]*\\r?)$",RegexOptions.Multiline|RegexOptions.IgnoreCase)] private static partial Regex HostNameLine();
 public static bool ValidHost(string host)=>HostPattern().IsMatch(host);

 public static (string Text,int Count) ReplaceHostName(string config,string oldHost,string newHost){
  var count=0;
  var text=HostNameLine().Replace(config,m=>{if(!string.Equals(m.Groups[2].Value,oldHost,StringComparison.OrdinalIgnoreCase))return m.Value;count++;return m.Groups[1].Value+newHost+m.Groups[3].Value;});
  return (text,count);
 }

 // Adds "newHost <type> <key>" for each plain entry of oldHost, unless newHost already has entries:
 // then ssh itself decides (a mismatch must stay a hard failure, never be overwritten here).
 public static (string Text,int Added) CarryKnownHosts(string knownHosts,string oldHost,string newHost){
  var lines=knownHosts.Replace("\r\n","\n").Split('\n');
  bool Names(string line,string host)=>!line.StartsWith('#')&&line.Split(' ',2)[0].Split(',').Any(n=>string.Equals(n,host,StringComparison.OrdinalIgnoreCase));
  if(lines.Any(l=>Names(l,newHost))){
   // Moving back: copies of the new host's keys under the old address were carried by an earlier move; drop them.
   var keysOfNew=lines.Where(l=>Names(l,newHost)).Select(l=>l.Split(' ',2)[1]).ToHashSet();
   var kept=lines.Where(l=>!(l.Split(' ').Length==3&&string.Equals(l.Split(' ')[0],oldHost,StringComparison.OrdinalIgnoreCase)&&keysOfNew.Contains(l.Split(' ',2)[1]))).ToArray();
   return kept.Length==lines.Length?(knownHosts,0):(string.Join(knownHosts.Contains("\r\n")?"\r\n":"\n",kept),0);
  }
  var carried=lines.Where(l=>Names(l,oldHost)).Select(l=>newHost+" "+l.Split(' ',2)[1]).ToList();
  if(carried.Count==0)return (knownHosts,0);
  var newline=knownHosts.Contains("\r\n")?"\r\n":"\n";
  var text=knownHosts.Length==0||knownHosts.EndsWith('\n')?knownHosts:knownHosts+newline;
  return (text+string.Join(newline,carried)+newline,carried.Count);
 }

 public static (int Aliases,int Keys) Apply(string sshFolder,string oldHost,string newHost){
  if(!ValidHost(newHost))throw new InvalidOperationException("Ungültige Adresse. Beispiel: 192.168.1.60");
  var configPath=Path.Combine(sshFolder,"config");
  var config=File.ReadAllText(configPath);
  var (updated,count)=ReplaceHostName(config,oldHost,newHost);
  if(count==0)throw new InvalidOperationException("In der SSH-Konfiguration steht kein HostName "+oldHost+". Bitte über „Konfiguration öffnen“ ändern.");
  var stamp=DateTime.Now.ToString("yyyyMMdd-HHmmss");
  File.Copy(configPath,configPath+".bak-pirelay-"+stamp);
  var keys=0;var knownPath=Path.Combine(sshFolder,"known_hosts");
  if(File.Exists(knownPath)){
   var known=File.ReadAllText(knownPath);var (carried,added)=CarryKnownHosts(known,oldHost,newHost);
   if(carried!=known){File.Copy(knownPath,knownPath+".bak-pirelay-"+stamp);File.WriteAllText(knownPath,carried);keys=added;}
  }
  File.WriteAllText(configPath,updated);
  return (count,keys);
 }
}

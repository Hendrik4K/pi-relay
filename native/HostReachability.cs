using System.Net.NetworkInformation;

namespace PiRelay;
// Shows whether each Pi address answers on the network. ICMP ping only: no SSH connection, no
// login and no security-key prompt. Two misses in a row are needed before a host counts as offline.
public sealed class HostReachability {
 private readonly Func<string,Task<bool>> ping;
 private readonly Action changed;
 private readonly Dictionary<string,(string State,int Misses)> hosts=new(StringComparer.OrdinalIgnoreCase);
 private bool checking;
 public HostReachability(Action changed,Func<string,Task<bool>>? ping=null){this.changed=changed;this.ping=ping??Ping;}
 internal static async Task<bool> Ping(string host){try{using var sender=new Ping();return (await sender.SendPingAsync(host,1500)).Status==IPStatus.Success;}catch{return false;}}
 public IReadOnlyDictionary<string,string> Snapshot(){lock(hosts)return hosts.ToDictionary(x=>x.Key,x=>x.Value.State,StringComparer.OrdinalIgnoreCase);}
 // A live SSH session proves the host is reachable, whatever ICMP says.
 public async Task Check(IEnumerable<string> addresses,Func<string,bool> connected){
  if(checking)return;checking=true;var dirty=false;
  try{
   var list=addresses.Where(h=>!string.IsNullOrEmpty(h)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
   var results=await Task.WhenAll(list.Select(async h=>(Host:h,Ok:connected(h)||await ping(h))));
   lock(hosts){
    foreach(var gone in hosts.Keys.Except(list,StringComparer.OrdinalIgnoreCase).ToList()){hosts.Remove(gone);dirty=true;}
    foreach(var (host,ok) in results){
     var previous=hosts.TryGetValue(host,out var entry)?entry:(State:"unknown",Misses:0);
     var misses=ok?0:previous.Misses+1;
     var state=ok?"online":misses>=2?"offline":previous.State;
     dirty|=state!=previous.State;hosts[host]=(state,misses);
    }
   }
  }finally{checking=false;}
  if(dirty)changed();
 }
}

// An explicit connect while the Pi is off or restarting waits here instead of failing at once:
// TCP to the SSH port (or ping, if the SSH port never answers) only, no handshake, no login.
public static class PiWait {
 internal static TimeSpan Limit=TimeSpan.FromMinutes(3),Every=TimeSpan.FromSeconds(3);
 internal const int PingOnlyRounds=5;
 public static async Task<bool> Until(Func<Task<bool>> sshPort,Func<Task<bool>> ping,CancellationToken token){
  var end=DateTime.UtcNow+Limit;var pings=0;
  while(true){
   if(await sshPort())return true;
   // A custom SSH port is not known here: a Pi that answers ping for a while counts as back.
   pings=await ping()?pings+1:0;if(pings>=PingOnlyRounds)return true;
   if(DateTime.UtcNow>=end)return false;
   await Task.Delay(Every,token);
  }
 }
 public static async Task<bool> SshPort(string host){try{using var client=new System.Net.Sockets.TcpClient();using var timeout=new CancellationTokenSource(1500);await client.ConnectAsync(host,22,timeout.Token);return true;}catch{return false;}}
}

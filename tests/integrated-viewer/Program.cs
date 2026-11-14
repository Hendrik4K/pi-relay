// Offline checks for the integrated viewer's update logic. Metadata comes from a fake source;
// no network, no build and no PowerShell window are started.
using System.Text.Json;
using PiRelay;

var root=Path.GetFullPath(args[0]);var sandbox=Path.Combine(root,Guid.NewGuid().ToString("N"));
void Check(bool value,string message){if(!value)throw new Exception("FAIL: "+message);}
async Task Throws<T>(Func<Task> action,string message) where T:Exception{try{await action();}catch(T){return;}throw new Exception("FAIL: "+message);}
try{
 var project=Path.Combine(sandbox,"project");var release=Path.Combine(project,"release");var data=Path.Combine(sandbox,"data");
 Directory.CreateDirectory(Path.Combine(release,"ui"));Directory.CreateDirectory(Path.Combine(project,"scripts"));Directory.CreateDirectory(Path.Combine(project,"release-next"));
 File.WriteAllText(Path.Combine(release,"ui","integrated-viewer.json"),"{\"novnc\":\"1.7.0\"}");File.WriteAllText(Path.Combine(project,"scripts","update-novnc.ps1"),"#");File.WriteAllText(Path.Combine(project,"package.json"),"{}");
 var tags="{\"latest\":\"1.7.0\",\"beta\":\"1.8.0-beta\"}";var fetches=0;var offline=false;var notices=new List<string>();
 Task<string> Fetch(){fetches++;return offline?Task.FromException<string>(new HttpRequestException("offline")):Task.FromResult(tags);}
 IntegratedViewer Make(string app="")=>new(app==""?release:app,data,"0.4.0",Fetch,()=>{},notices.Add);

 Check(IntegratedViewer.ParseLatest(tags)=="1.7.0","dist-tag latest is read");
 await Throws<IOException>(()=>Task.FromResult(IntegratedViewer.ParseLatest("{\"latest\":\"1.8.0-beta.1\"}")),"Prereleases are never offered");

 var viewer=Make();
 Check(viewer.Installed=="1.7.0"&&viewer.ProjectRoot==project,"Bundled version and project build path are detected");
 offline=true;await viewer.Check();
 Check(viewer.Error.Length>0&&!viewer.HasUpdate&&viewer.Latest=="","Offline is an error, never 'up to date'");
 offline=false;await viewer.Check();
 Check(viewer.Error==""&&!viewer.HasUpdate&&notices.Count==0,"Same version: up to date, no notice");

 tags="{\"latest\":\"1.8.0\"}";await viewer.Check();await viewer.Check();
 Check(viewer.HasUpdate&&notices.Count==1&&notices[0].Contains("1.8.0"),"A new stable version is announced exactly once");
 Check(Make().HasUpdate&&notices.Count==1,"Cached state survives a restart without a second notice");

 await Throws<InvalidOperationException>(()=>{viewer.Skip("1.7.9");return Task.CompletedTask;},"Stale skip requests are rejected");
 viewer.Skip("1.8.0");Check(viewer.IsSkipped&&Make().IsSkipped,"Skipping persists");
 tags="{\"latest\":\"1.8.1\"}";await viewer.Check();
 Check(viewer.HasUpdate&&!viewer.IsSkipped&&notices.Count==2,"A later release reappears after a skip");
 viewer.Skip("1.8.1");viewer.Restore();Check(!viewer.IsSkipped,"Restore shows the skipped update again");

 var installed=Path.Combine(sandbox,"Programs","Pi Relay","release");Directory.CreateDirectory(Path.Combine(installed,"ui"));File.WriteAllText(Path.Combine(installed,"ui","integrated-viewer.json"),"{\"novnc\":\"1.7.0\"}");
 var plain=Make(installed);Check(plain.ProjectRoot==null,"An installed copy without project offers no local build");
 await plain.Check();
 await Throws<InvalidOperationException>(()=>{plain.StartBuild("1.8.1");return Task.CompletedTask;},"Without a project the build is refused");
 await Throws<InvalidOperationException>(()=>{viewer.StartBuild("1.8.0");return Task.CompletedTask;},"A build for a stale version is refused");
 await Throws<InvalidOperationException>(()=>{viewer.StartActivation(1);return Task.CompletedTask;},"Nothing to activate without a tested build");

 var info=Path.Combine(project,"release-next","build-info.json");
 void Stage(string version,bool passed)=>File.WriteAllText(info,JsonSerializer.Serialize(new{appVersion=version,noVnc="1.8.1",builtAt=DateTimeOffset.Now,testsPassed=passed}));
 Stage("0.4.1",true);Check(viewer.Staged==null,"No staged build without its executable");
 File.WriteAllText(Path.Combine(project,"release-next","PiRelay.exe"),"x");
 Check(viewer.Staged is {AppVersion:"0.4.1",NoVnc:"1.8.1"},"A tested newer build is offered for activation");
 Stage("0.4.1",false);Check(viewer.Staged==null,"Untested builds are never offered");
 Stage("0.4.0",true);Check(viewer.Staged==null,"The running version is not offered again");

 var snapshot=JsonDocument.Parse(Json.Encode(viewer.Snapshot(true))).RootElement;
 Check(snapshot.GetProperty("installed").GetString()=="1.7.0"&&snapshot.GetProperty("latest").GetString()=="1.8.1"&&snapshot.GetProperty("sshActive").GetBoolean()&&snapshot.GetProperty("canBuild").GetBoolean(),"Snapshot carries versions and SSH state");

 var before=fetches;var fresh=Make();fresh.Tick();await Task.Delay(50);
 Check(fetches==before,"Daily check does not repeat within 24 hours");
 File.Delete(Path.Combine(data,"integrated-viewer.json"));var reset=Make();reset.Tick();await Task.Delay(50);
 Check(fetches==before+1,"First run checks once");
 // Relaunch: the path (with ASCII and typographic quotes) travels only in the environment; the script
 // text contains no path, parses cleanly, and PowerShell comes from System32.
 var oddPath=@"C:\Apps\O’Brien's Pi ‘Relay’\release\PiRelay.exe";var relaunch=Relaunch.Info(4242,oddPath);
 var encoded=relaunch.ArgumentList[relaunch.ArgumentList.IndexOf("-EncodedCommand")+1];var script=System.Text.Encoding.Unicode.GetString(Convert.FromBase64String(encoded));
 Check(Path.IsPathRooted(relaunch.FileName)&&relaunch.FileName.StartsWith(Environment.SystemDirectory,StringComparison.OrdinalIgnoreCase)&&File.Exists(relaunch.FileName),"PowerShell is started from System32: "+relaunch.FileName);
 Check(relaunch.Environment[Relaunch.ExeVariable]==oddPath&&!script.Contains("Brien")&&script.Contains("$env:"+Relaunch.ExeVariable)&&script.Contains("Wait-Process -Id 4242"),"Path only in the environment: "+script);
 var parse=new System.Diagnostics.ProcessStartInfo(Relaunch.PowerShell){UseShellExecute=false,RedirectStandardOutput=true,CreateNoWindow=true};
 foreach(var a in new[]{"-NoProfile","-NonInteractive","-Command","$e=$null;$t=$null;$ast=[System.Management.Automation.Language.Parser]::ParseInput($env:PI_RELAY_SCRIPT,[ref]$t,[ref]$e);$e.Count"})parse.ArgumentList.Add(a);
 parse.Environment["PI_RELAY_SCRIPT"]=script;
 using(var ps=System.Diagnostics.Process.Start(parse)!){var output=ps.StandardOutput.ReadToEnd().Trim();ps.WaitForExit();Check(output=="0","Relaunch script parses without errors: "+output);}
 // External viewer port: only the process that opened the connection is recognised, not others.
 {var listener=new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,0);listener.Start();var listenPort=((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
  using var client=new System.Net.Sockets.TcpClient();await client.ConnectAsync(System.Net.IPAddress.Loopback,listenPort);using var accepted=await listener.AcceptTcpClientAsync();
  var peer=(System.Net.IPEndPoint)accepted.Client.RemoteEndPoint!;
  Check(LoopbackPeer.OwnerProcessId(peer,listenPort)==Environment.ProcessId,"The connecting process is identified");
  Check(LoopbackPeer.IsFrom(peer,listenPort,Environment.ProcessPath!)&&!LoopbackPeer.IsFrom(peer,listenPort,Path.Combine(Environment.SystemDirectory,"notepad.exe")),"Only the expected viewer executable is accepted");
  {var shortName=new System.Text.StringBuilder(1024);if(GetShortPathName(Environment.ProcessPath!,shortName,shortName.Capacity)>0&&shortName.ToString()!=Environment.ProcessPath)Check(LoopbackPeer.IsFrom(peer,listenPort,shortName.ToString()),"Short 8.3 spelling of the viewer path is accepted too");}
  listener.Stop();}
 // Own pictures: decoded, downscaled to <=1600 px, re-encoded as PNG; garbage and unknown slots are refused.
 var iconStore=new IconStore(Path.Combine(sandbox,"data"));var big=Path.Combine(sandbox,"big.jpg");
 using(var bmp=new System.Drawing.Bitmap(3200,1600)){bmp.Save(big,System.Drawing.Imaging.ImageFormat.Jpeg);}
 iconStore.Import("claude",big);var stored=Path.Combine(iconStore.Folder,"claude.png");
 using(var check=System.Drawing.Image.FromFile(stored)){Check(check.Width==1600&&check.Height==800&&check.RawFormat.Guid==System.Drawing.Imaging.ImageFormat.Png.Guid,"Imported picture is a bounded PNG");}
 Check(iconStore.Snapshot().Keys.SequenceEqual(new[]{"claude"}),"Snapshot lists own pictures only");
 var fake=Path.Combine(sandbox,"fake.png");File.WriteAllText(fake,"not an image");
 try{iconStore.Import("codex",fake);Check(false,"Non-images must be refused");}catch(InvalidOperationException){}
 try{iconStore.Import("../evil",big);Check(false,"Unknown slots must be refused");}catch(InvalidOperationException){}
 iconStore.Reset("claude");Check(iconStore.Snapshot().Count==0&&!File.Exists(stored),"Reset restores the bundled picture");
 // Tray clicks: ignored while sliding in, reverse while sliding out; the in-panel collapse only when fully shown.
 Check(PanelMotion.OnTrayClick(PanelPhase.Revealing)==PanelAction.Ignore&&PanelMotion.OnTrayClick(PanelPhase.Collapsing)==PanelAction.Reverse&&PanelMotion.OnTrayClick(PanelPhase.Visible)==PanelAction.Collapse&&PanelMotion.OnTrayClick(PanelPhase.Hidden)==PanelAction.Reveal,"Tray click follows the slide phase");
 Check(PanelMotion.MayCollapse(PanelPhase.Visible)&&!PanelMotion.MayCollapse(PanelPhase.Revealing)&&!PanelMotion.MayCollapse(PanelPhase.Collapsing),"Collapse only from a fully shown panel");
 // Reachability: ping only, two misses before "offline", a live SSH session always counts as online.
 var answers=new Queue<bool>(new[]{true,false,false,true});var changes=0;
 var reach=new HostReachability(()=>changes++,_=>Task.FromResult(answers.Dequeue()));
 string State()=>reach.Snapshot()["192.168.1.50"];
 await reach.Check(["192.168.1.50"],_=>false);Check(State()=="online"&&changes==1,"First answer marks online");
 await reach.Check(["192.168.1.50"],_=>false);Check(State()=="online"&&changes==1,"One missed ping does not flip the state");
 await reach.Check(["192.168.1.50"],_=>false);Check(State()=="offline"&&changes==2,"Two misses in a row mark offline");
 await reach.Check(["192.168.1.50"],_=>false);Check(State()=="online"&&changes==3,"Recovers on the next answer");
 PiWait.Every=TimeSpan.FromMilliseconds(5);PiWait.Limit=TimeSpan.FromSeconds(5);
 var sshTries=0;Check(await PiWait.Until(()=>Task.FromResult(++sshTries>=3),()=>Task.FromResult(false),default)&&sshTries==3,"Waits until the SSH port answers");
 var pingTries=0;Check(await PiWait.Until(()=>Task.FromResult(false),()=>Task.FromResult(++pingTries>0),default)&&pingTries==PiWait.PingOnlyRounds,"Steady ping counts as back when the SSH port is unknown");
 PiWait.Limit=TimeSpan.FromMilliseconds(60);Check(!await PiWait.Until(()=>Task.FromResult(false),()=>Task.FromResult(false),default),"Gives up after the limit");
 PiWait.Limit=TimeSpan.FromSeconds(5);using(var cancelWait=new CancellationTokenSource(40)){var cancelled=false;try{await PiWait.Until(()=>Task.FromResult(false),()=>Task.FromResult(false),cancelWait.Token);}catch(OperationCanceledException){cancelled=true;}Check(cancelled,"Cancelling the wait stops it");}
 var never=new HostReachability(()=>{},_=>Task.FromResult(false));
 await never.Check(["10.0.0.5"],_=>true);await never.Check(["10.0.0.5"],_=>true);Check(never.Snapshot()["10.0.0.5"]=="online","A live SSH session overrides failing ICMP");
 await never.Check([],_=>false);Check(never.Snapshot().Count==0,"Removed addresses disappear");
 // Pi address change: every alias on the old host moves, other hosts and comments stay, trusted keys move along.
 var config="Host MasterControl\r\n    HostName 192.168.1.50\r\n    User pi\r\n\r\nHost BackDoor\r\n    hostname=192.168.1.50\r\n\r\nHost Phone\r\n    HostName 192.168.1.142\r\n# HostName 192.168.1.50\r\n";
 var (moved,count)=SshHostEdit.ReplaceHostName(config,"192.168.1.50","192.168.1.61");
 Check(count==2&&moved.Contains("    HostName 192.168.1.61\r\n")&&moved.Contains("hostname=192.168.1.61\r\n")&&moved.Contains("HostName 192.168.1.142")&&moved.Contains("# HostName 192.168.1.50"),"HostName moves for both aliases only: "+moved);
 var known="192.168.1.50 ssh-ed25519 AAAA1\n192.168.1.50 ssh-rsa AAAA2\n[192.168.1.142]:8022 ssh-ed25519 AAAA3\n";
 var (carried,added)=SshHostEdit.CarryKnownHosts(known,"192.168.1.50","192.168.1.61");
 Check(added==2&&carried.StartsWith(known)&&carried.EndsWith("192.168.1.61 ssh-ed25519 AAAA1\n192.168.1.61 ssh-rsa AAAA2\n"),"Trusted keys carried to the new address");
 Check(SshHostEdit.CarryKnownHosts(carried,"192.168.1.50","192.168.1.61").Added==0,"Existing entries for the new address are never overwritten");
 var back=SshHostEdit.CarryKnownHosts(carried,"192.168.1.61","192.168.1.50");
 Check(back.Added==0&&!back.Text.Contains("192.168.1.61")&&back.Text.Contains("192.168.1.50 ssh-ed25519 AAAA1")&&back.Text.Contains("[192.168.1.142]:8022"),"Moving back removes the carried copies only: "+back.Text);
 var foreign=SshHostEdit.CarryKnownHosts(known+"192.168.1.61 ssh-ed25519 OTHER\n","192.168.1.61","192.168.1.50");
 Check(foreign.Text.Contains("192.168.1.61 ssh-ed25519 OTHER"),"Keys that are not copies stay untouched");
 Check(SshHostEdit.ValidHost("192.168.1.61")&&SshHostEdit.ValidHost("raspberrypi.local")&&!SshHostEdit.ValidHost("1.2.3.4 -oProxyCommand=x")&&!SshHostEdit.ValidHost("")&&!SshHostEdit.ValidHost("-p"),"Only plain host names or addresses are accepted");
 var ssh=Path.Combine(sandbox,"ssh");Directory.CreateDirectory(ssh);File.WriteAllText(Path.Combine(ssh,"config"),config);File.WriteAllText(Path.Combine(ssh,"known_hosts"),known);
 var applied=SshHostEdit.Apply(ssh,"192.168.1.50","192.168.1.61");
 Check(applied==(2,2)&&File.ReadAllText(Path.Combine(ssh,"config"))==moved&&Directory.GetFiles(ssh,"*.bak-pirelay-*").Length==2,"Apply rewrites in place with backups");
 try{SshHostEdit.Apply(ssh,"10.0.0.9","10.0.0.10");Check(false,"Unknown old host must fail");}catch(InvalidOperationException){}
 Console.WriteLine("PASS: relaunch path only via environment + System32 PowerShell, viewer port bound to the launched viewer, own pictures (bounded PNG, refusals, reset), tray click phases, reachability (ping only, 2-miss debounce, SSH overrides), wait for a restarting Pi (SSH port, steady ping, limit, cancel), Pi address edit (both aliases, comments/other hosts untouched, keys carried, no overwrite, input validation, backups), relaunch through Explorer after exit (quoted path), stable dist-tag only, offline is not current, single notice, persisted skip/restore, later release reappears, no build without project or for stale version, only tested newer builds are activatable, daily check cadence. No network or process start.");
}finally{try{Directory.Delete(sandbox,true);}catch{}}
[System.Runtime.InteropServices.DllImport("kernel32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode)] static extern int GetShortPathName(string longPath,System.Text.StringBuilder shortPath,int size);

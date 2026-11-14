// Integrated-viewer transport checks against the real Python worker and a local mock VNC
// endpoint. No SSH, no Pi and no user window are involved.
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using PiRelay;

var python=args[0];
var worker=Path.GetFullPath("native/remote_worker.py");var shim=Path.GetFullPath("tests/screen-bridge/vnc_port_shim.py");
var server=new TcpListener(IPAddress.Loopback,0);server.Start();var port=((IPEndPoint)server.LocalEndpoint).Port;
int accepted=0,serverClosed=0,launches=0,ensured=0;
_=Task.Run(async()=>{while(true){TcpClient client;try{client=await server.AcceptTcpClientAsync();}catch{return;}Interlocked.Increment(ref accepted);_=Serve(client);}});
async Task Serve(TcpClient client){
 using(client){var stream=client.GetStream();await stream.WriteAsync(Encoding.ASCII.GetBytes("RFB 003.008\n"));var buffer=new byte[65536];int count;var text=new StringBuilder();
  try{while((count=await stream.ReadAsync(buffer))>0){
   var chunk=Encoding.ASCII.GetString(buffer,0,count);text.Append(chunk);
   if(text.ToString().EndsWith("BIG")){text.Clear();var big=new byte[2*1024*1024];for(var i=0;i<big.Length;i++)big[i]=(byte)(i*7);await stream.WriteAsync(big);continue;}
   if(text.ToString().EndsWith("BYE"))break;
   if(text.Length>4096)text.Remove(0,text.Length-16);
   await stream.WriteAsync(buffer.AsMemory(0,count));
  }}catch(IOException){}
 }
 Interlocked.Increment(ref serverClosed);
}
// The worker resolves its inbox under the home folder; point that at a scratch folder for the test.
var home=Path.Combine(Path.GetTempPath(),"pi-relay-inbox-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(home);
var session=new SharedSession("MeinPi",()=>{},_=>{Interlocked.Increment(ref launches);var start=Discovery.StartInfo(python,"-u",shim,port.ToString(),worker);start.RedirectStandardInput=true;start.Environment["USERPROFILE"]=home;start.Environment["HOME"]=home;return start;});
var posts=new ConcurrentQueue<JsonElement>();
void Post(object message)=>posts.Enqueue(JsonDocument.Parse(Json.Encode(message)).RootElement.Clone());
// Raw screen bytes, as the window receives them before handing them to the page as shared memory.
var chunks=new ConcurrentQueue<byte[]>();
void Data(byte[] chunk)=>chunks.Enqueue(chunk);
// Mirrors RelayWindow.EnsureConnection: reuse a ready transport, authenticate only when asked.
bool allowLogin=true;
async Task<SharedSession> Ensure(){Interlocked.Increment(ref ensured);if(session.IsReady)return session;if(!allowLogin)throw new InvalidOperationException("SSH-Zugang zuerst verbinden");await session.Connect();return session;}
void Require(bool value,string message){if(!value)throw new Exception("FAIL: "+message);}
async Task Until(Func<bool> condition,string message,int ms=8000){var deadline=DateTime.UtcNow.AddMilliseconds(ms);while(!condition()){if(DateTime.UtcNow>deadline)throw new Exception("FAIL (timeout): "+message);await Task.Delay(15);}}
byte[] Received(int skip=0)=>chunks.SelectMany(c=>c).Skip(skip).ToArray();
int Count(string type)=>posts.Count(p=>p.GetProperty("type").GetString()==type);
JsonElement Last(string type)=>posts.Last(p=>p.GetProperty("type").GetString()==type);

try{
 Require(SharedSession.Explain("ssh: connect to host 192.168.1.50 port 22: Connection timed out").StartsWith("Pi nicht erreichbar")&&SharedSession.Explain("Permission denied (publickey)").StartsWith("SSH-Verbindung beendet"),"Unreachable Pi gets a clear explanation");
 var bridge=new ScreenBridge("MeinPi",Ensure,Post,Data);
 await Task.WhenAll(bridge.Open(),bridge.Open());
 await Until(()=>Count("screenOpened")==1,"tunnel opens");
 await Until(()=>Encoding.ASCII.GetString(Received()).StartsWith("RFB 003.008\n"),"banner arrives through the shared transport");
 Require(launches==1&&accepted==1,"Double open uses one SSH transport and one VNC connection");

 var expected=new StringBuilder();
 for(var i=0;i<300;i++){var part="<"+i+">";expected.Append(part);bridge.Send(Encoding.ASCII.GetBytes(part));}
 await Until(()=>Received(12).Length>=expected.Length,"echo of queued input");
 Require(Encoding.ASCII.GetString(Received(12))==expected.ToString(),"Input bytes stay ordered and intact");

 var before=Received().Length;bridge.Send(Encoding.ASCII.GetBytes("BIG"));
 await Until(()=>Received().Length>=before+2*1024*1024,"2 MiB framebuffer burst",20000);
 var burst=Received(before);var intact=true;for(var i=0;i<2*1024*1024;i++)if(burst[i]!=(byte)(i*7)){intact=false;break;}
 Require(intact&&burst.Length==2*1024*1024,"Large server output passes the bounded channel intact");
 Require(chunks.Any(c=>c.Length>32768)&&!posts.Any(p=>p.GetProperty("type").GetString()=="screenData"),"Screen data arrives as raw blocks larger than 32 KB, never as base64 messages");

 bridge.Close();
 await Until(()=>Count("screenClosed")==1&&serverClosed==1,"viewer close releases only the VNC stream");
 Require(!Last("screenClosed").GetProperty("error").GetBoolean(),"User close is not an error");
 Require(session.IsReady&&launches==1,"Closing the viewer keeps the SSH transport");

 var opened=Count("screenOpened");await bridge.Open();
 await Until(()=>Count("screenOpened")==opened+1&&accepted==2,"reconnect");
 Require(launches==1,"Reconnect reuses the healthy SSH session without a second authentication");

 bridge.Send(Encoding.ASCII.GetBytes("BYE"));
 await Until(()=>Count("screenClosed")==2,"server-side end is reported");
 Require(Last("screenClosed").GetProperty("retry").GetBoolean(),"A Pi-side end with SSH still up lets the viewer reopen by itself");
 await Task.Delay(500);
 Require(accepted==2&&bridge.State is "closed" or "error","No automatic reconnect after the Pi ends the stream");

 await bridge.Open(auto:true);await Until(()=>accepted==3&&bridge.State=="open","automatic reopen on the live transport");
 Require(launches==1,"Automatic reopen reuses the SSH transport");
 session.Dispose();
 await Until(()=>Count("screenClosed")==3,"SSH loss is reported to the viewer");
 Require(Last("screenClosed").GetProperty("error").GetBoolean(),"SSH loss is shown as an error");
 await Task.Delay(700);
 Require(launches==1&&accepted==3,"SSH loss starts no login and no retry loop");

 Require(!Last("screenClosed").GetProperty("retry").GetBoolean(),"After SSH loss the viewer does not reopen by itself");
 var ensuredAuto=ensured;await bridge.Open(auto:true);
 Require(launches==1&&ensured==ensuredAuto&&bridge.State=="error"&&!Last("screenClosed").GetProperty("retry").GetBoolean(),"An automatic reopen without live SSH never asks for a login");
 allowLogin=false;var ensuredBefore=ensured;await bridge.Open();
 Require(launches==1&&ensured==ensuredBefore+1&&bridge.State=="error","Without an allowed login the viewer reports instead of authenticating");

 allowLogin=true;await bridge.Open();await Until(()=>bridge.State=="open"&&accepted==4,"explicit reconnect after loss");
 Require(launches==2,"Only the explicit user action created the new SSH transport");
 var closedBefore=Count("screenClosed");bridge.Dispose();
 await Until(()=>serverClosed==4,"disposing the window releases its VNC stream");
 await Task.Delay(300);
 Require(Count("screenClosed")==closedBefore&&session.IsReady,"Dispose posts nothing further and keeps SSH");
 bridge.Send(Encoding.ASCII.GetBytes("ignored"));await bridge.Open();
 Require(accepted==4,"A disposed bridge never reconnects");

 // Dropped files: chunked into the fixed inbox over the same transport, no new login.
 bridge=new ScreenBridge("MeinPi",Ensure,Post,Data);var token=Convert.ToHexString(Guid.NewGuid().ToByteArray()).ToLowerInvariant();var payload=new byte[2_500_000];for(var i=0;i<payload.Length;i++)payload[i]=(byte)(i*13);
 JsonElement last=default;for(var offset=0;offset<payload.Length;offset+=786432){var part=payload.AsSpan(offset,Math.Min(786432,payload.Length-offset)).ToArray();last=await bridge.Inbox("inbox_write",new{token,offset,data=Convert.ToBase64String(part),final=offset+part.Length>=payload.Length,name="../Bericht.pdf"});}
 var saved=last.GetProperty("path").GetString()!;
 Require(Path.GetDirectoryName(saved)==home&&File.ReadAllBytes(saved).SequenceEqual(payload),"Dropped file arrives intact in the inbox: "+saved);
 Require(launches==2,"File drop reuses the SSH transport");
 bridge.Dispose();

 // VNC server not listening yet (desktop still logging in after a restart): wait on the same transport.
 SharedSession.VncWait=TimeSpan.FromSeconds(20);SharedSession.VncRetry=TimeSpan.FromMilliseconds(250);
 server.Stop();var acceptedBefore=accepted;
 bridge=new ScreenBridge("MeinPi",Ensure,Post,Data);var opening=bridge.Open();
 await Until(()=>posts.Any(p=>p.GetProperty("type").GetString()=="screenState"&&p.GetProperty("state").GetString()=="waiting"),"missing VNC server is reported as waiting");
 var openedBefore=Count("screenOpened");
 server=new TcpListener(IPAddress.Loopback,port);server.Start();
 _=Task.Run(async()=>{var listener=server;while(true){TcpClient client;try{client=await listener.AcceptTcpClientAsync();}catch{return;}Interlocked.Increment(ref accepted);_=Serve(client);}});
 await Until(()=>Count("screenOpened")==openedBefore+1,"viewer opens once the VNC server listens");await opening;
 Require(launches==2&&accepted==acceptedBefore+1,"Waiting reuses the SSH transport and opens one VNC stream");
 bridge.Dispose();
 server.Stop();var closedWaiting=Count("screenClosed");
 bridge=new ScreenBridge("MeinPi",Ensure,Post,Data);opening=bridge.Open();
 await Until(()=>posts.Count(p=>p.GetProperty("type").GetString()=="screenState"&&p.GetProperty("state").GetString()=="waiting")>=2,"second wait starts");
 bridge.Close();await opening;
 Require(Count("screenClosed")==closedWaiting+1&&!Last("screenClosed").GetProperty("error").GetBoolean(),"Cancelling the wait closes quietly");
 SharedSession.VncWait=TimeSpan.FromMilliseconds(600);
 bridge=new ScreenBridge("MeinPi",Ensure,Post,Data);await bridge.Open();
 Require(Last("screenClosed").GetProperty("error").GetBoolean()&&Last("screenClosed").GetProperty("message").GetString()!.Contains("x11vnc")&&session.IsReady,"Gives up after the limit with a clear message and keeps SSH");
 bridge.Dispose();
 var windows=new SingleInstances<object>();var first=windows.GetOrCreate("MeinPi",()=>new object(),out var created1);var again=windows.GetOrCreate("MeinPi",()=>new object(),out var created2);
 Require(created1&&!created2&&ReferenceEquals(first,again),"A second open focuses the existing window instead of creating one");
 windows.Release("MeinPi",new object());Require(windows.Keys.Count==1,"A stale window cannot release the current one");
 windows.Release("MeinPi",first);Require(windows.Keys.Count==0,"Closing releases the alias");

 Console.WriteLine("PASS: unreachable explanation, patient wait for a VNC server that starts late (cancel, limit),  dropped file chunks into the fixed inbox (sanitized name, intact), one transport/one VNC stream per open, ordered input without reply round trips, 2 MiB burst as raw blocks over 32 KB, close keeps SSH, reconnect without re-auth, automatic reopen only on a live transport (never a login), explicit login only, dispose cleanup, single window per alias.");
}finally{session.Dispose();server.Stop();try{Directory.Delete(home,true);}catch{}}

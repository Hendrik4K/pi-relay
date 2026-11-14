using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace PiRelay;

// The transport belongs to an SSH alias, not to an agent or a window.
public sealed class SharedSession : IDisposable {
 private Process? process;
 private readonly SemaphoreSlim writes=new(1,1), connect=new(1,1);
 private readonly ConcurrentDictionary<long,TaskCompletionSource<JsonElement>> pending=new();
 private readonly ConcurrentDictionary<int,Channel<byte[]>> sockets=new();
 private TaskCompletionSource<bool>? welcome;
 private readonly Action changed;
 private readonly Func<string,ProcessStartInfo>? launch;
 private readonly object historyLock=new();
 private readonly Queue<byte[]> history=new();
 private int historySize;
 private long sequence;
 private string lastErrorLine="";
 private TcpListener? vnc;
 private CancellationTokenSource? tunnelLifetime;
 public event Action<string>? TerminalOutput;
 public event Action<string>? TerminalState;
 public string Alias {get;}
 public string State {get;private set;}="disconnected";
 public string LastError {get;private set;}="";
 public SharedSession(string alias,Action changed):this(alias,changed,null){}
 internal SharedSession(string alias,Action changed,Func<string,ProcessStartInfo>? launch){Alias=alias;this.changed=changed;this.launch=launch;}
 public bool IsReady {get{var owner=process;try{return State=="ready"&&owner is {HasExited:false};}catch(InvalidOperationException){return false;}}}
 public byte[] TerminalHistory {get{lock(historyLock)return history.SelectMany(x=>x).ToArray();}}
 public static string Quote(string value)=>"'"+value.Replace("'","'\\''")+"'";

 public async Task Connect(){
  await connect.WaitAsync();
  try{
   if(IsReady)return;
   if(!Discovery.ValidAlias(Alias))throw new InvalidOperationException("Ungültiger SSH-Zugang");
   // "connecting" until ssh really asks for the security key; an unreachable Pi never shows a key prompt.
   Stop();State="connecting";LastError="";lastErrorLine="";changed();
   lock(historyLock){history.Clear();historySize=0;}
   using var resource=typeof(SharedSession).Assembly.GetManifestResourceStream("PiRelay.remote_worker.py")??throw new IOException("SSH-Worker fehlt");
   using var reader=new StreamReader(resource);var code=await reader.ReadToEndAsync();
   var bootstrap="import base64;exec(base64.b64decode("+Quote(Convert.ToBase64String(Encoding.UTF8.GetBytes(code)))+"))";
   // -I: no imports from the home folder or user site-packages, no PYTHON* variables.
   var command="python3 -I -u -c "+Quote(bootstrap);
   // Screen data is already compressed (JPEG/zlib); SSH compression would only add delay. Forwardings
   // from ~/.ssh/config (agent, X11, ports, LocalCommand) never apply to this dedicated transport.
   var info=Discovery.StartInfo(Discovery.SshExe,"-T","-a","-x","-o","ClearAllForwardings=yes","-o","PermitLocalCommand=no","-o","StrictHostKeyChecking=yes","-o","Compression=no","-o","ConnectTimeout=15","-o","ConnectionAttempts=1","-o","ServerAliveInterval=30","-o","ServerAliveCountMax=10",Alias,command);
   info.RedirectStandardInput=true;
   var handshake=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);welcome=handshake;
   var owner=Process.Start(launch?.Invoke(Alias)??info)??throw new IOException("SSH konnte nicht starten");process=owner;owner.StandardInput.AutoFlush=true;
   // Read off the UI thread, so window work never holds up the screen stream (and the reverse).
   _=Task.Run(()=>ReadErrors(owner));_=Task.Run(()=>ReadMessages(owner));
   await handshake.Task.WaitAsync(TimeSpan.FromSeconds(80));
   State="ready";LastError="";changed();
  }catch(Exception e){LastError=e.Message;Stop();State="error";changed();throw;}finally{connect.Release();}
 }
 private async Task ReadErrors(Process owner){try{while(await owner.StandardError.ReadLineAsync() is {} line){if(!string.IsNullOrWhiteSpace(line))lastErrorLine=line.Length>300?line[..300]:line.Trim();if(State=="connecting"&&(line.Contains("Confirm user presence")||line.Contains("Enter PIN"))){State="key";changed();}if(line.Contains("Permission denied")||line.Contains("signing failed")||line.Contains("Host key verification failed")||line.Contains("Error:"))LastError=line.Length>400?line[..400]:line;}}catch{}}
 private async Task ReadMessages(Process owner){
  try{
   var output=new WorkerOutput(owner.StandardOutput.BaseStream);
   while(await output.ReadLine(3000000) is {} line){
    using var doc=JsonDocument.Parse(line);var value=doc.RootElement;
    if(value.TryGetProperty("ready",out _)){if(value.GetProperty("protocol").GetInt32()!=3)throw new IOException("Unbekanntes Verbindungsprotokoll");welcome?.TrySetResult(true);continue;}
    if(value.TryGetProperty("event",out var ev)){
     switch(ev.GetString()){
      case "terminal_output":var data=value.GetProperty("data").GetString()!;var bytes=Convert.FromBase64String(data);lock(historyLock){history.Enqueue(bytes);historySize+=bytes.Length;while(historySize>262144&&history.Count>1)historySize-=history.Dequeue().Length;}TerminalOutput?.Invoke(data);break;
      case "terminal_exit":TerminalState?.Invoke("Shell beendet. Über das Terminal-Symbol erneut öffnen.");break;
      // Raw screen bytes follow the header; they are always consumed so the stream stays aligned.
      case "tcp_data":{var size=value.GetProperty("size").GetInt32();if(size<0||size>WorkerOutput.MaxBlock)throw new IOException("Antwort zu groß");var queue=SocketChannel(value.GetProperty("channel").GetInt32());if(!queue.Writer.TryWrite(await output.ReadBytes(size)))queue.Writer.TryComplete(new IOException("VNC-Empfänger ist zu langsam"));break;}
      case "tcp_closed":{var queue=SocketChannel(value.GetProperty("channel").GetInt32());if(value.TryGetProperty("error",out var reason))queue.Writer.TryComplete(new IOException(reason.GetString()));else queue.Writer.TryComplete();break;}
     }continue;
    }
    if(value.TryGetProperty("id",out var id)&&id.TryGetInt64(out var number)&&pending.TryRemove(number,out var completion))completion.TrySetResult(value.Clone());
   }
   throw new IOException("SSH-Verbindung beendet. In Pi Relay erneut verbinden.");
  }catch(Exception e){if(ReferenceEquals(process,owner)){
   // Keyword-free ssh failures (e.g. unreachable host) still need a visible reason.
   if(string.IsNullOrEmpty(LastError)){await Task.Delay(200);LastError=lastErrorLine!=""?Explain(lastErrorLine):e.Message;}welcome?.TrySetException(new IOException(LastError));Stop();State="error";TerminalState?.Invoke(LastError);changed();}}
 }
 internal static string Explain(string sshLine){
  string[] unreachable=["timed out","No route to host","Network is unreachable","Connection refused","Could not resolve hostname"];
  return unreachable.Any(sshLine.Contains)?"Pi nicht erreichbar. Ist er eingeschaltet und im Netz? Sonst die IP neben dem Gerät prüfen. ("+sshLine+")":"SSH-Verbindung beendet: "+sshLine;
 }
 private Channel<byte[]> SocketChannel(int channel)=>sockets.GetOrAdd(channel,_=>Channel.CreateBounded<byte[]>(new BoundedChannelOptions(128){SingleReader=true,FullMode=BoundedChannelFullMode.Wait}));
 public async Task<JsonElement> Request(string op,object? args=null,AgentConfig? config=null){
  if(!IsReady)throw new InvalidOperationException("SSH-Zugang in Pi Relay zuerst verbinden");
  var id=Interlocked.Increment(ref sequence);var completion=new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);pending[id]=completion;
  try{
   await Write(Json.Encode(new{id,op,args=args??new{},config}));
   var result=await completion.Task.WaitAsync(TimeSpan.FromSeconds(45));
   if(!result.GetProperty("ok").GetBoolean())throw new InvalidOperationException(result.GetProperty("error").GetString());
   return result.GetProperty("result").Clone();
  }catch(TimeoutException){throw new IOException("Zeitlimit erreicht. Der Auftrag wird nicht automatisch wiederholt.");}finally{pending.TryRemove(id,out _);}
 }
 // Without an id the worker sends no answer (VNC input); a failure ends that stream instead.
 public Task Notify(string op,object args)=>Write(Json.Encode(new{op,args}));
 // One line at a time; the process is read once because the reader may stop it meanwhile.
 private async Task Write(string line){
  await writes.WaitAsync();
  try{var target=process;if(!IsReady||target==null)throw new IOException("SSH-Verbindung beendet");await target.StandardInput.WriteLineAsync(line);}
  finally{writes.Release();}
 }
 private string? vncViewer;
 // The port is for the external viewer Pi Relay starts (`viewerExe`); connections from any other
 // program or Windows account on this PC are closed before they reach the Pi.
 public async Task<int> VncPort(string viewerExe){
  if(!IsReady)throw new InvalidOperationException("SSH-Zugang zuerst verbinden");
  vncViewer=viewerExe;
  if(vnc!=null)return ((IPEndPoint)vnc.LocalEndpoint).Port;
  vnc=new TcpListener(IPAddress.Loopback,0);vnc.Start();tunnelLifetime=new();_=AcceptVnc(vnc,tunnelLifetime.Token);
  return ((IPEndPoint)vnc.LocalEndpoint).Port;
 }
 private async Task AcceptVnc(TcpListener listener,CancellationToken token){
  try{while(!token.IsCancellationRequested){
   var client=await listener.AcceptTcpClientAsync(token);
   var peer=(IPEndPoint)client.Client.RemoteEndPoint!;var viewer=vncViewer;
   if(viewer==null||!LoopbackPeer.IsFrom(peer,((IPEndPoint)listener.LocalEndpoint).Port,viewer)){client.Dispose();LastError="Bildschirm: Zugriff eines anderen Programms auf den Viewer-Port abgelehnt.";changed();continue;}
   _=ForwardVnc(client,token);
  }}catch(OperationCanceledException){}catch(SocketException){}
 }
 private async Task ForwardVnc(TcpClient client,CancellationToken token){
  try{
   using(client){await using var tunnel=await OpenTunnel();var stream=client.GetStream();
    async Task Receive(){await foreach(var chunk in tunnel.Incoming.ReadAllAsync(token))await stream.WriteAsync(chunk,token);}
    async Task Send(){var buffer=new byte[32768];int count;while((count=await stream.ReadAsync(buffer,token))>0)await tunnel.Send(buffer.AsMemory(0,count));}
    var receiving=Receive();var sending=Send();await Task.WhenAny(receiving,sending);client.Close();await tunnel.DisposeAsync();try{await Task.WhenAll(receiving,sending);}catch{}
   }
  }catch(Exception e){LastError="Bildschirm: "+e.Message;changed();client.Dispose();}
 }
 // One TCP stream to the Pi's fixed VNC endpoint inside this transport; never a new SSH login.
 public async Task<TcpTunnel> OpenTunnel(){var opened=await Request("tcp_open");var channel=opened.GetProperty("channel").GetInt32();return new TcpTunnel(this,channel,SocketChannel(channel).Reader);}
 public const string VncMissing="VNC-Server auf dem Pi nicht aktiv";
 internal static TimeSpan VncWait=TimeSpan.FromMinutes(2),VncRetry=TimeSpan.FromSeconds(3);
 // After a Pi restart the VNC server (WayVNC, x11vnc or TigerVNC) may start a little after the desktop
 // login. Retry the fixed endpoint on this transport only; never a new SSH login.
 public async Task<TcpTunnel> OpenTunnelWaiting(Action<int>? waiting=null,CancellationToken token=default){
  var end=DateTime.UtcNow+VncWait;
  while(true){
   try{return await OpenTunnel();}
   catch(InvalidOperationException e) when(e.Message.Contains(VncMissing)&&IsReady&&DateTime.UtcNow<end){
    waiting?.Invoke((int)Math.Ceiling((end-DateTime.UtcNow).TotalSeconds));
    await Task.Delay(VncRetry,token);
   }
   catch(InvalidOperationException e) when(e.Message.Contains(VncMissing)){throw new InvalidOperationException(VncMissing+" (127.0.0.1:5900). Läuft auf dem Pi ein VNC-Server (WayVNC, x11vnc oder TigerVNC)?");}
  }
 }
 internal static bool Unreachable(string message)=>message.StartsWith("Pi nicht erreichbar",StringComparison.Ordinal);
 internal async Task CloseTunnel(int channel){if(sockets.TryRemove(channel,out var queue))queue.Writer.TryComplete();if(IsReady)try{await Request("tcp_close",new{channel});}catch{}}
 public void Refresh(){if(process is {HasExited:true}&&State=="ready"){Stop();State="error";changed();}}
 private void Stop(){
  var owner=process;process=null;
  welcome?.TrySetException(new IOException("Verbindung beendet"));welcome=null;
  tunnelLifetime?.Cancel();tunnelLifetime?.Dispose();tunnelLifetime=null;vnc?.Stop();vnc=null;
  foreach(var queue in sockets.Values)queue.Writer.TryComplete();sockets.Clear();
  foreach(var entry in pending.Values)entry.TrySetException(new IOException("SSH-Verbindung beendet"));pending.Clear();
  try{if(owner is {HasExited:false})owner.Kill(true);}catch{}owner?.Dispose();
 }
 public void Dispose(){Stop();State="disconnected";TerminalState?.Invoke("Verbindung getrennt.");changed();}
}

// Input leaves as notifications without waiting for the Pi; one sequential sender per tunnel keeps the bytes in order.
public sealed class TcpTunnel : IAsyncDisposable {
 private readonly SharedSession owner;
 private int closed;
 public int Channel {get;}
 public ChannelReader<byte[]> Incoming {get;}
 public bool IsClosed=>Volatile.Read(ref closed)!=0;
 public bool TransportReady=>owner.IsReady;
 internal TcpTunnel(SharedSession owner,int channel,ChannelReader<byte[]> incoming){this.owner=owner;Channel=channel;Incoming=incoming;}
 public async Task Send(ReadOnlyMemory<byte> data){for(var offset=0;offset<data.Length;offset+=32768){if(IsClosed)throw new IOException("Bildschirmverbindung beendet");var part=data.Slice(offset,Math.Min(32768,data.Length-offset));await owner.Notify("tcp_send",new{channel=Channel,data=Convert.ToBase64String(part.Span)});}}
 public async ValueTask DisposeAsync(){if(Interlocked.Exchange(ref closed,1)==0)await owner.CloseTunnel(Channel);}
}

// Agent permissions remain opt-in even when a personal terminal already connected.
public sealed class AgentSession : IDisposable {
 private SharedSession? session;
 private AgentConfig config=new();
 private DateTime attachedUntil=DateTime.MinValue;
 private int busy;
 private readonly Action changed;
 public AgentSession(Action changed){this.changed=changed;}
 public string VisibleState=>session==null?"disconnected":!session.IsReady?session.State:busy>0?"busy":attachedUntil>DateTime.UtcNow?"active":"ready";
 public void Bind(SharedSession connection,AgentConfig settings){session=connection;config=settings;changed();}
 public void MarkAttached(){attachedUntil=DateTime.UtcNow.AddMinutes(2);changed();}
 public async Task<object?> Call(string op,JsonElement args){
  var connection=session??throw new InvalidOperationException("Agent in Pi Relay zuerst freigeben");
  if(op=="run"&&!config.AllowCommands)throw new InvalidOperationException("Befehle sind nicht freigegeben");
  if(op=="write"&&!config.AllowWrite)throw new InvalidOperationException("Dateiänderungen sind nicht freigegeben");
  Interlocked.Increment(ref busy);MarkAttached();try{return await connection.Request(op,args,config);}finally{Interlocked.Decrement(ref busy);changed();}
 }
 public void Dispose(){session=null;attachedUntil=DateTime.MinValue;changed();}
}

// Worker output (protocol 3): JSON lines; a tcp_data line announces `size` raw bytes that follow it.
internal sealed class WorkerOutput(Stream stream){
 public const int MaxBlock=1048576;
 private readonly byte[] buffer=new byte[65536];
 private readonly MemoryStream line=new();
 private int start,end;
 public async Task<string?> ReadLine(int limit){
  line.SetLength(0);
  while(true){
   var newline=Array.IndexOf(buffer,(byte)'\n',start,end-start);
   line.Write(buffer,start,(newline<0?end:newline)-start);
   if(line.Length>limit)throw new IOException("Antwort zu groß");
   if(newline>=0){start=newline+1;var length=(int)line.Length;if(length>0&&line.GetBuffer()[length-1]==(byte)'\r')length--;return Encoding.UTF8.GetString(line.GetBuffer(),0,length);}
   start=0;end=await stream.ReadAsync(buffer);
   if(end==0)return null;
  }
 }
 public async Task<byte[]> ReadBytes(int count){
  var data=new byte[count];var filled=Math.Min(count,end-start);
  Buffer.BlockCopy(buffer,start,data,0,filled);start+=filled;
  while(filled<count){var read=await stream.ReadAsync(data.AsMemory(filled));if(read==0)throw new IOException("SSH-Verbindung beendet");filled+=read;}
  return data;
 }
}

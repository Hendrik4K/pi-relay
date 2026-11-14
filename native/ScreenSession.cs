using System.IO;
using System.Threading.Channels;

namespace PiRelay;

// One integrated-viewer connection: a VNC byte stream inside the alias's shared SSH
// transport. Closing it releases only the tunnel; the SharedSession stays connected.
public sealed class ScreenBridge : IDisposable {
 private readonly Func<Task<SharedSession>> ensure;
 private readonly Action<object> post;
 private readonly object gate=new();
 private TcpTunnel? tunnel;
 private Channel<byte[]>? outgoing;
 private int generation;
 private bool opening,disposed;
 public string Alias {get;}
 public string State {get;private set;}="idle";
 public ScreenBridge(string alias,Func<Task<SharedSession>> ensure,Action<object> post){Alias=alias;this.ensure=ensure;this.post=post;}

 // Explicit user action only. A failed attempt is reported, never retried automatically.
 public async Task Open(){
  int current;
  lock(gate){if(disposed||opening||State=="open")return;opening=true;current=++generation;State="connecting";}
  post(new{type="screenState",state="connecting"});
  try{
   var session=await ensure();
   var opened=await session.OpenTunnel();
   var queue=Channel.CreateBounded<byte[]>(new BoundedChannelOptions(1024){SingleReader=true,SingleWriter=true});
   lock(gate){if(current!=generation||disposed){_=opened.DisposeAsync().AsTask();return;}tunnel=opened;outgoing=queue;State="open";}
   post(new{type="screenOpened"});
   _=Pump(opened,current);_=Drain(opened,queue,current);
  }catch(Exception e){Finish(current,e.Message,true);}
  finally{lock(gate)opening=false;}
 }

 public void Send(byte[] data){
  Channel<byte[]>? queue;int current;
  lock(gate){queue=outgoing;current=generation;}
  if(queue==null)return;
  if(!queue.Writer.TryWrite(data))Finish(current,"Eingaben stauen sich. Bildschirmverbindung beendet; die SSH-Verbindung bleibt bestehen.",true);
 }

 // Files dropped on the viewer go to the Pi's fixed inbox folder over the same SSH transport.
 public async Task<System.Text.Json.JsonElement> Inbox(string op,object args){var session=await ensure();return await session.Request(op,args);}

 public void Close(string message="Bildschirmverbindung getrennt. Die SSH-Verbindung bleibt bestehen."){int current;lock(gate)current=generation;Finish(current,message,false);}

 private async Task Pump(TcpTunnel source,int current){
  string? failure=null;
  try{await foreach(var chunk in source.Incoming.ReadAllAsync()){if(Volatile.Read(ref generation)!=current)return;post(new{type="screenData",data=Convert.ToBase64String(chunk)});}}
  catch(Exception e){failure=e.Message;}
  if(failure==null&&!source.TransportReady)failure="SSH-Verbindung zum Pi beendet. „Neu verbinden“ meldet den Zugang bei Bedarf neu an.";
  Finish(current,failure??"Der Pi hat die Bildschirmverbindung beendet.",failure!=null);
 }

 private async Task Drain(TcpTunnel target,Channel<byte[]> queue,int current){
  try{
   var batch=new MemoryStream();
   while(await queue.Reader.WaitToReadAsync()){
    batch.SetLength(0);
    while(batch.Length<32768&&queue.Reader.TryRead(out var part))batch.Write(part);
    await target.Send(batch.ToArray());
   }
  }catch(Exception e){Finish(current,"Senden fehlgeschlagen: "+e.Message,true);}
 }

 private void Finish(int current,string message,bool error){
  TcpTunnel? closing;Channel<byte[]>? queue;
  lock(gate){if(current!=generation||State is "idle" or "closed" or "error")return;generation++;closing=tunnel;queue=outgoing;tunnel=null;outgoing=null;State=error?"error":"closed";}
  queue?.Writer.TryComplete();
  if(closing!=null)_=closing.DisposeAsync().AsTask();
  if(!disposed)post(new{type="screenClosed",error,message});
 }

 public void Dispose(){
  TcpTunnel? closing;Channel<byte[]>? queue;
  lock(gate){if(disposed)return;disposed=true;generation++;closing=tunnel;queue=outgoing;tunnel=null;outgoing=null;State="closed";}
  queue?.Writer.TryComplete();
  if(closing!=null)_=closing.DisposeAsync().AsTask();
 }
}

// Reopening an alias focuses its existing window instead of creating another connection.
public sealed class SingleInstances<T> where T:class {
 private readonly Dictionary<string,T> items=new(StringComparer.Ordinal);
 public T GetOrCreate(string key,Func<T> create,out bool created){created=!items.TryGetValue(key,out var item);if(created){item=create();items[key]=item;}return item!;}
 public void Release(string key,T item){if(items.TryGetValue(key,out var current)&&ReferenceEquals(current,item))items.Remove(key);}
 public IReadOnlyCollection<string> Keys=>items.Keys;
 public IReadOnlyCollection<T> Values=>items.Values.ToList();
}

using System.Diagnostics;
using System.Text.Json;
using PiRelay;

var python=args[0];var root=Path.GetFullPath(args[1]);int launches=0;
Directory.CreateDirectory(root);
var session=new SharedSession("MeinPi",()=>{},_=>{
 Interlocked.Increment(ref launches);
 var start=Discovery.StartInfo(python,"-u",Path.GetFullPath("native/remote_worker.py"));start.RedirectStandardInput=true;return start;
});
void Require(bool value,string message){if(!value)throw new Exception(message);}
JsonElement Arg(object value)=>JsonDocument.Parse(Json.Encode(value)).RootElement.Clone();
try{
 await Task.WhenAll(session.Connect(),session.Connect());
 Require(launches==1&&session.IsReady,"Concurrent connects must reuse one transport");
 var writable=new AgentConfig{Alias="MeinPi",Root=root,AllowCommands=true,AllowWrite=true};
 var readonlyConfig=new AgentConfig{Alias="MeinPi",Root=root};
 var codex=new AgentSession(()=>{});var claude=new AgentSession(()=>{});
 codex.Bind(session,writable);claude.Bind(session,readonlyConfig);
 var first=codex.Call("run",Arg(new{command="echo alpha"}));var second=codex.Call("run",Arg(new{command="echo beta"}));
 var results=await Task.WhenAll(first,second);
 Require(((JsonElement)results[0]!).GetProperty("stdout").GetString()!.Contains("alpha"),"First response must match request ID");
 Require(((JsonElement)results[1]!).GetProperty("stdout").GetString()!.Contains("beta"),"Second response must match request ID");
 bool denied=false;try{await claude.Call("write",Arg(new{path="denied.txt",content="no"}));}catch(InvalidOperationException){denied=true;}
 Require(denied&&!File.Exists(Path.Combine(root,"denied.txt")),"Sharing must preserve per-agent permissions");
 codex.Dispose();Require(session.IsReady,"Detaching an agent must preserve the SSH transport");
 await claude.Call("list",Arg(new{path="."}));
 Require(launches==1,"Terminal/agent requests must never reconnect implicitly");
 session.Dispose();denied=false;try{await claude.Call("list",Arg(new{path="."}));}catch(InvalidOperationException){denied=true;}
 Require(denied&&launches==1,"Disconnected tools must not initiate authentication");
 Console.WriteLine("PASS: one transport, concurrent response routing, agent permissions, detach preserves transport, no implicit authentication.");
}finally{session.Dispose();}

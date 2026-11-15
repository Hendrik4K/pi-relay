// Native end-to-end check of the integrated viewer: the real ScreenWindow and WebView2 load the
// bundled noVNC, which talks RFB through the real worker to a local mock server. The window is
// placed off-screen, uses its own WebView data folder and never touches SSH or the running app.
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Windows;
using PiRelay;

public static class Program {
 static int accepted,closed,frames,incremental,launches;
 [STAThread] public static int Main(string[] args){
  var app=new System.Windows.Application{ShutdownMode=ShutdownMode.OnExplicitShutdown};var code=1;
  app.Startup+=async(_,_)=>{try{await Run(args[0]);code=0;}catch(Exception e){Console.Error.WriteLine(e);}finally{app.Shutdown();}};
  app.Run();return code;
 }
 static async Task Run(string python){
  var root=Path.Combine(Path.GetTempPath(),"pi-relay-screen-window-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  ScreenWindow.DataFolder=Path.Combine(root,"WebView");
  var server=new TcpListener(IPAddress.Loopback,0);server.Start();var port=((IPEndPoint)server.LocalEndpoint).Port;
  _=Task.Run(async()=>{while(true){TcpClient c;try{c=await server.AcceptTcpClientAsync();}catch{return;}Interlocked.Increment(ref accepted);_=Task.Run(()=>Serve(c));}});
  var project=Path.GetFullPath(".");
  var session=new SharedSession("MeinPi",()=>{},_=>{Interlocked.Increment(ref launches);var s=Discovery.StartInfo(python,"-u",Path.Combine(project,"tests/screen-bridge/vnc_port_shim.py"),port.ToString(),Path.Combine(project,"native/remote_worker.py"));s.RedirectStandardInput=true;return s;});
  async Task<SharedSession> Ensure(){if(!session.IsReady)await session.Connect();return session;}
  ScreenWindow Open(){var w=new ScreenWindow("MeinPi",Ensure){WindowStartupLocation=WindowStartupLocation.Manual,Left=-20000,Top=-20000,ShowInTaskbar=false,ShowActivated=false};w.Show();return w;}
  try{
   Require(ScreenWindow.PlainText("a\u0007b\tc\r\nd\u001b[31m\u0085e")=="ab\tc\r\nd[31me","Pi text loses control characters, keeps tabs and line breaks");
   Require(ScreenWindow.PlainText("rm ‮gnp.txt\r\n")=="rm gnp.txt","Pi text loses bidi overrides and a trailing line break");
   var first=Open();
   try{await Until(()=>frames>0&&incremental>0,"noVNC in WebView2 receives the frame and asks for the next update",45000);}
   catch{var web=(Microsoft.Web.WebView2.Wpf.WebView2)typeof(ScreenWindow).GetField("web",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance)!.GetValue(first)!;
    Console.Error.WriteLine("source="+web.Source+" core="+(web.CoreWebView2!=null));if(web.CoreWebView2!=null)Console.Error.WriteLine(await web.ExecuteScriptAsync("document.readyState+' | '+document.body.innerText.slice(0,300)+' | '+[...document.scripts].map(s=>s.src).join(',')"));throw;}
   Require(launches==1&&accepted==1,"One SSH transport and one VNC stream");
   // The 4:3 mock desktop in a wider window leaves bars; the window shrinks (animated) until they are gone.
   var startWidth=first.ActualWidth;var view=(Microsoft.Web.WebView2.Wpf.WebView2)typeof(ScreenWindow).GetField("web",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance)!.GetValue(first)!;
   await Until(()=>first.ActualWidth<startWidth-20&&Math.Abs(view.ActualWidth/(view.ActualHeight-46)-4.0/3)<0.02,"window snaps to the desktop aspect ratio",8000);
   first.Close();
   await Until(()=>closed==1,"closing the window ends its VNC stream",10000);
   Require(session.IsReady,"Closing the viewer window keeps the SSH transport");
   var second=Open();
   await Until(()=>accepted==2&&frames>1,"a new window reconnects",45000);
   Require(launches==1,"Reopening reuses the healthy SSH transport without new authentication");
   second.Close();await Until(()=>closed==2,"second window cleanup",10000);
   Console.WriteLine("PASS: window snaps to desktop aspect after connect, WebView2 loads bundled noVNC, RFB handshake and frame through the shared transport, window close releases only VNC, reopen without re-authentication.");
  }finally{session.Dispose();server.Stop();try{Directory.Delete(root,true);}catch{}}
 }
 static void Require(bool value,string message){if(!value)throw new Exception("FAIL: "+message);}
 static async Task Until(Func<bool> condition,string message,int ms){var end=DateTime.UtcNow.AddMilliseconds(ms);while(!condition()){if(DateTime.UtcNow>end)throw new Exception("FAIL (timeout): "+message+$" accepted={accepted} frames={frames} incremental={incremental} closed={closed}");await Task.Delay(50);}}
 static byte[] U16(int v)=>[(byte)(v>>8),(byte)v];
 static async Task<byte[]> Read(NetworkStream s,int n){var b=new byte[n];var o=0;while(o<n){var r=await s.ReadAsync(b.AsMemory(o));if(r==0)throw new EndOfStreamException();o+=r;}return b;}
 static async Task Serve(TcpClient client){
  try{using(client){var s=client.GetStream();const int w=320,h=240;
   await s.WriteAsync(Encoding.ASCII.GetBytes("RFB 003.008\n"));await Read(s,12);await s.WriteAsync(new byte[]{1,1});await Read(s,1);await s.WriteAsync(new byte[4]);await Read(s,1);
   var name=Encoding.ASCII.GetBytes("Mock");byte[] init=[..U16(w),..U16(h),32,24,0,1,0,255,0,255,0,255,16,8,0,0,0,0,0,0,0,(byte)name.Length,..name];await s.WriteAsync(init);
   while(true){var t=(await Read(s,1))[0];
    if(t==0)await Read(s,19);
    else if(t==2){var m=await Read(s,3);await Read(s,4*(m[1]<<8|m[2]));}
    else if(t==3){var m=await Read(s,9);if(m[0]==0){var frame=new byte[16+w*h*4];frame[3]=1;U16(w).CopyTo(frame,8);U16(h).CopyTo(frame,10);for(var i=16;i<frame.Length;i+=4){frame[i]=90;frame[i+1]=30;frame[i+2]=60;}await s.WriteAsync(frame);Interlocked.Increment(ref frames);}else if(frames>0)Interlocked.Increment(ref incremental);}
    else if(t==4)await Read(s,7);else if(t==5)await Read(s,5);
    else if(t==6){var m=await Read(s,7);await Read(s,m[3]<<24|m[4]<<16|m[5]<<8|m[6]);}
    else throw new InvalidDataException("Unexpected message "+t);
   }
  }}catch(Exception){}finally{Interlocked.Increment(ref closed);}
 }
}

using System.Drawing;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace PiRelay;
public sealed class TerminalWindow : Window {
 private readonly WebView2 web=new();
 private readonly SharedSession session;
 private bool ready,finished;
 public TerminalWindow(SharedSession session){
  this.session=session;Title=session.Alias+" · Pi Relay";Width=980;Height=650;MinWidth=480;MinHeight=320;
  Background=new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(23,21,26));Content=web;
  session.TerminalOutput+=OnOutput;session.TerminalState+=OnState;
  Closing+=(_,e)=>{if(!finished){e.Cancel=true;Hide();}};
  _=Initialize();
 }
 public void Reveal(){Show();if(WindowState==WindowState.Minimized)WindowState=WindowState.Normal;Activate();if(ready)Send(new{type="terminalFocus"});}
 private void Send(object message){if(!Dispatcher.CheckAccess()){Dispatcher.BeginInvoke(new Action(()=>Send(message)));return;}if(ready&&!finished)web.CoreWebView2.PostWebMessageAsJson(Json.Encode(message));}
 private void OnOutput(string data)=>Send(new{type="terminalData",data});
 private void OnState(string message)=>Send(new{type="terminalState",message});
 private async Task Initialize(){try{
  var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"PiRelay","WebView"));
  await web.EnsureCoreWebView2Async(environment);web.DefaultBackgroundColor=Color.FromArgb(255,23,21,26);
  web.CoreWebView2.SetVirtualHostNameToFolderMapping("pi-relay.local",Path.Combine(AppContext.BaseDirectory,"ui"),CoreWebView2HostResourceAccessKind.DenyCors);
  web.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;web.CoreWebView2.Settings.AreDevToolsEnabled=false;web.CoreWebView2.Settings.IsStatusBarEnabled=false;
  web.CoreWebView2.NavigationStarting+=(_,e)=>{if(!e.Uri.StartsWith("https://pi-relay.local/",StringComparison.OrdinalIgnoreCase))e.Cancel=true;};
  web.CoreWebView2.NewWindowRequested+=(_,e)=>e.Handled=true;
  web.CoreWebView2.WebMessageReceived+=async(_,e)=>{if(!e.Source.StartsWith("https://pi-relay.local/",StringComparison.OrdinalIgnoreCase))return;try{
   using var doc=JsonDocument.Parse(e.WebMessageAsJson);var r=doc.RootElement;
   switch(r.GetProperty("action").GetString()){
    case "terminalReady":if(!ready){ready=true;Send(new{type="terminalData",data=Convert.ToBase64String(session.TerminalHistory)});}await session.Request("terminal_open",new{cols=r.GetProperty("cols").GetInt32(),rows=r.GetProperty("rows").GetInt32()});break;
    case "terminalInput":var input=r.GetProperty("data").GetString()??"";if(input.Length>32768)throw new IOException("Eingabe zu groß");await session.Request("terminal_input",new{data=Convert.ToBase64String(Encoding.UTF8.GetBytes(input))});break;
    case "terminalResize":await session.Request("terminal_resize",new{cols=r.GetProperty("cols").GetInt32(),rows=r.GetProperty("rows").GetInt32()});break;
   }
  }catch(Exception ex){OnState(ex.Message);}};
  web.Source=new Uri("https://pi-relay.local/index.html?terminal="+Uri.EscapeDataString(session.Alias));
 }catch(Exception e){System.Windows.MessageBox.Show(e.Message,"Pi Relay Terminal");}}
 public void Finish(){finished=true;session.TerminalOutput-=OnOutput;session.TerminalState-=OnState;web.Dispose();Close();}
}

using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace PiRelay;
// Integrated viewer window. The renderer runs the bundled noVNC client; bytes pass through
// WebView messages to the alias's SharedSession, so no local listener or WebSocket exists.
public sealed class ScreenWindow : Window {
 private readonly WebView2 web=new();
 private readonly ScreenBridge bridge;
 private bool ready,finished,initialized,fullscreen,sizing;
 private readonly System.Windows.Threading.DispatcherTimer fitTimer=new(){Interval=TimeSpan.FromMilliseconds(15)};
 private readonly System.Diagnostics.Stopwatch fitClock=new();
 private Rect fitFrom,fitTo;
 private (WindowStyle style,ResizeMode mode,WindowState state) restore;
 public event Action? Finished;
 internal static string DataFolder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"PiRelay","WebView");
 public string Alias=>bridge.Alias;
 public ScreenWindow(string alias,Func<Task<SharedSession>> ensure){
  bridge=new(alias,ensure,Post);
  Title=alias+" · Pi-Bildschirm · Pi Relay";var area=SystemParameters.WorkArea;Width=Math.Min(1280,area.Width*.9);Height=Math.Min(840,area.Height*.9);MinWidth=480;MinHeight=320;WindowStartupLocation=WindowStartupLocation.CenterScreen;
  Background=new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(23,21,26));Content=web;
  var icon=Path.Combine(AppContext.BaseDirectory,"PiRelay.ico");if(File.Exists(icon))Icon=BitmapFrame.Create(new Uri(icon));
  // noVNC releases pressed keys on blur; the explicit message also covers Alt+Tab while a key is held.
  Activated+=(_,_)=>Post(new{type="screenActivated"});Deactivated+=(_,_)=>Post(new{type="screenDeactivated"});
  Closed+=(_,_)=>Finish();
  // After a resize drag ends, the renderer measures the black bars and asks to shrink to the desktop's aspect ratio.
  SourceInitialized+=(_,_)=>HwndSource.FromHwnd(new WindowInteropHelper(this).Handle)?.AddHook(SizeMoveHook);
  fitTimer.Tick+=(_,_)=>AdvanceFit();
  _=Initialize();
 }
 public void Reveal(){Show();if(WindowState==WindowState.Minimized)WindowState=fullscreen?WindowState.Maximized:WindowState.Normal;Activate();}
 private void Post(object message){if(!Dispatcher.CheckAccess()){Dispatcher.BeginInvoke(new Action(()=>Post(message)));return;}if(ready&&!finished)web.CoreWebView2.PostWebMessageAsJson(Json.Encode(message));}
 private async Task Initialize(){try{
  var environment=await CoreWebView2Environment.CreateAsync(null,DataFolder);
  await web.EnsureCoreWebView2Async(environment);if(finished)return;web.DefaultBackgroundColor=Color.FromArgb(255,23,21,26);
  web.CoreWebView2.SetVirtualHostNameToFolderMapping("pi-relay.local",Path.Combine(AppContext.BaseDirectory,"ui"),CoreWebView2HostResourceAccessKind.DenyCors);
  var settings=web.CoreWebView2.Settings;settings.AreDefaultContextMenusEnabled=false;settings.AreDevToolsEnabled=false;settings.IsStatusBarEnabled=false;settings.IsZoomControlEnabled=false;settings.IsPinchZoomEnabled=false;
  // F5, Ctrl+F, Ctrl+P and similar belong to the Pi desktop, not to WebView2.
  settings.AreBrowserAcceleratorKeysEnabled=false;
  web.CoreWebView2.NavigationStarting+=(_,e)=>{if(!e.Uri.StartsWith("https://pi-relay.local/",StringComparison.OrdinalIgnoreCase))e.Cancel=true;};
  web.CoreWebView2.NewWindowRequested+=(_,e)=>e.Handled=true;
  web.CoreWebView2.WebMessageReceived+=async(_,e)=>{if(!e.Source.StartsWith("https://pi-relay.local/",StringComparison.OrdinalIgnoreCase))return;try{await Handle(e.WebMessageAsJson);}catch(Exception ex){Post(new{type="screenNotice",message=ex.Message});}};
  web.NavigationCompleted+=(_,e)=>{ready=e.IsSuccess;};
  web.Source=new Uri("https://pi-relay.local/index.html?screen="+Uri.EscapeDataString(Alias));
 }catch(Exception e){System.Windows.MessageBox.Show(e.Message,"Pi Relay Bildschirm");Close();}}
 private async Task Handle(string json){using var document=JsonDocument.Parse(json);var r=document.RootElement;switch(r.GetProperty("action").GetString()){
  // A renderer reload restarts the RFB handshake on a fresh tunnel, but only the first load connects by itself.
  case "screenReady":ready=true;var first=!initialized;initialized=true;if(!first)bridge.Close("Ansicht neu geladen. Erneut verbinden.");Post(new{type="screenInit",alias=Alias,version=typeof(ScreenWindow).Assembly.GetName().Version?.ToString(3),autoConnect=first,fullscreen});break;
  case "screenOpen":await bridge.Open();break;
  case "screenSend":var data=Convert.FromBase64String(r.GetProperty("data").GetString()??"");if(data.Length>65536)throw new IOException("Datenblock zu groß");bridge.Send(data);break;
  case "screenDisconnect":bridge.Close();break;
  case "screenInfo":try{Post(new{type="screenInfo",info=await bridge.Inbox("screen_info",new{})});}catch{}break;
  case "screenFullscreen":SetFullscreen(r.GetProperty("on").GetBoolean());break;
  case "screenUpload":{var id=r.GetProperty("id").GetString();
   try{var chunk=r.GetProperty("data").GetString()??"";if(chunk.Length>1500000)throw new IOException("Datenblock zu groß");
    var result=await bridge.Inbox("inbox_write",new{token=r.GetProperty("token").GetString(),offset=r.GetProperty("offset").GetInt64(),data=chunk,final=r.GetProperty("final").GetBoolean(),name=r.GetProperty("name").GetString()});
    Post(new{type="screenUploadResult",id,ok=true,result});}
   catch(Exception e){Post(new{type="screenUploadResult",id,ok=false,error=e.Message});}
   break;}
  case "screenUploadCancel":try{await bridge.Inbox("inbox_cancel",new{token=r.GetProperty("token").GetString()});}catch{}break;
  case "screenFit":FitTo(r.GetProperty("dw").GetDouble(),r.GetProperty("dh").GetDouble());break;
  case "screenClipboardWrite":var text=r.GetProperty("text").GetString()??"";if(text.Length>1048576)throw new IOException("Zwischenablage zu groß");SetClipboard(text);break;
  case "screenClipboardRead":Post(new{type="screenClipboardText",text=ReadClipboard(),reason=r.TryGetProperty("reason",out var reason)?reason.GetString():"manual"});break;
 }}
 private static void SetClipboard(string text){for(var attempt=0;;attempt++){try{System.Windows.Clipboard.SetText(text);return;}catch(System.Runtime.InteropServices.COMException)when(attempt<3){Thread.Sleep(40);}}}
 private static string ReadClipboard(){try{return System.Windows.Clipboard.ContainsText()?System.Windows.Clipboard.GetText():"";}catch(System.Runtime.InteropServices.COMException){return "";}}
 private void SetFullscreen(bool on){
  if(on!=fullscreen){fullscreen=on;
   if(on){restore=(WindowStyle,ResizeMode,WindowState);WindowStyle=WindowStyle.None;ResizeMode=ResizeMode.NoResize;if(WindowState==WindowState.Maximized)WindowState=WindowState.Normal;WindowState=WindowState.Maximized;}
   else{WindowStyle=restore.style;ResizeMode=restore.mode;WindowState=restore.state;}
  }
  Post(new{type="screenFullscreen",on=fullscreen});
 }
 private IntPtr SizeMoveHook(IntPtr hwnd,int msg,IntPtr wParam,IntPtr lParam,ref bool handled){
  if(msg==0x0231){sizing=true;fitTimer.Stop();}
  else if(msg==0x0232){sizing=false;Post(new{type="screenResizeEnd"});}
  return IntPtr.Zero;
 }
 // Only shrinks, keeps the window centred and never touches maximized or fullscreen windows.
 private void FitTo(double dw,double dh){
  if(sizing||fullscreen||WindowState!=WindowState.Normal||!double.IsFinite(dw)||!double.IsFinite(dh))return;
  dw=Math.Min(0,dw);dh=Math.Min(0,dh);if(dw>-4&&dh>-4)return;
  var width=Math.Max(MinWidth,ActualWidth+dw);var height=Math.Max(MinHeight,ActualHeight+dh);
  fitFrom=new Rect(Left,Top,ActualWidth,ActualHeight);fitTo=new Rect(Left+(ActualWidth-width)/2,Top+(ActualHeight-height)/2,width,height);
  if(!SystemParameters.ClientAreaAnimation){ApplyFit(1);return;}
  fitClock.Restart();fitTimer.Start();
 }
 // A short pause after releasing, then cubic ease-in-out: a gentle start and dock with a brisk middle.
 private const double FitDelay=280,FitDuration=650;
 private void AdvanceFit(){var t=(fitClock.Elapsed.TotalMilliseconds-FitDelay)/FitDuration;if(t<0)return;t=Math.Min(1,t);ApplyFit(t<.5?4*t*t*t:1-Math.Pow(2-2*t,3)/2);if(t>=1)fitTimer.Stop();}
 private void ApplyFit(double t){Left=fitFrom.Left+(fitTo.Left-fitFrom.Left)*t;Top=fitFrom.Top+(fitTo.Top-fitFrom.Top)*t;Width=fitFrom.Width+(fitTo.Width-fitFrom.Width)*t;Height=fitFrom.Height+(fitTo.Height-fitFrom.Height)*t;}
 private void Finish(){if(finished)return;finished=true;fitTimer.Stop();bridge.Dispose();Finished?.Invoke();web.Dispose();}
 public void Finish(bool close){Finish();if(close)Close();}
}

using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using Forms=System.Windows.Forms;

// Every P/Invoke here targets a Windows system DLL: never load a copy planted next to PiRelay.exe.
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
namespace PiRelay;
public static class Program {
 [STAThread] public static void Main(string[] args){if(args.FirstOrDefault()=="--mcp"){Mcp.Run(args.ElementAtOrDefault(1)??"").GetAwaiter().GetResult();return;}if(args.FirstOrDefault() is "--viewer-check" or "--viewer-install" or "--viewer-status" or "--viewer-import-realvnc"){Console.OutputEncoding=new UTF8Encoding(false);try{var manager=new ViewerUpdates(ViewerUpdates.DefaultRoot,()=>{},_=>{});if(args[0]=="--viewer-check")Console.WriteLine(Json.Encode(manager.FetchLatest(args.ElementAtOrDefault(1)??"tigervnc").GetAwaiter().GetResult()));else{if(args[0]=="--viewer-install")manager.InstallTiger().GetAwaiter().GetResult();if(args[0]=="--viewer-import-realvnc")manager.ImportRealVnc(args.ElementAtOrDefault(1)??throw new ArgumentException("Viewer-Datei fehlt")).GetAwaiter().GetResult();Console.WriteLine(Json.Encode(manager.Snapshot()));}}catch(Exception e){Console.Error.WriteLine(e.Message);Environment.ExitCode=1;}return;}if(args.FirstOrDefault()=="--inspect"){var report=new {profiles=Discovery.Profiles().GetAwaiter().GetResult(),keys=Discovery.Keys([]).GetAwaiter().GetResult()};File.WriteAllText(args[1],Json.Encode(report));return;}
  // Create the event before the mutex so a second launch during startup is kept
  // until the first window can service it. Reopening never creates a new session.
  EventWaitHandle showPanel;Mutex mutex;bool first;
  try{showPanel=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\PiRelayDesktop.Show");mutex=new Mutex(true,"Local\\PiRelayDesktop",out first);}
  catch(Exception e) when(e is UnauthorizedAccessException or WaitHandleCannotBeOpenedException or IOException){
   System.Windows.MessageBox.Show(Lang.L("Pi Relay kann nicht starten: Ein anderes Programm oder Windows-Konto blockiert den Start.\n","Pi Relay can't start: another program or Windows account is blocking it.\n")+e.Message,"Pi Relay");return;}
  using var showHandle=showPanel;using var mutexHandle=mutex;
  if(!first){showPanel.Set();return;}
  var app=new System.Windows.Application{ShutdownMode=ShutdownMode.OnExplicitShutdown};
  // A single failing handler must not take every open SSH session down with it: log it and carry on.
  app.DispatcherUnhandledException+=(_,e)=>{Crash(e.Exception);e.Handled=true;};
  TaskScheduler.UnobservedTaskException+=(_,e)=>{Crash(e.Exception);e.SetObserved();};
  AppDomain.CurrentDomain.UnhandledException+=(_,e)=>{if(e.ExceptionObject is Exception ex)Crash(ex);};
  var window=new RelayWindow();
  var activation=ThreadPool.RegisterWaitForSingleObject(showPanel,(_,_)=>{
   if(!window.Dispatcher.HasShutdownStarted)window.Dispatcher.BeginInvoke(new Action(window.RevealPanel));
  },null,Timeout.Infinite,false);
  try{app.Run();}finally{activation.Unregister(null);}
  GC.KeepAlive(window);
 }
 internal static void Crash(Exception e){try{var file=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"PiRelay","events.log");File.AppendAllText(file,DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")+" Unerwarteter Fehler (abgefangen): "+RelayWindow.Short(e.GetType().Name+": "+e.Message,600)+Environment.NewLine);}catch{}}
}
public sealed class RelayWindow : Window {
 private readonly string dataFolder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"PiRelay");
 private readonly WebView2 web=new();
 private readonly Forms.NotifyIcon tray=new();
 private readonly Dictionary<string,AgentSession> agents=new();
 private readonly Dictionary<string,SharedSession> connections=new();
 private readonly Dictionary<string,TerminalWindow> terminals=new();
 private readonly SingleInstances<ScreenWindow> screens=new();
 private readonly ViewerUpdates viewerUpdates;
 private readonly IntegratedViewer integratedViewer;
 private readonly HostReachability reachability;
 private readonly Dictionary<string,CancellationTokenSource> waitingFor=new();
 private readonly Dictionary<string,Dictionary<string,JsonElement>> vncServers=new(StringComparer.OrdinalIgnoreCase);
 // Facts from the Pi reach the panel only in the shapes it renders: short strings, numbers, booleans and
 // lists of short strings. Anything else is dropped, so a crafted answer cannot break the panel.
 internal static Dictionary<string,JsonElement> Checked(JsonElement info){
  var fields=new Dictionary<string,JsonElement>();
  if(info.ValueKind==JsonValueKind.Object)foreach(var field in info.EnumerateObject().Take(32)){
   var value=field.Value;
   object? clean=value.ValueKind switch{
    JsonValueKind.String=>Short(value.GetString()),
    JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False=>value.Clone(),
    JsonValueKind.Array=>value.EnumerateArray().Where(x=>x.ValueKind==JsonValueKind.String).Take(16).Select(x=>Short(x.GetString())).ToArray(),
    _=>null};
   if(clean!=null&&field.Name.Length<=40)fields[field.Name]=JsonSerializer.SerializeToElement(clean);
  }
  fields["checkedAt"]=JsonSerializer.SerializeToElement(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());return fields;
 }
 internal static string Short(string? text,int limit=300){var value=string.Concat((text??"").Where(c=>!char.IsControl(c)));return value.Length>limit?value[..limit]+"…":value;}
 private readonly IconStore icons;
 private int reachTicks;
 private readonly List<EventRow> events=[];
 private List<Profile> profiles=[];private List<PublicKey> keys=[];private SavedState saved=new();
 private readonly System.Windows.Threading.DispatcherTimer timer=new(){Interval=TimeSpan.FromSeconds(2)};
 private SharedSession? authenticatingSession;
 private bool ready,exiting,refreshing,authenticating,revealRequested,collapsing,revealing;
 private readonly System.Windows.Threading.DispatcherTimer revealTimer=new(){Interval=TimeSpan.FromMilliseconds(1200)};
 // Fallback only: the renderer reports the real end of its slide (hideComplete/revealComplete).
 private readonly System.Windows.Threading.DispatcherTimer collapseTimer=new(){Interval=TimeSpan.FromMilliseconds(1200)};
 private readonly System.Windows.Threading.DispatcherTimer resizeTimer=new(){Interval=TimeSpan.FromMilliseconds(16)};
 // The open panel folds itself away after 6 s without the mouse over it or typing in it.
 private static readonly TimeSpan AutoCollapseAfter=TimeSpan.FromSeconds(6);
 private readonly System.Windows.Threading.DispatcherTimer idleTimer=new(){Interval=TimeSpan.FromSeconds(1)};
 // Tray dots: lit while an agent is connected, blinking while it works.
 private readonly System.Windows.Threading.DispatcherTimer blinkTimer=new(){Interval=TimeSpan.FromMilliseconds(600)};
 private bool blinkOn=true;
 private DateTime lastPanelActivity=DateTime.UtcNow;
 private readonly Stopwatch resizeClock=new();
 private double panelTargetHeight=440,resizeFromHeight;
 private int hideToken,hideClipFrames;
 private double hideMaxOffset;
 private bool hideClipsApplied=true;
 private readonly CancellationTokenSource lifetime=new();
 private Icon? trayIcon;
 private readonly DateTimeOffset started=DateTimeOffset.Now;
 private bool rounded;
 private WindowOutlineResult? outline;
 private object? surface;
 public RelayWindow(){
  Directory.CreateDirectory(dataFolder);try{saved=Json.Decode<SavedState>(File.ReadAllText(Path.Combine(dataFolder,"settings.json")))??new();}catch{}
  if(saved.Settings.Language is not ("de" or "en"))saved.Settings.Language=Lang.English?"en":"de";Lang.English=saved.Settings.Language=="en";
  foreach(var id in new[]{"codex","claude"}){saved.Agents.TryAdd(id,new());agents[id]=new(()=>Dispatcher.BeginInvoke(new Action(Push)));}
  viewerUpdates=new(ViewerUpdates.DefaultRoot,()=>Dispatcher.BeginInvoke(new Action(Push)),message=>Dispatcher.BeginInvoke(new Action(()=>{Notice(message);tray.ShowBalloonTip(8000,L("Pi Relay · Externer Viewer","Pi Relay · External viewer"),message,Forms.ToolTipIcon.Info);})));
  integratedViewer=new(AppContext.BaseDirectory,dataFolder,AppVersion.Current,IntegratedViewer.NpmTags(),()=>Dispatcher.BeginInvoke(new Action(Push)),message=>Dispatcher.BeginInvoke(new Action(()=>{Notice(message);tray.ShowBalloonTip(8000,L("Pi Relay · Integrierter Viewer","Pi Relay · Integrated viewer"),message,Forms.ToolTipIcon.Info);})));
  reachability=new(()=>Dispatcher.BeginInvoke(new Action(Push)));
  icons=new(dataFolder);
  Width=520;Height=panelTargetHeight;Title="Pi Relay";WindowStyle=WindowStyle.None;ResizeMode=ResizeMode.NoResize;ShowInTaskbar=false;Background=new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(23,21,26));Content=web;
  var appIcon=Path.Combine(AppContext.BaseDirectory,"PiRelay.ico");if(File.Exists(appIcon))Icon=BitmapFrame.Create(new Uri(appIcon));
  SourceInitialized+=(_,_)=>ApplyOutline();SizeChanged+=(_,_)=>ApplyOutline();DpiChanged+=(_,_)=>ApplyOutline();
  Closing+=(_,e)=>{if(!exiting){e.Cancel=true;CollapsePanel();}};
  collapseTimer.Tick+=(_,_)=>CompleteHide();
  revealTimer.Tick+=(_,_)=>FinishReveal();
  resizeTimer.Tick+=(_,_)=>AdvancePanelSize();
  idleTimer.Tick+=(_,_)=>CheckIdleCollapse();idleTimer.Start();
  blinkTimer.Tick+=(_,_)=>{blinkOn=!blinkOn;UpdateIcon();};
  BuildTrayMenu();tray.Text=L("Pi Relay · getrennt","Pi Relay · disconnected");tray.MouseClick+=(_,e)=>{if(e.Button==Forms.MouseButtons.Left)Dispatcher.Invoke(()=>{switch(PanelMotion.OnTrayClick(Phase)){case PanelAction.Collapse:CollapsePanel();break;case PanelAction.Reverse:case PanelAction.Reveal:RevealPanel();break;}});};StartSpinIfRestarted();UpdateIcon();tray.Visible=true;
  timer.Tick+=(_,_)=>{foreach(var connection in connections.Values)connection.Refresh();viewerUpdates.Tick();integratedViewer.Tick();if(++reachTicks>=(IsVisible&&Opacity>0?5:30))CheckReachability();Push();};timer.Start();
  // Tray startup is hidden, never iconically minimized. A taskbar-less WPF
  // minimized window becomes a tiny desktop bar and can leave WebView2 at 0px.
  if(saved.Settings.Minimized){ShowActivated=false;Opacity=0;PositionPanel();Show();}else ShowPanel();
  _=Initialize();_=PipeServer();_=Task.Run(RemoveSwappedFiles);
 }
 private async Task Initialize(){try{
  var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(dataFolder,"WebView"),ScreenWindow.EnvironmentOptions());await web.EnsureCoreWebView2Async(environment);
  web.DefaultBackgroundColor=Color.FromArgb(255,23,21,26);web.CoreWebView2.Settings.AreDevToolsEnabled=false;web.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;web.CoreWebView2.Settings.IsStatusBarEnabled=false;
  web.CoreWebView2.SetVirtualHostNameToFolderMapping("pi-relay.local",Path.Combine(AppContext.BaseDirectory,"ui"),CoreWebView2HostResourceAccessKind.DenyCors);
  // User pictures (Pi case, companions) live outside the app folder so updates keep them.
  Directory.CreateDirectory(icons.Folder);web.CoreWebView2.SetVirtualHostNameToFolderMapping("pi-relay-icons.local",icons.Folder,CoreWebView2HostResourceAccessKind.DenyCors);
  web.CoreWebView2.NavigationStarting+=(_,e)=>{if(!e.Uri.StartsWith("https://pi-relay.local/",StringComparison.OrdinalIgnoreCase))e.Cancel=true;};
  web.CoreWebView2.NewWindowRequested+=(_,e)=>e.Handled=true;web.CoreWebView2.DownloadStarting+=(_,e)=>e.Cancel=true;
  // The panel needs no camera, microphone, location or notifications.
  web.CoreWebView2.PermissionRequested+=(_,e)=>{e.SavesInProfile=false;e.State=CoreWebView2PermissionState.Deny;};
  web.CoreWebView2.WebMessageReceived+=async(_,e)=>{if(!e.Source.StartsWith("https://pi-relay.local/",StringComparison.OrdinalIgnoreCase))return;try{await Handle(e.WebMessageAsJson);}catch(Exception ex){Notice(ex.Message);Log("Aktion fehlgeschlagen: "+ex.Message);}};
  web.NavigationCompleted+=(_,e)=>{ready=e.IsSuccess;if(ready){Push();if(IsVisible&&Opacity>0)RevealSurface();}WriteStatus();};web.Source=new Uri("https://pi-relay.local/index.html");
  // An unreadable ~/.ssh/config is reported, not mistaken for a broken WebView2.
  try{await Refresh();}catch(Exception e){Log("SSH-Konfiguration nicht lesbar: "+e.Message);}
  if(saved.Settings.Minimized&&!revealRequested)CompleteHide();else ShowPanel();WriteStatus();
 }catch(Exception e){System.Windows.MessageBox.Show(L("Pi Relay konnte nicht starten. Microsoft Edge WebView2 Runtime prüfen.\n","Pi Relay couldn't start. Check the Microsoft Edge WebView2 Runtime.\n")+e.Message,"Pi Relay");Quit();}}
 private PanelPhase Phase=>revealing?PanelPhase.Revealing:collapsing?PanelPhase.Collapsing:IsVisible&&Opacity>0?PanelPhase.Visible:PanelPhase.Hidden;
 // Reveals slide in from where the panel currently is (mid-collapse or fully hidden); without motion it just appears.
 internal void RevealPanel(){
  revealRequested=true;
  if(revealing)return;
  if(collapsing&&IsVisible&&ready)StartReveal("current");
  else if(ready&&saved.Settings.Motion&&!(IsVisible&&Opacity>0))StartReveal("hidden");
  else ShowPanel();
  CheckReachability();
 }
 private void StartReveal(string from){
  collapseTimer.Stop();resizeTimer.Stop();collapsing=false;revealing=true;hideToken++;
  if(from=="hidden"){
   WindowState=WindowState.Normal;PositionPanel();
   // The window appears fully clipped; the renderer's slide frames open the region from the bottom.
   var handle=new WindowInteropHelper(this).Handle;if(handle!=IntPtr.Zero)WindowOutline.ApplySlideClip(handle,Height+2);
   ShowActivated=true;Opacity=1;Show();web.Visibility=Visibility.Visible;web.InvalidateMeasure();web.InvalidateArrange();UpdateLayout();
   handle=new WindowInteropHelper(this).Handle;if(handle!=IntPtr.Zero)WindowOutline.ApplySlideClip(handle,ActualHeight+2);
  }
  Activate();
  Push();web.CoreWebView2.PostWebMessageAsJson(Json.Encode(new{type="reveal",token=hideToken,from}));
  revealTimer.Stop();revealTimer.Start();WriteStatus();
 }
 private void CheckIdleCollapse(){
  if(Phase!=PanelPhase.Visible||IsMouseOverPanel()){lastPanelActivity=DateTime.UtcNow;return;}
  // Never while a dialog of the panel (file picker, message box) or an SSH confirmation is open.
  if(System.Windows.Interop.ComponentDispatcher.IsThreadModal||authenticating||waitingFor.Count>0){lastPanelActivity=DateTime.UtcNow;return;}
  if(DateTime.UtcNow-lastPanelActivity>=AutoCollapseAfter){lastPanelActivity=DateTime.UtcNow;CollapsePanel();}
 }
 private bool IsMouseOverPanel(){var handle=new WindowInteropHelper(this).Handle;if(handle==IntPtr.Zero||!GetWindowRect(handle,out var rect))return false;var cursor=Forms.Cursor.Position;return cursor.X>=rect.Left&&cursor.X<rect.Right&&cursor.Y>=rect.Top&&cursor.Y<rect.Bottom;}
 private void FinishReveal(){revealTimer.Stop();if(!revealing)return;revealing=false;ApplyOutline();Push();WriteStatus();}
 // Every 10 s while the panel is open, once a minute otherwise: ICMP only, never an SSH login.
 private void CheckReachability(){reachTicks=0;var hosts=profiles.Select(p=>p.Hostname).ToList();var live=profiles.Where(p=>connections.TryGetValue(p.Alias,out var c)&&c.IsReady).Select(p=>p.Hostname).ToHashSet(StringComparer.OrdinalIgnoreCase);_=reachability.Check(hosts,live.Contains);}
 private void ApplyOutline(){var handle=new WindowInteropHelper(this).Handle;if(handle==IntPtr.Zero||revealing)return;outline=WindowOutline.Apply(handle);rounded=outline.Applied&&outline.CornersClipped;}
 private void PositionPanel(){resizeTimer.Stop();var area=SystemParameters.WorkArea;Width=520;Height=panelTargetHeight;Left=area.Right-Width-14;Top=Math.Max(area.Top+10,area.Bottom-Height-14);}
 private void ResizePanel(double height,bool motion){
  if(!double.IsFinite(height))return;
  var next=Math.Clamp(Math.Ceiling(height),300,Math.Max(300,Math.Min(720,SystemParameters.WorkArea.Height-28)));
  if(Math.Abs(next-panelTargetHeight)<.5)return;
  panelTargetHeight=next;resizeFromHeight=ActualHeight>0?ActualHeight:Height;resizeTimer.Stop();
  if(!motion||!ready||!IsVisible||Opacity==0){PositionPanel();UpdateLayout();ApplyOutline();WriteStatus();return;}
  resizeClock.Restart();resizeTimer.Start();
 }
 private void AdvancePanelSize(){
  var progress=Math.Min(1,resizeClock.Elapsed.TotalMilliseconds/240);var eased=progress*progress*(3-2*progress);
  var height=resizeFromHeight+(panelTargetHeight-resizeFromHeight)*eased;
  Height=height;Top=Math.Max(SystemParameters.WorkArea.Top+10,SystemParameters.WorkArea.Bottom-height-14);
  if(progress>=1){resizeTimer.Stop();UpdateLayout();ApplyOutline();WriteStatus();}
 }
 private void ShowPanel(){collapseTimer.Stop();collapsing=false;WindowState=WindowState.Normal;PositionPanel();ShowActivated=true;Opacity=1;Show();web.Visibility=Visibility.Visible;web.InvalidateMeasure();web.InvalidateArrange();UpdateLayout();ApplyOutline();Activate();if(ready)RevealSurface();WriteStatus();}
 private void RevealSurface(){Push();web.CoreWebView2.PostWebMessageAsJson(Json.Encode(new{type="reveal"}));}
 private void CollapsePanel(){if(!PanelMotion.MayCollapse(Phase))return;if(!ready||!saved.Settings.Motion){CompleteHide();return;}if(resizeTimer.IsEnabled){PositionPanel();UpdateLayout();ApplyOutline();}collapsing=true;hideToken++;hideClipFrames=0;hideMaxOffset=0;hideClipsApplied=true;web.CoreWebView2.PostWebMessageAsJson(Json.Encode(new{type="collapse",token=hideToken}));collapseTimer.Start();}
 private void CompleteHide(){collapseTimer.Stop();resizeTimer.Stop();collapsing=false;if(ready)web.CoreWebView2.PostWebMessageAsJson(Json.Encode(new{type="hidden"}));Hide();PositionPanel();ApplyOutline();Opacity=1;WriteStatus();}
 // Diagnostics only: a locked status.json (e.g. read by a script) must never end the app.
 private void WriteStatus(){try{WriteStatusFile();}catch(IOException){}catch(UnauthorizedAccessException){}}
 private void WriteStatusFile(){File.WriteAllText(Path.Combine(dataFolder,"status.json"),Json.Encode(new{ready,pid=Environment.ProcessId,started,profiles=profiles.Count,keys=keys.Count,panelVisible=IsVisible,windowState=WindowState.ToString(),rounded,outline,panelTargetHeight,resizing=resizeTimer.IsEnabled,hideClipFrames,hideMaxOffset,hideClipsApplied,bottom=Top+ActualHeight,workAreaBottom=SystemParameters.WorkArea.Bottom,width=ActualWidth,height=ActualHeight,webWidth=web.ActualWidth,webHeight=web.ActualHeight,surface}));}
 // The Windows app mode (dark/light) decides the tone of the veil shown while Windows asks for the security key.
 private static string WindowsTheme(){try{using var key=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");return key?.GetValue("AppsUseLightTheme") is int light&&light==1?"light":"dark";}catch{return "dark";}}
 private object Snapshot()=>new {version=AppVersion.Current,windowsTheme=WindowsTheme(),screens=screens.Keys,icons=icons.Snapshot(),devices=saved.Devices,reachability=reachability.Snapshot(),vncServers,integrated=integratedViewer.Snapshot(connections.Values.Any(c=>c.IsReady)),profiles,keys,settings=saved.Settings,panel=new{visible=IsVisible&&Opacity>0,collapsing,revealing},viewer=viewerUpdates.Snapshot(),agents=agents.ToDictionary(x=>x.Key,x=>new{saved.Agents[x.Key].Alias,saved.Agents[x.Key].Root,saved.Agents[x.Key].AllowCommands,saved.Agents[x.Key].AllowWrite,state=x.Value.VisibleState}),events=events.TakeLast(80)};
 // While the panel is hidden nobody sees the state, so it isn't serialised every tick; every way of showing it pushes first.
 private void Push(){if(!Dispatcher.CheckAccess()){Dispatcher.BeginInvoke(new Action(Push));return;}foreach(var profile in profiles){var connection=connections.GetValueOrDefault(profile.Alias);profile.State=waitingFor.ContainsKey(profile.Alias)?"waiting":connection?.State=="ready"?"connected":connection?.State??"disconnected";}if(ready&&IsVisible&&Opacity>0)web.CoreWebView2.PostWebMessageAsJson(Json.Encode(new {type="state",data=Snapshot()}));UpdateIcon();}
 private void Notice(string message){if(ready)web.CoreWebView2.PostWebMessageAsJson(Json.Encode(new {type="notice",message}));}
 private void Log(string message){message=Short(message,600);events.Add(new(DateTime.Now.ToString("HH:mm:ss"),message));try{var file=Path.Combine(dataFolder,"events.log");if(File.Exists(file)&&new FileInfo(file).Length>262144)File.Move(file,file+".1",true);File.AppendAllText(file,DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")+" "+message+Environment.NewLine);}catch{}if(events.Count>200)events.RemoveAt(0);Push();}
 private void Save(){var file=Path.Combine(dataFolder,"settings.json");var temp=file+".tmp";File.WriteAllText(temp,Json.Encode(saved));File.Move(temp,file,true);}
 private async Task Refresh(){if(refreshing)return;refreshing=true;try{var found=await Discovery.Profiles();foreach(var p in found)p.State=profiles.FirstOrDefault(x=>x.Alias==p.Alias)?.State??"disconnected";profiles=found;keys=await Discovery.Keys(saved.AddedKeys);Push();CheckReachability();}finally{refreshing=false;}}
 private async Task Handle(string json){using var document=JsonDocument.Parse(json);var r=document.RootElement;var action=r.GetProperty("action").GetString();switch(action){
  case "getState":Push();if(ready&&IsVisible&&Opacity>0&&!collapsing)RevealSurface();break;
  case "surfaceReady":surface=new{width=r.GetProperty("width").GetDouble(),height=r.GetProperty("height").GetDouble(),panelHeight=r.GetProperty("panelHeight").GetDouble(),collapsed=r.GetProperty("collapsed").GetBoolean()};WriteStatus();break;
  case "resizePanel":ResizePanel(r.GetProperty("height").GetDouble(),saved.Settings.Motion&&r.GetProperty("motion").GetBoolean());break;
  case "hide":CollapsePanel();break;
  case "panelActivity":lastPanelActivity=DateTime.UtcNow;break;
  case "revealComplete":if(revealing&&r.GetProperty("token").GetInt32()==hideToken)FinishReveal();break;
  case "clipPanel":if((collapsing||revealing)&&r.GetProperty("token").GetInt32()==hideToken){var offset=r.GetProperty("offset").GetDouble();if(double.IsFinite(offset)){hideClipFrames++;hideMaxOffset=Math.Max(hideMaxOffset,offset);hideClipsApplied&=WindowOutline.ApplySlideClip(new WindowInteropHelper(this).Handle,offset);}}break;
  case "hideComplete":if(collapsing&&(!r.TryGetProperty("token",out var token)||token.GetInt32()==hideToken))CompleteHide();break;
  case "drag":if(System.Windows.Input.Mouse.LeftButton==System.Windows.Input.MouseButtonState.Pressed)DragMove();break;
  case "quit":Quit();break;
  case "refresh":await Refresh();break;
  case "connectProfile":await EnsureConnection(r.GetProperty("alias").GetString()??"");break;
  case "cancelLogin":authenticatingSession?.CancelLogin();break;
  case "cancelWait":if(waitingFor.TryGetValue(r.GetProperty("alias").GetString()??"",out var waitCancel))waitCancel.Cancel();break;
  case "connectTerminal":await ConnectTerminal(r.GetProperty("alias").GetString()??"");break;
  case "disconnectProfile":var alias=r.GetProperty("alias").GetString()??"";if(connections.TryGetValue(alias,out var connection))connection.Dispose();if(terminals.Remove(alias,out var terminal))terminal.Finish();Log(alias+": SSH-Verbindung getrennt");break;
  case "pickVncViewer":var viewer=new Microsoft.Win32.OpenFileDialog{Title=L("VNC Viewer auswählen","Choose a VNC viewer"),Filter="VNC Viewer (*.exe)|*.exe"};if(viewer.ShowDialog(this)==true){saved.Settings.VncViewer=viewer.FileName;saved.Settings.ManagedViewer=false;Save();Push();}break;
  case "checkViewerUpdate":await viewerUpdates.Check();break;
  case "skipViewerUpdate":viewerUpdates.SkipVersion(r.GetProperty("provider").GetString()??"",r.GetProperty("version").GetString()??"");break;
  case "restoreViewerUpdate":viewerUpdates.RestoreSkippedVersion();break;
  case "openViewerDownload":Process.Start(new ProcessStartInfo("https://manage.realvnc.com/"){UseShellExecute=true});break;
  case "installViewer":await viewerUpdates.InstallTiger();saved.Settings.ManagedViewer=true;Save();Push();break;
  case "rollbackViewer":viewerUpdates.Rollback();break;
  case "useManagedViewer":saved.Settings.ManagedViewer=true;Save();Push();break;
  case "importRealVnc":var classic=new Microsoft.Win32.OpenFileDialog{Title=L("Vorhandenen portablen RealVNC Classic Viewer auswählen","Choose an existing portable RealVNC Classic viewer"),Filter="RealVNC Classic (*.exe)|*.exe"};if(classic.ShowDialog(this)==true){await viewerUpdates.ImportRealVnc(classic.FileName);saved.Settings.ManagedViewer=true;Save();Push();}break;
  // The switch in "Externer Viewer" decides what the main screen action opens.
  case "connectScreen":if(saved.Settings.ExternalViewer)await OpenExternalScreen(r.GetProperty("alias").GetString()??"");else OpenScreen(r.GetProperty("alias").GetString()??"");break;
  case "checkIntegratedViewer":await integratedViewer.Check();break;
  // Which VNC server the Pi runs, its version and listen scope: read-only, existing connection only.
  case "checkVncServer":{var vncAlias=r.GetProperty("alias").GetString()??"";if(!connections.TryGetValue(vncAlias,out var vncSession)||!vncSession.IsReady)throw new InvalidOperationException("Zuerst mit dem Pi verbinden.");var vncHost=profiles.First(p=>p.Alias==vncAlias).Hostname;vncServers[vncHost]=Checked(await vncSession.Request("vnc_server_info"));Push();break;}
  case "skipIntegratedViewer":integratedViewer.Skip(r.GetProperty("version").GetString()??"");break;
  case "restoreIntegratedViewer":integratedViewer.Restore();break;
  case "buildIntegratedViewer":integratedViewer.StartBuild(r.GetProperty("version").GetString()??"");Log("Integrierter Viewer: Update-Build im PowerShell-Fenster gestartet");break;
  // Activation restarts Pi Relay; active SSH sessions end only after the user confirmed exactly that.
  case "activateIntegratedViewer":if(connections.Values.Any(c=>c.IsReady)&&!(r.TryGetProperty("confirm",out var confirmed)&&confirmed.GetBoolean()))throw new InvalidOperationException("SSH-Verbindungen sind aktiv. Bitte den Neustart ausdrücklich bestätigen.");integratedViewer.StartActivation(Environment.ProcessId);Log("Neue Pi-Relay-Version wird aktiviert; Pi Relay startet neu");Quit();break;
  case "connectScreenExternal":await OpenExternalScreen(r.GetProperty("alias").GetString()??"");break;
  case "saveSettings":var settings=r.GetProperty("settings");if(settings.TryGetProperty("minimized",out var min))saved.Settings.Minimized=min.GetBoolean();if(settings.TryGetProperty("motion",out var motion))saved.Settings.Motion=motion.GetBoolean();if(settings.TryGetProperty("clipboardFromPi",out var fromPi))saved.Settings.ClipboardFromPi=fromPi.GetBoolean();if(settings.TryGetProperty("clipboardToPi",out var toPi))saved.Settings.ClipboardToPi=toPi.GetBoolean();if(settings.TryGetProperty("language",out var language)){saved.Settings.Language=language.GetString()=="en"?"en":"de";Lang.English=saved.Settings.Language=="en";foreach(var screen in screens.Values)screen.SettingsChanged();foreach(var openTerminal in terminals.Values)openTerminal.LanguageChanged(saved.Settings.Language);BuildTrayMenu();}if(settings.TryGetProperty("showFps",out var fps)){saved.Settings.ShowFps=fps.GetBoolean();foreach(var screen in screens.Values)screen.SettingsChanged();}if(settings.TryGetProperty("externalViewer",out var external)){saved.Settings.ExternalViewer=external.GetBoolean();Log(external.GetBoolean()?"Pi-Bildschirm öffnet jetzt den externen Viewer":"Pi-Bildschirm öffnet jetzt den integrierten Viewer");}if(settings.TryGetProperty("autostart",out var start)){using var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");if(start.GetBoolean())key.SetValue("PiRelay","\""+Environment.ProcessPath+"\"");else key.DeleteValue("PiRelay",false);saved.Settings.Autostart=start.GetBoolean();}Save();Push();break;
  // Changing the Pi address rewrites HostName for all aliases on that host and carries its trusted keys.
  case "setHost":{var from=r.GetProperty("from").GetString()??"";var to=(r.GetProperty("to").GetString()??"").Trim();
   if(!profiles.Any(p=>p.Hostname==from))throw new InvalidOperationException("Unbekannte Pi-Adresse");
   if(string.Equals(from,to,StringComparison.OrdinalIgnoreCase))break;
   var (aliases,keys)=SshHostEdit.Apply(Discovery.SshFolder,from,to);await Refresh();
   Log("Pi-Adresse "+from+" → "+to+" ("+aliases+" Zugänge, "+keys+" Schlüssel-Fingerabdrücke übernommen)");
   Notice(connections.Values.Any(c=>c.IsReady)?"Neue Adresse gespeichert. Laufende Verbindungen bleiben bis zum Trennen auf der alten Adresse.":"Neue Adresse gespeichert. Beim nächsten Verbinden gilt "+to+".");
   break;}
  case "pickIcon":{var slot=r.GetProperty("slot").GetString()??"";var picker=new Microsoft.Win32.OpenFileDialog{Title=L("Eigenes Bild auswählen","Choose your own picture"),Filter=L("Bilder","Pictures")+" (*.png;*.jpg;*.jpeg)|*.png;*.jpg;*.jpeg"};
   if(picker.ShowDialog(this)==true){icons.Import(slot,picker.FileName);Log("Eigenes Bild für "+slot+" übernommen");Push();}
   break;}
  case "resetIcon":icons.Reset(r.GetProperty("slot").GetString()??"");Push();break;
  case "openConfig":Open("notepad.exe",Path.Combine(Discovery.SshFolder,"config"));break;
  case "openKeyFolder":Open("explorer.exe",Discovery.SshFolder);break;
  case "copyKey":var path=r.GetProperty("path").GetString();if(!keys.Any(k=>k.Path==path))throw new InvalidOperationException("Unbekannter öffentlicher Schlüssel");System.Windows.Clipboard.SetText(File.ReadAllText(path!));Notice("Öffentlicher Schlüssel kopiert.");break;
  case "addKey":var dialog=new Microsoft.Win32.OpenFileDialog{Filter=L("Öffentliche SSH-Schlüssel","Public SSH keys")+" (*.pub)|*.pub",InitialDirectory=Discovery.SshFolder};if(dialog.ShowDialog(this)==true){saved.AddedKeys.Add(dialog.FileName);Save();await Refresh();}break;
  case "saveAgent":var id=AgentId(r);var config=Json.Decode<AgentConfig>(r.GetProperty("config").GetRawText())??throw new InvalidOperationException("Ungültiges Profil");if(!profiles.Any(p=>p.Alias==config.Alias)||!config.Root.StartsWith('/'))throw new InvalidOperationException("Bekannten SSH-Zugang und absoluten Ordner wählen");agents[id].Dispose();saved.Agents[id]=config;Save();Log(id+": Zugang zugeordnet");break;
  case "connectAgent":var agentId=AgentId(r);var agentConfig=saved.Agents[agentId];var shared=await EnsureConnection(agentConfig.Alias);await shared.Request("list",new{path="."},agentConfig);agents[agentId].Bind(shared,agentConfig);Log(agentId+": Zugriff freigegeben über "+agentConfig.Alias);break;
  case "disconnectAgent":var stop=AgentId(r);agents[stop].Dispose();Log(stop+": Agent-Zugriff beendet; SSH bleibt verbunden");break;
  case "copyMcp":var agent=AgentId(r);var exe=Environment.ProcessPath!;System.Windows.Clipboard.SetText(Json.Encode(new {command=exe,args=new[]{"--mcp",agent}}));Notice("MCP-Konfiguration kopiert. In deinem Agent-Client als lokalen STDIO-Server eintragen.");break;
 }}
 private static string AgentId(JsonElement r){var id=r.GetProperty("agent").GetString();return id is "codex" or "claude"?id:throw new InvalidOperationException("Unbekannter Agent");}
 private static void Open(string exe,string argument){var info=new ProcessStartInfo(exe is "notepad.exe" or "explorer.exe"?Path.Combine(exe=="explorer.exe"?Environment.GetFolderPath(Environment.SpecialFolder.Windows):Environment.SystemDirectory,exe):exe){UseShellExecute=true};info.ArgumentList.Add(argument);Process.Start(info);}
 private async Task<SharedSession> EnsureConnection(string alias){
  if(!profiles.Any(p=>p.Alias==alias))throw new InvalidOperationException("Bekannten SSH-Zugang wählen");
  if(!connections.TryGetValue(alias,out var session)){session=new SharedSession(alias,()=>Dispatcher.BeginInvoke(new Action(Push)));connections[alias]=session;}
  if(session.IsReady){var host=profiles.First(p=>p.Alias==alias).Hostname;if(!saved.Devices.ContainsKey(host))_=LoadDeviceFacts(alias,session);return session;}
  // Clicking connect again while an earlier key confirmation still hangs (dialog cancelled) ends that attempt and starts fresh.
  if(authenticating){authenticatingSession?.CancelLogin();for(var i=0;i<100&&authenticating;i++)await Task.Delay(50);}
  if(authenticating)throw new InvalidOperationException("Eine Schlüsselbestätigung läuft bereits. Bitte zuerst diese Anmeldung abschließen.");
  var hostname=profiles.First(p=>p.Alias==alias).Hostname;var waited=false;
  if(reachability.Snapshot().GetValueOrDefault(hostname)=="offline"){await WaitForPi(alias,hostname);waited=true;}
  try{return await Authenticate(alias,session);}
  // Pi still restarting: wait until it answers, then authenticate exactly once more.
  catch(Exception e) when(!waited&&(SharedSession.Unreachable(e.Message)||SharedSession.Unreachable(session.LastError))){await WaitForPi(alias,hostname);return await Authenticate(alias,session);}
 }
 private async Task<SharedSession> Authenticate(string alias,SharedSession session){
  if(authenticating)throw new InvalidOperationException("Eine Schlüsselbestätigung läuft bereits. Bitte zuerst diese Anmeldung abschließen.");
  authenticating=true;authenticatingSession=session;
  try{await session.Connect();Log(alias+": verbunden · Terminal und freigegebene Agenten nutzen denselben Kanal");_=LoadDeviceFacts(alias,session);_=LoadVncServer(alias,session);return session;}
  finally{authenticating=false;authenticatingSession=null;Push();}
 }
 private async Task WaitForPi(string alias,string host){
  if(waitingFor.ContainsKey(alias))throw new InvalidOperationException("Pi Relay wartet bereits auf den Pi.");
  var cancel=new CancellationTokenSource();waitingFor[alias]=cancel;Push();
  Notice("Der Pi antwortet noch nicht. Pi Relay verbindet einmal, sobald er wieder da ist (bis zu 3 Minuten) …");Log(alias+": wartet auf den Pi");
  try{if(!await PiWait.Until(()=>PiWait.SshPort(host),()=>HostReachability.Ping(host),cancel.Token))throw new InvalidOperationException("Pi nach 3 Minuten nicht erreichbar. Ist er eingeschaltet und im Netz? Sonst die IP neben dem Gerät prüfen.");}
  catch(OperationCanceledException){throw new InvalidOperationException("Warten auf den Pi abgebrochen.");}
  finally{waitingFor.Remove(alias);cancel.Dispose();CheckReachability();Push();}
 }
 // Which VNC server the Pi runs (for the header badge and the screen view); read-only, failures ignored.
 private async Task LoadVncServer(string alias,SharedSession session){try{var host=profiles.FirstOrDefault(p=>p.Alias==alias)?.Hostname;if(string.IsNullOrEmpty(host))return;vncServers[host]=Checked(await session.Request("vnc_server_info"));Push();}catch{}}
 // Read-only board facts for the header; failures just leave the previous values.
 private async Task LoadDeviceFacts(string alias,SharedSession session){
  try{
   var host=profiles.FirstOrDefault(p=>p.Alias==alias)?.Hostname;if(string.IsNullOrEmpty(host))return;
   var info=await session.Request("device_info");
   saved.Devices[host]=new DeviceFacts{Model=Short(info.GetProperty("model").GetString(),120),MemoryBytes=info.GetProperty("memoryBytes").GetInt64(),StorageBytes=info.GetProperty("storageBytes").GetInt64(),StorageKind=Short(info.GetProperty("storageKind").GetString(),12)};
   Save();Push();
  }catch{}
 }
 // Not connected yet: connect first (security key once), then open the terminal.
 private async Task ConnectTerminal(string alias){
  var session=await EnsureConnection(alias);
  if(!terminals.TryGetValue(alias,out var terminal)){terminal=new TerminalWindow(session,saved.Settings.Language);terminals[alias]=terminal;}
  terminal.Reveal();
 }
 // The integrated viewer needs no external EXE. Opening it is the explicit user action that may
 // start the alias's SSH login; a second click focuses the existing window of that alias.
 private void OpenScreen(string alias){
  if(!profiles.Any(p=>p.Alias==alias))throw new InvalidOperationException("Bekannten SSH-Zugang wählen");
  var screen=screens.GetOrCreate(alias,()=>new ScreenWindow(alias,()=>EnsureConnection(alias),()=>saved.Settings,Log),out var created);
  if(created){screen.Finished+=()=>{screens.Release(alias,screen);Log(alias+": Pi-Bildschirm geschlossen · SSH bleibt verbunden");};Log(alias+": Pi-Bildschirm im integrierten Viewer geöffnet");}
  screen.Reveal();
 }
 private async Task OpenExternalScreen(string alias){
  var viewer=saved.Settings.ManagedViewer?viewerUpdates.Store.VerifiedCurrentPath():saved.Settings.VncViewer;
  if(string.IsNullOrEmpty(viewer)||!File.Exists(viewer)||!viewer.EndsWith(".exe",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Portablen Viewer zuerst einrichten oder einen vorhandenen Viewer auswählen.");
  var session=await EnsureConnection(alias);
  // Probe the existing Pi endpoint once. An unavailable desktop must not launch
  // an apparently connected viewer or start a second SSH authentication.
  var waited=false;
  var probe=await session.OpenTunnelWaiting(_=>{if(!waited){waited=true;Dispatcher.BeginInvoke(()=>Notice("Warte auf den VNC-Server des Pi (bis zu 2 Minuten) …"));}});await probe.DisposeAsync();
  var port=await session.VncPort(viewer);Open(viewer,"127.0.0.1::"+port);
  Log(alias+": Externer VNC Viewer über bestehenden SSH-Kanal geöffnet");
 }
 private async Task PipeServer(){while(!lifetime.IsCancellationRequested){try{var pipe=new NamedPipeServerStream(Mcp.PipeName,PipeDirection.InOut,10,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);if(!Mcp.OwnedByCurrentUser(pipe)){pipe.Dispose();Log("MCP-Schnittstelle gesperrt: Eine fremde Pipe mit gleichem Namen existiert. Agenten bleiben getrennt.");await Task.Delay(30000,lifetime.Token);continue;}await pipe.WaitForConnectionAsync(lifetime.Token);_=ProcessPipe(pipe);}catch(OperationCanceledException){break;}catch{await Task.Delay(1000);}}}
 private async Task ProcessPipe(NamedPipeServerStream pipe){using(pipe){using var reader=new StreamReader(pipe,Encoding.UTF8,leaveOpen:true);using var writer=new StreamWriter(pipe,new UTF8Encoding(false),leaveOpen:true){AutoFlush=true};try{using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(50));var line=await reader.ReadLineAsync(timeout.Token)??throw new IOException("Leere Anfrage");if(line.Length>2000000)throw new IOException("Anfrage zu groß (über 2 MB)");using var doc=JsonDocument.Parse(line);var r=doc.RootElement;var id=AgentId(r);var tool=r.GetProperty("tool").GetString();var session=agents[id];session.MarkAttached();object? result;if(tool=="pi_status")result=new{agent=id,state=session.VisibleState,saved.Agents[id].Alias,saved.Agents[id].Root,saved.Agents[id].AllowCommands,saved.Agents[id].AllowWrite};else{var op=tool switch{"pi_list_files"=>"list","pi_read_file"=>"read","pi_write_file"=>"write","pi_run_command"=>"run",_=>throw new InvalidOperationException("Unbekanntes Werkzeug")};result=await session.Call(op,r.GetProperty("arguments"));}await writer.WriteLineAsync(Json.Encode(new{text=Json.Encode(result),isError=false}));}catch(Exception e){try{await writer.WriteLineAsync(Json.Encode(new{text=e.Message,isError=true}));}catch{}}}}
 // An activation renames files that running MCP clients still had mapped to "*.old-<stamp>". Once those
 // clients are gone the files are free; they are removed here instead of waiting for the next activation.
 private static void RemoveSwappedFiles(){
  try{foreach(var file in Directory.EnumerateFiles(AppContext.BaseDirectory,"*.old-*",SearchOption.AllDirectories)){try{File.Delete(file);}catch{}}}catch{}
 }
 // Restart spin of the tray berry; the old process leaves a marker, the new one plays it once.
 private string SpinMarker=>Path.Combine(dataFolder,"spin-on-start");
 private readonly System.Windows.Threading.DispatcherTimer spinTimer=new(){Interval=TimeSpan.FromMilliseconds(20)};
 private readonly Stopwatch spinClock=new();
 private double? spinAngle;
 private Bitmap? berryImage;
 private void StartSpinIfRestarted(){
  try{if(!File.Exists(SpinMarker))return;var fresh=DateTime.UtcNow-File.GetLastWriteTimeUtc(SpinMarker)<TimeSpan.FromMinutes(2);File.Delete(SpinMarker);if(!fresh)return;}catch{return;}
  StartSpin(landing:true);
 }
 private bool spinWired,spinLanding;
 // The update check in the tray menu flicks the visible berry (speeds up, slows down); after a restart it
 // appears already spinning at full speed and only slows down. A spin already running just starts over.
 private void StartSpin(bool landing=false){
  if(!saved.Settings.Motion)return;
  if(!spinWired){spinWired=true;spinTimer.Tick+=(_,_)=>{var t=spinClock.Elapsed.TotalSeconds;spinAngle=spinLanding?TraySpin.LandingAngle(t):TraySpin.Angle(t);if(spinAngle==null)spinTimer.Stop();UpdateIcon();};}
  spinLanding=landing;
  // Landing starts edge-on, so the berry is never seen still before it spins.
  if(landing){spinAngle=90;UpdateIcon();}
  spinClock.Restart();spinTimer.Start();
 }
 // Tray menu in the app's look. The version line checks for updates on click and offers them one after another.
 // Native texts (tray menu, dialogs) follow the language chosen in the settings; the panel translates itself.
 private static string L(string de,string en)=>Lang.L(de,en);
 private void BuildTrayMenu(){
  var previous=tray.ContextMenuStrip;
  var menu=TrayMenu.Create();
  var versionText="Pi Relay "+integratedViewer.AppVersion+" · noVNC "+(integratedViewer.Installed==""?"?":integratedViewer.Installed);
  var version=new VersionItem{Font=menu.Font,ToolTipText=L("Klicken: nach Updates suchen","Click: check for updates")};version.Set(versionText,TrayMenu.Muted,false);menu.Items.Add(version);
  var keepOpen=false;var checking=false;
  menu.ItemClicked+=(_,e)=>keepOpen=e.ClickedItem==version;
  menu.Closing+=(_,e)=>{if(keepOpen&&e.CloseReason==Forms.ToolStripDropDownCloseReason.ItemClicked)e.Cancel=true;keepOpen=false;};
  version.Click+=async(_,_)=>{
   if(checking)return;checking=true;
   try{
    version.SlideTo(L("Suche nach Updates …","Checking for updates …"),TrayMenu.Text);
    await Task.Delay(170);StartSpin();
    var clock=Stopwatch.StartNew();
    try{await integratedViewer.Check();}catch(Exception ex){Log("Update-Prüfung fehlgeschlagen: "+ex.Message);}
    var rest=TimeSpan.FromMilliseconds(1300)-clock.Elapsed;if(rest>TimeSpan.Zero)await Task.Delay(rest);
    await ShowVersionState(version,versionText,true);
   }finally{checking=false;}
  };
  version.UpdateClicked+=()=>Dispatcher.BeginInvoke(()=>StartUpdate(version));
  menu.Items.Add(TrayMenu.Spacer());
  menu.Items.Add(TrayMenu.Item(L("Pi Relay öffnen","Open Pi Relay"),(_,_)=>Dispatcher.BeginInvoke(RevealPanel)));
  menu.Items.Add(TrayMenu.Item(L("SSH-Zugänge neu einlesen","Reload SSH accesses"),async(_,_)=>{try{await Refresh();}catch(Exception e){Log("SSH-Konfiguration nicht lesbar: "+e.Message);tray.ShowBalloonTip(8000,"Pi Relay",e.Message,Forms.ToolTipIcon.Warning);}}));
  var activateItem=TrayMenu.Item("",(_,_)=>Dispatcher.BeginInvoke(()=>Restart(true)));activateItem.ForeColor=TrayMenu.Amber;activateItem.Visible=false;menu.Items.Add(activateItem);
  menu.Items.Add(TrayMenu.Item(L("Pi Relay neu starten","Restart Pi Relay"),(_,_)=>Dispatcher.BeginInvoke(()=>Restart(false))));
  menu.Items.Add(TrayMenu.Spacer());
  menu.Items.Add(TrayMenu.Exit(L("Beenden","Quit"),(_,_)=>Dispatcher.BeginInvoke(Quit)));
  menu.Opening+=(_,_)=>{var staged=integratedViewer.Staged;activateItem.Visible=staged!=null;if(staged!=null)activateItem.Text=L("Pi Relay "+staged.AppVersion+" aktivieren & neu starten","Activate Pi Relay "+staged.AppVersion+" & restart");if(!checking)_=ShowVersionState(version,versionText,false);};
  tray.ContextMenuStrip=menu;previous?.Dispose();
 }
 // Up to date: the version line glows green once. Otherwise it names what is waiting and shows the refresh button.
 private async Task ShowVersionState(VersionItem version,string versionText,bool animate){
  var staged=integratedViewer.Staged;
  (string text,Color tint,bool update) state=
   staged!=null?(L("Pi Relay "+staged.AppVersion+" bereit zum Aktivieren","Pi Relay "+staged.AppVersion+" ready to activate"),TrayMenu.Amber,true):
   integratedViewer.Building?(L("Update wird gebaut …","Building update …"),TrayMenu.Amber,false):
   integratedViewer.HasUpdate&&!integratedViewer.IsSkipped?("noVNC "+integratedViewer.Latest+L(" verfügbar"," available"),TrayMenu.Amber,integratedViewer.ProjectRoot!=null):
   animate&&integratedViewer.Error!=""?(L("Prüfung nicht möglich (offline?)","Check not possible (offline?)"),TrayMenu.Muted,false):
   (versionText,TrayMenu.Muted,false);
  version.ToolTipText=!state.update?L("Klicken: nach Updates suchen","Click: check for updates"):staged!=null?L("Knopf rechts: neue Version aktivieren (Pi Relay startet neu)","Button on the right: activate the new version (Pi Relay restarts)"):L("Knopf rechts: Update bauen und prüfen","Button on the right: build and test the update");
  if(!animate){version.Set(state.text,state.tint,state.update);return;}
  version.SlideTo(state.text,state.tint,state.update);
  if(state.text==versionText){await Task.Delay(VersionItem.SlideTime);version.Glow();}
  else if(!state.update&&integratedViewer.Error!=""){await Task.Delay(2400);version.SlideTo(versionText,TrayMenu.Muted);}
 }
 // One step at a time: a tested build waiting → activate (restart); a newer noVNC → build and test it first.
 private void StartUpdate(VersionItem version){
  try{
   if(integratedViewer.Staged!=null){Restart(true);return;}
   if(integratedViewer.HasUpdate&&!integratedViewer.Building){integratedViewer.StartBuild(integratedViewer.Latest);Log("Integrierter Viewer: Update-Build im PowerShell-Fenster gestartet");version.SlideTo(L("Update wird gebaut …","Building update …"),TrayMenu.Amber);}
  }catch(Exception e){Notice(e.Message);tray.ShowBalloonTip(8000,"Pi Relay",e.Message,Forms.ToolTipIcon.Warning);}
 }
 // A restart ends every SSH session (a program running in the terminal is stopped too): with sessions
 // open it asks first, in front of everything, also when it was started from the tray menu.
 private bool ConfirmEndSessions(string question){
  if(!connections.Values.Any(c=>c.IsReady)&&!agents.Values.Any(a=>a.VisibleState=="busy"))return true;
  return Forms.MessageBox.Show(question+L("\n\nDabei werden die offenen SSH-Verbindungen getrennt: Terminal (laufende Programme darin werden beendet), Pi-Bildschirm und Agenten.","\n\nThis ends the open SSH connections: terminal (programs running in it are stopped), Pi screen and agents."),"Pi Relay",Forms.MessageBoxButtons.YesNo,Forms.MessageBoxIcon.Question,Forms.MessageBoxDefaultButton.Button2,Forms.MessageBoxOptions.DefaultDesktopOnly)==Forms.DialogResult.Yes;
 }
 // Loaded once into memory, so the ui folder stays free for an update swap.
 private Bitmap? Berry(){if(berryImage!=null)return berryImage;var file=Path.Combine(AppContext.BaseDirectory,"ui","assets","raspberry.png");if(!File.Exists(file))return null;using var stream=new MemoryStream(File.ReadAllBytes(file));using var loaded=Image.FromStream(stream);return berryImage=new Bitmap(loaded);}
 // Turning around the vertical axis: the berry narrows to a sliver, shows its darker mirrored back, and widens again.
 private void DrawBerry(Graphics g,Bitmap berry){
  if(spinAngle is not double angle){g.DrawImage(berry,1,0,23,31);return;}
  var c=Math.Cos(angle*Math.PI/180);var width=(float)Math.Max(1.5,23*Math.Abs(c));var left=12.5f-width/2;
  g.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
  if(c>=0){g.DrawImage(berry,left,0,width,31);return;}
  using var dim=new System.Drawing.Imaging.ImageAttributes();dim.SetColorMatrix(new System.Drawing.Imaging.ColorMatrix(new[]{new[]{.62f,0,0,0,0},new[]{0,.62f,0,0,0},new[]{0,0,.62f,0,0},new[]{0,0,0,1f,0},new[]{0,0,0,0,1f}}));
  g.DrawImage(berry,new[]{new PointF(left+width,0),new PointF(left,0),new PointF(left+width,31)},new RectangleF(0,0,berry.Width,berry.Height),GraphicsUnit.Pixel,dim);
 }
 // Redrawn only when something visible changed (agent states, spin angle); Push calls this every tick.
 private string iconKey="";
 private static bool AgentConnected(string? state)=>state is "ready" or "active" or "busy";
 private static bool AgentWorking(string? state)=>state is "active" or "busy";
 private void UpdateIcon(){try{var codexState=agents.GetValueOrDefault("codex")?.VisibleState;var claudeState=agents.GetValueOrDefault("claude")?.VisibleState;var working=AgentWorking(codexState)||AgentWorking(claudeState);if(working&&!blinkTimer.IsEnabled){blinkOn=true;blinkTimer.Start();}else if(!working&&blinkTimer.IsEnabled){blinkTimer.Stop();blinkOn=true;}var key=codexState+"|"+claudeState+"|"+spinAngle+"|"+(working&&blinkOn);if(key==iconKey&&trayIcon!=null)return;iconKey=key;var berry=Berry();if(berry==null)return;bool Lit(string? state)=>AgentConnected(state)&&(!AgentWorking(state)||blinkOn);using var bitmap=new Bitmap(32,32);using(var g=Graphics.FromImage(bitmap)){g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;DrawBerry(g,berry);using var blue=new SolidBrush(Lit(codexState)?Color.FromArgb(66,133,255):Color.FromArgb(81,89,112));using var orange=new SolidBrush(Lit(claudeState)?Color.FromArgb(218,119,86):Color.FromArgb(107,84,79));g.FillEllipse(blue,25,8,6,6);g.FillEllipse(orange,25,19,6,6);}var handle=bitmap.GetHicon();var next=(System.Drawing.Icon)System.Drawing.Icon.FromHandle(handle).Clone();DestroyIcon(handle);tray.Icon=next;trayIcon?.Dispose();trayIcon=next;tray.Text="Pi Relay · Codex: "+agents.GetValueOrDefault("codex")?.VisibleState+" · Claude: "+agents.GetValueOrDefault("claude")?.VisibleState;}catch{}}
 // Tray restart, optionally activating a tested staged build. Ending live SSH sessions needs a confirmation.
 private void Restart(bool activate){
  if(!ConfirmEndSessions(activate?L("Die neue Version aktivieren und Pi Relay neu starten?","Activate the new version and restart Pi Relay?"):L("Pi Relay jetzt neu starten?","Restart Pi Relay now?")))return;
  Log(activate?"Aktivierung der neuen Version angefordert":"Neustart angefordert");
  try{if(activate)integratedViewer.StartActivation(Environment.ProcessId);else Relaunch.Start(Environment.ProcessId,Environment.ProcessPath!);}
  catch(Exception e){Notice(e.Message);tray.ShowBalloonTip(8000,"Pi Relay",e.Message,Forms.ToolTipIcon.Warning);return;}
  try{File.WriteAllText(SpinMarker,"");}catch{}
  Log(activate?"Neue Version wird aktiviert; Pi Relay startet neu":"Pi Relay startet neu");Quit();
 }
 private void Quit(){exiting=true;lifetime.Cancel();timer.Stop();spinTimer.Stop();idleTimer.Stop();blinkTimer.Stop();collapseTimer.Stop();resizeTimer.Stop();foreach(var terminal in terminals.Values)terminal.Finish();foreach(var screen in screens.Values)screen.Finish(true);foreach(var a in agents.Values)a.Dispose();foreach(var session in connections.Values)session.Dispose();tray.Visible=false;tray.Dispose();trayIcon?.Dispose();System.Windows.Application.Current.Shutdown();}
 [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr handle);
 [StructLayout(LayoutKind.Sequential)] private struct NativeRect{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window,out NativeRect rect);
}

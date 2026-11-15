using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using Forms=System.Windows.Forms;

namespace PiRelay;
// The tray menu in the app's own look: dark plum surface, white entries, red "Beenden",
// thin dividers and Windows 11 rounded corners. No check or image margin.
public static class TrayMenu {
 public static readonly Color Surface=Color.FromArgb(29,25,32),Hover=Color.FromArgb(52,38,52),Line=Color.FromArgb(62,52,66),
  Text=Color.FromArgb(242,238,244),Muted=Color.FromArgb(160,151,166),Danger=Color.FromArgb(255,96,118),Pink=Color.FromArgb(226,72,112),
  Green=Color.FromArgb(78,224,138),Amber=Color.FromArgb(240,170,70),DangerHover=Color.FromArgb(70,34,46);
 public const int Width=280,EdgeHeight=42,CapRadius=10;
 public static Forms.ContextMenuStrip Create(){
  var menu=new Forms.ContextMenuStrip{Renderer=new Renderer(),ShowImageMargin=false,ShowCheckMargin=false,BackColor=Surface,ForeColor=Text,Font=new Font("Segoe UI",9.5f),Padding=Forms.Padding.Empty};
  menu.HandleCreated+=(_,_)=>Round(menu.Handle);
  return menu;
 }
 public static Forms.ToolStripMenuItem Item(string text,EventHandler click)=>new(text,null,click){ForeColor=Text,AutoSize=false,Size=new Size(Width,32)};
 // "Beenden" at the foot: door symbol, divider on its top edge; on hover the letters tremble.
 public static Forms.ToolStripMenuItem Exit(string text,EventHandler click){var item=new Forms.ToolStripMenuItem(text,null,click){ForeColor=Danger,AutoSize=false,Size=new Size(Width,EdgeHeight)};item.Tag=new LetterMotion(item,LetterMotion.Style.Shake);return item;}
 // Breathing room between the groups; the dividers belong to the version line and to "Beenden".
 public static Forms.ToolStripSeparator Spacer()=>new(){AutoSize=false,Size=new Size(Width,6)};
 // Items are laid out wider than the dropdown can be; everything is drawn inside the visible part.
 internal static int VisibleWidth(Forms.ToolStripItem item){var owner=item.Owner;return owner==null?item.Width:Math.Max(40,Math.Min(item.Width,owner.ClientSize.Width-item.Bounds.Left-1));}
 private static void Round(IntPtr handle){try{var preference=2;DwmSetWindowAttribute(handle,33,ref preference,sizeof(int));}catch{}}
 [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window,int attribute,ref int value,int size);
 private sealed class Renderer:Forms.ToolStripProfessionalRenderer {
  public Renderer():base(new Colors()){RoundedEdges=false;}
  protected override void OnRenderToolStripBackground(Forms.ToolStripRenderEventArgs e)=>e.Graphics.Clear(Surface);
  protected override void OnRenderToolStripBorder(Forms.ToolStripRenderEventArgs e){}
  protected override void OnRenderMenuItemBackground(Forms.ToolStripItemRenderEventArgs e){
   var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;var w=VisibleWidth(e.Item);
   if(e.Item.Tag is LetterMotion){using var pen=new Pen(Line);g.DrawLine(pen,12,0,w-12,0);Door(g,new Rectangle(18,(e.Item.Height-16)/2+1,16,16));return;}
   if(e.Item.Selected&&e.Item.Enabled){using var path=RoundRect(new Rectangle(6,1,w-12,e.Item.Height-2),7);using var fill=new SolidBrush(Hover);g.FillPath(fill,path);}
  }
  protected override void OnRenderItemText(Forms.ToolStripItemTextRenderEventArgs e){
   if(e.Item.Tag is LetterMotion motion){e.Graphics.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;motion.Draw(e.Graphics,e.Item.Text??"",e.Item.Font,e.Item.ForeColor,new RectangleF(42,1,VisibleWidth(e.Item)-58,e.Item.Height-1));return;}
   e.TextColor=e.Item.ForeColor;e.TextRectangle=new Rectangle(16,0,VisibleWidth(e.Item)-32,e.Item.Height);e.TextFormat=Forms.TextFormatFlags.VerticalCenter|Forms.TextFormatFlags.Left|Forms.TextFormatFlags.NoPrefix|Forms.TextFormatFlags.EndEllipsis;base.OnRenderItemText(e);
  }
  protected override void OnRenderSeparator(Forms.ToolStripSeparatorRenderEventArgs e){}
 }
 // A door frame open to the right with an arrow walking out of it.
 private static void Door(Graphics g,Rectangle r){
  using var pen=new Pen(Danger,1.6f){LineJoin=LineJoin.Round,StartCap=LineCap.Round,EndCap=LineCap.Round};
  g.DrawLines(pen,new[]{new PointF(r.X+9,r.Y+1),new PointF(r.X+2,r.Y+1),new PointF(r.X+2,r.Bottom-1),new PointF(r.X+9,r.Bottom-1)});
  var mid=r.Y+r.Height/2f;
  g.DrawLine(pen,r.X+6,mid,r.Right-1,mid);
  g.DrawLines(pen,new[]{new PointF(r.Right-4,mid-3),new PointF(r.Right-1,mid),new PointF(r.Right-4,mid+3)});
 }
 private sealed class Colors:Forms.ProfessionalColorTable {
  public override Color ToolStripDropDownBackground=>Surface;
  public override Color MenuBorder=>Line;
  public override Color MenuItemBorder=>Color.Transparent;
  public override Color MenuItemSelected=>Hover;
  public override Color ImageMarginGradientBegin=>Surface;
  public override Color ImageMarginGradientMiddle=>Surface;
  public override Color ImageMarginGradientEnd=>Surface;
 }
 internal static GraphicsPath RoundRect(Rectangle r,int radius){var path=new GraphicsPath();var d=radius*2;path.AddArc(r.X,r.Y,d,d,180,90);path.AddArc(r.Right-d,r.Y,d,d,270,90);path.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);path.AddArc(r.X,r.Bottom-d,d,d,90,90);path.CloseFigure();return path;}
 // Rounded on one side only (the divider side); the other side runs square into the menu edge.
 internal static GraphicsPath Cap(Rectangle r,int radius,bool top){
  var path=new GraphicsPath();var d=radius*2;
  if(top){path.AddArc(r.X,r.Y,d,d,180,90);path.AddArc(r.Right-d,r.Y,d,d,270,90);path.AddLine(r.Right,r.Bottom,r.X,r.Bottom);}
  else{path.AddLine(r.X,r.Y,r.Right,r.Y);path.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);path.AddArc(r.X,r.Bottom-d,d,d,90,90);}
  path.CloseFigure();return path;
 }
}
// The version line: fixed size so the menu never re-lays out (and never jumps). Text changes slide:
// the old text moves left and fades, the new one comes in from the right. A green glow confirms
// "up to date"; an update offer shows a small refresh button on the right.
public sealed class VersionItem:Forms.ToolStripMenuItem {
 private string text="",oldText="";
 private Color color=TrayMenu.Muted,oldColor=TrayMenu.Muted;
 private readonly Stopwatch slide=new(),glow=new();
 private readonly Forms.Timer frame=new(){Interval=16};
 public bool ShowUpdate {get;private set;}
 public event Action? UpdateClicked;
 private readonly LetterMotion dance;
 public VersionItem(){AutoSize=false;Size=new Size(TrayMenu.Width,TrayMenu.EdgeHeight);dance=new LetterMotion(this,LetterMotion.Style.Shake);frame.Tick+=(_,_)=>{if(!Animating)frame.Stop();Invalidate();};}
 private const double OutMs=170,InMs=230,GlowMs=1100;
 private bool Animating=>slide.IsRunning&&slide.Elapsed.TotalMilliseconds<OutMs+InMs||glow.IsRunning&&glow.Elapsed.TotalMilliseconds<GlowMs;
 public string Current=>text;
 // Shows text right away (menu opening), no motion.
 public void Set(string value,Color tint,bool update){text=value;color=tint;ShowUpdate=update;slide.Reset();glow.Reset();Invalidate();}
 public void SlideTo(string value,Color tint,bool update=false){if(value==text&&tint==color&&update==ShowUpdate)return;oldText=text;oldColor=color;text=value;color=tint;ShowUpdate=update;slide.Restart();frame.Start();}
 public void Glow(){glow.Restart();frame.Start();}
 // Duration of a full slide, so a caller can wait before the next text.
 public static TimeSpan SlideTime=>TimeSpan.FromMilliseconds(OutMs+InMs);
 private Rectangle UpdateButton=>new(TrayMenu.VisibleWidth(this)-40,(Height-1-26)/2,26,26);
 // Only a left click on the button starts an update; a right click or a click on the text never does.
 protected override void OnMouseUp(Forms.MouseEventArgs e){if(ShowUpdate&&e.Button==Forms.MouseButtons.Left&&UpdateButton.Contains(e.Location)){UpdateClicked?.Invoke();return;}base.OnMouseUp(e);}
 protected override void OnPaint(Forms.PaintEventArgs e){
  var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.TextRenderingHint=System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
  g.Clear(TrayMenu.Surface);var w=TrayMenu.VisibleWidth(this);
  // No hover background here: the letters dance instead (LetterMotion).
  using(var pen=new Pen(TrayMenu.Line))g.DrawLine(pen,12,Height-1,w-12,Height-1);
  var area=new Rectangle(16,0,w-(ShowUpdate?64:32),Height-1);
  var state=g.Save();g.SetClip(area);
  var ms=slide.IsRunning?slide.Elapsed.TotalMilliseconds:double.MaxValue;
  if(ms<OutMs){var t=Ease(ms/OutMs);Draw(g,oldText,oldColor,area,-26*t,1-t);}
  else{var t=ms<OutMs+InMs?Ease((ms-OutMs)/InMs):1;Draw(g,text,Glowing(color),area,26*(1-t),t);}
  g.Restore(state);
  if(ShowUpdate){var b=UpdateButton;using var path=TrayMenu.RoundRect(b,8);using var fill=new SolidBrush(Color.FromArgb(70,TrayMenu.Amber));g.FillPath(fill,path);
   Forms.TextRenderer.DrawText(g,"",IconFont(),b,TrayMenu.Amber,Forms.TextFormatFlags.HorizontalCenter|Forms.TextFormatFlags.VerticalCenter|Forms.TextFormatFlags.NoPadding);}
 }
 // Refresh glyph: Segoe Fluent Icons on Windows 11, Segoe MDL2 Assets on Windows 10 (same code point).
 private static Font? iconFont;
 private static Font IconFont(){if(iconFont!=null)return iconFont;var fluent=new Font("Segoe Fluent Icons",11f);if(fluent.Name=="Segoe Fluent Icons")return iconFont=fluent;fluent.Dispose();return iconFont=new Font("Segoe MDL2 Assets",11f);}
 private Color Glowing(Color tint){
  if(!glow.IsRunning)return tint;var u=glow.Elapsed.TotalMilliseconds/GlowMs;if(u>=1)return tint;
  var k=Math.Sin(Math.Min(1,u)*Math.PI);k*=k;return Color.FromArgb((int)(tint.R+(TrayMenu.Green.R-tint.R)*k),(int)(tint.G+(TrayMenu.Green.G-tint.G)*k),(int)(tint.B+(TrayMenu.Green.B-tint.B)*k));
 }
 private void Draw(Graphics g,string value,Color tint,Rectangle area,double dx,double alpha){
  var c=Color.FromArgb((int)(255*Math.Clamp(alpha,0,1)),tint);
  dance.Draw(g,value,Font,c,new RectangleF(area.X+(float)dx,area.Y,area.Width,area.Height));
 }
 private static double Ease(double t){t=Math.Clamp(t,0,1);return 1-Math.Pow(1-t,3);}
 protected override void Dispose(bool disposing){if(disposing)frame.Dispose();base.Dispose(disposing);}
}

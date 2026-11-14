using System.Runtime.InteropServices;

namespace PiRelay;
public sealed record WindowOutlineResult(bool Applied,bool CornersClipped,int RadiusPixels,int WidthPixels,int HeightPixels);
public static class WindowOutline {
 public const int RadiusDip=18;
 public static bool ApplySlideClip(IntPtr window,double offsetDip){
  if(window==IntPtr.Zero||!double.IsFinite(offsetDip)||!GetWindowRect(window,out var rect))return false;
  var width=rect.Right-rect.Left;var height=rect.Bottom-rect.Top;
  if(width<=0||height<=0)return false;
  var dpi=GetDpiForWindow(window);var scale=(dpi==0?96:dpi)/96.0;
  var radius=Math.Max(1,(int)Math.Round(RadiusDip*scale));
  var offset=(int)Math.Clamp(Math.Ceiling(offsetDip*scale),0,height+1);
  var region=CreateSlideRegion(width,height,radius,offset);
  if(region==IntPtr.Zero)return false;
  if(SetWindowRgn(window,region,true)!=0)return true; // Windows owns it.
  DeleteObject(region);return false;
 }
 internal static IntPtr CreateSlideRegion(int width,int height,int radius,int offset){
  var viewport=CreateRoundRectRgn(0,0,width+1,height+1,radius*2,radius*2);
  var front=CreateRoundRectRgn(0,offset,width+1,height+offset+1,radius*2,radius*2);
  try{
   if(viewport==IntPtr.Zero||front==IntPtr.Zero||CombineRgn(viewport,viewport,front,1)==0){if(viewport!=IntPtr.Zero)DeleteObject(viewport);return IntPtr.Zero;}
   return viewport;
  }finally{if(front!=IntPtr.Zero)DeleteObject(front);}
 }
 public static WindowOutlineResult Apply(IntPtr window){
  if(window==IntPtr.Zero||!GetWindowRect(window,out var rect))return new(false,false,0,0,0);
  var width=rect.Right-rect.Left;var height=rect.Bottom-rect.Top;
  if(width<=0||height<=0)return new(false,false,0,width,height);
  var dpi=GetDpiForWindow(window);var radius=Math.Max(1,(int)Math.Round(RadiusDip*(dpi==0?96:dpi)/96.0));
  var region=CreateRoundRectRgn(0,0,width+1,height+1,radius*2,radius*2);
  if(region==IntPtr.Zero)return new(false,false,radius,width,height);
  // On success Windows owns the region, including clipping child HWNDs such as
  // WebView2. A CSS radius or a DWM preference alone cannot mask the outer host.
  if(SetWindowRgn(window,region,true)==0){DeleteObject(region);return new(false,false,radius,width,height);}
  var actual=CreateRectRgn(0,0,0,0);
  try{
   var clipped=actual!=IntPtr.Zero&&GetWindowRgn(window,actual)!=0
    &&!PtInRegion(actual,0,0)&&!PtInRegion(actual,width-1,0)
    &&!PtInRegion(actual,0,height-1)&&!PtInRegion(actual,width-1,height-1)
    &&PtInRegion(actual,width/2,height/2);
   return new(true,clipped,radius,width,height);
  }finally{if(actual!=IntPtr.Zero)DeleteObject(actual);}
 }
 [StructLayout(LayoutKind.Sequential)] private struct Rect{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window,out Rect rect);
 [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
 [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr window,IntPtr region,bool redraw);
 [DllImport("user32.dll")] private static extern int GetWindowRgn(IntPtr window,IntPtr region);
 [DllImport("gdi32.dll")] private static extern IntPtr CreateRoundRectRgn(int left,int top,int right,int bottom,int ellipseWidth,int ellipseHeight);
 [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left,int top,int right,int bottom);
 [DllImport("gdi32.dll")] private static extern int CombineRgn(IntPtr destination,IntPtr first,IntPtr second,int mode);
 [DllImport("gdi32.dll")] private static extern bool PtInRegion(IntPtr region,int x,int y);
 [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
}

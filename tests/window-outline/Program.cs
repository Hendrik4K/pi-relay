using System.Runtime.InteropServices;
using PiRelay;

var width=520;var height=442;var radius=18;
foreach(var offset in new[]{0,22,110,221,330,height+1}){
 var region=WindowOutline.CreateSlideRegion(width,height,radius,offset);
 Check(region!=IntPtr.Zero,"region allocated");
 try{
  Check(!PtInRegion(region,0,0)&&!PtInRegion(region,width-1,0),"native top corners excluded");
  Check(!PtInRegion(region,0,height-1)&&!PtInRegion(region,width-1,height-1),"native lower corners excluded");
  if(offset>0)Check(!PtInRegion(region,width/2,Math.Min(height-1,offset-1)),"stationary host background above front excluded");
  if(offset<height-radius)Check(PtInRegion(region,width/2,offset+radius+2),"moving front remains visible");
  else Check(!PtInRegion(region,width/2,height-1),"fully lowered front leaves no host region");
 }finally{DeleteObject(region);}
}
Console.WriteLine("PASS: native rounded clip at six slide positions removes the host background and preserves the moving front; final mask is empty.");
static void Check(bool condition,string message){if(!condition)throw new Exception(message);}
[DllImport("gdi32.dll")] static extern bool PtInRegion(IntPtr region,int x,int y);
[DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);

using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace PiRelay;
// User pictures for the Pi case and the two companions. Each import is decoded and re-encoded as a
// PNG (no metadata, bounded size) into the app's data folder; the bundled pictures stay untouched.
public sealed class IconStore {
 public static readonly string[] Slots=["device","codex","claude"];
 private const long MaxBytes=8*1024*1024;
 private const int MaxSide=1600;
 public string Folder {get;}
 public IconStore(string dataFolder){Folder=Path.Combine(dataFolder,"icons");}
 private static string Check(string slot)=>Slots.Contains(slot)?slot:throw new InvalidOperationException("Unbekanntes Bild");
 private string PathFor(string slot)=>Path.Combine(Folder,Check(slot)+".png");
 public void Import(string slot,string source){
  var target=PathFor(slot);
  if(new FileInfo(source).Length>MaxBytes)throw new InvalidOperationException("Bild ist größer als 8 MB.");
  Image image;
  try{image=Image.FromFile(source);}catch(Exception){throw new InvalidOperationException("Datei ist kein lesbares Bild (PNG oder JPG).");}
  using(image){
   var scale=Math.Min(1.0,(double)MaxSide/Math.Max(image.Width,image.Height));
   var width=Math.Max(1,(int)Math.Round(image.Width*scale));var height=Math.Max(1,(int)Math.Round(image.Height*scale));
   using var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb);
   using(var g=Graphics.FromImage(bitmap)){g.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;g.DrawImage(image,0,0,width,height);}
   Directory.CreateDirectory(Folder);var temp=target+".tmp";bitmap.Save(temp,ImageFormat.Png);File.Move(temp,target,true);
  }
 }
 public void Reset(string slot){var target=PathFor(slot);if(File.Exists(target))File.Delete(target);}
 // A changing token per slot lets the renderer bypass its image cache after an import.
 public Dictionary<string,long> Snapshot()=>Slots.Where(s=>File.Exists(PathFor(s))).ToDictionary(s=>s,s=>File.GetLastWriteTimeUtc(PathFor(s)).Ticks);
}

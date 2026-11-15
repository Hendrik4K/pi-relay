namespace PiRelay;
// After a restart the tray berry spins like a flicked coin: soft start, at most 5.5 turns/s,
// a long slow-down over 8 turns, then one small rock before it lies still.
public static class TraySpin {
 public const int Turns=8;
 private const double Peak=5.5,Rise=.22,Wobble=12,WobbleSeconds=.45;
 private static readonly double[] cumulative=Build(out spinSeconds);
 private static readonly double spinSeconds;
 public static double Duration=>spinSeconds+WobbleSeconds;
 private static double Speed(double u)=>u<Rise?Math.Pow(Math.Sin(u/Rise*Math.PI/2),2):Math.Pow(1-(u-Rise)/(1-Rise),2.2);
 private static double[] Build(out double seconds){
  const int n=2000;var table=new double[n+1];for(var i=0;i<n;i++)table[i+1]=table[i]+Speed((i+.5)/n);
  seconds=Turns/(Peak*table[n]/n);for(var i=0;i<=n;i++)table[i]/=table[n];return table;
 }
 // Angle in degrees (0 = front) at a time after the start; null once the spin has finished.
 public static double? Angle(double seconds){
  if(seconds<0||seconds>=Duration)return null;
  if(seconds<spinSeconds){var x=seconds/spinSeconds*(cumulative.Length-1);var i=(int)x;var f=x-i;var share=i+1<cumulative.Length?cumulative[i]+(cumulative[i+1]-cumulative[i])*f:1;return 360*Turns*share%360;}
  var u=(seconds-spinSeconds)/WobbleSeconds;return Wobble*Math.Exp(-4*u)*Math.Sin(u*Math.PI*2);
 }
}

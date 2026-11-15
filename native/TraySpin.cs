namespace PiRelay;
// The tray berry spins like a flicked coin: soft start, at most 5.5 turns/s, a long slow-down over
// 8 turns, then one small rock before it lies still (update check).
// After a restart it "lands" instead: it appears already at full speed, edge-on, and only slows down.
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
 private static double Share(double u){var x=Math.Clamp(u,0,1)*(cumulative.Length-1);var i=(int)x;var f=x-i;return i+1<cumulative.Length?cumulative[i]+(cumulative[i+1]-cumulative[i])*f:1;}
 private static double Rock(double seconds)=>Wobble*Math.Exp(-4*seconds/WobbleSeconds)*Math.Sin(seconds/WobbleSeconds*Math.PI*2);
 // Angle in degrees (0 = front) at a time after the start; null once the spin has finished.
 public static double? Angle(double seconds){
  if(seconds<0||seconds>=Duration)return null;
  if(seconds<spinSeconds)return 360*Turns*Share(seconds/spinSeconds)%360;
  return Rock(seconds-spinSeconds);
 }
 // Landing after a restart: the slow-down part only, starting edge-on (90°, invisible) at full speed and
 // ending exactly at the front, so it settles into the still berry with the same small rock.
 private static readonly double landingSeconds=spinSeconds*(1-Rise),landingStart=Share(Rise);
 private static readonly double landingTurns=Math.Round(Turns*(1-landingStart)+.25)*360-90;
 public static double LandingDuration=>landingSeconds+WobbleSeconds;
 public static double? LandingAngle(double seconds){
  if(seconds<0||seconds>=LandingDuration)return null;
  if(seconds<landingSeconds)return (90+landingTurns*(Share(Rise+seconds/spinSeconds)-landingStart)/(1-landingStart))%360;
  return Rock(seconds-landingSeconds);
 }
}

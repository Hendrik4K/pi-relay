using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;

namespace PiRelay;
// Which local process opened a loopback TCP connection. The local port for an external VNC viewer
// serves only the viewer Pi Relay started; other programs or Windows accounts on this PC are refused.
public static class LoopbackPeer {
 [DllImport("iphlpapi.dll")] private static extern uint GetExtendedTcpTable(IntPtr table,ref int size,bool order,int family,int tableClass,uint reserved);
 [DllImport("kernel32.dll",SetLastError=true)] private static extern IntPtr OpenProcess(uint access,bool inherit,int processId);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process,int flags,StringBuilder name,ref int size);
 [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] private static extern int GetLongPathName(string shortPath,StringBuilder longPath,int size);
 private const int AfInet=2,TcpTableOwnerPidConnections=4,RowSize=24;
 private const uint ProcessQueryLimitedInformation=0x1000,ErrorInsufficientBuffer=122;

 // The process owning the client end of a connection from `client` to our listener on `serverPort`.
 public static int? OwnerProcessId(IPEndPoint client,int serverPort){
  for(var attempt=0;attempt<4;attempt++){
   var size=0;GetExtendedTcpTable(IntPtr.Zero,ref size,false,AfInet,TcpTableOwnerPidConnections,0);
   var buffer=Marshal.AllocHGlobal(size+4096);size+=4096;
   try{
    var result=GetExtendedTcpTable(buffer,ref size,false,AfInet,TcpTableOwnerPidConnections,0);
    if(result==ErrorInsufficientBuffer)continue;
    if(result!=0)return null;
    var rows=Marshal.ReadInt32(buffer);
    for(var i=0;i<rows;i++){
     var row=buffer+4+i*RowSize;
     if(Port(Marshal.ReadInt32(row,8))==client.Port&&Port(Marshal.ReadInt32(row,16))==serverPort)return Marshal.ReadInt32(row,20);
    }
    return null;
   }finally{Marshal.FreeHGlobal(buffer);}
  }
  return null;
 }
 // Ports are stored in network byte order in the low 16 bits.
 private static int Port(int raw)=>((raw&0xFF)<<8)|((raw>>8)&0xFF);

 public static string? ProcessPath(int processId){
  var handle=OpenProcess(ProcessQueryLimitedInformation,false,processId);if(handle==IntPtr.Zero)return null;
  try{var name=new StringBuilder(1024);var size=name.Capacity;return QueryFullProcessImageName(handle,0,name,ref size)?name.ToString():null;}
  finally{CloseHandle(handle);}
 }

 // Short (8.3) and long spellings of the same path compare equal.
 private static string Normal(string path){var full=Path.GetFullPath(path);var buffer=new StringBuilder(1024);var length=GetLongPathName(full,buffer,buffer.Capacity);return length>0&&length<buffer.Capacity?buffer.ToString():full;}
 public static bool IsFrom(IPEndPoint client,int serverPort,string exe){
  var path=OwnerProcessId(client,serverPort) is int id?ProcessPath(id):null;
  return path!=null&&string.Equals(Normal(path),Normal(exe),StringComparison.OrdinalIgnoreCase);
 }
}

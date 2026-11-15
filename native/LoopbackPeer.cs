using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Principal;
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
 [DllImport("advapi32.dll",SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] private static extern bool GetTokenInformation(IntPtr token,int infoClass,IntPtr info,int length,out int needed);
 private const int AfInet=2,TcpTableOwnerPidConnections=4,RowSize=24,TokenUserClass=1;
 private const uint ProcessQueryLimitedInformation=0x1000,ErrorInsufficientBuffer=122,TokenQuery=0x0008;

 // The process owning the client end of a connection from `client` to our listener on 127.0.0.1:`serverPort`.
 // The whole connection must match (both addresses, both ports, established) and exactly one row may match:
 // another account binding the same port on 127.0.0.2 cannot borrow the viewer's identity.
 public static int? OwnerProcessId(IPEndPoint client,int serverPort){
  if(!client.Address.Equals(IPAddress.Loopback))return null;
  var clientAddress=BitConverter.ToInt32(client.Address.GetAddressBytes());var serverAddress=BitConverter.ToInt32(IPAddress.Loopback.GetAddressBytes());
  for(var attempt=0;attempt<4;attempt++){
   var size=0;GetExtendedTcpTable(IntPtr.Zero,ref size,false,AfInet,TcpTableOwnerPidConnections,0);
   var buffer=Marshal.AllocHGlobal(size+4096);size+=4096;
   try{
    var result=GetExtendedTcpTable(buffer,ref size,false,AfInet,TcpTableOwnerPidConnections,0);
    if(result==ErrorInsufficientBuffer)continue;
    if(result!=0)return null;
    var rows=Marshal.ReadInt32(buffer);int? owner=null;var matches=0;
    for(var i=0;i<rows;i++){
     var row=buffer+4+i*RowSize;
     if(Marshal.ReadInt32(row,0)==Established&&Marshal.ReadInt32(row,4)==clientAddress&&Port(Marshal.ReadInt32(row,8))==client.Port&&Marshal.ReadInt32(row,12)==serverAddress&&Port(Marshal.ReadInt32(row,16))==serverPort){owner=Marshal.ReadInt32(row,20);matches++;}
    }
    return matches==1?owner:null;
   }finally{Marshal.FreeHGlobal(buffer);}
  }
  return null;
 }
 private const int Established=5;
 // Ports are stored in network byte order in the low 16 bits.
 private static int Port(int raw)=>((raw&0xFF)<<8)|((raw>>8)&0xFF);

 public static string? ProcessPath(int processId){
  var handle=OpenProcess(ProcessQueryLimitedInformation,false,processId);if(handle==IntPtr.Zero)return null;
  try{var name=new StringBuilder(1024);var size=name.Capacity;return QueryFullProcessImageName(handle,0,name,ref size)?name.ToString():null;}
  finally{CloseHandle(handle);}
 }

 // The Windows account a process runs under; null when its token cannot be read (other accounts).
 public static SecurityIdentifier? ProcessUser(int processId){
  var handle=OpenProcess(ProcessQueryLimitedInformation,false,processId);if(handle==IntPtr.Zero)return null;
  try{
   if(!OpenProcessToken(handle,TokenQuery,out var token))return null;
   try{
    GetTokenInformation(token,TokenUserClass,IntPtr.Zero,0,out var size);if(size<=0)return null;
    var buffer=Marshal.AllocHGlobal(size);
    try{return GetTokenInformation(token,TokenUserClass,buffer,size,out _)?new SecurityIdentifier(Marshal.ReadIntPtr(buffer)):null;}
    finally{Marshal.FreeHGlobal(buffer);}
   }finally{CloseHandle(token);}
  }finally{CloseHandle(handle);}
 }

 // Short (8.3) and long spellings of the same path compare equal.
 private static string Normal(string path){var full=Path.GetFullPath(path);var buffer=new StringBuilder(1024);var length=GetLongPathName(full,buffer,buffer.Capacity);return length>0&&length<buffer.Capacity?buffer.ToString():full;}
 // Same viewer program and the same Windows account: another account starting the same installed
 // viewer against the port is refused as well.
 public static bool IsFrom(IPEndPoint client,int serverPort,string exe){
  if(OwnerProcessId(client,serverPort) is not int id||ProcessPath(id) is not {} path)return false;
  using var me=WindowsIdentity.GetCurrent();
  return string.Equals(Normal(path),Normal(exe),StringComparison.OrdinalIgnoreCase)&&ProcessUser(id) is {} user&&me.User is {} self&&user.Equals(self);
 }
}

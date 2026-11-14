using PiRelay;
var root=Path.GetFullPath(args[0]);Directory.CreateDirectory(root);var sandbox=Path.Combine(root,Guid.NewGuid().ToString("N"));Directory.CreateDirectory(sandbox);
bool running=false;var store=new ViewerStore(Path.Combine(sandbox,"managed"),()=>running);
void Check(bool value,string message){if(!value)throw new Exception(message);}
var first=Path.Combine(sandbox,"one.bin");var second=Path.Combine(sandbox,"two.bin");File.WriteAllText(first,"first viewer");File.WriteAllText(second,"second viewer");
store.Stage(first,"test","1.0.0",ViewerStore.Hash(first),"test");var original=store.VerifiedCurrentPath();
Check(store.Manifest.Current?.Version=="1.0.0","First install");
try{store.Stage(second,"test","2.0.0",new string('0',64),"test");throw new Exception("Corrupt download accepted");}catch(IOException){}
Check(store.VerifiedCurrentPath()==original,"Failed download must preserve active version");
running=true;store.Stage(second,"test","2.0.0",ViewerStore.Hash(second),"test");
Check(store.Manifest.Pending?.Version=="2.0.0"&&store.VerifiedCurrentPath()==original,"Running viewer must defer switch");
try{store.Rollback();throw new Exception("Rollback while running");}catch(InvalidOperationException){}
running=false;Check(store.ApplyPending(),"Pending update applies when closed");
Check(store.Manifest.Current?.Version=="2.0.0"&&store.PreviousVersion=="1.0.0","Previous version preserved");
var reopened=new ViewerStore(Path.Combine(sandbox,"managed"),()=>false);reopened.Rollback();
Check(reopened.VerifiedCurrentPath()==original&&reopened.PreviousVersion=="2.0.0","Rollback survives app restart");
Check(store.Reload()&&store.VerifiedCurrentPath()==original,"Existing app notices an externally adopted viewer without restart");
try{reopened.Stage(first,"../../escape","1.0.0",ViewerStore.Hash(first),"test");throw new Exception("Traversal accepted");}catch(IOException){}
File.AppendAllText(original,"tamper");try{reopened.VerifiedCurrentPath();throw new Exception("Tampered EXE accepted");}catch(IOException){}
var tag="{\"tag_name\":\"v1.2.3\",\"draft\":false,\"prerelease\":false}";
var feed="<rss xmlns:media=\"http://search.yahoo.com/mrss/\"><channel><item><media:content url=\"https://sourceforge.net/projects/tigervnc/files/stable/1.2.3/vncviewer64-1.2.3.exe/download\" filesize=\"1234\"><media:hash algo=\"md5\">0123456789abcdef0123456789abcdef</media:hash></media:content></item></channel></rss>";
var release=ViewerUpdates.ParseTiger(tag,feed);Check(release.Version=="1.2.3"&&release.Size==1234&&release.Download.Contains("/tigervnc/stable/1.2.3/"),"Official release parser");
Check(ViewerUpdates.ParseTiger(tag,feed.Replace("http://search.yahoo.com/mrss/","http://video.search.yahoo.com/mrss/")).Version=="1.2.3","SourceForge media namespace variant");
try{ViewerUpdates.ParseTiger(tag.Replace("v1.2.3","../../escape"),feed);throw new Exception("Bad release tag accepted");}catch(IOException){}
try{ViewerUpdates.ParseTiger(tag,"<rss/>");throw new Exception("Missing Windows artifact accepted");}catch(IOException){}
// Skipping changes metadata only; no network requests or executable launches.
var updateRoot=Path.Combine(sandbox,"skip-checks");var updates=new ViewerUpdates(updateRoot,()=>{},_=>{});
updates.Store.Stage(second,"tigervnc","1.0.0",ViewerStore.Hash(second),"fixture");
var cache=new ViewerUpdateCache{Latest=new("tigervnc","1.1.0","https://example.invalid","","","sha256"),LastAttempt=DateTimeOffset.UtcNow};
void SaveUpdateCache()=>File.WriteAllText(Path.Combine(updateRoot,"updates.json"),Json.Encode(cache));
SaveUpdateCache();updates=new ViewerUpdates(updateRoot,()=>{},_=>{});
Check(updates.HasUpdate&&!updates.IsSkipped,"New version offered");
try{updates.SkipVersion("tigervnc","1.0.9");throw new Exception("Stale skip accepted");}catch(InvalidOperationException){}
try{updates.SkipVersion("realvnc-classic","1.1.0");throw new Exception("Wrong provider accepted");}catch(InvalidOperationException){}
updates.SkipVersion("tigervnc","1.1.0");updates=new ViewerUpdates(updateRoot,()=>{},_=>{});
Check(updates.IsSkipped&&updates.Store.Manifest.Current?.Version=="1.0.0","Skip survives restart and preserves installed viewer");
cache=Json.Decode<ViewerUpdateCache>(File.ReadAllText(Path.Combine(updateRoot,"updates.json")))!;
cache.Latest=cache.Latest! with{Version="1.2.0"};SaveUpdateCache();updates=new ViewerUpdates(updateRoot,()=>{},_=>{});
Check(updates.HasUpdate&&!updates.IsSkipped,"Later version offered after skipping predecessor");
updates.SkipVersion("tigervnc","1.2.0");updates.RestoreSkippedVersion();updates=new ViewerUpdates(updateRoot,()=>{},_=>{});
Check(updates.HasUpdate&&!updates.IsSkipped,"Restoring skipped version persists");
Console.WriteLine("PASS: failed update preserves current, running viewer defers switch, persisted rollback, path/hash checks, stable release parser, exact-version skip persistence, later updates reappear, stale skips rejected, restore persists. No network or viewer launch.");

import importlib.util,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('relay_worker',Path(__file__).with_name('remote_worker.py'))
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class WorkerTests(unittest.TestCase):
 def setUp(self):
  self.tmpRoot=Path(__file__).resolve().parent/'test-data';self.tmpRoot.mkdir(exist_ok=True)
  self.temp=tempfile.TemporaryDirectory(dir=self.tmpRoot);self.root=Path(self.temp.name)/'project';self.root.mkdir()
  (self.root/'hello.txt').write_text('Hallo Pi',encoding='utf-8')
  self.config={'root':str(self.root),'allowWrite':False,'allowCommands':False}
 def tearDown(self):
  self.assertTrue(Path(self.temp.name).resolve().is_relative_to(self.tmpRoot.resolve()))
  self.temp.cleanup()
 def test_read_and_list(self):
  self.assertEqual(worker.perform(self.config,{'op':'read','args':{'path':'hello.txt'}}),'Hallo Pi')
  self.assertEqual(worker.perform(self.config,{'op':'list','args':{}})[0]['name'],'hello.txt')
 def test_path_escape_rejected(self):
  for op in ['read','write','list']:
   with self.assertRaises(PermissionError):worker.resolve_path(self.root,'../outside.txt')
 def test_absolute_escape_rejected(self):
  with self.assertRaises(PermissionError):worker.resolve_path(self.root,str(Path(self.temp.name)/'outside'))
 def test_write_denied_without_opt_in(self):
  with self.assertRaises(PermissionError):worker.perform(self.config,{'op':'write','args':{'path':'hello.txt','content':'changed'}})
  self.assertEqual((self.root/'hello.txt').read_text(encoding='utf-8'),'Hallo Pi')
 def test_write_allowed_inside_project(self):
  self.config['allowWrite']=True
  worker.perform(self.config,{'op':'write','args':{'path':'nested/example.txt','content':'Freigegeben'}})
  self.assertEqual((self.root/'nested/example.txt').read_text(encoding='utf-8'),'Freigegeben')
 def test_command_denied_without_opt_in(self):
  with self.assertRaises(PermissionError):worker.perform(self.config,{'op':'run','args':{'command':'echo should-not-run'}})
 def test_command_opt_in(self):
  self.config['allowCommands']=True
  result=worker.perform(self.config,{'op':'run','args':{'command':'echo relay'}})
  self.assertEqual(result['exitCode'],0);self.assertIn('relay',result['stdout'])
 def test_command_does_not_read_worker_stdin(self):
  self.config['allowCommands']=True
  command=subprocess.list2cmdline([sys.executable,'-c','import sys;print(len(sys.stdin.read()))'])
  result=worker.perform(self.config,{'op':'run','args':{'command':command}})
  self.assertEqual(result['exitCode'],0);self.assertEqual(result['stdout'].strip(),'0')
 def test_large_read_rejected(self):
  (self.root/'large.txt').write_bytes(b'a'*1048577)
  with self.assertRaises(ValueError):worker.perform(self.config,{'op':'read','args':{'path':'large.txt'}})

 def test_inbox_chunks_rename_and_limits(self):
  import base64,secrets
  inbox=self.root/'inbox';inbox.mkdir();original=worker.inbox_folder;worker.inbox_folder=lambda:inbox
  try:
   token=secrets.token_hex(16);b=lambda d:base64.b64encode(d).decode()
   worker.inbox_write({'token':token,'offset':0,'data':b(b'Hallo ')})
   with self.assertRaises(ValueError):worker.inbox_write({'token':token,'offset':3,'data':b(b'x')})
   done=worker.inbox_write({'token':token,'offset':6,'data':b(b'Pi'),'final':True,'name':'../../etc/passwd'})
   self.assertEqual(Path(done['path']).parent,inbox);self.assertEqual(Path(done['path']).read_bytes(),b'Hallo Pi')
   self.assertNotIn('/',Path(done['path']).name);self.assertNotIn('..',Path(done['path']).name.split('_')[0]+'x')
   again=worker.inbox_write({'token':secrets.token_hex(16),'offset':0,'data':b(b'2'),'final':True,'name':Path(done['path']).name})
   self.assertNotEqual(again['path'],done['path']);self.assertTrue(Path(again['path']).name.endswith(')'+Path(done['path']).suffix) or ' (2)' in Path(again['path']).name)
   with self.assertRaises(ValueError):worker.inbox_write({'token':'../x','offset':0,'data':''})
   t=secrets.token_hex(16);worker.inbox_write({'token':t,'offset':0,'data':b(b'abc')});worker.inbox_cancel({'token':t})
   self.assertFalse((inbox/('.'+t+'.part')).exists())
   self.assertEqual(sorted(p.name for p in inbox.iterdir() if p.name.startswith('.')),[])
  finally:worker.inbox_folder=original

 def test_device_info_shape(self):
  info=worker.device_info()
  self.assertEqual(sorted(info),['memoryBytes','model','storageBytes','storageKind']);self.assertGreater(info['storageBytes'],0)

 def test_screen_info_names_system_and_server(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'os-release').write_text('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_CODENAME=trixie\n')
   for pid,name in (('17','bash'),('42','x11vnc'),('self','x11vnc')):(root/pid).mkdir();(root/pid/'comm').write_text(name+'\n')
   info=worker.screen_info(root/'os-release',root)
   self.assertEqual(info['server'],'x11vnc');self.assertIn('Trixie',info['os']);self.assertTrue(info['host'])
   (root/'42'/'comm').write_text('wayvnc\n');self.assertEqual(worker.screen_info(root/'os-release',root)['server'],'WayVNC')
   (root/'42'/'comm').write_text('sshd\n');self.assertEqual(worker.screen_info(root/'nothing',root)['server'],'')

 def test_vnc_server_info_reads_versions_and_listen_scope(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'42').mkdir();(root/'42'/'comm').write_text('x11vnc\n');net=root/'net';net.mkdir()
   head='  sl  local_address rem_address   st\n'
   (net/'tcp').write_text(head+'   0: 0100007F:170C 00000000:0000 0A\n   1: 00000000:0016 00000000:0000 0A\n')
   (net/'tcp6').write_text(head+'   0: 00000000000000000000000001000000:170C 00000000000000000000000000000000:0000 0A\n')
   answers={'dpkg-query':'0.9.17-1','apt-cache':'x11vnc:\n  Installed: 0.9.17-1\n  Candidate: 0.9.17-2\n'}
   info=worker.vnc_server_info(root,net,lambda *c:answers[c[0]])
   self.assertEqual((info['server'],info['installed'],info['candidate'],info['update']),('x11vnc','0.9.17-1','0.9.17-2',True))
   self.assertEqual(info['addresses'],['127.0.0.1','::1']);self.assertTrue(info['localOnly'])
   (net/'tcp').write_text(head+'   0: 00000000:170C 00000000:0000 0A\n')
   self.assertFalse(worker.vnc_server_info(root,net,lambda *c:answers[c[0]])['localOnly'])
   answers['apt-cache']='  Candidate: 0.9.17-1\n';self.assertFalse(worker.vnc_server_info(root,net,lambda *c:answers[c[0]])['update'])

 @unittest.skipIf(os.name=='nt','POSIX receiver script')
 def test_mic_feed_passes_pcm_and_drops_backlog(self):
  with tempfile.TemporaryDirectory() as d:
   out=Path(d)/'out.raw';script=Path(d)/'empfang'
   script.write_text('#!/bin/sh\nif [ "$1" = --status ]; then echo bereit; exit 0; fi\ncat > '+str(out)+'\n');script.chmod(0o755)
   feed=worker.MicFeed(str(script));self.assertTrue(feed.status()['ready'])
   import base64;feed.open()
   for i in range(5):feed.send(base64.b64encode(bytes([i])*1920).decode())
   feed.close();data=out.read_bytes()
   self.assertEqual(len(data)%1920,0);self.assertTrue(data.endswith(bytes([4])*1920))
   with self.assertRaises(ValueError):feed.send('AA==')
  self.assertFalse(worker.MicFeed('/nonexistent/empfang').status()['ready'])

 def test_write_guard_without_command_permission(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);config={'root':d,'allowWrite':True,'allowCommands':False}
   for path in ('.git/config','.ssh/authorized_keys','.bashrc','sub/.profile','.config/autostart/x.desktop','.config/systemd/user/x.service'):
    with self.assertRaises(PermissionError,msg=path):worker.perform(config,{'op':'write','args':{'path':path,'content':'x'}})
   worker.perform(config,{'op':'write','args':{'path':'src/app.py','content':'print(1)'}});self.assertEqual((root/'src'/'app.py').read_text(),'print(1)')
   config['allowCommands']=True;worker.perform(config,{'op':'write','args':{'path':'.git/info/exclude','content':'x'}})

 @unittest.skipIf(not hasattr(os,'getuid'),'POSIX uids')
 def test_vnc_listener_owned_by_foreign_user_is_refused(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);net=root/'net';net.mkdir();sessions=root/'sessions';sessions.mkdir()
   head='  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
   def listen(uid):(net/'tcp').write_text(head+'   0: 0100007F:170C 00000000:0000 0A 00000000:00000000 00:00000000 00000000 %5d        0 1\n'%uid)
   listen(os.getuid());worker.vnc_listener_check(5900,net,sessions)
   listen(0);worker.vnc_listener_check(5900,net,sessions)
   listen(4242)
   with self.assertRaises(PermissionError):worker.vnc_listener_check(5900,net,sessions)
   (sessions/'c2').write_text('UID=4242\nTYPE=x11\nSTATE=active\n');worker.vnc_listener_check(5900,net,sessions)
   (net/'tcp').write_text(head);worker.vnc_listener_check(5900,net,sessions)

if __name__=='__main__':unittest.main()

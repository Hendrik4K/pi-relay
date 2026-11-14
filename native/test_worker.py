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

if __name__=='__main__':unittest.main()

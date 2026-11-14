"""Integration checks, executed on the Pi through the existing authenticated MCP.

The runner injects WORKER_CODE. No extra SSH connection, install or service.
"""
import base64, json, os, queue, subprocess, sys, tempfile, threading, time

def check_broker(code):
    proc = subprocess.Popen([sys.executable, '-u', '-c', code], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    messages = queue.Queue()
    def read():
        for line in proc.stdout: messages.put(json.loads(line))
    threading.Thread(target=read, daemon=True).start()
    pending, events, counter = {}, [], 0
    def request(op, args=None, config=None):
        nonlocal counter
        counter += 1
        proc.stdin.write(json.dumps(dict(id=counter, op=op, args=args or {}, config=config))+'\n')
        proc.stdin.flush()
        return counter
    def wait(number, timeout=8):
        deadline = time.monotonic()+timeout
        while number not in pending:
            item=messages.get(timeout=max(.05, deadline-time.monotonic()))
            if 'event' in item: events.append(item)
            else: pending[item['id']]=item
        return pending.pop(number)
    def output_until(fragment):
        deadline=time.monotonic()+8
        while True:
            text=''.join(base64.b64decode(x['data']).decode('utf-8','replace') for x in events if x.get('event')=='terminal_output')
            if fragment in text: return text
            item=messages.get(timeout=max(.05,deadline-time.monotonic()))
            if 'event' in item: events.append(item)
            else: pending[item['id']]=item
    checks=[]
    try:
        assert messages.get(timeout=5)['protocol']==2
        with tempfile.TemporaryDirectory(prefix='pi-relay-check-') as root:
            config=dict(root=root,allowCommands=False,allowWrite=False)
            denied=wait(request('write',dict(path='denied.txt',content='no'),config))
            assert not denied['ok'] and not os.path.exists(root+'/denied.txt')
            assert not wait(request('run',dict(command='echo denied'),config))['ok']
            assert wait(request('list',{},config))['result']==[]
            checks.append('per-agent permissions, scoped files, errors preserve channel')
            config['allowCommands']=True
            running=request('run',dict(command='sleep 1; printf command_ok'),config)
            shell=wait(request('terminal_open',dict(cols=96,rows=28)))['result']
            again=wait(request('terminal_open',dict(cols=96,rows=28)))['result']
            assert shell['pid']==again['pid']
            assert wait(request('terminal_input',dict(data=base64.b64encode(b"tty; stty size; printf '\\137\\137PTY_OK\\137\\137\\n'\n").decode())))['ok']
            text=output_until('__PTY_OK__')
            assert '/dev/pts/' in text and '28 96' in text
            assert wait(running)['result']['stdout']=='command_ok'
            checks.append('real interactive PTY, size, same shell, concurrent agent command')
            channel=wait(request('tcp_open'))['result']['channel']
            deadline=time.monotonic()+8
            while not any(x.get('event')=='tcp_data' and x.get('channel')==channel for x in events):
                item=messages.get(timeout=max(.05,deadline-time.monotonic()))
                if 'event' in item: events.append(item)
                else: pending[item['id']]=item
            banner=base64.b64decode(next(x['data'] for x in events if x.get('event')=='tcp_data' and x.get('channel')==channel))
            assert banner.startswith(b'RFB ')
            assert wait(request('tcp_close',dict(channel=channel)))['ok']
            checks.append('Pi loopback VNC endpoint returns RFB through same broker')
            wait(request('terminal_input',dict(data=base64.b64encode(b'exit\n').decode())))
            assert wait(request('list',{},config))['ok']
            checks.append('exiting shell preserves shared transport')
        return dict(ok=True,checks=checks)
    finally:
        proc.stdin.close()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill();proc.wait()

if __name__=='__main__':
    print(json.dumps(check_broker(WORKER_CODE)))

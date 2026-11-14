"""Test-only launcher: runs the real worker, but points its fixed VNC endpoint at a local mock."""
import runpy, socket, sys

port, worker = int(sys.argv[1]), sys.argv[2]
connect = socket.create_connection

def redirect(address, *args, **kwargs):
    if tuple(address) == ('127.0.0.1', 5900): address = ('127.0.0.1', port)
    return connect(address, *args, **kwargs)

socket.create_connection = redirect
sys.argv = [worker]
runpy.run_path(worker, run_name='__main__')

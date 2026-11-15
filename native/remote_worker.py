"""One SSH transport: scoped agent tools, an interactive PTY and loopback VNC."""
import base64, itertools, json, os, re, signal, socket, stat, subprocess, sys, threading, unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

def resolve_path(root, value):
    p = (root / str(value)).resolve()
    if not p.is_relative_to(root): raise PermissionError('Pfad liegt außerhalb des freigegebenen Projektordners')
    return p

# Key material, credentials and histories stay out of reach, even when the home folder is shared read-only.
SENSITIVE = ('.ssh', '.gnupg', '.config/gh', '.claude', '.claude.json', '.codex', '.local/share/keyrings',
             '.config/chromium', '.config/google-chrome', '.mozilla', '.pki', '.netrc', '.git-credentials',
             '.config/git/credentials', '.bash_history', '.zsh_history', '.python_history', '.lesshst',
             '.mysql_history', '.psql_history', '.sqlite_history', '.config/rclone', '.docker', '.aws', '.kube',
             '.npmrc', '.pypirc', '.password-store', '.Xauthority', '.vnc', '.config/tigervnc',
             '.config/wayvnc', '.cloudflared', '.ngrok2', '.config/ngrok')
OPEN_FLAGS = getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)

def check_root(config, root):
    if root == Path(root.anchor): raise PermissionError('Das Wurzelverzeichnis ist als Projektordner nicht erlaubt.')
    home = Path.home().resolve()
    if home.is_relative_to(root) and (config.get('allowWrite') or config.get('allowCommands')):
        raise PermissionError('Der Home-Ordner (oder ein Ordner darüber) ist mit Schreib- oder Befehlsrecht nicht erlaubt. '
                              'Bitte einen Unterordner als Projektordner wählen.')
    # Hidden folders under home hold start-up and app settings (autostart, labwc, systemd, site-packages):
    # writing there would run code at the next login, so it needs the command permission as well.
    if config.get('allowWrite') and not config.get('allowCommands') and root.is_relative_to(home) \
            and any(part.startswith('.') for part in root.relative_to(home).parts):
        raise PermissionError('Ein versteckter Ordner im Home-Ordner (z. B. ~/.config) ist mit Schreibrecht '
                              'nur zusammen mit „Befehle ausführen“ erlaubt.')

def guard_sensitive(p, root=None):
    home = Path.home().resolve()
    if any(p.is_relative_to(home / item) for item in SENSITIVE):
        raise PermissionError('Geschützter Bereich (Schlüssel und Zugangsdaten): kein Zugriff für Agenten.')
    # With home (or a folder above it) as the project folder, its hidden folders and files stay closed;
    # they are reachable only when the project folder itself lies inside one of them.
    if root is not None and home.is_relative_to(root) and p.is_relative_to(home) and p != home:
        top = p.relative_to(home).parts[0]
        if top.startswith('.') and not root.is_relative_to(home / top):
            raise PermissionError('Versteckte Dateien im Home-Ordner sind für Agenten gesperrt. '
                                  'Bei Bedarf den versteckten Ordner selbst als Projektordner wählen.')

# Names from the Pi may contain bytes that are not UTF-8 (shown as lone surrogates in Python).
def show_name(value): return str(value).encode('utf-8', 'surrogateescape').decode('utf-8', 'backslashreplace')

# Without the command permission writes stay plain project files: nothing hidden (Git, SSH, shell,
# desktop and app settings live in dot paths), nothing executable, no hard links to files elsewhere.
def guard_write(config, root, p):
    if config.get('allowCommands', False): return
    if any(part.startswith('.') for part in p.relative_to(root).parts):
        raise PermissionError('Versteckte Dateien und Ordner (z. B. .git, .bashrc) nur zusammen mit „Befehle ausführen“.')
    try: info = os.lstat(p)
    except FileNotFoundError: return
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o111 or info.st_nlink > 1:
        raise PermissionError('Ausführbare oder mehrfach verknüpfte Dateien nur zusammen mit „Befehle ausführen“.')

def perform(config, request):
    root = Path(config['root']).resolve()
    if not root.is_dir(): raise ValueError('Projektordner existiert nicht')
    check_root(config, root)
    op, args = request['op'], request.get('args', {})
    if op == 'list':
        p = resolve_path(root, args.get('path', '.'))
        guard_sensitive(p, root)
        return [{'name': show_name(x.name), 'directory': x.is_dir()} for x in sorted(p.iterdir(), key=lambda x: x.name)][:1000]
    if op == 'read':
        p = resolve_path(root, args['path'])
        guard_sensitive(p, root)
        # Regular files only, opened without blocking (a FIFO would hang) and read with a hard cap.
        with os.fdopen(os.open(p, os.O_RDONLY | OPEN_FLAGS | getattr(os, 'O_NONBLOCK', 0)), 'rb') as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise ValueError('Nur normale Dateien sind lesbar')
            data = f.read(1048577)
        if len(data) > 1048576: raise ValueError('Datei ist größer als 1 MiB')
        return data.decode('utf-8')
    if op == 'write':
        if not config.get('allowWrite', False): raise PermissionError('Dateiänderungen sind nicht freigegeben')
        p, content = resolve_path(root, args['path']), args['content']
        guard_sensitive(p, root)
        guard_write(config, root, p)
        data = content.encode('utf-8')
        if len(data) > 1048576: raise ValueError('Inhalt ist größer als 1 MiB')
        p.parent.mkdir(parents=True, exist_ok=True)
        # Opened without blocking and without truncating first: a FIFO or device is refused before anything happens.
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | OPEN_FLAGS | getattr(os, 'O_NONBLOCK', 0), 0o644)
        with os.fdopen(fd, 'wb') as f:
            if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError('Nur normale Dateien sind beschreibbar')
            os.ftruncate(fd, 0); f.write(data)
        return {'written': show_name(p)}
    if op == 'run':
        if not config.get('allowCommands', False): raise PermissionError('Befehle sind nicht freigegeben')
        return run_command(args['command'], root)
    raise ValueError('Unbekannte Operation')

RUN_SECONDS, RUN_CAP = 30, 262144

# stdin must not inherit the worker's protocol stream: a reading command would otherwise swallow requests
# meant for the terminal, VNC or agents. Output is read as it comes and kept only up to the cap (an endless
# `yes` must not fill the Pi's memory); after the time limit the whole process group is killed, and a
# leftover child that keeps the pipes open cannot hold the worker either.
def run_command(command, root, seconds=RUN_SECONDS, cap=RUN_CAP):
    proc = subprocess.Popen(command, cwd=root, shell=True, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=os.name != 'nt')
    if os.name == 'nt':  # local tests only; the worker itself runs on the Pi
        try: out, err = proc.communicate(timeout=seconds)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.communicate()
            raise TimeoutError('Befehl nach %d Sekunden beendet; keine automatische Wiederholung' % seconds)
        return {'exitCode': proc.returncode, 'stdout': out[:cap].decode('utf-8', 'replace'), 'stderr': err[:cap].decode('utf-8', 'replace')}
    import selectors, time
    deadline, timed_out = time.monotonic() + seconds, False
    kept = {proc.stdout: bytearray(), proc.stderr: bytearray()}
    with selectors.DefaultSelector() as sel:
        for stream in kept: os.set_blocking(stream.fileno(), False); sel.register(stream, selectors.EVENT_READ)
        while sel.get_map():
            left = deadline - time.monotonic()
            if left <= 0: timed_out = True; break
            for key, _ in sel.select(min(left, 0.5)):
                try: chunk = os.read(key.fd, 65536)
                except BlockingIOError: continue
                if not chunk: sel.unregister(key.fileobj); continue
                buffer = kept[key.fileobj]
                if len(buffer) < cap: buffer += chunk[:cap - len(buffer)]
    if not timed_out:
        try: proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired: timed_out = True
    if timed_out:
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        try: proc.wait(timeout=2)
        except subprocess.TimeoutExpired: pass
    for stream in kept: stream.close()
    if timed_out: raise TimeoutError('Befehl nach %d Sekunden beendet; keine automatische Wiederholung' % seconds)
    return {'exitCode': proc.returncode, 'stdout': bytes(kept[proc.stdout]).decode('utf-8', 'replace'),
            'stderr': bytes(kept[proc.stderr]).decode('utf-8', 'replace')}

# Files dropped on the viewer window land only on the Pi desktop, never at a caller-chosen path.
INBOX_LIMIT = 512 * 1024 * 1024

def inbox_folder():
    desktop = Path.home() / 'Desktop'
    return desktop if desktop.is_dir() else Path.home()

# Control, format (bidi, zero-width) and path characters are replaced; the name is cut by bytes (file systems
# allow 255) while the extension is kept.
def safe_name(value, limit=200):
    name = ''.join('_' if c in '/\\' or unicodedata.category(c) in ('Cc', 'Cf', 'Cs') else c for c in str(value))
    name = name.strip().lstrip('.')
    stem, dot, ext = name.rpartition('.')
    if not dot or len(ext) > 16: stem, ext = name, ''
    ext = ('.' + ext) if ext else ''
    room = limit - len(ext.encode('utf-8'))
    stem = stem.encode('utf-8')[:max(1, room)].decode('utf-8', 'ignore').rstrip()
    return (stem + ext) if stem else 'Datei' + ext

def inbox_write(args):
    token = str(args.get('token', ''))
    if not re.fullmatch(r'[0-9a-f]{32}', token): raise ValueError('Ungültige Übertragung')
    folder = inbox_folder()
    part = folder / ('.' + token + '.part')
    chunk = base64.b64decode(args.get('data', ''), validate=True)
    if len(chunk) > 1048576: raise ValueError('Datenblock zu groß')
    offset = int(args.get('offset', 0))
    # Private while it arrives, never through a planted link, and appended only to the same regular file.
    if offset == 0: fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL | OPEN_FLAGS, 0o600)
    else:
        try: fd = os.open(part, os.O_WRONLY | os.O_APPEND | OPEN_FLAGS)
        except FileNotFoundError: raise ValueError('Übertragung unterbrochen. Datei erneut ablegen.') from None
    with os.fdopen(fd, 'wb') as f:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size != offset:
            raise ValueError('Übertragung unterbrochen. Datei erneut ablegen.')
        if offset + len(chunk) > INBOX_LIMIT:
            f.close(); part.unlink(missing_ok=True); raise ValueError('Datei ist größer als 512 MiB')
        f.write(chunk)
    if not args.get('final'): return {'size': part.stat().st_size}
    target = folder / safe_name(args.get('name'))
    stem, suffix, n = target.stem, target.suffix, 2
    # A hard link never replaces a file that appeared in the meantime; the next free name is used instead.
    while True:
        try: os.link(part, target); part.unlink(); break
        except FileExistsError: target = folder / f'{stem} ({n}){suffix}'; n += 1
        except (OSError, NotImplementedError, AttributeError):  # file systems without hard links
            if target.exists(): target = folder / f'{stem} ({n}){suffix}'; n += 1; continue
            os.replace(part, target); break
    try: os.chmod(target, 0o644)
    except OSError: pass
    return {'path': show_name(target), 'size': target.stat().st_size}

def inbox_cancel(args):
    token = str(args.get('token', ''))
    if re.fullmatch(r'[0-9a-f]{32}', token): (inbox_folder() / ('.' + token + '.part')).unlink(missing_ok=True)
    return {}

# Read-only facts for the tray header: board model, RAM and the system drive.
def device_info():
    def read(path):
        try: return Path(path).read_text(errors='replace').replace(chr(0), '').strip()
        except OSError: return ''
    model = read('/proc/device-tree/model')
    mem = 0
    for line in read('/proc/meminfo').splitlines():
        if line.startswith('MemTotal:'): mem = int(line.split()[1]) * 1024
    import shutil
    total = shutil.disk_usage('/').total
    source = ''
    for line in read('/proc/mounts').splitlines():
        parts = line.split()
        if len(parts) > 1 and parts[1] == '/': source = parts[0]
    name = os.path.basename(os.path.realpath(source)) if source.startswith('/dev/') else source
    kind = 'NVMe' if name.startswith('nvme') else 'SD' if name.startswith('mmcblk') else 'USB' if name.startswith('sd') else ''
    return {'model': model, 'memoryBytes': mem, 'storageBytes': total, 'storageKind': kind}

# Header facts for the viewer window: system, Pi name and which VNC server answers on 5900.
def screen_info(os_release='/etc/os-release', proc='/proc'):
    fields = {}
    try:
        for line in Path(os_release).read_text(errors='replace').splitlines():
            key, _, value = line.partition('=')
            if value: fields[key] = value.strip().strip('"')
    except OSError: pass
    distro = 'Raspberry Pi OS' if Path('/etc/rpi-issue').exists() else fields.get('NAME', '').split(' GNU/')[0]
    system = (distro + ' ' + fields.get('VERSION_CODENAME', '').capitalize()).strip() or fields.get('PRETTY_NAME', '')
    return {'os': system, 'host': socket.gethostname(), 'server': vnc_server_name(proc)}

# Process name (/proc/*/comm) -> name shown in the app and the Debian package for the update check.
# TigerVNC's x0vncserver wrapper starts X0tigervnc; Xtigervnc (Xvnc) is its standalone server.
VNC_SERVERS = {'x11vnc': ('x11vnc', 'x11vnc'), 'wayvnc': ('WayVNC', 'wayvnc'),
               'X0tigervnc': ('TigerVNC', 'tigervnc-scraping-server'), 'x0vncserver': ('TigerVNC', 'tigervnc-scraping-server'),
               'Xtigervnc': ('TigerVNC', 'tigervnc-standalone-server'), 'Xvnc': ('TigerVNC', 'tigervnc-standalone-server')}

def socket_rows(net):
    rows, readable = [], False
    for table in ('tcp', 'tcp6'):
        try: lines = Path(net, table).read_text().splitlines()[1:]
        except OSError: continue
        readable = True
        rows += [parts for parts in (line.split() for line in lines) if len(parts) >= 8]
    if not readable: raise PermissionError('Besitzer des VNC-Ports nicht prüfbar (/proc/net) – Verbindung abgelehnt.')
    return rows

def port_of(address): return int(address.rsplit(':', 1)[1], 16)

def refuse_foreign(port, owners):
    foreign = sorted(set(owners) - {os.getuid(), 0})
    if foreign:
        raise PermissionError('VNC-Port %d gehört einem fremden Benutzer (uid %s) – Verbindung aus Sicherheitsgründen abgelehnt.' % (port, ', '.join(map(str, foreign))))

# Port 5900 is unprivileged: another account on the Pi could bind it before the real VNC server and
# would then receive keystrokes and the shared clipboard. Only this user's or root's listener counts.
def vnc_listener_check(port=5900, net='/proc/net'):
    if not hasattr(os, 'getuid'): return
    refuse_foreign(port, [int(r[7]) for r in socket_rows(net) if r[3] == '0A' and port_of(r[1]) == port])

# After connecting, the server end of exactly this connection is checked, so a listener swapped in
# after the first check cannot slip through: its row has the server port locally and ours remotely.
def vnc_peer_check(local_port, server_port=5900, net='/proc/net'):
    if not hasattr(os, 'getuid'): return
    owners = [int(r[7]) for r in socket_rows(net) if port_of(r[1]) == server_port and port_of(r[2]) == local_port]
    if not owners: raise PermissionError('Gegenstelle des VNC-Ports nicht gefunden – Verbindung abgelehnt.')
    refuse_foreign(server_port, owners)

def vnc_server(proc='/proc'):
    try: entries = list(Path(proc).iterdir())
    except OSError: entries = []
    own = (os.getuid(), 0) if hasattr(os, 'getuid') else None
    for entry in entries:
        if not entry.name.isdigit(): continue
        try:
            # Only this user's or root's processes name the server; another account cannot fake the badge.
            if own is not None and entry.stat().st_uid not in own: continue
            name = (entry / 'comm').read_text().strip()
        except OSError: continue
        if name in VNC_SERVERS: return VNC_SERVERS[name]
    return '', ''

def vnc_server_name(proc='/proc'): return vnc_server(proc)[0]

def listen_addresses(port=5900, net='/proc/net'):
    import ipaddress
    found = []
    for table in ('tcp', 'tcp6'):
        try: lines = Path(net, table).read_text().splitlines()[1:]
        except OSError: continue
        for line in lines:
            parts = line.split()
            if len(parts) < 4 or parts[3] != '0A': continue
            address, _, hexport = parts[1].partition(':')
            if int(hexport, 16) != port: continue
            raw = bytes.fromhex(address)
            raw = b''.join(raw[i:i + 4][::-1] for i in range(0, len(raw), 4))
            found.append(str(ipaddress.ip_address(raw)))
    return found

def is_loopback(address):
    import ipaddress
    ip = ipaddress.ip_address(address)
    return ip.is_loopback or bool(getattr(ip, 'ipv4_mapped', None) and ip.ipv4_mapped.is_loopback)

# Read-only facts for the "VNC-Server auf dem Pi" card: which server runs, its package version,
# what apt's last package lists offer, and whether it listens on loopback only. Never installs.
def vnc_server_info(proc='/proc', net='/proc/net', query=None):
    def run(*command):
        try: return subprocess.run(command, capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL).stdout
        except (OSError, subprocess.SubprocessError): return ''
    query = query or run
    server, package = vnc_server(proc)
    installed = candidate = ''
    if package:
        installed = query('dpkg-query', '-W', '-f=${Version}', package).strip()
        for line in query('apt-cache', 'policy', package).splitlines():
            if line.strip().startswith('Candidate:'): candidate = line.split(':', 1)[1].strip()
        if candidate == '(none)': candidate = ''
    addresses = listen_addresses(5900, net)
    return {'server': server, 'package': package, 'installed': installed, 'candidate': candidate,
            'update': bool(installed and candidate and candidate != installed),
            'addresses': addresses, 'localOnly': bool(addresses) and all(is_loopback(a) for a in addresses)}

# Windows microphone into the Pi: raw PCM (s16le, 48 kHz, mono) is fed to the user's fixed
# receiver ~/.local/bin/windows-mikro-empfang, which publishes it as a PipeWire source. Only this
# program is started; chunks queue briefly and the oldest are dropped so latency stays low.
MIC_RECEIVER = '~/.local/bin/windows-mikro-empfang'

class MicFeed:
    MAX_QUEUED = 8  # 8 x 20 ms

    def __init__(self, receiver=MIC_RECEIVER):
        self.receiver = os.path.expanduser(receiver)
        self.process, self.queue, self.dropped = None, None, 0

    def status(self):
        if not os.access(self.receiver, os.X_OK): return {'ready': False, 'message': 'Empfänger fehlt auf dem Pi: ' + MIC_RECEIVER}
        try: done = subprocess.run([self.receiver, '--status'], capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as exc: return {'ready': False, 'message': str(exc)}
        text = (done.stdout + done.stderr).strip()
        return {'ready': done.returncode == 0 and 'bereit' in text, 'message': text[:300]}

    def open(self):
        import queue
        self.close()
        process = subprocess.Popen([self.receiver], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        feed = queue.Queue()
        self.process, self.queue, self.dropped = process, feed, 0
        def write():
            while True:
                chunk = feed.get()
                if chunk is None: break
                try: process.stdin.write(chunk); process.stdin.flush()
                except (OSError, ValueError): break
            try: process.stdin.close()
            except OSError: pass
        threading.Thread(target=write, daemon=True).start()
        return {}

    def send(self, data):
        if not self.process or self.process.poll() is not None: raise ValueError('Mikrofon-Empfänger läuft nicht')
        chunk = base64.b64decode(data)
        if len(chunk) > 65536: raise ValueError('Audioblock zu groß')
        while self.queue.qsize() >= self.MAX_QUEUED:
            try: self.queue.get_nowait(); self.dropped += 1
            except Exception: break
        self.queue.put(chunk)
        return {'dropped': self.dropped}

    def close(self):
        process, feed = self.process, self.queue
        self.process = self.queue = None
        if feed: feed.put(None)
        if process:
            try: process.wait(timeout=2)
            except subprocess.TimeoutExpired: process.kill()
        return {}

class Broker:
    def __init__(self, emit, emit_data):
        self.emit, self.emit_data, self.terminal, self.master = emit, emit_data, None, None
        self.sockets, self.channels = {}, itertools.count(1)  # tcp_open runs in a pool: no shared += here
        self.typing = None
        self.mic = MicFeed()

    def resize(self, args):
        import fcntl, struct, termios
        if self.master is not None:
            rows = max(2, min(300, int(args.get('rows', 30))))
            cols = max(10, min(500, int(args.get('cols', 100))))
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def open_terminal(self, args):
        if self.terminal and self.terminal.poll() is None:
            self.resize(args)
            return {'running': True, 'pid': self.terminal.pid}
        import pty
        master, slave = pty.openpty()
        shell = os.environ.get('SHELL') or '/bin/bash'
        # Establish a controlling terminal in the exec'd child: no preexec_fn
        # in a multithreaded parent, and shell job control remains available.
        child = 'import os,fcntl,termios;os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0);os.execv(os.environ["SHELL"],[os.environ["SHELL"],"-l"])'
        env = dict(os.environ, TERM='xterm-256color', SHELL=shell)
        # -I: started in the home folder, so a planted ~/termios.py or user site-packages must not load.
        try:
            process = subprocess.Popen([sys.executable, '-I', '-c', child], stdin=slave, stdout=slave,
                                       stderr=slave, cwd=Path.home(), env=env, close_fds=True)
        finally: os.close(slave)
        self.terminal, self.master = process, master
        # Typing goes through its own writer: a program that stops reading fills the PTY, and a blocking write
        # there must not stall the request reader (VNC input, microphone, agents).
        import queue
        typing = queue.Queue(maxsize=256)
        self.typing = typing
        def write_terminal():
            while True:
                chunk = typing.get()
                if chunk is None: break
                try:
                    while chunk: chunk = chunk[os.write(master, chunk):]
                except OSError: break
        threading.Thread(target=write_terminal, daemon=True).start()
        self.resize(args)
        def read_terminal():
            try:
                while True:
                    chunk = os.read(master, 16384)
                    if not chunk: break
                    self.emit({'event': 'terminal_output', 'data': base64.b64encode(chunk).decode()})
            except OSError: pass
            finally:
                process.wait()
                if self.master == master: self.master = None
                if self.typing is typing: self.typing = None
                try: typing.put_nowait(None)
                except Exception: pass
                os.close(master)
                self.emit({'event': 'terminal_exit', 'exitCode': process.returncode})
        threading.Thread(target=read_terminal, daemon=True).start()
        return {'running': True, 'pid': process.pid}

    def handle(self, request):
        op, args = request['op'], request.get('args', {})
        if op == 'terminal_open': return self.open_terminal(args)
        if op == 'terminal_resize':
            self.resize(args)
            return {}
        if op == 'terminal_input':
            typing = self.typing
            if self.master is None or typing is None: raise ValueError('Terminal ist beendet. Erneut öffnen.')
            chunk = base64.b64decode(args['data'], validate=True)
            if len(chunk) > 65536: raise ValueError('Eingabe zu groß')
            try: typing.put_nowait(chunk)
            except Exception: raise ValueError('Das Programm im Terminal nimmt gerade keine Eingabe an.') from None
            return {}
        if op == 'tcp_open':
            # Only the Pi's own VNC endpoint; never an arbitrary network proxy.
            vnc_listener_check()
            # Nothing listening yet (desktop still logging in): a fixed message the app can wait on.
            try: sock = socket.create_connection(('127.0.0.1', 5900), timeout=8)
            except ConnectionRefusedError: raise ConnectionError('VNC-Server auf dem Pi nicht aktiv (127.0.0.1:5900)') from None
            try: vnc_peer_check(sock.getsockname()[1], sock.getpeername()[1])
            except Exception: sock.close(); raise
            # Small input packets (pointer, keys, fence replies) leave at once instead of waiting for an ACK.
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.settimeout(1)
            channel = next(self.channels)
            self.sockets[channel] = sock
            def read_socket():
                try:
                    while self.sockets.get(channel) is sock:
                        try: chunk = sock.recv(262144)
                        except socket.timeout: continue
                        if not chunk: break
                        self.emit_data(channel, chunk)
                except OSError: pass
                finally:
                    self.sockets.pop(channel, None)
                    sock.close()
                    self.emit({'event': 'tcp_closed', 'channel': channel})
            return {'channel': channel, '_reader': read_socket}
        if op == 'tcp_close':
            sock = self.sockets.pop(int(args['channel']), None)
            if sock: sock.close()
            return {}
        if op == 'device_info': return device_info()
        if op == 'screen_info': return screen_info()
        if op == 'vnc_server_info': return vnc_server_info()
        if op == 'audio_status': return self.mic.status()
        if op == 'audio_open': return self.mic.open()
        if op == 'audio_send': return self.mic.send(args.get('data', ''))
        if op == 'audio_close': return self.mic.close()
        if op == 'inbox_write': return inbox_write(args)
        if op == 'inbox_cancel': return inbox_cancel(args)
        if op in ('list', 'read', 'write', 'run'): return perform(request['config'], request)
        raise ValueError('Unbekannte Operation')

    # VNC input is a notification: written in arrival order by the request reader and never
    # answered, so the next input never waits for a round trip. A failed write ends the stream.
    def send_input(self, args):
        channel = int(args.get('channel', 0))
        sock = self.sockets.get(channel)
        if sock is None: return
        try:
            chunk = base64.b64decode(args.get('data', ''), validate=True)
            if len(chunk) > 65536: raise ValueError('Datenblock zu groß')
            sock.sendall(chunk)
        except (OSError, ValueError) as exc:
            if self.sockets.pop(channel, None) is sock:
                self.emit({'event': 'tcp_closed', 'channel': channel, 'error': 'Eingabe an den VNC-Server fehlgeschlagen: ' + str(exc)})
            sock.close()

    def close(self):
        self.mic.close()
        if self.typing:
            try: self.typing.put_nowait(None)
            except Exception: pass
        for sock in list(self.sockets.values()): sock.close()
        self.sockets.clear()
        if self.terminal and self.terminal.poll() is None:
            try: os.killpg(self.terminal.pid, signal.SIGHUP)
            except ProcessLookupError: pass

# Protocol 3: JSON lines both ways. Screen data from the Pi skips base64 and JSON: a header line
# names channel and size, the raw bytes follow directly.
REQUEST_LIMIT, REPLY_LIMIT = 2097152 + 65536, 2500000  # the host reads lines up to 3,000,000 bytes

def encode(value):
    # UTF-8 keeps non-Latin text compact; a name with non-UTF-8 bytes (lone surrogate) becomes U+FFFD.
    return json.dumps(value, ensure_ascii=False).encode('utf-8', 'replace') + b'\n'

def main():
    lock = threading.Lock()
    out = open(sys.stdout.fileno(), 'wb', closefd=False)
    def write(*parts):
        with lock:
            for part in parts: out.write(part)
            out.flush()
    def emit(value): write(encode(value))
    def emit_data(channel, chunk): write(b'{"event":"tcp_data","channel":%d,"size":%d}\n' % (channel, len(chunk)), chunk)
    # Agent work (commands may run for 30 s) and short control steps (VNC connect, mic, Pi facts, file drop)
    # get separate pools, so busy agents never hold up the viewer.
    broker, agents, control = Broker(emit, emit_data), ThreadPoolExecutor(max_workers=4), ThreadPoolExecutor(max_workers=3)
    emit({'ready': True, 'home': str(Path.home()), 'protocol': 3})
    def respond(request):
        try:
            result = broker.handle(request)
            reader = result.pop('_reader', None) if isinstance(result, dict) else None
            line = encode({'id': request['id'], 'ok': True, 'result': result})
            # One oversized answer fails only its own request instead of ending the whole connection.
            if len(line) > REPLY_LIMIT: raise ValueError('Antwort zu groß (über 2,5 MB). Bitte kleinere Teile anfragen.')
            write(line)
            if reader: threading.Thread(target=reader, daemon=True).start()
        except Exception as exc: emit({'id': request.get('id'), 'ok': False, 'error': str(exc)[:2000]})
    try:
        for line in sys.stdin:
            try: request = json.loads(line)
            except ValueError: continue
            if not isinstance(request, dict): continue
            if len(line) > REQUEST_LIMIT:
                emit({'id': request.get('id'), 'ok': False, 'error': 'Anfrage zu groß'}); continue
            op = request.get('op')
            if op == 'tcp_send': broker.send_input(request.get('args', {}))
            elif op in ('run', 'list', 'read'): agents.submit(respond, request)
            elif op in ('tcp_open', 'audio_status', 'vnc_server_info', 'device_info', 'screen_info'): control.submit(respond, request)
            else: respond(request)
    finally:
        broker.close()
        agents.shutdown(wait=False, cancel_futures=True)
        control.shutdown(wait=False, cancel_futures=True)
        os._exit(0)

if __name__ == '__main__': main()

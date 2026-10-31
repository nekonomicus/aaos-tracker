#!/usr/bin/env python3
"""FMH MUSTS · local server. Serves the app and keeps state.json in ./userdata next to this file.
Standard library only.    python3 server.py [--port 8766] [--no-open]"""
import argparse
import json
import os
import shutil
import sys
import threading
import time
import webbrowser
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, 'userdata')
STATE = os.path.join(DATA, 'state.json')
OLD_STATE = os.path.join(os.path.dirname(ROOT), 'drill', 'userdata', 'state.json')  # the previous drill: its key is reused once
LOCK = threading.Lock()
MAX_BODY = 32 * 1024 * 1024


def read_json(path):
    try:
        with open(path, 'rb') as handle:
            return json.loads(handle.read().decode('utf-8'))
    except (OSError, ValueError):
        return None


def atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp-{os.getpid()}'
    with open(tmp, 'wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def daily_backup():
    if not os.path.exists(STATE):
        return
    folder = os.path.join(DATA, 'backups')
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, f'state-{date.today().isoformat()}.json')
    if os.path.exists(target):
        return
    shutil.copyfile(STATE, target)
    for old in sorted(name for name in os.listdir(folder) if name.startswith('state-'))[:-30]:
        os.remove(os.path.join(folder, old))


def load_state():
    state = read_json(STATE) or {}
    settings = state.get('settings') or {}
    if not settings.get('apiKey'):
        old = (read_json(OLD_STATE) or {}).get('settings') or {}
        if old.get('apiKey'):
            settings['apiKey'] = old['apiKey']
            settings['importedKey'] = True
            state['settings'] = settings
    return state


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if self.command in ('PUT', 'POST') or (args and str(args[-1]).startswith(('4', '5'))):
            sys.stderr.write('%s  %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        if status >= 400:
            self.close_connection = True
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/ping':
            return self.send_json({'ok': True, 'dataDir': DATA})
        if path == '/api/state':
            with LOCK:
                return self.send_json(load_state())
        if path.startswith('/userdata/'):
            return self.send_json({'error': 'not served'}, 403)
        if path == '/':
            self.path = '/index.html'
        return super().do_GET()

    def do_PUT(self):
        path = urlsplit(self.path).path
        if path != '/api/state':
            return self.send_json({'error': 'not found'}, 404)
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length > MAX_BODY:
                raise ValueError('too large')
            body = self.rfile.read(length)
            json.loads(body)
            with LOCK:
                daily_backup()
                atomic_write(STATE, body)
            return self.send_json({'ok': True})
        except ValueError as error:
            return self.send_json({'error': str(error)}, 400)


def main():
    parser = argparse.ArgumentParser(description='FMH MUSTS local server')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    os.makedirs(DATA, exist_ok=True)
    url = f'http://127.0.0.1:{args.port}/'
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError as error:
        if getattr(error, 'errno', None) in (48, 98):
            print(f'FMH MUSTS läuft bereits · {url}')
            if not args.no_open:
                webbrowser.open(url)
            return
        raise
    print(f'FMH MUSTS  ·  {url}\nprogress is saved in {DATA}\npress Ctrl+C to stop')
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')


if __name__ == '__main__':
    main()

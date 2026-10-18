#!/usr/bin/env python3
"""FMH DRILL · local server.

Serves the app and stores every bit of progress as plain JSON files in ./userdata
next to this script. Standard library only — no installs.

    python3 server.py            # starts on http://127.0.0.1:8765 and opens the browser
    python3 server.py --port 9000 --no-open

Layout of userdata/
    state.json            settings, drill progress, case grades, daily log
    backups/              one copy of state.json per day (last 30 kept)
    bank.json             drill items generated from your materials
    materials/<id>.json   text extracted from dumped PDFs / PPTX / DOCX
    files/                the original uploaded files
    sessions/<id>.json    full exam transcripts with feedback
"""
import argparse
import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, 'userdata')
LOCK = threading.Lock()
SAFE_ID = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
MAX_JSON = 64 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024 * 1024


def ensure_dirs():
    for sub in ('', 'backups', 'materials', 'files', 'sessions'):
        os.makedirs(os.path.join(DATA, sub), exist_ok=True)


def atomic_write(path, data: bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp-{os.getpid()}-{threading.get_ident()}'
    with open(tmp, 'wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def daily_backup(path):
    """Keep one copy of state.json per calendar day, at most 30."""
    if not os.path.exists(path):
        return
    os.makedirs(os.path.join(DATA, 'backups'), exist_ok=True)
    stamp = date.today().isoformat()
    target = os.path.join(DATA, 'backups', f'state-{stamp}.json')
    if os.path.exists(target):
        return
    shutil.copyfile(path, target)
    backups = sorted(name for name in os.listdir(os.path.join(DATA, 'backups')) if name.startswith('state-'))
    for old in backups[:-30]:
        os.remove(os.path.join(DATA, 'backups', old))


def read_json(path):
    if not os.path.exists(path):
        return None
    with open(path, 'rb') as handle:
        return json.loads(handle.read().decode('utf-8'))


def list_dir_json(folder):
    items = []
    if not os.path.isdir(folder):
        return items
    for name in sorted(os.listdir(folder)):
        if not name.endswith('.json'):
            continue
        try:
            items.append(read_json(os.path.join(folder, name)))
        except (OSError, ValueError):
            continue
    return items


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # surface the 302 instead of following it with the token attached
        return None


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # quieter log: only API writes and errors
        if self.command in ('PUT', 'POST', 'DELETE') or (args and str(args[-1]).startswith(('4', '5'))):
            sys.stderr.write('%s  %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    # ---- helpers -------------------------------------------------------
    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        if status >= 400:
            self.close_connection = True  # an unread request body must not be parsed as the next request
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit):
        length = int(self.headers.get('Content-Length') or 0)
        if length > limit:
            raise ValueError('too large')
        return self.rfile.read(length) if length else b''

    def route(self):
        parts = urlsplit(self.path)
        return parts.path, parse_qs(parts.query)

    def end_headers(self):
        if self.path.startswith('/api/') or self.path.endswith(('.js', '.css', '.html')):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    # ---- GET -------------------------------------------------------------
    def do_GET(self):
        path, query = self.route()
        if not path.startswith('/api/'):
            if path == '/':
                self.path = '/index.html'
            return super().do_GET()
        try:
            with LOCK:
                if path == '/api/ping':
                    return self.send_json({'ok': True, 'dataDir': DATA})
                if path == '/api/state':
                    return self.send_json(read_json(os.path.join(DATA, 'state.json')) or {})
                if path == '/api/bank':
                    return self.send_json(read_json(os.path.join(DATA, 'bank.json')) or [])
                if path == '/api/materials':
                    items = list_dir_json(os.path.join(DATA, 'materials'))
                    summary = [{key: value for key, value in item.items() if key != 'text'} for item in items if item]
                    return self.send_json(summary)
                match = re.match(r'^/api/materials/([A-Za-z0-9_-]+)$', path)
                if match:
                    item = read_json(os.path.join(DATA, 'materials', match.group(1) + '.json'))
                    return self.send_json(item or {}, 200 if item else 404)
                if path == '/api/sessions':
                    items = list_dir_json(os.path.join(DATA, 'sessions'))
                    summary = [{key: value for key, value in item.items() if key not in ('messages', 'dossier')} for item in items if item]
                    return self.send_json(summary)
                match = re.match(r'^/api/sessions/([A-Za-z0-9_-]+)$', path)
                if match:
                    item = read_json(os.path.join(DATA, 'sessions', match.group(1) + '.json'))
                    return self.send_json(item or {}, 200 if item else 404)
                if path == '/api/files':
                    folder = os.path.join(DATA, 'files')
                    return self.send_json(sorted(os.listdir(folder)) if os.path.isdir(folder) else [])
            if path == '/api/fetch':
                return self.fetch_image((query.get('url') or [''])[0])
            if path == '/api/gh':
                return self.github(query)
            self.send_json({'error': 'not found'}, 404)
        except Exception as error:  # noqa: BLE001 - report anything to the UI
            self.send_json({'error': str(error)}, 500)

    def fetch_image(self, url):
        """Download a remote image for the browser (browsers may not fetch cross-origin images themselves)."""
        if not re.match(r'^https?://', url):
            return self.send_json({'error': 'bad url'}, 400)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (FMH DRILL; local study tool)', 'Accept': 'image/*,*/*;q=0.8'})
            with urllib.request.urlopen(req, timeout=20) as resp:
                ctype = resp.headers.get('Content-Type', 'application/octet-stream').split(';')[0].strip()
                data = resp.read(15 * 1024 * 1024 + 1)
            if len(data) > 15 * 1024 * 1024:
                return self.send_json({'error': 'too large'}, 413)
            if not ctype.startswith('image/'):
                if data[:3] == b'\xff\xd8\xff':
                    ctype = 'image/jpeg'
                elif data[:8] == b'\x89PNG\r\n\x1a\n':
                    ctype = 'image/png'
                else:
                    return self.send_json({'error': f'not an image ({ctype})'}, 415)
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'private, max-age=86400')
            self.end_headers()
            self.wfile.write(data)
        except Exception as error:  # noqa: BLE001
            self.send_json({'error': str(error)}, 502)

    def github(self, query):
        """Read-only proxy to the GitHub API for the FMH case-matrix attachments (private repo, token
        from the browser's settings in the X-Github-Token header; never stored or logged here).
        ?path=/releases/...  -> JSON passthrough          ?asset=<id> -> the asset's bytes"""
        token = self.headers.get('X-Github-Token', '').strip()
        repo = (query.get('repo') or [''])[0]
        if not token or not re.match(r'^[\w.-]+/[\w.-]+$', repo):
            return self.send_json({'error': 'token or repo missing'}, 400)
        headers = {'Authorization': f'Bearer {token}', 'User-Agent': 'FMH-DRILL', 'X-GitHub-Api-Version': '2022-11-28'}
        asset = (query.get('asset') or [''])[0]
        api_path = (query.get('path') or [''])[0]
        try:
            if asset:
                if not asset.isdigit():
                    return self.send_json({'error': 'bad asset id'}, 400)
                req = urllib.request.Request(f'https://api.github.com/repos/{repo}/releases/assets/{asset}', headers={**headers, 'Accept': 'application/octet-stream'})
                opener = urllib.request.build_opener(NoRedirect)
                location = None
                try:
                    with opener.open(req, timeout=30) as resp:  # GitHub answers 302 to a signed URL; some setups stream directly
                        data = resp.read(MAX_FILE)
                        ctype = resp.headers.get('Content-Type', 'application/octet-stream')
                except urllib.error.HTTPError as error:
                    if error.code in (301, 302, 303, 307, 308):
                        location = error.headers.get('Location')
                    else:
                        raise
                if location:  # the signed URL must be fetched WITHOUT the token
                    with urllib.request.urlopen(urllib.request.Request(location, headers={'User-Agent': 'FMH-DRILL'}), timeout=120) as resp:
                        data = resp.read(MAX_FILE)
                        ctype = resp.headers.get('Content-Type', 'application/octet-stream')
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(data)
                return None
            if not api_path.startswith('/') or '..' in api_path:
                return self.send_json({'error': 'bad path'}, 400)
            req = urllib.request.Request(f'https://api.github.com/repos/{repo}{api_path}', headers={**headers, 'Accept': 'application/vnd.github+json'})
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read(MAX_JSON)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return None
        except urllib.error.HTTPError as error:
            hint = {401: 'Token ungültig', 403: 'Token hat keinen Zugriff auf dieses Repo', 404: 'Repo oder Release "attachments" nicht gefunden'}.get(error.code, '')
            return self.send_json({'error': f'GitHub {error.code}{" · " + hint if hint else ""}'}, 502)
        except Exception as error:  # noqa: BLE001
            return self.send_json({'error': str(error)}, 502)

    # ---- PUT / POST ------------------------------------------------------
    def do_PUT(self):
        path, query = self.route()
        try:
            if path == '/api/state':
                body = self.read_body(MAX_JSON)
                json.loads(body)  # validate before touching the disk
                with LOCK:
                    target = os.path.join(DATA, 'state.json')
                    daily_backup(target)
                    atomic_write(target, body)
                return self.send_json({'ok': True})
            if path == '/api/bank':
                body = self.read_body(MAX_JSON)
                json.loads(body)
                with LOCK:
                    atomic_write(os.path.join(DATA, 'bank.json'), body)
                return self.send_json({'ok': True})
            for kind in ('materials', 'sessions'):
                match = re.match(r'^/api/%s/([A-Za-z0-9_-]+)$' % kind, path)
                if match:
                    body = self.read_body(MAX_JSON)
                    json.loads(body)
                    with LOCK:
                        atomic_write(os.path.join(DATA, kind, match.group(1) + '.json'), body)
                    return self.send_json({'ok': True})
            self.send_json({'error': 'not found'}, 404)
        except ValueError as error:
            self.send_json({'error': str(error)}, 400)
        except Exception as error:  # noqa: BLE001
            self.send_json({'error': str(error)}, 500)

    def do_POST(self):
        path, query = self.route()
        try:
            if path == '/api/files':
                name = unquote((query.get('name') or ['file'])[0])
                name = re.sub(r'[^A-Za-z0-9._ -]+', '-', name).strip(' .-') or 'file'
                length = int(self.headers.get('Content-Length') or 0)
                if length > MAX_FILE:
                    raise ValueError('file too large')
                os.makedirs(os.path.join(DATA, 'files'), exist_ok=True)
                target = os.path.join(DATA, 'files', f'{int(time.time())}-{name}'[:150])
                remaining = length
                with open(target, 'wb') as handle:
                    while remaining > 0:
                        chunk = self.rfile.read(min(1 << 20, remaining))
                        if not chunk:
                            break
                        handle.write(chunk)
                        remaining -= len(chunk)
                return self.send_json({'ok': True, 'stored': os.path.basename(target)})
            self.send_json({'error': 'not found'}, 404)
        except ValueError as error:
            self.send_json({'error': str(error)}, 400)
        except Exception as error:  # noqa: BLE001
            self.send_json({'error': str(error)}, 500)

    def do_DELETE(self):
        path, query = self.route()
        try:
            for kind in ('materials', 'sessions'):
                match = re.match(r'^/api/%s/([A-Za-z0-9_-]+)$' % kind, path)
                if match:
                    target = os.path.join(DATA, kind, match.group(1) + '.json')
                    with LOCK:
                        if os.path.exists(target):
                            os.remove(target)
                    return self.send_json({'ok': True})
            self.send_json({'error': 'not found'}, 404)
        except Exception as error:  # noqa: BLE001
            self.send_json({'error': str(error)}, 500)


def main():
    parser = argparse.ArgumentParser(description='FMH DRILL local server')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-open', action='store_true', help='do not open the browser')
    args = parser.parse_args()
    ensure_dirs()
    url = f'http://127.0.0.1:{args.port}/'
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError as error:
        if getattr(error, 'errno', None) in (48, 98):  # already running (double-click on the desktop icon twice): just open it
            print(f'FMH DRILL läuft bereits · {url}')
            if not args.no_open:
                webbrowser.open(url)
            return
        raise
    print(f'FMH DRILL  ·  {url}\nprogress is saved in {DATA}\npress Ctrl+C to stop')
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')


if __name__ == '__main__':
    main()

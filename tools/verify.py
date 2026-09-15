#!/usr/bin/env python3
"""Open slot's test card in the studio in headless Chrome, the way a browser without a directory
picker opens it, then screenshot the page at 1280 and 400 wide and download the labels zip.

Everything lands in out/. The card is slot's own sdcard/ Games folder with its Labels/ left
behind, so every cart gets a generated label that can be set beside its hand-made one.
"""

import base64
import functools
import http.server
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

import websocket

STUDIO = Path(__file__).resolve().parent.parent
SLOT_GAMES = STUDIO.parent / 'slot' / 'sdcard' / 'Games'
OUT = STUDIO / 'out'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
HTTP_PORT, CDP_PORT = 8765, 9223

OPEN_FILES = """
(async (paths) => {
  const files = [];
  for (const path of paths) {
    const r = await fetch('/card/' + path.split('/').map(encodeURIComponent).join('/'));
    if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
    const file = new File([await r.blob()], path.split('/').pop());
    Object.defineProperty(file, 'webkitRelativePath', { value: 'card/' + path });
    files.push(file);
  }
  await window.__studio.openFiles(files);
  return files.length;
})(%s)
"""


class Quiet(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.wasm': 'application/wasm',
        '.js': 'text/javascript',
    }

    def log_message(self, *args):
        pass


class Cdp:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=300)
        self.last = 0

    def send(self, method, **params):
        self.last += 1
        self.ws.send(json.dumps({'id': self.last, 'method': method, 'params': params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == self.last:
                if 'error' in msg:
                    raise RuntimeError(f'{method}: {msg["error"]}')
                return msg.get('result', {})

    def eval(self, expression):
        r = self.send('Runtime.evaluate', expression=expression, awaitPromise=True, returnByValue=True)
        if 'exceptionDetails' in r:
            raise RuntimeError(json.dumps(r['exceptionDetails'], indent=1))
        return r['result'].get('value')

    def width(self, width):
        self.send('Emulation.setDeviceMetricsOverride', width=width, height=900, deviceScaleFactor=1, mobile=False)
        time.sleep(0.5)

    def shot(self, width, path):
        self.width(width)
        height = self.eval('document.documentElement.scrollHeight')
        r = self.send('Page.captureScreenshot', format='png', captureBeyondViewport=True,
                      clip={'x': 0, 'y': 0, 'width': width, 'height': height, 'scale': 1})
        path.write_bytes(base64.b64decode(r['data']))
        print(f'{path.name}: {width}x{height}')


def wait(check, timeout, what):
    end = time.time() + timeout
    while True:
        try:
            value = check()
            if value:
                return value
        except OSError:
            pass
        if time.time() > end:
            sys.exit(f'timed out waiting for {what}')
        time.sleep(0.25)


def main():
    if not (STUDIO / 'web' / 'pkg' / 'slot_cart_studio.js').exists():
        sys.exit('web/pkg is missing: run `task build` first')
    OUT.mkdir(exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='studio-verify-'))
    (stage / 'studio').symlink_to(STUDIO / 'web')
    (stage / 'card').mkdir()
    (stage / 'card' / 'Games').symlink_to(SLOT_GAMES)
    games = sorted(p.name for p in SLOT_GAMES.iterdir() if p.is_file() and not p.name.startswith('.'))

    server = http.server.ThreadingHTTPServer(('127.0.0.1', HTTP_PORT), functools.partial(Quiet, directory=str(stage)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = Path(tempfile.mkdtemp(prefix='studio-chrome-'))
    chrome = subprocess.Popen(
        [CHROME, '--headless=new', f'--remote-debugging-port={CDP_PORT}', '--remote-allow-origins=*',
         f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check', 'about:blank'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        version = wait(lambda: json.load(urllib.request.urlopen(f'http://127.0.0.1:{CDP_PORT}/json/version')), 30, 'Chrome')
        downloads = OUT / 'downloads'
        shutil.rmtree(downloads, ignore_errors=True)
        downloads.mkdir()
        Cdp(version['webSocketDebuggerUrl']).send('Browser.setDownloadBehavior', behavior='allow', downloadPath=str(downloads))

        new = urllib.request.Request(f'http://127.0.0.1:{CDP_PORT}/json/new?about:blank', method='PUT')
        page = Cdp(json.load(urllib.request.urlopen(new))['webSocketDebuggerUrl'])
        page.width(1280)
        page.send('Page.navigate', url=f'http://127.0.0.1:{HTTP_PORT}/studio/')
        wait(lambda: page.eval("document.body && document.body.dataset.ready === 'true'"), 60, 'the studio to start')

        print('opened', page.eval(OPEN_FILES % json.dumps(['Games/' + g for g in games])), 'files')
        wait(lambda: page.eval('window.__studio.idle()'), 600, 'every cart to be looked up')
        for s in page.eval('window.__studio.states()'):
            print(f"  {s['state']:<10} hue {s['hue']:>3}  {s['stem']}  ->  {s['game']}")

        page.shot(1280, OUT / 'studio-1280.png')
        page.shot(400, OUT / 'studio-400.png')
        overflow = page.eval('document.documentElement.scrollWidth')
        print('scroll width at 400:', overflow)
        if overflow > 400:
            sys.exit('the page scrolls sideways at 400 px')

        page.width(1280)
        # Browser.setDownloadBehavior above is ignored by headless Chrome for this target; the
        # page-level form of the same command is the one that actually takes effect.
        page.send('Page.setDownloadBehavior', behavior='allow', downloadPath=str(downloads))
        page.eval("document.getElementById('write').click()")
        wait(lambda: (downloads / 'labels.zip').exists(), 60, 'labels.zip to download')
        time.sleep(1)
        shutil.copy(downloads / 'labels.zip', OUT / 'labels.zip')
        subprocess.run(['unzip', '-t', str(OUT / 'labels.zip')], check=True)

        card = OUT / 'card'
        shutil.rmtree(card, ignore_errors=True)
        card.mkdir()
        (card / 'Games').symlink_to(SLOT_GAMES)
        with zipfile.ZipFile(OUT / 'labels.zip') as z:
            z.extractall(card)
        print('labels unzipped into', card)
    finally:
        chrome.terminate()
        server.shutdown()
        shutil.rmtree(stage, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    main()

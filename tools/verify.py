#!/usr/bin/env python3
"""Open slot's test card in the studio in headless Chrome, the way a browser without a directory
picker opens it, then screenshot the page at 1280 and 400 wide and download the labels zip.

Everything lands in out/. The card is slot's own sdcard/ Games folder with its Labels/ left
behind, so every cart gets a generated label that can be set beside its hand-made one.

A second pass opens a card that already has labels for three of its carts, one of them spelled
decomposed, and fails unless those three stay out of the zip. In the zip flow nothing else stops
labels.zip from overwriting a label someone made by hand.
"""

import base64
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import websocket

STUDIO = Path(__file__).resolve().parent.parent
SLOT_GAMES = STUDIO.parent / 'slot' / 'sdcard' / 'Games'
OUT = STUDIO / 'out'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
# Overridable so a run can avoid whichever port the user's own browser session is on.
HTTP_PORT = int(os.environ.get('STUDIO_HTTP_PORT', 8765))
CDP_PORT = int(os.environ.get('STUDIO_CDP_PORT', 9223))
# The second pass's labels: two of slot's hand-made ones, and Emerald's under an extra cart whose
# ROM is named composed and whose label decomposed, so only a normalised comparison pairs them.
KEPT = ['Advance Wars', 'Metroid Fusion']
PROBE = unicodedata.normalize('NFC', 'Pokémon Probe')
PROBE_OF = 'Pokemon - Emerald Version (USA, Europe)'
# What the labelled card already holds: a comment and another cart's choice, both of which a
# write must leave as they are.
SHELLS_ON_CARD = '# chosen by hand\nCatrap (USA) = rounded 112233 solid\n'

OPEN_FILES = """
(async (card, paths) => {
  const files = [];
  for (const path of paths) {
    const r = await fetch('/' + card + '/' + path.split('/').map(encodeURIComponent).join('/'));
    if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
    const file = new File([await r.blob()], path.split('/').pop());
    Object.defineProperty(file, 'webkitRelativePath', { value: card + '/' + path });
    files.push(file);
  }
  await window.__studio.openFiles(files);
  return files.length;
})(%s, %s)
"""

# The data URL of one cart's preview, and a click on its Shell button, by stem.
CART_CANVAS = """
(stem => document.querySelectorAll('#grid > .cart')[
  window.__studio.states().findIndex(s => s.stem === stem)].querySelector('canvas').toDataURL())(%s)
"""
OPEN_SHELL = """
(stem => document.querySelectorAll('#grid > .cart')[
  window.__studio.states().findIndex(s => s.stem === stem)].querySelector('.shell-open').click())(%s)
"""
CANVAS_HIDDEN = """
(stem => document.querySelectorAll('#grid > .cart')[
  window.__studio.states().findIndex(s => s.stem === stem)].querySelector('canvas').hidden)(%s)
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
        # An exception thrown inside a paint leaves the page half drawn and says nothing. The
        # events arrive between the replies to our own calls, so they are collected there.
        self.problems = []

    def send(self, method, **params):
        self.last += 1
        self.ws.send(json.dumps({'id': self.last, 'method': method, 'params': params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('method') == 'Runtime.exceptionThrown':
                d = msg['params']['exceptionDetails']
                text = d.get('exception', {}).get('description') or d.get('text', '')
                self.problems.append(text.splitlines()[0] if text else 'unknown exception')
            elif msg.get('method') == 'Runtime.consoleAPICalled' and msg['params']['type'] == 'error':
                args = ' '.join(str(a.get('value', a.get('description', ''))) for a in msg['params']['args'])
                self.problems.append(f'console.error: {args}'[:200])
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


def nfc(name):
    return unicodedata.normalize('NFC', name)


def open_card(page, card, paths):
    """Hands the page a card's files and waits for every cart to settle. Returns their states."""
    print('opened', page.eval(OPEN_FILES % (json.dumps(card), json.dumps(paths))), 'files')
    wait(lambda: page.eval('window.__studio.idle()'), 600, 'every cart to be looked up')
    states = page.eval('window.__studio.states()')
    for s in states:
        print(f"  {s['state']:<10} {s['deep']}  {s['stem']}  ->  {s['game']}")
    return states


def stage_labelled(card, games):
    """slot's carts, the probe cart, and the labels in KEPT and for the probe. Returns the paths
    the page is handed, spelled as they were written."""
    # A symlink per ROM rather than one for the folder, so the probe lands here and not in slot.
    for g in games:
        (card / 'Games' / g).parent.mkdir(parents=True, exist_ok=True)
        (card / 'Games' / g).symlink_to(SLOT_GAMES / g)
    probe = f'GBA/{PROBE}.gba'
    (card / 'Games' / probe).symlink_to(SLOT_GAMES / f'GBA/{PROBE_OF}.gba')
    # The labels the first pass just wrote, not the live card's: a fixture that reads slot's sdcard
    # breaks whenever that card changes, and it did.
    written = OUT / 'card' / 'Labels'
    labels = {f'GBA/{stem}.png': written / f'GBA/{stem}.png' for stem in KEPT}
    labels[unicodedata.normalize('NFD', f'GBA/{PROBE}.png')] = written / f'GBA/{PROBE_OF}.png'
    for name, source in labels.items():
        (card / 'Labels' / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(source, card / 'Labels' / name)
    (card / 'System').mkdir(parents=True, exist_ok=True)
    (card / 'System' / 'cart_shell.ini').write_text(SHELLS_ON_CARD)
    return ([f'Games/{g}' for g in games] + [f'Games/{probe}'] + [f'Labels/{name}' for name in labels]
            + ['System/cart_shell.ini'])


def main():
    if not (STUDIO / 'web' / 'pkg' / 'slot_cart_studio.js').exists():
        sys.exit('web/pkg is missing: run `task build` first')
    OUT.mkdir(exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='studio-verify-'))
    (stage / 'studio').symlink_to(STUDIO / 'web')
    (stage / 'card').mkdir()
    (stage / 'card' / 'Games').symlink_to(SLOT_GAMES)
    # Relative to Games/, platform folder and all: slot files a cart under the folder its
    # platform names, and the folder is what decides the platform.
    games = sorted(
        f'{d.name}/{p.name}'
        for d in SLOT_GAMES.iterdir()
        if d.is_dir() and not d.name.startswith('.')
        for p in d.iterdir()
        if p.is_file() and not p.name.startswith('.')
    )

    server = http.server.ThreadingHTTPServer(('127.0.0.1', HTTP_PORT), functools.partial(Quiet, directory=str(stage)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = Path(tempfile.mkdtemp(prefix='studio-chrome-'))
    chrome = subprocess.Popen(
        [CHROME, '--headless=new', f'--remote-debugging-port={CDP_PORT}', '--remote-allow-origins=*',
         f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check', 'about:blank'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait(lambda: json.load(urllib.request.urlopen(f'http://127.0.0.1:{CDP_PORT}/json/version')), 30, 'Chrome')
        downloads = OUT / 'downloads'
        shutil.rmtree(downloads, ignore_errors=True)
        downloads.mkdir()

        new = urllib.request.Request(f'http://127.0.0.1:{CDP_PORT}/json/new?about:blank', method='PUT')
        page = Cdp(json.load(urllib.request.urlopen(new))['webSocketDebuggerUrl'])
        page.send('Runtime.enable')
        page.width(1280)
        # STUDIO_ART points the page at a harvested set, the way the address does by hand. Unset,
        # the run is the one that came before there was a set: every logo from libretro.
        art = os.environ.get('STUDIO_ART', '')
        page_url = f'http://127.0.0.1:{HTTP_PORT}/studio/'
        if art:
            page_url += '?art=' + urllib.parse.quote(art, safe='')
            print('art set:', art)
        page.send('Page.navigate', url=page_url)
        wait(lambda: page.eval("document.body && document.body.dataset.ready === 'true'"), 60, 'the studio to start')

        first = open_card(page, 'card', ['Games/' + g for g in games])

        # Settled again before the shots: open_card's wait ends when every cart has resolved once,
        # and a shot taken while anything is still being dressed photographs a spinner.
        wait(lambda: page.eval('window.__studio.idle()'), 120, 'the carts to settle before the shot')
        page.shot(1280, OUT / 'studio-1280.png')
        page.shot(400, OUT / 'studio-400.png')
        overflow = page.eval('document.documentElement.scrollWidth')
        print('scroll width at 400:', overflow)
        if overflow > 400:
            sys.exit('the page scrolls sideways at 400 px')

        # The switcher, clicked rather than counted: the Game Boy shelves are where the unmatched
        # carts live, so this is also the only shot that shows what an unmatched cart offers.
        tabs = page.eval("[...document.querySelectorAll('#tabs button')].map(b => b.textContent)")
        print('tabs:', tabs)
        if len(tabs) > 1:
            page.eval("document.querySelectorAll('#tabs button')[%d].click()" % (len(tabs) - 1))
            wait(lambda: page.eval('window.__studio.idle()'), 120, 'the shelf to settle')
            print('at the shot: idle', page.eval('window.__studio.idle()'),
                  '| button', repr(page.eval("document.getElementById('write').textContent")),
                  '| banner', repr(page.eval("document.getElementById('banner').hidden")))
            # Per card: what paint wrote to the dom against what the page thinks the cart is. They
            # disagree only if paint stopped part way through, which has one early return in it.
            rows = page.eval(
                "[...document.querySelectorAll('.cart')].map(c => ["
                "  c.querySelector('.stem').textContent, c.dataset.state,"
                "  c.querySelector('.game').textContent,"
                "  c.querySelector('canvas').hidden ? 'no canvas' : 'canvas'].join(' | '))"
            )
            says = {s['stem']: s['state'] for s in page.eval('window.__studio.states()')}
            for r in rows:
                print('   dom:', r)
            print('   states:', json.dumps(says))
            for problem in dict.fromkeys(page.problems):
                print('   PAGE ERROR:', problem)
            shown = page.eval(
                "[...document.querySelectorAll('#grid > *')].filter(c => !c.hidden)"
                ".map(c => c.querySelector('.stem').textContent)"
            )
            print(f'{tabs[-1]} shows: {shown}')
            page.shot(1280, OUT / 'studio-tab-1280.png')
            if not shown:
                sys.exit(f'switching to {tabs[-1]} left no carts on screen')

        needs_logo = next((s['stem'] for s in first if s['state'] == 'needs-logo'), None)
        if needs_logo is None:
            sys.exit('no needs-logo cart in the fixture to check the shell preview on')
        if not page.eval(CANVAS_HIDDEN % json.dumps(needs_logo)):
            sys.exit(f'{needs_logo} shows a canvas before a shell is chosen')
        # One open/close cycle for both checks: the dialog's own close event is a queued task, so
        # closing and reopening it in quick succession races that task's `shelling = null` against
        # the reopen's `shelling = c` and can leave the reset click acting on no cart at all.
        page.eval(OPEN_SHELL % json.dumps(needs_logo))
        page.eval("document.querySelectorAll('#shell-presets button')[5].click()")
        if page.eval(CANVAS_HIDDEN % json.dumps(needs_logo)):
            sys.exit(f'{needs_logo} still shows no canvas after a shell was chosen')
        print(f'asserted: {needs_logo} (needs-logo) shows no canvas until a shell is chosen, '
              'then shows the generated label')
        # Left as found: back to Automatic, so it does not show up as a shell change below.
        page.eval("document.getElementById('shell-reset').click()")
        page.eval("document.getElementById('shell').close()")
        if not page.eval(CANVAS_HIDDEN % json.dumps(needs_logo)):
            sys.exit(f'{needs_logo} still shows a canvas after resetting to Automatic')

        page.width(1280)
        # Headless Chrome ignores the browser-level Browser.setDownloadBehavior for this target;
        # only the page-level form of the command takes effect.
        page.send('Page.setDownloadBehavior', behavior='allow', downloadPath=str(downloads))
        page.eval("document.getElementById('write').click()")
        # click() returns at the loop's first yield, and this round trip lands a few carts later
        # still: on ten carts it reads "8 of 10". What keeps that honest is the packing left to
        # do, about 44 ms a cart against a round trip of a few, so the bar is up and counting
        # well before this looks. A fixture small enough to finish packing first would flake.
        packing = page.eval(
            "!document.getElementById('progress').hidden && "
            "document.getElementById('progress-text').textContent"
        )
        if not packing or 'Packing' not in packing:
            sys.exit(f'the progress bar was not showing a packing count: {packing!r}')
        print(f'asserted: progress bar reads {packing!r} mid-write')
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

        print('second pass: a card that already has labels for', ', '.join([*KEPT, PROBE]))
        kept = {nfc(stem) for stem in [*KEPT, PROBE]}
        # Which folder each cart's label belongs in, for the zip's entry names.
        where = {nfc(Path(g).stem): Path(g).parent.name for g in games}
        where[nfc(PROBE)] = 'GBA'
        # What the plain card actually settled on, rather than an assumption that every cart finds
        # a logo: the Game Boy carts here are homebrew and libretro has nothing for them.
        expected = {nfc(s['stem']): s['state'] for s in first} | {stem: 'has-label' for stem in kept}
        states = open_card(page, 'labelled', stage_labelled(stage / 'labelled', games))
        page.shot(1280, OUT / 'studio-labelled-1280.png')
        got = {nfc(s['stem']): s['state'] for s in states}
        if got != expected:
            for stem in sorted(got.keys() | expected.keys()):
                if got.get(stem) != expected.get(stem):
                    print(f'  {stem}: expected {expected.get(stem)}, got {got.get(stem)}')
            sys.exit('the labelled card\'s carts are not in the states they should be')

        shells = {nfc(s['stem']): s['shell'] for s in page.eval('window.__studio.shells()')}
        if shells.get('Catrap (USA)') != 'rounded 112233 solid':
            sys.exit(f'the card\'s cart_shell.ini was not read: {shells.get("Catrap (USA)")!r}')
        print('asserted: the card\'s existing shell choice was read')

        chosen = 'Advance Wars'
        preset = page.eval('window.__studio.shellPresets()')[5].split('\t')[1]
        before = page.eval(CART_CANVAS % json.dumps(chosen))
        page.eval(OPEN_SHELL % json.dumps(chosen))
        page.eval("document.querySelectorAll('#shell-presets button')[5].click()")
        in_dialog = page.eval("document.getElementById('shell-face').toDataURL()")
        on_card = page.eval(CART_CANVAS % json.dumps(chosen))
        page.eval('window.scrollTo(0, 0)')
        page.shot(1280, OUT / 'studio-shell-1280.png')
        page.shot(400, OUT / 'studio-shell-400.png')
        page.width(1280)
        page.eval("document.getElementById('shell').close()")
        if in_dialog != on_card:
            sys.exit(f'the shell dialog does not show {chosen} as its card does')
        print(f'asserted: the shell dialog shows {chosen} as its card does, while choosing')
        if page.eval(CART_CANVAS % json.dumps(chosen)) == before:
            sys.exit(f'choosing a shell did not redraw {chosen}')
        print(f'asserted: choosing a shell redrew {chosen}')

        kept_downloads = OUT / 'downloads-labelled'
        shutil.rmtree(kept_downloads, ignore_errors=True)
        kept_downloads.mkdir()
        page.width(1280)
        page.send('Page.setDownloadBehavior', behavior='allow', downloadPath=str(kept_downloads))
        page.eval("document.getElementById('write').click()")
        wait(lambda: (kept_downloads / 'labels.zip').exists(), 60, 'the labelled card\'s labels.zip to download')
        time.sleep(1)
        with zipfile.ZipFile(kept_downloads / 'labels.zip') as z:
            entries = {nfc(name) for name in z.namelist()}
        overwritten = sorted(entries & {f'Labels/{where[stem]}/{stem}.png' for stem in kept})
        if overwritten:
            sys.exit(f'labels.zip would overwrite labels the card already has: {overwritten}')
        ready = {
            f'Labels/{where[stem]}/{stem}.png'
            for stem, state in expected.items()
            if state == 'ready'
        }
        if entries != ready | {'System/cart_shell.ini'}:
            sys.exit(f'labels.zip holds {sorted(entries)}, not the ready carts and the shells')
        with zipfile.ZipFile(kept_downloads / 'labels.zip') as z:
            written = z.read('System/cart_shell.ini').decode()
        want = f'{chosen} = auto {preset.split(" ", 1)[1]}'
        if written != SHELLS_ON_CARD + want + '\n':
            sys.exit(f'cart_shell.ini came out as {written!r}, not the card\'s lines plus {want!r}')
        print(f'asserted: cart_shell.ini keeps the card\'s lines and adds {chosen}\'s shell')
        print(f'asserted: {len(kept)} carts are has-label: {", ".join(sorted(kept))}')
        print(f'asserted: the other {len(ready)} carts are ready')
        print(f'asserted: labels.zip holds exactly those {len(ready)}, and none of the {len(kept)} with labels')
    finally:
        chrome.terminate()
        server.shutdown()
        shutil.rmtree(stage, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Build a thumbnail set from ScreenScraper, to host beside libretro's.

libretro has no Named_Logos for Game Boy Color at all — the folder does not exist — so every GBC
cart falls back to a hand-dropped logo. ScreenScraper has a clear logo (`wheel`) for most of
them, under CC BY-NC-SA 4.0: redistributable with attribution, as long as the set that results
carries the same licence.

It also keeps each cart's printed label (`label`), cut from ScreenScraper's scan of the cartridge
(`support-2D`) as it downloads, so the set holds the label and not the whole scan. Cropping needs
Pillow; a run of `--media wheel` alone does not.

This runs locally. Credentials come from the environment, the images land in a folder you push to
a repository of your own, and the studio only ever fetches the result over https. None of the CORS
and credential problems that rule ScreenScraper out of the page itself apply here.

    SS_DEVID=... SS_DEVPASSWORD=... SS_SSID=... SS_SSPASSWORD=... \\
        tools/harvest.py --probe "../slot/sdcard/Games/GBC/Pokemon - Crystal Version.gbc"

    SS_... tools/harvest.py --card ../slot/sdcard --out ../slot-thumbnails
    SS_... tools/harvest.py --dat all --out ../slot-thumbnails

Alongside the images it writes index.json, mapping CRC32 to the file that was saved. The studio
already computes a cart's CRC32, so that index is an exact lookup: no name matching, no probing a
url per cart to see whether it 404s, and it reaches roms No-Intro has never heard of.

Files are named by that CRC32 rather than by a game's name, so nothing in the set is named after a
database it did not come from. The No-Intro dat is read only to know which dumps exist and what to
call them while the run reports itself; every image is ScreenScraper's.

ScreenScraper's quota is per account, per minute and per day, and their documentation makes
managing it the client's job rather than the server's. This reads the account's own limits before
it starts and stops when the day's allowance is gone, leaving what it has written in place: a
later run skips whatever is already on disk, so a set is built across as many days as it needs.
"""

import argparse
import io
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = 'https://api.screenscraper.fr/api2'
DAT = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/'

# The card folders slot files roms under, and libretro's name for each system. The ScreenScraper
# system id is looked up from that name rather than hard-coded, so a renumbering upstream cannot
# quietly harvest the wrong console's art.
PLATFORMS = {
    'GBA': 'Nintendo - Game Boy Advance',
    'GB': 'Nintendo - Game Boy',
    'GBC': 'Nintendo - Game Boy Color',
}
EXTENSIONS = {'GBA': ('.gba',), 'GB': ('.gb', '.gbc'), 'GBC': ('.gb', '.gbc')}

# ScreenScraper's own system ids. They are named "Game Boy Color", not libretro's "Nintendo -
# Game Boy Color", so there is no shared name to look them up by. Stated here and then checked
# against the live list at startup: a renumbering upstream would otherwise file one console's art
# under another's name, silently and for the whole run.
SS_SYSTEM = {'GB': 9, 'GBC': 10, 'GBA': 12}
SS_EXPECT = {'GB': 'game boy', 'GBC': 'game boy color', 'GBA': 'game boy advance'}

# Where each media lands, in the layout libretro uses and the studio already fetches.
# A media's own name is its folder: <platform>/<media type>/<crc>.png. The platform folders are
# the ones slot files roms under, so the set speaks the card's vocabulary, and the media folders
# are ScreenScraper's own type names, so another type needs no table here to be harvested.

# Most dumps in circulation are USA or World, so prefer the art that belongs with those before
# falling back to whatever a game has.
REGIONS = ('us', 'wor', 'eu', 'jp')


def creds():
    missing = [k for k in ('SS_DEVID', 'SS_DEVPASSWORD') if not os.environ.get(k)]
    if missing:
        sys.exit(f'set {" and ".join(missing)} in the environment')
    c = {
        'devid': os.environ['SS_DEVID'],
        'devpassword': os.environ['SS_DEVPASSWORD'],
        'softname': os.environ.get('SS_SOFTNAME', 'slot-cart-studio'),
        'output': 'json',
    }
    # A user account carries the quota; without one the per-day allowance is too small to build
    # anything but a handful of files.
    if os.environ.get('SS_SSID'):
        c['ssid'] = os.environ['SS_SSID']
        c['sspassword'] = os.environ.get('SS_SSPASSWORD', '')
    return c


def call(endpoint, params, tries=4):
    """One API call, backing off rather than hammering a service that limits by design."""
    for attempt in range(tries):
        url = f'{API}/{endpoint}?' + urllib.parse.urlencode(params)
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.loads(r.read().decode('utf-8', 'replace'))
        except urllib.error.HTTPError as e:
            # 404 means this rom is not known, which is an answer rather than a failure. 429 is the
            # documented rate limit and 430/431 their quota codes.
            if e.code == 404:
                return None
            if e.code in (429, 430, 431):
                if e.code != 429:
                    raise QuotaSpent(f'ScreenScraper says the quota is spent (HTTP {e.code})')
                if attempt < tries - 1:
                    wait = 20 * (attempt + 1)
                    print(f'    rate limited, waiting {wait}s', flush=True)
                    time.sleep(wait)
                    continue
            raise
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            if attempt == tries - 1:
                raise
            time.sleep(5 * (attempt + 1))
    return None


class QuotaSpent(Exception):
    pass


def quota(c):
    """The account's own limits. Their documentation makes honouring these the client's job."""
    data = call('ssuserInfos.php', c) or {}
    u = data.get('response', {}).get('ssuser', {}) or {}
    def num(*keys):
        for k in keys:
            v = u.get(k)
            if v not in (None, ''):
                try:
                    return int(str(v).strip())
                except ValueError:
                    pass
        return None
    return {
        'per_min': num('maxrequestspermin', 'maxrequestsparminute'),
        'per_day': num('maxrequestsperday', 'maxrequestsparjour'),
        'today': num('requeststoday', 'requestsdone') or 0,
        'threads': num('maxthreads') or 1,
    }


def dat_entries(platform):
    """CRC32 to No-Intro name: which dumps exist, and what to call them in this run's own output.

    The name never reaches a file on disk — those are named for the CRC — so this is a worklist
    and a log, not a source.
    """
    url = DAT + urllib.parse.quote(PLATFORMS[platform]) + '.dat'
    with urllib.request.urlopen(url, timeout=120) as r:
        text = r.read().decode('utf-8', 'replace')
    out = {}
    for block in re.finditer(r'game\s*\((.*?)\n\)', text, re.S):
        body = block.group(1)
        name = re.search(r'name\s+"([^"]+)"', body)
        crc = re.search(r'\bcrc\s+([0-9A-Fa-f]{8})', body)
        if name and crc:
            out[crc.group(1).upper()] = name.group(1)
    return out


def check_systems(c):
    """Hold ScreenScraper to the ids above, by the name it gives each one."""
    data = call('systemesListe.php', c)
    listed = (data or {}).get('response', {}).get('systemes', [])
    if not listed:
        sys.exit('ScreenScraper would not list its systems: check the credentials')
    names = {}
    for s in listed:
        try:
            names[int(s['id'])] = str((s.get('noms') or {}).get('nom_eu', '')).strip().lower()
        except (TypeError, ValueError):
            continue
    for platform, sid in SS_SYSTEM.items():
        got = names.get(sid)
        if got is None:
            sys.exit(f'ScreenScraper lists no system {sid}, which this expects to be {platform}')
        if got != SS_EXPECT[platform]:
            sys.exit(f'system {sid} is "{got}", not "{SS_EXPECT[platform]}": ids have moved')
    return SS_SYSTEM


def crc32(path):
    h = 0
    with open(path, 'rb') as f:
        while chunk := f.read(1 << 20):
            h = zlib.crc32(chunk, h)
    return f'{h & 0xffffffff:08X}'


def pick(medias, want):
    """The wanted media in the most useful region, or None."""
    same = [m for m in medias if m.get('type') == want]
    for region in REGIONS:
        for m in same:
            if (m.get('region') or '').lower() == region:
                return m
    return same[0] if same else None


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        body = r.read()
    # A truncated or error body is not an image, and a broken file on the card is worse than none.
    return body if len(body) >= 256 else None


def save(body, dest):
    if not body:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    return True


# `label` is not a ScreenScraper media: it is the printed label cut out of the cart scan.
SOURCE = {'label': 'support-2D'}

# Most of ScreenScraper's cart scans are one template per console, square on and the same size, so
# the label sits in the same place in every one. Measured by overlaying scans of different games:
# the label is the only part that changes. Each box stops short of every pixel that stays the same
# across 400 harvested labels, which is where plastic showed at the edges and in the rounded
# corners of the well.
LABEL_BOX = {
    (600, 678): (91, 209, 504, 572),  # Game Boy pak
    (600, 355): (88, 86, 515, 302),  # GBA cart
    (600, 701): (97, 254, 519, 631),  # Game Boy Color pak, photographed
}
# Any other scan is a photograph. The Game Boy box, as fractions of the template's 600 by 665 cart,
# is applied to the photographed cart's own outline instead.
LABEL_FRAC = (91 / 600, 209 / 665, 504 / 600, 572 / 665)


def crop_label(data):
    """PNG bytes of the printed label in a cart scan, or None when it cannot be placed."""
    from PIL import Image, UnidentifiedImageError

    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except (UnidentifiedImageError, OSError):
        return None
    im = im.convert('RGBA')
    box = LABEL_BOX.get(im.size)
    if box is None:
        outline = im.getchannel('A').point(lambda a: 255 if a > 128 else 0).getbbox()
        if outline is None or outline == (0, 0, *im.size):
            return None
        l, t, r, b = outline
        w, h = r - l, b - t
        box = tuple(round(v) for v in (
            l + LABEL_FRAC[0] * w, t + LABEL_FRAC[1] * h, l + LABEL_FRAC[2] * w, t + LABEL_FRAC[3] * h))
    out = io.BytesIO()
    im.crop(box).convert('RGB').save(out, 'PNG', optimize=True)
    return out.getvalue()


def roms(card, platform):
    d = Path(card) / 'Games' / platform
    if not d.is_dir():
        return []
    return sorted(
        p for p in d.iterdir()
        if p.is_file() and not p.name.startswith('.') and p.suffix.lower() in EXTENSIONS[platform]
    )


def probe(path, c, ids):
    platform = Path(path).parent.name.upper()
    system = ids.get(platform)
    data = call('jeuInfos.php', dict(c, crc=crc32(path), systemeid=system or '',
                                     romnom=Path(path).name,
                                     romtaille=str(Path(path).stat().st_size)))
    jeu = (data or {}).get('response', {}).get('jeu')
    if not jeu:
        print(f'{Path(path).name}: no match')
        return
    names = jeu.get('noms') or [{}]
    print(f'{Path(path).name}: {names[0].get("text", "?")}  (system {system})')
    for m in jeu.get('medias', []):
        # The media urls carry devid and devpassword as query parameters, so only the path is
        # ever printed: a probe's output gets pasted into chats and issues.
        url = urllib.parse.urlsplit(str(m.get('url', '')))
        print(f'   {str(m.get("type")):<22} {str(m.get("region") or "-"):<5} '
              f'{str(m.get("format") or "-"):<5} {url.netloc}{url.path}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--card', help='a slot SD card, harvested for the roms actually on it')
    ap.add_argument('--dat', choices=sorted(PLATFORMS) + ['all'],
                    help='every dump a platform has, not just a card; "all" for every platform')
    ap.add_argument('--out', help='where the set is written')
    ap.add_argument('--media', default='wheel,label',
                    help='comma separated ScreenScraper media types, or label for the label cut from the cart scan')
    ap.add_argument('--probe', help='print every media one rom has, and stop')
    ap.add_argument('--limit', type=int, help='stop after this many games, for a trial run')
    args = ap.parse_args()

    c = creds()
    ids = check_systems(c)

    if args.probe:
        probe(args.probe, c, ids)
        return
    if not args.out or not (args.card or args.dat):
        sys.exit('--out plus one of --card or --dat is needed (or --probe)')

    q = quota(c)
    left = None if q['per_day'] is None else max(0, q['per_day'] - q['today'])
    print(f"quota: {q['today']} used today of {q['per_day'] or '?'}, "
          f"{q['per_min'] or '?'} a minute, {q['threads']} thread(s)")
    if left == 0:
        sys.exit('the day\'s quota is already spent; run again tomorrow and it will resume')
    # Their limit is per minute, so pace to it rather than racing into a 429.
    pause = 60.0 / q['per_min'] if q['per_min'] else 1.0

    wanted = [m.strip() for m in args.media.split(',') if m.strip()]
    if 'label' in wanted:
        try:
            import PIL  # noqa: F401
        except ImportError:
            sys.exit('cropping labels needs Pillow: python3 -m pip install Pillow, or pass --media wheel')
    index_path = Path(args.out) / 'index.json'
    index = json.loads(index_path.read_text()) if index_path.exists() else {}

    # The account's own thread allowance, which is what ScreenScraper polices. Pacing is per
    # thread, so the total stays inside the per-minute limit however many are running.
    threads = max(1, min(q['threads'] or 1, 6))
    pause = threads * pause
    print(f'{threads} worker(s)')

    lock = threading.Lock()
    stop = threading.Event()
    n = {'asked': 0, 'saved': 0, 'missed': 0, 'skipped': 0, 'done': 0, 'unplaced': 0}

    def work(platform, root, system, entries, job):
        crc, romname, size = job
        if stop.is_set():
            return
        # The dat's name is only ever what this run calls a cart while it works; a rom it has
        # never heard of goes by its checksum, which is what the file is named anyway.
        name = entries.get(crc, crc)
        todo = [w for w in wanted if not (root / w / f'{crc}.png').exists()]
        if not todo:
            with lock:
                n['skipped'] += 1
            return
        with lock:
            if (left is not None and n['asked'] >= left) or (args.limit and n['asked'] >= args.limit):
                stop.set()
                return
            n['asked'] += 1
        params = dict(c, crc=crc, systemeid=system, romnom=romname)
        if size:
            params['romtaille'] = str(size)
        try:
            data = call('jeuInfos.php', params)
        except QuotaSpent:
            stop.set()
            return
        except Exception as e:  # one bad game must not take the run down with it
            with lock:
                n['missed'] += 1
            print(f'  {name}: {type(e).__name__}')
            return
        medias = ((data or {}).get('response', {}).get('jeu') or {}).get('medias', [])
        got = []
        unplaced = False
        for want in todo:
            m = pick(medias, SOURCE.get(want, want))
            dest = root / want / f'{crc}.png'
            try:
                body = fetch(m['url']) if m else None
                if body and want == 'label':
                    body = crop_label(body)
                    unplaced = body is None
                if save(body, dest):
                    got.append(want)
            except Exception:
                pass
        with lock:
            n['unplaced'] += unplaced
            if got:
                n['saved'] += len(got)
                index.setdefault(crc, {}).update(
                    {w: str((root / w / f'{crc}.png').relative_to(args.out))
                     for w in got})
            else:
                n['missed'] += 1
            n['done'] += 1
            if n['done'] % 50 == 0:
                print(f"  ... {n['done']} done, {n['saved']} files, {n['missed']} without art", flush=True)
        time.sleep(pause)

    try:
        chosen = list(PLATFORMS) if args.dat == 'all' else ([args.dat] if args.dat else list(PLATFORMS))
        for platform in chosen:
            if stop.is_set():
                break
            entries = dat_entries(platform)
            if args.card:
                # Every rom on the card, whether No-Intro knows it or not: a file is named for its
                # checksum, so a dump nobody has catalogued still has somewhere to go. Only a
                # sweep of a whole platform needs the dat, because only that needs a list.
                jobs = [(crc32(p), p.name, p.stat().st_size) for p in roms(args.card, platform)]
            else:
                jobs = [(crc, f'{name}.bin', 0) for crc, name in entries.items()]
            if not jobs:
                continue
            system = ids[platform]
            root = Path(args.out) / platform
            print(f'{platform}: {len(jobs)} to consider, system {system}', flush=True)
            with ThreadPoolExecutor(max_workers=threads) as pool:
                for job in jobs:
                    if stop.is_set():
                        break
                    pool.submit(work, platform, root, system, entries, job)
    except QuotaSpent as e:
        print(f'\nstopped: {e}')
    except KeyboardInterrupt:
        stop.set()
        print('\nstopped by hand')
    finally:
        asked, saved, missed, skipped = n['asked'], n['saved'], n['missed'], n['skipped']
        # Written whatever happened, so an interrupted run leaves a usable index behind.
        if args.out:
            index_path.parent.mkdir(parents=True, exist_ok=True)
            index_path.write_text(json.dumps(index, indent=1, sort_keys=True))
            print(f'\n{saved} files, {missed} games with none, {skipped} already there, '
                  f'{asked} api calls\nindex: {index_path} ({len(index)} crcs)')
            if n['unplaced']:
                print(f"{n['unplaced']} cart scans had no label that could be placed, and were left out")


if __name__ == '__main__':
    main()

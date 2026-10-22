#!/usr/bin/env python3
"""Build a thumbnail set from ScreenScraper, to host beside libretro's.

libretro has no Named_Logos for Game Boy Color at all — the folder does not exist — so every GBC
cart falls back to a hand-dropped logo. ScreenScraper has a clear logo (`wheel`) for most of
them, under CC BY-NC-SA 4.0: redistributable with attribution, as long as the set that results
carries the same licence.

It also records each cart's `look`: the ground colour and edge band of its printed label, measured
from ScreenScraper's scan of the cartridge as it downloads. Only the measurements are kept, in
index.json; the scan is never saved. Measuring needs Pillow and numpy; a run of `--media wheel`
alone does not.

This runs locally. Credentials come from the environment, the images land in a folder you push to
a repository of your own, and the studio only ever fetches the result over https. None of the CORS
and credential problems that rule ScreenScraper out of the page itself apply here.

    SS_DEVID=... SS_DEVPASSWORD=... SS_SSID=... SS_SSPASSWORD=... \\
        tools/harvest.py --probe "../slot/sdcard/Games/GBC/Pokemon - Crystal Version.gbc"

    SS_... tools/harvest.py --card ../slot/sdcard --out ../slot-thumbnails
    SS_... tools/harvest.py --dat all --out ../slot-thumbnails

Alongside the images it writes index.json, mapping CRC32 to the file that was saved. The studio
already computes a cart's CRC32, so that index is an exact lookup: no probing a
url per cart to see whether it 404s, and it reaches roms No-Intro has never heard of.

The dat is read only to know which dumps exist and what to
call them while the run reports itself; every image is ScreenScraper's.

ScreenScraper's quota is per account, per minute and per day, and their documentation makes
managing it the client's job rather than the server's. This reads the account's own limits before
it starts and stops when the day's allowance is gone, leaving what it has written in place: a
later run skips whatever is already on disk, so a set is built across as many days as it needs.
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = 'https://api.screenscraper.fr/api2'
LIBRETRO = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/'
VIDEO = 'Game Boy Advance Video'
EXTRAS = Path(__file__).with_name('extras.json')

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
COUNTRY = {
    'USA': 'us', 'World': 'wor', 'Europe': 'eu', 'Japan': 'jp', 'Germany': 'de', 'France': 'fr',
    'Spain': 'sp', 'Italy': 'it', 'UK': 'uk', 'Australia': 'au', 'Netherlands': 'nl',
    'Sweden': 'se', 'Korea': 'kr', 'Brazil': 'br', 'China': 'cn',
}
IN_EUROPE = {'de', 'fr', 'sp', 'it', 'uk', 'au', 'nl', 'se'}


def regions_for(name):
    found = re.search(r'\(([^)]*)\)', name)
    own = COUNTRY.get(found.group(1).split(',')[0].strip()) if found else None
    first = [own] + (['eu'] if own in IN_EUROPE else []) if own else []
    return tuple(dict.fromkeys(first + list(REGIONS)))


def creds():
    missing = [k for k in ('SS_DEVID', 'SS_DEVPASSWORD') if not os.environ.get(k)]
    if missing:
        sys.exit(f'set {" and ".join(missing)} in the environment')
    c = {
        'devid': os.environ['SS_DEVID'],
        'devpassword': os.environ['SS_DEVPASSWORD'],
        'softname': os.environ.get('SS_SOFTNAME', 'Cannoli'),
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


def parse_dat(text, prefix=''):
    out = {}
    for block in re.finditer(r'game\s*\((.*?)\n\)', text, re.S):
        body = block.group(1)
        name = re.search(r'^\s*(?:name|comment)\s+"([^"]+)"', body, re.M)
        crc = re.search(r'\bcrc\s+([0-9A-Fa-f]{8})', body)
        if name and crc and name.group(1).startswith(prefix):
            out.setdefault(crc.group(1).upper(), name.group(1))
    return out


def read_dat(folder, platform):
    url = LIBRETRO + folder + '/' + urllib.parse.quote(PLATFORMS[platform]) + '.dat'
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            return r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return ''
        raise


def dat_entries(platform):
    """CRC32 to No-Intro name: which dumps exist, and what to call them in this run's own output.

    The name never reaches a file on disk, so this is a worklist and a log, not a source.
    """
    return parse_dat(read_dat('no-intro', platform))


def other_dumps(platform):
    out = parse_dat(read_dat('hacks', platform))
    for crc, name in parse_dat(read_dat('serial', platform), VIDEO).items():
        out.setdefault(crc, name)
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


def pick(medias, want, regions=REGIONS):
    """The wanted media in the most useful region, or None."""
    same = [m for m in medias if m.get('type') == want]
    for region in regions:
        for m in same:
            if (m.get('region') or '').lower() == region:
                return m
    return same[0] if same else None


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        body = r.read()
    # A truncated or error body is not an image, and a broken file on the card is worse than none.
    return body if len(body) >= 256 else None


def as_png(body):
    if not body or body.startswith(b'\x89PNG\r\n\x1a\n'):
        return body
    try:
        import io
        from PIL import Image
        out = io.BytesIO()
        Image.open(io.BytesIO(body)).save(out, 'PNG')
        return out.getvalue()
    except Exception:
        return None


def save(body, dest):
    if not body:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    return True


# `look` is not a ScreenScraper media: it is measured from the cart scan and kept in the index.
SOURCE = {'look': 'support-2D'}


def write_index(path, index):
    """Compact, since the page downloads it whole; sorted, so two runs diff cleanly."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index, separators=(',', ':'), sort_keys=True))


def todo_for(crc, wanted, index, root, relook, redo=False):
    """The media this cart still needs: files not on disk, and a look not yet recorded."""
    if redo:
        return list(wanted)
    def needed(w):
        if w == 'look':
            return relook or 'look' not in index.get(crc, {})
        return not (root / w / f'{crc}.png').exists()
    return [w for w in wanted if needed(w)]


def roms(card, platform):
    d = Path(card) / 'Games' / platform
    if not d.is_dir():
        return []
    return sorted(
        p for p in d.iterdir()
        if p.is_file() and not p.name.startswith('.') and p.suffix.lower() in EXTENSIONS[platform]
    )


def collect(medias, todo, regions, root, key):
    got = {}
    for want in todo:
        m = pick(medias, SOURCE.get(want, want), regions)
        try:
            body = fetch(m['url']) if m else None
            if want == 'look':
                measured = look.measure_look(body) if body else None
                if measured:
                    got[want] = measured
            elif save(as_png(body), root / want / f'{key}.png'):
                got[want] = True
        except Exception:
            pass
    return got


def record(entry, got, root, key, out):
    for w, value in got.items():
        entry[w] = value if w == 'look' else str((root / w / f'{key}.png').relative_to(out))


SLUG = re.compile(r'^(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$')


def load_extras(path):
    data = json.loads(Path(path).read_text())
    seen = set()
    for platform, extras in data.items():
        if platform not in PLATFORMS:
            sys.exit(f'{path}: {platform} is not one of {", ".join(PLATFORMS)}')
        for e in extras:
            slug = e.get('slug', '')
            if not SLUG.match(slug):
                sys.exit(f'{path}: "{slug}" is not a slug: lower case words joined by hyphens, with a letter in it')
            if slug in seen:
                sys.exit(f'{path}: {slug} is listed twice')
            if not e.get('name'):
                sys.exit(f'{path}: {slug} has no name')
            seen.add(slug)
    return data


def save_extras(path, data):
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')


def plain(text):
    return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFD', text).lower())


def best_hit(data, names):
    hits = [j for j in (data or {}).get('response', {}).get('jeux') or [] if j and str(j.get('id') or '').isdigit()]
    wanted = {plain(n) for n in names}
    exact = [j for j in hits if any(plain(n.get('text') or '') in wanted for n in j.get('noms') or [])]
    return (exact or hits or [None])[0]


def game_name(jeu):
    return ((jeu.get('noms') or [{}])[0] or {}).get('text', '?')


def new_crcs(roms, known):
    out = set()
    for r in roms or []:
        crc = str(r.get('romcrc') or '').strip().upper()
        if re.fullmatch(r'[0-9A-F]{8}', crc) and crc not in known:
            out.add(crc)
    return sorted(out)


def extra_entry(platform, extra, crcs, old=None):
    entry = {k: v for k, v in (old or {}).items() if k not in ('name', 'platform', 'crcs', 'aka')}
    entry.update(name=extra['name'], platform=platform, crcs=crcs)
    if extra.get('aka'):
        entry['aka'] = list(extra['aka'])
    return entry


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
    ap.add_argument('--extras', nargs='?', const=str(EXTRAS),
                    help=f'the games no dat names, kept under slugs of our own (default {EXTRAS.name})')
    ap.add_argument('--out', help='where the set is written')
    ap.add_argument('--media', default='wheel,look,support-texture',
                    help='comma separated ScreenScraper media types, or look for the label measured from the cart scan')
    ap.add_argument('--relook', action='store_true', help='measure every look again')
    ap.add_argument('--reregion', action='store_true', help='fetch every media again for dumps whose own region is not USA')
    ap.add_argument('--probe', help='print every media one rom has, and stop')
    ap.add_argument('--limit', type=int, help='stop after this many games, for a trial run')
    args = ap.parse_args()

    c = creds()
    ids = check_systems(c)

    if args.probe:
        probe(args.probe, c, ids)
        return
    if not args.out or not (args.card or args.dat or args.extras):
        sys.exit('--out plus one of --card, --dat or --extras is needed (or --probe)')
    extras = load_extras(args.extras) if args.extras else {}

    q = quota(c)
    left = None if q['per_day'] is None else max(0, q['per_day'] - q['today'])
    print(f"quota: {q['today']} used today of {q['per_day'] or '?'}, "
          f"{q['per_min'] or '?'} a minute, {q['threads']} thread(s)")
    if left == 0:
        sys.exit('the day\'s quota is already spent; run again tomorrow and it will resume')
    # Their limit is per minute, so pace to it rather than racing into a 429.
    pause = 60.0 / q['per_min'] if q['per_min'] else 1.0

    wanted = [m.strip() for m in args.media.split(',') if m.strip()]
    if 'look' in wanted:
        try:
            global look
            import look
        except ImportError:
            sys.exit('measuring looks needs Pillow and numpy: python3 -m pip install Pillow numpy, or pass --media wheel')
    index_path = Path(args.out) / 'index.json'
    index = json.loads(index_path.read_text()) if index_path.exists() else {}

    # The account's own thread allowance, which is what ScreenScraper polices. Pacing is per
    # thread, so the total stays inside the per-minute limit however many are running.
    threads = max(1, min(q['threads'] or 1, 6))
    pause = threads * pause
    print(f'{threads} worker(s)')

    lock = threading.Lock()
    stop = threading.Event()
    n = {'asked': 0, 'saved': 0, 'missed': 0, 'skipped': 0, 'done': 0}

    def work(platform, root, system, entries, job):
        crc, romname, size = job
        if stop.is_set():
            return
        # The dat's name is only ever what this run calls a cart while it works; a rom it has
        # never heard of goes by its checksum, which is what the file is named anyway.
        name = entries.get(crc, crc)
        regions = regions_for(entries.get(crc) or romname)
        redo = args.reregion and regions[0] != 'us'
        todo = todo_for(crc, wanted, index, root, args.relook, redo)
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
        got = collect(medias, todo, regions, root, crc)
        with lock:
            if got:
                n['saved'] += len(got)
                record(index.setdefault(crc, {}), got, root, crc, args.out)
            else:
                n['missed'] += 1
            n['done'] += 1
            if n['done'] % 50 == 0:
                print(f"  ... {n['done']} done, {n['saved']} files, {n['missed']} without art", flush=True)
        time.sleep(pause)

    def extra(platform, system, known, e):
        slug = e['slug']
        root = Path(args.out) / platform
        todo = todo_for(slug, wanted, index, root, args.relook)
        if not todo and 'crcs' in index.get(slug, {}):
            n['skipped'] += 1
            return
        if left is not None and n['asked'] >= left or args.limit and n['asked'] >= args.limit:
            stop.set()
            return
        if not e.get('gameid'):
            n['asked'] += 1
            names = [e['name'], *e.get('aka', []), *([e['search']] if e.get('search') else [])]
            jeu = best_hit(call('jeuRecherche.php', dict(c, systemeid=system, recherche=e.get('search') or e['name'])), names)
            time.sleep(pause)
            if not jeu:
                n['missed'] += 1
                print(f'  {slug}: ScreenScraper finds nothing called "{e.get("search") or e["name"]}"')
                return
            e['gameid'] = int(jeu['id'])
            save_extras(args.extras, extras)
            print(f'  {slug}: pinned to ScreenScraper game {jeu["id"]}, "{game_name(jeu)}"')
        n['asked'] += 1
        data = call('jeuInfos.php', dict(c, systemeid=system, gameid=e['gameid']))
        time.sleep(pause)
        jeu = (data or {}).get('response', {}).get('jeu')
        if not jeu:
            n['missed'] += 1
            print(f'  {slug}: ScreenScraper has no game {e["gameid"]}')
            return
        got = collect(jeu.get('medias', []), todo, REGIONS, root, slug)
        entry = extra_entry(platform, e, new_crcs(jeu.get('roms'), known), index.get(slug))
        record(entry, got, root, slug, args.out)
        n['done'] += 1
        if not set(entry) - {'name', 'platform', 'crcs', 'aka'}:
            n['missed'] += 1
            print(f'  {slug}: ScreenScraper game {e["gameid"]} has no art')
            return
        index[slug] = entry
        n['saved'] += len(got)
        print(f'  {slug}: {", ".join(got) or "no media"}, {len(entry["crcs"])} dump(s)')

    try:
        for platform, listed in extras.items():
            if stop.is_set():
                break
            print(f'{platform}: {len(listed)} extras', flush=True)
            known = dat_entries(platform)
            for e in listed:
                if stop.is_set():
                    break
                try:
                    extra(platform, ids[platform], known, e)
                except QuotaSpent:
                    raise
                except Exception as err:
                    n['missed'] += 1
                    print(f'  {e["slug"]}: {type(err).__name__}')
        if args.dat and args.dat != 'all':
            chosen = [args.dat]
        else:
            chosen = list(PLATFORMS) if args.dat or args.card else []
        for platform in chosen:
            if stop.is_set():
                break
            entries = {**other_dumps(platform), **dat_entries(platform)}
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
            write_index(index_path, index)
            print(f'\n{saved} files, {missed} games with none, {skipped} already there, '
                  f'{asked} api calls\nindex: {index_path} ({len(index)} crcs)')


if __name__ == '__main__':
    main()

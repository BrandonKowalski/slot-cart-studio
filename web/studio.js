// slot cart studio. Everything that needs a browser lives here: the card, the network and the page.
// Everything that decides what a label looks like is Rust, in pkg/.

import init, {
  Crc32,
  Dat,
  Label,
  Zip,
  box_hue,
  cart_size,
  clean_label,
  existing_face,
  fallback_hue,
  header_code,
  label_tags,
  logo_luma,
  stop_colours,
  stub_target,
  thumbnail_name,
} from './pkg/slot_cart_studio.js';
import { fromDirectory, fromFiles, labelKey, PLATFORMS } from './card.js';
import { fetchDat, fetchThumb, limiter } from './libretro.js';

const $ = (id) => document.getElementById(id);
const limit = limiter(4);
// The game code sits at 0xAC; nothing past the header is needed to read it.
const HEAD = 0xb0;
const FATAL = 'The studio ran out of memory or hit an internal error. Reload the page to start again.';

let faceW = 0;
let faceH = 0;
// One parsed No-Intro database per platform, kept across cards: the databases are large and a
// second card of the same platform should not fetch one again.
const dats = new Map();
let session = null;
let busy = 0;
let writing = false;
// Set by the first WASM trap. What the module holds is undefined after one (a RefCell can stay
// borrowed, and then every face panics), so nothing calls into it again.
let fatal = false;

const track = (promise) => {
  busy++;
  return promise.finally(() => {
    busy--;
  });
};

function newCart({ platform, stem, file }) {
  return {
    // The folder the rom sits in, and so the only thing that says which console it is for.
    platform,
    stem,
    file,
    code: '',
    crc: null,
    game: null,
    // Logos stay PNG bytes, which are small. The label made from one is not kept: see withLabel.
    logoBytes: null,
    droppedBytes: null,
    rejected: false,
    snapshot: null,
    boxHue: null,
    // How bright the logo is decides which way the ground goes, so it is read once with the logo
    // and kept. 255 until there is a logo: nothing is drawn before then anyway.
    logoLuma: 255,
    deep: null,
    userHue: false,
    existing: null,
    error: null,
    result: null,
    looking: true,
    el: null,
  };
}

const activeLogo = (c) => c.droppedBytes ?? (c.rejected ? null : c.logoBytes);

function stateOf(c) {
  if (c.error) return 'error';
  if (c.existing) return 'has-label';
  if (c.looking) return 'looking';
  return activeLogo(c) ? 'ready' : 'needs-logo';
}

// The box art belongs to the matched game, so its hue only stands while the match does.
const baseHueOf = (c) =>
  c.game && !c.rejected && c.boxHue !== null ? c.boxHue : fallback_hue(c.stem);

// A label is described by its deep corner, whether computed or picked, and the corner a hue
// produces depends on the logo going over it: dark logos get a pale ground, bright ones a deep
// one. stop_colours is that rule, so the page never restates the house numbers itself.
const stopsOf = (c) => stop_colours(baseHueOf(c), c.logoLuma ?? 255);
const baseDeep = (c) => Array.from(stopsOf(c)).slice(0, 3);

const hex = (rgb) => `#${[...rgb].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const fromHex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));

const readyCarts = () =>
  session ? session.carts.filter((c) => stateOf(c) === 'ready' && c.result !== 'skipped') : [];

// A Label holds its 1280x640 composition in WASM memory, which never shrinks and stops at 4 GiB.
// One kept per cart runs a big card out of it, so a Label lives only for the call that needs it.
function withLabel(bytes, deep, use) {
  const label = new Label(bytes, deep);
  try {
    return use(label);
  } finally {
    label.free();
  }
}

// Whether slot's decoder takes a logo, asked the only way the module can be asked: by making one.
function readable(bytes) {
  try {
    withLabel(bytes, [0, 0, 0], () => {});
    return true;
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) throw e;
    return false;
  }
}

// A WebAssembly.RuntimeError is a trap: memory ran out, or Rust panicked. The plain Error a Label
// throws for bytes that aren't a PNG is not one. Returns whether `e` was a trap.
function trapped(e) {
  if (!(e instanceof WebAssembly.RuntimeError)) return false;
  if (!fatal) {
    fatal = true;
    console.error(e);
    $('progress').hidden = true;
    banner(FATAL);
    updateWriteBar();
  }
  return true;
}

// A thumbnail that won't fetch is only a missing image. A trap on the way is not.
const noImage = (e) => {
  if (e instanceof WebAssembly.RuntimeError) throw e;
  return null;
};

function describe(c, state) {
  switch (state) {
    case 'looking':
      return c.crc === null ? 'Reading the ROM…' : 'Looking it up…';
    case 'error':
      return c.error;
    case 'has-label':
      // The label is on the cart above, so saying it has one says nothing. A write is worth saying.
      return c.result === 'written' ? 'Label written to the card' : '';
    default:
      if (c.rejected) return `Not ${c.game}`;
      if (!c.game) {
        return dats.has(c.platform)
          ? 'Not in the No-Intro database'
          : 'The game database has not loaded';
      }
      if (!c.logoBytes && !c.droppedBytes) return `${c.game}: libretro has no logo for it`;
      // The title above already says the game, so this line speaks only when the CRC disagrees
      // with the name on the card — the renamed-ROM case worth catching before it is written.
      return clean_label(c.game) === clean_label(c.stem) ? '' : `Matched ${c.game}`;
  }
}

const statusText = (c) =>
  ({
    skipped: 'Skipped: a label turned up on the card in the meantime',
    failed: 'Writing this label failed',
  })[c.result] ?? '';

function buildCard(c) {
  const root = $('card-tpl').content.firstElementChild.cloneNode(true);
  const q = (selector) => root.querySelector(selector);
  c.el = {
    root,
    canvas: q('canvas'),
    stem: q('.stem'),
    tags: q('.tags'),
    game: q('.game'),
    status: q('.status'),
    hue: q('.hue'),
    hueRow: q('.hue-row'),
    reject: q('.reject'),
    drop: q('.drop'),
    pickLogo: q('.drop input'),
  };
  c.el.canvas.width = faceW;
  c.el.canvas.height = faceH;
  // The device's own title, with the file it came from on hover, and the bracketed groups it
  // dropped shown as chips rather than left in the name.
  c.el.stem.textContent = clean_label(c.stem);
  c.el.stem.title = c.stem;
  // A pill each: slot keeps `(USA, Europe)` as one tag so it never claims two releases, but as
  // chips they read as the regions covered.
  const tags = label_tags(c.stem)
    .flatMap((group) => group.split(','))
    .map((tag) => tag.trim())
    .filter(Boolean);
  c.el.tags.replaceChildren(
    ...tags.map((tag) => Object.assign(document.createElement('span'), { className: 'chip', textContent: tag })),
  );
  c.el.hue.addEventListener('input', () => {
    // The well gives back "#rrggbb"; that colour is the label's deep corner, and the pale one is
    // derived from it, so one pick describes the whole ground.
    c.deep = fromHex(c.el.hue.value);
    c.userHue = true;
    schedulePaint(c);
  });
  c.el.reject.addEventListener('click', () => (c.rejected ? restore(c) : openFinder(c)));
  c.el.drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    c.el.drop.classList.add('over');
  });
  c.el.drop.addEventListener('dragleave', () => c.el.drop.classList.remove('over'));
  c.el.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    c.el.drop.classList.remove('over');
    takeLogo(c, e.dataTransfer.files[0]);
  });
  c.el.pickLogo.addEventListener('change', () => {
    const file = c.el.pickLogo.files[0];
    // An input fires no change when handed the file it already holds, so it lets go of it here.
    c.el.pickLogo.value = '';
    takeLogo(c, file);
  });
  return root;
}

// A slider fires faster than a label recomposes, so paints are coalesced to one per frame.
const queued = new Set();
function schedulePaint(c) {
  if (queued.has(c)) return;
  queued.add(c);
  requestAnimationFrame(() => {
    queued.delete(c);
    paint(c);
  });
}

function paint(c) {
  if (fatal) return;
  const state = stateOf(c);
  const { root, canvas, game, status, hue, hueRow, reject, drop } = c.el;
  root.dataset.state = state;
  // The button opens the picker on the label's deep corner, which comes from stop_colours so the
  // house numbers live in src/label.rs alone. The pale corner is derived from it in Rust when the
  // label is composed, so there is nothing to work out here.
  const deep = c.deep ?? Array.from(stopsOf(c)).slice(0, 3);
  let face = null;
  if (state === 'has-label') face = c.existing;
  if (state === 'ready') {
    try {
      face = withLabel(activeLogo(c), deep, (label) => label.face(c.platform, c.code, c.stem));
    } catch (e) {
      if (trapped(e)) return;
      throw e;
    }
  }
  canvas.hidden = !face;
  if (face) {
    const pixels = new Uint8ClampedArray(face.buffer, face.byteOffset, face.byteLength);
    canvas.getContext('2d').putImageData(new ImageData(pixels, faceW, faceH), 0, 0);
  }
  drop.hidden = state !== 'needs-logo';
  hueRow.hidden = state !== 'ready';
  hue.value = hex(deep);
  reject.hidden = !c.game || !['ready', 'needs-logo'].includes(state);
  reject.textContent = c.rejected ? 'Restore the Match' : 'Wrong Game';
  game.textContent = describe(c, state);
  status.textContent = statusText(c);
  updateWriteBar();
}

// The finder: one dialog for both ways out of a wrong match, naming the right game or handing
// the cart a logo yourself. It owns no state — picking dresses the cart and repaints it.
let finding = null;

function openFinder(c) {
  finding = c;
  $('finder-cart').textContent = clean_label(c.stem);
  $('finder-query').value = '';
  $('finder-results').replaceChildren();
  $('finder-note').textContent = c.game ? `Matched ${c.game}` : 'No match in the database.';
  $('finder').showModal();
  $('finder-query').focus();
}

function findGames() {
  const c = finding;
  if (!c) return;
  const query = $('finder-query').value;
  const db = dats.get(c.platform);
  if (!db) {
    $('finder-note').textContent = `The ${c.platform} database has not loaded.`;
    return;
  }
  const hits = db.search(query, 30);
  $('finder-results').replaceChildren(
    ...hits.map((name) => {
      const button = Object.assign(document.createElement('button'), {
        type: 'button',
        textContent: name,
      });
      button.addEventListener('click', () => track(chooseGame(c, name)));
      return Object.assign(document.createElement('li'), {}).appendChild(button).parentElement;
    }),
  );
  $('finder-note').textContent =
    query.trim() && hits.length === 0 ? `Nothing in the database matches “${query.trim()}”.` : '';
}

// A game named by hand is dressed exactly as a matched one, so its logo, box art hue and the
// clash rule all apply. The CRC keeps whatever it said; the name is what the label follows.
async function chooseGame(c, name) {
  $('finder').close();
  const s = session;
  c.game = name;
  c.rejected = false;
  c.snapshot = null;
  c.droppedBytes = null;
  c.logoBytes = null;
  c.looking = true;
  paint(c);
  try {
    await dress(s, c);
  } catch (e) {
    if (!trapped(e)) throw e;
  }
  if (s !== session) return;
  c.looking = false;
  paint(c);
}

// A CRC can be right about the bytes and wrong about what the user meant: a ROM renamed to
// another game's name. Rejecting drops the match, its logo and its box art hue.
function reject(c) {
  c.snapshot = { deep: c.deep, userHue: c.userHue, droppedBytes: c.droppedBytes };
  c.rejected = true;
  c.droppedBytes = null;
  c.userHue = false;
  c.deep = null;
  schedulePaint(c);
}

function restore(c) {
  Object.assign(c, c.snapshot, { rejected: false, snapshot: null });
  schedulePaint(c);
}

async function takeLogo(c, file) {
  if (!file) return;
  let bytes = null;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    if (fatal) return;
    if (!readable(bytes)) bytes = null;
  } catch (e) {
    if (trapped(e)) return;
    bytes = null;
  }
  if (!bytes) {
    c.el.status.textContent = `${file.name} is not a PNG this studio can read`;
    return;
  }
  c.droppedBytes = bytes;
  // A dropped logo decides which way its ground goes the same way a fetched one does.
  c.logoLuma = logo_luma(bytes);
  if (!c.userHue) c.deep = null;
  schedulePaint(c);
}

function progress(done, total, stem, verb = 'Reading') {
  $('progress').hidden = done >= total;
  $('bar').max = total;
  $('bar').value = done;
  $('progress-text').textContent = stem ? `${verb} ${done + 1} of ${total}: ${stem}` : '';
}

function banner(text, retry) {
  const b = $('banner');
  b.replaceChildren(text);
  if (retry) {
    const button = Object.assign(document.createElement('button'), {
      type: 'button',
      className: 'btn ghost',
      textContent: 'Retry',
    });
    button.addEventListener('click', retry);
    b.append(' ', button);
  }
  b.hidden = false;
}

async function open(source) {
  if (fatal) {
    banner(FATAL);
    return;
  }
  session = { source, carts: source.carts.map(newCart) };
  $('banner').hidden = true;
  // A card opened mid-scan replaces identify()'s loop before it reaches progress(total, total, ''),
  // so the old bar has to be cleared here rather than left for a call that may never come.
  $('progress').hidden = true;
  $('progress-text').textContent = '';
  $('summary').textContent = '';
  $('grid').replaceChildren(...session.carts.map(buildCard));
  session.carts.forEach(paint);
  showPlatform(platformsOf(session)[0] ?? PLATFORMS[0]);
  // The card is chosen, so the chooser goes: the write bar sits in its place, once there is
  // something to write. updateWriteBar, reached through paint, is what shows it.
  $('pick').hidden = true;
  $('pick-files-label').hidden = true;
  $('write-bar').hidden = true;
  if (session.carts.length === 0) {
    banner('There are no .gba files in that card’s Games folder.');
    return;
  }
  track(identify(session));
}

async function crcOf(file) {
  const crc = new Crc32();
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc.finish();
    crc.update(value);
  }
}

async function identify(s) {
  const total = s.carts.length;
  for (const [i, c] of s.carts.entries()) {
    if (s !== session || fatal) return;
    progress(i, total, c.stem);
    try {
      const file = await c.file();
      // Only a GBA rom carries a game code. On a Game Boy cart 0xAC is inside the RST vectors,
      // so a code read from there is opcode bytes dressed up as one.
      c.code =
        c.platform === 'GBA'
          ? header_code(new Uint8Array(await file.slice(0, HEAD).arrayBuffer()))
          : '';
      const label = s.source.labels.get(labelKey(c.platform, c.stem));
      if (label) {
        const bytes = new Uint8Array(await (await label()).arrayBuffer());
        c.existing = existing_face(bytes, c.platform, c.code, c.stem);
      } else {
        c.crc = await crcOf(file);
      }
    } catch (e) {
      if (trapped(e)) return;
      c.error = `Could not read this ROM: ${e.message}`;
    }
    paint(c);
  }
  // A card opened during the last read has its own bar up by now.
  if (s !== session) return;
  progress(total, total, '');
  await match(s);
}

async function match(s) {
  // One database per platform, fetched only for the platforms this card actually holds: a card
  // of nothing but GBA carts never pays for the two Game Boy databases.
  for (const platform of new Set(s.carts.map((c) => c.platform))) {
    if (dats.has(platform)) continue;
    try {
      dats.set(platform, Dat.parse(await fetchDat(platform)));
    } catch (e) {
      if (trapped(e) || s !== session || fatal) return;
      banner(
        `The ${platform} database didn’t load (${e.message}), so carts can’t be matched yet. Logos can still be dropped in by hand.`,
        () => track(match(s)),
      );
      for (const c of s.carts) {
        if (c.looking) {
          c.looking = false;
          paint(c);
        }
      }
      return;
    }
  }
  if (s !== session || fatal) return;
  $('banner').hidden = true;
  const pending = s.carts.filter((c) => c.crc !== null && !c.game && !c.existing && !c.error);
  await Promise.all(pending.map((c) => art(s, c)));
}

async function art(s, c) {
  c.looking = true;
  paint(c);
  try {
    c.game = dats.get(c.platform)?.game_for(c.crc) ?? null;
    await dress(s, c);
  } catch (e) {
    if (trapped(e)) return;
    throw e;
  }
  c.looking = false;
  paint(c);
}

// Fetch what `c.game` names and let it decide the cart's hue. The finder re-runs this for a game
// chosen by hand, so a chosen match is dressed exactly the way a matched one is.
async function dress(s, c) {
  if (!c.game) return;
  const name = thumbnail_name(c.game);
  // The queue is shared, so a card replaced while its jobs wait gives up their turns without
  // a request instead of making the new card wait behind its downloads.
  const thumb = (folder) =>
    limit(async () =>
      s === session && !fatal ? fetchThumb(c.platform, folder, name, stub_target) : null,
    ).catch(noImage);
  const [logo, box] = await Promise.all([thumb('Named_Logos'), thumb('Named_Boxarts')]);
  if (s !== session || fatal) return;
  c.boxHue = box ? (box_hue(box) ?? null) : null;
  c.logoBytes = logo && readable(logo) ? logo : null;
  // How bright the logo is decides which way its ground goes, so it is measured with the logo.
  c.logoLuma = c.logoBytes ? logo_luma(c.logoBytes) : 255;
  if (!c.userHue) c.deep = null;
}

// The platforms this card actually holds, in the order slot switches shelves through.
const platformsOf = (s) => PLATFORMS.filter((p) => s.carts.some((c) => c.platform === p));

// A tab per platform on the card, with what it holds. One platform is no choice at all, so a
// card of nothing but GBA carts shows no switcher and reads exactly as it did before.
function renderTabs() {
  const s = session;
  const present = platformsOf(s);
  $('tabs').hidden = present.length < 2;
  $('tabs').replaceChildren(
    ...present.map((p) => {
      const n = s.carts.filter((c) => c.platform === p).length;
      const tab = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'btn ghost',
        textContent: `${p} (${n})`,
      });
      tab.setAttribute('aria-pressed', String(p === s.platform));
      tab.addEventListener('click', () => showPlatform(p));
      return tab;
    }),
  );
}

// Switching hides the other shelves rather than rebuilding the grid: a cart keeps its canvas, its
// chosen colour and any logo dropped on it, so coming back to a tab finds it as it was left.
function showPlatform(p) {
  session.platform = p;
  for (const c of session.carts) c.el.root.hidden = c.platform !== p;
  renderTabs();
}

function updateWriteBar() {
  if (!session) return;
  const n = readyCarts().length;
  const noun = n === 1 ? 'label' : 'labels';
  // Nothing to write means no bar at all, except while a finished run's summary is still on it.
  $('write-bar').hidden = n === 0 && !$('summary').textContent;
  $('write').disabled = n === 0 || writing || fatal;
  $('write').textContent = session.source.direct
    ? `Write ${n} ${noun} to the card`
    : `Download ${n} ${noun} as a zip`;
}

function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function writeLabels() {
  const s = session;
  const carts = readyCarts();
  if (!carts.length || writing || fatal) return;
  writing = true;
  updateWriteBar();
  try {
    if (s.source.direct) {
      const count = { written: 0, skipped: 0, failed: 0 };
      for (const c of carts) {
        if (fatal) return;
        let face = null;
        try {
          const [png, drawn] = withLabel(activeLogo(c), c.deep ?? baseDeep(c), (label) => [
            label.png(),
            label.face(c.platform, c.code, c.stem),
          ]);
          face = drawn;
          c.result = await s.source.write(c.platform, c.stem, png);
        } catch (e) {
          if (trapped(e)) return;
          console.error(c.stem, e);
          c.result = 'failed';
        }
        if (c.result === 'written') c.existing = face;
        count[c.result]++;
        paint(c);
      }
      // A card opened while this one was writing has its own summary, which this must not replace.
      if (s === session) {
        $('summary').textContent = `${count.written} written, ${count.skipped} skipped, ${count.failed} failed.`;
      }
    } else {
      const zip = new Zip();
      // Each entry is taken out of WASM memory as soon as it is added, so the card's labels pile
      // up here, where memory is given back, and not in the module.
      const parts = [];
      const total = carts.length;
      for (const [i, c] of carts.entries()) {
        progress(i, total, c.stem, 'Packing');
        zip.add(
          `Labels/${c.platform}/${c.stem}.png`,
          withLabel(activeLogo(c), c.deep ?? baseDeep(c), (label) => label.png()),
        );
        parts.push(zip.take());
        // Packing a few hundred carts is seconds of synchronous work with nothing on screen, so
        // give the tab a turn every few carts to paint the bar above and take input.
        if (i % 4 === 3) {
          await new Promise((r) => setTimeout(r, 0));
          // A trap elsewhere, or a card replacing this one, can happen while this awaits.
          if (fatal || s !== session) return;
        }
      }
      parts.push(zip.finish());
      download(new Blob(parts, { type: 'application/zip' }), 'labels.zip');
      if (s === session) {
        const noun = carts.length === 1 ? 'label' : 'labels';
        $('summary').textContent = `${carts.length} ${noun} in labels.zip. Unzip it at the top of your card.`;
      }
    }
  } catch (e) {
    if (!trapped(e)) throw e;
  } finally {
    writing = false;
    updateWriteBar();
    // The zip path's loop can return early, before its own final progress() call, leaving the
    // bar stuck on a stale count — the same failure mode open() already guards against for a
    // reopened card. Only clear it if this is still the session it was showing progress for; a
    // card opened since owns the bar now, and trapped() already hid it if this run went fatal.
    if (s === session) $('progress').hidden = true;
  }
}

async function start() {
  await init();
  [faceW, faceH] = cart_size();
  const direct = 'showDirectoryPicker' in window;
  $('pick').hidden = !direct;
  $('pick-files-label').hidden = direct;
  // Writing in place needs no explaining; the zip the other browsers fall back to does.
  $('mode').hidden = direct;
  if (!direct) {
    $('mode').textContent =
      'This browser can’t write back to the SD card. You will have to copy the contents of a zip file to the Labels folder.';
  }

  $('pick').addEventListener('click', async () => {
    let root;
    try {
      root = await window.showDirectoryPicker({ id: 'slot-card', mode: 'readwrite' });
    } catch (e) {
      if (e.name !== 'AbortError') banner(e.message);
      return;
    }
    try {
      await open(await fromDirectory(root));
    } catch (e) {
      banner(e.message);
    }
  });
  $('pick-files').addEventListener('change', async (e) => {
    // Emptied at once, or choosing the same card again fires no change. The FileList belongs to
    // the input, so the files are copied out of it first.
    const files = [...e.target.files];
    e.target.value = '';
    try {
      await open(fromFiles(files));
    } catch (err) {
      banner(err.message);
    }
  });
  $('write').addEventListener('click', () => track(writeLabels()));

  $('finder-query').addEventListener('input', findGames);
  $('finder').addEventListener('close', () => {
    finding = null;
  });
  const takeFromFinder = (file) => {
    const c = finding;
    if (!c || !file) return;
    $('finder').close();
    track(takeLogo(c, file));
  };
  $('finder-file').addEventListener('change', (e) => {
    const [file] = e.target.files;
    e.target.value = '';
    takeFromFinder(file);
  });
  $('finder-drop').addEventListener('dragover', (e) => {
    e.preventDefault();
    $('finder-drop').classList.add('over');
  });
  $('finder-drop').addEventListener('dragleave', () => $('finder-drop').classList.remove('over'));
  $('finder-drop').addEventListener('drop', (e) => {
    e.preventDefault();
    $('finder-drop').classList.remove('over');
    takeFromFinder(e.dataTransfer.files[0]);
  });

  // For tools/verify.py, which has no native picker to click. Never set on the published site.
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    window.__studio = {
      openFiles: (files) => open(fromFiles(files)),
      idle: () =>
        busy === 0 && session !== null && session.carts.every((c) => stateOf(c) !== 'looking'),
      states: () =>
        session
          ? session.carts.map((c) => ({
              platform: c.platform,
              stem: c.stem,
              state: stateOf(c),
              game: c.game,
              deep: hex(c.deep ?? baseDeep(c)),
            }))
          : [],
    };
  }
  document.body.dataset.ready = 'true';
}

start();

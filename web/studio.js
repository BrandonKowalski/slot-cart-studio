// slot cart studio. Everything that needs a browser lives here: the card, the network and the page.
// Everything that decides what a label looks like is Rust, in pkg/.

import init, {
  Crc32,
  Dat,
  Label,
  Zip,
  box_hue,
  cart_size,
  existing_face,
  fallback_hue,
  header_code,
  stub_target,
  thumbnail_name,
} from './pkg/slot_cart_studio.js';
import { fromDirectory, fromFiles } from './card.js';
import { fetchDat, fetchThumb, limiter } from './libretro.js';

const $ = (id) => document.getElementById(id);
const limit = limiter(4);
// The game code sits at 0xAC; nothing past the header is needed to read it.
const HEAD = 0xb0;

let faceW = 0;
let faceH = 0;
let dat = null;
let session = null;
let busy = 0;
let writing = false;

const track = (promise) => {
  busy++;
  return promise.finally(() => {
    busy--;
  });
};

function newCart({ stem, file }) {
  return {
    stem,
    file,
    code: '',
    crc: null,
    game: null,
    logo: null,
    dropped: null,
    rejected: false,
    snapshot: null,
    boxHue: null,
    hue: fallback_hue(stem),
    userHue: false,
    existing: null,
    error: null,
    result: null,
    looking: true,
    el: null,
  };
}

const activeLabel = (c) => c.dropped ?? (c.rejected ? null : c.logo);

function stateOf(c) {
  if (c.error) return 'error';
  if (c.existing) return 'has-label';
  if (c.looking) return 'looking';
  return activeLabel(c) ? 'ready' : 'needs-logo';
}

// The box art belongs to the matched game, so its hue only stands while the match does.
const baseHue = (c) =>
  c.game && !c.rejected && c.boxHue !== null ? c.boxHue : fallback_hue(c.stem);

const readyCarts = () =>
  session ? session.carts.filter((c) => stateOf(c) === 'ready' && c.result !== 'skipped') : [];

function describe(c, state) {
  switch (state) {
    case 'looking':
      return c.crc === null ? 'Reading the ROM…' : 'Looking it up…';
    case 'error':
      return c.error;
    case 'has-label':
      return c.result === 'written' ? 'Label written to the card' : 'Already has a label';
    default:
      if (c.rejected) return `Not ${c.game}`;
      if (!c.game) return dat ? 'Not in the No-Intro database' : 'The game database has not loaded';
      return c.logo || c.dropped ? c.game : `${c.game}: libretro has no logo for it`;
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
  c.el.stem.textContent = c.stem;
  c.el.hue.addEventListener('input', () => {
    c.hue = Number(c.el.hue.value);
    c.userHue = true;
    schedulePaint(c);
  });
  c.el.reject.addEventListener('click', () => (c.rejected ? restore(c) : reject(c)));
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
  c.el.pickLogo.addEventListener('change', () => takeLogo(c, c.el.pickLogo.files[0]));
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
  const state = stateOf(c);
  const { root, canvas, game, status, hue, hueRow, reject, drop } = c.el;
  root.dataset.state = state;
  let face = null;
  if (state === 'has-label') face = c.existing;
  if (state === 'ready') {
    const label = activeLabel(c);
    if (label.hue() !== c.hue) label.set_hue(c.hue);
    face = label.face(c.code, c.stem);
  }
  canvas.hidden = !face;
  if (face) {
    const pixels = new Uint8ClampedArray(face.buffer, face.byteOffset, face.byteLength);
    canvas.getContext('2d').putImageData(new ImageData(pixels, faceW, faceH), 0, 0);
  }
  drop.hidden = state !== 'needs-logo';
  hueRow.hidden = state !== 'ready';
  hue.value = String(c.hue);
  reject.hidden = !c.game || !['ready', 'needs-logo'].includes(state);
  reject.textContent = c.rejected ? 'Restore the match' : 'Wrong game';
  game.textContent = describe(c, state);
  status.textContent = statusText(c);
  updateWriteBar();
}

// A CRC can be right about the bytes and wrong about what the user meant: a ROM renamed to
// another game's name. Rejecting drops the match, its logo and its box art hue.
function reject(c) {
  c.snapshot = { hue: c.hue, userHue: c.userHue, dropped: c.dropped };
  c.rejected = true;
  c.dropped = null;
  c.userHue = false;
  c.hue = baseHue(c);
  schedulePaint(c);
}

function restore(c) {
  Object.assign(c, c.snapshot, { rejected: false, snapshot: null });
  schedulePaint(c);
}

async function takeLogo(c, file) {
  if (!file) return;
  let label;
  try {
    label = new Label(new Uint8Array(await file.arrayBuffer()), c.userHue ? c.hue : baseHue(c));
  } catch {
    c.el.status.textContent = `${file.name} is not a PNG this studio can read`;
    return;
  }
  c.dropped = label;
  if (!c.userHue) c.hue = baseHue(c);
  schedulePaint(c);
}

function progress(done, total, stem) {
  $('progress').hidden = done >= total;
  $('bar').max = total;
  $('bar').value = done;
  $('progress-text').textContent = stem ? `Reading ${done + 1} of ${total}: ${stem}` : '';
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
  session = { source, carts: source.carts.map(newCart) };
  $('banner').hidden = true;
  // A card opened mid-scan replaces identify()'s loop before it reaches progress(total, total, ''),
  // so the old bar has to be cleared here rather than left for a call that may never come.
  $('progress').hidden = true;
  $('progress-text').textContent = '';
  $('summary').textContent = '';
  $('grid').replaceChildren(...session.carts.map(buildCard));
  session.carts.forEach(paint);
  $('write-bar').hidden = session.carts.length === 0;
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
    if (s !== session) return;
    progress(i, total, c.stem);
    try {
      const file = await c.file();
      c.code = header_code(new Uint8Array(await file.slice(0, HEAD).arrayBuffer()));
      const label = s.source.labels.get(c.stem.normalize('NFC'));
      if (label) {
        const bytes = new Uint8Array(await (await label()).arrayBuffer());
        c.existing = existing_face(bytes, c.code, c.stem);
      } else {
        c.crc = await crcOf(file);
      }
    } catch (e) {
      c.error = `Could not read this ROM: ${e.message}`;
    }
    paint(c);
  }
  progress(total, total, '');
  await match(s);
}

async function match(s) {
  if (!dat) {
    try {
      dat = Dat.parse(await fetchDat());
    } catch (e) {
      if (s !== session) return;
      banner(
        `The game database didn’t load (${e.message}), so carts can’t be matched yet. Logos can still be dropped in by hand.`,
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
  if (s !== session) return;
  $('banner').hidden = true;
  const pending = s.carts.filter((c) => c.crc !== null && !c.game && !c.existing && !c.error);
  await Promise.all(pending.map((c) => art(s, c)));
}

async function art(s, c) {
  c.looking = true;
  paint(c);
  c.game = dat.game_for(c.crc) ?? null;
  if (c.game) {
    const name = thumbnail_name(c.game);
    const [logo, box] = await Promise.all([
      limit(() => fetchThumb('Named_Logos', name, stub_target)).catch(() => null),
      limit(() => fetchThumb('Named_Boxarts', name, stub_target)).catch(() => null),
    ]);
    if (s !== session) return;
    c.boxHue = box ? (box_hue(box) ?? null) : null;
    if (!c.userHue) c.hue = baseHue(c);
    if (logo) {
      try {
        c.logo = new Label(logo, c.hue);
      } catch {
        c.logo = null;
      }
    }
  }
  c.looking = false;
  paint(c);
}

function updateWriteBar() {
  if (!session) return;
  const n = readyCarts().length;
  const noun = n === 1 ? 'label' : 'labels';
  $('write').disabled = n === 0 || writing;
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
  if (!carts.length || writing) return;
  writing = true;
  updateWriteBar();
  try {
    if (s.source.direct) {
      const count = { written: 0, skipped: 0, failed: 0 };
      for (const c of carts) {
        const label = activeLabel(c);
        try {
          c.result = await s.source.write(c.stem, label.png());
        } catch (e) {
          console.error(c.stem, e);
          c.result = 'failed';
        }
        if (c.result === 'written') c.existing = label.face(c.code, c.stem);
        count[c.result]++;
        paint(c);
      }
      $('summary').textContent = `${count.written} written, ${count.skipped} skipped, ${count.failed} failed.`;
    } else {
      const zip = new Zip();
      for (const c of carts) zip.add(`Labels/${c.stem}.png`, activeLabel(c).png());
      download(new Blob([zip.finish()], { type: 'application/zip' }), 'labels.zip');
      const noun = carts.length === 1 ? 'label' : 'labels';
      $('summary').textContent = `${carts.length} ${noun} in labels.zip. Unzip it at the top of your card.`;
    }
  } finally {
    writing = false;
    updateWriteBar();
  }
}

async function start() {
  await init();
  [faceW, faceH] = cart_size();
  const direct = 'showDirectoryPicker' in window;
  $('pick').hidden = !direct;
  $('pick-files-label').hidden = direct;
  $('mode').textContent = direct
    ? 'Labels are written straight into Labels/ on the card. A cart that already has one is left alone.'
    : 'This browser can’t write to the card, so the labels come as a zip to unzip at its top. Chrome and Edge write them in place.';

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
    try {
      await open(fromFiles(e.target.files));
    } catch (err) {
      banner(err.message);
    }
  });
  $('write').addEventListener('click', () => track(writeLabels()));

  // For tools/verify.py, which has no native picker to click. Never set on the published site.
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    window.__studio = {
      openFiles: (files) => open(fromFiles(files)),
      idle: () =>
        busy === 0 && session !== null && session.carts.every((c) => stateOf(c) !== 'looking'),
      states: () =>
        session
          ? session.carts.map((c) => ({ stem: c.stem, state: stateOf(c), game: c.game, hue: c.hue }))
          : [],
    };
  }
  document.body.dataset.ready = 'true';
}

start();

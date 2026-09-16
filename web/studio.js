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
const FATAL = 'The studio ran out of memory or hit an internal error. Reload the page to start again.';

let faceW = 0;
let faceH = 0;
let dat = null;
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

function newCart({ stem, file }) {
  return {
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
    hue: fallback_hue(stem),
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
const baseHue = (c) =>
  c.game && !c.rejected && c.boxHue !== null ? c.boxHue : fallback_hue(c.stem);

const readyCarts = () =>
  session ? session.carts.filter((c) => stateOf(c) === 'ready' && c.result !== 'skipped') : [];

// A Label holds its 1280x640 composition in WASM memory, which never shrinks and stops at 4 GiB.
// One kept per cart runs a big card out of it, so a Label lives only for the call that needs it.
function withLabel(bytes, hue, use) {
  const label = new Label(bytes, hue);
  try {
    return use(label);
  } finally {
    label.free();
  }
}

// Whether slot's decoder takes a logo, asked the only way the module can be asked: by making one.
function readable(bytes) {
  try {
    withLabel(bytes, 0, () => {});
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
      return c.result === 'written' ? 'Label written to the card' : 'Already has a label';
    default:
      if (c.rejected) return `Not ${c.game}`;
      if (!c.game) return dat ? 'Not in the No-Intro database' : 'The game database has not loaded';
      return c.logoBytes || c.droppedBytes ? c.game : `${c.game}: libretro has no logo for it`;
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
  if (fatal) return;
  const state = stateOf(c);
  const { root, canvas, game, status, hue, hueRow, reject, drop } = c.el;
  root.dataset.state = state;
  let face = null;
  if (state === 'has-label') face = c.existing;
  if (state === 'ready') {
    try {
      face = withLabel(activeLogo(c), c.hue, (label) => label.face(c.code, c.stem));
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
  c.snapshot = { hue: c.hue, userHue: c.userHue, droppedBytes: c.droppedBytes };
  c.rejected = true;
  c.droppedBytes = null;
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
    if (s !== session || fatal) return;
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
      if (trapped(e)) return;
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
      if (trapped(e) || s !== session || fatal) return;
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
  if (s !== session || fatal) return;
  $('banner').hidden = true;
  const pending = s.carts.filter((c) => c.crc !== null && !c.game && !c.existing && !c.error);
  await Promise.all(pending.map((c) => art(s, c)));
}

async function art(s, c) {
  c.looking = true;
  paint(c);
  try {
    c.game = dat.game_for(c.crc) ?? null;
    if (c.game) {
      const name = thumbnail_name(c.game);
      const [logo, box] = await Promise.all([
        limit(() => fetchThumb('Named_Logos', name, stub_target)).catch(noImage),
        limit(() => fetchThumb('Named_Boxarts', name, stub_target)).catch(noImage),
      ]);
      if (s !== session || fatal) return;
      c.boxHue = box ? (box_hue(box) ?? null) : null;
      if (!c.userHue) c.hue = baseHue(c);
      c.logoBytes = logo && readable(logo) ? logo : null;
    }
  } catch (e) {
    if (trapped(e)) return;
    throw e;
  }
  c.looking = false;
  paint(c);
}

function updateWriteBar() {
  if (!session) return;
  const n = readyCarts().length;
  const noun = n === 1 ? 'label' : 'labels';
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
          const [png, drawn] = withLabel(activeLogo(c), c.hue, (label) => [
            label.png(),
            label.face(c.code, c.stem),
          ]);
          face = drawn;
          c.result = await s.source.write(c.stem, png);
        } catch (e) {
          if (trapped(e)) return;
          console.error(c.stem, e);
          c.result = 'failed';
        }
        if (c.result === 'written') c.existing = face;
        count[c.result]++;
        paint(c);
      }
      $('summary').textContent = `${count.written} written, ${count.skipped} skipped, ${count.failed} failed.`;
    } else {
      const zip = new Zip();
      // Each entry is taken out of WASM memory as soon as it is added, so the card's labels pile
      // up here, where memory is given back, and not in the module.
      const parts = [];
      for (const c of carts) {
        zip.add(`Labels/${c.stem}.png`, withLabel(activeLogo(c), c.hue, (label) => label.png()));
        parts.push(zip.take());
      }
      parts.push(zip.finish());
      download(new Blob(parts, { type: 'application/zip' }), 'labels.zip');
      const noun = carts.length === 1 ? 'label' : 'labels';
      $('summary').textContent = `${carts.length} ${noun} in labels.zip. Unzip it at the top of your card.`;
    }
  } catch (e) {
    if (!trapped(e)) throw e;
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

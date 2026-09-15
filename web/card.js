// A card, however the browser opened it. Chrome and Edge hand over a directory handle that can
// be written to. Everything else hands over a flat list of files with their paths, which can only
// be read, so the labels leave as a zip instead.

// slot's own rule, from slot-store's scan.rs: a .gba in any case, never a dotfile. macOS leaves
// `._` sidecars beside what it copies onto a card, extension and all.
const isCart = (name) => !name.startsWith('.') && name.toLowerCase().endsWith('.gba');
const isLabel = (name) => !name.startsWith('.') && name.toLowerCase().endsWith('.png');
const stemOf = (name) => name.slice(0, -4);
// macOS lists exFAT names decomposed, whatever form was written, so names are compared composed.
// What gets written is still the listing's own spelling.
const key = (stem) => stem.normalize('NFC');
const byStem = (a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0);
const NO_GAMES = 'There is no Games folder there. Choose the top of your slot SD card.';

export async function fromDirectory(root) {
  let games;
  try {
    games = await root.getDirectoryHandle('Games');
  } catch {
    throw new Error(NO_GAMES);
  }
  const carts = [];
  for await (const [name, handle] of games.entries()) {
    if (handle.kind === 'file' && isCart(name)) {
      carts.push({ stem: stemOf(name), file: () => handle.getFile() });
    }
  }
  const labels = new Map();
  try {
    const dir = await root.getDirectoryHandle('Labels');
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && isLabel(name)) labels.set(key(stemOf(name)), () => handle.getFile());
    }
  } catch {
    // No Labels folder yet: every cart needs a label.
  }
  return {
    carts: carts.sort(byStem),
    labels,
    direct: true,
    async write(stem, bytes) {
      const dir = await root.getDirectoryHandle('Labels', { create: true });
      const name = `${stem}.png`;
      try {
        await dir.getFileHandle(name);
        return 'skipped';
      } catch (e) {
        if (e.name !== 'NotFoundError') throw e;
      }
      const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await out.write(bytes);
      await out.close();
      return 'written';
    },
  };
}

export function fromFiles(files) {
  const carts = [];
  const labels = new Map();
  let sawGames = false;
  for (const file of files) {
    // The picked folder, then Games or Labels, then the file. Anything deeper is not slot's.
    const parts = file.webkitRelativePath.split('/');
    if (parts.length !== 3) continue;
    const [, dir, name] = parts;
    if (dir.toLowerCase() === 'games') {
      sawGames = true;
      if (isCart(name)) carts.push({ stem: stemOf(name), file: async () => file });
    } else if (dir.toLowerCase() === 'labels' && isLabel(name)) {
      labels.set(key(stemOf(name)), async () => file);
    }
  }
  if (!sawGames) throw new Error(NO_GAMES);
  return { carts: carts.sort(byStem), labels, direct: false, write: null };
}

// libretro's GBA database and thumbnails, both from raw.githubusercontent.com, which answers
// cross-origin requests. thumbnails.libretro.com does not.

const DAT = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/Nintendo%20-%20Game%20Boy%20Advance.dat';
const THUMBS = 'https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Game_Boy_Advance/master/';

export async function fetchDat() {
  const r = await fetch(DAT);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// A card can hold hundreds of carts, each wanting two images, and GitHub is not a CDN.
export function limiter(slots) {
  let running = 0;
  const waiting = [];
  const pump = () => {
    while (running < slots && waiting.length) {
      const { job, resolve, reject } = waiting.shift();
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          pump();
        });
    }
  };
  return (job) =>
    new Promise((resolve, reject) => {
      waiting.push({ job, resolve, reject });
      pump();
    });
}

// A thumbnail's bytes, or null when libretro has none. A git symlink comes back as a one-line
// body naming its target in the same folder; `stubTarget`, from the Rust side, tells the two apart.
export async function fetchThumb(folder, name, stubTarget) {
  const get = async (file) => {
    const r = await fetch(`${THUMBS}${folder}/${encodeURIComponent(file)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const body = await get(`${name}.png`);
  if (!body) return null;
  const target = stubTarget(body);
  return target === undefined ? body : get(target);
}

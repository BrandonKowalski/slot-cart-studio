import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchArt } from './libretro.js';

const BASE = 'https://art.example/';

function serve(routes) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const body = routes[String(url)];
    if (typeof body === 'number') return { ok: false, status: body };
    if (!body) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  return asked;
}

const text = (bytes) => new TextDecoder().decode(bytes);

test('the webp is asked for first and the png is left alone', async () => {
  const asked = serve({ [`${BASE}GBA/wheel/AB.webp`]: 'webp', [`${BASE}GBA/wheel/AB.png`]: 'png' });
  assert.equal(text(await fetchArt(BASE, 'GBA/wheel/AB.png')), 'webp');
  assert.deepEqual(asked, [`${BASE}GBA/wheel/AB.webp`]);
});

test('a set with no webp is still read as png', async () => {
  const asked = serve({ [`${BASE}GBA/wheel/AB.png`]: 'png' });
  assert.equal(text(await fetchArt(BASE, 'GBA/wheel/AB.png')), 'png');
  assert.deepEqual(asked, [`${BASE}GBA/wheel/AB.webp`, `${BASE}GBA/wheel/AB.png`]);
});

test('art in neither format is null', async () => {
  serve({});
  assert.equal(await fetchArt(BASE, 'GBA/wheel/AB.png'), null);
});

test('a server failure on the webp is not mistaken for a missing file', async () => {
  const asked = serve({ [`${BASE}GBA/wheel/AB.webp`]: 503 });
  await assert.rejects(fetchArt(BASE, 'GBA/wheel/AB.png'), /HTTP 503/);
  assert.deepEqual(asked, [`${BASE}GBA/wheel/AB.webp`]);
});

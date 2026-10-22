import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAMES, heroPicks, heroPool, heroShell } from './hero.js';

const PRESETS = new Map([
  ['Advance charcoal', 'auto 35353a solid'],
  ['Game Boy Color clear', 'auto 7c7a8a clear'],
  ['Game Boy grey', 'auto 9a978f solid'],
  ['Game Boy black', 'auto 333031 solid'],
  ['Pokémon Ruby', 'auto c2332e clear'],
  ['Pokémon Gold', 'auto b38b3a solid'],
  ['Pokémon Crystal', 'auto 86b9bf glitter'],
  ['Pokémon Red', 'auto c0282c solid'],
]);

const INDEX = {
  DBEF116C: { 'support-texture': 'GBA/support-texture/DBEF116C.png' },
  F0815EE7: { 'support-texture': 'GBA/support-texture/F0815EE7.png' },
  EE6F5188: { 'support-texture': 'GBC/support-texture/EE6F5188.png' },
  '9F7FDD53': { wheel: 'GB/wheel/9F7FDD53.png' },
  '12345678': { 'support-texture': 'GBA/support-texture/12345678.png' },
  'pokemon-radical-red': { name: 'Pokemon Radical Red', platform: 'GBA', 'support-texture': 'GBA/support-texture/pokemon-radical-red.png' },
  'pokemon-prism': { name: 'Pokemon Prism', platform: 'GBC', wheel: 'GBC/wheel/pokemon-prism.png' },
  'pokemon-brown': { name: 'Pokemon Brown', platform: 'GB', 'support-texture': 'GB/support-texture/pokemon-brown.png' },
};

test('every listed game is an eight digit checksum, listed once', () => {
  const all = Object.values(GAMES).flat().map(([crc]) => crc);
  for (const crc of all) assert.match(crc, /^[0-9A-F]{8}$/);
  assert.equal(new Set(all).size, all.length);
});

test('the pool holds listed games and hacks with a label on their own platform, nothing else', () => {
  assert.deepEqual(heroPool(INDEX, 'GBA').map((p) => p.key), ['DBEF116C', 'F0815EE7', 'pokemon-radical-red']);
  assert.deepEqual(heroPool(INDEX, 'GBC').map((p) => p.key), ['EE6F5188']);
  assert.deepEqual(heroPool(INDEX, 'GB').map((p) => p.key), ['pokemon-brown']);
  assert.deepEqual(heroPool(null, 'GBA'), []);
});

test('mainline Pokemon carts keep their shell, everything else gets its platform plain one', () => {
  const shell = (platform, key) => heroShell(platform, heroPool(INDEX, platform).find((p) => p.key === key).preset, PRESETS);
  assert.equal(shell('GBA', 'F0815EE7'), 'auto c2332e clear');
  assert.equal(shell('GBA', 'DBEF116C'), 'auto 35353a solid');
  assert.equal(shell('GBC', 'EE6F5188'), 'rounded 86b9bf glitter');
  assert.equal(shell('GB', 'pokemon-brown'), 'notched 9a978f solid');
  assert.equal(heroShell('GBC', null, PRESETS), 'rounded 7c7a8a clear');
  assert.equal(heroShell('GBC', 'Pokémon Gold', PRESETS), 'notched b38b3a solid');
  assert.equal(heroShell('GB', 'Pokémon Red', PRESETS), 'notched c0282c solid');
});

test('one pick per platform, skipping a platform with nothing to show', () => {
  const picks = heroPicks(INDEX, () => 0.99);
  assert.deepEqual(picks.map((p) => [p.platform, p.key, p.label]), [
    ['GBA', 'pokemon-radical-red', 'GBA/support-texture/pokemon-radical-red.png'],
    ['GBC', 'EE6F5188', 'GBC/support-texture/EE6F5188.png'],
    ['GB', 'pokemon-brown', 'GB/support-texture/pokemon-brown.png'],
  ]);
  assert.deepEqual(heroPicks({}, () => 0), []);
});

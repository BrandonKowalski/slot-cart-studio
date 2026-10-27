import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extrasFrom } from './extras.js';

const INDEX = {
  '0006612D': { wheel: 'GB/wheel/0006612D.png' },
  'pokemon-crystal-clear': {
    name: 'Pokemon Crystal Clear',
    platform: 'GBC',
    aka: ['Crystal Clear'],
    crcs: ['aaaa0000'],
    wheel: 'GBC/wheel/pokemon-crystal-clear.png',
  },
  'pokemon-prism': { name: 'Pokemon Prism', platform: 'GBC', crcs: [] },
  'pokemon-radical-red': { name: 'Pokemon Radical Red', platform: 'GBA', aka: ['Radical Red'] },
  'pokemon-emerald-kaizo': { name: 'Pokemon Emerald Kaizo', platform: 'GBA' },
  'pokemon-emerald-rogue': { name: 'Pokemon Emerald Rogue', platform: 'GBA' },
  'mother-3-english': { name: 'Mother 3 (English)', platform: 'GBA', aka: ['Mother 3'] },
  '12345678': { name: 'Not a slug', platform: 'GBA' },
};

const extras = extrasFrom(INDEX);

test('an extra is found by its name and by a dump filed under it, on its own platform', () => {
  assert.equal(extras.named('GBC', 'Pokemon Crystal Clear').slug, 'pokemon-crystal-clear');
  assert.equal(extras.named('GBA', 'Pokemon Crystal Clear'), null);
  assert.equal(extras.dumped('GBC', 'AAAA0000').slug, 'pokemon-crystal-clear');
  assert.equal(extras.dumped('GBC', '0006612D'), null);
});

test('a Game Boy extra is found from either Game Boy folder, and never from the GBA one', () => {
  assert.equal(extras.named('GB', 'Pokemon Crystal Clear').slug, 'pokemon-crystal-clear');
  assert.equal(extras.dumped('GB', 'AAAA0000').slug, 'pokemon-crystal-clear');
  assert.equal(extras.guess('GB', 'Pokemon Prism').slug, 'pokemon-prism');
  assert.equal(extras.guess('GBA', 'Pokemon Prism'), null);
  assert.deepEqual(extras.search('GB', 'prism', 30), ['Pokemon Prism']);
});

test('a GBA extra is found from the Game Boy Advance Video folder too', () => {
  assert.equal(extras.named('GBAV', 'Pokemon Radical Red').slug, 'pokemon-radical-red');
  assert.equal(extras.guess('GBAV', 'Mother 3').slug, 'mother-3-english');
  assert.equal(extras.named('GBAV', 'Pokemon Crystal Clear'), null);
});

test('checksum keys and entries without a name are not extras', () => {
  assert.equal(extras.named('GBA', 'Not a slug'), null);
  assert.equal(extrasFrom(null).guess('GBA', 'anything'), null);
});

test('a file name that spells out an extra guesses it, however it is spaced or versioned', () => {
  const guess = (platform, title) => extras.guess(platform, title)?.slug ?? null;
  assert.equal(guess('GBC', 'Pokemon - Crystal Clear v2.0.4'), 'pokemon-crystal-clear');
  assert.equal(guess('GBC', 'PokemonCrystalClear'), 'pokemon-crystal-clear');
  assert.equal(guess('GBC', 'crystal_clear'), 'pokemon-crystal-clear');
  assert.equal(guess('GBC', 'Pokémon Prism 0.95'), 'pokemon-prism');
  assert.equal(guess('GBA', 'Radical Red v4.1'), 'pokemon-radical-red');
  assert.equal(guess('GBA', 'Mother 3'), 'mother-3-english');
});

test('a name that only shares a franchise with an extra guesses nothing', () => {
  assert.equal(extras.guess('GBC', 'Pokemon - Crystal Version'), null);
  assert.equal(extras.guess('GBA', 'Pokemon - Emerald Version'), null);
  assert.equal(extras.guess('GBC', 'Prism'), null);
});

test('the most specific name wins, and a tie guesses nothing', () => {
  const both = extrasFrom({
    'a-b': { name: 'Pokemon Red', platform: 'GB' },
    'a-c': { name: 'Pokemon Red Plus', platform: 'GB' },
    'a-d': { name: 'Pokemon Blue', platform: 'GB' },
  });
  assert.equal(both.guess('GB', 'Pokemon Red Plus 1.2').slug, 'a-c');
  assert.equal(both.guess('GB', 'Pokemon Red and Blue'), null);
});

test('search finds extras by any of their names, those starting with the query first', () => {
  assert.deepEqual(extras.search('GBA', 'red', 30), ['Pokemon Radical Red']);
  assert.deepEqual(extras.search('GBA', 'emerald', 30), ['Pokemon Emerald Kaizo', 'Pokemon Emerald Rogue']);
  assert.deepEqual(extras.search('GBA', 'mother', 30), ['Mother 3 (English)']);
  assert.deepEqual(extras.search('GBA', 'pokemon e', 1), ['Pokemon Emerald Kaizo']);
  assert.deepEqual(extras.search('GBA', '  ', 30), []);
});

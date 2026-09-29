import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELLS, pickShell } from './colourway.js';

test('?shell= pins a colourway by name, as it does on slot\'s site', () => {
  assert.equal(pickShell('?art=x&shell=light+blue', () => 0).name, 'light blue');
  assert.equal(pickShell('?shell=PINK', () => 0).name, 'pink');
});

test('otherwise each visit draws one of slot\'s four', () => {
  assert.deepEqual(SHELLS.map((s) => s.name), ['silver', 'pink', 'light blue', 'black']);
  assert.equal(pickShell('', () => 0.99).name, 'black');
  assert.equal(pickShell('?shell=gold', () => 0).name, 'silver');
});

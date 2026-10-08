import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromDirectory, fromFiles } from './card.js';

const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });

const dirHandle = (tree) => ({
  kind: 'directory',
  async getDirectoryHandle(name) {
    if (typeof tree[name] !== 'object') throw notFound();
    return dirHandle(tree[name]);
  },
  async getFileHandle(name) {
    if (typeof tree[name] !== 'string') throw notFound();
    return fileHandle(tree[name]);
  },
  async *entries() {
    for (const [name, value] of Object.entries(tree)) {
      yield [name, typeof value === 'object' ? dirHandle(value) : fileHandle(value)];
    }
  },
});
const fileHandle = (text) => ({ kind: 'file', getFile: async () => new File([text], 'f') });

const listed = (tree, prefix = 'card') =>
  Object.entries(tree).flatMap(([name, value]) =>
    typeof value === 'object'
      ? listed(value, `${prefix}/${name}`)
      : [Object.assign(new File([value], name), { webkitRelativePath: `${prefix}/${name}` })],
  );

const GAMES = { Games: { GBA: { 'A.gba': '' } } };
const CONFIG = 'A = rounded 112233 solid\n';
const SYSTEM = 'A = notched 445566 clear\n';
const LABELS = 'A = auto\n';

const both = async (tree) => [
  await (await fromDirectory(dirHandle(tree))).shells(),
  await fromFiles(listed(tree)).shells(),
];

test('a card slot has moved reads its shells from Config', async () => {
  for (const got of await both({ ...GAMES, Config: { 'cart_shell.ini': CONFIG }, Labels: { 'cart_shell.ini': LABELS } })) {
    assert.deepEqual(got, { system: CONFIG, labels: LABELS });
  }
});

test('a card slot has not moved yet reads its shells from System', async () => {
  for (const got of await both({ ...GAMES, System: { 'cart_shell.ini': SYSTEM } })) {
    assert.deepEqual(got, { system: SYSTEM, labels: '' });
  }
});

test('Config wins over a System file left behind', async () => {
  for (const got of await both({ ...GAMES, Config: { 'cart_shell.ini': CONFIG }, System: { 'cart_shell.ini': SYSTEM } })) {
    assert.deepEqual(got, { system: CONFIG, labels: '' });
  }
});

test('an empty Config file is still the one slot reads', async () => {
  for (const got of await both({ ...GAMES, Config: { 'cart_shell.ini': '' }, System: { 'cart_shell.ini': SYSTEM } })) {
    assert.deepEqual(got, { system: '', labels: '' });
  }
});

test('a Config folder without the file falls back to System', async () => {
  for (const got of await both({ ...GAMES, Config: {}, System: { 'cart_shell.ini': SYSTEM } })) {
    assert.deepEqual(got, { system: SYSTEM, labels: '' });
  }
});

test('a card with no shell files reads as empty', async () => {
  for (const got of await both(GAMES)) {
    assert.deepEqual(got, { system: '', labels: '' });
  }
});

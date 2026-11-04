import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dismissNotice, noticeShown } from './notice.js';

function memory() {
  const items = new Map();
  return {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => items.set(k, String(v)),
  };
}

const broken = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
};

test('the notice shows until it is dismissed', () => {
  const storage = memory();
  assert.equal(noticeShown(storage), true);
  dismissNotice(storage);
  assert.equal(noticeShown(storage), false);
});

test('storage that refuses access still shows the notice and dismissing does not throw', () => {
  assert.equal(noticeShown(broken), true);
  assert.doesNotThrow(() => dismissNotice(broken));
});

test('no storage at all still shows the notice', () => {
  assert.equal(noticeShown(undefined), true);
  assert.doesNotThrow(() => dismissNotice(undefined));
});

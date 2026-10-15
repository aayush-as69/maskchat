import test from 'node:test';
import assert from 'node:assert/strict';
import { shortHash } from './logger.js';

test('shortHash is stable, short, and one-way', () => {
  const key = 'some-identity-key';
  const first = shortHash(key);
  assert.equal(first, shortHash(key)); // deterministic
  assert.equal(first.length, 10); // truncated, not the full digest
  assert.notEqual(first, key); // never the raw value
  assert.notEqual(shortHash('a-different-key'), first);
});

test('shortHash returns null for empty input rather than hashing nothing', () => {
  assert.equal(shortHash(''), null);
  assert.equal(shortHash(null), null);
  assert.equal(shortHash(undefined), null);
});

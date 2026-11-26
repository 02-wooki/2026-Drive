import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, verifyRequest, NonceStore, sha256Hex, UNSIGNED_PAYLOAD, generateSecret, HMAC_HEADERS } from '../src/node/index.js';

const SECRET = 'x'.repeat(48);
const NOW = 1_800_000_000_000;

function roundtrip(overrides = {}, verifyOverrides = {}) {
  const headers = signRequest({ secret: SECRET, audience: 'agent', method: 'get', pathWithQuery: '/files?path=%2Fa', now: NOW, ...overrides });
  return verifyRequest({
    secret: SECRET,
    audience: 'agent',
    method: 'GET',
    pathWithQuery: '/files?path=%2Fa',
    headers,
    nonceStore: new NonceStore(),
    now: NOW,
    ...verifyOverrides,
  });
}

test('valid signature passes', () => {
  const r = roundtrip();
  assert.deepEqual(r, { ok: true, bodySha256: UNSIGNED_PAYLOAD });
});

test('signed body hash is reported', () => {
  const r = roundtrip({ body: '{"a":1}' });
  assert.equal(r.ok, true);
  assert.equal(r.bodySha256, sha256Hex('{"a":1}'));
});

test('tampering is detected', () => {
  assert.equal(roundtrip({}, { method: 'DELETE' }).reason, 'BAD_SIGNATURE');
  assert.equal(roundtrip({}, { pathWithQuery: '/files?path=%2Fb' }).reason, 'BAD_SIGNATURE');
  assert.equal(roundtrip({}, { secret: 'y'.repeat(48) }).reason, 'BAD_SIGNATURE');
  // gateway→agent 서명을 gateway 쪽 리스너에 재사용 불가
  assert.equal(roundtrip({}, { audience: 'gateway' }).reason, 'BAD_SIGNATURE');
  const h = signRequest({ secret: SECRET, audience: 'agent', method: 'GET', pathWithQuery: '/x', now: NOW });
  h[HMAC_HEADERS.contentSha256] = sha256Hex('other');
  assert.equal(
    verifyRequest({ secret: SECRET, audience: 'agent', method: 'GET', pathWithQuery: '/x', headers: h, nonceStore: new NonceStore(), now: NOW }).reason,
    'BAD_SIGNATURE',
  );
});

test('clock skew', () => {
  assert.equal(roundtrip({}, { now: NOW + 59_000 }).ok, true);
  assert.equal(roundtrip({}, { now: NOW + 61_000 }).reason, 'CLOCK_SKEW');
  assert.equal(roundtrip({}, { now: NOW - 61_000 }).reason, 'CLOCK_SKEW');
});

test('replay is rejected, nonce recorded only after valid signature', () => {
  const store = new NonceStore();
  const headers = signRequest({ secret: SECRET, audience: 'agent', method: 'GET', pathWithQuery: '/x', now: NOW });
  const args = { secret: SECRET, audience: 'agent', method: 'GET', pathWithQuery: '/x', headers, nonceStore: store, now: NOW };
  // 잘못된 서명으로 먼저 보내도 nonce 가 소모되지 않아야 한다
  assert.equal(verifyRequest({ ...args, pathWithQuery: '/y' }).reason, 'BAD_SIGNATURE');
  assert.equal(store.size, 0);
  assert.equal(verifyRequest(args).ok, true);
  assert.equal(verifyRequest(args).reason, 'REPLAY');
});

test('nonce store fails closed when full, recovers after expiry', () => {
  const store = new NonceStore({ maxEntries: 2 });
  assert.equal(store.checkAndAdd('aaaaaaaaaaaaaaaa1', NOW + 10, NOW), true);
  assert.equal(store.checkAndAdd('aaaaaaaaaaaaaaaa2', NOW + 10, NOW), true);
  assert.equal(store.checkAndAdd('aaaaaaaaaaaaaaaa3', NOW + 10, NOW), false);
  assert.equal(store.checkAndAdd('aaaaaaaaaaaaaaaa3', NOW + 30, NOW + 20), true);
});

test('key rotation: verify accepts any listed key, sign uses the first', () => {
  const oldKey = 'o'.repeat(40);
  const newKey = 'n'.repeat(40);
  const headers = signRequest({ secret: oldKey, audience: 'gateway', method: 'POST', pathWithQuery: '/internal/sync', now: NOW });
  const r = verifyRequest({ secret: [newKey, oldKey], audience: 'gateway', method: 'POST', pathWithQuery: '/internal/sync', headers, nonceStore: new NonceStore(), now: NOW });
  assert.equal(r.ok, true);
});

test('malformed headers', () => {
  const base = { secret: SECRET, audience: 'agent', method: 'GET', pathWithQuery: '/x', nonceStore: new NonceStore(), now: NOW };
  const good = signRequest({ ...base, nonceStore: undefined });
  assert.equal(verifyRequest({ ...base, headers: {} }).reason, 'MISSING_HEADER');
  assert.equal(verifyRequest({ ...base, headers: { ...good, [HMAC_HEADERS.timestamp]: '1e12' } }).reason, 'BAD_TIMESTAMP');
  assert.equal(verifyRequest({ ...base, headers: { ...good, [HMAC_HEADERS.nonce]: 'short' } }).reason, 'BAD_NONCE');
  assert.equal(verifyRequest({ ...base, headers: { ...good, [HMAC_HEADERS.signature]: [good[HMAC_HEADERS.signature]] } }).reason, 'MISSING_HEADER');
  assert.equal(verifyRequest({ ...base, headers: { ...good, [HMAC_HEADERS.contentSha256]: 'zz' } }).reason, 'BAD_CONTENT_HASH');
  // Fetch API Headers 도 지원
  assert.equal(verifyRequest({ ...base, headers: new Headers(good) }).ok, true);
});

test('short secrets are refused', () => {
  assert.throws(() => signRequest({ secret: 'short', audience: 'agent', method: 'GET', pathWithQuery: '/' }), /at least 32/);
  assert.ok(generateSecret().length >= 80);
});

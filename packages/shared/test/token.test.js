import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, TOKEN_AUDIENCE } from '../src/node/index.js';

const SECRET = 't'.repeat(40);
const NOW = 1_800_000_000_000;
const aud = TOKEN_AUDIENCE.LAN_AGENT;

test('roundtrip', () => {
  const tok = signToken({ aud, sub: 'owner', scope: 'read' }, SECRET, { now: NOW });
  const r = verifyToken(tok, SECRET, { audience: aud, now: NOW + 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.claims.sub, 'owner');
  assert.equal(r.claims.exp - r.claims.iat, 300);
});

test('expiry with skew', () => {
  const tok = signToken({ aud }, SECRET, { now: NOW, ttlSec: 60 });
  assert.equal(verifyToken(tok, SECRET, { audience: aud, now: NOW + 60_000 + 29_000 }).ok, true);
  assert.equal(verifyToken(tok, SECRET, { audience: aud, now: NOW + 60_000 + 30_000 }).reason, 'EXPIRED');
  assert.equal(verifyToken(tok, SECRET, { audience: aud, now: NOW - 31_000 }).reason, 'NOT_YET_VALID');
});

test('wrong audience / key / tampering', () => {
  const tok = signToken({ aud, role: 'guest' }, SECRET, { now: NOW });
  assert.equal(verifyToken(tok, SECRET, { audience: 'other', now: NOW }).reason, 'WRONG_AUDIENCE');
  assert.equal(verifyToken(tok, 'u'.repeat(40), { audience: aud, now: NOW }).reason, 'BAD_SIGNATURE');

  const [v, payload, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), role: 'owner' })).toString('base64url');
  assert.equal(verifyToken(`${v}.${forged}.${sig}`, SECRET, { audience: aud, now: NOW }).reason, 'BAD_SIGNATURE');
});

test('malformed', () => {
  for (const t of [null, '', 'abc', 'v2.a.b', 'v1.a', 'v1.a.b.c', 'v1.a+b.c', 'v1.' + 'a'.repeat(5000) + '.b']) {
    assert.equal(verifyToken(t, SECRET, { audience: aud, now: NOW }).ok, false, String(t).slice(0, 20));
  }
});

test('key rotation', () => {
  const tok = signToken({ aud }, 'o'.repeat(40), { now: NOW });
  assert.equal(verifyToken(tok, ['n'.repeat(40), 'o'.repeat(40)], { audience: aud, now: NOW }).ok, true);
});

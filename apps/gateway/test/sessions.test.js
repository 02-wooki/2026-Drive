import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, parseCookies, sessionCookie, cookieName } from '../src/sessions.js';
import { safeContentType } from '../src/http.js';

const user = { provider: 'github', sub: '1', nickname: 'w' };
const ttl = { absoluteMs: 10_000, idleMs: 3_000 };

test('create / get / destroy', () => {
  let t = 1000;
  const s = new SessionStore({ now: () => t });
  const { id } = s.create({ role: 'guest', user }, ttl);
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.get(id).role, 'guest');
  assert.equal(s.get('x'.repeat(43)), null);
  assert.equal(s.get('../../etc'), null);
  s.destroy(id);
  assert.equal(s.get(id), null);
});

test('idle and absolute expiry', () => {
  let t = 0;
  const s = new SessionStore({ now: () => t });
  const { id } = s.create({ role: 'guest', user }, ttl);
  t = 2_900;
  assert.ok(s.get(id)); // 활동 → 유휴 타이머 리셋
  t = 5_800;
  assert.ok(s.get(id));
  t = 8_700;
  assert.ok(s.get(id));
  t = 10_000; // 계속 활동해도 절대 만료
  assert.equal(s.get(id), null);

  const { id: id2 } = s.create({ role: 'guest', user }, ttl);
  t += 3_000;
  assert.equal(s.get(id2), null);
});

test('rotate issues a new id and kills the old one', () => {
  const s = new SessionStore();
  const { id } = s.create({ role: 'guest', user, stage: 'pending-passkey' }, ttl);
  const r = s.rotate(id, { role: 'owner', stage: undefined }, ttl);
  assert.notEqual(r.id, id);
  assert.equal(s.get(id), null);
  assert.equal(s.get(r.id).role, 'owner');
  assert.equal(s.get(r.id).user.sub, '1');
});

test('persistence stores only hashed ids', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sess-'));
  try {
    const file = path.join(dir, 'sessions', 'sessions.json');
    const a = new SessionStore({ file });
    const { id } = a.create({ role: 'owner', user }, { absoluteMs: 60_000, idleMs: 60_000 });
    await a.flush();
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(id), 'raw session id must not be written');

    const b = new SessionStore({ file });
    b.load();
    assert.equal(b.get(id).role, 'owner');

    fs.writeFileSync(file, '{broken');
    const c = new SessionStore({ file });
    c.load();
    assert.equal(c.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cookies', () => {
  assert.deepEqual(parseCookies('a=1; b=2; a=3; junk; =x'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(cookieName(true), '__Host-wd_sid');
  assert.equal(sessionCookie('abc', { secure: true }), '__Host-wd_sid=abc; Path=/; HttpOnly; SameSite=Lax; Secure');
  assert.equal(sessionCookie('', { secure: false, maxAgeSec: 0 }), 'wd_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
});

test('safeContentType', () => {
  assert.equal(safeContentType('image/png', 'inline'), 'image/png');
  assert.equal(safeContentType('video/mp4', 'inline'), 'video/mp4');
  assert.equal(safeContentType('application/pdf', 'inline'), 'application/pdf');
  assert.equal(safeContentType('text/plain', 'inline'), 'text/plain; charset=utf-8');
  assert.equal(safeContentType('text/html; charset=utf-8', 'inline'), 'text/plain; charset=utf-8');
  assert.equal(safeContentType('image/svg+xml', 'inline'), 'text/plain; charset=utf-8');
  assert.equal(safeContentType('application/xhtml+xml', 'inline'), 'text/plain; charset=utf-8');
  assert.equal(safeContentType('application/javascript', 'inline'), 'text/plain; charset=utf-8');
  assert.equal(safeContentType('application/x-msdownload', 'inline'), 'application/octet-stream');
  assert.equal(safeContentType(undefined, 'inline'), 'application/octet-stream');
  assert.equal(safeContentType('text/html', 'attachment'), 'text/html');
});

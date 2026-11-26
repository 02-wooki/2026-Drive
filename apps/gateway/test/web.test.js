// 웹 화면 정적 서빙과 개발 로그인.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toKeyList } from '@wooki-drive/shared/node';
import { createApp } from '../src/app.js';
import { SessionStore, cookieName } from '../src/sessions.js';
import { AgentClient, AgentMonitor } from '../src/agent-client.js';
import { PasskeyStore } from '../src/auth/passkeys.js';
import { PAGE_CSP } from '../src/web.js';

const ORIGIN = 'http://127.0.0.1:7400';
const HOUR = 3600_000;
let tmp, server, base, store;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-web-'));
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');

  store = new SessionStore();
  const app = createApp({
    publicOrigin: ORIGIN,
    cookieSecure: false,
    devLogin: true,
    webDist: dist,
    demoRoot: tmp,
    session: { owner: { absoluteMs: HOUR, idleMs: HOUR }, guest: { absoluteMs: HOUR, idleMs: HOUR } },
    store,
    passkeys: new PasskeyStore(),
    agent: new AgentClient({ baseUrl: 'http://127.0.0.1:9', secrets: toKeyList('z'.repeat(40)) }),
    monitor: new AgentMonitor(),
  });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('SPA routes serve index.html with strict CSP', async () => {
  for (const p of ['/', '/login', '/login/passkey', '/?loc=demo&path=%2F']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /id="root"/);
    assert.equal(r.headers.get('content-security-policy'), PAGE_CSP);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  }
  assert.match(PAGE_CSP, /script-src 'self'/);
  assert.doesNotMatch(PAGE_CSP, /unsafe-inline|unsafe-eval/);
});

test('hashed assets are immutable, unknown assets 404', async () => {
  const r = await fetch(`${base}/assets/app-abc123.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}/assets/nope.js`)).status, 404);
  assert.equal((await fetch(`${base}/favicon.svg`)).status, 200);
});

test('api and auth paths are not swallowed by the SPA fallback', async () => {
  const r = await fetch(`${base}/api/nope`);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'NOT_FOUND' });
  const a = await fetch(`${base}/auth/nope/start`);
  assert.equal(a.status, 404);
});

test('dev login (localhost only) issues a session', async () => {
  const providers = await (await fetch(`${base}/auth/providers`)).json();
  assert.equal(providers.devLogin, true);

  const post = (body, headers = { Origin: ORIGIN }) =>
    fetch(`${base}/auth/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  assert.equal((await post({ role: 'owner' }, {})).status, 403); // CSRF: Origin 없음
  assert.equal((await post({ role: 'admin' })).status, 400);

  const r = await post({ role: 'owner' });
  assert.equal(r.status, 200);
  const sid = r.headers.getSetCookie()[0].split(';')[0].split('=')[1];
  assert.equal(store.get(sid).role, 'owner');
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie: `${cookieName(false)}=${sid}` } })).json();
  assert.equal(me.user.nickname, '개발 오너');
});

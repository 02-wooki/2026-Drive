// gateway ↔ 실제 agent 앱을 함께 띄운 통합 테스트.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toKeyList } from '@wooki-drive/shared/node';
import { createApp as createAgentApp } from '../../agent/src/app.js';
import { createApp } from '../src/app.js';
import { SessionStore, cookieName } from '../src/sessions.js';
import { AgentClient, AgentMonitor } from '../src/agent-client.js';

const SECRET = 'k'.repeat(48);
const ORIGIN = 'https://drive.example.test';
const TTL = { absoluteMs: 3600_000, idleMs: 3600_000 };
const listen = (app) =>
  new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

let tmp, agentServer, gw, gwBase, store, monitor;
let ownerCookie, guestCookie;

function makeGateway(agentUrl, secret = SECRET) {
  const mon = new AgentMonitor();
  const agent = new AgentClient({ baseUrl: agentUrl, secrets: toKeyList(secret), onReachability: (ok) => mon.set(ok) });
  const app = createApp({ publicOrigin: ORIGIN, cookieSecure: true, demoRoot: path.join(tmp, 'demo'), store, agent, monitor: mon });
  return { app, mon };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-gw-'));
  const drive = path.join(tmp, 'Drive');
  fs.mkdirSync(path.join(drive, '문서'), { recursive: true });
  fs.writeFileSync(path.join(drive, 'hello.txt'), 'hello world');
  fs.writeFileSync(path.join(drive, 'evil.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(drive, 'pic.svg'), '<svg onload="alert(1)"/>');
  fs.mkdirSync(path.join(tmp, 'demo', '샘플'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'demo', '샘플', 'a.txt'), 'demo file');
  fs.writeFileSync(path.join(tmp, 'demo', 'x.html'), '<b>x</b>');

  agentServer = await listen(createAgentApp({ driveRoot: drive, hmacSecrets: toKeyList(SECRET) }));
  store = new SessionStore();
  const g = makeGateway(`http://127.0.0.1:${agentServer.address().port}`);
  monitor = g.mon;
  gw = await listen(g.app);
  gwBase = `http://127.0.0.1:${gw.address().port}`;

  const name = cookieName(true);
  ownerCookie = `${name}=${store.create({ role: 'owner', user: { provider: 'github', sub: '1', nickname: '오너' } }, TTL).id}`;
  guestCookie = `${name}=${store.create({ role: 'guest', user: { provider: 'kakao', sub: '2', nickname: '손님' } }, TTL).id}`;
});

after(() => {
  gw?.close();
  agentServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (url, cookie, headers = {}) => fetch(gwBase + url, { headers: { ...(cookie ? { cookie } : {}), ...headers } });
const q = (p) => `?path=${encodeURIComponent(p)}`;

test('anonymous: only /api/me', async () => {
  assert.deepEqual(await (await get('/api/me')).json(), { user: null });
  for (const url of ['/api/status', `/api/demo/list${q('/')}`, `/api/files/list${q('/')}`]) {
    const r = await get(url);
    assert.equal(r.status, 401, url);
    assert.deepEqual(await r.json(), { error: 'LOGIN_REQUIRED' });
  }
  // 위조 쿠키
  assert.equal((await get('/api/status', `${cookieName(true)}=${'a'.repeat(43)}`)).status, 401);
});

test('security headers on every response', async () => {
  const r = await get('/api/me');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('guest: demo yes, desktop no', async () => {
  const me = await (await get('/api/me', guestCookie)).json();
  assert.deepEqual(me, { user: { role: 'guest', nickname: '손님', provider: 'kakao' } });

  const list = await (await get(`/api/demo/list${q('/')}`, guestCookie)).json();
  assert.deepEqual(list.entries.map((e) => e.name).sort(), ['x.html', '샘플']);

  const file = await get(`/api/demo/content${q('/샘플/a.txt')}`, guestCookie);
  assert.equal(await file.text(), 'demo file');
  assert.equal(file.headers.get('content-type'), 'text/plain; charset=utf-8');

  const html = await get(`/api/demo/content${q('/x.html')}`, guestCookie);
  assert.equal(html.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(html.headers.get('content-security-policy'), /sandbox/);

  for (const url of [`/api/files/list${q('/')}`, `/api/files/content${q('/hello.txt')}`]) {
    const r = await get(url, guestCookie);
    assert.equal(r.status, 403, url);
    assert.deepEqual(await r.json(), { error: 'OWNER_ONLY' });
  }
  assert.equal((await get(`/api/demo/list${q('/../Drive')}`, guestCookie)).status, 400);
});

test('owner: desktop files through agent', async () => {
  const list = await (await get(`/api/files/list${q('/')}`, ownerCookie)).json();
  assert.deepEqual(list.entries.map((e) => e.name).sort(), ['evil.html', 'hello.txt', 'pic.svg', '문서']);
  assert.equal(monitor.status().desktop, 'online');

  const stat = await (await get(`/api/files/stat${q('/hello.txt')}`, ownerCookie)).json();
  assert.equal(stat.size, 11);

  const full = await get(`/api/files/content${q('/hello.txt')}&disposition=attachment`, ownerCookie);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), 'hello world');
  assert.match(full.headers.get('content-disposition'), /^attachment;/);
  assert.equal(full.headers.get('cache-control'), 'private, no-cache');
  const etag = full.headers.get('etag');
  assert.ok(etag);

  const part = await get(`/api/files/content${q('/hello.txt')}`, ownerCookie, { Range: 'bytes=0-4' });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), 'hello');
  assert.equal(part.headers.get('content-range'), 'bytes 0-4/11');

  const cached = await get(`/api/files/content${q('/hello.txt')}`, ownerCookie, { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' });
  assert.equal(cached.status, 304);

  const unsat = await get(`/api/files/content${q('/hello.txt')}`, ownerCookie, { Range: 'bytes=99-' });
  assert.equal(unsat.status, 416);
});

test('owner: active content is neutralized on inline preview', async () => {
  for (const name of ['/evil.html', '/pic.svg']) {
    const r = await get(`/api/files/content${q(name)}`, ownerCookie);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8', name);
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    assert.match(r.headers.get('content-disposition'), /^inline;/);
  }
});

test('owner: errors are mapped', async () => {
  const bad = await get(`/api/files/list${q('/a/../..')}`, ownerCookie);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'PATH_DOT_SEGMENT' });

  const missing = await get(`/api/files/content${q('/nope.txt')}`, ownerCookie);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'NOT_FOUND' });
  assert.equal(missing.headers.get('content-security-policy'), null);

  assert.equal((await get(`/api/files/content${q('/문서')}`, ownerCookie)).status, 400);
  assert.equal((await get(`/api/files/content${q('/hello.txt')}&disposition=evil`, ownerCookie)).status, 400);
});

test('desktop offline → 503 and status flips', async () => {
  const dead = await listen(createAgentApp({ driveRoot: tmp, hmacSecrets: toKeyList(SECRET) }));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));

  const g = makeGateway(`http://127.0.0.1:${deadPort}`);
  g.mon.set(true);
  const s = await listen(g.app);
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/files/list${q('/')}`, { headers: { cookie: ownerCookie } });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'AGENT_OFFLINE' });
    assert.equal(g.mon.status().desktop, 'offline');
  } finally {
    s.close();
  }
});

test('wrong agent secret → 502 without leaking details', async () => {
  const g = makeGateway(`http://127.0.0.1:${agentServer.address().port}`, 'w'.repeat(48));
  const s = await listen(g.app);
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const r = await fetch(`${base}/api/files/list${q('/')}`, { headers: { cookie: ownerCookie } });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'AGENT_AUTH_FAILED' });
    const f = await fetch(`${base}/api/files/content${q('/hello.txt')}`, { headers: { cookie: ownerCookie } });
    assert.equal(f.status, 502);
  } finally {
    s.close();
  }
});

test('CSRF: state-changing requests need our Origin', async () => {
  const { id } = store.create({ role: 'guest', user: { provider: 'google', sub: '3', nickname: 'c' } }, TTL);
  const cookie = `${cookieName(true)}=${id}`;
  const post = (headers) => fetch(`${gwBase}/api/logout`, { method: 'POST', headers: { cookie, ...headers } });

  assert.equal((await post({})).status, 403);
  assert.equal((await post({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.ok(store.get(id), 'session must survive rejected requests');

  const ok = await post({ Origin: ORIGIN });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(store.get(id), null);
});

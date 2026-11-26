// 데스크탑 꺼짐 대응: 목록 캐시(§4.2) + 파이 임시 보관함과 데스크탑으로 옮기기(D3) — 실제 agent 와 함께.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { toKeyList } from '@wooki-drive/shared/node';
import { createApp as createAgentApp } from '../../agent/src/app.js';
import { createApp } from '../src/app.js';
import { SessionStore, cookieName } from '../src/sessions.js';
import { AgentClient, AgentMonitor } from '../src/agent-client.js';
import { PasskeyStore } from '../src/auth/passkeys.js';
import { MetaCache } from '../src/meta-cache.js';
import { BufferStore } from '../src/buffer.js';

const SECRET = 'o'.repeat(48);
const ORIGIN = 'https://drive.example.test';
const TTL = { absoluteMs: 3600_000, idleMs: 3600_000 };
const CHUNK = 1000;

let tmp, drive, agentApp, agentServer, agentPort, gw, base, ownerCookie, guestCookie, agent, monitor, meta, buffer;

const listen = (app, port = 0) =>
  new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });

async function stopAgent() {
  agentServer.closeAllConnections();
  await new Promise((r) => agentServer.close(r));
}
async function startAgent() {
  agentServer = await listen(agentApp, agentPort);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-off-'));
  drive = path.join(tmp, 'Drive');
  fs.mkdirSync(path.join(drive, '사진', '2024'), { recursive: true });
  fs.writeFileSync(path.join(drive, '사진', 'a.jpg'), 'AAAA');
  fs.writeFileSync(path.join(drive, 'readme.txt'), 'hi');

  agentApp = createAgentApp({ driveRoot: drive, hmacSecrets: toKeyList(SECRET), uploadChunkSize: CHUNK });
  agentServer = await listen(agentApp);
  agentPort = agentServer.address().port;

  const store = new SessionStore();
  monitor = new AgentMonitor();
  agent = new AgentClient({ baseUrl: `http://127.0.0.1:${agentPort}`, secrets: toKeyList(SECRET), onReachability: (ok) => monitor.set(ok) });
  meta = new MetaCache({ file: path.join(tmp, 'data', 'folders.json') });
  buffer = new BufferStore({ dir: path.join(tmp, 'data', 'buffer'), maxBytes: 10_000, chunkSize: CHUNK });
  gw = await listen(
    createApp({
      publicOrigin: ORIGIN,
      cookieSecure: true,
      demoRoot: tmp,
      session: { owner: TTL, guest: TTL },
      store,
      passkeys: new PasskeyStore(),
      agent,
      monitor,
      meta,
      buffer,
    }),
  );
  base = `http://127.0.0.1:${gw.address().port}`;
  ownerCookie = `${cookieName(true)}=${store.create({ role: 'owner', user: { provider: 'github', sub: '1', nickname: 'o' } }, TTL).id}`;
  guestCookie = `${cookieName(true)}=${store.create({ role: 'guest', user: { provider: 'kakao', sub: '2', nickname: 'g' } }, TTL).id}`;
});

after(async () => {
  gw?.close();
  agentServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function api(method, url, body, { cookie = ownerCookie, headers = {}, raw } = {}) {
  const r = await fetch(base + url, {
    method,
    headers: {
      cookie,
      origin: ORIGIN,
      ...(body !== undefined && raw === undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const q = (p) => `?path=${encodeURIComponent(p)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** 브라우저가 하는 것처럼 보관함에 올리기 */
async function bufferUpload(vpath, content, mtimeMs) {
  const data = Buffer.from(content);
  const c = await api('POST', '/api/buffer/uploads', { path: vpath, size: data.length, ...(mtimeMs ? { mtimeMs } : {}) });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  for (let off = 0; off < data.length; off += CHUNK) {
    const part = data.subarray(off, off + CHUNK);
    const r = await api('PUT', `/api/buffer/uploads/${c.body.id}?offset=${off}`, undefined, {
      raw: part,
      headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha(part) },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const done = await api('POST', `/api/buffer/uploads/${c.body.id}/complete`, {});
  assert.equal(done.status, 200);
  return done.body;
}

test('offline: last seen listing is served read-only; unseen folders still fail', async () => {
  const online = await api('GET', `/api/files/list${q('/사진')}`);
  assert.equal(online.status, 200);
  assert.equal(online.body.cached, undefined);

  await stopAgent();
  try {
    const cached = await api('GET', `/api/files/list${q('/사진')}`);
    assert.equal(cached.status, 200);
    assert.equal(cached.body.cached, true);
    assert.ok(Number.isFinite(cached.body.cachedAt));
    assert.deepEqual(cached.body.entries.map((e) => e.name).sort(), ['2024', 'a.jpg']);

    const st = await api('GET', `/api/files/stat${q('/사진/a.jpg')}`);
    assert.equal(st.status, 200);
    assert.equal(st.body.size, 4);
    assert.equal(st.body.cached, true);

    const unseen = await api('GET', `/api/files/list${q('/사진/2024')}`);
    assert.equal(unseen.status, 503);
    assert.deepEqual(unseen.body, { error: 'AGENT_OFFLINE' });

    // 원본·쓰기는 여전히 꺼짐
    assert.equal((await api('GET', `/api/files/content${q('/사진/a.jpg')}`)).status, 503);
    assert.equal((await api('POST', '/api/files/mkdir', { parent: '/', name: 'x' })).status, 503);
    // 게스트는 캐시도 못 봄
    assert.equal((await api('GET', `/api/files/list${q('/사진')}`, undefined, { cookie: guestCookie })).status, 403);
  } finally {
    await startAgent();
  }
});

test('rename invalidates cached listings of the old path and its parent', async () => {
  await api('GET', `/api/files/list${q('/')}`);
  await api('GET', `/api/files/list${q('/사진')}`);
  assert.ok(meta.get('/사진') && meta.get('/'));
  const r = await api('POST', '/api/files/rename', { path: '/사진', name: '사진들' });
  assert.equal(r.status, 200);
  assert.equal(meta.get('/사진'), null);
  assert.equal(meta.get('/'), null);
  await api('POST', '/api/files/rename', { path: '/사진들', name: '사진' });
});

test('crawl fills every folder, drops vanished ones, and persists', async () => {
  meta.put('/gone', []);
  const n = await meta.crawl((folder) => agent.getJson(`/v1/list${q(folder)}`), { pauseMs: 0 });
  assert.equal(n, 3); // /, /사진, /사진/2024
  assert.deepEqual([...meta.folders.keys()].sort(), ['/', '/사진', '/사진/2024']);
  const again = new MetaCache({ file: path.join(tmp, 'data', 'folders.json') });
  again.load();
  assert.deepEqual([...again.folders.keys()].sort(), ['/', '/사진', '/사진/2024']);
});

test('buffer: upload while offline, then moves to the desktop when it comes back', async () => {
  await stopAgent();
  monitor.set(false);
  const content = 'x'.repeat(2500); // 청크 3개
  const mtime = Date.UTC(2024, 0, 2);
  try {
    const done = await bufferUpload('/사진/새 폴더/b.txt', content, mtime);
    assert.deepEqual({ path: done.path, buffered: done.buffered }, { path: '/사진/새 폴더/b.txt', buffered: true });
    await bufferUpload('/readme.txt', 'second'); // 이미 있는 이름 → 옮길 때 "(1)"

    const list = await api('GET', '/api/buffer');
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.items.map((i) => [i.path, i.size, i.error]),
      [
        ['/사진/새 폴더/b.txt', 2500, null],
        ['/readme.txt', 6, null],
      ],
    );
    assert.deepEqual([list.body.used, list.body.max, list.body.free], [2506, 10_000, 7494]);

    // 상한 초과
    const full = await api('POST', '/api/buffer/uploads', { path: '/big.bin', size: 8000 });
    assert.equal(full.status, 507);
    assert.deepEqual(full.body, { error: 'BUFFER_FULL' });

    // 동기화 시도해도 꺼져 있으면 그대로
    assert.deepEqual(await buffer.sync(agent), { moved: 0, failed: 0 });
    assert.equal((await buffer.list()).length, 2);
  } finally {
    await startAgent();
  }

  assert.deepEqual(await buffer.sync(agent), { moved: 2, failed: 0 });
  assert.equal(fs.readFileSync(path.join(drive, '사진', '새 폴더', 'b.txt'), 'utf8'), content);
  assert.equal(fs.statSync(path.join(drive, '사진', '새 폴더', 'b.txt')).mtimeMs, mtime);
  assert.equal(fs.readFileSync(path.join(drive, 'readme.txt'), 'utf8'), 'hi');
  assert.equal(fs.readFileSync(path.join(drive, 'readme (1).txt'), 'utf8'), 'second');
  assert.deepEqual((await api('GET', '/api/buffer')).body.items, []);
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'data', 'buffer', 'ready')), []);
});

test('buffer: path the desktop rejects is kept with its error, then can be removed', async () => {
  // 형식은 맞지만 데스크탑에서 만들 수 없는 경로 (중간 경로가 이미 파일)
  const done = await bufferUpload('/readme.txt/inner.txt', 'nope');
  assert.equal((await buffer.sync(agent)).failed, 1);
  const [item] = (await api('GET', '/api/buffer')).body.items;
  assert.equal(item.id, done.id);
  assert.equal(item.error, 'NOT_A_DIRECTORY');
  assert.equal(fs.readFileSync(path.join(drive, 'readme.txt'), 'utf8'), 'hi');
  // 다시 동기화해도 거부된 항목은 건드리지 않는다
  assert.deepEqual(await buffer.sync(agent), { moved: 0, failed: 0 });

  assert.equal((await api('DELETE', `/api/buffer/${item.id}`)).status, 200);
  assert.deepEqual((await api('GET', '/api/buffer')).body.items, []);
});

test('buffer: input checks and owner only', async () => {
  for (const [body, code] of [
    [{ path: '/', size: 1 }, 'PATH_ROOT'],
    [{ path: '/.wooki/x', size: 1 }, 'PATH_RESERVED'],
    [{ path: '/CON.txt', size: 1 }, 'PATH_RESERVED_NAME'],
    [{ path: '/../x', size: 1 }, 'PATH_DOT_SEGMENT'],
    [{ path: '/x', size: -1 }, 'BAD_SIZE'],
  ]) {
    const r = await api('POST', '/api/buffer/uploads', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.body, { error: code });
  }
  const c = await api('POST', '/api/buffer/uploads', { path: '/x.txt', size: 4 });
  const bad = await api('PUT', `/api/buffer/uploads/${c.body.id}?offset=0`, undefined, {
    raw: Buffer.from('abcd'),
    headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha('zzzz') },
  });
  assert.deepEqual([bad.status, bad.body], [400, { error: 'CHUNK_CORRUPT' }]);
  const skip = await api('PUT', `/api/buffer/uploads/${c.body.id}?offset=2`, undefined, {
    raw: Buffer.from('cd'),
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.deepEqual([skip.status, skip.body], [409, { error: 'OFFSET_MISMATCH', received: 0 }]);
  assert.equal((await api('DELETE', `/api/buffer/uploads/${c.body.id}`)).status, 200);

  assert.equal((await api('GET', '/api/buffer', undefined, { cookie: guestCookie })).status, 403);
  assert.equal((await api('POST', '/api/buffer/uploads', { path: '/g.txt', size: 1 }, { cookie: guestCookie })).status, 403);
});

test('clock skew: health reports the desktop clock offset and the monitor warns once', async () => {
  const skewed = createAgentApp({ driveRoot: drive, hmacSecrets: toKeyList(SECRET), now: () => Date.now() - 150_000 });
  const s = await listen(skewed);
  try {
    const c = new AgentClient({ baseUrl: `http://127.0.0.1:${s.address().port}`, secrets: toKeyList(SECRET) });
    assert.equal(await c.health(), true);
    assert.ok(Math.abs(c.lastSkewMs + 150_000) < 2000, `skew ${c.lastSkewMs}`);
    // 시계가 어긋나면 서명 요청은 거절된다 — 이 경고가 그 원인을 알려준다
    await assert.rejects(c.getJson('/v1/list?path=%2F'), { code: 'AGENT_AUTH_FAILED' });

    const logs = [];
    const m = new AgentMonitor({ log: (x) => logs.push(x) });
    assert.equal(m.checkSkew(c.lastSkewMs, 1_000_000), true);
    assert.equal(m.checkSkew(c.lastSkewMs, 1_000_000 + 60_000), false, 'throttled');
    assert.equal(m.checkSkew(5_000, 1_000_000 + 11 * 60_000), false, 'small skew is fine');
    assert.match(logs[0], /150s behind/);
    assert.equal(logs.length, 1);

    // 정상 agent 는 차이가 거의 없다
    assert.equal(await agent.health(), true);
    assert.ok(Math.abs(agent.lastSkewMs) < 2000);
  } finally {
    s.closeAllConnections();
    s.close();
  }
});

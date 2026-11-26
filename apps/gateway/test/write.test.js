// gateway 쓰기 프록시 + 패스키 재인증 — 실제 agent 와 함께.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { toKeyList } from '@wooki-drive/shared/node';
import { createApp as createAgentApp } from '../../agent/src/app.js';
import { createApp } from '../src/app.js';
import { SessionStore, cookieName } from '../src/sessions.js';
import { AgentClient, AgentMonitor } from '../src/agent-client.js';
import { PasskeyStore } from '../src/auth/passkeys.js';

const SECRET = 'q'.repeat(48);
const ORIGIN = 'https://drive.example.test';
const TTL = { absoluteMs: 3600_000, idleMs: 3600_000 };
const SESSION = { owner: TTL, guest: TTL };
const listen = (app) =>
  new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

let tmp, drive, agentServer, gw, base, store, ownerSid, ownerCookie, guestCookie;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-gww-'));
  drive = path.join(tmp, 'Drive');
  fs.mkdirSync(path.join(drive, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(drive, 'a.txt'), 'A');

  agentServer = await listen(createAgentApp({ driveRoot: drive, hmacSecrets: toKeyList(SECRET), uploadChunkSize: 1000 }));
  store = new SessionStore();
  const app = createApp({
    publicOrigin: ORIGIN,
    cookieSecure: true,
    demoRoot: tmp,
    session: SESSION,
    store,
    passkeys: new PasskeyStore(),
    agent: new AgentClient({ baseUrl: `http://127.0.0.1:${agentServer.address().port}`, secrets: toKeyList(SECRET) }),
    monitor: new AgentMonitor(),
    trashNotice: { days: 30, bytes: 1024 },
  });
  gw = await listen(app);
  base = `http://127.0.0.1:${gw.address().port}`;

  ownerSid = store.create({ role: 'owner', user: { provider: 'github', sub: '1', nickname: 'o' } }, TTL).id;
  ownerCookie = `${cookieName(true)}=${ownerSid}`;
  guestCookie = `${cookieName(true)}=${store.create({ role: 'guest', user: { provider: 'kakao', sub: '2', nickname: 'g' } }, TTL).id}`;
});

after(() => {
  gw?.close();
  agentServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function api(method, url, body, { cookie = ownerCookie, origin = ORIGIN, headers = {}, raw } = {}) {
  const r = await fetch(base + url, {
    method,
    headers: {
      cookie,
      ...(origin ? { Origin: origin } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { status: r.status, body: await r.json() };
}

test('guest and cross-site requests cannot write', async () => {
  assert.equal((await api('POST', '/api/files/mkdir', { parent: '/', name: 'x' }, { cookie: guestCookie })).status, 403);
  assert.equal((await api('POST', '/api/files/mkdir', { parent: '/', name: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await api('POST', '/api/files/mkdir', { parent: '/', name: 'x' }, { origin: null })).status, 403);
  assert.ok(!fs.existsSync(path.join(drive, 'x')));
});

test('mkdir / rename / move / trash / restore through the gateway', async () => {
  assert.deepEqual((await api('POST', '/api/files/mkdir', { parent: '/', name: '새 폴더' })).body, { path: '/새 폴더' });
  assert.deepEqual((await api('POST', '/api/files/rename', { path: '/새 폴더', name: '사진' })).body, { path: '/사진' });
  const mv = await api('POST', '/api/files/move', { paths: ['/a.txt'], to: '/사진' });
  assert.deepEqual(mv.body.results, [{ from: '/a.txt', path: '/사진/a.txt' }]);
  // 알 수 없는 필드는 agent 로 전달되지 않음(형식만 거름)
  const extra = await api('POST', '/api/files/mkdir', { parent: '/', name: 'y', evil: true });
  assert.equal(extra.status, 200);

  const tr = await api('POST', '/api/files/trash', { paths: ['/사진/a.txt'] });
  const id = tr.body.results[0].id;
  assert.ok(id);
  const items = (await api('GET', '/api/files/trash')).body.items;
  assert.equal(items[0].originalPath, '/사진/a.txt');
  assert.deepEqual((await api('POST', '/api/files/trash/restore', { ids: [id] })).body.results, [{ from: id, path: '/사진/a.txt' }]);
  assert.equal((await api('POST', '/api/files/rename', { path: '/.wooki', name: 'x' })).body.error, 'PATH_RESERVED');
});

test('permanent delete and empty require a one-time passkey step-up', async () => {
  const id = (await api('POST', '/api/files/trash', { paths: ['/y'] })).body.results[0].id;

  const denied = await api('POST', '/api/files/trash/delete', { ids: [id] });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { error: 'STEP_UP_REQUIRED' });
  assert.equal((await api('POST', '/api/files/trash/empty', {})).body.error, 'STEP_UP_REQUIRED');

  // 만료된 허가는 무효
  store.update(ownerSid, { stepUp: { expiresAt: Date.now() - 1 } });
  assert.equal((await api('POST', '/api/files/trash/delete', { ids: [id] })).status, 403);

  // 재인증 성공 상태 → 한 번만 통과
  store.update(ownerSid, { stepUp: { expiresAt: Date.now() + 60_000 } });
  assert.deepEqual((await api('POST', '/api/files/trash/delete', { ids: [id] })).body.results, [{ from: id }]);
  assert.equal((await api('POST', '/api/files/trash/empty', {})).body.error, 'STEP_UP_REQUIRED');

  store.update(ownerSid, { stepUp: { expiresAt: Date.now() + 60_000 } });
  assert.deepEqual((await api('POST', '/api/files/trash/empty', {})).body, { deleted: 0 });
});

test('trash summary raises a notice for size or age (D20)', async () => {
  fs.mkdirSync(path.join(drive, 'old', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(drive, 'old', 'a.bin'), Buffer.alloc(3000));
  fs.writeFileSync(path.join(drive, 'old', 'sub', 'b.bin'), Buffer.alloc(2000));
  await api('POST', '/api/files/trash', { paths: ['/old'] });

  const s = (await api('GET', '/api/files/trash/summary')).body;
  assert.equal(s.count, 1);
  assert.equal(s.totalBytes, 5000); // 폴더 안 파일 합
  assert.equal(s.notice.large, true); // 이 테스트 앱은 1KB 를 상한으로 둠
  assert.equal(s.notice.old, false);
  assert.equal((await api('GET', '/api/files/trash/summary', undefined, { cookie: guestCookie })).status, 403);
});

test('chunked upload streams through the gateway', async () => {
  const data = Buffer.from('0123456789'.repeat(250)); // 2500 bytes, chunk 1000
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const c = await api('POST', '/api/files/uploads', { path: '/docs/big.bin', size: data.length, mtimeMs: 1_600_000_000_000 });
  assert.equal(c.status, 201);
  const { id, chunkSize } = c.body;
  assert.equal(chunkSize, 1000);

  const put = (offset, chunk, hash = sha(chunk)) =>
    api('PUT', `/api/files/uploads/${id}?offset=${offset}`, undefined, {
      raw: chunk,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': hash },
    });

  assert.equal((await put(0, data.subarray(0, 1000))).body.received, 1000);
  const skip = await put(2000, data.subarray(2000));
  assert.equal(skip.status, 409);
  assert.deepEqual(skip.body, { error: 'OFFSET_MISMATCH', received: 1000 }); // 이어올리기 위치 전달
  assert.equal((await api('GET', `/api/files/uploads/${id}`)).body.received, 1000);
  await put(1000, data.subarray(1000, 2000));
  await put(2000, data.subarray(2000));
  assert.deepEqual((await api('POST', `/api/files/uploads/${id}/complete`, {})).body, { path: '/docs/big.bin' });
  assert.ok(fs.readFileSync(path.join(drive, 'docs', 'big.bin')).equals(data));

  // 잘못된 id 는 agent 경로에 끼워 넣지 않는다
  assert.equal((await api('GET', '/api/files/uploads/..%2F..%2Fv1%2Flist')).status, 404);
  // 청크 상한: 본문을 보내기 전에 헤더(Content-Length)만으로 413 을 받아야 한다 — 40MB 를 실제로 보내지 않는다
  const tooBigStatus = await new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: gw.address().port,
        method: 'PUT',
        path: `/api/files/uploads/${'a'.repeat(22)}?offset=0`,
        headers: { cookie: ownerCookie, Origin: ORIGIN, 'Content-Length': String(40 * 1024 * 1024) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
        r.destroy();
      },
    );
    r.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    r.flushHeaders();
  });
  assert.equal(tooBigStatus, 413);

  const c2 = await api('POST', '/api/files/uploads', { path: '/docs/cancel.bin', size: 5 });
  assert.deepEqual((await api('DELETE', `/api/files/uploads/${c2.body.id}`)).body, { ok: true });
});

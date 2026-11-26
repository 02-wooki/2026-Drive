// 썸네일 캐시: 처음엔 agent 에서, 이후엔 데스크탑이 꺼져도 파이 캐시에서.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { toKeyList } from '@wooki-drive/shared/node';
import { createApp as createAgentApp } from '../../agent/src/app.js';
import { createApp } from '../src/app.js';
import { SessionStore, cookieName } from '../src/sessions.js';
import { AgentClient, AgentMonitor } from '../src/agent-client.js';
import { PasskeyStore } from '../src/auth/passkeys.js';
import { ThumbCache } from '../src/thumb-cache.js';

const SECRET = 'm'.repeat(48);
const TTL = { absoluteMs: 3600_000, idleMs: 3600_000 };
const listen = (app) =>
  new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

let tmp, drive, agentServer, gw, base, cookie, thumbs, version;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-gwt-'));
  drive = path.join(tmp, 'Drive');
  fs.mkdirSync(drive);
  await sharp({ create: { width: 900, height: 600, channels: 3, background: '#22aa88' } }).png().toFile(path.join(drive, 'pic.png'));
  const st = fs.statSync(path.join(drive, 'pic.png'));
  version = `${Math.floor(st.mtimeMs)}-${st.size}`;

  agentServer = await listen(createAgentApp({ driveRoot: drive, hmacSecrets: toKeyList(SECRET) }));
  thumbs = new ThumbCache({ dir: path.join(tmp, 'cache'), maxBytes: 10 * 1024 * 1024 });
  await thumbs.init();
  const store = new SessionStore();
  cookie = `${cookieName(true)}=${store.create({ role: 'owner', user: { provider: 'github', sub: '1', nickname: 'o' } }, TTL).id}`;
  gw = await listen(
    createApp({
      publicOrigin: 'https://drive.example.test',
      cookieSecure: true,
      demoRoot: tmp,
      session: { owner: TTL, guest: TTL },
      store,
      passkeys: new PasskeyStore(),
      agent: new AgentClient({ baseUrl: `http://127.0.0.1:${agentServer.address().port}`, secrets: toKeyList(SECRET) }),
      monitor: new AgentMonitor(),
      thumbs,
    }),
  );
  base = `http://127.0.0.1:${gw.address().port}`;
});

after(() => {
  gw?.close();
  agentServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (q) => fetch(`${base}/api/files/thumb?${q}`, { headers: { cookie } });

test('miss → agent → cached; long cache only when the version matches', async () => {
  const r = await get(`path=%2Fpic.png&w=256&v=${version}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/webp');
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'");
  assert.ok(thumbs.get('/pic.png', version, 256));
  assert.ok(thumbs.total > 0);

  const stale = await get('path=%2Fpic.png&w=256&v=1-1');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('cache-control'), 'private, no-cache');
});

test('served from the Pi cache while the desktop is off', async () => {
  await new Promise((r) => agentServer.close(r));
  const hit = await get(`path=%2Fpic.png&w=256&v=${version}`);
  assert.equal(hit.status, 200);
  const meta = await sharp(Buffer.from(await hit.arrayBuffer())).metadata();
  assert.equal(meta.width, 256);

  // 캐시에 없는 크기·버전은 데스크탑이 필요
  assert.equal((await get(`path=%2Fpic.png&w=512&v=${version}`)).status, 503);
  assert.equal((await get('path=%2Fpic.png&w=256')).status, 503);
});

test('input validation', async () => {
  assert.equal((await get('path=%2Fpic.png&w=999')).status, 400);
  assert.equal((await get('path=..%2Fx&w=256')).status, 400);
  assert.equal(ThumbCache.isVersion('../../x'), false);
  assert.equal(thumbs.get('/pic.png', '../../etc', 256), null);
});

test('cache prunes oldest files over the limit', async () => {
  const small = new ThumbCache({ dir: path.join(tmp, 'cache2'), maxBytes: 3000 });
  await small.init();
  for (let i = 0; i < 6; i++) {
    await small.put(`/f${i}`, `${i}-1`, 128, Buffer.alloc(1000, i));
    await new Promise((r) => setTimeout(r, 15));
  }
  await small.pruning;
  assert.ok(small.total <= 3000, `total ${small.total}`);
  assert.equal(small.get('/f0', '0-1', 128), null); // 가장 오래된 것부터
  assert.ok(small.get('/f5', '5-1', 128));
});

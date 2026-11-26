import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signRequest, toKeyList, contentDisposition } from '@wooki-drive/shared/node';
import { createApp } from '../src/app.js';
import { readZip } from '../../../packages/shared/test/zip-reader.js';

const SECRET = 's'.repeat(48);
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
let tmp, root, server, base;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-agent-'));
  root = path.join(tmp, 'Drive');
  fs.mkdirSync(path.join(root, '사진', '2024'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'outside'));
  fs.writeFileSync(path.join(root, '사진', '바다.jpg'), Buffer.alloc(1000, 7));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello world');
  fs.writeFileSync(path.join(root, '.DS_Store'), '');
  fs.writeFileSync(path.join(tmp, 'outside', 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, 'escape'), linkType);
  fs.symlinkSync(path.join(root, '사진'), path.join(root, 'photos-link'), linkType);

  const app = createApp({ driveRoot: root, hmacSecrets: toKeyList(SECRET) });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const q = (vpath, extra = '') => `?path=${encodeURIComponent(vpath)}${extra}`;

function signedGet(pathWithQuery, { headers = {}, secret = SECRET } = {}) {
  const sig = signRequest({ secret, audience: 'agent', method: 'GET', pathWithQuery });
  return fetch(base + pathWithQuery, { headers: { ...sig, ...headers } });
}

test('health needs no signature', async () => {
  const before = Date.now();
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'time']);
  assert.equal(body.ok, true);
  assert.ok(body.time >= before && body.time <= Date.now(), 'agent clock for skew detection');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('unsigned / wrong-key / replayed requests are rejected', async () => {
  assert.equal((await fetch(`${base}/v1/list${q('/')}`)).status, 401);
  assert.equal((await signedGet(`/v1/list${q('/')}`, { secret: 'x'.repeat(48) })).status, 401);

  const pq = `/v1/list${q('/')}`;
  const sig = signRequest({ secret: SECRET, audience: 'agent', method: 'GET', pathWithQuery: pq });
  assert.equal((await fetch(base + pq, { headers: sig })).status, 200);
  assert.equal((await fetch(base + pq, { headers: sig })).status, 401); // replay

  // 서명된 경로와 다른 경로로 보내기
  const other = signRequest({ secret: SECRET, audience: 'agent', method: 'GET', pathWithQuery: `/v1/list${q('/사진')}` });
  assert.equal((await fetch(base + `/v1/list${q('/')}`, { headers: other })).status, 401);
  const body = await (await fetch(`${base}/v1/list${q('/')}`)).json();
  assert.deepEqual(body, { error: 'UNAUTHORIZED' });
});

test('list root', async () => {
  const r = await signedGet(`/v1/list${q('/')}`);
  assert.equal(r.status, 200);
  const { path: p, entries } = await r.json();
  assert.equal(p, '/');
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(byName).sort(), ['.DS_Store', 'escape', 'hello.txt', 'photos-link', '사진'].sort());
  assert.equal(byName['사진'].type, 'dir');
  assert.equal(byName['사진'].path, '/사진');
  assert.equal(byName['hello.txt'].type, 'file');
  assert.equal(byName['hello.txt'].size, 11);
  assert.equal(byName['.DS_Store'].hidden, true);
  // 루트 안을 가리키는 링크는 대상처럼, 밖을 가리키면 열 수 없는 항목
  assert.equal(byName['photos-link'].link, true);
  assert.equal(byName['photos-link'].type, 'dir');
  assert.equal(byName['escape'].link, true);
  assert.equal(byName['escape'].type, 'other');
});

test('list subfolder, errors', async () => {
  const r = await signedGet(`/v1/list${q('/사진/')}`);
  const body = await r.json();
  assert.equal(body.path, '/사진');
  assert.deepEqual(body.entries.map((e) => e.name).sort(), ['2024', '바다.jpg']);

  assert.equal((await signedGet(`/v1/list${q('/없음')}`)).status, 404);
  assert.equal((await signedGet(`/v1/list${q('/hello.txt')}`)).status, 400);
  const bad = await signedGet(`/v1/list${q('/../')}`);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'PATH_DOT_SEGMENT' });
  assert.equal((await signedGet('/v1/list')).status, 400); // path 없음
  assert.equal((await signedGet('/v1/list?path=/a&path=/b')).status, 400); // 배열
});

test('escape via junction is blocked', async () => {
  for (const url of [`/v1/list${q('/escape')}`, `/v1/stat${q('/escape/secret.txt')}`, `/v1/file${q('/escape/secret.txt')}`]) {
    const r = await signedGet(url);
    assert.equal(r.status, 400, url);
    assert.deepEqual(await r.json(), { error: 'PATH_OUTSIDE_ROOT' });
  }
});

test('stat', async () => {
  const r = await signedGet(`/v1/stat${q('/사진/바다.jpg')}`);
  const body = await r.json();
  assert.equal(body.type, 'file');
  assert.equal(body.size, 1000);
  assert.equal(body.name, '바다.jpg');
  assert.equal(body.realPath, undefined); // 실제 경로는 노출하지 않음
});

test('file download with Range and conditional GET', async () => {
  const full = await signedGet(`/v1/file${q('/hello.txt')}`);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), 'hello world');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('cache-control'), 'private, no-cache');
  assert.match(full.headers.get('content-disposition'), /^attachment; /);
  const etag = full.headers.get('etag');
  assert.ok(etag);

  const part = await signedGet(`/v1/file${q('/hello.txt')}`, { headers: { Range: 'bytes=6-' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), 'world');
  assert.equal(part.headers.get('content-range'), 'bytes 6-10/11');

  const unsat = await signedGet(`/v1/file${q('/hello.txt')}`, { headers: { Range: 'bytes=100-' } });
  assert.equal(unsat.status, 416);

  const cached = await signedGet(`/v1/file${q('/hello.txt')}`, {
    // fetch 는 조건부 요청에 Cache-Control: no-cache 를 자동으로 붙여 304 를 막는다 → 명시해서 덮어쓴다
    headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' },
  });
  assert.equal(cached.status, 304);

  const inline = await signedGet(`/v1/file${q('/사진/바다.jpg', '&disposition=inline')}`);
  assert.equal(inline.status, 200);
  assert.equal((await inline.arrayBuffer()).byteLength, 1000);
  assert.equal(inline.headers.get('content-disposition'), contentDisposition('inline', '바다.jpg'));

  assert.equal((await signedGet(`/v1/file${q('/사진')}`)).status, 400); // 폴더
  assert.equal((await signedGet(`/v1/file${q('/hello.txt', '&disposition=evil')}`)).status, 400);
  const missing = await signedGet(`/v1/file${q('/nope.txt')}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('content-disposition'), null);
});

test('contentDisposition encoding', () => {
  assert.equal(
    contentDisposition('attachment', '바다 "1".jpg'),
    `attachment; filename="__ _1_.jpg"; filename*=UTF-8''%EB%B0%94%EB%8B%A4%20%221%22.jpg`,
  );
  assert.equal(contentDisposition('inline', "a'b(c).txt"), `inline; filename="a'b(c).txt"; filename*=UTF-8''a%27b%28c%29.txt`);
});

test('ip allowlist', async () => {
  const app = createApp({ driveRoot: root, hmacSecrets: toKeyList(SECRET), allowedIps: ['10.9.9.9'] });
  const s = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/health`);
    assert.equal(r.status, 403);
  } finally {
    s.close();
  }
});

test('zip: folder streams as a valid zip, links and system folder excluded', async () => {
  const r = await signedGet(`/v1/zip${q('/사진')}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.equal(r.headers.get('content-disposition'), contentDisposition('attachment', '사진.zip'));
  const { entries } = readZip(Buffer.from(await r.arrayBuffer()));
  assert.deepEqual(
    entries.map((e) => e.name),
    ['사진/', '사진/2024/', '사진/바다.jpg'],
  );
  assert.ok(entries[2].data.equals(Buffer.alloc(1000, 7)));

  // 루트 전체: .wooki(휴지통·업로드 임시), 링크(escape, photos-link), .DS_Store 제외
  fs.writeFileSync(path.join(root, '.wooki', 'trash', 'leak.txt'), 'TRASHED');
  const all = await signedGet(`/v1/zip${q('/')}`);
  const buf = Buffer.from(await all.arrayBuffer());
  assert.deepEqual(
    readZip(buf).entries.map((e) => e.name),
    ['Drive/', 'Drive/hello.txt', 'Drive/사진/', 'Drive/사진/2024/', 'Drive/사진/바다.jpg'],
  );
  assert.ok(!buf.includes(Buffer.from('TRASHED')));
  assert.ok(!buf.includes(Buffer.from('secret')));
  fs.rmSync(path.join(root, '.wooki', 'trash', 'leak.txt'));
});

test('zip: multiple items, bad selections', async () => {
  const r = await signedGet(`/v1/zip?path=${encodeURIComponent('/hello.txt')}&path=${encodeURIComponent('/사진/바다.jpg')}`);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'MIXED_PARENTS' });

  const ok = await signedGet(`/v1/zip?path=${encodeURIComponent('/hello.txt')}&path=${encodeURIComponent('/사진')}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-disposition'), contentDisposition('attachment', 'Drive.zip'));
  assert.deepEqual(
    readZip(Buffer.from(await ok.arrayBuffer())).entries.map((e) => e.name),
    ['hello.txt', '사진/', '사진/2024/', '사진/바다.jpg'],
  );

  for (const [p, code] of [
    ['/없음', 'NOT_FOUND'],
    ['/.wooki', 'PATH_RESERVED'],
    ['/escape', 'PATH_OUTSIDE_ROOT'],
  ]) {
    const bad = await signedGet(`/v1/zip${q(p)}`);
    assert.equal(bad.status >= 400, true, p);
    assert.deepEqual(await bad.json(), { error: code }, p);
  }
  assert.equal((await fetch(`${base}/v1/zip${q('/사진')}`)).status, 401);
});

test('config: empty values in the env file count as unset', async () => {
  const { loadConfig } = await import('../src/config.js');
  const c = loadConfig({ DRIVE_ROOT: root, AGENT_HMAC_SECRET: SECRET, AGENT_HOST: '', AGENT_PORT: '', AGENT_ALLOWED_IPS: '', FFMPEG_PATH: '' });
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 7401);
  assert.equal(c.allowedIps, null);
  assert.throws(() => loadConfig({ DRIVE_ROOT: root, AGENT_HMAC_SECRET: '' }), /AGENT_HMAC_SECRET/);
});

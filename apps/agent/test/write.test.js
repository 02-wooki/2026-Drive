import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { signRequest, toKeyList } from '@wooki-drive/shared/node';
import { createApp } from '../src/app.js';

const SECRET = 'w'.repeat(48);
const CHUNK = 1024; // 테스트용 작은 청크
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
let tmp, root, outside, server, base;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-write-'));
  root = path.join(tmp, 'Drive');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dest'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'a', 'file.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'dest', 'file.txt'), 'existing');
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'must survive');
  fs.symlinkSync(outside, path.join(root, 'link-out'), linkType);

  const app = createApp({ driveRoot: root, hmacSecrets: toKeyList(SECRET), uploadChunkSize: CHUNK });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method, pathWithQuery, body, { headers = {}, raw } = {}) {
  const json = body !== undefined ? JSON.stringify(body) : undefined;
  const sig = signRequest({ secret: SECRET, audience: 'agent', method, pathWithQuery, ...(json !== undefined ? { body: json } : {}) });
  const r = await fetch(base + pathWithQuery, {
    method,
    headers: { ...sig, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? json,
  });
  return { status: r.status, body: await r.json() };
}
const exists = (...p) => fs.existsSync(path.join(root, ...p));

test('system folder is hidden and unreachable', async () => {
  assert.ok(exists('.wooki', 'trash'));
  const list = await call('GET', `/v1/list?path=${encodeURIComponent('/')}`);
  assert.ok(!list.body.entries.some((e) => e.name === '.wooki'));
  for (const p of ['/.wooki', '/.WOOKI/trash', '/.wooki/staging']) {
    const r = await call('GET', `/v1/list?path=${encodeURIComponent(p)}`);
    assert.equal(r.status, 400, p);
    assert.equal(r.body.error, 'PATH_RESERVED');
  }
  assert.equal((await call('POST', '/v1/mkdir', { parent: '/', name: '.Wooki' })).body.error, 'PATH_RESERVED');
  assert.equal((await call('POST', '/v1/rename', { path: '/a', name: '.wooki' })).body.error, 'PATH_RESERVED');
  const mv = await call('POST', '/v1/move', { paths: ['/a/b'], to: '/.wooki/trash' });
  assert.equal(mv.body.error, 'PATH_RESERVED');
});

test('JSON bodies must be signed', async () => {
  const pq = '/v1/mkdir';
  const json = JSON.stringify({ parent: '/', name: 'x' });
  // 본문 해시 없이 서명
  const unsigned = signRequest({ secret: SECRET, audience: 'agent', method: 'POST', pathWithQuery: pq });
  let r = await fetch(base + pq, { method: 'POST', headers: { ...unsigned, 'Content-Type': 'application/json' }, body: json });
  assert.equal(r.status, 400);
  // 다른 본문의 해시로 서명
  const other = signRequest({ secret: SECRET, audience: 'agent', method: 'POST', pathWithQuery: pq, body: '{"parent":"/","name":"y"}' });
  r = await fetch(base + pq, { method: 'POST', headers: { ...other, 'Content-Type': 'application/json' }, body: json });
  assert.equal(r.status, 401);
  assert.ok(!exists('x'));
});

test('mkdir', async () => {
  assert.deepEqual((await call('POST', '/v1/mkdir', { parent: '/', name: '새 폴더' })).body, { path: '/새 폴더' });
  assert.equal((await call('POST', '/v1/mkdir', { parent: '/', name: '새 폴더' })).status, 409);
  assert.deepEqual((await call('POST', '/v1/mkdir', { parent: '/', name: '새 폴더', onConflict: 'rename' })).body, { path: '/새 폴더 (1)' });
  assert.equal((await call('POST', '/v1/mkdir', { parent: '/', name: 'CON' })).body.error, 'PATH_RESERVED_NAME');
  assert.equal((await call('POST', '/v1/mkdir', { parent: '/nope', name: 'x' })).status, 404);
  const nfd = await call('POST', '/v1/mkdir', { parent: '/', name: '한글'.normalize('NFD') });
  assert.equal(nfd.body.path, '/한글'); // NFC
});

test('rename, including case-only', async () => {
  fs.writeFileSync(path.join(root, 'case.txt'), 'c');
  assert.deepEqual((await call('POST', '/v1/rename', { path: '/case.txt', name: 'CASE.txt' })).body, { path: '/CASE.txt' });
  assert.ok(fs.readdirSync(root).includes('CASE.txt'));
  assert.equal((await call('POST', '/v1/rename', { path: '/CASE.txt', name: 'dest' })).status, 409);
  assert.equal((await call('POST', '/v1/rename', { path: '/', name: 'x' })).body.error, 'ROOT_IS_READONLY');
  assert.equal((await call('POST', '/v1/rename', { path: '/CASE.txt', name: '../x' })).body.error, 'PATH_INVALID_CHAR');
});

test('move: conflicts, into self, per-item results', async () => {
  const r = await call('POST', '/v1/move', { paths: ['/a/file.txt', '/a/b', '/nope'], to: '/dest' });
  assert.deepEqual(r.body.results, [
    { from: '/a/file.txt', error: 'ALREADY_EXISTS' },
    { from: '/a/b', path: '/dest/b' },
    { from: '/nope', error: 'NOT_FOUND' },
  ]);
  const r2 = await call('POST', '/v1/move', { paths: ['/a/file.txt'], to: '/dest', onConflict: 'rename' });
  assert.deepEqual(r2.body.results, [{ from: '/a/file.txt', path: '/dest/file (1).txt' }]);
  assert.equal(fs.readFileSync(path.join(root, 'dest', 'file (1).txt'), 'utf8'), 'hello');

  const self = await call('POST', '/v1/move', { paths: ['/dest'], to: '/dest/b' });
  assert.equal(self.body.results[0].error, 'MOVE_INTO_SELF');
  const same = await call('POST', '/v1/move', { paths: ['/dest/b'], to: '/dest' });
  assert.equal(same.body.results[0].error, 'SAME_LOCATION');
  assert.equal((await call('POST', '/v1/move', { paths: [], to: '/' })).status, 400);
});

test('trash → list → restore (with conflict) → delete; links are never followed', async () => {
  fs.writeFileSync(path.join(root, 'trash-me.txt'), 'bye');
  const t = await call('POST', '/v1/trash', { paths: ['/trash-me.txt', '/link-out', '/'] });
  assert.ok(t.body.results[0].id);
  assert.ok(t.body.results[1].id);
  assert.equal(t.body.results[2].error, 'ROOT_IS_READONLY');
  assert.ok(!exists('trash-me.txt'));

  const list = (await call('GET', '/v1/trash')).body.items;
  const mine = list.find((i) => i.originalPath === '/trash-me.txt');
  assert.equal(mine.name, 'trash-me.txt');
  assert.equal(mine.type, 'file');

  // 같은 이름이 생긴 뒤 복원 → "(1)"
  fs.writeFileSync(path.join(root, 'trash-me.txt'), 'new');
  const rs = await call('POST', '/v1/trash/restore', { ids: [mine.id] });
  assert.deepEqual(rs.body.results, [{ from: mine.id, path: '/trash-me (1).txt' }]);
  assert.equal(fs.readFileSync(path.join(root, 'trash-me (1).txt'), 'utf8'), 'bye');

  // 바깥을 가리키는 정션을 영구 삭제해도 대상은 살아 있어야 한다
  const linkItem = (await call('GET', '/v1/trash')).body.items.find((i) => i.name === 'link-out');
  const del = await call('POST', '/v1/trash/delete', { ids: [linkItem.id, '0000000000000-000000000000', '../../x'] });
  assert.deepEqual(del.body.results.map((r) => r.error ?? 'ok'), ['ok', 'NOT_FOUND', 'NOT_FOUND']);
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'must survive');

  // 비우기
  await call('POST', '/v1/trash', { paths: ['/trash-me (1).txt'] });
  const e = await call('POST', '/v1/trash/empty', {});
  assert.equal(e.body.deleted, 1);
  assert.deepEqual((await call('GET', '/v1/trash')).body.items, []);
});

test('chunked upload with resume, hash check and folder creation', async () => {
  const data = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251));
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const mtime = Date.UTC(2020, 0, 2);

  const c = await call('POST', '/v1/uploads', { path: '/업로드/깊은/data.bin', size: data.length, mtimeMs: mtime });
  assert.equal(c.status, 201);
  assert.equal(c.body.chunkSize, CHUNK);
  const id = c.body.id;
  const put = (offset, chunk, hash = sha(chunk)) =>
    call('PUT', `/v1/uploads/${id}?offset=${offset}`, undefined, { raw: chunk, headers: { 'X-Chunk-Sha256': hash } });

  assert.equal((await put(0, data.subarray(0, 1024))).body.received, 1024);
  // 재전송(같은 청크) → 성공, 위치 그대로
  assert.equal((await put(0, data.subarray(0, 1024))).body.received, 1024);
  // 건너뛰기 → 409 + 현재 위치
  const skip = await put(2048, data.subarray(2048));
  assert.equal(skip.status, 409);
  assert.deepEqual(skip.body, { error: 'OFFSET_MISMATCH', received: 1024 });
  // 해시 불일치 → 거부되고 위치 유지
  const bad = await put(1024, data.subarray(1024, 2048), '0'.repeat(64));
  assert.equal(bad.body.error, 'CHUNK_CORRUPT');
  assert.equal((await call('GET', `/v1/uploads/${id}`)).body.received, 1024);
  // 청크 크기 초과
  assert.equal((await put(1024, Buffer.alloc(CHUNK + 1))).body.error, 'BAD_CHUNK_LENGTH');
  // 완료 전 complete → 409
  assert.equal((await call('POST', `/v1/uploads/${id}/complete`, {})).body.error, 'UPLOAD_INCOMPLETE');

  await put(1024, data.subarray(1024, 2048));
  await put(2048, data.subarray(2048));
  const done = await call('POST', `/v1/uploads/${id}/complete`, {});
  assert.deepEqual(done.body, { path: '/업로드/깊은/data.bin' });
  const saved = path.join(root, '업로드', '깊은', 'data.bin');
  assert.ok(fs.readFileSync(saved).equals(data));
  assert.equal(fs.statSync(saved).mtimeMs, mtime);
  assert.equal((await call('GET', `/v1/uploads/${id}`)).status, 404);

  // 같은 이름 다시 업로드 → "(1)"
  const c2 = await call('POST', '/v1/uploads', { path: '/업로드/깊은/data.bin', size: 3 });
  await call('PUT', `/v1/uploads/${c2.body.id}?offset=0`, undefined, { raw: Buffer.from('abc') });
  assert.deepEqual((await call('POST', `/v1/uploads/${c2.body.id}/complete`, {})).body, { path: '/업로드/깊은/data (1).bin' });

  // 빈 파일
  const c3 = await call('POST', '/v1/uploads', { path: '/empty.txt', size: 0 });
  assert.deepEqual((await call('POST', `/v1/uploads/${c3.body.id}/complete`, {})).body, { path: '/empty.txt' });

  // 취소
  const c4 = await call('POST', '/v1/uploads', { path: '/cancel.bin', size: 10 });
  assert.equal((await call('DELETE', `/v1/uploads/${c4.body.id}`)).status, 200);
  assert.equal((await call('GET', `/v1/uploads/${c4.body.id}`)).status, 404);

  // 잘못된 대상
  assert.equal((await call('POST', '/v1/uploads', { path: '/', size: 1 })).body.error, 'PATH_ROOT');
  assert.equal((await call('POST', '/v1/uploads', { path: '/.wooki/x', size: 1 })).body.error, 'PATH_RESERVED');
  assert.equal((await call('POST', '/v1/uploads', { path: '/x', size: -1 })).body.error, 'BAD_SIZE');
  assert.equal((await call('POST', '/v1/uploads', { path: '/x', size: 2 ** 52 })).body.error, 'INSUFFICIENT_STORAGE');
  assert.equal((await call('POST', '/v1/uploads', { path: '/x', size: 1e18 })).body.error, 'BAD_SIZE'); // 안전한 정수 아님
  assert.equal((await call('GET', '/v1/uploads/..%2F..%2Fx')).status, 404);
});

test('upload conflicts: check, replace (old file to trash), fail, folder cannot be replaced', async () => {
  fs.mkdirSync(path.join(root, 'up'));
  fs.writeFileSync(path.join(root, 'up', 'same.txt'), 'old');
  fs.mkdirSync(path.join(root, 'up', 'dir.txt'));
  const nfd = '/up/' + '한글.txt'.normalize('NFD');
  fs.writeFileSync(path.join(root, 'up', '한글.txt'.normalize('NFC')), 'nfc');

  // check: 있는 것만, 경로가 잘못된 것은 조용히 건너뜀. NFD 로 물어도 저장될 NFC 이름으로 비교
  const chk = await call('POST', '/v1/uploads/check', { paths: ['/up/same.txt', '/up/dir.txt', '/up/new.txt', '/up/none/x.txt', nfd, '/.wooki/x', '/up/../a'] });
  assert.equal(chk.status, 200);
  assert.deepEqual(
    chk.body.conflicts.map((c) => [c.path, c.type, c.size]),
    [
      ['/up/same.txt', 'file', 3],
      ['/up/dir.txt', 'dir', null],
      [nfd, 'file', 3],
    ],
  );
  assert.equal((await call('POST', '/v1/uploads/check', { paths: [] })).body.error, 'BAD_LIST');

  const upload = async (p, content, onConflict) => {
    const c = await call('POST', '/v1/uploads', { path: p, size: content.length, ...(onConflict ? { onConflict } : {}) });
    if (c.status !== 201) return c;
    if (content.length) await call('PUT', `/v1/uploads/${c.body.id}?offset=0`, undefined, { raw: Buffer.from(content) });
    return { ...(await call('POST', `/v1/uploads/${c.body.id}/complete`, {})), id: c.body.id };
  };

  // replace: 같은 이름으로 저장되고 기존 파일은 휴지통에 (되돌릴 수 있음)
  const r = await upload('/up/same.txt', 'new!', 'replace');
  assert.deepEqual(r.body, { path: '/up/same.txt', replaced: true });
  assert.equal(fs.readFileSync(path.join(root, 'up', 'same.txt'), 'utf8'), 'new!');
  assert.ok(!exists('up', 'same (1).txt'));
  const trashed = (await call('GET', '/v1/trash')).body.items.find((i) => i.originalPath === '/up/same.txt');
  assert.ok(trashed, 'old file is in the trash');
  assert.equal(fs.readFileSync(path.join(root, '.wooki', 'trash', trashed.id, 'data', 'same.txt'), 'utf8'), 'old');

  // replace 인데 기존 항목이 없으면 그냥 저장
  assert.deepEqual((await upload('/up/fresh.txt', 'x', 'replace')).body, { path: '/up/fresh.txt' });

  // fail: 있으면 시작부터 409(청크를 보내기 전에 거른다), 없으면 저장
  const f = await call('POST', '/v1/uploads', { path: '/up/same.txt', size: 3, onConflict: 'fail' });
  assert.equal(f.status, 409);
  assert.equal(f.body.error, 'ALREADY_EXISTS');
  assert.deepEqual((await upload('/up/new.txt', 'n', 'fail')).body, { path: '/up/new.txt' });

  // 폴더는 대체 불가 (역시 시작부터)
  const d = await call('POST', '/v1/uploads', { path: '/up/dir.txt', size: 1, onConflict: 'replace' });
  assert.equal(d.status, 409);
  assert.equal(d.body.error, 'CANNOT_REPLACE_FOLDER');
  assert.ok(fs.statSync(path.join(root, 'up', 'dir.txt')).isDirectory());

  // 받는 사이에 생긴 충돌: fail 은 complete 에서 409 + 임시 파일 정리, 덮어쓰지 않음
  const late = await call('POST', '/v1/uploads', { path: '/up/late.txt', size: 1, onConflict: 'fail' });
  await call('PUT', `/v1/uploads/${late.body.id}?offset=0`, undefined, { raw: Buffer.from('L') });
  fs.writeFileSync(path.join(root, 'up', 'late.txt'), 'someone else');
  const lateDone = await call('POST', `/v1/uploads/${late.body.id}/complete`, {});
  assert.equal(lateDone.body.error, 'ALREADY_EXISTS');
  assert.equal(fs.readFileSync(path.join(root, 'up', 'late.txt'), 'utf8'), 'someone else');
  assert.equal((await call('GET', `/v1/uploads/${late.body.id}`)).status, 404);

  // 받는 사이에 폴더가 생기면 replace 도 거부
  const late2 = await call('POST', '/v1/uploads', { path: '/up/late2', size: 1, onConflict: 'replace' });
  await call('PUT', `/v1/uploads/${late2.body.id}?offset=0`, undefined, { raw: Buffer.from('L') });
  fs.mkdirSync(path.join(root, 'up', 'late2'));
  assert.equal((await call('POST', `/v1/uploads/${late2.body.id}/complete`, {})).body.error, 'CANNOT_REPLACE_FOLDER');

  // 기본(onConflict 없음)은 그대로 "(1)" — 버퍼 동기화(D21) 호환
  assert.deepEqual((await upload('/up/same.txt', 'again')).body, { path: '/up/same (1).txt' });
  assert.equal((await call('POST', '/v1/uploads', { path: '/up/y', size: 1, onConflict: 'overwrite' })).body.error, 'BAD_CONFLICT_MODE');
});

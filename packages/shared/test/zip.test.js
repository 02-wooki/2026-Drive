import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { zipStream, zipEntriesFor, planZip } from '../src/node/zip.js';
import { readZip } from './zip-reader.js';

async function collect(gen) {
  const chunks = [];
  for await (const c of gen) chunks.push(c);
  return Buffer.concat(chunks);
}

const memEntry = (name, data, extra = {}) => ({
  name,
  type: 'file',
  size: data.length,
  mtime: new Date(2026, 10, 26, 12, 34, 56),
  open: async () => Readable.from([data]),
  ...extra,
});

test('zipStream: files, folders, UTF-8 names round-trip', async () => {
  const big = crypto.randomBytes(3 * 1024 * 1024); // 압축 안 되는 데이터, 여러 청크
  const text = Buffer.from('안녕하세요\n'.repeat(5000));
  const buf = await collect(
    zipStream([
      { name: '여행', type: 'dir', mtime: new Date() },
      memEntry('여행/사진 1.jpg', big),
      memEntry('여행/메모.txt', text),
      memEntry('빈 파일', Buffer.alloc(0)),
    ]),
  );
  const { zip64, entries } = readZip(buf);
  assert.equal(zip64, false);
  assert.deepEqual(
    entries.map((e) => [e.name, e.dir]),
    [
      ['여행/', true],
      ['여행/사진 1.jpg', false],
      ['여행/메모.txt', false],
      ['빈 파일', false],
    ],
  );
  assert.ok(entries[1].data.equals(big));
  assert.ok(entries[2].data.equals(text));
  assert.equal(entries[3].data.length, 0);
  assert.ok(buf.length < big.length + text.length, 'text is actually compressed');
});

test('zipStream: ZIP64 records are well-formed', async () => {
  const data = crypto.randomBytes(100_000);
  const buf = await collect(zipStream([memEntry('a.bin', data), { name: 'd', type: 'dir' }], { forceZip64: true }));
  const { zip64, entries } = readZip(buf);
  assert.equal(zip64, true);
  assert.ok(entries[0].data.equals(data));
  assert.equal(entries[1].name, 'd/');
});

test('zipStream: entries that vanished (open → null) are skipped', async () => {
  const buf = await collect(zipStream([memEntry('gone.txt', Buffer.from('x'), { open: async () => null }), memEntry('ok.txt', Buffer.from('ok'))]));
  assert.deepEqual(
    readZip(buf).entries.map((e) => e.name),
    ['ok.txt'],
  );
});

test('zipStream: a read error fails the stream instead of producing a truncated zip', async () => {
  const failing = memEntry('bad.bin', Buffer.alloc(10), {
    open: async () =>
      (async function* () {
        yield Buffer.alloc(10);
        throw new Error('disk read failed');
      })(),
  });
  await assert.rejects(collect(zipStream([memEntry('a', Buffer.from('a')), failing])), /disk read failed/);
});

test('zipEntriesFor: walks folders, skips links, junk and skipDir', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wd-zip-'));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'wd-zip-out-'));
  try {
    await fsp.mkdir(path.join(root, '사진/여행/빈폴더'), { recursive: true });
    await fsp.writeFile(path.join(root, '사진/a.jpg'), 'A');
    await fsp.writeFile(path.join(root, '사진/여행/b.txt'), 'B');
    await fsp.writeFile(path.join(root, '사진/.DS_Store'), 'junk');
    await fsp.mkdir(path.join(root, '사진/skip-me'));
    await fsp.writeFile(path.join(root, '사진/skip-me/x'), 'X');
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'SECRET');
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(root, '사진/link'), 'junction');
    } catch {
      linked = false; // 권한 없는 환경
    }

    const skipDir = (real) => path.basename(real) === 'skip-me';
    const buf = await collect(zipStream(zipEntriesFor(root, ['/사진'], { skipDir })));
    const { entries } = readZip(buf);
    assert.deepEqual(
      entries.map((e) => e.name),
      ['사진/', '사진/a.jpg', '사진/여행/', '사진/여행/b.txt', '사진/여행/빈폴더/'],
    );
    assert.equal(entries.find((e) => e.name === '사진/여행/b.txt').data.toString(), 'B');
    if (linked) assert.ok(!buf.includes(Buffer.from('SECRET')));

    // 여러 항목 선택: 각 이름부터
    const multi = readZip(await collect(zipStream(zipEntriesFor(root, ['/사진/a.jpg', '/사진/여행'])))).entries;
    assert.deepEqual(
      multi.map((e) => e.name),
      ['a.jpg', '여행/', '여행/b.txt', '여행/빈폴더/'],
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('planZip: same-parent selection, names, root only alone', () => {
  assert.deepEqual(planZip(['/a/b', '/a/c', '/a/b']), { vpaths: ['/a/b', '/a/c'], filename: 'a.zip' });
  assert.deepEqual(planZip('/사진/여행'), { vpaths: ['/사진/여행'], filename: '여행.zip' });
  assert.deepEqual(planZip(['/x', '/y']), { vpaths: ['/x', '/y'], filename: 'Drive.zip' });
  assert.deepEqual(planZip('/'), { vpaths: ['/'], filename: 'Drive.zip' });
  assert.throws(() => planZip(['/', '/a']), { code: 'BAD_LIST' });
  assert.throws(() => planZip(['/a/b', '/c']), { code: 'MIXED_PARENTS' });
  assert.throws(() => planZip([]), { code: 'BAD_LIST' });
  assert.throws(() => planZip(undefined), { code: 'BAD_LIST' });
  assert.throws(() => planZip(['/a/../b']), { code: 'DOT_SEGMENT' });
});

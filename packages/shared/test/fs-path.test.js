import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveInRoot, resolveInRootReal, isInside, PathError } from '../src/node/index.js';

const rejects = async (p, code) => {
  await assert.rejects(p, (e) => e instanceof PathError && e.code === code);
};

test('resolveInRoot (win32 rules)', () => {
  const w = { pathImpl: path.win32 };
  assert.equal(resolveInRoot('D:\\Drive', '/', w), 'D:\\Drive');
  assert.equal(resolveInRoot('D:\\Drive', '/a/b.txt', w), 'D:\\Drive\\a\\b.txt');
  assert.equal(resolveInRoot('D:\\Drive\\', '/사진', w), 'D:\\Drive\\사진');
  assert.throws(() => resolveInRoot('D:\\Drive', '/../x', w), PathError);
  assert.throws(() => resolveInRoot('D:\\Drive', '/C:', w), PathError);
  assert.throws(() => resolveInRoot('relative', '/a', w), /absolute/);
});

test('resolveInRoot (posix rules)', () => {
  const p = { pathImpl: path.posix };
  assert.equal(resolveInRoot('/var/lib/wd/demo', '/a', p), '/var/lib/wd/demo/a');
  assert.equal(resolveInRoot('/var/lib/wd/demo/', '/', p), '/var/lib/wd/demo');
});

test('isInside', () => {
  const w = path.win32;
  assert.equal(isInside('D:\\Drive', 'D:\\Drive', w), true);
  assert.equal(isInside('D:\\Drive', 'd:\\drive\\A', w), true);
  assert.equal(isInside('D:\\Drive', 'D:\\Drive2', w), false);
  assert.equal(isInside('D:\\Drive', 'D:\\', w), false);
  assert.equal(isInside('D:\\Drive', 'C:\\Drive\\a', w), false);
  assert.equal(isInside('D:\\Drive', 'D:\\Drive\\..foo', w), true);
  assert.equal(isInside('/r', '/r/..foo', path.posix), true);
  assert.equal(isInside('/r', '/r2', path.posix), false);
});

// ── 실제 파일 시스템: 링크/정션 탈출 ─────────────────────────────
let tmp, root, outside;
const linkType = process.platform === 'win32' ? 'junction' : 'dir'; // 정션은 관리자 권한 불필요

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-shared-'));
  root = path.join(tmp, 'root');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(root, 'inner'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'inner', 'a.txt'), 'a');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  fs.symlinkSync(outside, path.join(root, 'escape'), linkType);
  fs.symlinkSync(path.join(root, 'inner'), path.join(root, 'alias'), linkType);
  fs.symlinkSync(path.join(outside, 'nope'), path.join(root, 'dangling'), linkType);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('existing file inside root', async () => {
  const r = await resolveInRootReal(root, '/inner/a.txt');
  assert.equal(r.exists, true);
  assert.equal(r.absPath, path.join(root, 'inner', 'a.txt'));
  assert.equal(r.realPath, fs.realpathSync.native(path.join(root, 'inner', 'a.txt')));
});

test('non-existent target (upload / mkdir) inside root', async () => {
  const r = await resolveInRootReal(root, '/inner/new/deeper/file.bin');
  assert.equal(r.exists, false);
  assert.equal(r.realPath, path.join(fs.realpathSync.native(path.join(root, 'inner')), 'new', 'deeper', 'file.bin'));
});

test('root itself', async () => {
  const r = await resolveInRootReal(root, '/');
  assert.equal(r.exists, true);
});

test('link pointing inside root is allowed', async () => {
  const r = await resolveInRootReal(root, '/alias/a.txt');
  assert.equal(r.exists, true);
});

test('link escaping root is rejected', async () => {
  await rejects(resolveInRootReal(root, '/escape'), 'OUTSIDE_ROOT');
  await rejects(resolveInRootReal(root, '/escape/secret.txt'), 'OUTSIDE_ROOT');
  await rejects(resolveInRootReal(root, '/escape/new-file.txt'), 'OUTSIDE_ROOT');
});

test('dangling link is rejected (write would land outside root)', async () => {
  await rejects(resolveInRootReal(root, '/dangling'), 'DANGLING_LINK');
  await rejects(resolveInRootReal(root, '/dangling/x'), 'DANGLING_LINK');
});

test('path through a file', async () => {
  const r = await resolveInRootReal(root, '/inner/a.txt/x');
  assert.equal(r.exists, false);
});

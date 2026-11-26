import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { signRequest, toKeyList } from '@wooki-drive/shared/node';
import { createApp } from '../src/app.js';
import { Thumbnailer, detectFfmpeg, thumbKind } from '../src/thumbs.js';

const SECRET = 't'.repeat(48);
let tmp, root, server, base;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-thumb-'));
  root = path.join(tmp, 'Drive');
  fs.mkdirSync(root);
  // 1200x800 이미지, EXIF 방향 6(90도 회전)
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#3366cc' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(path.join(root, '사진.jpg'));
  await sharp({ create: { width: 50, height: 40, channels: 4, background: '#ff000080' } }).png().toFile(path.join(root, 'small.png'));
  fs.writeFileSync(path.join(root, 'broken.png'), 'not really a png');
  fs.writeFileSync(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, 'movie.mp4'), 'x');

  const app = createApp({ driveRoot: root, hmacSecrets: toKeyList(SECRET), thumbnailer: new Thumbnailer({ ffmpeg: null }) });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const thumb = async (p, w = 256) => {
  const pq = `/v1/thumb?path=${encodeURIComponent(p)}&w=${w}`;
  return fetch(base + pq, { headers: signRequest({ secret: SECRET, audience: 'agent', method: 'GET', pathWithQuery: pq }) });
};

test('image thumbnail: webp, fits the box, honours EXIF rotation, carries version', async () => {
  const r = await thumb('/사진.jpg');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/webp');
  const st = fs.statSync(path.join(root, '사진.jpg'));
  assert.equal(r.headers.get('x-thumb-version'), `${Math.floor(st.mtimeMs)}-${st.size}`);
  const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
  assert.equal(meta.format, 'webp');
  // 1200x800 + 90도 회전 → 세로가 긴 그림, 256 상자 안
  assert.equal(meta.height, 256);
  assert.ok(meta.width < meta.height);
});

test('small images are not enlarged', async () => {
  const meta = await sharp(Buffer.from(await (await thumb('/small.png', 512)).arrayBuffer())).metadata();
  assert.deepEqual([meta.width, meta.height], [50, 40]);
});

test('unsupported or broken inputs', async () => {
  assert.equal((await (await thumb('/icon.svg')).json()).error, 'THUMB_UNSUPPORTED'); // SVG 는 래스터화하지 않음
  assert.equal((await (await thumb('/movie.mp4')).json()).error, 'THUMB_UNSUPPORTED'); // ffmpeg 없음
  const broken = await thumb('/broken.png');
  assert.equal(broken.status, 422);
  assert.equal((await broken.json()).error, 'THUMB_FAILED');
  assert.equal((await (await thumb('/사진.jpg', 300)).json()).error, 'BAD_THUMB_WIDTH');
  assert.equal((await thumb('/.wooki/x.png')).status, 400);
});

test('thumbKind', () => {
  assert.equal(thumbKind('a.JPG'), 'image');
  assert.equal(thumbKind('a.mov'), 'video');
  assert.equal(thumbKind('a.svg'), null);
  assert.equal(thumbKind('a.heic'), null);
});

test('video thumbnail via ffmpeg (skipped when ffmpeg is not installed)', { skip: !detectFfmpeg() && 'ffmpeg not installed' }, async () => {
  const ffmpeg = detectFfmpeg();
  const out = path.join(tmp, 'clip.mp4');
  const { spawnSync } = await import('node:child_process');
  spawnSync(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=10', '-pix_fmt', 'yuv420p', out, '-y'], { windowsHide: true });
  const t = new Thumbnailer({ ffmpeg });
  const meta = await sharp(await t.make(out, 'clip.mp4', 256)).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256);
});

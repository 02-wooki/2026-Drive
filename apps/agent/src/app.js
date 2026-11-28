// agent HTTP 앱. 테스트에서 직접 띄울 수 있도록 listen 과 분리한다.
//
// GET  /health                         인증 없음. 내용 없는 생존 확인.
// ── 읽기 ──
// GET  /v1/list?path=/a                폴더 목록 (루트의 시스템 폴더는 숨김)
// GET  /v1/stat?path=/a/b.jpg          메타데이터
// GET  /v1/file?path=&disposition=     파일 내용. Range / If-None-Match 지원
// GET  /v1/thumb?path=&w=128|256|512   WebP 썸네일 + X-Thumb-Version
// GET  /v1/zip?path=&path=…            폴더·여러 항목을 zip 으로 스트리밍 (같은 폴더 안 항목만, 시스템 폴더 제외)
// ── 쓰기 (JSON 본문, 본문 해시 서명 필수) ──
// POST /v1/mkdir        { parent, name, onConflict? }        → { path }
// POST /v1/rename       { path, name }                        → { path }
// POST /v1/move         { paths[], to, onConflict? }          → { results[] }
// POST /v1/trash        { paths[] }                           → { results[] }
// GET  /v1/trash                                              → { items[] }
// GET  /v1/trash/summary                                      → { count, totalBytes, oldestDeletedAt }
// POST /v1/trash/restore { ids[] }                            → { results[] }
// POST /v1/trash/delete  { ids[] }                            → { results[] }   (영구 삭제 — gateway 가 패스키 재인증 후에만 호출)
// POST /v1/trash/empty                                        → { deleted }
// ── 업로드 (청크) ──
// POST   /v1/uploads/check        { paths[] }                 → { conflicts: [{ path, type, size, mtimeMs }] }  (이미 있는 것만)
// POST   /v1/uploads              { path, size, mtimeMs?, onConflict? }  → { id, size, received, chunkSize }
//          onConflict: 'rename'(기본, "이름 (1)") | 'replace'(기존 파일은 휴지통으로) | 'fail'(409 ALREADY_EXISTS)
// GET    /v1/uploads/:id                                      → { id, size, received }
// PUT    /v1/uploads/:id?offset=N  본문=청크(원본 바이트), X-Chunk-Sha256
// POST   /v1/uploads/:id/complete                             → { path }
// DELETE /v1/uploads/:id
// ── 묶음 업로드 (작은 파일 여러 개를 요청 하나로) ──
// POST   /v1/uploads/batch?id=&manifestBytes=N&manifestSha256=  본문 = 매니페스트 JSON(N바이트) + 파일 바이트를 순서대로 이어 붙인 것
//          매니페스트 { files: [{ path, size, sha256, mtimeMs?, onConflict? }] }
//          → { results: [{ path, finalPath, replaced? } | { path, error }] }  (파일마다 성공·실패, 순서 그대로)
//          본문은 서명하지 않지만 매니페스트 해시가 서명된 쿼리에 있고, 매니페스트에 파일마다 해시가 있다.
//          같은 id 로 다시 보내면(응답을 못 받고 재시도) 처음 결과를 그대로 돌려준다 → 두 번 저장되지 않는다.
//
// 시스템 폴더(.wooki: 휴지통·업로드 임시 파일)는 어떤 API 로도 직접 접근할 수 없다 (ai.md D15).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import {
  listDirectory,
  statPath,
  contentDisposition,
  makeDirectory,
  renameEntry,
  moveEntry,
  trashEntry,
  listTrash,
  trashSummary,
  restoreTrash,
  deleteTrash,
  ensureDirectory,
  availableName,
  resolveInRootReal,
  normalizeNewName,
  parseVirtualPath,
  formatVirtualPath,
  assertNotReserved,
  isReservedPath,
  UploadStore,
  UNSIGNED_PAYLOAD,
  sha256Hex,
  SYSTEM_DIR_NAME,
  UPLOAD_CHUNK_SIZE,
  MAX_CHUNK_REQUEST_BYTES,
  planZip,
  zipStream,
  zipEntriesFor,
  isInside,
} from '@wooki-drive/shared/node';
import { ipAllowlist, requireSignature } from './auth.js';
import { HttpError, toHttpError } from './http-error.js';
import { Thumbnailer } from './thumbs.js';

const MAX_BATCH = 1000;
const UPLOAD_BATCH_MAX_FILES = 500;
const BATCH_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const BATCH_RESULT_TTL_MS = 3600_000;
const BATCH_RESULT_MAX = 500;
const FREE_SPACE_MARGIN = 1024 ** 3; // 디스크를 꽉 채우지 않도록 1GB 여유

/** 시스템 폴더 경로들. 루트 안이지만 웹 API 로는 접근 불가. */
export function systemDirs(driveRoot) {
  const base = path.join(driveRoot, SYSTEM_DIR_NAME);
  return { base, trash: path.join(base, 'trash'), staging: path.join(base, 'staging') };
}

/** JSON 본문 + 서명된 본문 해시 검증. 서명이 UNSIGNED-PAYLOAD 면 거부. */
const signedJson = [
  express.raw({ type: () => true, limit: '256kb' }),
  (req, _res, next) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (req.signedBodySha256 === UNSIGNED_PAYLOAD) return next(new HttpError(400, 'BODY_NOT_SIGNED'));
    if (sha256Hex(raw) !== req.signedBodySha256) return next(new HttpError(401, 'UNAUTHORIZED'));
    try {
      req.json = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    } catch {
      return next(new HttpError(400, 'BAD_JSON'));
    }
    if (!req.json || typeof req.json !== 'object' || Array.isArray(req.json)) return next(new HttpError(400, 'BAD_JSON'));
    next();
  },
];

function stringList(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BATCH || !v.every((s) => typeof s === 'string')) {
    throw new HttpError(400, 'BAD_LIST');
  }
  return v;
}

function conflictMode(v) {
  if (v === undefined || v === 'fail' || v === 'rename') return v ?? 'fail';
  throw new HttpError(400, 'BAD_CONFLICT_MODE');
}

const UPLOAD_CONFLICT_MODES = new Set(['rename', 'replace', 'fail']);

function uploadConflictMode(v) {
  if (v === undefined) return 'rename'; // 버퍼 동기화(D21) 등 기존 호출은 그대로
  if (UPLOAD_CONFLICT_MODES.has(v)) return v;
  throw new HttpError(400, 'BAD_CONFLICT_MODE');
}

/** 업로드 대상 가상 경로 — 폴더 업로드는 중간 폴더도 새로 만들 수 있으므로 모든 세그먼트를 NFC 로 (ai.md D12) */
function uploadVpath(raw) {
  const segs = parseVirtualPath(raw);
  if (segs.length === 0) throw new HttpError(400, 'PATH_ROOT');
  return assertNotReserved(formatVirtualPath(segs.map((s) => normalizeNewName(s))));
}

/** 이미 있는 항목의 종류. 없으면 null. 링크는 링크 자체로 본다(대체 시 링크만 휴지통으로). */
async function existingType(root, vpath) {
  const { absPath, exists } = await resolveInRootReal(root, vpath);
  if (!exists) return null;
  const st = await fsp.lstat(absPath);
  return {
    type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
    size: st.isFile() ? st.size : null,
    mtimeMs: st.mtimeMs,
  };
}

/** 항목별 결과. 하나가 실패해도 나머지는 진행한다. */
async function each(list, fn) {
  const results = [];
  for (const item of list) {
    try {
      results.push({ from: item, ...(await fn(item)) });
    } catch (err) {
      results.push({ from: item, error: toHttpError(err).code });
    }
  }
  return results;
}

/**
 * @param {{
 *   driveRoot: string, hmacSecrets: Buffer[], allowedIps?: string[] | null,
 *   now?: () => number, log?: (msg: string) => void, uploadChunkSize?: number,
 * }} config
 */
export function createApp({
  driveRoot,
  hmacSecrets,
  allowedIps = null,
  now,
  log = () => {},
  uploadChunkSize = UPLOAD_CHUNK_SIZE,
  thumbnailer = new Thumbnailer(),
}) {
  const dirs = systemDirs(driveRoot);
  fs.mkdirSync(dirs.trash, { recursive: true });
  fs.mkdirSync(dirs.staging, { recursive: true });
  const uploads = new UploadStore({ stagingDir: dirs.staging, chunkSize: uploadChunkSize });

  const app = express();
  app.disable('x-powered-by');
  // 주의: app.set('etag', false) 를 하면 Express 가 sendFile 의 etag 옵션까지 꺼버린다(동영상 재검증 불가). 켜 둘 것.
  app.set('query parser', 'simple');
  app.locals.uploads = uploads;

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(ipAllowlist(allowedIps));

  // time: gateway 가 시계 차이를 감지하는 데 쓴다 (서명은 ±60초까지만 허용)
  app.get('/health', (_req, res) => res.json({ ok: true, time: (now ?? Date.now)() }));

  const v1 = express.Router();
  v1.use(requireSignature({ secrets: hmacSecrets, now, onReject: (reason) => log(`signature rejected: ${reason}`) }));

  // ── 읽기 ──
  v1.get('/list', async (req, res) => {
    const vpath = assertNotReserved(req.query.path);
    const result = await listDirectory(driveRoot, vpath);
    if (result.path === '/') result.entries = result.entries.filter((e) => e.name.toLowerCase() !== SYSTEM_DIR_NAME);
    res.json(result);
  });

  v1.get('/stat', async (req, res) => {
    const { realPath: _omit, ...info } = await statPath(driveRoot, assertNotReserved(req.query.path));
    res.json(info);
  });

  v1.get('/file', async (req, res, next) => {
    const disposition = req.query.disposition ?? 'attachment';
    if (disposition !== 'inline' && disposition !== 'attachment') throw new HttpError(400, 'BAD_DISPOSITION');

    const info = await statPath(driveRoot, assertNotReserved(req.query.path));
    if (info.type !== 'file') throw new HttpError(400, 'NOT_A_FILE');

    res.set('Content-Disposition', contentDisposition(disposition, info.name));
    res.set('Cache-Control', 'private, no-cache'); // ETag 재검증은 허용
    res.sendFile(
      info.realPath,
      // cacheControl:false — send 기본값(public, max-age=0)이 위에서 정한 private 을 덮어쓰지 않게
      { dotfiles: 'allow', acceptRanges: true, etag: true, lastModified: true, cacheControl: false },
      (err) => {
        if (err && !res.headersSent) next(err);
      },
    );
  });

  // 썸네일: 캐시는 gateway 가 X-Thumb-Version(수정시각-크기) 키로 보관
  v1.get('/thumb', async (req, res) => {
    const width = Number(req.query.w ?? 256);
    const info = await statPath(driveRoot, assertNotReserved(req.query.path));
    if (info.type !== 'file') throw new HttpError(400, 'NOT_A_FILE');
    const buf = await thumbnailer.make(info.realPath, info.name, width);
    res.set('Content-Type', 'image/webp');
    res.set('X-Thumb-Version', `${Math.floor(info.mtimeMs)}-${info.size}`);
    res.send(buf);
  });

  // 폴더 zip: 크기를 미리 알 수 없어 chunked 로 보낸다. 중간에 읽기가 실패하면 연결을 끊어 깨진 zip 이 정상처럼 저장되지 않게 한다.
  v1.get('/zip', async (req, res) => {
    const { vpaths, filename } = planZip(req.query.path);
    for (const p of vpaths) {
      if (p !== '/') assertNotReserved(p);
      await statPath(driveRoot, p); // 없으면 스트림 시작 전에 404
    }
    const realSystem = fs.realpathSync(dirs.base);
    const skipDir = (real) => isInside(realSystem, real);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', contentDisposition('attachment', filename));
    try {
      await pipeline(Readable.from(zipStream(zipEntriesFor(driveRoot, vpaths, { skipDir }))), res);
    } catch (err) {
      if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') log(`zip failed: ${err?.message ?? err}`);
      res.destroy();
    }
  });

  // ── 쓰기 ──
  v1.post('/mkdir', signedJson, async (req, res) => {
    const { parent, name, onConflict } = req.json;
    assertNotReserved(parent);
    if (parent === '/' && typeof name === 'string' && name.normalize('NFC').toLowerCase() === SYSTEM_DIR_NAME) throw new HttpError(400, 'PATH_RESERVED');
    res.json({ path: await makeDirectory(driveRoot, parent, name, { onConflict: conflictMode(onConflict) }) });
  });

  v1.post('/rename', signedJson, async (req, res) => {
    const { path: vpath, name } = req.json;
    assertNotReserved(vpath);
    const segs = parseVirtualPath(vpath);
    if (typeof name === 'string') assertNotReserved(formatVirtualPath([...segs.slice(0, -1), normalizeNewName(name)]));
    res.json({ path: await renameEntry(driveRoot, vpath, name) });
  });

  v1.post('/move', signedJson, async (req, res) => {
    const paths = stringList(req.json.paths);
    const to = assertNotReserved(req.json.to);
    const onConflict = conflictMode(req.json.onConflict);
    res.json({
      results: await each(paths, async (p) => {
        assertNotReserved(p);
        if (to === '/' && parseVirtualPath(p).at(-1)?.toLowerCase() === SYSTEM_DIR_NAME) throw new HttpError(400, 'PATH_RESERVED');
        return { path: await moveEntry(driveRoot, p, to, { onConflict }) };
      }),
    });
  });

  // ── 휴지통 ──
  v1.post('/trash', signedJson, async (req, res) => {
    const paths = stringList(req.json.paths);
    res.json({ results: await each(paths, async (p) => trashEntry(driveRoot, dirs.trash, assertNotReserved(p))) });
  });

  v1.get('/trash', async (_req, res) => {
    res.json({ items: await listTrash(dirs.trash) });
  });

  v1.get('/trash/summary', async (_req, res) => {
    res.json(await trashSummary(dirs.trash));
  });

  v1.post('/trash/restore', signedJson, async (req, res) => {
    const ids = stringList(req.json.ids);
    res.json({ results: await each(ids, async (id) => ({ path: await restoreTrash(driveRoot, dirs.trash, id) })) });
  });

  v1.post('/trash/delete', signedJson, async (req, res) => {
    const ids = stringList(req.json.ids);
    const results = await each(ids, async (id) => {
      await deleteTrash(dirs.trash, id);
      return {};
    });
    log(`trash: permanently deleted ${results.filter((r) => !r.error).length} item(s)`);
    res.json({ results });
  });

  v1.post('/trash/empty', signedJson, async (_req, res) => {
    const items = await listTrash(dirs.trash);
    let deleted = 0;
    for (const it of items) {
      await deleteTrash(dirs.trash, it.id);
      deleted++;
    }
    log(`trash: emptied (${deleted} item(s))`);
    res.json({ deleted });
  });

  // ── 업로드 ──
  // 올리기 전에 이미 있는 항목을 알려준다 → 웹이 대체/건너뛰기/취소를 묻는다. 경로가 잘못된 항목은 건너뜀(업로드 때 오류).
  v1.post('/uploads/check', signedJson, async (req, res) => {
    const paths = stringList(req.json.paths);
    const conflicts = [];
    for (const p of paths) {
      try {
        const found = await existingType(driveRoot, uploadVpath(p));
        if (found) conflicts.push({ path: p, ...found });
      } catch {
        // 잘못된 경로·깨진 링크 등은 업로드 단계에서 항목별 오류로 보인다
      }
    }
    res.json({ conflicts });
  });

  v1.post('/uploads', signedJson, async (req, res) => {
    const { size, mtimeMs } = req.json;
    const vpath = uploadVpath(req.json.path);
    const onConflict = uploadConflictMode(req.json.onConflict);
    if (mtimeMs !== undefined && !(Number.isFinite(mtimeMs) && mtimeMs > 0)) throw new HttpError(400, 'BAD_MTIME');
    // 받기 전에 걸러 낼 수 있는 충돌은 바로 거부 (완료 때 한 번 더 확인)
    if (onConflict !== 'rename') {
      const found = await existingType(driveRoot, vpath).catch(() => null);
      if (found && onConflict === 'fail') throw new HttpError(409, 'ALREADY_EXISTS');
      if (found && found.type !== 'file') throw new HttpError(409, 'CANNOT_REPLACE_FOLDER');
    }
    if (Number.isSafeInteger(size)) {
      const st = await fsp.statfs(driveRoot);
      if (size > st.bavail * st.bsize - FREE_SPACE_MARGIN) throw new HttpError(507, 'INSUFFICIENT_STORAGE');
    }
    const info = await uploads.create(size, { path: vpath, mtimeMs: mtimeMs ?? null, onConflict });
    res.status(201).json({ id: info.id, size: info.size, received: info.received, chunkSize: uploads.chunkSize });
  });

  v1.get('/uploads/:id', async (req, res) => {
    const info = await uploads.status(req.params.id);
    res.json({ id: info.id, size: info.size, received: info.received });
  });

  v1.put('/uploads/:id', async (req, res) => {
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length)) throw new HttpError(411, 'LENGTH_REQUIRED');
    const offset = Number(req.query.offset);
    const sha = typeof req.headers['x-chunk-sha256'] === 'string' ? req.headers['x-chunk-sha256'].toLowerCase() : null;
    const info = await uploads.writeChunk(req.params.id, offset, req, { length, sha256: sha });
    res.json({ id: info.id, size: info.size, received: info.received });
  });

  /**
   * 받아 둔 임시 파일을 제자리로 옮긴다 (청크 업로드 완료·묶음 업로드 공용).
   * 충돌이면 HttpError 를 던지고 임시 파일은 그대로 둔다(호출한 쪽이 정리).
   */
  async function commitUpload(partPath, vpath, onConflict, mtimeMs) {
    const segs = parseVirtualPath(vpath);
    const parentReal = await ensureDirectory(driveRoot, formatVirtualPath(segs.slice(0, -1)));
    const name = normalizeNewName(segs.at(-1));
    let finalName = name;
    let replaced = false;
    if (onConflict === 'rename') {
      finalName = await availableName(parentReal, name);
    } else {
      const found = await existingType(driveRoot, vpath);
      if (found) {
        if (onConflict === 'fail' || found.type !== 'file') {
          throw new HttpError(409, onConflict === 'fail' ? 'ALREADY_EXISTS' : 'CANNOT_REPLACE_FOLDER');
        }
        // 대체: 덮어쓰지 않고 기존 파일을 휴지통으로 → 되돌릴 수 있다 (D16 — 복구 불가 작업은 재인증 필요)
        await trashEntry(driveRoot, dirs.trash, vpath);
        replaced = true;
      }
    }
    const dest = path.join(parentReal, finalName);
    await fsp.rename(partPath, dest);
    if (mtimeMs) {
      const t = new Date(mtimeMs);
      await fsp.utimes(dest, t, t).catch(() => {});
    }
    const finalPath = formatVirtualPath([...segs.slice(0, -1), finalName]);
    if (isReservedPath(finalPath)) throw new HttpError(500, 'INTERNAL'); // 위 검증으로 불가능해야 함
    return replaced ? { path: finalPath, replaced: true } : { path: finalPath };
  }

  v1.post('/uploads/:id/complete', signedJson, async (req, res) => {
    const { info, partPath } = await uploads.take(req.params.id);
    let done;
    try {
      done = await commitUpload(partPath, info.meta.path, info.meta.onConflict ?? 'rename', info.meta.mtimeMs);
    } catch (err) {
      // 받는 사이에 생긴 충돌. 임시 파일은 지운다(같은 파일을 다른 방식으로 다시 올리게).
      if (err instanceof HttpError && err.status === 409) await uploads.finish(info.id);
      throw err;
    }
    await uploads.finish(info.id);
    res.json(done);
  });

  // 묶음 업로드. id → 결과 (재시도 시 그대로 돌려줌). 처리 중이면 'running'.
  const batchResults = new Map();
  const rememberBatch = (id, value) => {
    batchResults.delete(id);
    batchResults.set(id, value);
    const cutoff = Date.now() - BATCH_RESULT_TTL_MS;
    for (const [k, v] of batchResults) {
      if (v === 'running') continue;
      if (v.at < cutoff || batchResults.size > BATCH_RESULT_MAX) batchResults.delete(k); // 오래된 것부터
    }
  };

  v1.post('/uploads/batch', express.raw({ type: () => true, limit: MAX_CHUNK_REQUEST_BYTES }), async (req, res) => {
    const id = typeof req.query.id === 'string' && BATCH_ID_RE.test(req.query.id) ? req.query.id : null;
    if (!id) throw new HttpError(400, 'BAD_BATCH_ID');
    const prev = batchResults.get(id);
    if (prev === 'running') throw new HttpError(409, 'BATCH_IN_PROGRESS');
    if (prev) return res.json({ results: prev.results });

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const manifestBytes = Number(req.query.manifestBytes);
    const manifestSha = typeof req.query.manifestSha256 === 'string' ? req.query.manifestSha256.toLowerCase() : '';
    if (!Number.isSafeInteger(manifestBytes) || manifestBytes <= 0 || manifestBytes > body.length) throw new HttpError(400, 'BAD_MANIFEST');
    const manifestRaw = body.subarray(0, manifestBytes);
    if (sha256Hex(manifestRaw) !== manifestSha) throw new HttpError(422, 'CHUNK_CORRUPT');
    let files;
    try {
      files = JSON.parse(manifestRaw.toString('utf8')).files;
    } catch {
      throw new HttpError(400, 'BAD_MANIFEST');
    }
    if (!Array.isArray(files) || files.length === 0 || files.length > UPLOAD_BATCH_MAX_FILES) throw new HttpError(400, 'BAD_MANIFEST');
    let total = 0;
    for (const f of files) {
      if (!f || typeof f !== 'object' || typeof f.path !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0) throw new HttpError(400, 'BAD_MANIFEST');
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) throw new HttpError(400, 'BAD_MANIFEST');
      if (f.mtimeMs !== undefined && !(Number.isFinite(f.mtimeMs) && f.mtimeMs > 0)) throw new HttpError(400, 'BAD_MTIME');
      uploadConflictMode(f.onConflict);
      total += f.size;
    }
    if (manifestBytes + total !== body.length) throw new HttpError(400, 'BATCH_LENGTH_MISMATCH');
    const st = await fsp.statfs(driveRoot);
    if (total > st.bavail * st.bsize - FREE_SPACE_MARGIN) throw new HttpError(507, 'INSUFFICIENT_STORAGE');

    rememberBatch(id, 'running');
    const results = [];
    try {
      let offset = manifestBytes;
      for (const f of files) {
        const data = body.subarray(offset, offset + f.size);
        offset += f.size;
        try {
          if (sha256Hex(data) !== f.sha256.toLowerCase()) throw new HttpError(422, 'CHUNK_CORRUPT');
          const vpath = uploadVpath(f.path);
          // UploadStore 와 같은 이름 꼴 → 중간에 꺼져 남은 임시 파일도 cleanup 이 치운다
          const partPath = path.join(dirs.staging, `${randomBytes(16).toString('base64url')}.part`);
          await fsp.writeFile(partPath, data, { flag: 'wx' });
          try {
            const done = await commitUpload(partPath, vpath, uploadConflictMode(f.onConflict), f.mtimeMs);
            results.push({ path: f.path, finalPath: done.path, ...(done.replaced ? { replaced: true } : {}) });
          } catch (err) {
            await fsp.rm(partPath, { force: true });
            throw err;
          }
        } catch (err) {
          results.push({ path: f.path, error: toHttpError(err).code });
        }
      }
    } catch (err) {
      batchResults.delete(id);
      throw err;
    }
    rememberBatch(id, { at: Date.now(), results });
    res.json({ results });
  });

  v1.delete('/uploads/:id', async (req, res) => {
    await uploads.abort(req.params.id);
    res.json({ ok: true });
  });

  app.use('/v1', v1);

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const httpErr = toHttpError(err);
    if (httpErr.status >= 500) log(`error ${req.method} ${req.path}: ${err?.stack ?? err}`);
    if (res.headersSent) return res.destroy();
    res.removeHeader('Content-Disposition');
    const body = { error: httpErr.code };
    if (Number.isSafeInteger(err?.received)) body.received = err.received; // 업로드 이어올리기 위치
    res.status(httpErr.status).json(body);
  });

  return app;
}

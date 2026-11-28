// /api 라우트.
//
//   GET  /api/status                 데스크탑 상태 (로그인 필요)
//   GET  /api/me                     현재 사용자
//   POST /api/logout
//
//   ── owner 전용: 데스크탑 D:\Drive (agent 프록시) ──
//   GET  /api/files/list?path=
//   GET  /api/files/stat?path=
//   GET  /api/files/content?path=&disposition=inline|attachment
//   GET  /api/files/thumb?path=&w=&v=          썸네일 (파이에 캐시)
//   GET  /api/files/zip?path=&path=…           폴더·여러 항목 zip 다운로드 (agent 가 만들고 그대로 파이프)
//   POST /api/files/{mkdir,rename,move,trash}  GET|POST /api/files/trash[/restore]
//   POST /api/files/trash/{delete,empty}       ← 패스키 재인증(1회용) 필요
//   POST /api/files/uploads/check { paths[] }
//   POST /api/files/uploads  GET|PUT|DELETE /api/files/uploads/:id  POST /api/files/uploads/:id/complete
//
//   ── owner 전용: 파이 임시 보관함 (데스크탑이 꺼져 있을 때, D3) ──
//   GET  /api/buffer                            { items[], used, max, free }
//   POST /api/buffer/uploads  GET|PUT|DELETE /api/buffer/uploads/:id  POST /api/buffer/uploads/:id/complete
//   POST /api/buffer/:id/retry   DELETE /api/buffer/:id
//
//   데스크탑이 꺼져 있으면 /api/files/{list,stat} 은 마지막으로 본 목록을 { cached: true, cachedAt } 와 함께 돌려준다 (§4.2).
//
//   ── guest·owner: 파이의 데모 폴더 (읽기 전용) ──
//   GET  /api/demo/list?path=
//   GET  /api/demo/stat?path=
//   GET  /api/demo/content?path=&disposition=
//   GET  /api/demo/zip?path=&path=…

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import mime from 'mime-types';
import { normalizeVirtualPath, listDirectory, statPath, contentDisposition, ROLES, MAX_CHUNK_REQUEST_BYTES, planZip, zipStream, zipEntriesFor } from '@wooki-drive/shared/node';
import { requireRole, requireStepUp, HttpError, safeContentType, fileSecurityHeaders, parseDisposition } from './http.js';
import { sessionCookie } from './sessions.js';
import { RateLimiter } from './rate-limit.js';

/** agent 로 보낼 경로. gateway 에서도 먼저 검증한다(이중 방어). */
const q = (vpath) => `path=${encodeURIComponent(normalizeVirtualPath(vpath))}`;

/**
 * @param {{
 *   agent: import('./agent-client.js').AgentClient,
 *   monitor: import('./agent-client.js').AgentMonitor,
 *   store: import('./sessions.js').SessionStore,
 *   demoRoot: string, cookieSecure: boolean,
 * }} deps
 */
export function apiRouter({
  agent,
  monitor,
  store,
  demoRoot,
  cookieSecure,
  devLogin = false,
  now = Date.now,
  thumbs = null,
  meta = null,
  buffer = null,
  trashNotice = { days: 30, bytes: 10 * 1024 ** 3 },
}) {
  const api = express.Router();
  const stepUp = requireStepUp({ store, devLogin, now });
  const uploadLimiter = new RateLimiter({ limit: 2000, windowMs: 10 * 60_000 }); // 폴더 업로드(파일 수백 개)는 허용

  // ── 세션 ──
  api.get('/me', (req, res) => {
    if (!req.session) return res.json({ user: null });
    // 화이트리스트 OAuth 는 통과했지만 패스키 전 → 아직 아무 권한 없음
    if (!req.session.role) {
      const locked = Boolean(req.session.locked);
      // 잠긴 오너 세션: 화면을 그대로 두고 그 자리에서 패스키로 풀 수 있도록 표시용 정보만 준다 (권한은 없음)
      return res.json({
        user: null,
        pending: req.session.stage ?? null,
        locked,
        ...(locked ? { lockedUser: { role: ROLES.OWNER, nickname: req.session.user.nickname, provider: req.session.user.provider } } : {}),
      });
    }
    const { role, user } = req.session;
    res.json({ user: { role, nickname: user.nickname, provider: user.provider } });
  });

  api.post('/logout', (req, res) => {
    if (req.sessionId) store.destroy(req.sessionId);
    res.set('Set-Cookie', sessionCookie('', { secure: cookieSecure, maxAgeSec: 0 }));
    res.json({ ok: true });
  });

  api.get('/status', requireRole(ROLES.GUEST), (_req, res) => {
    res.json(monitor.status());
  });

  // ── 데스크탑 파일 (owner) ──
  const files = express.Router();
  files.use(requireRole(ROLES.OWNER));

  // 꺼져 있으면(503) 캐시된 목록으로. 캐시가 없으면 원래 오류 그대로.
  const offlineFallback = async (fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      if (meta && err?.code === 'AGENT_OFFLINE') {
        const hit = fallback();
        if (hit) return hit;
      }
      throw err;
    }
  };

  files.get('/list', async (req, res) => {
    const vpath = normalizeVirtualPath(req.query.path);
    const result = await offlineFallback(
      () => agent.getJson(`/v1/list?${q(vpath)}`),
      () => {
        const c = meta.get(vpath);
        return c && { path: vpath, entries: c.entries, cached: true, cachedAt: c.at };
      },
    );
    if (meta && !result.cached) meta.put(result.path, result.entries);
    res.json(result);
  });

  files.get('/stat', async (req, res) => {
    const vpath = normalizeVirtualPath(req.query.path);
    res.json(
      await offlineFallback(
        () => agent.getJson(`/v1/stat?${q(vpath)}`),
        () => {
          const e = meta.stat(vpath);
          return e && { ...e, cached: true };
        },
      ),
    );
  });

  files.get('/content', async (req, res) => {
    const disposition = parseDisposition(req.query.disposition);
    const policy = (ct) => {
      const safe = safeContentType(ct, disposition);
      fileSecurityHeaders(res, safe);
      return safe;
    };
    res.set('Cache-Control', 'private, no-cache');
    await agent.pipeFile(req, res, `/v1/file?${q(req.query.path)}&disposition=${disposition}`, policy);
  });

  files.get('/zip', async (req, res) => {
    const { vpaths } = planZip(req.query.path); // 형식 검사는 여기서도(이중 방어), 이름은 agent 가 정한다
    fileSecurityHeaders(res, 'application/zip');
    res.set('Cache-Control', 'no-store');
    await agent.pipeFile(req, res, `/v1/zip?${vpaths.map(q).join('&')}`, () => 'application/zip');
  });

  // 썸네일: ?path=&w=&v=<수정시각-크기>. 캐시 적중이면 데스크탑이 꺼져 있어도 응답한다.
  files.get('/thumb', async (req, res) => {
    const vpath = normalizeVirtualPath(req.query.path);
    const width = Number(req.query.w ?? 256);
    if (![128, 256, 512].includes(width)) throw new HttpError(400, 'BAD_THUMB_WIDTH');
    const wanted = typeof req.query.v === 'string' ? req.query.v : null;

    const sendThumb = (bodyOrPath, immutable) => {
      res.set('Content-Type', 'image/webp');
      res.set('Content-Security-Policy', "default-src 'none'");
      res.set('Cross-Origin-Resource-Policy', 'same-origin');
      // URL 에 버전이 들어 있고 그 버전과 일치할 때만 오래 캐시
      res.set('Cache-Control', immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache');
      if (Buffer.isBuffer(bodyOrPath)) res.send(bodyOrPath);
      else res.sendFile(bodyOrPath, { dotfiles: 'allow', cacheControl: false, lastModified: false, etag: false, headers: { 'Content-Type': 'image/webp' } });
    };

    if (thumbs && wanted) {
      const hit = thumbs.get(vpath, wanted, width);
      if (hit) return sendThumb(hit, true);
    }

    const upstream = await agent.request('GET', `/v1/thumb?${q(vpath)}&w=${width}`);
    const chunks = [];
    let size = 0;
    for await (const c of upstream) {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        upstream.destroy();
        throw new HttpError(502, 'AGENT_BAD_RESPONSE');
      }
      chunks.push(c);
    }
    const body = Buffer.concat(chunks);
    if (upstream.statusCode === 401) throw new HttpError(502, 'AGENT_AUTH_FAILED');
    if (upstream.statusCode !== 200) {
      let code = 'AGENT_ERROR';
      try {
        code = JSON.parse(body.toString('utf8')).error ?? code;
      } catch {}
      throw new HttpError(upstream.statusCode ?? 502, code);
    }
    const version = upstream.headers['x-thumb-version'];
    if (thumbs && typeof version === 'string') await thumbs.put(vpath, version, width, body).catch(() => {});
    sendThumb(body, wanted !== null && wanted === version);
  });

  // ── 쓰기 (owner). 검증은 agent 가 최종 책임지고, 여기서는 형식만 거른다. ──
  const json = express.json({ limit: '256kb' });
  const fwd = (method, agentPath, pick) => async (req, res) => {
    const { status, data } = await agent.sendJson(method, agentPath(req), pick ? pick(req.body ?? {}) : {});
    res.status(status).json(data);
  };
  const only = (...keys) => (body) => Object.fromEntries(keys.filter((k) => k in body).map((k) => [k, body[k]]));
  const uploadId = (req) => {
    const id = req.params.id;
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new HttpError(404, 'UPLOAD_NOT_FOUND');
    return id;
  };

  files.post('/mkdir', json, fwd('POST', () => '/v1/mkdir', only('parent', 'name', 'onConflict')));
  // 경로가 바뀌는 작업은 목록 캐시에서 그 경로를 버린다
  const forget = (pick) => (req, _res, next) => {
    meta?.invalidate(pick(req.body ?? {}));
    next();
  };
  files.post('/rename', json, forget((b) => [b.path]), fwd('POST', () => '/v1/rename', only('path', 'name')));
  files.post('/move', json, forget((b) => (Array.isArray(b.paths) ? [...b.paths, b.to] : [])), fwd('POST', () => '/v1/move', only('paths', 'to', 'onConflict')));
  files.post('/trash', json, forget((b) => (Array.isArray(b.paths) ? b.paths : [])), fwd('POST', () => '/v1/trash', only('paths')));
  files.get('/trash', async (_req, res) => res.json(await agent.getJson('/v1/trash')));
  // 접속 시 배너용 (D20): 오래된 항목·큰 용량이면 notice 에 표시
  files.get('/trash/summary', async (_req, res) => {
    const s = await agent.getJson('/v1/trash/summary');
    const old = s.oldestDeletedAt != null && now() - s.oldestDeletedAt >= trashNotice.days * 86_400_000;
    const large = s.totalBytes >= trashNotice.bytes;
    res.json({ ...s, notice: old || large ? { old, large, days: trashNotice.days, limitBytes: trashNotice.bytes } : null });
  });
  files.post('/trash/restore', json, fwd('POST', () => '/v1/trash/restore', only('ids')));
  // 되돌릴 수 없는 작업: 패스키 재인증 1회용 허가 필요 (ai.md D16)
  files.post('/trash/delete', json, stepUp, fwd('POST', () => '/v1/trash/delete', only('ids')));
  files.post('/trash/empty', json, stepUp, fwd('POST', () => '/v1/trash/empty'));

  files.post('/uploads/check', json, fwd('POST', () => '/v1/uploads/check', only('paths')));
  files.post('/uploads', uploadLimiter.middleware('UPLOAD_RATE_LIMITED'), json, fwd('POST', () => '/v1/uploads', only('path', 'size', 'mtimeMs', 'onConflict')));
  files.get('/uploads/:id', async (req, res) => res.json(await agent.getJson(`/v1/uploads/${uploadId(req)}`)));
  files.put('/uploads/:id', async (req, res) => {
    const id = uploadId(req);
    const offset = Number(req.query.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'BAD_OFFSET');
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length)) throw new HttpError(411, 'LENGTH_REQUIRED');
    if (length > MAX_CHUNK_REQUEST_BYTES) throw new HttpError(413, 'CHUNK_TOO_LARGE');
    const headers = { 'Content-Length': String(length), 'Content-Type': 'application/octet-stream' };
    const sha = req.headers['x-chunk-sha256'];
    if (typeof sha === 'string') headers['X-Chunk-Sha256'] = sha;
    const { status, data } = await agent.pipeUpload(req, `/v1/uploads/${id}?offset=${offset}`, headers);
    res.status(status).json(data);
  });
  files.post('/uploads/:id/complete', json, async (req, res, next) => fwd('POST', () => `/v1/uploads/${uploadId(req)}/complete`)(req, res, next));
  files.delete('/uploads/:id', async (req, res) => {
    const r = await agent.request('DELETE', `/v1/uploads/${uploadId(req)}`);
    const chunks = [];
    for await (const c of r) chunks.push(c);
    if (r.statusCode === 401) throw new HttpError(502, 'AGENT_AUTH_FAILED');
    res.status(r.statusCode ?? 502).type('application/json').send(Buffer.concat(chunks));
  });

  api.use('/files', files);

  // ── 파이 임시 보관함 (owner) ──
  if (buffer) {
    const buf = express.Router();
    buf.use(requireRole(ROLES.OWNER));
    buf.get('/', async (_req, res) => {
      res.json({ items: await buffer.list(), ...(await buffer.usage()) });
    });
    buf.post('/uploads', uploadLimiter.middleware('UPLOAD_RATE_LIMITED'), json, async (req, res) => {
      const { path: p, size, mtimeMs } = req.body ?? {};
      const info = await buffer.create(p, size, mtimeMs);
      res.status(201).json({ id: info.id, size: info.size, received: info.received, chunkSize: buffer.chunkSize });
    });
    buf.get('/uploads/:id', async (req, res) => {
      const info = await buffer.uploads.status(uploadId(req));
      res.json({ id: info.id, size: info.size, received: info.received });
    });
    buf.put('/uploads/:id', async (req, res) => {
      const id = uploadId(req);
      const offset = Number(req.query.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'BAD_OFFSET');
      const length = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(length)) throw new HttpError(411, 'LENGTH_REQUIRED');
      if (length > MAX_CHUNK_REQUEST_BYTES) throw new HttpError(413, 'CHUNK_TOO_LARGE');
      const sha = typeof req.headers['x-chunk-sha256'] === 'string' ? req.headers['x-chunk-sha256'].toLowerCase() : null;
      try {
        const info = await buffer.uploads.writeChunk(id, offset, req, { length, sha256: sha });
        res.json({ id: info.id, size: info.size, received: info.received });
      } catch (err) {
        if (Number.isSafeInteger(err?.received)) err.extra = { received: err.received };
        throw err;
      }
    });
    buf.post('/uploads/:id/complete', json, async (req, res) => {
      const item = await buffer.complete(uploadId(req));
      res.json({ path: item.path, buffered: true, id: item.id });
      if (monitor.online) buffer.sync(agent).catch(() => {}); // 그 사이 켜졌으면 바로 옮긴다
    });
    buf.delete('/uploads/:id', async (req, res) => {
      await buffer.uploads.abort(uploadId(req));
      res.json({ ok: true });
    });
    buf.post('/:id/retry', async (req, res) => {
      await buffer.retry(req.params.id);
      res.json({ ok: true });
      if (monitor.online) buffer.sync(agent).catch(() => {});
    });
    buf.delete('/:id', async (req, res) => {
      await buffer.remove(req.params.id);
      res.json({ ok: true });
    });
    api.use('/buffer', buf);
  }

  // ── 데모 폴더 (guest 이상, 읽기 전용) ──
  const demo = express.Router();
  demo.use(requireRole(ROLES.GUEST));

  demo.get('/list', async (req, res) => {
    res.json(await listDirectory(demoRoot, req.query.path));
  });

  demo.get('/stat', async (req, res) => {
    const { realPath: _omit, ...info } = await statPath(demoRoot, req.query.path);
    res.json(info);
  });

  demo.get('/content', async (req, res, next) => {
    const disposition = parseDisposition(req.query.disposition);
    const info = await statPath(demoRoot, req.query.path);
    if (info.type !== 'file') throw new HttpError(400, 'NOT_A_FILE');

    const ct = safeContentType(mime.lookup(info.name) || undefined, disposition);
    res.set('Content-Type', ct); // send 는 이미 설정된 Content-Type 을 덮어쓰지 않는다
    fileSecurityHeaders(res, ct);
    res.set('Content-Disposition', contentDisposition(disposition, info.name));
    res.set('Cache-Control', 'private, no-cache');
    res.sendFile(
      info.realPath,
      { dotfiles: 'allow', acceptRanges: true, etag: true, lastModified: true, cacheControl: false },
      (err) => {
        if (err && !res.headersSent) next(err);
      },
    );
  });

  demo.get('/zip', async (req, res) => {
    const { vpaths, filename } = planZip(req.query.path);
    for (const p of vpaths) await statPath(demoRoot, p);
    fileSecurityHeaders(res, 'application/zip');
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', contentDisposition('attachment', filename));
    try {
      await pipeline(Readable.from(zipStream(zipEntriesFor(demoRoot, vpaths))), res);
    } catch {
      res.destroy();
    }
  });

  api.use('/demo', demo);

  api.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND')));
  return api;
}

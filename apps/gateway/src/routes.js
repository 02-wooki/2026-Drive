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
//
//   ── guest·owner: 파이의 데모 폴더 (읽기 전용) ──
//   GET  /api/demo/list?path=
//   GET  /api/demo/stat?path=
//   GET  /api/demo/content?path=&disposition=

import express from 'express';
import mime from 'mime-types';
import { normalizeVirtualPath, listDirectory, statPath, contentDisposition, ROLES } from '@wooki-drive/shared/node';
import { requireRole, HttpError, safeContentType, fileSecurityHeaders, parseDisposition } from './http.js';
import { sessionCookie } from './sessions.js';

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
export function apiRouter({ agent, monitor, store, demoRoot, cookieSecure }) {
  const api = express.Router();

  // ── 세션 ──
  api.get('/me', (req, res) => {
    if (!req.session) return res.json({ user: null });
    // 화이트리스트 OAuth 는 통과했지만 패스키 전 → 아직 아무 권한 없음
    if (!req.session.role) return res.json({ user: null, pending: req.session.stage ?? null });
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

  files.get('/list', async (req, res) => {
    res.json(await agent.getJson(`/v1/list?${q(req.query.path)}`));
  });

  files.get('/stat', async (req, res) => {
    res.json(await agent.getJson(`/v1/stat?${q(req.query.path)}`));
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

  api.use('/files', files);

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

  api.use('/demo', demo);

  api.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND')));
  return api;
}

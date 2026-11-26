// 개발 전용 로그인: POST /auth/dev/login { role: 'owner' | 'guest' }
// config.devLogin 이 true 일 때만 마운트된다. config 는 localhost + http 가 아니면 devLogin 을 거부한다(이중 잠금).
import express from 'express';
import { ROLES } from '@wooki-drive/shared/node';
import { HttpError } from '../http.js';
import { issueSession } from './session-cookie.js';

/**
 * @param {{ store: import('../sessions.js').SessionStore, sessionTtl: any, cookieSecure: boolean, log?: (m: string) => void }} deps
 */
export function devLoginRouter({ store, sessionTtl, cookieSecure, log = () => {} }) {
  if (cookieSecure) throw new Error('dev login requires COOKIE_SECURE=false');
  const router = express.Router();
  router.use(express.json({ limit: '1kb' }));
  router.post('/login', (req, res) => {
    const role = req.body?.role;
    if (role !== ROLES.OWNER && role !== ROLES.GUEST) throw new HttpError(400, 'BAD_ROLE');
    if (req.sessionId) store.destroy(req.sessionId);
    const ttl = sessionTtl[role];
    const { id } = store.create({ role, user: { provider: 'dev', sub: role, nickname: role === 'owner' ? '개발 오너' : '개발 게스트' } }, ttl);
    issueSession(res, id, ttl, cookieSecure);
    log(`DEV LOGIN as ${role}`);
    res.json({ ok: true });
  });
  return router;
}

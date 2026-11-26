// gateway HTTP 앱 (공개 리스너, nginx 뒤). 테스트에서 직접 띄울 수 있도록 listen 과 분리.
import express from 'express';
import { apiRouter } from './routes.js';
import { oauthRouter } from './auth/oauth.js';
import { passkeyRouter } from './auth/passkeys.js';
import { RateLimiter } from './rate-limit.js';
import { securityHeaders, noStore, loadSession, csrfGuard, toHttpError } from './http.js';

const TEN_MIN = 10 * 60_000;

/**
 * @param {{
 *   publicOrigin: string, cookieSecure: boolean, demoRoot: string,
 *   oauth: Record<string, { clientId: string, clientSecret: string }>,
 *   ownerAccounts: Set<string>,
 *   session: { owner: { absoluteMs: number, idleMs: number }, guest: { absoluteMs: number, idleMs: number } },
 *   store: import('./sessions.js').SessionStore,
 *   passkeys: import('./auth/passkeys.js').PasskeyStore,
 *   agent: import('./agent-client.js').AgentClient,
 *   monitor: import('./agent-client.js').AgentMonitor,
 *   fetch?: typeof fetch, webauthn?: any, now?: () => number,
 *   limits?: { login?: number, passkey?: number },
 *   log?: (m: string) => void,
 * }} deps
 */
export function createApp(deps) {
  const { publicOrigin, cookieSecure, demoRoot, store, agent, monitor, log = () => {} } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // nginx 가 같은 기기에서 X-Forwarded-For 를 붙인다
  app.set('query parser', 'simple');

  app.use(securityHeaders);
  app.use(loadSession({ store, secure: cookieSecure }));

  // ── 로그인 ──
  const loginLimiter = new RateLimiter({ limit: deps.limits?.login ?? 30, windowMs: TEN_MIN });
  const passkeyLimiter = new RateLimiter({ limit: deps.limits?.passkey ?? 20, windowMs: TEN_MIN });
  app.use(
    '/auth/passkey',
    noStore,
    csrfGuard(publicOrigin),
    passkeyRouter({
      publicOrigin,
      cookieSecure,
      sessionTtl: deps.session,
      store,
      passkeys: deps.passkeys,
      limiter: passkeyLimiter,
      webauthn: deps.webauthn,
      now: deps.now,
      log,
    }),
  );
  app.use(
    '/auth',
    oauthRouter({
      publicOrigin,
      cookieSecure,
      oauth: deps.oauth ?? {},
      ownerAccounts: deps.ownerAccounts ?? new Set(),
      sessionTtl: deps.session,
      store,
      limiter: loginLimiter,
      fetch: deps.fetch,
      now: deps.now,
      log,
    }),
  );

  // ── API ──
  app.use('/api', noStore, csrfGuard(publicOrigin), apiRouter({ agent, monitor, store, demoRoot, cookieSecure }));

  // TODO: apps/web 빌드 산출물 정적 서빙 (/, /login, /login/passkey 등)

  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const httpErr = toHttpError(err);
    if (httpErr.status >= 500 && httpErr.code === 'INTERNAL') log(`error ${req.method} ${req.path}: ${err?.stack ?? err}`);
    if (res.headersSent) return res.destroy();
    // 파일 응답용으로 미리 단 헤더 제거
    for (const h of ['Content-Disposition', 'Content-Security-Policy', 'Content-Type', 'ETag', 'Last-Modified', 'Accept-Ranges']) {
      res.removeHeader(h);
    }
    res.status(httpErr.status).json({ error: httpErr.code });
  });

  return app;
}

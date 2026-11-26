// gateway HTTP 앱 (공개 리스너, nginx 뒤). 테스트에서 직접 띄울 수 있도록 listen 과 분리.
import express from 'express';
import { apiRouter } from './routes.js';
import { securityHeaders, noStore, loadSession, csrfGuard, toHttpError } from './http.js';

/**
 * @param {{
 *   publicOrigin: string, cookieSecure: boolean, demoRoot: string,
 *   store: import('./sessions.js').SessionStore,
 *   agent: import('./agent-client.js').AgentClient,
 *   monitor: import('./agent-client.js').AgentMonitor,
 *   log?: (m: string) => void,
 * }} deps
 */
export function createApp({ publicOrigin, cookieSecure, demoRoot, store, agent, monitor, log = () => {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // nginx 가 같은 기기에서 X-Forwarded-For 를 붙인다
  app.set('query parser', 'simple');

  app.use(securityHeaders);
  app.use(loadSession({ store, secure: cookieSecure }));

  app.use('/api', noStore, csrfGuard(publicOrigin), apiRouter({ agent, monitor, store, demoRoot, cookieSecure }));

  // TODO: /auth (OAuth + 패스키), apps/web 빌드 산출물 정적 서빙

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

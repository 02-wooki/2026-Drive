// apps/web 빌드 산출물 서빙 (SPA). /api, /auth 이외의 GET 은 index.html 로.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/** 앱 페이지 CSP. 외부 출처 없음, 인라인 스크립트 없음. blob: 은 Quick Look 텍스트·미디어용. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "frame-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** @param {{ webDist: string, log?: (m: string) => void }} opts */
export function webRouter({ webDist, log = () => {} }) {
  const router = express.Router();
  const indexFile = path.join(webDist, 'index.html');
  const built = fs.existsSync(indexFile);
  if (!built) log(`web not built: ${indexFile} missing (npm run build --workspace apps/web)`);

  router.use((_req, res, next) => {
    res.set('Content-Security-Policy', PAGE_CSP);
    next();
  });

  // 해시가 붙은 빌드 산출물은 영구 캐시
  router.use(
    '/assets',
    express.static(path.join(webDist, 'assets'), { immutable: true, maxAge: '365d', index: false, fallthrough: false }),
  );
  router.use(express.static(webDist, { index: false, maxAge: '1h' }));

  router.get(/^\/(?!api\/|auth\/).*/, (req, res, next) => {
    if (!built) return res.status(503).type('text/plain; charset=utf-8').send('웹 화면이 아직 빌드되지 않았습니다.');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexFile, (err) => err && next(err));
  });

  return router;
}

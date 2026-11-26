// agent HTTP 앱. 테스트에서 직접 띄울 수 있도록 listen 과 분리한다.
//
// GET /health                         인증 없음. 내용 없는 생존 확인.
// GET /v1/list?path=/a                폴더 목록
// GET /v1/stat?path=/a/b.jpg          메타데이터
// GET /v1/file?path=/a/b.jpg[&disposition=inline|attachment]
//                                     파일 내용. Range / If-None-Match 지원 (동영상 탐색, 이어받기)
//
// 응답 보안 헤더(CSP 등)는 브라우저와 맞닿은 gateway 가 최종 책임진다. agent 는 nosniff 만 기본으로 단다.

import express from 'express';
import { listDirectory, statPath, contentDisposition } from './files.js';
import { ipAllowlist, requireSignature } from './auth.js';
import { HttpError, toHttpError } from './http-error.js';

/**
 * @param {{
 *   driveRoot: string, hmacSecrets: Buffer[], allowedIps?: string[] | null,
 *   now?: () => number, log?: (msg: string) => void,
 * }} config
 */
export function createApp({ driveRoot, hmacSecrets, allowedIps = null, now, log = () => {} }) {
  const app = express();
  app.disable('x-powered-by');
  // 주의: app.set('etag', false) 를 하면 Express 가 sendFile 의 etag 옵션까지 꺼버린다(동영상 재검증 불가). 켜 둘 것.
  app.set('query parser', 'simple');

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(ipAllowlist(allowedIps));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const v1 = express.Router();
  v1.use(requireSignature({ secrets: hmacSecrets, now, onReject: (reason) => log(`signature rejected: ${reason}`) }));

  v1.get('/list', async (req, res) => {
    res.json(await listDirectory(driveRoot, req.query.path));
  });

  v1.get('/stat', async (req, res) => {
    const { realPath: _omit, ...info } = await statPath(driveRoot, req.query.path);
    res.json(info);
  });

  v1.get('/file', async (req, res, next) => {
    const disposition = req.query.disposition ?? 'attachment';
    if (disposition !== 'inline' && disposition !== 'attachment') throw new HttpError(400, 'BAD_DISPOSITION');

    const info = await statPath(driveRoot, req.query.path);
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

  app.use('/v1', v1);

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const httpErr = toHttpError(err);
    if (httpErr.status >= 500) log(`error ${req.method} ${req.path}: ${err?.stack ?? err}`);
    if (res.headersSent) return res.destroy();
    res.removeHeader('Content-Disposition');
    res.status(httpErr.status).json({ error: httpErr.code });
  });

  return app;
}

// gateway → agent 요청 인증 미들웨어 (ai.md §4.3).
import { verifyRequest, NonceStore } from '@wooki-drive/shared/node';
import { HttpError } from './http-error.js';

/** "::ffff:192.168.0.17" → "192.168.0.17" */
export function normalizeIp(addr) {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** 방화벽과 별개의 이중 방어. allowedIps 가 null 이면 통과. */
export function ipAllowlist(allowedIps) {
  const allowed = allowedIps ? new Set(allowedIps.map(normalizeIp)) : null;
  return (req, _res, next) => {
    if (allowed && !allowed.has(normalizeIp(req.socket.remoteAddress))) {
      return next(new HttpError(403, 'IP_NOT_ALLOWED'));
    }
    next();
  };
}

/**
 * HMAC 서명 검증. 실패 사유는 응답에 싣지 않는다(공격자에게 힌트 주지 않기) — 401 + 'UNAUTHORIZED' 만.
 * @param {{ secrets: Buffer[], nonceStore?: NonceStore, now?: () => number, onReject?: (reason: string) => void }} opts
 */
export function requireSignature({ secrets, nonceStore = new NonceStore(), now = Date.now, onReject }) {
  return (req, _res, next) => {
    const result = verifyRequest({
      secret: secrets,
      audience: 'agent',
      method: req.method,
      pathWithQuery: req.originalUrl,
      headers: req.headers,
      nonceStore,
      now: now(),
    });
    if (!result.ok) {
      onReject?.(result.reason);
      return next(new HttpError(401, 'UNAUTHORIZED'));
    }
    req.signedBodySha256 = result.bodySha256;
    next();
  };
}

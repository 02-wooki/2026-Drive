// 공용 HTTP 유틸: 오류, 미들웨어(세션·역할·CSRF·보안 헤더), 파일 응답 헤더 정책.
import { PathError, BrowseError, ROLES } from '@wooki-drive/shared/node';
import { cookieName, parseCookies } from './sessions.js';

export class HttpError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof PathError) return new HttpError(400, `PATH_${err.code}`);
  if (err instanceof BrowseError) return new HttpError(err.status, err.code);
  switch (err?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new HttpError(404, 'NOT_FOUND');
    case 'EACCES':
    case 'EPERM':
      return new HttpError(403, 'FS_PERMISSION_DENIED');
    default:
      if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
        return new HttpError(err.status, 'BAD_REQUEST');
      }
      return new HttpError(500, 'INTERNAL');
  }
}

/** 모든 응답 기본 보안 헤더. 파일 응답은 fileSecurityHeaders 로 더 좁힌다. */
export function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}

/** API 응답은 캐시 금지 (세션별 내용). */
export function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

/** 쿠키 → req.session / req.sessionId. 없으면 null. */
export function loadSession({ store, secure }) {
  const name = cookieName(secure);
  return (req, _res, next) => {
    const id = parseCookies(req.headers.cookie)[name];
    const session = id ? store.get(id) : null;
    req.sessionId = session ? id : null;
    req.session = session;
    next();
  };
}

/**
 * 역할 검사. owner 는 guest 가 할 수 있는 것도 할 수 있다.
 * owner 판정은 세션의 role 만 본다 — role 'owner' 는 화이트리스트 + 패스키 통과 후에만 부여된다(auth 단계).
 * @param {'owner' | 'guest'} minRole
 */
export function requireRole(minRole) {
  return (req, _res, next) => {
    const role = req.session?.role;
    if (!role) return next(new HttpError(401, 'LOGIN_REQUIRED'));
    if (minRole === ROLES.OWNER && role !== ROLES.OWNER) return next(new HttpError(403, 'OWNER_ONLY'));
    if (role !== ROLES.OWNER && role !== ROLES.GUEST) return next(new HttpError(403, 'FORBIDDEN'));
    next();
  };
}

/**
 * 되돌릴 수 없는 작업(영구 삭제·휴지통 비우기) 전 패스키 재인증 (ai.md D16).
 * /auth/passkey/reauth 로 받은 허가(2분)를 **한 번 쓰고 없앤다**.
 * 개발 로그인 세션은 패스키가 없으므로 devLogin 모드에서만 통과시킨다.
 * @param {{ store: import('./sessions.js').SessionStore, devLogin?: boolean, now?: () => number }} deps
 */
export function requireStepUp({ store, devLogin = false, now = Date.now }) {
  return (req, _res, next) => {
    const s = req.session;
    if (devLogin && s?.user?.provider === 'dev') return next();
    if (s?.stepUp && s.stepUp.expiresAt > now()) {
      store.update(req.sessionId, { stepUp: null });
      return next();
    }
    next(new HttpError(403, 'STEP_UP_REQUIRED'));
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 방어 (SameSite=Lax 에 더해): 상태 변경 요청은 Origin 이 우리 사이트여야 한다.
 * Origin 이 없으면 Sec-Fetch-Site: same-origin 을 요구. 둘 다 없으면 거부.
 */
export function csrfGuard(publicOrigin) {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers.origin;
    if (origin !== undefined) {
      return origin === publicOrigin ? next() : next(new HttpError(403, 'CSRF_ORIGIN'));
    }
    if (req.headers['sec-fetch-site'] === 'same-origin') return next();
    next(new HttpError(403, 'CSRF_ORIGIN'));
  };
}

// ── 파일 응답 (미리보기·다운로드) 정책 — ai.md §6 ─────────────────

/** inline 으로 그대로 보여줘도 되는 타입. 그 외는 텍스트로 바꾸거나 다운로드로만. */
const INLINE_SAFE = [
  /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/,
  /^video\//,
  /^audio\//,
  /^application\/pdf$/,
  /^text\/plain$/,
];

/** 텍스트로는 보여줄 수 있는 타입 (HTML·SVG·스크립트 포함 — 실행되지 않게 text/plain 으로). */
const TEXT_LIKE = [/^text\//, /^application\/(json|xml|javascript|x-javascript|ecmascript|x-sh|x-yaml|toml)$/, /\+xml$/, /\+json$/];

/**
 * @param {string | undefined} contentType  원래 Content-Type
 * @param {'inline' | 'attachment'} disposition
 * @returns {string} 실제로 내보낼 Content-Type
 */
export function safeContentType(contentType, disposition) {
  const raw = (contentType ?? 'application/octet-stream').toLowerCase();
  const mime = raw.split(';')[0].trim();
  if (disposition === 'attachment') return raw;
  if (INLINE_SAFE.some((re) => re.test(mime))) return mime === 'text/plain' ? 'text/plain; charset=utf-8' : raw;
  if (TEXT_LIKE.some((re) => re.test(mime))) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * 파일 응답 공통 헤더. sandbox CSP 로 혹시 렌더링돼도 스크립트가 돌지 않게. PDF 뷰어는 sandbox 에서 막히므로 예외.
 * Quick Look 이 PDF 를 iframe 으로 띄우므로 같은 출처 안에서만 프레임 허용 (다른 사이트는 불가).
 */
export function fileSecurityHeaders(res, contentType) {
  const isPdf = contentType.startsWith('application/pdf');
  res.set(
    'Content-Security-Policy',
    isPdf
      ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'"
      : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
  );
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.set('X-Content-Type-Options', 'nosniff');
}

/** @param {unknown} v */
export function parseDisposition(v) {
  const d = v ?? 'inline';
  if (d !== 'inline' && d !== 'attachment') throw new HttpError(400, 'BAD_DISPOSITION');
  return d;
}

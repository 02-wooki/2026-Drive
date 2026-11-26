// OAuth 로그인 (ai.md §5).
//
//   GET /auth/:provider/start      → 공급자 로그인 화면으로 리다이렉트
//   GET /auth/:provider/callback   → 로그인 완료. 화이트리스트면 패스키 단계로, 아니면 게스트로.
//
// CSRF(로그인 CSRF 포함): state 를 서버에 1회용으로 저장 + 같은 값을 브라우저 쿠키에 묶는다.
// 콜백은 브라우저 내비게이션이므로 오류도 JSON 이 아니라 /login?error=CODE 로 리다이렉트한다.

import { randomBytes, createHash } from 'node:crypto';
import express from 'express';
import { ROLES } from '@wooki-drive/shared/node';
import { PROVIDERS, authorizeUrl, exchangeCode } from './providers.js';
import { parseCookies } from '../sessions.js';
import { HttpError } from '../http.js';
import { issueSession } from './session-cookie.js';

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1000;

export const PENDING_PASSKEY_TTL = { absoluteMs: 10 * 60_000, idleMs: 10 * 60_000 };

function stateCookieName(secure) {
  return secure ? '__Host-wd_oauth' : 'wd_oauth';
}

function stateCookie(value, { secure, maxAgeSec }) {
  const parts = [`${stateCookieName(secure)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * @param {{
 *   publicOrigin: string, cookieSecure: boolean,
 *   oauth: Record<string, { clientId: string, clientSecret: string }>,  // 설정된 공급자만
 *   ownerAccounts: Set<string>,                                         // "provider:sub"
 *   sessionTtl: { owner: { absoluteMs: number, idleMs: number }, guest: { absoluteMs: number, idleMs: number } },
 *   store: import('../sessions.js').SessionStore,
 *   limiter: import('../rate-limit.js').RateLimiter,
 *   fetch?: typeof fetch, now?: () => number, log?: (m: string) => void,
 * }} deps
 */
export function oauthRouter({ publicOrigin, cookieSecure, oauth, ownerAccounts, sessionTtl, store, limiter, devLogin = false, fetch: f = fetch, now = Date.now, log = () => {} }) {
  const router = express.Router();
  /** @type {Map<string, { provider: string, verifier: string | null, expiresAt: number }>} */
  const pending = new Map();

  const enabled = (id) => Object.hasOwn(PROVIDERS, id) && Object.hasOwn(oauth, id);
  const redirectUri = (id) => `${publicOrigin}/auth/${id}/callback`;
  const fail = (res, code) => res.redirect(303, `/login?error=${encodeURIComponent(code)}`);

  router.get('/providers', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ providers: Object.keys(PROVIDERS).filter(enabled), devLogin: Boolean(devLogin) });
  });

  router.get('/:provider/start', limiter.middleware('LOGIN_RATE_LIMITED'), (req, res) => {
    const id = req.params.provider;
    if (!enabled(id)) throw new HttpError(404, 'UNKNOWN_PROVIDER');
    const spec = PROVIDERS[id];

    const t = now();
    for (const [k, v] of pending) if (v.expiresAt <= t) pending.delete(k);
    if (pending.size >= MAX_PENDING) throw new HttpError(429, 'LOGIN_RATE_LIMITED');

    const state = randomBytes(32).toString('base64url');
    const verifier = spec.pkce ? randomBytes(32).toString('base64url') : null;
    pending.set(state, { provider: id, verifier, expiresAt: t + STATE_TTL_MS });

    res.set('Cache-Control', 'no-store');
    res.set('Set-Cookie', stateCookie(state, { secure: cookieSecure, maxAgeSec: STATE_TTL_MS / 1000 }));
    res.redirect(
      302,
      authorizeUrl(spec, {
        clientId: oauth[id].clientId,
        redirectUri: redirectUri(id),
        state,
        codeChallenge: verifier ? createHash('sha256').update(verifier).digest('base64url') : undefined,
      }),
    );
  });

  router.get('/:provider/callback', limiter.middleware('LOGIN_RATE_LIMITED'), async (req, res) => {
    const id = req.params.provider;
    res.set('Cache-Control', 'no-store');
    // state 쿠키는 성공·실패 관계없이 즉시 제거
    res.append('Set-Cookie', stateCookie('', { secure: cookieSecure, maxAgeSec: 0 }));
    if (!enabled(id)) return fail(res, 'UNKNOWN_PROVIDER');

    const { state, code, error } = req.query;
    const cookieState = parseCookies(req.headers.cookie)[stateCookieName(cookieSecure)];
    const entry = typeof state === 'string' ? pending.get(state) : undefined;
    if (entry) pending.delete(state); // 1회용

    if (!entry || state !== cookieState || entry.provider !== id || entry.expiresAt <= now()) {
      return fail(res, 'OAUTH_STATE_MISMATCH');
    }
    if (typeof error === 'string') return fail(res, 'OAUTH_DENIED');
    if (typeof code !== 'string' || code.length === 0 || code.length > 2048) return fail(res, 'OAUTH_NO_CODE');

    let user;
    try {
      user = await exchangeCode(PROVIDERS[id], {
        clientId: oauth[id].clientId,
        clientSecret: oauth[id].clientSecret,
        redirectUri: redirectUri(id),
        code,
        codeVerifier: entry.verifier ?? undefined,
        fetch: f,
      });
    } catch (err) {
      log(`oauth ${id} failed: ${err.code ?? err.message}`);
      return fail(res, err.code ?? 'OAUTH_FAILED');
    }

    // 세션 고정 방지: 기존 세션은 항상 버리고 새로 발급
    if (req.sessionId) store.destroy(req.sessionId);

    const isOwnerAccount = ownerAccounts.has(`${user.provider}:${user.sub}`);
    if (isOwnerAccount) {
      // 화이트리스트 통과 = 아직 권한 없음. 패스키를 통과해야 owner 가 된다.
      const { id: sid } = store.create({ role: null, stage: 'passkey', user }, PENDING_PASSKEY_TTL);
      issueSession(res, sid, PENDING_PASSKEY_TTL, cookieSecure);
      log(`owner candidate signed in via ${id}, passkey required`);
      return res.redirect(303, '/login/passkey');
    }

    // 초기 설정 모드(화이트리스트가 비어 있음)에서만 고유 ID 를 로그에 남긴다 → OWNER_ACCOUNTS 에 넣을 값 확인용.
    // 평소에는 게스트 식별자를 로그에 남기지 않는다 (ai.md §5: 게스트 정보 최소화).
    if (ownerAccounts.size === 0) log(`setup mode: signed in via ${id} sub=${user.sub}`);

    const { id: sid } = store.create({ role: ROLES.GUEST, user }, sessionTtl.guest);
    issueSession(res, sid, sessionTtl.guest, cookieSecure);
    return res.redirect(303, '/');
  });

  return router;
}

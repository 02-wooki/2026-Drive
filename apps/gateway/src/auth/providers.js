// OAuth 공급자 정의 (ai.md D6). 이메일은 요청하지도 저장하지도 않는다 — 닉네임 + 고유 ID(sub)만 (§5).
//
// 각 공급자는 authorize URL 생성 → code 교환 → 사용자 조회 순서로 동작한다.
// 네트워크 호출은 주입된 fetch 로만 해서 테스트에서 가짜 공급자로 바꿀 수 있다.

import { HttpError } from '../http.js';

/**
 * @typedef {{
 *   id: 'kakao' | 'google' | 'github',
 *   authorizeUrl: string, tokenUrl: string, userUrl: string,
 *   scope: string, pkce: boolean,
 *   parseUser: (json: any) => { sub: string, nickname: string },
 * }} ProviderSpec
 */

/** @type {Record<string, ProviderSpec>} */
export const PROVIDERS = {
  kakao: {
    id: 'kakao',
    authorizeUrl: 'https://kauth.kakao.com/oauth/authorize',
    tokenUrl: 'https://kauth.kakao.com/oauth/token',
    userUrl: 'https://kapi.kakao.com/v2/user/me',
    scope: 'profile_nickname',
    pkce: false,
    parseUser: (j) => ({
      sub: String(j?.id ?? ''),
      nickname: j?.kakao_account?.profile?.nickname ?? j?.properties?.nickname ?? '',
    }),
  },
  google: {
    id: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid profile',
    pkce: true,
    parseUser: (j) => ({ sub: String(j?.sub ?? ''), nickname: j?.name ?? j?.given_name ?? '' }),
  },
  github: {
    id: 'github',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scope: '', // 공개 프로필만
    pkce: false,
    parseUser: (j) => ({ sub: j?.id != null ? String(j.id) : '', nickname: j?.name || j?.login || '' }),
  },
};

const NETWORK_TIMEOUT_MS = 10_000;

/** 표시용 닉네임 정리: 제어문자 제거, 공백 정리, 40자 제한. 비면 기본값. */
export function cleanNickname(raw, fallback) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, 40).join('') || fallback;
}

/**
 * @param {ProviderSpec} spec
 * @param {{ clientId: string, redirectUri: string, state: string, codeChallenge?: string }} p
 */
export function authorizeUrl(spec, { clientId, redirectUri, state, codeChallenge }) {
  const u = new URL(spec.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  if (spec.scope) u.searchParams.set('scope', spec.scope);
  if (spec.pkce && codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  if (spec.id === 'google') u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

/**
 * code → 사용자 정보. 실패는 전부 502 OAUTH_* 로 (공급자 응답 내용은 노출·기록하지 않는다).
 * @param {ProviderSpec} spec
 * @param {{ clientId: string, clientSecret: string, redirectUri: string, code: string, codeVerifier?: string, fetch?: typeof fetch }} p
 * @returns {Promise<{ provider: string, sub: string, nickname: string }>}
 */
export async function exchangeCode(spec, { clientId, clientSecret, redirectUri, code, codeVerifier, fetch: f = fetch }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
  });
  if (clientSecret) form.set('client_secret', clientSecret);
  if (spec.pkce && codeVerifier) form.set('code_verifier', codeVerifier);

  let token;
  try {
    const r = await f(spec.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    const j = await r.json();
    token = r.ok && typeof j?.access_token === 'string' ? j.access_token : null;
  } catch {
    token = null;
  }
  if (!token) throw new HttpError(502, 'OAUTH_TOKEN_FAILED');

  let user;
  try {
    const r = await f(spec.userUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'wooki-drive' },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    user = r.ok ? spec.parseUser(await r.json()) : null;
  } catch {
    user = null;
  }
  if (!user || !/^[A-Za-z0-9_-]{1,128}$/.test(user.sub)) throw new HttpError(502, 'OAUTH_PROFILE_FAILED');

  return { provider: spec.id, sub: user.sub, nickname: cleanNickname(user.nickname, `${spec.id} 사용자`) };
}

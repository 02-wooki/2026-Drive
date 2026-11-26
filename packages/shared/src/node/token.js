// 짧은 수명 서명 토큰 — LAN 직결(ai.md §4.1-2)용. gateway 가 발급하고 agent 가 직접 검증한다.
//
// 형식: "v1.<payload base64url JSON>.<HMAC-SHA256 base64url>"
// payload 필수 필드: aud(대상), iat, exp(초 단위 유닉스 시각). 그 외(sub, role, scope 등)는 자유.
//
// 비밀키는 요청 서명용(HMAC)과 **다른 값**을 쓴다. 토큰은 브라우저로 나가므로 노출 범위가 다르다.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { toKeyList } from './secret.js';
import { LAN_TOKEN_TTL_SEC, TOKEN_CLOCK_SKEW_SEC } from '../constants.js';

const PREFIX = 'v1';
const MAX_TOKEN_LENGTH = 4096;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function mac(key, payloadB64) {
  return createHmac('sha256', key).update(`WOOKI-TOKEN-V1.${payloadB64}`, 'utf8').digest();
}

/**
 * @param {Record<string, unknown> & { aud: string }} claims
 * @param {string | Buffer | Array<string | Buffer>} secret  배열이면 첫 번째 키로 서명
 * @param {{ ttlSec?: number, now?: number }} [opts]  now 는 ms
 * @returns {string}
 */
export function signToken(claims, secret, { ttlSec = LAN_TOKEN_TTL_SEC, now = Date.now() } = {}) {
  if (!claims || typeof claims.aud !== 'string' || !claims.aud) throw new Error('claims.aud is required');
  if (!(ttlSec > 0)) throw new Error('ttlSec must be positive');
  const [key] = toKeyList(secret);
  const iat = Math.floor(now / 1000);
  const payload = { ...claims, iat, exp: iat + Math.floor(ttlSec) };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${PREFIX}.${payloadB64}.${mac(key, payloadB64).toString('base64url')}`;
}

/**
 * @param {unknown} token
 * @param {string | Buffer | Array<string | Buffer>} secret  배열이면 아무 키나 맞으면 통과 (키 회전)
 * @param {{ audience: string, now?: number, clockSkewSec?: number }} opts
 * @returns {{ ok: true, claims: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function verifyToken(token, secret, { audience, now = Date.now(), clockSkewSec = TOKEN_CLOCK_SKEW_SEC }) {
  if (!audience) throw new Error('audience is required');
  const keys = toKeyList(secret);
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'MALFORMED' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'MALFORMED' };
  const [, payloadB64, sigB64] = parts;
  if (!B64URL_RE.test(payloadB64) || !B64URL_RE.test(sigB64)) return { ok: false, reason: 'MALFORMED' };

  const given = Buffer.from(sigB64, 'base64url');
  let match = false;
  for (const key of keys) {
    const expected = mac(key, payloadB64);
    if (expected.length === given.length && timingSafeEqual(expected, given)) match = true;
  }
  if (!match) return { ok: false, reason: 'BAD_SIGNATURE' };

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { ok: false, reason: 'MALFORMED' };
  if (!Number.isInteger(claims.exp) || !Number.isInteger(claims.iat)) return { ok: false, reason: 'MALFORMED' };

  const nowSec = Math.floor(now / 1000);
  if (claims.aud !== audience) return { ok: false, reason: 'WRONG_AUDIENCE' };
  if (claims.iat > nowSec + clockSkewSec) return { ok: false, reason: 'NOT_YET_VALID' };
  if (claims.exp + clockSkewSec <= nowSec) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, claims };
}

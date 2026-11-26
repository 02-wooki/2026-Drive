// gateway ↔ agent LAN 요청 서명 (ai.md §4.3).
//
// 서명 대상 (줄바꿈으로 연결):
//   WOOKI-HMAC-V1 / audience / METHOD / pathWithQuery / timestamp(ms) / nonce / bodySha256
//
// - audience: 'agent'(gateway→agent) 또는 'gateway'(agent→gateway). 한 방향의 서명을 반대 방향에 재사용 못 하게 한다.
//   두 방향은 같은 비밀키를 써도 되지만 audience 덕분에 서로 바꿔치기할 수 없다.
// - pathWithQuery: 요청 라인의 원문 그대로 (Express 에서는 req.originalUrl).
// - bodySha256: 작은 JSON 본문은 hex SHA-256 을 서명한다. 대용량 스트림(업로드·다운로드)은 'UNSIGNED-PAYLOAD'.
//   이 경우 본문 무결성은 LAN 신뢰 + 업로드 완료 후 해시 검증으로 보완한다.
// - 재전송 방지: 시각 허용 오차 + nonce 일회성.

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { toKeyList } from './secret.js';
import { HMAC_HEADERS, HMAC_MAX_SKEW_MS } from '../constants.js';

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const VERSION = 'WOOKI-HMAC-V1';
const AUDIENCES = new Set(['agent', 'gateway']);
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/; // 32바이트 base64url

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function canonical({ audience, method, pathWithQuery, timestamp, nonce, bodySha256 }) {
  return [VERSION, audience, method.toUpperCase(), pathWithQuery, String(timestamp), nonce, bodySha256].join('\n');
}

function mac(key, text) {
  return createHmac('sha256', key).update(text, 'utf8').digest();
}

/**
 * 요청 서명 헤더를 만든다. 서명에는 항상 첫 번째 키를 쓴다(키 회전 시 새 키를 앞에).
 * @param {{
 *   secret: string | Buffer | Array<string | Buffer>,
 *   audience: 'agent' | 'gateway',
 *   method: string,
 *   pathWithQuery: string,
 *   body?: string | Buffer,          // 주면 SHA-256 을 서명
 *   bodySha256?: string,             // 해시를 이미 알고 있을 때
 *   now?: number,
 *   nonce?: string,
 * }} opts
 * @returns {Record<string, string>}
 */
export function signRequest({ secret, audience, method, pathWithQuery, body, bodySha256, now = Date.now(), nonce }) {
  if (!AUDIENCES.has(audience)) throw new Error(`invalid audience: ${audience}`);
  const [key] = toKeyList(secret);
  const hash = body !== undefined ? sha256Hex(body) : (bodySha256 ?? UNSIGNED_PAYLOAD);
  const n = nonce ?? randomBytes(18).toString('base64url');
  const timestamp = Math.floor(now);
  const sig = mac(key, canonical({ audience, method, pathWithQuery, timestamp, nonce: n, bodySha256: hash }));
  return {
    [HMAC_HEADERS.timestamp]: String(timestamp),
    [HMAC_HEADERS.nonce]: n,
    [HMAC_HEADERS.contentSha256]: hash,
    [HMAC_HEADERS.signature]: sig.toString('base64url'),
  };
}

/**
 * 일회용 nonce 저장소 (메모리). 만료된 항목은 주기적으로 정리하고, 상한을 넘으면 실패 쪽으로 닫는다.
 */
export class NonceStore {
  /** @param {{ maxEntries?: number }} [opts] */
  constructor({ maxEntries = 100_000 } = {}) {
    this.maxEntries = maxEntries;
    /** @type {Map<string, number>} nonce → 만료 시각(ms) */
    this.map = new Map();
  }

  #prune(now) {
    for (const [k, exp] of this.map) if (exp <= now) this.map.delete(k);
  }

  /**
   * 처음 보는 nonce 면 기록하고 true, 이미 본 것이거나 저장소가 가득 차면 false.
   * @param {string} nonce
   * @param {number} expiresAt
   * @param {number} now
   */
  checkAndAdd(nonce, expiresAt, now) {
    const seen = this.map.get(nonce);
    if (seen !== undefined && seen > now) return false;
    if (this.map.size >= this.maxEntries) {
      this.#prune(now);
      if (this.map.size >= this.maxEntries) return false;
    }
    this.map.set(nonce, expiresAt);
    return true;
  }

  get size() {
    return this.map.size;
  }
}

/** 헤더 객체에서 값 하나 꺼내기 (Node 는 소문자 키, 중복 헤더는 배열 → 거부). */
function header(headers, name) {
  const v = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  return typeof v === 'string' ? v : null;
}

/**
 * 요청 서명 검증.
 * 본문 해시가 서명된 경우(bodySha256 !== UNSIGNED_PAYLOAD) 실제 본문과의 비교는 호출자가 해야 한다.
 *
 * @param {{
 *   secret: string | Buffer | Array<string | Buffer>,  // 배열이면 아무 키나 맞으면 통과 (키 회전)
 *   audience: 'agent' | 'gateway',                    // 내가 누구인가
 *   method: string,
 *   pathWithQuery: string,
 *   headers: Record<string, string | string[] | undefined> | Headers,
 *   nonceStore: NonceStore,
 *   now?: number,
 *   maxSkewMs?: number,
 * }} opts
 * @returns {{ ok: true, bodySha256: string } | { ok: false, reason: string }}
 */
export function verifyRequest({
  secret,
  audience,
  method,
  pathWithQuery,
  headers,
  nonceStore,
  now = Date.now(),
  maxSkewMs = HMAC_MAX_SKEW_MS,
}) {
  if (!AUDIENCES.has(audience)) throw new Error(`invalid audience: ${audience}`);
  if (!(nonceStore instanceof NonceStore)) throw new Error('nonceStore is required');
  const keys = toKeyList(secret);

  const ts = header(headers, HMAC_HEADERS.timestamp);
  const nonce = header(headers, HMAC_HEADERS.nonce);
  const bodySha256 = header(headers, HMAC_HEADERS.contentSha256);
  const sigB64 = header(headers, HMAC_HEADERS.signature);
  if (!ts || !nonce || !bodySha256 || !sigB64) return { ok: false, reason: 'MISSING_HEADER' };
  if (!/^\d{1,16}$/.test(ts)) return { ok: false, reason: 'BAD_TIMESTAMP' };
  if (!NONCE_RE.test(nonce)) return { ok: false, reason: 'BAD_NONCE' };
  if (bodySha256 !== UNSIGNED_PAYLOAD && !SHA256_HEX_RE.test(bodySha256)) return { ok: false, reason: 'BAD_CONTENT_HASH' };
  if (!SIG_RE.test(sigB64)) return { ok: false, reason: 'BAD_SIGNATURE' };

  const timestamp = Number(ts);
  if (Math.abs(now - timestamp) > maxSkewMs) return { ok: false, reason: 'CLOCK_SKEW' };

  const given = Buffer.from(sigB64, 'base64url');
  const text = canonical({ audience, method, pathWithQuery, timestamp, nonce, bodySha256 });
  // 일찍 빠져나가지 않고 모든 키를 비교한다
  let match = false;
  for (const key of keys) {
    const expected = mac(key, text);
    if (expected.length === given.length && timingSafeEqual(expected, given)) match = true;
  }
  if (!match) return { ok: false, reason: 'BAD_SIGNATURE' };

  // 서명이 맞은 뒤에만 nonce 를 기록 → 위조 요청으로 저장소를 채울 수 없다
  if (!nonceStore.checkAndAdd(nonce, timestamp + maxSkewMs, now)) return { ok: false, reason: 'REPLAY' };
  return { ok: true, bodySha256 };
}

// 오너 패스키 (WebAuthn) — ai.md §5, D6.
//
//   POST /auth/passkey/register/options   등록 시작
//   POST /auth/passkey/register/verify    등록 완료
//   POST /auth/passkey/login/options      인증 시작
//   POST /auth/passkey/login/verify       인증 완료 → owner 세션 (새 세션 ID)
//
// 등록 허용 조건 (둘 중 하나):
//   a) 등록된 패스키가 하나도 없고, 화이트리스트 OAuth 를 막 통과한 세션 (최초 1회 부트스트랩)
//   b) 이미 owner 세션 (기기 추가)
// → 오너의 OAuth 계정이 털려도, 패스키가 이미 있으면 공격자가 새 패스키를 등록할 수 없다.
//
// 챌린지는 세션에 저장하고, 검증 전에 먼저 소모한다(재사용 불가).
// 암호 검증 자체는 @simplewebauthn/server 에 맡긴다 (직접 구현하지 않는다).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import * as simple from '@simplewebauthn/server';
import { ROLES } from '@wooki-drive/shared/node';
import { HttpError } from '../http.js';
import { issueSession } from './session-cookie.js';

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CREDENTIALS = 20;
const OWNER_USER_ID = new TextEncoder().encode('wooki-drive-owner');

/**
 * @typedef {{
 *   id: string, publicKey: string, counter: number, transports?: string[],
 *   createdAt: number, lastUsedAt: number | null, createdBy: string,
 * }} StoredCredential   publicKey 는 base64url
 */

/** 패스키 저장소 (JSON 파일). 쓰기는 등록·인증 때만이라 드물다. */
export class PasskeyStore {
  /** @param {{ file?: string | null }} [opts] */
  constructor({ file = null } = {}) {
    this.file = file;
    /** @type {StoredCredential[]} */
    this.creds = [];
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8')); // 깨졌으면 시작 실패 — 조용히 비우면 부트스트랩이 다시 열린다
    if (data?.version !== 1 || !Array.isArray(data.credentials)) throw new Error(`passkey file has unknown format: ${this.file}`);
    this.creds = data.credentials;
  }

  async save() {
    if (!this.file) return;
    await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, credentials: this.creds }, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  get count() {
    return this.creds.length;
  }

  find(id) {
    return this.creds.find((c) => c.id === id) ?? null;
  }

  descriptors() {
    return this.creds.map((c) => ({ id: c.id, transports: c.transports }));
  }

  async add(cred) {
    if (this.find(cred.id)) throw new HttpError(409, 'PASSKEY_EXISTS');
    this.creds.push(cred);
    await this.save();
  }

  async touch(id, counter, now) {
    const c = this.find(id);
    if (!c) return;
    c.counter = counter;
    c.lastUsedAt = now;
    await this.save();
  }
}

/**
 * @param {{
 *   publicOrigin: string, cookieSecure: boolean,
 *   sessionTtl: { owner: { absoluteMs: number, idleMs: number } },
 *   store: import('../sessions.js').SessionStore,
 *   passkeys: PasskeyStore,
 *   limiter: import('../rate-limit.js').RateLimiter,
 *   webauthn?: Pick<typeof simple, 'generateRegistrationOptions' | 'verifyRegistrationResponse' | 'generateAuthenticationOptions' | 'verifyAuthenticationResponse'>,
 *   now?: () => number, log?: (m: string) => void,
 * }} deps
 */
export function passkeyRouter({ publicOrigin, cookieSecure, sessionTtl, store, passkeys, limiter, webauthn = simple, now = Date.now, log = () => {} }) {
  const router = express.Router();
  const rpID = new URL(publicOrigin).hostname;

  router.use(express.json({ limit: '32kb' }));
  router.use(limiter.middleware('PASSKEY_RATE_LIMITED'));

  const isPending = (s) => s?.stage === 'passkey' && !s.role;
  const isOwner = (s) => s?.role === ROLES.OWNER;
  const canRegister = (s) => isOwner(s) || (isPending(s) && passkeys.count === 0);

  /** 세션에 챌린지 저장 */
  const saveChallenge = (req, type, challenge) => {
    store.update(req.sessionId, { webauthn: { type, challenge, expiresAt: now() + CHALLENGE_TTL_MS } });
  };
  /** 세션의 챌린지를 꺼내면서 지운다. 없거나 종류가 다르거나 만료면 null. */
  const takeChallenge = (req, type) => {
    const c = req.session?.webauthn;
    store.update(req.sessionId, { webauthn: null });
    if (!c || c.type !== type || c.expiresAt <= now()) return null;
    return c.challenge;
  };

  router.get('/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const s = req.session;
    res.json({
      pending: isPending(s),
      registered: passkeys.count > 0,
      canRegister: canRegister(s),
      canLogin: isPending(s) && passkeys.count > 0,
    });
  });

  // ── 등록 ──
  router.post('/register/options', async (req, res) => {
    if (!canRegister(req.session)) throw new HttpError(403, 'PASSKEY_REGISTRATION_CLOSED');
    if (passkeys.count >= MAX_CREDENTIALS) throw new HttpError(409, 'PASSKEY_LIMIT');
    const options = await webauthn.generateRegistrationOptions({
      rpName: 'Wooki Drive',
      rpID,
      userName: 'owner',
      userDisplayName: req.session.user.nickname,
      userID: OWNER_USER_ID,
      attestationType: 'none',
      excludeCredentials: passkeys.descriptors(),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    saveChallenge(req, 'register', options.challenge);
    res.json(options);
  });

  router.post('/register/verify', async (req, res) => {
    const session = req.session;
    // 옵션 발급 이후 다른 경로로 등록이 끝났을 수도 있으니 다시 확인
    if (!canRegister(session)) throw new HttpError(403, 'PASSKEY_REGISTRATION_CLOSED');
    const challenge = takeChallenge(req, 'register');
    if (!challenge) throw new HttpError(400, 'PASSKEY_CHALLENGE_EXPIRED');

    let result;
    try {
      result = await webauthn.verifyRegistrationResponse({
        response: req.body,
        expectedChallenge: challenge,
        expectedOrigin: publicOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      result = { verified: false };
    }
    if (!result.verified) throw new HttpError(400, 'PASSKEY_FAILED');

    const { credential } = result.registrationInfo;
    const t = now();
    await passkeys.add({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports,
      createdAt: t,
      lastUsedAt: t,
      createdBy: `${session.user.provider}:${session.user.sub}`,
    });
    log(`passkey registered (total ${passkeys.count})`);

    if (isPending(session)) {
      // 최초 등록 = 방금 사용자 확인(UV)까지 했으므로 owner 로 승격. 권한 변경이므로 새 세션 ID.
      const rotated = store.rotate(req.sessionId, { role: ROLES.OWNER, stage: null, webauthn: null }, sessionTtl.owner);
      issueSession(res, rotated.id, sessionTtl.owner, cookieSecure);
    }
    res.json({ ok: true });
  });

  // ── 인증 ──
  router.post('/login/options', async (req, res) => {
    if (!isPending(req.session)) throw new HttpError(403, 'PASSKEY_NOT_PENDING');
    if (passkeys.count === 0) throw new HttpError(409, 'PASSKEY_NOT_REGISTERED');
    const options = await webauthn.generateAuthenticationOptions({
      rpID,
      allowCredentials: passkeys.descriptors(),
      userVerification: 'required',
    });
    saveChallenge(req, 'login', options.challenge);
    res.json(options);
  });

  router.post('/login/verify', async (req, res) => {
    if (!isPending(req.session)) throw new HttpError(403, 'PASSKEY_NOT_PENDING');
    const challenge = takeChallenge(req, 'login');
    if (!challenge) throw new HttpError(400, 'PASSKEY_CHALLENGE_EXPIRED');

    const cred = typeof req.body?.id === 'string' ? passkeys.find(req.body.id) : null;
    if (!cred) throw new HttpError(400, 'PASSKEY_FAILED');

    let result;
    try {
      result = await webauthn.verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: challenge,
        expectedOrigin: publicOrigin,
        expectedRPID: rpID,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
          counter: cred.counter,
          transports: cred.transports,
        },
        requireUserVerification: true,
      });
    } catch {
      result = { verified: false };
    }
    if (!result.verified) throw new HttpError(400, 'PASSKEY_FAILED');

    await passkeys.touch(cred.id, result.authenticationInfo.newCounter, now());
    const rotated = store.rotate(req.sessionId, { role: ROLES.OWNER, stage: null, webauthn: null }, sessionTtl.owner);
    issueSession(res, rotated.id, sessionTtl.owner, cookieSecure);
    log('owner signed in with passkey');
    res.json({ ok: true });
  });

  return router;
}

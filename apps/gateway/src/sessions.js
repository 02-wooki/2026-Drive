// 서버 측 세션 저장소 (ai.md §5).
//
// - 세션 ID: 32바이트 난수(base64url). 쿠키로만 오간다.
// - 저장 키는 ID 의 SHA-256. 세션 파일이 유출돼도 그 값으로 로그인할 수 없다.
// - 만료: 절대 만료(absolute) + 유휴 만료(idle). 역할별 값은 config.session.
//   오너 세션은 lockOnIdle: 유휴 시 지우지 않고 '잠금'(권한 없음, 패스키만 다시) → ai.md D17.
// - 파이 SD카드 쓰기 최소화: 생성·삭제·내용 변경 때만 파일에 기록(디바운스).
//   lastSeen 갱신은 메모리에서만 → 재시작하면 유휴 시간이 더 길게 계산돼 더 빨리 만료(안전한 쪽).

import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

const keyOf = (id) => createHash('sha256').update(id).digest('hex');

/**
 * @typedef {{
 *   role: 'owner' | 'guest',
 *   user: { provider: string, sub: string, nickname: string },
 *   createdAt: number, lastSeen: number, absoluteExpiresAt: number, idleMs: number,
 *   [k: string]: unknown,
 * }} Session
 */

export class SessionStore {
  /**
   * @param {{ file?: string | null, now?: () => number, flushDelayMs?: number, log?: (m: string) => void }} [opts]
   */
  constructor({ file = null, now = Date.now, flushDelayMs = 5000, log = () => {} } = {}) {
    this.file = file;
    this.now = now;
    this.flushDelayMs = flushDelayMs;
    this.log = log;
    /** @type {Map<string, Session>} */
    this.map = new Map();
    this.timer = null;
    this.dirty = false;
  }

  /** 파일에서 불러오기. 깨진 파일이면 비우고 시작(모두 재로그인)한다. */
  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.sessions)) throw new Error('bad format');
      const now = this.now();
      for (const [key, s] of data.sessions) {
        if (typeof key === 'string' && s && !this.#expired(s, now)) this.map.set(key, s);
      }
    } catch (err) {
      this.log(`session file unreadable, starting empty: ${err.message}`);
      this.map.clear();
    }
  }

  /** 완전히 버릴 세션인가. lockOnIdle 세션은 무활동이어도 버리지 않고 get() 에서 잠근다 (ai.md D17). */
  #expired(s, now) {
    if (now >= s.absoluteExpiresAt) return true;
    return !s.lockOnIdle && now - s.lastSeen >= s.idleMs;
  }

  #markDirty() {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => this.log(`session flush failed: ${err.message}`));
    }, this.flushDelayMs);
    this.timer.unref?.();
  }

  /** 즉시 기록 (종료 시 호출). 임시 파일에 쓰고 rename → 중간에 꺼져도 파일이 깨지지 않는다. */
  async flush() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    const now = this.now();
    for (const [k, s] of this.map) if (this.#expired(s, now)) this.map.delete(k);
    await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, sessions: [...this.map] }), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  /**
   * @param {{ role: Session['role'], user: Session['user'], [k: string]: unknown }} data
   * @param {{ absoluteMs: number, idleMs: number }} ttl
   * @returns {{ id: string, session: Session }}
   */
  create(data, ttl) {
    const id = randomBytes(32).toString('base64url');
    const now = this.now();
    const session = {
      ...data,
      createdAt: now,
      lastSeen: now,
      absoluteExpiresAt: now + ttl.absoluteMs,
      idleMs: ttl.idleMs,
    };
    this.map.set(keyOf(id), session);
    this.#markDirty();
    return { id, session };
  }

  /**
   * @param {string} id
   * @param {{ touch?: boolean }} [opts]  touch=false: 백그라운드 폴링처럼 '활동'으로 치지 않는 조회
   * @returns {Session | null}
   */
  get(id, { touch = true } = {}) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const key = keyOf(id);
    const s = this.map.get(key);
    if (!s) return null;
    const now = this.now();
    if (this.#expired(s, now)) {
      this.map.delete(key);
      this.#markDirty();
      return null;
    }
    // 무활동 → 잠금: 권한을 떼고 패스키 대기 상태로. 절대 만료 안에서는 패스키만으로 풀 수 있다.
    if (s.lockOnIdle && s.role && now - s.lastSeen >= s.idleMs) {
      Object.assign(s, { role: null, stage: 'passkey', locked: true, webauthn: null, stepUp: null, lastSeen: now });
      this.#markDirty();
      return s;
    }
    if (touch) s.lastSeen = now; // 메모리에서만
    return s;
  }

  /** 세션 내용 변경 (예: 패스키 통과 후 역할 승격은 반드시 새 ID 로 — rotate 사용). */
  update(id, patch) {
    const s = this.get(id);
    if (!s) return null;
    Object.assign(s, patch);
    this.#markDirty();
    return s;
  }

  /**
   * 권한이 바뀔 때 세션 ID 를 새로 발급 (세션 고정 공격 방지). 기존 ID 는 폐기.
   * @returns {{ id: string, session: Session } | null}
   */
  rotate(id, patch, ttl, { keepAbsolute = false } = {}) {
    const s = this.get(id);
    if (!s) return null;
    this.destroy(id);
    const { createdAt: _c, lastSeen: _l, absoluteExpiresAt: oldAbsolute, idleMs: _i, ...data } = s;
    const created = this.create({ ...data, ...patch }, ttl);
    // 잠금 해제는 '리프레시'일 뿐 — 처음 로그인 기준 절대 만료를 늘리지 않는다
    if (keepAbsolute) created.session.absoluteExpiresAt = Math.min(created.session.absoluteExpiresAt, oldAbsolute);
    return created;
  }

  destroy(id) {
    if (typeof id !== 'string') return;
    if (this.map.delete(keyOf(id))) this.#markDirty();
  }

  get size() {
    return this.map.size;
  }
}

// ── 쿠키 ────────────────────────────────────────────────────────

/** Secure 일 때 __Host- 접두어: Path=/ · Domain 없음 · Secure 강제 → 하위 도메인이 덮어쓸 수 없다. */
export function cookieName(secure) {
  return secure ? '__Host-wd_sid' : 'wd_sid';
}

/** @param {string | undefined} header */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (!k || k in out) continue; // 같은 이름이 여럿이면 첫 번째만
    out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

/** @param {{ secure: boolean, maxAgeSec?: number }} opts  maxAgeSec=0 이면 삭제 */
export function sessionCookie(id, { secure, maxAgeSec }) {
  const parts = [`${cookieName(secure)}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  return parts.join('; ');
}

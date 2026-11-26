// 메모리 기반 고정 윈도 rate limit (ai.md §6: 로그인·방명록·업로드 시작).
// 단일 프로세스·단일 사용자 규모라 메모리로 충분하다. 재시작하면 초기화된다.
import { HttpError } from './http.js';

export class RateLimiter {
  /** @param {{ limit: number, windowMs: number, maxKeys?: number, now?: () => number }} opts */
  constructor({ limit, windowMs, maxKeys = 10_000, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.map = new Map();
  }

  /** @returns {boolean} 허용이면 true */
  hit(key) {
    const now = this.now();
    let e = this.map.get(key);
    if (!e || e.resetAt <= now) {
      if (!e && this.map.size >= this.maxKeys) {
        for (const [k, v] of this.map) if (v.resetAt <= now) this.map.delete(k);
        if (this.map.size >= this.maxKeys) return false; // 키 폭주 시 실패 쪽으로 닫는다
      }
      e = { count: 0, resetAt: now + this.windowMs };
      this.map.set(key, e);
    }
    e.count += 1;
    return e.count <= this.limit;
  }

  /** Express 미들웨어. 키는 클라이언트 IP (trust proxy 설정 기준). */
  middleware(code = 'RATE_LIMITED') {
    return (req, _res, next) => (this.hit(req.ip ?? 'unknown') ? next() : next(new HttpError(429, code)));
  }
}

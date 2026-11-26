import { sessionCookie } from '../sessions.js';

/** 세션 쿠키 발급. 쿠키 수명은 서버 측 절대 만료와 맞춘다(실제 판정은 서버가 한다). */
export function issueSession(res, id, ttl, secure) {
  res.append('Set-Cookie', sessionCookie(id, { secure, maxAgeSec: ttl.absoluteMs / 1000 }));
}

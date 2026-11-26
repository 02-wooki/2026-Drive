// 공용 상수 — 브라우저·gateway·agent 공용. 환경마다 달라지는 값은 .env 로 두고 여기에는 프로토콜 상수만 둔다.

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const ROLES = Object.freeze({ OWNER: 'owner', GUEST: 'guest' });

/** 업로드 청크 크기. Cloudflare 무료 플랜의 요청당 100MB 제한 아래로 여유 있게 (ai.md §3). */
export const UPLOAD_CHUNK_SIZE = 32 * MiB;
/** nginx client_max_body_size 등 서버 쪽 본문 상한. 청크 + 여유. */
export const MAX_CHUNK_REQUEST_BYTES = UPLOAD_CHUNK_SIZE + 1 * MiB;

/** 파이 버퍼 기본 상한 (D9). 실제 값은 gateway .env 에서 덮어쓴다. */
export const DEFAULT_BUFFER_LIMIT_BYTES = 20 * GiB;

/** gateway ↔ agent 요청 서명 헤더 (소문자: Node 가 헤더 키를 소문자로 준다). */
export const HMAC_HEADERS = Object.freeze({
  timestamp: 'x-wooki-timestamp',
  nonce: 'x-wooki-nonce',
  contentSha256: 'x-wooki-content-sha256',
  signature: 'x-wooki-signature',
});
/** 서명 타임스탬프 허용 오차. 파이·데스크탑 모두 NTP 동기화 전제. */
export const HMAC_MAX_SKEW_MS = 60_000;

/** LAN 직결 토큰 수명 (ai.md §4.1-2: 약 5분). */
export const LAN_TOKEN_TTL_SEC = 300;
export const TOKEN_CLOCK_SKEW_SEC = 30;
/** 토큰 aud 값 */
export const TOKEN_AUDIENCE = Object.freeze({ LAN_AGENT: 'lan-agent' });

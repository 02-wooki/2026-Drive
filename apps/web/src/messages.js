// 서버 오류 코드 → 사용자 문구 (ai.md §9: 서버는 코드만, 한국어 문구는 web 에서).
const MESSAGES = {
  NETWORK: '서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.',
  LOGIN_REQUIRED: '로그인이 필요해요.',
  OWNER_ONLY: '오너만 볼 수 있는 곳이에요.',
  FORBIDDEN: '권한이 없어요.',
  NOT_FOUND: '항목을 찾을 수 없어요. 이동되었거나 삭제되었을 수 있어요.',
  NOT_A_DIRECTORY: '폴더가 아니에요.',
  NOT_A_FILE: '파일이 아니에요.',
  FS_PERMISSION_DENIED: '이 항목에 접근할 권한이 없어요.',
  AGENT_OFFLINE: '데스크탑이 꺼져 있어요. 켜지면 자동으로 다시 불러올게요.',
  AGENT_AUTH_FAILED: '게이트웨이와 데스크탑의 인증 설정이 맞지 않아요. 비밀키를 확인해 주세요.',
  AGENT_ERROR: '데스크탑에서 오류가 났어요.',
  AGENT_BAD_RESPONSE: '데스크탑 응답을 이해하지 못했어요.',
  LOGIN_RATE_LIMITED: '로그인 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.',
  PASSKEY_RATE_LIMITED: '패스키 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.',
  OAUTH_STATE_MISMATCH: '로그인 요청이 만료되었거나 올바르지 않아요. 처음부터 다시 시도해 주세요.',
  OAUTH_DENIED: '로그인이 취소되었어요.',
  OAUTH_NO_CODE: '로그인 응답이 올바르지 않아요.',
  OAUTH_TOKEN_FAILED: '로그인 서비스와 통신하지 못했어요. 다시 시도해 주세요.',
  OAUTH_PROFILE_FAILED: '계정 정보를 받아오지 못했어요.',
  UNKNOWN_PROVIDER: '지원하지 않는 로그인 방식이에요.',
  PASSKEY_FAILED: '패스키 확인에 실패했어요.',
  PASSKEY_CHALLENGE_EXPIRED: '시간이 지나 요청이 만료되었어요. 다시 시도해 주세요.',
  PASSKEY_REGISTRATION_CLOSED: '새 패스키를 등록할 수 없어요. 이미 등록된 패스키로 확인해 주세요.',
  PASSKEY_NOT_PENDING: '먼저 로그인해 주세요.',
  PASSKEY_NOT_REGISTERED: '등록된 패스키가 없어요.',
  PASSKEY_EXISTS: '이미 등록된 패스키예요.',
  PASSKEY_LIMIT: '패스키를 더 등록할 수 없어요.',
  PASSKEY_CANCELLED: '패스키 확인이 취소되었어요.',
  PASSKEY_UNSUPPORTED: '이 브라우저는 패스키를 지원하지 않아요.',
  CSRF_ORIGIN: '요청 출처를 확인할 수 없어요. 페이지를 새로고침해 주세요.',
};

/** @param {{ code?: string } | string | null | undefined} err */
export function messageFor(err) {
  const code = typeof err === 'string' ? err : err?.code;
  if (!code) return '알 수 없는 오류가 났어요.';
  if (code.startsWith('PATH_')) return '사용할 수 없는 경로예요.';
  return MESSAGES[code] ?? `오류가 났어요. (${code})`;
}

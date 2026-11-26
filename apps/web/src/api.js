// gateway API 클라이언트. 같은 출처라 쿠키는 자동으로 붙고, POST 에는 브라우저가 Origin 을 붙인다(CSRF 검사).

export class ApiError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** 세션이 잠기거나 만료되면(401 LOGIN_REQUIRED) 앱 전체에 알린다 → App 이 로그인/패스키 화면으로 보냄 */
export const AUTH_LOST_EVENT = 'wd:auth-lost';
export function reportAuthLost(code) {
  if (code === 'LOGIN_REQUIRED') dispatchEvent(new Event(AUTH_LOST_EVENT));
}

/**
 * @param {{ background?: boolean }} [opts]  background: 주기적 폴링 — 서버가 '활동'으로 치지 않는다(무활동 잠금 유지)
 */
export async function request(method, url, body, { background = false } = {}) {
  let res;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (background) headers['X-Wooki-Background'] = '1';
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 본문 없음 */
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error ?? `HTTP_${res.status}`);
    if (Number.isSafeInteger(data?.received)) err.received = data.received;
    if (url !== '/api/me') reportAuthLost(err.code);
    throw err;
  }
  return data;
}

/** @typedef {'files' | 'demo'} Source  files = 데스크탑(오너), demo = 파이의 데모 폴더 */

const q = (path) => `path=${encodeURIComponent(path)}`;

export const api = {
  me: () => request('GET', '/api/me'),
  logout: () => request('POST', '/api/logout'),
  status: () => request('GET', '/api/status', undefined, { background: true }),
  trashSummary: () => request('GET', '/api/files/trash/summary', undefined, { background: true }),
  providers: () => request('GET', '/auth/providers'),
  devLogin: (role) => request('POST', '/auth/dev/login', { role }),

  /** @param {Source} source */
  list: (source, path) => request('GET', `/api/${source}/list?${q(path)}`),

  // ── 쓰기 (오너, 데스크탑) ──
  mkdir: (parent, name, onConflict = 'rename') => request('POST', '/api/files/mkdir', { parent, name, onConflict }),
  rename: (path, name) => request('POST', '/api/files/rename', { path, name }),
  move: (paths, to, onConflict = 'fail') => request('POST', '/api/files/move', { paths, to, onConflict }),
  trash: (paths) => request('POST', '/api/files/trash', { paths }),
  trashList: () => request('GET', '/api/files/trash'),
  trashRestore: (ids) => request('POST', '/api/files/trash/restore', { ids }),
  trashDelete: (ids) => request('POST', '/api/files/trash/delete', { ids }),
  trashEmpty: () => request('POST', '/api/files/trash/empty', {}),

  uploads: {
    create: (path, size, mtimeMs) => request('POST', '/api/files/uploads', { path, size, mtimeMs }),
    status: (id) => request('GET', `/api/files/uploads/${encodeURIComponent(id)}`),
    complete: (id) => request('POST', `/api/files/uploads/${encodeURIComponent(id)}/complete`, {}),
    abort: (id) => request('DELETE', `/api/files/uploads/${encodeURIComponent(id)}`),
  },

  passkey: {
    reauthOptions: () => request('POST', '/auth/passkey/reauth/options'),
    reauthVerify: (response) => request('POST', '/auth/passkey/reauth/verify', response),
    status: () => request('GET', '/auth/passkey/status'),
    registerOptions: () => request('POST', '/auth/passkey/register/options'),
    registerVerify: (response) => request('POST', '/auth/passkey/register/verify', response),
    loginOptions: () => request('POST', '/auth/passkey/login/options'),
    loginVerify: (response) => request('POST', '/auth/passkey/login/verify', response),
  },
};

/**
 * 파일 내용 URL (img/video src, 다운로드 링크).
 * @param {Source} source
 * @param {'inline' | 'attachment'} [disposition]
 */
export function contentUrl(source, path, disposition = 'inline') {
  return `/api/${source}/content?${q(path)}&disposition=${disposition}`;
}

/**
 * 데스크탑 썸네일 URL. 파일 버전(수정시각-크기)을 넣어 파일이 바뀌면 URL 도 바뀐다 → 브라우저·파이 모두 오래 캐시 가능.
 * @param {{ path: string, mtimeMs: number | null, size: number | null }} entry
 */
export function thumbUrl(entry, width = 256) {
  const v = `${Math.floor(entry.mtimeMs ?? 0)}-${entry.size ?? 0}`;
  return `/api/files/thumb?${q(entry.path)}&w=${width}&v=${v}`;
}

/** 텍스트 미리보기: 앞부분만 Range 로 받는다. */
export async function fetchTextPreview(source, path, maxBytes = 256 * 1024) {
  const res = await fetch(contentUrl(source, path), { headers: { Range: `bytes=0-${maxBytes - 1}` }, credentials: 'same-origin' });
  if (!res.ok && res.status !== 206) {
    let code = `HTTP_${res.status}`;
    try {
      code = (await res.json()).error ?? code;
    } catch {}
    throw new ApiError(res.status, code);
  }
  const buf = await res.arrayBuffer();
  const total = Number(res.headers.get('content-range')?.split('/')[1] ?? buf.byteLength);
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), truncated: total > buf.byteLength };
}

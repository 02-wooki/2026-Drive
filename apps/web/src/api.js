// gateway API 클라이언트. 같은 출처라 쿠키는 자동으로 붙고, POST 에는 브라우저가 Origin 을 붙인다(CSRF 검사).

export class ApiError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP_${res.status}`);
  return data;
}

/** @typedef {'files' | 'demo'} Source  files = 데스크탑(오너), demo = 파이의 데모 폴더 */

const q = (path) => `path=${encodeURIComponent(path)}`;

export const api = {
  me: () => request('GET', '/api/me'),
  logout: () => request('POST', '/api/logout'),
  status: () => request('GET', '/api/status'),
  providers: () => request('GET', '/auth/providers'),
  devLogin: (role) => request('POST', '/auth/dev/login', { role }),

  /** @param {Source} source */
  list: (source, path) => request('GET', `/api/${source}/list?${q(path)}`),

  passkey: {
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

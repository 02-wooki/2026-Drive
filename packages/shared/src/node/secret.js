import { randomBytes } from 'node:crypto';

export const MIN_SECRET_BYTES = 32;

/** 새 비밀키 생성 (.env 용). 64바이트 → base64url 86자. */
export function generateSecret(bytes = 64) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * 비밀키(또는 키 회전용 배열)를 Buffer 배열로 만든다. 너무 짧으면 시작 단계에서 바로 실패시킨다.
 * @param {string | Buffer | Array<string | Buffer>} secrets
 * @returns {Buffer[]}
 */
export function toKeyList(secrets) {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter((s) => s != null && s !== '');
  if (list.length === 0) throw new Error('secret is required');
  return list.map((s) => {
    const buf = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
    if (buf.length < MIN_SECRET_BYTES) throw new Error(`secret must be at least ${MIN_SECRET_BYTES} bytes`);
    return buf;
  });
}

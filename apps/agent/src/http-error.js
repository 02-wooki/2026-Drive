import { PathError } from '@wooki-drive/shared/node';

export class HttpError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** 파일 시스템 오류 → HTTP 상태. 응답에는 코드만 싣고 경로·스택은 싣지 않는다. */
export function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof PathError) return new HttpError(400, `PATH_${err.code}`);
  switch (err?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new HttpError(404, 'NOT_FOUND');
    case 'EACCES':
    case 'EPERM':
      return new HttpError(403, 'FS_PERMISSION_DENIED');
    case 'EBUSY':
      return new HttpError(409, 'FS_BUSY');
    default:
      // express/send 가 만든 HTTP 오류 (예: 416 Range Not Satisfiable)
      if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
        return new HttpError(err.status, 'BAD_REQUEST');
      }
      return new HttpError(500, 'INTERNAL');
  }
}

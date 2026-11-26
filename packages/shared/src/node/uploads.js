// 청크 업로드 + 이어올리기 (ai.md §3: Cloudflare 요청당 100MB 제한 → 32MB 청크).
//
// 흐름: create(size, meta) → writeChunk(offset, stream) × N → take() → 호출자가 임시 파일을 최종 위치로 rename
//
//  - 청크는 순서대로만 받는다. offset 이 서버의 received 와 다르면 409 + 현재 received 를 알려준다
//    (이미 받은 구간의 재전송은 성공으로 처리 → 네트워크 재시도가 안전).
//  - 청크마다 SHA-256 을 받으면 스트리밍하면서 검증하고, 틀리면 그 청크를 잘라내고 거부한다.
//  - 임시 파일은 stagingDir(루트 밖, 같은 드라이브)에 둔다. 메타데이터는 <id>.json, 데이터는 <id>.part.
//  - 오래 방치된 업로드는 cleanup() 이 지운다.
//  - 대용량을 메모리에 올리지 않는다 (ai.md §9).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BrowseError } from './fs-browse.js';
import { UPLOAD_CHUNK_SIZE } from '../constants.js';

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * @typedef {{
 *   id: string, size: number, received: number, createdAt: number, updatedAt: number,
 *   meta: Record<string, unknown>,
 * }} UploadInfo
 */

export class UploadStore {
  /**
   * @param {{ stagingDir: string, chunkSize?: number, maxIdleMs?: number, maxSize?: number, now?: () => number }} opts
   */
  constructor({ stagingDir, chunkSize = UPLOAD_CHUNK_SIZE, maxIdleMs = 24 * 3600_000, maxSize = 2 ** 50, now = Date.now }) {
    this.dir = stagingDir;
    this.chunkSize = chunkSize;
    this.maxIdleMs = maxIdleMs;
    this.maxSize = maxSize;
    this.now = now;
    /** 동시에 같은 업로드에 쓰지 않도록 */
    this.busy = new Set();
  }

  #paths(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new BrowseError('UPLOAD_NOT_FOUND', 404);
    return { meta: path.join(this.dir, `${id}.json`), part: path.join(this.dir, `${id}.part`) };
  }

  async #read(id) {
    const { meta } = this.#paths(id);
    try {
      return JSON.parse(await fsp.readFile(meta, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw new BrowseError('UPLOAD_NOT_FOUND', 404);
      throw err;
    }
  }

  async #write(info) {
    const { meta } = this.#paths(info.id);
    const tmp = `${meta}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(info));
    await fsp.rename(tmp, meta);
  }

  /** @returns {Promise<UploadInfo>} */
  async create(size, meta = {}) {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.maxSize) throw new BrowseError('BAD_SIZE', 400);
    await fsp.mkdir(this.dir, { recursive: true });
    const id = randomBytes(16).toString('base64url');
    const t = this.now();
    const info = { id, size, received: 0, createdAt: t, updatedAt: t, meta };
    await fsp.writeFile(this.#paths(id).part, Buffer.alloc(0), { flag: 'wx' });
    await this.#write(info);
    return info;
  }

  /** @returns {Promise<UploadInfo>} */
  async status(id) {
    return this.#read(id);
  }

  /**
   * 청크 하나 쓰기.
   * @param {string} id
   * @param {number} offset
   * @param {import('node:stream').Readable} body
   * @param {{ length: number, sha256?: string | null }} opts  length 는 Content-Length
   * @returns {Promise<UploadInfo>}
   */
  async writeChunk(id, offset, body, { length, sha256 = null }) {
    const p = this.#paths(id);
    if (this.busy.has(id)) throw new BrowseError('UPLOAD_BUSY', 409);
    this.busy.add(id);
    try {
      const info = await this.#read(id);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new BrowseError('BAD_OFFSET', 400);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.chunkSize) throw new BrowseError('BAD_CHUNK_LENGTH', 400);
      if (offset + length > info.size) throw new BrowseError('BAD_CHUNK_LENGTH', 400);
      if (sha256 !== null && !SHA256_RE.test(sha256)) throw new BrowseError('BAD_CHUNK_HASH', 400);

      // 이미 받은 구간 재전송 → 본문은 버리고 성공 처리
      if (offset + length <= info.received) {
        body.resume();
        return info;
      }
      if (offset !== info.received) {
        body.resume();
        const err = new BrowseError('OFFSET_MISMATCH', 409);
        err.received = info.received;
        throw err;
      }

      const hash = createHash('sha256');
      let count = 0;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          count += chunk.length;
          if (count > length) return cb(new BrowseError('BAD_CHUNK_LENGTH', 400));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(body, meter, fs.createWriteStream(p.part, { flags: 'r+', start: offset }));
        if (count !== length) throw new BrowseError('INCOMPLETE_CHUNK', 400);
        if (sha256 !== null && hash.digest('hex') !== sha256) throw new BrowseError('CHUNK_CORRUPT', 400);
      } catch (err) {
        // 이번 청크로 쓴 부분은 되돌린다
        await fsp.truncate(p.part, info.received).catch(() => {});
        throw err instanceof BrowseError ? err : new BrowseError('INCOMPLETE_CHUNK', 400);
      }

      info.received = offset + length;
      info.updatedAt = this.now();
      await this.#write(info);
      return info;
    } finally {
      this.busy.delete(id);
    }
  }

  /**
   * 완료 확인 후 임시 파일 경로를 넘긴다. 호출자가 최종 위치로 옮긴 뒤 finish() 를 호출한다.
   * @returns {Promise<{ info: UploadInfo, partPath: string }>}
   */
  async take(id) {
    const info = await this.#read(id);
    if (info.received !== info.size) {
      const err = new BrowseError('UPLOAD_INCOMPLETE', 409);
      err.received = info.received;
      throw err;
    }
    if (this.busy.has(id)) throw new BrowseError('UPLOAD_BUSY', 409);
    return { info, partPath: this.#paths(id).part };
  }

  /** 메타데이터 정리 (데이터 파일은 이미 옮겨졌거나 지움) */
  async finish(id) {
    const p = this.#paths(id);
    await fsp.rm(p.meta, { force: true });
    await fsp.rm(p.part, { force: true });
  }

  async abort(id) {
    if (this.busy.has(id)) throw new BrowseError('UPLOAD_BUSY', 409);
    await this.#read(id);
    await this.finish(id);
  }

  /** 오래 방치된 업로드 정리. @returns {Promise<number>} 지운 개수 */
  async cleanup() {
    let names;
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
    let removed = 0;
    const t = this.now();
    for (const name of names) {
      const m = /^([A-Za-z0-9_-]{22})\.(json|part)$/.exec(name);
      if (!m) continue;
      const id = m[1];
      if (this.busy.has(id)) continue;
      let stale;
      try {
        const info = JSON.parse(await fsp.readFile(path.join(this.dir, `${id}.json`), 'utf8'));
        stale = t - info.updatedAt > this.maxIdleMs;
      } catch {
        // 메타 없는 .part (중간에 꺼짐) → 파일 시각으로 판단
        const st = await fsp.stat(path.join(this.dir, name)).catch(() => null);
        stale = !st || t - st.mtimeMs > this.maxIdleMs;
      }
      if (stale) {
        await fsp.rm(path.join(this.dir, name), { force: true });
        if (m[2] === 'json') removed++;
      }
    }
    return removed;
  }
}

// 파이 임시 보관함 (ai.md D3, D9, §4.1-3). 데스크탑이 꺼져 있을 때 오너가 고르면 업로드를 파이에 받아 두고,
// 데스크탑이 켜지면 gateway 가 agent 로 밀어 넣는다(같은 청크 + SHA-256 프로토콜). 다 들어가면 파이에서 지운다.
//
//  dir/staging/  받는 중 (UploadStore — 데스크탑 업로드와 같은 청크·이어올리기 규칙)
//  dir/ready/<id>.data + <id>.json   다 받았고 데스크탑으로 옮기기를 기다리는 파일
//
// 용량 상한(BUFFER_MAX_GB, 기본 20GB)은 대기 파일 + 받는 중인 업로드의 "예약 크기" 합으로 판단한다.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UploadStore, BrowseError, normalizeVirtualPath, parseVirtualPath, isReservedPath, UPLOAD_CHUNK_SIZE } from '@wooki-drive/shared/node';

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** 버퍼 항목 상태 */
/** @typedef {{ id: string, path: string, size: number, mtimeMs: number | null, createdAt: number, error: string | null }} BufferItem */

export class BufferStore {
  /**
   * @param {{ dir: string, maxBytes: number, chunkSize?: number, now?: () => number, log?: (m: string) => void }} opts
   */
  constructor({ dir, maxBytes, chunkSize = UPLOAD_CHUNK_SIZE, now = Date.now, log = () => {} }) {
    this.readyDir = path.join(dir, 'ready');
    this.uploads = new UploadStore({ stagingDir: path.join(dir, 'staging'), chunkSize, maxSize: maxBytes, now });
    this.maxBytes = maxBytes;
    this.now = now;
    this.log = log;
    this.syncing = null;
    fs.mkdirSync(this.readyDir, { recursive: true, mode: 0o700 });
  }

  get chunkSize() {
    return this.uploads.chunkSize;
  }

  #files(id) {
    if (!ID_RE.test(id)) throw new BrowseError('BUFFER_ITEM_NOT_FOUND', 404);
    return { data: path.join(this.readyDir, `${id}.data`), meta: path.join(this.readyDir, `${id}.json`) };
  }

  /** @returns {Promise<BufferItem[]>} 오래된 순 */
  async list() {
    const names = await fsp.readdir(this.readyDir).catch(() => []);
    const items = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        items.push(JSON.parse(await fsp.readFile(path.join(this.readyDir, n), 'utf8')));
      } catch {}
    }
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 대기 파일 + 받는 중 예약 크기 */
  async usage() {
    let used = 0;
    for (const it of await this.list()) used += it.size;
    const staging = await fsp.readdir(this.uploads.dir).catch(() => []);
    for (const n of staging) {
      if (!n.endsWith('.json')) continue;
      try {
        used += JSON.parse(await fsp.readFile(path.join(this.uploads.dir, n), 'utf8')).size;
      } catch {}
    }
    return { used, max: this.maxBytes, free: Math.max(0, this.maxBytes - used) };
  }

  /** 받기 시작. 경로 형식은 여기서, 최종 검증(이름 규칙·충돌)은 데스크탑으로 옮길 때 agent 가 한다. */
  async create(vpath, size, mtimeMs) {
    const p = normalizeVirtualPath(vpath);
    if (parseVirtualPath(p).length === 0) throw new BrowseError('PATH_ROOT', 400);
    if (isReservedPath(p)) throw new BrowseError('PATH_RESERVED', 400);
    if (mtimeMs !== undefined && mtimeMs !== null && !(Number.isFinite(mtimeMs) && mtimeMs > 0)) throw new BrowseError('BAD_MTIME', 400);
    if (!Number.isSafeInteger(size) || size < 0) throw new BrowseError('BAD_SIZE', 400);
    const { free } = await this.usage();
    if (size > free) throw new BrowseError('BUFFER_FULL', 507);
    return this.uploads.create(size, { path: p, mtimeMs: mtimeMs ?? null });
  }

  /** 다 받은 업로드를 대기 목록으로 */
  async complete(id) {
    const { info, partPath } = await this.uploads.take(id);
    const f = this.#files(info.id);
    await fsp.rename(partPath, f.data);
    /** @type {BufferItem} */
    const item = { id: info.id, path: info.meta.path, size: info.size, mtimeMs: info.meta.mtimeMs ?? null, createdAt: this.now(), error: null };
    await fsp.writeFile(f.meta, JSON.stringify(item), { mode: 0o600 });
    await this.uploads.finish(info.id);
    return item;
  }

  async remove(id) {
    const f = this.#files(id);
    try {
      await fsp.access(f.meta);
    } catch {
      throw new BrowseError('BUFFER_ITEM_NOT_FOUND', 404);
    }
    await fsp.rm(f.meta, { force: true });
    await fsp.rm(f.data, { force: true });
  }

  /**
   * 대기 파일을 데스크탑으로 옮긴다. 이미 도는 중이면 그 작업을 기다린다.
   * @param {import('./agent-client.js').AgentClient} agent
   * @returns {Promise<{ moved: number, failed: number }>}
   */
  sync(agent) {
    if (!this.syncing) {
      this.syncing = this.#syncAll(agent).finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  async #syncAll(agent) {
    let moved = 0;
    let failed = 0;
    for (const item of await this.list()) {
      if (item.error) continue; // 거부된 항목은 오너가 지우거나 다시 시도할 때까지 둔다
      try {
        const finalPath = await this.#push(agent, item);
        await this.remove(item.id);
        moved++;
        this.log(`buffer: moved ${item.size} bytes to the desktop`);
        this.onMoved?.(finalPath);
      } catch (err) {
        const code = err?.code ?? 'SYNC_FAILED';
        // 꺼짐·시간 초과·일시 오류는 다음에 다시. 그 외(경로 거부 등)는 항목에 기록하고 넘어간다
        if (code === 'AGENT_OFFLINE' || code === 'AGENT_TIMEOUT' || code === 'AGENT_ERROR' || err?.status >= 500) {
          this.log(`buffer: sync paused (${code})`);
          break;
        }
        failed++;
        await this.#markError(item, code);
        this.log(`buffer: item rejected by the desktop (${code})`);
      }
    }
    return { moved, failed };
  }

  async #markError(item, code) {
    const f = this.#files(item.id);
    await fsp.writeFile(f.meta, JSON.stringify({ ...item, error: code }), { mode: 0o600 });
  }

  /** 거부된 항목을 다시 시도 대상으로 */
  async retry(id) {
    const f = this.#files(id);
    let item;
    try {
      item = JSON.parse(await fsp.readFile(f.meta, 'utf8'));
    } catch {
      throw new BrowseError('BUFFER_ITEM_NOT_FOUND', 404);
    }
    await fsp.writeFile(f.meta, JSON.stringify({ ...item, error: null }), { mode: 0o600 });
  }

  /** 파일 하나를 agent 업로드 프로토콜로 전송. @returns {Promise<string>} 데스크탑에 저장된 경로 */
  async #push(agent, item) {
    const { data: file } = this.#files(item.id);
    const { data: c } = await agent.sendJson('POST', '/v1/uploads', { path: item.path, size: item.size, ...(item.mtimeMs ? { mtimeMs: item.mtimeMs } : {}) });
    let offset = c.received ?? 0;
    try {
      while (offset < item.size) {
        const end = Math.min(offset + c.chunkSize, item.size);
        const length = end - offset;
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(file, { start: offset, end: end - 1 })) hash.update(chunk);
        const { data } = await agent.pipeUpload(fs.createReadStream(file, { start: offset, end: end - 1 }), `/v1/uploads/${c.id}?offset=${offset}`, {
          'Content-Length': String(length),
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Sha256': hash.digest('hex'),
        });
        offset = data.received;
      }
      const { data: done } = await agent.sendJson('POST', `/v1/uploads/${c.id}/complete`, {});
      return done.path;
    } catch (err) {
      // 실패하면 데스크탑의 반쯤 받은 임시 파일을 지운다(다음에 처음부터)
      await agent
        .request('DELETE', `/v1/uploads/${c.id}`)
        .then((r) => r.resume())
        .catch(() => {});
      throw err;
    }
  }
}

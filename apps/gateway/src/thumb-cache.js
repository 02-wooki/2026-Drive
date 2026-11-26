// 썸네일 캐시 (파이, ai.md §4.2: 데스크탑이 꺼져도 썸네일은 보이게).
//
//  - 키 = SHA-256(가상 경로, 파일 버전 "수정시각-크기", 폭). 파일이 바뀌면 버전이 바뀌어 자연히 새 키.
//  - SD카드 쓰기 최소화: 파일 버전마다 한 번만 쓴다. 조회 시 시각 갱신(쓰기)도 하지 않는다.
//  - 상한을 넘으면 오래 만든 것부터 지운다(FIFO). 기본 512MB.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const VERSION_RE = /^\d{1,16}-\d{1,16}$/;

export class ThumbCache {
  /** @param {{ dir: string, maxBytes?: number, log?: (m: string) => void }} opts */
  constructor({ dir, maxBytes = 512 * 1024 * 1024, log = () => {} }) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.log = log;
    this.total = 0;
    this.pruning = null;
  }

  static isVersion(v) {
    return typeof v === 'string' && VERSION_RE.test(v);
  }

  #file(vpath, version, width) {
    const key = createHash('sha256').update(`${vpath}\n${version}\n${width}`).digest('hex');
    return path.join(this.dir, key.slice(0, 2), `${key}.webp`);
  }

  /** 시작 시 현재 용량 계산 */
  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    this.total = 0;
    for (const f of await this.#all()) this.total += f.size;
  }

  async #all() {
    const out = [];
    let subs;
    try {
      subs = await fsp.readdir(this.dir);
    } catch {
      return out;
    }
    for (const sub of subs) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      for (const name of await fsp.readdir(path.join(this.dir, sub)).catch(() => [])) {
        const p = path.join(this.dir, sub, name);
        const st = await fsp.stat(p).catch(() => null);
        if (st?.isFile()) out.push({ p, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return out;
  }

  /** @returns {string | null} 캐시 파일 경로 */
  get(vpath, version, width) {
    if (!ThumbCache.isVersion(version)) return null;
    const p = this.#file(vpath, version, width);
    return fs.existsSync(p) ? p : null;
  }

  async put(vpath, version, width, buf) {
    if (!ThumbCache.isVersion(version)) return;
    const p = this.#file(vpath, version, width);
    if (fs.existsSync(p)) return;
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, p);
    this.total += buf.length;
    if (this.total > this.maxBytes && !this.pruning) {
      this.pruning = this.#prune().finally(() => {
        this.pruning = null;
      });
    }
  }

  async #prune() {
    const files = (await this.#all()).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((s, f) => s + f.size, 0);
    const target = this.maxBytes * 0.9;
    let removed = 0;
    for (const f of files) {
      if (total <= target) break;
      await fsp.rm(f.p, { force: true });
      total -= f.size;
      removed++;
    }
    this.total = total;
    if (removed) this.log(`thumb cache pruned ${removed} file(s)`);
  }
}

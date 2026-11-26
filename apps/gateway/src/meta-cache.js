// 데스크탑 폴더 목록 캐시 (ai.md §4.2). 데스크탑이 꺼져 있어도 마지막으로 본 목록을 읽기 전용으로 보여준다.
//
//  - 데스크탑이 켜져 있을 때 지나간 목록(/v1/list 응답)을 폴더 경로별로 보관
//  - 켜지면 한 번 전체를 천천히 훑는다(crawl) → 안 열어 본 폴더도 꺼졌을 때 볼 수 있게
//  - 메모리에 두고 몇 분에 한 번만 파일로 기록(SD카드 쓰기 최소화). 꺼질 때도 기록
//  - 이름·크기·수정시각만. 파일 내용은 저장하지 않는다(썸네일은 thumb-cache 가 따로)

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;

/** 목록 항목에서 보관할 필드만 */
const slim = (e) => ({
  name: e.name,
  path: e.path,
  type: e.type,
  size: e.size,
  mtimeMs: e.mtimeMs,
  link: e.link,
  hidden: e.hidden,
  addressable: e.addressable,
});

const parentOf = (p) => (p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/');
const isSelfOrUnder = (p, base) => p === base || p.startsWith(base === '/' ? '/' : `${base}/`);

export class MetaCache {
  /**
   * @param {{ file?: string | null, maxFolders?: number, flushMs?: number, now?: () => number, log?: (m: string) => void }} [opts]
   */
  constructor({ file = null, maxFolders = 20_000, flushMs = 5 * 60_000, now = Date.now, log = () => {} } = {}) {
    this.file = file;
    this.maxFolders = maxFolders;
    this.flushMs = flushMs;
    this.now = now;
    this.log = log;
    /** @type {Map<string, { at: number, entries: any[] }>} 삽입 순서 = 오래된 순 */
    this.folders = new Map();
    this.dirty = false;
    this.timer = null;
    this.crawling = false;
  }

  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data?.v !== VERSION || typeof data.folders !== 'object') return;
      const sorted = Object.entries(data.folders).sort((a, b) => a[1].at - b[1].at);
      for (const [p, v] of sorted) if (Array.isArray(v?.entries) && Number.isFinite(v.at)) this.folders.set(p, v);
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`meta cache unreadable, starting empty: ${err.message}`);
    }
  }

  start() {
    if (!this.file || this.timer) return;
    this.timer = setInterval(() => this.flush().catch((err) => this.log(`meta cache flush failed: ${err.message}`)), this.flushMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async flush() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ v: VERSION, folders: Object.fromEntries(this.folders) }), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  /** 데스크탑에서 받은 목록 저장 */
  put(folder, entries) {
    this.folders.delete(folder);
    this.folders.set(folder, { at: this.now(), entries: entries.map(slim) });
    while (this.folders.size > this.maxFolders) this.folders.delete(this.folders.keys().next().value);
    this.dirty = true;
  }

  /** @returns {{ at: number, entries: any[] } | null} */
  get(folder) {
    return this.folders.get(folder) ?? null;
  }

  /** 부모 목록에서 항목 하나 찾기 */
  stat(p) {
    if (p === '/') return null;
    const parent = this.folders.get(parentOf(p));
    return parent?.entries.find((e) => e.path === p) ?? null;
  }

  /** 이름 변경·이동·휴지통 뒤: 그 경로(와 하위)·부모 목록을 버린다. 다음에 켜진 상태로 볼 때 다시 채워진다. */
  invalidate(paths) {
    let changed = false;
    for (const p of paths) {
      if (typeof p !== 'string') continue;
      for (const key of [...this.folders.keys()]) {
        if (isSelfOrUnder(key, p) || key === parentOf(p)) {
          this.folders.delete(key);
          changed = true;
        }
      }
    }
    if (changed) this.dirty = true;
  }

  /**
   * 데스크탑 전체 폴더를 천천히 훑어 캐시를 채운다. 한 번에 하나씩, 실패하면 멈춘다(꺼짐 등).
   * @param {(folder: string) => Promise<{ entries: any[] }>} list
   * @returns {Promise<number>} 훑은 폴더 수
   */
  async crawl(list, { maxFolders = this.maxFolders, pauseMs = 20 } = {}) {
    if (this.crawling) return 0;
    this.crawling = true;
    let count = 0;
    try {
      const queue = ['/'];
      const visited = [];
      while (queue.length && count < maxFolders) {
        const folder = queue.shift();
        let r;
        try {
          r = await list(folder);
        } catch (err) {
          if (err?.status === 404 || err?.code === 'NOT_A_DIRECTORY') continue; // 그 사이 사라짐
          throw err;
        }
        this.put(folder, r.entries);
        visited.push(folder);
        count++;
        for (const e of r.entries) if (e.type === 'dir' && e.addressable && !e.link) queue.push(e.path);
        if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
      }
      // 끝까지 훑었으면 그 사이 사라진 폴더의 옛 목록은 버린다
      if (queue.length === 0) {
        const seen = new Set(visited);
        for (const key of [...this.folders.keys()]) if (!seen.has(key)) this.folders.delete(key);
      }
      this.log(`meta cache: crawled ${count} folder(s)`);
      await this.flush();
      return count;
    } finally {
      this.crawling = false;
    }
  }
}

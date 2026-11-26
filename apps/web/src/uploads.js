// 업로드 관리자: 큐, 동시 전송, 청크 SHA-256, 재시도, 새로고침 후 이어올리기.
//
// 한 파일 흐름: create → (GET status 로 이어올릴 위치 확인) → PUT 청크 × N → complete
//  - 청크는 서버가 준 chunkSize(기본 32MB) 단위. Cloudflare 요청당 100MB 제한 아래 (ai.md §3)
//  - 청크마다 SHA-256(crypto.subtle) 을 보내 서버가 손상을 감지
//  - 네트워크 오류·5xx 는 지수 백오프로 재시도, 409 OFFSET_MISMATCH 는 서버의 received 부터 이어서
//  - 업로드 id 는 localStorage 에 (대상 경로 + 크기 + 수정시각) 키로 저장 → 탭을 닫았다 같은 파일을 다시 올리면 이어서

import { api, ApiError } from './api.js';

const CONCURRENCY = 2;
const MAX_RETRIES = 6;
const RESUME_KEY = 'wd.uploads';

/** @typedef {'queued' | 'uploading' | 'done' | 'error' | 'cancelled'} UploadState */
/**
 * @typedef {{
 *   key: string, name: string, dest: string, size: number, sent: number,
 *   state: UploadState, error?: string, finalPath?: string, startedAt?: number, rate?: number,
 * }} UploadItem
 */

function loadResume() {
  try {
    return JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function saveResume(map) {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(map));
  } catch {}
}
const resumeKey = (dest, file) => `${dest}|${file.size}|${file.lastModified}`;

async function sha256Hex(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

/** 재시도해 볼 만한 오류인가 */
const retryable = (err) => err?.code === 'NETWORK' || err?.status >= 500 || err?.code === 'UPLOAD_BUSY';

class UploadManager {
  constructor() {
    /** @type {Array<UploadItem & { file: File, ctrl: AbortController }>} */
    this.items = [];
    this.listeners = new Set();
    this.completeListeners = new Set();
    this.seq = 0;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 파일 하나가 끝날 때마다 (목록 새로고침용) */
  onComplete(fn) {
    this.completeListeners.add(fn);
    return () => this.completeListeners.delete(fn);
  }

  #emit() {
    const snapshot = this.items.map(({ file: _f, ctrl: _c, ...rest }) => ({ ...rest }));
    for (const fn of this.listeners) fn(snapshot);
  }

  /**
   * @param {Array<{ file: File, dest: string }>} files  dest = 최종 가상 경로 (폴더 업로드면 하위 경로 포함)
   */
  add(files) {
    for (const { file, dest } of files) {
      this.items.push({
        key: `u${++this.seq}`,
        name: file.name.normalize('NFC'),
        dest: dest.normalize('NFC'), // 맥은 NFD 로 준다 (ai.md D12)
        size: file.size,
        sent: 0,
        state: 'queued',
        file,
        ctrl: new AbortController(),
      });
    }
    this.#emit();
    this.#pump();
  }

  cancel(key) {
    const it = this.items.find((i) => i.key === key);
    if (!it || it.state === 'done') return;
    it.ctrl.abort();
    it.state = 'cancelled';
    this.#emit();
    this.#pump();
  }

  retry(key) {
    const it = this.items.find((i) => i.key === key);
    if (!it || (it.state !== 'error' && it.state !== 'cancelled')) return;
    it.state = 'queued';
    it.error = undefined;
    it.ctrl = new AbortController();
    this.#emit();
    this.#pump();
  }

  /** 끝난(완료·취소) 항목 지우기 */
  clearFinished() {
    this.items = this.items.filter((i) => i.state === 'queued' || i.state === 'uploading' || i.state === 'error');
    this.#emit();
  }

  #pump() {
    const running = this.items.filter((i) => i.state === 'uploading').length;
    const next = this.items.filter((i) => i.state === 'queued').slice(0, Math.max(0, CONCURRENCY - running));
    for (const it of next) {
      it.state = 'uploading';
      it.startedAt = Date.now();
      this.#emit();
      this.#run(it)
        .then((finalPath) => {
          it.state = 'done';
          it.sent = it.size;
          it.finalPath = finalPath;
          for (const fn of this.completeListeners) fn(finalPath);
        })
        .catch((err) => {
          if (it.ctrl.signal.aborted) {
            it.state = 'cancelled';
          } else {
            it.state = 'error';
            it.error = err?.code ?? 'UPLOAD_FAILED';
          }
        })
        .finally(() => {
          this.#emit();
          this.#pump();
        });
    }
  }

  async #run(it) {
    const { file, dest, ctrl } = it;
    const signal = ctrl.signal;
    const resume = loadResume();
    const rkey = resumeKey(dest, file);

    // 1) 이어올리기 가능한지 확인, 아니면 새로 만들기
    let id = resume[rkey]?.id;
    let chunkSize = resume[rkey]?.chunkSize;
    let received = 0;
    if (id) {
      try {
        const s = await api.uploads.status(id);
        received = s.received;
      } catch {
        id = undefined;
      }
    }
    if (!id) {
      const c = await api.uploads.create(dest, file.size, file.lastModified || undefined);
      id = c.id;
      chunkSize = c.chunkSize;
      received = c.received;
      const r = loadResume();
      r[rkey] = { id, chunkSize, at: Date.now() };
      saveResume(r);
    }
    const onAbort = () => api.uploads.abort(id).catch(() => {});
    signal.addEventListener('abort', onAbort, { once: true });

    // 2) 청크 전송
    let attempt = 0;
    while (received < file.size) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const end = Math.min(received + chunkSize, file.size);
      const blob = file.slice(received, end);
      try {
        const hash = await sha256Hex(blob);
        const t0 = performance.now();
        const res = await fetch(`/api/files/uploads/${encodeURIComponent(id)}?offset=${received}`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': hash },
          body: blob,
          signal,
        }).catch((e) => {
          if (e?.name === 'AbortError') throw e;
          throw new ApiError(0, 'NETWORK');
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new ApiError(res.status, data.error ?? `HTTP_${res.status}`);
          if (Number.isSafeInteger(data.received)) err.received = data.received;
          throw err;
        }
        const secs = (performance.now() - t0) / 1000;
        it.rate = secs > 0 ? blob.size / secs : undefined;
        received = data.received;
        it.sent = received;
        attempt = 0;
        this.#emit();
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (err?.code === 'OFFSET_MISMATCH' && Number.isSafeInteger(err.received)) {
          received = err.received; // 서버 기준으로 다시 맞춤
          it.sent = received;
          continue;
        }
        if (err?.code === 'UPLOAD_NOT_FOUND') {
          // 서버에서 정리됨 → 기록을 지우고 처음부터
          const r = loadResume();
          delete r[rkey];
          saveResume(r);
          throw err;
        }
        if (!retryable(err) && err?.code !== 'CHUNK_CORRUPT' && err?.code !== 'INCOMPLETE_CHUNK') throw err;
        if (++attempt > MAX_RETRIES) throw err;
        await sleep(Math.min(30_000, 500 * 2 ** attempt), signal);
      }
    }

    // 3) 완료
    signal.removeEventListener('abort', onAbort);
    const done = await api.uploads.complete(id);
    const r = loadResume();
    delete r[rkey];
    saveResume(r);
    return done.path;
  }
}

export const uploads = new UploadManager();

/**
 * 드롭된 항목(파일·폴더)을 { file, dest } 목록으로 펼친다. 폴더는 하위까지 재귀.
 * @param {DataTransfer} dt
 * @param {string} baseDir  올릴 위치(가상 경로)
 */
export async function collectDropped(dt, baseDir) {
  const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
  const out = [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);

  const readAll = (reader) =>
    new Promise((resolve, reject) => {
      const all = [];
      const step = () =>
        reader.readEntries((batch) => {
          if (batch.length === 0) resolve(all);
          else {
            all.push(...batch);
            step();
          }
        }, reject);
      step();
    });

  async function walk(entry, dir) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, dest: join(dir, file.name) });
    } else if (entry.isDirectory) {
      const sub = join(dir, entry.name);
      for (const child of await readAll(entry.createReader())) await walk(child, sub);
    }
  }

  if (entries.length) {
    for (const e of entries) await walk(e, baseDir);
  } else {
    for (const file of dt.files) out.push({ file, dest: join(baseDir, file.name) });
  }
  return out;
}

/** <input type=file webkitdirectory> 결과 → { file, dest } (webkitRelativePath 유지) */
export function collectPicked(fileList, baseDir) {
  const join = (dir, rel) => (dir === '/' ? `/${rel}` : `${dir}/${rel}`);
  return [...fileList].map((file) => ({ file, dest: join(baseDir, file.webkitRelativePath || file.name) }));
}

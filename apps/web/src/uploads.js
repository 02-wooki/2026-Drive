// 업로드 관리자: 큐, 동시 전송, 청크 SHA-256, 재시도, 새로고침 후 이어올리기.
//
// 한 파일 흐름: create → (GET status 로 이어올릴 위치 확인) → PUT 청크 × N → complete
//  - 청크는 서버가 준 chunkSize(기본 32MB) 단위. Cloudflare 요청당 100MB 제한 아래 (ai.md §3)
//  - 청크마다 SHA-256(crypto.subtle) 을 보내 서버가 손상을 감지
//  - 네트워크 오류·5xx 는 지수 백오프로 재시도, 409 OFFSET_MISMATCH 는 서버의 received 부터 이어서
//  - 업로드 id 는 localStorage 에 (대상 경로 + 크기 + 수정시각) 키로 저장 → 탭을 닫았다 같은 파일을 다시 올리면 이어서
//
// 작은 파일(BATCH_FILE_MAX 이하, 데스크탑 대상)은 여러 개를 묶어 요청 하나로 보낸다 (POST /uploads/batch).
//  - 파일마다 요청 3번이면 작은 파일이 많을 때 왕복 시간이 대부분이라서. 이어올리기는 없다(끊기면 묶음째 다시).
//  - 매니페스트 해시 + 파일별 해시로 서버가 검증하고, 파일마다 임시 파일 → 제자리로 옮김. 결과도 파일마다.
//  - 같은 묶음 id 로 재시도하면 서버가 처음 결과를 돌려준다 → 응답만 잃어버린 경우에도 두 번 저장되지 않는다.

import { api, ApiError, reportAuthLost } from './api.js';

const CONCURRENCY = 2; // 동시에 진행하는 작업 수 (큰 파일 하나 또는 묶음 하나가 작업 하나)
const MiB = 1024 * 1024;
const BATCH_FILE_MAX = 4 * MiB; // 이 크기 이하만 묶는다
const BATCH_MAX_BYTES = 30 * MiB; // 요청 상한(32MB + 1MB) 아래, 매니페스트 여유
const BATCH_MAX_FILES = 200;
const MAX_RETRIES = 6;
const RESUME_KEY = 'wd.uploads';

/** @typedef {'queued' | 'uploading' | 'done' | 'error' | 'cancelled'} UploadState */
/** @typedef {'desktop' | 'buffer'} UploadTarget  buffer = 데스크탑이 꺼져 있어 파이에 임시 보관 (D3) */
/**
 * @typedef {{
 *   key: string, name: string, dest: string, size: number, sent: number,
 *   state: UploadState, error?: string, finalPath?: string, startedAt?: number, rate?: number, target: UploadTarget,
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
// 충돌 처리 방식은 업로드를 만들 때 정해지므로 키에 넣는다 (같은 파일을 다른 방식으로 다시 올리면 새 업로드)
const resumeKey = (dest, file, target, onConflict) =>
  `${target === 'buffer' ? 'buffer:' : ''}${onConflict ? `${onConflict}:` : ''}${dest}|${file.size}|${file.lastModified}`;

async function sha256Hex(blob) {
  return bytesSha256Hex(await blob.arrayBuffer());
}
async function bytesSha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const randomId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, '-').replace(/\//g, '_');
const batchable = (it) => it.target === 'desktop' && it.size <= BATCH_FILE_MAX;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

/**
 * 업로드 요청. fetch 는 보낸 바이트 수를 알려주지 않아 XHR 을 쓴다 → 조각 도중에도 진행률·속도가 움직인다.
 * (보낸 바이트는 Cloudflare 까지 기준. 다 보낸 뒤 응답이 오기까지 잠깐 더 걸릴 수 있다)
 * @returns {Promise<any>} 응답 JSON. 실패면 ApiError(+received), 취소면 AbortError
 */
function sendWithProgress(method, url, body, headers, signal, onProgress) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const done = (fn) => {
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    xhr.onabort = () => done(() => reject(new DOMException('aborted', 'AbortError')));
    xhr.onerror = () => done(() => reject(new ApiError(0, 'NETWORK')));
    xhr.ontimeout = xhr.onerror;
    xhr.onload = () =>
      done(() => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        reportAuthLost(data.error);
        const err = new ApiError(xhr.status, data.error ?? `HTTP_${xhr.status}`);
        if (Number.isSafeInteger(data.received)) err.received = data.received;
        reject(err);
      });
    xhr.send(body);
  });
}

const RATE_WINDOW_MS = 3000;

/** 재시도해 볼 만한 오류인가 */
const retryable = (err) => err?.code === 'NETWORK' || err?.status >= 500 || err?.code === 'UPLOAD_BUSY';

class UploadManager {
  constructor() {
    /** @type {Array<UploadItem & { file: File, ctrl: AbortController }>} */
    this.items = [];
    this.listeners = new Set();
    this.completeListeners = new Set();
    this.seq = 0;
    this.running = 0; // 진행 중인 작업 수
    this.emitTimer = null;
    this.preparing = null;
    this.prepareListeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.items.map(({ file: _f, ctrl: _c, ...rest }) => ({ ...rest })));
    return () => this.listeners.delete(fn);
  }

  /** 파일 하나가 끝날 때마다 (목록 새로고침용) */
  onComplete(fn) {
    this.completeListeners.add(fn);
    return () => this.completeListeners.delete(fn);
  }

  /**
   * 지금 전체 업로드 속도(바이트/초): 최근 3초 동안 실제로 보낸 바이트(XHR 진행 이벤트) ÷ 시간.
   * 큰 파일 조각·작은 파일 묶음을 동시에 보내도 모두 합친 값이다.
   */
  currentRate() {
    const now = performance.now();
    const samples = this.#samples;
    while (samples.length > 1 && now - samples[1].t > RATE_WINDOW_MS) samples.shift();
    if (samples.length === 0 || now - samples.at(-1).t > RATE_WINDOW_MS) return 0; // 한동안 보낸 게 없음
    const first = samples[0];
    const secs = (now - first.t) / 1000;
    return secs > 0.3 ? (this.#sentBytes - first.total) / secs : 0;
  }

  #sentBytes = 0; // 지금까지 보낸 바이트 (재전송 포함, 늘어나기만 함)
  #samples = []; // { t, total } — 0.2초에 하나

  #countSent(delta) {
    if (!(delta > 0)) return;
    this.#sentBytes += delta;
    const t = performance.now();
    const last = this.#samples.at(-1);
    if (!last || t - last.t >= 200) this.#samples.push({ t, total: this.#sentBytes });
    else last.total = this.#sentBytes;
  }

  /** 요청 하나의 진행 이벤트(누적 loaded) → 새로 보낸 만큼만 센다 */
  #progressCounter(onLoaded) {
    let prev = 0;
    return (loaded) => {
      this.#countSent(loaded - prev);
      prev = Math.max(prev, loaded);
      onLoaded(loaded);
      this.#emit();
    };
  }

  // 파일이 몇만 개일 때 진행 상황이 바뀔 때마다 전체를 복사·다시 그리지 않도록 0.1초에 한 번으로 모은다
  #emit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const snapshot = this.items.map(({ file: _f, ctrl: _c, ...rest }) => ({ ...rest }));
      for (const fn of this.listeners) fn(snapshot);
    }, 100);
  }

  /** 올리기 전 준비(폴더 펼치기·중복 확인) 진행 문구. null 이면 끝. 업로드 패널이 보여준다. */
  setPreparing(text) {
    this.preparing = text;
    for (const fn of this.prepareListeners) fn(text);
  }

  onPreparing(fn) {
    this.prepareListeners.add(fn);
    fn(this.preparing);
    return () => this.prepareListeners.delete(fn);
  }

  /**
   * @param {Array<{ file: File, dest: string, onConflict?: 'replace' | 'fail' }>} files
   *   dest = 최종 가상 경로 (폴더 업로드면 하위 경로 포함). onConflict 는 데스크탑 업로드에만 (planUploads 참고)
   * @param {UploadTarget} [target]
   */
  add(files, target = 'desktop') {
    for (const { file, dest, onConflict } of files) {
      this.items.push({
        key: `u${++this.seq}`,
        name: file.name.normalize('NFC'),
        dest: dest.normalize('NFC'), // 맥은 NFD 로 준다 (ai.md D12)
        size: file.size,
        sent: 0,
        state: 'queued',
        target,
        onConflict: target === 'desktop' ? onConflict : undefined,
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

  /** 대기 중·올리는 중인 항목 전부 취소 (각각 '다시 시도'로 되살릴 수 있다) */
  cancelAll() {
    let changed = false;
    for (const it of this.items) {
      if (it.state !== 'queued' && it.state !== 'uploading') continue;
      it.ctrl.abort();
      it.state = 'cancelled';
      changed = true;
    }
    if (changed) this.#emit();
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

  /** 세션 잠금·만료(LOGIN_REQUIRED)로 멈춘 업로드를 다시 시작 — 이미 받은 위치부터 이어진다 */
  resumeAfterAuth() {
    for (const it of this.items) if (it.state === 'error' && it.error === 'LOGIN_REQUIRED') this.retry(it.key);
  }

  /** 끝난(완료·취소) 항목 지우기 */
  clearFinished() {
    this.items = this.items.filter((i) => i.state === 'queued' || i.state === 'uploading' || i.state === 'error');
    this.#emit();
  }

  #pump() {
    while (this.running < CONCURRENCY) {
      const first = this.items.find((i) => i.state === 'queued');
      if (!first) return;
      const group = batchable(first) ? this.#takeBatch() : [first];
      for (const it of group) {
        it.state = 'uploading';
        it.startedAt = Date.now();
        it.batched = batchable(first); // 묶음은 파일별 진행률이 없다
      }
      this.running++;
      this.#emit();
      (batchable(first) ? this.#runBatch(group) : this.#runOne(first)).finally(() => {
        this.running--;
        this.#emit();
        this.#pump();
      });
    }
  }

  /** 대기 중인 작은 파일을 앞에서부터 상한까지 */
  #takeBatch() {
    const group = [];
    let bytes = 0;
    for (const it of this.items) {
      if (it.state !== 'queued' || !batchable(it)) continue;
      if (group.length && (group.length >= BATCH_MAX_FILES || bytes + it.size > BATCH_MAX_BYTES)) break;
      group.push(it);
      bytes += it.size;
    }
    return group;
  }

  #done(it, finalPath, replaced) {
    it.state = 'done';
    it.sent = it.size;
    it.finalPath = finalPath;
    it.replaced = Boolean(replaced);
    for (const fn of this.completeListeners) fn(finalPath, it.target);
  }

  async #runOne(it) {
    try {
      const { path: finalPath, replaced } = await this.#run(it);
      this.#done(it, finalPath, replaced);
    } catch (err) {
      if (it.ctrl.signal.aborted) {
        it.state = 'cancelled';
      } else {
        it.state = 'error';
        it.error = err?.code ?? 'UPLOAD_FAILED';
      }
    }
  }

  /** 작은 파일 묶음. 하나를 취소하면 묶음 요청을 끊고 나머지는 다시 대기열로. */
  async #runBatch(group) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    for (const it of group) it.ctrl.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const sending = [];
      const parts = [];
      for (const it of group) {
        if (it.ctrl.signal.aborted) continue;
        try {
          parts.push(await it.file.arrayBuffer());
          sending.push(it);
        } catch {
          it.state = 'error'; // 올리는 사이 원본이 지워졌거나 옮겨짐
          it.error = 'FILE_UNREADABLE';
        }
      }
      if (!sending.length) return;
      const files = [];
      for (let i = 0; i < sending.length; i++) {
        const it = sending[i];
        files.push({
          path: it.dest,
          size: parts[i].byteLength,
          sha256: await bytesSha256Hex(parts[i]),
          ...(it.file.lastModified ? { mtimeMs: it.file.lastModified } : {}),
          ...(it.onConflict ? { onConflict: it.onConflict } : {}),
        });
      }
      const manifest = new TextEncoder().encode(JSON.stringify({ files }));
      const q = new URLSearchParams({ id: randomId(), manifestBytes: String(manifest.byteLength), manifestSha256: await bytesSha256Hex(manifest) });
      const body = new Blob([manifest, ...parts]);
      const t0 = performance.now();
      // 묶음은 파일별 진행률이 없으니 보낸 비율만큼 나눠서 보여준다
      const onLoaded = (loaded) => {
        const f = body.size ? Math.min(1, loaded / body.size) : 1;
        for (const it of sending) if (it.state === 'uploading') it.sent = Math.floor(it.size * f);
      };
      const results = await this.#sendBatch(`${api.uploads.base('desktop')}/batch?${q}`, body, ctrl.signal, onLoaded);
      const secs = (performance.now() - t0) / 1000;
      sending.forEach((it, i) => {
        const r = results[i];
        if (it.state !== 'uploading') return;
        if (secs > 0) it.rate = body.size / secs;
        if (!r) {
          it.state = 'error';
          it.error = 'AGENT_BAD_RESPONSE';
        } else if (r.error) {
          it.state = 'error';
          it.error = r.error;
        } else {
          this.#done(it, r.finalPath, r.replaced);
        }
      });
    } catch (err) {
      for (const it of group) {
        if (it.state !== 'uploading') continue; // 취소된 것(cancel 이 이미 표시)
        if (ctrl.signal.aborted) {
          it.state = 'queued'; // 같은 묶음의 다른 파일이 취소됨 → 다시 대기
        } else {
          it.state = 'error';
          it.error = err?.code ?? 'UPLOAD_FAILED';
        }
      }
    } finally {
      for (const it of group) it.ctrl.signal.removeEventListener('abort', onAbort);
    }
  }

  async #sendBatch(url, body, signal, onLoaded) {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await sendWithProgress('POST', url, body, { 'Content-Type': 'application/octet-stream' }, signal, this.#progressCounter(onLoaded));
        if (!Array.isArray(data.results)) throw new ApiError(502, 'AGENT_BAD_RESPONSE');
        return data.results;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        onLoaded(0);
        // 같은 id 로 재시도 → 이미 처리됐으면 서버가 그 결과를 준다. 처리 중이면 잠시 뒤 다시.
        if (!(retryable(err) || err?.code === 'BATCH_IN_PROGRESS') || attempt >= MAX_RETRIES) throw err;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt), signal);
      }
    }
  }

  async #run(it) {
    const { file, dest, ctrl, target, onConflict } = it;
    const signal = ctrl.signal;
    const resume = loadResume();
    const rkey = resumeKey(dest, file, target, onConflict);
    const base = api.uploads.base(target);

    // 1) 이어올리기 가능한지 확인, 아니면 새로 만들기
    let id = resume[rkey]?.id;
    let chunkSize = resume[rkey]?.chunkSize;
    let received = 0;
    if (id) {
      try {
        const s = await api.uploads.status(id, target);
        received = s.received;
      } catch {
        id = undefined;
      }
    }
    if (!id) {
      const c = await api.uploads.create(dest, file.size, file.lastModified || undefined, target, onConflict);
      id = c.id;
      chunkSize = c.chunkSize;
      received = c.received;
      const r = loadResume();
      r[rkey] = { id, chunkSize, at: Date.now() };
      saveResume(r);
    }
    const onAbort = () => api.uploads.abort(id, target).catch(() => {});
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
        const start = received;
        const data = await sendWithProgress(
          'PUT',
          `${base}/${encodeURIComponent(id)}?offset=${received}`,
          blob,
          { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': hash },
          signal,
          this.#progressCounter((loaded) => {
            it.sent = start + loaded; // 조각 도중에도 움직인다
            const secs = (performance.now() - t0) / 1000;
            if (secs > 0.3) it.rate = loaded / secs;
          }),
        );
        received = data.received;
        it.sent = received;
        attempt = 0;
        this.#emit();
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        it.sent = received; // 조각 도중 실패 → 서버가 받은 데까지로 되돌림
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
    const done = await api.uploads.complete(id, target);
    const r = loadResume();
    delete r[rkey];
    saveResume(r);
    return done;
  }
}

export const uploads = new UploadManager();

const CHECK_BATCH = 500; // gateway JSON 본문 256KB 안쪽
const CHECK_PARALLEL = 4;

/** 경로 목록 → 이미 있는 것만 Map. 500개씩, 동시에 4개 요청 */
async function checkPaths(paths, onProgress) {
  const found = new Map();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < paths.length) {
      const slice = paths.slice(next, (next += CHECK_BATCH));
      const { conflicts } = await api.uploads.check(slice);
      for (const { path, ...rest } of conflicts) found.set(path, rest);
      done += slice.length;
      onProgress?.(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_PARALLEL, Math.ceil(paths.length / CHECK_BATCH)) }, worker));
  return found;
}

/**
 * 올릴 위치에 이미 있는 항목 찾기 (데스크탑만). dest 는 NFC 로 맞춰 서버가 저장할 이름과 비교한다.
 * 1) 모든 dest 의 공통 폴더 바로 아래 항목(올리는 폴더·파일 자체)만 먼저 확인 — 없으면 그 아래는 전부 새 파일
 * 2) 이미 있는 폴더 아래 파일만 하나하나 확인
 * → 새 폴더를 통째로 올리면 요청 한 번으로 끝난다.
 * @param {Array<{ file: File, dest: string }>} list
 * @param {(checked: number, total: number) => void} [onProgress]
 * @returns {Promise<Map<string, { type: 'file' | 'dir' | 'other', size: number | null, mtimeMs: number | null }>>} NFC dest → 기존 항목
 */
export async function findConflicts(list, onProgress) {
  const dests = [...new Set(list.map((x) => x.dest.normalize('NFC')))];
  if (!dests.length) return new Map();
  // 공통 폴더 (마지막 세그먼트는 파일 이름이라 제외)
  let common = dests[0].split('/').slice(0, -1);
  for (const d of dests) {
    const segs = d.split('/');
    let i = 0;
    while (i < common.length && i < segs.length - 1 && common[i] === segs[i]) i++;
    common = common.slice(0, i);
  }
  const depth = common.length; // '/a/b' → ['', 'a', 'b']
  const topOf = (d) => d.split('/').slice(0, depth + 1).join('/');
  const tops = [...new Set(dests.map(topOf))];
  const topFound = await checkPaths(tops);
  const found = new Map();
  const rest = [];
  for (const d of dests) {
    const top = topOf(d);
    if (d === top) {
      if (topFound.has(d)) found.set(d, topFound.get(d));
    } else if (topFound.has(top)) {
      rest.push(d); // 이미 있는 폴더(또는 같은 이름의 무언가) 아래 → 하나하나 확인
    }
  }
  onProgress?.(dests.length - rest.length, dests.length);
  if (rest.length) {
    const more = await checkPaths(rest, (n) => onProgress?.(dests.length - rest.length + n, dests.length));
    for (const [k, v] of more) found.set(k, v);
  }
  return found;
}

/**
 * 드롭된 항목(파일·폴더)을 { file, dest } 목록으로 펼친다. 폴더는 하위까지 재귀.
 * @param {DataTransfer} dt
 * @param {string} baseDir  올릴 위치(가상 경로)
 * @param {(found: number) => void} [onProgress]  찾은 파일 수 (가끔씩)
 */
export async function collectDropped(dt, baseDir, onProgress) {
  const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((file) => ({ file, dest: join(baseDir, file.name) }));

  // 파일·폴더 읽기를 한꺼번에 여러 개 진행한다(하나씩 기다리지 않음). 상한을 두는 건 몇만 개 요청을
  // 한 번에 걸면 브라우저 안에서 줄 서는 건 같고 메모리만 늘기 때문.
  const limit = concurrency(64);
  let found = 0;
  let lastReport = 0;
  const report = () => {
    found++;
    const t = performance.now();
    if (t - lastReport > 150) {
      lastReport = t;
      onProgress?.(found);
    }
  };

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

  /** @returns {Promise<Array<{ file: File, dest: string }>>} 폴더 안 순서 유지 */
  async function walk(entry, dir) {
    if (entry.isFile) {
      const file = await limit(() => new Promise((res, rej) => entry.file(res, rej)));
      report();
      return [{ file, dest: join(dir, file.name) }];
    }
    if (entry.isDirectory) {
      const sub = join(dir, entry.name);
      const children = await limit(() => readAll(entry.createReader()));
      return (await Promise.all(children.map((c) => walk(c, sub)))).flat();
    }
    return [];
  }

  const out = (await Promise.all(entries.map((e) => walk(e, baseDir)))).flat();
  onProgress?.(found);
  return out;
}

/** 동시에 n 개까지만 실행 */
function concurrency(n) {
  let active = 0;
  let head = 0; // shift() 는 몇만 개짜리 배열에서 매번 전체를 옮기므로 위치만 넘긴다
  const queue = [];
  const next = () => {
    if (active >= n || head >= queue.length) return;
    active++;
    const { fn, resolve, reject } = queue[head];
    queue[head++] = null;
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/** <input type=file webkitdirectory> 결과 → { file, dest } (webkitRelativePath 유지) */
export function collectPicked(fileList, baseDir) {
  const join = (dir, rel) => (dir === '/' ? `/${rel}` : `${dir}/${rel}`);
  return [...fileList].map((file) => ({ file, dest: join(baseDir, file.webkitRelativePath || file.name) }));
}

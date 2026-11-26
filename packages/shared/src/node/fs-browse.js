// 읽기 전용 탐색: 폴더 목록·메타데이터. agent(D:\Drive)와 gateway(데모 폴더)가 같은 로직을 쓴다.
// 모든 경로는 resolveInRootReal 을 거친다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveInRootReal } from './fs-path.js';
import { parseVirtualPath, formatVirtualPath, checkSegment, PathError } from '../virtual-path.js';

/** 경로 형식은 맞지만 대상 상태가 요청과 맞지 않을 때. status 는 HTTP 매핑용. */
export class BrowseError extends Error {
  /** @param {string} code @param {number} status */
  constructor(code, status) {
    super(code);
    this.name = 'BrowseError';
    this.code = code;
    this.status = status;
  }
}

/** 맥·윈도우가 만드는 부수 파일. 숨김 표시만 하고 목록에서 빼지는 않는다(판단은 UI). */
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const isHidden = (name) => name.startsWith('.') || JUNK_NAMES.has(name);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

function typeOf(stat) {
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'other';
}

/**
 * @typedef {{
 *   name: string, path: string | null, type: 'dir' | 'file' | 'other',
 *   size: number | null, mtimeMs: number | null,
 *   link: boolean, hidden: boolean, addressable: boolean
 * }} Entry
 * addressable=false: 이름이 가상 경로 규칙에 맞지 않아(예: 예약어) 웹에서 열 수 없는 항목. path 는 null.
 */

/**
 * 폴더 안 항목 하나 설명. 링크는 대상이 루트 안일 때만 대상의 종류로 보여주고, 밖이면 'other'.
 * @returns {Promise<Entry | null>} 그 사이 사라졌으면 null
 */
async function describeChild(root, parentSegs, parentReal, name) {
  const addressable = checkSegment(name) === null;
  const vpath = addressable ? formatVirtualPath([...parentSegs, name]) : null;
  const base = { name, path: vpath, link: false, hidden: isHidden(name), addressable };

  let lst;
  try {
    lst = await fsp.lstat(path.join(parentReal, name));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { ...base, type: 'other', size: null, mtimeMs: null };
  }

  if (!lst.isSymbolicLink()) {
    return { ...base, type: typeOf(lst), size: lst.isFile() ? lst.size : null, mtimeMs: lst.mtimeMs };
  }

  // 링크·정션: 루트 안을 가리키면 대상처럼, 아니면 열 수 없는 항목으로
  const linkInfo = { ...base, link: true, type: 'other', size: null, mtimeMs: lst.mtimeMs };
  if (!addressable) return linkInfo;
  try {
    const { realPath, exists } = await resolveInRootReal(root, vpath);
    if (!exists) return linkInfo;
    const st = await fsp.stat(realPath);
    return { ...linkInfo, type: typeOf(st), size: st.isFile() ? st.size : null, mtimeMs: st.mtimeMs };
  } catch (err) {
    if (err instanceof PathError || err.code === 'ENOENT') return linkInfo;
    throw err;
  }
}

/** @returns {Promise<{ path: string, entries: Entry[] }>} */
export async function listDirectory(root, vpath) {
  const segs = parseVirtualPath(vpath);
  const { realPath, exists } = await resolveInRootReal(root, vpath);
  if (!exists) throw new BrowseError('NOT_FOUND', 404);
  const st = await fsp.stat(realPath);
  if (!st.isDirectory()) throw new BrowseError('NOT_A_DIRECTORY', 400);

  const names = await fsp.readdir(realPath);
  const entries = await mapLimit(names, 32, (name) => describeChild(root, segs, realPath, name));
  return { path: formatVirtualPath(segs), entries: entries.filter(Boolean) };
}

/**
 * realPath 는 서버 내부용. 응답에 실을 때는 빼야 한다.
 * @returns {Promise<Entry & { realPath: string }>}
 */
export async function statPath(root, vpath) {
  const segs = parseVirtualPath(vpath);
  const { realPath, exists } = await resolveInRootReal(root, vpath);
  if (!exists) throw new BrowseError('NOT_FOUND', 404);
  const st = await fsp.stat(realPath);
  const name = segs.at(-1) ?? '';
  return {
    name,
    path: formatVirtualPath(segs),
    type: typeOf(st),
    size: st.isFile() ? st.size : null,
    mtimeMs: st.mtimeMs,
    link: false,
    hidden: isHidden(name),
    addressable: true,
    realPath,
  };
}

/** RFC 6266 / 5987 Content-Disposition. 한글 파일명은 filename* 로, filename 은 ASCII 대체. */
export function contentDisposition(type, filename) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

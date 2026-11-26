// 쓰기 작업: 새 폴더, 이름 변경, 이동, 휴지통, 영구 삭제. agent(D:\Drive)용이지만 루트를 인자로 받는 범용 코드.
//
// 원칙
//  - 대상 "항목 자체"에 작업한다. 부모 폴더는 resolveInRootReal 로 링크 탈출을 검사하고,
//    항목은 lstat 으로 다룬다 → 링크·정션을 옮기거나 지우면 링크만 움직이고 링크 대상은 건드리지 않는다.
//  - 루트 자체는 이름 변경·이동·삭제 불가.
//  - 휴지통은 루트 안의 시스템 폴더(SYSTEM_DIR_NAME/trash)에 둔다 (ai.md D15) → 같은 드라이브라 rename 한 번으로 끝난다.
//    시스템 폴더 경로는 호출자(agent 라우트)가 assertNotReserved 로 막는다.
//  - 영구 삭제는 fs.rm 대신 직접 구현한 safeRemove: 링크를 만나면 링크만 지우고 절대 따라 들어가지 않는다.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveInRootReal } from './fs-path.js';
import { BrowseError } from './fs-browse.js';
import {
  parseVirtualPath,
  formatVirtualPath,
  normalizeNewName,
  numberedName,
  isAncestorOrSelf,
} from '../virtual-path.js';

const MAX_NUMBERED = 1000;

async function lstatOrNull(p) {
  try {
    return await fsp.lstat(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** 존재하는 폴더의 실제 경로. 없거나 폴더가 아니면 BrowseError. */
async function realDir(root, vpath) {
  const { realPath, exists } = await resolveInRootReal(root, vpath);
  if (!exists) throw new BrowseError('NOT_FOUND', 404);
  const st = await fsp.stat(realPath);
  if (!st.isDirectory()) throw new BrowseError('NOT_A_DIRECTORY', 400);
  return realPath;
}

/**
 * 가상 경로의 항목 자체(링크면 링크) 위치.
 * @returns {Promise<{ segs: string[], name: string, parentVpath: string, parentReal: string, entryPath: string, stat: import('node:fs').Stats }>}
 */
async function locateEntry(root, vpath) {
  const segs = parseVirtualPath(vpath);
  if (segs.length === 0) throw new BrowseError('ROOT_IS_READONLY', 400);
  const parentVpath = formatVirtualPath(segs.slice(0, -1));
  const parentReal = await realDir(root, parentVpath);
  const name = segs.at(-1);
  const entryPath = path.join(parentReal, name);
  const stat = await lstatOrNull(entryPath);
  if (!stat) throw new BrowseError('NOT_FOUND', 404);
  return { segs, name, parentVpath, parentReal, entryPath, stat };
}

/** dir 안에서 name 이 비어 있으면 그대로, 아니면 "name (n)" 중 빈 이름. */
export async function availableName(dirReal, name, { isDir = false } = {}) {
  if (!(await lstatOrNull(path.join(dirReal, name)))) return name;
  for (let n = 1; n <= MAX_NUMBERED; n++) {
    const candidate = numberedName(name, n, { isDir });
    if (!(await lstatOrNull(path.join(dirReal, candidate)))) return candidate;
  }
  throw new BrowseError('TOO_MANY_CONFLICTS', 409);
}

/** 대소문자만 다른 같은 항목인가 (윈도우에서 "a.txt" → "A.txt" 이름 변경 허용용) */
async function isSameEntry(a, b) {
  const [sa, sb] = await Promise.all([lstatOrNull(a), lstatOrNull(b)]);
  return Boolean(sa && sb && sa.ino === sb.ino && sa.dev === sb.dev && sa.ino !== 0);
}

// ── 새 폴더 ────────────────────────────────────────────────

/**
 * @param {string} root
 * @param {string} parentVpath
 * @param {string} name  NFC 정규화된다
 * @param {{ onConflict?: 'fail' | 'rename' }} [opts]
 * @returns {Promise<string>} 만든 폴더의 가상 경로
 */
export async function makeDirectory(root, parentVpath, name, { onConflict = 'fail' } = {}) {
  const parentReal = await realDir(root, parentVpath);
  let finalName = normalizeNewName(name);
  if (await lstatOrNull(path.join(parentReal, finalName))) {
    if (onConflict !== 'rename') throw new BrowseError('ALREADY_EXISTS', 409);
    finalName = await availableName(parentReal, finalName, { isDir: true });
  }
  await fsp.mkdir(path.join(parentReal, finalName));
  return formatVirtualPath([...parseVirtualPath(parentVpath), finalName]);
}

/**
 * 폴더를 중간 경로까지 만든다 (폴더 업로드용). 각 단계가 루트 안인지 확인한다.
 * @returns {Promise<string>} 실제 경로
 */
export async function ensureDirectory(root, vpath) {
  const segs = parseVirtualPath(vpath);
  for (let i = 1; i <= segs.length; i++) {
    const sub = formatVirtualPath(segs.slice(0, i));
    const { realPath, exists } = await resolveInRootReal(root, sub);
    if (!exists) {
      try {
        await fsp.mkdir(realPath);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err; // 동시 업로드끼리 경쟁
      }
    }
  }
  return realDir(root, vpath);
}

// ── 이름 변경 ──────────────────────────────────────────────

/** @returns {Promise<string>} 새 가상 경로 */
export async function renameEntry(root, vpath, newName) {
  const { segs, name, parentReal, entryPath } = await locateEntry(root, vpath);
  const finalName = normalizeNewName(newName);
  if (finalName === name) return formatVirtualPath(segs);
  const target = path.join(parentReal, finalName);
  if ((await lstatOrNull(target)) && !(await isSameEntry(entryPath, target))) {
    throw new BrowseError('ALREADY_EXISTS', 409);
  }
  await fsp.rename(entryPath, target);
  return formatVirtualPath([...segs.slice(0, -1), finalName]);
}

// ── 이동 ───────────────────────────────────────────────────

/**
 * 항목 하나를 폴더로 이동.
 * @param {{ onConflict?: 'fail' | 'rename' }} [opts]
 * @returns {Promise<string>} 새 가상 경로
 */
export async function moveEntry(root, vpath, toDirVpath, { onConflict = 'fail' } = {}) {
  const src = await locateEntry(root, vpath);
  const destSegs = parseVirtualPath(toDirVpath);
  if (formatVirtualPath(destSegs) === src.parentVpath) throw new BrowseError('SAME_LOCATION', 400);
  if (isAncestorOrSelf(vpath, toDirVpath)) throw new BrowseError('MOVE_INTO_SELF', 400);
  const destReal = await realDir(root, toDirVpath);

  let finalName = src.name;
  if (await lstatOrNull(path.join(destReal, finalName))) {
    if (onConflict !== 'rename') throw new BrowseError('ALREADY_EXISTS', 409);
    finalName = await availableName(destReal, finalName, { isDir: src.stat.isDirectory() });
  }
  try {
    await fsp.rename(src.entryPath, path.join(destReal, finalName));
  } catch (err) {
    if (err.code === 'EXDEV') throw new BrowseError('CROSS_DEVICE', 400);
    throw err;
  }
  return formatVirtualPath([...destSegs, finalName]);
}

// ── 휴지통 ─────────────────────────────────────────────────

const TRASH_ID_RE = /^[0-9]{13}-[0-9a-f]{12}$/;

function trashPaths(trashRoot, id) {
  if (!TRASH_ID_RE.test(id)) throw new BrowseError('NOT_FOUND', 404);
  const dir = path.join(trashRoot, id);
  return { dir, meta: path.join(dir, 'meta.json'), data: path.join(dir, 'data') };
}

/**
 * 휴지통으로 이동. trashRoot/<id>/data/<원래이름> + meta.json
 * @returns {Promise<{ id: string }>}
 */
export async function trashEntry(root, trashRoot, vpath, { now = Date.now() } = {}) {
  const src = await locateEntry(root, vpath);
  const id = `${now}-${randomBytes(6).toString('hex')}`;
  const { dir, meta, data } = trashPaths(trashRoot, id);
  await fsp.mkdir(data, { recursive: true });
  const meta0 = {
    id,
    name: src.name,
    originalPath: formatVirtualPath(src.segs),
    type: src.stat.isDirectory() ? 'dir' : src.stat.isFile() ? 'file' : 'other',
    size: src.stat.isFile() ? src.stat.size : null,
    deletedAt: now,
  };
  await fsp.writeFile(meta, JSON.stringify(meta0));
  try {
    await fsp.rename(src.entryPath, path.join(data, src.name));
  } catch (err) {
    await safeRemove(dir).catch(() => {});
    if (err.code === 'EXDEV') throw new BrowseError('CROSS_DEVICE', 500);
    throw err;
  }
  return { id };
}

/** @returns {Promise<Array<{ id: string, name: string, originalPath: string, type: string, size: number | null, deletedAt: number }>>} */
export async function listTrash(trashRoot) {
  let ids;
  try {
    ids = await fsp.readdir(trashRoot);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const items = [];
  for (const id of ids) {
    if (!TRASH_ID_RE.test(id)) continue;
    try {
      items.push(JSON.parse(await fsp.readFile(trashPaths(trashRoot, id).meta, 'utf8')));
    } catch {
      /* 반쯤 만들어진 항목은 건너뜀 */
    }
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * 원래 위치로 복원. 원래 폴더가 없으면 다시 만들고, 같은 이름이 있으면 "이름 (1)".
 * @returns {Promise<string>} 복원된 가상 경로
 */
export async function restoreTrash(root, trashRoot, id) {
  const { dir, meta, data } = trashPaths(trashRoot, id);
  let info;
  try {
    info = JSON.parse(await fsp.readFile(meta, 'utf8'));
  } catch {
    throw new BrowseError('NOT_FOUND', 404);
  }
  const segs = parseVirtualPath(info.originalPath);
  const parentVpath = formatVirtualPath(segs.slice(0, -1));
  const parentReal = await ensureDirectory(root, parentVpath);
  const src = path.join(data, info.name);
  const st = await lstatOrNull(src);
  if (!st) throw new BrowseError('NOT_FOUND', 404);
  const finalName = await availableName(parentReal, info.name, { isDir: st.isDirectory() });
  await fsp.rename(src, path.join(parentReal, finalName));
  await safeRemove(dir);
  return formatVirtualPath([...segs.slice(0, -1), finalName]);
}

/** 휴지통 항목 영구 삭제 */
export async function deleteTrash(trashRoot, id) {
  const { dir } = trashPaths(trashRoot, id);
  if (!(await lstatOrNull(dir))) throw new BrowseError('NOT_FOUND', 404);
  await safeRemove(dir);
}

/**
 * 재귀 삭제. 링크(심볼릭·정션)를 만나면 링크만 지우고 절대 따라 들어가지 않는다.
 * (fs.rm 의 윈도우 정션 처리에 기대지 않으려고 직접 구현)
 */
export async function safeRemove(p) {
  const st = await lstatOrNull(p);
  if (!st) return;
  if (st.isSymbolicLink()) {
    try {
      await fsp.unlink(p);
    } catch (err) {
      // 윈도우 디렉터리 정션은 rmdir 로 지운다(대상은 건드리지 않음)
      if (err.code === 'EPERM' || err.code === 'EISDIR') await fsp.rmdir(p);
      else throw err;
    }
    return;
  }
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(p)) await safeRemove(path.join(p, name));
    await fsp.rmdir(p);
    return;
  }
  await fsp.unlink(p);
}

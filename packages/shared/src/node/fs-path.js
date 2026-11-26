// 가상 경로 → 실제 디스크 경로 변환과 루트 탈출 방어. gateway(리눅스)·agent(윈도우) 공용.
//
// 모든 파일 API는 반드시 이 모듈을 거친다 (ai.md §6).
//  1) resolveInRoot      : 문자열 수준 검증 + 루트 포함 검사 (동기, I/O 없음)
//  2) resolveInRootReal  : 1) + 심볼릭 링크·정션을 따라간 실제 위치도 루트 안인지 검사 (비동기)
// 실제 파일 작업 직전에는 2)를 쓴다.
//
// 한계: 검사와 사용 사이의 경쟁(TOCTOU)은 막지 못한다. 루트 안에 링크를 만들 수 있는 주체는
// 오너뿐이고 웹 API로는 링크를 만들 수 없으므로 허용 가능한 위험으로 본다.

import path from 'node:path';
import fsp from 'node:fs/promises';
import { parseVirtualPath, PathError } from '../virtual-path.js';

/**
 * target 이 root 자신이거나 그 안에 있는지. 둘 다 같은 pathImpl 기준의 절대경로여야 한다.
 * win32 의 path.relative 는 대소문자를 무시하므로 "D:\drive" 와 "D:\Drive" 를 같게 본다.
 */
export function isInside(root, target, pathImpl = path) {
  const rel = pathImpl.relative(root, target);
  if (rel === '') return true;
  if (pathImpl.isAbsolute(rel)) return false; // 다른 드라이브
  return rel !== '..' && !rel.startsWith('..' + pathImpl.sep);
}

function assertInside(root, target, pathImpl) {
  if (!isInside(root, target, pathImpl)) throw new PathError('OUTSIDE_ROOT');
}

function assertRoot(root, pathImpl) {
  if (typeof root !== 'string' || !pathImpl.isAbsolute(root)) {
    throw new Error(`root must be an absolute path: ${root}`);
  }
}

/**
 * 가상 경로를 root 아래의 절대경로로 변환한다. I/O 없음.
 * @param {string} root      예: 'D:\\Drive', '/var/lib/wooki-drive/demo'
 * @param {string} vpath     예: '/사진/a.jpg'
 * @param {{ pathImpl?: typeof path }} [opts]  테스트에서 path.win32 / path.posix 지정용
 * @returns {string}
 */
export function resolveInRoot(root, vpath, { pathImpl = path } = {}) {
  assertRoot(root, pathImpl);
  const segments = parseVirtualPath(vpath);
  const normRoot = pathImpl.resolve(root);
  const abs = pathImpl.resolve(normRoot, ...segments);
  assertInside(normRoot, abs, pathImpl); // 세그먼트 검증으로 불가능해야 하지만 이중 방어
  return abs;
}

/**
 * resolveInRoot + 링크 탈출 검사.
 * 대상이 없으면(업로드·새 폴더) 존재하는 가장 가까운 조상의 실제 위치를 검사한다.
 * 대상 경로 중간에 "깨진 링크"가 있으면 거부한다 — 그 위에 쓰면 링크 대상(루트 밖)에 파일이 생기므로.
 *
 * @param {string} root
 * @param {string} vpath
 * @param {{ fs?: Pick<typeof fsp, 'realpath' | 'lstat'> }} [opts]
 * @returns {Promise<{ absPath: string, realPath: string, exists: boolean }>}
 */
export async function resolveInRootReal(root, vpath, { fs = fsp } = {}) {
  const absPath = resolveInRoot(root, vpath);
  const realRoot = await fs.realpath(root);

  let probe = absPath;
  const tail = [];
  for (;;) {
    let real = null;
    try {
      real = await fs.realpath(probe);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    }
    if (real !== null) {
      assertInside(realRoot, real, path);
      const realPath = tail.length ? path.join(real, ...tail.reverse()) : real;
      return { absPath, realPath, exists: tail.length === 0 };
    }
    // realpath 실패: 진짜 없음 vs 깨진 링크 구분
    let isLink = false;
    try {
      isLink = (await fs.lstat(probe)).isSymbolicLink();
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    }
    if (isLink) throw new PathError('DANGLING_LINK');

    const parent = path.dirname(probe);
    // absPath 는 root 안이고 root 는 존재(realpath 성공)하므로 root 에서 반드시 멈춘다
    if (parent === probe) throw new PathError('OUTSIDE_ROOT');
    tail.push(path.basename(probe));
    probe = parent;
  }
}

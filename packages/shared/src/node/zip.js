// 스트리밍 zip 작성기. 전체 크기를 미리 몰라도 되고, 메모리에는 청크 하나와 중앙 디렉터리만 둔다.
//
// 형식 선택 (호환성 우선):
//  - 파일은 DEFLATE + 데이터 디스크립터(플래그 bit 3). 스트림으로 만드는 zip 의 표준 형태라
//    윈도우 탐색기, macOS 아카이브 유틸리티, unzip, 7-Zip 모두 읽는다.
//    (STORE + 데이터 디스크립터는 일부 스트리밍 해제기가 파일 끝을 찾지 못해 쓰지 않는다)
//  - 이미 압축된 형식(사진·동영상·zip 등)은 압축 레벨 1 → CPU 를 거의 쓰지 않는다.
//  - 이름은 UTF-8(플래그 bit 11).
//  - 4GB 넘는 파일·오프셋, 65535개 넘는 항목은 ZIP64.

import zlib from 'node:zlib';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveInRootReal } from './fs-path.js';
import { parseVirtualPath, formatVirtualPath, normalizeVirtualPath } from '../virtual-path.js';
import { BrowseError } from './fs-browse.js';

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_EOCD = 0x06054b50;

const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const VERSION = 20; // 2.0: deflate, 폴더
const VERSION_ZIP64 = 45;

/** 압축해도 거의 줄지 않는 형식 */
const PRECOMPRESSED = new Set(
  'jpg jpeg png gif webp heic heif avif mp4 mov m4v mkv webm avi mp3 m4a aac flac ogg opus zip 7z rar gz tgz bz2 xz zst pdf docx xlsx pptx hwpx'.split(' '),
);

/**
 * 이 크기를 넘을 수 있는 파일은 처음부터 ZIP64 로 쓴다.
 * deflate 는 압축이 안 되는 데이터에서 약간 커질 수 있으므로(블록당 수 바이트) 여유를 둔다.
 */
export const ZIP64_FILE_THRESHOLD = 0xf0000000;

/** DOS 날짜/시간(로컬 시각, 2초 단위). 1980 이전은 1980-01-01 로. */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** zip64 확장 필드(0x0001). values 는 표준 순서(원본 크기, 압축 크기, 오프셋)로 넣을 것만. */
function zip64Extra(values) {
  const buf = Buffer.alloc(4 + values.length * 8);
  buf.writeUInt16LE(0x0001, 0);
  buf.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => buf.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return buf;
}

/**
 * @typedef {{
 *   name: string,                       // zip 안 경로. 폴더는 '/' 로 끝나게 넘기지 않아도 된다(type 으로 판단)
 *   type: 'file' | 'dir',
 *   mtime?: Date,
 *   size?: number,                      // 파일: 예상 크기(stat). ZIP64 여부 판단용
 *   open?: () => Promise<AsyncIterable<Buffer> | null>,  // 파일: 내용 스트림. null 이면(그 사이 사라짐) 건너뜀
 * }} ZipEntry
 */

/**
 * zip 바이트를 차례로 내보내는 비동기 제너레이터. Readable.from() 으로 감싸 응답에 파이프한다.
 * 항목 하나라도 읽다 실패하면 예외를 던진다 → 호출자는 연결을 끊어야 한다(깨진 zip 을 정상처럼 보내지 않음).
 *
 * @param {AsyncIterable<ZipEntry> | Iterable<ZipEntry>} entries
 * @param {{ forceZip64?: boolean }} [opts]  forceZip64: 테스트용 (작은 파일로 ZIP64 경로 검증)
 */
export async function* zipStream(entries, { forceZip64 = false } = {}) {
  /** @type {Array<{ name: Buffer, flags: number, method: number, time: number, date: number, crc: number, csize: number, usize: number, offset: number, zip64: boolean, dir: boolean }>} */
  const central = [];
  let offset = 0;
  const emit = (buf) => {
    offset += buf.length;
    return buf;
  };

  for await (const entry of entries) {
    const dir = entry.type === 'dir';
    const rawName = entry.name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!rawName) continue;
    const name = Buffer.from(dir ? `${rawName}/` : rawName, 'utf8');
    if (name.length > MAX16) throw new Error('zip entry name too long');

    let source = null;
    if (!dir) {
      source = await entry.open();
      if (source === null) continue; // 그 사이 사라진 파일
    }

    const { time, date } = dosDateTime(entry.mtime);
    const zip64 = !dir && (forceZip64 || (entry.size ?? 0) > ZIP64_FILE_THRESHOLD);
    const method = dir ? METHOD_STORE : METHOD_DEFLATE;
    const flags = FLAG_UTF8 | (dir ? 0 : FLAG_DESCRIPTOR);
    const localOffset = offset;

    // 로컬 헤더: 디스크립터를 쓰는 파일은 CRC·크기를 0 으로 (ZIP64 면 크기 자리는 0xFFFFFFFF + 확장 필드 0)
    const extra = zip64 ? zip64Extra([0, 0]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(zip64 ? MAX32 : 0, 18);
    local.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    yield emit(Buffer.concat([local, name, extra]));

    let crc = 0;
    let usize = 0;
    let csize = 0;
    if (!dir) {
      const ext = rawName.split('.').pop()?.toLowerCase() ?? '';
      const deflate = zlib.createDeflateRaw({ level: PRECOMPRESSED.has(ext) ? 1 : 6 });
      // 원본을 deflate 에 넣는 쪽과 압축 결과를 꺼내는 쪽을 동시에 돌린다(역압 유지)
      const feed = (async () => {
        try {
          for await (const chunk of source) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            crc = zlib.crc32(buf, crc);
            usize += buf.length;
            if (!zip64 && usize > MAX32) throw new Error('zip entry grew past 4GB');
            if (!deflate.write(buf)) {
              // 받는 쪽이 끊기면 drain 이 오지 않으므로 close 도 기다린다(파일 핸들이 남지 않게)
              await new Promise((r) => {
                deflate.once('drain', r);
                deflate.once('close', r);
              });
              if (deflate.destroyed) throw new Error('zip consumer closed');
            }
          }
          deflate.end();
        } catch (err) {
          deflate.destroy(err);
        }
      })();
      for await (const out of deflate) {
        csize += out.length;
        yield emit(out);
      }
      await feed;
      if (!zip64 && csize > MAX32) throw new Error('zip entry compressed past 4GB');

      const desc = Buffer.alloc(zip64 ? 24 : 16);
      desc.writeUInt32LE(SIG_DESCRIPTOR, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      if (zip64) {
        desc.writeBigUInt64LE(BigInt(csize), 8);
        desc.writeBigUInt64LE(BigInt(usize), 16);
      } else {
        desc.writeUInt32LE(csize, 8);
        desc.writeUInt32LE(usize, 12);
      }
      yield emit(desc);
    }

    central.push({ name, flags, method, time, date, crc: crc >>> 0, csize, usize, offset: localOffset, zip64, dir });
  }

  // 중앙 디렉터리
  const cdStart = offset;
  for (const e of central) {
    const values = [];
    if (e.zip64) values.push(e.usize, e.csize);
    if (e.offset >= MAX32) values.push(e.offset);
    const extra = values.length ? zip64Extra(values) : Buffer.alloc(0);
    const needs64 = values.length > 0;
    const h = Buffer.alloc(46);
    h.writeUInt32LE(SIG_CENTRAL, 0);
    h.writeUInt16LE(needs64 ? VERSION_ZIP64 : VERSION, 4); // made by: MS-DOS(0) + 버전
    h.writeUInt16LE(needs64 ? VERSION_ZIP64 : VERSION, 6);
    h.writeUInt16LE(e.flags, 8);
    h.writeUInt16LE(e.method, 10);
    h.writeUInt16LE(e.time, 12);
    h.writeUInt16LE(e.date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.zip64 ? MAX32 : e.csize, 20);
    h.writeUInt32LE(e.zip64 ? MAX32 : e.usize, 24);
    h.writeUInt16LE(e.name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt16LE(0, 32); // 주석
    h.writeUInt16LE(0, 34); // 디스크 번호
    h.writeUInt16LE(0, 36); // 내부 속성
    h.writeUInt32LE(e.dir ? 0x10 : 0, 38); // 외부 속성: MS-DOS 디렉터리 비트
    h.writeUInt32LE(e.offset >= MAX32 ? MAX32 : e.offset, 42);
    yield emit(Buffer.concat([h, e.name, extra]));
  }
  const cdSize = offset - cdStart;
  const count = central.length;

  // 끝 레코드 (필요하면 ZIP64 레코드 + 위치 정보를 먼저)
  if (forceZip64 || count >= MAX16 || cdSize >= MAX32 || cdStart >= MAX32) {
    const z64Offset = offset;
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(SIG_ZIP64_EOCD, 0);
    rec.writeBigUInt64LE(44n, 4); // 이 필드 다음부터의 크기
    rec.writeUInt16LE(VERSION_ZIP64, 12);
    rec.writeUInt16LE(VERSION_ZIP64, 14);
    rec.writeUInt32LE(0, 16);
    rec.writeUInt32LE(0, 20);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(z64Offset), 8);
    loc.writeUInt32LE(1, 16);
    yield emit(Buffer.concat([rec, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Math.min(count, MAX16), 8);
  end.writeUInt16LE(Math.min(count, MAX16), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
  end.writeUInt16LE(0, 20);
  yield emit(end);
}

const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * 루트 안 가상 경로들(같은 폴더의 항목들)을 zip 항목으로 펼친다. 폴더는 하위까지.
 *  - 심볼릭 링크·정션은 따라가지 않고 건너뛴다(루트 밖 노출·순환 방지, safeRemove 와 같은 원칙)
 *  - 맥·윈도우 부수 파일(.DS_Store 등)과 skipDir(예: 시스템 폴더) 는 뺀다
 *  - zip 안 이름은 선택한 항목 이름부터 시작 (예: /사진/여행 → 여행/a.jpg)
 *
 * @param {string} root
 * @param {string[]} vpaths  이미 검증·정규화된 가상 경로
 * @param {{ skipDir?: (realPath: string) => boolean }} [opts]
 * @returns {AsyncGenerator<ZipEntry>}
 */
export async function* zipEntriesFor(root, vpaths, { skipDir = () => false } = {}) {

  const fileEntry = (name, realPath, st) => ({
    name,
    type: 'file',
    mtime: st.mtime,
    size: st.size,
    open: async () => {
      let handle;
      try {
        handle = await fsp.open(realPath, 'r');
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
      return handle.createReadStream({ highWaterMark: 1024 * 1024 });
    },
  });

  async function* walkDir(name, realDir, st) {
    yield { name, type: 'dir', mtime: st.mtime };
    let dirents;
    try {
      dirents = await fsp.readdir(realDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (d.isSymbolicLink() || JUNK_NAMES.has(d.name)) continue;
      const childReal = path.join(realDir, d.name);
      if (!d.isFile() && !d.isDirectory()) continue;
      if (d.isDirectory() && skipDir(childReal)) continue;
      let cst;
      try {
        cst = await fsp.lstat(childReal);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      const childName = `${name}/${d.name}`;
      if (cst.isDirectory()) yield* walkDir(childName, childReal, cst);
      else if (cst.isFile()) yield fileEntry(childName, childReal, cst);
    }
  }

  for (const vpath of vpaths) {
    const segs = parseVirtualPath(vpath);
    const { realPath, exists } = await resolveInRootReal(root, vpath);
    if (!exists) continue;
    const st = await fsp.stat(realPath);
    const name = segs.at(-1) ?? 'Drive';
    if (st.isDirectory()) {
      if (!skipDir(realPath)) yield* walkDir(name, realPath, st);
    } else if (st.isFile()) yield fileEntry(name, realPath, st);
  }
}

export const MAX_ZIP_ITEMS = 500;

/**
 * 다운로드할 선택 항목 검사 + zip 파일 이름.
 *  - 모두 같은 폴더 안 항목이어야 한다(zip 안 최상위 이름이 겹치지 않도록)
 *  - 루트('/')는 단독으로만
 * @param {unknown} list  ?path= 쿼리 값(문자열 또는 배열)
 * @returns {{ vpaths: string[], filename: string }}
 */
export function planZip(list) {
  const raw = typeof list === 'string' ? [list] : list;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ZIP_ITEMS || !raw.every((s) => typeof s === 'string')) {
    throw new BrowseError('BAD_LIST', 400);
  }
  const vpaths = [...new Set(raw.map((p) => normalizeVirtualPath(p)))];
  const segsList = vpaths.map((p) => parseVirtualPath(p));
  if (segsList.some((s) => s.length === 0)) {
    if (vpaths.length !== 1) throw new BrowseError('BAD_LIST', 400);
    return { vpaths, filename: 'Drive.zip' };
  }
  const parent = formatVirtualPath(segsList[0].slice(0, -1));
  if (!segsList.every((s) => formatVirtualPath(s.slice(0, -1)) === parent)) throw new BrowseError('MIXED_PARENTS', 400);
  const base = vpaths.length === 1 ? segsList[0].at(-1) : (segsList[0].at(-2) ?? 'Drive');
  return { vpaths, filename: `${base}.zip` };
}

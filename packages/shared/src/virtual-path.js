// 가상 경로(virtual path) 검증 — 브라우저·gateway·agent 공용. node: 모듈을 import하지 않는다.
//
// 가상 경로 형식: POSIX 스타일 절대경로. "/" 는 루트, "/사진/2024/a.jpg".
//  - 빈 세그먼트("//"), ".", ".." 금지 (정규화로 조용히 고치지 않고 거부한다)
//  - 마지막 "/" 하나는 허용하고 제거한다
//  - 각 세그먼트는 윈도우·ext4 양쪽에서 안전한 파일명이어야 한다 (checkSegment 참고)
//
// 실제 디스크 경로로의 변환과 루트 밖 탈출 검사는 node 전용 모듈 fs-path.js 에서 한다.

export const MAX_SEGMENT_UTF16 = 255; // NTFS 파일명 한도 (UTF-16 코드 유닛)
export const MAX_SEGMENT_BYTES = 255; // ext4 파일명 한도 (UTF-8 바이트) — 파이의 데모·버퍼 저장소
export const MAX_VIRTUAL_PATH_LENGTH = 1024;
export const MAX_DEPTH = 64;

export class PathError extends Error {
  /**
   * @param {string} code  기계가 읽는 코드 (예: 'INVALID_CHAR'). 사용자 문구는 web에서 코드로 매핑한다.
   * @param {string} [detail]
   */
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PathError';
    this.code = code;
  }
}

// 윈도우 금지 문자 + 제어문자. ':' 는 NTFS 대체 데이터 스트림(ADS) 접근도 막는다.
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
// 짝이 맞지 않는 서로게이트 (UTF-8로 인코딩 불가 → 파일 시스템마다 다르게 깨짐)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// 윈도우 예약 장치 이름. 확장자가 붙어도("nul.txt") 예약어로 취급된다.
const RESERVED_BASENAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

const utf8 = new TextEncoder();

/**
 * 파일/폴더 이름 한 개를 검사한다.
 * @param {unknown} seg
 * @returns {string | null} 문제가 있으면 오류 코드, 없으면 null
 */
export function checkSegment(seg) {
  if (typeof seg !== 'string') return 'NOT_A_STRING';
  if (seg.length === 0) return 'EMPTY_SEGMENT';
  if (seg === '.' || seg === '..') return 'DOT_SEGMENT';
  if (INVALID_CHARS.test(seg)) return 'INVALID_CHAR';
  if (LONE_SURROGATE.test(seg)) return 'INVALID_UNICODE';
  // 윈도우는 후행 공백·점을 조용히 잘라낸다 → "a." 와 "a" 가 같은 파일이 되는 혼동 방지
  if (/[ .]$/.test(seg)) return 'TRAILING_DOT_OR_SPACE';
  const dot = seg.indexOf('.');
  const base = (dot === -1 ? seg : seg.slice(0, dot)).replace(/ +$/, '');
  if (RESERVED_BASENAME.test(base)) return 'RESERVED_NAME';
  if (seg.length > MAX_SEGMENT_UTF16) return 'NAME_TOO_LONG';
  if (utf8.encode(seg).length > MAX_SEGMENT_BYTES) return 'NAME_TOO_LONG';
  return null;
}

/** @param {unknown} name */
export function isValidName(name) {
  return checkSegment(name) === null;
}

/**
 * 가상 경로를 세그먼트 배열로 파싱한다. 하나라도 문제가 있으면 PathError.
 * @param {unknown} vpath
 * @returns {string[]} 루트면 []
 */
export function parseVirtualPath(vpath) {
  if (typeof vpath !== 'string') throw new PathError('NOT_A_STRING');
  if (vpath.length > MAX_VIRTUAL_PATH_LENGTH) throw new PathError('PATH_TOO_LONG');
  if (!vpath.startsWith('/')) throw new PathError('NOT_ABSOLUTE', 'virtual path must start with "/"');
  if (vpath === '/') return [];
  const body = vpath.endsWith('/') ? vpath.slice(1, -1) : vpath.slice(1);
  const segments = body.split('/');
  if (segments.length > MAX_DEPTH) throw new PathError('PATH_TOO_DEEP');
  for (const seg of segments) {
    const code = checkSegment(seg);
    if (code) throw new PathError(code, JSON.stringify(seg));
  }
  return segments;
}

/** @param {string[]} segments */
export function formatVirtualPath(segments) {
  return '/' + segments.join('/');
}

/** 검증 + 정규화 ("/a/b/" → "/a/b"). */
export function normalizeVirtualPath(vpath) {
  return formatVirtualPath(parseVirtualPath(vpath));
}

/** 루트면 null. */
export function parentOf(vpath) {
  const segs = parseVirtualPath(vpath);
  return segs.length === 0 ? null : formatVirtualPath(segs.slice(0, -1));
}

/** 루트면 ''. */
export function basenameOf(vpath) {
  const segs = parseVirtualPath(vpath);
  return segs.length === 0 ? '' : segs[segs.length - 1];
}

/**
 * 새로 만들 파일·폴더 이름 정규화. 맥은 NFD(자모 분리)로 보내므로 NFC로 통일한 뒤 검사한다.
 * 기존 파일 조회에는 쓰지 않는다 (디스크에 NFD로 저장된 기존 파일을 못 찾게 되므로).
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeNewName(name) {
  if (typeof name !== 'string') throw new PathError('NOT_A_STRING');
  const nfc = name.normalize('NFC');
  const code = checkSegment(nfc);
  if (code) throw new PathError(code, JSON.stringify(nfc));
  return nfc;
}

/** 부모 가상 경로 + 새 이름 → 가상 경로. 이름은 NFC 정규화된다. */
export function joinVirtual(parent, name) {
  return formatVirtualPath([...parseVirtualPath(parent), normalizeNewName(name)]);
}

/**
 * 루트 바로 아래의 시스템 폴더 (휴지통·업로드 임시 파일). 웹 API 로는 보이지도, 접근되지도 않는다.
 * 윈도우는 대소문자를 구분하지 않으므로 비교도 대소문자 무시.
 */
export const SYSTEM_DIR_NAME = '.wooki';

/** 가상 경로가 시스템 폴더(또는 그 안)를 가리키는가 */
export function isReservedPath(vpath) {
  const segs = parseVirtualPath(vpath);
  return segs.length > 0 && segs[0].toLowerCase() === SYSTEM_DIR_NAME;
}

/** 시스템 폴더 경로면 PathError('RESERVED') */
export function assertNotReserved(vpath) {
  if (isReservedPath(vpath)) throw new PathError('RESERVED');
  return vpath;
}

/**
 * 이름 충돌 시 대체 이름 (ai.md §4.1-3: `이름 (1).ext`).
 * 확장자는 마지막 점 기준. 점으로 시작하는 이름(.env)이나 폴더는 끝에 붙인다.
 * @param {string} name
 * @param {number} n  1, 2, 3 …
 * @param {{ isDir?: boolean }} [opts]
 */
export function numberedName(name, n, { isDir = false } = {}) {
  const dot = name.lastIndexOf('.');
  if (isDir || dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/**
 * a 가 b 자신이거나 b 의 조상인가. 폴더를 자기 하위로 이동하는 것을 막을 때 쓴다.
 * 기본은 대소문자 무시(윈도우 NTFS 기준). 대소문자를 구분하는 ext4에서는 거짓 양성만 생기므로 안전한 쪽.
 */
export function isAncestorOrSelf(a, b, { caseInsensitive = true } = {}) {
  const fold = (s) => (caseInsensitive ? s.toLowerCase() : s);
  const sa = parseVirtualPath(a);
  const sb = parseVirtualPath(b);
  if (sa.length > sb.length) return false;
  return sa.every((seg, i) => fold(seg) === fold(sb[i]));
}

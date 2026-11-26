// 확장자 → 종류. Finder 의 "종류" 열과 Quick Look 방식 결정에 쓴다.

/** @typedef {'image' | 'video' | 'audio' | 'pdf' | 'text' | 'archive' | 'document' | 'other'} Kind */

const TABLE = {
  image: { exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico'], label: '이미지' },
  // svg 는 미리보기에서 텍스트로 보여준다(서버도 text/plain 으로 바꿈)
  video: { exts: ['mp4', 'm4v', 'mov', 'webm', 'ogv'], label: '동영상' },
  audio: { exts: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac', 'opus'], label: '오디오' },
  pdf: { exts: ['pdf'], label: 'PDF 문서' },
  text: {
    exts: [
      'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env',
      'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'html', 'htm', 'svg', 'py', 'rb', 'go', 'rs', 'java',
      'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bat', 'ps1', 'sql', 'gitignore',
    ],
    label: '텍스트',
  },
  archive: { exts: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'dmg', 'iso'], label: '압축 파일' },
  document: { exts: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx', 'key', 'pages', 'numbers', 'rtf'], label: '문서' },
};

const BY_EXT = new Map();
for (const [kind, { exts }] of Object.entries(TABLE)) for (const e of exts) BY_EXT.set(e, kind);

/** 'a.tar.gz' → 'gz', '.gitignore' → 'gitignore', 'Makefile' → '' */
export function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i === -1 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** @returns {Kind} */
export function kindOf(entry) {
  if (entry.type !== 'file') return 'other';
  return BY_EXT.get(extOf(entry.name)) ?? 'other';
}

/** Finder "종류" 열 */
export function kindLabel(entry) {
  if (entry.type === 'dir') return '폴더';
  if (entry.type !== 'file') return entry.link ? '링크 (열 수 없음)' : '기타';
  const ext = extOf(entry.name);
  const kind = BY_EXT.get(ext);
  if (!kind) return ext ? `${ext.toUpperCase()} 파일` : '문서';
  const base = TABLE[kind].label;
  return kind === 'pdf' ? base : `${base} (${ext.toUpperCase()})`;
}

/** Quick Look 으로 내용을 보여줄 수 있는가 */
export function canPreview(entry) {
  return ['image', 'video', 'audio', 'pdf', 'text'].includes(kindOf(entry));
}

const units = ['바이트', 'KB', 'MB', 'GB', 'TB'];
/** Finder 처럼 10진 단위 */
export function formatSize(bytes) {
  if (bytes == null) return '--';
  if (bytes < 1000) return `${bytes} 바이트`;
  let v = bytes;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[u]}`;
}

const timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

/** "오늘 오후 3:12", "어제 오전 9:01", "2024년 3월 5일 오후 3:12" */
export function formatDate(ms, now = Date.now()) {
  if (ms == null) return '--';
  const d = new Date(ms);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const t = timeFmt.format(d);
  if (ms >= today.getTime() && ms < today.getTime() + day) return `오늘 ${t}`;
  if (ms >= today.getTime() - day && ms < today.getTime()) return `어제 ${t}`;
  return `${dateFmt.format(d)} ${t}`;
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

/**
 * @param {any[]} entries
 * @param {{ key: 'name' | 'mtime' | 'size' | 'kind', dir: 1 | -1 }} sort
 */
export function sortEntries(entries, { key, dir }) {
  const byName = (a, b) => collator.compare(a.name, b.name);
  const cmp = {
    name: byName,
    mtime: (a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0) || byName(a, b),
    // Finder 처럼 폴더(크기 없음)는 크기순에서 맨 끝
    size: (a, b) => (a.size ?? -1) - (b.size ?? -1) || byName(a, b),
    kind: (a, b) => collator.compare(kindLabel(a), kindLabel(b)) || byName(a, b),
  }[key];
  return [...entries].sort((a, b) => dir * cmp(a, b));
}

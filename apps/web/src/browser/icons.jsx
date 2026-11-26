// 인라인 SVG 아이콘. 외부 리소스를 불러오지 않는다(CSP: 'self' 만).
import { extOf, kindOf } from './fileTypes.js';

const KIND_COLOR = {
  image: '#e2744b',
  video: '#9b5de5',
  audio: '#e5487a',
  pdf: '#d93b30',
  text: '#6b7684',
  archive: '#a77b3b',
  document: '#2f7de1',
  other: '#8c939d',
};

export function FolderIcon({ size = 16, className }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M4 14a4 4 0 0 1 4-4h15.5a4 4 0 0 1 3 1.4L31 16h25a4 4 0 0 1 4 4v30a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="var(--folder-back)" />
      <path d="M4 23a3 3 0 0 1 3-3h50a3 3 0 0 1 3 3v27a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="var(--folder-front)" />
    </svg>
  );
}

export function FileIcon({ entry, size = 16, className }) {
  const kind = kindOf(entry);
  const color = KIND_COLOR[kind];
  const ext = extOf(entry.name).slice(0, 4).toUpperCase();
  const big = size >= 40;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M14 4h26l14 14v40a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="var(--file-paper)" stroke="var(--file-edge)" strokeWidth="1.5" />
      <path d="M40 4v12a2 2 0 0 0 2 2h12" fill="var(--file-fold)" stroke="var(--file-edge)" strokeWidth="1.5" />
      {big && ext ? (
        <>
          <rect x="12" y="38" width="42" height="14" rx="2" fill={color} />
          <text x="33" y="48.5" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">
            {ext}
          </text>
        </>
      ) : (
        <rect x="19" y="34" width="28" height="6" rx="3" fill={color} />
      )}
    </svg>
  );
}

export function EntryIcon({ entry, size }) {
  return entry.type === 'dir' ? <FolderIcon size={size} /> : <FileIcon entry={entry} size={size} />;
}

export function AppMark({ className }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M6 16a4 4 0 0 1 4-4h14l5 6h25a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#3d8bfd" />
      <path d="M6 24h52v26a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#6aa9ff" />
    </svg>
  );
}

/** 툴바·사이드바용 선 아이콘 (currentColor) */
export function Glyph({ name, size = 16 }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  switch (name) {
    case 'back':
      return <svg {...common}><path d="M10 3 5 8l5 5" /></svg>;
    case 'forward':
      return <svg {...common}><path d="m6 3 5 5-5 5" /></svg>;
    case 'list':
      return <svg {...common}><path d="M5 4h9M5 8h9M5 12h9M2 4h.01M2 8h.01M2 12h.01" /></svg>;
    case 'columns':
      return <svg {...common}><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M6 2.5v11M10.5 2.5v11" /></svg>;
    case 'grid':
      return <svg {...common}><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>;
    case 'download':
      return <svg {...common}><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10" /></svg>;
    case 'eye':
      return <svg {...common}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>;
    case 'desktop':
      return <svg {...common}><rect x="1.5" y="2.5" width="13" height="8.5" rx="1" /><path d="M6 14h4M8 11v3" /></svg>;
    case 'demo':
      return <svg {...common}><path d="M2 5.5h12M3 3h10a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M6 9h4" /></svg>;
    case 'logout':
      return <svg {...common}><path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11 13.5 8l-3-3M13.5 8H6" /></svg>;
    case 'close':
      return <svg {...common}><path d="m4 4 8 8M12 4l-8 8" /></svg>;
    case 'open':
      return <svg {...common}><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></svg>;
    case 'trash':
      return <svg {...common}><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9a1 1 0 0 0 1 1h4.6a1 1 0 0 0 1-1L12 4M6.5 6.5v5M9.5 6.5v5" /></svg>;
    case 'upload':
      return <svg {...common}><path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13h10" /></svg>;
    case 'newfolder':
      return <svg {...common}><path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5h6.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /><path d="M8 7v4M6 9h4" /></svg>;
    case 'chevron':
      return <svg {...common} width={10} height={10}><path d="m6 3 5 5-5 5" /></svg>;
    default:
      return null;
  }
}

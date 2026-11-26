// 여러 보기가 같이 쓰는 조각: 썸네일, 이름 변경 입력칸.
import { useEffect, useRef, useState } from 'react';
import { contentUrl, thumbUrl } from '../api.js';
import { kindOf } from './fileTypes.js';
import { EntryIcon } from './icons.jsx';

const THUMB_MAX_BYTES = 20_000_000;

/**
 * 썸네일 주소. 데스크탑: agent 가 만든 썸네일(이미지·동영상). 데모 폴더: 작은 샘플이라 원본 이미지를 그대로.
 * @returns {string | null}
 */
export function thumbSrc(e, source) {
  if (!e.addressable) return null;
  const kind = kindOf(e);
  if (source === 'files' && (kind === 'image' || kind === 'video')) return thumbUrl(e);
  if (source === 'demo' && kind === 'image' && e.size != null && e.size <= THUMB_MAX_BYTES) return contentUrl(source, e.path);
  return null;
}

/** 썸네일. 못 받으면(지원 안 하는 형식, 데스크탑 꺼짐+캐시 없음) 아이콘으로. */
export function Thumb({ src, entry, video, size = 64 }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <EntryIcon entry={entry} size={size} />;
  return (
    <span className={`thumb ${video ? 'is-video' : ''}`}>
      <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
    </span>
  );
}

/** 이름 변경 입력칸. 파일은 확장자 앞까지만 선택 (Finder 와 같음). */
export function RenameInput({ entry, onCommit, onCancel, className }) {
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = entry.type === 'file' ? entry.name.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry]);
  const finish = (fn) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  return (
    <input
      ref={ref}
      className={`rename-input ${className ?? ''}`}
      defaultValue={entry.name}
      aria-label="새 이름"
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(() => onCommit(entry, e.currentTarget.value));
        if (e.key === 'Escape') finish(onCancel);
      }}
      onBlur={(e) => finish(() => onCommit(entry, e.currentTarget.value))}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

/** 항목 툴팁: 파이 보관함 대기·열 수 없는 이름 */
export function entryTitle(e) {
  if (e.pending) {
    if (e.pending.error) return '데스크탑으로 옮기지 못했어요. 우클릭해서 다시 옮기거나 지울 수 있어요.';
    return e.type === 'dir' ? `파이에 보관 중인 파일 ${e.pending.count}개 — 데스크탑이 켜지면 옮겨져요` : '파이에 보관 중 — 데스크탑이 켜지면 옮겨져요';
  }
  return e.addressable ? undefined : '이름 때문에 웹에서 열 수 없는 항목이에요';
}

/** "대기 중" / "옮기지 못함" 배지 */
export function PendingBadge({ entry }) {
  const failed = Boolean(entry.pending?.error);
  return <span className={`pending-badge ${failed ? 'is-failed' : ''}`}>{failed ? '옮기지 못함' : '대기 중'}</span>;
}

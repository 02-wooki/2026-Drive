// 컬럼 보기 (Finder 의 ⌘3).
//
// 왼쪽부터 루트 → … → 지금 폴더(활성 컬럼). 활성 컬럼에서 고른 것이
//  - 폴더면 오른쪽에 그 안 목록(미리 보기 컬럼)
//  - 파일이면 오른쪽에 미리 보기(썸네일 + 정보)
// 지금 폴더는 URL 의 path 그대로라, 선택·단축키·이름 변경·끌어서 옮기기는 다른 보기와 같은 코드를 쓴다.
// 다른 컬럼을 누르면 그 컬럼의 폴더로 이동하면서 누른 항목을 고른다(onPick).

import { useEffect, useRef } from 'react';
import { kindLabel, formatSize, formatDate, kindOf, canPreview } from './fileTypes.js';
import { EntryIcon, Glyph } from './icons.jsx';
import { Thumb, thumbSrc, RenameInput, PendingBadge, entryTitle } from './parts.jsx';
import { messageFor } from '../messages.js';

/**
 * @typedef {{
 *   folder: string,
 *   entries: Array<any> | null,   // null = 불러오는 중
 *   error?: any,
 *   active: boolean,              // 지금 폴더 (선택·키보드 대상)
 *   highlight: string | null,     // 이 컬럼에서 다음 컬럼으로 이어지는 항목
 * }} Column
 */

export function ColumnView({
  columns,
  preview,
  source,
  path,
  selected,
  lead,
  renaming,
  dropTarget,
  onPick,
  onOpen,
  onMenu,
  onRename,
  onCancelRename,
  dragProps,
  dropProps,
}) {
  const ref = useRef(null);

  // 새 컬럼이 생기면 오른쪽 끝이 보이도록
  const count = columns.length + (preview ? 1 : 0);
  useEffect(() => {
    const el = ref.current?.closest('.content');
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [count, path]);

  return (
    <div className="columns" ref={ref}>
      {columns.map((col) => (
        <div
          key={col.folder}
          className={`column ${col.active ? 'is-active' : ''} ${dropTarget === col.folder ? 'is-drop' : ''}`}
          role="listbox"
          aria-label={col.folder === '/' ? '최상위' : col.folder.split('/').pop()}
          aria-multiselectable={col.active ? 'true' : undefined}
          data-folder={col.folder}
          onMouseDown={(ev) => {
            if (ev.button === 0 && ev.target === ev.currentTarget) onPick(col.folder, null, ev);
          }}
          onContextMenu={(ev) => {
            if (ev.target === ev.currentTarget) onMenu(ev, null, col.folder);
          }}
          {...dropProps(col.folder)}
        >
          {col.error ? (
            <p className="column-note">{messageFor(col.error)}</p>
          ) : col.entries === null ? (
            <p className="column-note">불러오는 중…</p>
          ) : col.entries.length === 0 ? (
            <p className="column-note">빈 폴더</p>
          ) : (
            col.entries.map((e) => {
              const on = col.active && selected.has(e.path);
              const onPath = !col.active && col.highlight === e.path;
              return (
                <div
                  key={e.pending ? `~${e.name}` : e.name}
                  role="option"
                  aria-selected={on || onPath}
                  data-path={e.path ?? ''}
                  className={`column-row ${on ? 'is-selected' : ''} ${onPath ? 'is-path' : ''} ${col.active && (e.path != null && e.path === lead) ? 'is-lead' : ''} ${e.addressable ? '' : 'is-disabled'} ${e.hidden ? 'is-hidden' : ''} ${e.pending ? 'is-pending' : ''} ${(e.path != null && dropTarget === e.path) ? 'is-drop' : ''}`}
                  title={entryTitle(e)}
                  onMouseDown={(ev) => ev.button === 0 && onPick(col.folder, e, ev)}
                  onDoubleClick={() => onOpen(e)}
                  onContextMenu={(ev) => onMenu(ev, e, col.folder)}
                  {...dragProps(e)}
                  {...(e.type === 'dir' && e.addressable ? dropProps(e.path) : {})}
                >
                  <EntryIcon entry={e} size={16} />
                  {col.active && (e.path != null && renaming === e.path) ? (
                    <RenameInput entry={e} onCommit={onRename} onCancel={onCancelRename} />
                  ) : (
                    <span className="name-text">{e.name}</span>
                  )}
                  {e.pending && <PendingBadge entry={e} />}
                  {e.type === 'dir' && <Glyph name="chevron" />}
                </div>
              );
            })
          )}
        </div>
      ))}
      {preview && <FilePreview entry={preview} source={source} />}
    </div>
  );
}

function FilePreview({ entry, source }) {
  const src = thumbSrc(entry, source);
  const kind = kindOf(entry);
  return (
    <div className="column column-preview" aria-label="미리 보기">
      <div className="preview-art">{src ? <Thumb src={src} entry={entry} video={kind === 'video'} size={96} /> : <EntryIcon entry={entry} size={96} />}</div>
      <p className="preview-name">{entry.name}</p>
      <p className="preview-kind">
        {kindLabel(entry)}
        {entry.type === 'file' && ` · ${formatSize(entry.size)}`}
      </p>
      <dl className="preview-info">
        <dt>수정일</dt>
        <dd>{formatDate(entry.mtimeMs)}</dd>
      </dl>
      {canPreview(entry) && <p className="preview-hint">Space로 훑어보기</p>}
    </div>
  );
}

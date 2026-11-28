// 업로드 진행 패널 (오른쪽 아래).
import { useEffect, useState } from 'react';
import { uploads } from '../uploads.js';
import { messageFor } from '../messages.js';
import { formatSize } from './fileTypes.js';
import { Glyph } from './icons.jsx';

export function UploadPanel() {
  const [items, setItems] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => uploads.subscribe(setItems), []);

  // 새로 추가되면 펼치기
  const active = items.filter((i) => i.state === 'queued' || i.state === 'uploading');
  useEffect(() => {
    if (active.length) setCollapsed(false);
  }, [active.length]);

  // 업로드 중 탭 닫기 경고
  useEffect(() => {
    if (!active.length) return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [active.length]);

  if (items.length === 0) return null;

  const total = items.reduce((s, i) => s + i.size, 0);
  const sent = items.reduce((s, i) => s + (i.state === 'done' ? i.size : i.sent), 0);
  const failed = items.filter((i) => i.state === 'error').length;
  const cancelled = items.filter((i) => i.state === 'cancelled').length;
  const title = active.length
    ? `${active.length}개 업로드 중 · ${formatSize(sent)} / ${formatSize(total)}`
    : failed
      ? `${failed}개 업로드 실패`
      : cancelled === items.length
        ? '업로드 취소됨'
        : cancelled
          ? `업로드 완료 · ${cancelled}개 취소됨`
          : '업로드 완료';

  return (
    <section className={`upload-panel glass ${collapsed ? 'is-collapsed' : ''}`} aria-label="업로드">
      <header className="upload-head">
        <button type="button" className="upload-title" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
          {title}
        </button>
        {active.length > 0 && (
          <button type="button" className="btn upload-cancel-all" onClick={() => uploads.cancelAll()} title="대기 중인 파일까지 모두 취소">
            모두 취소
          </button>
        )}
        {!active.length && (
          <button type="button" className="icon-btn" onClick={() => uploads.clearFinished()} title="목록 지우기" aria-label="목록 지우기">
            <Glyph name="close" />
          </button>
        )}
      </header>
      <div className="upload-total" aria-hidden="true">
        <div style={{ width: `${total ? (sent / total) * 100 : 100}%` }} />
      </div>
      {!collapsed && (
        <ul className="upload-list">
          {items.map((it) => (
            <li key={it.key} className={`upload-item is-${it.state}`}>
              <div className="upload-name" title={it.dest}>
                {it.name}
              </div>
              <div className="upload-meta">
                {it.state === 'uploading' && (
                  <>
                    {formatSize(it.sent)} / {formatSize(it.size)}
                    {it.rate ? ` · ${formatSize(it.rate)}/초` : ''}
                  </>
                )}
                {it.state === 'queued' && '대기 중'}
                {it.state === 'done' &&
                  (it.target === 'buffer'
                    ? '파이에 보관됨 · 데스크탑이 켜지면 옮겨져요'
                    : it.replaced
                      ? '완료 · 기존 파일은 휴지통으로'
                      : it.finalPath && it.finalPath !== it.dest
                        ? `완료 · ${it.finalPath.split('/').pop()}(으)로 저장`
                        : '완료')}
                {it.state === 'cancelled' && '취소됨'}
                {it.state === 'error' && messageFor(it.error)}
              </div>
              {(it.state === 'uploading' || it.state === 'queued') && (
                <>
                  <div className="upload-bar" aria-hidden="true">
                    <div style={{ width: `${it.size ? (it.sent / it.size) * 100 : 0}%` }} />
                  </div>
                  <button type="button" className="icon-btn upload-btn" onClick={() => uploads.cancel(it.key)} aria-label={`${it.name} 업로드 취소`} title="취소">
                    <Glyph name="close" size={12} />
                  </button>
                </>
              )}
              {(it.state === 'error' || it.state === 'cancelled') && (
                <button type="button" className="btn upload-retry" onClick={() => uploads.retry(it.key)}>
                  다시 시도
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

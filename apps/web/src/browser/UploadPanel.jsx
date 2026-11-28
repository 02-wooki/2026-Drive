// 업로드 진행 패널 (오른쪽 아래).
// 파일이 몇만 개여도 볼 만하게: 진행 중인 파일을 맨 위에, 대기 중은 앞의 몇 개만, 끝난 파일은 "N개 완료" 한 줄로 접는다.
import { useEffect, useMemo, useState } from 'react';
import { uploads } from '../uploads.js';
import { messageFor } from '../messages.js';
import { formatSize } from './fileTypes.js';
import { Glyph } from './icons.jsx';

const UPLOADING_SHOWN = 20; // 묶음 하나가 200개라 올리는 중인 것도 앞부분만
const QUEUED_SHOWN = 20;
const PROBLEMS_SHOWN = 200;
const DONE_SHOWN = 200;

export function UploadPanel() {
  const [items, setItems] = useState([]);
  const [preparing, setPreparing] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [showDone, setShowDone] = useState(false);
  useEffect(() => uploads.subscribe(setItems), []);
  useEffect(() => uploads.onPreparing(setPreparing), []);

  const groups = useMemo(() => {
    const g = { uploading: [], queued: [], problems: [], done: [] };
    for (const it of items) {
      if (it.state === 'uploading') g.uploading.push(it);
      else if (it.state === 'queued') g.queued.push(it);
      else if (it.state === 'done') g.done.push(it);
      else g.problems.push(it); // error · cancelled
    }
    return g;
  }, [items]);
  const activeCount = groups.uploading.length + groups.queued.length;

  // 새로 추가되거나 준비를 시작하면 펼치기
  useEffect(() => {
    if (activeCount || preparing) setCollapsed(false);
  }, [activeCount, preparing]);

  // 업로드 중 탭 닫기 경고
  useEffect(() => {
    if (!activeCount) return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [activeCount]);

  if (items.length === 0 && !preparing) return null;

  const total = items.reduce((s, i) => s + i.size, 0);
  const sent = items.reduce((s, i) => s + (i.state === 'done' ? i.size : i.sent), 0);
  const failed = groups.problems.filter((i) => i.state === 'error').length;
  const cancelled = groups.problems.length - failed;
  const title = activeCount
    ? `${activeCount.toLocaleString()}개 업로드 중 · ${formatSize(sent)} / ${formatSize(total)}`
    : preparing && !items.length
      ? '업로드 준비 중'
      : failed
        ? `${failed.toLocaleString()}개 업로드 실패`
        : cancelled === items.length
          ? '업로드 취소됨'
          : cancelled
            ? `업로드 완료 · ${cancelled.toLocaleString()}개 취소됨`
            : '업로드 완료';

  const row = (it) => (
    <li key={it.key} className={`upload-item is-${it.state}`}>
      <div className="upload-name" title={it.dest}>
        {it.name}
      </div>
      <div className="upload-meta">
        {it.state === 'uploading' && it.batched && '작은 파일 여러 개와 함께 보내는 중'}
        {it.state === 'uploading' && !it.batched && (
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
  );

  const more = (n, text) => n > 0 && <li className="upload-more">{`외 ${n.toLocaleString()}개 ${text}`}</li>;

  return (
    <section className={`upload-panel glass ${collapsed ? 'is-collapsed' : ''}`} aria-label="업로드">
      <header className="upload-head">
        <button type="button" className="upload-title" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
          {title}
        </button>
        {activeCount > 0 && (
          <button type="button" className="btn upload-cancel-all" onClick={() => uploads.cancelAll()} title="대기 중인 파일까지 모두 취소">
            모두 취소
          </button>
        )}
        {!activeCount && !preparing && (
          <button type="button" className="icon-btn" onClick={() => uploads.clearFinished()} title="목록 지우기" aria-label="목록 지우기">
            <Glyph name="close" />
          </button>
        )}
      </header>
      <div className="upload-total" aria-hidden="true">
        <div style={{ width: `${total ? (sent / total) * 100 : preparing ? 0 : 100}%` }} />
      </div>
      {!collapsed && (
        <ul className="upload-list">
          {preparing && (
            <li className="upload-more upload-preparing" role="status">
              {preparing}
            </li>
          )}
          {groups.uploading.slice(0, UPLOADING_SHOWN).map(row)}
          {more(groups.uploading.length - UPLOADING_SHOWN, '올리는 중')}
          {groups.queued.slice(0, QUEUED_SHOWN).map(row)}
          {more(groups.queued.length - QUEUED_SHOWN, '대기 중')}
          {groups.problems.slice(0, PROBLEMS_SHOWN).map(row)}
          {more(groups.problems.length - PROBLEMS_SHOWN, '실패·취소')}
          {groups.done.length > 0 && (
            <li className="upload-done-summary">
              <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
                <span>✓ {groups.done.length.toLocaleString()}개 전송 완료</span>
                <span className="upload-done-toggle">{showDone ? '숨기기' : '보기'}</span>
              </button>
            </li>
          )}
          {showDone && (
            <>
              {/* 최근에 끝난 것부터 */}
              {groups.done.slice(-DONE_SHOWN).reverse().map(row)}
              {more(groups.done.length - DONE_SHOWN, '더 완료')}
            </>
          )}
        </ul>
      )}
    </section>
  );
}

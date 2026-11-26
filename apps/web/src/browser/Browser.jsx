// Finder 스타일 탐색기.
//
// 위치는 URL 에 둔다: /?loc=desktop|demo&path=/a/b  → 브라우저 뒤로·앞으로가 그대로 Finder 의 뒤로·앞으로가 된다.
//
// 단축키 (맥은 ⌘, 윈도우는 Ctrl):
//   ↑ ↓ (아이콘 보기에선 ← → 도)  선택 이동        ⌘↓ / 더블클릭  열기
//   ⌘↑  상위 폴더                                 ⌘[ ⌘]          뒤로 / 앞으로
//   Space  Quick Look                             ⌘⇧.            숨김 파일 보기
//   글자 입력  이름으로 바로 이동 (type-select)
// Enter 는 Finder 처럼 '이름 변경'용으로 남겨 둔다(쓰기 기능 단계에서 연결).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, contentUrl } from '../api.js';
import { messageFor } from '../messages.js';
import { sortEntries, kindLabel, formatSize, formatDate, canPreview, kindOf } from './fileTypes.js';
import { EntryIcon, Glyph } from './icons.jsx';
import { QuickLook } from './QuickLook.jsx';

const ROOT_LABEL = { files: '데스크탑', demo: '데모 폴더' };
const THUMB_MAX_BYTES = 20_000_000; // 썸네일 생성 전까지는 원본을 쓰므로 너무 큰 이미지는 아이콘으로

const isMod = (e) => e.metaKey || e.ctrlKey;

function parentPath(p) {
  if (p === '/') return null;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function usePersistent(key, initial) {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {}
  }, [key, v]);
  return [v, setV];
}

/**
 * @param {{
 *   user: { role: 'owner' | 'guest', nickname: string, provider: string },
 *   loc: { pathname: string, search: URLSearchParams },
 *   navigate: (url: string, opts?: { replace?: boolean }) => void,
 *   onLogout: () => void,
 * }} props
 */
export function Browser({ user, loc, navigate, onLogout }) {
  const isOwner = user.role === 'owner';
  const source = isOwner && loc.search.get('loc') !== 'demo' ? 'files' : 'demo';
  const path = loc.search.get('path') || '/';

  const [listing, setListing] = useState({ key: null, entries: [], error: null, loading: true });
  const [selected, setSelected] = useState(null); // 선택된 항목의 path
  const [sort, setSort] = usePersistent('wd.sort', { key: 'name', dir: 1 });
  const [view, setView] = usePersistent('wd.view', 'list');
  const [showHidden, setShowHidden] = usePersistent('wd.hidden', false);
  const [quickLook, setQuickLook] = useState(false);
  const [desktop, setDesktop] = useState(null); // 'online' | 'offline' | null
  const [focused, setFocused] = useState(true);

  const contentRef = useRef(null);
  const prevLocation = useRef({ source, path });
  const typeBuffer = useRef({ text: '', at: 0 });

  const locKey = `${source}:${path}`;
  const go = useCallback(
    (nextSource, nextPath) => {
      const params = new URLSearchParams({ loc: nextSource === 'files' ? 'desktop' : 'demo', path: nextPath });
      navigate(`/?${params}`);
    },
    [navigate],
  );

  // ── 목록 불러오기 ──
  const load = useCallback(async () => {
    setListing((l) => ({ ...l, key: locKey, loading: true, error: null }));
    try {
      const r = await api.list(source, path);
      setListing({ key: locKey, entries: r.entries, error: null, loading: false });
    } catch (e) {
      setListing({ key: locKey, entries: [], error: e, loading: false });
      if (e.code === 'AGENT_OFFLINE') setDesktop('offline');
    }
  }, [source, path, locKey]);

  useEffect(() => {
    load();
  }, [load]);

  // 위치가 바뀌면: 상위로 올라온 경우 방금 있던 폴더를 선택 (Finder 동작), 아니면 선택 해제
  useEffect(() => {
    const prev = prevLocation.current;
    prevLocation.current = { source, path };
    setQuickLook(false);
    if (prev.source === source && prev.path !== path && prev.path.startsWith(path === '/' ? '/' : `${path}/`)) {
      const rest = prev.path.slice(path === '/' ? 1 : path.length + 1);
      const child = rest.split('/')[0];
      setSelected(path === '/' ? `/${child}` : `${path}/${child}`);
    } else {
      setSelected(null);
    }
    contentRef.current?.focus({ preventScroll: true });
  }, [source, path]);

  // ── 데스크탑 상태 (15초마다) ──
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .status()
        .then((s) => alive && setDesktop(s.desktop))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // 꺼져 있다가 켜지면 자동으로 다시 불러오기
  useEffect(() => {
    if (desktop === 'online' && source === 'files' && listing.error?.code === 'AGENT_OFFLINE') load();
  }, [desktop, source, listing.error, load]);

  // ── 보이는 항목 ──
  const visible = useMemo(() => {
    const list = showHidden ? listing.entries : listing.entries.filter((e) => !e.hidden);
    return sortEntries(list, sort);
  }, [listing.entries, showHidden, sort]);

  const selIndex = visible.findIndex((e) => e.path === selected);
  const selEntry = selIndex >= 0 ? visible[selIndex] : null;

  // 선택 항목이 보이도록 스크롤
  useEffect(() => {
    if (!selected) return;
    const el = contentRef.current?.querySelector(`[data-path="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected, view]);

  const open = useCallback(
    (entry) => {
      if (!entry || !entry.addressable) return;
      if (entry.type === 'dir') return go(source, entry.path);
      if (entry.type !== 'file') return;
      setSelected(entry.path);
      if (canPreview(entry)) setQuickLook(true);
      else location.assign(contentUrl(source, entry.path, 'attachment'));
    },
    [go, source],
  );

  const columnsInGrid = () => {
    const grid = contentRef.current?.querySelector('.icon-grid');
    const cell = grid?.querySelector('.icon-cell');
    if (!grid || !cell) return 1;
    return Math.max(1, Math.floor(grid.clientWidth / cell.offsetWidth));
  };

  const moveSelection = (delta) => {
    if (visible.length === 0) return;
    const next = selIndex === -1 ? (delta > 0 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, selIndex + delta));
    setSelected(visible[next].path);
  };

  // ── 키보드 ──
  const onKeyDown = (e) => {
    const k = e.key;
    if (k === ' ') {
      e.preventDefault();
      if (quickLook) setQuickLook(false);
      else if (selEntry?.type === 'file' && selEntry.addressable) setQuickLook(true);
      return;
    }
    if (k === 'Escape') {
      if (quickLook) setQuickLook(false);
      else setSelected(null);
      return;
    }
    if (isMod(e) && k === 'ArrowUp') {
      e.preventDefault();
      const up = parentPath(path);
      if (up) go(source, up);
      return;
    }
    if (isMod(e) && k === 'ArrowDown') {
      e.preventDefault();
      open(selEntry);
      return;
    }
    if (isMod(e) && k === '[') return void (e.preventDefault(), history.back());
    if (isMod(e) && k === ']') return void (e.preventDefault(), history.forward());
    if (isMod(e) && e.shiftKey && (k === '.' || k === '>')) {
      e.preventDefault();
      setShowHidden((v) => !v);
      return;
    }
    if (isMod(e) && k.toLowerCase() === 'a') return; // 다중 선택은 쓰기 기능 단계에서

    const grid = view === 'icons';
    if (k === 'ArrowDown') return void (e.preventDefault(), moveSelection(grid ? columnsInGrid() : 1));
    if (k === 'ArrowUp') return void (e.preventDefault(), moveSelection(grid ? -columnsInGrid() : -1));
    if (grid && k === 'ArrowRight') return void (e.preventDefault(), moveSelection(1));
    if (grid && k === 'ArrowLeft') return void (e.preventDefault(), moveSelection(-1));
    if (k === 'Home') return void (e.preventDefault(), visible[0] && setSelected(visible[0].path));
    if (k === 'End') return void (e.preventDefault(), visible.at(-1) && setSelected(visible.at(-1).path));

    // type-select: 1초 안에 친 글자들로 이름 앞부분 찾기
    if (k.length === 1 && !isMod(e) && !e.altKey) {
      const now = Date.now();
      const buf = typeBuffer.current;
      buf.text = now - buf.at > 1000 ? k : buf.text + k;
      buf.at = now;
      const needle = buf.text.toLocaleLowerCase('ko');
      const hit = visible.find((en) => en.name.toLocaleLowerCase('ko').startsWith(needle));
      if (hit) setSelected(hit.path);
    }
  };

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));

  const crumbs = useMemo(() => {
    const segs = path === '/' ? [] : path.slice(1).split('/');
    return [{ name: ROOT_LABEL[source], path: '/' }, ...segs.map((name, i) => ({ name, path: '/' + segs.slice(0, i + 1).join('/') }))];
  }, [source, path]);

  const title = crumbs.at(-1).name;
  const canGoBack = typeof navigation !== 'undefined' ? navigation.canGoBack : true;
  const canGoForward = typeof navigation !== 'undefined' ? navigation.canGoForward : true;
  const stale = listing.key !== locKey;

  useEffect(() => {
    document.title = `${title} — Wooki Drive`;
  }, [title]);

  return (
    <div className={`finder ${focused ? 'is-focused' : ''}`}>
      <aside className="sidebar" aria-label="위치">
        <div className="sidebar-brand">Wooki Drive</div>
        <div className="sidebar-heading">위치</div>
        <nav className="sidebar-list">
          {isOwner && (
            <button type="button" className={`sidebar-item ${source === 'files' ? 'is-active' : ''}`} onClick={() => go('files', '/')}>
              <Glyph name="desktop" />
              <span>데스크탑</span>
              <span className={`status-dot status-${desktop ?? 'unknown'}`} title={desktop === 'online' ? '켜져 있음' : desktop === 'offline' ? '꺼져 있음' : '확인 중'} />
            </button>
          )}
          <button type="button" className={`sidebar-item ${source === 'demo' ? 'is-active' : ''}`} onClick={() => go('demo', '/')}>
            <Glyph name="demo" />
            <span>데모 폴더</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <span className="sidebar-user-name">{user.nickname}</span>
            <span className="sidebar-user-role">{isOwner ? '오너' : '게스트'}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onLogout} title="로그아웃" aria-label="로그아웃">
            <Glyph name="logout" />
          </button>
        </div>
      </aside>

      <section className="pane">
        <header className="toolbar">
          <div className="toolbar-nav">
            <button type="button" className="icon-btn" disabled={!canGoBack} onClick={() => history.back()} title="뒤로 (⌘[)" aria-label="뒤로">
              <Glyph name="back" />
            </button>
            <button type="button" className="icon-btn" disabled={!canGoForward} onClick={() => history.forward()} title="앞으로 (⌘])" aria-label="앞으로">
              <Glyph name="forward" />
            </button>
          </div>
          <h1 className="toolbar-title">{title}</h1>
          <div className="toolbar-actions">
            <div className="segmented" role="group" aria-label="보기">
              <button type="button" className={view === 'icons' ? 'is-on' : ''} onClick={() => setView('icons')} title="아이콘으로 보기" aria-pressed={view === 'icons'}>
                <Glyph name="grid" />
              </button>
              <button type="button" className={view === 'list' ? 'is-on' : ''} onClick={() => setView('list')} title="목록으로 보기" aria-pressed={view === 'list'}>
                <Glyph name="list" />
              </button>
            </div>
            <button
              type="button"
              className="icon-btn"
              disabled={!(selEntry?.type === 'file' && selEntry.addressable)}
              onClick={() => setQuickLook(true)}
              title="훑어보기 (Space)"
              aria-label="훑어보기"
            >
              <Glyph name="eye" />
            </button>
            <a
              className={`icon-btn ${selEntry?.type === 'file' && selEntry.addressable ? '' : 'is-disabled'}`}
              href={selEntry?.type === 'file' && selEntry.addressable ? contentUrl(source, selEntry.path, 'attachment') : undefined}
              title="다운로드"
              aria-label="다운로드"
              aria-disabled={!(selEntry?.type === 'file' && selEntry.addressable)}
            >
              <Glyph name="download" />
            </a>
          </div>
        </header>

        <div
          className={`content ${stale || listing.loading ? 'is-loading' : ''}`}
          ref={contentRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget || e.target.classList.contains('icon-grid') || e.target.classList.contains('rows')) setSelected(null);
          }}
        >
          {listing.error && !stale ? (
            <EmptyState error={listing.error} onRetry={load} />
          ) : view === 'list' ? (
            <ListView entries={visible} selected={selected} sort={sort} onSort={toggleSort} onSelect={setSelected} onOpen={open} />
          ) : (
            <IconView entries={visible} selected={selected} source={source} onSelect={setSelected} onOpen={open} />
          )}
          {!listing.error && !listing.loading && !stale && visible.length === 0 && <p className="empty-folder">빈 폴더</p>}
        </div>

        <footer className="pathbar">
          <ol className="crumbs" aria-label="경로">
            {crumbs.map((c, i) => (
              <li key={c.path}>
                {i > 0 && <Glyph name="chevron" />}
                <button type="button" onClick={() => go(source, c.path)} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                  {i === 0 && <Glyph name={source === 'files' ? 'desktop' : 'demo'} size={12} />}
                  {c.name}
                </button>
              </li>
            ))}
          </ol>
          <span className="pathbar-count">
            {listing.loading || stale ? '불러오는 중…' : listing.error ? '' : `${visible.length}개 항목`}
            {showHidden && ' · 숨김 파일 표시 중'}
          </span>
        </footer>
      </section>

      {quickLook && selEntry?.type === 'file' && (
        <QuickLook
          entry={selEntry}
          source={source}
          onClose={() => {
            setQuickLook(false);
            contentRef.current?.focus({ preventScroll: true });
          }}
          onKeyDown={onKeyDown}
        />
      )}
    </div>
  );
}

function EmptyState({ error, onRetry }) {
  const offline = error.code === 'AGENT_OFFLINE';
  return (
    <div className="empty-state" role="status">
      {offline && <Glyph name="desktop" size={40} />}
      <p>{messageFor(error)}</p>
      {!offline && (
        <button type="button" className="btn" onClick={onRetry}>
          다시 시도
        </button>
      )}
    </div>
  );
}

const COLUMNS = [
  { key: 'name', label: '이름' },
  { key: 'mtime', label: '수정일' },
  { key: 'size', label: '크기' },
  { key: 'kind', label: '종류' },
];

function ListView({ entries, selected, sort, onSort, onSelect, onOpen }) {
  return (
    <div className="list" role="grid" aria-rowcount={entries.length}>
      <div className="list-head" role="row">
        {COLUMNS.map((c) => (
          <button
            key={c.key}
            type="button"
            role="columnheader"
            className={`col col-${c.key} ${sort.key === c.key ? 'is-sorted' : ''}`}
            aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
            onClick={() => onSort(c.key)}
            tabIndex={-1}
          >
            {c.label}
            {sort.key === c.key && <span className="sort-arrow">{sort.dir === 1 ? '▲' : '▼'}</span>}
          </button>
        ))}
      </div>
      <div className="rows">
        {entries.map((e) => (
          <div
            key={e.name}
            role="row"
            data-path={e.path ?? ''}
            aria-selected={e.path === selected}
            className={`row ${e.path === selected ? 'is-selected' : ''} ${e.addressable ? '' : 'is-disabled'} ${e.hidden ? 'is-hidden' : ''}`}
            title={e.addressable ? undefined : '이름 때문에 웹에서 열 수 없는 항목이에요'}
            onMouseDown={() => e.addressable && onSelect(e.path)}
            onDoubleClick={() => onOpen(e)}
          >
            <span className="col col-name" role="gridcell">
              <EntryIcon entry={e} size={16} />
              <span className="name-text">{e.name}</span>
            </span>
            <span className="col col-mtime" role="gridcell">{formatDate(e.mtimeMs)}</span>
            <span className="col col-size" role="gridcell">{e.type === 'file' ? formatSize(e.size) : '--'}</span>
            <span className="col col-kind" role="gridcell">{kindLabel(e)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function IconView({ entries, selected, source, onSelect, onOpen }) {
  return (
    <div className="icon-grid" role="grid">
      {entries.map((e) => {
        const thumb = e.addressable && kindOf(e) === 'image' && e.size != null && e.size <= THUMB_MAX_BYTES;
        return (
          <div
            key={e.name}
            role="gridcell"
            data-path={e.path ?? ''}
            aria-selected={e.path === selected}
            className={`icon-cell ${e.path === selected ? 'is-selected' : ''} ${e.addressable ? '' : 'is-disabled'} ${e.hidden ? 'is-hidden' : ''}`}
            onMouseDown={() => e.addressable && onSelect(e.path)}
            onDoubleClick={() => onOpen(e)}
          >
            <div className="icon-art">
              {thumb ? <img src={contentUrl(source, e.path)} alt="" loading="lazy" decoding="async" draggable={false} /> : <EntryIcon entry={e} size={64} />}
            </div>
            <span className="icon-label">{e.name}</span>
          </div>
        );
      })}
    </div>
  );
}

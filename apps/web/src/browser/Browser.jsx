// Finder 스타일 탐색기.
//
// 위치는 URL 에 둔다: /?loc=desktop|demo|trash&path=/a/b  → 브라우저 뒤로·앞으로가 그대로 Finder 의 뒤로·앞으로가 된다.
//
// 단축키 (맥은 ⌘, 윈도우는 Ctrl):
//   ↑ ↓ (아이콘 보기에선 ← → 도), ⇧+방향키 범위 선택     ⌘A 모두 선택
//   컬럼 보기: → 폴더 안으로, ← 상위 컬럼으로
//   ⌘↓ / 더블클릭 열기     ⌘↑ 상위 폴더     ⌘[ ⌘] 뒤로 / 앞으로
//   Space Quick Look       Enter 이름 변경   ⌘⌫ / Delete 휴지통으로
//   ⌘⇧N 새 폴더           ⌘⇧. 숨김 파일     글자 입력 이름으로 이동
// 마우스: ⌘클릭 추가/해제, ⇧클릭 범위, 끌어서 폴더·경로 막대로 이동, 바탕화면 파일을 끌어다 놓아 업로드, 우클릭 메뉴.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, contentUrl, zipUrl } from '../api.js';
import { messageFor } from '../messages.js';
import { uploads, collectDropped, collectPicked } from '../uploads.js';
import { sortEntries, kindLabel, formatSize, formatDate, canPreview, kindOf } from './fileTypes.js';
import { EntryIcon, Glyph } from './icons.jsx';
import { Thumb, thumbSrc, RenameInput } from './parts.jsx';
import { ColumnView } from './ColumnView.jsx';
import { QuickLook } from './QuickLook.jsx';
import { TrashView } from './TrashView.jsx';
import { UploadPanel } from './UploadPanel.jsx';
import { ConfirmDialog, ContextMenu, Toast } from './Overlays.jsx';

const ROOT_LABEL = { files: '데스크탑', demo: '데모 폴더', trash: '휴지통' };
const DRAG_TYPE = 'application/x-wooki-paths';

const VIEWS = [
  ['icons', '아이콘'],
  ['list', '목록'],
  ['columns', '컬럼'],
];

const isMod = (e) => e.metaKey || e.ctrlKey;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

function parentPath(p) {
  if (p === '/') return null;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

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
  const locParam = loc.search.get('loc');
  const source = !isOwner ? 'demo' : locParam === 'demo' ? 'demo' : locParam === 'trash' ? 'trash' : 'files';
  const path = source === 'trash' ? '/' : loc.search.get('path') || '/';
  const writable = isOwner && source === 'files';

  const [listing, setListing] = useState({ key: null, entries: [], error: null, loading: true });
  const [selected, setSelected] = useState(() => new Set());
  const [lead, setLead] = useState(null); // 키보드 기준 항목 (Quick Look·이름 변경 대상)
  const anchor = useRef(null); // ⇧ 범위 선택 기준
  const [renaming, setRenaming] = useState(null);
  const [sort, setSort] = usePersistent('wd.sort', { key: 'name', dir: 1 });
  const [view, setView] = usePersistent('wd.view', 'list');
  const [showHidden, setShowHidden] = usePersistent('wd.hidden', false);
  const [quickLook, setQuickLook] = useState(false);
  const [desktop, setDesktop] = useState(null);
  const [focused, setFocused] = useState(true);
  const [toast, setToast] = useState(null);
  const [menu, setMenu] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // 폴더 경로 또는 '@here'
  const [dragging, setDragging] = useState(null); // 내부 드래그 중인 경로들

  const contentRef = useRef(null);
  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const prevLocation = useRef({ source, path });
  const typeBuffer = useRef({ text: '', at: 0 });
  const pendingSelect = useRef(null); // 목록 새로고침 뒤 선택할 경로들
  const navSelect = useRef(undefined); // 이동 직후 선택할 항목 (컬럼 보기에서 다른 컬럼을 누를 때). null = 선택 없음
  const lastLoaded = useRef(null);
  /** 컬럼 보기용 다른 폴더 목록 캐시: `${source}:${folder}` → { entries, error } */
  const [folders, setFolders] = useState({});
  const folderFetching = useRef(new Set());

  const locKey = `${source}:${path}`;
  const go = useCallback(
    (nextSource, nextPath = '/') => {
      const l = nextSource === 'files' ? 'desktop' : nextSource;
      const params = new URLSearchParams(nextSource === 'trash' ? { loc: l } : { loc: l, path: nextPath });
      navigate(`/?${params}`);
    },
    [navigate],
  );
  const notify = useCallback((t) => setToast(t), []);
  const closeToast = useCallback(() => setToast(null), []);
  const focusContent = () => contentRef.current?.focus({ preventScroll: true });

  // ── 목록 불러오기 ──
  const load = useCallback(async () => {
    if (source === 'trash') return;
    // 같은 폴더를 다시 불러오는 것 = 쓰기 뒤 새로고침 → 다른 컬럼 목록도 낡았을 수 있다
    if (lastLoaded.current === locKey) setFolders({});
    lastLoaded.current = locKey;
    setListing((l) => ({ ...l, key: locKey, loading: true, error: null }));
    try {
      const r = await api.list(source, path);
      setListing({ key: locKey, entries: r.entries, error: null, loading: false });
      if (pendingSelect.current) {
        const want = pendingSelect.current;
        pendingSelect.current = null;
        setSelected(new Set(want));
        setLead(want.at(-1) ?? null);
      }
    } catch (e) {
      setListing({ key: locKey, entries: [], error: e, loading: false });
      if (e.code === 'AGENT_OFFLINE') setDesktop('offline');
    }
  }, [source, path, locKey]);

  useEffect(() => {
    load();
  }, [load]);

  const selectOnly = useCallback((p) => {
    setSelected(p ? new Set([p]) : new Set());
    setLead(p);
    anchor.current = p;
  }, []);

  // 위치가 바뀌면: 상위로 올라온 경우 방금 있던 폴더를 선택 (Finder 동작), 아니면 선택 해제
  useEffect(() => {
    const prev = prevLocation.current;
    prevLocation.current = { source, path };
    setQuickLook(false);
    setRenaming(null);
    const want = navSelect.current;
    navSelect.current = undefined;
    if (want !== undefined) {
      selectOnly(want);
    } else if (prev.source === source && prev.path !== path && prev.path.startsWith(path === '/' ? '/' : `${path}/`)) {
      const rest = prev.path.slice(path === '/' ? 1 : path.length + 1);
      selectOnly(joinPath(path, rest.split('/')[0]));
    } else {
      selectOnly(null);
    }
    focusContent();
  }, [source, path, selectOnly]);

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

  // ── 휴지통 알림 (D20): 접속 시 한 번, 30일 넘은 항목이나 큰 용량이면 배너. 닫으면 이 탭에선 다시 안 띄움 ──
  const [trashNotice, setTrashNotice] = useState(null);
  useEffect(() => {
    if (!isOwner || sessionStorage.getItem('wd.trashNoticeSeen')) return;
    api
      .trashSummary()
      .then((s) => s.notice && setTrashNotice(s))
      .catch(() => {}); // 데스크탑 꺼짐 등 — 조용히 넘어감
  }, [isOwner]);
  const dismissTrashNotice = () => {
    sessionStorage.setItem('wd.trashNoticeSeen', '1');
    setTrashNotice(null);
  };

  // 꺼져 있다가 켜지면 자동으로 다시 불러오기
  useEffect(() => {
    if (desktop === 'online' && source === 'files' && listing.error?.code === 'AGENT_OFFLINE') load();
  }, [desktop, source, listing.error, load]);

  // 업로드가 현재 폴더에 끝나면 목록 새로고침 (여러 개가 연달아 끝나도 한 번만)
  useEffect(() => {
    let t;
    return uploads.onComplete((finalPath) => {
      if (source !== 'files') return;
      if (!finalPath.startsWith(path === '/' ? '/' : `${path}/`)) return;
      clearTimeout(t);
      t = setTimeout(load, 400);
    });
  }, [source, path, load]);

  // ── 보이는 항목 ──
  const visible = useMemo(() => {
    const list = showHidden ? listing.entries : listing.entries.filter((e) => !e.hidden);
    return sortEntries(list, sort);
  }, [listing.entries, showHidden, sort]);

  const shown = useCallback((entries) => sortEntries(showHidden ? entries : entries.filter((e) => !e.hidden), sort), [showHidden, sort]);

  // ── 컬럼 보기: 상위 폴더들 + (폴더를 골랐으면) 그 안 목록 ──
  const columnMode = view === 'columns' && source !== 'trash';
  const ancestors = useMemo(() => {
    if (path === '/') return [];
    const segs = path.slice(1).split('/');
    return segs.map((_, i) => (i === 0 ? '/' : '/' + segs.slice(0, i).join('/')));
  }, [path]);
  const peekEntry = selected.size === 1 ? listing.entries.find((e) => e.path === lead) : null;
  const peekFolder = columnMode && listing.key === locKey && peekEntry?.type === 'dir' && peekEntry.addressable ? peekEntry.path : null;

  const ensureFolder = useCallback(
    (folder) => {
      const key = `${source}:${folder}`;
      if (folders[key] || folderFetching.current.has(key)) return;
      folderFetching.current.add(key);
      api
        .list(source, folder)
        .then((r) => setFolders((f) => ({ ...f, [key]: { entries: r.entries } })))
        .catch((error) => setFolders((f) => ({ ...f, [key]: { entries: [], error } })))
        .finally(() => folderFetching.current.delete(key));
    },
    [source, folders],
  );

  useEffect(() => {
    if (!columnMode) return;
    for (const a of ancestors) ensureFolder(a);
  }, [columnMode, ancestors, ensureFolder]);

  useEffect(() => {
    if (!peekFolder) return;
    const t = setTimeout(() => ensureFolder(peekFolder), 120); // 방향키로 훑을 때 요청 폭주 방지
    return () => clearTimeout(t);
  }, [peekFolder, ensureFolder]);

  const leadIndex = visible.findIndex((e) => e.path === lead);
  const leadEntry = leadIndex >= 0 ? visible[leadIndex] : null;
  const selEntries = visible.filter((e) => selected.has(e.path));

  useEffect(() => {
    if (!lead) return;
    const el = contentRef.current?.querySelector(`[data-path="${CSS.escape(lead)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [lead, view]);

  // ── 동작 ──
  /**
   * 내려받기: 파일 하나는 그대로, 폴더나 여러 항목은 zip.
   * 브라우저 다운로드는 오류 응답을 화면에 띄워 버리므로, 먼저 가볍게 확인(데스크탑 꺼짐·세션 만료)하고 넘긴다.
   */
  const download = useCallback(
    async (entries) => {
      const list = entries.filter((e) => e.addressable && (e.type === 'file' || e.type === 'dir'));
      if (!list.length) return;
      const single = list.length === 1 && list[0].type === 'file';
      const url = single ? contentUrl(source, list[0].path, 'attachment') : zipUrl(source, list.map((e) => e.path));
      if (url.length > 6000) return notify({ kind: 'error', text: '한 번에 고른 항목이 너무 많아요. 폴더째로 내려받아 보세요.' });
      try {
        await api.stat(source, list[0].path);
      } catch (e) {
        return notify({ kind: 'error', text: messageFor(e) });
      }
      location.assign(url);
    },
    [source, notify],
  );

  const open = useCallback(
    (entry) => {
      if (!entry || !entry.addressable) return;
      if (entry.type === 'dir') return go(source, entry.path);
      if (entry.type !== 'file') return;
      selectOnly(entry.path);
      if (canPreview(entry)) setQuickLook(true);
      else download([entry]);
    },
    [go, source, selectOnly, download],
  );

  const failMsg = (results, verb) => {
    const failed = results.filter((r) => r.error);
    if (failed.length) notify({ kind: 'error', text: `${failed.length}개를 ${verb}하지 못했어요: ${messageFor(failed[0].error)}` });
    return failed;
  };

  async function newFolder() {
    if (!writable) return;
    try {
      const { path: created } = await api.mkdir(path, '새 폴더', 'rename');
      pendingSelect.current = [created];
      await load();
      setRenaming(created);
    } catch (e) {
      notify({ kind: 'error', text: messageFor(e) });
    }
  }

  async function commitRename(entry, name) {
    setRenaming(null);
    focusContent();
    const trimmed = name.trim();
    if (!trimmed || trimmed === entry.name) return;
    try {
      const { path: renamed } = await api.rename(entry.path, trimmed);
      pendingSelect.current = [renamed];
      await load();
    } catch (e) {
      notify({ kind: 'error', text: messageFor(e) });
    }
  }

  /** 경로를 명시적으로 받는다 — 우클릭 직후처럼 선택 상태가 아직 갱신 전일 때 엉뚱한 항목을 지우지 않도록 */
  async function trashPaths(paths) {
    if (!writable || paths.length === 0) return;
    try {
      const { results } = await api.trash(paths);
      const ok = results.filter((r) => r.id);
      const failed = failMsg(results, '휴지통으로 이동');
      if (!failed.length) {
        notify({
          text: ok.length === 1 ? `'${paths[0].split('/').pop()}'을(를) 휴지통으로 옮겼어요.` : `${ok.length}개 항목을 휴지통으로 옮겼어요.`,
          action: {
            label: '되돌리기',
            run: async () => {
              try {
                const r = await api.trashRestore(ok.map((x) => x.id));
                failMsg(r.results, '복원');
                pendingSelect.current = r.results.filter((x) => x.path).map((x) => x.path);
                load();
              } catch (e) {
                notify({ kind: 'error', text: messageFor(e) });
              }
            },
          },
        });
      }
      selectOnly(null);
      await load();
    } catch (e) {
      notify({ kind: 'error', text: messageFor(e) });
    }
  }

  const trashSelected = () => trashPaths(selEntries.map((e) => e.path));

  async function moveTo(paths, dest, onConflict = 'fail') {
    const movable = paths.filter((p) => parentPath(p) !== dest && p !== dest);
    if (!movable.length) return;
    try {
      const { results } = await api.move(movable, dest, onConflict);
      const conflicts = results.filter((r) => r.error === 'ALREADY_EXISTS').map((r) => r.from);
      const other = results.filter((r) => r.error && r.error !== 'ALREADY_EXISTS');
      if (other.length) failMsg(other, '옮기');
      if (conflicts.length) {
        setConfirm({
          title: `같은 이름의 항목이 ${conflicts.length}개 있어요.`,
          message: '둘 다 유지하면 옮기는 항목 이름 뒤에 번호가 붙어요.',
          confirmLabel: '둘 다 유지',
          run: () => moveTo(conflicts, dest, 'rename'),
        });
      } else if (!other.length) {
        const name = dest === '/' ? ROOT_LABEL.files : dest.split('/').pop();
        notify({ text: `${results.length}개 항목을 '${name}'(으)로 옮겼어요.` });
      }
      await load();
    } catch (e) {
      notify({ kind: 'error', text: messageFor(e) });
    }
  }

  function pickUpload(kind) {
    (kind === 'folder' ? folderInput : fileInput).current?.click();
  }

  // ── 선택 ──
  function clickSelect(entry, e) {
    if (!entry.addressable) return;
    const p = entry.path;
    if (e.shiftKey && anchor.current) {
      const a = visible.findIndex((x) => x.path === anchor.current);
      const b = visible.findIndex((x) => x.path === p);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        const range = visible.slice(from, to + 1).filter((x) => x.addressable).map((x) => x.path);
        setSelected(new Set(isMod(e) ? [...selected, ...range] : range));
        setLead(p);
        return;
      }
    }
    if (isMod(e)) {
      const n = new Set(selected);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      setSelected(n);
      setLead(p);
      anchor.current = p;
      return;
    }
    // 이미 선택된 여러 항목 중 하나를 누르면 (끌기 시작일 수 있으니) 선택 유지
    if (selected.has(p) && selected.size > 1) {
      setLead(p);
      return;
    }
    selectOnly(p);
  }

  const columnsInGrid = () => {
    const grid = contentRef.current?.querySelector('.icon-grid');
    const cell = grid?.querySelector('.icon-cell');
    if (!grid || !cell) return 1;
    return Math.max(1, Math.floor(grid.clientWidth / cell.offsetWidth));
  };

  const moveLead = (delta, extend) => {
    if (visible.length === 0) return;
    const next = leadIndex === -1 ? (delta > 0 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, leadIndex + delta));
    const p = visible[next].path;
    if (!p) return;
    if (extend && anchor.current) {
      const a = visible.findIndex((x) => x.path === anchor.current);
      const [from, to] = a < next ? [a, next] : [next, a];
      setSelected(new Set(visible.slice(from, to + 1).filter((x) => x.addressable).map((x) => x.path)));
      setLead(p);
    } else {
      selectOnly(p);
    }
  };

  // ── 키보드 ──
  const onKeyDown = (e) => {
    if (renaming || confirm || menu) return;
    const k = e.key;
    if (k === ' ') {
      e.preventDefault();
      if (quickLook) setQuickLook(false);
      else if (leadEntry?.type === 'file' && leadEntry.addressable) setQuickLook(true);
      return;
    }
    if (k === 'Escape') {
      if (quickLook) setQuickLook(false);
      else selectOnly(null);
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
      open(leadEntry);
      return;
    }
    if (isMod(e) && k === '[') return void (e.preventDefault(), history.back());
    if (isMod(e) && k === ']') return void (e.preventDefault(), history.forward());
    if (isMod(e) && e.shiftKey && (k === '.' || k === '>')) return void (e.preventDefault(), setShowHidden((v) => !v));
    if (isMod(e) && e.shiftKey && k.toLowerCase() === 'n') return void (e.preventDefault(), newFolder());
    if (isMod(e) && k.toLowerCase() === 'a') {
      e.preventDefault();
      const all = visible.filter((x) => x.addressable).map((x) => x.path);
      setSelected(new Set(all));
      if (!lead && all.length) setLead(all[0]);
      return;
    }
    if ((isMod(e) && k === 'Backspace') || k === 'Delete') return void (e.preventDefault(), trashSelected());
    if (k === 'Enter') {
      e.preventDefault();
      if (writable && leadEntry?.addressable && !quickLook) setRenaming(leadEntry.path);
      return;
    }

    if (columnMode && k === 'ArrowRight') {
      e.preventDefault();
      if (leadEntry?.type !== 'dir' || !leadEntry.addressable || selected.size !== 1) return;
      const inside = folders[`${source}:${leadEntry.path}`];
      const first = inside && !inside.error ? shown(inside.entries).find((x) => x.addressable) : null;
      navSelect.current = first?.path ?? null;
      go(source, leadEntry.path);
      return;
    }
    if (columnMode && k === 'ArrowLeft') {
      e.preventDefault();
      const up = parentPath(path);
      if (up) go(source, up);
      return;
    }

    const grid = view === 'icons';
    if (k === 'ArrowDown') return void (e.preventDefault(), moveLead(grid ? columnsInGrid() : 1, e.shiftKey));
    if (k === 'ArrowUp') return void (e.preventDefault(), moveLead(grid ? -columnsInGrid() : -1, e.shiftKey));
    if (grid && k === 'ArrowRight') return void (e.preventDefault(), moveLead(1, e.shiftKey));
    if (grid && k === 'ArrowLeft') return void (e.preventDefault(), moveLead(-1, e.shiftKey));
    if (k === 'Home') return void (e.preventDefault(), visible[0] && selectOnly(visible[0].path));
    if (k === 'End') return void (e.preventDefault(), visible.at(-1) && selectOnly(visible.at(-1).path));

    if (k.length === 1 && !isMod(e) && !e.altKey) {
      const now = Date.now();
      const buf = typeBuffer.current;
      buf.text = now - buf.at > 1000 ? k : buf.text + k;
      buf.at = now;
      const needle = buf.text.toLocaleLowerCase('ko');
      const hit = visible.find((en) => en.name.toLocaleLowerCase('ko').startsWith(needle));
      if (hit?.path) selectOnly(hit.path);
    }
  };

  // ── 끌어다 놓기 ──
  const dragProps = (entry) =>
    writable && entry.addressable
      ? {
          draggable: renaming !== entry.path,
          onDragStart: (e) => {
            const paths = selected.has(entry.path) ? [...selected] : [entry.path];
            if (!selected.has(entry.path)) selectOnly(entry.path);
            e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
            e.dataTransfer.effectAllowed = 'move';
            setDragging(paths);
          },
          onDragEnd: () => {
            setDragging(null);
            setDropTarget(null);
          },
        }
      : {};

  /** 폴더(항목·경로 막대)를 놓을 곳으로 */
  const dropProps = (folderPath) =>
    writable
      ? {
          onDragOver: (e) => {
            const internal = e.dataTransfer.types.includes(DRAG_TYPE);
            const files = e.dataTransfer.types.includes('Files');
            if (!internal && !files) return;
            if (internal && dragging?.some((p) => folderPath === p || folderPath.startsWith(`${p}/`))) return; // 자기 안으로 X
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
            setDropTarget(folderPath);
          },
          onDragLeave: (e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget((t) => (t === folderPath ? null : t));
          },
          onDrop: async (e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(null);
            const raw = e.dataTransfer.getData(DRAG_TYPE);
            if (raw) {
              setDragging(null);
              moveTo(JSON.parse(raw), folderPath);
            } else if (e.dataTransfer.types.includes('Files')) {
              uploads.add(await collectDropped(e.dataTransfer, folderPath));
            }
          },
        }
      : {};

  // 내용 영역 바탕 = 현재 폴더에 업로드 (내부 이동은 같은 폴더라 무시)
  const contentDrop = writable
    ? {
        onDragOver: (e) => {
          if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropTarget('@here');
        },
        onDragLeave: (e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget((t) => (t === '@here' ? null : t));
        },
        onDrop: async (e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDropTarget(null);
          uploads.add(await collectDropped(e.dataTransfer, path));
        },
      }
    : {};

  // ── 우클릭 메뉴 ──
  function openMenu(e, entry) {
    e.preventDefault();
    if (entry && entry.addressable && !selected.has(entry.path)) selectOnly(entry.path);
    const many = entry && selected.has(entry.path) && selected.size > 1;
    const items = [];
    if (entry && entry.addressable) {
      items.push({ label: '열기', shortcut: `${MOD}↓`, run: () => open(entry), disabled: many });
      if (entry.type === 'file') {
        items.push({ label: '훑어보기', shortcut: 'Space', run: () => (selectOnly(entry.path), setQuickLook(true)), disabled: many || !canPreview(entry) });
      }
      if (entry.type === 'file' || entry.type === 'dir') {
        const targets = many ? selEntries : [entry];
        const zip = targets.length > 1 || entry.type === 'dir';
        items.push({ label: many ? `${targets.length}개 항목 내려받기 (zip)` : zip ? 'zip으로 내려받기' : '내려받기', run: () => download(targets) });
      }
      if (writable) {
        items.push('sep');
        items.push({ label: '이름 변경', shortcut: 'Enter', run: () => setRenaming(entry.path), disabled: many });
        const targets = many ? [...selected] : [entry.path];
        items.push({ label: many ? `${targets.length}개 항목을 휴지통으로` : '휴지통으로 이동', shortcut: `${MOD}⌫`, danger: true, run: () => trashPaths(targets) });
      }
    } else {
      if (writable) {
        items.push({ label: '새 폴더', shortcut: `${MOD}⇧N`, run: newFolder });
        items.push({ label: '파일 올리기…', run: () => pickUpload('file') });
        items.push({ label: '폴더 올리기…', run: () => pickUpload('folder') });
        items.push('sep');
      }
      items.push({ label: showHidden ? '숨김 파일 가리기' : '숨김 파일 보기', shortcut: `${MOD}⇧.`, run: () => setShowHidden((v) => !v) });
      for (const [v, label] of VIEWS) if (v !== view) items.push({ label: `${label}으로 보기`, run: () => setView(v) });
    }
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
  }

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));

  const crumbs = useMemo(() => {
    const segs = path === '/' ? [] : path.slice(1).split('/');
    return [{ name: ROOT_LABEL[source], path: '/' }, ...segs.map((name, i) => ({ name, path: '/' + segs.slice(0, i + 1).join('/') }))];
  }, [source, path]);

  const title = crumbs.at(-1).name;
  const canGoBack = typeof navigation !== 'undefined' ? navigation.canGoBack : true;
  const canGoForward = typeof navigation !== 'undefined' ? navigation.canGoForward : true;
  const stale = listing.key !== locKey;
  const oneFile = selEntries.length === 1 && selEntries[0].type === 'file' ? selEntries[0] : null;

  useEffect(() => {
    document.title = `${title} — Wooki Drive`;
  }, [title]);

  const itemProps = {
    selected,
    lead,
    renaming,
    dropTarget,
    source,
    onSelect: clickSelect,
    onOpen: open,
    onMenu: openMenu,
    onRename: commitRename,
    onCancelRename: () => {
      setRenaming(null);
      focusContent();
    },
    dragProps,
    dropProps,
  };

  return (
    <div className={`finder ${focused ? 'is-focused' : ''}`}>
      <aside className="sidebar" aria-label="위치">
        <div className="sidebar-brand">Wooki Drive</div>
        <div className="sidebar-heading">위치</div>
        <nav className="sidebar-list">
          {isOwner && (
            <button type="button" className={`sidebar-item ${source === 'files' ? 'is-active' : ''} ${dropTarget === '/' && source !== 'files' ? 'is-drop' : ''}`} onClick={() => go('files', '/')}>
              <Glyph name="desktop" />
              <span>데스크탑</span>
              <span className={`status-dot status-${desktop ?? 'unknown'}`} title={desktop === 'online' ? '켜져 있음' : desktop === 'offline' ? '꺼져 있음' : '확인 중'} />
            </button>
          )}
          <button type="button" className={`sidebar-item ${source === 'demo' ? 'is-active' : ''}`} onClick={() => go('demo', '/')}>
            <Glyph name="demo" />
            <span>데모 폴더</span>
          </button>
          {isOwner && (
            <button type="button" className={`sidebar-item ${source === 'trash' ? 'is-active' : ''}`} onClick={() => go('trash')}>
              <Glyph name="trash" />
              <span>휴지통</span>
            </button>
          )}
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
            <button type="button" className="icon-btn" disabled={!canGoBack} onClick={() => history.back()} title={`뒤로 (${MOD}[)`} aria-label="뒤로">
              <Glyph name="back" />
            </button>
            <button type="button" className="icon-btn" disabled={!canGoForward} onClick={() => history.forward()} title={`앞으로 (${MOD}])`} aria-label="앞으로">
              <Glyph name="forward" />
            </button>
          </div>
          <h1 className="toolbar-title">{title}</h1>
          {source !== 'trash' && (
            <div className="toolbar-actions">
              {writable && (
                <>
                  <button type="button" className="icon-btn" onClick={newFolder} title={`새 폴더 (${MOD}⇧N)`} aria-label="새 폴더">
                    <Glyph name="newfolder" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="올리기"
                    aria-label="올리기"
                    aria-haspopup="menu"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setMenu({
                        x: r.left,
                        y: r.bottom + 4,
                        items: [
                          { label: '파일 올리기…', run: () => pickUpload('file') },
                          { label: '폴더 올리기…', run: () => pickUpload('folder') },
                        ],
                      });
                    }}
                  >
                    <Glyph name="upload" />
                  </button>
                  <button type="button" className="icon-btn" disabled={!selEntries.length} onClick={trashSelected} title={`휴지통으로 이동 (${MOD}⌫)`} aria-label="휴지통으로 이동">
                    <Glyph name="trash" />
                  </button>
                  <span className="toolbar-sep" />
                </>
              )}
              <div className="segmented" role="group" aria-label="보기">
                <button type="button" className={view === 'icons' ? 'is-on' : ''} onClick={() => setView('icons')} title="아이콘으로 보기" aria-pressed={view === 'icons'}>
                  <Glyph name="grid" />
                </button>
                <button type="button" className={view === 'list' ? 'is-on' : ''} onClick={() => setView('list')} title="목록으로 보기" aria-pressed={view === 'list'}>
                  <Glyph name="list" />
                </button>
                <button type="button" className={view === 'columns' ? 'is-on' : ''} onClick={() => setView('columns')} title="컬럼으로 보기" aria-pressed={view === 'columns'}>
                  <Glyph name="columns" />
                </button>
              </div>
              <button type="button" className="icon-btn" disabled={!(oneFile && canPreview(oneFile))} onClick={() => (selectOnly(oneFile.path), setQuickLook(true))} title="훑어보기 (Space)" aria-label="훑어보기">
                <Glyph name="eye" />
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={!selEntries.some((e) => e.type === 'file' || e.type === 'dir')}
                onClick={() => download(selEntries)}
                title={oneFile ? '내려받기' : '내려받기 (폴더·여러 항목은 zip)'}
                aria-label="내려받기"
              >
                <Glyph name="download" />
              </button>
            </div>
          )}
        </header>

        <div className="banner-slot">
          {trashNotice && (
            <div className="banner" role="status">
              <Glyph name="trash" />
              <span className="banner-text">
                {trashNotice.notice.old && trashNotice.notice.large
                  ? `휴지통에 ${trashNotice.notice.days}일이 지난 항목이 있고, 용량이 ${formatSize(trashNotice.totalBytes)}예요.`
                  : trashNotice.notice.old
                    ? `휴지통에 ${trashNotice.notice.days}일이 지난 항목이 있어요. (${trashNotice.count}개, ${formatSize(trashNotice.totalBytes)})`
                    : `휴지통 용량이 ${formatSize(trashNotice.totalBytes)}예요. (${trashNotice.count}개)`}
              </span>
              {source !== 'trash' && (
                <button
                  type="button"
                  className="btn banner-action"
                  onClick={() => {
                    dismissTrashNotice();
                    go('trash');
                  }}
                >
                  휴지통 열기
                </button>
              )}
              <button type="button" className="icon-btn" onClick={dismissTrashNotice} aria-label="알림 닫기" title="닫기">
                <Glyph name="close" />
              </button>
            </div>
          )}
        </div>

        {source === 'trash' ? (
          <div className="content trash-content" tabIndex={-1}>
            <TrashView onToast={notify} focused={focused} />
          </div>
        ) : (
          <div
            className={`content ${columnMode ? 'is-columns' : ''} ${stale || listing.loading ? 'is-loading' : ''} ${dropTarget === '@here' ? 'is-drop' : ''}`}
            ref={contentRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
            onMouseDown={(e) => {
              if (e.button === 0 && (e.target === e.currentTarget || e.target.classList.contains('icon-grid') || e.target.classList.contains('rows'))) selectOnly(null);
            }}
            onContextMenu={(e) => {
              if (e.target === e.currentTarget || e.target.classList.contains('icon-grid') || e.target.classList.contains('rows')) openMenu(e, null);
            }}
            {...contentDrop}
          >
            {listing.error && !stale ? (
              <EmptyState error={listing.error} onRetry={load} />
            ) : columnMode ? (
              <ColumnView
                {...itemProps}
                columns={[
                  ...ancestors.map((folder, i) => {
                    const c = folders[`${source}:${folder}`];
                    return { folder, entries: c ? shown(c.entries) : null, error: c?.error, active: false, highlight: ancestors[i + 1] ?? path };
                  }),
                  { folder: path, entries: stale ? null : visible, active: true, highlight: null },
                  ...(peekFolder ? [peekColumn(folders[`${source}:${peekFolder}`], peekFolder, shown)] : []),
                ]}
                preview={selected.size === 1 && leadEntry?.type === 'file' ? leadEntry : null}
                path={path}
                onPick={(folder, entry, ev) => {
                  if (folder === path) {
                    if (entry) clickSelect(entry, ev);
                    else selectOnly(null);
                    return;
                  }
                  if (entry && !entry.addressable) return;
                  navSelect.current = entry?.path ?? null;
                  go(source, folder);
                }}
                onMenu={(ev, entry, folder) => {
                  if (folder !== path) {
                    ev.preventDefault();
                    if (entry && !entry.addressable) return;
                    navSelect.current = entry?.path ?? null;
                    go(source, folder);
                    return;
                  }
                  openMenu(ev, entry);
                }}
              />
            ) : view === 'list' ? (
              <ListView entries={visible} sort={sort} onSort={toggleSort} {...itemProps} />
            ) : (
              <IconView entries={visible} {...itemProps} />
            )}
            {!columnMode && !listing.error && !listing.loading && !stale && visible.length === 0 && (
              <p className="empty-folder">{writable ? '빈 폴더 · 파일을 끌어다 놓으면 올라가요' : '빈 폴더'}</p>
            )}
          </div>
        )}

        <footer className="pathbar">
          <ol className="crumbs" aria-label="경로">
            {crumbs.map((c, i) => (
              <li key={c.path}>
                {i > 0 && <Glyph name="chevron" />}
                <button
                  type="button"
                  onClick={() => go(source, c.path)}
                  aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                  className={dropTarget === c.path ? 'is-drop' : ''}
                  {...(i < crumbs.length - 1 ? dropProps(c.path) : {})}
                >
                  {i === 0 && <Glyph name={source === 'files' ? 'desktop' : source === 'trash' ? 'trash' : 'demo'} size={12} />}
                  {c.name}
                </button>
              </li>
            ))}
          </ol>
          {source !== 'trash' && (
            <span className="pathbar-count">
              {listing.loading || stale
                ? '불러오는 중…'
                : listing.error
                  ? ''
                  : selected.size > 0
                    ? `${visible.length}개 중 ${selected.size}개 선택`
                    : `${visible.length}개 항목`}
              {showHidden && ' · 숨김 파일 표시 중'}
            </span>
          )}
        </footer>
      </section>

      {quickLook && leadEntry?.type === 'file' && (
        <QuickLook
          entry={leadEntry}
          source={source}
          onClose={() => {
            setQuickLook(false);
            focusContent();
          }}
          onKeyDown={onKeyDown}
        />
      )}

      {writable && (
        <>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              uploads.add(collectPicked(e.target.files, path));
              e.target.value = '';
            }}
          />
          <input
            ref={folderInput}
            type="file"
            hidden
            webkitdirectory=""
            onChange={(e) => {
              uploads.add(collectPicked(e.target.files, path));
              e.target.value = '';
            }}
          />
        </>
      )}

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={() => {
            const run = confirm.run;
            setConfirm(null);
            run();
          }}
          onCancel={() => {
            setConfirm(null);
            focusContent();
          }}
        />
      )}
      <UploadPanel />
      <Toast toast={toast} onClose={closeToast} />
    </div>
  );
}

/** 컬럼 보기에서 고른 폴더의 안쪽 목록 (아직 이동하지 않은 미리 보기 컬럼) */
function peekColumn(cached, folder, shown) {
  return { folder, entries: cached ? shown(cached.entries) : null, error: cached?.error, active: false, highlight: null };
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

function ListView({ entries, sort, onSort, selected, lead, renaming, dropTarget, onSelect, onOpen, onMenu, onRename, onCancelRename, dragProps, dropProps }) {
  return (
    <div className="list" role="grid" aria-multiselectable="true" aria-rowcount={entries.length}>
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
        {entries.map((e) => {
          const on = selected.has(e.path);
          return (
            <div
              key={e.name}
              role="row"
              data-path={e.path ?? ''}
              aria-selected={on}
              className={`row ${on ? 'is-selected' : ''} ${e.path === lead ? 'is-lead' : ''} ${e.addressable ? '' : 'is-disabled'} ${e.hidden ? 'is-hidden' : ''} ${dropTarget === e.path ? 'is-drop' : ''}`}
              title={e.addressable ? undefined : '이름 때문에 웹에서 열 수 없는 항목이에요'}
              onMouseDown={(ev) => ev.button === 0 && onSelect(e, ev)}
              onDoubleClick={() => onOpen(e)}
              onContextMenu={(ev) => onMenu(ev, e)}
              {...dragProps(e)}
              {...(e.type === 'dir' && e.addressable ? dropProps(e.path) : {})}
            >
              <span className="col col-name" role="gridcell">
                <EntryIcon entry={e} size={16} />
                {renaming === e.path ? (
                  <RenameInput entry={e} onCommit={onRename} onCancel={onCancelRename} />
                ) : (
                  <span className="name-text">{e.name}</span>
                )}
              </span>
              <span className="col col-mtime" role="gridcell">{formatDate(e.mtimeMs)}</span>
              <span className="col col-size" role="gridcell">{e.type === 'file' ? formatSize(e.size) : '--'}</span>
              <span className="col col-kind" role="gridcell">{kindLabel(e)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IconView({ entries, source, selected, lead, renaming, dropTarget, onSelect, onOpen, onMenu, onRename, onCancelRename, dragProps, dropProps }) {
  return (
    <div className="icon-grid" role="grid" aria-multiselectable="true">
      {entries.map((e) => {
        const on = selected.has(e.path);
        const kind = kindOf(e);
        const thumb = thumbSrc(e, source);
        return (
          <div
            key={e.name}
            role="gridcell"
            data-path={e.path ?? ''}
            aria-selected={on}
            className={`icon-cell ${on ? 'is-selected' : ''} ${e.path === lead ? 'is-lead' : ''} ${e.addressable ? '' : 'is-disabled'} ${e.hidden ? 'is-hidden' : ''} ${dropTarget === e.path ? 'is-drop' : ''}`}
            onMouseDown={(ev) => ev.button === 0 && onSelect(e, ev)}
            onDoubleClick={() => onOpen(e)}
            onContextMenu={(ev) => onMenu(ev, e)}
            {...dragProps(e)}
            {...(e.type === 'dir' && e.addressable ? dropProps(e.path) : {})}
          >
            <div className="icon-art">{thumb ? <Thumb src={thumb} entry={e} video={kind === 'video'} /> : <EntryIcon entry={e} size={64} />}</div>
            {renaming === e.path ? (
              <RenameInput entry={e} onCommit={onRename} onCancel={onCancelRename} className="is-icon" />
            ) : (
              <span className="icon-label">{e.name}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

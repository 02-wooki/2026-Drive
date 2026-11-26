// 휴지통 (오너). 복원 / 영구 삭제 / 비우기. 영구 삭제류는 확인 대화상자 + 패스키 재인증.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { messageFor } from '../messages.js';
import { withStepUp } from '../stepUp.js';
import { formatDate, formatSize, kindLabel } from './fileTypes.js';
import { EntryIcon, Glyph } from './icons.jsx';
import { ConfirmDialog } from './Overlays.jsx';

/** @param {{ onToast: (t: any) => void, focused: boolean }} props */
export function TrashView({ onToast, focused }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'empty' }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await api.trashList()).items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const ids = useMemo(() => [...selected], [selected]);

  const report = (results, verb) => {
    const failed = results.filter((r) => r.error);
    if (failed.length) onToast({ kind: 'error', text: `${failed.length}개를 ${verb}하지 못했어요: ${messageFor(failed[0].error)}` });
    else onToast({ text: `${results.length}개 항목을 ${verb}했어요.` });
  };

  async function restore() {
    setBusy(true);
    try {
      report((await api.trashRestore(ids)).results, '복원');
      setSelected(new Set());
      await load();
    } catch (e) {
      onToast({ kind: 'error', text: messageFor(e) });
    } finally {
      setBusy(false);
    }
  }

  async function runConfirmed() {
    setBusy(true);
    try {
      if (confirm.kind === 'empty') {
        const r = await withStepUp(() => api.trashEmpty());
        onToast({ text: `휴지통을 비웠어요. (${r.deleted}개)` });
      } else {
        report((await withStepUp(() => api.trashDelete(ids))).results, '영구 삭제');
      }
      setSelected(new Set());
      setConfirm(null);
      await load();
    } catch (e) {
      onToast({ kind: 'error', text: messageFor(e) });
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id, e) => {
    setSelected((s) => {
      const n = new Set(e.metaKey || e.ctrlKey ? s : []);
      if ((e.metaKey || e.ctrlKey) && s.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  return (
    <>
      <div className="trash-actions">
        <span className="trash-note">휴지통의 항목은 직접 비우기 전까지 보관돼요.</span>
        <button type="button" className="btn" disabled={!ids.length || busy} onClick={restore}>
          복원
        </button>
        <button type="button" className="btn" disabled={!ids.length || busy} onClick={() => setConfirm({ kind: 'delete' })}>
          영구 삭제
        </button>
        <button type="button" className="btn btn-danger-outline" disabled={!items?.length || busy} onClick={() => setConfirm({ kind: 'empty' })}>
          휴지통 비우기
        </button>
      </div>

      {error ? (
        <div className="empty-state" role="status">
          <p>{messageFor(error)}</p>
          <button type="button" className="btn" onClick={load}>
            다시 시도
          </button>
        </div>
      ) : items && items.length === 0 ? (
        <div className="empty-state" role="status">
          <Glyph name="trash" size={40} />
          <p>휴지통이 비어 있어요.</p>
        </div>
      ) : (
        <div className="list trash-list" role="grid">
          <div className="list-head" role="row">
            <span className="col col-name">이름</span>
            <span className="col col-mtime">원래 위치</span>
            <span className="col col-size">크기</span>
            <span className="col col-kind">삭제일</span>
          </div>
          <div className="rows" onMouseDown={(e) => e.target === e.currentTarget && setSelected(new Set())}>
            {items?.map((it) => {
              const entry = { name: it.name, type: it.type, size: it.size };
              const on = selected.has(it.id);
              return (
                <div
                  key={it.id}
                  role="row"
                  aria-selected={on}
                  className={`row ${on ? 'is-selected' : ''} ${focused ? '' : ''}`}
                  onMouseDown={(e) => toggle(it.id, e)}
                  title={kindLabel(entry)}
                >
                  <span className="col col-name" role="gridcell">
                    <EntryIcon entry={entry} size={16} />
                    <span className="name-text">{it.name}</span>
                  </span>
                  <span className="col col-mtime" role="gridcell" title={it.originalPath}>
                    {it.originalPath.slice(0, it.originalPath.lastIndexOf('/')) || '/'}
                  </span>
                  <span className="col col-size" role="gridcell">{it.type === 'file' ? formatSize(it.size) : '--'}</span>
                  <span className="col col-kind" role="gridcell">{formatDate(it.deletedAt)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          danger
          busy={busy}
          title={confirm.kind === 'empty' ? '휴지통을 비울까요?' : `${ids.length}개 항목을 영구 삭제할까요?`}
          message="되돌릴 수 없어요. 계속하면 패스키(Touch ID)로 한 번 더 확인해요."
          confirmLabel={confirm.kind === 'empty' ? '휴지통 비우기' : '영구 삭제'}
          onConfirm={runConfirmed}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}

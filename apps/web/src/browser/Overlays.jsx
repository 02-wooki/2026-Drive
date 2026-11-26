// 확인 대화상자, 토스트, 우클릭 메뉴.
import { useEffect, useRef } from 'react';

/**
 * @param {{ title: string, message?: string, confirmLabel: string, danger?: boolean, busy?: boolean,
 *           onConfirm: () => void, onCancel: () => void }} props
 */
export function ConfirmDialog({ title, message, confirmLabel, danger = false, busy = false, onConfirm, onCancel }) {
  const confirmRef = useRef(null);
  useEffect(() => {
    // 위험한 작업은 기본 포커스를 '취소'에 둔다 (Finder 와 같음)
    if (!danger) confirmRef.current?.focus();
  }, [danger]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' && !busy) onCancel();
        }}
      >
        <h2 id="dialog-title">{title}</h2>
        {message && <p>{message}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy} autoFocus={danger}>
            취소
          </button>
          <button type="button" ref={confirmRef} className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? '처리 중…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * @param {{ toast: { text: string, kind?: 'info' | 'error', action?: { label: string, run: () => void } } | null, onClose: () => void }} props
 */
export function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, toast.action ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind === 'error' ? 'toast-error' : ''}`} role="status" aria-live="polite">
      <span>{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action.run();
            onClose();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

/**
 * @param {{ x: number, y: number, items: Array<{ label: string, shortcut?: string, run: () => void, disabled?: boolean, danger?: boolean } | 'sep'>, onClose: () => void }} props
 */
export function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 화면 밖으로 나가지 않게
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth) el.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
    if (r.bottom > innerHeight) el.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;
    el.querySelector('button:not(:disabled)')?.focus();
    const close = (e) => !el.contains(e.target) && onClose();
    addEventListener('mousedown', close);
    addEventListener('blur', onClose);
    return () => {
      removeEventListener('mousedown', close);
      removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const btns = [...ref.current.querySelectorAll('button:not(:disabled)')];
          const i = btns.indexOf(document.activeElement);
          btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={`sep${i}`} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className={it.danger ? 'is-danger' : ''}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            <span>{it.label}</span>
            {it.shortcut && <kbd>{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

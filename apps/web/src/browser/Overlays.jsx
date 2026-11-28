// 확인 대화상자, 토스트, 우클릭 메뉴 — 디자인 시스템(Dialog·Toast·Menu)에 앱의 기존 props 를 맞춰 주는 얇은 층.
// 떠 있는(Z축) 요소는 깊이감이 보이도록 맑은 유리(clear).
import { useEffect, useMemo, useRef } from 'react';
import { Button, Dialog, Menu, Toast as DsToast } from '../design/index.js';

/**
 * @param {{ title: string, message?: string, confirmLabel: string, danger?: boolean, busy?: boolean,
 *           onConfirm: () => void, onCancel: () => void }} props
 */
export function ConfirmDialog({ title, message, confirmLabel, danger = false, busy = false, onConfirm, onCancel }) {
  const confirmRef = useRef(null);
  useEffect(() => {
    // 위험한 작업은 기본 포커스를 '취소'(맨 앞 버튼 — showModal 이 첫 버튼에 둔다)에 둔다 (Finder 와 같음)
    if (!danger) confirmRef.current?.focus();
  }, [danger]);
  const cancel = () => !busy && onCancel();
  return (
    <Dialog
      open
      size="sm"
      variant="clear"
      onClose={cancel}
      dismissible={!busy}
      title={title}
      description={message}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            취소
          </Button>
          <Button ref={confirmRef} variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? '처리 중…' : confirmLabel}
          </Button>
        </>
      }
    />
  );
}

/**
 * @param {{ toast: { text: string, kind?: 'info' | 'error', action?: { label: string, run: () => void } } | null, onClose: () => void }} props
 */
export function Toast({ toast, onClose }) {
  return (
    <DsToast
      open={Boolean(toast)}
      message={toast?.text}
      tone={toast?.kind === 'error' ? 'danger' : 'neutral'}
      variant={toast?.kind === 'error' ? 'dark' : 'clear'} // 오류는 빨간 바탕이 보이게 어두운 유리 유지
      action={toast?.action && { label: toast.action.label, onClick: toast.action.run }}
      duration={toast?.action ? 7000 : 4000}
      onClose={onClose}
    />
  );
}

/**
 * @param {{ x: number, y: number, items: Array<{ label: string, shortcut?: string, run: () => void, disabled?: boolean, danger?: boolean } | 'sep'>,
 *           subject?: { icon?: import('react').ReactNode, label: string, detail?: string }, onClose: () => void }} props
 *   subject: 무엇에 대한 메뉴인지 — 휴대폰 폭에서 메뉴 위에 아이콘·이름으로 뜬다
 */
export function ContextMenu({ x, y, items, subject, onClose }) {
  const point = useMemo(() => ({ x, y }), [x, y]);
  const menuItems = useMemo(
    () => items.map((it) => (it === 'sep' ? 'divider' : { label: it.label, hint: it.shortcut, onSelect: it.run, disabled: it.disabled, danger: it.danger })),
    [items],
  );
  return <Menu open variant="clear" point={point} items={menuItems} subject={subject} onClose={onClose} label="메뉴" />;
}

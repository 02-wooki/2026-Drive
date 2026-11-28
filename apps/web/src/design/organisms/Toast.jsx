// Organism: 토스트. 화면 아래 가운데에 잠깐 떴다 사라지는 어두운 유리 캡슐.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Glass } from '../atoms/Glass.jsx';
import { cx } from '../lib/cx.js';

/**
 * @param {{
 *   open: boolean,
 *   message: import('react').ReactNode,
 *   onClose: () => void,
 *   tone?: 'neutral' | 'success' | 'danger',
 *   icon?: import('react').ReactNode,
 *   action?: { label: string, onClick: () => void },  // 예: 되돌리기
 *   variant?: 'dark' | 'clear' | 'tinted',            // 유리 종류 (기본 dark)
 *   duration?: number,                                 // ms. 0 이면 저절로 닫히지 않는다
 * }} props
 */
export function Toast({ open, message, onClose, tone = 'neutral', icon, action, variant = 'dark', duration = 4000 }) {
  // onClose 가 매번 새 함수여도 타이머가 다시 시작되지 않게 ref 로 들고 있는다
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || !duration) return undefined;
    const t = setTimeout(() => close.current(), duration);
    return () => clearTimeout(t);
  }, [open, duration, message]);

  if (!open) return null;
  return createPortal(
    <Glass
      variant={variant}
      shape="capsule"
      active={message}
      className={cx('toast-pill', `toast-${tone}`)}
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
    >
      {icon && <span className="toast-icon">{icon}</span>}
      <span className="toast-msg">{message}</span>
      {action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            action.onClick();
            onClose();
          }}
        >
          {action.label}
        </button>
      )}
    </Glass>,
    document.body,
  );
}

// Organism: 대화상자. 브라우저 기본 <dialog>(showModal)를 써서 포커스 가두기·Esc 닫기·뒤 화면 잠금을 그대로 얻는다.
import { useEffect, useId, useRef } from 'react';
import { Glass } from '../atoms/Glass.jsx';
import { cx } from '../lib/cx.js';

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,                  // Esc, 바깥 누르기, 닫기 버튼에서 불린다
 *   title?: import('react').ReactNode,
 *   description?: import('react').ReactNode,
 *   footer?: import('react').ReactNode,   // 아래 버튼 줄 (취소 / 확인)
 *   size?: 'sm' | 'md' | 'lg',
 *   variant?: 'thick' | 'clear' | 'tinted', // 유리 종류 (기본 thick)
 *   dismissible?: boolean,                // false 면 바깥 누르기로 닫히지 않는다 (Esc 는 onClose 에서 막을 것)
 *   className?: string,
 *   children?: import('react').ReactNode,
 * }} props
 */
export function Dialog({ open, onClose, title, description, footer, size = 'md', variant = 'thick', dismissible = true, className, children }) {
  const ref = useRef(null);
  const titleId = `dlg${useId()}`;
  const descId = `${titleId}-d`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <Glass
      as="dialog"
      ref={ref}
      variant={variant}
      shape="panel"
      active={open}
      className={cx('dialog-box', `dialog-${size}`, className)}
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault(); // 닫힘은 open 값으로만 정한다
        onClose();
      }}
      onClick={(e) => {
        // 유리 바깥(::backdrop)을 누르면 이벤트 대상이 dialog 자신이다
        if (dismissible && e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (!inside) onClose();
        }
      }}
    >
      {open && (
        <>
          {(title || description) && (
            <header className="dialog-head">
              {title && (
                <h2 id={titleId} className="dialog-title">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="dialog-desc">
                  {description}
                </p>
              )}
            </header>
          )}
          {children != null && <div className="dialog-body">{children}</div>}
          {footer && <footer className="dialog-foot">{footer}</footer>}
        </>
      )}
    </Glass>
  );
}

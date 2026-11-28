// Organism: 메뉴. 버튼 아래(또는 지정한 좌표)에 뜨는 유리 목록. 화살표·Home·End·Esc 로 움직인다.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Glass } from '../atoms/Glass.jsx';
import { cx } from '../lib/cx.js';

const GAP = 6;
const EDGE = 8;

// 휴대폰 폭에서는 누른 자리 대신 화면 가운데 큰 팝업으로 띄운다 (손가락으로 누르기 쉽게)
const PHONE = '(max-width: 600px)';
const subscribePhone = (fn) => {
  const mq = matchMedia(PHONE);
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
};
const isPhone = () => matchMedia(PHONE).matches;

/**
 * @typedef {{ label: import('react').ReactNode, icon?: import('react').ReactNode, hint?: string,
 *             onSelect?: () => void, danger?: boolean, disabled?: boolean } | 'divider'} MenuItem
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   anchor?: { current: HTMLElement | null },  // 이 요소 아래에 붙는다
 *   point?: { x: number, y: number },           // 또는 이 좌표에 뜬다 (우클릭 메뉴)
 *   items: MenuItem[],
 *   label?: string,
 *   align?: 'start' | 'end',
 *   variant?: 'thick' | 'clear' | 'tinted', // 유리 종류 (기본 thick)
 *   subject?: { icon?: import('react').ReactNode, label: import('react').ReactNode, detail?: import('react').ReactNode },
 *     // 무엇에 대한 메뉴인지. 휴대폰 폭에서 메뉴 위에 아이콘·이름으로 띄운다
 *   className?: string,
 * }} props
 */
export function Menu({ open, onClose, anchor, point, items, label, align = 'start', variant = 'thick', subject, className }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const sheet = useSyncExternalStore(subscribePhone, isPhone, () => false);

  // 자리 잡기: 기준 아래, 화면 밖으로 나가면 안쪽으로 / 위로 뒤집기
  useLayoutEffect(() => {
    if (!open || sheet) return setPos(null);
    const el = ref.current;
    if (!el) return undefined;
    const m = el.getBoundingClientRect();
    let x;
    let y;
    if (point) {
      x = point.x;
      y = point.y;
    } else if (anchor?.current) {
      const a = anchor.current.getBoundingClientRect();
      x = align === 'end' ? a.right - m.width : a.left;
      y = a.bottom + GAP;
      if (y + m.height > innerHeight - EDGE) y = a.top - GAP - m.height;
    } else {
      x = (innerWidth - m.width) / 2;
      y = (innerHeight - m.height) / 2;
    }
    x = Math.min(Math.max(x, EDGE), innerWidth - m.width - EDGE);
    y = Math.min(Math.max(y, EDGE), innerHeight - m.height - EDGE);
    setPos({ x, y });
    return undefined;
  }, [open, point, anchor, align, sheet]);

  // 열리면 첫 항목에 포커스, 바깥 누르기·스크롤·창 크기 변경에 닫기
  useEffect(() => {
    if (!open) return undefined;
    ref.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    const away = (e) => {
      if (ref.current?.contains(e.target) || anchor?.current?.contains(e.target)) return;
      onClose();
    };
    addEventListener('pointerdown', away, true);
    addEventListener('resize', onClose);
    return () => {
      removeEventListener('pointerdown', away, true);
      removeEventListener('resize', onClose);
    };
  }, [open, onClose, anchor]);

  const onKeyDown = (e) => {
    const list = [...ref.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const i = list.indexOf(document.activeElement);
    const go = (n) => list[(n + list.length) % list.length]?.focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      onClose();
      anchor?.current?.focus();
    } else return;
    e.preventDefault();
  };

  if (!open) return null;
  const menu = (
    <Glass
      ref={ref}
      variant={variant}
      shape="panel"
      role="menu"
      aria-label={label ?? (typeof subject?.label === 'string' ? subject.label : undefined)}
      className={cx('menu', sheet && 'menu-sheet', className)}
      style={sheet ? undefined : { left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={onKeyDown}
    >
      {items.map((it, i) =>
        it === 'divider' ? (
          <div key={i} className="menu-divider" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={cx('menu-item', it.danger && 'is-danger')}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect?.();
            }}
          >
            {it.icon && <span className="menu-icon">{it.icon}</span>}
            <span className="menu-label">{it.label}</span>
            {it.hint && !sheet && <kbd className="menu-hint">{it.hint}</kbd>}
          </button>
        ),
      )}
    </Glass>
  );
  if (!sheet) return createPortal(menu, document.body);
  return createPortal(
    <>
      <div className="menu-scrim" aria-hidden="true" />
      <div className="menu-sheet-wrap">
        {subject && (
          <Glass variant={variant} shape="panel" className="menu-subject" aria-hidden="true">
            {subject.icon && <span className="menu-subject-icon">{subject.icon}</span>}
            <span className="menu-subject-text">
              <span className="menu-subject-label">{subject.label}</span>
              {subject.detail && <span className="menu-subject-detail">{subject.detail}</span>}
            </span>
          </Glass>
        )}
        {menu}
      </div>
    </>,
    document.body,
  );
}

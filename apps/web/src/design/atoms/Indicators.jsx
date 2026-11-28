// Atoms: 배지, 구분선, 로딩 표시.
import { cx } from '../lib/cx.js';

/**
 * 상태나 개수를 짧게 보여 주는 캡슐.
 * @param {{ tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger', className?: string, children: import('react').ReactNode }} props
 */
export function Badge({ tone = 'neutral', className, children, ...rest }) {
  return (
    <span className={cx('badge', `badge-${tone}`, className)} {...rest}>
      {children}
    </span>
  );
}

/**
 * 구분선. vertical 이면 세로선 (버튼 줄 사이).
 * @param {{ vertical?: boolean, className?: string }} props
 */
export function Divider({ vertical, className }) {
  return vertical ? (
    <span className={cx('divider', 'divider-v', className)} role="separator" aria-orientation="vertical" />
  ) : (
    <hr className={cx('divider', className)} />
  );
}

/**
 * 돌아가는 로딩 표시. 동작 줄이기 설정이면 돌지 않고 깜빡인다.
 * @param {{ size?: number, label?: string, className?: string }} props
 */
export function Spinner({ size = 16, label = '불러오는 중', className }) {
  return (
    <span className={cx('spinner', className)} role="status" aria-label={label} style={{ width: size, height: size }} />
  );
}

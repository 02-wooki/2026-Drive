// Atoms: 체크박스, 스위치. 둘 다 진짜 <input type="checkbox"> 라 키보드·폼·스크린 리더가 그대로 동작한다.
import { cx } from '../lib/cx.js';

/**
 * @param {{ label?: import('react').ReactNode, className?: string }
 *         & import('react').InputHTMLAttributes<HTMLInputElement>} props
 *   label 을 주면 글자를 눌러도 켜지고 꺼진다
 */
export function Checkbox({ label, className, ...rest }) {
  return (
    <label className={cx('check', className)}>
      <input type="checkbox" className="check-input" {...rest} />
      <span className="check-box" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="10" height="10">
          <path d="M2.5 6.2 5 8.6l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {label != null && <span className="check-label">{label}</span>}
    </label>
  );
}

/**
 * 켜고 끄는 스위치. 손잡이는 작은 유리 알갱이처럼 보인다.
 * @param {{ label?: import('react').ReactNode, className?: string }
 *         & import('react').InputHTMLAttributes<HTMLInputElement>} props
 */
export function Switch({ label, className, ...rest }) {
  return (
    <label className={cx('switch', className)}>
      <input type="checkbox" role="switch" className="switch-input" {...rest} />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {label != null && <span className="check-label">{label}</span>}
    </label>
  );
}

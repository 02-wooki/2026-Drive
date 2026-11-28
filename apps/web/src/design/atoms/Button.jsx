// Atoms: 글자 버튼, 아이콘 버튼.
import { cx } from '../lib/cx.js';

/**
 * 글자 버튼.
 * @param {{ variant?: 'plain' | 'primary' | 'danger' | 'danger-outline', size?: 'md' | 'lg', className?: string }
 *         & import('react').ButtonHTMLAttributes<HTMLButtonElement>} props
 */
export function Button({ variant = 'plain', size = 'md', className, type = 'button', ...rest }) {
  return <button type={type} className={cx('btn', variant !== 'plain' && `btn-${variant}`, size === 'lg' && 'btn-large', className)} {...rest} />;
}

/**
 * 아이콘만 있는 버튼. label 은 스크린 리더와 툴팁에 같이 쓰인다.
 * href 를 주면 <a> 로 그린다 (새 탭 열기, 다운로드 링크).
 * @param {{ label: string, hint?: string, href?: string, className?: string, children: import('react').ReactNode }
 *         & Record<string, unknown>} props  hint: 툴팁에 덧붙일 단축키 등 (예: '⌘[')
 */
export function IconButton({ label, hint, href, className, children, ...rest }) {
  const props = { className: cx('icon-btn', className), title: hint ? `${label} (${hint})` : label, 'aria-label': label, ...rest };
  return href ? (
    <a href={href} {...props}>
      {children}
    </a>
  ) : (
    <button type="button" {...props}>
      {children}
    </button>
  );
}

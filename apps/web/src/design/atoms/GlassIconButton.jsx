// Atom: 동그란 유리 바탕에 아이콘만 있는 작은 버튼. 툴바에서 하나씩 떨어뜨려 놓는다.
// (여러 개 중 하나를 고르는 건 SegmentedControl — 모양을 다르게 해서 헷갈리지 않게 한다)
import { Glass } from './Glass.jsx';
import { cx } from '../lib/cx.js';

/**
 * label 은 스크린 리더와 툴팁에 같이 쓰인다. href 를 주면 <a> 로 그린다 (새 탭 열기, 다운로드 링크).
 * @param {{ label: string, hint?: string, href?: string, variant?: 'tinted' | 'clear' | 'thick' | 'dark',
 *           size?: 'sm' | 'md', className?: string, children: import('react').ReactNode }
 *         & Record<string, unknown>} props  hint: 툴팁에 덧붙일 단축키 등 (예: '⌘[')
 */
export function GlassIconButton({ label, hint, href, variant = 'tinted', size = 'md', className, children, ...rest }) {
  const props = {
    variant,
    shape: 'circle',
    className: cx('glass-icon-btn', size === 'sm' && 'glass-icon-btn-sm', className),
    title: hint ? `${label} (${hint})` : label,
    'aria-label': label,
    ...rest,
  };
  return href ? (
    <Glass as="a" href={href} {...props}>
      {children}
    </Glass>
  ) : (
    <Glass as="button" type="button" {...props}>
      {children}
    </Glass>
  );
}

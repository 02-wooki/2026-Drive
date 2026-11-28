// Molecule: 카드. 유리 판 위에 머리(제목·부제·동작) / 본문 / 바닥(버튼 줄)을 올린다.
import { Glass } from '../atoms/Glass.jsx';
import { cx } from '../lib/cx.js';

/**
 * @param {{
 *   title?: import('react').ReactNode,
 *   subtitle?: import('react').ReactNode,
 *   media?: import('react').ReactNode,   // 머리 위에 꽉 차게 들어가는 그림·미리보기
 *   action?: import('react').ReactNode,  // 머리 오른쪽 (아이콘 버튼, 배지 등)
 *   footer?: import('react').ReactNode,  // 바닥 (버튼 줄)
 *   variant?: 'tinted' | 'thick' | 'clear' | 'content' | 'dark',
 *   tint?: string,
 *   href?: string,                       // 주면 카드 전체가 링크
 *   onClick?: (e: import('react').MouseEvent) => void, // 주면 카드 전체가 버튼
 *   className?: string,
 *   children?: import('react').ReactNode,
 * } & Record<string, unknown>} props
 */
export function Card({ title, subtitle, media, action, footer, variant = 'tinted', tint, href, onClick, className, children, ...rest }) {
  const interactive = Boolean(href || onClick);
  const as = href ? 'a' : onClick ? 'button' : 'article';
  const extra = href ? { href } : onClick ? { type: 'button', onClick } : {};
  return (
    <Glass as={as} variant={variant} tint={tint} shape="panel" className={cx('card', interactive && 'card-interactive', className)} {...extra} {...rest}>
      {media && <div className="card-media">{media}</div>}
      {(title || subtitle || action) && (
        <header className="card-head">
          <div className="card-titles">
            {title && <h3 className="card-title">{title}</h3>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {action && <div className="card-action">{action}</div>}
        </header>
      )}
      {children != null && <div className="card-body">{children}</div>}
      {footer && <footer className="card-foot">{footer}</footer>}
    </Glass>
  );
}

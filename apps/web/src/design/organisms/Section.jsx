// Organism: 섹션. 제목·설명·동작 버튼이 있는 머리와 본문 묶음. 페이지를 나누는 기본 단위.
import { useId } from 'react';
import { Glass } from '../atoms/Glass.jsx';
import { cx } from '../lib/cx.js';

/**
 * @param {{
 *   title?: import('react').ReactNode,
 *   eyebrow?: import('react').ReactNode,      // 제목 위 작은 머리말 (분류·단계)
 *   description?: import('react').ReactNode,
 *   actions?: import('react').ReactNode,      // 머리 오른쪽 버튼들
 *   layout?: 'stack' | 'grid',                // grid: 카드처럼 같은 폭의 칸으로 자동 줄바꿈
 *   minColumn?: string,                       // grid 한 칸의 최소 폭 (기본 240px)
 *   glass?: boolean | 'tinted' | 'thick' | 'clear', // 섹션 전체를 유리 판에 올린다
 *   className?: string,
 *   children?: import('react').ReactNode,
 * } & Record<string, unknown>} props
 */
export function Section({ title, eyebrow, description, actions, layout = 'stack', minColumn = '240px', glass, className, children, ...rest }) {
  const headingId = `sec${useId()}`;
  const head = (title || description || actions || eyebrow) && (
    <header className="section-head">
      <div className="section-titles">
        {eyebrow && <p className="section-eyebrow">{eyebrow}</p>}
        {title && (
          <h2 id={headingId} className="section-title">
            {title}
          </h2>
        )}
        {description && <p className="section-desc">{description}</p>}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </header>
  );
  const body = (
    <div className={cx('section-body', layout === 'grid' && 'section-grid')} style={layout === 'grid' ? { '--section-min': minColumn } : undefined}>
      {children}
    </div>
  );
  const props = { className: cx('section', glass && 'section-glass', className), 'aria-labelledby': title ? headingId : undefined, ...rest };
  if (glass) {
    return (
      <Glass as="section" variant={glass === true ? 'tinted' : glass} shape="panel" {...props}>
        {head}
        {body}
      </Glass>
    );
  }
  return (
    <section {...props}>
      {head}
      {body}
    </section>
  );
}

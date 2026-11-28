// Atom: 유리 표면. 다른 모든 유리 부품(버튼 묶음, 알림, 패널)이 이 위에 올라간다.
import { useRef } from 'react';
import { useGlassRefraction } from '../lib/useGlassRefraction.jsx';
import { cx } from '../lib/cx.js';

/**
 * @param {{
 *   as?: keyof JSX.IntrinsicElements,
 *   variant?: 'tinted' | 'thick' | 'clear' | 'content' | 'dark',
 *   tint?: string,       // 바탕에 섞을 색 (CSS 색). 예: '#3a7bff'
 *   shape?: 'capsule' | 'panel',
 *   refract?: boolean,   // Chromium 에서 가장자리 굴절 + 색수차 (기본 켜짐, 아주 큰 면은 자동 생략)
 *   active?: unknown,    // 내용이 바뀌어 크기를 다시 재야 할 때 바꿔 줄 값
 *   ref?: import('react').Ref<HTMLElement>,
 *   className?: string,
 *   children?: import('react').ReactNode,
 * } & Record<string, unknown>} props
 */
export function Glass({ as: Tag = 'div', variant = 'tinted', shape, refract = true, active, tint, ref, className, style, children, ...rest }) {
  // 흐림·굴절은 맨 뒤의 surface 가 맡는다 (겹 유리: 안에 넣은 유리도 바깥 배경이 비친다)
  const surface = useRef(null);
  const refraction = useGlassRefraction(surface, { active: refract ? (active ?? true) : false });
  return (
    <Tag
      ref={ref}
      className={cx('glass', 'glass-layered', `glass-${variant}`, shape && `glass-${shape}`, className)}
      style={tint ? { ...style, '--glass-tint': tint } : style}
      {...rest}
    >
      <span ref={surface} className="glass-surface" aria-hidden="true" />
      {refraction}
      {children}
    </Tag>
  );
}

// Atom: 유리 표면. 다른 모든 유리 부품(버튼 묶음, 알림, 패널)이 이 위에 올라간다.
import { useCallback, useRef } from 'react';
import { useLiquidGlass } from '../lib/useLiquidGlass.jsx';
import { cx } from '../lib/cx.js';

/**
 * @param {{
 *   as?: keyof JSX.IntrinsicElements,
 *   variant?: 'tinted' | 'clear' | 'dark',
 *   shape?: 'capsule' | 'panel',
 *   refract?: boolean,   // Chromium 에서 가장자리 굴절 (작은 요소에만 권장)
 *   active?: unknown,    // 내용이 바뀌어 크기를 다시 재야 할 때 바꿔 줄 값
 *   ref?: import('react').Ref<HTMLElement>,
 *   className?: string,
 *   children?: import('react').ReactNode,
 * } & Record<string, unknown>} props
 */
export function Glass({ as: Tag = 'div', variant = 'tinted', shape, refract = false, active, ref, className, children, ...rest }) {
  const inner = useRef(null);
  const refraction = useLiquidGlass(inner, { active: refract ? (active ?? true) : false });
  const setRef = useCallback(
    (el) => {
      inner.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  return (
    <Tag ref={setRef} className={cx('glass', `glass-${variant}`, shape && `glass-${shape}`, className)} {...rest}>
      {refraction}
      {children}
    </Tag>
  );
}

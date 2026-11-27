// Molecule: 하나만 고르는 버튼 묶음 (보기 방식 전환). 선택된 칸에 밝은 손잡이가 올라간다.
import { Glass } from '../atoms/Glass.jsx';
import { cx } from '../lib/cx.js';

/**
 * @template {string} T
 * @param {{
 *   label: string,
 *   value: T,
 *   options: Array<{ value: T, label: string, icon?: import('react').ReactNode }>,
 *   onChange: (value: T) => void,
 *   variant?: 'tinted' | 'clear',
 *   className?: string,
 * }} props  icon 이 있으면 아이콘만 보이고 label 은 툴팁·aria-label 로 쓴다
 */
export function SegmentedControl({ label, value, options, onChange, variant = 'tinted', className }) {
  return (
    <Glass variant={variant} shape="capsule" role="group" aria-label={label} className={cx('segmented', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'is-on' : ''}
          aria-pressed={o.value === value}
          title={o.icon ? o.label : undefined}
          aria-label={o.icon ? o.label : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.icon ?? o.label}
        </button>
      ))}
    </Glass>
  );
}

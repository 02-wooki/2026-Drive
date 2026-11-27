// Molecule: 유리 캡슐 안에 아이콘 버튼을 묶는다 (툴바의 뒤로/앞으로, 편집 버튼 묶음).
import { Glass } from '../atoms/Glass.jsx';
import { cx } from '../lib/cx.js';

/**
 * @param {{ label: string, variant?: 'tinted' | 'clear', className?: string, children: import('react').ReactNode }} props
 *   label: 묶음 이름 (aria-label)
 */
export function ButtonGroup({ label, variant = 'tinted', className, children }) {
  return (
    <Glass variant={variant} shape="capsule" role="group" aria-label={label} className={cx('btn-group', className)}>
      {children}
    </Glass>
  );
}

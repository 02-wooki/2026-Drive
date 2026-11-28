// Atom: 글 입력칸. 한 줄(input)과 여러 줄(textarea).
import { cx } from '../lib/cx.js';

/**
 * 한 줄 입력칸. 크기·상태는 CSS 가 정하고, 나머지 속성은 <input> 에 그대로 넘긴다.
 * @param {{ invalid?: boolean, className?: string, ref?: import('react').Ref<HTMLInputElement> }
 *         & import('react').InputHTMLAttributes<HTMLInputElement>} props
 */
export function Input({ invalid, className, type = 'text', ...rest }) {
  return <input type={type} className={cx('input', className)} aria-invalid={invalid || undefined} {...rest} />;
}

/**
 * 여러 줄 입력칸.
 * @param {{ invalid?: boolean, className?: string, ref?: import('react').Ref<HTMLTextAreaElement> }
 *         & import('react').TextareaHTMLAttributes<HTMLTextAreaElement>} props
 */
export function TextArea({ invalid, className, rows = 3, ...rest }) {
  return <textarea rows={rows} className={cx('input', 'input-multiline', className)} aria-invalid={invalid || undefined} {...rest} />;
}

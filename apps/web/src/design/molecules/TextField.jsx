// Molecule: 이름표 + 입력칸 + 도움말/오류. id·aria 연결을 대신 해 준다.
import { useId } from 'react';
import { Input, TextArea } from '../atoms/Input.jsx';
import { cx } from '../lib/cx.js';

/**
 * @param {{
 *   label: import('react').ReactNode,
 *   hint?: import('react').ReactNode,   // 입력칸 아래 회색 도움말
 *   error?: import('react').ReactNode,  // 있으면 빨간 오류 문구 + 입력칸 빨간 테두리 (hint 대신 보인다)
 *   multiline?: boolean,
 *   className?: string,
 *   id?: string,
 * } & Record<string, unknown>} props  나머지는 <input>/<textarea> 에 넘긴다
 */
export function TextField({ label, hint, error, multiline, className, id, ...rest }) {
  const auto = useId();
  const inputId = id ?? `tf${auto}`;
  const noteId = `${inputId}-note`;
  const note = error ?? hint;
  const Control = multiline ? TextArea : Input;
  return (
    <div className={cx('field', className)}>
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <Control id={inputId} invalid={Boolean(error)} aria-describedby={note ? noteId : undefined} {...rest} />
      {note && (
        <p id={noteId} className={cx('field-note', error && 'is-error')} role={error ? 'alert' : undefined}>
          {note}
        </p>
      )}
    </div>
  );
}

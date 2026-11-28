// 올리려는 파일 중 이미 있는 것이 있으면 어떻게 할지 묻는다.
//  - 한꺼번에: 모두 대체 / 새 파일만 올리기(중복은 기존 것 유지) / 취소
//  - 하나씩: 항목마다 대체·유지를 골라 올리기
//  대체된 기존 파일은 휴지통으로 간다(agent). 폴더와 이름이 같은 파일은 대체할 수 없어 늘 건너뛴다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatSize, formatDate } from './fileTypes.js';
import { Button, Dialog } from '../design/index.js';
import './uploadConflict.css';

const PAGE = 200;

/** 크기가 같고 수정 시각 차이가 2초 안이면 같은 파일로 보인다 (FAT·zip 의 2초 단위 시각 고려) */
const looksSame = (file, existing) =>
  existing.type === 'file' && existing.size === file.size && existing.mtimeMs != null && file.lastModified && Math.abs(existing.mtimeMs - file.lastModified) < 2000;

/**
 * @param {{
 *   list: Array<{ file: File, dest: string }>,
 *   conflicts: Map<string, { type: string, size: number | null, mtimeMs: number | null }>,
 *   baseDir: string,
 *   onCancel: () => void,
 *   onConfirm: (files: Array<{ file: File, dest: string, onConflict: 'replace' | 'fail' }>) => void,
 * }} props
 */
export function UploadConflictDialog({ list, conflicts, baseDir, onCancel, onConfirm }) {
  const { fresh, dupes } = useMemo(() => {
    const fresh = [];
    const dupes = [];
    for (const x of list) {
      const dest = x.dest.normalize('NFC');
      const existing = conflicts.get(dest);
      if (!existing) fresh.push(x);
      else dupes.push({ ...x, dest, existing, replaceable: existing.type === 'file', same: looksSame(x.file, existing) });
    }
    return { fresh, dupes };
  }, [list, conflicts]);
  const replaceable = dupes.filter((d) => d.replaceable);
  const blocked = dupes.length - replaceable.length;

  const [mode, setMode] = useState('summary'); // 'summary' | 'each'
  const [choice, setChoice] = useState(() => new Map()); // dest → 'replace' (없으면 유지)
  const [shown, setShown] = useState(PAGE);

  const submit = (replaceSet) => {
    onConfirm([
      ...fresh.map((x) => ({ ...x, onConflict: 'fail' })), // 확인 뒤에 생긴 충돌은 덮어쓰지 않고 오류로
      ...replaceable.filter((d) => replaceSet.has(d.dest)).map(({ file, dest }) => ({ file, dest, onConflict: 'replace' })),
    ]);
  };

  const prefix = baseDir === '/' ? '/' : `${baseDir.normalize('NFC')}/`;
  const rel = (dest) => (dest.startsWith(prefix) ? dest.slice(prefix.length) : dest);
  const replaceCount = [...choice.values()].filter((v) => v === 'replace').length;
  const setAll = (v) => setChoice(new Map(v === 'replace' ? replaceable.map((d) => [d.dest, 'replace']) : []));
  const toggle = (dest, v) =>
    setChoice((m) => {
      const next = new Map(m);
      if (v === 'replace') next.set(dest, 'replace');
      else next.delete(dest);
      return next;
    });

  const firstRef = useRef(null);
  useEffect(() => firstRef.current?.focus(), [mode]);

  return (
    <Dialog
      open
      variant="clear"
      size={mode === 'each' ? 'lg' : 'md'}
      onClose={onCancel}
      className="upload-conflict"
      title={`이미 있는 파일이 ${dupes.length.toLocaleString()}개 있어요`}
      description={
        mode === 'summary' && (
          <>
            올리려는 {list.length.toLocaleString()}개 중 {dupes.length.toLocaleString()}개가 이 위치에 이미 있어요.
            {fresh.length > 0 && ` 나머지 ${fresh.length.toLocaleString()}개는 새 파일이에요.`}
            {replaceable.length > 0 && ' 대체하면 기존 파일은 휴지통으로 옮겨져요.'}
            {blocked > 0 && ` 폴더와 이름이 같은 ${blocked.toLocaleString()}개는 대체할 수 없어 건너뛰어요.`}
          </>
        )
      }
      footer={
        mode === 'each' && (
          <>
            <Button onClick={() => setMode('summary')}>뒤로</Button>
            <Button onClick={onCancel}>올리기 취소</Button>
            <Button variant="primary" disabled={replaceCount === 0 && fresh.length === 0} onClick={() => submit(new Set([...choice.keys()]))}>
              {(replaceCount + fresh.length).toLocaleString()}개 올리기
            </Button>
          </>
        )
      }
    >
      {mode === 'summary' ? (
        <div className="uc-actions">
          {replaceable.length > 0 && (
            <Button ref={firstRef} variant="primary" onClick={() => submit(new Set(replaceable.map((d) => d.dest)))}>
              모두 대체하기
            </Button>
          )}
          {fresh.length > 0 && (
            <Button ref={replaceable.length ? undefined : firstRef} onClick={() => submit(new Set())}>
              기존 것 유지 · 새 파일 {fresh.length.toLocaleString()}개만 올리기
            </Button>
          )}
          {replaceable.length > 0 && <Button onClick={() => setMode('each')}>하나씩 고르기…</Button>}
          <Button onClick={onCancel}>올리기 취소</Button>
        </div>
      ) : (
        <>
          <div className="uc-bulk">
            <span>
              대체 {replaceCount.toLocaleString()} · 유지 {(dupes.length - replaceCount).toLocaleString()}
              {fresh.length > 0 && ` · 새 파일 ${fresh.length.toLocaleString()}`}
            </span>
            <Button ref={firstRef} className="btn-sm" onClick={() => setAll('replace')}>
              모두 대체
            </Button>
            <Button className="btn-sm" onClick={() => setAll('keep')}>
              모두 유지
            </Button>
          </div>
          <ul className="uc-list">
            {dupes.slice(0, shown).map((d) => {
              const on = choice.get(d.dest) === 'replace';
              return (
                <li key={d.dest}>
                  <div className="uc-name" title={d.dest}>
                    {rel(d.dest)}
                    {d.same && <span className="uc-chip">같아 보임</span>}
                  </div>
                  <div className="uc-meta">
                    {d.replaceable ? (
                      <>
                        기존 {formatSize(d.existing.size)} · {formatDate(d.existing.mtimeMs)} → 새 파일 {formatSize(d.file.size)} ·{' '}
                        {d.file.lastModified ? formatDate(d.file.lastModified) : '--'}
                      </>
                    ) : (
                      '같은 이름의 폴더가 있어 대체할 수 없어요'
                    )}
                  </div>
                  <div className="uc-choice" role="group" aria-label={`${d.file.name} 처리`}>
                    <button type="button" className={on ? '' : 'is-on'} aria-pressed={!on} onClick={() => toggle(d.dest, 'keep')}>
                      유지
                    </button>
                    <button type="button" className={on ? 'is-on' : ''} aria-pressed={on} disabled={!d.replaceable} onClick={() => toggle(d.dest, 'replace')}>
                      대체
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {shown < dupes.length && (
            <button type="button" className="btn btn-sm uc-more" onClick={() => setShown((n) => n + PAGE)}>
              {Math.min(PAGE, dupes.length - shown).toLocaleString()}개 더 보기 (남은 {(dupes.length - shown).toLocaleString()}개)
            </button>
          )}
        </>
      )}
    </Dialog>
  );
}

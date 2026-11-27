// Quick Look: 스페이스바 미리보기. 이미지·동영상·오디오·PDF·텍스트.
// 키 입력은 Browser 의 핸들러를 그대로 쓴다 → ↑↓ 로 옆 파일로 넘어가고 Space/Esc 로 닫힌다(Finder 와 같음).
import { useEffect, useRef, useState } from 'react';
import { contentUrl, fetchTextPreview } from '../api.js';
import { messageFor } from '../messages.js';
import { kindOf, kindLabel, formatSize, formatDate } from './fileTypes.js';
import { EntryIcon, Glyph } from './icons.jsx';
import { ButtonGroup, IconButton } from '../design/index.js';

export function QuickLook({ entry, source, onClose, onKeyDown }) {
  const ref = useRef(null);
  const kind = kindOf(entry);
  const url = contentUrl(source, entry.path);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="ql-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="ql"
        role="dialog"
        aria-modal="true"
        aria-label={`${entry.name} 훑어보기`}
        tabIndex={-1}
        ref={ref}
        onKeyDown={(e) => {
          // 동영상·오디오 컨트롤의 방향키는 그대로 두고, 나머지는 탐색기 단축키로
          if (e.target instanceof HTMLMediaElement && ['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
          onKeyDown(e);
        }}
      >
        <header className="ql-bar">
          <ButtonGroup label="창">
            <IconButton label="닫기" hint="Space" onClick={onClose}>
              <Glyph name="close" />
            </IconButton>
          </ButtonGroup>
          <div className="ql-title">
            <span className="ql-name">{entry.name}</span>
            <span className="ql-meta">
              {kindLabel(entry)} · {formatSize(entry.size)} · {formatDate(entry.mtimeMs)}
            </span>
          </div>
          <ButtonGroup label="파일">
            <IconButton label="새 탭에서 열기" href={url} target="_blank" rel="noopener">
              <Glyph name="open" />
            </IconButton>
            <IconButton label="다운로드" href={contentUrl(source, entry.path, 'attachment')}>
              <Glyph name="download" />
            </IconButton>
          </ButtonGroup>
        </header>
        <div className={`ql-body ql-${kind}`}>
          <Preview key={entry.path} kind={kind} url={url} entry={entry} source={source} />
        </div>
      </div>
    </div>
  );
}

function Preview({ kind, url, entry, source }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <NoPreview entry={entry} message="미리보기를 불러오지 못했어요." />;
  switch (kind) {
    case 'image':
      return <img src={url} alt={entry.name} onError={() => setFailed(true)} />;
    case 'video':
      return <video src={url} controls autoPlay playsInline onError={() => setFailed(true)} />;
    case 'audio':
      return (
        <div className="ql-audio">
          <EntryIcon entry={entry} size={96} />
          <audio src={url} controls autoPlay onError={() => setFailed(true)} />
        </div>
      );
    case 'pdf':
      return <iframe src={url} title={entry.name} />;
    case 'text':
      return <TextPreview source={source} entry={entry} />;
    default:
      return <NoPreview entry={entry} />;
  }
}

function TextPreview({ source, entry }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    fetchTextPreview(source, entry.path)
      .then((r) => alive && setState({ loading: false, ...r }))
      .catch((error) => alive && setState({ loading: false, error }));
    return () => {
      alive = false;
    };
  }, [source, entry.path]);

  if (state.loading) return <div className="ql-loading" aria-busy="true" />;
  if (state.error) return <NoPreview entry={entry} message={messageFor(state.error)} />;
  return (
    <div className="ql-text-wrap">
      {/* React 가 이스케이프한다 — HTML·SVG 도 글자 그대로 보인다 */}
      <pre className="ql-text">{state.text}</pre>
      {state.truncated && <p className="ql-truncated">앞부분 256KB만 보여주고 있어요. 전체는 다운로드해서 보세요.</p>}
    </div>
  );
}

function NoPreview({ entry, message }) {
  return (
    <div className="ql-none">
      <EntryIcon entry={entry} size={128} />
      <p className="ql-none-name">{entry.name}</p>
      <p>{message ?? '이 형식은 미리보기를 지원하지 않아요.'}</p>
    </div>
  );
}

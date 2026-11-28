// 디자인 시스템 견본 — 개발 서버에서 /showcase.html 로 연다. Drive 화면과 무관.
import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './design/index.css';
import {
  Glass, Button, IconButton, ButtonGroup, SegmentedControl,
  Input, Checkbox, Switch, Badge, Divider, Spinner, Card, TextField, Section, Dialog, Menu, Toast,
} from './design/index.js';
import { EntryIcon, Glyph } from './browser/icons.jsx';

const css = `
body { margin: 0; min-height: 100vh; background: var(--wallpaper); color: var(--text);
  font: var(--text-md, 13px)/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif; }
.sc { max-width: 920px; margin: 0 auto; padding: 32px 16px 64px; display: grid; gap: 20px; }
.sc h1 { margin: 0; font-size: 22px; }
.sc-sec > h2 { margin: 0 0 12px; font-size: 13px; font-weight: 600; color: var(--text-2); }
.sc-sec { padding: 18px; }
.sc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.sc-cap { font-size: 11px; color: var(--text-3); margin-top: 6px; }
.sc-item { display: grid; justify-items: start; }
.sc-glass { width: 180px; height: 96px; display: grid; place-items: center; font-weight: 600; }
.sc-stripes .sc-cap { color: #fff; background: rgba(0,0,0,.55); padding: 1px 6px; border-radius: var(--radius-full); }
.sc-sw { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; }
.sc-sw div { display: grid; gap: 4px; font-size: 11px; color: var(--text-2); }
.sc-sw i { display: block; height: 36px; border-radius: var(--radius-sm); box-shadow: inset 0 0 0 1px var(--line); }
.sc-stripes { background: repeating-linear-gradient(45deg, #ff7a59 0 14px, #3a7bff 14px 28px, #ffd23f 28px 42px); border-radius: var(--radius-lg); padding: 18px; }
.sc-scene { position: relative; border-radius: var(--radius-xl); overflow: hidden; padding: 28px; min-height: 360px;
  display: grid; place-items: center;
  background:
    radial-gradient(40% 55% at 18% 30%, #ff8a3d 0 40%, transparent 70%),
    radial-gradient(35% 50% at 80% 25%, #ffd84a 0 35%, transparent 70%),
    radial-gradient(45% 60% at 70% 85%, #2f6bff 0 45%, transparent 75%),
    radial-gradient(40% 50% at 20% 90%, #c04dff 0 35%, transparent 70%),
    repeating-linear-gradient(45deg, #1a2a6c 0 10px, #2b4fd8 10px 20px); }
.sc-big { width: min(100%, 520px); min-height: 300px; padding: 24px 0; border-radius: 48px; display: grid; place-items: center; }
.sc-big-inner { display: grid; justify-items: center; gap: 18px; }
.sc-orb { width: 120px; height: 120px; border-radius: 50%; display: grid; place-items: center; font-weight: 600; }
.sc-pills { display: flex; gap: 12px; }
.sc-pill { width: 96px; height: 36px; border-radius: 999px; }
`;

const COLORS = ['--bg', '--surface-2', '--line', '--text', '--text-2', '--text-3', '--accent', '--danger', '--ok', '--warning', '--hover', '--fill', '--fill-raised', '--glass-bg', '--glass-bg-thick'];
const RADII = ['xs', 'sm', 'md', 'lg', 'xl', 'full'];

function Item({ cap, children }) {
  return (
    <div className="sc-item">
      {children}
      <div className="sc-cap">{cap}</div>
    </div>
  );
}

function Components() {
  const [dialog, setDialog] = useState(false);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState(null);
  const [name, setName] = useState('');
  const [sync, setSync] = useState(true);
  const menuBtn = useRef(null);
  return (
    <>
      <Section
        glass
        eyebrow="Organism"
        title="Section · Card (grid)"
        description="섹션은 제목·설명·동작을 머리에 두고, 본문을 쌓거나(stack) 같은 폭 칸으로(grid) 놓는다."
        actions={<Button variant="primary">새로 만들기</Button>}
        layout="grid"
        minColumn="220px"
      >
        <Card title="사진 백업" subtitle="어제 23:10 · 1,204장" action={<Badge tone="success">완료</Badge>}>
          집 PC의 D:\Photos 를 매일 밤 복사합니다.
        </Card>
        <Card
          title="문서 공유"
          subtitle="링크 3개"
          action={<Badge tone="warning">만료 임박</Badge>}
          footer={
            <>
              <Button>취소</Button>
              <Button variant="primary">연장</Button>
            </>
          }
        >
          이번 주 안에 만료되는 링크가 있어요.
        </Card>
        <Card title="눌러서 열기" subtitle="카드 전체가 버튼" onClick={() => setToast({ message: '카드를 눌렀어요', tone: 'neutral' })}>
          href 나 onClick 을 주면 떠오르는 효과가 붙는다.
        </Card>
        <Card variant="content" tint="#3a7bff" title="틴트 카드" subtitle="variant content + tint">
          도형 유리에 색을 섞었다.
        </Card>
      </Section>

      <Section glass title="Form" description="TextField(molecule) = 이름표 + Input(atom) + 도움말/오류">
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))' }}>
          <TextField label="이름" placeholder="예: 우키" value={name} onChange={(e) => setName(e.target.value)} hint="다른 사람에게 보이는 이름" />
          <TextField label="이메일" type="email" defaultValue="wrong@" error="이메일 형식이 아니에요" />
          <TextField label="메모" multiline placeholder="여러 줄 입력" />
          <div className="field">
            <span className="field-label">Input 단독 · disabled</span>
            <Input placeholder="잠긴 입력칸" disabled />
          </div>
        </div>
        <Divider />
        <div className="sc-row">
          <Checkbox label="숨김 파일 보기" defaultChecked />
          <Checkbox label="확장자 보기" />
          <Checkbox label="잠김" disabled />
          <Divider vertical />
          <Switch label="자동 동기화" checked={sync} onChange={(e) => setSync(e.target.checked)} />
          <Switch label="끔" />
        </div>
      </Section>

      <Section glass title="Badge · Spinner · Divider">
        <div className="sc-row">
          <Badge>기본</Badge>
          <Badge tone="accent">새 기능</Badge>
          <Badge tone="success">완료</Badge>
          <Badge tone="warning">주의</Badge>
          <Badge tone="danger">오류</Badge>
          <Divider vertical />
          <Spinner />
          <Spinner size={24} />
          <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
            <Spinner size={20} />
          </span>
        </div>
      </Section>

      <Section glass title="Dialog · Menu · Toast" description="눌러서 띄워 보세요. Esc·바깥 누르기로 닫힌다.">
        <div className="sc-row">
          <Button variant="primary" onClick={() => setDialog(true)}>대화상자 열기</Button>
          <Button ref={menuBtn} onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
            메뉴 열기 ▾
          </Button>
          <Button onClick={() => setToast({ message: '파일 3개를 옮겼어요', tone: 'success', action: true })}>토스트</Button>
          <Button variant="danger-outline" onClick={() => setToast({ message: '업로드에 실패했어요', tone: 'danger' })}>
            오류 토스트
          </Button>
        </div>
      </Section>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="폴더를 휴지통으로 옮길까요?"
        description="'2026 여행' 폴더와 안의 파일 48개가 휴지통으로 이동합니다."
        footer={
          <>
            <Button onClick={() => setDialog(false)}>취소</Button>
            <Button variant="danger" onClick={() => setDialog(false)}>옮기기</Button>
          </>
        }
      >
        <Checkbox label="다시 묻지 않기" />
      </Dialog>
      <Menu
        open={menu}
        onClose={() => setMenu(false)}
        anchor={menuBtn}
        label="파일"
        subject={{ icon: <span style={{ '--folder-back': '#4a9bf2', '--folder-front': '#74b4f7', display: 'contents' }}><EntryIcon entry={{ type: 'dir' }} size={32} /></span>, label: 'Photos', detail: '폴더' }}
        items={[
          { label: '열기', icon: <Glyph name="open" />, hint: '⌘O' },
          { label: '다운로드', icon: <Glyph name="download" /> },
          { label: '이름 바꾸기', disabled: true },
          'divider',
          { label: '휴지통으로 이동', icon: <Glyph name="trash" />, danger: true },
        ]}
      />
      <Toast
        open={Boolean(toast)}
        message={toast?.message}
        tone={toast?.tone}
        action={toast?.action ? { label: '되돌리기', onClick: () => {} } : undefined}
        onClose={() => setToast(null)}
      />
    </>
  );
}

function App() {
  const [view, setView] = useState('list');
  return (
    <main className="sc">
      <style>{css}</style>
      <h1>@02-wooki/glassmorphism-ui 견본</h1>

      <Components />

      <Glass shape="panel" className="sc-sec">
        <h2>큰 유리 — 바탕 유리(tint) 위에 도형 유리(content)</h2>
        <div className="sc-scene">
          <Glass shape="panel" tint="#3a7bff" className="sc-big">
            <div className="sc-big-inner">
              <Glass variant="content" className="sc-orb">Content</Glass>
              <div className="sc-pills">
                <Glass variant="content" className="sc-pill" />
                <Glass variant="content" className="sc-pill" />
              </div>
            </div>
          </Glass>
        </div>
      </Glass>

      <Glass shape="panel" className="sc-sec">
        <h2>Glass (atom) — variant × shape</h2>
        <div className="sc-stripes sc-row">
          <Item cap="tinted · panel"><Glass shape="panel" className="sc-glass">Tinted</Glass></Item>
          <Item cap="clear · panel"><Glass variant="clear" shape="panel" className="sc-glass">Clear</Glass></Item>
          <Item cap="dark · panel"><Glass variant="dark" shape="panel" className="sc-glass">Dark</Glass></Item>
          <Item cap="thick · panel"><Glass variant="thick" shape="panel" className="sc-glass">Thick</Glass></Item>
          <Item cap="tinted · refract 끔"><Glass shape="panel" refract={false} className="sc-glass">굴절 없음</Glass></Item>
          <Item cap="tinted · capsule"><Glass shape="capsule" style={{ padding: '8px 18px' }}>캡슐</Glass></Item>
        </div>
      </Glass>

      <Glass shape="panel" className="sc-sec">
        <h2>Button (atom)</h2>
        <div className="sc-row">
          <Item cap="plain"><Button>취소</Button></Item>
          <Item cap="primary"><Button variant="primary">저장</Button></Item>
          <Item cap="danger"><Button variant="danger">삭제</Button></Item>
          <Item cap="danger-outline"><Button variant="danger-outline">비우기</Button></Item>
          <Item cap="primary · disabled"><Button variant="primary" disabled>저장</Button></Item>
          <Item cap="size lg"><Button variant="primary" size="lg">패스키로 로그인</Button></Item>
        </div>
      </Glass>

      <Glass shape="panel" className="sc-sec">
        <h2>IconButton (atom)</h2>
        <div className="sc-row">
          <Item cap="button"><IconButton label="새 폴더" hint="⌘⇧N"><Glyph name="newfolder" /></IconButton></Item>
          <Item cap="disabled"><IconButton label="휴지통" disabled><Glyph name="trash" /></IconButton></Item>
          <Item cap="href (링크)"><IconButton label="다운로드" href="#"><Glyph name="download" /></IconButton></Item>
        </div>
      </Glass>

      <Glass shape="panel" className="sc-sec">
        <h2>ButtonGroup · SegmentedControl (molecule)</h2>
        <div className="sc-stripes sc-row">
          <Item cap="ButtonGroup tinted">
            <ButtonGroup label="탐색">
              <IconButton label="뒤로"><Glyph name="back" /></IconButton>
              <IconButton label="앞으로" disabled><Glyph name="forward" /></IconButton>
            </ButtonGroup>
          </Item>
          <Item cap="ButtonGroup clear">
            <ButtonGroup label="편집" variant="clear">
              <IconButton label="새 폴더"><Glyph name="newfolder" /></IconButton>
              <IconButton label="올리기"><Glyph name="upload" /></IconButton>
              <IconButton label="휴지통"><Glyph name="trash" /></IconButton>
            </ButtonGroup>
          </Item>
          <Item cap="SegmentedControl">
            <SegmentedControl
              label="보기"
              value={view}
              onChange={setView}
              options={[
                { value: 'icons', label: '아이콘', icon: <Glyph name="grid" /> },
                { value: 'list', label: '목록', icon: <Glyph name="list" /> },
                { value: 'columns', label: '칼럼', icon: <Glyph name="columns" /> },
              ]}
            />
          </Item>
        </div>
      </Glass>

      <Glass shape="panel" className="sc-sec">
        <h2>토큰 — 색</h2>
        <div className="sc-sw">
          {COLORS.map((c) => (
            <div key={c}><i style={{ background: `var(${c})` }} />{c}</div>
          ))}
        </div>
        <h2 style={{ marginTop: 18 }}>토큰 — 둥글기</h2>
        <div className="sc-row">
          {RADII.map((r) => (
            <Item key={r} cap={`--radius-${r}`}>
              <div style={{ width: 56, height: 40, background: 'var(--accent)', borderRadius: `var(--radius-${r})` }} />
            </Item>
          ))}
        </div>
      </Glass>
    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

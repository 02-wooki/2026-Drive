// Molecule: 하나만 고르는 버튼 묶음 (보기 방식 전환). 선택된 칸에 밝은 손잡이가 올라간다.
// 손잡이를 길게 누르거나 끌면 손잡이가 커지며 떠올라 돋보기처럼 아래 아이콘을 키워 보이고, 손가락(마우스)을 따라간다.
// 놓으면 가장 가까운 칸으로 튕기듯 붙고 그 칸이 선택된다.
import { useLayoutEffect, useRef, useState } from 'react';
import { Glass } from '../atoms/Glass.jsx';
import { cx } from '../lib/cx.js';

const LONG_PRESS = 250; // ms: 이만큼 누르고 있으면 떠오른다
const DRAG_START = 4; // px: 이만큼 움직이면 바로 떠오른다
const LIFT = 1.45; // 떠오른 손잡이 배율 (CSS .is-dragging 의 scale 과 같게)

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
  const root = useRef(null);
  const [segs, setSegs] = useState([]); // 칸마다 { left, top, width, height }
  const [drag, setDrag] = useState(null); // 끄는 중이면 손잡이 왼쪽 x
  const press = useRef(null); // { id, startX, grab, timer, lifted }
  const swallowClick = useRef(false);

  // 칸 자리 재기 (글꼴·크기가 바뀌어도 맞게)
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const measure = () =>
      setSegs([...el.querySelectorAll('.segmented-btn')].map((b) => ({ left: b.offsetLeft, top: b.offsetTop, width: b.offsetWidth, height: b.offsetHeight })));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [options.length]);

  const on = Math.max(0, options.findIndex((o) => o.value === value));
  const seg = segs[on];
  const maxX = segs.length ? segs.at(-1).left : 0;
  const minX = segs.length ? segs[0].left : 0;
  const x = drag ?? seg?.left ?? 0;

  const nearest = (left) => {
    let best = 0;
    segs.forEach((s, i) => {
      if (Math.abs(s.left - left) < Math.abs(segs[best].left - left)) best = i;
    });
    return best;
  };
  const thumbX = (clientX) => {
    const r = root.current.getBoundingClientRect();
    return Math.min(Math.max(clientX - r.left - press.current.grab, minX), maxX);
  };
  const lift = (clientX) => {
    const p = press.current;
    if (!p || p.lifted) return;
    p.lifted = true;
    // 떠오른 뒤에만 포인터를 붙잡는다 (그냥 누르기는 버튼 click 이 그대로 받게)
    try {
      root.current.setPointerCapture(p.id);
    } catch {
      /* 이미 손을 뗀 경우 */
    }
    setDrag(thumbX(clientX));
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || !seg) return;
    const r = root.current.getBoundingClientRect();
    const px = e.clientX - r.left;
    // 누른 곳이 손잡이 위면 잡은 자리 그대로, 아니면 손잡이 가운데를 손가락 아래로
    const grab = px >= seg.left && px <= seg.left + seg.width ? px - seg.left : seg.width / 2;
    press.current = { id: e.pointerId, startX: e.clientX, lastX: e.clientX, grab, lifted: false };
    press.current.timer = setTimeout(() => lift(press.current?.lastX ?? e.clientX), LONG_PRESS);
  };
  const onPointerMove = (e) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    p.lastX = e.clientX;
    if (!p.lifted && Math.abs(e.clientX - p.startX) >= DRAG_START) lift(e.clientX);
    if (p.lifted) setDrag(thumbX(e.clientX));
  };
  const end = (e, commit) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    clearTimeout(p.timer);
    press.current = null;
    if (!p.lifted) return; // 그냥 누른 것: 버튼 click 이 처리한다
    swallowClick.current = true; // 끌기 뒤에 따라오는 click 은 무시
    setTimeout(() => (swallowClick.current = false), 0);
    const i = nearest(thumbX(e.clientX));
    setDrag(null);
    if (commit && options[i].value !== value) onChange(options[i].value);
  };

  return (
    <Glass
      ref={root}
      variant={variant}
      shape="capsule"
      role="group"
      aria-label={label}
      className={cx('segmented', drag != null && 'is-dragging', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {seg && (
        // 자리는 translate 로 준다. transform 으로 주면 떠오를 때의 scale 이 이동 거리까지 키워서 손잡이가 어긋난다
        <span className="segmented-thumb" aria-hidden="true" style={{ width: seg.width, height: seg.height, top: seg.top, translate: `${x}px 0` }}>
          {/* 돋보기: 아이콘 줄을 그대로 한 벌 더 깔고, 손잡이가 커질 때 같이 커져서 확대돼 보인다 */}
          <span className="segmented-lens" style={{ transform: `translate(${-x}px, ${-seg.top}px)` }}>
            {options.map((o, i) =>
              segs[i] ? (
                <span key={o.value} className={cx('segmented-lens-item', i === nearest(x) && 'is-on')} style={segs[i]}>
                  {o.icon ?? o.label}
                </span>
              ) : null,
            )}
          </span>
        </span>
      )}
      <span
        className="segmented-row"
        style={
          drag != null
            ? {
                // 손잡이(돋보기) 아래의 원래 아이콘은 가린다: 돋보기 속 확대된 아이콘만 보이게
                '--hole-l': `${x + (seg.width * (1 - LIFT)) / 2 - minX}px`,
                '--hole-r': `${x + (seg.width * (1 + LIFT)) / 2 - minX}px`,
              }
            : undefined
        }
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={cx('segmented-btn', o.value === value && 'is-on')}
            aria-pressed={o.value === value}
            title={o.icon ? o.label : undefined}
            aria-label={o.icon ? o.label : undefined}
            onClick={() => {
              if (!swallowClick.current) onChange(o.value);
            }}
          >
            {o.icon ?? o.label}
          </button>
        ))}
      </span>
    </Glass>
  );
}

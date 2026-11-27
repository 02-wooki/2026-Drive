/**
 * 터치로 길게 누르면 우클릭 메뉴 — iOS Safari 는 길게 눌러도 contextmenu 를 보내지 않는다.
 *  손가락을 HOLD_MS 동안 거의 움직이지 않으면 누른 요소에 contextmenu 를 직접 보낸다
 *  → 기존 onContextMenu 처리(항목·바탕 구분)를 그대로 쓴다.
 *  안드로이드처럼 브라우저가 직접 contextmenu 를 보내면 그것만 쓰고(중복 방지),
 *  메뉴가 뜬 뒤 손을 떼며 생기는 click·mousedown 은 삼킨다(메뉴 항목이 바로 눌리거나 메뉴가 닫히지 않게).
 */
const HOLD_MS = 450;
const MOVE_PX = 10;

export function installLongPress(root) {
  let timer = 0;
  let start = null;
  let fired = false; // 이번 누름에서 메뉴를 이미 띄웠나
  let swallowUntil = 0;

  const cancel = () => {
    clearTimeout(timer);
    timer = 0;
  };

  const onDown = (e) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    cancel();
    fired = false;
    start = { x: e.clientX, y: e.clientY, target: e.target };
    timer = setTimeout(() => {
      timer = 0;
      if (!start?.target.isConnected) return;
      fired = true;
      swallowUntil = Date.now() + 800;
      start.target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y, button: 2 }),
      );
    }, HOLD_MS);
  };

  const onMove = (e) => {
    if (!timer || e.pointerType !== 'touch') return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_PX) cancel();
  };

  const onUp = (e) => {
    if (e.pointerType !== 'touch') return;
    cancel();
    if (fired) swallowUntil = Date.now() + 400; // 손 뗀 직후의 click 까지
  };

  const onContextMenu = (e) => {
    if (!e.isTrusted) return; // 우리가 보낸 것
    if (fired) {
      // 이미 띄웠으면 브라우저가 늦게 보낸 것은 무시
      e.preventDefault();
      e.stopPropagation();
    } else if (timer) {
      cancel(); // 브라우저가 먼저 보냄 → 그것을 쓴다
      fired = true;
      swallowUntil = Date.now() + 800;
    }
  };

  const swallow = (e) => {
    if (Date.now() < swallowUntil) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'click') swallowUntil = 0;
    }
  };

  const opts = { capture: true };
  root.addEventListener('pointerdown', onDown, opts);
  root.addEventListener('pointermove', onMove, opts);
  root.addEventListener('pointerup', onUp, opts);
  root.addEventListener('pointercancel', onUp, opts);
  root.addEventListener('contextmenu', onContextMenu, opts);
  root.addEventListener('mousedown', swallow, opts);
  root.addEventListener('click', swallow, opts);
  return () => {
    cancel();
    root.removeEventListener('pointerdown', onDown, opts);
    root.removeEventListener('pointermove', onMove, opts);
    root.removeEventListener('pointerup', onUp, opts);
    root.removeEventListener('pointercancel', onUp, opts);
    root.removeEventListener('contextmenu', onContextMenu, opts);
    root.removeEventListener('mousedown', swallow, opts);
    root.removeEventListener('click', swallow, opts);
  };
}

// 유리 품질 단계: 'full' (굴절·색수차 포함) / 'lite' (흐림·가장자리 색만).
// lite 로 내려가는 경우
//  - 동작 줄이기(prefers-reduced-motion) 설정이 켜져 있을 때
//  - 화면이 계속 버벅일 때: 1초 단위로 프레임 간격을 재서 3초 연속 평균 25ms(40fps 미만)를 넘으면
// 한 번 내려가면 그 탭에서는 다시 올리지 않는다 (sessionStorage).
// <html data-glass-quality="lite"> 로도 표시해서 CSS 가 따라올 수 있게 한다.

const KEY = 'glass-quality';
const SLOW_FRAME_MS = 25;
const SLOW_WINDOWS = 3;

const listeners = new Set();
let jank = readJank();
let reduced = false;
let monitoring = false;

function readJank() {
  try {
    return sessionStorage.getItem(KEY) === 'lite';
  } catch {
    return false;
  }
}

function current() {
  return jank || reduced ? 'lite' : 'full';
}

function emit() {
  const q = current();
  document.documentElement.dataset.glassQuality = q;
  listeners.forEach((fn) => fn(q));
}

function startMonitor() {
  if (monitoring || typeof window === 'undefined') return;
  monitoring = true;

  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  reduced = mq.matches;
  mq.addEventListener('change', (e) => {
    reduced = e.matches;
    emit();
  });

  let prev = 0;
  let sum = 0;
  let count = 0;
  let windowStart = 0;
  let slowWindows = 0;
  const tick = (now) => {
    if (jank) return; // 이미 lite: 더 잴 필요 없음
    if (prev && document.visibilityState === 'visible') {
      const dt = now - prev;
      if (dt < 250) {
        // 탭 전환·일시정지로 생긴 긴 간격은 버벅임이 아니다
        sum += dt;
        count += 1;
      }
    }
    prev = now;
    if (!windowStart) windowStart = now;
    if (now - windowStart >= 1000) {
      const avg = count ? sum / count : 0;
      slowWindows = avg > SLOW_FRAME_MS ? slowWindows + 1 : 0;
      sum = 0;
      count = 0;
      windowStart = now;
      if (slowWindows >= SLOW_WINDOWS) {
        jank = true;
        try {
          sessionStorage.setItem(KEY, 'lite');
        } catch {
          /* 저장 못 해도 이번 화면에서는 lite */
        }
        emit();
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  emit();
}

/** @returns {'full' | 'lite'} */
export function getGlassQuality() {
  return current();
}

/** @param {(q: 'full' | 'lite') => void} fn */
export function subscribeGlassQuality(fn) {
  startMonitor();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

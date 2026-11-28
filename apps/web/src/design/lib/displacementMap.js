// 유리 필터에 쓰는 맵들을 PNG data URL 로 만든다.
// 출처: Wooki 의 2026-Pebbles (MIT) Displacementmap.js 를 바탕으로 다시 썼다.
//
// 매끄럽게 변하는 맵은 작게 그려 feImage 가 늘려 쓴다 (큰 면에서도 계산이 가볍다).
// 가장자리 띠처럼 또렷해야 하는 것만 원래 크기로 그린다.

const SMOOTH_PIXELS = 160_000; // 매끄러운 맵의 최대 픽셀 수

/**
 * 렌즈 맵 — 실제 볼록 유리의 굴절을 계산한다.
 *
 * 유리 단면을 가장자리 폭(bezel) 안에서 볼록한 스쿼클 곡선  y = (1 - (1-x)⁴)^¼  로 본다
 * (x: 가장자리에서 안쪽으로 0→1). 가운데는 평평하고, 가장자리로 갈수록 면이 서서 맨 끝은 90°에 가깝다.
 * 위에서 수직으로 들어온 빛이 그 면에서 꺾이는 각을 스넬 법칙(굴절률 ior)으로 구해
 * "배경을 얼마나 안쪽에서 끌어오는가"를 정한다. 면이 설수록 많이 꺾이므로
 * 맨 가장자리에는 가운데 쪽 풍경이 비쳐 보인다. 평평한 가운데는 그대로 비친다.
 * 곡선이 평평한 곳에서 기울기·곡률이 0 으로 시작해 굴절도 매끄럽게 시작한다.
 *
 *  R, G = x, y 변위 (128 = 0, 안쪽 방향). 맨 가장자리에서 1 이 되도록 정규화했다.
 *  B    = 흐림 세기 (가장자리일수록 큼)
 *
 * x·y 축을 따로 계산해서 둥근 사각형 대각선에 꺾인 자국이 생기지 않는다.
 *
 * @param {number} w 요소 폭(px)
 * @param {number} h 요소 높이(px)
 * @param {number} bezel 굴곡이 있는 가장자리 폭(px)
 * @param {number} [ior] 굴절률 (유리 1.5)
 */
export function makeLensMap(w, h, bezel, ior = 1.5) {
  const hx = w / 2;
  const hy = h / 2;
  const bz = Math.max(1, Math.min(bezel, hx, hy));
  const bend = refractionProfile(ior);
  return paintSmooth(w, h, (px, py) => {
    const fx = bend((hx - Math.abs(px)) / bz);
    const fy = bend((hy - Math.abs(py)) / bz);
    return [-Math.sign(px) * fx, -Math.sign(py) * fy, Math.min(1, Math.max(fx, fy) * 2) * 2 - 1];
  });
}

/** 가장자리에서의 거리 x(0~1, bezel 기준) → 굴절로 배경이 밀리는 양 (맨 가장자리 = 1) */
function refractionProfile(ior) {
  const deviation = (x) => {
    if (x >= 1) return 0;
    const u = 1 - Math.max(x, 1e-4);
    const slope = u ** 3 / (1 - u ** 4) ** 0.75; // 스쿼클 단면의 기울기
    const incidence = Math.atan(slope); // 면의 법선과 수직 빛 사이 각
    const refracted = Math.asin(Math.sin(incidence) / ior);
    return Math.tan(incidence - refracted); // 꺾인 빛이 옆으로 가는 정도
  };
  const max = deviation(0);
  return (x) => deviation(x) / max;
}

/**
 * 물리 렌즈 맵 — 두께까지 넣어 실제 빛이 얼마나 옆으로 밀리는지(px)를 계산한다.
 *
 * makeLensMap 과 같은 스쿼클 단면·스넬 법칙을 쓰되 두 가지가 다르다.
 *  1) 밀리는 양 = 그 자리의 유리 두께 × tan(꺾인 각). 맨 가장자리는 두께가 0 이라 밀림도 0 이고,
 *     가장자리 바로 안쪽(면이 서 있고 두께도 있는 곳)에서 가장 크게 밀린다. 크기를 따로 정하지 않고
 *     굴절률·두께·가장자리 폭에서 나온다 (maxShift 로 돌려준다).
 *  2) 방향은 둥근 사각형 윤곽의 법선. 캡슐의 둥근 끝은 둥글게 꺾인다 (축을 따로 계산하지 않는다).
 *     모서리 반지름이 가장자리 폭보다 작은 큰 판은, 법선·거리를 반지름 = 가장자리 폭인 윤곽으로 재서
 *     모서리 대각선에 꺾인 자국이 생기지 않게 한다. 그 윤곽 밖(실제 모서리 끝 조각)은 두께 0 으로 본다.
 *
 * @param {number} w
 * @param {number} h
 * @param {number} radius 모서리 반지름(px)
 * @param {number} bezel 굴곡이 있는 가장자리 폭(px)
 * @param {number} ior 굴절률
 * @param {number} thickness 유리 두께 ÷ 가장자리 폭 (1 이면 가장자리가 1/4 원에 가까운 단면)
 * @returns {{ url: string, maxShift: number }} maxShift: 가장 크게 밀리는 거리(px) = feDisplacementMap 세기
 */
export function makePhysicalLensMap(w, h, radius, bezel, ior, thickness) {
  const hx = w / 2;
  const hy = h / 2;
  const bz = Math.max(1, Math.min(bezel, hx, hy));
  const r = Math.min(Math.max(radius, bz), hx, hy);
  const shift = (x) => {
    if (x >= 1) return 0;
    const u = 1 - Math.max(x, 1e-4);
    const height = (1 - u ** 4) ** 0.25; // 가장자리 0 → 안쪽 1
    const slope = (thickness * u ** 3) / (1 - u ** 4) ** 0.75;
    const incidence = Math.atan(slope);
    const refracted = Math.asin(Math.sin(incidence) / ior);
    return thickness * height * Math.tan(incidence - refracted); // 가장자리 폭 단위
  };
  let peak = 0;
  for (let i = 1; i <= 400; i++) peak = Math.max(peak, shift(i / 400));
  const url = paintSmooth(w, h, (px, py) => {
    // 둥근 사각형 SDF: 안쪽 거리 e 와 바깥 방향 법선 (nx, ny)
    const qx = Math.abs(px) - (hx - r);
    const qy = Math.abs(py) - (hy - r);
    let nx;
    let ny;
    let e;
    if (qx > 0 && qy > 0) {
      const l = Math.hypot(qx, qy);
      e = r - l;
      nx = (qx / l) * Math.sign(px);
      ny = (qy / l) * Math.sign(py);
    } else if (qx > qy) {
      e = r - qx;
      nx = Math.sign(px);
      ny = 0;
    } else {
      e = r - qy;
      nx = 0;
      ny = Math.sign(py);
    }
    const v = peak ? shift(Math.max(e, 0) / bz) / peak : 0;
    return [-nx * v, -ny * v, Math.min(1, v * 2) * 2 - 1];
  }, 6);
  return { url, maxShift: peak * bz };
}

/**
 * 색수차용 방사형 맵. 가운데 0 → 가장자리 1 (직선), 방향은 안쪽.
 */
export function makeRadialMap(w, h) {
  const hx = w / 2;
  const hy = h / 2;
  return paintSmooth(w, h, (px, py) => [-px / hx, -py / hy, 0]);
}

/**
 * 두 번째 가장자리 띠 마스크 (흰색 + 알파). 바깥에서 진하고 안쪽으로 부드럽게 번지며 사라진다.
 * @param {number} w
 * @param {number} h
 * @param {number} radius 모서리 반지름(px)
 * @param {number} width 띠 폭(px)
 */
export function makeRimMask(w, h, radius, width) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const r = Math.min(radius, w / 2, h / 2);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  // 안쪽 구멍을 띠 폭의 절반만큼 들여 파고 흐려서, 가장자리에서 진하고 안쪽으로 번지며 사라지게
  const inset = width * 0.4;
  ctx.filter = `blur(${Math.max(width * 0.4, 0.5)}px)`;
  ctx.beginPath();
  ctx.roundRect(inset, inset, Math.max(w - inset * 2, 0), Math.max(h - inset * 2, 0), Math.max(r - inset, 0));
  ctx.fill();
  return canvas.toDataURL('image/png');
}

function paintSmooth(w, h, fn, maxScale = 1) {
  // maxScale > 1: 작은 면은 원래보다 촘촘히 그려 가파른 변화(물리 렌즈의 가장자리)가 계단지지 않게 한다
  const k = Math.min(maxScale, Math.sqrt(SMOOTH_PIXELS / (w * h)));
  const cw = Math.max(2, Math.round(w * k));
  const ch = Math.max(2, Math.round(h * k));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cw, ch);
  const d = img.data;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      // 작은 캔버스의 픽셀 중심을 원래 크기 좌표로 되돌려 계산
      const [vx, vy, vb] = fn(((x + 0.5) / cw - 0.5) * w, ((y + 0.5) / ch - 0.5) * h);
      const i = (y * cw + x) * 4;
      d[i] = 128 + vx * 127;
      d[i + 1] = 128 + vy * 127;
      d[i + 2] = 128 + vb * 127;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

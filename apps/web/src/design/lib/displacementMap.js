// 둥근 사각형 가장자리(bezel)에서 배경을 "안쪽으로 끌어당기는" 변위 맵을 PNG data URL 로 만든다.
// R = x 변위, G = y 변위 (128 = 변위 없음). feDisplacementMap 이 이 값을 읽어 배경을 휘게 한다.
// 출처: Wooki 의 2026-Pebbles (MIT) Displacementmap.js 를 옮겨 왔다.

/**
 * @param {number} w 요소 폭(px)
 * @param {number} h 요소 높이(px)
 * @param {number} radius 모서리 반지름(px)
 * @param {number} bezel 굴절이 일어나는 가장자리 폭(px)
 * @returns {string} data:image/png URL
 */
export function makeDisplacementMap(w, h, radius, bezel) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;

  const hx = w / 2;
  const hy = h / 2;
  const r = Math.min(radius, hx, hy);
  const bz = Math.min(bezel, hx, hy);
  const bx = hx - r;
  const by = hy - r;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hx;
      const py = y + 0.5 - hy;
      const sx = px < 0 ? -1 : 1;
      const sy = py < 0 ? -1 : 1;
      const qx = Math.abs(px) - bx;
      const qy = Math.abs(py) - by;
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      // 둥근 사각형까지의 부호 있는 거리 (안쪽이 음수)
      const inside = -(Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r);

      let vx = 0;
      let vy = 0;
      if (inside > 0 && inside < bz) {
        // 바깥쪽 법선
        let ux;
        let uy;
        if (ox > 0 || oy > 0) {
          const len = Math.hypot(ox, oy) || 1;
          ux = ox / len;
          uy = oy / len;
        } else if (qx > qy) {
          ux = 1;
          uy = 0;
        } else {
          ux = 0;
          uy = 1;
        }
        // 가장자리에서 1, 안쪽으로 갈수록 0 (smoothstep)
        const s = 1 - inside / bz;
        const m = s * s * (3 - 2 * s);
        vx = -ux * sx * m;
        vy = -uy * sy * m;
      }

      const i = (y * w + x) * 4;
      d[i] = 128 + vx * 127;
      d[i + 1] = 128 + vy * 127;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

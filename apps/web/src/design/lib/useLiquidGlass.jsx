// 유리 요소에 굴절(가장자리에서 뒤 배경이 휘는 효과)을 덧붙이는 훅.
// 출처: Wooki 의 2026-Pebbles (MIT) Glass.jsx 를 훅으로 바꿨다.
//
// backdrop-filter 안에서 SVG 필터(url(#id))가 동작하는 건 Chromium 계열뿐이다.
// 그 밖의 브라우저나 "투명도 줄이기" 설정에서는 아무것도 하지 않고 glass.css 의 흐림 유리만 남는다.
// iOS 의 Chrome(CriOS)은 WebKit 이라 "Chrome/" 문자열로 구분한다.
import { useEffect, useId, useState } from 'react';
import { makeDisplacementMap } from './displacementMap.js';

const SVG_BACKDROP = typeof navigator !== 'undefined' && /Chrome\//.test(navigator.userAgent);
const MAX_PIXELS = 400_000; // 이보다 큰 면은 맵 계산이 무거워 굴절을 생략

/**
 * @param {{ current: HTMLElement | null }} ref .glass 요소
 * @param {{ bezel?: number, depth?: number, active?: unknown }} [opts]
 *   bezel: 굴절이 일어나는 가장자리 폭(px), depth: 배경이 휘는 최대 거리(px),
 *   active: 요소가 조건부로 그려질 때 다시 측정하게 하는 값 (예: 토스트 객체)
 * @returns {import('react').ReactNode} 요소 옆에 그려 둘 숨은 <svg> (필터 정의)
 */
export function useLiquidGlass(ref, { bezel = 14, depth = 10, active = true } = {}) {
  const id = `lg${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [map, setMap] = useState(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !active || !SVG_BACKDROP) return undefined;
    if (matchMedia('(prefers-reduced-transparency: reduce)').matches) return undefined;

    let timer = 0;
    let last = '';
    const build = () => {
      const w = el.offsetWidth; // transform(scale) 영향을 받지 않는 레이아웃 크기
      const h = el.offsetHeight;
      const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2);
      const key = `${w}x${h}r${r}`;
      if (!w || !h || key === last) return;
      last = key;
      if (w * h > MAX_PIXELS) return setMap(null);
      setMap({ w, h, url: makeDisplacementMap(w, h, r, bezel) });
    };

    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(build, 60);
    });
    ro.observe(el);
    build();
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      setMap(null);
    };
  }, [ref, bezel, active]);

  // 필터 문자열은 CSS 토큰(--glass-blur, --glass-saturate)을 그대로 따른다
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (!map) {
      el.style.removeProperty('backdrop-filter');
      el.style.removeProperty('-webkit-backdrop-filter');
      return undefined;
    }
    const cs = getComputedStyle(el);
    const blur = cs.getPropertyValue('--glass-blur').trim() || '20px';
    const sat = cs.getPropertyValue('--glass-saturate').trim() || '1.8';
    const filter = `url(#${id}) blur(${blur}) saturate(${sat})`;
    el.style.setProperty('backdrop-filter', filter);
    el.style.setProperty('-webkit-backdrop-filter', filter);
    return () => {
      el.style.removeProperty('backdrop-filter');
      el.style.removeProperty('-webkit-backdrop-filter');
    };
  }, [ref, map, id]);

  if (!map) return null;
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feImage href={map.url} x="0" y="0" width={map.w} height={map.h} preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={depth * 2} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}

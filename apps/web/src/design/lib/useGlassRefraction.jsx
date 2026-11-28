// 유리 요소에 SVG 필터를 덧붙이는 훅. 한 필터 안에서 차례로
//  1) 고르지 않은 흐림: 가운데는 얇게(--glass-blur), 가장자리로 갈수록 두껍게(--glass-blur-edge)
//  2) 굴절: 볼록 유리 단면(스쿼클)과 스넬 법칙으로 계산. 가운데는 그대로, 면이 서는 가장자리일수록
//     크게 꺾여 맨 끝에는 가운데 쪽 풍경이 비친다 (displacementMap.js)
//  3) 색수차: 면 전체에 약하게, 가장자리에서 굴절과 함께 커진다
//  4) 두 번째 가장자리: 뒤 배경을 넓게 흐려 채도를 올린 "대표 색"을 맨 바깥 흰 반사광 바로 안쪽에
//     진하게 두르고, 안쪽으로 부드럽게 번지게 한다 (흰 반사광은 glass.css 의 ::before)
// 품질이 lite(동작 줄이기 설정, 계속 버벅임)이면 2·3 을 빼고 1·4 만 남긴다.
// 출처: Wooki 의 2026-Pebbles (MIT) Glass.jsx 를 훅으로 바꿨다.
//
// backdrop-filter 안에서 SVG 필터(url(#id))가 동작하는 건 Chromium 계열뿐이다.
// 그 밖의 브라우저나 "투명도 줄이기" 설정에서는 아무것도 하지 않고 glass.css 의 흐림 유리만 남는다.
// iOS 의 Chrome(CriOS)은 WebKit 이라 "Chrome/" 문자열로 구분한다.
import { Fragment, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { makeLensMap, makeRadialMap, makeRimMask } from './displacementMap.js';
import { getGlassQuality, subscribeGlassQuality } from './glassQuality.js';

const SVG_BACKDROP = typeof navigator !== 'undefined' && /Chrome\//.test(navigator.userAgent);
const MAX_PIXELS = 4_000_000; // 화면 몇 개 크기를 넘는 비정상적인 면만 생략
// [채널, 세기(0~1), 그 채널만 남기는 색 행렬]. 실제 유리처럼 파랑이 가장 많이, 빨강이 가장 적게 꺾인다 (분산).
const CHANNELS = [
  ['r', 0, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'],
  ['g', 0.5, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'],
  ['b', 1, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'],
];
const B_TO_ALPHA = '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0';

/**
 * @param {{ current: HTMLElement | null }} ref .glass 요소
 * @param {{ bezel?: number, depth?: number, aberration?: number, aberrationBase?: number, active?: unknown }} [opts]
 *   bezel: 굴곡이 있는 가장자리 폭(px). 없으면 --glass-bezel × 짧은 변의 절반
 *   depth: 맨 가장자리에서 배경을 끌어오는 거리(px). 없으면 --glass-refract × 짧은 변의 절반
 *   aberration: 가장자리 색수차. 굴절에 비례해 빨강이 파랑보다 이만큼 더 휜다 (0~1). 없으면 --glass-aberration
 *   aberrationBase: 면 전체에 깔리는 약한 색수차(px, 가운데 0 → 가장자리 최대, 직선). 없으면 --glass-aberration-base
 *   active: 요소가 조건부로 그려질 때 다시 측정하게 하는 값 (예: 토스트 객체)
 * @returns {import('react').ReactNode} 요소 옆에 그려 둘 숨은 <svg> (필터 정의)
 */
export function useGlassRefraction(ref, { bezel, depth, aberration, aberrationBase, active = true } = {}) {
  const id = `lg${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [map, setMap] = useState(null);
  const quality = useSyncExternalStore(subscribeGlassQuality, getGlassQuality, () => 'full');

  useEffect(() => {
    const el = ref.current;
    if (!el || !active || !SVG_BACKDROP) return undefined;
    if (matchMedia('(prefers-reduced-transparency: reduce)').matches) return undefined;

    let timer = 0;
    let last = '';
    const build = () => {
      const w = el.offsetWidth; // transform(scale) 영향을 받지 않는 레이아웃 크기
      const h = el.offsetHeight;
      const cs = getComputedStyle(el);
      const num = (v, name, fallback) => {
        if (v != null) return v;
        const n = parseFloat(cs.getPropertyValue(name));
        return Number.isFinite(n) ? n : fallback;
      };
      const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, w / 2, h / 2);
      const half = Math.min(w, h) / 2;
      const p = {
        // 굴절·굴곡 폭은 요소 크기에 비례 (실제 유리처럼 작은 유리도 큰 유리와 같은 모양)
        d: depth ?? num(null, '--glass-refract', 0.6) * half,
        bz: bezel ?? num(null, '--glass-bezel', 0.45) * half,
        ior: num(null, '--glass-ior', 1.5),
        ca: Math.min(Math.max(num(aberration, '--glass-aberration', 0), 0), 1),
        base: Math.max(num(aberrationBase, '--glass-aberration-base', 0), 0),
        blur: num(null, '--glass-blur', 3),
        blurEdge: num(null, '--glass-blur-edge', 14),
        rimW: num(null, '--glass-rim-width', 3),
        rimA: num(null, '--glass-rim-tint', 0),
        rimSat: num(null, '--glass-rim-saturate', 2.6),
        rimDeepen: num(null, '--glass-rim-deepen', 2),
      };
      const key = JSON.stringify([w, h, radius, p]);
      if (!w || !h || key === last) return;
      last = key;
      if (w * h > MAX_PIXELS) return setMap(null);
      setMap({
        w,
        h,
        ...p,
        lens: makeLensMap(w, h, p.bz, p.ior),
        radial: p.ca > 0 || p.base > 0 ? makeRadialMap(w, h) : null,
        rim: p.rimW > 0 && p.rimA > 0 ? makeRimMask(w, h, radius, Math.min(p.rimW, Math.min(w, h) / 4)) : null,
        // 면 전체 크기만큼 흐려 "뒤 배경에서 가장 많은 색"에 가깝게 만든다 (위치마다 색이 달라지지 않게)
        rimBlur: Math.min(Math.max(Math.max(w, h) / 2, 12), 200),
      });
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
  }, [ref, bezel, depth, aberration, aberrationBase, active]);

  // 흐림은 필터 안에서 하므로 CSS 쪽은 채도만 덧붙인다
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (!map) {
      el.style.removeProperty('backdrop-filter');
      el.style.removeProperty('-webkit-backdrop-filter');
      return undefined;
    }
    const sat = getComputedStyle(el).getPropertyValue('--glass-saturate').trim() || '1.7';
    const filter = `url(#${id}) saturate(${sat})`;
    el.style.setProperty('backdrop-filter', filter);
    el.style.setProperty('-webkit-backdrop-filter', filter);
    return () => {
      el.style.removeProperty('backdrop-filter');
      el.style.removeProperty('-webkit-backdrop-filter');
    };
  }, [ref, map, id]);

  if (!map) return null;
  const full = quality === 'full' && map.d > 0;
  const img = { x: 0, y: 0, width: map.w, height: map.h, preserveAspectRatio: 'none' };
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feImage href={map.lens} {...img} result="lens" />

        {/* 1) 고르지 않은 흐림: 렌즈 맵 B 값만큼 두꺼운 흐림을 얇은 흐림 위에 섞는다 */}
        <feGaussianBlur in="SourceGraphic" stdDeviation={map.blur} edgeMode="duplicate" result="sharp" />
        <feGaussianBlur in="SourceGraphic" stdDeviation={map.blurEdge} edgeMode="duplicate" result="soft" />
        <feColorMatrix in="lens" type="matrix" values={B_TO_ALPHA} result="blurMask" />
        <feComposite in="soft" in2="blurMask" operator="in" result="softPart" />
        <feComposite in="softPart" in2="sharp" operator="over" result="body" />

        {/* 2·3) 굴절 + 색수차 */}
        {full && map.radial && (
          <>
            <feImage href={map.radial} {...img} result="radial" />
            {CHANNELS.map(([name, k, matrix]) => (
              <Fragment key={name}>
                <feDisplacementMap in="body" in2="lens" scale={map.d * 2 * (1 + map.ca * k)} xChannelSelector="R" yChannelSelector="G" result={`d${name}`} />
                <feDisplacementMap in={`d${name}`} in2="radial" scale={map.base * 2 * k} xChannelSelector="R" yChannelSelector="G" result={`e${name}`} />
                <feColorMatrix in={`e${name}`} type="matrix" values={matrix} result={name} />
              </Fragment>
            ))}
            <feBlend in="r" in2="g" mode="screen" result="rg" />
            <feBlend in="rg" in2="b" mode="screen" result="lensed" />
          </>
        )}
        {full && !map.radial && (
          <feDisplacementMap in="body" in2="lens" scale={map.d * 2} xChannelSelector="R" yChannelSelector="G" result="lensed" />
        )}
        {!full && <feOffset in="body" dx="0" dy="0" result="lensed" />}

        {/* 4) 가장자리 색: 뒤 배경의 대표 색(아주 세게 흐린 색)을 띠 모양으로 두른다 */}
        {map.rim ? (
          <>
            <feGaussianBlur in="SourceGraphic" stdDeviation={map.rimBlur} edgeMode="duplicate" result="avg" />
            <feColorMatrix in="avg" type="saturate" values={map.rimSat} result="avgSat0" />
            {/* 배경보다 진하게: 유리 두께 속에 색이 고인 것처럼. 감마라서 흰 바탕은 탁해지지 않는다 */}
            <feComponentTransfer in="avgSat0" result="avgSat">
              <feFuncR type="gamma" amplitude="1" exponent={map.rimDeepen} offset="0" />
              <feFuncG type="gamma" amplitude="1" exponent={map.rimDeepen} offset="0" />
              <feFuncB type="gamma" amplitude="1" exponent={map.rimDeepen} offset="0" />
            </feComponentTransfer>
            <feColorMatrix in="avgSat" type="matrix" values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${map.rimA} 0`} result="avgA" />
            <feImage href={map.rim} {...img} result="rimMask" />
            <feComposite in="avgA" in2="rimMask" operator="in" result="rimColor" />
            <feComposite in="rimColor" in2="lensed" operator="over" />
          </>
        ) : (
          <feOffset in="lensed" dx="0" dy="0" />
        )}
      </filter>
    </svg>
  );
}

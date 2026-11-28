// 잠금 게이트 (ai.md D17): 오너 세션이 무활동으로 잠겨도 화면을 떠나지 않는다.
// 잠긴 뒤 첫 클릭·키 입력을 가로채 그 자리에서 Touch ID(패스키)를 띄우고, 통과하면 계속 쓴다.
//
// Safari 는 사용자 제스처 '그 순간'에만 WebAuthn 창을 띄울 수 있다 → 인증 옵션(챌린지)을 미리 받아 두고
// 제스처 핸들러 안에서 곧바로 startAuthentication 을 호출한다. 챌린지(5분)는 4분마다 갱신.
import { useCallback, useEffect, useRef, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from './api.js';
import { messageFor } from './messages.js';
import { useGlassRefraction } from './design/index.js';

const REFRESH_OPTIONS_MS = 4 * 60_000;

/** @param {{ onUnlocked: () => void }} props */
export function LockGate({ onUnlocked }) {
  const [state, setState] = useState('preparing'); // preparing | ready | prompting | unavailable
  const [error, setError] = useState(null);
  const pillRef = useRef(null);
  const refraction = useGlassRefraction(pillRef, { active: state });
  const options = useRef(null);

  const prepare = useCallback(async () => {
    try {
      options.current = await api.passkey.loginOptions();
      setState((s) => (s === 'prompting' ? s : 'ready'));
    } catch (e) {
      options.current = null;
      // 이 세션으로 쓸 패스키가 없음(개발 로그인 등) → 다시 로그인하도록
      setState('unavailable');
      if (e.code !== 'PASSKEY_NOT_REGISTERED') setError(e);
    }
  }, []);

  useEffect(() => {
    prepare();
    const t = setInterval(prepare, REFRESH_OPTIONS_MS);
    return () => clearInterval(t);
  }, [prepare]);

  // 제스처 핸들러 안에서 '동기적으로' 호출해야 한다 (await 앞에 다른 await 를 두지 말 것)
  const unlock = useCallback(() => {
    const optionsJSON = options.current;
    if (!optionsJSON || state === 'prompting') return;
    options.current = null; // 챌린지는 1회용
    setState('prompting');
    setError(null);
    startAuthentication({ optionsJSON })
      .then((response) => api.passkey.loginVerify(response))
      .then(() => onUnlocked())
      .catch((e) => {
        setError(e?.name === 'NotAllowedError' || e?.name === 'AbortError' ? { code: 'PASSKEY_CANCELLED' } : e);
        setState('preparing');
        prepare();
      });
  }, [state, onUnlocked, prepare]);

  // 첫 활동 가로채기: 키 입력도 캡처 단계에서 막고 인증으로 돌린다
  useEffect(() => {
    if (state === 'unavailable') return;
    const onKey = (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      unlock();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [state, unlock]);

  const relogin = async () => {
    await api.logout().catch(() => {});
    location.assign('/login');
  };

  return (
    <>
      {/* 화면은 그대로 보이게, 클릭만 가로채는 투명 막 */}
      {state !== 'unavailable' && (
        <div
          className="lock-catcher"
          aria-hidden="true"
          onPointerDown={(e) => {
            e.preventDefault();
            unlock();
          }}
          onClick={(e) => e.preventDefault()}
          onContextMenu={(e) => e.preventDefault()}
        />
      )}
      <div ref={pillRef} className={`lock-pill glass glass-clear ${error ? 'has-error' : ''}`} role="status" aria-live="polite">
        {refraction}
        <span aria-hidden="true">🔒</span>
        {state === 'unavailable' ? (
          <>
            <span>잠겼어요. 이 세션으로 확인할 패스키가 없어요.</span>
            <button type="button" className="lock-pill-btn" onClick={relogin}>
              다시 로그인
            </button>
          </>
        ) : state === 'prompting' ? (
          <span>패스키로 확인하는 중…</span>
        ) : (
          <>
            <span>{error ? messageFor(error) : '잠겨 있어요 · 아무 곳이나 누르면 패스키로 확인해요'}</span>
            <button type="button" className="lock-pill-btn" onClick={relogin}>
              다른 계정
            </button>
          </>
        )}
      </div>
    </>
  );
}

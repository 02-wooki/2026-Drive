import { useEffect, useState, useCallback } from 'react';
import { api, AUTH_LOST_EVENT } from './api.js';
import { useLocation } from './router.js';
import { uploads } from './uploads.js';
import { LoginPage } from './pages/LoginPage.jsx';
import { PasskeyPage } from './pages/PasskeyPage.jsx';
import { Browser } from './browser/Browser.jsx';
import { LockGate } from './LockGate.jsx';

const RETURN_KEY = 'wd.returnTo';

export function App() {
  const [loc, navigate] = useLocation();
  /** undefined = 확인 중 */
  const [me, setMe] = useState(undefined);
  /** 잠금 해제 때마다 증가 → 탐색기를 새로 그려 목록을 다시 불러온다 */
  const [epoch, setEpoch] = useState(0);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch {
      setMe({ user: null });
    }
  }, []);

  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  // 요청이 401 이면 상태 재확인 → 잠금이면 그 자리에서 게이트, 만료면 로그인 화면
  useEffect(() => {
    addEventListener(AUTH_LOST_EVENT, refreshMe);
    return () => removeEventListener(AUTH_LOST_EVENT, refreshMe);
  }, [refreshMe]);

  /** 잠긴 오너 세션: 화면은 그대로 두고 LockGate 로 푼다 (D17) */
  const lockedUser = me?.locked ? me.lockedUser : null;
  const shownUser = me?.user ?? lockedUser;

  // 로그인 상태에 맞는 화면으로 보내기. 로그인 화면으로 튕겨 나가면 보던 위치를 기억했다가 돌아온다.
  useEffect(() => {
    if (me === undefined) return;
    const p = loc.pathname;
    const remember = () => {
      if (!p.startsWith('/login')) sessionStorage.setItem(RETURN_KEY, p + location.search);
    };
    if (me.pending === 'passkey' && !lockedUser) {
      if (p !== '/login/passkey') {
        remember();
        navigate('/login/passkey', { replace: true });
      }
    } else if (!shownUser) {
      if (p !== '/login') {
        remember();
        navigate('/login', { replace: true });
      }
    } else if (p.startsWith('/login')) {
      const back = sessionStorage.getItem(RETURN_KEY);
      sessionStorage.removeItem(RETURN_KEY);
      navigate(back && back.startsWith('/') && !back.startsWith('//') ? back : '/', { replace: true });
    }
  }, [me, lockedUser, shownUser, loc.pathname, navigate]);

  const onUnlocked = useCallback(async () => {
    await refreshMe();
    setEpoch((n) => n + 1);
    uploads.resumeAfterAuth(); // 잠금 때문에 멈춘 업로드 이어서
  }, [refreshMe]);

  if (me === undefined) return <div className="splash" aria-busy="true" />;

  if (loc.pathname === '/login/passkey' && !lockedUser) {
    return <PasskeyPage onDone={refreshMe} />;
  }
  if (loc.pathname.startsWith('/login') || !shownUser) {
    return <LoginPage error={loc.search.get('error')} onDone={refreshMe} />;
  }
  return (
    <>
      <Browser
        key={epoch}
        user={shownUser}
        loc={loc}
        navigate={navigate}
        onLogout={async () => {
          await api.logout().catch(() => {});
          setMe({ user: null });
        }}
      />
      {lockedUser && <LockGate onUnlocked={onUnlocked} />}
    </>
  );
}

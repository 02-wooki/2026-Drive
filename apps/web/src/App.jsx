import { useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import { useLocation } from './router.js';
import { LoginPage } from './pages/LoginPage.jsx';
import { PasskeyPage } from './pages/PasskeyPage.jsx';
import { Browser } from './browser/Browser.jsx';

export function App() {
  const [loc, navigate] = useLocation();
  /** undefined = 확인 중, null = 비로그인 */
  const [me, setMe] = useState(undefined);

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

  // 로그인 상태에 맞는 화면으로 보내기
  useEffect(() => {
    if (me === undefined) return;
    const p = loc.pathname;
    if (me.pending === 'passkey') {
      if (p !== '/login/passkey') navigate('/login/passkey', { replace: true });
    } else if (!me.user) {
      if (p !== '/login') navigate('/login', { replace: true });
    } else if (p.startsWith('/login')) {
      navigate('/', { replace: true });
    }
  }, [me, loc.pathname, navigate]);

  if (me === undefined) return <div className="splash" aria-busy="true" />;

  if (loc.pathname === '/login/passkey') {
    return <PasskeyPage onDone={refreshMe} />;
  }
  if (loc.pathname === '/login' || !me.user) {
    return <LoginPage error={loc.search.get('error')} onDone={refreshMe} />;
  }
  return (
    <Browser
      user={me.user}
      loc={loc}
      navigate={navigate}
      onLogout={async () => {
        await api.logout().catch(() => {});
        setMe({ user: null });
      }}
    />
  );
}

// 아주 작은 라우터: pathname + query 를 상태로 들고, pushState/popstate 로 브라우저 뒤로·앞으로와 연동.
import { useEffect, useState, useCallback } from 'react';

function snapshot() {
  return { pathname: location.pathname, search: new URLSearchParams(location.search) };
}

export function useLocation() {
  const [loc, setLoc] = useState(snapshot);
  useEffect(() => {
    const onPop = () => setLoc(snapshot());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((url, { replace = false } = {}) => {
    const next = new URL(url, location.origin);
    if (next.pathname + next.search === location.pathname + location.search) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', next.pathname + next.search);
    setLoc(snapshot());
  }, []);
  return [loc, navigate];
}

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { messageFor } from '../messages.js';
import { AppMark } from '../browser/icons.jsx';
import { ProviderMark } from './ProviderMark.jsx';

// 버튼 문구는 각 사 가이드의 표준 문구를 따른다.
//  - 카카오: "카카오 로그인" (가이드의 전체형 레이블 그대로)
//  - Google: "Sign in with Google" 의 한국어 (현지화 권장)
//  - GitHub: 별도 규정 없음 → Google 과 같은 형식
const PROVIDER_LABEL = {
  kakao: '카카오 로그인',
  google: 'Google 계정으로 로그인',
  github: 'GitHub 계정으로 로그인',
};

/** @param {{ error: string | null, onDone: () => void }} props */
export function LoginPage({ error, onDone }) {
  const [providers, setProviders] = useState(null);
  const [devLogin, setDevLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState(null);

  useEffect(() => {
    document.title = '로그인 — Wooki Drive';
    api
      .providers()
      .then((r) => {
        setProviders(r.providers);
        setDevLogin(Boolean(r.devLogin));
      })
      .catch((e) => {
        setProviders([]);
        setLocalError(e);
      });
  }, []);

  const shownError = localError ?? (error ? { code: error } : null);

  return (
    <main className="login">
      <section className="login-card glass" aria-labelledby="login-title">
        <AppMark className="login-mark" />
        <h1 id="login-title">Wooki Drive</h1>

        {shownError && (
          <p className="notice notice-error" role="alert">
            {messageFor(shownError)}
          </p>
        )}

        <div className="login-buttons">
          {providers === null && <div className="login-skeleton" aria-busy="true" />}
          {providers?.map((p) => (
            <a key={p} className={`login-btn login-btn-${p}`} href={`/auth/${p}/start`}>
              <span className="login-btn-mark">
                <ProviderMark provider={p} />
              </span>
              <span className="login-btn-label">{PROVIDER_LABEL[p] ?? p}</span>
            </a>
          ))}
          {providers?.length === 0 && !devLogin && <p className="login-empty">설정된 로그인 방식이 없어요.</p>}
        </div>

        {devLogin && (
          <div className="dev-login">
            <span className="dev-login-label">개발용 로그인 (localhost 전용)</span>
            <div className="dev-login-row">
              {['owner', 'guest'].map((role) => (
                <button
                  key={role}
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.devLogin(role);
                      onDone();
                    } catch (e) {
                      setLocalError(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {role === 'owner' ? '오너로' : '게스트로'}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <p className="login-guest-note">
        포트폴리오를 보러 오셨다면 아무 계정으로나 로그인해 보세요. 데모 폴더를 둘러보고 방명록을 남길 수 있어요.
        <br />
        이메일은 받지 않고 닉네임만 사용해요.
      </p>
    </main>
  );
}

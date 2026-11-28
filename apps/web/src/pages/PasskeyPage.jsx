import { useEffect, useRef, useState } from 'react';
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, ApiError } from '../api.js';
import { messageFor } from '../messages.js';
import { AppMark } from '../browser/icons.jsx';

/** 브라우저 WebAuthn 오류 → 코드 */
function webauthnError(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return { code: 'PASSKEY_CANCELLED' };
  if (e?.code === 'ERROR_INVALID_DOMAIN') return { code: 'PASSKEY_INVALID_DOMAIN' }; // IP 주소 접속 등
  if (e instanceof ApiError) return e;
  return { code: 'PASSKEY_FAILED' };
}

/** @param {{ onDone: () => void }} props */
export function PasskeyPage({ onDone }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const supported = browserSupportsWebAuthn();

  useEffect(() => {
    document.title = '본인 확인 — Wooki Drive';
    api.passkey
      .status()
      .then(setStatus)
      .catch((e) => setError(e));
  }, []);

  // 들어오자마자 패스키 확인을 바로 띄운다(버튼을 누르지 않아도). 등록은 자동으로 하지 않음.
  // 브라우저가 사용자 동작 없이는 막는 경우(일부 Safari)엔 조용히 실패 → 버튼으로 다시.
  const autoTried = useRef(false);
  useEffect(() => {
    if (!status?.canLogin || !supported || autoTried.current) return;
    autoTried.current = true;
    run('login', { quiet: true });
  }, [status, supported]);

  async function run(kind, { quiet = false } = {}) {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'login') {
        const optionsJSON = await api.passkey.loginOptions();
        await api.passkey.loginVerify(await startAuthentication({ optionsJSON }));
      } else {
        const optionsJSON = await api.passkey.registerOptions();
        await api.passkey.registerVerify(await startRegistration({ optionsJSON }));
      }
      onDone();
    } catch (e) {
      const err = webauthnError(e);
      if (!(quiet && err.code === 'PASSKEY_CANCELLED')) setError(err);
    } finally {
      setBusy(false);
    }
  }

  const expired = status && !status.pending;

  return (
    <main className="login">
      <section className="login-card glass" aria-labelledby="passkey-title">
        <AppMark className="login-mark" />
        <h1 id="passkey-title">본인 확인</h1>

        {!supported && (
          <p className="notice notice-error" role="alert">
            {messageFor('PASSKEY_UNSUPPORTED')}
          </p>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {messageFor(error)}
          </p>
        )}

        {status === null && !error && <div className="login-skeleton" aria-busy="true" />}

        {status?.canLogin && (
          <div className="login-buttons">
            <button type="button" className="btn btn-primary btn-large" disabled={busy || !supported} onClick={() => run('login')}>
              {busy ? '확인 중…' : '패스키로 확인'}
            </button>
          </div>
        )}

        {status?.canRegister && (
          <>
            <p className="login-lede">
              처음 로그인했어요. 이 기기에 패스키를 등록하면 다음부터는 패스키로 확인해요.
              <br />
              <strong>최초 등록은 한 번만 가능해요.</strong> 이후 기기 추가는 로그인한 상태에서만 할 수 있어요.
            </p>
            <div className="login-buttons">
              <button type="button" className="btn btn-primary btn-large" disabled={busy || !supported} onClick={() => run('register')}>
                {busy ? '등록 중…' : '패스키 등록'}
              </button>
            </div>
          </>
        )}

        {expired && <p className="login-lede">확인 시간이 지났어요. 처음부터 다시 로그인해 주세요.</p>}
        {status?.pending && !status.canLogin && !status.canRegister && (
          <p className="login-lede">잠겼지만 이 세션으로 확인할 수 있는 패스키가 없어요. 다시 로그인해 주세요.</p>
        )}

        <p className="login-guest-note">
          <a
            href="/login"
            onClick={async (e) => {
              e.preventDefault();
              await api.logout().catch(() => {});
              location.assign('/login');
            }}
          >
            다른 계정으로 로그인
          </a>
        </p>
      </section>
    </main>
  );
}

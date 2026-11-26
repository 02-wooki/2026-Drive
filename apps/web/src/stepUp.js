// 되돌릴 수 없는 작업 전 패스키 재인증 (ai.md D16).
// 서버가 STEP_UP_REQUIRED 를 주면 Touch ID 로 한 번 더 확인하고 같은 작업을 한 번 다시 시도한다.
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from './api.js';

/**
 * @template T
 * @param {() => Promise<T>} action
 * @returns {Promise<T>}
 */
export async function withStepUp(action) {
  try {
    return await action();
  } catch (err) {
    if (err?.code !== 'STEP_UP_REQUIRED') throw err;
  }
  const optionsJSON = await api.passkey.reauthOptions();
  let response;
  try {
    response = await startAuthentication({ optionsJSON });
  } catch (e) {
    const err = new Error('cancelled');
    err.code = e?.name === 'NotAllowedError' || e?.name === 'AbortError' ? 'PASSKEY_CANCELLED' : 'PASSKEY_FAILED';
    throw err;
  }
  await api.passkey.reauthVerify(response);
  return action();
}

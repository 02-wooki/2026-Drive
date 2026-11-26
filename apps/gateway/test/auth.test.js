// 로그인 흐름 테스트. OAuth 공급자와 WebAuthn 인증기는 가짜로 주입한다
// (암호 검증 자체는 @simplewebauthn/server 의 책임 — 여기서는 우리 쪽 상태 관리·권한 로직을 검증).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { toKeyList } from '@wooki-drive/shared/node';
import { createApp } from '../src/app.js';
import { SessionStore, cookieName } from '../src/sessions.js';
import { AgentClient, AgentMonitor } from '../src/agent-client.js';
import { PasskeyStore } from '../src/auth/passkeys.js';
import { PROVIDERS, cleanNickname } from '../src/auth/providers.js';
import { loadConfig } from '../src/config.js';

const ORIGIN = 'https://drive.example.test';
const RP_ID = 'drive.example.test';
const HOUR = 3600_000;
const SESSION = { owner: { absoluteMs: 12 * HOUR, idleMs: 2 * HOUR }, guest: { absoluteMs: 24 * HOUR, idleMs: HOUR } };
const SID = cookieName(true);
const OAUTH_COOKIE = '__Host-wd_oauth';

// ── 가짜 OAuth 공급자 ──
const fakeUsers = { 'code-guest': { id: 7, login: 'guest7', name: '손님' }, 'code-owner': { id: 42, login: 'wooki', name: '우키' } };
let lastGoogleChallenge = null;
async function fakeFetch(url, init = {}) {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url === PROVIDERS.github.tokenUrl) {
    const code = new URLSearchParams(init.body.toString()).get('code');
    return fakeUsers[code] ? json(200, { access_token: `tok-${code}` }) : json(400, { error: 'bad_verification_code' });
  }
  if (url === PROVIDERS.github.userUrl) {
    const code = init.headers.Authorization.replace('Bearer tok-', '');
    return json(200, fakeUsers[code]);
  }
  if (url === PROVIDERS.google.tokenUrl) {
    const form = new URLSearchParams(init.body.toString());
    const v = form.get('code_verifier');
    const ok = v && createHash('sha256').update(v).digest('base64url') === lastGoogleChallenge;
    return ok ? json(200, { access_token: 'gtok' }) : json(400, { error: 'invalid_grant' });
  }
  if (url === PROVIDERS.google.userUrl) return json(200, { sub: '1098', name: '구글 손님' });
  throw new Error(`unexpected fetch ${url}`);
}

// ── 가짜 WebAuthn ──
const fakeWebauthn = {
  async generateRegistrationOptions(o) {
    return { challenge: `reg-${randomBytes(8).toString('hex')}`, rp: { id: o.rpID }, excludeCredentials: o.excludeCredentials };
  },
  async verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID, requireUserVerification }) {
    const ok = response.challenge === expectedChallenge && expectedOrigin === ORIGIN && expectedRPID === RP_ID && requireUserVerification;
    return ok
      ? { verified: true, registrationInfo: { credential: { id: response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } } }
      : { verified: false };
  },
  async generateAuthenticationOptions(o) {
    return { challenge: `auth-${randomBytes(8).toString('hex')}`, allowCredentials: o.allowCredentials };
  },
  async verifyAuthenticationResponse({ response, expectedChallenge, credential, requireUserVerification }) {
    const ok =
      response.challenge === expectedChallenge &&
      credential.id === response.id &&
      Buffer.from(credential.publicKey).equals(Buffer.from([1, 2, 3])) &&
      requireUserVerification;
    return { verified: ok, authenticationInfo: { newCounter: ok ? credential.counter + 1 : 0 } };
  },
};

function build({ limits } = {}) {
  const store = new SessionStore();
  const passkeys = new PasskeyStore();
  const app = createApp({
    publicOrigin: ORIGIN,
    cookieSecure: true,
    demoRoot: process.cwd(),
    oauth: { github: { clientId: 'gh-id', clientSecret: 'gh-secret' }, google: { clientId: 'g-id', clientSecret: 'g-secret' } },
    ownerAccounts: new Set(['github:42']),
    session: SESSION,
    store,
    passkeys,
    agent: new AgentClient({ baseUrl: 'http://127.0.0.1:9', secrets: toKeyList('z'.repeat(40)) }),
    monitor: new AgentMonitor(),
    fetch: fakeFetch,
    webauthn: fakeWebauthn,
    limits,
  });
  return { app, store, passkeys };
}

const listen = (app) =>
  new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

let server, base, ctx;
before(async () => {
  ctx = build();
  server = await listen(ctx.app);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

/** Set-Cookie 에서 특정 쿠키 값 */
function cookieValue(res, name) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
}

const req = (path, { cookies = {}, method = 'GET', body, origin = method === 'GET' ? undefined : ORIGIN } = {}) =>
  fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

/** start → callback 한 번에. 반환: callback 응답 */
async function login(provider, code, extraCookies = {}) {
  const start = await req(`/auth/${provider}/start`);
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  const state = loc.searchParams.get('state');
  if (provider === 'google') lastGoogleChallenge = loc.searchParams.get('code_challenge');
  assert.equal(cookieValue(start, OAUTH_COOKIE), state);
  return req(`/auth/${provider}/callback?code=${code}&state=${state}`, { cookies: { [OAUTH_COOKIE]: state, ...extraCookies } });
}

const me = async (sid) => (await req('/api/me', { cookies: { [SID]: sid } })).json();

test('providers list and authorize redirect', async () => {
  assert.deepEqual(await (await req('/auth/providers')).json(), { providers: ['google', 'github'] });

  const r = await req('/auth/github/start');
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, PROVIDERS.github.authorizeUrl);
  assert.equal(loc.searchParams.get('client_id'), 'gh-id');
  assert.equal(loc.searchParams.get('redirect_uri'), `${ORIGIN}/auth/github/callback`);
  assert.equal(loc.searchParams.get('code_challenge'), null); // github: PKCE 미사용
  assert.match(r.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);

  const g = new URL((await req('/auth/google/start')).headers.get('location'));
  assert.equal(g.searchParams.get('code_challenge_method'), 'S256');

  assert.equal((await req('/auth/kakao/start')).status, 404); // 설정 안 됨
  assert.equal((await req('/auth/evil/start')).status, 404);
});

test('guest login (github, non-whitelisted)', async () => {
  const cb = await login('github', 'code-guest');
  assert.equal(cb.status, 303);
  assert.equal(cb.headers.get('location'), '/');
  assert.equal(cookieValue(cb, OAUTH_COOKIE), ''); // state 쿠키 제거
  const sid = cookieValue(cb, SID);
  assert.ok(sid);
  assert.deepEqual(await me(sid), { user: { role: 'guest', nickname: '손님', provider: 'github' } });
  // 게스트 세션에 이메일 등 불필요한 정보 없음
  const s = ctx.store.get(sid);
  assert.deepEqual(Object.keys(s.user).sort(), ['nickname', 'provider', 'sub']);
});

test('google login uses PKCE', async () => {
  const cb = await login('google', 'any');
  assert.equal(cb.headers.get('location'), '/');
  assert.equal((await me(cookieValue(cb, SID))).user.nickname, '구글 손님');
});

test('state must match cookie, be single-use and provider-bound', async () => {
  const fail = (r) => r.headers.get('location');
  const start = await req('/auth/github/start');
  const state = new URL(start.headers.get('location')).searchParams.get('state');

  // 쿠키 없음 (다른 브라우저에서 콜백 = 로그인 CSRF)
  assert.equal(fail(await req(`/auth/github/callback?code=code-guest&state=${state}`)), '/login?error=OAUTH_STATE_MISMATCH');
  // 위 시도로 state 가 이미 소모됨 → 정상 쿠키로도 재사용 불가
  assert.equal(
    fail(await req(`/auth/github/callback?code=code-guest&state=${state}`, { cookies: { [OAUTH_COOKIE]: state } })),
    '/login?error=OAUTH_STATE_MISMATCH',
  );

  // 다른 공급자 콜백으로
  const s2 = new URL((await req('/auth/github/start')).headers.get('location')).searchParams.get('state');
  assert.equal(
    fail(await req(`/auth/google/callback?code=x&state=${s2}`, { cookies: { [OAUTH_COOKIE]: s2 } })),
    '/login?error=OAUTH_STATE_MISMATCH',
  );
});

test('provider errors', async () => {
  const s = new URL((await req('/auth/github/start')).headers.get('location')).searchParams.get('state');
  const denied = await req(`/auth/github/callback?error=access_denied&state=${s}`, { cookies: { [OAUTH_COOKIE]: s } });
  assert.equal(denied.headers.get('location'), '/login?error=OAUTH_DENIED');
  assert.equal(cookieValue(denied, SID), undefined);

  const bad = await login('github', 'code-bad');
  assert.equal(bad.headers.get('location'), '/login?error=OAUTH_TOKEN_FAILED');
});

test('login always replaces an existing session (fixation)', async () => {
  const { id: planted } = ctx.store.create({ role: 'guest', user: { provider: 'x', sub: '1', nickname: 'x' } }, SESSION.guest);
  const cb = await login('github', 'code-guest', { [SID]: planted });
  assert.notEqual(cookieValue(cb, SID), planted);
  assert.equal(ctx.store.get(planted), null);
});

test('owner: whitelist → passkey registration (bootstrap) → owner', async () => {
  const cb = await login('github', 'code-owner');
  assert.equal(cb.headers.get('location'), '/login/passkey');
  const pending = cookieValue(cb, SID);

  // 패스키 전에는 아무 권한 없음
  assert.deepEqual(await me(pending), { user: null, pending: 'passkey' });
  assert.equal((await req('/api/status', { cookies: { [SID]: pending } })).status, 401);
  assert.equal((await req('/api/files/list?path=%2F', { cookies: { [SID]: pending } })).status, 401);

  const status = await (await req('/auth/passkey/status', { cookies: { [SID]: pending } })).json();
  assert.deepEqual(status, { pending: true, registered: false, canRegister: true, canLogin: false });

  // CSRF: Origin 없이 거부
  assert.equal((await req('/auth/passkey/register/options', { method: 'POST', origin: null, cookies: { [SID]: pending } })).status, 403);

  const opts = await (await req('/auth/passkey/register/options', { method: 'POST', cookies: { [SID]: pending } })).json();
  assert.equal(opts.rp.id, RP_ID);

  // 틀린 챌린지 → 실패, 그리고 챌린지 소모됨
  const wrong = await req('/auth/passkey/register/verify', { method: 'POST', cookies: { [SID]: pending }, body: { id: 'cred-1', challenge: 'nope' } });
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: 'PASSKEY_FAILED' });
  const replay = await req('/auth/passkey/register/verify', { method: 'POST', cookies: { [SID]: pending }, body: { id: 'cred-1', challenge: opts.challenge } });
  assert.deepEqual(await replay.json(), { error: 'PASSKEY_CHALLENGE_EXPIRED' });

  const opts2 = await (await req('/auth/passkey/register/options', { method: 'POST', cookies: { [SID]: pending } })).json();
  const ok = await req('/auth/passkey/register/verify', { method: 'POST', cookies: { [SID]: pending }, body: { id: 'cred-1', challenge: opts2.challenge } });
  assert.equal(ok.status, 200);
  const owner = cookieValue(ok, SID);
  assert.ok(owner && owner !== pending, 'privilege change must rotate the session id');
  assert.equal(ctx.store.get(pending), null);
  assert.equal((await me(owner)).user.role, 'owner');
  assert.equal(ctx.passkeys.count, 1);
  assert.equal(ctx.passkeys.find('cred-1').createdBy, 'github:42');
});

test('owner: registration closes after bootstrap; login requires passkey', async () => {
  assert.equal(ctx.passkeys.count, 1, 'depends on previous test');

  const cb = await login('github', 'code-owner');
  const pending = cookieValue(cb, SID);

  // OAuth 계정만 털린 공격자 시나리오: 새 패스키 등록 불가
  const reg = await req('/auth/passkey/register/options', { method: 'POST', cookies: { [SID]: pending } });
  assert.equal(reg.status, 403);
  assert.deepEqual(await reg.json(), { error: 'PASSKEY_REGISTRATION_CLOSED' });

  const status = await (await req('/auth/passkey/status', { cookies: { [SID]: pending } })).json();
  assert.deepEqual(status, { pending: true, registered: true, canRegister: false, canLogin: true });

  // 등록 안 된 자격 증명
  const o1 = await (await req('/auth/passkey/login/options', { method: 'POST', cookies: { [SID]: pending } })).json();
  assert.deepEqual(o1.allowCredentials, [{ id: 'cred-1', transports: ['internal'] }]);
  const unknown = await req('/auth/passkey/login/verify', { method: 'POST', cookies: { [SID]: pending }, body: { id: 'cred-x', challenge: o1.challenge } });
  assert.equal(unknown.status, 400);

  const o2 = await (await req('/auth/passkey/login/options', { method: 'POST', cookies: { [SID]: pending } })).json();
  const ok = await req('/auth/passkey/login/verify', { method: 'POST', cookies: { [SID]: pending }, body: { id: 'cred-1', challenge: o2.challenge } });
  assert.equal(ok.status, 200);
  const owner = cookieValue(ok, SID);
  assert.notEqual(owner, pending);
  assert.equal((await me(owner)).user.role, 'owner');
  assert.equal(ctx.passkeys.find('cred-1').counter, 1);

  // owner 는 기기 추가 등록 가능
  const add = await req('/auth/passkey/register/options', { method: 'POST', cookies: { [SID]: owner } });
  assert.equal(add.status, 200);
  assert.deepEqual((await add.json()).excludeCredentials, [{ id: 'cred-1', transports: ['internal'] }]);

  // 게스트·비로그인은 패스키 로그인 시도 불가
  const guest = cookieValue(await login('github', 'code-guest'), SID);
  assert.equal((await req('/auth/passkey/login/options', { method: 'POST', cookies: { [SID]: guest } })).status, 403);
  assert.equal((await req('/auth/passkey/login/options', { method: 'POST' })).status, 403);
});

test('rate limit on login start', async () => {
  const small = build({ limits: { login: 3 } });
  const s = await listen(small.app);
  try {
    const url = `http://127.0.0.1:${s.address().port}/auth/github/start`;
    for (let i = 0; i < 3; i++) assert.equal((await fetch(url, { redirect: 'manual' })).status, 302);
    const r = await fetch(url, { redirect: 'manual' });
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'LOGIN_RATE_LIMITED' });
  } finally {
    s.close();
  }
});

test('config validation', () => {
  const base = {
    PUBLIC_ORIGIN: ORIGIN,
    AGENT_URL: 'http://127.0.0.1:7401',
    AGENT_HMAC_SECRET: 'a'.repeat(40),
    DATA_DIR: process.cwd(),
  };
  const c = loadConfig({ ...base, OAUTH_GITHUB_CLIENT_ID: 'id', OAUTH_GITHUB_CLIENT_SECRET: 's', OWNER_ACCOUNTS: 'github:42, google:1098' });
  assert.deepEqual(Object.keys(c.oauth), ['github']);
  assert.deepEqual([...c.ownerAccounts], ['github:42', 'google:1098']);
  assert.throws(() => loadConfig({ ...base, OWNER_ACCOUNTS: 'someone@example.com' }), /OWNER_ACCOUNTS/);
  assert.throws(() => loadConfig({ ...base, OAUTH_GOOGLE_CLIENT_ID: 'id' }), /SECRET/);
  assert.doesNotThrow(() => loadConfig({ ...base, OAUTH_KAKAO_CLIENT_ID: 'id' })); // 카카오는 secret 선택
  assert.throws(() => loadConfig({ ...base, COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
});

test('cleanNickname', () => {
  assert.equal(cleanNickname('  우키‮\n  ', 'x'), '우키');
  assert.equal(cleanNickname('', 'github 사용자'), 'github 사용자');
  assert.equal([...cleanNickname('가'.repeat(100), 'x')].length, 40);
});

// gateway 설정 로드. 값은 환경변수(또는 env 파일)에서만 읽는다 — 하드코딩 금지 (ai.md §9).
//
// env 파일 위치 우선순위:
//   1) WOOKI_GATEWAY_ENV_FILE
//   2) /etc/wooki-drive/gateway.env  (파이 운영, systemd)
//   3) apps/gateway/.env             (개발)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toKeyList, withoutEmpty } from '@wooki-drive/shared/node';

const here = path.dirname(fileURLToPath(import.meta.url));

function findEnvFile() {
  const candidates = [
    process.env.WOOKI_GATEWAY_ENV_FILE,
    '/etc/wooki-drive/gateway.env',
    path.join(here, '..', '.env'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function required(env, name) {
  const v = env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 필요합니다`);
  return v;
}

function port(value, fallback, name) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} 가 올바르지 않습니다`);
  return n;
}

const HOUR = 3600_000;

function positive(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!(n > 0)) throw new Error(`${name} 는 양수여야 합니다`);
  return n;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(rawEnv = process.env) {
  let envFile = null;
  if (rawEnv === process.env) {
    envFile = findEnvFile();
    if (envFile) process.loadEnvFile(envFile);
  }
  const env = withoutEmpty(rawEnv); // `KEY=` 는 설정 안 한 것으로

  const publicOrigin = new URL(required(env, 'PUBLIC_ORIGIN')).origin; // 예: https://drive.wooki.cloud
  const agentUrl = new URL(required(env, 'AGENT_URL')); // 예: http://192.168.0.20:7401
  if (agentUrl.protocol !== 'http:') throw new Error('AGENT_URL 은 http:// (LAN) 이어야 합니다');

  const dataDir = path.resolve(required(env, 'DATA_DIR')); // 예: /var/lib/wooki-drive
  const cookieSecure = env.COOKIE_SECURE !== 'false';
  if (!cookieSecure && publicOrigin.startsWith('https:')) {
    throw new Error('https 운영에서 COOKIE_SECURE=false 는 허용되지 않습니다');
  }

  // OAuth: CLIENT_ID 가 있는 공급자만 활성화
  const oauth = {};
  for (const id of ['kakao', 'google', 'github']) {
    const up = id.toUpperCase();
    const clientId = env[`OAUTH_${up}_CLIENT_ID`];
    if (!clientId) continue;
    const clientSecret = env[`OAUTH_${up}_CLIENT_SECRET`] ?? '';
    if (!clientSecret && id !== 'kakao') throw new Error(`OAUTH_${up}_CLIENT_SECRET 가 필요합니다`);
    oauth[id] = { clientId, clientSecret };
  }

  // 오너 화이트리스트: "github:12345,google:1098..." — 이메일이 아니라 provider + 고유 ID (ai.md §5)
  const ownerAccounts = new Set(
    (env.OWNER_ACCOUNTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const a of ownerAccounts) {
    if (!/^(kakao|google|github):[A-Za-z0-9_-]{1,128}$/.test(a)) throw new Error(`OWNER_ACCOUNTS 형식 오류: ${a}`);
  }

  // 개발용 로그인: OAuth 없이 역할을 골라 로그인. localhost + http 에서만 허용 (운영 설정이면 시작 자체를 거부)
  const devLogin = env.DEV_LOGIN === 'true';
  if (devLogin) {
    const host = new URL(publicOrigin).hostname;
    if (cookieSecure || !['localhost', '127.0.0.1'].includes(host)) {
      throw new Error('DEV_LOGIN 은 PUBLIC_ORIGIN 이 http://localhost 이고 COOKIE_SECURE=false 일 때만 쓸 수 있습니다');
    }
  }

  return {
    envFile,
    devLogin,
    webDist: path.resolve(env.WEB_DIST ?? path.join(here, '..', '..', 'web', 'dist')),
    oauth,
    ownerAccounts,
    passkeyFile: path.join(dataDir, 'passkeys.json'),
    host: env.GATEWAY_HOST ?? '127.0.0.1', // nginx 뒤에서만 받는다
    port: port(env.GATEWAY_PORT, 7400, 'GATEWAY_PORT'),
    publicOrigin,
    agentUrl: agentUrl.origin,
    agentSecrets: toKeyList(required(env, 'AGENT_HMAC_SECRET').split(',').map((s) => s.trim())),
    dataDir,
    demoRoot: path.resolve(env.DEMO_ROOT ?? path.join(dataDir, 'demo')),
    sessionFile: path.join(dataDir, 'sessions', 'sessions.json'),
    trashNotice: {
      days: positive(env.TRASH_NOTICE_DAYS, 30, 'TRASH_NOTICE_DAYS'),
      bytes: positive(env.TRASH_NOTICE_GB, 10, 'TRASH_NOTICE_GB') * 1024 ** 3,
    },
    thumbCacheDir: path.join(dataDir, 'cache', 'thumbs'),
    thumbCacheMaxBytes: Number(env.THUMB_CACHE_MAX_MB ?? 512) * 1024 * 1024,
    metaCacheFile: path.join(dataDir, 'cache', 'folders.json'),
    // D3·D9: 데스크탑이 꺼져 있을 때 오너가 고르면 파이에 임시 보관. 기본 20GB
    bufferDir: path.join(dataDir, 'buffer'),
    bufferMaxBytes: positive(env.BUFFER_MAX_GB, 20, 'BUFFER_MAX_GB') * 1024 ** 3,
    cookieSecure,
    session: {
      // D17: 무활동 10분 → 잠금(패스키만), 2시간 → 완전 만료. 불편하면 env 로 늘린다.
      owner: {
        absoluteMs: positive(env.OWNER_SESSION_HOURS, 2, 'OWNER_SESSION_HOURS') * HOUR,
        idleMs: positive(env.OWNER_IDLE_MINUTES, 10, 'OWNER_IDLE_MINUTES') * 60_000,
      },
      guest: { absoluteMs: 7 * 24 * HOUR, idleMs: 24 * HOUR },
    },
  };
}

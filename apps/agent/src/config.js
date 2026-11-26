// agent 설정 로드. 값은 환경변수(또는 env 파일)에서만 읽는다 — 하드코딩 금지 (ai.md §9).
//
// env 파일 위치 우선순위:
//   1) WOOKI_AGENT_ENV_FILE
//   2) C:\ProgramData\WookiDrive\agent.env  (윈도우 서비스 운영)
//   3) apps/agent/.env                       (개발)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toKeyList, withoutEmpty } from '@wooki-drive/shared/node';

const here = path.dirname(fileURLToPath(import.meta.url));

function findEnvFile() {
  const candidates = [
    process.env.WOOKI_AGENT_ENV_FILE,
    process.env.ProgramData && path.join(process.env.ProgramData, 'WookiDrive', 'agent.env'),
    path.join(here, '..', '.env'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function required(env, name) {
  const v = env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 필요합니다`);
  return v;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   driveRoot: string, host: string, port: number,
 *   hmacSecrets: Buffer[], allowedIps: string[] | null, envFile: string | null
 * }}
 */
export function loadConfig(rawEnv = process.env) {
  let envFile = null;
  if (rawEnv === process.env) {
    envFile = findEnvFile();
    if (envFile) process.loadEnvFile(envFile); // 이미 설정된 값은 덮어쓰지 않는다
  }
  const env = withoutEmpty(rawEnv); // `KEY=` 는 설정 안 한 것으로

  const driveRoot = required(env, 'DRIVE_ROOT');
  if (!path.isAbsolute(driveRoot)) throw new Error('DRIVE_ROOT 는 절대경로여야 합니다');
  if (!fs.statSync(driveRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`DRIVE_ROOT 폴더가 없습니다: ${driveRoot}`);
  }

  const port = Number(env.AGENT_PORT ?? 7401);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AGENT_PORT 가 올바르지 않습니다');

  // 쉼표로 여러 개 → 키 회전 (첫 번째가 현재 키)
  const hmacSecrets = toKeyList(required(env, 'AGENT_HMAC_SECRET').split(',').map((s) => s.trim()));

  const allowedIps = env.AGENT_ALLOWED_IPS
    ? env.AGENT_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  return {
    driveRoot: path.resolve(driveRoot),
    host: env.AGENT_HOST ?? '0.0.0.0',
    port,
    hmacSecrets,
    allowedIps,
    envFile,
  };
}

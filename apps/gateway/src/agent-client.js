// gateway → agent 호출 (LAN, HMAC 서명). 파일은 저장하지 않고 스트림을 그대로 파이프한다 (ai.md §4.1-1).
//
// fetch 대신 node:http 를 쓰는 이유:
//  - fetch 는 조건부 요청에 Cache-Control: no-cache 를 자동으로 붙여 304 를 막는다
//  - 브라우저 연결이 끊기면 agent 쪽 요청도 즉시 끊어야 한다(대용량 동영상 탐색 시 낭비 방지)

import http from 'node:http';
import { signRequest } from '@wooki-drive/shared/node';
import { HttpError } from './http.js';

const CONNECT_TIMEOUT_MS = 3000;

/** 브라우저 → agent 로 넘겨줄 요청 헤더 (Range·캐시 재검증) */
const FORWARD_REQUEST_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
/** agent → 브라우저로 넘겨줄 응답 헤더. Content-Type 은 안전 정책을 거쳐 따로 설정. */
const FORWARD_RESPONSE_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition'];

const OFFLINE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'AGENT_CONNECT_TIMEOUT']);

export class AgentClient {
  /**
   * @param {{ baseUrl: string, secrets: Buffer[], onReachability?: (online: boolean) => void }} opts
   */
  constructor({ baseUrl, secrets, onReachability = () => {} }) {
    this.base = new URL(baseUrl);
    this.secrets = secrets;
    this.onReachability = onReachability;
  }

  /**
   * 서명된 요청을 보내고 응답(IncomingMessage)을 돌려준다. 본문은 호출자가 소비해야 한다.
   * @param {string} method
   * @param {string} pathWithQuery  예: '/v1/list?path=%2F'
   * @param {{ headers?: Record<string, string>, signal?: AbortSignal, signed?: boolean }} [opts]
   * @returns {Promise<http.IncomingMessage>}
   */
  request(method, pathWithQuery, { headers = {}, signal, signed = true } = {}) {
    const sig = signed ? signRequest({ secret: this.secrets, audience: 'agent', method, pathWithQuery }) : {};
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          protocol: this.base.protocol,
          hostname: this.base.hostname,
          port: this.base.port,
          method,
          path: pathWithQuery,
          headers: { ...headers, ...sig },
          signal,
        },
        (res) => {
          clearTimeout(connectTimer);
          this.onReachability(true);
          resolve(res);
        },
      );
      // 연결·응답 헤더까지만 시간 제한. 본문 스트리밍엔 제한 없음.
      const connectTimer = setTimeout(() => {
        const err = new Error('agent connect timeout');
        err.code = 'AGENT_CONNECT_TIMEOUT';
        req.destroy(err);
      }, CONNECT_TIMEOUT_MS);
      req.on('error', (err) => {
        clearTimeout(connectTimer);
        if (OFFLINE_CODES.has(err.code)) {
          this.onReachability(false);
          reject(new HttpError(503, 'AGENT_OFFLINE'));
        } else if (err.name === 'AbortError') {
          reject(err);
        } else {
          reject(new HttpError(502, 'AGENT_ERROR'));
        }
      });
      req.end();
    });
  }

  /** JSON 응답 API. agent 의 오류 코드는 그대로 전달하고, 인증 실패(설정 오류)는 502 로 숨긴다. */
  async getJson(pathWithQuery) {
    const res = await this.request('GET', pathWithQuery);
    const chunks = [];
    for await (const c of res) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(502, 'AGENT_BAD_RESPONSE');
    }
    if (res.statusCode === 401) throw new HttpError(502, 'AGENT_AUTH_FAILED');
    if (res.statusCode >= 400) throw new HttpError(res.statusCode, typeof body?.error === 'string' ? body.error : 'AGENT_ERROR');
    return body;
  }

  /** agent /health (서명 없음). 온라인이면 true. */
  async health() {
    try {
      const res = await this.request('GET', '/health', { signed: false });
      res.resume();
      return res.statusCode === 200;
    } catch {
      return false;
    }
  }

  /**
   * 파일 스트림 프록시. 브라우저가 끊으면 agent 요청도 끊는다.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {string} pathWithQuery
   * @param {(agentContentType: string | undefined) => string} contentTypePolicy
   */
  async pipeFile(req, res, pathWithQuery, contentTypePolicy) {
    const ac = new AbortController();
    const abort = () => ac.abort();
    res.on('close', abort);

    const headers = {};
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }

    let upstream;
    try {
      upstream = await this.request('GET', pathWithQuery, { headers, signal: ac.signal });
    } catch (err) {
      res.off('close', abort);
      if (err.name === 'AbortError') return; // 브라우저가 먼저 끊음
      throw err;
    }

    const status = upstream.statusCode ?? 502;
    if (status >= 400) {
      // 오류는 JSON 으로 받아 코드만 전달
      const chunks = [];
      for await (const c of upstream) chunks.push(c);
      res.off('close', abort);
      let code = 'AGENT_ERROR';
      try {
        code = JSON.parse(Buffer.concat(chunks).toString('utf8')).error ?? code;
      } catch {}
      if (status === 401) throw new HttpError(502, 'AGENT_AUTH_FAILED');
      throw new HttpError(status, code);
    }

    res.status(status);
    for (const h of FORWARD_RESPONSE_HEADERS) {
      const v = upstream.headers[h];
      if (v !== undefined) res.set(h, v);
    }
    if (status !== 304) res.set('Content-Type', contentTypePolicy(upstream.headers['content-type']));

    upstream.pipe(res);
    upstream.on('error', () => res.destroy());
    upstream.on('end', () => res.off('close', abort));
  }
}

/**
 * 데스크탑 상태 감시. 주기적으로 /health 를 찌르고, 실제 요청 성공/실패도 반영한다.
 */
export class AgentMonitor {
  /** @param {{ intervalMs?: number, log?: (m: string) => void }} [opts] */
  constructor({ intervalMs = 10_000, log = () => {} } = {}) {
    this.intervalMs = intervalMs;
    this.log = log;
    this.online = false;
    this.changedAt = Date.now();
    this.timer = null;
  }

  set(online) {
    if (online === this.online) return;
    this.online = online;
    this.changedAt = Date.now();
    this.log(`desktop ${online ? 'online' : 'offline'}`);
  }

  /** @param {AgentClient} client */
  start(client) {
    const tick = async () => this.set(await client.health());
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  status() {
    return { desktop: this.online ? 'online' : 'offline', since: this.changedAt };
  }
}

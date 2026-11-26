// gateway 진입점. 운영에서는 systemd 가 실행한다 (deploy/pi).
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { SessionStore } from './sessions.js';
import { AgentClient, AgentMonitor } from './agent-client.js';
import { PasskeyStore } from './auth/passkeys.js';
import { ThumbCache } from './thumb-cache.js';
import { MetaCache } from './meta-cache.js';
import { BufferStore } from './buffer.js';

const log = (msg) => console.log(`[gateway] ${new Date().toISOString()} ${msg}`);

const config = loadConfig();
fs.mkdirSync(config.demoRoot, { recursive: true });

const store = new SessionStore({ file: config.sessionFile, log });
store.load();

const passkeys = new PasskeyStore({ file: config.passkeyFile });
passkeys.load();

if (Object.keys(config.oauth).length === 0) log('warning: no OAuth provider configured — nobody can sign in');
if (config.ownerAccounts.size === 0) log('setup mode: OWNER_ACCOUNTS is empty — every login becomes a guest');

const thumbs = new ThumbCache({ dir: config.thumbCacheDir, maxBytes: config.thumbCacheMaxBytes, log });
await thumbs.init();

const meta = new MetaCache({ file: config.metaCacheFile, log });
meta.load();
meta.start();

const buffer = new BufferStore({ dir: config.bufferDir, maxBytes: config.bufferMaxBytes, log });

const monitor = new AgentMonitor({ log });
const agent = new AgentClient({ baseUrl: config.agentUrl, secrets: config.agentSecrets, onReachability: (ok) => monitor.set(ok) });

// 데스크탑이 켜지면: 파이에 보관한 파일을 옮기고, 꺼졌을 때 볼 폴더 목록을 새로 훑는다
const CRAWL_EVERY_MS = 6 * 3600_000;
let lastCrawl = 0;
const onDesktopOnline = () => {
  buffer.sync(agent).catch((err) => log(`buffer sync failed: ${err.message}`));
  if (Date.now() - lastCrawl > CRAWL_EVERY_MS) {
    lastCrawl = Date.now();
    meta.crawl((folder) => agent.getJson(`/v1/list?path=${encodeURIComponent(folder)}`)).catch((err) => log(`meta crawl stopped: ${err.code ?? err.message}`));
  }
};
monitor.onChange((online) => online && onDesktopOnline());
// 실패한 동기화 재시도 (켜져 있는 동안 1분마다)
setInterval(() => monitor.online && buffer.sync(agent).catch(() => {}), 60_000).unref();
setInterval(() => buffer.uploads.cleanup().catch(() => {}), 3600_000).unref();
monitor.start(agent);

const app = createApp({ ...config, store, passkeys, agent, monitor, thumbs, meta, buffer, log });

const server = app.listen(config.port, config.host, () => {
  // 비밀값은 출력하지 않는다
  log(`listening on ${config.host}:${config.port}, origin=${config.publicOrigin}, agent=${config.agentUrl}, env=${config.envFile ?? '(process env)'}`);
});
server.on('error', (err) => {
  log(`listen failed: ${err.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`${sig} — shutting down`);
    monitor.stop();
    setTimeout(() => process.exit(0), 5000).unref();
    await store.flush().catch((err) => log(`session flush failed: ${err.message}`));
    await meta.flush().catch((err) => log(`meta cache flush failed: ${err.message}`));
    server.close(() => process.exit(0));
  });
}

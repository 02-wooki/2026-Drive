// gateway 진입점. 운영에서는 systemd 가 실행한다 (deploy/pi).
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { SessionStore } from './sessions.js';
import { AgentClient, AgentMonitor } from './agent-client.js';
import { PasskeyStore } from './auth/passkeys.js';
import { ThumbCache } from './thumb-cache.js';

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

const monitor = new AgentMonitor({ log });
const agent = new AgentClient({ baseUrl: config.agentUrl, secrets: config.agentSecrets, onReachability: (ok) => monitor.set(ok) });
monitor.start(agent);

const app = createApp({ ...config, store, passkeys, agent, monitor, thumbs, log });

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
    server.close(() => process.exit(0));
  });
}

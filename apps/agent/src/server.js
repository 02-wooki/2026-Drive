// agent 진입점. 운영에서는 윈도우 서비스가 이 파일을 실행한다 (deploy/windows).
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const log = (msg) => console.log(`[agent] ${new Date().toISOString()} ${msg}`);

const config = loadConfig();
const app = createApp({ ...config, log });

const server = app.listen(config.port, config.host, () => {
  // 비밀값은 출력하지 않는다
  log(`listening on ${config.host}:${config.port}, root=${config.driveRoot}, env=${config.envFile ?? '(process env)'}`);
});
server.on('error', (err) => {
  log(`listen failed: ${err.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

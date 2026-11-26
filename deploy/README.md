# 배포

라즈베리 파이(gateway, `drive.wooki.cloud`) + 윈도우 데스크탑(agent, `D:\Drive`).
순서대로 한 번만 하면 되고, 이후 업데이트는 각 스크립트를 다시 실행하면 된다.

## 0. 준비 (한 번)

- **GitHub OAuth App** — GitHub → Settings → Developer settings → OAuth Apps → New
  - Homepage URL: `https://drive.wooki.cloud`
  - Authorization callback URL: `https://drive.wooki.cloud/auth/github/callback`
  - Client ID, Client secret 을 받아 둔다 (secret 은 한 번만 보인다)
- **오너 계정 ID**: GitHub 숫자 ID (`gh api user --jq .id`) → `OWNER_ACCOUNTS=github:<숫자>`
- **공유기**: 데스크탑에 고정 IP(DHCP 예약)
- **Cloudflare DNS**: `drive` 레코드를 파이 공인 주소로, 프록시(주황 구름) 켬

## 1. 윈도우 데스크탑 — agent

관리자 PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File D:\Wooki\Wooki_Drive\deploy\windows\install-agent.ps1 -PiIp <파이 IP>
```

- `C:\Program Files\WookiDrive` 에 설치, 설정은 `C:\ProgramData\WookiDrive\agent.env`
- 부팅 시 자동 시작(작업 스케줄러 `WookiDriveAgent`, SYSTEM, 로그인 불필요), 로그 `C:\ProgramData\WookiDrive\logs\agent.log`
- 방화벽: agent 포트는 파이 IP 에서만
- 처음 실행하면 마지막에 `AGENT_URL`, `AGENT_HMAC_SECRET` 이 한 번 출력된다 → 2단계에서 파이 설정에 넣는다
- 개발용 agent 가 7401 을 쓰고 있으면 끄고 `Start-ScheduledTask WookiDriveAgent`

## 2. 라즈베리 파이 — gateway

```bash
sudo git clone https://github.com/02-wooki/2026-Drive.git /opt/wooki-drive
sudo bash /opt/wooki-drive/deploy/pi/install.sh
sudo nano /etc/wooki-drive/gateway.env
```

채울 값: `AGENT_URL`, `AGENT_HMAC_SECRET`(1단계 출력), `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OWNER_ACCOUNTS`.
`PUBLIC_ORIGIN=https://drive.wooki.cloud`, `COOKIE_SECURE=true`, `DEV_LOGIN=false` 는 그대로.

```bash
sudo systemctl restart wooki-drive-gateway
journalctl -u wooki-drive-gateway -f     # "desktop online", "meta cache: crawled N folder(s)" 확인
```

- Node 22 는 nodejs.org 공식 파일을 SHA-256 확인 후 `/usr/local` 에 설치
- 코드 `/opt/wooki-drive`, 데이터 `/var/lib/wooki-drive`(700), 설정 `/etc/wooki-drive/gateway.env`(640)
- 전용 사용자 `wookidrive` 로 실행, systemd 격리(데이터 폴더 외 쓰기 불가)

## 3. CloudPanel — nginx 사이트

1. Sites → Add Site → **Create a Reverse Proxy** — 도메인 `drive.wooki.cloud`, Reverse Proxy URL `http://127.0.0.1:7400`
2. SSL/TLS — 다른 사이트와 같은 방식으로 인증서 발급
3. Vhost — [`pi/nginx-vhost.conf`](pi/nginx-vhost.conf) 의 내용 반영
   - Cloudflare 실제 IP 복원(`real_ip_header CF-Connecting-IP`)
   - `client_max_body_size 40m`
   - `proxy_request_buffering off`, `proxy_buffering off`, `proxy_max_temp_file_size 0` (SD카드에 임시 파일 안 씀)

## 4. 첫 로그인

1. `https://drive.wooki.cloud` → GitHub 로그인 → 패스키 등록(Touch ID)
2. 왼쪽 아래 **열쇠 버튼(패스키 추가)** → 기존 패스키로 확인 → 다른 기기·보안 키 등록. **2개 이상** 권장
   (모두 잃으면 파이에서 `/var/lib/wooki-drive/passkeys.json` 을 지우는 것 말고는 복구 방법이 없다)

## 업데이트

- 파이: `sudo bash /opt/wooki-drive/deploy/pi/install.sh`
- 윈도우: 저장소를 `git pull` 한 뒤 1단계 명령 다시 실행 (설정·서명 키는 유지)

## 배포 전 체크리스트 (ai.md §10.1)

- [ ] 로그인 버튼 디자인 가이드 (공급자 공식 규격) — 첫 배포는 GitHub 만, 가이드는 나중에 한 번에
- [ ] nginx: Cloudflare 실제 IP 복원
- [ ] nginx: `client_max_body_size` 33MB 이상
- [ ] 파이: dev 의존성 없음, 전용 사용자, `DATA_DIR` 700, `gateway.env` 640
- [ ] `DEV_LOGIN=false`, `COOKIE_SECURE=true`
- [ ] 패스키 2개 이상

#!/usr/bin/env bash
# Wooki Drive gateway 설치·업데이트 (라즈베리 파이, Ubuntu 24.04 aarch64). 여러 번 실행해도 안전하다.
#
#   처음:   sudo git clone https://github.com/02-wooki/2026-Drive.git /opt/wooki-drive
#           sudo bash /opt/wooki-drive/deploy/pi/install.sh
#   업데이트: sudo bash /opt/wooki-drive/deploy/pi/install.sh     (git pull → 빌드 → 재시작)
#
# 하는 일
#   1) Node 22 (nodejs.org 공식 tarball, SHA-256 확인) → /usr/local
#   2) 전용 시스템 사용자 wookidrive (로그인 불가)
#   3) /var/lib/wooki-drive (700), /etc/wooki-drive/gateway.env (640 root:wookidrive)
#   4) 코드 받기 → web 빌드 → gateway 운영 의존성만 설치
#   5) systemd 서비스 등록. 설정이 비어 있으면 시작하지 않고 안내만
#
# 다른 서비스(CloudPanel, nginx, MariaDB …)는 건드리지 않는다. nginx 사이트는 CloudPanel 화면에서 만든다(deploy/README.md).

set -euo pipefail

APP=/opt/wooki-drive
DATA=/var/lib/wooki-drive
ETC=/etc/wooki-drive
ENV_FILE=$ETC/gateway.env
SVC_USER=wookidrive
UNIT=wooki-drive-gateway
REPO=${WOOKI_REPO:-https://github.com/02-wooki/2026-Drive.git}
NODE_MAJOR=22

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "sudo 로 실행해 주세요: sudo bash $0" >&2; exit 1; }

# ── 1) Node ──
say "Node $NODE_MAJOR"
if command -v node >/dev/null && [[ "$(node -v)" == v$NODE_MAJOR.* ]]; then
  echo "이미 설치됨: $(node -v) ($(command -v node))"
else
  arch=$(uname -m)
  case "$arch" in
    aarch64) narch=arm64 ;;
    x86_64) narch=x64 ;;
    *) echo "지원하지 않는 아키텍처: $arch" >&2; exit 1 ;;
  esac
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(grep -oE "node-v$NODE_MAJOR\.[0-9]+\.[0-9]+-linux-$narch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)
  [[ -n "$file" ]] || { echo "Node 배포 파일을 찾지 못했어요" >&2; exit 1; }
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --no-same-owner
  echo "설치됨: $(/usr/local/bin/node -v)"
fi
NODE_BIN=$(command -v node)
NPM_BIN=$(command -v npm)

# ── 2) 사용자 ──
say "서비스 사용자 $SVC_USER"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

# ── 3) 폴더 ──
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$DATA"
install -d -m 750 -o root -g "$SVC_USER" "$ETC"

# ── 4) 코드 ──
say "코드 ($APP)"
if [[ -d "$APP/.git" ]]; then
  git -C "$APP" pull --ff-only
else
  git clone "$REPO" "$APP"
fi
cd "$APP"
echo "버전: $(git log --oneline -1)"

say "web 빌드"
"$NPM_BIN" ci --workspace apps/web --include-workspace-root --no-audit --no-fund
"$NPM_BIN" run build --workspace apps/web

say "gateway 운영 의존성 (dev 제외)"
"$NPM_BIN" ci --omit=dev --workspace apps/gateway --include-workspace-root --no-audit --no-fund

# ── 5) 설정 ──
if [[ ! -f "$ENV_FILE" ]]; then
  say "설정 파일 만들기 ($ENV_FILE)"
  sed -e 's#^DATA_DIR=.*#DATA_DIR='"$DATA"'#' \
      -e 's#^COOKIE_SECURE=.*#COOKIE_SECURE=true#' \
      -e 's#^DEV_LOGIN=.*#DEV_LOGIN=false#' \
      -e 's#^AGENT_URL=.*#AGENT_URL=#' \
      apps/gateway/.env.example >"$ENV_FILE"
fi
chown root:"$SVC_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ── 6) systemd ──
say "systemd 서비스 $UNIT"
sed "s#@NODE@#$NODE_BIN#; s#@APP@#$APP#; s#@DATA@#$DATA#; s#@USER@#$SVC_USER#; s#@ENV@#$ENV_FILE#" \
  deploy/pi/wooki-drive-gateway.service >/etc/systemd/system/$UNIT.service
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null

missing=()
for key in AGENT_URL AGENT_HMAC_SECRET PUBLIC_ORIGIN; do
  grep -qE "^$key=.+" "$ENV_FILE" || missing+=("$key")
done
grep -qE '^OAUTH_[A-Z]+_CLIENT_ID=.+' "$ENV_FILE" || missing+=("OAUTH_GITHUB_CLIENT_ID/SECRET")
grep -qE '^OWNER_ACCOUNTS=.+' "$ENV_FILE" || missing+=("OWNER_ACCOUNTS")

if ((${#missing[@]})); then
  say "설정이 비어 있어요 — 채운 뒤 다시 실행하거나 'sudo systemctl restart $UNIT'"
  printf '  - %s\n' "${missing[@]}"
  echo "  편집: sudo nano $ENV_FILE"
  if [[ " ${missing[*]} " == *" AGENT_URL "* || " ${missing[*]} " == *" AGENT_HMAC_SECRET "* ]]; then exit 0; fi
fi

systemctl restart "$UNIT"
sleep 2
systemctl --no-pager --lines=15 status "$UNIT" || true
say "완료. 로그: journalctl -u $UNIT -f"

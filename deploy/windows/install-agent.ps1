<#
  Wooki Drive agent 설치·업데이트 (윈도우 데스크탑). 관리자 PowerShell 에서 실행. 여러 번 실행해도 안전하다.

    powershell -ExecutionPolicy Bypass -File <저장소>\deploy\windows\install-agent.ps1 -PiIp <파이 IP>

  하는 일
    1) 저장소를 C:\Program Files\WookiDrive 로 복사 (node_modules·data·.env·.git 제외) → agent 운영 의존성만 설치
    2) C:\ProgramData\WookiDrive\agent.env (처음이면 생성: 서명 키 새로 만들고, 접속 허용 IP = 파이)
       폴더 권한은 SYSTEM·Administrators 만
    3) 방화벽: agent 포트로 들어오는 연결은 파이 IP 에서만 허용
    4) 작업 스케줄러 "WookiDriveAgent": 부팅 시 SYSTEM 으로 시작(로그인 불필요), 죽으면 5초 뒤 다시 시작
       (윈도우 서비스 래퍼 같은 외부 프로그램을 받지 않으려고 기본 기능만 쓴다)
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PiIp,
  [string]$DriveRoot = 'D:\Drive',
  [int]$Port = 7401
)
$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '관리자 권한 PowerShell 에서 실행해 주세요.'
}
if (-not [System.Net.IPAddress]::TryParse($PiIp, [ref]$null)) { throw "PiIp 가 IP 주소가 아니에요: $PiIp" }

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$App = Join-Path $env:ProgramFiles 'WookiDrive'
$Data = Join-Path $env:ProgramData 'WookiDrive'
$EnvFile = Join-Path $Data 'agent.env'
$Logs = Join-Path $Data 'logs'
$TaskName = 'WookiDriveAgent'

# ── Node ──
Say 'Node'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node 22 가 필요해요 (https://nodejs.org).' }
$ver = & $node -v
if ($ver -notmatch '^v(2[2-9]|[3-9]\d)\.') { throw "Node 22 이상이 필요해요 (지금: $ver)" }
$npm = Join-Path (Split-Path $node) 'npm.cmd'
Write-Host "$ver ($node)"

# ── 실행 중이면 멈춤 (파일 교체) ──
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Say '기존 agent 멈춤'
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*$App*server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

# ── 코드 복사 ──
Say "코드 → $App"
New-Item -ItemType Directory -Force $App | Out-Null
& robocopy $Repo $App /MIR /NFL /NDL /NJH /NJS /NP `
  /XD node_modules data dist .git .claude `
  /XF .env ai.md *.log | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 실패 ($LASTEXITCODE)" }

Say 'agent 운영 의존성 설치'
Push-Location $App
try {
  & $npm ci --omit=dev --workspace apps/agent --include-workspace-root --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci 실패 ($LASTEXITCODE)" }
} finally { Pop-Location }

# ── 데이터·설정 ──
Say "설정 $EnvFile"
New-Item -ItemType Directory -Force $Data, $Logs | Out-Null
New-Item -ItemType Directory -Force $DriveRoot | Out-Null
# SYSTEM·Administrators 만 (서명 키 보호)
& icacls $Data /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

$newSecret = $null
if (-not (Test-Path $EnvFile)) {
  $newSecret = & $node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))"
  $lines = Get-Content (Join-Path $App 'apps\agent\.env.example') -Encoding UTF8 | ForEach-Object {
    switch -Regex ($_) {
      '^DRIVE_ROOT=' { "DRIVE_ROOT=$DriveRoot"; break }
      '^AGENT_PORT=' { "AGENT_PORT=$Port"; break }
      '^AGENT_HMAC_SECRET=' { "AGENT_HMAC_SECRET=$newSecret"; break }
      '^AGENT_ALLOWED_IPS=' { "AGENT_ALLOWED_IPS=$PiIp"; break }
      default { $_ }
    }
  }
  [IO.File]::WriteAllLines($EnvFile, $lines, (New-Object Text.UTF8Encoding($false)))
} else {
  Write-Host '이미 있음 — 그대로 둠 (서명 키 유지)'
}

# ── 방화벽 ──
Say "방화벽: TCP $Port ← $PiIp 만"
Get-NetFirewallRule -DisplayName 'Wooki Drive agent' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Wooki Drive agent' -Direction Inbound -Action Allow -Protocol TCP `
  -LocalPort $Port -RemoteAddress $PiIp -Profile Any | Out-Null
$loose = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*node.exe' } |
  Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Enabled -eq 'True' }
if ($loose) {
  Write-Warning "node.exe 전체를 허용하는 인바운드 규칙이 있어요 (개발 중 '허용'을 눌렀을 때 생김). agent 는 서명·IP 검사로 막지만, 정리하려면:"
  $loose | ForEach-Object { Write-Warning "  Remove-NetFirewallRule -Name '$($_.Name)'   # $($_.DisplayName) / $($_.Profile)" }
}

# ── 작업 스케줄러 ──
Say "작업 스케줄러 $TaskName (부팅 시, SYSTEM)"
$runner = Join-Path $App 'deploy\windows\run-agent.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -Node `"$node`"" -WorkingDirectory $App
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null

$devAgent = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($devAgent) {
  Write-Warning "포트 $Port 를 이미 다른 프로그램(PID $($devAgent[0].OwningProcess))이 쓰고 있어요. 개발용 agent 라면 끈 뒤: Start-ScheduledTask $TaskName"
} else {
  Start-ScheduledTask -TaskName $TaskName
  # 이 PC 에서 확인하면 AGENT_ALLOWED_IPS(파이만) 때문에 403 IP_NOT_ALLOWED 가 정상이다 → 응답이 오기만 하면 실행 중
  $running = $false
  for ($i = 0; $i -lt 15 -and -not $running; $i++) {
    Start-Sleep -Seconds 1
    try {
      Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $running = $true
    } catch {
      if ($_.Exception.Response) { $running = $true }
    }
  }
  if ($running) {
    Write-Host "agent 실행 중 (포트 $Port). 파이에서 확인: curl http://<이 PC IP>:$Port/health" -ForegroundColor Green
  } else {
    Write-Warning "agent 가 15초 안에 응답하지 않았어요. 로그: $Logs\agent.log"
  }
}

Say '완료'
Write-Host "로그: $Logs\agent.log"
if ($newSecret) {
  Write-Host ''
  Write-Host '파이의 /etc/wooki-drive/gateway.env 에 아래 값을 넣어 주세요 (이 창에만 한 번 보여요):' -ForegroundColor Yellow
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object -First 1).IPAddress
  Write-Host "  AGENT_URL=http://$($ip):$Port"
  Write-Host "  AGENT_HMAC_SECRET=$newSecret"
  Write-Host '  (공유기에서 이 데스크탑 IP 를 고정 할당해 두세요)'
}

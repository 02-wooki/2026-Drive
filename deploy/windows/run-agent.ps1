<#
  작업 스케줄러가 부팅 시 SYSTEM 으로 실행하는 감시 루프. agent 가 죽으면 5초 뒤 다시 띄운다.
  로그는 C:\ProgramData\WookiDrive\logs\agent.log (10MB 넘으면 agent.log.1 로 넘김).
#>
param([Parameter(Mandatory = $true)][string]$Node)

$App = Split-Path (Split-Path $PSScriptRoot)
$Server = Join-Path $App 'apps\agent\src\server.js'
$Logs = Join-Path $env:ProgramData 'WookiDrive\logs'
$Log = Join-Path $Logs 'agent.log'
New-Item -ItemType Directory -Force $Logs | Out-Null

while ($true) {
  if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 10MB) {
    Move-Item -Force $Log "$Log.1"
  }
  # cmd 로 리다이렉트: PowerShell 5.1 은 네이티브 stderr 를 오류 레코드로 감싸 로그가 지저분해진다
  & cmd.exe /d /c "`"$Node`" `"$Server`" >> `"$Log`" 2>&1"
  Add-Content -Path $Log -Value "[run-agent] $(Get-Date -Format o) agent exited ($LASTEXITCODE), restarting in 5s"
  Start-Sleep -Seconds 5
}

$ErrorActionPreference='Stop'
$target='C:\\Users\\Administrator\\AppData\\Local\\TianheAIDigitalEmployee-PackageTest-20260812'
$env:PORT='3211'
$env:AGENT_PORT='17932'
$env:CLOUD_BASE_URL='http://127.0.0.1:3211'
$env:ALLOWED_ORIGINS='http://127.0.0.1:3211,http://localhost:3211'
$env:AGENT_ALLOWED_ORIGINS='http://127.0.0.1:3211,http://localhost:3211'
$env:AUTO_COLLECT_ENABLED='false'
try {
  & (Join-Path $target 'start-mvp.ps1') -NoBrowser -WaitSeconds 30
  $web=Invoke-RestMethod 'http://127.0.0.1:3211/api/health' -TimeoutSec 5
  $agent=Invoke-RestMethod 'http://127.0.0.1:17932/health' -TimeoutSec 5
  if($web.service -ne 'cloud-web' -or -not $agent.ok){throw 'start script health verification failed'}
  Write-Host 'Start script health verification: OK'
} finally {
  & (Join-Path $target 'stop-mvp.ps1')
}
Start-Sleep -Seconds 1
$webStopped=$false;try{Invoke-RestMethod 'http://127.0.0.1:3211/api/health' -TimeoutSec 2|Out-Null}catch{$webStopped=$true}
$agentStopped=$false;try{Invoke-RestMethod 'http://127.0.0.1:17932/health' -TimeoutSec 2|Out-Null}catch{$agentStopped=$true}
Write-Host "Stop script: webStopped=$webStopped agentStopped=$agentStopped"
if(-not $webStopped -or -not $agentStopped){throw 'stop script verification failed'}

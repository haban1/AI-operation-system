$ErrorActionPreference='SilentlyContinue'
$Root=Split-Path -Parent $MyInvocation.MyCommand.Path
$Logs=Join-Path $Root 'logs'
$EnvPath=Join-Path $Root '.env'

function Read-EnvValue([string]$Name,[string]$Default='') {
  if(-not (Test-Path -LiteralPath $EnvPath)){return $Default}
  $prefix="$Name="
  $line=Get-Content -LiteralPath $EnvPath -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object {$_.StartsWith($prefix)} | Select-Object -Last 1
  if($null -eq $line){return $Default}
  return $line.Substring($prefix.Length).Trim()
}

function Get-DescendantProcessIds([int]$ParentId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Get-DescendantProcessIds ([int]$child.ProcessId)
    [int]$child.ProcessId
  }
}

# 先停止由统一启动入口托管的 RAG。没有 rag.pid 时不碰外部手工启动的进程。
$RagPidFile=Join-Path $Logs 'rag.pid'
if(Test-Path -LiteralPath $RagPidFile){
  $ragProcessId=0
  [void][int]::TryParse((Get-Content -LiteralPath $RagPidFile -Raw).Trim(),[ref]$ragProcessId)
  $ragProcess=if($ragProcessId -gt 0){Get-Process -Id $ragProcessId -ErrorAction SilentlyContinue}else{$null}
  if($ragProcess){
    $ragProcessIds = @((Get-DescendantProcessIds $ragProcessId), $ragProcessId) | Where-Object { $_ -gt 0 } | Select-Object -Unique
    foreach($processId in $ragProcessIds){
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    try{$ragProcess.WaitForExit(5000)}catch{}
    Write-Host "已停止 RAG PID=$ragProcessId"
  }
  Remove-Item -LiteralPath $RagPidFile -Force -ErrorAction SilentlyContinue
}

$AgentHost=Read-EnvValue 'AGENT_HOST' '127.0.0.1'
$AgentPort=[int](Read-EnvValue 'AGENT_PORT' '17831')
$AgentToken=Read-EnvValue 'AGENT_SHARED_TOKEN' ''
$AgentPidFile=Join-Path $Logs 'agent.pid'
$AgentProcess=$null
if(Test-Path -LiteralPath $AgentPidFile){
  $agentProcessId=[int](Get-Content -LiteralPath $AgentPidFile -Raw)
  $AgentProcess=Get-Process -Id $agentProcessId -ErrorAction SilentlyContinue
}

# 先让 Local Agent 优雅关闭：清空轮询集合、关闭各平台 context，
# 并按独立 Profile 清理该平台的全部浏览器子进程。
if($AgentProcess){
  $headers=@{}
  if($AgentToken){$headers['X-Agent-Token']=$AgentToken}
  try {
    Invoke-RestMethod -Uri "http://${AgentHost}:${AgentPort}/control/shutdown" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"reason":"STOP_MVP"}' -TimeoutSec 3 | Out-Null
  } catch {}
  try{$AgentProcess.WaitForExit(12000)}catch{}
  $AgentProcess=Get-Process -Id $agentProcessId -ErrorAction SilentlyContinue
  if($AgentProcess){
    Stop-Process -Id $agentProcessId -Force
    try{$AgentProcess.WaitForExit(5000)}catch{}
  }
  Write-Host "已停止 agent PID=$agentProcessId"
}
Remove-Item -LiteralPath $AgentPidFile -Force -ErrorAction SilentlyContinue

$ServerPidFile=Join-Path $Logs 'server.pid'
if(Test-Path -LiteralPath $ServerPidFile){
  $serverProcessId=[int](Get-Content -LiteralPath $ServerPidFile -Raw)
  $serverProcess=Get-Process -Id $serverProcessId -ErrorAction SilentlyContinue
  if($serverProcess){
    Stop-Process -Id $serverProcessId -Force
    try{$serverProcess.WaitForExit(5000)}catch{}
    Write-Host "已停止 server PID=$serverProcessId"
  }
  Remove-Item -LiteralPath $ServerPidFile -Force -ErrorAction SilentlyContinue
}
Get-ChildItem -LiteralPath $Logs -Filter '*.lock' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

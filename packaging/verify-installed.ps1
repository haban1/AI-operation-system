param(
  [Parameter(Mandatory=$true)][string]$Target,
  [int]$Port = 32180,
  [int]$AgentPort = 17980,
  [int]$RagPort = 18180,
  [string]$ExpectedPassword = 'admin11'
)
$ErrorActionPreference = 'Stop'
$Target = [IO.Path]::GetFullPath($Target)
$Node = Join-Path $Target 'runtime\node.exe'
$Python = Join-Path $Target 'runtime\python\python.exe'
$EnvPath = Join-Path $Target '.env'
$RagEnvPath = Join-Path $Target 'rag\.env'
foreach ($name in @('runtime\node.exe','runtime\python\python.exe','.env','data\mvp.db','data\.settings-key','rag\.env','rag\data\rag.db','rag\app\main.py','assets\app.ico','卸载天河AI数字员工平台.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $Target $name))) { throw "缺少安装组件：$name" }
}
function Set-TestEnv([string]$File,[string]$Name,[string]$Value) {
  $lines = [Collections.Generic.List[string]]::new()
  Get-Content -LiteralPath $File -Encoding UTF8 | ForEach-Object { $lines.Add($_) }
  $found = $false
  for ($i=0; $i -lt $lines.Count; $i++) { if ($lines[$i].StartsWith("$Name=")) { $lines[$i]="$Name=$Value"; $found=$true; break } }
  if (-not $found) { $lines.Add("$Name=$Value") }
  [IO.File]::WriteAllLines($File,$lines,[Text.UTF8Encoding]::new($false))
}
foreach ($testPort in @($Port,$AgentPort,$RagPort)) {
  if (Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue) { throw "验收端口被占用：$testPort" }
}
Set-TestEnv $EnvPath 'PORT' "$Port"
Set-TestEnv $EnvPath 'AGENT_PORT' "$AgentPort"
Set-TestEnv $EnvPath 'RAG_PORT' "$RagPort"
Set-TestEnv $EnvPath 'CLOUD_BASE_URL' "http://127.0.0.1:$Port"
Set-TestEnv $EnvPath 'ALLOWED_ORIGINS' "http://127.0.0.1:$Port,http://localhost:$Port"
Set-TestEnv $EnvPath 'AGENT_ALLOWED_ORIGINS' "http://127.0.0.1:$Port,http://localhost:$Port"
Set-TestEnv $EnvPath 'RAG_BASE_URL' "http://127.0.0.1:$RagPort"
Set-TestEnv $EnvPath 'AUTO_COLLECT_ENABLED' 'false'
Set-TestEnv $RagEnvPath 'RAG_PORT' "$RagPort"
$base = "http://127.0.0.1:$Port"
$report = [ordered]@{}
try {
  # Deliberately start outside the installation directory to catch relative-path bugs.
  # Another Python installed on the destination PC must not break the bundled one.
  $PreviousPythonHome = [Environment]::GetEnvironmentVariable('PYTHONHOME', 'Process')
  [Environment]::SetEnvironmentVariable('PYTHONHOME', (Join-Path $Target '__absent_python_home__'), 'Process')
  Push-Location $env:TEMP
  try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Target 'start-mvp.ps1') -NoBrowser -WaitSeconds 45 }
  finally {
    Pop-Location
    [Environment]::SetEnvironmentVariable('PYTHONHOME', $PreviousPythonHome, 'Process')
  }
  if ($LASTEXITCODE -ne 0) { throw '安装后的启动入口失败' }
  $health = Invoke-RestMethod "$base/api/health" -TimeoutSec 5
  $loginBody = @{username='admin';password=$ExpectedPassword} | ConvertTo-Json -Compress
  $login = Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType 'application/json' -Body $loginBody -SessionVariable session
  if (-not $login.authenticated) { throw '首次后台登录失败' }
  $bootstrap = Invoke-RestMethod "$base/api/bootstrap" -WebSession $session
  if ($bootstrap.config.masterSwitch.enabled -or $bootstrap.localAgent.online) { throw '首次安装没有保持暂停' }
  if (@($bootstrap.platforms | Where-Object { $_.desired_state -ne 'STOPPED' }).Count) { throw '安装模板平台未全部停止' }
  if (@($bootstrap.accounts | Where-Object { $_.login_source -or $_.platform_user_id -or $_.login_status -eq 'READY' }).Count) { throw '安装模板携带旧登录信息' }
  $messages = Invoke-RestMethod "$base/api/messages" -WebSession $session
  $tasks = Invoke-RestMethod "$base/api/tasks" -WebSession $session
  $handoffs = Invoke-RestMethod "$base/api/manual-handoffs" -WebSession $session
  if (@($messages.messages).Count -or @($tasks.tasks).Count -or @($handoffs.handoffs).Count) { throw '安装后的业务记录非空' }
  if ($bootstrap.stats.autoReplies -ne 0 -or $bootstrap.stats.queuedTasks -ne 0 -or $bootstrap.stats.manualRequired -ne 0) { throw '首页历史统计非空' }
  if ($bootstrap.stats.handoffRecords -ne 0 -or $bootstrap.stats.handoffRecords -ne $handoffs.totalHandoffs) { throw '首页转人工统计与记录页不一致' }
  if ($null -eq $bootstrap.stats.aiUsageToday -or $bootstrap.stats.aiUsageToday.calls -ne 0 -or $bootstrap.stats.aiUsageToday.total_tokens -ne 0 -or $bootstrap.stats.aiUsageToday.estimated_cost_cny -ne 0) { throw '今日 AI 用量未正确初始化' }
  $knowledge = Invoke-RestMethod "$base/api/knowledge" -WebSession $session
  $documents = Invoke-RestMethod "$base/api/rag/documents" -WebSession $session -TimeoutSec 20
  $releases = Invoke-RestMethod "$base/api/rag/releases" -WebSession $session -TimeoutSec 20
  if (@($knowledge.knowledge).Count -lt 1 -or @($documents.documents).Count -lt 1 -or -not $releases.active) { throw '知识库或正式版本未正确迁移' }
  $ai = Invoke-RestMethod "$base/api/settings/ai" -WebSession $session
  $wecom = Invoke-RestMethod "$base/api/settings/wecom" -WebSession $session
  if (-not $ai.settings.configured -or -not $wecom.settings.configured) { throw 'AI 或企微配置解密失败' }
  foreach ($route in @('/','/app.js','/styles.css','/favicon.ico')) {
    $asset = Invoke-WebRequest "$base$route" -UseBasicParsing
    if ($asset.StatusCode -ne 200) { throw "页面资源无法访问：$route" }
  }
  # Only the master switch is enabled: all five platform gates stay STOPPED,
  # so this verifies the local process binding without visiting social sites.
  $null = Invoke-RestMethod "$base/api/settings/operations" -WebSession $session -Method Post -ContentType 'application/json' -Body '{"enabled":true,"updatedBy":"安装验收"}'
  $agent = Invoke-RestMethod "$base/api/local-agent/health" -WebSession $session -TimeoutSec 20
  if (-not $agent.localAgent.online -or -not $agent.localAgent.bindingVerified) { throw 'Local Agent 绑定失败' }
  $null = Invoke-RestMethod "$base/api/settings/operations" -WebSession $session -Method Post -ContentType 'application/json' -Body '{"enabled":false,"updatedBy":"安装验收"}'
  $report.web = $health.service
  $report.firstStartPaused = $true
  $report.customerHistoryEmpty = $true
  $report.dashboardHandoffStatsAligned = $true
  $report.dashboardAiUsageInitialized = $true
  $report.knowledge = @($knowledge.knowledge).Count
  $report.ragDocuments = @($documents.documents).Count
  $report.ragReleases = @($releases.releases).Count
  $report.aiConfigurationPreserved = $true
  $report.wecomConfigurationPreserved = $true
  $report.agentBindingVerified = $true
  $report.externalPythonEnvironmentIgnored = $true
} finally {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Target 'stop-mvp.ps1') | Out-Host
}
foreach ($testPort in @($Port,$AgentPort,$RagPort)) {
  if (Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue) { throw "停止后仍有服务占用端口：$testPort" }
}
$report.allServicesStopped = $true
& $Node (Join-Path $PSScriptRoot 'verify-installed-channels.mjs') $Target
if ($LASTEXITCODE -ne 0) { throw '安装后的评论与私信双通道验收失败' }
$report.independentCollectionChannelsVerified = $true
$report | ConvertTo-Json
Write-Host 'INSTALLED_VERIFY_OK'

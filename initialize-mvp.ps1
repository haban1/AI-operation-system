param(
  [switch]$Quiet,
  [switch]$EnsureMessageCollection
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $Root '.env'
$ExamplePath = Join-Path $Root '.env.example'
# 保留显式安全默认值，便于安装审计；实际 .env 仍以 .env.example 为完整模板生成。
$InstallerSafetyDefaults = @'
ISSUE_DIAGNOSIS_ENABLED=false
ISSUE_DIAGNOSIS_BROWSER_READONLY=true
'@
if (-not (Test-Path -LiteralPath $ExamplePath)) { throw "缺少配置模板：$ExamplePath" }

function New-RandomText([int]$Length = 64) {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}
function Set-EnvValue([System.Collections.Generic.List[string]]$Lines,[string]$Name,[string]$Value) {
  $prefix = "$Name="
  for ($i=0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i].StartsWith($prefix,[System.StringComparison]::OrdinalIgnoreCase)) {
      $Lines[$i] = "$Name=$Value"
      return
    }
  }
  $Lines.Add("$Name=$Value")
}
function Get-EnvValue([System.Collections.Generic.List[string]]$Lines,[string]$Name,[string]$Default = '') {
  $line = $Lines | Where-Object { $_.StartsWith("$Name=", [StringComparison]::OrdinalIgnoreCase) } | Select-Object -Last 1
  if ($null -eq $line) { return $Default }
  $value = $line.Substring($Name.Length + 1).Trim()
  if (-not $value) { return $Default }
  return $value
}
function Repair-InstallerChannelDefaults([System.Collections.Generic.List[string]]$WebLines) {
  $TemplateLines = [System.Collections.Generic.List[string]]::new()
  Get-Content -LiteralPath $ExamplePath -Encoding UTF8 | ForEach-Object { $TemplateLines.Add($_) }
  $Version = Get-EnvValue $TemplateLines 'INSTALLER_CHANNEL_CONFIG_VERSION'
  if (-not $Version -or (Get-EnvValue $WebLines 'INSTALLER_CHANNEL_CONFIG_VERSION') -eq $Version) { return $false }
  $Names = @('CHANNEL_SPLIT_ENABLED','PLATFORM_CHANNEL_SPLIT_DOUYIN','PLATFORM_CHANNEL_SPLIT_XIAOHONGSHU','PLATFORM_CHANNEL_SPLIT_WECHAT_CHANNELS','PLATFORM_CHANNEL_SPLIT_BILIBILI','PLATFORM_CHANNEL_SPLIT_WEIBO')
  # Repair the original installer's all-disabled template once. Preserve an
  # installation already configured for channel splitting, including opt-outs.
  $HasChannelConfiguration = @($Names | Where-Object { (Get-EnvValue $WebLines $_ 'false').ToLowerInvariant() -notin @('false','0','off','no') }).Count -gt 0
  if (-not $HasChannelConfiguration) {
    foreach ($Name in $Names) { Set-EnvValue $WebLines $Name (Get-EnvValue $TemplateLines $Name 'false') }
  }
  Set-EnvValue $WebLines 'INSTALLER_CHANNEL_CONFIG_VERSION' $Version
  return $true
}
function Initialize-BundledRag([System.Collections.Generic.List[string]]$WebLines) {
  $BundledRagRoot = Join-Path $Root 'rag'
  if (-not (Test-Path -LiteralPath (Join-Path $BundledRagRoot 'app\main.py'))) { return $false }
  $ConfiguredRoot = Get-EnvValue $WebLines 'RAG_PROJECT_ROOT'
  $ResolvedRoot = ''
  if ($ConfiguredRoot) {
    $ResolvedRoot = if ([IO.Path]::IsPathRooted($ConfiguredRoot)) { [IO.Path]::GetFullPath($ConfiguredRoot) } else { [IO.Path]::GetFullPath((Join-Path $Root $ConfiguredRoot)) }
    # Keep an intentionally configured external service. A stale path from an
    # older computer can be replaced with this installation's bundled service.
    if ($ResolvedRoot -ne $BundledRagRoot -and (Test-Path -LiteralPath (Join-Path $ResolvedRoot 'app\main.py'))) { return $false }
  }
  $ConfiguredUrl = Get-EnvValue $WebLines 'RAG_BASE_URL'
  if (-not $ConfiguredRoot -and $ConfiguredUrl -and ([Uri]$ConfiguredUrl).Host -notin @('127.0.0.1','localhost','::1')) { return $false }
  $RagEnvPath = Join-Path $BundledRagRoot '.env'
  if ((Test-Path -LiteralPath $RagEnvPath) -and $ResolvedRoot -eq $BundledRagRoot -and (Get-EnvValue $WebLines 'RAG_TOKEN')) { return $false }
  $RagPort = Get-EnvValue $WebLines 'RAG_PORT' '18080'
  $RagToken = New-RandomText 64
  $RagLines = [System.Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $RagEnvPath) {
    Get-Content -LiteralPath $RagEnvPath -Encoding UTF8 | ForEach-Object { $RagLines.Add($_) }
    $RagToken = Get-EnvValue $RagLines 'RAG_BEARER_TOKEN' $RagToken
    $RagPort = Get-EnvValue $RagLines 'RAG_PORT' $RagPort
  } else {
    Get-Content -LiteralPath (Join-Path $BundledRagRoot '.env.example') -Encoding UTF8 | ForEach-Object { $RagLines.Add($_) }
    Set-EnvValue $RagLines 'RAG_HOST' '127.0.0.1'
    Set-EnvValue $RagLines 'RAG_PORT' $RagPort
    Set-EnvValue $RagLines 'RAG_AUTH_ENABLED' 'true'
    Set-EnvValue $RagLines 'RAG_BEARER_TOKEN' $RagToken
    Set-EnvValue $RagLines 'RAG_DATA_DIR' './data'
    Set-EnvValue $RagLines 'RAG_UPLOAD_DIR' './data/uploads'
    Set-EnvValue $RagLines 'RAG_SQLITE_PATH' './data/rag.db'
    Set-EnvValue $RagLines 'RAG_QDRANT_PATH' './data/qdrant'
    Set-EnvValue $RagLines 'RAG_MODEL_CACHE_DIR' './models'
    Set-EnvValue $RagLines 'RAG_FASTEMBED_LOCAL_FILES_ONLY' 'true'
    Set-EnvValue $RagLines 'RAG_ALLOW_MODEL_FALLBACK' 'false'
    Set-EnvValue $RagLines 'RAG_QUERY_REWRITE_ENABLED' 'false'
    Set-EnvValue $RagLines 'RAG_DEEP_AGENT_ENABLED' 'false'
    [IO.File]::WriteAllLines($RagEnvPath, $RagLines, [Text.UTF8Encoding]::new($false))
  }
  Set-EnvValue $WebLines 'RAG_PROJECT_ROOT' './rag'
  Set-EnvValue $WebLines 'RAG_AUTO_START' 'true'
  Set-EnvValue $WebLines 'RAG_ADMIN_ENABLED' 'true'
  Set-EnvValue $WebLines 'RAG_FORMAL_ROUTING_ENABLED' 'true'
  Set-EnvValue $WebLines 'RAG_PORT' $RagPort
  Set-EnvValue $WebLines 'RAG_BASE_URL' "http://127.0.0.1:$RagPort"
  Set-EnvValue $WebLines 'RAG_TOKEN' $RagToken
  return $true
}

if (Test-Path -LiteralPath $EnvPath) {
  $ExistingLines = [System.Collections.Generic.List[string]]::new()
  Get-Content -LiteralPath $EnvPath -Encoding UTF8 | ForEach-Object { $ExistingLines.Add($_) }
  $Changed = Initialize-BundledRag $ExistingLines
  if (Repair-InstallerChannelDefaults $ExistingLines) { $Changed = $true }
  if ($EnsureMessageCollection) {
    Set-EnvValue $ExistingLines 'AUTO_COLLECT_ENABLED' 'true'
    $Changed = $true
  }
  if ($Changed) {
    [System.IO.File]::WriteAllLines($EnvPath, $ExistingLines, [System.Text.UTF8Encoding]::new($false))
    if (-not $Quiet) { Write-Host '已补齐安装运行配置，保留原有账号与业务设置。' }
  } elseif (-not $Quiet) {
    Write-Host '配置文件已存在，不覆盖原有配置。'
  }
  exit 0
}

foreach ($dir in 'data','data\browser-profiles','logs','logs\issue-diagnosis','logs\browser-control','logs\smoke-tests','outputs','tmp') {
  New-Item -ItemType Directory -Force -Path (Join-Path $Root $dir) | Out-Null
}

$BundledBrowser = Get-ChildItem -LiteralPath (Join-Path $Root 'runtime\browser') -Recurse -Filter chrome.exe -File -ErrorAction SilentlyContinue | Select-Object -First 1
$BrowserPath = if ($BundledBrowser) { $BundledBrowser.FullName.Replace('\','/') } else { 'C:/Program Files/Google/Chrome/Application/chrome.exe' }
$Lines = [System.Collections.Generic.List[string]]::new()
Get-Content -LiteralPath $ExamplePath -Encoding UTF8 | ForEach-Object { $Lines.Add($_) }

$SessionSecret = New-RandomText 64
$AgentToken = New-RandomText 64
Set-EnvValue $Lines 'PORT' '3100'
Set-EnvValue $Lines 'AGENT_PORT' '17831'
Set-EnvValue $Lines 'SERVER_HOST' '127.0.0.1'
Set-EnvValue $Lines 'AGENT_HOST' '127.0.0.1'
Set-EnvValue $Lines 'ADMIN_USERNAME' 'admin'
Set-EnvValue $Lines 'ADMIN_PASSWORD' 'admin11'
Set-EnvValue $Lines 'SESSION_SECRET' $SessionSecret
Set-EnvValue $Lines 'AGENT_SHARED_TOKEN' $AgentToken
Set-EnvValue $Lines 'ALLOWED_ORIGINS' 'http://127.0.0.1:3100,http://localhost:3100'
Set-EnvValue $Lines 'AGENT_ALLOWED_ORIGINS' 'http://127.0.0.1:3100,http://localhost:3100'
Set-EnvValue $Lines 'CLOUD_BASE_URL' 'http://127.0.0.1:3100'
Set-EnvValue $Lines 'DATABASE_PATH' './data/mvp.db'
Set-EnvValue $Lines 'LOCAL_AGENT_AUTO_START' 'true'
Set-EnvValue $Lines 'RPA_MODE' 'five_platform_assisted'
Set-EnvValue $Lines 'CHROME_EXECUTABLE_PATH' $BrowserPath
Set-EnvValue $Lines 'CHANNELS_COMMENT_URL' 'https://channels.weixin.qq.com/platform/interaction/comment'
Set-EnvValue $Lines 'CHANNELS_MESSAGE_URL' 'https://channels.weixin.qq.com/platform/private_msg'
Set-EnvValue $Lines 'AUTO_COLLECT_ENABLED' 'true'
Set-EnvValue $Lines 'BROWSER_CONTROL_ENABLED' 'false'
[void](Initialize-BundledRag $Lines)
# 当前数据库模板的 AI 配置使用 data/.settings-key 解密；不要生成不匹配的新密钥。
if (Test-Path -LiteralPath (Join-Path $Root 'data\.settings-key')) {
  Set-EnvValue $Lines 'SETTINGS_ENCRYPTION_KEY' ''
} else {
  Set-EnvValue $Lines 'SETTINGS_ENCRYPTION_KEY' (New-RandomText 64)
}

[System.IO.File]::WriteAllLines($EnvPath, $Lines, [System.Text.UTF8Encoding]::new($false))
$CredentialPath = Join-Path $Root '首次登录信息.txt'
$CredentialText = @"
天河 AI 数字员工平台 - 首次登录信息
生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
管理地址：http://127.0.0.1:3100/
账号：admin
初始密码：admin11

说明：
1. Web、Local Agent 和 RAG 已配置完成。首次启动保持任务暂停，在后台开启总开关后才启动 Local Agent。
2. 安装包不迁移平台 Cookie；换电脑后，抖音、视频号等平台需要首次扫码登录。
3. “一键卸载（保留数据）”会保留数据库、配置和日志；“一键彻底删除”会永久删除全部本地数据。
"@
[System.IO.File]::WriteAllText($CredentialPath, $CredentialText, [System.Text.UTF8Encoding]::new($true))
if (-not $Quiet) {
  Write-Host '首次配置已生成。'
  Write-Host '管理地址：http://127.0.0.1:3100/'
  Write-Host '账号：admin  初始密码：admin11'
}

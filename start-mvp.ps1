param(
  [switch]$NoBrowser,
  [switch]$OpenRag,
  [int]$WaitSeconds = 30,
  [int]$PortOverride = 0
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeNode = Join-Path $Root 'runtime\node.exe'
$DevBundled = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$Node = if (Test-Path -LiteralPath $RuntimeNode) {
  $RuntimeNode
} elseif (Test-Path -LiteralPath $DevBundled) {
  $DevBundled
} else {
  (Get-Command node -ErrorAction Stop).Source
}

$Initializer = Join-Path $Root 'initialize-mvp.ps1'
$EnvPath = Join-Path $Root '.env'
if (-not (Test-Path -LiteralPath $EnvPath)) { & $Initializer -Quiet }

function Read-EnvValue([string]$Name, [string]$Default = '') {
  if (-not (Test-Path -LiteralPath $EnvPath)) { return $Default }
  $prefix = "$Name="
  $line = Get-Content -LiteralPath $EnvPath -Encoding UTF8 -ErrorAction SilentlyContinue |
    Where-Object { $_.StartsWith($prefix) } |
    Select-Object -Last 1
  if ($null -eq $line) { return $Default }
  return $line.Substring($prefix.Length).Trim()
}

function Test-LocalPort([string]$TargetHost, [int]$Port) {
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $tcp.Connect($TargetHost, $Port)
    return $tcp.Connected
  } catch {
    return $false
  } finally {
    $tcp.Dispose()
  }
}

# RAG 和业务 Web 都是本地服务。启动入口统一负责先启动 RAG，
# 再启动业务 Web；RAG 已经在运行时只复用，不重复拉起。
$RagAutoStart = (Read-EnvValue 'RAG_AUTO_START' 'true').ToLowerInvariant() -notin @('0', 'false', 'no', 'off')
$RagHost = Read-EnvValue 'RAG_HOST' '127.0.0.1'
$RagPort = [int](Read-EnvValue 'RAG_PORT' '18080')
$RagToken = Read-EnvValue 'RAG_TOKEN' 'dev-local-token'
$RagRootValue = Read-EnvValue 'RAG_PROJECT_ROOT' ''
$RagRoot = $null
if ($RagRootValue) {
  $RagRoot = if ([IO.Path]::IsPathRooted($RagRootValue)) { [IO.Path]::GetFullPath($RagRootValue) } else { [IO.Path]::GetFullPath((Join-Path $Root $RagRootValue)) }
} else {
  $ragCandidates = @(
    (Join-Path $Root 'rag'),
    (Join-Path $Root '..\rag'),
    (Join-Path $Root '..\..\rag')
  )
  $RagRoot = $ragCandidates |
    ForEach-Object { [IO.Path]::GetFullPath($_) } |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'app\main.py') } |
    Select-Object -First 1
}
$RagBaseUrl = "http://${RagHost}:${RagPort}"
$RagHealthUrl = "$RagBaseUrl/rag-api/v1/health"
$RagLogs = Join-Path $Root 'logs'
$RagPidFile = Join-Path $RagLogs 'rag.pid'

function Test-RagHealth {
  try {
    $headers = @{}
    if ($RagToken) { $headers['Authorization'] = "Bearer $RagToken" }
    $health = Invoke-RestMethod -Uri $RagHealthUrl -Headers $headers -TimeoutSec 3
    return $null -ne $health
  } catch {
    return $false
  }
}

function Ensure-RagService {
  if (-not $RagAutoStart) {
    Write-Host 'RAG 自动启动已关闭（RAG_AUTO_START=false）。'
    return
  }
  if (-not $RagRoot -or -not (Test-Path -LiteralPath (Join-Path $RagRoot 'app\main.py'))) {
    throw "找不到本地 RAG 项目。请在 .env 中配置 RAG_PROJECT_ROOT，或将 RAG 项目放在可识别的位置。"
  }
  if (Test-RagHealth) {
    Write-Host "RAG 知识库服务已运行：$RagBaseUrl"
    if ($OpenRag -and -not $NoBrowser) { Start-Process $RagBaseUrl }
    return
  }
  if (Test-LocalPort $RagHost $RagPort) {
    throw "RAG 端口 $RagPort 已被其他程序占用，但健康检查未通过。请检查 $RagHealthUrl。"
  }

  $RagPython = Join-Path $Root 'runtime\python\python.exe'
  if (-not (Test-Path -LiteralPath $RagPython)) { $RagPython = Join-Path $RagRoot '.venv\Scripts\python.exe' }
  if (-not (Test-Path -LiteralPath $RagPython)) {
    $RagPython = (Get-Command python -ErrorAction SilentlyContinue).Source
  }
  if (-not $RagPython) {
    throw '找不到 RAG 的 Python 运行环境。请先准备 RAG 项目的 .venv，或安装 Python 3.11-3.13。'
  }

  New-Item -ItemType Directory -Force -Path $RagLogs | Out-Null
  $ragOut = Join-Path $RagLogs 'rag-service.out.log'
  $ragErr = Join-Path $RagLogs 'rag-service.err.log'
  $RagPortText = [string]$RagPort
  $RagLauncher = Join-Path $Root 'src\start-rag.js'
  $ragProcess = Start-Process -FilePath $Node `
    -ArgumentList @(('"' + $RagLauncher + '"'), '--python', ('"' + $RagPython + '"'), '--rag-root', ('"' + $RagRoot + '"'), '--host', $RagHost, '--port', $RagPortText) `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $ragOut -RedirectStandardError $ragErr -PassThru
  Set-Content -LiteralPath $RagPidFile -Value $ragProcess.Id -Encoding ascii

  $deadline = (Get-Date).AddSeconds([Math]::Max(5, $WaitSeconds))
  $online = $false
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $ragProcess.Id -ErrorAction SilentlyContinue)) { break }
    if (Test-RagHealth) { $online = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $online) {
    $detail = if (Test-Path -LiteralPath $ragErr) {
      (Get-Content -LiteralPath $ragErr -Tail 30 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    } else {
      '未生成错误日志'
    }
    throw "RAG 知识库服务启动失败。请检查 $ragErr`n$detail"
  }
  Write-Host "RAG 知识库服务已启动：$RagBaseUrl（PID=$($ragProcess.Id)）"
  if ($OpenRag -and -not $NoBrowser) { Start-Process $RagBaseUrl }
}

$ListenHost = Read-EnvValue 'SERVER_HOST' '127.0.0.1'
$Port = [int](Read-EnvValue 'PORT' '3100')
if ($PortOverride -gt 0) { $Port = $PortOverride }
$BrowserHost = if ($ListenHost -in @('0.0.0.0', '::', '::0')) { '127.0.0.1' } else { $ListenHost }
$BaseUrl = "http://${BrowserHost}:${Port}"
$HealthUrl = "$BaseUrl/api/health"

# 进程环境优先于 .env，确保端口、回调地址和浏览器来源始终一致。
$env:PORT = [string]$Port
$env:CLOUD_BASE_URL = $BaseUrl
$env:ALLOWED_ORIGINS = "$BaseUrl,http://localhost:$Port"
$env:AGENT_ALLOWED_ORIGINS = "$BaseUrl,http://localhost:$Port"

$BrowserRoot = Join-Path $Root 'runtime\browser'
$BundledBrowser = if (Test-Path -LiteralPath $BrowserRoot) {
  Get-ChildItem -LiteralPath $BrowserRoot -Recurse -Filter chrome.exe -File -ErrorAction SilentlyContinue | Select-Object -First 1
} else {
  $null
}
if ($BundledBrowser) { $env:CHROME_EXECUTABLE_PATH = $BundledBrowser.FullName }

$Logs = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$PidFile = Join-Path $Logs 'server.pid'

# 先确保 RAG 已经起来。即使业务 Web 已经在运行，也会补起缺失的 RAG。
Ensure-RagService

if (Test-Path -LiteralPath $PidFile) {
  $existingId = 0
  [void][int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$existingId)
  $existing = if ($existingId -gt 0) { Get-Process -Id $existingId -ErrorAction SilentlyContinue } else { $null }
  if ($existing) {
    $owner = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in @($BrowserHost, '127.0.0.1', '0.0.0.0', '::', '::1') } |
      Select-Object -First 1 -ExpandProperty OwningProcess)
    if ($owner -eq $existingId) {
      try {
        $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        if ($health.service -eq 'cloud-web') {
          Write-Host "平台已运行：$BaseUrl（PID=$existingId）"
          if (-not $NoBrowser) { Start-Process $BaseUrl }
          exit 0
        }
      } catch {}
    }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

# 兼容之前手工启动但没有 server.pid 的本项目实例。
try {
  $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
  if ($health.service -eq 'cloud-web') {
    $owner = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in @($BrowserHost, '127.0.0.1', '0.0.0.0', '::', '::1') } |
      Select-Object -First 1 -ExpandProperty OwningProcess)
    if ($owner -gt 0) { Set-Content -LiteralPath $PidFile -Value $owner -Encoding ascii }
    Write-Host "平台已运行：$BaseUrl（复用现有进程）"
    if (-not $NoBrowser) { Start-Process $BaseUrl }
    exit 0
  }
} catch {}

# 禁止误连同一台电脑上其他目录启动的旧平台。
if (Test-LocalPort $BrowserHost $Port) {
  throw "端口 $Port 已被其他程序占用。当前目录不会打开其他项目的页面。请停止占用程序，或使用：.\start-mvp.ps1 -PortOverride 32167"
}

# Clear only a stale PID record before Web starts. Once Web is running it may
# immediately start Local Agent and write a fresh agent.pid; never delete it after launch.
Remove-Item -LiteralPath (Join-Path $Logs 'agent.pid') -Force -ErrorAction SilentlyContinue
$server = Start-Process -FilePath $Node -ArgumentList 'src/server.js' -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Logs 'server.out.log') -RedirectStandardError (Join-Path $Logs 'server.err.log') -PassThru
Set-Content -LiteralPath $PidFile -Value $server.Id -Encoding ascii

$deadline = (Get-Date).AddSeconds([Math]::Max(5, $WaitSeconds))
$online = $false
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $server.Id -ErrorAction SilentlyContinue)) { break }
  try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
    if ($health) { $online = $true; break }
  } catch {}
  Start-Sleep -Milliseconds 500
}

if (-not $online) {
  $err = Join-Path $Logs 'server.err.log'
  $detail = if (Test-Path -LiteralPath $err) {
    (Get-Content -LiteralPath $err -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
  } else {
    '未生成错误日志'
  }
  throw "平台启动失败。请检查 $err`n$detail"
}

Write-Host "平台已启动：$BaseUrl（PID=$($server.Id)）"
Write-Host "RAG 知识库服务已绑定：$RagBaseUrl"
Write-Host 'Local Agent 由全局总开关自动启停。'
if (-not $NoBrowser) { Start-Process $BaseUrl }




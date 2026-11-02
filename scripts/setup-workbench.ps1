param(
  [string]$GitProxy = '',
  [string]$BuildProxy = '',
  [switch]$PrepareOnly,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
Set-Location $projectDir
$sources = Get-Content deploy/workbench/sources.json -Raw | ConvertFrom-Json
foreach ($entry in $sources.PSObject.Properties) {
  $source = $entry.Value
  $gitArgs = @()
  if ($GitProxy) { $gitArgs += @('-c', "http.proxy=$GitProxy", '-c', 'http.version=HTTP/1.1') }
  if (-not (Test-Path -LiteralPath (Join-Path $source.directory '.git'))) {
    if (Test-Path -LiteralPath $source.directory) { throw "Existing non-Git directory: $($source.directory)" }
    & git @gitArgs clone --no-checkout --depth 1 $source.repository $source.directory
    if ($LASTEXITCODE -ne 0) { throw "Clone failed: $($entry.Name)" }
    & git @gitArgs -C $source.directory fetch --depth 1 origin $source.commit
    if ($LASTEXITCODE -ne 0) { throw "Fetch failed: $($entry.Name)" }
    & git -C $source.directory checkout --detach $source.commit
    if ($LASTEXITCODE -ne 0) { throw "Checkout failed: $($entry.Name)" }
  }
  $head = & git -C $source.directory rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $head -ne $source.commit) {
    throw "$($entry.Name) is not at the pinned revision. Preserve your changes and select the intended revision before building."
  }
}

$tokenLine = Get-Content -LiteralPath .env.docker | Where-Object { $_ -match '^TIANHE_MODEL_TOKEN=' } | Select-Object -Last 1
if (-not $tokenLine) { throw 'TIANHE_MODEL_TOKEN is missing in .env.docker' }
$modelToken = ($tokenLine -split '=', 2)[1].Trim().Trim('"').Trim("'")
if ($modelToken -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid internal model-token format' }
$occDir = Join-Path $projectDir 'runtime/workbench/openchatcut'
$toonDir = Join-Path $projectDir 'runtime/workbench/toonflow'
New-Item -ItemType Directory -Force -Path "$occDir/media/uploads", "$occDir/home", "$toonDir/workspaces/myProject" | Out-Null
$utf8 = [System.Text.UTF8Encoding]::new($false)
if (-not (Test-Path -LiteralPath "$occDir/settings.env")) {
  $settings = @(
    'LLM_PROVIDER=openai',
    'LLM_OPENAI_BASE_URL=http://web:3100/api/model/v1',
    "LLM_OPENAI_API_KEY=$modelToken",
    'LLM_OPENAI_MODEL=tianhe-workbench-chat',
    'LLM_OPENAI_API_MODE=chat'
  ) -join "`n"
  [System.IO.File]::WriteAllText("$occDir/settings.env", "$settings`n", $utf8)
}
if (-not (Test-Path -LiteralPath "$toonDir/settings.json")) {
  $settings = @{ settings = @{ customProviders = @(@{
    id = 'tianhe'; label = '天河统一模型';
    apiUrl = 'http://web:3100/api/model/v1'; apiKey = $modelToken;
    protocol = 'openai-completions';
    models = @(@{ id = 'tianhe-workbench-chat'; label = '天河主模型'; reasoningEfforts = $false })
  }) } } | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText("$toonDir/settings.json", $settings, $utf8)
}
& "$PSScriptRoot/setup-signal.ps1" -PrepareOnly
Write-Host 'Sources pinned and persistent settings prepared. Existing settings were preserved.'
if ($PrepareOnly) { return }
$composeArgs = @('compose', '-f', 'compose.yaml', '-f', 'compose.wechat.yaml', '-f', 'compose.workbench.yaml')
if (-not $SkipBuild) {
  $buildArgs = @('build')
  if ($BuildProxy) {
    $buildArgs += @('--build-arg', "HTTP_PROXY=$BuildProxy", '--build-arg', "HTTPS_PROXY=$BuildProxy", '--build-arg', 'NO_PROXY=localhost,127.0.0.1')
  }
  & docker @composeArgs @buildArgs signal openchatcut toonflow
  if ($LASTEXITCODE -ne 0) { throw 'Engine build failed' }
}
# Start the engines first: SQLite and its WAL sidecars must exist before read-only mounts.
& docker @composeArgs up -d --no-deps --wait --wait-timeout 180 signal openchatcut toonflow
if ($LASTEXITCODE -ne 0) { throw 'Engine startup failed' }
foreach ($suffix in @('', '-wal', '-shm')) {
  if (-not (Test-Path -LiteralPath "$occDir/project-store-v1.sqlite3$suffix" -PathType Leaf)) {
    throw "OpenChatCut database is not ready: $suffix"
  }
}
& docker @composeArgs up -d --force-recreate --no-deps --wait --wait-timeout 90 web
if ($LASTEXITCODE -ne 0) { throw 'Tianhe workbench connection failed' }
Write-Host 'Tianhe: http://127.0.0.1:3100/#studio'
Write-Host 'OpenChatCut: http://127.0.0.1:5199/'
Write-Host 'Toonflow: http://127.0.0.1:13000/'
Write-Host 'AI Signal Studio: http://127.0.0.1:3100/integrations/ai-signal/'
